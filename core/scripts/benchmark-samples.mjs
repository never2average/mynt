#!/usr/bin/env node
// Prepares the agent benchmarks' program samples on this machine exactly as the mainnet gate prepares them in a
// sandbox for a benchmark run (src/solana/mainnet-gate.ts, "sample_provisioning"): the coding agents' starter program
// and scaffold script as shipped, the sample's files laid over it, and Mynt's own sample script. It starts no agent
// and spends nothing.
//
//   node scripts/benchmark-samples.mjs <work dir>            every audit sample, captured as the auditor gets it
//   node scripts/benchmark-samples.mjs <work dir> --build    every red-team sample, through Mynt's verifiable build
//
// Exits 1, saying which sample and why, when one can't be prepared. CI's solana-program job runs both, so a sample
// that stops compiling with the pinned toolchain is caught there and not in a paid run. Needs python3, and docker for
// --build. Run `npm run build` first.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { workspaceFiles } from "../dist/agent-host.js";
import { programSample, taskSetFor } from "../dist/benchmark-tasks.js";
import { verifiableHash } from "../dist/solana/built-programs.js";
import { GATE_SAMPLE_SCRIPT } from "../dist/solana/gate-scripts.js";
import { SOLANA_VERIFY_SCRIPT } from "../dist/solana/toolchain.js";
import { loadCrateAllowlist } from "../dist/solana/vuln-db.js";

const [work, flag] = process.argv.slice(2);
if (!work || (flag && flag !== "--build")) {
  console.error("usage: node scripts/benchmark-samples.mjs <work dir> [--build]");
  process.exit(2);
}
const build = flag === "--build";
const set = taskSetFor(build ? "program-red-team" : "program-audit");
const kit = workspaceFiles("coding-build");
const put = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
let failed = 0;
for (const task of set.tasks) {
  const sample = programSample(task.source_dir);
  const dir = resolve(work, `${build ? "build" : "capture"}-${task.id}`);
  rmSync(dir, { recursive: true, force: true });
  put(join(dir, "sample.sh"), GATE_SAMPLE_SCRIPT);
  put(join(dir, "solana-verify.sh"), SOLANA_VERIFY_SCRIPT);
  put(join(dir, "allowlist.json"), JSON.stringify(loadCrateAllowlist()));
  for (const [path, text] of Object.entries(kit)) if (path === "scripts/scaffold_program.py" || path.startsWith("templates/solana-program/")) put(join(dir, "kit", path), text);
  for (const [path, text] of Object.entries(sample.files)) put(join(dir, "sample", path), text);
  spawnSync("bash", [join(dir, "sample.sh"), dir, sample.name, sample.program_id, build ? "build" : "capture"], { stdio: "inherit" });
  let why = null;
  try {
    const prep = JSON.parse(readFileSync(join(dir, "prep.json"), "utf8"));
    if (prep.error) why = prep.error;
    else if (build) {
      const listed = JSON.parse(readFileSync(join(dir, "build/out/programs.json"), "utf8")).find((p) => p.name === sample.name);
      if (!listed) why = `Mynt's build listed no program '${sample.name}'`;
      else if (listed.declared_id !== sample.program_id) why = `the built program declares ${listed.declared_id}, not ${sample.program_id}`;
      else if (verifiableHash(readFileSync(join(dir, `build/out/${sample.name}.so`))) !== listed.sha256) why = "the program's bytes don't hash as the build recorded";
      else console.log(`${task.id}: built ${sample.name} (${listed.size} bytes, sha256 ${listed.sha256})`);
    } else {
      const raw = readFileSync(join(dir, "build/out/sample.sources.json"));
      const files = JSON.parse(raw.toString("utf8")).files;
      const lib = `programs/${sample.name}/src/lib.rs`;
      if (createHash("sha256").update(raw).digest("hex") !== prep.sources_sha256 || raw.length !== prep.sources_size) why = "the captured source doesn't match what the script recorded";
      else if (files[lib] !== sample.files[lib]) why = `the captured ${lib} isn't the sample's`;
      else if (!files["Cargo.toml"] || !files["Cargo.lock"] || !files["Anchor.toml"]?.includes(sample.program_id)) why = "the captured workspace isn't whole (Cargo.toml, Cargo.lock and an Anchor.toml naming the sample's address)";
      else console.log(`${task.id}: captured ${Object.keys(files).length} files of ${sample.name}`);
    }
  } catch (e) {
    why = `the preparation left no usable result (${e.message})`;
  }
  if (why) {
    failed++;
    console.error(`${task.id}: NOT PREPARED: ${why}`);
    try {
      console.error(readFileSync(join(dir, "prep.log"), "utf8").slice(-3000));
    } catch {
      // no log
    }
  }
}
if (failed) process.exit(1);
console.log(`${set.tasks.length} ${set.agent} sample(s) prepared`);
