"""Multi-format export for crawl results.

Converts the structured JSON payloads stored in the SQLite result store into
formats that are easier to consume for different audiences:

| Format   | Audience                        | Endpoint                       |
|----------|---------------------------------|--------------------------------|
| CSV      | Spreadsheet users, SQL analysts | /results/{id}/csv              |
| Markdown | Humans, documentation           | /results/{id}/markdown         |
| Parquet  | Data scientists (Pandas/Polars) | /results/{id}/parquet          |
| Excel    | Business analysts               | /results/{id}/excel            |

All exporters return ``(bytes_or_str, mime_type, filename)`` tuples so the
HTTP handler can attach the right headers without knowing the format details.
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from datetime import datetime, timezone
from typing import Any

# Soft imports for heavy dependencies ─ only raise at call time if missing.
def _require_polars():
    try:
        import polars as pl  # noqa: F401
        return pl
    except ImportError:
        raise ImportError(
            "polars is required for Parquet/Excel export. "
            "Install it with: pip install polars pyarrow openpyxl"
        )


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #


def _all_rows(job: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten all per-URL data rows from a job result into a single list."""
    rows = []
    for entry in job.get("results", []):
        result = entry.get("result", {})
        url = entry.get("url", "")
        target = result.get("target", "")
        extracted_at = result.get("extracted_at", "")
        for row in result.get("data", []):
            rows.append(
                {
                    "_url": url,
                    "_target": target,
                    "_extracted_at": extracted_at,
                    **row,
                }
            )
    return rows


def _job_summary(job: dict[str, Any]) -> str:
    created = datetime.fromtimestamp(
        job.get("created_at", 0), tz=timezone.utc
    ).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"Job {job.get('job_id', '')} | "
        f"target={job.get('target', 'auto')} | "
        f"urls={job.get('received', 0)} | "
        f"success={job.get('succeeded', 0)} | "
        f"failed={job.get('failed', 0)} | "
        f"created={created}"
    )


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #


def export_csv(job: dict[str, Any]) -> tuple[bytes, str, str]:
    """Return (csv_bytes, mime_type, filename)."""
    rows = _all_rows(job)
    if not rows:
        # Return a minimal header-only CSV instead of an empty file.
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["_url", "_target", "_extracted_at", "(no data)"])
        return buf.getvalue().encode("utf-8"), "text/csv; charset=utf-8", f"{job.get('job_id', 'results')}.csv"

    # Collect the superset of all column names, keeping insertion order.
    all_keys: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for key in row:
            if key not in seen:
                all_keys.append(key)
                seen.add(key)

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=all_keys, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        # Serialise any nested dicts/lists to JSON strings so CSV stays flat.
        flat = {
            k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else v)
            for k, v in row.items()
        }
        writer.writerow(flat)

    return (
        buf.getvalue().encode("utf-8"),
        "text/csv; charset=utf-8",
        f"{job.get('job_id', 'results')}.csv",
    )


# --------------------------------------------------------------------------- #
# Markdown
# --------------------------------------------------------------------------- #


