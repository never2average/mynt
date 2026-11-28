import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGENT_DIR, agentState, launchAgent } from "./agent-host.js";
import type { AgentRun } from "./agent-proxy.js";
import { redact } from "./boxes.js";
import { AUDIT_REPORT_FILE, AUDITOR_KILL, auditOutcome, auditorJob, type AuditProblem, type BuildService, type MaxwellReport } from "./builds.js";
import { inTransaction, type Db } from "./db.js";
import { operationalSetting } from "./platform-settings.js";
import { PRODUCTION_REVIEW_STATUSES, REVIEW_ACTIVE, reviewCounts, reviewStanding, seriousOf, type ProductionReviewStatus } from "./production-review-records.js";
import { lockAppStage } from "./promotion-schema.js";
import type { App, Store, User } from "./store.js";
import { defaultGraceMs, failureMessage, GraceTracker } from "./transient.js";
import { VERIFY_DIR, VERIFY_SCRIPT } from "./verify-script.js";
import { serialLoop } from "./worker.js";
import { appRole, frozenReason, isUuid, memberApp } from "./workspaces.js";

// The production code review: Mynt's full agent code review of ONE verified build of an app or service, required
// before that build goes to Production (promotions.ts: the production_code_review check, and the deploy gate for an
// app already there).
//
// Why it is its own step: the secure code review workflow is a run of dozens of agents, far larger than a per-build
// limit, so a build's own audit (builds.ts) runs only the workflows that fit one. The review that reads the code
// happens once, on the exact build that will go live, with its own time limit and budget.
//
// It runs through the build audit's machinery, not a second one: a clean sandbox, the build's source as a read-only
// copy Mynt hashes before and after, the auditor steered by workspaces/build-audit (its script fetches the pinned
// tool, checks it, launches each workflow, watches it and rewrites the report from the tool's own ledger), Mynt's
// meter on every model call, and builds.ts's auditOutcome to say why a report doesn't count. The agent never grades
// its work: Mynt reads the report and decides. A review that ends without a complete report is never run again by
// itself: someone asks again, knowing why it ended.
//
// The source is the commit the build pushed, which Mynt checked was exactly the verified source when the build
// succeeded, and which is what hosting fetches when the build goes online.
//
// Who: an owner or admin of the app's workspace asks for a review of their app, within the workspace's monthly
// limits (it is Mynt's spend, not the workspace's). Every member reads the results. Mynt admins ask, stop and read
// across workspaces, and only a Mynt admin outside the workspace records an exception for one build
// (waive_production_review), with a reason, in the audit trail, shown wherever the review is.

const T = "financial_products";
type Q = Pick<Db, "query">;
type Row = Record<string, unknown>;

export class ProductionReviewError extends Error {}

export interface ProductionReviewConfig {
  workflows: string[];
  model: string;
  minutes: number;
  capUsd: number;
  // Per workspace per calendar month, for reviews its own owners and admins start: how many, and how much.
  workspaceMonthly: number;
  workspaceMonthlyUsd: number;
  // Reviews running at once, across Mynt; the rest wait their turn (PRODUCTION_REVIEW_CONCURRENCY, default 2).
  maxRunning: number;
}

// Operational settings (platform-settings.ts), read each time they're used: an admin's change applies to the next
// review asked for. A review keeps the limits it was asked with.
export function productionReviewConfigFromEnv(env = process.env): ProductionReviewConfig {
  const setting = (key: string) => operationalSetting(key, env);
  return {
    get workflows() {
      return (setting("PRODUCTION_REVIEW_WORKFLOWS") ?? "execute-scr").split(",").map((w) => w.trim()).filter(Boolean);
    },
    get model() {
      return setting("PRODUCTION_REVIEW_MODEL") ?? "claude-sonnet-5-5";
    },
    get minutes() {
      return Number(setting("PRODUCTION_REVIEW_MINUTES") ?? 180);
    },
    get capUsd() {
      return Number(setting("PRODUCTION_REVIEW_CAP_USD") ?? 60);
    },
    get workspaceMonthly() {
      return Number(setting("PRODUCTION_REVIEW_WORKSPACE_MONTHLY") ?? 4);
    },
    get workspaceMonthlyUsd() {
      return Number(setting("PRODUCTION_REVIEW_WORKSPACE_MONTHLY_USD") ?? 200);
    },
    maxRunning: Math.max(1, Math.floor(Number(env.PRODUCTION_REVIEW_CONCURRENCY ?? 2)) || 2),
  };
}

// What to do, by why a review isn't complete. Its time, budget, model and workflows are Mynt's settings.
export const REVIEW_NEXT = {
  time:
    "Nothing in your code needs changing for this. The time limit is Mynt's setting, and asking again is likely to end the same way (and counts towards the workspace's monthly reviews) until it changes: ask a Mynt admin to raise PRODUCTION_REVIEW_MINUTES, then request the review again.",
  budget:
    "Nothing in your code needs changing for this. The budget is Mynt's setting, and asking again is likely to end the same way (and counts towards the workspace's monthly reviews) until it changes: ask a Mynt admin to raise PRODUCTION_REVIEW_CAP_USD, then request the review again.",
  tool:
    "Nothing in your code needs changing for this, and asking again won't help until it's fixed: a Mynt admin must put right what the message names. Most often that is BUILD_MAXWELL_COMMIT (a commit of the review tool whose own checks pass) or PRODUCTION_REVIEW_WORKFLOWS (it names a workflow that commit doesn't have). Then request the review again.",
  refused:
    "Nothing in your code needs changing for this, and asking again will be refused again: the model provider's safeguards declined the security review. Ask a Mynt admin, who chooses one: get the provider's approval for security work on Mynt's account, run reviews on a model the provider allows them on (PRODUCTION_REVIEW_MODEL), or record an exception for this build with its reason (waive_production_review). The request id above is what the provider will ask for.",
  stalled:
    "Nothing in your code needs changing for this: the review's run stopped making progress and was ended. Request the review again. If it ends the same way, ask a Mynt admin: the model provider or Mynt's agent proxy may be failing.",
  no_report: "Nothing in your code needs changing for this. Request the review again. If it ends the same way, ask a Mynt admin, who can read the reviewer's own account of the run.",
  incomplete: "Request the review again. If the same workflows don't finish again, ask a Mynt admin, who can read the reviewer's own account of the run.",
  changed: "The reviewer reads a read-only copy of the source, so something in the review's sandbox wrote to it. Request the review again; if the same files change again, tell a Mynt admin.",
  error: "Nothing in your code needs changing for this. Request the review again. If it fails the same way, ask a Mynt admin.",
  source: "Mynt couldn't fetch the commit this build pushed. Check the app's repository is still connected (get_app_repository), then request the review again; or build again and review the new build.",
  stopped: "A stopped review doesn't count: request the review again when you're ready.",
} as const;
export type ReviewProblem = keyof typeof REVIEW_NEXT;

