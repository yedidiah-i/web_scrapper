"""Verify store and exporter expansions."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, ".")

from store import ResultStore
from exporter import export_bundle, export_csv, export_excel, export_markdown, export_parquet

def test_store_and_exporters():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test.db"
        store = ResultStore(db_path)

        job_id = "test-job-123"
        url = "https://example.com/products"

        payload = {
            "job_id": job_id,
            "url": url,
            "status": "ok",
            "target": "tables",
            "extracted_at": "2026-11-11T10:00:00Z",
            "row_count": 2,
            "fields": ["index", "table_index", "headers", "row_index", "cells", "values"],
            "data": [
                {
                    "index": 1,
                    "table_index": 0,
                    "headers": "Product, Price",
                    "row_index": 0,
                    "cells": "Widget A, $19.99",
                    "values": {"Product": "Widget A", "Price": "$19.99"},
                },
                {
                    "index": 2,
                    "table_index": 0,
                    "headers": "Product, Price",
                    "row_index": 1,
                    "cells": "Widget B, $24.50",
                    "values": {"Product": "Widget B", "Price": "$24.50"},
                },
            ],
            "meta": {
                "document_title": "Products Page",
                "status_code": 200,
                "elapsed_ms": 120,
            },
        }

        # Record history
        store.record_history(
            job_id=job_id,
            urls_seed=[url],
            target="tables",
            crawl_depth=1,
            label="Product crawl",
        )

        # Record result
        store.record_result(
            job_id=job_id,
            url=url,
            ok=True,
            status_code=200,
            payload=payload,
        )

        # Mark job complete
        store.mark_job_complete(job_id)

        # Retrieve job
        retrieved = store.get_job(job_id)
        assert retrieved is not None, "get_job returned None"
        assert retrieved["completed"] is True
        assert len(retrieved["results"]) == 1
        res0 = retrieved["results"][0]["result"]
        assert res0["row_count"] == 2
        assert res0["data"][0]["values"]["Product"] == "Widget A"
        print("  PASS store: record_result, mark_complete, get_job with compression")

        # History checks
        history = store.get_history(limit=10)
        assert len(history) == 1
        assert history[0]["job_id"] == job_id
        assert history[0]["label"] == "Product crawl"
        assert history[0]["crawl_depth"] == 1
        assert history[0]["succeeded"] == 1

        entry = store.get_history_entry(job_id)
        assert entry is not None
        assert entry["summary"] is not None
        print("  PASS store: get_history and get_history_entry")

        # Exporters
        csv_bytes, csv_mime, csv_fn = export_csv(retrieved)
        assert b"Widget A" in csv_bytes
        assert "text/csv" in csv_mime
        print(f"  PASS export_csv ({len(csv_bytes)} bytes)")

        md_bytes, md_mime, md_fn = export_markdown(retrieved)
        assert b"Products Page" in md_bytes
        assert b"Widget A" in md_bytes
        assert "markdown" in md_mime
        print(f"  PASS export_markdown ({len(md_bytes)} bytes)")

        try:
            pq_bytes, pq_mime, pq_fn = export_parquet(retrieved)
            assert len(pq_bytes) > 0
            print(f"  PASS export_parquet ({len(pq_bytes)} bytes)")
        except ImportError as e:
            print(f"  SKIP export_parquet (missing dependency: {e})")

        try:
            xl_bytes, xl_mime, xl_fn = export_excel(retrieved)
            assert len(xl_bytes) > 0
            print(f"  PASS export_excel ({len(xl_bytes)} bytes)")
        except ImportError as e:
            print(f"  SKIP export_excel (missing dependency: {e})")

        zip_bytes, zip_mime, zip_fn = export_bundle(retrieved)
        assert len(zip_bytes) > 0
        assert zip_mime == "application/zip"
        print(f"  PASS export_bundle ({len(zip_bytes)} bytes)")

        store.close()

if __name__ == "__main__":
    test_store_and_exporters()
    print("All store and exporter tests passed!")
