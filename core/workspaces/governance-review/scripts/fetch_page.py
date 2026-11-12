#!/usr/bin/env python3
"""Fetch a public https page and save its readable text under sources/ for quoting.

    python3 scripts/fetch_page.py <url>

Prints the saved file and its size. Mynt extracts text from the page the same way when it verifies quotes, so
copy quotes from the saved file.
"""
import hashlib
import html
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCES = os.path.join(HERE, "..", "sources")
MAX_BYTES = 2 * 1024 * 1024


def page_text(content_type: str, body: str) -> str:
    if not re.search(r"html|xml", content_type, re.I) and not re.search(r"<html|<body|<div|<p[\s>]", body[:2000], re.I):
        return body
    body = re.sub(r"(?is)<(script|style|noscript|template)\b.*?</\1>", " ", body)
    body = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|td|th|h[1-6])>", " ", body)
    body = re.sub(r"<[^>]+>", " ", body)
    return html.unescape(body)


def source_file(url: str) -> str:
    return os.path.join(SOURCES, hashlib.sha256(url.encode()).hexdigest()[:16] + ".txt")


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].startswith("https://"):
        print("usage: fetch_page.py https://...", file=sys.stderr)
        return 2
    url = sys.argv[1]
    req = urllib.request.Request(url, headers={"User-Agent": "mynt-evidence-check", "Accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.5"})
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            content_type = res.headers.get("content-type", "")
            raw = res.read(MAX_BYTES)
    except Exception as e:  # noqa: BLE001 - report any fetch failure plainly
        print(f"couldn't fetch {url}: {e}", file=sys.stderr)
        return 1
    if "pdf" in content_type.lower():
        print(f"{url} is a PDF: Mynt can't verify PDF quotes yet; find an HTML view or record it in searched_for", file=sys.stderr)
        return 1
    text = page_text(content_type, raw.decode("utf-8", errors="replace"))
    if "json" in content_type.lower():
        try:
            text = json.dumps(json.loads(text), ensure_ascii=False, indent=1)
        except ValueError:
            pass
    os.makedirs(SOURCES, exist_ok=True)
    path = source_file(url)
    with open(path, "w", encoding="utf-8") as f:
        f.write(url + "\n" + text)
    print(f"saved {os.path.relpath(path)} ({len(text)} chars) for {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
