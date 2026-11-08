// The Solana toolchain Mynt installs in developers' build sandboxes and in its own clean verify sandbox: the
// Agave release (solana, solana-test-validator, cargo-build-sbf), the Anchor CLI and Rust, each a pinned
// release checked against its published sha256 before it is used. Anchor's verifiable builds run in Anchor's
// own image, pinned by digest. Versions move together: Anchor 0.32 is built and tested against Agave 2.3 and
// needs Rust 1.89 for its IDL.

export const SOLANA_TOOLCHAIN = {
  agave: { version: "2.3.13", sha256: "c43539ebdf6942472e8b87635d6ea55f428a51e3d0219f7b6f720fc6b19fade0" },
  anchor: { version: "0.32.1", sha256: "5f25b850ce80278507a98947833fcd48423391f6d145046ffb0c5fd130dec436", commit: "1ebbe58158d089a2a40b5e35ebead5a10db9090d" },
  rust: { version: "1.89.0", rustup: "1.28.2", rustupSha256: "20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c" },
  // Anchor's verifiable-build image for the same Anchor version.
  anchorImage: "solanafoundation/anchor:v0.32.1@sha256:facc4ebd0738ba7ebc1eb4ef000deab6b37e7747960d3f400c73c40c5421b5de",
} as const;

const T = SOLANA_TOOLCHAIN;

// Idempotent; installs under $MYNT_SOLANA_HOME (default ~/.mynt-solana) and writes an env file to source.
// About 2 GB once Anchor's first build has fetched the SBF platform tools.
export const SOLANA_TOOLCHAIN_SCRIPT = String.raw`#!/usr/bin/env bash
# Mynt's pinned Solana toolchain: Agave ${T.agave.version}, Anchor ${T.anchor.version}, Rust ${T.rust.version}.
set -euo pipefail
ROOT="${"${"}MYNT_SOLANA_HOME:-$HOME/.mynt-solana}"
READY="$ROOT/ready-${T.agave.version}-${T.anchor.version}-${T.rust.version}"
[ -f "$READY" ] && exit 0
[ "$(uname -m)" = x86_64 ] || { echo "The Solana toolchain is published for x86_64 Linux only" >&2; exit 1; }
mkdir -p "$ROOT/bin" "$ROOT/dl"
fetch() { # url sha256 out
  curl -fsSL --retry 3 "$1" -o "$3"
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "checksum mismatch for $1" >&2; rm -f "$3"; exit 1; }
}
# A C toolchain for Rust's build scripts, when the machine lacks one (best effort: the sandbox user may have sudo).
command -v cc >/dev/null || { sudo -n apt-get update -q >/dev/null 2>&1 && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -yq build-essential pkg-config bzip2 >/dev/null 2>&1; } || true

export RUSTUP_HOME="$ROOT/rustup" CARGO_HOME="$ROOT/cargo"
if ! "$CARGO_HOME/bin/rustc" +${T.rust.version} --version >/dev/null 2>&1; then
  fetch "https://static.rust-lang.org/rustup/archive/${T.rust.rustup}/x86_64-unknown-linux-gnu/rustup-init" ${T.rust.rustupSha256} "$ROOT/dl/rustup-init"
  chmod +x "$ROOT/dl/rustup-init"
  "$ROOT/dl/rustup-init" -y --quiet --no-modify-path --profile minimal --default-toolchain ${T.rust.version}
fi

if ! "$ROOT/solana-release/bin/solana" --version 2>/dev/null | grep -q "${T.agave.version}"; then
  fetch "https://github.com/anza-xyz/agave/releases/download/v${T.agave.version}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" ${T.agave.sha256} "$ROOT/dl/solana-release.tar.bz2"
  rm -rf "$ROOT/solana-release"; tar -xjf "$ROOT/dl/solana-release.tar.bz2" -C "$ROOT"
fi

if ! "$ROOT/bin/anchor" --version 2>/dev/null | grep -q "${T.anchor.version}"; then
  fetch "https://github.com/solana-foundation/anchor/releases/download/v${T.anchor.version}/anchor-${T.anchor.version}-x86_64-unknown-linux-gnu" ${T.anchor.sha256} "$ROOT/dl/anchor"
  install -m 755 "$ROOT/dl/anchor" "$ROOT/bin/anchor"
  # The release binary needs glibc 2.39 or later; on an older system, build the same release from its tagged
  # commit instead (about ten minutes).
  if ! "$ROOT/bin/anchor" --version >/dev/null 2>&1; then
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -yq pkg-config libudev-dev libssl-dev >/dev/null 2>&1 || true
    "$CARGO_HOME/bin/cargo" install --quiet --locked --force --root "$ROOT" --git https://github.com/solana-foundation/anchor --rev ${T.anchor.commit} anchor-cli
  fi
fi
rm -rf "$ROOT/dl"

cat > "$ROOT/env" <<ENV
export RUSTUP_HOME="$ROOT/rustup" CARGO_HOME="$ROOT/cargo"
export PATH="$ROOT/bin:$ROOT/solana-release/bin:$ROOT/cargo/bin:\$PATH"
ENV
. "$ROOT/env"
# A throwaway wallet for the local test validator only; nothing is ever deployed with it.
[ -f "$HOME/.config/solana/id.json" ] || solana-keygen new --no-bip39-passphrase --silent --outfile "$HOME/.config/solana/id.json" >/dev/null
solana --version; anchor --version; rustc --version
touch "$READY"
`;

