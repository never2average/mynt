// Reading benchmark runs: a run's scoreboard, two runs compared task by task, and the regression gate over that
// comparison. Pure functions over the rows the harness recorded (benchmarks.ts), so the gate script, the tools and
// the tests all read a run the same way.
//
// What counts: a task passes or fails on the agent's own account, and only those are scored. A task that failed
// because of the infrastructure (the sandbox host's capacity or an outage) or the harness itself, and a task that
// never ran (the run's cap was reached, something it needs isn't there), is listed and left out of the pass rate, so
// noise that isn't the agent's doesn't move its score. A figure nothing measured is null with the reason, never 0.

export type ResultStatus = "pending" | "running" | "passed" | "failed" | "not_run";
export type FailureClass = "agent" | "infrastructure" | "harness";

export interface RunSummary {
  id: string;
  agent: string;
  task_set: string;
  task_set_version: number;
  task_set_sha256: string;
  status: string;
  model: string | null;
  workspace_revisions: Record<string, string>;
}
export interface TaskResult {
  task_id: string;
  position: number;
  status: ResultStatus;
  failure_class: FailureClass | null;
  failed_check: string | null;
  detail: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const agentFailure = (r: TaskResult) => r.status === "failed" && r.failure_class === "agent";
const scored = (r: TaskResult) => r.status === "passed" || agentFailure(r);

export function scoreboard(results: TaskResult[]) {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter(agentFailure).length;
  const infrastructure = results.filter((r) => r.status === "failed" && r.failure_class === "infrastructure").length;
  const harness = results.filter((r) => r.status === "failed" && r.failure_class === "harness").length;
  const notRun = results.filter((r) => r.status === "not_run").length;
  const waiting = results.filter((r) => r.status === "pending" || r.status === "running").length;
  const costs = results.filter((r) => r.cost_usd !== null).map((r) => r.cost_usd as number);
  const durations = results.filter((r) => r.duration_ms !== null).map((r) => r.duration_ms as number);
  const ended = results.filter((r) => r.status === "passed" || r.status === "failed").length;
  const byCheck: Record<string, number> = {};
  for (const r of results.filter(agentFailure)) byCheck[r.failed_check ?? "unknown"] = (byCheck[r.failed_check ?? "unknown"] ?? 0) + 1;
  return {
    tasks: results.length,
    passed,
    failed,
    infrastructure_failures: infrastructure,
    harness_failures: harness,
    not_run: notRun,
    waiting,
    // Only tasks that passed or failed on the agent's own account.
    scored: passed + failed,
    pass_rate: passed + failed ? round(passed / (passed + failed)) : null,
    pass_rate_note: passed + failed ? null : "Not measured: no task has passed or failed on the agent's own account yet",
    failures_by_check: byCheck,
    cost_usd: costs.length ? round(sum(costs)) : null,
    cost_measured_tasks: costs.length,
    cost_note: !costs.length ? "Not measured: no task has a recorded cost" : costs.length === ended ? null : `Measured for ${costs.length} of ${ended} tasks that ran; the others ended before their cost was recorded`,
    duration_ms: durations.length ? sum(durations) : null,
    median_duration_ms: median(durations),
    duration_note: durations.length ? null : "Not measured: no task has finished",
  };
}

export type TaskChange = "regressed" | "fixed" | "same" | "not_comparable";

export interface Comparison {
  baseline: string;
  candidate: string;
  comparable: boolean;
  // Why the two runs can't be compared at all, or what to keep in mind when reading the comparison.
  problems: string[];
  notes: string[];
  pass_rate: { baseline: number | null; candidate: number | null; delta: number | null };
  cost_usd: { baseline: number | null; candidate: number | null; delta: number | null; delta_pct: number | null };
  median_duration_ms: { baseline: number | null; candidate: number | null; delta: number | null };
  tasks: {
    task_id: string;
    baseline: string;
    candidate: string;
    change: TaskChange;
    why: string | null;
    failed_check: string | null;
    cost_delta_usd: number | null;
    duration_delta_ms: number | null;
  }[];
  regressions: string[];
  fixed: string[];
  not_comparable: string[];
}

const label = (r: TaskResult | undefined) => (!r ? "missing" : r.status === "failed" ? `failed (${r.failure_class ?? "unknown"})` : r.status);
const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : round(b - a));

