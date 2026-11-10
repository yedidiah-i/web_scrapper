"""Regression checks for the extraction pipeline.

Run with the project virtual environment:

    .\\venv\\Scripts\\python.exe test_extractor.py
"""

import json
import sys

sys.path.insert(0, ".")

from extractor import _parse_price, extract_document

FAILURES = []


def check(name, condition, detail=""):
    if condition:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name} {detail}")
        FAILURES.append(name)


print("price parsing")
check("dollar amount", _parse_price("$19.99") == ("19.99", "$"), _parse_price("$19.99"))
check("euro amount", _parse_price("€1.234,56") == ("1234.56", "€"), _parse_price("€1.234,56"))
check("plain number", _parse_price("42") == ("42", ""), _parse_price("42"))
check("thousands separator", _parse_price("$1,234.00") == ("1234.00", "$"), _parse_price("$1,234.00"))
check("rounded amount", _parse_price("$19") == ("19", "$"), _parse_price("$19"))

print("custom selectors")
html = (
    "<html><head><title>T</title></head><body>"
    '<article><h2 class="head">Head</h2><p class="lead">Para one.</p>'
    '<p>Para two.</p><div><p>Nested</p></div></article></body></html>'
)
out = extract_document(html, url="https://x.com", target="auto", selectors=["p", "h2"], job_id="t")
texts = [r["text"] for r in out["data"]]
check("custom target used", out["target"] == "custom", out["target"])
check("custom rows extracted", out["row_count"] == 4, out["row_count"])
check("attributes preserved as object", isinstance(out["data"][0]["attributes"], dict), out["data"][0])
check("attribute value kept", any(r["attributes"].get("class") == "lead" for r in out["data"]), texts)
check("rows ordered numerically", [r["index"] for r in out["data"]] == ["1", "2", "3", "4"],
      [r["index"] for r in out["data"]])

print("text target")
out = extract_document(html, url="https://x.com", target="text", selectors=[], job_id="t")
check("text rows extracted", out["row_count"] == 4, out["row_count"])
check("text has no duplicates", len({r["text"] for r in out["data"]}) == out["row_count"], out["data"])

print("mixed attribute shapes")
mixed = (
    "<html><body><p class='a' id='b'>One</p><p class='c'>Two</p>"
    "<p>Three</p></body></html>"
)
out = extract_document(mixed, url="https://x.com", target="auto", selectors=["p"], job_id="t")
check("mixed attributes do not crash", out["status"] == "ok", out["status"])
check("mixed attributes keep every row", out["row_count"] == 3, out["row_count"])

print("tables target")
table_html = (
    "<html><body><table><thead><tr><th>Item</th><th>Price</th></tr></thead>"
    "<tbody><tr><td>Widget</td><td>12.99</td></tr></tbody></table></body></html>"
)
out = extract_document(table_html, url="https://x.com", target="tables", selectors=[], job_id="t")
check("table rows extracted", out["row_count"] == 1, out["row_count"])
check("values stay an object", isinstance(out["data"][0]["values"], dict), out["data"][0])
check("values mapped to headers", out["data"][0]["values"].get("Item") == "Widget", out["data"][0])

print("empty document")
out = extract_document("", url="https://x.com", target="auto", selectors=[], job_id="t")
check("empty html is an error", out["status"] == "error", out["status"])

print("prices target")
price_html = '<html><body><span class="price">$19.99</span></body></html>'
out = extract_document(price_html, url="https://x.com", target="prices", selectors=[], job_id="t")
check("price row extracted", out["row_count"] == 1, out["row_count"])
if out["row_count"] == 1:
    check("price label intact", out["data"][0]["label"] == "$19.99", out["data"][0]["label"])
    check("price amount parsed", out["data"][0]["amount"] == "19.99", out["data"][0]["amount"])
    check("price currency parsed", out["data"][0]["currency"] == "$", out["data"][0]["currency"])

print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) failed: {', '.join(FAILURES)}")
    sys.exit(1)

print("all checks passed")
