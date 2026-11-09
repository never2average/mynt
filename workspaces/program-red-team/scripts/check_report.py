#!/usr/bin/env python3
"""Checks job/report.json and the proofs of concept before the red team ends its turn: the shape Mynt reads, and
that every PoC a finding names has a run.sh. Mynt re-runs the PoCs itself; this only catches a missing file."""
import json, os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
target = json.load(open(os.path.join(HERE, "job", "target.json")))
path = os.path.join(HERE, target.get("output", "job/report.json"))
poc_dir = os.path.join(HERE, target.get("poc_dir", "job/poc"))
problems = []
try:
    data = json.load(open(path))
except Exception as e:
    sys.exit(f"{path}: not valid JSON ({e})")
if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
    sys.exit("report.json needs a top-level object with a 'findings' list")
for i, f in enumerate(data["findings"]):
    at = f"findings[{i}]"
    if not isinstance(f, dict):
        problems.append(f"{at}: not an object")
        continue
    if f.get("severity") not in ("critical", "high", "medium", "low", "info"):
        problems.append(f"{at}: severity must be critical, high, medium, low or info")
    for k in ("id", "title", "description"):
        if not isinstance(f.get(k), str) or not f[k].strip():
            problems.append(f"{at}: '{k}' is required")
    poc = f.get("poc")
    if poc is not None:
        if not isinstance(poc, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", poc):
            problems.append(f"{at}: poc must be a folder name under {target.get('poc_dir', 'job/poc')} (letters, digits, _ and -)")
        elif not os.path.isfile(os.path.join(poc_dir, poc, "run.sh")):
            problems.append(f"{at}: {poc}/run.sh doesn't exist")
if not isinstance(data.get("attacks_tried"), list) or not data["attacks_tried"]:
    problems.append("'attacks_tried' is required: each attack you tried and what happened")
if not isinstance(data.get("summary"), str) or not data["summary"].strip():
    problems.append("'summary' is required")
if problems:
    print("\n".join(problems))
    sys.exit(1)
print(f"ok: {len(data['findings'])} finding(s), {sum(1 for f in data['findings'] if f.get('poc'))} with a PoC")
