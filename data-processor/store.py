"""SQLite-backed store for transformed extraction results.

The Rust core worker streams raw HTML packets to the ingestion socket; this
store persists the transformed JSON per job so the TypeScript gateway can read
the final payload back over HTTP.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "data" / "results.db"

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
    payload     TEXT NOT NULL,
    created_at  REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_results_job ON results(job_id);
CREATE INDEX IF NOT EXISTS idx_results_created ON results(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
"""


class ResultStore:
    """Thread safe SQLite store for job state and transformed payloads."""

    def __init__(self, db_path: Path | str = DEFAULT_DB_PATH) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

    # ------------------------------------------------------------------ #
    # Writes
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
                INSERT INTO results (job_id, url, ok, status_code, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    url,
                    1 if ok else 0,
                    status_code,
                    json.dumps(payload, ensure_ascii=False),
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

    # ------------------------------------------------------------------ #
    # Reads
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
                payload = json.loads(row["payload"])
            except json.JSONDecodeError:
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

    def close(self) -> None:
        with self._lock:
            self._conn.close()
