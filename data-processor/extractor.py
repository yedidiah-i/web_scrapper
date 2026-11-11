"""Polars + selectolax transformation pipeline.

Takes the raw HTML payloads streamed by the Rust core worker, isolates the
requested target elements, cleans them through a Polars ``LazyFrame`` and
emits a strictly validated JSON payload that external customer code can
consume directly.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Iterable
from urllib.parse import urljoin

import polars as pl
from selectolax.parser import HTMLParser

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

TEXT_BLOCK_SELECTOR = (
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, dt, dd, figcaption, td, th"
)
_TEXT_BLOCK_TAGS = frozenset(
    {
        "p", "h1", "h2", "h3", "h4", "h5", "h6",
        "li", "blockquote", "pre", "dt", "dd", "figcaption", "td", "th",
    }
)
CONTENT_ROOT_SELECTOR = "article, main, [role='main']"
PRICE_SELECTOR = (
    "[class*='price'], [id*='price'], [data-price], [itemprop='price']"
)

# Fixed output schema per target so the Polars frame stays strongly typed and
# every emitted row has exactly the same keys.
TARGET_SCHEMAS: dict[str, list[str]] = {
    "text": ["index", "tag", "text"],
    "tables": ["index", "table_index", "headers", "row_index", "cells", "values"],
    "images": ["index", "src", "alt", "title", "width", "height"],
    "links": ["index", "href", "text", "rel", "title"],
    "metadata": ["index", "key", "value"],
    "prices": ["index", "label", "amount", "currency", "raw"],
    "custom": ["index", "tag", "text", "attributes"],
}

# Columns whose value is a JSON object rather than a plain string.
#
# Polars infers a struct type for dict values, and a struct column fails to
# build as soon as two rows carry different attribute sets (which is the norm
# on real pages). These columns are serialised to a JSON string before the
# cleaning pass and parsed back afterwards, so the frame stays rectangular.
JSON_OBJECT_COLUMNS: dict[str, set[str]] = {
    "tables": {"values"},
    "custom": {"attributes"},
}

# Columns that carry the actual payload of a row, per target.
#
# Used to drop rows that hold no content. Structural columns such as `index`
# or `tag` are always populated, so including them would make every row look
# non-empty and the filter would never drop anything.
CONTENT_COLUMNS: dict[str, list[str]] = {
    "text": ["text"],
    "tables": ["cells", "values"],
    "images": ["src", "alt", "title"],
    "links": ["href", "text"],
    "metadata": ["key", "value"],
    "prices": ["label", "amount", "currency", "raw"],
    "custom": ["text", "attributes"],
}

# JSON Schema (draft 2020-12) describing the emitted payload.
PAYLOAD_JSON_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "ExtractionResult",
    "type": "object",
    "required": [
        "job_id",
        "url",
        "status",
        "target",
        "extracted_at",
        "row_count",
        "fields",
        "data",
        "meta",
    ],
    "properties": {
        "job_id": {"type": "string"},
        "url": {"type": "string"},
        "status": {"type": "string", "enum": ["ok", "error"]},
        "target": {"type": "string"},
        "extracted_at": {"type": "string", "format": "date-time"},
        "row_count": {"type": "integer", "minimum": 0},
        "fields": {"type": "array", "items": {"type": "string"}},
        "data": {"type": "array", "items": {"type": "object"}},
        "meta": {"type": "object"},
    },
    "additionalProperties": False,
}

_WHITESPACE = re.compile(r"\s+")
_NUMERIC = re.compile(r"\d[\d.,]*")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _clean_text(value: str | None) -> str:
    """Collapse whitespace noise out of a raw text node."""
    if not value:
        return ""
    return _WHITESPACE.sub(" ", value.replace("\xa0", " ")).strip()


def _is_hidden(node) -> bool:
    """Cheap visibility check: inline style based hiding only."""
    style = (node.attributes or {}).get("style", "") or ""
    lowered = style.lower()
    return "display:none" in lowered.replace(" ", "") or "visibility:hidden" in lowered.replace(" ", "")


def _attr(node, name: str) -> str:
    return _clean_text((node.attributes or {}).get(name, "") or "")


def _parse_price(text: str) -> tuple[str, str]:
    """Split a price label into a numeric amount and a currency symbol."""
    match = _NUMERIC.search(text)
    raw = match.group(0) if match else ""
    amount = _normalise_amount(raw)

    currency = ""
    for symbol in ("$", "€", "£", "¥", "₹", "₽", "R"):
        if symbol in text:
            currency = symbol
            break
    if not currency:
        currency = next((c for c in text if c.isalpha() and c.upper() == c and len(c) == 3), "")
    return amount, currency


def _normalise_amount(raw: str) -> str:
    """
    Normalise a numeric string to a plain dotted decimal.

    Handles the two common conventions:

    * ``1,234.56`` -> ``1234.56`` (English, comma is a thousands separator)
    * ``1.234,56`` -> ``1234.56`` (European, dot is a thousands separator)

    The separator that appears last is the decimal one; the other is a
    thousands separator and is removed.
    """
    if not raw:
        return ""

    cleaned = raw.rstrip(".,")
    if not cleaned:
        return ""

    has_dot = "." in cleaned
    has_comma = "," in cleaned

    if has_dot and has_comma:
        # The right-most separator is the decimal separator.
        if cleaned.rfind(",") > cleaned.rfind("."):
            cleaned = cleaned.replace(".", "").replace(",", ".")
        else:
            cleaned = cleaned.replace(",", "")
    elif has_comma:
        # A single comma with exactly three trailing digits is a thousands
        # separator; otherwise it is a decimal comma.
        if cleaned.count(",") == 1 and len(cleaned.split(",")[1]) == 3:
            cleaned = cleaned.replace(",", "")
        else:
            cleaned = cleaned.replace(",", ".")
    elif has_dot:
        # Same rule for a dot: "1.234" is a thousands separator, "12.99" is
        # a decimal.
        if cleaned.count(".") == 1 and len(cleaned.split(".")[1]) == 3:
            cleaned = cleaned.replace(".", "")

    return cleaned


def _absolute(base_url: str, href: str) -> str:
    if not href:
        return ""
    if base_url:
        try:
            return urljoin(base_url, href)
        except ValueError:
            return href
    return href


# --------------------------------------------------------------------------- #
# Per target extraction
# --------------------------------------------------------------------------- #


def _has_text_block_descendant(node) -> bool:
    """True when the node contains another text block.

    `node.css()` includes the node itself, so it cannot be used here: every
    block element would match itself and be skipped. `iter()` walks the real
    descendants only.
    """
    return any(
        descendant.tag in _TEXT_BLOCK_TAGS
        for descendant in node.iter(include_text=False)
    )


def _extract_text(tree, base_url: str) -> list[dict[str, Any]]:
    """Visible text blocks, preferring article/main content when present."""
    root = tree.body
    if root is None:
        return []

    content = root.css_first(CONTENT_ROOT_SELECTOR)
    scope = content if content is not None else root

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    index = 0

    for node in scope.css(TEXT_BLOCK_SELECTOR):
        if _is_hidden(node):
            continue
        # Skip wrapper elements that merely contain other blocks, otherwise the
        # same text is emitted twice.
        if _has_text_block_descendant(node):
            continue
        text = _clean_text(node.text(deep=True, strip=True))
        if not text or text in seen:
            continue
        seen.add(text)
        index += 1
        rows.append({"index": index, "tag": node.tag, "text": text})

    return rows


def _extract_tables(tree, base_url: str) -> list[dict[str, Any]]:
    """Table entries flattened into header/value records."""
    rows: list[dict[str, Any]] = []
    index = 0

    for table_index, table in enumerate(tree.css("table")):
        header_nodes = table.css("thead th")
        if not header_nodes:
            header_nodes = table.css("tr:first-child th")
        headers = [_clean_text(n.text(strip=True)) for n in header_nodes]
        headers = [h for h in headers if h]

        body_rows = table.css("tbody tr") or table.css("tr")
        if header_nodes and body_rows:
            first = body_rows[0]
            if first.css("th") and not first.css("td"):
                body_rows = body_rows[1:]

        for row_index, row in enumerate(body_rows):
            cells = [_clean_text(c.text(strip=True)) for c in row.css("td")]
            if not cells:
                cells = [_clean_text(c.text(strip=True)) for c in row.css("th")]
            if not any(cells):
                continue

            values = dict(zip(headers, cells)) if headers else {}
            if not values:
                values = {f"column_{i + 1}": value for i, value in enumerate(cells)}

            index += 1
            rows.append(
                {
                    "index": index,
                    "table_index": table_index,
                    "headers": ", ".join(headers),
                    "row_index": row_index,
                    "cells": ", ".join(cells),
                    "values": values,
                }
            )

    return rows


def _extract_images(tree, base_url: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    for node in tree.css("img"):
        src = _attr(node, "src")
        if not src:
            continue
        index += 1
        rows.append(
            {
                "index": index,
                "src": _absolute(base_url, src),
                "alt": _attr(node, "alt"),
                "title": _attr(node, "title"),
                "width": _attr(node, "width"),
                "height": _attr(node, "height"),
            }
        )
    return rows


def _extract_links(tree, base_url: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    for node in tree.css("a"):
        href = _attr(node, "href")
        if not href:
            continue
        index += 1
        rows.append(
            {
                "index": index,
                "href": _absolute(base_url, href),
                "text": _clean_text(node.text(strip=True)),
                "rel": _attr(node, "rel"),
                "title": _attr(node, "title"),
            }
        )
    return rows


def _extract_metadata(tree, base_url: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0

    def push(key: str, value: str) -> None:
        nonlocal index
        value = _clean_text(value)
        if not value:
            return
        index += 1
        rows.append({"index": index, "key": key, "value": value})

    title = tree.css_first("title")
    if title is not None:
        push("title", title.text(strip=True))

    html = tree.css_first("html")
    if html is not None:
        push("language", _attr(html, "lang"))

    for meta in tree.css("meta"):
        name = _attr(meta, "name") or _attr(meta, "property")
        content = _attr(meta, "content")
        if name and content:
            push(name.lower(), content)

    canonical = tree.css_first('link[rel="canonical"]')
    if canonical is not None:
        push("canonical", _absolute(base_url, _attr(canonical, "href")))

    for heading in tree.css("h1"):
        text = _clean_text(heading.text(strip=True))
        if text:
            push("h1", text)

    return rows


def _extract_prices(tree, base_url: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    index = 0
    seen: set[str] = set()

    for node in tree.css(PRICE_SELECTOR):
        if _is_hidden(node):
            continue
        text = _clean_text(node.text(deep=True, strip=True))
        if not text or text in seen:
            continue
        seen.add(text)
        amount, currency = _parse_price(text)
        index += 1
        rows.append(
            {
                "index": index,
                "label": text,
                "amount": amount,
                "currency": currency,
                "raw": _attr(node, "data-price"),
            }
        )

    return rows


def _extract_custom(tree, base_url: str, selectors: Iterable[str]) -> list[dict[str, Any]]:
    """Custom CSS selector extraction with attributes preserved."""
    rows: list[dict[str, Any]] = []
    index = 0

    for selector in selectors:
        try:
            nodes = tree.css(selector)
        except Exception:
            continue
        for node in nodes:
            index += 1
            rows.append(
                {
                    "index": index,
                    "tag": node.tag,
                    "text": _clean_text(node.text(deep=True, strip=True)),
                    "attributes": dict(node.attributes or {}),
                }
            )

    return rows


def _resolve_target(tree, requested: str) -> str:
    """Pick the best target for the document when `auto` was requested."""
    if tree.css("table"):
        return "tables"
    if tree.css(PRICE_SELECTOR):
        return "prices"
    if tree.css("img"):
        return "images"
    if tree.css("a"):
        return "links"
    return "text"


# --------------------------------------------------------------------------- #
# Polars cleaning
# --------------------------------------------------------------------------- #


def _clean_with_polars(rows: list[dict[str, Any]], target: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Run the extracted rows through a Polars LazyFrame cleaning pass.

    Trims whitespace, drops null/empty anomalies and keeps the frame strictly
    rectangular before it is compiled back into JSON.
    """
    schema = TARGET_SCHEMAS.get(target, TARGET_SCHEMAS["text"])
    if not rows:
        return [], schema

    json_columns = JSON_OBJECT_COLUMNS.get(target, set())

    # Normalise every row to the exact schema so Polars infers a stable frame.
    # Object columns are serialised to JSON strings first: a dict value would
    # otherwise be inferred as a struct and fail to build as soon as two rows
    # carry different attribute sets, which is the norm on real pages.
    normalised: list[dict[str, Any]] = []
    for row in rows:
        item: dict[str, Any] = {}
        for key in schema:
            value = row.get(key)
            if key in json_columns:
                item[key] = json.dumps(value if value is not None else {}, ensure_ascii=False)
            elif value is None:
                item[key] = ""
            else:
                item[key] = str(value)
        normalised.append(item)

    frame = pl.DataFrame(normalised, schema={key: pl.String for key in schema})

    lazy = frame.lazy()
    string_columns = [pl.col(key).fill_null("").str.strip_chars() for key in schema]
    lazy = lazy.with_columns(string_columns)

    # Drop rows that carry no payload at all.
    #
    # Only the content columns count: the index and tag are always populated,
    # so including them would make every row non-empty.
    content_columns = [key for key in CONTENT_COLUMNS.get(target, []) if key in schema]
    if not content_columns:
        content_columns = [key for key in schema if key != "index"]

    lazy = lazy.filter(
        pl.any_horizontal([pl.col(key).str.len_chars() > 0 for key in content_columns])
    )

    # De-duplicate identical records.
    #
    # The index is a string column, so it has to be cast back to an integer
    # for the sort; sorting it as text would put "10" before "2".
    lazy = lazy.unique(subset=schema, keep="first").sort(
        pl.col("index").cast(pl.Int64, strict=False)
    )

    cleaned = lazy.collect().to_dicts()

    # Restore the object columns so the published payload keeps its JSON shape.
    for item in cleaned:
        for key in json_columns:
            raw = item.get(key) or "{}"
            try:
                item[key] = json.loads(raw)
            except json.JSONDecodeError:
                item[key] = {}

    return cleaned, schema


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #


