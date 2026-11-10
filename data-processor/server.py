"""Data processor service.

Runs two listeners:

* **Ingestion socket** (TCP, ``PY_INGEST_ADDR``) - the Rust core worker pushes
  newline delimited JSON packets with raw HTML into this socket.
* **Results API** (HTTP, ``PY_RESULTS_ADDR``) - the TypeScript gateway reads
  the transformed JSON payloads back through this API.
"""

from __future__ import annotations

import json
import logging
import os
import socketserver
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from extractor import extract_packet, make_error_payload
from store import DEFAULT_DB_PATH, ResultStore

LOGGER = logging.getLogger("data-processor")


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
                    packets += 1
                    LOGGER.info(
                        "job %s | %s | %s | rows=%d",
                        job_id,
                        packet.get("url", ""),
                        payload.get("status"),
                        payload.get("row_count", 0),
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
    """Minimal JSON API over the standard library."""

    server_version = "DataProcessor/0.2"

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib contract
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib contract
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        store: ResultStore = self.server.store  # type: ignore[attr-defined]

        if path == "/health":
            self._send(
                200,
                {
                    "status": "ok",
                    "service": "data-processor",
                    "version": "0.2.0",
                    "db_path": str(store.db_path),
                },
            )
            return

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

        if path.startswith("/results/"):
            job_id = path[len("/results/") :]
            job = store.get_job(job_id)
            if job is None:
                self._send(404, {"error": {"status": 404, "message": "unknown job id"}})
                return
            self._send(200, job)
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
