#!/usr/bin/env python3
"""Tell Mynt (and the developer watching) which phase the build is in.

    python3 scripts/report_status.py <coding|auditing|checking|previewing|pushing> "<one line>"
"""
import json
import os
import sys

PHASES = {"coding", "auditing", "checking", "previewing", "pushing"}

if len(sys.argv) != 3 or sys.argv[1] not in PHASES:
    print(f"usage: report_status.py <{'|'.join(sorted(PHASES))}> \"<message>\"", file=sys.stderr)
    sys.exit(2)
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "job", "status.json")
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump({"phase": sys.argv[1], "message": sys.argv[2][:300]}, f)
os.replace(tmp, path)
print(f"status: {sys.argv[1]}")