const STATUS_OF: Record<AuditProblem["kind"], ProductionReviewStatus> = { time: "incomplete", budget: "incomplete", stalled: "incomplete", no_report: "incomplete", incomplete: "incomplete", refused: "refused", tool: "failed" };

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const parse = <X>(text: string | null): X | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as X;
  } catch {
    return null;
  }
};
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const num = (v: unknown) => (v == null ? null : Number(v));
const short = (id: unknown) => String(id ?? "").slice(0, 8);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const asWorkflow = (s: unknown) => (typeof s === "string" ? s : s && typeof s === "object" && typeof (s as { workflow?: unknown }).workflow === "string" ? (s as { workflow: string }).workflow : null);
const monthName = (d = new Date()) => d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

// Which parts a report says were reviewed, and which weren't, with why: read from the report alone.
export function reviewCoverage(report: unknown, workflows: string[]) {
  if (!report || typeof report !== "object") return null;
  const r = report as MaxwellReport & { progress?: unknown };
  const ran = new Set((Array.isArray(r.workflows_run) ? r.workflows_run : []).map(asWorkflow).filter((w): w is string => !!w));
  const skipped = (Array.isArray(r.skipped) ? r.skipped : []).flatMap((s) => {
    const workflow = asWorkflow(s);
    if (!workflow) return [];
    const o = s && typeof s === "object" ? (s as { kind?: unknown; reason?: unknown }) : {};
    return [{ workflow, kind: typeof o.kind === "string" ? o.kind : null, reason: typeof o.reason === "string" ? clip(redact(o.reason.replace(/\s+/g, " ").trim()), 300) : null }];
  });
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // How far each workflow got, as the reviewer's script counted it: agent runs, minutes, ledger records.
  const progress = (Array.isArray(r.progress) ? r.progress : []).flatMap((p) => {
    const workflow = asWorkflow(p);
    if (!workflow || !p || typeof p !== "object") return [];
    const o = p as Row;
    return [{ workflow, state: typeof o.state === "string" ? o.state : null, minutes: n(o.minutes), agent_runs: n(o.agents), ledger_records: n(o.ledger_records) }];
  });
  return {
    reviewed: workflows.filter((w) => ran.has(w)),
    not_reviewed: workflows.filter((w) => !ran.has(w)).map((w) => skipped.find((s) => s.workflow === w) ?? { workflow: w, kind: null, reason: null }),
    progress,
  };
}

function findingsOf(report: unknown) {
  const list = report && typeof report === "object" ? (report as { findings?: unknown }).findings : null;
  return (Array.isArray(list) ? list : [])
    .filter((f): f is Row => !!f && typeof f === "object")
    .slice(0, 500)
    .map((f) => ({
      severity: String(f.severity ?? "").toLowerCase(),
      title: clip(redact(String(f.title ?? "untitled").replace(/\s+/g, " ").trim()), 300),
      file: f.file ? clip(String(f.file), 300) : null,
      workflow: f.workflow ? String(f.workflow) : null,
    }));
}

const SELECT = `SELECT r.*, a.name AS app_name, a.kind AS app_kind, w.name AS workspace_name, u.name AS requested_by_name, s.name AS stopped_by_name
  FROM ${T}.production_reviews r JOIN ${T}.apps a ON a.id = r.app_id LEFT JOIN ${T}.workspaces w ON w.id = r.workspace_id
  LEFT JOIN ${T}.users u ON u.id = r.requested_by LEFT JOIN ${T}.users s ON s.id = r.stopped_by`;

