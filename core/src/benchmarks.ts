import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentMeter } from "./agent-meter.js";
import type { AgentRun } from "./agent-proxy.js";
import { BdService, type BdConfig } from "./bd.js";
import { compareRuns, GATE_DEFAULTS, regressionGate, scoreboard, type FailureClass, type RunSummary, type TaskResult } from "./benchmark-compare.js";
import {
  BENCHMARK_AGENTS,
  sourceCommit,
  taskSetFor,
  taskSets,
  workspaceRevision,
  type BenchmarkAgent,
  type BenchmarkTask,
  type CodingTask,
  type ConnectorTask,
  type DeskTask,
  type ReviewTask,
  type TaskSet,
} from "./benchmark-tasks.js";
import { BuildService, type Build, type BuildConfig } from "./builds.js";
import type { FinancialProduct } from "./catalog.js";
import type { Db } from "./db.js";
import { DeskService, type DeskConfig } from "./desk.js";
import type { DeskOutcome } from "./desk-runner.js";
import type { Fetcher } from "./evidence.js";
import type { RepoAccess } from "./github.js";
import { operationalSetting } from "./platform-settings.js";
import { runProductTests } from "./product-tests.js";
import { checklist, ReviewService, type ItemResult, type ReviewConfig } from "./review.js";
import type { SandboxHost } from "./sandbox-host.js";
import type { Store, User } from "./store.js";
import { isQuotaExhausted, isTransient, QUOTA_MESSAGE } from "./transient.js";
import { serialLoop } from "./worker.js";

// Agent benchmarks: how well Mynt's hosted agents do real work, measured the way production measures it.
//
// A run takes one agent's task set (benchmark-tasks.ts) and puts each task through the service that agent runs in
// in production: the same class, the same queue and worker tick, the same budgets, sandboxes, agent launch and, above
// all, the same verification by Mynt outside the agent's sandbox. The harness never looks at what an agent says about
// its own work: a task's outcome is read from the record Mynt's own checks left (a build's verification report, the
// desk's own run of the model, the governance desk's recommendation over re-checked quotes, the connector's pipeline).
//
// The benchmark context is separate from everything real, by construction:
//   - each service is a second instance over `benchDb`, which sends every table the service owns to a `bench_` twin
//     (bench_build_runs, bench_desk_jobs, bench_review_cases, bench_bd_*, …). So a benchmark's jobs are never in the
//     real queues, lists, statistics or monthly budgets, and no real job is ever in a benchmark's;
//   - whatever must exist in the shared records (an app to build, a draft product to model) belongs to a benchmark
//     account of its own, which nobody can sign in as;
//   - the connector's instance is made here with no way to reach any channel (see `connector` below), over a pipeline
//     of its own holding only invented people.
// A run has a hard cap (the caller's, never more than BENCHMARK_CAP_USD): each task may spend at most what's left of
// it, and when too little is left the run stops and says so.

const T = "financial_products";
type Row = Record<string, unknown>;

// The tables each agent service owns: a benchmark instance gets a `bench_` twin of each (and of its indexes, whose
// names start with the table's). Everything else (users, apps, products, the audit log) is the shared record.
const OWNED = ["build_runs", "build_events", "build_activity", "repo_connections", "app_repositories", "managed_repository_names", "desk_jobs", "desk_reports", "desk_workspaces", "product_terms", "review_cases"];
const OWNED_NAME = new RegExp(`\\b(?:${OWNED.join("|")}|bd_[a-z]+)`, "g");
export const benchSql = (sql: string) => sql.replace(OWNED_NAME, (name) => `bench_${name}`);

