// The script Mynt runs to verify a build, in a fresh sandbox the coding agent never touched. Its
// report, not the agent's own, decides whether a build ships.
import { VERIFY_IMAGES_SCRIPT } from "./verify-images.js";

export const VERIFY_DIR = "/home/user/mynt-verify";
export const VERIFY_APP = "/home/user/app";
// The auditor's own copy of the source: a fresh extraction of the verified archive, made read-only, that nothing
// else in the verification touches (Mynt's checks run in VERIFY_APP, where installs and builds rewrite files).
export const VERIFY_AUDIT_SRC = "/home/user/audit-src";
const GITLEAKS_VERSION = "8.21.2";
const SYFT_VERSION = "1.18.1";
const GRYPE_VERSION = "0.121.3";
const NJSSCAN_VERSION = "1.0.1";
const BANDIT_VERSION = "1.9.4";
// The sha256 of each scanner's release archive, per machine architecture. A scanner is used only when its download
// matches the hash kept here and the release's own checksums file. Change a version and its hashes together.
const TOOL_SHA256 = {
  gitleaks: { x64: "5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba", arm64: "654c935542c89f565aabe7bf7c6c500830f116c114f0aeb509d2460c1ac2e6da" },
  syft: { amd64: "066c251652221e4d44fcc4d115ce3df33a91769da38c830a8533199db2f65aab", arm64: "cd228306e5cb0654baecb454f76611606b84899d27fa9ceb7da4df46b94fe84e" },
  grype: { amd64: "e9da18cc1429e786722e32161288103600efffd8e483c90761f90485bd1bec85", arm64: "b7815598d48da78bfd16f5b98ef28e1bb09c03d34fc8c3e350f99b6ccb3c7cba" },
};
// The pinned tools of Mynt's checks, for the docs and for the pipeline evidence Mynt shows its auditor.
export const VERIFY_TOOLS = { gitleaks: GITLEAKS_VERSION, syft: SYFT_VERSION, grype: GRYPE_VERSION, njsscan: NJSSCAN_VERSION, bandit: BANDIT_VERSION } as const;