def export_markdown(job: dict[str, Any]) -> tuple[bytes, str, str]:
    """Return (md_bytes, mime_type, filename).

    Generates a readable Markdown document with:
    * A job summary header
    * Per-URL sections with a table of extracted data rows
    """
    lines: list[str] = []
    job_id = job.get("job_id", "unknown")
    lines.append(f"# Crawl Report — `{job_id}`\n")
    lines.append(f"> {_job_summary(job)}\n")

    for entry in job.get("results", []):
        url = entry.get("url", "")
        result = entry.get("result", {})
        status = result.get("status", "error")
        target = result.get("target", "auto")
        data = result.get("data", [])
        meta = result.get("meta", {})

        lines.append(f"\n## {url}\n")
        lines.append(f"- **Status:** `{status}`")
        lines.append(f"- **Target:** `{target}`")
        lines.append(f"- **Rows:** {len(data)}")

        doc_title = meta.get("document_title")
        if doc_title:
            lines.append(f"- **Page title:** {doc_title}")
        lines.append("")

        if status == "error":
            err = meta.get("error", "unknown error")
            lines.append(f"> ⚠️ **Error:** {err}\n")
            continue

        if not data:
            lines.append("*No rows extracted.*\n")
            continue

        # Build a Markdown table from the first few rows.
        fields = result.get("fields", list(data[0].keys()) if data else [])
        # Cap displayed columns to avoid 300-column monstrosities.
        display_fields = fields[:12]
        if len(fields) > 12:
            display_fields.append("…")

        header = "| " + " | ".join(str(f) for f in display_fields) + " |"
        sep = "|" + "|".join(" --- " for _ in display_fields) + "|"
        lines.append(header)
        lines.append(sep)

        for row in data[:50]:  # Limit rows in Markdown to stay readable
            cells = []
            for f in display_fields:
                if f == "…":
                    cells.append("…")
                    continue
                val = row.get(f, "")
                if isinstance(val, (dict, list)):
                    val = json.dumps(val, ensure_ascii=False)
                # Escape pipe characters inside cells
                cells.append(str(val).replace("|", "\\|")[:80])
            lines.append("| " + " | ".join(cells) + " |")

        if len(data) > 50:
            lines.append(f"\n*…and {len(data) - 50} more rows not shown.*")
        lines.append("")

    md = "\n".join(lines)
    return (
        md.encode("utf-8"),
        "text/markdown; charset=utf-8",
        f"{job_id}.md",
    )


# --------------------------------------------------------------------------- #
# Parquet
# --------------------------------------------------------------------------- #


def export_parquet(job: dict[str, Any]) -> tuple[bytes, str, str]:
    """Return (parquet_bytes, mime_type, filename).

    Writes one Parquet file per job.  All string columns are stored as
    ``pl.Utf8``; nested JSON objects are serialised to strings to keep the
    schema flat and compatible with any downstream reader.
    """
    pl = _require_polars()
    rows = _all_rows(job)
    job_id = job.get("job_id", "results")

    if not rows:
        # Return a valid but empty Parquet file.
        df = pl.DataFrame({"_url": [], "_target": [], "_extracted_at": []})
    else:
        # Collect superset of keys, normalise every value to a JSON-safe scalar.
        all_keys: list[str] = []
        seen: set[str] = set()
        for row in rows:
            for key in row:
                if key not in seen:
                    all_keys.append(key)
                    seen.add(key)

        normalised: list[dict[str, str]] = []
        for row in rows:
            norm = {}
            for key in all_keys:
                val = row.get(key)
                if val is None:
                    norm[key] = ""
                elif isinstance(val, (dict, list)):
                    norm[key] = json.dumps(val, ensure_ascii=False)
                else:
                    norm[key] = str(val)
            normalised.append(norm)

        df = pl.DataFrame(normalised, schema={k: pl.String for k in all_keys})

    buf = io.BytesIO()
    df.write_parquet(buf)
    return (
        buf.getvalue(),
        "application/octet-stream",
        f"{job_id}.parquet",
    )


# --------------------------------------------------------------------------- #
# Excel
# --------------------------------------------------------------------------- #