/** A review as its readers see it. Nothing here is the sandbox, the token or the reviewer's own log. */
export function reviewView(r: Row, o: { findings?: boolean; admin?: boolean } = {}) {
  const status = r.status as ProductionReviewStatus;
  const started = iso(r.started_at);
  const finished = iso(r.finished_at);
  const workflows = (r.workflows as string[]) ?? [];
  return {
    id: r.id as string,
    app_id: r.app_id as string,
    app_name: (r.app_name as string | undefined) ?? null,
    app_kind: (r.app_kind as string | undefined) ?? "app",
    workspace_id: (r.workspace_id as string | null) ?? null,
    workspace_name: (r.workspace_name as string | null | undefined) ?? null,
    build_id: r.build_id as string,
    commit_sha: (r.commit_sha as string | null) ?? null,
    source_sha256: (r.source_sha256 as string | null) ?? null,
    status,
    // Counts by severity from the report so far; null when no report was written (not measured, never 0).
    findings: reviewCounts(r.report),
    coverage: reviewCoverage(r.report, workflows),
    // Mynt's own spend on it (the model, and the sandbox's machine time); null until it has been measured.
    cost_usd: num(r.cost_usd),
    // How long it ran; null when it never started.
    seconds: started ? Math.max(0, Math.round((Date.parse(finished ?? new Date().toISOString()) - Date.parse(started)) / 1000)) : null,
    limits: { workflows, minutes: Number(r.minutes), cap_usd: Number(r.cap_usd), model: r.model as string },
    problem: (r.problem as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    next_step: (r.next_step as string | null) ?? null,
    requested_by: r.requested_by ? { id: r.requested_by as string, name: (r.requested_by_name as string | null | undefined) ?? null, mynt_admin: !!r.by_admin } : null,
    stopped_by: r.stopped_by ? { id: r.stopped_by as string, name: (r.stopped_by_name as string | null | undefined) ?? null } : null,
    created_at: iso(r.created_at)!,
    started_at: started,
    finished_at: finished,
    ...(o.findings ? { finding_list: findingsOf(r.report), summary: typeof (r.report as { summary?: unknown } | null)?.summary === "string" ? clip(redact((r.report as { summary: string }).summary), 1000) : null } : {}),
    // The reviewer's own account of a run that didn't finish, for the admins who must put it right.
    ...(o.admin && o.findings ? { run: r.run ?? null, tool_commit: (r.tool_commit as string | null) ?? null } : {}),
  };
}

const waiverView = (w: Row) => ({
  app_id: w.app_id as string,
  build_id: w.build_id as string,
  reason: w.reason as string,
  waived_by: w.waived_by ? { id: w.waived_by as string, name: (w.waived_by_name as string | null | undefined) ?? null } : null,
  at: iso(w.created_at)!,
});

export class ProductionReviewService {
  static TRANSIENT_GRACE_MS = defaultGraceMs();
  private transient = new GraceTracker(() => ProductionReviewService.TRANSIENT_GRACE_MS);
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly builds: BuildService,
    readonly config: ProductionReviewConfig,
  ) {}

  // The tables are the store's (promotion-schema.ts), so the promotion checks read them on any Mynt.
  static async open(db: Db, store: Store, builds: BuildService, config: ProductionReviewConfig = productionReviewConfigFromEnv()) {
    return new ProductionReviewService(db, store, builds, config);
  }

  private get sandboxes() {
    return this.builds.sandboxes;
  }
  /** Reviews can run here: agent sandboxes, the model backend, Mynt's public address and the repository host. */
  get enabled() {
    return this.builds.enabled && !!this.builds.repos;
  }
  private async one(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows[0] as Row | undefined;
  }
  private async all(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as Row[];
  }
  private async update(id: string, f: Row) {
    const keys = Object.keys(f);
    if (!keys.length) return;
    const json = new Set(["report", "run"]);
    await this.db.query(`UPDATE ${T}.production_reviews SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...keys.map((k) => (json.has(k) && f[k] != null ? JSON.stringify(f[k]) : f[k]))]);
  }

  /** The limits a review asked for now would run with, and the workspace's monthly limits. */
  limits() {
    const c = this.config;
    return { workflows: c.workflows, model: c.model, minutes: c.minutes, cap_usd: c.capUsd, workspace_monthly_reviews: c.workspaceMonthly, workspace_monthly_usd: c.workspaceMonthlyUsd };
  }

  /** What a workspace's own owners and admins have used of its monthly limits (reviews in progress at their cap). */
  async usage(q: Q, workspaceId: string) {
    const r = (
      await q.query(
        `SELECT count(*) FILTER (WHERE started_at IS NOT NULL OR status = ANY($2))::int AS reviews,
           COALESCE(sum(CASE WHEN status = ANY($2) THEN cap_usd ELSE COALESCE(cost_usd, 0) END), 0)::float AS usd
         FROM ${T}.production_reviews WHERE workspace_id::text = $1 AND NOT by_admin AND created_at >= date_trunc('month', now())`,
        [workspaceId, REVIEW_ACTIVE],
      )
    ).rows[0] as { reviews: number; usd: number };
    return { month: monthName(), reviews: Number(r.reviews), usd: Math.round(Number(r.usd) * 100) / 100 };
  }

  // ---- asking, stopping, waiving ----

  // The app, for someone who may ask for or stop its reviews: an owner or admin of its workspace, or a Mynt admin.
  private async managed(user: Pick<User, "id">, appId: string, admin: boolean, what: string): Promise<App> {
    const app = admin && isUuid(appId) ? await this.store.getApp(appId) : await memberApp(this.store, user, appId);
    if (!app) throw new ProductionReviewError(`No app of yours with id '${appId}'`);
    if (admin) return app;
    const role = await appRole(this.store, user, app);
    if (role !== "owner" && role !== "admin")
      throw new ProductionReviewError(`Only the workspace's owners and admins ${what}: it spends Mynt's review budget for the workspace. Members read its result (list_production_reviews) and ask them`);
    return app;
  }

  async request(user: Pick<User, "id">, appId: string, buildId: string | undefined, o: { admin: boolean }) {
    const app = await this.managed(user, appId, o.admin, "request a production code review");
    if (!this.enabled) throw new ProductionReviewError("Production code reviews can't run on this deployment yet: they need Mynt's agent sandboxes, its model backend and its repository host");
    if (buildId !== undefined && !isUuid(buildId)) throw new ProductionReviewError(`Build '${buildId}' isn't a build of this app`);
    const c = this.config;
    if (!c.workflows.length) throw new ProductionReviewError("PRODUCTION_REVIEW_WORKFLOWS names no workflow: a Mynt admin must set it");
    const out = await inTransaction(this.db, async (tx) => {
      const one = async (sql: string, params: unknown[]) => (await tx.query(sql, params)).rows[0] as Row | undefined;
      await lockAppStage(tx, app.id);
      if (app.workspace_id) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`mynt.production_reviews:${app.workspace_id}`]);
        const why = await frozenReason(tx, app.workspace_id);
        if (why) throw new ProductionReviewError(`${why}; no review starts in it meanwhile`);
      }
      const build = buildId
        ? await one(`SELECT * FROM ${T}.build_runs WHERE id = $1 AND app_id = $2`, [buildId, app.id])
        : await one(`SELECT * FROM ${T}.build_runs WHERE app_id = $1 AND status = 'succeeded' ORDER BY COALESCE(finished_at, updated_at) DESC, created_at DESC LIMIT 1`, [app.id]);
      if (!build) throw new ProductionReviewError(buildId ? `Build '${buildId}' isn't a build of this app` : "This app has no build that passed Mynt's verification yet: a production code review is for a verified build (start_build)");
      const name = `Build ${short(build.id)}`;
      if (build.status !== "succeeded") throw new ProductionReviewError(`${name} is ${build.status}: a production code review is for a build that passed Mynt's verification`);
      if (!build.repository || !/^[0-9a-f]{40}$/.test(String(build.commit_sha ?? ""))) throw new ProductionReviewError(`${name} pushed no commit, so it can't go online and there is nothing to review: build again in the app's repository`);
      const active = await one(`SELECT id, build_id, status FROM ${T}.production_reviews WHERE app_id = $1 AND status = ANY($2)`, [app.id, REVIEW_ACTIVE]);
      if (active) throw new ProductionReviewError(`A production code review of build ${short(active.build_id)} is already ${active.status} for this ${app.kind === "service" ? "service" : "app"} (${active.id}): wait for it, or stop it first (stop_production_review)`);
      const done = await one(`SELECT id, finished_at FROM ${T}.production_reviews WHERE app_id = $1 AND build_id = $2 AND status = 'complete'`, [app.id, build.id]);
      if (done) throw new ProductionReviewError(`${name} already has a complete production code review (${done.id}, finished ${iso(done.finished_at)!.slice(0, 10)}): get_production_review shows it. A review is for one build; a new build needs its own`);
      // The workspace's monthly limits, for what its own people start. A Mynt admin's start is Mynt's own decision.
      if (!o.admin && app.workspace_id) {
        const used = await this.usage(tx, app.workspace_id);
        if (used.reviews >= c.workspaceMonthly)
          throw new ProductionReviewError(
            `This workspace has started ${used.reviews} of its ${c.workspaceMonthly} production code reviews for ${used.month} (PRODUCTION_REVIEW_WORKSPACE_MONTHLY). The count starts again on the 1st; before then, ask a Mynt admin, who can start one or raise the limit`,
          );
        if (used.usd + c.capUsd > c.workspaceMonthlyUsd)
          throw new ProductionReviewError(
            `This workspace's production code reviews have used US$${used.usd.toFixed(2)} of its US$${c.workspaceMonthlyUsd} for ${used.month} (a review in progress counts at its cap), and one more may spend up to US$${c.capUsd} (PRODUCTION_REVIEW_WORKSPACE_MONTHLY_USD). It starts again on the 1st; before then, ask a Mynt admin, who can start one or raise the limit`,
          );
      }
      const id = randomUUID();
      await tx.query(
        `INSERT INTO ${T}.production_reviews (id, app_id, workspace_id, build_id, source_sha256, commit_sha, repository, status, workflows, minutes, cap_usd, model, tool_commit, requested_by, by_admin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11, $12, $13, $14)`,
        [id, app.id, app.workspace_id, build.id, build.source_sha256 ?? null, build.commit_sha, build.repository, c.workflows, Math.round(c.minutes), c.capUsd, c.model, this.builds.config.maxwellCommit ?? "", user.id, o.admin],
      );
      return { id, build_id: build.id as string };
    });
    await this.store.audit(user.id, "request_production_review", app.id, { app_id: app.id, workspace_id: app.workspace_id, review_id: out.id, build_id: out.build_id, by_mynt_admin: o.admin, limits: this.limits() });
    return this.get(out.id);
  }

  async row(id: string) {
    return isUuid(id) ? this.one(`${SELECT} WHERE r.id = $1`, [id]) : undefined;
  }
  private async get(id: string, o: { findings?: boolean; admin?: boolean } = {}) {
    return reviewView((await this.row(id))!, o);
  }

  /** One review with its findings, for a member of the app's workspace or a Mynt admin; and its build's waiver. */
  async read(user: Pick<User, "id">, id: string, o: { admin: boolean }) {
    const r = await this.row(id);
    if (!r || !(o.admin || (await memberApp(this.store, user, r.app_id as string)))) throw new ProductionReviewError(`No production code review of yours with id '${id}'`);
    const { waiver } = await reviewStanding(this.db, r.app_id as string, r.build_id as string);
    return { ...reviewView(r, { findings: true, admin: o.admin }), waiver: waiver ? waiverView(waiver) : null };
  }

  /** Reviews, newest first: one app's (any member of its workspace), or every app's the caller can see. */
  async list(user: Pick<User, "id">, f: { appId?: string; status?: ProductionReviewStatus; limit?: number }, o: { admin: boolean }) {
    const where: string[] = [];
    const params: unknown[] = [];
    const p = (v: unknown) => `$${params.push(v)}`;
    let app: App | undefined;
    if (f.appId !== undefined) {
      app = o.admin && isUuid(f.appId) ? await this.store.getApp(f.appId) : await memberApp(this.store, user, f.appId);
      if (!app) throw new ProductionReviewError(`No app of yours with id '${f.appId}'`);
      where.push(`r.app_id = ${p(app.id)}`);
    } else if (!o.admin) where.push(`r.workspace_id IN (SELECT workspace_id FROM ${T}.workspace_members WHERE user_id = ${p(user.id)})`);
    if (f.status) where.push(`r.status = ${p(f.status)}`);
    const rows = await this.all(`${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY r.created_at DESC LIMIT ${p(Math.min(Math.max(f.limit ?? 100, 1), 500))}`, params);
    const waivers = await this.all(
      `SELECT w.*, u.name AS waived_by_name FROM ${T}.production_review_waivers w LEFT JOIN ${T}.users u ON u.id = w.waived_by
       WHERE ${app ? "w.app_id = $1" : o.admin ? "$1::text IS NULL" : `w.workspace_id IN (SELECT workspace_id FROM ${T}.workspace_members WHERE user_id::text = $1)`} ORDER BY w.created_at DESC LIMIT 500`,
      [app ? app.id : o.admin ? null : user.id],
    );
    // For one app: the verified builds a review can be asked for (those that pushed a commit), newest first, and
    // whether this caller may ask.
    const role = app && !o.admin ? await appRole(this.store, user, app) : null;
    const builds = app
      ? (
          await this.all(
            `SELECT b.id::text AS id, COALESCE(b.finished_at, b.updated_at) AS at, b.commit_sha,
               (SELECT r.status FROM ${T}.production_reviews r WHERE r.app_id = b.app_id AND r.build_id = b.id ORDER BY (r.status = 'complete') DESC, r.created_at DESC LIMIT 1) AS review_status
             FROM ${T}.build_runs b WHERE b.app_id = $1 AND b.status = 'succeeded' AND b.repository IS NOT NULL AND b.commit_sha IS NOT NULL
             ORDER BY COALESCE(b.finished_at, b.updated_at) DESC, b.created_at DESC LIMIT 10`,
            [app.id],
          ).catch(() => [])
        ).map((b) => ({ id: b.id as string, verified_at: iso(b.at), commit_sha: (b.commit_sha as string | null) ?? null, review_status: (b.review_status as string | null) ?? null }))
      : null;
    return {
      reviews: rows.map((r) => reviewView(r)),
      waivers: waivers.map(waiverView),
      // What a review asked for now would run with: how long it may take and what it may cost at most.
      limits: this.limits(),
      available: this.enabled,
      ...(app ? { builds, can_request: o.admin || role === "owner" || role === "admin" } : {}),
      ...(app?.workspace_id ? { workspace_usage: await this.usage(this.db, app.workspace_id) } : {}),
    };
  }

  async stop(user: Pick<User, "id">, id: string, o: { admin: boolean }) {
    const r = await this.row(id);
    if (!r || !(o.admin || (await memberApp(this.store, user, r.app_id as string)))) throw new ProductionReviewError(`No production code review of yours with id '${id}'`);
    await this.managed(user, r.app_id as string, o.admin, "stop a production code review");
    if (!REVIEW_ACTIVE.includes(r.status as ProductionReviewStatus)) throw new ProductionReviewError(`This review has already ended (${r.status})`);
    // What it had found and spent so far is kept: read before its sandbox goes.
    const measured = r.sandbox_id && r.step === "reviewing" ? await this.measure(r).catch(() => null) : null;
    if (r.sandbox_id && this.sandboxes) {
      await this.sandboxes.exec(r.sandbox_id as string, AUDITOR_KILL, { timeoutSeconds: 30 }).catch(() => undefined);
      await this.sandboxes.stop(r.sandbox_id as string).catch(() => undefined);
    }
    const who = (await this.store.getUser(user.id))?.name ?? "someone";
    const ended = await this.finish(r, "stopped", {
      problem: "stopped",
      reason: `Stopped by ${o.admin ? "a Mynt admin" : who} before it finished`,
      next_step: REVIEW_NEXT.stopped,
      stopped_by: user.id,
      ...(measured?.fields ?? {}),
    });
    if (!ended) throw new ProductionReviewError("This review ended while it was being stopped");
    await this.store.audit(user.id, "stop_production_review", r.app_id as string, { app_id: r.app_id, workspace_id: r.workspace_id, review_id: id, build_id: r.build_id, by_mynt_admin: o.admin });
    return this.get(id);
  }

  /**
   * A Mynt admin's exception for one build: it may go to Production without a complete review, for the reason given.
   * Never for a finding: a build whose review recorded a critical or high finding isn't waived. The admin is outside
   * the app's workspace, as for a sign-off.
   */
  async waive(admin: Pick<User, "id">, appId: string, buildId: string, reason: string) {
    const app = isUuid(appId) ? await this.store.getApp(appId) : undefined;
    if (!app) throw new ProductionReviewError(`No app with id '${appId}'`);
    const text = reason.replace(/\s+/g, " ").trim();
    if (text.length < 20) throw new ProductionReviewError("Give the reason in a sentence (at least 20 characters): it is shown on the promotion checks and kept in the audit trail");
    const build = isUuid(buildId) ? await this.one(`SELECT id, status FROM ${T}.build_runs WHERE id = $1 AND app_id = $2`, [buildId, app.id]).catch(() => undefined) : undefined;
    if (!build || build.status !== "succeeded") throw new ProductionReviewError(`Build '${buildId}' isn't a build of this app that passed Mynt's verification`);
    if (await this.one(`SELECT 1 FROM ${T}.workspace_members m WHERE m.workspace_id = $1 AND m.user_id = $2`, [app.workspace_id, admin.id]))
      throw new ProductionReviewError("You're a member of this app's workspace; a Mynt admin outside it records the exception");
    const { review } = await reviewStanding(this.db, app.id, build.id as string);
    if (review?.status === "complete" && seriousOf(review.report) === 0) throw new ProductionReviewError(`Build ${short(build.id)} already passed its production code review: there is nothing to waive`);
    if (review && seriousOf(review.report) > 0)
      throw new ProductionReviewError(`The review of build ${short(build.id)} recorded ${seriousOf(review.report)} critical or high finding(s). An exception is for a review that can't finish, never for its findings: they are fixed in a new build`);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO ${T}.production_review_waivers (id, app_id, workspace_id, build_id, reason, waived_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (app_id, build_id) DO UPDATE SET reason = EXCLUDED.reason, waived_by = EXCLUDED.waived_by, created_at = now()`,
      [id, app.id, app.workspace_id, build.id, text, admin.id],
    );
    await this.store.audit(admin.id, "waive_production_review", app.id, { app_id: app.id, workspace_id: app.workspace_id, build_id: build.id, reason: text, review_id: review?.id ?? null, review_status: review?.status ?? null, review_problem: review?.problem ?? null });
    const { waiver } = await reviewStanding(this.db, app.id, build.id as string);
    return { waiver: waiverView(waiver!), review: review ? await this.get(review.id as string) : null };
  }

  // ---- the reviewer's model calls (agent-proxy.ts) ----

  // Its own meter key, budget and model; valid only while the review runs.
  async agentRun(token: string): Promise<AgentRun | null> {
    const r = await this.one(`SELECT id, cap_usd, model FROM ${T}.production_reviews WHERE token_hash = $1 AND status = 'running'`, [hashToken(token)]);
    return r ? { key: `production-review:${r.id}`, capUsd: Number(r.cap_usd), model: r.model as string } : null;
  }

  // ---- the worker ----

  startWorker(intervalMs = Number(process.env.PRODUCTION_REVIEW_POLL_MS ?? 15000)) {
    if (this.timer || !this.sandboxes) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "production review worker");
  }
  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Tests call tick() directly.
  async tick() {
    if (!this.sandboxes) return;
    for (const r of await this.all(`${SELECT} WHERE r.status = ANY($1) ORDER BY r.created_at`, [REVIEW_ACTIVE])) {
      const id = r.id as string;
      try {
        await this.advance(r);
        this.transient.clear(id);
      } catch (e) {
        if (this.transient.rideOut(id, e)) continue;
        if (r.sandbox_id) await this.sandboxes.stop(r.sandbox_id as string).catch(() => undefined);
        const message = clip(redact(failureMessage(e)), 600);
        await this.finish(r, "failed", { problem: "error", reason: `The review couldn't run: ${message}`, next_step: REVIEW_NEXT.error });
      }
    }
  }

  // Ends a review that is still going; false when it had already ended (stopped meanwhile, say).
  private async finish(r: Row, status: ProductionReviewStatus, f: Row) {
    const set = { ...f, status, step: null, token_hash: null };
    const keys = Object.keys(set) as (keyof typeof set)[];
    const json = new Set(["report", "run"]);
    const done = await this.one(
      `UPDATE ${T}.production_reviews SET ${keys.map((k, i) => `${String(k)} = $${i + 3}`).join(", ")}, finished_at = now(), updated_at = now() WHERE id = $1 AND status = ANY($2) RETURNING id`,
      [r.id, REVIEW_ACTIVE, ...keys.map((k) => (json.has(String(k)) && set[k] != null ? JSON.stringify(set[k]) : set[k]))],
    );
    if (done && status !== "stopped")
      await this.store.audit(null, "production_review_finished", r.app_id as string, { app_id: r.app_id, workspace_id: r.workspace_id, review_id: r.id, build_id: r.build_id, status, problem: f.problem ?? null, cost_usd: f.cost_usd ?? num(r.cost_usd) });
    return !!done;
  }

  // What the review has spent and found so far, read from Mynt's meter, the sandbox host and the report file.
  private async measure(r: Row) {
    const sandboxes = this.sandboxes!;
    const sid = r.sandbox_id as string;
    const auditor = await agentState(sandboxes, sid, r.process_id as string);
    const meter = this.builds.meter;
    const modelUsd = Math.max(auditor.cost, meter ? await meter.spent(`production-review:${r.id}`) : 0);
    const sandboxUsd = await sandboxes.costDollars(sid);
    const report = parse<MaxwellReport>(await sandboxes.readFile(sid, AUDIT_REPORT_FILE));
    return { auditor, modelUsd, report, fields: { model_cost_usd: modelUsd, sandbox_cost_usd: sandboxUsd, cost_usd: modelUsd + sandboxUsd, ...(report ? { report } : {}) } as Row };
  }

  // A short-lived token to read the build's repository, through the connection its builder made (or the host's own
  // installation on it). Null when Mynt can no longer reach it.
  private async sourceToken(r: Row) {
    const repos = this.builds.repos!;
    const repository = String(r.repository);
    const conn = await this.one(`SELECT c.installation_id FROM ${T}.repo_connections c JOIN ${T}.build_runs b ON b.developer_id = c.developer_id WHERE b.id = $1 AND c.repository = $2`, [r.build_id, repository.toLowerCase()]);
    const installation = conn ? Number(conn.installation_id) : await repos.installationFor(repository);
    if (!installation) return null;
    return (await repos.tokenFor(repository, installation)).token;
  }

  private async advance(r: Row) {
    const sandboxes = this.sandboxes!;
    const id = r.id as string;
    const minutes = Number(r.minutes);
    const capUsd = Number(r.cap_usd);
    const workflows = r.workflows as string[];

    if (r.status === "queued") {
      const running = await this.one(`SELECT count(*)::int AS n FROM ${T}.production_reviews WHERE status = 'running'`);
      if (Number(running!.n) >= this.config.maxRunning) return;
      // A clean machine of its own, with no secrets: it holds the source and the reviewer, nothing else.
      const s = await sandboxes.createSandbox({ name: `mynt-review-${id}`, type: this.builds.config.sandboxType, ttlSeconds: minutes * 60 + 1800, labels: { mynt_review: id, mynt_role: "review" }, env: {} });
      const took = await this.one(`UPDATE ${T}.production_reviews SET status = 'running', step = 'provisioning', sandbox_id = $2, started_at = now(), updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING id`, [id, s.id]);
      if (!took) await sandboxes.stop(s.id).catch(() => undefined);
      return;
    }
    const sid = r.sandbox_id as string;

    if (r.step === "provisioning") {
      const state = (await sandboxes.getSandbox(sid)).state;
      if (state === "error" || state === "cancelled") throw new Error(`The review's sandbox ended as ${state}`);
      if (!["ready", "idle", "running"].includes(state)) return;
      const repository = String(r.repository ?? "");
      const commit = String(r.commit_sha ?? "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("The build has no repository and commit to review");
      const token = await this.sourceToken(r);
      if (!token) {
        await sandboxes.stop(sid).catch(() => undefined);
        await this.finish(r, "failed", { problem: "source", reason: `Mynt can't read ${repository} any more, so it couldn't fetch the commit build ${short(r.build_id)} pushed`, next_step: REVIEW_NEXT.source });
        return;
      }
      // The reviewer's copy: the commit's archive, unpacked read-only, and Mynt's own hash of every file in it. The
      // token goes in a file the script deletes before it does anything else; it is never in a command or the machine's
      // environment, and it is gone before the reviewer starts.
      await sandboxes.writeFile(sid, `${VERIFY_DIR}/verify.sh`, VERIFY_SCRIPT);
      const header = `${VERIFY_DIR}/source.header`;
      await sandboxes.writeFile(sid, header, `Authorization: Bearer ${token}\n`);
      const copy = await sandboxes.exec(sid, `bash ${VERIFY_DIR}/verify.sh --review-copy 'https://api.github.com/repos/${repository}/tarball/${commit}' ${header}`, { timeoutSeconds: 600 });
      const tree = copy.stdout.match(/^audit-copy ([0-9a-f]{64})$/m)?.[1];
      if (copy.exitCode !== 0 || !tree) {
        await sandboxes.exec(sid, `rm -f ${header}`, { timeoutSeconds: 30 }).catch(() => undefined);
        await sandboxes.stop(sid).catch(() => undefined);
        await this.finish(r, "failed", { problem: "source", reason: `Mynt couldn't fetch the commit build ${short(r.build_id)} pushed (${clip(redact((copy.stderr || copy.stdout || "no output").trim(), [token]), 200)})`, next_step: REVIEW_NEXT.source });
        return;
      }
      const agentToken = `mynt_agent_${randomBytes(24).toString("base64url")}`;
      await this.update(id, { token_hash: hashToken(agentToken) });
      const job = auditorJob({ maxwellRepo: this.builds.config.maxwellRepo, maxwellCommit: (r.tool_commit as string | null) ?? this.builds.config.maxwellCommit }, { workflows, minutes, budgetUsd: capUsd, model: r.model as string, attempt: 1, attempts: 1 });
      const processId = await launchAgent(sandboxes, this.builds.config, sid, { ...job, model: r.model as string, token: agentToken });
      await this.db.query(`UPDATE ${T}.production_reviews SET step = 'reviewing', process_id = $2, tree_sha256 = $3, review_started_at = now(), updated_at = now() WHERE id = $1`, [id, processId, tree]);
      return;
    }

    if (r.step !== "reviewing" || !r.process_id) throw new Error("The review's record is incomplete");
    const m = await this.measure(r);
    // Findings are kept as they are recorded: the report file is the reviewer's script's, rewritten from the tool's
    // ledger at every look.
    if (m.fields.cost_usd !== num(r.cost_usd) || JSON.stringify(m.report ?? null) !== JSON.stringify(r.report ?? null)) await this.update(id, m.fields);
    const { auditor } = m;
    const timedOut = auditor.running && Date.now() - Date.parse(String(r.review_started_at)) > minutes * 60_000;
    const outOfBudget = m.modelUsd >= capUsd || auditor.state?.last_subtype === "error_max_budget_usd";
    if (auditor.running && !timedOut && !outOfBudget) return;

    // Ended, or out of time or budget: the reviewer and everything it started are ended before Mynt reads the report
    // and hashes the source again.
    await sandboxes.exec(sid, AUDITOR_KILL, { timeoutSeconds: 30 }).catch(() => undefined);
    const rehash = await sandboxes.exec(sid, `bash ${VERIFY_DIR}/verify.sh --rehash`, { timeoutSeconds: 300 }).catch(() => null);
    const after = rehash?.stdout.match(/^rehash ([0-9a-f]{64})$/m)?.[1];
    const [reportText, changedText] = await Promise.all([sandboxes.readFile(sid, AUDIT_REPORT_FILE), sandboxes.readFile(sid, `${VERIFY_DIR}/changed.txt`).catch(() => null)]);
    const report = parse<MaxwellReport>(reportText);
    const fields: Row = { ...m.fields, report: report ?? null };
    const end = async (status: ProductionReviewStatus, f: Row) => {
      await sandboxes.stop(sid).catch(() => undefined);
      await this.finish(r, status, { ...fields, ...f });
    };
    if (!after || after !== r.tree_sha256) {
      const files = after ? (changedText ?? "").split("\n").map((l) => l.trim()).filter(Boolean) : [];
      return end("failed", {
        problem: "changed",
        reason: `The reviewer's read-only copy of the source ${after ? `changed during the review${files.length ? ` (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""})` : ""}` : "couldn't be hashed again after the review"}; the result can't be trusted`,
        next_step: REVIEW_NEXT.changed,
      });
    }
    const problem = auditOutcome({ report, workflows, timedOut, outOfBudget, minutes, capUsd, spentUsd: m.modelUsd, attempt: 1, runner: auditor.state });
    if (!problem) return end("complete", { problem: null, reason: null, next_step: null });

    // Not complete. What it covered and found so far is said with the reason, and the reviewer's own account of the
    // run is kept for the admins who must put it right: the sandbox, the only other record of it, goes next.
    const log = await sandboxes
      .exec(sid, `tail -c 1500 ${AGENT_DIR}/runner.log 2>/dev/null; echo; tail -n 3 ${AGENT_DIR}/agent.jsonl 2>/dev/null | cut -c1-600`, { timeoutSeconds: 30 })
      .then((x) => x.stdout ?? "")
      .catch(() => "");
    const s = auditor.state;
    const run = { result: timedOut ? `timed out after ${minutes} min` : outOfBudget ? `out of its US$${capUsd} budget` : (s?.last_subtype ?? null), exit_code: s?.exit_code ?? null, error: s?.error ? redact(s.error) : null, summary: s?.summary ? redact(s.summary).slice(0, 1500) : null, log: redact(log).slice(-3000) || null, report_written: !!report };
    const cover = reviewCoverage(report, workflows);
    const serious = seriousOf(report);
    const covered = !cover ? "" : `; so far it covers ${cover.reviewed.length ? cover.reviewed.join(", ") : "no workflow"}${serious ? `, with ${serious} critical or high finding(s)` : ""}`;
    const what =
      problem.kind === "time"
        ? `The review ran out of time (${minutes} min) before it finished`
        : problem.kind === "budget"
          ? `The review used up its US$${capUsd} budget before it finished`
          : problem.kind === "tool"
            ? `The review couldn't run: ${problem.detail}`
            : problem.kind === "refused"
              ? `The review didn't finish: ${problem.detail.replace("the audit's model", "its model")}`
              : `The review didn't finish: ${problem.detail}`;
    return end(STATUS_OF[problem.kind], { problem: problem.kind, reason: `${what}${covered}`, next_step: REVIEW_NEXT[problem.kind], run });
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const guard = async <X>(f: () => Promise<X>) => {
  try {
    return json(await f());
  } catch (e) {
    if (e instanceof ProductionReviewError) return fail(e.message);
    throw e;
  }
};

/** The production code review's tools. `admin`: a Mynt admin, who asks, stops and reads across workspaces. */
export function registerProductionReviewTools(server: McpServer, user: User, reviews: ProductionReviewService, o: { admin: boolean }) {
  server.registerTool(
    "request_production_review",
    {
      title: "Request a production code review",
      description:
        "Developer (an owner or admin of the app's workspace; Mynt admins for any app): ask Mynt for the full agent code review a build needs before it goes to Production. It reviews ONE verified build of an app or service (build_id; default: the latest build that passed Mynt's verification), exactly the commit that build pushed, in a clean sandbox, with Mynt's secure code review workflows (PRODUCTION_REVIEW_WORKFLOWS, default execute-scr). It is long: up to PRODUCTION_REVIEW_MINUTES (default 180) and PRODUCTION_REVIEW_CAP_USD (default 60) of Mynt's own budget, not the workspace's build budget; list_production_reviews gives the limits in force. So a workspace's own people start at most PRODUCTION_REVIEW_WORKSPACE_MONTHLY reviews (default 4) and PRODUCTION_REVIEW_WORKSPACE_MONTHLY_USD (default 200) per calendar month; one review per app runs at a time, and a build that already has a complete review isn't reviewed again. Returns the review, queued; follow it with get_production_review. Mynt reads the review tool's own ledger and decides: the reviewer never grades its work, and a review that ends without a complete report (out of time or budget, refused by the model provider, a broken tool) doesn't pass and isn't run again by itself; its reason says what to do.",
      inputSchema: { app_id: z.string(), build_id: z.string().optional().describe("A verified build of this app. Default: its latest verified build") },
    },
    async ({ app_id, build_id }) => guard(() => reviews.request(user, app_id, build_id, o)),
  );

  server.registerTool(
    "get_production_review",
    {
      title: "A production code review",
      description:
        "Developer (any member of the app's workspace; Mynt admins for any): one production code review: its build and commit, status (queued, running, complete, incomplete, refused, failed or stopped), findings by severity with each finding's title, file and workflow (as recorded so far while it runs), coverage (the workflows that finished, and those that didn't with why), Mynt's measured cost and time (null when not measured, never 0), the limits it ran with, the reason and next step when it isn't complete, and any exception a Mynt admin recorded for its build.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => guard(() => reviews.read(user, id, o)),
  );

  server.registerTool(
    "list_production_reviews",
    {
      title: "Production code reviews",
      description:
        "Developer (any member of the app's workspace; Mynt admins see every workspace's): production code reviews, newest first, for one app or service (app_id) or for every app you can see, optionally by status. Each has its build, status, findings by severity, coverage, cost, time, who started it and when. Also: the exceptions Mynt admins recorded (waivers, each for one build, with its reason), the limits a review asked for now would run with (how long it may take, what it may cost at most), whether reviews can run on this deployment and, for one app, the verified builds a review can be asked for, whether you may ask, and what its workspace has used of its monthly limits.",
      inputSchema: { app_id: z.string().optional(), status: z.enum(PRODUCTION_REVIEW_STATUSES).optional(), limit: z.number().int().min(1).max(500).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id, status, limit }) => guard(() => reviews.list(user, { appId: app_id, status, limit }, o)),
  );

  server.registerTool(
    "stop_production_review",
    {
      title: "Stop a production code review",
      description:
        "Developer (an owner or admin of the app's workspace; Mynt admins for any): stop a review that is queued or running. Its sandbox is ended; what it had found and spent so far is kept. A stopped review doesn't pass the production check, and one that had started still counts towards the workspace's monthly reviews.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => guard(() => reviews.stop(user, id, o)),
  );
}

export function registerProductionReviewAdminTools(server: McpServer, user: User, reviews: ProductionReviewService) {
  server.registerTool(
    "waive_production_review",
    {
      title: "Record an exception to the production code review",
      description:
        "Admin: record that one verified build of an app or service may go to Production without a complete production code review, with the reason (for example: the model provider's safeguards refuse the security review, with the request id). For that build only; a newer build needs its own review or its own exception. Never for findings: refused when the build's review recorded a critical or high finding, or already passed. Not for an app of a workspace you're a member of. Recorded in the audit trail and shown as it is, with your name and the reason, on the app's promotion checks ('Waived by a Mynt admin: …') and beside its reviews.",
      inputSchema: { app_id: z.string(), build_id: z.string(), reason: z.string().min(20).max(1000) },
    },
    async ({ app_id, build_id, reason }) => guard(() => reviews.waive(user, app_id, build_id, reason)),
  );
}
