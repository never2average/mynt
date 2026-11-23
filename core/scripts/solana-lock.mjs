#!/usr/bin/env node
// Regenerates the Cargo.lock that an Anchor workspace Mynt ships commits (the starter program and Mynt's own
// program), resolved exactly as Mynt's verify step resolves a source without one: in the pinned Anchor image, with
// the MSRV-aware resolver and Mynt's pin list (SOLANA_LOCK_RESOLVE in src/solana/toolchain.ts), then fetched by the
// SBF platform tools' own Cargo, which fails if it can't read a crate. Run it after a toolchain bump or a change to a
// workspace's dependencies, review the crate changes (and schemas/solana-crate-allowlist.json), and commit the lock.
//
//   npm run build && node scripts/solana-lock.mjs workspaces/coding-build/templates/solana-program programs/product-health
//
// Needs docker and the network. Only the workspace's manifests reach the container, with empty stub sources.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SOLANA_LOCK_RESOLVE, SOLANA_TOOLCHAIN, lockPinsEnv } from "../dist/solana/toolchain.js";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: node scripts/solana-lock.mjs <anchor workspace>...");
  process.exit(2);
}
const script = `set -e
rm -f Cargo.lock
${SOLANA_LOCK_RESOLVE}
for pc in /root/.cache/solana/*/platform-tools/rust/bin/cargo; do "$pc" fetch -q; done`;

for (const ws of dirs) {
  const skel = mkdtempSync(join(tmpdir(), "mynt-lock-"));
  try {
    // Every Cargo.toml, with an empty src/lib.rs beside each package's: enough for cargo to resolve.
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory() && !["target", "node_modules"].includes(e.name) && !e.name.startsWith(".")) walk(join(d, e.name));
        else if (e.isFile() && e.name === "Cargo.toml") {
          const to = join(skel, relative(ws, d));
          mkdirSync(join(to, "src"), { recursive: true });
          copyFileSync(join(d, e.name), join(to, "Cargo.toml"));
          if (/^\[package\]/m.test(readFileSync(join(d, e.name), "utf8"))) writeFileSync(join(to, "src", "lib.rs"), "");
        }
      }
    };
    walk(ws);
    const r = spawnSync(
      "docker",
      ["run", "--rm", "-v", `${skel}:/workdir`, "--workdir", "/workdir", "-e", "RUSTUP_TOOLCHAIN=stable", "-e", "CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback",
        "-e", `MYNT_LOCK_PINS=${lockPinsEnv()}`, "-e", "PATH=/root/.local/share/solana/install/active_release/bin:/root/.cargo/bin:/usr/local/bin:/usr/bin:/bin",
        SOLANA_TOOLCHAIN.anchorImage, "bash", "-c", script],
      { stdio: "inherit" },
    );
    if (r.status !== 0) {
      console.error(`${ws}: resolving failed`);
      process.exit(1);
    }
    copyFileSync(join(skel, "Cargo.lock"), join(ws, "Cargo.lock"));
    console.log(`${join(ws, "Cargo.lock")}: written`);
  } finally {
    // The container writes as root; whatever it left that this user can't remove stays in the temp folder.
    try { rmSync(skel, { recursive: true, force: true }); } catch {}
  }
}
