#!/usr/bin/env node
// Runs the mainnet program gate's hard rules (src/solana/program-rules.ts) on a program, as Mynt does when a review
// is requested. CI uses it on the template program (it must pass) and on a bad fixture (it must be refused).
//
//   node scripts/program-rules.mjs --workspace <dir> --program-id <address> [--so <program.so>] [--idl <idl.json>]
//
// Prints the result as JSON; exits 0 when the program passes, 1 when the rules refuse it, 2 on bad input.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { checkProgramRules } from "../dist/solana/program-rules.js";

const { values } = parseArgs({ options: { workspace: { type: "string" }, "program-id": { type: "string" }, so: { type: "string" }, idl: { type: "string" } } });
if (!values.workspace || !values["program-id"]) {
  console.error("usage: program-rules.mjs --workspace <dir> --program-id <address> [--so <program.so>] [--idl <idl.json>]");
  process.exit(2);
}
// The same files Mynt captures with a build (solana-verify.sh): Rust and manifests, outside target and node_modules.
const sources = {};
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!["target", "node_modules", "docker-target"].includes(name) && !name.startsWith(".")) walk(path);
    } else if (name.endsWith(".rs") || ["Cargo.toml", "Anchor.toml", "Cargo.lock"].includes(name)) sources[relative(values.workspace, path)] = readFileSync(path, "utf8");
  }
};
walk(values.workspace);
const result = checkProgramRules({
  name: "program",
  program_id: values["program-id"],
  program: values.so ? new Uint8Array(readFileSync(values.so)) : null,
  idl: values.idl ? JSON.parse(readFileSync(values.idl, "utf8")) : null,
  sources,
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
