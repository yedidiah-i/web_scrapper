"""Data processor service.

Runs two listeners:

* **Ingestion socket** (TCP, ``PY_INGEST_ADDR``) - the Rust core worker pushes
  newline delimited JSON packets with raw HTML into this socket.
* **Results API** (HTTP, ``PY_RESULTS_ADDR``) - the TypeScript gateway reads
  the transformed JSON payloads and exports back through this API.

New in v0.3:
* Export endpoints: ``/results/{id}/csv``, ``/results/{id}/markdown``,
  ``/results/{id}/parquet``, ``/results/{id}/excel``
* History endpoints: ``GET /history``, ``GET /history/{job_id}``
* History is recorded automatically when a job_complete packet arrives.

New in v0.4:
* ``GET /results/{id}`` negotiates its output format from ``?format=`` or the
  ``Accept`` header, so the same endpoint serves JSON, NDJSON, CSV, Parquet,
  Markdown and a downloadable corpus bundle.
* ``POST /render`` is the browser half of the hybrid fetcher: the Rust worker
  asks this service to render a page with a real browser when the cheap HTTP
  fetch is not enough.
* ``GET /history/{job_id}/pages`` exposes the per-page crawl trail.
"""

from __future__ import annotations

import json
import logging
import os
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from exporter import export_excel
from extractor import extract_packet, make_error_payload
from formats import FORMATS, build_table, extension_for
from formats import render as render_table
from render import RenderConfig, RenderService
from store import DEFAULT_DB_PATH, ResultStore

LOGGER = logging.getLogger("data-processor")

#: Media type -> format name, used when the caller negotiates with ``Accept``.
ACCEPT_FORMATS: tuple[tuple[str, str], ...] = (
    ("application/vnd.apache.parquet", "parquet"),
    ("application/x-ndjson", "ndjson"),
    ("application/x-parquet", "parquet"),
    ("application/zip", "bundle"),
    ("text/csv", "csv"),
    ("text/markdown", "markdown"),
    ("text/x-markdown", "markdown"),
    ("application/json", "json"),
)


def _env_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning("invalid integer for %s: %r, using default", key, raw)
        return default


# --------------------------------------------------------------------------- #
# Render service (shared by every request)
# --------------------------------------------------------------------------- #

_render_service: RenderService | None = None
_render_lock = threading.Lock()


def get_render_service() -> RenderService:
    """Return the shared render service, creating it on first use.

    The service owns the browser process, so it has to be a singleton -
    launching a browser per request would dominate the render time.
    """
    global _render_service
    with _render_lock:
        if _render_service is None:
            _render_service = RenderService(RenderConfig.from_env())
        return _render_service


def negotiate_format(accept_header: str | None) -> str:
    """Pick a result format from an ``Accept`` header.

    The caller can always override this with ``?format=``.  A missing header,
    ``*/*`` or an unrecognised media type falls back to JSON so a client
    always receives something usable.
    """
    if not accept_header:
        return "json"

    # Sort the accepted media types by quality so a client that prefers CSV
    # over JSON gets CSV even when JSON is listed first.
    weighted: list[tuple[float, int, str]] = []
    for index, part in enumerate(accept_header.split(",")):
        piece = part.strip()
        if not piece:
            continue
        media, _, params = piece.partition(";")
        quality = 1.0
        for param in params.split(";"):
            name, _, value = param.partition("=")
            if name.strip().lower() == "q":
                try:
                    quality = float(value.strip())
                except ValueError:
                    quality = 1.0
        weighted.append((quality, index, media.strip().lower()))

    weighted.sort(key=lambda item: (-item[0], item[1]))

    for _, _, media in weighted:
        if media in ("*/*", "application/*"):
            return "json"
        for supported, name in ACCEPT_FORMATS:
            if media == supported:
                return name

    return "json"


def build_result_envelope(job: dict[str, Any]) -> dict[str, Any]:
    """Build the JSON envelope for a job.

    The envelope keeps the original per-URL ``results`` array - the contract
    the gateway and existing customers rely on - and adds the flat, typed
    ``records`` table and the per-page ``documents`` list on top.  Analysts
    get a table, developers keep a stable shape.
    """
    job_id = str(job.get("job_id", ""))
    table = build_table(
        job.get("results", []),
        target=str(job.get("target") or "auto"),
        job_id=job_id,
        extra_meta={
            "status": job.get("status"),
            "received": job.get("received", 0),
            "succeeded": job.get("succeeded", 0),
            "failed": job.get("failed", 0),
            "created_at": job.get("created_at", 0),
            "updated_at": job.get("updated_at", 0),
        },
    )

    envelope = dict(job)
    envelope.update(
        {
            "generated_at": table.meta.get("generated_at", ""),
            "columns": table.columns,
            "document_count": table.meta.get("document_count", 0),
            "row_count": table.meta.get("row_count", 0),
            "documents": table.documents,
            "records": table.to_json_rows(),
        }
    )
    return envelope


