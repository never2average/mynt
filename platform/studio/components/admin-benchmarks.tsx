"use client"

// Platform admin → Agent benchmarks (/platform/benchmarks; lib/benchmarks.ts; GET and POST /api/admin/benchmarks and
// /api/admin/benchmarks/<id>): how well Mynt's hosted agents do real work, scored by Mynt's own verification.
// The section has three read views, each ONE table under one toolbar: Runs (every run with its scoreboard), Task sets
// (each agent's set, what a run needs, whether one could start now, and what the set could cost against the cap) and
// Records (the benchmarks' own account, apps, stand-in firm and draft products, which no other list in Studio shows).
// Start run is a labelled button opening a sheet: a run spends money, so the sheet asks for its cap, lets the admin
// pick which tasks to run, and says what the cap covers of them before anything starts. A run's page (/platform/benchmarks/<id>) is a
// metadata card, then Tasks, Failures, Cost and Compare, each a table; Stop run is a labelled button with a sheet.
// A figure Mynt didn't measure reads "Not measured" with why, never 0.
import { useCallback, useMemo, useState } from "react"
import { CircleStop, Play } from "lucide-react"

import { AdminDetail, AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { Tab, TabList } from "@/components/ui/tabs"
import { csvOf } from "@/lib/admin"
import {
  agentLabel,
  capCoverWords,
  ceilingWords,
  CHANGE_LABELS,
  durationDeltaWords,
  durationWords,
  FAILURE_CLASS_LABELS,
  GATE_LABELS,
  notMeasured,
  pointsDeltaWords,
  rateWords,
  RUN_STATUS_LABELS,
  runIsGoing,
  scoredWords,
  TASK_STATUS_LABELS,
  usdDeltaWords,
  usdWords,
  whenWords,
  type BenchmarkAgentInfo,
  type BenchmarkComparison,
  type BenchmarkDetail,
  type BenchmarkList,
  type BenchmarkRun,
  type BenchmarkTask,
} from "@/lib/benchmarks"

const ROUTE = "/api/admin/benchmarks"
export const RUNS_HEAD = ["Run", "Agent", "Status", "Passed", "Pass rate", "Infrastructure failures", "Cost", "Model", "Started", "Action"] as const
export const TASK_SETS_HEAD = ["Agent", "Task set", "Tasks", "Ceiling against the cap", "Can a run start now?", "What a run needs"] as const
export const RECORDS_HEAD = ["Kind", "Name", "Status", "Made", "Id"] as const
export const NO_RECORDS_NOTE = "No benchmark run has made any record yet. A coding run makes an account nobody can sign in as and one app per task; a product-desk run makes a stand-in firm with one draft product per task. They are listed here and nowhere else."
export const NO_RUNS_NOTE =
  "No benchmark run has been made yet, so nothing has been measured. A run is started here by a Mynt admin, with a cap in US dollars: it puts one agent's task set through the same sandboxes and the same checks by Mynt as real work, and spends money on the model and on sandboxes. What each agent's run needs, and whether one could start now, is on the Task sets tab."
export const LIST_TABS = [
  { id: "runs", label: "Runs" },
  { id: "task-sets", label: "Task sets" },
  { id: "records", label: "Records" },
] as const
type ListTab = (typeof LIST_TABS)[number]["id"]
export const RUN_TABS = [
  { id: "tasks", label: "Tasks" },
  { id: "failures", label: "Failures" },
  { id: "cost", label: "Cost" },
  { id: "compare", label: "Compare" },
] as const
export type RunTab = (typeof RUN_TABS)[number]["id"]

const runName = (r: BenchmarkRun) => r.label ?? `${agentLabel(r.agent)} run`
const statusWords = (status: string) => RUN_STATUS_LABELS[status] ?? status
const wrap = (text: string | null) => <span className="block min-w-56 font-normal whitespace-normal">{text ?? "None"}</span>

/** Start run: which agent, the cap (required), what it's for. It says plainly that the run spends money. */
export function StartRunSheet({ open, agents, maxCapUsd, onClose, onDone, fetcher }: { open: boolean; agents: BenchmarkAgentInfo[]; maxCapUsd: number | null; onClose: () => void; onDone: (id: string | null) => void; fetcher?: typeof fetch }) {
  const [agent, setAgent] = useState(agents.find((a) => a.ready)?.agent ?? agents[0]?.agent ?? "")
  const [cap, setCap] = useState("")
  const [label, setLabel] = useState("")
  const [restored, setRestored] = useState(false)
  // The tasks left out, per agent: every task is in until the admin unticks it.
  const [left, setLeft] = useState<Record<string, string[]>>({})
  const action = useAdminAction(fetcher)
  const chosen = agents.find((a) => a.agent === agent) ?? null
  const capUsd = Number(cap)
  const out = left[agent] ?? []
  const picked = (chosen?.taskList ?? []).filter((t) => !out.includes(t.id)).map((t) => t.id)
  const whole = chosen !== null && picked.length === chosen.taskList.length
  const typed = cap.trim() !== "" && Number.isFinite(capUsd) && capUsd > 0
  const ok = chosen !== null && typed && picked.length > 0
  const toggle = (id: string) => setLeft((l) => ({ ...l, [agent]: out.includes(id) ? out.filter((x) => x !== id) : [...out, id] }))
  return (
    <AdminSheet
      open={open}
      title="Start run"
      description="Runs one agent's benchmark tasks for real, one at a time, through the same sandboxes and the same checks by Mynt as production work, in a benchmark context of its own. This spends money on the model and on sandboxes, up to the cap you give. The run stops, and says so, when the cap is reached. It's recorded in the audit trail."
      onClose={onClose}
      error={action.error}
      result={action.result}
      id="start-benchmark-run"
    >
      {action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-start-run-form
          onSubmit={(e) => {
            e.preventDefault()
            if (!ok) return
            void action
              .run(ROUTE, { agent, cap_usd: capUsd, ...(label.trim() ? { label: label.trim() } : {}), ...(whole ? {} : { task_ids: picked }), ...(restored ? { host_restored: true } : {}) })
              .then((res) => res?.ok === true && onDone(typeof res.id === "string" ? res.id : null))
          }}
        >
          <Field label="Agent" hint={chosen ? `${chosen.tasks} tasks in ${chosen.taskSet}. ${chosen.description}` : undefined}>
            <select className={fieldClass} value={agent} onChange={(e) => setAgent(e.target.value)} data-start-run-agent>
              {agents.map((a) => (
                <option key={a.agent} value={a.agent}>
                  {agentLabel(a.agent)}
                </option>
              ))}
            </select>
          </Field>
          {chosen && !chosen.ready && (
            <p className="text-sm text-destructive" data-start-run-not-ready>
              A run can&apos;t start now: {chosen.whyNot ?? "Mynt didn't say why."}
            </p>
          )}
          {chosen && (
            <p className="text-sm" data-start-run-ceiling>
              {chosen.budget.note ?? ceilingWords(chosen.budget, chosen.tasks)}
            </p>
          )}
          {chosen && chosen.taskList.length > 0 && (
            <fieldset className="flex flex-col gap-1" data-start-run-tasks>
              <legend className="text-sm font-medium">
                Tasks to run ({picked.length} of {chosen.taskList.length})
              </legend>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setLeft((l) => ({ ...l, [agent]: [] }))} data-start-run-all>
                  Pick all
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setLeft((l) => ({ ...l, [agent]: chosen.taskList.map((t) => t.id) }))} data-start-run-none>
                  Pick none
                </Button>
              </div>
              <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                {chosen.taskList.map((t) => (
                  <li key={t.id}>
                    <label className="flex items-start gap-2 text-sm">
                      <input type="checkbox" className="mt-1" checked={!out.includes(t.id)} onChange={() => toggle(t.id)} data-start-run-task={t.id} />
                      <span>
                        <code className="text-xs">{t.id}</code>
                        {t.label && t.label !== t.id ? <span className="block text-muted-foreground">{t.label}</span> : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          )}
          <Field
            label="Cap in US dollars"
            hint={`Required: the most this run may spend. ${maxCapUsd === null ? "" : `At most US$${maxCapUsd} (the BENCHMARK_CAP_USD operational setting). `}${chosen?.maxTaskUsd ? `One task may spend up to US$${chosen.maxTaskUsd}, so the whole set could cost up to US$${chosen.maxTaskUsd * chosen.tasks}; what it really costs hasn't been measured until a run is made.` : ""}`}
          >
            <input className={fieldClass} value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="For example 20" autoComplete="off" required data-start-run-cap />
          </Field>
          {chosen && (
            <p className={picked.length === 0 ? "text-sm text-destructive" : "text-sm"} data-start-run-cover>
              {picked.length === 0 ? "Pick at least one task." : capCoverWords(chosen.budget, picked.length, typed ? capUsd : null)}
            </p>
          )}
          <Field label="Label" hint="What this run is for, so it can be told apart later: for example, Baseline before changing the instructions.">
            <input className={fieldClass} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} autoComplete="off" data-start-run-label />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={restored} onChange={(e) => setRestored(e.target.checked)} className="mt-1" data-start-run-restored />
            <span>The sandbox host&apos;s allowance has been restored. Tick this only if Mynt refused the run because the allowance was used up, and billing has been added since.</span>
          </label>
          <div>
            <Button type="submit" disabled={action.busy || !ok} data-start-run-submit>
              {action.busy ? "Starting…" : "Start run"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

/** Stop run: the reason, and what stopping does. */
export function StopRunSheet({ run, onClose, onDone, fetcher }: { run: BenchmarkRun | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [reason, setReason] = useState("")
  const action = useAdminAction(fetcher)
  return (
    <AdminSheet
      open={run !== null}
      title="Stop run"
      description="Stops the task in flight and its sandboxes, and ends the run. The task in flight isn't held against the agent, and the tasks left are recorded as not run. What the run has already spent stays spent. It's recorded in the audit trail."
      onClose={onClose}
      error={action.error}
      result={action.result}
      id="stop-benchmark-run"
    >
      {run && action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-stop-run-form
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim().length >= 3) void action.run(`${ROUTE}/${run.id}`, { action: "stop", reason: reason.trim() }).then((res) => res?.ok === true && onDone())
          }}
        >
          <Field label="Reason" hint="Kept on the run and in the audit trail.">
            <input className={fieldClass} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required data-stop-run-reason />
          </Field>
          <div>
            <Button type="submit" variant="destructive" disabled={action.busy || reason.trim().length < 3} data-stop-run-submit>
              {action.busy ? "Stopping…" : "Stop run"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

/** The section's two read views, each one table, with Start run. */
export function BenchmarksView({ list, onOpen, onChanged = () => undefined, fetcher, initialTab = "runs" }: { list: BenchmarkList; onOpen: (id: string) => void; onChanged?: () => void; fetcher?: typeof fetch; initialTab?: ListTab }) {
  const [tab, setTab] = useState<ListTab>(initialTab)
  const [query, setQuery] = useState("")
  const [starting, setStarting] = useState(false)
  const runs = useMemo(() => list.runs.filter((r) => matches(query, r.label, agentLabel(r.agent), r.agent, statusWords(r.status), r.model, r.id)), [list.runs, query])
  const sets = useMemo(() => list.agents.filter((a) => matches(query, agentLabel(a.agent), a.agent, a.title, a.taskSet, a.whyNot, ...a.needs)), [list.agents, query])
  const pagedRuns = usePaged(runs)
  const pagedSets = usePaged(sets)
  const records = useMemo(() => list.records.filter((r) => matches(query, r.kind, r.name, r.status, r.id)), [list.records, query])
  const pagedRecords = usePaged(records)
  const startRun = (
    <Button onClick={() => setStarting(true)} data-start-run>
      <Play />
      Start run
    </Button>
  )
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-benchmarks>
      <TabList aria-label="Agent benchmarks">
        {LIST_TABS.map((t) => (
          <Tab key={t.id} selected={tab === t.id} data-benchmarks-tab={t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      {tab === "runs" ? (
        <AdminList
          id="benchmark-runs"
          search={query}
          onSearch={setQuery}
          searchLabel="Search runs by label, agent, status or model"
          importable={false}
          onExport={() =>
            downloadCsv(
              "benchmark-runs.csv",
              csvOf(
                ["Run id", "Label", "Agent", "Status", "Passed", "Scored", "Pass rate", "Infrastructure failures", "Not run", "Cost (US$)", "Cap (US$)", "Model", "Started"],
                runs.map((r) => [r.id, r.label ?? "", r.agent, r.status, String(r.scoreboard.passed), String(r.scoreboard.scored), r.scoreboard.passRate === null ? "Not measured" : String(r.scoreboard.passRate), String(r.scoreboard.infrastructureFailures), String(r.scoreboard.notRun), r.scoreboard.costUsd === null ? "Not measured" : String(r.scoreboard.costUsd), String(r.capUsd), r.model ?? "", r.createdAt ?? ""]),
              ),
            )
          }
          exportDisabled={!runs.length}
          cta={startRun}
          note={list.runs.length ? null : NO_RUNS_NOTE}
          page={pagedRuns.page}
          pages={pagedRuns.pages}
          total={runs.length}
          onPage={pagedRuns.setPage}
        >
          <AdminTable
            head={RUNS_HEAD}
            empty={list.runs.length ? "No run matches the search." : "No benchmark run has been made yet."}
            rowKeys={pagedRuns.shown.map((r) => r.id)}
            onRow={(i) => onOpen(pagedRuns.shown[i].id)}
            rows={pagedRuns.shown.map((r) => [
              <span key="n" className="font-medium">
                {runName(r)}
              </span>,
              agentLabel(r.agent),
              <span key="s" data-run-status={r.status} title={r.stopReason ?? undefined}>
                {statusWords(r.status)}
              </span>,
              <span key="p" data-run-passed>
                {scoredWords(r.scoreboard)}
              </span>,
              <span key="r" data-run-pass-rate>
                {rateWords(r.scoreboard.passRate, r.scoreboard.passRateNote)}
              </span>,
              String(r.scoreboard.infrastructureFailures),
              <span key="c" data-run-cost>
                {usdWords(r.scoreboard.costUsd, r.scoreboard.costNote)} of a US${r.capUsd} cap
              </span>,
              r.model ?? "Not recorded",
              whenWords(r.createdAt),
              <Button key="o" variant="outline" size="sm" onClick={() => onOpen(r.id)} data-open-run={r.id}>
                Open
              </Button>,
            ])}
          />
        </AdminList>
      ) : tab === "records" ? (
        <AdminList
          id="benchmark-records"
          search={query}
          onSearch={setQuery}
          searchLabel="Search the benchmarks' own records by kind or name"
          importable={false}
          cta={startRun}
          note={list.records.length ? list.recordsNote : NO_RECORDS_NOTE}
          page={pagedRecords.page}
          pages={pagedRecords.pages}
          total={records.length}
          onPage={pagedRecords.setPage}
        >
          <AdminTable
            head={RECORDS_HEAD}
            empty={list.records.length ? "No record matches the search." : "No benchmark run has made any record yet."}
            rowKeys={pagedRecords.shown.map((r) => `${r.kind}:${r.id}`)}
            rows={pagedRecords.shown.map((r) => [
              r.kind,
              <span key="n" className="font-medium" data-benchmark-record={r.kind}>
                {r.name}
              </span>,
              r.status ?? "Not applicable",
              whenWords(r.createdAt),
              <code key="i" className="text-xs">
                {r.id}
              </code>,
            ])}
          />
        </AdminList>
      ) : (
        <AdminList id="benchmark-task-sets" search={query} onSearch={setQuery} searchLabel="Search task sets by agent or what a run needs" importable={false} cta={startRun} page={pagedSets.page} pages={pagedSets.pages} total={sets.length} onPage={pagedSets.setPage}>
          <AdminTable
            head={TASK_SETS_HEAD}
            empty="This Mynt has no benchmark task sets."
            rowKeys={pagedSets.shown.map((a) => a.agent)}
            rows={pagedSets.shown.map((a) => [
              <span key="a" className="font-medium">
                {agentLabel(a.agent)}
              </span>,
              <span key="t" className="block min-w-40 font-normal whitespace-normal">
                {a.title}
                <code className="block text-xs text-muted-foreground">{a.taskSet}</code>
              </span>,
              String(a.tasks),
              <span key="c" data-agent-ceiling={a.budget.fitsWholeSet ? "fits" : a.budget.tasksCoveredInFull > 0 ? "part" : "none"} className="block min-w-56 font-normal whitespace-normal" title={a.budget.note ?? undefined}>
                {ceilingWords(a.budget, a.tasks)}
              </span>,
              <span key="r" data-agent-ready={a.ready ? "yes" : "no"} className="block min-w-56 font-normal whitespace-normal">
                {a.ready ? "Yes" : `No. ${a.whyNot ?? "Mynt didn't say why."}`}
              </span>,
              <ul key="n" className="min-w-72 list-disc pl-4 font-normal whitespace-normal">
                {a.needs.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>,
            ])}
          />
        </AdminList>
      )}
      {starting && (
        <StartRunSheet
          open
          agents={list.agents}
          maxCapUsd={list.maxCapUsd}
          fetcher={fetcher}
          onClose={() => {
            setStarting(false)
            onChanged()
          }}
          onDone={() => onChanged()}
        />
      )}
    </div>
  )
}

const TASKS_HEAD = ["Task", "Outcome", "Failed check", "Cost", "Duration", "Mynt's checks"] as const
const FAILURES_HEAD = ["Task", "Failed check", "Whose failure", "What Mynt recorded"] as const
const COST_HEAD = ["Task", "Cost", "Agent's model", "Sandboxes", "Mynt's audit", "Task budget"] as const
const COMPARE_HEAD = ["Task", "Baseline", "This run", "Change", "Cost change", "Time change"] as const
const outcomeWords = (t: BenchmarkTask) => TASK_STATUS_LABELS[t.status] ?? t.status
const part = (t: BenchmarkTask, key: string) => (t.costParts && key in t.costParts ? usdWords(t.costParts[key], "this part wasn't recorded") : notMeasured(t.costUsd === null ? t.costNote : "the service records one figure for this agent"))

/** The Compare tab: this run against another of the same agent, with the regression gate's verdict. */
export function CompareTable({ comparison }: { comparison: BenchmarkComparison }) {
  return (
    <div data-benchmark-compare>
      <div className="flex flex-col gap-1 border-b p-3 text-sm" data-gate={comparison.gate.verdict}>
        <p className="font-medium">
          Regression gate: {GATE_LABELS[comparison.gate.verdict] ?? comparison.gate.verdict}. Pass rate {rateWords(comparison.passRate.baseline)} to {rateWords(comparison.passRate.candidate)} ({pointsDeltaWords(comparison.passRate.delta)}); cost{" "}
          {usdWords(comparison.costUsd.baseline)} to {usdWords(comparison.costUsd.candidate)} ({usdDeltaWords(comparison.costUsd.delta)}).
        </p>
        {[...comparison.gate.reasons, ...comparison.notes].map((r) => (
          <p key={r} className="text-muted-foreground">
            {r}
          </p>
        ))}
        {comparison.regressions.length > 0 && <p data-regressions>Regressed: {comparison.regressions.join(", ")}</p>}
      </div>
      <AdminTable
        head={COMPARE_HEAD}
        empty="The two runs have no task in common."
        rowKeys={comparison.tasks.map((t) => t.taskId)}
        rows={comparison.tasks.map((t) => [
          <code key="t" className="text-xs">
            {t.taskId}
          </code>,
          t.baseline,
          t.candidate,
          <span key="c" data-change={t.change} className="block min-w-40 font-normal whitespace-normal">
            {CHANGE_LABELS[t.change] ?? t.change}
            {t.change === "regressed" && t.failedCheck ? `: ${t.failedCheck}` : ""}
            {t.why ? <span className="block text-xs text-muted-foreground">{t.why}</span> : null}
          </span>,
          usdDeltaWords(t.costDeltaUsd),
          durationDeltaWords(t.durationDeltaMs),
        ])}
      />
    </div>
  )
}

/** One run: its metadata card, then Tasks, Failures, Cost and Compare, each a table. */
export function BenchmarkRunView({
  detail,
  others,
  comparison,
  baseline,
  onBaseline,
  onBack,
  onChanged = () => undefined,
  fetcher,
  initialTab = "tasks",
}: {
  detail: BenchmarkDetail
  others: BenchmarkRun[] // other runs of the same agent, to compare against
  comparison: BenchmarkComparison | null
  baseline: string | null
  onBaseline: (id: string | null) => void
  onBack: () => void
  onChanged?: () => void
  fetcher?: typeof fetch
  initialTab?: RunTab
}) {
  const [tab, setTab] = useState<RunTab>(initialTab)
  const [stopping, setStopping] = useState(false)
  const { run, tasks } = detail
  const s = run.scoreboard
  const failures = tasks.filter((t) => t.status === "failed")
  const revisions = Object.entries(run.workspaceRevisions)
  return (
    <>
      <AdminDetail
        backLabel="Back to Agent benchmarks"
        onBack={onBack}
        title={runName(run)}
        subtitle={run.stopReason ? `${statusWords(run.status)}: ${run.stopReason}` : statusWords(run.status)}
        fields={[
          ["Agent", agentLabel(run.agent)],
          ["Task set", `${run.taskSet} (${s.tasks} tasks)`],
          ["Passed", scoredWords(s)],
          ["Pass rate", rateWords(s.passRate, s.passRateNote)],
          ["Not counted", `${s.infrastructureFailures} infrastructure, ${s.harnessFailures} benchmark, ${s.notRun} not run`],
          ["Cost", usdWords(s.costUsd, s.costNote)],
          ["Cap", `US$${run.capUsd} (US$${run.chargedUsd.toFixed(2)} counted)`],
          ["Median task time", durationWords(s.medianDurationMs, s.durationNote)],
          ["Model", run.model ?? "Not recorded"],
          ["Workspace folders", revisions.length ? <span title={revisions.map(([w, h]) => `${w}: ${h}`).join("\n")}>{revisions.map(([w, h]) => `${w} ${h.slice(0, 10)}`).join(", ")}</span> : "Not recorded"],
          ["Server commit", run.sourceCommit ? run.sourceCommit.slice(0, 10) : (run.sourceCommitNote ?? "Not recorded")],
          ["Started", `${whenWords(run.createdAt)}${run.startedBy ? ` by ${run.startedBy}` : ""}`],
        ]}
        actions={
          runIsGoing(run.status) ? (
            <Button variant="outline" onClick={() => setStopping(true)} data-stop-run>
              <CircleStop />
              Stop run
            </Button>
          ) : null
        }
        tabs={[...RUN_TABS]}
        tab={tab}
        onTab={setTab}
      >
        {tab === "tasks" && (
          <AdminTable
            head={TASKS_HEAD}
            empty="This run has no tasks."
            rowKeys={tasks.map((t) => t.taskId)}
            rows={tasks.map((t) => [
              <code key="t" className="text-xs">
                {t.taskId}
              </code>,
              <span key="o" data-task-status={t.status}>
                {outcomeWords(t)}
                {t.status === "not_run" && t.detail ? <span className="block max-w-80 text-xs font-normal whitespace-normal text-muted-foreground">{t.detail}</span> : null}
              </span>,
              t.failedCheck ?? "None",
              t.status === "pending" || t.status === "running" || t.status === "not_run" ? "Not run yet" : usdWords(t.costUsd, t.costNote),
              t.status === "pending" || t.status === "running" || t.status === "not_run" ? "Not run yet" : durationWords(t.durationMs, "the job's start or end wasn't recorded"),
              wrap(t.checks.length ? t.checks.map((c) => `${c.name}: ${c.status.replace("_", " ")}`).join(", ") : null),
            ])}
          />
        )}
        {tab === "failures" && (
          <AdminTable
            head={FAILURES_HEAD}
            empty={s.scored + s.infrastructureFailures + s.harnessFailures ? "No task failed." : "No task has finished yet."}
            rowKeys={failures.map((t) => t.taskId)}
            rows={failures.map((t) => [
              <code key="t" className="text-xs">
                {t.taskId}
              </code>,
              t.failedCheck ?? "Not recorded",
              <span key="c" data-failure-class={t.failureClass ?? "unknown"}>
                {FAILURE_CLASS_LABELS[t.failureClass ?? ""] ?? "Not recorded"}
              </span>,
              wrap(t.detail),
            ])}
          />
        )}
        {tab === "cost" && (
          <AdminTable
            head={COST_HEAD}
            empty="This run has no tasks."
            rowKeys={tasks.map((t) => t.taskId)}
            rows={tasks.map((t) => {
              const ran = t.status === "passed" || t.status === "failed"
              return [
                <code key="t" className="text-xs">
                  {t.taskId}
                </code>,
                <span key="c" data-task-cost>
                  {ran ? usdWords(t.costUsd, t.costNote) : "Not run yet"}
                </span>,
                ran ? part(t, "agent_model") : "Not run yet",
                ran ? part(t, "sandboxes") : "Not run yet",
                ran ? part(t, "mynt_audit") : "Not run yet",
                t.capUsd === null ? "Not set: the task never started" : `US$${t.capUsd}`,
              ]
            })}
          />
        )}
        {tab === "compare" && (
          <div data-compare-tab>
            <div className="flex flex-wrap items-center gap-2 border-b p-3 text-sm">
              <label htmlFor="benchmark-baseline">Compare against</label>
              <select id="benchmark-baseline" className={fieldClass} value={baseline ?? ""} onChange={(e) => onBaseline(e.target.value || null)} data-baseline-select>
                <option value="">Choose a baseline run</option>
                {others.map((o) => (
                  <option key={o.id} value={o.id}>
                    {runName(o)} · {whenWords(o.createdAt)} · {rateWords(o.scoreboard.passRate)}
                  </option>
                ))}
              </select>
            </div>
            {comparison ? (
              <CompareTable comparison={comparison} />
            ) : (
              <AdminTable head={COMPARE_HEAD} rows={[]} empty={others.length ? "Choose a baseline run to compare this one against." : `There is no other ${agentLabel(run.agent)} run to compare against yet. Two runs are needed: one before a change, one after.`} />
            )}
          </div>
        )}
      </AdminDetail>
      {stopping && (
        <StopRunSheet
          run={run}
          fetcher={fetcher}
          onClose={() => {
            setStopping(false)
            onChanged()
          }}
          onDone={() => onChanged()}
        />
      )}
    </>
  )
}

function RunPage({ id, onBack }: { id: string; onBack: () => void }) {
  const [baseline, setBaseline] = useState<string | null>(null)
  // The route answers with the run already read into the page's shape (lib/benchmarks.ts).
  const pick = useCallback((b: Record<string, unknown>) => (b.detail ? { detail: b.detail as BenchmarkDetail, comparison: (b.comparison as BenchmarkComparison | null) ?? null } : undefined), [])
  const { state, reload } = useAdminData(`${ROUTE}/${id}${baseline ? `?baseline=${baseline}` : ""}`, pick)
  const pickList = useCallback((b: Record<string, unknown>) => (b.list as BenchmarkList | undefined) ?? undefined, [])
  const list = useAdminData(ROUTE, pickList)
  if (state.kind !== "ready") return <AdminNotReady state={state} what="this benchmark run" />
  const { detail, comparison } = state.data
  const others = list.state.kind === "ready" ? list.state.data.runs.filter((r) => r.agent === detail.run.agent && r.id !== detail.run.id) : []
  return <BenchmarkRunView detail={detail} others={others} comparison={baseline ? comparison : null} baseline={baseline} onBaseline={setBaseline} onBack={onBack} onChanged={reload} />
}

/** The section: the list, or one run when its id is in the address. */
export function BenchmarksTab({ id, onOpen, onBack }: { id: string | null; onOpen: (id: string) => void; onBack: () => void }) {
  const pick = useCallback((b: Record<string, unknown>) => (b.list as BenchmarkList | undefined) ?? undefined, [])
  const { state, reload } = useAdminData(id ? null : ROUTE, pick)
  if (id) return <RunPage id={id} onBack={onBack} />
  if (state.kind !== "ready") return <AdminNotReady state={state} what="agent benchmarks" />
  return <BenchmarksView list={state.data} onOpen={onOpen} onChanged={reload} />
}
