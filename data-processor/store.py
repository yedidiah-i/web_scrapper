"""SQLite-backed store for transformed extraction results and crawl history.

The Rust core worker streams raw HTML packets to the ingestion socket; this
store persists the transformed JSON per job so the TypeScript gateway can read
the final payload back over HTTP.

Schema additions in v0.3:
* ``history`` table — lightweight index of every crawl submitted by a user,
  keyed by ``job_id``.  Payloads are stored compressed (zlib deflate) so the
  history stays compact even for large crawls.
* ``results.payload`` column is also compressed from v0.3 onward; a migration
  guard detects and upgrades old plain-text rows on startup.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import zlib
from pathlib import Path
from typing import Any

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "data" / "results.db"

# History is kept for 90 days; entries beyond 10 000 are pruned by LRU.
HISTORY_MAX_DAYS = 90
HISTORY_MAX_ENTRIES = 10_000

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    job_id     TEXT PRIMARY KEY,
    completed  INTEGER NOT NULL DEFAULT 0,
    received   INTEGER NOT NULL DEFAULT 0,
    succeeded  INTEGER NOT NULL DEFAULT 0,
    failed     INTEGER NOT NULL DEFAULT 0,
    target     TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL,
    url         TEXT NOT NULL,
    ok          INTEGER NOT NULL,
    status_code INTEGER,
    payload     BLOB NOT NULL,
    compressed  INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL UNIQUE,
    label       TEXT,
    urls_seed   TEXT NOT NULL,
    target      TEXT NOT NULL DEFAULT 'auto',
    crawl_depth INTEGER NOT NULL DEFAULT 0,
    user_id     INTEGER,
    succeeded   INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    total_pages INTEGER NOT NULL DEFAULT 0,
    summary     BLOB,
    compressed  INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

-- Per-page audit trail.
--
-- One row per crawled page, so a past crawl can be reviewed page by page
-- (what was fetched, how deep it was, which engine got it, whether an
-- anti-bot challenge was met) without replaying the whole result payload.
-- The extracted payload itself is not duplicated here; the row keeps the
-- small facts and points back at the results table.
CREATE TABLE IF NOT EXISTS crawl_pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL,
    url         TEXT NOT NULL,
    source_url  TEXT,
    depth       INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'unknown',
    ok          INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER,
    engine      TEXT NOT NULL DEFAULT 'http',
    challenge   TEXT,
    elapsed_ms  INTEGER NOT NULL DEFAULT 0,
    row_count   INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_job ON results(job_id);
CREATE INDEX IF NOT EXISTS idx_results_created ON results(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawl_pages_job ON crawl_pages(job_id, id);
CREATE INDEX IF NOT EXISTS idx_crawl_pages_created ON crawl_pages(created_at);
"""


def _compress(data: str) -> bytes:
    return zlib.compress(data.encode("utf-8"), level=6)


def _decompress(blob: bytes) -> str:
    return zlib.decompress(blob).decode("utf-8")


def _encode_payload(payload: dict[str, Any]) -> tuple[bytes, int]:
    """Serialise and compress a payload dict.  Returns (blob, compressed_flag)."""
    raw = json.dumps(payload, ensure_ascii=False)
    return _compress(raw), 1


def _decode_payload(blob: bytes | str, compressed: int) -> dict[str, Any]:
    if compressed:
        raw = _decompress(blob if isinstance(blob, bytes) else blob.encode("latin-1"))
    else:
        raw = blob if isinstance(blob, str) else blob.decode("utf-8")
    return json.loads(raw)


