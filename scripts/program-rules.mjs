#!/usr/bin/env node
// Runs what the mainnet program gate checks itself, without agents, on a program: the hard rules (src/solana/
// program-rules.ts), the exceptions in its workspace, its IDL against its bytes, and its dependencies against the
// crate allowlist. CI runs it on the template program as Mynt captured it (it must pass, with no exceptions and
// every crate on the allowlist) and on a bad fixture (it must be refused).
//
//   node scripts/program-rules.mjs --program-id <address> (--workspace <dir> | --sources <sources.json>)
//     [--so <program.so>] [--idl <idl.json>] [--deps <deps.json>]
//
// Prints the result as JSON; exits 0 when the program passes, 1 when it's refused, 2 on bad input.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { checkProgramRules } from "../dist/solana/program-rules.js";
import { dependencyVerdict, resolveCrateTree, verifyIdl, workspaceExceptions } from "../dist/solana/crate-tree.js";
import { loadCrateAllowlist } from "../dist/solana/vuln-db.js";

const { values } = parseArgs({
  options: { workspace: { type: "string" }, sources: { type: "string" }, "program-id": { type: "string" }, so: { type: "string" }, idl: { type: "string" }, deps: { type: "string" } },
});
if ((!values.workspace && !values.sources) || !values["program-id"]) {
  console.error("usage: program-rules.mjs --program-id <address> (--workspace <dir> | --sources <sources.json>) [--so <program.so>] [--idl <idl.json>] [--deps <deps.json>]");
  process.exit(2);
}
let bundle;
if (values.sources) bundle = JSON.parse(readFileSync(values.sources, "utf8"));
else {
  // Every file, as the build captures it (outside target/ and node_modules/ at the top).
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(values.workspace, path);
      if (statSync(path).isDirectory()) {
        if (!["target", "node_modules", ".anchor"].includes(rel)) walk(path);
      } else files[rel] = readFileSync(path, "utf8");
    }
  };
  walk(values.workspace);
  bundle = { files };
}
const program = values.so ? new Uint8Array(readFileSync(values.so)) : null;
const idl = values.idl ? JSON.parse(readFileSync(values.idl, "utf8")) : null;
const tree = resolveCrateTree(bundle.files);
const idlCheck = idl && program ? verifyIdl(idl, program) : null;
const allow = loadCrateAllowlist();
const deps = values.deps ? dependencyVerdict(JSON.parse(readFileSync(values.deps, "utf8")), new Set(allow.crates), tree.packages) : null;
const rules = checkProgramRules({ name: "program", program_id: values["program-id"], program, idl: idlCheck?.verified ? idl : null, sources: bundle.files });
const result = {
  passed: rules.passed && (!idlCheck || idlCheck.verified) && (!deps || deps.refusals.length === 0),
  rules,
  compiled_files: [...tree.code.keys()],
  exceptions: [...workspaceExceptions(bundle, tree), ...(deps?.exceptions ?? [])],
  idl: idlCheck,
  dependencies: deps && { refusals: deps.refusals, off_allowlist: deps.exceptions.map((e) => e.id), crates: deps.crates.length },
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
