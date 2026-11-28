#!/usr/bin/env python3
"""Checks job/report.json before the red team ends its turn, against the same JSON schema Mynt validates it with
(job/report.schema.json), and that every PoC a finding names has a run.sh. Mynt re-runs the PoCs itself; this only
catches a report Mynt would refuse.

Exit 0: the report is complete and valid. Exit 1: Mynt would refuse it; the problems are listed. Exit 2: valid, but
it says it is incomplete, which blocks the program."""
import json, os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TYPES = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}
KNOWN = {"$schema", "$id", "title", "description", "type", "required", "properties", "items", "enum", "const", "pattern",
         "maxLength", "minItems", "maxItems", "if", "then", "else"}


def validate(value, schema, at=""):
    """The part of JSON Schema the report's schema uses. An unknown keyword is an error, never skipped."""
    unknown = sorted(set(schema) - KNOWN)
    if unknown:
        raise SystemExit(f"check_report.py doesn't know the schema keyword(s) {', '.join(unknown)}: tell Mynt")
    here = at or "the report"
    problems = []
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(isinstance(value, TYPES[t]) for t in types):
            return [f"{here}: must be {' or '.join(types)}"]
    if "enum" in schema and value not in schema["enum"]:
        problems.append(f"{here}: must be one of {', '.join(map(str, schema['enum']))}")
    if "const" in schema and value != schema["const"]:
        problems.append(f"{here}: must be {json.dumps(schema['const'])}")
    if isinstance(value, str):
        if "pattern" in schema and not re.search(schema["pattern"], value):
            problems.append(f"{here}: must not be empty" if schema["pattern"] == r"\S" else f"{here}: must match {schema['pattern']}")
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            problems.append(f"{here}: at most {schema['maxLength']} characters")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            problems.append(f"{here}: needs at least {schema['minItems']} item(s)")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            problems.append(f"{here}: at most {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                problems += validate(item, schema["items"], f"{at}/{i}")
    if isinstance(value, dict):
        for k in schema.get("required", []):
            if k not in value:
                problems.append(f"{here}: '{k}' is required")
        for k, sub in schema.get("properties", {}).items():
            if k in value:
                problems += validate(value[k], sub, f"{at}/{k}")
    if "if" in schema:
        branch = schema.get("then") if not validate(value, schema["if"], at) else schema.get("else")
        if branch:
            problems += validate(value, branch, at)
    return problems


def main():
    target = json.load(open(os.path.join(HERE, "job", "target.json")))
    path = os.path.join(HERE, target.get("output", "job/report.json"))
    schema = json.load(open(os.path.join(HERE, target.get("schema", "job/report.schema.json"))))
    poc_dir = os.path.join(HERE, target.get("poc_dir", "job/poc"))
    if not os.path.isfile(path):
        sys.exit(f"{path} doesn't exist yet: write it (see CLAUDE.md, 'Finish')")
    try:
        data = json.load(open(path))
    except Exception as e:
        sys.exit(f"{path}: not valid JSON ({e})")
    problems = validate(data, schema)
    if not problems:
        for i, f in enumerate(data["findings"]):
            poc = f.get("poc")
            if poc is not None and not os.path.isfile(os.path.join(poc_dir, poc, "run.sh")):
                problems.append(f"/findings/{i}/poc: {target.get('poc_dir', 'job/poc')}/{poc}/run.sh doesn't exist")
    if problems:
        print("Mynt would refuse this report:\n" + "\n".join(problems))
        sys.exit(1)
    if data.get("complete") is False:
        print("valid, but INCOMPLETE (complete is false): Mynt blocks the program on this report. Leave it so only if "
              f"the program truly couldn't be attacked. Reason given: {data['incomplete_reason']}")
        sys.exit(2)
    print(f"ok: complete, {len(data['findings'])} finding(s), {sum(1 for f in data['findings'] if f.get('poc'))} with a PoC, "
          f"{len(data['attacks_tried'])} attack(s) tried")


if __name__ == "__main__":
    main()
