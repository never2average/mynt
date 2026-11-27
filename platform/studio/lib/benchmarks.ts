// The platform admin's Agent benchmarks (/platform/benchmarks): what Mynt's benchmark tools answer, read into what
// the page shows (list_benchmark_runs, get_benchmark_run, compare_benchmark_runs). Pure, for the routes, the views
// and the tests. A figure Mynt didn't measure is null here and "Not measured" with the reason on screen, never 0.

export const BENCHMARK_AGENTS = ["coding", "product-desk", "governance-review", "connector", "program-audit", "program-red-team", "ask-ai"] as const
export type BenchmarkAgent = (typeof BENCHMARK_AGENTS)[number]
export const BENCHMARK_AGENT_LABELS: Record<BenchmarkAgent, string> = {
  coding: "Coding agents",
  "product-desk": "Product desk",
  "governance-review": "Governance desk",
  connector: "Connector (dry run)",
  "program-audit": "Program audit",
  "program-red-team": "Program red team",
  "ask-ai": "Ask AI",
}
export const agentLabel = (agent: string) => BENCHMARK_AGENT_LABELS[agent as BenchmarkAgent] ?? agent

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  finished: "Finished",
  stopped_at_cap: "Stopped at its cap",
  stopped: "Stopped",
  failed: "Failed",
}
export const runIsGoing = (status: string) => status === "queued" || status === "running"

export type Scoreboard = {
  tasks: number
  passed: number
  failed: number
  infrastructureFailures: number
  harnessFailures: number
  notRun: number
  waiting: number
  scored: number
  passRate: number | null
  passRateNote: string | null
  costUsd: number | null
  costNote: string | null
  medianDurationMs: number | null
  durationNote: string | null
}
export type BenchmarkRun = {
  id: string
  agent: string
  label: string | null
  taskSet: string
  taskSetVersion: number
  status: string
  stopReason: string | null
  capUsd: number
  chargedUsd: number
  model: string | null
  workspaceRevisions: Record<string, string>
  sourceCommit: string | null
  sourceCommitNote: string | null
  startedBy: string | null
  createdAt: string | null
  finishedAt: string | null
  scoreboard: Scoreboard
}
export type BenchmarkAgentInfo = {
  agent: string
  taskSet: string
  version: number
  title: string
  description: string
  tasks: number
  model: string | null
  maxTaskUsd: number | null
  ready: boolean
  whyNot: string | null
  needs: string[]
}
export type BenchmarkCheck = { name: string; status: string; detail: string | null }
export type BenchmarkTask = {
  taskId: string
  status: string
  failureClass: string | null
  failedCheck: string | null
  detail: string | null
  checks: BenchmarkCheck[]
  capUsd: number | null
  costUsd: number | null
  costParts: Record<string, number | null> | null
  costNote: string | null
  durationMs: number | null
}
export type BenchmarkList = { runs: BenchmarkRun[]; agents: BenchmarkAgentInfo[]; maxCapUsd: number | null }
export type BenchmarkDetail = { run: BenchmarkRun; tasks: BenchmarkTask[] }
export type ComparedTask = { taskId: string; baseline: string; candidate: string; change: string; why: string | null; failedCheck: string | null; costDeltaUsd: number | null; durationDeltaMs: number | null }
export type BenchmarkComparison = {
  baseline: string
  candidate: string
  problems: string[]
  notes: string[]
  passRate: { baseline: number | null; candidate: number | null; delta: number | null }
  costUsd: { baseline: number | null; candidate: number | null; delta: number | null }
  tasks: ComparedTask[]
  regressions: string[]
  fixed: string[]
  gate: { verdict: string; reasons: string[] }
}

type Row = Record<string, unknown>
const row = (v: unknown): Row | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null)
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.map(row).filter((r): r is Row => r !== null) : [])
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v : null)
const figure = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
const count = (v: unknown) => figure(v) ?? 0
const words = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

function scoreboardFrom(v: unknown): Scoreboard {
  const s = row(v) ?? {}
  return {
    tasks: count(s.tasks),
    passed: count(s.passed),
    failed: count(s.failed),
    infrastructureFailures: count(s.infrastructure_failures),
    harnessFailures: count(s.harness_failures),
    notRun: count(s.not_run),
    waiting: count(s.waiting),
    scored: count(s.scored),
    passRate: figure(s.pass_rate),
    passRateNote: text(s.pass_rate_note),
    costUsd: figure(s.cost_usd),
    costNote: text(s.cost_note),
    medianDurationMs: figure(s.median_duration_ms),
    durationNote: text(s.duration_note),
  }
}

function runFrom(v: unknown, scoreboard: unknown): BenchmarkRun | null {
  const r = row(v)
  const id = text(r?.id)
  if (!r || !id) return null
  const revisions = row(r.workspace_revisions) ?? {}
  return {
    id,
    agent: text(r.agent) ?? "unknown",
    label: text(r.label),
    taskSet: text(r.task_set) ?? "",
    taskSetVersion: count(r.task_set_version),
    status: text(r.status) ?? "unknown",
    stopReason: text(r.stop_reason),
    capUsd: count(r.cap_usd),
    chargedUsd: count(r.charged_usd),
    model: text(r.model),
    workspaceRevisions: Object.fromEntries(Object.entries(revisions).filter((e): e is [string, string] => typeof e[1] === "string")),
    sourceCommit: text(r.source_commit),
    sourceCommitNote: text(r.source_commit_note),
    startedBy: text(r.started_by),
    createdAt: text(r.created_at),
    finishedAt: text(r.finished_at),
    scoreboard: scoreboardFrom(scoreboard),
  }
}

