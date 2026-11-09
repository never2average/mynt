// The scripts Mynt runs in its own sandboxes for the mainnet program gate (src/solana/mainnet-gate.ts). No agent
// writes or edits them; Mynt reads their results back itself.

// Open-source static analysis, each tool pinned and checked against its sha256 before it runs:
//   - cargo-audit (RustSec), the release binary, against the RustSec advisory database (fetched fresh: the
//     point is today's advisories) for the Cargo.lock the build compiled with;
//   - Radar (Auditware), its source at a pinned commit (tarball sha256) and its images by digest, over the
//     program's Rust. Radar honours `radar-disable` comments in the code it scans; Mynt removes them from its
//     copy first, so a program can't silence a finding.
export const GATE_TOOLS = {
  cargoAudit: {
    version: "0.22.2",
    url: "https://github.com/rustsec/rustsec/releases/download/cargo-audit%2Fv0.22.2/cargo-audit-x86_64-unknown-linux-musl-v0.22.2.tgz",
    sha256: "7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428",
  },
  radar: {
    commit: "3439053d8da6339606ec6aee604cf2e1855e43e0",
    url: "https://codeload.github.com/Auditware/radar/tar.gz/3439053d8da6339606ec6aee604cf2e1855e43e0",
    sha256: "e23e59c3bb062ca9d5a18936fa356ecddbeb3482e726521139989870062a8a72",
    images: {
      "ghcr.io/auditware/radar-api:main": "ghcr.io/auditware/radar-api@sha256:7f8397ff1d0175bd7a943056ea2d34a452cf22dc010e3cd7a178cc7f8e563344",
      "ghcr.io/auditware/radar-controller:main": "ghcr.io/auditware/radar-controller@sha256:3d0d7ef4ec2566760de9c1c415ee917f8599ca3d1d5cfcd4ca0dd7100037d194",
      "postgres:16-alpine": "postgres@sha256:aa6cb33cf4c19c765cefcf48d96176258800870a9a1e930ad126200f9d825139",
      "rabbitmq:3-alpine": "rabbitmq@sha256:d7af1c87c5f1eda13fcfca06db452bf3aeab6619fc3358b68535c0c02c4e52bc",
    } as Record<string, string>,
  },
} as const;

const CA = GATE_TOOLS.cargoAudit;
const RD = GATE_TOOLS.radar;