def export_excel(job: dict[str, Any]) -> tuple[bytes, str, str]:
    """Return (xlsx_bytes, mime_type, filename).

    Generates a multi-sheet Excel workbook:
    * **Summary** sheet — one row per URL with status, row count, latency
    * Per-target sheets — e.g. ``text``, ``tables``, etc.
    """
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError:
        raise ImportError(
            "openpyxl is required for Excel export. "
            "Install it with: pip install openpyxl"
        )

    wb = openpyxl.Workbook()
    job_id = job.get("job_id", "results")

    # ------------------------------------------------------------------ #
    # Summary sheet
    # ------------------------------------------------------------------ #
    ws_summary = wb.active
    ws_summary.title = "Summary"

    header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
    header_font = Font(color="FFFFFF", bold=True)
    ok_fill = PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid")
    err_fill = PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid")

    summary_headers = ["URL", "Status", "Target", "Rows", "Elapsed (ms)", "Extracted At"]
    for col_idx, h in enumerate(summary_headers, 1):
        cell = ws_summary.cell(row=1, column=col_idx, value=h)
        cell.fill = header_fill
        cell.font = header_font

    for row_idx, entry in enumerate(job.get("results", []), 2):
        result = entry.get("result", {})
        status = result.get("status", "error")
        meta = result.get("meta", {})
        fill = ok_fill if status == "ok" else err_fill

        row_data = [
            entry.get("url", ""),
            status,
            result.get("target", ""),
            result.get("row_count", 0),
            meta.get("elapsed_ms", ""),
            result.get("extracted_at", ""),
        ]
        for col_idx, val in enumerate(row_data, 1):
            cell = ws_summary.cell(row=row_idx, column=col_idx, value=val)
            cell.fill = fill

    # Auto-width for summary columns
    for col in ws_summary.columns:
        max_len = max((len(str(cell.value or "")) for cell in col), default=10)
        ws_summary.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 2, 60)

    # ------------------------------------------------------------------ #
    # Per-target data sheets
    # ------------------------------------------------------------------ #
    target_rows: dict[str, list[dict]] = {}
    for entry in job.get("results", []):
        result = entry.get("result", {})
        target = result.get("target", "data")
        url = entry.get("url", "")
        for row in result.get("data", []):
            target_rows.setdefault(target, []).append({"_url": url, **row})

    for target, rows in target_rows.items():
        sheet_name = target[:31]  # Excel sheet name limit
        ws = wb.create_sheet(title=sheet_name)

        if not rows:
            continue

        # Column headers
        all_keys: list[str] = []
        seen: set[str] = set()
        for row in rows:
            for key in row:
                if key not in seen:
                    all_keys.append(key)
                    seen.add(key)

        for col_idx, key in enumerate(all_keys, 1):
            cell = ws.cell(row=1, column=col_idx, value=key)
            cell.fill = header_fill
            cell.font = header_font

        for row_idx, row in enumerate(rows, 2):
            for col_idx, key in enumerate(all_keys, 1):
                val = row.get(key)
                if isinstance(val, (dict, list)):
                    val = json.dumps(val, ensure_ascii=False)
                ws.cell(row=row_idx, column=col_idx, value=val)

        # Auto-width
        for col in ws.columns:
            max_len = max((len(str(cell.value or "")) for cell in col), default=10)
            ws.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 2, 50)

    buf = io.BytesIO()
    wb.save(buf)
    return (
        buf.getvalue(),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        f"{job_id}.xlsx",
    )


# --------------------------------------------------------------------------- #
# Zip Bundle
# --------------------------------------------------------------------------- #


def export_bundle(job: dict[str, Any]) -> tuple[bytes, str, str]:
    """Return (zip_bytes, mime_type, filename).

    Creates a complete self-describing archive of the crawl:
    * ``manifest.json`` — crawl metadata, target, counts, timestamps
    * ``records.csv`` — flattened CSV of all extracted items
    * ``report.md`` — human-readable Markdown summary report
    * ``documents/*.json`` — individual per-URL extraction documents
    """
    job_id = job.get("job_id", "results")
    buf = io.BytesIO()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        # 1. Manifest
        manifest = {
            "schema": "scrapeworks.bundle/1",
            "job_id": job_id,
            "status": job.get("status", "unknown"),
            "target": job.get("target", "auto"),
            "received": job.get("received", 0),
            "succeeded": job.get("succeeded", 0),
            "failed": job.get("failed", 0),
            "created_at": job.get("created_at", 0),
            "updated_at": job.get("updated_at", 0),
        }
        archive.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

        # 2. CSV records
        csv_data, _, _ = export_csv(job)
        archive.writestr("records.csv", csv_data)

        # 3. Markdown report
        md_data, _, _ = export_markdown(job)
        archive.writestr("report.md", md_data)

        # 4. Individual per-URL JSON documents
        for idx, entry in enumerate(job.get("results", [])):
            fname = f"documents/{idx:04d}.json"
            archive.writestr(fname, json.dumps(entry, indent=2, ensure_ascii=False))

    return (
        buf.getvalue(),
        "application/zip",
        f"{job_id}.zip",
    )