/** list_benchmark_runs, as the page's list shows it; null when Mynt's answer isn't one. */
export function benchmarkListFrom(v: unknown): BenchmarkList | null {
  const body = row(v)
  if (!body || !Array.isArray(body.runs)) return null
  return {
    runs: rows(body.runs)
      .map((r) => runFrom(r, r.scoreboard))
      .filter((r): r is BenchmarkRun => r !== null),
    agents: rows(body.agents).map((a) => ({
      agent: text(a.agent) ?? "unknown",
      taskSet: text(a.task_set) ?? "",
      version: count(a.version),
      title: text(a.title) ?? "",
      description: text(a.description) ?? "",
      tasks: count(a.tasks),
      model: text(a.model),
      maxTaskUsd: figure(a.max_task_usd),
      ready: a.ready === true,
      whyNot: text(a.why_not),
      needs: words(a.needs),
    })),
    maxCapUsd: figure(row(body.cap)?.max_usd_per_run),
  }
}

/** get_benchmark_run, as a run's page shows it. */
export function benchmarkDetailFrom(v: unknown): BenchmarkDetail | null {
  const body = row(v)
  const run = runFrom(body?.run, body?.scoreboard)
  if (!body || !run) return null
  return {
    run,
    tasks: rows(body.tasks).map((t) => ({
      taskId: text(t.task_id) ?? "",
      status: text(t.status) ?? "unknown",
      failureClass: text(t.failure_class),
      failedCheck: text(t.failed_check),
      detail: text(t.detail),
      checks: rows(t.checks).map((c) => ({ name: text(c.name) ?? "", status: text(c.status) ?? "", detail: text(c.detail) })),
      capUsd: figure(t.cap_usd),
      costUsd: figure(t.cost_usd),
      costParts: row(t.cost_parts) ? Object.fromEntries(Object.entries(row(t.cost_parts)!).map(([k, x]) => [k, figure(x)])) : null,
      costNote: text(t.cost_note),
      durationMs: figure(t.duration_ms),
    })),
  }
}

/** compare_benchmark_runs, as the Compare tab shows it. */
export function comparisonFrom(v: unknown): BenchmarkComparison | null {
  const body = row(v)
  const c = row(body?.comparison)
  const gate = row(body?.gate)
  if (!c || !gate) return null
  const pair = (x: unknown) => ({ baseline: figure(row(x)?.baseline), candidate: figure(row(x)?.candidate), delta: figure(row(x)?.delta) })
  return {
    baseline: text(c.baseline) ?? "",
    candidate: text(c.candidate) ?? "",
    problems: words(c.problems),
    notes: words(c.notes),
    passRate: pair(c.pass_rate),
    costUsd: pair(c.cost_usd),
    tasks: rows(c.tasks).map((t) => ({
      taskId: text(t.task_id) ?? "",
      baseline: text(t.baseline) ?? "",
      candidate: text(t.candidate) ?? "",
      change: text(t.change) ?? "",
      why: text(t.why),
      failedCheck: text(t.failed_check),
      costDeltaUsd: figure(t.cost_delta_usd),
      durationDeltaMs: figure(t.duration_delta_ms),
    })),
    regressions: words(c.regressions),
    fixed: words(c.fixed),
    gate: { verdict: text(gate.verdict) ?? "inconclusive", reasons: words(gate.reasons) },
  }
}

// ---- in words ----

export const NOT_MEASURED = "Not measured"
/** A figure, or "Not measured" with why. Never 0 for something nothing measured. */
export const notMeasured = (why: string | null) => (why ? (why.startsWith(NOT_MEASURED) ? why : `${NOT_MEASURED}: ${why}`) : NOT_MEASURED)
export const usdWords = (v: number | null, why: string | null = null) => (v === null ? notMeasured(why) : `US$${v.toFixed(2)}`)
export const rateWords = (v: number | null, why: string | null = null) => (v === null ? notMeasured(why) : `${Math.round(v * 1000) / 10}%`)
export function durationWords(ms: number | null, why: string | null = null) {
  if (ms === null) return notMeasured(why)
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}
const signed = (n: number, digits: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}`
export const usdDeltaWords = (v: number | null) => (v === null ? NOT_MEASURED : `${signed(v, 2).replace(/^([+−]?)/, "$1US$")}`)
export const pointsDeltaWords = (v: number | null) => (v === null ? NOT_MEASURED : `${signed(v * 100, 1)} points`)
export const durationDeltaWords = (ms: number | null) => (ms === null ? NOT_MEASURED : `${signed(ms / 1000, 0)} s`)

export const TASK_STATUS_LABELS: Record<string, string> = { pending: "Waiting", running: "Running", passed: "Passed", failed: "Failed", not_run: "Not run" }
export const FAILURE_CLASS_LABELS: Record<string, string> = {
  agent: "The agent (counts against it)",
  infrastructure: "Infrastructure (not counted)",
  harness: "The benchmark itself (not counted)",
}
export const CHANGE_LABELS: Record<string, string> = { regressed: "Regressed", fixed: "Fixed", same: "No change", not_comparable: "Not compared" }
export const GATE_LABELS: Record<string, string> = { pass: "Pass", fail: "Fail", inconclusive: "Inconclusive" }
/** Passed out of scored, in words: "3 of 5 scored", or why nothing is scored yet. */
export const scoredWords = (s: Scoreboard) => (s.scored ? `${s.passed} of ${s.scored} scored` : notMeasured(s.passRateNote))
export const whenWords = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "Not started")