export const VERIFY_SCRIPT = String.raw`#!/usr/bin/env bash
# Mynt build verification. Usage: verify.sh <source-url> <sha256>  |  verify.sh --audit-copy <sha256>  |  verify.sh --rehash
# The paths can be moved for Mynt's own tests of this script; in a verification sandbox nothing sets them.
V=$MYNT_VERIFY_DIR; [ -n "$V" ] || V=${VERIFY_DIR}
APP=$MYNT_VERIFY_APP; [ -n "$APP" ] || APP=${VERIFY_APP}
AUDIT=$MYNT_VERIFY_AUDIT_SRC; [ -n "$AUDIT" ] || AUDIT=${VERIFY_AUDIT_SRC}
set -uo pipefail
mkdir -p "$V/bin"

# The audit must leave the source untouched. The auditor reads its own copy of the verified archive, extracted
# fresh once Mynt's checks have finished and made read-only, so nothing it runs incidentally (git status, a
# scanner's cache) writes into the source, and nothing Mynt's checks did (installs, builds) is in it. Each file of
# that copy is hashed before the audit and again after it: a file changed, added or deleted blocks the build and is
# named. Two kinds of folder aren't source, at any depth, and are left out of both: Git's own (.git: any git
# command, even a read-only status, may rewrite its index) and node_modules (never packaged into a build's source).
tree_sums() { # dir out-prefix
  python3 - "$1" "$2.sums" <<'PY'
import hashlib, os, sys
root, out = sys.argv[1], sys.argv[2]
rows = []
for d, dirs, files in os.walk(root):
    links = [x for x in dirs if os.path.islink(os.path.join(d, x))]
    dirs[:] = [x for x in dirs if x not in links and x not in (".git", "node_modules")]
    for f in files + links:
        p = os.path.join(d, f)
        rel = os.path.relpath(p, root).replace("\n", "?")
        try:
            if os.path.islink(p):
                rows.append((rel, "link:" + os.readlink(p)))
                continue
            h = hashlib.sha256()
            with open(p, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            rows.append((rel, h.hexdigest()))
        except OSError as e:
            rows.append((rel, "unreadable:" + type(e).__name__))
with open(out, "w") as fh:
    for rel, digest in sorted(rows):
        fh.write(digest + "  " + rel + "\n")
PY
  sha256sum < "$2.sums" | cut -d' ' -f1 > "$2.sha"
}
if [ "$#" -gt 0 ] && [ "$1" = "--audit-copy" ]; then
  [ "$(sha256sum "$V/app.tgz" | cut -d' ' -f1)" = "$2" ] || { echo "source checksum mismatch" >&2; exit 2; }
  chmod -R u+w "$AUDIT" 2>/dev/null; rm -rf "$AUDIT"; mkdir -p "$AUDIT"
  tar -xzf "$V/app.tgz" -C "$AUDIT" || { echo "could not unpack the source" >&2; exit 2; }
  tree_sums "$AUDIT" "$V/before"
  # Read-only, except Git's own folders, so the git commands the auditor runs work as they would anywhere.
  chmod -R a-w "$AUDIT" && find "$AUDIT" -name .git -prune -exec chmod -R u+w {} + 2>/dev/null
  echo "audit-copy $(cat "$V/before.sha")"
  exit 0
fi
if [ "$#" -gt 0 ] && [ "$1" = "--rehash" ]; then
  tree_sums "$AUDIT" "$V/after"
  python3 - "$V/before.sums" "$V/after.sums" "$V/changed.txt" <<'PY'
import sys
def load(p):
    rows = {}
    for line in open(p):
        digest, _, rel = line.rstrip("\n").partition("  ")
        rows[rel] = digest
    return rows
before, after = load(sys.argv[1]), load(sys.argv[2])
changed = [r for r in sorted(before) if r in after and before[r] != after[r]]
changed += [r + " (deleted)" for r in sorted(before) if r not in after]
changed += [r + " (added)" for r in sorted(after) if r not in before]
open(sys.argv[3], "w").write("".join("./" + c + "\n" for c in changed[:20]))
PY
  echo "rehash $(cat "$V/after.sha")"
  exit 0
fi

# Mynt fetches the source first, alone, and reads this run's answer itself: whether the hash-verified source has
# an Anchor workspace. Nothing from the source runs here.
if [ "$#" -gt 0 ] && [ "$1" = "--fetch" ]; then
  curl -fsSL "$2" -o "$V/app.tgz" || { echo "could not download the source" >&2; exit 2; }
  [ "$(sha256sum "$V/app.tgz" | cut -d' ' -f1)" = "$3" ] || { echo "source checksum mismatch" >&2; exit 2; }
  # The same places the build looks: not inside node_modules, target or .git.
  if tar -tzf "$V/app.tgz" | grep -vE '(^|/)(node_modules|target|\.git)/' | grep -qE '(^|/)Anchor\.toml$'; then echo anchor-workspace; fi
  echo fetched
  exit 0
fi

# Mynt's Solana build, a run of its own on its own copy of the fetched source, before any of the app's code runs
# on this machine: the programs are compiled only inside a container (solana-verify.sh build), and Mynt reads them
# back and hashes them as soon as this exits.
if [ "$#" -gt 0 ] && [ "$1" = "--solana-build" ]; then
  SRC="$V/solana-src"; rm -rf "$SRC"; mkdir -p "$SRC"
  if [ "$(sha256sum "$V/app.tgz" | cut -d' ' -f1)" = "$2" ] && tar -xzf "$V/app.tgz" -C "$SRC"; then
    bash "$V/solana-verify.sh" build "$SRC" "$V/solana" "$V/solana-crate-allowlist.json"
  else
    mkdir -p "$V/solana"; echo '{"name": "solana_build", "status": "fail", "detail": "the fetched source failed its checksum"}' > "$V/solana/checks.jsonl"
  fi
  exit 0
fi

URL="$1"; WANT="$2"
CHECKS="$V/checks.jsonl"; : > "$CHECKS"
check() {
  python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "status": sys.argv[2], "detail": sys.argv[3][-1500:]}))' "$1" "$2" "$3" >> "$CHECKS"
}
finish() {
  python3 - "$CHECKS" "$V/report.json" <<'PY'
import json, sys
checks = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
json.dump({"checks": checks}, open(sys.argv[2], "w"), indent=2)
PY
}
trap finish EXIT

# What produced each check: the tool and its version, the command, the bar it holds the build to, and when it ran.
# Mynt reads this back with the report and writes its pipeline evidence for the auditor from the two.
RUNS="$V/pipeline.jsonl"; : > "$RUNS"
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ran() { # check tool version command threshold started-at
  python3 -c 'import json,sys,time; a=sys.argv; print(json.dumps({"check": a[1], "tool": a[2], "tool_version": a[3].strip(), "command": a[4], "threshold": a[5], "started_at": a[6], "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}))' "$@" >> "$RUNS"
}

# Fetch a release binary and check it against the hash Mynt pinned for it and the release's published checksums.
fetch_tool() { # name version url-base asset checksums-asset sha256
  local name=$1 version=$2 base=$3 asset=$4 sums=$5 want=$6
  [ -n "$want" ] || return 1
  curl -fsSL "$base/$asset" -o "$V/$asset" && curl -fsSL "$base/$sums" -o "$V/$sums" || return 1
  [ "$(sha256sum "$V/$asset" | cut -d' ' -f1)" = "$want" ] || return 1
  (cd "$V" && grep " $asset\$" "$sums" | sha256sum -c - >/dev/null) || return 1
  tar -xzf "$V/$asset" -C "$V/bin" "$name"
}

# --- source ---
curl -fsSL "$URL" -o "$V/app.tgz" || { check source fail "could not download the build's source"; exit 0; }
GOT=$(sha256sum "$V/app.tgz" | cut -d' ' -f1)
[ "$GOT" = "$WANT" ] || { check source fail "source checksum mismatch ($GOT)"; exit 0; }
mkdir -p "$APP" && tar -xzf "$V/app.tgz" -C "$APP"
check source pass "sha256 $GOT"
ran source sha256sum "" "the source the coding sandbox packaged, fetched once and hashed" "must match the sha256 Mynt recorded when it packaged the source" "$(now)"
cd "$APP"
has_script() { [ -f package.json ] && node -e "process.exit((require('./package.json').scripts||{})['$1'] ? 0 : 1)" 2>/dev/null; }

# --- tests ---
T0=$(now)
if has_script test; then
  ran_tests() { ran tests npm "$(npm --version 2>/dev/null)" "npm ci (npm install without a lockfile), then npm test" "the app's own test suite must pass" "$T0"; }
  if (npm ci --no-audit --no-fund || npm install --no-audit --no-fund) >"$V/install.log" 2>&1 && npm test >"$V/tests.log" 2>&1; then
    check tests pass "npm test passed"
  else
    check tests fail "$(tail -c 1500 "$V/tests.log" 2>/dev/null || tail -c 1500 "$V/install.log")"
  fi
  ran_tests
elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  python3 -m venv "$V/venv" && . "$V/venv/bin/activate"
  { [ -f requirements.txt ] && pip install -q -r requirements.txt; [ -f pyproject.toml ] && pip install -q -e .; pip install -q pytest; } >"$V/install.log" 2>&1
  if python -m pytest -q >"$V/tests.log" 2>&1; then check tests pass "pytest passed"; else check tests fail "$(tail -c 1500 "$V/tests.log")"; fi
  ran tests pytest "$(python -m pytest --version 2>&1 | head -1 | sed 's/^pytest //')" "python -m pytest -q" "the app's own test suite must pass" "$T0"
else
  check tests fail "no test suite found"
fi

# --- lint and types ---
T0=$(now)
LINT_OK=1; LINT_RAN=0
for s in lint typecheck; do
  if has_script "$s"; then LINT_RAN=1; npm run -s "$s" >"$V/$s.log" 2>&1 || LINT_OK=0; fi
done
if [ "$LINT_RAN" = 0 ] && [ -f tsconfig.json ]; then LINT_RAN=1; npx --yes tsc --noEmit >"$V/typecheck.log" 2>&1 || LINT_OK=0; fi
if [ "$LINT_RAN" = 0 ]; then check lint_typecheck warn "no lint or typecheck configured"
elif [ "$LINT_OK" = 1 ]; then check lint_typecheck pass "lint and types pass"
else check lint_typecheck fail "$(tail -c 1500 "$V"/lint.log "$V"/typecheck.log 2>/dev/null)"; fi
[ "$LINT_RAN" = 0 ] || ran lint_typecheck npm "$(npm --version 2>/dev/null)" "the app's lint and typecheck scripts (tsc --noEmit when it has neither)" "both must pass" "$T0"

# --- secrets ---
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) GA=x64; SA=amd64; GITLEAKS_SHA=${TOOL_SHA256.gitleaks.x64}; SYFT_SHA=${TOOL_SHA256.syft.amd64}; GRYPE_SHA=${TOOL_SHA256.grype.amd64};;
  aarch64|arm64) GA=arm64; SA=arm64; GITLEAKS_SHA=${TOOL_SHA256.gitleaks.arm64}; SYFT_SHA=${TOOL_SHA256.syft.arm64}; GRYPE_SHA=${TOOL_SHA256.grype.arm64};;
  *) GA=$ARCH; SA=$ARCH; GITLEAKS_SHA=; SYFT_SHA=; GRYPE_SHA=;;
esac
T0=$(now)
if fetch_tool gitleaks ${GITLEAKS_VERSION} "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}" "gitleaks_${GITLEAKS_VERSION}_linux_$GA.tar.gz" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" "$GITLEAKS_SHA"; then
  GIT_FLAG=""; [ -d .git ] || GIT_FLAG="--no-git"
  # Default rules, plus one narrow allowlist: a value in a test file that reads as a placeholder. A real-looking
  # key anywhere, tests included, still fails.
  cat > "$V/gitleaks.toml" <<'TOML'
[extend]
useDefault = true

[[allowlists]]
description = "Obvious placeholders in test files"
condition = "AND"
paths = ['''(^|/)(tests?|__tests__)/''', '''\.(test|spec)\.[cm]?[jt]sx?$''', '''(^|/)test_[^/]+\.py$''']
regexes = ['''(?i)(test|fake|dummy|example|placeholder|sample|wrong|invalid|bad)''']
TOML
  # The gate is what ships: the files of the verified source, scanned as they are (a fresh extraction, without
  # .git). A secret found only in the repository's history (other branches, old commits) doesn't ship with this
  # build, but it has leaked all the same, so it's reported as a warning to rotate it, not a block.
  SECRETS_SRC="$V/secrets-src"; rm -rf "$SECRETS_SRC"; mkdir -p "$SECRETS_SRC" && tar -xzf "$V/app.tgz" -C "$SECRETS_SRC" && rm -rf "$SECRETS_SRC/.git"
  if "$V/bin/gitleaks" detect --source "$SECRETS_SRC" --no-git --config "$V/gitleaks.toml" --no-banner --redact --report-path "$V/gitleaks.json" >"$V/gitleaks.log" 2>&1; then
    check secrets_scan pass "no secrets in the source"
  else
    check secrets_scan fail "$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(len(r), "secret(s):", ", ".join(sorted({x.get("RuleID","?")+" in "+x.get("File","?").split("/secrets-src/")[-1] for x in r}))[:1200])' "$V/gitleaks.json" 2>/dev/null || tail -c 800 "$V/gitleaks.log")"
  fi
  ran secrets_scan gitleaks ${GITLEAKS_VERSION} "gitleaks detect --no-git over the files of the verified source (default rules; placeholders in test files allowed)" "any secret in the source fails" "$T0"
  if [ -z "$GIT_FLAG" ]; then
    T0=$(now)
    if "$V/bin/gitleaks" detect --source "$APP" --config "$V/gitleaks.toml" --no-banner --redact --report-path "$V/gitleaks-history.json" >"$V/gitleaks-history.log" 2>&1; then
      check secrets_history pass "no secrets in the repository's history"
    else
      check secrets_history warn "$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1])); print(len(r), "secret(s) in history, not in this build; rotate them:", ", ".join(sorted({x.get("RuleID","?")+" in "+x.get("File","?")+" @ "+x.get("Commit","?")[:10] for x in r}))[:1200])' "$V/gitleaks-history.json" 2>/dev/null || tail -c 800 "$V/gitleaks-history.log")"
    fi
    ran secrets_history gitleaks ${GITLEAKS_VERSION} "gitleaks detect over the repository's history" "a secret only in the history is a warning to rotate it" "$T0"
  fi
else
  check secrets_scan fail "could not install a verified gitleaks"
fi

# --- dependency audit: Mynt's own gate, whatever the app's scripts or install flags say. An install's
# --no-audit only leaves out npm's advisory printout; this is the step that fails a build.
T0=$(now)
if [ -f package-lock.json ] || [ -f package.json ]; then
  if npm audit --omit=dev --audit-level=high >"$V/audit.log" 2>&1; then check dependency_audit pass "no high or critical advisories"; else check dependency_audit fail "$(tail -c 1500 "$V/audit.log")"; fi
  ran dependency_audit "npm audit" "$(npm --version 2>/dev/null)" "npm audit --omit=dev --audit-level=high, on the lockfile of the verified source" "a high or critical advisory in a production dependency fails" "$T0"
elif [ -f requirements.txt ] || [ -f pyproject.toml ]; then
  . "$V/venv/bin/activate" 2>/dev/null; pip install -q pip-audit >/dev/null 2>&1
  if pip-audit >"$V/audit.log" 2>&1; then check dependency_audit pass "no known vulnerabilities"; else check dependency_audit fail "$(tail -c 1500 "$V/audit.log")"; fi
  ran dependency_audit pip-audit "$(pip-audit --version 2>/dev/null | sed 's/^pip-audit //')" "pip-audit" "any known vulnerability fails" "$T0"
else
  check dependency_audit warn "no dependency manifest"
fi

# --- static security scan: njsscan (LGPL-3.0+) for JavaScript and TypeScript, bandit (Apache-2.0) for Python.
# High-severity findings fail it. Both run from a venv of their own, pinned.
# It reads a fresh extraction of the verified archive, so generated output (dist, coverage) is never scanned,
# with test files left out: fixtures aren't shipped code.
T0=$(now)
SRC="$V/scan-src"; rm -rf "$SRC"; mkdir -p "$SRC" && tar -xzf "$V/app.tgz" -C "$SRC"
find "$SRC" \( -path '*/node_modules' -o -path '*/.git' -o -name tests -o -name test -o -name __tests__ \) -prune -exec rm -rf {} + 2>/dev/null
find "$SRC" -type f \( -name '*.test.*' -o -name '*.spec.*' -o -name 'test_*.py' \) -delete 2>/dev/null
if python3 -m venv "$V/scan-venv" >/dev/null 2>&1 && . "$V/scan-venv/bin/activate" \
   && pip install -q "njsscan==${NJSSCAN_VERSION}" "bandit==${BANDIT_VERSION}" >"$V/scan-install.log" 2>&1; then
  SCAN_FINDINGS=""
  if find "$SRC" \( -name '*.js' -o -name '*.ts' -o -name '*.tsx' -o -name '*.jsx' -o -name '*.mjs' \) -print -quit | grep -q .; then
    njsscan --json -o "$V/njsscan.json" "$SRC" >"$V/njsscan.log" 2>&1
    SCAN_FINDINGS+=$(python3 -c '
import json, sys
r = json.load(open(sys.argv[1]))
out = []
for group in ("nodejs", "templates"):
    for rule, f in (r.get(group) or {}).items():
        if (f.get("metadata") or {}).get("severity") == "ERROR":
            files = sorted({x.get("file_path", "?").split("/scan-src/")[-1] for x in f.get("files", [])})
            out.append(rule + " in " + ", ".join(files[:3]))
print("; ".join(out))' "$V/njsscan.json" 2>/dev/null || echo "njsscan produced no report")
  fi
  if find "$SRC" -name '*.py' -print -quit | grep -q .; then
    bandit -r "$SRC" -x '*/.venv/*,*/venv/*' -lll -iii -f json -o "$V/bandit.json" >"$V/bandit.log" 2>&1
    B=$(python3 -c '
import json, sys
r = json.load(open(sys.argv[1]))
print("; ".join(sorted({x["test_id"] + " " + x["test_name"] + " in " + x["filename"].split("/scan-src/")[-1] for x in r.get("results", [])})))' "$V/bandit.json" 2>/dev/null || echo "bandit produced no report")
    if [ -n "$B" ] && [ -n "$SCAN_FINDINGS" ]; then SCAN_FINDINGS="$SCAN_FINDINGS; $B"; elif [ -n "$B" ]; then SCAN_FINDINGS="$B"; fi
  fi
  deactivate 2>/dev/null
  if [ -z "$SCAN_FINDINGS" ]; then check static_scan pass "no high-severity findings (njsscan ${NJSSCAN_VERSION}, bandit ${BANDIT_VERSION})"
  else check static_scan fail "high-severity: $SCAN_FINDINGS"; fi
else
  check static_scan fail "could not install the static scanners: $(tail -c 600 "$V/scan-install.log" 2>/dev/null)"
fi
ran static_scan "njsscan, bandit" "njsscan ${NJSSCAN_VERSION}, bandit ${BANDIT_VERSION}" "njsscan over the JavaScript and TypeScript, bandit -lll -iii over the Python, test files left out" "a high-severity finding fails" "$T0"

# --- SBOM of the source (syft, CycloneDX). Its check is written below, once the images have theirs.
T0=$(now); SBOM_SRC=""; SBOM_ERR=""
if fetch_tool syft ${SYFT_VERSION} "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}" "syft_${SYFT_VERSION}_linux_$SA.tar.gz" "syft_${SYFT_VERSION}_checksums.txt" "$SYFT_SHA" \
   && "$V/bin/syft" "dir:$APP" -o "cyclonedx-json=$V/sbom.json" -q >"$V/sbom.log" 2>&1; then
  SBOM_SRC=$(python3 -c 'import json,sys; n=len(json.load(open(sys.argv[1])).get("components") or []); print(n) if n else sys.exit(1)' "$V/sbom.json" 2>/dev/null) || SBOM_ERR="the source SBOM has no components"
else
  SBOM_ERR="$(tail -c 800 "$V/sbom.log" 2>/dev/null)"; [ -n "$SBOM_ERR" ] || SBOM_ERR="could not install a verified syft"
fi

# --- container images: what the app ships as containers is built here from a fresh extraction of the verified
# archive (the same build context the app's own machine gets), then each image gets a CycloneDX SBOM (syft) and a
# vulnerability scan (grype over that SBOM). images.py (src/verify-images.ts) says what is and isn't covered.
T1=$(now)
IMG_SRC="$V/image-src"; rm -rf "$IMG_SRC"; mkdir -p "$IMG_SRC" && tar -xzf "$V/app.tgz" -C "$IMG_SRC"
cat > "$V/images.py" <<'MYNT_IMAGES_PY'
${VERIFY_IMAGES_SCRIPT}
MYNT_IMAGES_PY
rm -f "$V/images.json"
HAS_IMAGES=0; for f in compose.yaml compose.yml docker-compose.yaml docker-compose.yml Dockerfile; do [ -f "$IMG_SRC/$f" ] && HAS_IMAGES=1; done
if [ "$HAS_IMAGES" = 0 ]; then
  python3 "$V/images.py" "$IMG_SRC" "$V" "$V/bin/syft" "$V/bin/grype" >"$V/images.log" 2>&1
elif [ ! -x "$V/bin/syft" ]; then
  echo "could not install a verified syft" >"$V/images.log"
elif ! fetch_tool grype ${GRYPE_VERSION} "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}" "grype_${GRYPE_VERSION}_linux_$SA.tar.gz" "grype_${GRYPE_VERSION}_checksums.txt" "$GRYPE_SHA"; then
  echo "could not install a verified grype" >"$V/images.log"
else
  python3 "$V/images.py" "$IMG_SRC" "$V" "$V/bin/syft" "$V/bin/grype" --syft-version ${SYFT_VERSION} --grype-version ${GRYPE_VERSION} >"$V/images.log" 2>&1
fi
python3 - "$V/images.json" "$V/images.log" "$CHECKS" "$SBOM_SRC" "$SBOM_ERR" <<'PY'
import json, sys
path, log, out, src, err = sys.argv[1:6]
try:
    r = json.load(open(path))
except (OSError, ValueError):
    r = None
try:
    tail = open(log, encoding="utf-8", errors="replace").read()[-600:].strip()
except OSError:
    tail = ""
imgs = (r or {}).get("sbom") or {"ok": r is not None, "detail": "", "missing": []}
if r is None:
    imgs = {"ok": False, "detail": "", "missing": ["the images (Mynt's image stage didn't finish)"]}
parts = [f"source ({src} components)"] if src else []
if imgs["detail"]:
    parts.append("images: " + imgs["detail"])
problems = ([err] if err else []) + (["no SBOM for " + ", ".join(imgs["missing"])] if imgs["missing"] else [])
if problems:
    sbom = {"name": "sbom", "status": "fail", "detail": ("; ".join(problems) + ("; generated: " + "; ".join(parts) if parts else ""))[-1500:]}
else:
    sbom = {"name": "sbom", "status": "pass", "detail": ("CycloneDX SBOM generated: " + "; ".join(parts))[-1500:]}
scan = (r or {}).get("check") or {"status": "fail", "detail": "Mynt's image scan didn't finish: " + (tail or "no report")}
with open(out, "a") as f:
    f.write(json.dumps(sbom) + "\n")
    f.write(json.dumps({"name": "image_scan", "status": scan["status"], "detail": scan["detail"][-1500:]}) + "\n")
PY
ran sbom syft ${SYFT_VERSION} "syft over the source folder and over each built image, CycloneDX JSON" "an SBOM with components for the source and for every image must exist" "$T0"
if [ "$HAS_IMAGES" = 1 ]; then
  ran image_scan grype ${GRYPE_VERSION} "docker build of each image the app ships, from the verified source; syft for its SBOM; grype over that SBOM" "a high or critical vulnerability with a fix available fails; one with no fix yet is a warning" "$T1"
else
  ran image_scan "" "" "looked for a Compose file or a Dockerfile at the root of the source" "nothing to scan: the build ships no container image" "$T1"
fi

# --- Solana programs: Mynt's own verifiable build of every Anchor workspace, and its tests on a local validator
# (solana-verify.sh, from src/solana/toolchain.ts). Its artifacts are what Mynt deploys, never the agent's.
# The build ran before this script, on its own (verify.sh --solana-build), and Mynt read the programs back and
# recorded solana_build then; this adds solana_tests.
if [ -f "$V/solana-verify.sh" ]; then
  bash "$V/solana-verify.sh" test "$APP" "$V/solana" "$CHECKS" "$V/solana-toolchain.sh"
fi

# --- required disclosures ---
T0=$(now)
python3 - "$V/disclosures.json" "$APP" "$CHECKS" <<'PY'
import json, os, re, sys
wanted, root, out = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
norm = lambda s: re.sub(r"\s+", " ", s).strip().lower()
text = []
for d, dirs, files in os.walk(root):
    dirs[:] = [x for x in dirs if x not in ("node_modules", ".git")]
    for f in files:
        p = os.path.join(d, f)
        try:
            if os.path.getsize(p) < 2_000_000:
                text.append(open(p, encoding="utf-8", errors="ignore").read())
        except OSError:
            pass
corpus = norm("\n".join(text))
missing = [f'{w["product_id"]}: {w["text"]}' for w in wanted if norm(w["text"]) not in corpus]
row = {"name": "disclosures", "status": "fail" if missing else "pass",
       "detail": ("missing: " + " | ".join(missing))[-1500:] if missing else f"{len(wanted)} required disclosure(s) present"}
open(out, "a").write(json.dumps(row) + "\n")
PY
ran disclosures python3 "$(python3 --version 2>&1 | sed 's/^Python //')" "every disclosure the app's products require, searched for in the source" "a missing disclosure fails" "$T0"
`;
