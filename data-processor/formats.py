"""Multi-format rendering of extraction results.

The pipeline used to publish one shape: a JSON object with a ``fields`` list
and a ``data`` array of loosely typed rows. That is awkward for both audiences
the platform serves - analysts want a table, and application developers want a
stable typed contract.

This module keeps the extracted records in one canonical, flat form and then
renders that form into whatever the caller asked for:

* ``json``   - the full envelope, with typed records (backwards friendly)
* ``ndjson`` - one JSON record per line, for streaming consumers
* ``csv``    - a flat table, for spreadsheets and quick analysis
* ``parquet`` - a columnar table, for pandas / Polars / DuckDB
* ``markdown`` - a readable report, for people rather than pipelines
* ``bundle`` - a zip holding the manifest, the per-page documents and the
  flat table, for archiving a crawl as a self-describing artefact

Every renderer works from the same :class:`ResultTable`, so the formats can
never drift apart.
"""

from __future__ import annotations

import csv
import io
import json
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable

# --------------------------------------------------------------------------- #
# Canonical table
# --------------------------------------------------------------------------- #

#: Columns every table carries, in order. Target specific columns follow.
BASE_COLUMNS: tuple[str, ...] = (
    "page_url",
    "page_title",
    "source_url",
    "depth",
    "fetched_at",
    "status",
    "engine",
    "target",
    "row_index",
    "row",
)


@dataclass
class ResultTable:
    """A flat, typed table built from the per-page extraction payloads."""

    columns: list[str]
    records: list[dict[str, Any]] = field(default_factory=list)
    documents: list[dict[str, Any]] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def row_count(self) -> int:
        return len(self.records)

    def to_json_rows(self) -> list[dict[str, Any]]:
        """Return the records with every value coerced to a JSON type."""
        return [_jsonify_row(row) for row in self.records]


def _jsonify_value(value: Any) -> Any:
    """Coerce a single cell into something JSON can represent."""
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _jsonify_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonify_value(v) for v in value]
    return str(value)


def _jsonify_row(row: dict[str, Any]) -> dict[str, Any]:
    return {str(key): _jsonify_value(value) for key, value in row.items()}


