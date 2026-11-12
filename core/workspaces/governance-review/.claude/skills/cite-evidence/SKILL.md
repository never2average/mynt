---
name: cite-evidence
description: How to fetch sources and quote them so Mynt can verify every quote — use for every item before writing job/review.json.
---

# Citing evidence that Mynt can verify

Mynt re-fetches every `source_url` and checks that the quote is on the page after normalising case, spacing,
curly quotes and dashes. A quote it can't find doesn't count, and the item drops to "unverified".

- **Fetch before you quote:** `python3 scripts/fetch_page.py <url>` saves the page's text under `sources/`
  and prints the file name. Copy quotes from that saved text, not from memory or search snippets.
- **Quote enough to be unambiguous** (at least a dozen characters, usually one row or sentence), and nothing
  stitched together. Text separated on the page needs two quotes.
- **Use HTML pages or JSON APIs.** PDFs can't be verified yet: find an HTML view, or say in `searched_for`
  which PDF holds the answer.
- **Use `mynt://case`** to quote something from `job/case.json` (the product's text, the recorded law). Copy
  the value exactly.
- **Use stable URLs** without session tokens, and https only.
- **Absence claims** (`silent`, and "no enforcement found") list the pages and search terms you used in
  `searched_for`.

`python3 scripts/check_review.py` runs the same checks locally against your saved sources before you finish.
