#!/usr/bin/env node
// Runs Mynt's own build checks (verify.sh, from the built server) on an app folder, the way a build's verification
// does: the source packaged without node_modules, hash-checked, then every check, with the pinned scanners fetched
// and the app's images built and scanned. CI runs it on a freshly scaffolded starter, so a template that would fail
// Mynt's dependency gate, image scan or SBOM is caught here and not in a developer's build.
//
//   node test/fixtures/verify-starter.mjs <app-dir> [--must-pass dependency_audit,image_scan,...]
//
// Prints each check with its result, tool and time taken, and each image's scan. Exits 1 when a check named in
// --must-pass failed or didn't run. (A bare starter has no tests of its own, so `tests` isn't in the default list:
// the coding agents write them.) Needs docker, python3, curl and network access.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERIFY_SCRIPT } from "../../dist/verify-script.js";

const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--"));
const flag = args.indexOf("--must-pass");
const mustPass = (flag >= 0 ? args[flag + 1] : "secrets_scan,dependency_audit,static_scan,sbom,image_scan").split(",").filter(Boolean);
if (!app) {
  console.error("usage: verify-starter.mjs <app-dir> [--must-pass a,b,c]");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "mynt-verify-starter-"));
const V = join(root, "verify");
const out = join(root, "out");
for (const d of [V, out]) spawnSync("mkdir", ["-p", d]);
// Packaged as a build packages it: the folder without any node_modules.
const tar = spawnSync("tar", ["--exclude=node_modules", "-czf", join(out, "app.tgz"), "."], { cwd: resolve(app) });
if (tar.status !== 0) {
  console.error(`Couldn't package ${app}: ${tar.stderr}`);
  process.exit(2);
}
const sha = createHash("sha256").update(readFileSync(join(out, "app.tgz"))).digest("hex");
writeFileSync(join(V, "verify.sh"), VERIFY_SCRIPT);
writeFileSync(join(V, "disclosures.json"), "[]");
const env = { ...process.env, MYNT_VERIFY_DIR: V, MYNT_VERIFY_APP: join(root, "app"), MYNT_VERIFY_AUDIT_SRC: join(root, "audit-src") };
const started = Date.now();
const run = spawnSync("bash", [join(V, "verify.sh"), `file://${join(out, "app.tgz")}`, sha], { env, stdio: ["ignore", "inherit", "inherit"] });
const seconds = Math.round((Date.now() - started) / 1000);

const read = (file) => {
  try {
    return readFileSync(join(V, file), "utf8");
  } catch {
    return null;
  }
};
const report = JSON.parse(read("report.json") ?? "null");
const runs = new Map(
  (read("pipeline.jsonl") ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => [r.check, r]),
);
const images = JSON.parse(read("images.json") ?? "null");
console.log(`\nMynt's checks on ${app} (verify.sh exit ${run.status}, ${seconds}s in all)`);
for (const c of report?.checks ?? []) {
  const r = runs.get(c.name);
  const took = r ? `${Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)}s` : "";
  console.log(`  ${c.status.padEnd(4)} ${c.name.padEnd(17)} ${took.padStart(5)}  ${r ? `${r.tool} ${r.tool_version}`.trim() : ""}\n         ${String(c.detail ?? "").replace(/\s+/g, " ").slice(0, 700)}`);
}
for (const i of images?.images ?? []) {
  const s = i.scan;
  console.log(
    `  image ${i.service ?? i.ref}: ${i.build_seconds ?? "?"}s to build, ${i.size_bytes ? `${Math.round(i.size_bytes / 1e6)} MB` : "size unknown"}, ${i.sbom?.components ?? 0} components` +
      (s ? `; ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low (${s.blocking.length} the build can fix, ${s.publisher_built.length} compiled in by the base image's publisher, ${s.unfixable.length} with no fixed version)` : "; not scanned"),
  );
  for (const row of [...(s?.blocking ?? []), ...(s?.publisher_built ?? []), ...(s?.unfixable ?? [])]) console.log(`      ${row}`);
}
if (!report) console.log(`  no report was written\n${(read("images.log") ?? "").slice(-800)}`);

const by = new Map((report?.checks ?? []).map((c) => [c.name, c.status]));
const bad = mustPass.filter((name) => by.get(name) !== "pass" && by.get(name) !== "warn");
spawnSync("chmod", ["-R", "u+w", root]);
rmSync(root, { recursive: true, force: true });
if (bad.length) {
  console.error(`\nFailed or didn't run: ${bad.map((n) => `${n} (${by.get(n) ?? "no result"})`).join(", ")}`);
  process.exit(1);
}
console.log(`\nNone of ${mustPass.join(", ")} failed.`);
