#!/usr/bin/env node
// Runs what the mainnet program gate checks itself, without agents, on a program: the hard rules (src/solana/
// program-rules.ts), the exceptions in its workspace, its IDL against its bytes, and its dependencies against the
// crate allowlist. CI runs it on the template program as Mynt captured it (it must pass, with no exceptions and
// every crate on the allowlist) and on a bad fixture (it must be refused).
//
//   node scripts/program-rules.mjs --program-id <address> (--workspace <dir> | --sources <sources.json>)
//     [--so <program.so>] [--idl <idl.json>] [--deps <deps.json>] [--depinfo <depinfo.json>]
//
// With --depinfo (what the build kept of rustc's dep-info), the rules read exactly the files the compiler read, and
// the module-tree resolver is only a cross-check.
//
// Prints the result as JSON; exits 0 when the program passes, 1 when it's refused, 2 on bad input.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { checkProgramRules } from "../dist/solana/program-rules.js";
import { crossCheck, dependencyVerdict, evaluateDepInfo, resolveCrateTree, verifyIdl, workspaceExceptions } from "../dist/solana/crate-tree.js";
import { loadCrateAllowlist } from "../dist/solana/vuln-db.js";

const { values } = parseArgs({
  options: { workspace: { type: "string" }, sources: { type: "string" }, "program-id": { type: "string" }, so: { type: "string" }, idl: { type: "string" }, deps: { type: "string" }, depinfo: { type: "string" } },
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
const depsCapture = values.deps ? JSON.parse(readFileSync(values.deps, "utf8")) : null;
const deps = depsCapture ? dependencyVerdict(depsCapture, new Set(allow.crates), tree.packages) : null;
const lockCrates = new Set((depsCapture?.packages ?? []).filter((p) => p.source).map((p) => `${p.name}-${p.version}`));
const compiled = values.depinfo ? evaluateDepInfo(JSON.parse(readFileSync(values.depinfo, "utf8")), bundle, lockCrates) : null;
const rules = checkProgramRules({ name: "program", program_id: values["program-id"], program, idl: idlCheck?.verified ? idl : null, sources: bundle.files, compiled_files: compiled?.workspace ?? null });
const result = {
  passed: rules.passed && (!idlCheck || idlCheck.verified) && (!deps || deps.refusals.length === 0) && (!compiled || compiled.problems.length === 0),
  rules,
  compiled_files: compiled ? compiled.workspace : [...tree.code.keys()],
  compiled: compiled && { problems: compiled.problems, registry_files: compiled.registry.length, generated: compiled.generated },
  exceptions: [...workspaceExceptions(bundle, tree), ...(deps?.exceptions ?? []), ...(compiled ? crossCheck(tree, compiled) : [])],
  idl: idlCheck,
  dependencies: deps && { refusals: deps.refusals, off_allowlist: deps.exceptions.map((e) => e.id), crates: deps.crates.length },
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
