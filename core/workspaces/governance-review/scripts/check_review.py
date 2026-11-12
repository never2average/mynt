#!/usr/bin/env python3
"""Check job/review.json the way Mynt will, before you finish.

    python3 scripts/check_review.py

Every item the case asks you to answer must be present with a valid status. met and not_met need evidence;
every quote must appear in its saved source (fetched with fetch_page.py) or, for mynt://case, in the case;
silent needs searched_for. Exits 1 and lists the problems if anything is wrong.
"""
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_page import source_file  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
STATUSES = {"met", "not_met", "silent"}


def normalize(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[‘’‚′`]", "'", s)
    s = re.sub(r"[“”„″]", '"', s)
    s = re.sub(r"[‐-―−]", "-", s)
    return re.sub(r"\s+", " ", s.lower()).strip()


def main() -> int:
    case = json.load(open(os.path.join(ROOT, "job", "case.json"), encoding="utf-8"))
    try:
        review = json.load(open(os.path.join(ROOT, "job", "review.json"), encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(f"job/review.json is missing or not JSON: {e}")
        return 1
    case_text = normalize(json.dumps(case, ensure_ascii=False))
    wanted = [i["id"] for i in case.get("items", [])]
    got = {i.get("id"): i for i in review.get("items", []) if isinstance(i, dict)}
    problems = []
    for item_id in wanted:
        item = got.get(item_id)
        if not item:
            problems.append(f"{item_id}: missing")
            continue
        status = item.get("status")
        if status not in STATUSES:
            problems.append(f"{item_id}: status must be one of {sorted(STATUSES)}")
            continue
        if status == "silent" and not str(item.get("searched_for") or "").strip():
            problems.append(f"{item_id}: silent needs searched_for (what you looked for, and where)")
        evidence = item.get("evidence") or []
        if status in ("met", "not_met") and not evidence:
            problems.append(f"{item_id}: {status} needs at least one quote")
        for e in evidence:
            url, quote = e.get("source_url", ""), normalize(e.get("quote", ""))
            if len(quote) < 12:
                problems.append(f"{item_id}: a quote is too short to verify")
            elif url == "mynt://case":
                if quote not in case_text:
                    problems.append(f"{item_id}: quote not found in the case: {e.get('quote', '')[:60]!r}")
            elif not url.startswith("https://"):
                problems.append(f"{item_id}: source_url must be https:// or mynt://case")
            else:
                path = source_file(url)
                if not os.path.exists(path):
                    problems.append(f"{item_id}: fetch {url} with scripts/fetch_page.py before quoting it")
                elif quote not in normalize(open(path, encoding="utf-8").read()):
                    problems.append(f"{item_id}: quote not on {url}: {e.get('quote', '')[:60]!r}")
    extra = set(got) - set(wanted)
    if extra:
        problems.append(f"items not in the case (remove them): {sorted(extra)}")
    if problems:
        print("\n".join(problems))
        return 1
    print(f"review.json is ready: {len(wanted)} items checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
