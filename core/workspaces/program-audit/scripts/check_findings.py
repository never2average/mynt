#!/usr/bin/env python3
"""Checks job/findings.json before the program-audit agent ends its turn: the shape Mynt reads, and that every
quote is really in the file it names (Mynt checks the same itself; this only saves a wasted finding)."""
import json, os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
review = json.load(open(os.path.join(HERE, "job", "review.json")))
path = os.path.join(HERE, review.get("output", "job/findings.json"))
problems = []
try:
    data = json.load(open(path))
except Exception as e:
    sys.exit(f"{path}: not valid JSON ({e})")
if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
    sys.exit("findings.json needs a top-level object with a 'findings' list")
squash = lambda s: re.sub(r"\s+", " ", s).strip()
for i, f in enumerate(data["findings"]):
    at = f"findings[{i}]"
    if not isinstance(f, dict):
        problems.append(f"{at}: not an object")
        continue
    if f.get("severity") not in ("critical", "high", "medium", "low", "info"):
        problems.append(f"{at}: severity must be critical, high, medium, low or info")
    for k in ("id", "title", "file", "quote", "description"):
        if not isinstance(f.get(k), str) or not f[k].strip():
            problems.append(f"{at}: '{k}' is required")
    file = str(f.get("file", "")).lstrip("./")
    src = os.path.join(review["source_dir"], file)
    if file and os.path.isfile(src):
        if len(squash(str(f.get("quote", "")))) < 8 or squash(str(f.get("quote", ""))) not in squash(open(src, errors="replace").read()):
            problems.append(f"{at}: the quote isn't in {file} (copy it exactly; at least a few words)")
    elif file:
        problems.append(f"{at}: no file '{file}' under source_dir (paths are relative to it)")
if not isinstance(data.get("summary"), str) or not data["summary"].strip():
    problems.append("'summary' is required: what you checked and what you found")
if problems:
    print("\n".join(problems))
    sys.exit(1)
print(f"ok: {len(data['findings'])} finding(s)")