def _cell(value: Any) -> str:
    """Render a cell as a flat string for the tabular formats."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)):
        return str(value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if isinstance(value, (list, tuple, set)):
        return json.dumps(_jsonify_value(value), ensure_ascii=False)
    return str(value)


# --------------------------------------------------------------------------- #
# Building the table
# --------------------------------------------------------------------------- #


def build_table(
    results: Iterable[dict[str, Any]],
    *,
    target: str = "auto",
    job_id: str = "",
    extra_meta: dict[str, Any] | None = None,
) -> ResultTable:
    """Flatten per-page extraction payloads into one typed table.

    Each input is the envelope the transformation layer publishes for a single
    page. Every extracted row becomes one table row, and each page also
    produces a document record holding the page level facts (title, status,
    engine, link to its source) so a crawler can be audited afterwards.
    """
    results = list(results)
    columns: list[str] = list(BASE_COLUMNS)
    records: list[dict[str, Any]] = []
    documents: list[dict[str, Any]] = []

    for entry in results:
        payload = entry.get("result") if isinstance(entry.get("result"), dict) else entry
        if not isinstance(payload, dict):
            continue

        url = str(payload.get("url") or entry.get("url") or "")
        status = str(payload.get("status") or "unknown")
        page_meta = payload.get("meta") if isinstance(payload.get("meta"), dict) else {}
        extracted_at = str(payload.get("extracted_at") or "")
        page_target = str(payload.get("target") or target)
        engine = str(page_meta.get("engine") or page_meta.get("fetch_engine") or "http")
        depth = page_meta.get("depth", 0)
        source_url = str(page_meta.get("source_url") or "")
        title = str(page_meta.get("title") or "")

        data = payload.get("data") if isinstance(payload.get("data"), list) else []
        fields = payload.get("fields") if isinstance(payload.get("fields"), list) else []

        documents.append(
            {
                "url": url,
                "title": title,
                "source_url": source_url,
                "depth": depth,
                "status": status,
                "engine": engine,
                "target": page_target,
                "fetched_at": extracted_at,
                "row_count": len(data),
                "fields": list(fields),
                "links": list(page_meta.get("links") or []),
                "meta": dict(page_meta),
            }
        )

        for index, row in enumerate(data):
            if not isinstance(row, dict):
                continue
            flat: dict[str, Any] = {
                "page_url": url,
                "page_title": title,
                "source_url": source_url,
                "depth": depth,
                "fetched_at": extracted_at,
                "status": status,
                "engine": engine,
                "target": page_target,
                "row_index": index,
                "row": {k: _jsonify_value(v) for k, v in row.items()},
            }
            # Promote the extracted fields to their own columns so the table is
            # genuinely tabular instead of one nested blob per row.
            for key, value in row.items():
                name = str(key)
                if name not in columns:
                    columns.append(name)
                flat[name] = _jsonify_value(value)
            records.append(flat)

    meta = {
        "job_id": job_id,
        "target": target,
        "document_count": len(documents),
        "row_count": len(records),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        **(extra_meta or {}),
    }

    return ResultTable(columns=columns, records=records, documents=documents, meta=meta)


# --------------------------------------------------------------------------- #
# Renderers
# --------------------------------------------------------------------------- #


def render_json(table: ResultTable) -> tuple[str, str]:
    """Return ``(body, content_type)`` for the JSON format."""
    body = {
        "job_id": table.meta.get("job_id", ""),
        "target": table.meta.get("target", ""),
        "generated_at": table.meta.get("generated_at", ""),
        "document_count": table.meta.get("document_count", 0),
        "row_count": table.meta.get("row_count", 0),
        "columns": table.columns,
        "documents": table.documents,
        "records": table.to_json_rows(),
        "meta": table.meta,
    }
    return json.dumps(body, ensure_ascii=False, indent=2), "application/json; charset=utf-8"


def render_ndjson(table: ResultTable) -> tuple[str, str]:
    """Return ``(body, content_type)`` for the JSON Lines format."""
    buffer = io.StringIO()
    for document in table.documents:
        buffer.write(json.dumps({"type": "document", **document}, ensure_ascii=False))
        buffer.write("\n")
    for record in table.to_json_rows():
        buffer.write(json.dumps({"type": "record", **record}, ensure_ascii=False))
        buffer.write("\n")
    return buffer.getvalue(), "application/x-ndjson; charset=utf-8"


def render_csv(table: ResultTable) -> tuple[str, str]:
    """Return ``(body, content_type)`` for the CSV format."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(table.columns)
    for record in table.records:
        writer.writerow([_cell(record.get(column)) for column in table.columns])
    return buffer.getvalue(), "text/csv; charset=utf-8"


def render_parquet(table: ResultTable) -> tuple[bytes, str]:
    """Return ``(body, content_type)`` for the Parquet format.

    Polars is already a dependency of this service, so the columnar writer
    comes for free and produces a file pandas and DuckDB both read directly.
    """
    import polars as pl

    if table.records:
        frame = pl.DataFrame(
            [_jsonify_row(record) for record in table.records],
            infer_schema_length=None,
        )
    else:
        frame = pl.DataFrame({column: [] for column in table.columns[:1]})

    buffer = io.BytesIO()
    frame.write_parquet(buffer)
    return buffer.getvalue(), "application/vnd.apache.parquet"


