"""Convenience entry point for the data processor.

Usage:
    python main.py          # start both listeners
    python main.py --selftest  # run the extraction self test
"""

from __future__ import annotations

import argparse
import sys

from extractor import extract_document

SAMPLE_HTML = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="description" content="Sample catalogue page">
    <meta property="og:title" content="Sample Catalogue">
    <title>Sample Catalogue</title>
</head>
<body>
    <article>
        <h1>Sample Catalogue</h1>
        <p>The first paragraph describes the product line.</p>
        <p>   The second paragraph   mentions pricing.   </p>
        <table>
            <thead><tr><th>Product</th><th>Price</th></tr></thead>
            <tbody>
                <tr><td>Widget A</td><td>$19.99</td></tr>
                <tr><td>Widget B</td><td>$24.50</td></tr>
            </tbody>
        </table>
        <img src="/img/widget.png" alt="Widget" width="300" height="200">
        <a href="/products/widget-a" title="Product page">Widget A</a>
    </article>
</body>
</html>
"""


def self_test() -> int:
    """Smoke test the extraction pipeline against a static document."""
    checks = [
        ("text", "text", 3),
        ("tables", "tables", 2),
        ("images", "images", 1),
        ("links", "links", 1),
        ("metadata", "metadata", 4),
        ("prices", "prices", 2),
    ]

    failures = 0
    for target, expected_target, expected_rows in checks:
        payload = extract_document(SAMPLE_HTML, url="https://example.com/catalogue", target=target)
        actual_target = payload["target"]
        rows = payload["row_count"]
        status = "ok"
        if actual_target != expected_target or rows != expected_rows:
            status = "FAIL"
            failures += 1
        print(
            f"  {status:<4} target={target:<9} resolved={actual_target:<9} rows={rows} (expected {expected_rows})"
        )

    auto = extract_document(SAMPLE_HTML, url="https://example.com/catalogue", target="auto")
    print(f"  {'ok' if auto['target'] == 'tables' else 'FAIL':<4} target=auto     resolved={auto['target']}")

    if failures:
        print(f"\n{failures} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Data transformation pipeline")
    parser.add_argument("--selftest", action="store_true", help="run the extraction self test")
    args = parser.parse_args()

    if args.selftest:
        return self_test()

    import server

    server.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