/** `db`, with every agent-service table sent to its benchmark twin. */
export function benchDb(db: Db): Db {
  return {
    query: (sql, params) => db.query(benchSql(sql), params),
    exec: (sql) => db.exec(benchSql(sql)),
    close: async () => undefined, // the benchmark context never closes the server's database
    ...(db.transaction ? { transaction: (f) => db.transaction!((tx) => f({ query: (sql, params) => tx.query(benchSql(sql), params) })) } : {}),
  };
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS ${T}.benchmark_runs (
    id uuid PRIMARY KEY,
    agent text NOT NULL,
    task_set text NOT NULL,
    task_set_version integer NOT NULL,
    task_set_sha256 text NOT NULL,
    label text,
    -- queued, running, finished, stopped_at_cap (the cap was reached), stopped (an admin, or the host), failed
    status text NOT NULL,
    stop_reason text,
    cap_usd numeric NOT NULL,
    -- what the cap has counted so far: each task's measured cost, or its whole budget where nothing was measured
    charged_usd numeric NOT NULL DEFAULT 0,
    model text,
    -- a content hash of each agent workspace folder the set exercises, and the commit the server ran from
    workspace_revisions jsonb NOT NULL DEFAULT '{}',
    source_commit text,
    options jsonb NOT NULL DEFAULT '{}',
    started_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS benchmark_runs_created_idx ON ${T}.benchmark_runs (created_at DESC);
  -- One run at a time, held by the database: of two starts at the same moment, only one can be queued.
  CREATE UNIQUE INDEX IF NOT EXISTS benchmark_runs_one_active_idx ON ${T}.benchmark_runs ((true)) WHERE status IN ('queued', 'running');
  CREATE TABLE IF NOT EXISTS ${T}.benchmark_results (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ${T}.benchmark_runs(id),
    task_id text NOT NULL,
    position integer NOT NULL,
    -- pending, running, passed, failed, not_run
    status text NOT NULL,
    -- for a failed task: agent (counts against the agent), infrastructure (host capacity or outage) or harness
    failure_class text,
    failed_check text,
    detail text,
    checks jsonb,
    observed jsonb,
    job_id text,
    cap_usd numeric,
    cost_usd numeric,
    cost_parts jsonb,
    cost_note text,
    duration_ms bigint,
    started_at timestamptz,
    finished_at timestamptz,
    UNIQUE (run_id, task_id)
  );
`;

const ACTIVE = ["queued", "running"];
const MIN_TASK_USD = 0.5;
const IDENTITY = "benchmarks:identity";

/** Why a run can't start or a tool can't answer, in words for the admin. */
export class BenchmarkRefusal extends Error {}
// A task that can't run on this Mynt (something it needs isn't there): recorded as not run, never as a failure.
class NotRunnable extends Error {}

export interface BenchmarkDeps {
  sandboxes: SandboxHost | null;
  repos: RepoAccess | null;
  buildConfig: BuildConfig;
  deskConfig: DeskConfig;
  reviewConfig: ReviewConfig;
  bdConfig: BdConfig;
  fetcher?: Fetcher; // the governance desk's page fetcher (tests give a stand-in)
}

interface Check {
  name: string;
  status: "pass" | "fail" | "warn" | "not_reported";
  detail?: string;
}
interface Outcome {
  passed: boolean;
  failure_class: FailureClass | null;
  failed_check: string | null;
  detail: string | null;
  checks: Check[];
  observed: unknown;
  cost_usd: number | null;
  cost_parts: Record<string, number | null> | null;
  cost_note: string | null;
  started_at: string | null;
  finished_at: string | null;
  // The whole run must stop (the host can't run anything more), with this reason.
  stop_run?: string;
}
interface StartOptions {
  repository?: string;
}
interface Adapter {
  // What a real run of this agent needs, in words (shown before the first run).
  needs: string[];
  model(): string | null;
  // Why a run can't start here; null when it can.
  unavailable(opts: StartOptions): Promise<string | null>;
  // The most one task may spend, and what Mynt may spend on top of it (kept free in the run's cap).
  maxTaskUsd(): number;
  reserveUsd(): number;
  start(run: Row, task: BenchmarkTask, capUsd: number): Promise<string>;
  tick(): Promise<void>;
  poll(run: Row, jobId: string, task: BenchmarkTask): Promise<Outcome | null>;
  stop(jobId: string, reason: string): Promise<void>;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const cents = (n: number) => Math.round(n * 10000) / 10000;
const usd = (v: unknown) => (v === null || v === undefined ? null : cents(Number(v)));

// A failure that is the infrastructure's, not the agent's: the sandbox host out of allowance or capacity, a
// provider's outage, a sandbox that never came up, the runner unable to install or start, Mynt's own verification
// not reporting.
const INFRASTRUCTURE = /Sandbox (error|cancelled)|Verification sandbox (error|cancelled)|Couldn't start the agent|Couldn't install Claude Code|Verification didn't produce a report|Couldn't prepare the auditor's copy|Couldn't place the program|Couldn't create a Python environment|\b(no|insufficient|out of) capacity\b|service unavailable/i;
export function failureClassOf(error: string | null | undefined): FailureClass {
  const e = error ?? "";
  return isQuotaExhausted(e) || isTransient(e) || INFRASTRUCTURE.test(e) ? "infrastructure" : "agent";
}
const OVER_CAP = /over the US\$[\d.]+ (cap|case cap|run cap)|error_max_budget_usd/i;

export class BenchmarkService {
  private timer: NodeJS.Timeout | null = null;
  private adapters!: Record<BenchmarkAgent, Adapter>;
  // The benchmark context's own instances of the agent services (see the top of this file).
  builds!: BuildService;
  desk!: DeskService;
  review!: ReviewService;
  connector!: BdService;
  private bench: Db;
  private connectorClock = new Date();
  private connectorCapUsd = MIN_TASK_USD;
  private ticking = false;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly deps: BenchmarkDeps,
  ) {
    this.bench = benchDb(db);
  }

  static async open(db: Db, store: Store, deps: BenchmarkDeps) {
    await db.exec(TABLES);
    const s = new BenchmarkService(db, store, deps);
    const NO_MONTHLY = Number.MAX_SAFE_INTEGER; // the run's own cap governs; no real month's budget is involved
    // Object.create keeps each config's live settings (its getters read the operational settings at each use).
    const over = <C extends object>(base: C, values: Partial<Record<keyof C, unknown>>) =>
      Object.create(base, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === "function" ? { get: v as () => unknown } : { value: v }]))) as C;
    // No repository host: a benchmark build pushes nowhere and opens no pull request; Mynt verifies the packaged source.
    s.builds = await BuildService.open(s.bench, store, deps.sandboxes, null, over(deps.buildConfig, { monthlyCapUsd: NO_MONTHLY, workspaceMonthlyCapUsd: null, solanaSnapshot: false }));
    s.desk = await DeskService.open(s.bench, store, deps.sandboxes, deps.repos, over(deps.deskConfig, { monthlyCapUsd: NO_MONTHLY }));
    s.review = await ReviewService.open(s.bench, store, deps.sandboxes, over(deps.reviewConfig, { monthlyCapUsd: NO_MONTHLY, autoOpen: false }), s.desk, deps.fetcher);
    // The connector, dry run only. Its channel senders are the empty object written here: there is no parameter,
    // setting or environment variable through which a benchmark could be handed a way to email or message anyone,
    // so every message it writes is kept as a draft in the benchmark's own pipeline (bench_bd_*).
    s.connector = await BdService.open(
      s.bench,
      deps.sandboxes,
      over(deps.bdConfig, { enabled: true, monthlyCapUsd: NO_MONTHLY, everyHours: Number.MAX_SAFE_INTEGER, runCapUsd: () => s.connectorCapUsd }),
      {},
      () => s.connectorClock,
    );
    s.adapters = { coding: s.coding(), "product-desk": s.productDesk(), "governance-review": s.governance(), connector: s.connectorAdapter(), "program-audit": s.program("program-audit"), "program-red-team": s.program("program-red-team") };
    return s;
  }

  set meter(m: AgentMeter | null) {
    for (const x of [this.builds, this.desk, this.review, this.connector]) x.meter = m;
  }

  // The run behind a live benchmark agent's token, for the agent proxy (the same budgets and metering as any run).
  async agentRun(token: string): Promise<AgentRun | null> {
    return (await this.builds.agentRun(token)) ?? (await this.desk.agentRun(token)) ?? (await this.review.agentRun(token)) ?? (await this.connector.agentRun(token));
  }

  // A benchmark connector run's token: its MCP tools are the benchmark's own connector, never the real one.
  async connectorRun(token: string): Promise<{ bd: BdService; id: string } | null> {
    const run = await this.connector.runForToken(token);
    return run ? { bd: this.connector, id: run.id as string } : null;
  }

  private async all(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as Row[];
  }
  private async one(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }

  // ---- the benchmark's own account ----

  private async identity(): Promise<User> {
    const kept = await this.store.getSetting<{ user_id?: string }>(IDENTITY);
    const found = kept?.user_id ? await this.store.getUser(kept.user_id) : undefined;
    if (found) return found;
    // Its sign-in token is thrown away here: nobody, and no agent, can act as this account.
    const { user } = await this.store.createUser("Mynt benchmarks", ["developer"]);
    await this.store.setSetting(IDENTITY, { ...(kept ?? {}), user_id: user.id }, null);
    return user;
  }

  private async firm(user: User): Promise<string> {
    const kept = await this.store.getSetting<{ user_id?: string; entity_id?: string }>(IDENTITY);
    if (kept?.entity_id && (await this.store.getEntity(kept.entity_id))) return kept.entity_id;
    const entity = await this.store.createEntity(user.id, { name: "Mynt benchmarks (not a firm)", registration_numbers: {}, regions: ["US"] });
    await this.store.setSetting(IDENTITY, { ...(kept ?? {}), user_id: user.id, entity_id: entity.id }, null);
    return entity.id;
  }

  // ---- what each agent's run is made of ----

  private hostMissing(): string | null {
    const c = this.deps.buildConfig;
    if (!this.deps.sandboxes) return "no sandbox host is configured on this Mynt, so agents have nowhere to run";
    if (!c.agentBackend) return "no model backend is configured on this Mynt (the agents' model key isn't set)";
    if (!c.publicUrl) return "PUBLIC_URL isn't set, so a sandbox couldn't reach Mynt's agent proxy";
    return null;
  }

  private coding(): Adapter {
    const builds = () => this.builds;
    const config = this.deps.buildConfig;
    const ENDED = ["succeeded", "blocked", "failed", "stopped", "over_budget"];
    const resolve = async (task: CodingTask) => {
      const published = await this.store.publishedProducts();
      return task.products.map((want) => ({ want, product: published.find((p) => p.name.toLowerCase().includes(want.name.toLowerCase()) && (!want.category || p.category === want.category)) }));
    };
    return {
      needs: [
        "A sandbox host with allowance left, the agents' model backend, and PUBLIC_URL.",
        "Published products named as the tasks name them (a money market account, a certificate of deposit, …): a task whose product isn't published here is recorded as not run.",
        "No repository: a benchmark build pushes nowhere. Mynt packages the source and verifies it in a clean sandbox, as for any build.",
      ],
      model: () => config.model,
      unavailable: async () => {
        const set = taskSetFor("coding") as TaskSet<CodingTask>;
        for (const task of set.tasks) if ((await resolve(task)).every((r) => r.product)) return null;
        return `none of the task set's products is published on this Mynt (${[...new Set(set.tasks.flatMap((t) => t.products.map((p) => p.name)))].join(", ")})`;
      },
      maxTaskUsd: () => config.capUsd,
      // Mynt's independent audit is Mynt's own spend, outside a build's cap: the run's cap keeps room for it.
      reserveUsd: () => (config.audit.mode === "maxwell" ? config.audit.capUsd : 0),
      start: async (_run, t, capUsd) => {
        const task = t as CodingTask;
        const found = await resolve(task);
        const missing = found.filter((r) => !r.product).map((r) => r.want.name);
        if (missing.length) throw new NotRunnable(`No published product here is named like ${missing.map((m) => `'${m}'`).join(", ")}`);
        const user = await this.identity();
        const ids = [...new Set(found.map((r) => r.product!.id))];
        const name = `Benchmark: ${task.id}`;
        // One app per task, reused by every run: it belongs to the benchmark account, in that account's own workspace.
        const existing = await this.one(`SELECT id FROM ${T}.apps WHERE owner_id = $1 AND name = $2 ORDER BY created_at LIMIT 1`, [user.id, name]);
        let appId = existing?.id as string | undefined;
        if (appId) await this.db.query(`UPDATE ${T}.apps SET product_ids = $2 WHERE id = $1`, [appId, ids]);
        else appId = (await this.store.createApp(user.id, { name, description: "An agent benchmark task's app. Not a real app: nobody uses it.", audience: "Nobody: benchmark only", product_ids: ids })).id;
        const build = await builds().start(user, { goal: task.prompt, app_id: appId, kind: task.kind, cap_usd: capUsd });
        return build.id;
      },
      tick: () => builds().tick(),
      stop: async (jobId, reason) => {
        const b = await builds().get(jobId);
        if (b && !ENDED.includes(b.status)) await builds().stop(b, reason);
      },
      poll: async (_run, jobId, t) => {
        const task = t as CodingTask;
        const b = (await builds().get(jobId)) as Build | null;
        if (!b) return lost("the build's record is gone");
        if (!ENDED.includes(b.status)) return null;
        const reported = new Map(((b.readiness as Check[] | null) ?? []).map((c) => [c.name, c]));
        const checks: Check[] = task.checks.map((name) => {
          const c = reported.get(name);
          return c ? { name, status: c.status, ...(c.detail ? { detail: String(c.detail).slice(0, 400) } : {}) } : { name, status: "not_reported" };
        });
        const audited = config.audit.mode === "maxwell" || !!b.maxwell;
        const error = b.error ?? "";
        const auditBlocked = b.status === "blocked" && !/Solana program/.test(error);
        if (audited) checks.push({ name: "independent_audit", status: b.status === "succeeded" ? "pass" : auditBlocked ? "fail" : "not_reported", ...(auditBlocked ? { detail: error.slice(0, 400) } : {}) });
        let failed_check: string | null = null;
        let failure_class: FailureClass | null = null;
        if (b.status !== "succeeded") {
          const failing = checks.filter((c) => c.status === "fail" && c.name !== "independent_audit").map((c) => c.name);
          const other = [...reported.values()].filter((c) => c.status === "fail").map((c) => c.name);
          failure_class = failureClassOf(error);
          if (b.status === "stopped") failure_class = "harness";
          failed_check =
            failure_class !== "agent"
              ? failure_class
              : b.status === "over_budget" || OVER_CAP.test(error)
                ? "budget"
                : b.status === "blocked"
                  ? /Solana program/.test(error) ? "solana_build" : "independent_audit"
                  : (failing[0] ?? other[0] ?? (/^Coding agent/.test(error) ? "agent_exit" : "build_failed"));
        }
        const measured = b.agent_cost_usd !== null || b.sandbox_cost_usd !== null;
        return {
          passed: b.status === "succeeded",
          failure_class,
          failed_check,
          detail: b.status === "succeeded" ? null : `${b.status}: ${error || "no reason recorded"}`.slice(0, 1000),
          checks,
          observed: { build_status: b.status, next_step: b.next_step, products: ((await this.store.getApp(b.app_id ?? ""))?.product_ids ?? []) },
          cost_usd: measured ? cents(b.cost_usd + (b.audit_cost_usd ?? 0)) : null,
          cost_parts: measured ? { agent_model: b.agent_cost_usd, sandboxes: b.sandbox_cost_usd, mynt_audit: b.audit_cost_usd } : null,
          cost_note: measured ? null : "Not measured: the build ended before Mynt first measured its cost",
          started_at: iso(b.created_at),
          finished_at: iso(b.finished_at ?? b.updated_at),
          ...(isQuotaExhausted(error) ? { stop_run: QUOTA_MESSAGE } : {}),
        };
      },
    };
  }

  private productDesk(): Adapter {
    const config = this.deps.deskConfig;
    return {
      needs: [
        "A sandbox host with allowance left, the agents' model backend, PUBLIC_URL, and Mynt's GitHub App.",
        "A repository set aside for benchmarks, with Mynt's GitHub App installed on it, named when the run starts: the desk agent pushes a branch per task there and Mynt opens a pull request for each.",
        "The task set's regions and categories defined on this Mynt: a product that doesn't pass Mynt's product checks here is recorded as not run.",
      ],
      model: () => config.model,
      unavailable: async (opts) => {
        if (!this.deps.repos) return "Mynt's GitHub App isn't configured, and the desk agent works in a repository";
        if (!opts.repository) return "a product-desk run needs `repository`: a repository set aside for benchmarks, with Mynt's GitHub App installed on it";
        if (!(await this.deps.repos.installationFor(opts.repository))) return `Mynt's GitHub App isn't installed on ${opts.repository}`;
        return null;
      },
      maxTaskUsd: () => config.jobCapUsd,
      reserveUsd: () => 0,
      start: async (run, t, capUsd) => {
        const task = t as DeskTask;
        const user = await this.identity();
        const entityId = await this.firm(user);
        const product = { id: `benchmark-${task.id}`, ...task.product } as FinancialProduct;
        // The same product checks every product record gets, against this Mynt's regions and categories.
        const failed = runProductTests(product, await this.store.referenceData(true)).checks.filter((c) => c.status === "fail");
        if (failed.length) throw new NotRunnable(`The product doesn't pass Mynt's product checks here: ${failed.map((c) => `${c.name} (${c.message})`).join("; ")}`);
        const existing = await this.store.getProduct(product.id);
        if (existing && existing.owner_id !== user.id) throw new NotRunnable(`A product '${product.id}' that isn't the benchmark's already exists`);
        if (existing) await this.store.saveProduct(product, existing.status);
        else await this.store.insertDraft(user.id, product, { entity_id: entityId });
        await this.desk.setTerms(product.id, user.id, task.terms);
        const repository = String((run.options as StartOptions).repository);
        // The admin who started the run named this repository for it: that is its approval, in the benchmark's own
        // desk_workspaces (the start is audited with the repository's name).
        await this.desk.connectWorkspace(entityId, user.id, repository);
        await this.bench.query(`UPDATE ${T}.desk_workspaces SET approval = 'approved', approval_note = $2, decided_by = $3, decided_at = now() WHERE entity_id = $1`, [entityId, `Benchmark run ${run.id}`, run.started_by]);
        const job = await this.desk.start({ ...user, entity_id: entityId }, { kind: "agent", product_id: product.id, goal: task.goal, cap_usd: capUsd });
        return job.id as string;
      },
      tick: () => this.desk.tick(),
      stop: (jobId, reason) => this.desk.stop(jobId, reason),
      poll: async (_run, jobId, t) => {
        const task = t as DeskTask;
        const j = await this.desk.job(jobId);
        if (!j) return lost("the desk job's record is gone");
        if (!["finished", "failed", "stopped"].includes(j.status as string)) return null;
        const o = j.outcome as DeskOutcome | null;
        const error = (j.error as string | null) ?? "";
        const ran = j.status === "finished" && o?.outcome === "ran";
        const report = ran ? o.report : null;
        const e = task.expect;
        const shortfalls = report
          ? [
              ...(e.verdicts.includes(report.verdict) ? [] : [`verdict '${report.verdict}' isn't one of ${e.verdicts.join(", ")}`]),
              ...((report.checks?.length ?? 0) >= (e.min_checks ?? 0) ? [] : [`${report.checks?.length ?? 0} checks, at least ${e.min_checks} expected`]),
              ...(Object.keys(report.metrics ?? {}).length >= (e.min_metrics ?? 0) ? [] : [`${Object.keys(report.metrics ?? {}).length} metrics, at least ${e.min_metrics} expected`]),
            ]
          : [];
        const agentDone = ran || /^Mynt couldn't run the agent's model/.test(error) || (j.status === "finished" && !!o);
        const checks: Check[] = [
          { name: "product_checks", status: "pass" },
          { name: "agent_finished", status: agentDone ? "pass" : "fail", ...(agentDone ? {} : { detail: error.slice(0, 400) }) },
          { name: "mynt_model_run", status: ran ? "pass" : agentDone ? "fail" : "not_reported", ...(ran || !agentDone ? {} : { detail: (error || `Mynt's run ended as ${o?.outcome ?? "nothing"}`).slice(0, 400) }) },
          { name: "report_expectations", status: !ran ? "not_reported" : shortfalls.length ? "fail" : "pass", ...(shortfalls.length ? { detail: shortfalls.join("; ") } : {}) },
        ];
        const passed = ran && !shortfalls.length;
        let failure_class: FailureClass | null = null;
        let failed_check: string | null = null;
        if (!passed) {
          failure_class = j.status === "stopped" && !OVER_CAP.test(error) ? "harness" : failureClassOf(error);
          failed_check = failure_class !== "agent" ? failure_class : OVER_CAP.test(error) ? "budget" : (checks.find((c) => c.status === "fail")?.name ?? "desk_failed");
        }
        return {
          passed,
          failure_class,
          failed_check,
          detail: passed ? null : (shortfalls.join("; ") || error || `The job ended ${j.status}`).slice(0, 1000),
          checks,
          observed: { job_status: j.status, verdict: report?.verdict ?? null, model: j.model ?? null, pr_url: j.pr_url ?? null, metrics: report ? Object.keys(report.metrics ?? {}).length : null },
          cost_usd: usd(j.cost_usd),
          cost_parts: null,
          cost_note: "The desk records one figure per job: model spend and sandbox time together",
          started_at: iso(j.created_at),
          finished_at: iso(j.finished_at),
          ...(isQuotaExhausted(error) ? { stop_run: QUOTA_MESSAGE } : {}),
        };
      },
    };
  }

  private governance(): Adapter {
    const config = this.deps.reviewConfig;
    return {
      needs: ["A sandbox host with allowance left, the agents' model backend, and PUBLIC_URL.", "Nothing else: every sample's case is in the task set, and nothing is read from or written to real firms, licences or products."],
      model: () => config.model,
      unavailable: async () => null,
      maxTaskUsd: () => config.caseCapUsd,
      reserveUsd: () => 0.5, // a case may run this far over its cap before the desk stops it
      start: async (run, t, capUsd) => {
        const task = t as ReviewTask;
        const list = checklist(task.subject_kind);
        const snapshot = {
          subject_kind: task.subject_kind,
          subject: task.subject,
          facts: task.facts,
          regulatory: task.regulatory,
          items: list.filter((i) => i.by === "agent").map(({ id, title, requirement, material }) => ({ id, title, requirement, material })),
          // What Mynt would have computed from its own records, fixed for the sample.
          decided_by_mynt: list
            .filter((i) => i.by === "mynt")
            .map((i) => ({ id: i.id, status: task.decided_by_mynt[i.id], evidence: [{ source_url: "mynt://records", quote: "Fixed for this benchmark sample", verified: true }], note: null })),
        };
        const opened = await this.review.openCaseOn(snapshot, `benchmark:${String(run.id).slice(0, 8)}:${task.id}`, (run.started_by as string | null) ?? null, capUsd);
        return opened.id as string;
      },
      tick: () => this.review.tick(),
      stop: async (jobId, reason) => void (await this.review.stop(jobId, reason)),
      poll: async (_run, jobId, t) => {
        const task = t as ReviewTask;
        const c = await this.review.get(jobId);
        if (!c) return lost("the review case's record is gone");
        if (!["ready", "failed", "stopped", "decided"].includes(c.status as string)) return null;
        const error = (c.error as string | null) ?? "";
        const items = (c.items as ItemResult[] | null) ?? [];
        const verdict = (c.recommendation as { verdict?: string; reason?: string } | null)?.verdict ?? null;
        const answered = c.status === "ready" && verdict !== null;
        const byId = new Map(items.map((i) => [i.id, i]));
        const agentItems = items.filter((i) => i.by === "agent");
        const flagged = verdict === "reject";
        const checks: Check[] = [{ name: "review_complete", status: !answered ? "not_reported" : verdict === "incomplete" ? "fail" : "pass", ...(verdict === "incomplete" ? { detail: (c.recommendation as { reason?: string }).reason } : {}) }];
        if (answered && task.sample === "bad") {
          for (const id of task.expect.not_met ?? []) {
            const got = byId.get(id)?.status ?? "not_reviewed";
            // The agent said not met but no quote of its could be found in the source: the finding doesn't count.
            checks.push({ name: got === "unverified" ? "evidence_verified" : "planted_problem_caught", status: got === "not_met" ? "pass" : "fail", detail: `${id}: ${got}` });
          }
          checks.push({ name: "rejected", status: flagged ? "pass" : "fail", detail: `Mynt's recommendation: ${verdict}` });
        } else if (answered) {
          const wrong = agentItems.filter((i) => i.status === "not_met").map((i) => i.id);
          checks.push({ name: "nothing_falsely_flagged", status: wrong.length || flagged ? "fail" : "pass", detail: wrong.length ? `Marked not met: ${wrong.join(", ")}` : `Mynt's recommendation: ${verdict}` });
        }
        const passed = answered && checks.every((x) => x.status === "pass");
        let failure_class: FailureClass | null = null;
        let failed_check: string | null = null;
        if (!passed) {
          failure_class = answered ? "agent" : c.status === "stopped" && !OVER_CAP.test(error) && !/Over the US\$/.test(error) ? "harness" : failureClassOf(error);
          failed_check = failure_class !== "agent" ? failure_class : !answered ? (/Over the US\$/.test(error) ? "budget" : "review_failed") : (checks.find((x) => x.status === "fail")?.name ?? "review_failed");
        }
        return {
          passed,
          failure_class,
          failed_check,
          detail: passed ? null : (checks.filter((x) => x.status === "fail").map((x) => `${x.name}${x.detail ? ` (${x.detail})` : ""}`).join("; ") || error || `The case ended ${c.status}`).slice(0, 1000),
          checks,
          observed: { case_status: c.status, recommendation: verdict, items: Object.fromEntries(agentItems.map((i) => [i.id, i.status])), expected_flagged: task.expect.flagged },
          cost_usd: usd(c.cost_usd),
          cost_parts: null,
          cost_note: "The governance desk records one figure per case: model spend and sandbox time together",
          started_at: iso(c.created_at),
          finished_at: iso(c.finished_at),
          ...(isQuotaExhausted(error) ? { stop_run: QUOTA_MESSAGE } : {}),
        };
      },
    };
  }

  private connectorAdapter(): Adapter {
    const bd = () => this.connector;
    const q = (sql: string, params: unknown[] = []) => this.bench.query(sql, params).then((r) => r.rows as Row[]);
    const keyOf = (task: ConnectorTask, ids: Record<string, string>, key: string) => ids[key] ?? `missing:${task.id}:${key}`;
    return {
      needs: [
        "A sandbox host with allowance left, the agents' model backend, and PUBLIC_URL.",
        "Nothing else. It is a dry run by construction: the benchmark's connector has no channel to send on and works on a pipeline of invented people, separate from the real one. Nobody is emailed or messaged.",
      ],
      model: () => this.deps.bdConfig.model,
      unavailable: async () => null,
      maxTaskUsd: () => this.deps.bdConfig.runCapUsd,
      reserveUsd: () => 0.5, // a run may go this far over its cap before the connector stops it
      start: async (_run, t, capUsd) => {
        const task = t as ConnectorTask;
        // A clean pipeline for every task: only this task's invented people are in it.
        for (const table of ["bd_messages", "bd_intros", "bd_consents", "bd_erasures", "bd_contacts", "bd_suppressions", "bd_runs", "bd_prospects"]) await q(`DELETE FROM ${T}.${table}`);
        await q(`DELETE FROM ${T}.bd_settings WHERE key <> 'secret'`);
        this.connectorClock = new Date(task.at);
        this.connectorCapUsd = capUsd;
        const at = this.connectorClock.getTime();
        const ids: Record<string, string> = {};
        for (const p of task.prospects) {
          const { id } = await bd().addProspect({ kind: p.kind, name: p.name, org: p.org, title: p.title, region: p.region, source: p.source, source_url: p.source_url, contacts: p.contacts });
          ids[p.key] = id;
          const address = p.contacts[0].address;
          const contact = (await q(`SELECT id FROM ${T}.bd_contacts WHERE prospect_id = $1 AND channel = 'email' LIMIT 1`, [id]))[0];
          const history = p.history ?? [];
          for (const [n, m] of history.entries()) {
            const when = new Date(at - m.days_ago * 86400e3).toISOString();
            if (m.direction === "out") {
              await q(
                `INSERT INTO ${T}.bd_messages (id, prospect_id, contact_id, channel, direction, subject, body, status, created_at) VALUES ($1, $2, $3, 'email', 'out', $4, $5, 'draft', $6)`,
                [randomUUID(), id, contact.id, m.subject ?? null, m.body, when],
              );
              await q(`UPDATE ${T}.bd_prospects SET stage = 'contacted' WHERE id = $1 AND stage = 'sourced'`, [id]);
            } else {
              // Through the connector's own intake, so a STOP opts them out exactly as it would for real.
              const message = await bd().receive("email", address, { subject: m.subject, body: m.body });
              // A reply that was already answered later in the history isn't waiting.
              await q(`UPDATE ${T}.bd_messages SET created_at = $2, handled = $3 WHERE id = $1`, [message, when, history.slice(n + 1).some((x) => x.direction === "out")]);
            }
          }
          if (p.stage) await q(`UPDATE ${T}.bd_prospects SET stage = $2 WHERE id = $1`, [id, p.stage]);
        }
        await bd().setSetting("benchmark_prospects", ids);
        await bd().requestRun();
        await bd().tick();
        const run = (await q(`SELECT id FROM ${T}.bd_runs ORDER BY created_at DESC LIMIT 1`))[0];
        if (!run) throw new Error("The connector didn't start a run");
        return run.id as string;
      },
      tick: () => bd().tick(),
      stop: (_jobId, reason) => bd().stopRuns(reason),
      poll: async (_run, jobId, t) => {
        const task = t as ConnectorTask;
        const r = (await q(`SELECT * FROM ${T}.bd_runs WHERE id::text = $1`, [jobId]))[0];
        if (!r) return lost("the connector run's record is gone");
        if (!["finished", "failed", "stopped"].includes(r.status as string)) return null;
        const error = (r.error as string | null) ?? "";
        const ids = (await bd().setting<Record<string, string>>("benchmark_prospects")) ?? {};
        const id = (key: string) => keyOf(task, ids, key);
        const written = await q(`SELECT prospect_id::text AS prospect_id, body, status FROM ${T}.bd_messages WHERE direction = 'out' AND run_id::text = $1`, [jobId]);
        const to = (key: string) => written.filter((m) => m.prospect_id === id(key));
        const e = task.expect;
        const checks: Check[] = [{ name: "session_finished", status: r.status === "finished" ? "pass" : "fail", ...(r.status === "finished" ? {} : { detail: (error || String(r.status)).slice(0, 400) }) }];
        const check = (name: string, ok: boolean, detail: string) => checks.push({ name, status: ok ? "pass" : "fail", detail });
        for (const key of e.drafted_to ?? []) check("drafted_to", to(key).length > 0, `${key}: ${to(key).length} new message(s)`);
        for (const key of e.no_outbound_to ?? []) check("no_outbound_to", to(key).length === 0, `${key}: ${to(key).length} new message(s)`);
        for (const key of e.handled ?? []) {
          const open = (await q(`SELECT count(*)::int AS n FROM ${T}.bd_messages WHERE prospect_id::text = $1 AND direction = 'in' AND NOT handled`, [id(key)]))[0].n as number;
          check("replies_handled", open === 0, `${key}: ${open} reply(ies) left unhandled`);
        }
        for (const want of e.consent ?? []) {
          const got = (await q(`SELECT consent FROM ${T}.bd_contacts WHERE prospect_id::text = $1 AND channel = $2 ORDER BY consent_at DESC LIMIT 1`, [id(want.key), want.channel]))[0]?.consent ?? "none recorded";
          check("consent_recorded", got === want.consent, `${want.key} on ${want.channel}: ${got}`);
        }
        for (const [key, stage] of Object.entries(e.stage ?? {})) {
          const got = (await q(`SELECT stage FROM ${T}.bd_prospects WHERE id::text = $1`, [id(key)]))[0]?.stage ?? "erased";
          check("stage", got === stage, `${key}: ${got}`);
        }
        if (e.max_outbound !== undefined) check("max_outbound", written.length <= e.max_outbound, `${written.length} new message(s), at most ${e.max_outbound}`);
        if (e.no_intro_made) {
          const made = (await q(`SELECT count(*)::int AS n FROM ${T}.bd_intros WHERE status = 'made'`))[0].n as number;
          check("no_intro_made", made === 0, `${made} introduction(s) made`);
        }
        for (const s of e.not_shared ?? []) {
          const addresses = (task.prospects.find((p) => p.key === s.of)?.contacts ?? []).map((c) => c.address.toLowerCase());
          const leaked = to(s.with).some((m) => addresses.some((a) => String(m.body).toLowerCase().includes(a)));
          check("details_not_shared", !leaked, `${s.of}'s address ${leaked ? "is" : "isn't"} in a message to ${s.with}`);
        }
        // Nothing may ever have left: every message of a benchmark is a draft. Anything else is the harness's fault.
        const sent = (await q(`SELECT count(*)::int AS n FROM ${T}.bd_messages WHERE status = 'sent'`))[0].n as number;
        const passed = sent === 0 && checks.every((c) => c.status === "pass");
        let failure_class: FailureClass | null = null;
        let failed_check: string | null = null;
        if (sent > 0) [failure_class, failed_check] = ["harness", "message_left_the_benchmark"];
        else if (!passed) {
          failure_class = r.status === "finished" ? "agent" : r.status === "stopped" && !OVER_CAP.test(error) ? "harness" : failureClassOf(error);
          failed_check = failure_class !== "agent" ? failure_class : OVER_CAP.test(error) ? "budget" : (checks.find((c) => c.status === "fail" && (r.status !== "finished" || c.name !== "session_finished"))?.name ?? "session_failed");
        }
        return {
          passed,
          failure_class,
          failed_check,
          detail: passed ? null : sent > 0 ? `${sent} message(s) were marked sent in a dry run` : (checks.filter((c) => c.status === "fail").map((c) => `${c.name} (${c.detail})`).join("; ") || error).slice(0, 1000),
          checks,
          observed: { run_status: r.status, drafts: written.length, sent },
          cost_usd: usd(r.cost_usd),
          cost_parts: null,
          cost_note: "The connector records one figure per session: model spend and sandbox time together",
          started_at: iso(r.created_at),
          finished_at: iso(r.finished_at),
          ...(isQuotaExhausted(error) ? { stop_run: QUOTA_MESSAGE } : {}),
        };
      },
    };
  }

  // The mainnet gate's two agents have task sets and samples, but no way to run yet: the gate only reviews a mainnet
  // program record whose build Mynt compiled, and a benchmark must never create one of those.
  private program(agent: "program-audit" | "program-red-team"): Adapter {
    const why = `${agent} benchmarks can't run yet: the mainnet program gate reviews only a mainnet program's own verified build, and a benchmark must not register mainnet programs. The task set and its samples are in place; the gate needs an entry point that takes a sample's source${agent === "program-red-team" ? " and compiles it" : ""} directly`;
    const never = async () => {
      throw new BenchmarkRefusal(why);
    };
    return { needs: [why], model: () => null, unavailable: async () => why, maxTaskUsd: () => 0, reserveUsd: () => 0, start: never, tick: async () => undefined, poll: async () => null, stop: async () => undefined };
  }

  // ---- runs ----

  /** Every agent with a task set: what it holds, and whether a run could start here now (and if not, why). */
  async agents() {
    const host = this.hostMissing();
    const out = [];
    for (const agent of BENCHMARK_AGENTS) {
      const set = taskSetFor(agent);
      if (!set) continue;
      const a = this.adapters[agent];
      // What only a start can check (the repository a desk run names) isn't held against readiness here.
      const own = await a.unavailable({ repository: "" }).catch((e) => (e as Error).message);
      const whyNot = agent.startsWith("program-") ? own : (host ?? (agent === "product-desk" && own?.startsWith("a product-desk run needs") ? null : own));
      out.push({
        agent,
        task_set: set.file,
        version: set.version,
        title: set.title,
        description: set.description,
        tasks: set.tasks.length,
        workspaces: set.workspaces,
        model: a.model(),
        max_task_usd: a.maxTaskUsd() || null,
        ready: !whyNot,
        why_not: whyNot ? `${whyNot[0].toUpperCase()}${whyNot.slice(1)}` : null,
        needs: a.needs,
      });
    }
    return out;
  }

  capCeilingUsd() {
    return Number(operationalSetting("BENCHMARK_CAP_USD") ?? 25);
  }

  /**
   * Starts a run: only ever on an admin's explicit call, with an explicit cap. Refuses, saying why, when real
   * execution isn't possible. Audited by the caller's tool.
   */
  async start(admin: User, o: { agent: BenchmarkAgent; cap_usd: number; label?: string; repository?: string; task_ids?: string[]; host_restored?: boolean }) {
    const set = taskSetFor(o.agent);
    if (!set) throw new BenchmarkRefusal(`There is no task set for ${o.agent}`);
    const adapter = this.adapters[o.agent];
    const refuse = (why: string) => new BenchmarkRefusal(`This run can't start: ${why}.`);
    if (!(o.cap_usd > 0)) throw refuse("a run needs an explicit cap in US dollars (cap_usd), the most it may spend");
    const ceiling = this.capCeilingUsd();
    if (o.cap_usd > ceiling) throw refuse(`its cap of US$${o.cap_usd} is over BENCHMARK_CAP_USD, the most one run may spend (US$${ceiling}); an admin can change that in the operational settings`);
    const own = o.agent.startsWith("program-") ? await adapter.unavailable(o) : (this.hostMissing() ?? (await adapter.unavailable(o)));
    if (own) throw refuse(own);
    if (o.cap_usd < MIN_TASK_USD + adapter.reserveUsd()) throw refuse(`a cap of US$${o.cap_usd} is too small for even one task (at least US$${MIN_TASK_USD + adapter.reserveUsd()})`);
    const quota = o.host_restored ? null : await this.hostOutOfAllowance();
    if (quota) throw refuse(quota);
    const active = await this.one(`SELECT id, agent FROM ${T}.benchmark_runs WHERE status = ANY($1) LIMIT 1`, [ACTIVE]);
    if (active) throw refuse(`another benchmark run is still going (${active.agent}, ${active.id}); one runs at a time, so stop it or let it finish`);
    const tasks = o.task_ids?.length ? set.tasks.filter((t) => o.task_ids!.includes(t.id)) : set.tasks;
    const unknown = (o.task_ids ?? []).filter((id) => !set.tasks.some((t) => t.id === id));
    if (unknown.length || !tasks.length) throw refuse(`the task set has no task ${unknown.map((u) => `'${u}'`).join(", ") || "to run"}`);
    const id = randomUUID();
    // Another start can get in between the check above and this insert; the index benchmark_runs_one_active_idx
    // refuses the second, and so does this start, in the same words.
    const taken = (e: { code?: string }) => {
      throw e.code === "23505" ? refuse("another benchmark run is still going (it was started at the same moment); one runs at a time, so stop it or let it finish") : e;
    };
    await this.db.query(
      `INSERT INTO ${T}.benchmark_runs (id, agent, task_set, task_set_version, task_set_sha256, label, status, cap_usd, model, workspace_revisions, source_commit, options, started_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7, $8, $9, $10, $11, $12)`,
      [
        id,
        o.agent,
        set.file,
        set.version,
        set.sha256,
        o.label?.trim() || null,
        o.cap_usd,
        adapter.model(),
        JSON.stringify(Object.fromEntries(set.workspaces.map((w) => [w, workspaceRevision(w)]))),
        sourceCommit(),
        JSON.stringify({ ...(o.repository ? { repository: o.repository.toLowerCase() } : {}), ...(o.task_ids?.length ? { task_ids: o.task_ids } : {}), ...(o.host_restored ? { host_restored: true } : {}) }),
        admin.id,
      ],
    ).catch(taken);
    for (const [n, t] of tasks.entries()) await this.db.query(`INSERT INTO ${T}.benchmark_results (id, run_id, task_id, position, status) VALUES ($1, $2, $3, $4, 'pending')`, [randomUUID(), id, t.id, n]);
    return (await this.run(id))!;
  }

  // The sandbox host's allowance was used up the last time anything real tried to run, and nothing has run since.
  private async hostOutOfAllowance(): Promise<string | null> {
    try {
      const last = await this.one(`SELECT error, finished_at FROM ${T}.build_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`);
      if (last && isQuotaExhausted(last.error as string))
        return `the sandbox host's allowance is used up: the last build to end (${iso(last.finished_at)}) failed with "${QUOTA_MESSAGE}" and none has run since. Once billing is added there, start the run with host_restored: true`;
    } catch {
      // no builds table on this Mynt: nothing to go by
    }
    return null;
  }

  async stop(runId: string, reason: string) {
    const run = await this.one(`SELECT * FROM ${T}.benchmark_runs WHERE id::text = $1`, [runId]);
    if (!run) throw new BenchmarkRefusal(`No benchmark run '${runId}'`);
    if (!ACTIVE.includes(run.status as string)) throw new BenchmarkRefusal(`The run already ended (${run.status})`);
    await this.endRun(run, "stopped", reason);
    return (await this.run(runId))!;
  }

  // Ends a run before its tasks are done: the task in flight is stopped and scored as the harness's, the rest never ran.
  private async endRun(run: Row, status: "stopped" | "stopped_at_cap" | "failed", reason: string) {
    const adapter = this.adapters[run.agent as BenchmarkAgent];
    for (const r of await this.all(`SELECT * FROM ${T}.benchmark_results WHERE run_id = $1 AND status = 'running'`, [run.id])) {
      if (r.job_id) await adapter.stop(r.job_id as string, `Benchmark run stopped: ${reason}`).catch(() => undefined);
      await this.db.query(`UPDATE ${T}.benchmark_results SET status = 'failed', failure_class = 'harness', failed_check = 'run_stopped', detail = $2, finished_at = now() WHERE id = $1`, [r.id, `Stopped with the run: ${reason}`]);
    }
    await this.db.query(`UPDATE ${T}.benchmark_results SET status = 'not_run', detail = $2 WHERE run_id = $1 AND status = 'pending'`, [run.id, reason]);
    await this.db.query(`UPDATE ${T}.benchmark_runs SET status = $2, stop_reason = $3, finished_at = now() WHERE id = $1`, [run.id, status, reason]);
  }

  startWorker(intervalMs = Number(process.env.BENCHMARK_POLL_MS ?? 5000)) {
    if (this.timer) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "benchmark worker");
  }
  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One step of the run in progress (below), never two at once: a second tick overlapping the first would see the
   * same task waiting and start it again, and count a scored task's cost twice. A pool holds an advisory lock for the
   * step on one connection, so this holds across every server on the database; in-process Postgres has one connection.
   */
  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (!this.db.transaction) return await this.step();
      await this.db.transaction(async (tx) => {
        const lock = (await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext('mynt:benchmark-tick')) AS mine`)).rows[0] as { mine: boolean };
        if (lock.mine) await this.step();
      });
    } finally {
      this.ticking = false;
    }
  }

  /** One step of the run in progress, if any: move its task along, score it when Mynt has decided, start the next. */
  private async step() {
    const run = await this.one(`SELECT * FROM ${T}.benchmark_runs WHERE status = ANY($1) ORDER BY created_at LIMIT 1`, [ACTIVE]);
    if (!run) return;
    const agent = run.agent as BenchmarkAgent;
    const adapter = this.adapters[agent];
    const set = taskSetFor(agent, run.task_set_version as number);
    if (!set || set.sha256 !== run.task_set_sha256) return this.endRun(run, "failed", "The task set this run started on is no longer on this server (it was changed or removed), so its remaining tasks can't be scored against it");
    if (run.status === "queued") await this.db.query(`UPDATE ${T}.benchmark_runs SET status = 'running', started_at = now() WHERE id = $1`, [run.id]);

    const current = await this.one(`SELECT * FROM ${T}.benchmark_results WHERE run_id = $1 AND status = 'running' LIMIT 1`, [run.id]);
    if (current) {
      const task = set.tasks.find((t) => t.id === current.task_id)!;
      await adapter.tick();
      const outcome = await adapter.poll(run, current.job_id as string, task);
      if (!outcome) return;
      await this.record(run, current, outcome);
      if (outcome.stop_run) await this.endRun(run, "stopped", outcome.stop_run);
      return;
    }

    const next = await this.one(`SELECT * FROM ${T}.benchmark_results WHERE run_id = $1 AND status = 'pending' ORDER BY position LIMIT 1`, [run.id]);
    if (!next) {
      await this.db.query(`UPDATE ${T}.benchmark_runs SET status = 'finished', finished_at = now() WHERE id = $1`, [run.id]);
      return;
    }
    // The cap: a task may spend at most what's left of it (less what Mynt may spend on top). Too little left: stop.
    const charged = Number((await this.one(`SELECT charged_usd FROM ${T}.benchmark_runs WHERE id = $1`, [run.id]))!.charged_usd);
    const left = Number(run.cap_usd) - charged;
    const capUsd = Math.floor(Math.min(adapter.maxTaskUsd(), left - adapter.reserveUsd()) * 100) / 100;
    if (capUsd < MIN_TASK_USD) {
      const done = Number((await this.one(`SELECT count(*)::int AS n FROM ${T}.benchmark_results WHERE run_id = $1 AND status IN ('passed', 'failed')`, [run.id]))!.n);
      return this.endRun(run, "stopped_at_cap", `The run's cap of US$${Number(run.cap_usd)} was reached: US$${cents(charged)} counted after ${done} task(s), and US$${cents(Math.max(0, left))} left isn't enough for another`);
    }
    const task = set.tasks.find((t) => t.id === next.task_id)!;
    try {
      const jobId = await adapter.start(run, task, capUsd);
      await this.db.query(`UPDATE ${T}.benchmark_results SET status = 'running', job_id = $2, cap_usd = $3, started_at = now() WHERE id = $1`, [next.id, jobId, capUsd]);
    } catch (e) {
      const message = (e as Error).message;
      if (e instanceof NotRunnable) await this.db.query(`UPDATE ${T}.benchmark_results SET status = 'not_run', detail = $2 WHERE id = $1`, [next.id, message]);
      else {
        // The task never reached the agent: the host's fault when it looks like it, else the harness's. Never the agent's.
        const failureClass = failureClassOf(message) === "infrastructure" ? "infrastructure" : "harness";
        await this.db.query(`UPDATE ${T}.benchmark_results SET status = 'failed', failure_class = $2, failed_check = $2, detail = $3, started_at = now(), finished_at = now() WHERE id = $1`, [next.id, failureClass, `The task couldn't be started: ${message}`.slice(0, 1000)]);
        if (isQuotaExhausted(message)) await this.endRun(run, "stopped", QUOTA_MESSAGE);
      }
    }
  }

  private async record(run: Row, result: Row, o: Outcome) {
    const duration = o.started_at && o.finished_at ? Math.max(0, Date.parse(o.finished_at) - Date.parse(o.started_at)) : null;
    await this.db.query(
      `UPDATE ${T}.benchmark_results SET status = $2, failure_class = $3, failed_check = $4, detail = $5, checks = $6, observed = $7, cost_usd = $8, cost_parts = $9, cost_note = $10,
         duration_ms = $11, finished_at = COALESCE($12::timestamptz, now()) WHERE id = $1`,
      [result.id, o.passed ? "passed" : "failed", o.failure_class, o.failed_check, o.detail, JSON.stringify(o.checks), JSON.stringify(o.observed ?? null), o.cost_usd, o.cost_parts ? JSON.stringify(o.cost_parts) : null, o.cost_note, duration, o.finished_at],
    );
    // Where nothing was measured, the cap counts the task's whole budget: it never under-counts.
    await this.db.query(`UPDATE ${T}.benchmark_runs SET charged_usd = charged_usd + $2 WHERE id = $1`, [run.id, o.cost_usd ?? Number(result.cap_usd ?? 0)]);
  }

  // ---- reading runs ----

  private runView(r: Row) {
    return {
      id: r.id as string,
      agent: r.agent as string,
      label: (r.label as string | null) ?? null,
      task_set: r.task_set as string,
      task_set_version: Number(r.task_set_version),
      task_set_sha256: r.task_set_sha256 as string,
      status: r.status as string,
      stop_reason: (r.stop_reason as string | null) ?? null,
      cap_usd: Number(r.cap_usd),
      charged_usd: cents(Number(r.charged_usd)),
      model: (r.model as string | null) ?? null,
      workspace_revisions: (r.workspace_revisions as Record<string, string>) ?? {},
      source_commit: (r.source_commit as string | null) ?? null,
      source_commit_note: r.source_commit ? null : "Not recorded: the server wasn't running from a git checkout",
      options: r.options ?? {},
      started_by: (r.started_by_name as string | null) ?? null,
      created_at: iso(r.created_at),
      started_at: iso(r.started_at),
      finished_at: iso(r.finished_at),
    };
  }

  private resultView(r: Row) {
    return {
      task_id: r.task_id as string,
      position: Number(r.position),
      status: r.status as TaskResult["status"],
      failure_class: (r.failure_class as FailureClass | null) ?? null,
      failed_check: (r.failed_check as string | null) ?? null,
      detail: (r.detail as string | null) ?? null,
      checks: (r.checks as Check[] | null) ?? [],
      observed: r.observed ?? null,
      cap_usd: num(r.cap_usd),
      cost_usd: usd(r.cost_usd),
      cost_parts: (r.cost_parts as Record<string, number | null> | null) ?? null,
      cost_note: r.cost_usd === null && ["passed", "failed"].includes(r.status as string) ? ((r.cost_note as string | null) ?? "Not measured") : ((r.cost_note as string | null) ?? null),
      duration_ms: num(r.duration_ms),
      started_at: iso(r.started_at),
      finished_at: iso(r.finished_at),
    };
  }

  private async results(runId: string) {
    return (await this.all(`SELECT * FROM ${T}.benchmark_results WHERE run_id::text = $1 ORDER BY position`, [runId])).map((r) => this.resultView(r));
  }

  async run(id: string) {
    const r = await this.one(`SELECT r.*, u.name AS started_by_name FROM ${T}.benchmark_runs r LEFT JOIN ${T}.users u ON u.id = r.started_by WHERE r.id::text = $1`, [id]);
    if (!r) return null;
    const run = this.runView(r);
    const tasks = await this.results(id);
    return { run, scoreboard: scoreboard(tasks), tasks };
  }

  async list(o: { agent?: string; limit?: number } = {}) {
    const rows = await this.all(
      `SELECT r.*, u.name AS started_by_name FROM ${T}.benchmark_runs r LEFT JOIN ${T}.users u ON u.id = r.started_by WHERE ($1::text IS NULL OR r.agent = $1) ORDER BY r.created_at DESC LIMIT $2`,
      [o.agent ?? null, Math.min(o.limit ?? 50, 200)],
    );
    const out = [];
    for (const r of rows) out.push({ ...this.runView(r), scoreboard: scoreboard(await this.results(r.id as string)) });
    return out;
  }

  async compare(baselineId: string, candidateId: string, thresholds: Parameters<typeof regressionGate>[1] = {}) {
    const [a, b] = [await this.run(baselineId), await this.run(candidateId)];
    if (!a) throw new BenchmarkRefusal(`No benchmark run '${baselineId}'`);
    if (!b) throw new BenchmarkRefusal(`No benchmark run '${candidateId}'`);
    const comparison = compareRuns({ run: a.run as RunSummary, results: a.tasks }, { run: b.run as RunSummary, results: b.tasks });
    return { baseline: a.run, candidate: b.run, comparison, gate: regressionGate(comparison, thresholds) };
  }
}

