"""Tests for the multi-format output, the render detection helpers and the
persistent crawl history.

Run with:

    .\\venv\\Scripts\\python.exe test_formats_history.py
"""

from __future__ import annotations

import io
import json
import tempfile
import zipfile
from pathlib import Path

from formats import FORMATS, build_table, extension_for, render
from render import detect_challenge, looks_like_js_app
from server import build_result_envelope, negotiate_format
from store import ResultStore

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


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #

RESULTS = [
    {
        "url": "https://example.com/a",
        "ok": True,
        "status_code": 200,
        "created_at": 1_700_000_000.0,
        "result": {
            "job_id": "job-1",
            "url": "https://example.com/a",
            "status": "ok",
            "target": "tables",
            "extracted_at": "2026-01-01T00:00:00+00:00",
            "row_count": 2,
            "fields": ["index", "values"],
            "data": [
                {"index": "1", "values": {"name": "Widget", "price": "9.99"}},
                {"index": "2", "values": {"name": "Gadget", "price": "19.50"}},
            ],
            "meta": {
                "document_title": "Catalog",
                "engine": "http",
                "depth": 0,
                "source_url": "",
                "challenge": "",
            },
        },
    },
    {
        "url": "https://example.com/b",
        "ok": True,
        "status_code": 200,
        "created_at": 1_700_000_001.0,
        "result": {
            "job_id": "job-1",
            "url": "https://example.com/b",
            "status": "ok",
            "target": "tables",
            "extracted_at": "2026-01-01T00:00:05+00:00",
            "row_count": 1,
            "fields": ["index", "values"],
            "data": [{"index": "1", "values": {"name": "Doohickey", "price": "5.00"}}],
            "meta": {
                "document_title": "Catalog page 2",
                "engine": "browser",
                "depth": 1,
                "source_url": "https://example.com/a",
                "challenge": "",
            },
        },
    },
]

JOB = {
    "job_id": "job-1",
    "status": "completed",
    "target": "tables",
    "received": 2,
    "succeeded": 2,
    "failed": 0,
    "completed": True,
    "created_at": 1_700_000_000.0,
    "updated_at": 1_700_000_010.0,
    "results": RESULTS,
}


def table() -> object:
    return build_table(RESULTS, target="tables", job_id="job-1")


# --------------------------------------------------------------------------- #
# Format rendering
# --------------------------------------------------------------------------- #


def test_formats() -> None:
    print("format rendering")
    t = table()

    body, mime = render(t, "json")
    payload = json.loads(body)
    check("json carries the flat table", len(payload["records"]) == 3, str(payload.keys()))
    check("json promotes extracted fields to columns", "values" in payload["columns"], str(payload["columns"]))
    check("json keeps one document per page", len(payload["documents"]) == 2)
    check("json content type", mime.startswith("application/json"))

    # A flat extraction (no nested object column) promotes every field.
    flat = build_table(
        [
            {
                "url": "https://example.com/c",
                "result": {
                    "url": "https://example.com/c",
                    "status": "ok",
                    "target": "text",
                    "data": [{"index": "1", "tag": "p", "text": "hello"}],
                    "meta": {},
                },
            }
        ],
        job_id="job-2",
    )
    flat_payload = json.loads(render(flat, "json")[0])
    check("flat rows promote their fields", "text" in flat_payload["columns"], str(flat_payload["columns"]))

    body, mime = render(t, "ndjson")
    lines = [line for line in body.splitlines() if line.strip()]
    check("ndjson emits one line per document and record", len(lines) == 5, str(len(lines)))
    check("ndjson content type", mime.startswith("application/x-ndjson"))

    body, mime = render(t, "csv")
    text = body.decode("utf-8")
    header = text.splitlines()[0]
    check("csv header has the base columns", header.startswith("page_url,page_title"), header)
    check("csv holds every row", len(text.strip().splitlines()) == 4, str(len(text.splitlines())))
    check("csv content type", mime.startswith("text/csv"))

    body, mime = render(t, "parquet")
    check("parquet is a binary blob", isinstance(body, bytes) and len(body) > 0)
    check("parquet content type", "parquet" in mime)

    body, mime = render(t, "markdown")
    text = body.decode("utf-8")
    check("markdown lists both pages", "https://example.com/b" in text)
    check("markdown content type", mime.startswith("text/markdown"))

    body, mime = render(t, "bundle")
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        names = archive.namelist()
        check("bundle holds a manifest", "manifest.json" in names)
        check("bundle holds the flat table", "records.csv" in names)
        check("bundle holds the ndjson stream", "records.ndjson" in names)
        check("bundle holds a report", "report.md" in names)
        check("bundle holds one document per page", "documents/00000.json" in names)
        manifest = json.loads(archive.read("manifest.json"))
        check("bundle manifest counts the rows", manifest["row_count"] == 3)

    check("every format has an extension", all(extension_for(f) for f in FORMATS))
    body, _ = render(t, "not-a-format")
    check("unknown formats fall back to json", json.loads(body).get("records") is not None)