def validate_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Assert the payload matches the published JSON schema (Substep 3.3)."""
    required = PAYLOAD_JSON_SCHEMA["required"]
    missing = [key for key in required if key not in payload]
    if missing:
        raise ValueError(f"payload missing required keys: {', '.join(missing)}")

    extra = [key for key in payload if key not in PAYLOAD_JSON_SCHEMA["properties"]]
    if extra:
        raise ValueError(f"payload has unexpected keys: {', '.join(extra)}")

    if payload["status"] not in ("ok", "error"):
        raise ValueError(f"invalid status: {payload['status']!r}")
    if not isinstance(payload["data"], list):
        raise ValueError("data must be a list")
    if not isinstance(payload["fields"], list):
        raise ValueError("fields must be a list")
    if not isinstance(payload["row_count"], int):
        raise ValueError("row_count must be an integer")
    if payload["row_count"] != len(payload["data"]):
        raise ValueError("row_count does not match data length")
    if not isinstance(payload["meta"], dict):
        raise ValueError("meta must be an object")

    return payload


def extract_document(
    html: str,
    url: str = "",
    target: str = "auto",
    selectors: Iterable[str] | None = None,
    job_id: str = "",
    extra_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Transform one raw HTML document into the production JSON payload."""
    selectors = list(selectors or [])
    target = (target or "auto").lower()
    requested_target = target

    if not html or not html.strip():
        payload = {
            "job_id": job_id,
            "url": url,
            "status": "error",
            "target": requested_target,
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "row_count": 0,
            "fields": [],
            "data": [],
            "meta": {"error": "empty document", **(extra_meta or {})},
        }
        return validate_payload(payload)

    tree = HTMLParser(html)

    if selectors:
        effective_target = "custom"
        rows = _extract_custom(tree, url, selectors)
    else:
        if target == "auto":
            effective_target = _resolve_target(tree, target)
        else:
            effective_target = target if target in TARGET_SCHEMAS else "text"

        if effective_target == "text":
            rows = _extract_text(tree, url)
        elif effective_target == "tables":
            rows = _extract_tables(tree, url)
        elif effective_target == "images":
            rows = _extract_images(tree, url)
        elif effective_target == "links":
            rows = _extract_links(tree, url)
        elif effective_target == "metadata":
            rows = _extract_metadata(tree, url)
        elif effective_target == "prices":
            rows = _extract_prices(tree, url)
        else:
            effective_target = "text"
            rows = _extract_text(tree, url)

    data, fields = _clean_with_polars(rows, effective_target)

    payload = {
        "job_id": job_id,
        "url": url,
        "status": "ok",
        "target": effective_target,
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "row_count": len(data),
        "fields": fields,
        "data": data,
        "meta": {
            "requested_target": requested_target,
            "selectors": selectors,
            "document_title": _clean_text(
                tree.css_first("title").text(strip=True) if tree.css_first("title") is not None else ""
            ),
            **(extra_meta or {}),
        },
    }

    return validate_payload(payload)