# --------------------------------------------------------------------------- #
# Ingestion socket (Rust -> Python)
# --------------------------------------------------------------------------- #


class IngestHandler(socketserver.StreamRequestHandler):
    """Reads NDJSON packets from the Rust core worker."""

    def handle(self) -> None:  # noqa: D102 - stdlib contract
        store: ResultStore = self.server.store  # type: ignore[attr-defined]
        peer = self.client_address
        LOGGER.info("core worker connected from %s:%s", peer[0], peer[1])

        packets = 0
        for raw_line in self.rfile:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            try:
                packet = json.loads(line)
            except json.JSONDecodeError:
                LOGGER.warning("dropping malformed JSON line (%d bytes)", len(line))
                continue

            try:
                kind = packet.get("kind", "html")
                job_id = packet.get("job_id", "")

                if kind == "job_complete":
                    store.mark_job_complete(job_id)
                    LOGGER.info("job %s complete", job_id)
                else:
                    try:
                        payload = extract_packet(packet)
                    except Exception as exc:
                        # A transformation failure must still produce a result
                        # for this URL. Dropping the packet would silently
                        # remove the URL from the job and leave the summary
                        # short of the requested count.
                        LOGGER.exception(
                            "failed to transform packet for %s", packet.get("url", "")
                        )
                        payload = make_error_payload(
                            job_id=job_id,
                            url=packet.get("url", ""),
                            target=packet.get("target", "auto"),
                            error=f"extraction failed: {exc}",
                            status_code=packet.get("status_code"),
                            attempts=packet.get("attempts", 0),
                            elapsed_ms=packet.get("elapsed_ms", 0),
                        )

                    store.record_result(
                        job_id=job_id,
                        url=packet.get("url", ""),
                        ok=payload.get("status") == "ok",
                        status_code=packet.get("status_code"),
                        payload=payload,
                    )

                    # Per-page trail: what was fetched, how deep, which engine
                    # got it and whether an anti-bot challenge was met.
                    meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
                    store.record_page(
                        job_id=job_id,
                        url=packet.get("url", ""),
                        source_url=packet.get("source_url"),
                        depth=int(packet.get("depth") or 0),
                        status=str(payload.get("status") or "unknown"),
                        ok=payload.get("status") == "ok",
                        status_code=packet.get("status_code"),
                        engine=str(meta.get("engine") or "http"),
                        challenge=packet.get("challenge"),
                        elapsed_ms=int(packet.get("elapsed_ms") or 0),
                        row_count=int(payload.get("row_count") or 0),
                    )
                    packets += 1
                    LOGGER.info(
                        "job %s | %s | %s | rows=%d | depth_remaining=%d | browser=%s",
                        job_id,
                        packet.get("url", ""),
                        payload.get("status"),
                        payload.get("row_count", 0),
                        packet.get("crawl_depth_remaining", 0),
                        packet.get("browser_rendered", False),
                    )
            except Exception as exc:  # keep the socket alive on bad payloads
                LOGGER.exception("failed to process packet: %s", exc)

        LOGGER.info("core worker disconnected after %d packets", packets)


class IngestServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, store: ResultStore):
        super().__init__(address, IngestHandler)
        self.store = store


# --------------------------------------------------------------------------- #
# Results API (Python -> TypeScript gateway)
# --------------------------------------------------------------------------- #