// program-analysis.sh <workspace> <out> [<advisory ids to ignore, comma-separated>]
// Writes <out>/static.json: {"tools": [{"name", "version", "status": "ran" | "error", "detail", "findings": [...]}]}.
export const GATE_ANALYSIS_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
WS="$1"; OUT="$2"; IGNORE="${"${"}3:-}"
mkdir -p "$OUT/dl"; : > "$OUT/tools.jsonl"
tool() { # name version status detail findings-file
  python3 -c 'import json,sys,os; f=sys.argv[5]; print(json.dumps({"name": sys.argv[1], "version": sys.argv[2], "status": sys.argv[3], "detail": sys.argv[4][-1500:], "findings": json.load(open(f)) if f and os.path.isfile(f) else []}))' "$@" >> "$OUT/tools.jsonl"
}
fetch() { # url sha256 out
  curl -fsSL --retry 3 "$1" -o "$3" && echo "$2  $3" | sha256sum -c - >/dev/null
}

# --- cargo-audit: the RustSec advisories for every crate in the Cargo.lock the build compiled with ---
if [ ! -f "$WS/Cargo.lock" ]; then
  tool cargo-audit ${CA.version} error "the build recorded no Cargo.lock" ""
elif ! fetch "${CA.url}" ${CA.sha256} "$OUT/dl/cargo-audit.tgz"; then
  tool cargo-audit ${CA.version} error "could not download cargo-audit ${CA.version} or its checksum didn't match" ""
else
  tar -xzf "$OUT/dl/cargo-audit.tgz" -C "$OUT/dl"
  CARGO_AUDIT=$(find "$OUT/dl" -type f -name cargo-audit -perm -u+x | head -1)
  args=(audit --json --file "$WS/Cargo.lock" --db "$OUT/advisory-db")
  IFS=',' read -ra ids <<< "$IGNORE"; for id in "${"${"}ids[@]}"; do [ -n "$id" ] && args+=(--ignore "$id"); done
  "$CARGO_AUDIT" "${"${"}args[@]}" > "$OUT/cargo-audit.json" 2> "$OUT/cargo-audit.log"
  if python3 - "$OUT/cargo-audit.json" "$OUT/cargo-audit.findings.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
out = []
for v in (r.get("vulnerabilities") or {}).get("list") or []:
    a, p = v.get("advisory") or {}, v.get("package") or {}
    out.append({"severity": "high", "title": f"{a.get('id')}: {a.get('title')}", "location": f"{p.get('name')} {p.get('version')}", "detail": (a.get("description") or "")[:600], "id": a.get("id")})
for kind, items in (r.get("warnings") or {}).items():
    for w in items or []:
        a, p = w.get("advisory") or {}, w.get("package") or {}
        out.append({"severity": "low", "title": f"{kind}: {a.get('id') or p.get('name')}", "location": f"{p.get('name')} {p.get('version')}", "detail": (a.get("title") or kind)[:600], "id": a.get("id")})
json.dump(out, open(sys.argv[2], "w"))
PY
  then tool cargo-audit ${CA.version} ran "audited the Cargo.lock against the RustSec advisory database" "$OUT/cargo-audit.findings.json"
  else tool cargo-audit ${CA.version} error "cargo-audit didn't produce a report: $(tail -c 600 "$OUT/cargo-audit.log")" ""
  fi
fi

# --- Radar: static analysis of the program's Rust ---
RADAR_HOME="$OUT/radar-home"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  tool radar ${RD.commit.slice(0, 7)} error "docker with the compose plugin isn't available" ""
elif ! fetch "${RD.url}" ${RD.sha256} "$OUT/dl/radar.tgz"; then
  tool radar ${RD.commit.slice(0, 7)} error "could not download Radar at ${RD.commit} or its checksum didn't match" ""
else
  mkdir -p "$RADAR_HOME/.radar"; tar -xzf "$OUT/dl/radar.tgz" -C "$RADAR_HOME/.radar" --strip-components=1
  # Every image by digest.
  python3 - "$RADAR_HOME/.radar/docker-compose.yml" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
${"for a, b in " + JSON.stringify(Object.entries(RD.images)) + ":"}
    s = s.replace("image: " + a, "image: " + b)
# No host ports: the services talk over compose's own network, and a port the machine already uses (a local
# Postgres on 5432) would stop the stack from starting.
import re
s = re.sub(r"\n    ports:\n(      - [^\n]*\n)+", "\n", s)
open(p, "w").write(s)
PY
  # Radar's script reads its images' labels by their :main tags (and stops when they're missing): the pinned
  # images, pulled by digest, carry those tags locally.
  ${Object.entries(RD.images)
    .map(([tag, pinned]) => `docker pull -q ${pinned} >> "$OUT/radar.log" 2>&1 && docker tag ${pinned} ${tag} >> "$OUT/radar.log" 2>&1`)
    .join("\n  ")}
  # Mynt's copy of the source, with any radar-disable comment removed.
  rm -rf "$OUT/radar-src"; cp -r "$WS" "$OUT/radar-src"; rm -f "$OUT/radar-src/Cargo.lock"
  find "$OUT/radar-src" -name '*.rs' -exec sed -i 's/radar-disable/mynt-removed/g' {} +
  # Exit 1 means findings and 2 a template error; the report is what counts, so its presence decides.
  (cd "$OUT" && XDG_CONFIG_HOME="$RADAR_HOME" timeout 1800 bash "$RADAR_HOME/.radar/radar" scan -p "$OUT/radar-src" -o "$OUT/radar.json" -f none) > "$OUT/radar.log" 2>&1
  if [ -f "$OUT/radar.json" ]; then
    python3 - "$OUT/radar.json" "$OUT/radar.findings.json" "$OUT/radar-src" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
out = []
for f in r if isinstance(r, list) else []:
    for loc in (f.get("locations") or [])[:20]:
        out.append({"severity": str(f.get("severity", "")).lower(), "certainty": str(f.get("certainty", "")).lower(), "title": f.get("name"), "location": str(loc).replace(sys.argv[3] + "/", "").replace("/contract/", ""), "detail": (f.get("description") or "")[:600]})
json.dump(out, open(sys.argv[2], "w"))
PY
    tool radar ${RD.commit.slice(0, 7)} ran "scanned the program's Rust with Radar's built-in templates$(grep -q 'template errors' "$OUT/radar.log" && echo '; some templates errored: '"$(grep -A5 'template errors\|failed:' "$OUT/radar.log" | tail -c 400)")" "$OUT/radar.findings.json"
  else
    tool radar ${RD.commit.slice(0, 7)} error "Radar didn't produce a report: $(tail -c 800 "$OUT/radar.log")" ""
  fi
  (cd "$RADAR_HOME/.radar" && docker compose down -v >/dev/null 2>&1) || true
fi
python3 -c 'import json,sys; json.dump({"tools": [json.loads(l) for l in open(sys.argv[1]) if l.strip()]}, open(sys.argv[2], "w"), indent=1)' "$OUT/tools.jsonl" "$OUT/static.json"
exit 0
`;

// confirm.py <job.json>: Mynt re-runs each proof of concept the red team wrote, on a fresh local validator of
// its own with exactly the program Mynt built, and decides from the chain itself whether the exploit is real.
// Each PoC is a directory with run.sh, run twice: MYNT_PHASE=setup (it creates the victim's state and writes
// claim.json: the victim's signer keys and accounts), then MYNT_PHASE=attack (it writes attack.json: the
// signatures of its attack transactions). Mynt snapshots the victim's accounts between the two and after, and
// confirms only when every attack transaction succeeded on its validator, invoked the program, was signed by none
// of the victim's keys, and changed a victim account the program owns that holds a victim key or lost lamports.
export const GATE_CONFIRM_SCRIPT = String.raw`#!/usr/bin/env python3
import base64, json, os, re, shutil, signal, subprocess, sys, time, urllib.request

job = json.load(open(sys.argv[1]))
ROOT = os.path.dirname(os.path.abspath(sys.argv[1]))
PROGRAM, SO = job["program_id"], os.path.join(ROOT, "program.so")
RPC = "http://127.0.0.1:8899"
B58 = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58decode(s):
    n = 0
    for c in s:
        n = n * 58 + ALPHABET.index(c)
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big") if n else b""
    return b"\0" * (len(s) - len(s.lstrip("1"))) + raw

def rpc(method, params):
    req = urllib.request.Request(RPC, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("result")

def account(addr):
    v = (rpc("getAccountInfo", [addr, {"encoding": "base64", "commitment": "confirmed"}]) or {}).get("value")
    return None if v is None else {"owner": v["owner"], "lamports": v["lamports"], "data": v["data"][0]}

def validator(ledger):
    shutil.rmtree(ledger, ignore_errors=True)
    authority = subprocess.run(["solana-keygen", "new", "--no-bip39-passphrase", "--silent", "--force", "--outfile", ledger + "-authority.json"], capture_output=True)
    pub = subprocess.run(["solana-keygen", "pubkey", ledger + "-authority.json"], capture_output=True, text=True).stdout.strip()
    p = subprocess.Popen(["solana-test-validator", "--reset", "--quiet", "--ledger", ledger, "--upgradeable-program", PROGRAM, SO, pub], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(120):
        try:
            if rpc("getHealth", []) == "ok" and rpc("getAccountInfo", [PROGRAM, {"encoding": "base64"}]).get("value"):
                return p
        except Exception:
            pass
        time.sleep(1)
    os.killpg(p.pid, signal.SIGKILL)
    raise RuntimeError("the local validator didn't start")

def run(poc_dir, phase, out):
    env = {**os.environ, "MYNT_PHASE": phase, "MYNT_RPC_URL": RPC, "MYNT_PROGRAM_ID": PROGRAM, "MYNT_PROGRAM_SO": SO, "MYNT_IDL": os.path.join(ROOT, "idl.json"), "MYNT_POC_OUT": out}
    try:
        r = subprocess.run(["bash", "run.sh"], cwd=poc_dir, env=env, capture_output=True, text=True, timeout=job.get("timeout_seconds", 600))
        return r.returncode, (r.stdout + r.stderr)[-1500:]
    except subprocess.TimeoutExpired:
        return None, "timed out"

def confirm(poc):
    poc_dir = os.path.join(ROOT, "pocs", poc)
    out = os.path.join(ROOT, "out", poc); shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
    v = validator(os.path.join(ROOT, "ledger"))
    try:
        code, log = run(poc_dir, "setup", out)
        if code != 0:
            return {"confirmed": False, "reason": f"setup exited {code}: {log}"}
        try:
            claim = json.load(open(os.path.join(out, "claim.json")))
        except Exception:
            return {"confirmed": False, "reason": "setup wrote no claim.json"}
        victims = [k for k in claim.get("victim_signers") or [] if isinstance(k, str) and B58.match(k)][:10]
        targets = [a for a in claim.get("victim_accounts") or [] if isinstance(a, str) and B58.match(a)][:10]
        if not victims or not targets:
            return {"confirmed": False, "reason": "claim.json names no victim signer or no victim account"}
        before = {a: account(a) for a in targets}
        if not any(before.values()):
            return {"confirmed": False, "reason": "none of the victim accounts exists after setup"}
        code, log = run(poc_dir, "attack", out)
        if code != 0:
            return {"confirmed": False, "reason": f"attack exited {code}: {log}"}
        try:
            sigs = [s for s in json.load(open(os.path.join(out, "attack.json"))).get("signatures") or [] if isinstance(s, str)][:10]
        except Exception:
            sigs = []
        if not sigs:
            return {"confirmed": False, "reason": "attack wrote no attack.json signatures"}
        for s in sigs:
            tx = None
            for _ in range(30):
                tx = rpc("getTransaction", [s, {"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": 0}])
                if tx: break
                time.sleep(1)
            if not tx:
                return {"confirmed": False, "reason": f"transaction {s} isn't on Mynt's validator"}
            if (tx.get("meta") or {}).get("err") is not None:
                return {"confirmed": False, "reason": f"transaction {s} failed: {tx['meta']['err']}"}
            msg = tx["transaction"]["message"]
            keys = msg["accountKeys"] + ((tx.get("meta") or {}).get("loadedAddresses") or {}).get("writable", []) + ((tx.get("meta") or {}).get("loadedAddresses") or {}).get("readonly", [])
            logs = (tx.get("meta") or {}).get("logMessages") or []
            if PROGRAM not in keys or not any(l.startswith(f"Program {PROGRAM} invoke") for l in logs):
                return {"confirmed": False, "reason": f"transaction {s} doesn't invoke the program under review"}
            signers = msg["accountKeys"][: msg["header"]["numRequiredSignatures"]]
            if set(signers) & set(victims):
                return {"confirmed": False, "reason": f"transaction {s} is signed by the victim ({', '.join(set(signers) & set(victims))}): not an attack"}
        after = {a: account(a) for a in targets}
        victim_bytes = [b58decode(k) for k in victims]
        changed = []
        for a in targets:
            b, c = before[a], after[a]
            if b is None or b["owner"] != PROGRAM or b == c:
                continue
            data = base64.b64decode(b["data"])
            if any(k in data for k in victim_bytes) or c is None or c["lamports"] < b["lamports"]:
                changed.append({"account": a, "before": {"owner": b["owner"], "lamports": b["lamports"]}, "after": None if c is None else {"owner": c["owner"], "lamports": c["lamports"], "data_changed": c["data"] != b["data"]}})
        if not changed:
            return {"confirmed": False, "reason": "no victim account the program owns (holding a victim key, or losing lamports) changed"}
        return {"confirmed": True, "reason": f"{len(sigs)} transaction(s) not signed by the victim changed {len(changed)} victim account(s)", "signatures": sigs, "changed": changed}
    finally:
        os.killpg(v.pid, signal.SIGKILL)
        v.wait()

results = {}
for poc in job["pocs"]:
    try:
        results[poc] = confirm(poc)
    except Exception as e:
        results[poc] = {"confirmed": False, "reason": f"Mynt couldn't run it: {e}"[:600], "error": True}
json.dump({"results": results}, open(os.path.join(ROOT, "results.json"), "w"), indent=1)
`;
