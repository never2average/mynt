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

// Mynt's own build and test of every Anchor workspace in a verified source tree, in two separate runs so no
// developer test code runs between the build and Mynt reading the program back:
//   build <app> <out> <toolchain>: Anchor's verifiable (reproducible) build of each workspace; each program and
//     its IDL are copied to <out>, listed in <out>/programs.json, and the solana_build check written to
//     <out>/checks.jsonl. No npm install and no tests: Mynt reads back and hashes the programs straight after.
//   test <app> <out> <checks.jsonl>: the workspaces' tests on a local validator, against the programs in <out>
//     (the bytes Mynt hashed), appending solana_build and solana_tests to the checks. Mynt re-hashes afterwards.
export const SOLANA_VERIFY_SCRIPT = String.raw`#!/usr/bin/env bash
set -uo pipefail
MODE="$1"; APP="$2"; OUT="$3"
check() { # checks-file name status detail
  python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "status": sys.argv[2], "detail": sys.argv[3][-1500:]}))' "$2" "$3" "$4" >> "$1"
}
mapfile -t WS < <(cd "$APP" && find . \( -name node_modules -o -name target -o -name .git \) -prune -o -name Anchor.toml -print | sed -e 's|^\./||' -e 's|/*Anchor.toml$||' | LC_ALL=C sort)
[ "${"${"}#WS[@]}" -gt 0 ] || exit 0

if [ "$MODE" = build ]; then
  TOOLCHAIN="$4"
  rm -rf "$OUT"; mkdir -p "$OUT"; echo "[]" > "$OUT/programs.json"; : > "$OUT/checks.jsonl"
  if ! bash "$TOOLCHAIN" > "$OUT/toolchain.log" 2>&1; then
    check "$OUT/checks.jsonl" solana_build fail "could not install the pinned Solana toolchain: $(tail -c 600 "$OUT/toolchain.log")"
    exit 0
  fi
  . "${"${"}MYNT_SOLANA_HOME:-$HOME/.mynt-solana}/env"
  BUILD_FAIL=""; BUILT=0
  for w in "${"${"}WS[@]}"; do
    label="${"${"}w:-.}"; dir="$APP/$label"; log="$OUT/$(echo "$label" | tr '/.' '__')"
    rm -rf "$dir/target/verifiable"
    # Anchor runs its build container with a terminal; script(1) gives it one.
    if ! (cd "$dir" && script -qefc "anchor build --verifiable --docker-image ${T.anchorImage}" /dev/null) > "$log.build.log" 2>&1; then
      BUILD_FAIL+="$label: $(tail -c 700 "$log.build.log" | tr -d '\r') "
      continue
    fi
    for so in "$dir"/target/verifiable/*.so; do
      [ -f "$so" ] || continue
      name=$(basename "$so" .so)
      cp "$so" "$OUT/$name.so"
      cp "$dir/target/idl/$name.json" "$OUT/$name.idl.json" 2>/dev/null || true
      python3 - "$OUT" "$name" "$label" <<'PY'
import hashlib, json, os, sys
out, name, ws = sys.argv[1:4]
data = open(os.path.join(out, name + ".so"), "rb").read()
idl = {}
try:
    idl = json.load(open(os.path.join(out, name + ".idl.json")))
except Exception:
    pass
progs = json.load(open(os.path.join(out, "programs.json")))
progs.append({"workspace": ws, "name": name, "size": len(data), "sha256": hashlib.sha256(data.rstrip(b"\0")).hexdigest(), "declared_id": idl.get("address")})
json.dump(progs, open(os.path.join(out, "programs.json"), "w"), indent=2)
PY
      BUILT=$((BUILT + 1))
    done
  done
  if [ -n "$BUILD_FAIL" ]; then check "$OUT/checks.jsonl" solana_build fail "$BUILD_FAIL"
  elif [ "$BUILT" = 0 ]; then check "$OUT/checks.jsonl" solana_build fail "an Anchor workspace built no program"
  else check "$OUT/checks.jsonl" solana_build pass "$BUILT program(s) built verifiably (Anchor ${T.anchor.version}, Agave ${T.agave.version})"; fi
  exit 0
fi

# test
CHECKS="$4"
if [ ! -f "$OUT/checks.jsonl" ]; then
  check "$CHECKS" solana_build fail "Mynt's Solana build didn't run"
  check "$CHECKS" solana_tests fail "not run: no build"
  exit 0
fi
cat "$OUT/checks.jsonl" >> "$CHECKS"
if ! grep -q '"solana_build", "status": "pass"' "$OUT/checks.jsonl"; then
  check "$CHECKS" solana_tests fail "not run: the build failed"
  exit 0
fi
. "${"${"}MYNT_SOLANA_HOME:-$HOME/.mynt-solana}/env"
TEST_FAIL=""
for w in "${"${"}WS[@]}"; do
  label="${"${"}w:-.}"; dir="$APP/$label"; log="$OUT/$(echo "$label" | tr '/.' '__')"
  (cd "$dir" && { npm ci --no-audit --no-fund || npm install --no-audit --no-fund; }) > "$log.npm.log" 2>&1
  # The bytes Mynt read back and hashed, not whatever the workspace's target/ holds now.
  mkdir -p "$dir/target/deploy"
  for so in "$dir"/target/verifiable/*.so; do
    [ -f "$so" ] || continue
    name=$(basename "$so" .so)
    cp "$OUT/$name.so" "$dir/target/deploy/$name.so"
  done
  if ! (cd "$dir" && anchor test --skip-build) > "$log.test.log" 2>&1; then
    TEST_FAIL+="$label: $(tail -c 700 "$log.test.log" | tr -d '\r') "
  fi
done
if [ -n "$TEST_FAIL" ]; then check "$CHECKS" solana_tests fail "$TEST_FAIL"
else check "$CHECKS" solana_tests pass "anchor test passed on a local validator against the verifiable build"; fi
exit 0
`;