def make_error_payload(
    job_id: str,
    url: str,
    target: str,
    error: str,
    status_code: int | None = None,
    attempts: int = 0,
    elapsed_ms: int = 0,
) -> dict[str, Any]:
    """Build a valid error payload for a URL that could not be transformed."""
    return validate_payload(
        {
            "job_id": job_id,
            "url": url,
            "status": "error",
            "target": target,
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "row_count": 0,
            "fields": [],
            "data": [],
            "meta": {
                "error": error,
                "status_code": status_code,
                "attempts": attempts,
                "elapsed_ms": elapsed_ms,
            },
        }
    )


def extract_packet(packet: dict[str, Any]) -> dict[str, Any]:
    """Transform a raw packet coming from the Rust core worker."""
    job_id = packet.get("job_id", "")
    url = packet.get("url", "")
    ok = bool(packet.get("ok")) and bool(packet.get("html_content"))
    status_code = packet.get("status_code")

    # Crawl provenance travels with every page so the history view can show
    # where a page came from, which engine fetched it and whether an
    # anti-bot challenge was met.
    crawl_meta: dict[str, Any] = {
        "status_code": status_code,
        "attempts": packet.get("attempts", 1),
        "elapsed_ms": packet.get("elapsed_ms", 0),
        "depth": packet.get("depth", 0),
        "source_url": packet.get("source_url") or "",
        "engine": "browser" if packet.get("browser_rendered") else "http",
        "browser_rendered": bool(packet.get("browser_rendered", False)),
        "proxy_used": packet.get("proxy_used") or "",
        "challenge": packet.get("challenge") or "",
        "crawl_depth_remaining": packet.get("crawl_depth_remaining", 0),
    }

    if not ok:
        payload = {
            "job_id": job_id,
            "url": url,
            "status": "error",
            "target": packet.get("target", "auto"),
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "row_count": 0,
            "fields": [],
            "data": [],
            "meta": {
                "error": packet.get("error") or "fetch failed",
                **crawl_meta,
            },
        }
        return validate_payload(payload)

    return extract_document(
        html=packet.get("html_content", ""),
        url=url,
        target=packet.get("target", "auto"),
        selectors=packet.get("selectors") or [],
        job_id=job_id,
        extra_meta=crawl_meta,
    )