// Mynt's own build and test of every Anchor workspace in a verified source tree. Two runs, with Mynt reading the
// programs back between them, so no developer code ever runs on the host before Mynt has the bytes:
//   build <src> <out>: each program crate is compiled with cargo build-sbf inside Anchor's verifiable-build image
//     (pinned by digest), the same command `anchor build --verifiable` runs there, but with the source COPIED into
//     a container that has no mount of the host and, once its crates are fetched, no network; the program is
//     copied out with docker cp -L and kept only if it is a regular ELF file. `anchor build
//     --verifiable` itself isn't used: after its container it builds the IDL on the host, which compiles and runs
//     the developer's build scripts and macros there. Writes <out>/<name>.so, <out>/programs.json and
//     <out>/checks.jsonl (solana_build). Needs only docker and python3.
//   test <app> <out> <checks.jsonl> <toolchain>: after Mynt has read the programs back. Refuses test setups that
//     would load other code at the programs' addresses, builds the IDL (`anchor idl build`), puts the programs Mynt
//     hashed in target/deploy and runs `anchor test --skip-build` on a local validator. Appends solana_tests; Mynt
//     re-hashes every copy afterwards.
export const SOLANA_VERIFY_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
MODE="$1"; APP="$2"; OUT="$3"
check() { # checks-file name status detail
  python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "status": sys.argv[2], "detail": sys.argv[3][-1500:]}))' "$2" "$3" "$4" >> "$1"
}
mapfile -t WS < <(cd "$APP" && find . \( -name node_modules -o -name target -o -name .git \) -prune -o -name Anchor.toml -print | sed -e 's|^\./||' -e 's|/*Anchor.toml$||' | LC_ALL=C sort)
[ "${"${"}#WS[@]}" -gt 0 ] || exit 0

# The program crates of a workspace: "<manifest, relative to the workspace>\t<lib name>\t<declared id>" per line,
# read from the files (nothing is compiled or run).
programs() {
  python3 - "$1" <<'PY'
import glob, os, re, sys, tomllib
ws = sys.argv[1]
root = tomllib.load(open(os.path.join(ws, "Cargo.toml"), "rb"))
members = (root.get("workspace") or {}).get("members") or []
for pattern in members:
    for d in sorted(glob.glob(os.path.join(ws, pattern))):
        manifest = os.path.join(d, "Cargo.toml")
        if not os.path.isfile(manifest):
            continue
        crate = tomllib.load(open(manifest, "rb"))
        lib = crate.get("lib") or {}
        if "cdylib" not in (lib.get("crate-type") or []):
            continue
        name = (lib.get("name") or crate["package"]["name"]).replace("-", "_")
        if not re.fullmatch(r"[a-z0-9_]+", name):
            sys.exit(f"the program crate name {name!r} must be lowercase letters, digits and underscores")
        src = open(os.path.join(d, lib.get("path") or "src/lib.rs"), errors="ignore").read()
        m = re.search(r'declare_id!\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*\)', src)
        print(f"{os.path.relpath(manifest, ws)}\t{name}\t{m.group(1) if m else ''}")
PY
}

if [ "$MODE" = build ]; then
  rm -rf "$OUT"; mkdir -p "$OUT"; echo "[]" > "$OUT/programs.json"; : > "$OUT/checks.jsonl"
  command -v docker >/dev/null || { check "$OUT/checks.jsonl" solana_build fail "docker isn't available for the verifiable build"; exit 0; }
  BUILD_FAIL=""; BUILT=0
  for w in "${"${"}WS[@]}"; do
    label="${"${"}w:-.}"; dir="$APP/$label"; log="$OUT/$(echo "$label" | tr '/.' '__')"
    mapfile -t PROGS < <(programs "$dir" 2> "$log.programs.log")
    if [ "${"${"}#PROGS[@]}" = 0 ]; then BUILD_FAIL+="$label: no program crate found ($(tail -c 300 "$log.programs.log")) "; continue; fi
    manifests=(); for p in "${"${"}PROGS[@]}"; do manifests+=("$(cut -f1 <<<"$p")"); done
    # One container per workspace, never with a mount of the host. It fetches the crates while it has a network
    # (cargo fetch runs no build scripts), is then cut off from every network, and only then compiles: the
    # developer's build scripts and macros run with no network and no access to the host.
    cid=$(docker create --workdir /workdir -e CARGO_TARGET_DIR=/workdir/docker-target \
      -e PATH=/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      ${T.anchorImage} sleep infinity 2> "$log.build.log")
    if [ -z "$cid" ]; then BUILD_FAIL+="$label: $(tail -c 500 "$log.build.log") "; continue; fi
    # The source goes in as a copy: the container never sees the host's files, and can't change them.
    if ! tar -C "$dir" --exclude=./target --exclude=./node_modules --exclude=./.anchor --transform 's,^\.$,workdir,;s,^\./,workdir/,' -cf - . | docker cp - "$cid:/" >> "$log.build.log" 2>&1 \
       || ! docker start "$cid" >> "$log.build.log" 2>&1 \
       || ! docker exec "$cid" bash -c 'set -e; for m in "$@"; do cargo fetch --manifest-path "$m"; done' _ "${"${"}manifests[@]}" >> "$log.build.log" 2>&1; then
      BUILD_FAIL+="$label: $(tail -c 700 "$log.build.log" | tr -d '\r') "
      docker rm -f "$cid" >/dev/null 2>&1; continue
    fi
    for net in $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid"); do docker network disconnect -f "$net" "$cid" >> "$log.build.log" 2>&1; done
    if [ -n "$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$cid")" ]; then
      BUILD_FAIL+="$label: couldn't cut the build container off the network "
      docker rm -f "$cid" >/dev/null 2>&1; continue
    fi
    if ! docker exec -e CARGO_NET_OFFLINE=true "$cid" bash -c 'set -e; for m in "$@"; do cargo build-sbf --manifest-path "$m"; done' _ "${"${"}manifests[@]}" >> "$log.build.log" 2>&1; then
      BUILD_FAIL+="$label: $(tail -c 700 "$log.build.log" | tr -d '\r') "
      docker rm -f "$cid" >/dev/null 2>&1; continue
    fi
    for p in "${"${"}PROGS[@]}"; do
      name=$(cut -f2 <<<"$p"); declared=$(cut -f3 <<<"$p")
      # -L: a link in the container is resolved there, to the container's own file, never copied out as a link
      # that would point at the host. Then only a regular file that is an ELF program counts.
      rm -f "$OUT/$name.so"
      if ! docker cp -L "$cid:/workdir/docker-target/deploy/$name.so" "$OUT/$name.so" >> "$log.build.log" 2>&1; then BUILD_FAIL+="$label: $name.so wasn't built "; continue; fi
      if [ -L "$OUT/$name.so" ] || [ ! -f "$OUT/$name.so" ] || [ "$(head -c 4 "$OUT/$name.so" | od -An -tx1 | tr -d ' \n')" != 7f454c46 ]; then
        BUILD_FAIL+="$label: $name.so isn't a program (not a regular ELF file) "; rm -f "$OUT/$name.so"; continue
      fi
      python3 - "$OUT" "$name" "$label" "$declared" <<'PY'
import hashlib, json, os, sys
out, name, ws, declared = sys.argv[1:5]
data = open(os.path.join(out, name + ".so"), "rb").read()
progs = json.load(open(os.path.join(out, "programs.json")))
progs.append({"workspace": ws, "name": name, "size": len(data), "sha256": hashlib.sha256(data.rstrip(b"\0")).hexdigest(), "declared_id": declared or None})
json.dump(progs, open(os.path.join(out, "programs.json"), "w"), indent=2)
PY
      BUILT=$((BUILT + 1))
    done
    docker rm -f "$cid" >/dev/null 2>&1
  done
  if [ -n "$BUILD_FAIL" ]; then check "$OUT/checks.jsonl" solana_build fail "$BUILD_FAIL"
  elif [ "$BUILT" = 0 ]; then check "$OUT/checks.jsonl" solana_build fail "an Anchor workspace built no program"
  else check "$OUT/checks.jsonl" solana_build pass "$BUILT program(s) built verifiably in ${T.anchorImage.split("@")[0]} (Anchor ${T.anchor.version})"; fi
  chmod a-w "$OUT"/*.so 2>/dev/null
  exit 0
fi

# test: solana_build is Mynt's own record from the build run; this run adds only solana_tests.
CHECKS="$4"; TOOLCHAIN="$5"
if ! python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])) else 1)' "$OUT/programs.json" 2>/dev/null; then
  check "$CHECKS" solana_tests fail "not run: Mynt's build produced no program"
  exit 0
fi
# The tests must exercise the programs Mynt built at their declared addresses: no genesis programs, no clones,
# no preloaded accounts at those addresses, and each program at its own address on the local validator.
POLICY=$(python3 - "$APP" "$OUT/programs.json" "${"${"}WS[@]}" <<'PY'
import json, os, sys, tomllib
app, progs = sys.argv[1], json.load(open(sys.argv[2]))
ids = {p["declared_id"] for p in progs if p.get("declared_id")}
problems = []
for ws in sys.argv[3:]:
    label = ws or "."
    cfg = tomllib.load(open(os.path.join(app, label, "Anchor.toml"), "rb"))
    test = cfg.get("test") or {}
    if test.get("genesis"):
        problems.append(f"{label}: [[test.genesis]] loads programs the build didn't make")
    validator = test.get("validator") or {}
    if validator.get("clone"):
        problems.append(f"{label}: [[test.validator.clone]] copies programs or accounts from a live cluster")
    for a in validator.get("account") or []:
        if a.get("address") in ids:
            problems.append(f"{label}: [[test.validator.account]] preloads {a.get('address')}")
    localnet = (cfg.get("programs") or {}).get("localnet") or {}
    for p in progs:
        if p["workspace"] == label and p.get("declared_id") and localnet.get(p["name"]) not in (None, p["declared_id"]):
            problems.append(f"{label}: [programs.localnet] puts {p['name']} at {localnet.get(p['name'])}, not its declared {p['declared_id']}")
print("; ".join(problems))
PY
)
if [ -n "$POLICY" ]; then check "$CHECKS" solana_tests fail "the tests wouldn't run the programs Mynt built: $POLICY"; exit 0; fi
if ! bash "$TOOLCHAIN" > "$OUT/toolchain.log" 2>&1; then
  check "$CHECKS" solana_tests fail "could not install the pinned Solana toolchain: $(tail -c 600 "$OUT/toolchain.log")"
  exit 0
fi
. "${"${"}MYNT_SOLANA_HOME:-$HOME/.mynt-solana}/env"
TEST_FAIL=""
for w in "${"${"}WS[@]}"; do
  label="${"${"}w:-.}"; dir="$APP/$label"; log="$OUT/$(echo "$label" | tr '/.' '__')"
  (cd "$dir" && { npm ci --no-audit --no-fund || npm install --no-audit --no-fund; }) > "$log.npm.log" 2>&1
  mkdir -p "$dir/target/deploy" "$dir/target/idl" "$dir/target/types"
  for name in $(python3 -c 'import json,sys; print(" ".join(p["name"] for p in json.load(open(sys.argv[1])) if p["workspace"] == sys.argv[2]))' "$OUT/programs.json" "$label"); do
    (cd "$dir" && anchor idl build -p "$name" -o "target/idl/$name.json" -t "target/types/$name.ts") >> "$log.idl.log" 2>&1 || TEST_FAIL+="$label: the IDL of $name didn't build: $(tail -c 400 "$log.idl.log") "
    cp "$dir/target/idl/$name.json" "$OUT/$name.idl.json" 2>/dev/null
    # The bytes Mynt read back and hashed, not anything the workspace built.
    cp "$OUT/$name.so" "$dir/target/deploy/$name.so"
  done
  [ -z "$TEST_FAIL" ] || continue
  if ! (cd "$dir" && anchor test --skip-build) > "$log.test.log" 2>&1; then
    TEST_FAIL+="$label: $(tail -c 700 "$log.test.log" | tr -d '\r') "
  fi
done
if [ -n "$TEST_FAIL" ]; then check "$CHECKS" solana_tests fail "$TEST_FAIL"
else check "$CHECKS" solana_tests pass "anchor test passed on a local validator against the programs Mynt built"; fi
exit 0
`;
