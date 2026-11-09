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
// What Mynt keeps of a build: the workspace exactly as it went into the build container (a build whose source is
// larger fails, never keeps part of it), and the source of every dependency not on Mynt's crate allowlist.
export const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_DEPS_SOURCE_BYTES = 16 * 1024 * 1024;

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
//   build <src> <out> [<crate allowlist>]: each program crate is compiled with cargo build-sbf inside Anchor's verifiable-build image
//     (pinned by digest), the same command `anchor build --verifiable` runs there. The crates are fetched first, in
//     a throwaway networked container that gets only the manifests, Cargo.lock and empty stubs (nothing of the
//     source that could run); the build then runs in a fresh container with no network from creation and no mount
//     of the host, with the source copied in and the crate caches carried over. The program is copied out with
//     docker cp -L and kept only if it is a regular ELF file. `anchor build
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

# What the fetch container gets of a workspace: every Cargo.toml (outside target, node_modules and dot-directories),
# Cargo.lock, and an empty file wherever a manifest names a source. Nothing else: no .cargo/ config, no
# rust-toolchain.toml, no build script or source code, nothing executable.
skeleton() {
  python3 - "$1" "$2" <<'PY'
import os, re, shutil, sys, tomllib
ws, out = sys.argv[1], sys.argv[2]
def stub(rel):
    p = os.path.normpath(os.path.join(out, rel))
    if not p.startswith(out + os.sep):
        sys.exit(f"a manifest names a path outside its workspace: {rel}")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").close()
for d, dirs, files in os.walk(ws):
    dirs[:] = [x for x in dirs if x not in ("target", "node_modules") and not x.startswith(".")]
    if "Cargo.toml" not in files:
        continue
    rel = os.path.relpath(d, ws)
    src = os.path.join(d, "Cargo.toml")
    if os.path.islink(src):
        sys.exit(f"{os.path.join(rel, 'Cargo.toml')} is a link")
    os.makedirs(os.path.join(out, rel), exist_ok=True)
    shutil.copyfile(src, os.path.join(out, rel, "Cargo.toml"))
    m = tomllib.load(open(src, "rb"))
    if "package" not in m:
        continue
    package = m["package"].get("name", "")
    lib = m.get("lib")
    bins = m.get("bin") or []
    has = lambda f: os.path.isfile(os.path.join(d, f))
    # The library: where [lib] says, or src/lib.rs when the crate has one (or nothing else that cargo would find).
    if lib is not None or has("src/lib.rs") or not (bins or has("src/main.rs")):
        stub(os.path.join(rel, (lib or {}).get("path") or "src/lib.rs"))
    # The implied binary: src/main.rs.
    if has("src/main.rs"):
        stub(os.path.join(rel, "src/main.rs"))
    # Named targets: their path, or the place cargo looks for one declared without a path.
    DEFAULT = {"bin": "src/bin/{}.rs", "example": "examples/{}.rs", "test": "tests/{}.rs", "bench": "benches/{}.rs"}
    for kind, default in DEFAULT.items():
        for t in m.get(kind) or []:
            if t.get("path"):
                stub(os.path.join(rel, t["path"]))
                continue
            name = str(t.get("name", ""))
            if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
                sys.exit(f"a [[{kind}]] target named {name!r} needs a plain name")
            stub(os.path.join(rel, default.format(name)))
            if kind == "bin" and name == package:
                stub(os.path.join(rel, "src/main.rs"))
    build = (m.get("package") or {}).get("build")
    if isinstance(build, str):
        stub(os.path.join(rel, build))
lock = os.path.join(ws, "Cargo.lock")
if os.path.isfile(lock) and not os.path.islink(lock):
    shutil.copyfile(lock, os.path.join(out, "Cargo.lock"))
PY
}