function lost(why: string): Outcome {
  return { passed: false, failure_class: "harness", failed_check: "harness", detail: `The benchmark lost track of this task: ${why}`, checks: [], observed: null, cost_usd: null, cost_parts: null, cost_note: "Not measured: the task's record is gone", started_at: null, finished_at: null };
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const OFF = "Agent benchmarks aren't running on this Mynt (the server was started without them)";

/** Admins only: start, stop, list, read and compare agent benchmark runs. */
export function registerBenchmarkTools(server: McpServer, store: Store, admin: User, benchmarks: BenchmarkService | null) {
  const attempt = async (f: (b: BenchmarkService) => Promise<unknown>) => {
    if (!benchmarks) return fail(OFF);
    try {
      return json(await f(benchmarks));
    } catch (e) {
      if (e instanceof BenchmarkRefusal) return fail(e.message);
      throw e;
    }
  };
  const agent = z.enum(BENCHMARK_AGENTS);

  server.registerTool(
    "list_benchmark_runs",
    {
      title: "Agent benchmark runs",
      description:
        "Admin: the agent benchmark runs, newest first, each with its scoreboard (tasks passed and failed on the agent's own account, the pass rate over those, infrastructure failures and tasks not run listed apart, cost and time), plus every agent that has a task set: how many tasks, what a run needs, and whether one could start here now (and if not, why). A figure nothing measured is null with a note saying why, never 0.",
      inputSchema: { agent: agent.optional().describe("Only this agent's runs"), limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ agent: only, limit }) =>
      attempt(async (b) => ({
        runs: await b.list({ agent: only, limit }),
        agents: await b.agents(),
        cap: { setting: "BENCHMARK_CAP_USD", max_usd_per_run: b.capCeilingUsd(), note: "A run's own cap is given when it starts and may not be more than this." },
        gate_defaults: GATE_DEFAULTS,
      })),
  );

  server.registerTool(
    "get_benchmark_run",
    {
      title: "A benchmark run's scoreboard",
      description:
        "Admin: one benchmark run: the agent, task set, model and the content hash of each agent workspace folder it ran with, its cap and what the cap has counted, why it stopped if it did, its scoreboard, and every task with its outcome, the check that failed, whether the failure was the agent's or the infrastructure's, each of Mynt's checks, cost and duration.",
      inputSchema: { run_id: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async ({ run_id }) =>
      attempt(async (b) => {
        const run = await b.run(run_id);
        if (!run) throw new BenchmarkRefusal(`No benchmark run '${run_id}'`);
        return run;
      }),
  );

  server.registerTool(
    "compare_benchmark_runs",
    {
      title: "Compare two benchmark runs",
      description:
        "Admin: a candidate run against a baseline run of the same agent and task set: pass rate, cost and median time with their deltas, each task's outcome in both with its cost and time deltas, the regressions (passed before, fails now on the agent's own account) and fixes listed, and the regression gate's verdict over it (pass, fail, or inconclusive when the runs can't be compared or too few tasks were scored in both). Tasks that failed for infrastructure reasons or didn't run are never counted as regressions or as passes.",
      inputSchema: {
        baseline: z.string().min(1).describe("The run to compare against"),
        candidate: z.string().min(1).describe("The run being judged"),
        max_regressions: z.number().int().min(0).optional().describe(`Tasks that may regress (default ${GATE_DEFAULTS.max_regressions})`),
        max_pass_rate_drop_points: z.number().min(0).max(100).optional().describe(`How far the pass rate may fall, in percentage points (default ${GATE_DEFAULTS.max_pass_rate_drop_points})`),
        max_cost_increase_pct: z.number().min(0).optional().describe("How far cost may rise, in percent (default: cost doesn't gate)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ baseline, candidate, ...thresholds }) => attempt((b) => b.compare(baseline, candidate, thresholds)),
  );

  server.registerTool(
    "start_benchmark_run",
    {
      title: "Start a benchmark run",
      description:
        "Admin: run one agent's benchmark task set for real: each task goes through the same service, sandbox, budgets and verification by Mynt as production work, in a benchmark context of its own (its own queues and budgets; no real workspace's data or budget is touched). This spends money on the model and on sandboxes, up to cap_usd, which is required and may not be more than BENCHMARK_CAP_USD; the run stops, and says so, when the cap is reached. Refused with the reason when it can't run here (no sandbox host or model backend, the host's allowance used up, another run going, something the agent's run needs missing). One run at a time. Audited.",
      inputSchema: z
        .object({
          agent,
          cap_usd: z.number().positive().describe("The most this run may spend, in US dollars. Required: there is no default."),
          label: z.string().trim().max(120).optional().describe("What this run is for, e.g. 'baseline before changing the secure skill'"),
          repository: z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/).optional().describe("product-desk only: the repository set aside for benchmarks (owner/name), with Mynt's GitHub App installed"),
          task_ids: z.array(z.string()).max(100).optional().describe("Only these tasks (default: the whole set)"),
          host_restored: z.boolean().optional().describe("Say true once the sandbox host's allowance, used up when a build last ran, has been restored"),
        })
        .strict(),
    },
    async (o) =>
      attempt(async (b) => {
        const started = await b.start(admin, o);
        await store.audit(admin.id, "start_benchmark_run", started.run.id, { agent: o.agent, task_set: started.run.task_set, tasks: started.tasks.length, cap_usd: o.cap_usd, label: o.label ?? null, repository: o.repository ?? null, host_restored: o.host_restored ?? false });
        return { ...started, message: `Started: ${started.tasks.length} ${o.agent} task(s), one at a time, up to US$${o.cap_usd}. Follow it with get_benchmark_run.` };
      }),
  );

  server.registerTool(
    "stop_benchmark_run",
    {
      title: "Stop a benchmark run",
      description: "Admin: stop a benchmark run that is still going. The task in flight is stopped (its sandboxes too) and recorded as stopped by the harness, not as the agent's failure; the tasks left are recorded as not run. Audited.",
      inputSchema: z.object({ run_id: z.string().min(1), reason: z.string().trim().min(3).max(300) }).strict(),
    },
    async ({ run_id, reason }) =>
      attempt(async (b) => {
        const stopped = await b.stop(run_id, `Stopped by ${admin.name}: ${reason}`);
        await store.audit(admin.id, "stop_benchmark_run", run_id, { reason });
        return stopped;
      }),
  );
}

/** Every task set, as the docs and the gate script list them. */
export const benchmarkTaskSets = () => taskSets().map(({ tasks, ...set }) => ({ ...set, tasks: tasks.length }));