def render_markdown(table: ResultTable) -> tuple[str, str]:
    """Return ``(body, content_type)`` for the Markdown report."""
    lines: list[str] = ["# Scrapeworks crawl report", ""]
    meta = table.meta
    lines.append(f"- **Job**: `{meta.get('job_id', '')}`")
    lines.append(f"- **Target**: `{meta.get('target', '')}`")
    lines.append(f"- **Generated**: {meta.get('generated_at', '')}")
    lines.append(f"- **Pages**: {meta.get('document_count', 0)}")
    lines.append(f"- **Rows**: {meta.get('row_count', 0)}")
    lines.append("")

    lines.append("## Pages")
    lines.append("")
    lines.append("| URL | Status | Engine | Depth | Rows |")
    lines.append("| --- | --- | --- | --- | --- |")
    for document in table.documents:
        lines.append(
            "| {url} | {status} | {engine} | {depth} | {rows} |".format(
                url=document.get("url", ""),
                status=document.get("status", ""),
                engine=document.get("engine", ""),
                depth=document.get("depth", 0),
                rows=document.get("row_count", 0),
            )
        )
    lines.append("")

    if table.records:
        lines.append("## Rows")
        lines.append("")
        preview = table.records[:200]
        columns = table.columns
        lines.append("| " + " | ".join(columns) + " |")
        lines.append("| " + " | ".join("---" for _ in columns) + " |")
        for record in preview:
            lines.append(
                "| " + " | ".join(_cell(record.get(column)) for column in columns) + " |"
            )
        if len(table.records) > len(preview):
            lines.append("")
            lines.append(f"_Showing {len(preview)} of {len(table.records)} rows._")
    else:
        lines.append("_No rows were extracted._")

    return "\n".join(lines), "text/markdown; charset=utf-8"


def render_bundle(table: ResultTable) -> tuple[bytes, str]:
    """Return ``(body, content_type)`` for the zip bundle.

    The bundle holds a manifest, one JSON document per page and the flat
    table, so an archived crawl stays readable without this service running.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": "scrapeworks.bundle/1",
                    "job_id": table.meta.get("job_id", ""),
                    "target": table.meta.get("target", ""),
                    "generated_at": table.meta.get("generated_at", ""),
                    "document_count": table.meta.get("document_count", 0),
                    "row_count": table.meta.get("row_count", 0),
                    "columns": table.columns,
                },
                ensure_ascii=False,
                indent=2,
            ),
        )

        documents_dir = "documents"
        for index, document in enumerate(table.documents):
            name = f"{documents_dir}/{index:05d}.json"
            archive.writestr(
                name, json.dumps(document, ensure_ascii=False, indent=2)
            )

        csv_body, _ = render_csv(table)
        archive.writestr("records.csv", csv_body)

        ndjson_body, _ = render_ndjson(table)
        archive.writestr("records.ndjson", ndjson_body)

        markdown_body, _ = render_markdown(table)
        archive.writestr("report.md", markdown_body)

    return buffer.getvalue(), "application/zip"


#: Format name -> (renderer, default file extension).
RENDERERS: dict[str, tuple[Any, str]] = {
    "json": (render_json, "json"),
    "ndjson": (render_ndjson, "ndjson"),
    "csv": (render_csv, "csv"),
    "parquet": (render_parquet, "parquet"),
    "markdown": (render_markdown, "md"),
    "bundle": (render_bundle, "zip"),
}

#: Every format this module can produce.
FORMATS: tuple[str, ...] = tuple(RENDERERS.keys())

#: Media type used when a format is requested but cannot be produced.
FALLBACK_CONTENT_TYPE = "application/json; charset=utf-8"


def extension_for(fmt: str) -> str:
    """File extension used when a format is served as a download."""
    return RENDERERS.get(fmt.lower(), (None, "json"))[1]


def render(table: ResultTable, fmt: str) -> tuple[bytes, str]:
    """Render the table in ``fmt`` and return ``(body, content_type)``.

    Unknown formats fall back to JSON so a client never receives an empty
    body, and text formats are encoded to bytes here so every caller can
    treat the result uniformly.
    """
    key = (fmt or "json").lower().strip()
    renderer = RENDERERS.get(key)
    if renderer is None:
        key = "json"
        renderer = RENDERERS["json"]

    body, content_type = renderer[0](table)
    if isinstance(body, bytes):
        return body, content_type
    return body.encode("utf-8"), content_type
