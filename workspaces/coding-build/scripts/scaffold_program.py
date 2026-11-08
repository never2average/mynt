#!/usr/bin/env python3
"""Start a Solana (Anchor) program from templates/solana-program, next to the app.

usage: python3 scripts/scaffold_program.py <dest> [--name <snake_case>] [--program-id <address>] [--cluster devnet|mainnet]

Without --name/--program-id it takes the first program in job/build.json's solana.programs: the address Mynt
reserved for it, which the program must declare (declare_id! and Anchor.toml). Mynt deploys only a program that
declares its reserved address.
"""
import argparse, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(HERE, "templates", "solana-program")
SPEC = os.path.join(HERE, "job", "build.json")
DEFAULT_NAME = "mynt_program"
DEFAULT_ID = "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME"
ADDRESS = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def camel(name, upper):
    parts = name.split("_")
    head = parts[0].capitalize() if upper else parts[0]
    return head + "".join(p.capitalize() for p in parts[1:])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest")
    ap.add_argument("--name")
    ap.add_argument("--program-id")
    ap.add_argument("--cluster", default=None, choices=["devnet", "mainnet"])
    a = ap.parse_args()

    name, program_id, cluster = a.name, a.program_id, a.cluster
    if not (name and program_id) and os.path.exists(SPEC):
        programs = (json.load(open(SPEC)).get("solana") or {}).get("programs") or []
        match = next((p for p in programs if not name or p["name"] == name), None)
        if match:
            name, program_id, cluster = name or match["name"], program_id or match["program_id"], cluster or match["cluster"]
    name = name or DEFAULT_NAME
    program_id = program_id or DEFAULT_ID
    cluster = cluster or "devnet"
    if not re.match(r"^[a-z][a-z0-9_]{1,40}$", name):
        sys.exit("--name must be snake_case")
    if not ADDRESS.match(program_id):
        sys.exit("--program-id must be a Solana address")
    if os.path.exists(a.dest):
        sys.exit(f"{a.dest} already exists")

    shutil.copytree(TEMPLATE, a.dest, ignore=shutil.ignore_patterns("node_modules", "target", ".anchor", "test-ledger"))
    os.rename(os.path.join(a.dest, "programs", DEFAULT_NAME), os.path.join(a.dest, "programs", name))
    os.rename(os.path.join(a.dest, "tests", f"{DEFAULT_NAME}.ts"), os.path.join(a.dest, "tests", f"{name}.ts"))
    swaps = [
        (DEFAULT_ID, program_id),
        (camel(DEFAULT_NAME, True), camel(name, True)),
        (camel(DEFAULT_NAME, False), camel(name, False)),
        (DEFAULT_NAME, name),
    ]
    for d, _, files in os.walk(a.dest):
        for f in files:
            if f == "package-lock.json":
                continue
            p = os.path.join(d, f)
            text = open(p).read()
            new = text
            for old, value in swaps:
                new = new.replace(old, value)
            if f == "Anchor.toml" and cluster == "mainnet":
                new = new.replace("[programs.devnet]", "[programs.mainnet]")
            if new != text:
                open(p, "w").write(new)
    print(f"{name} ({program_id}, {cluster}) in {a.dest}")


if __name__ == "__main__":
    main()
