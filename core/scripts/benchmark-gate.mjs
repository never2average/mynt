#!/usr/bin/env node
// The agent benchmarks' regression gate. Given a baseline run and a candidate run of the same agent and task set, it
// exits non-zero when the candidate regressed beyond the stated thresholds:
//
//   0  pass: no regression beyond the thresholds
//   1  fail: a regression beyond them (each reason is printed)
//   2  inconclusive: the runs can't be compared, or too few of their tasks were scored in both (an infrastructure
//      failure is never counted as a pass), or the arguments are wrong
//
//   node scripts/benchmark-gate.mjs --baseline <run> --candidate <run> [--max-regressions 0] [--max-pass-rate-drop 0]
//                                   [--max-cost-increase-pct <n>] [--min-compared-share 0.8] [--json]
//   node scripts/benchmark-gate.mjs --validate        (only checks the task sets; needs no run and spends nothing)
//
// A <run> is a JSON file holding what get_benchmark_run returned, or a run id when DATABASE_URL is set (read-only).
// The script never starts a run: runs are started by an admin, with a cap (start_benchmark_run). Build first.
import { existsSync, readFileSync } from "node:fs";

const { compareRuns, regressionGate, GATE_DEFAULTS } = await import("../dist/benchmark-compare.js");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const stop = (message) => {
  console.error(message);
  process.exit(2);
};

if (flag("validate")) {
  const { taskSets } = await import("../dist/benchmark-tasks.js");
  try {
    const sets = taskSets();
    console.log(`${sets.length} task sets are sound: ${sets.map((s) => `${s.agent} v${s.version} (${s.tasks.length} tasks)`).join(", ")}`);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

const number = (name, fallback) => {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) stop(`--${name} takes a number, not '${raw}'`);
  return n;
};
const thresholds = {
  max_regressions: number("max-regressions", GATE_DEFAULTS.max_regressions),
  max_pass_rate_drop_points: number("max-pass-rate-drop", GATE_DEFAULTS.max_pass_rate_drop_points),
  min_compared_share: number("min-compared-share", GATE_DEFAULTS.min_compared_share),
  max_cost_increase_pct: number("max-cost-increase-pct", GATE_DEFAULTS.max_cost_increase_pct),
};

let db = null;
async function load(which) {
  const ref = value(which);
  if (!ref) stop(`Give --${which}: a JSON file from get_benchmark_run, or a run id with DATABASE_URL set`);
  if (existsSync(ref)) {
    const data = JSON.parse(readFileSync(ref, "utf8"));
    if (!data?.run?.id || !Array.isArray(data.tasks)) stop(`${ref} isn't what get_benchmark_run returns (it has no run or no tasks)`);
    return { run: data.run, results: data.tasks };
  }
  if (!process.env.DATABASE_URL) stop(`'${ref}' isn't a file, and DATABASE_URL isn't set to look it up as a run id`);
  const { connectPostgres } = await import("../dist/db.js");
  db ??= connectPostgres(process.env.DATABASE_URL);
  const run = (await db.query("SELECT * FROM financial_products.benchmark_runs WHERE id::text = $1", [ref])).rows[0];
  if (!run) stop(`No benchmark run '${ref}'`);
  const rows = (await db.query("SELECT * FROM financial_products.benchmark_results WHERE run_id = $1 ORDER BY position", [run.id])).rows;
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    run: { ...run, task_set_version: Number(run.task_set_version), workspace_revisions: run.workspace_revisions ?? {} },
    results: rows.map((r) => ({ task_id: r.task_id, position: Number(r.position), status: r.status, failure_class: r.failure_class, failed_check: r.failed_check, detail: r.detail, cost_usd: n(r.cost_usd), duration_ms: n(r.duration_ms) })),
  };
}

const baseline = await load("baseline");
const candidate = await load("candidate");
await db?.close();
const comparison = compareRuns(baseline, candidate);
const gate = regressionGate(comparison, thresholds);

if (flag("json")) console.log(JSON.stringify({ comparison, gate }, null, 2));
else {
  const pct = (v) => (v === null ? "not measured" : `${Math.round(v * 1000) / 10}%`);
  const usd = (v) => (v === null ? "not measured" : `US$${v}`);
  console.log(`${gate.verdict.toUpperCase()}: ${candidate.run.agent} run ${comparison.candidate} against baseline ${comparison.baseline}`);
  console.log(`  pass rate  ${pct(comparison.pass_rate.baseline)} -> ${pct(comparison.pass_rate.candidate)}`);
  console.log(`  cost       ${usd(comparison.cost_usd.baseline)} -> ${usd(comparison.cost_usd.candidate)}`);
  for (const note of comparison.notes) console.log(`  note: ${note}`);
  if (comparison.regressions.length) console.log(`  regressed: ${comparison.regressions.join(", ")}`);
  if (comparison.fixed.length) console.log(`  fixed: ${comparison.fixed.join(", ")}`);
  if (comparison.not_comparable.length) console.log(`  not compared (infrastructure, harness or not run): ${comparison.not_comparable.join(", ")}`);
  for (const reason of gate.reasons) console.log(`  - ${reason}`);
  console.log(`  thresholds: at most ${gate.thresholds.max_regressions} regression(s), pass rate may fall ${gate.thresholds.max_pass_rate_drop_points} point(s)${gate.thresholds.max_cost_increase_pct === null ? "" : `, cost may rise ${gate.thresholds.max_cost_increase_pct}%`}`);
}
process.exit(gate.verdict === "pass" ? 0 : gate.verdict === "fail" ? 1 : 2);