export function compareRuns(base: { run: RunSummary; results: TaskResult[] }, cand: { run: RunSummary; results: TaskResult[] }): Comparison {
  const problems: string[] = [];
  const notes: string[] = [];
  const a = base.run;
  const b = cand.run;
  if (a.agent !== b.agent) problems.push(`The runs are of different agents (${a.agent} and ${b.agent})`);
  else if (a.task_set_version !== b.task_set_version || a.task_set_sha256 !== b.task_set_sha256)
    problems.push(`The runs used different task sets (${a.task_set} v${a.task_set_version} and ${b.task_set} v${b.task_set_version}${a.task_set_version === b.task_set_version ? ", edited in between" : ""}), so their scores don't mean the same thing`);
  for (const [name, r] of [["baseline", a], ["candidate", b]] as const)
    if (["queued", "running"].includes(r.status)) problems.push(`The ${name} run is still ${r.status}`);
  if (a.model !== b.model) notes.push(`Model changed: ${a.model ?? "not recorded"} to ${b.model ?? "not recorded"}`);
  const folders = new Set([...Object.keys(a.workspace_revisions), ...Object.keys(b.workspace_revisions)]);
  const changed = [...folders].filter((w) => a.workspace_revisions[w] !== b.workspace_revisions[w]);
  if (changed.length) notes.push(`Workspace folders changed: ${changed.sort().join(", ")}`);
  else if (a.model === b.model) notes.push("Same model and same workspace folders: any difference is run-to-run variation");

  const before = new Map(base.results.map((r) => [r.task_id, r]));
  const after = new Map(cand.results.map((r) => [r.task_id, r]));
  const ids = [...new Set([...base.results, ...cand.results].sort((x, y) => x.position - y.position).map((r) => r.task_id))];
  const tasks: Comparison["tasks"] = ids.map((id) => {
    const x = before.get(id);
    const y = after.get(id);
    let change: TaskChange = "same";
    let why: string | null = null;
    if (!x || !y || !scored(x) || !scored(y)) {
      change = "not_comparable";
      const culprit = !x || !scored(x) ? ["baseline", x] as const : ["candidate", y] as const;
      why = `${culprit[0]}: ${label(culprit[1])}${culprit[1]?.detail ? ` (${culprit[1].detail.slice(0, 160)})` : ""}`;
    } else if (x.status === "passed" && y.status !== "passed") change = "regressed";
    else if (x.status !== "passed" && y.status === "passed") change = "fixed";
    return {
      task_id: id,
      baseline: label(x),
      candidate: label(y),
      change,
      why,
      failed_check: y?.failed_check ?? null,
      cost_delta_usd: delta(x?.cost_usd ?? null, y?.cost_usd ?? null),
      duration_delta_ms: delta(x?.duration_ms ?? null, y?.duration_ms ?? null),
    };
  });
  const sa = scoreboard(base.results);
  const sb = scoreboard(cand.results);
  const costDelta = delta(sa.cost_usd, sb.cost_usd);
  return {
    baseline: a.id,
    candidate: b.id,
    comparable: problems.length === 0,
    problems,
    notes,
    pass_rate: { baseline: sa.pass_rate, candidate: sb.pass_rate, delta: delta(sa.pass_rate, sb.pass_rate) },
    cost_usd: { baseline: sa.cost_usd, candidate: sb.cost_usd, delta: costDelta, delta_pct: costDelta !== null && sa.cost_usd ? round((costDelta / sa.cost_usd) * 100, 1) : null },
    median_duration_ms: { baseline: sa.median_duration_ms, candidate: sb.median_duration_ms, delta: delta(sa.median_duration_ms, sb.median_duration_ms) },
    tasks,
    regressions: tasks.filter((t) => t.change === "regressed").map((t) => t.task_id),
    fixed: tasks.filter((t) => t.change === "fixed").map((t) => t.task_id),
    not_comparable: tasks.filter((t) => t.change === "not_comparable").map((t) => t.task_id),
  };
}

export interface GateThresholds {
  // The most tasks that may pass in the baseline and fail, on the agent's own account, in the candidate.
  max_regressions: number;
  // The most the pass rate may fall, in percentage points.
  max_pass_rate_drop_points: number;
  // The least share of the task set both runs must have scored for the comparison to count.
  min_compared_share: number;
  // The most the run's cost may rise, in percent; null: cost doesn't gate.
  max_cost_increase_pct: number | null;
}
export const GATE_DEFAULTS: GateThresholds = { max_regressions: 0, max_pass_rate_drop_points: 0, min_compared_share: 0.8, max_cost_increase_pct: null };

/**
 * The regression gate: pass, fail (a regression beyond the thresholds) or inconclusive (the runs can't be compared, or
 * too few of their tasks can: an infrastructure failure isn't a pass). Only "pass" lets a change through.
 */
export function regressionGate(c: Comparison, given: Partial<GateThresholds> = {}): { verdict: "pass" | "fail" | "inconclusive"; reasons: string[]; thresholds: GateThresholds } {
  const t = { ...GATE_DEFAULTS, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) } as GateThresholds;
  if (!c.comparable) return { verdict: "inconclusive", reasons: c.problems, thresholds: t };
  const compared = c.tasks.filter((x) => x.change !== "not_comparable").length;
  const reasons: string[] = [];
  if (!c.tasks.length || compared / c.tasks.length < t.min_compared_share) {
    reasons.push(
      `Only ${compared} of ${c.tasks.length} tasks passed or failed on the agent's own account in both runs (at least ${Math.round(t.min_compared_share * 100)}% are needed); the rest: ${c.tasks.filter((x) => x.change === "not_comparable").map((x) => `${x.task_id} (${x.why})`).join("; ")}`,
    );
    return { verdict: "inconclusive", reasons, thresholds: t };
  }
  if (c.regressions.length > t.max_regressions) reasons.push(`${c.regressions.length} task(s) passed in the baseline and fail in the candidate (at most ${t.max_regressions} allowed): ${c.regressions.join(", ")}`);
  const drop = c.pass_rate.delta === null ? null : -c.pass_rate.delta * 100;
  if (drop !== null && drop > t.max_pass_rate_drop_points + 1e-9) reasons.push(`The pass rate fell ${round(drop, 1)} points (at most ${t.max_pass_rate_drop_points} allowed)`);
  if (t.max_cost_increase_pct !== null) {
    if (c.cost_usd.delta_pct === null) reasons.push("Cost wasn't measured in both runs, so the cost threshold can't be checked");
    else if (c.cost_usd.delta_pct > t.max_cost_increase_pct) reasons.push(`Cost rose ${c.cost_usd.delta_pct}% (at most ${t.max_cost_increase_pct}% allowed)`);
  }
  return { verdict: reasons.length ? "fail" : "pass", reasons, thresholds: t };
}
