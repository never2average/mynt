// The treasury template (workspaces/coding-build/templates/solana-treasury): its pins, its manifest, where its code
// comes from, and that the mainnet program gate still refuses it. Building it and running its tests on a local
// validator is CI's solana-treasury job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const { SOLANA_TOOLCHAIN } = await import("../dist/solana/toolchain.js");
const { checkProgramRules } = await import("../dist/solana/program-rules.js");

const ROOT = new URL("../workspaces/coding-build/templates/solana-treasury/", import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../schemas/solana-treasury-template.json", import.meta.url), "utf8"));
const esc = (v) => v.replace(/\./g, "\\.");

test("the treasury is built with exactly the pinned toolchain its manifest names", () => {
  // The template is reviewed at one toolchain: when the pins move, it needs a new review and a new hash, not a silent bump.
  const why = "the treasury is reviewed at a pinned toolchain: re-review it and record its new build hash when the pins move";
  assert.equal(manifest.toolchain.anchor, SOLANA_TOOLCHAIN.anchor.version, why);
  assert.equal(manifest.toolchain.agave, SOLANA_TOOLCHAIN.agave.version, why);
  assert.equal(manifest.toolchain.rust, SOLANA_TOOLCHAIN.rust.version, why);
  assert.equal(manifest.toolchain.anchorImage, SOLANA_TOOLCHAIN.anchorImage, why);
  assert.match(read("programs/mynt_treasury/Cargo.toml"), new RegExp(`^anchor-lang = \\{ version = "=${esc(SOLANA_TOOLCHAIN.anchor.version)}"`, "m"));
  assert.match(read("programs/mynt_treasury/Cargo.toml"), new RegExp(`^anchor-spl = \\{ version = "=${esc(SOLANA_TOOLCHAIN.anchor.version)}"`, "m"));
  assert.match(read("programs/extension_probe/Cargo.toml"), new RegExp(`^anchor-lang = "=${esc(SOLANA_TOOLCHAIN.anchor.version)}"$`, "m"));
  assert.match(read("rust-toolchain.toml"), new RegExp(`^channel = "${esc(SOLANA_TOOLCHAIN.rust.version)}"$`, "m"));
  assert.equal(JSON.parse(read("package.json")).dependencies[SOLANA_TOOLCHAIN.anchorTs.package], SOLANA_TOOLCHAIN.anchorTs.version);
  assert.equal(JSON.parse(read("package-lock.json")).packages[`node_modules/${SOLANA_TOOLCHAIN.anchorTs.package}`].version, SOLANA_TOOLCHAIN.anchorTs.version);
});

test("the manifest names the program's address and the Cargo.lock it commits", () => {
  assert.equal(manifest.program, "mynt_treasury");
  assert.equal(manifest.mainnet, false);
  assert.ok(read("programs/mynt_treasury/src/lib.rs").includes(`declare_id!("${manifest.declared_id}");`));
  assert.match(read("Anchor.toml"), new RegExp(`^mynt_treasury = "${manifest.declared_id}"$`, "m"));
  assert.doesNotMatch(read("Anchor.toml"), /\[programs\.mainnet\]/);
  assert.equal(createHash("sha256").update(readFileSync(join(ROOT, "Cargo.lock"))).digest("hex"), manifest.cargo_lock_sha256);
  assert.ok(manifest.program_sha256 === null || /^[0-9a-f]{64}$/.test(manifest.program_sha256));
});

test("everything the treasury adapts is listed with its commit and licence, and the licences are shipped", () => {
  const u = JSON.parse(read("UPSTREAM.json"));
  const byRepo = Object.fromEntries(u.sources.map((s) => [s.repo, s]));
  for (const repo of ["jito-foundation/restaking", "onre-finance/onre-sol", "Squads-Protocol/v4", "solana-foundation/token-acl", "circlefin/solana-cctp-contracts"]) assert.ok(byRepo[repo], repo);
  for (const s of u.sources) {
    if (s.commit) assert.match(s.commit, /^[0-9a-f]{40}$/, s.repo);
    if (s.url) assert.ok(s.url.endsWith(s.commit), s.repo);
  }
  assert.match(read(byRepo["jito-foundation/restaking"].license_file), /Apache License\s+Version 2\.0/);
  assert.match(read(byRepo["onre-finance/onre-sol"].license_file), /Permission is hereby granted, free of charge/);
  // Squads is AGPL: called as a deployed program, never copied.
  assert.equal(byRepo["Squads-Protocol/v4"].use, "called, never vendored");
  for (const f of byRepo["onre-finance/onre-sol"].adapted_into) {
    assert.match(read(f), /onre-sol \(MIT[\s\S]*c0490831f438074562ebf51e437ca5f8e027596b/, f);
  }
});

test("the mainnet program gate's hard rules still refuse the treasury: it holds tokens", () => {
  const sources = {};
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (!["target", "node_modules", ".anchor"].includes(name)) walk(p);
      } else sources[relative(ROOT, p)] = readFileSync(p, "utf8");
    }
  };
  walk(ROOT);
  assert.ok(existsSync(join(ROOT, "programs/mynt_treasury/src/lib.rs")));
  const r = checkProgramRules({ name: "mynt_treasury", program_id: manifest.declared_id, program: null, idl: null, sources });
  assert.equal(r.passed, false);
  assert.ok(r.findings.some((f) => f.blocks && f.rule === "RUG-TOKEN-CPI" && /anchor_spl::token/.test(f.detail)), JSON.stringify(r.findings.filter((f) => f.blocks)));
});
