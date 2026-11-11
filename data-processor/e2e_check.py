"""End to end check of the scraping pipeline.

Boots three processes against a local test site:

* a static HTTP server that serves the test pages
* the Python data processor (ingestion socket + results API)
* the Rust core worker

then submits a crawl with a depth of two and checks that

* the seed page and both hops were fetched,
* the crawler followed the link inside the link (page C),
* the results are available in every negotiated format,
* the crawl shows up in the persistent history with its page trail.

Run with:  .\\venv\\Scripts\\python.exe e2e_check.py
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV_PY = ROOT / "data-processor" / "venv" / "Scripts" / "python.exe"
CORE_BIN = ROOT / "core_worker" / "target" / "release" / "core_worker.exe"
SITE_DIR = Path(os.environ.get("E2E_SITE_DIR", Path.home() / "AppData/Local/Temp/sw_e2e/site"))
E2E_DB = Path(os.environ.get("E2E_DB", Path.home() / "AppData/Local/Temp/sw_e2e/results.db"))

PASSED = 0
FAILED = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global PASSED, FAILED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED += 1
        print(f"  FAIL  {label}{(' - ' + detail) if detail else ''}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_for(url: str, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200:
                    return True
        except Exception:
            time.sleep(0.3)
    return False


def http_json(url: str, payload: dict | None = None, headers: dict | None = None):
    """Fetch a URL and return ``(body, content_type)``.

    A 404 is returned as ``(None, None)`` because the processor does not know
    a job until the first packet arrives.  The body is returned as bytes so
    binary formats (Parquet, the zip bundle) survive the round trip.
    """
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, headers=headers or {})
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            content_type = response.headers.get("Content-Type", "")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None, None
        raise
    if content_type.startswith(("text/", "application/json", "application/x-ndjson")):
        return body.decode("utf-8"), content_type
    return body, content_type


def main() -> int:
    site_port = free_port()
    results_port = free_port()
    ingest_port = free_port()
    engine_port = free_port()

    site_url = f"http://127.0.0.1:{site_port}"
    results_url = f"http://127.0.0.1:{results_port}"
    engine_url = f"http://127.0.0.1:{engine_port}"

    processes: list[subprocess.Popen] = []

    print("starting the pipeline")
    try:
        # 1. the test site
        processes.append(
            subprocess.Popen(
                [str(VENV_PY), "-m", "http.server", str(site_port), "--bind", "127.0.0.1", "--directory", str(SITE_DIR)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        )

        # 2. the data processor
        env = dict(os.environ)
        env.update(
            {
                "PY_RESULTS_ADDR": f"127.0.0.1:{results_port}",
                "PY_INGEST_ADDR": f"127.0.0.1:{ingest_port}",
                "PY_DB_PATH": str(E2E_DB),
                "LOG_LEVEL": "INFO",
            }
        )
        processes.append(
            subprocess.Popen(
                [str(VENV_PY), "server.py"],
                cwd=str(ROOT / "data-processor"),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
        )

        # 3. the core worker
        core_env = dict(os.environ)
        core_env.update(
            {
                "CORE_BIND_ADDR": f"127.0.0.1:{engine_port}",
                "PY_INGEST_ADDR": f"127.0.0.1:{ingest_port}",
                "PY_RESULTS_ADDR": f"127.0.0.1:{results_port}",
                "PY_RENDER_URL": f"{results_url}/render",
                "CORE_CRAWL_DEPTH": "3",
                "CORE_CRAWL_MAX_PAGES": "20",
                "CORE_CRAWL_MAX_LINKS_PER_PAGE": "10",
                "CORE_BROWSER_FALLBACK": "true",
                "CORE_WORKERS": "8",
                "CORE_ROTATE_UA": "true",
                "RUST_LOG": "info",
            }
        )
        processes.append(
            subprocess.Popen(
                [str(CORE_BIN)],
                cwd=str(ROOT / "core_worker"),
                env=core_env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
        )

        if not wait_for(f"{site_url}/index.html", timeout=20):
            print("  FAIL  the test site did not start")
            return 1
        if not wait_for(f"{results_url}/health", timeout=30):
            print("  FAIL  the data processor did not start")
            return 1
        if not wait_for(f"{engine_url}/health", timeout=30):
            print("  FAIL  the core worker did not start")
            return 1
        print("  the pipeline is up")

        # ------------------------------------------------------------------ #
        # Submit a crawl with two hops
        # ------------------------------------------------------------------ #
        body, _ = http_json(
            f"{engine_url}/jobs",
            {
                "urls": [f"{site_url}/index.html"],
                "target": "auto",
                "selectors": [],
                "crawl_depth": 2,
                "crawl_max_pages": 20,
                "label": "e2e run",
            },
        )
        accepted = json.loads(body)
        job_id = accepted["job_id"]
        print(f"  submitted job {job_id}")

        # Wait for the job to complete in the processor.
        job: dict = {}
        deadline = time.time() + 60
        while time.time() < deadline:
            raw, _ = http_json(f"{results_url}/results/{job_id}")
            if raw:
                job = json.loads(raw)
                if job.get("completed"):
                    break
            time.sleep(0.5)

        check("the job completed", bool(job.get("completed")), json.dumps(job)[:200])

        urls = [entry["url"] for entry in job.get("results", [])]
        check("the seed page was crawled", f"{site_url}/index.html" in urls, str(urls))
        check("the first hop was crawled", f"{site_url}/a.html" in urls, str(urls))
        check("the sibling hop was crawled", f"{site_url}/b.html" in urls, str(urls))
        check(
            "the link inside the link was crawled",
            f"{site_url}/c.html" in urls,
            str(urls),
        )
        check("four pages were fetched", len(urls) == 4, str(urls))
        check(
            "the crawl stayed inside the page budget",
            len(urls) <= 20,
            str(len(urls)),
        )

        # Depth must be recorded per page.
        documents = job.get("documents", [])
        depths = {doc["url"]: doc.get("depth") for doc in documents}
        check(
            "the depth of each page is recorded",
            depths.get(f"{site_url}/c.html") == 2,
            str(depths),
        )
        check(
            "the engine of each page is recorded",
            all(doc.get("engine") in ("http", "browser") for doc in documents),
            str([doc.get("engine") for doc in documents]),
        )

        # ------------------------------------------------------------------ #
        # Formats
        # ------------------------------------------------------------------ #
        csv_body, csv_type = http_json(f"{results_url}/results/{job_id}?format=csv")
        check("csv is served", csv_type.startswith("text/csv"), csv_type)
        check("csv has a header row", csv_body.splitlines()[0].startswith("page_url"), csv_body[:80])

        ndjson_body, ndjson_type = http_json(f"{results_url}/results/{job_id}?format=ndjson")
        check("ndjson is served", ndjson_type.startswith("application/x-ndjson"), ndjson_type)
        check(
            "ndjson has one record per line",
            all(line.strip().startswith("{") for line in ndjson_body.splitlines() if line.strip()),
        )

        parquet_body, parquet_type = http_json(f"{results_url}/results/{job_id}?format=parquet")
        check("parquet is served", "parquet" in parquet_type, parquet_type)
        check("parquet is binary", len(parquet_body) > 100, str(len(parquet_body)))

        md_body, md_type = http_json(f"{results_url}/results/{job_id}?format=markdown")
        check("markdown is served", md_type.startswith("text/markdown"), md_type)
        check("markdown names the pages", "Page C" in md_body or "c.html" in md_body)

        # Content negotiation through the Accept header.
        accept_body, accept_type = http_json(
            f"{results_url}/results/{job_id}", headers={"Accept": "text/csv"}
        )
        check("the Accept header negotiates csv", accept_type.startswith("text/csv"), accept_type)

        # The legacy envelope is still available.
        check("the json envelope keeps the results array", isinstance(job.get("results"), list))
        check("the json envelope adds the flat records", isinstance(job.get("records"), list))

        # ------------------------------------------------------------------ #
        # History
        # ------------------------------------------------------------------ #
        raw_history, _ = http_json(f"{results_url}/history?limit=10")
        history = json.loads(raw_history)
        entries = history.get("entries", [])
        entry = next((item for item in entries if item["job_id"] == job_id), None)
        check("the crawl is in the history", entry is not None, raw_history[:200])
        if entry:
            check("the history keeps the label", entry.get("label") == "e2e run", str(entry))
            check("the history keeps the depth", entry.get("crawl_depth") == 2, str(entry))
            check("the history counts the pages", entry.get("total_pages", 0) >= 4, str(entry))

        raw_pages, _ = http_json(f"{results_url}/history/{job_id}/pages")
        trail = json.loads(raw_pages).get("pages", [])
        check("the page trail has every page", len(trail) == 4, str(len(trail)))
        check(
            "the page trail records the depth",
            any(page["depth"] == 2 for page in trail),
            str(trail),
        )
        check(
            "the page trail records the engine",
            all(page["engine"] in ("http", "browser") for page in trail),
            str(trail),
        )

        # ------------------------------------------------------------------ #
        # Render endpoint
        # ------------------------------------------------------------------ #
        raw_render, _ = http_json(f"{results_url}/render", {"url": f"{site_url}/index.html"})
        rendered = json.loads(raw_render)
        check("the render endpoint answers", "html" in rendered, str(rendered)[:200])
        check(
            "the render endpoint reports a backend",
            rendered.get("backend") in ("local", "cloud", "none"),
            str(rendered.get("backend")),
        )

    finally:
        for process in processes:
            try:
                process.terminate()
            except Exception:
                pass
        time.sleep(0.5)
        for process in processes:
            try:
                process.kill()
            except Exception:
                pass

    print()
    print(f"{PASSED} checks passed, {FAILED} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