class ResultStore:
    """Thread safe SQLite store for job state, transformed payloads, and crawl history."""

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.executescript(SCHEMA)
        self._conn.commit()
        self._prune_history()

    # ------------------------------------------------------------------ #
    # Writes — results
    # ------------------------------------------------------------------ #

    def record_result(
        self,
        job_id: str,
        url: str,
        ok: bool,
        status_code: int | None,
        payload: dict[str, Any],
    ) -> None:
        now = time.time()
        blob, compressed = _encode_payload(payload)
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO jobs (job_id, completed, received, succeeded, failed, target,
                                  created_at, updated_at)
                VALUES (?, 0, 0, 0, 0, ?, ?, ?)
                ON CONFLICT(job_id) DO NOTHING
                """,
                (job_id, payload.get("target"), now, now),
            )
            self._conn.execute(
                """
                INSERT INTO results (job_id, url, ok, status_code, payload, compressed, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    url,
                    1 if ok else 0,
                    status_code,
                    blob,
                    compressed,
                    now,
                ),
            )
            self._conn.execute(
                """
                UPDATE jobs
                   SET received = received + 1,
                       succeeded = succeeded + ?,
                       failed = failed + ?,
                       updated_at = ?
                 WHERE job_id = ?
                """,
                (1 if ok else 0, 0 if ok else 1, now, job_id),
            )
            self._conn.commit()

    def mark_job_complete(self, job_id: str) -> None:
        now = time.time()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO jobs (job_id, completed, received, succeeded, failed, target,
                                  created_at, updated_at)
                VALUES (?, 1, 0, 0, 0, NULL, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET completed = 1, updated_at = excluded.updated_at
                """,
                (job_id, now, now),
            )
            self._conn.commit()
        # Update history entry when the job finishes.
        self._update_history_on_complete(job_id)

    # ------------------------------------------------------------------ #
    # History — writes
    # ------------------------------------------------------------------ #

    def record_history(
        self,
        job_id: str,
        urls_seed: list[str],
        target: str,
        crawl_depth: int = 0,
        label: str | None = None,
        user_id: int | None = None,
    ) -> None:
        """Create a lightweight history entry for a new crawl job."""
        now = time.time()
        seed_json = json.dumps(urls_seed[:10], ensure_ascii=False)  # store first 10 seeds
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO history
                    (job_id, label, urls_seed, target, crawl_depth, user_id,
                     succeeded, failed, total_pages, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
                ON CONFLICT(job_id) DO NOTHING
                """,
                (job_id, label, seed_json, target, crawl_depth, user_id, now, now),
            )
            self._conn.commit()

    def _update_history_on_complete(self, job_id: str) -> None:
        """Sync history counters from the jobs table when a job finishes."""
        with self._lock:
            row = self._conn.execute(
                "SELECT succeeded, failed, received, target, created_at FROM jobs WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            if row is None:
                return

            # Build a compact summary blob: top-5 URLs with their status.
            results = self._conn.execute(
                "SELECT url, ok FROM results WHERE job_id = ? ORDER BY id LIMIT 5",
                (job_id,),
            ).fetchall()
            summary = [{"url": r["url"], "ok": bool(r["ok"])} for r in results]
            blob, compressed = _encode_payload({"top_results": summary})
            now = time.time()

            # Check if history entry already exists
            hist = self._conn.execute(
                "SELECT id FROM history WHERE job_id = ?", (job_id,)
            ).fetchone()

            if hist is None:
                # Automatically create history entry if not pre-registered
                seed_urls = [r["url"] for r in results[:3]]
                self._conn.execute(
                    """
                    INSERT INTO history
                        (job_id, label, urls_seed, target, crawl_depth, user_id,
                         succeeded, failed, total_pages, summary, compressed, created_at, updated_at)
                    VALUES (?, NULL, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(job_id) DO UPDATE SET
                        succeeded = excluded.succeeded,
                        failed = excluded.failed,
                        total_pages = excluded.total_pages,
                        summary = excluded.summary,
                        compressed = excluded.compressed,
                        updated_at = excluded.updated_at
                    """,
                    (
                        job_id,
                        json.dumps(seed_urls, ensure_ascii=False),
                        row["target"] or "auto",
                        row["succeeded"],
                        row["failed"],
                        row["received"],
                        blob,
                        compressed,
                        row["created_at"],
                        now,
                    ),
                )
            else:
                self._conn.execute(
                    """
                    UPDATE history
                       SET succeeded = ?, failed = ?, total_pages = ?,
                           summary = ?, compressed = ?, updated_at = ?
                     WHERE job_id = ?
                    """,
                    (
                        row["succeeded"],
                        row["failed"],
                        row["received"],
                        blob,
                        compressed,
                        now,
                        job_id,
                    ),
                )
            self._conn.commit()

    def _prune_history(self) -> None:
        """Remove history entries older than HISTORY_MAX_DAYS or beyond the row cap."""
        cutoff = time.time() - HISTORY_MAX_DAYS * 86400
        with self._lock:
            self._conn.execute(
                "DELETE FROM history WHERE created_at < ?", (cutoff,)
            )
            # Keep only the most recent HISTORY_MAX_ENTRIES rows.
            self._conn.execute(
                """
                DELETE FROM history
                WHERE id NOT IN (
                    SELECT id FROM history ORDER BY created_at DESC LIMIT ?
                )
                """,
                (HISTORY_MAX_ENTRIES,),
            )
            # Page rows follow their job, so a pruned job takes its pages with it.
            self._conn.execute(
                """
                DELETE FROM crawl_pages
                WHERE job_id NOT IN (SELECT job_id FROM history)
                """
            )
            self._conn.commit()

    # ------------------------------------------------------------------ #
    # History — public maintenance API
    # ------------------------------------------------------------------ #

    def prune_history(self) -> dict[str, int]:
        """Apply the retention policy now and report what was removed."""
        before = self.count_history()
        with self._lock:
            self._conn.execute(
                """
                DELETE FROM crawl_pages
                WHERE job_id NOT IN (SELECT job_id FROM history)
                """
            )
            self._conn.commit()
        self._prune_history()
        after = self.count_history()
        return {"removed": max(0, before - after), "remaining": after}

    def delete_history(self, job_id: str) -> bool:
        """Delete one crawl from the history (and its page trail).

        Returns ``True`` when an entry was actually removed.
        """
        with self._lock:
            cursor = self._conn.execute(
                "DELETE FROM history WHERE job_id = ?", (job_id,)
            )
            removed = cursor.rowcount > 0
            self._conn.execute(
                "DELETE FROM crawl_pages WHERE job_id = ?", (job_id,)
            )
            self._conn.commit()
        return removed

    # ------------------------------------------------------------------ #
    # Per-page audit trail
    # ------------------------------------------------------------------ #

    def record_page(
        self,
        job_id: str,
        url: str,
        *,
        source_url: str | None = None,
        depth: int = 0,
        status: str = "unknown",
        ok: bool = False,
        status_code: int | None = None,
        engine: str = "http",
        challenge: str | None = None,
        elapsed_ms: int = 0,
        row_count: int = 0,
    ) -> None:
        """Record the facts about one crawled page.

        The row is intentionally small: it holds the crawl provenance, not the
        extracted payload, so a long history costs very little memory.
        """
        now = time.time()
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO crawl_pages
                    (job_id, url, source_url, depth, status, ok, status_code,
                     engine, challenge, elapsed_ms, row_count, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    url,
                    source_url,
                    depth,
                    status,
                    1 if ok else 0,
                    status_code,
                    engine,
                    challenge,
                    elapsed_ms,
                    row_count,
                    now,
                ),
            )
            self._conn.commit()

    def get_pages(self, job_id: str) -> list[dict[str, Any]]:
        """Return the per-page trail of one crawl, in fetch order."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT url, source_url, depth, status, ok, status_code, engine,
                       challenge, elapsed_ms, row_count, created_at
                  FROM crawl_pages
                 WHERE job_id = ?
                 ORDER BY id ASC
                """,
                (job_id,),
            ).fetchall()
        return [dict(row) for row in rows]

    def count_pages(self, job_id: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) FROM crawl_pages WHERE job_id = ?", (job_id,)
            ).fetchone()
        return int(row[0])

    # ------------------------------------------------------------------ #
    # Reads — results
    # ------------------------------------------------------------------ #

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            if job is None:
                return None

            rows = self._conn.execute(
                "SELECT * FROM results WHERE job_id = ? ORDER BY id ASC", (job_id,)
            ).fetchall()

        results = []
        for row in rows:
            try:
                payload = _decode_payload(row["payload"], row["compressed"])
            except Exception:
                continue
            results.append(
                {
                    "url": row["url"],
                    "ok": bool(row["ok"]),
                    "status_code": row["status_code"],
                    "created_at": row["created_at"],
                    "result": payload,
                }
            )

        return {
            "job_id": job["job_id"],
            "status": "completed" if job["completed"] else "pending",
            "target": job["target"],
            "received": job["received"],
            "succeeded": job["succeeded"],
            "failed": job["failed"],
            "completed": bool(job["completed"]),
            "created_at": job["created_at"],
            "updated_at": job["updated_at"],
            "results": results,
        }

    def recent_jobs(self, limit: int = 25) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT job_id, target, completed, received, succeeded, failed,
                       created_at, updated_at
                  FROM jobs
                 ORDER BY created_at DESC
                 LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return [dict(row) for row in rows]

    def stats(self, hours: int = 24) -> dict[str, Any]:
        """Per-hour success/failure series plus lifetime totals."""
        since = time.time() - hours * 3600
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT ok, created_at FROM results WHERE created_at >= ?
                """,
                (since,),
            ).fetchall()

            totals = self._conn.execute(
                """
                SELECT COUNT(*) AS total,
                       SUM(ok) AS succeeded,
                       SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
                  FROM results
                """
            ).fetchone()

        buckets: dict[int, dict[str, int]] = {}
        for row in rows:
            bucket = int(row["created_at"] // 3600 * 3600)
            entry = buckets.setdefault(bucket, {"success": 0, "failed": 0})
            entry["success" if row["ok"] else "failed"] += 1

        series = [
            {"ts": ts, "success": value["success"], "failed": value["failed"]}
            for ts, value in sorted(buckets.items())
        ]

        return {
            "window_hours": hours,
            "total": totals["total"] or 0,
            "succeeded": totals["succeeded"] or 0,
            "failed": totals["failed"] or 0,
            "series": series,
        }

    # ------------------------------------------------------------------ #
    # Reads — history
    # ------------------------------------------------------------------ #

    def get_history(
        self,
        limit: int = 50,
        user_id: int | None = None,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """Return lightweight history entries, newest first."""
        if user_id is not None:
            query = """
                SELECT id, job_id, label, urls_seed, target, crawl_depth,
                       succeeded, failed, total_pages, created_at, updated_at
                  FROM history
                 WHERE user_id = ?
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?
            """
            params: tuple = (user_id, limit, offset)
        else:
            query = """
                SELECT id, job_id, label, urls_seed, target, crawl_depth,
                       succeeded, failed, total_pages, created_at, updated_at
                  FROM history
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?
            """
            params = (limit, offset)

        with self._lock:
            rows = self._conn.execute(query, params).fetchall()

        entries = []
        for row in rows:
            try:
                urls_seed = json.loads(row["urls_seed"])
            except Exception:
                urls_seed = []
            entries.append(
                {
                    "id": row["id"],
                    "job_id": row["job_id"],
                    "label": row["label"],
                    "urls_seed": urls_seed,
                    "target": row["target"],
                    "crawl_depth": row["crawl_depth"],
                    "succeeded": row["succeeded"],
                    "failed": row["failed"],
                    "total_pages": row["total_pages"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
            )
        return entries

    def get_history_entry(self, job_id: str) -> dict[str, Any] | None:
        """Return a single history entry with the compact summary payload."""
        with self._lock:
            row = self._conn.execute(
                """
                SELECT id, job_id, label, urls_seed, target, crawl_depth,
                       succeeded, failed, total_pages, summary, compressed,
                       created_at, updated_at
                  FROM history WHERE job_id = ?
                """,
                (job_id,),
            ).fetchone()
        if row is None:
            return None

        try:
            urls_seed = json.loads(row["urls_seed"])
        except Exception:
            urls_seed = []

        summary = None
        if row["summary"]:
            try:
                summary = _decode_payload(row["summary"], row["compressed"])
            except Exception:
                pass

        return {
            "id": row["id"],
            "job_id": row["job_id"],
            "label": row["label"],
            "urls_seed": urls_seed,
            "target": row["target"],
            "crawl_depth": row["crawl_depth"],
            "succeeded": row["succeeded"],
            "failed": row["failed"],
            "total_pages": row["total_pages"],
            "summary": summary,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def count_history(self, user_id: int | None = None) -> int:
        with self._lock:
            if user_id is not None:
                row = self._conn.execute(
                    "SELECT COUNT(*) FROM history WHERE user_id = ?", (user_id,)
                ).fetchone()
            else:
                row = self._conn.execute("SELECT COUNT(*) FROM history").fetchone()
        return row[0]

    def close(self) -> None:
        with self._lock:
            self._conn.close()