if [ "$MODE" = build ]; then
  ALLOW="${"${"}4:-}"
  rm -rf "$OUT"; mkdir -p "$OUT"; echo "[]" > "$OUT/programs.json"; : > "$OUT/checks.jsonl"
  command -v docker >/dev/null || { check "$OUT/checks.jsonl" solana_build fail "docker isn't available for the verifiable build"; exit 0; }
  BUILD_FAIL=""; BUILT=0; NO_LOCK=""
  cat > "$OUT/.depinfo.py" <<'PY'
import hashlib, json, sys, tarfile
mode, out = sys.argv[1], sys.argv[2]
res, dsize = {"d_files": {}, "hashes": {}}, 0
with tarfile.open(fileobj=sys.stdin.buffer, mode="r|*") as t:
    for m in t:
        name = m.name.split("/", 1)[1] if "/" in m.name else ""
        if not name or not m.isfile():
            continue
        if mode == "target":
            # cargo's and rustc's dep-info, not a build script's own output
            if name.endswith(".d") and "/out/" not in name:
                data = t.extractfile(m).read()
                dsize += len(data)
                if dsize > 16 * 1024 * 1024:
                    sys.exit("the dep-info files are over 16 MB")
                res["d_files"][name] = data.decode("utf-8", "replace")
            continue
        res["hashes"][name] = hashlib.sha256(t.extractfile(m).read()).hexdigest()
json.dump(res, open(out, "w"))
PY
  # Both cargos fetch: the host toolchain's (it resolves Cargo.lock) and the SBF platform tools' (the one cargo
  # build-sbf compiles with, which keeps its own crate cache), so the offline build finds every crate.
  FETCH='set -e; for m in "$@"; do cargo fetch --manifest-path "$m"; for pc in /root/.cache/solana/*/platform-tools/rust/bin/cargo; do if [ -x "$pc" ]; then "$pc" fetch --manifest-path "$m"; fi; done; done'
  BUILD='set -e; for m in "$@"; do cargo build-sbf --manifest-path "$m"; done'
  # The IDL, built in a container of its own (no network, a fresh copy of the same source and crates) after the
  # programs are out: building the IDL runs the workspace's code, which must never touch the built programs.
  IDL_BUILD='mkdir -p /mynt-idl; for n in "$@"; do anchor idl build -p "$n" -o "/mynt-idl/$n.json" > "/mynt-idl/$n.log" 2>&1 || true; done; true'
  # Mynt's own settings in both containers, never the source's: the image's Rust for cargo itself (a
  # rust-toolchain.toml can't swap it), and dependencies resolved to versions the platform tools can build. The
  # target dir is /mynt-target, outside /workdir and empty: nothing from the source can be a "fresh" artifact cargo
  # would reuse instead of compiling, and the programs, dep-info and IDL Mynt reads come only from there.
  COMMON=(--workdir /workdir -e RUSTUP_TOOLCHAIN=stable -e CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback
    -e PATH=/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin)
  for w in "${"${"}WS[@]}"; do
    label="${"${"}w:-.}"; dir="$APP/$label"; slug="$(echo "$label" | tr '/.' '__')"; log="$OUT/$slug"
    mapfile -t PROGS < <(programs "$dir" 2> "$log.programs.log")
    if [ "${"${"}#PROGS[@]}" = 0 ]; then BUILD_FAIL+="$label: no program crate found ($(tail -c 300 "$log.programs.log")) "; continue; fi
    manifests=(); names=(); for p in "${"${"}PROGS[@]}"; do manifests+=("$(cut -f1 <<<"$p")"); names+=("$(cut -f2 <<<"$p")"); done
    : > "$log.build.log"
    # 0. The source, once, as the archive the build container gets: what Mynt captures is exactly what it compiles.
    srctar="$OUT/$slug.src.tar"
    tar -C "$dir" --exclude=./target --exclude=./node_modules --exclude=./.anchor --transform 's,^\.$,workdir,;s,^\./,workdir/,' -cf "$srctar" . 2>> "$log.build.log"
    srcs="$slug.sources.json"
    if ! python3 - "$srctar" "$OUT/$srcs" ${MAX_SOURCE_BYTES} <<'PY' >> "$log.build.log" 2>&1; then BUILD_FAIL+="$label: $(tail -c 300 "$log.build.log") "; rm -f "$srctar" "$OUT/$srcs"; continue; fi
import base64, json, re, sys, tarfile
src, out, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
files, binary, links, total, refused = {}, {}, {}, 0, []
with tarfile.open(src) as t:
    for m in t.getmembers():
        path = m.name[len("workdir/"):] if m.name.startswith("workdir/") else None
        if not path:
            continue
        # Never anything a build could reuse instead of compiling: no target folders at any depth (the top-level
        # ones are left out of the archive), no cargo artifacts, fingerprints or dep-info, no prebuilt programs.
        # Refused, not stripped: what Mynt keeps is what it compiles.
        parts = path.split("/")
        if re.search(r"[\x00-\x1f\x7f]", path):
            refused.append(repr(path) + " (control characters in its name)")
        elif any(x in ("target", "docker-target", ".anchor", ".fingerprint", "mynt-target", "mynt-idl") for x in parts):
            refused.append(path)
        elif not m.isdir() and re.search(r"\.(rlib|rmeta|d|so)$", parts[-1]):
            refused.append(path)
        if m.isdir():
            continue
        if m.issym() or m.islnk():
            links[path] = m.linkname
            continue
        if not m.isfile():
            continue
        total += m.size
        if total > limit:
            sys.exit(f"the workspace's source is over {limit // (1024 * 1024)} MB; Mynt keeps everything it compiles, so the build can't go on (move large files out of the Anchor workspace)")
        data = t.extractfile(m).read()
        try:
            files[path] = data.decode("utf-8")
        except UnicodeDecodeError:
            binary[path] = base64.b64encode(data).decode()
if refused:
    # Kept short: the build failure keeps only the log's last 300 characters, and this line must survive whole.
    shown = ", ".join(sorted(refused)[:3])
    sys.exit(("refused: the workspace ships build output (remove it): %d path(s), e.g. " % len(refused) + shown)[:250])
json.dump({"files": files, "binary": binary, "links": links}, open(out, "w"), sort_keys=True)
PY
    # 1. Fetch, networked, in a throwaway container that gets only the manifests, Cargo.lock and empty stub
    #    sources: no .cargo/ config, no build script, no rust-toolchain.toml, nothing of the source that could run.
    #    The compiler and every wrapper are pinned by environment, which outranks any config.
    skel=$(mktemp -d)
    committed=0; [ -f "$dir/Cargo.lock" ] && [ ! -L "$dir/Cargo.lock" ] && committed=1
    if ! skeleton "$dir" "$skel" >> "$log.build.log" 2>&1; then BUILD_FAIL+="$label: $(tail -c 400 "$log.build.log") "; rm -rf "$skel"; continue; fi
    fcid=$(docker create "${"${"}COMMON[@]}" -e RUSTC=rustc -e CARGO_BUILD_RUSTC=rustc -e RUSTC_WRAPPER= -e CARGO_BUILD_RUSTC_WRAPPER= \
      -e RUSTC_WORKSPACE_WRAPPER= -e CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER= \
      ${T.anchorImage} bash -c "$FETCH" _ "${"${"}manifests[@]}" 2>> "$log.build.log")
    if [ -z "$fcid" ] || ! tar -C "$skel" --transform 's,^\.$,workdir,;s,^\./,workdir/,' -cf - . | docker cp - "$fcid:/" >> "$log.build.log" 2>&1 \
       || ! docker start -a "$fcid" >> "$log.build.log" 2>&1; then
      BUILD_FAIL+="$label: fetching its crates failed: $(tail -c 600 "$log.build.log" | tr -d '\r') "
      [ -n "$fcid" ] && docker rm -f "$fcid" >/dev/null 2>&1; rm -rf "$skel"; continue
    fi
    rm -rf "$skel"
    # 2. Build, in a fresh container with no network from the moment it exists, never with a mount of the host.
    #    It gets the source archive above (exactly what Mynt keeps), and the crate caches and Cargo.lock from the
    #    fetch container (streamed container to container, never unpacked here). The fetch container is gone before
    #    the build starts. The build is the container's own process: when it ends the container stops, and anything
    #    it left running dies.
    bcid=$(docker create --network none "${"${"}COMMON[@]}" -e CARGO_TARGET_DIR=/mynt-target -e CARGO_NET_OFFLINE=true \
      ${T.anchorImage} bash -c "$BUILD" _ "${"${"}manifests[@]}" 2>> "$log.build.log")
    ok=1
    if [ -z "$bcid" ]; then ok=0
    elif [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$bcid")" != none ]; then echo "the build container has a network" >> "$log.build.log"; ok=0
    elif ! docker cp - "$bcid:/" < "$srctar" >> "$log.build.log" 2>&1 \
       || ! docker cp "$fcid:/root/.cargo/registry" - | docker cp - "$bcid:/root/.cargo" >> "$log.build.log" 2>&1 \
       || ! docker cp "$fcid:/workdir/Cargo.lock" - | docker cp - "$bcid:/workdir" >> "$log.build.log" 2>&1; then ok=0
    else
      docker cp "$fcid:/root/.cargo/git" - 2>/dev/null | docker cp - "$bcid:/root/.cargo" >/dev/null 2>&1 || true
    fi
    # The IDL's container, created and filled the same way now, but started only after the programs are out:
    # building the IDL runs the workspace's code, which must never touch the built programs.
    icid=$(docker create --network none "${"${"}COMMON[@]}" -e CARGO_TARGET_DIR=/mynt-target -e CARGO_NET_OFFLINE=true \
      ${T.anchorImage} bash -c "$IDL_BUILD" _ "${"${"}names[@]}" 2>> "$log.idl.log")
    if [ -n "$icid" ] && [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$icid")" = none ] && docker cp - "$icid:/" < "$srctar" >> "$log.idl.log" 2>&1 \
       && docker cp "$fcid:/root/.cargo/registry" - | docker cp - "$icid:/root/.cargo" >> "$log.idl.log" 2>&1 \
       && docker cp "$fcid:/workdir/Cargo.lock" - | docker cp - "$icid:/workdir" >> "$log.idl.log" 2>&1; then
      docker cp "$fcid:/root/.cargo/git" - 2>/dev/null | docker cp - "$icid:/root/.cargo" >/dev/null 2>&1 || true
    else
      [ -n "$icid" ] && docker rm -f "$icid" >/dev/null 2>&1; icid=""
    fi
    # The crates as cargo downloaded them (checksums verified against crates.io's index), before any of the
    # developer's code has run anywhere: what the dependency capture reads.
    docker cp "$fcid:/root/.cargo/registry/cache" - > "$OUT/$slug.crates.tar" 2>> "$log.build.log" || : > "$OUT/$slug.crates.tar"
    docker rm -f "$fcid" >/dev/null 2>&1
    if [ "$ok" = 0 ] || ! docker start -a "$bcid" >> "$log.build.log" 2>&1; then
      BUILD_FAIL+="$label: $(tail -c 700 "$log.build.log" | tr -d '\r') "
      [ -n "$bcid" ] && docker rm -f "$bcid" >/dev/null 2>&1; [ -n "$icid" ] && docker rm -f "$icid" >/dev/null 2>&1; continue
    fi
    cid="$bcid"
    # The Cargo.lock the build actually used (read back from the stopped build container), hashed and kept with
    # each program, so anyone can rebuild exactly these bytes.
    lock="$OUT/$slug.Cargo.lock"; rm -f "$lock"
    lock_sha=""
    if docker cp -L "$cid:/workdir/Cargo.lock" "$lock" >> "$log.build.log" 2>&1 && [ -f "$lock" ] && [ ! -L "$lock" ]; then
      lock_sha=$(sha256sum "$lock" | cut -d' ' -f1)
    fi
    [ "$committed" = 1 ] || NO_LOCK+="$label "
    for p in "${"${"}PROGS[@]}"; do
      name=$(cut -f2 <<<"$p")
      # -L: a link in the container is resolved there, to the container's own file, never copied out as a link
      # that would point at the host. Then only a regular file that is an ELF program counts.
      rm -f "$OUT/$name.so"
      if ! docker cp -L "$cid:/mynt-target/deploy/$name.so" "$OUT/$name.so" >> "$log.build.log" 2>&1; then BUILD_FAIL+="$label: $name.so wasn't built "; continue; fi
      if [ -L "$OUT/$name.so" ] || [ ! -f "$OUT/$name.so" ] || [ "$(head -c 4 "$OUT/$name.so" | od -An -tx1 | tr -d ' \n')" != 7f454c46 ]; then
        BUILD_FAIL+="$label: $name.so isn't a program (not a regular ELF file) "; rm -f "$OUT/$name.so"; continue
      fi
    done
    # What the compiler actually read: every dep-info file cargo wrote, and the workspace and the unpacked crates as
    # the stopped container holds them (streamed out as tar and hashed, never unpacked here).
    docker cp -L "$cid:/workdir" - 2>> "$log.build.log" | python3 "$OUT/.depinfo.py" workdir "$OUT/$slug.depinfo.workdir.json" >> "$log.build.log" 2>&1
    docker cp -L "$cid:/mynt-target" - 2>> "$log.build.log" | python3 "$OUT/.depinfo.py" target "$OUT/$slug.depinfo.target.json" >> "$log.build.log" 2>&1
    docker cp -L "$cid:/root/.cargo/registry/src" - 2>> "$log.build.log" | python3 "$OUT/.depinfo.py" registry "$OUT/$slug.depinfo.registry.json" >> "$log.build.log" 2>&1
    docker rm -f "$cid" >/dev/null 2>&1
    # 3. The IDL, in its own container, after the programs are out.
    if [ -n "$icid" ] && timeout 1800 docker start -a "$icid" >> "$log.idl.log" 2>&1; then
      for n in "${"${"}names[@]}"; do
        rm -f "$OUT/$n.build-idl.json"
        docker cp -L "$icid:/mynt-idl/$n.json" "$OUT/$n.build-idl.json" >> "$log.idl.log" 2>&1 || true
        docker cp -L "$icid:/mynt-idl/$n.log" "$OUT/$n.build-idl.log" >> "$log.idl.log" 2>&1 || true
        { [ -L "$OUT/$n.build-idl.json" ] || ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$OUT/$n.build-idl.json" 2>/dev/null; } && rm -f "$OUT/$n.build-idl.json"
      done
    fi
    [ -n "$icid" ] && docker rm -f "$icid" >/dev/null 2>&1
    # 4. The dependencies: every crate of the Cargo.lock the build used, checked against the .crate cargo
    #    downloaded, and the source of each one not on Mynt's allowlist, for the mainnet program gate.
    deps="$slug.deps.json"
    python3 - "$lock" "$OUT/$slug.crates.tar" "$ALLOW" "$OUT/$deps" ${MAX_DEPS_SOURCE_BYTES} <<'PY' >> "$log.build.log" 2>&1 || rm -f "$OUT/$deps"
import hashlib, io, json, os, re, sys, tarfile, tomllib
lock, crates_tar, allow, out, limit = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], int(sys.argv[5])
allowed = set(json.load(open(allow)).get("crates", [])) if allow and os.path.isfile(allow) else set()
packages = tomllib.load(open(lock, "rb")).get("package", []) if os.path.isfile(lock) else []
cache = {}
try:
    with tarfile.open(crates_tar) as t:
        for m in t.getmembers():
            if m.isfile() and m.name.endswith(".crate"):
                cache[os.path.basename(m.name)[: -len(".crate")]] = t.extractfile(m).read()
except Exception:
    pass
problems, entries, sources, total, over = [], [], {}, 0, False
for p in packages:
    name, version, source, checksum = p.get("name"), p.get("version"), p.get("source"), p.get("checksum")
    e = {"name": name, "version": version, "source": source, "checksum": checksum, "allowlisted": name in allowed}
    if source and source.startswith(("registry+", "sparse+")):
        data = cache.get(f"{name}-{version}")
        if data is None:
            problems.append(f"{name} {version}: not in the downloaded crates")
        else:
            e["crate_sha256"] = hashlib.sha256(data).hexdigest()
            if checksum and e["crate_sha256"] != checksum:
                problems.append(f"{name} {version}: the downloaded crate doesn't match Cargo.lock's checksum")
            if name not in allowed and not over:
                files = {}
                with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as c:
                    for m in c.getmembers():
                        if m.isfile() and (m.name.endswith(".rs") or os.path.basename(m.name) == "Cargo.toml"):
                            total += m.size
                            if total > limit:
                                over = True
                                problems.append(f"the source of the crates not on the allowlist is over the capture limit (at {name} {version})")
                                break
                            files[m.name.split("/", 1)[1] if "/" in m.name else m.name] = c.extractfile(m).read().decode("utf-8", "replace")
                if not over:
                    sources[f"{name}@{version}"] = files
    entries.append(e)
json.dump({"packages": entries, "sources": sources, "complete": not problems and bool(packages), "problems": problems[:50], "lock": open(lock, encoding="utf-8", errors="replace").read() if os.path.isfile(lock) else None}, open(out, "w"), sort_keys=True)
# The dep-info record: what the compiler read, the container's copies' hashes, and every file of each .crate.
slug = out[: -len(".deps.json")]
def part(kind):
    try:
        return json.load(open(f"{slug}.depinfo.{kind}.json"))
    except Exception:
        return None
w, r, tg = part("workdir"), part("registry"), part("target")
crate_files = {}
for key, data in cache.items():
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as c:
        for m in c.getmembers():
            if m.isfile() and "/" in m.name:
                files[m.name.split("/", 1)[1]] = hashlib.sha256(c.extractfile(m).read()).hexdigest()
    crate_files[key] = files
depinfo_problems = [] if w and r and tg else ["Mynt couldn't read the build container's dep-info and files back"]
json.dump({"d_files": (tg or {}).get("d_files", {}), "workdir": (w or {}).get("hashes", {}), "registry": (r or {}).get("hashes", {}), "crate_files": crate_files, "problems": depinfo_problems},
          open(f"{slug}.depinfo.json", "w"), sort_keys=True)
PY
    rm -f "$OUT/$slug.crates.tar" "$srctar" "$OUT/$slug.depinfo.workdir.json" "$OUT/$slug.depinfo.registry.json" "$OUT/$slug.depinfo.target.json"
    for p in "${"${"}PROGS[@]}"; do
      name=$(cut -f2 <<<"$p"); declared=$(cut -f3 <<<"$p")
      [ -f "$OUT/$name.so" ] || continue
      python3 - "$OUT" "$name" "$label" "$declared" "$lock_sha" "$committed" "$srcs" "$deps" <<'PY'
import hashlib, json, os, sys
out, name, ws, declared, lock_sha, committed, srcs, deps = sys.argv[1:9]
data = open(os.path.join(out, name + ".so"), "rb").read()
progs = json.load(open(os.path.join(out, "programs.json")))
def kept(key, f):
    path = os.path.join(out, f)
    if not os.path.isfile(path) or os.path.islink(path):
        return {}
    raw = open(path, "rb").read()
    return {key: f, f"{key}_size": len(raw), f"{key}_sha256": hashlib.sha256(raw).hexdigest()}
progs.append({"workspace": ws, "name": name, "size": len(data), "sha256": hashlib.sha256(data.rstrip(b"\0")).hexdigest(), "declared_id": declared or None,
              "cargo_lock_sha256": lock_sha or None, "cargo_lock_committed": committed == "1",
              **kept("sources", srcs), **kept("deps", deps), **kept("idl", name + ".build-idl.json"), **kept("depinfo", deps[: -len(".deps.json")] + ".depinfo.json")})
json.dump(progs, open(os.path.join(out, "programs.json"), "w"), indent=2)
PY
      BUILT=$((BUILT + 1))
    done
  done
  if [ -n "$BUILD_FAIL" ]; then check "$OUT/checks.jsonl" solana_build fail "$BUILD_FAIL"
  elif [ "$BUILT" = 0 ]; then check "$OUT/checks.jsonl" solana_build fail "an Anchor workspace built no program"
  else
    WARN=""; [ -z "$NO_LOCK" ] || WARN="; warning: no Cargo.lock committed in $NO_LOCK- the build resolved one (its hash is recorded), but commit it so the dependencies can't change between builds"
    check "$OUT/checks.jsonl" solana_build pass "$BUILT program(s) built verifiably in ${T.anchorImage.split("@")[0]} (Anchor ${T.anchor.version})$WARN"
  fi
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