class ResultsHandler(BaseHTTPRequestHandler):
    """Minimal JSON + binary API over the standard library."""

    server_version = "DataProcessor/0.3"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _send_binary(self, status: int, data: bytes, mime: str, filename: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _send_bytes(self, status: int, data: bytes, mime: str) -> None:
        """Send a binary body inline (no download prompt)."""
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib contract
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802 - stdlib contract
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        store: ResultStore = self.server.store  # type: ignore[attr-defined]

        # ---------------------------------------------------------------- #
        # Render (browser half of the hybrid fetcher)
        # ---------------------------------------------------------------- #
        if path == "/render":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body_bytes = self.rfile.read(content_len)
                data = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            except Exception:
                self._send(400, {"error": {"status": 400, "message": "invalid json"}})
                return

            if not isinstance(data, dict):
                self._send(400, {"error": {"status": 400, "message": "body must be an object"}})
                return

            url = str(data.get("url") or "").strip()
            if not url:
                self._send(400, {"error": {"status": 400, "message": "missing url"}})
                return

            click_selectors = data.get("click_selectors") or []
            if isinstance(click_selectors, str):
                click_selectors = [click_selectors]

            service = get_render_service()
            try:
                result = service.render(
                    url,
                    wait_for_selector=str(data.get("wait_for_selector") or ""),
                    scroll=bool(data.get("scroll", False)),
                    click_selectors=tuple(str(item) for item in click_selectors),
                    wait_after_ms=int(data.get("wait_after_ms") or 0),
                    extra_headers=data.get("headers") or None,
                    prefer_cloud=bool(data.get("prefer_cloud", False)),
                )
            except Exception as exc:
                LOGGER.exception("render failed for %s", url)
                self._send(500, {"error": {"status": 500, "message": f"render failed: {exc}"}})
                return

            self._send(200, result.to_dict())
            return

        if path == "/history":
            try:
                content_len = int(self.headers.get("Content-Length", 0))
                body_bytes = self.rfile.read(content_len)
                data = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                self._send(400, {"error": {"status": 400, "message": "invalid json"}})
                return

            job_id = data.get("job_id") or data.get("jobId")
            if not job_id:
                self._send(400, {"error": {"status": 400, "message": "missing job_id"}})
                return

            urls_seed = data.get("urls") or data.get("urls_seed") or []
            target = data.get("target", "auto")
            crawl_depth = int(data.get("crawl_depth", 0))
            label = data.get("label")
            user_id = data.get("user_id") or data.get("userId")

            store.record_history(
                job_id=job_id,
                urls_seed=urls_seed,
                target=target,
                crawl_depth=crawl_depth,
                label=label,
                user_id=user_id,
            )
            self._send(201, {"status": "ok", "job_id": job_id})
            return

        self._send(404, {"error": {"status": 404, "message": "not found"}})

    def do_GET(self) -> None:  # noqa: N802 - stdlib contract
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        store: ResultStore = self.server.store  # type: ignore[attr-defined]

        # ---------------------------------------------------------------- #
        # Health
        # ---------------------------------------------------------------- #
        if path == "/health":
            self._send(
                200,
                {
                    "status": "ok",
                    "service": "data-processor",
                    "version": "0.3.0",
                    "db_path": str(store.db_path),
                },
            )
            return

        # ---------------------------------------------------------------- #
        # Stats
        # ---------------------------------------------------------------- #
        if path == "/stats":
            hours = _env_int("PY_STATS_WINDOW_HOURS", 24)
            raw_hours = query.get("hours")
            if raw_hours:
                try:
                    hours = max(1, min(720, int(raw_hours[0])))
                except ValueError:
                    pass
            self._send(200, store.stats(hours))
            return

        # ---------------------------------------------------------------- #
        # Recent jobs list
        # ---------------------------------------------------------------- #
        if path == "/jobs":
            limit = 25
            raw_limit = query.get("limit")
            if raw_limit:
                try:
                    limit = max(1, min(200, int(raw_limit[0])))
                except ValueError:
                    pass
            self._send(200, {"jobs": store.recent_jobs(limit)})
            return

        # ---------------------------------------------------------------- #
        # Job results
        # ---------------------------------------------------------------- #
        if path.startswith("/results/"):
            remainder = path[len("/results/"):]
            parts = remainder.split("/")
            job_id = parts[0]
            export_format = parts[1] if len(parts) > 1 else None

            job = store.get_job(job_id)
            if job is None:
                self._send(404, {"error": {"status": 404, "message": "unknown job id"}})
                return

            # ---------------------------------------------------------- #
            # Format negotiation
            # ---------------------------------------------------------- #
            # `?format=` wins, then the `Accept` header, then JSON.
            requested = export_format
            if requested is None:
                raw_format = query.get("format")
                if raw_format:
                    requested = raw_format[0].strip().lower()
                else:
                    requested = negotiate_format(self.headers.get("Accept"))

            download = query.get("download", ["0"])[0] in ("1", "true", "yes")

            if requested in (None, "", "json"):
                self._send(200, build_result_envelope(job))
                return

            # `zip` is an accepted alias for the corpus bundle.
            if requested in ("zip", "bundle"):
                requested = "bundle"

            if requested == "excel":
                try:
                    data, mime, fname = export_excel(job)
                    self._send_binary(200, data, mime, fname)
                except ImportError as exc:
                    self._send(503, {"error": {"status": 503, "message": str(exc)}})
                except Exception as exc:
                    LOGGER.exception("excel export failed for job %s", job_id)
                    self._send(500, {"error": {"status": 500, "message": f"export failed: {exc}"}})
                return

            if requested not in FORMATS:
                self._send(
                    404,
                    {
                        "error": {
                            "status": 404,
                            "message": f"unknown export format: {requested}",
                            "supported": list(FORMATS) + ["excel"],
                        }
                    },
                )
                return

            try:
                table = build_table(
                    job.get("results", []),
                    target=str(job.get("target") or "auto"),
                    job_id=job_id,
                    extra_meta={
                        "status": job.get("status"),
                        "received": job.get("received", 0),
                        "succeeded": job.get("succeeded", 0),
                        "failed": job.get("failed", 0),
                        "created_at": job.get("created_at", 0),
                        "updated_at": job.get("updated_at", 0),
                    },
                )
                data, mime = render_table(table, requested)
                filename = f"{job_id}.{extension_for(requested)}"
                if download:
                    self._send_binary(200, data, mime, filename)
                else:
                    self._send_bytes(200, data, mime)
            except ImportError as exc:
                self._send(503, {"error": {"status": 503, "message": str(exc)}})
            except Exception as exc:
                LOGGER.exception("export failed for job %s format %s", job_id, requested)
                self._send(500, {"error": {"status": 500, "message": f"export failed: {exc}"}})
            return

        # ---------------------------------------------------------------- #
        # History
        # ---------------------------------------------------------------- #
        if path == "/history":
            limit = 50
            offset = 0
            raw_limit = query.get("limit")
            raw_offset = query.get("offset")
            if raw_limit:
                try:
                    limit = max(1, min(200, int(raw_limit[0])))
                except ValueError:
                    pass
            if raw_offset:
                try:
                    offset = max(0, int(raw_offset[0]))
                except ValueError:
                    pass
            entries = store.get_history(limit=limit, offset=offset)
            total = store.count_history()
            self._send(200, {"total": total, "limit": limit, "offset": offset, "entries": entries})
            return

        if path.startswith("/history/"):
            remainder = path[len("/history/"):]
            if remainder.endswith("/pages"):
                job_id = remainder[: -len("/pages")]
                pages = store.get_pages(job_id)
                self._send(200, {"job_id": job_id, "pages": pages, "count": len(pages)})
                return

            job_id = remainder
            entry = store.get_history_entry(job_id)
            if entry is None:
                self._send(404, {"error": {"status": 404, "message": "history entry not found"}})
                return
            entry["pages"] = store.get_pages(job_id)
            self._send(200, entry)
            return

        self._send(404, {"error": {"status": 404, "message": "not found"}})

    def do_DELETE(self) -> None:  # noqa: N802 - stdlib contract
        """Delete one crawl from the history."""
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        store: ResultStore = self.server.store  # type: ignore[attr-defined]

        if path.startswith("/history/"):
            job_id = path[len("/history/"):]
            if not job_id:
                self._send(404, {"error": {"status": 404, "message": "not found"}})
                return
            removed = store.delete_history(job_id)
            if not removed:
                self._send(404, {"error": {"status": 404, "message": "history entry not found"}})
                return
            self._send(200, {"status": "ok", "job_id": job_id, "deleted": True})
            return

        self._send(404, {"error": {"status": 404, "message": "not found"}})

    def log_message(self, fmt: str, *args) -> None:  # noqa: D102 - stdlib contract
        LOGGER.debug("results-api " + fmt, *args)


class ResultsServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, store: ResultStore):
        super().__init__(address, ResultsHandler)
        self.store = store


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    db_path = Path(os.environ.get("PY_DB_PATH", str(DEFAULT_DB_PATH)))
    store = ResultStore(db_path)

    ingest_host, ingest_port = os.environ.get("PY_INGEST_ADDR", "127.0.0.1:59081").rsplit(":", 1)
    results_host, results_port = os.environ.get("PY_RESULTS_ADDR", "127.0.0.1:59082").rsplit(":", 1)

    ingest_server = IngestServer((ingest_host, int(ingest_port)), store)
    results_server = ResultsServer((results_host, int(results_port)), store)

    ingest_thread = threading.Thread(target=ingest_server.serve_forever, daemon=True)
    ingest_thread.start()

    LOGGER.info("ingestion socket listening on %s:%s", ingest_host, ingest_port)
    LOGGER.info("results api listening on %s:%s", results_host, results_port)
    LOGGER.info("result store at %s", db_path)

    try:
        results_server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("shutting down")
    finally:
        ingest_server.shutdown()
        results_server.shutdown()
        store.close()


if __name__ == "__main__":
    main()
