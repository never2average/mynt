// The product desk's code runner: the deterministic half of the desk. Mynt runs it in a sandbox
// against a clone of the innovator's workspace repository; no model calls are involved. It finds the
// model that applies to the product (models/<name>/model.json), checks the term sheet has the inputs
// it needs, runs it, and checks its report has the shape Mynt expects.
//
//   node desk-runner.mjs <repo dir> <job dir>     (job dir holds product.json and terms.json)
//
// A model's manifest:
//   { "name": "...", "description": "...",
//     "applies_to": { "product_lines": ["credit"], "categories": ["personal-loans"] },   // either may be omitted
//     "inputs": [{ "key": "apr_pct", "required": true, "unit": "%", "description": "..." }],
//     "run": "python3 main.py",                     // gets MYNT_INPUT (JSON) and must write MYNT_OUTPUT
//     "requirements": "requirements.txt" }          // optional, installed into the model's own venv
// Its output: { "verdict": "feasible" | "marginal" | "infeasible", "summary": "...",
//   "metrics": { "<name>": number | string }, "checks": [{ "name", "status": "pass"|"warn"|"fail", "detail", "legal_ref"? }],
//   "scenarios": [{ "name", "metrics": {...} }], "assumptions": { ... } }

export const DESK_VERDICTS = ["feasible", "marginal", "infeasible"] as const;

export interface DeskReport {
  verdict: (typeof DESK_VERDICTS)[number];
  summary: string;
  metrics: Record<string, number | string>;
  checks: { name: string; status: "pass" | "warn" | "fail"; detail: string; legal_ref?: string }[];
  scenarios?: { name: string; metrics: Record<string, number | string> }[];
  assumptions?: Record<string, unknown>;
}

export type DeskOutcome =
  | { outcome: "ran"; model: string; commit: string | null; report: DeskReport; log: string }
  | { outcome: "no_model"; models: string[]; log: string }
  | { outcome: "missing_inputs"; model: string; missing: { key: string; unit?: string; description?: string }[]; log: string }
  | { outcome: "error"; model: string | null; error: string; log: string };

export const DESK_RUNNER = String.raw`
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, job] = process.argv.slice(2);
const product = JSON.parse(readFileSync(join(job, "product.json"), "utf8"));
const terms = JSON.parse(readFileSync(join(job, "terms.json"), "utf8"));
const wanted = existsSync(join(job, "model.txt")) ? readFileSync(join(job, "model.txt"), "utf8").trim() : null;
let log = "";
const done = (r) => {
  writeFileSync(join(job, "outcome.json"), JSON.stringify({ ...r, log: log.slice(-8000) }));
  process.exit(0);
};

let commit = null;
try { commit = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim(); } catch {}

const dir = join(repo, "models");
const models = (existsSync(dir) ? readdirSync(dir) : [])
  .filter((d) => existsSync(join(dir, d, "model.json")))
  .map((d) => {
    try { return { dir: join(dir, d), ...JSON.parse(readFileSync(join(dir, d, "model.json"), "utf8")) }; } catch { return null; }
  })
  .filter(Boolean);
const applies = (m) => {
  const a = m.applies_to ?? {};
  return (!a.product_lines || a.product_lines.includes(product.product_line)) && (!a.categories || a.categories.includes(product.category));
};
// The most specific match: a model naming the category beats one naming only the line.
const model = wanted
  ? models.find((m) => m.name === wanted)
  : models.filter(applies).sort((x, y) => (y.applies_to?.categories ? 1 : 0) - (x.applies_to?.categories ? 1 : 0))[0];
if (!model) done({ outcome: "no_model", models: models.map((m) => m.name) });

const values = terms.inputs ?? {};
const missing = (model.inputs ?? []).filter((i) => i.required !== false && (values[i.key] === undefined || values[i.key] === null || values[i.key] === ""));
if (missing.length) done({ outcome: "missing_inputs", model: model.name, missing: missing.map(({ key, unit, description }) => ({ key, unit, description })) });

const venv = "/tmp/mynt-desk-venv-" + model.name.replace(/[^a-z0-9_-]/gi, "_");
const env = { ...process.env, PATH: venv + "/bin:" + process.env.PATH, MYNT_INPUT: join(job, "input.json"), MYNT_OUTPUT: join(job, "report.json") };
const sh = (cmd, timeout) => {
  const r = spawnSync("bash", ["-lc", cmd], { cwd: model.dir, env, encoding: "utf8", timeout });
  log += "$ " + cmd + "\n" + (r.stdout ?? "") + (r.stderr ?? "") + "\n";
  return r.status === 0;
};
if (!existsSync(venv) && !sh("python3 -m venv " + venv, 120000)) done({ outcome: "error", model: model.name, error: "Couldn't create a Python environment" });
if (model.requirements && !sh("pip install -q -r " + JSON.stringify(model.requirements), 600000)) done({ outcome: "error", model: model.name, error: "Couldn't install the model's requirements" });

writeFileSync(join(job, "input.json"), JSON.stringify({ product, inputs: values, assumptions: terms.assumptions ?? {}, regulatory: terms.regulatory ?? [] }));
if (!sh(model.run, 600000)) done({ outcome: "error", model: model.name, error: "The model exited with an error" });
let report;
try { report = JSON.parse(readFileSync(join(job, "report.json"), "utf8")); } catch { done({ outcome: "error", model: model.name, error: "The model didn't write a JSON report to MYNT_OUTPUT" }); }
const verdicts = ["feasible", "marginal", "infeasible"];
const bad = !verdicts.includes(report.verdict) || typeof report.summary !== "string" || typeof report.metrics !== "object" || !Array.isArray(report.checks)
  || report.checks.some((c) => !["pass", "warn", "fail"].includes(c.status) || typeof c.name !== "string");
if (bad) done({ outcome: "error", model: model.name, error: "The report doesn't have the expected shape (verdict, summary, metrics, checks)" });
done({ outcome: "ran", model: model.name, commit, report });
`;