def test_negotiation() -> None:
    print("content negotiation")
    check("no accept header falls back to json", negotiate_format(None) == "json")
    check("wildcard falls back to json", negotiate_format("*/*") == "json")
    check("csv accept header", negotiate_format("text/csv") == "csv")
    check("ndjson accept header", negotiate_format("application/x-ndjson") == "ndjson")
    check("parquet accept header", negotiate_format("application/vnd.apache.parquet") == "parquet")
    check("markdown accept header", negotiate_format("text/markdown") == "markdown")
    check("zip accept header", negotiate_format("application/zip") == "bundle")
    check(
        "quality values are honoured",
        negotiate_format("application/json;q=0.2, text/csv;q=0.9") == "csv",
    )

    envelope = build_result_envelope(JOB)
    check("envelope keeps the legacy results array", len(envelope["results"]) == 2)
    check("envelope adds the flat records", len(envelope["records"]) == 3)
    check("envelope adds the page documents", len(envelope["documents"]) == 2)
    check("envelope keeps the job counters", envelope["received"] == 2)


# --------------------------------------------------------------------------- #
# Render detection
# --------------------------------------------------------------------------- #


def test_detection() -> None:
    print("challenge and SPA detection")
    check("cloudflare is detected", detect_challenge("<html>cf-browser-verification</html>") == "cloudflare")
    check("recaptcha is detected", detect_challenge('<div class="g-recaptcha">') == "recaptcha")
    check("hcaptcha is detected", detect_challenge("https://hcaptcha.com/assets/x") == "hcaptcha")
    check("turnstile is detected", detect_challenge("<div data-sitekey=turnstile>") == "turnstile")
    check(
        "a bot wall is detected",
        detect_challenge("<html>Verify you are human</html>") == "bot_wall",
    )
    check("a normal page has no challenge", detect_challenge("<html><body>hi</body></html>") is None)

    check("an SPA shell is detected", looks_like_js_app('<div id="root"></div>') is True)
    check("a normal page is not an SPA", looks_like_js_app("<html><body><p>text</p></body></html>") is False)


# --------------------------------------------------------------------------- #
# History store
# --------------------------------------------------------------------------- #


def test_history() -> None:
    print("crawl history")
    with tempfile.TemporaryDirectory() as tmp:
        db_path = Path(tmp) / "history.db"
        store = ResultStore(db_path)

        store.record_history(
            job_id="job-1",
            urls_seed=["https://example.com"],
            target="tables",
            crawl_depth=2,
            label="catalog run",
            user_id=7,
        )
        entries = store.get_history()
        check("history entry is stored", len(entries) == 1)
        check("history keeps the label", entries[0]["label"] == "catalog run")
        check("history keeps the depth", entries[0]["crawl_depth"] == 2)
        check("history keeps the seeds", entries[0]["urls_seed"] == ["https://example.com"])

        store.record_page(
            job_id="job-1",
            url="https://example.com/a",
            source_url=None,
            depth=0,
            status="ok",
            ok=True,
            status_code=200,
            engine="http",
        )
        store.record_page(
            job_id="job-1",
            url="https://example.com/b",
            source_url="https://example.com/a",
            depth=1,
            status="ok",
            ok=True,
            status_code=200,
            engine="browser",
            challenge="cloudflare",
        )
        pages = store.get_pages("job-1")
        check("both pages are in the trail", len(pages) == 2)
        check("the trail keeps the depth", pages[1]["depth"] == 1)
        check("the trail keeps the engine", pages[1]["engine"] == "browser")
        check("the trail keeps the challenge", pages[1]["challenge"] == "cloudflare")
        check("the trail keeps the parent page", pages[1]["source_url"] == "https://example.com/a")

        entry = store.get_history_entry("job-1")
        check("history detail is readable", entry is not None and entry["job_id"] == "job-1")

        store.record_result(
            job_id="job-1",
            url="https://example.com/a",
            ok=True,
            status_code=200,
            payload={"target": "tables", "status": "ok", "row_count": 1, "data": [], "meta": {}},
        )
        store.mark_job_complete("job-1")
        entry = store.get_history_entry("job-1")
        check("completion syncs the counters", entry["succeeded"] == 1, str(entry))
        check("completion records the page count", entry["total_pages"] == 1)

        check("history can be counted", store.count_history() == 1)
        check("history entries can be deleted", store.delete_history("job-1") is True)
        check("history is empty after deletion", store.count_history() == 0)
        check("the page trail is removed too", store.get_pages("job-1") == [])

        pruned = store.prune_history()
        check("pruning reports the remaining entries", pruned["remaining"] == 0)
        store.close()


def main() -> int:
    test_formats()
    test_negotiation()
    test_detection()
    test_history()

    print()
    print(f"{PASSED} checks passed, {FAILED} failed")
    return 1 if FAILED else 0


if __name__ == "__main__":
    raise SystemExit(main())
