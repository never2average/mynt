import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentMeter } from "./agent-meter.js";
import type { AgentRun } from "./agent-proxy.js";
import { serialLoop } from "./worker.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agentState, launchAgent, type AgentHostConfig } from "./agent-host.js";
import type { BoatClient } from "./boat.js";
import type { Db } from "./db.js";
import { DESK_RUNNER, type DeskOutcome, type DeskReport } from "./desk-runner.js";
import type { RepoAccess } from "./github.js";
import { REPO_DIR, startRepoRun } from "./repo-run.js";
import { findLicenses, normalizeModel } from "./regulatory.js";
import type { ProductRecord, Store, User } from "./store.js";

// The product desk: innovators work out whether a product makes sense, financially and legally.
// Each firm has a workspace: its own GitHub repository where its computational logic accumulates as
// models (models/<name>/model.json + code). The desk splits work by what it needs:
//   - code runs: when a model in the workspace applies and the term sheet has its inputs, Mynt clones
//     the repo in a sandbox and executes it. Deterministic, no model calls, re-runnable.
//   - agent tasks: intelligence-driven work (designing a model, interpreting the regulation, choosing
//     assumptions) goes to Claude Code in a sandbox, which writes the model and its tests and pushes a
//     branch. Mynt then runs that code itself in a clean sandbox for the official report and opens a
//     pull request on the workspace; the agent's own numbers are never taken on trust.

export interface DeskConfig extends AgentHostConfig {
  jobCapUsd: number; // an agent task
  runCapUsd: number; // a code run: machine time only
  monthlyCapUsd: number; // per firm
  sandboxType: string;
}

export function deskConfigFromEnv(host: AgentHostConfig, env = process.env): DeskConfig {
  return {
    ...host,
    jobCapUsd: Number(env.DESK_JOB_CAP_USD ?? 5),
    runCapUsd: Number(env.DESK_RUN_CAP_USD ?? 1),
    monthlyCapUsd: Number(env.DESK_MONTHLY_CAP_USD ?? 50),
    sandboxType: env.BUILD_SANDBOX_TYPE ?? "default",
  };
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.desk_workspaces (
    entity_id uuid PRIMARY KEY REFERENCES financial_products.entities(id),
    repository text NOT NULL,
    installation_id bigint NOT NULL,
    connected_by uuid NOT NULL REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.product_terms (
    product_id text PRIMARY KEY,
    terms jsonb NOT NULL,
    terms_hash text NOT NULL,
    updated_by uuid NOT NULL REFERENCES financial_products.users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.desk_jobs (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    product_id text,
    kind text NOT NULL CHECK (kind IN ('run', 'agent')),
    goal text,
    model text,
    status text NOT NULL,
    phase_message text,
    sandbox_id text,
    process_id text,
    verify_sandbox_id text,
    verify_process_id text,
    token_hash text,
    branch text,
    pr_url text,
    terms_hash text,
    outcome jsonb,
    escalate boolean NOT NULL DEFAULT false,
    agent_cap_usd numeric,
    cost_usd numeric NOT NULL DEFAULT 0,
    cap_usd numeric NOT NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS desk_jobs_entity_idx ON financial_products.desk_jobs (entity_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS financial_products.desk_reports (
    id uuid PRIMARY KEY,
    product_id text NOT NULL,
    terms_hash text NOT NULL,
    job_id uuid NOT NULL,
    model text NOT NULL,
    commit_sha text,
    ref text NOT NULL,
    report jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS desk_reports_product_idx ON financial_products.desk_reports (product_id, created_at DESC);
`;

const DONE = ["finished", "failed", "stopped"];
const DIR = "/home/user/mynt-desk";
const JOB = `${DIR}/job`;
const WORKSPACE = REPO_DIR;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
export const termsHash = (terms: unknown) => hash(stable(terms));
const parse = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

export interface Terms {
  inputs: Record<string, number | string | boolean>;
  assumptions?: Record<string, unknown>;
}

type Row = Record<string, unknown>;

export class DeskService {
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly boat: BoatClient | null,
    readonly repos: RepoAccess | null,
    readonly config: DeskConfig,
  ) {}

  static async open(db: Db, store: Store, boat: BoatClient | null, repos: RepoAccess | null, config: DeskConfig) {
    await db.exec(TABLES);
    return new DeskService(db, store, boat, repos, config);
  }

  // Code runs need a sandbox host and the GitHub App; agent tasks also need a model backend.
  get enabled() {
    return !!this.boat && !!this.repos;
  }

  get agentsEnabled() {
    return this.enabled && !!this.config.agentBackend && !!this.config.publicUrl;
  }

  private async all(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as Row[];
  }

  private async one(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }

  // ---- workspace and term sheets ----

  async connectWorkspace(entityId: string, userId: string, repository: string) {
    if (!this.repos) throw new Error("The product desk isn't enabled on this Mynt yet");
    const installation = await this.repos.installationFor(repository);
    if (!installation) throw new Error(`Install the Mynt GitHub App on ${repository} first: ${this.repos.installUrl()}`);
    await this.db.query(
      `INSERT INTO financial_products.desk_workspaces (entity_id, repository, installation_id, connected_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entity_id) DO UPDATE SET repository = EXCLUDED.repository, installation_id = EXCLUDED.installation_id, connected_by = EXCLUDED.connected_by`,
      [entityId, repository.toLowerCase(), installation, userId],
    );
  }

  async workspace(entityId: string) {
    const r = await this.one("SELECT repository, installation_id, created_at FROM financial_products.desk_workspaces WHERE entity_id = $1", [entityId]);
    return r ? { repository: r.repository as string, installation_id: Number(r.installation_id), created_at: r.created_at } : null;
  }

  async setTerms(productId: string, userId: string, terms: Terms) {
    const h = termsHash(terms);
    await this.db.query(
      `INSERT INTO financial_products.product_terms (product_id, terms, terms_hash, updated_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id) DO UPDATE SET terms = EXCLUDED.terms, terms_hash = EXCLUDED.terms_hash, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [productId, JSON.stringify(terms), h, userId],
    );
    return h;
  }

  async terms(productId: string) {
    const r = await this.one("SELECT terms, terms_hash, updated_at FROM financial_products.product_terms WHERE product_id = $1", [productId]);
    return r ? { terms: r.terms as Terms, terms_hash: r.terms_hash as string, updated_at: r.updated_at } : null;
  }

  // The latest report for the product's current term sheet, if any.
  async feasibility(productId: string) {
    const t = await this.terms(productId);
    const latest = await this.one("SELECT * FROM financial_products.desk_reports WHERE product_id = $1 ORDER BY created_at DESC LIMIT 1", [productId]);
    const current = t ? await this.one("SELECT * FROM financial_products.desk_reports WHERE product_id = $1 AND terms_hash = $2 ORDER BY created_at DESC LIMIT 1", [productId, t.terms_hash]) : undefined;
    return { terms: t, current: current ?? null, stale: !current && !!latest, latest: latest ?? null };
  }

  // What the regulation says about this kind of product, from the admins' regulatory model, so models
  // can check limits and cite them by legal_ref.
  private async regulatoryContext(p: ProductRecord) {
    const region = (await this.store.referenceData(true)).regions.find((r) => r.code === p.product.region);
    if (!region) return [];
    const model = normalizeModel(region.regulatory);
    const regulators = new Set(findLicenses(model, { category: p.product.category }).map((l) => l.regulator.id));
    const law = model.legal.legislative
      .filter((l) => regulators.has(l.issued_by ?? "") || (l.applies_to?.regulators ?? []).some((r) => regulators.has(r)))
      .slice(0, 60)
      .map((l) => ({ legal_ref: l.id, kind: l.kind, title: l.title, issued_by: l.issued_by, status: l.status, summary: l.summary, url: l.url }));
    return [{ regulators: [...regulators] }, ...law];
  }

  // ---- jobs ----

  async monthSpend(entityId: string) {
    return Number((await this.one("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM financial_products.desk_jobs WHERE entity_id = $1 AND created_at >= date_trunc('month', now())", [entityId]))?.s ?? 0);
  }

  // What this month is committed to: finished jobs at what they cost, unfinished ones at their cap.
  async monthCommitted(entityId: string) {
    const r = await this.one(
      `SELECT COALESCE(SUM(CASE WHEN status = ANY($2) THEN cost_usd ELSE cap_usd END), 0) AS s FROM financial_products.desk_jobs
       WHERE entity_id = $1 AND created_at >= date_trunc('month', now())`,
      [entityId, DONE],
    );
    return Number(r?.s ?? 0);
  }

  async job(id: string) {
    const r = await this.one("SELECT * FROM financial_products.desk_jobs WHERE id::text = $1", [id]);
    if (!r) return null;
    const { token_hash: _, ...job } = r;
    return job;
  }

  async jobs(entityId: string, limit = 30) {
    return (await this.all("SELECT * FROM financial_products.desk_jobs WHERE entity_id = $1 ORDER BY created_at DESC LIMIT $2", [entityId, limit])).map(({ token_hash: _, ...j }) => j);
  }

  async start(user: User, o: { kind: "run" | "agent"; product_id?: string; goal?: string; model?: string; cap_usd?: number; escalate?: boolean }) {
    if (!this.enabled) throw new Error("The product desk isn't enabled on this Mynt yet");
    if (o.kind === "agent" && !this.agentsEnabled) throw new Error("Desk agents aren't enabled on this Mynt yet");
    if (!user.entity_id) throw new Error("Join or create your firm first (create_entity)");
    if (!(await this.workspace(user.entity_id))) throw new Error("Connect your firm's workspace repository first (connect_desk_repository)");
    let termsH: string | null = null;
    if (o.product_id) {
      const p = await this.store.getProduct(o.product_id);
      if (!p || (p.owner_id !== user.id && p.entity_id !== user.entity_id)) throw new Error(`No product of your firm's with id '${o.product_id}'`);
      termsH = (await this.terms(o.product_id))?.terms_hash ?? null;
      if (o.kind === "run" && !termsH) throw new Error("Set the product's term sheet first (set_product_terms)");
    }
    const max = o.kind === "agent" ? this.config.jobCapUsd : this.config.runCapUsd;
    const cap = Math.min(o.cap_usd ?? max, max);
    if ((await this.monthCommitted(user.entity_id)) + cap > this.config.monthlyCapUsd) throw new Error(`Your firm's monthly desk budget of US$${this.config.monthlyCapUsd} is used up`);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO financial_products.desk_jobs (id, entity_id, user_id, product_id, kind, goal, model, status, terms_hash, escalate, cap_usd, agent_cap_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8, $9, $10, $11)`,
      [id, user.entity_id, user.id, o.product_id ?? null, o.kind, o.goal ?? null, o.model ?? null, termsH, o.escalate ?? false, cap, o.kind === "run" ? (o.cap_usd ?? null) : null],
    );
    return (await this.job(id))!;
  }

  private async update(id: string, f: Row) {
    const keys = Object.keys(f);
    const done = typeof f.status === "string" && DONE.includes(f.status);
    await this.db.query(
      `UPDATE financial_products.desk_jobs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}${done ? ", finished_at = now(), token_hash = NULL" : ""} WHERE id = $1`,
      [id, ...keys.map((k) => (k === "outcome" ? JSON.stringify(f[k]) : f[k]))],
    );
  }

  private async end(j: Row, status: string, f: Row = {}) {
    for (const s of [j.sandbox_id, j.verify_sandbox_id]) if (s && this.boat) await this.boat.stop(s as string).catch(() => {});
    await this.update(j.id as string, { ...f, status });
  }

  async stop(id: string, reason: string) {
    const j = await this.one("SELECT * FROM financial_products.desk_jobs WHERE id::text = $1", [id]);
    if (!j || DONE.includes(j.status as string)) return;
    await this.end(j, "stopped", { error: reason });
  }

  async agentTokenActive(token: string) {
    return !!(await this.agentRun(token));
  }

  meter: AgentMeter | null = null;
  async agentRun(token: string): Promise<AgentRun | null> {
    const r = await this.one("SELECT id, cap_usd FROM financial_products.desk_jobs WHERE token_hash = $1 AND status <> ALL($2)", [hash(token), DONE]);
    return r ? { key: `desk:${r.id}`, capUsd: Number(r.cap_usd) } : null;
  }

  // A sandbox job that clones the workspace (at `ref`) and runs the desk runner, credentials removed first.
  private async startRun(j: Row, sandbox: string, ref: string | null) {
    const ws = (await this.workspace(j.entity_id as string))!;
    const p = (await this.store.getProduct(j.product_id as string))!;
    const t = (await this.terms(j.product_id as string))!;
    return startRepoRun(this.boat!, this.repos!, sandbox, {
      repository: ws.repository,
      installationId: ws.installation_id,
      ref,
      dir: DIR,
      outcome: `${JOB}/outcome.json`,
      cloneFailure: { outcome: "error", model: null, error: "Couldn't clone the workspace repository", log: "" },
      files: {
        [`${DIR}/desk-runner.mjs`]: DESK_RUNNER,
        [`${JOB}/product.json`]: JSON.stringify({ ...p.product, action: p.action }),
        [`${JOB}/terms.json`]: JSON.stringify({ ...t.terms, regulatory: await this.regulatoryContext(p) }),
        ...(j.model ? { [`${JOB}/model.txt`]: String(j.model) } : {}),
      },
      command: `node ${DIR}/desk-runner.mjs ${WORKSPACE} ${JOB}`,
    });
  }

  private async runOutcome(sandbox: string, processId: string) {
    if ((await this.boat!.commandStatus(sandbox, Number(processId))).running) return null;
    return parse<DeskOutcome>(await this.boat!.readFile(sandbox, `${JOB}/outcome.json`)) ?? { outcome: "error", model: null, error: "The run produced no outcome", log: "" };
  }

  private async saveReport(j: Row, o: Extract<DeskOutcome, { outcome: "ran" }>, ref: string) {
    await this.db.query(
      `INSERT INTO financial_products.desk_reports (id, product_id, terms_hash, job_id, model, commit_sha, ref, report) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), j.product_id, j.terms_hash, j.id, o.model, o.commit, ref, JSON.stringify(o.report)],
    );
  }

  private async newSandbox(j: Row, role: string, env: Record<string, string> = {}) {
    return (await this.boat!.createSandbox({ name: `mynt-desk-${role}-${j.id}`, type: this.config.sandboxType, ttlSeconds: 2 * 3600, labels: { mynt_desk: j.id as string, mynt_role: role }, env })).id;
  }

  private async ready(sandbox: string) {
    const s = await this.boat!.getSandbox(sandbox);
    if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}`);
    return ["ready", "idle", "running"].includes(s.state);
  }

  async tick() {
    if (!this.enabled) return;
    for (const j of await this.all("SELECT * FROM financial_products.desk_jobs WHERE status <> ALL($1) ORDER BY created_at", [DONE])) {
      try {
        await this.advance(j);
      } catch (e) {
        await this.end(j, "failed", { error: (e as Error).message });
      }
    }
  }

  private async advance(j: Row) {
    const boat = this.boat!;
    if (j.status === "queued") {
      let env: Record<string, string> = {};
      if (j.kind === "agent") {
        const ws = (await this.workspace(j.entity_id as string))!;
        const { token } = await this.repos!.tokenFor(ws.repository, ws.installation_id);
        env = { GITHUB_REPOSITORY: ws.repository, GITHUB_TOKEN: token, MYNT_BRANCH: `mynt/desk-${String(j.id).slice(0, 8)}` };
      }
      const sandbox = await this.newSandbox(j, j.kind as string, env);
      await this.update(j.id as string, { status: "provisioning", sandbox_id: sandbox, branch: env.MYNT_BRANCH ?? null, phase_message: "Sandbox requested" });
      return;
    }

    const cost = (await boat.costDollars(j.sandbox_id as string)) + (j.verify_sandbox_id ? await boat.costDollars(j.verify_sandbox_id as string) : 0);
    const agentCost = j.kind === "agent" && j.process_id ? (await agentState(boat, j.sandbox_id as string, j.process_id as string)).cost : 0;
    const total = cost + Math.max(agentCost, this.meter ? await this.meter.spent(`desk:${j.id}`) : 0);
    if (total !== Number(j.cost_usd)) await this.update(j.id as string, { cost_usd: total });
    if (total > Number(j.cap_usd)) return this.end(j, "stopped", { error: `Stopped at US$${total.toFixed(2)}: over the US$${j.cap_usd} cap`, cost_usd: total });

    if (j.status === "provisioning") {
      if (!(await this.ready(j.sandbox_id as string))) return;
      if (j.kind === "run") {
        const pid = await this.startRun(j, j.sandbox_id as string, null);
        await this.update(j.id as string, { status: "running", process_id: pid, phase_message: "Running the workspace's model" });
      } else {
        const token = `mynt_desk_${randomBytes(24).toString("base64url")}`;
        await this.update(j.id as string, { token_hash: hash(token) });
        await boat.writeFile(j.sandbox_id as string, `${DIR}/desk-runner.mjs`, DESK_RUNNER);
        const pid = await launchAgent(boat, this.config, j.sandbox_id as string, {
          prompt: "Do the job in job/spec.json, following CLAUDE.md and its skills.",
          budgetUsd: Number(j.cap_usd) - total,
          token,
          workspace: "product-desk",
          jobFiles: { "job/spec.json": JSON.stringify(await this.spec(j), null, 2) },
        });
        await this.update(j.id as string, { status: "coding", process_id: pid, phase_message: "The desk agent is working" });
      }
      return;
    }

    if (j.status === "running") {
      const o = await this.runOutcome(j.sandbox_id as string, j.process_id as string);
      if (!o) return;
      if (o.outcome === "ran") {
        await this.saveReport(j, o, "default branch");
        return this.end(j, "finished", { outcome: o, model: o.model, phase_message: `${o.report.verdict}: ${o.report.summary}`.slice(0, 500) });
      }
      // Nothing in the workspace models this product yet: that's intelligence work for the agent.
      if (o.outcome === "no_model" && j.escalate && this.agentsEnabled) {
        await this.end(j, "finished", { outcome: o, phase_message: "No model applies yet; handed to the desk agent" });
        const user = (await this.store.getUser(j.user_id as string))!;
        await this.start(user, { kind: "agent", product_id: j.product_id as string, goal: "Build a feasibility model for this product (none in the workspace applies yet), then run it.", cap_usd: j.agent_cap_usd ? Number(j.agent_cap_usd) : undefined });
        return;
      }
      const message =
        o.outcome === "missing_inputs"
          ? `Model ${o.model} needs: ${o.missing.map((m) => m.key + (m.unit ? ` (${m.unit})` : "")).join(", ")}; add them with set_product_terms`
          : o.outcome === "no_model"
            ? "No model in the workspace applies to this product; run desk_task to have the agent build one"
            : `${o.error}`;
      return this.end(j, o.outcome === "error" ? "failed" : "finished", { outcome: o, phase_message: message, error: o.outcome === "error" ? o.error : null });
    }

    if (j.status === "coding") {
      const agent = await agentState(boat, j.sandbox_id as string, j.process_id as string);
      if (agent.running) return;
      if (!agent.ok) throw new Error(`Desk agent ${agent.state?.error ?? agent.state?.last_subtype ?? "exited"}`);
      if (!j.product_id) {
        // A task with no product (e.g. a shared library): Mynt opens the PR with the agent's summary.
        const pr = await this.openPr(j, agent.state?.summary ?? "", null);
        return this.end(j, "finished", { pr_url: pr, phase_message: agent.state?.summary?.slice(0, 500) ?? "Done" });
      }
      // Mynt runs the agent's branch itself, in a clean sandbox with no agent and no credentials left.
      const v = await this.newSandbox(j, "verify");
      await this.update(j.id as string, { status: "verifying", verify_sandbox_id: v, phase_message: "Mynt is running the new model itself" });
      return;
    }

    if (j.status === "verifying") {
      if (!j.verify_process_id) {
        if (!(await this.ready(j.verify_sandbox_id as string))) return;
        const pid = await this.startRun(j, j.verify_sandbox_id as string, j.branch as string);
        await this.update(j.id as string, { verify_process_id: pid });
        return;
      }
      const o = await this.runOutcome(j.verify_sandbox_id as string, j.verify_process_id as string);
      if (!o) return;
      if (o.outcome !== "ran") {
        return this.end(j, "failed", { outcome: o, error: `Mynt couldn't run the agent's model: ${o.outcome === "missing_inputs" ? `missing ${o.missing.map((m) => m.key).join(", ")}` : o.outcome === "error" ? o.error : "no model applies"}` });
      }
      await this.saveReport(j, o, j.branch as string);
      const pr = await this.openPr(j, (await agentState(boat, j.sandbox_id as string, j.process_id as string)).state?.summary ?? "", o);
      return this.end(j, "finished", { outcome: o, model: o.model, pr_url: pr, phase_message: `${o.report.verdict}: ${o.report.summary}`.slice(0, 500) });
    }
  }

  private async openPr(j: Row, summary: string, o: Extract<DeskOutcome, { outcome: "ran" }> | null) {
    const ws = (await this.workspace(j.entity_id as string))!;
    const report = o
      ? [
          `**Verdict (run by Mynt, commit ${o.commit?.slice(0, 7) ?? "?"}):** ${o.report.verdict}: ${o.report.summary}`,
          "",
          "| Metric | Value |",
          "| --- | --- |",
          ...Object.entries(o.report.metrics).slice(0, 30).map(([k, v]) => `| ${k} | ${v} |`),
          "",
          "| Check | Status | Detail |",
          "| --- | --- | --- |",
          ...o.report.checks.slice(0, 30).map((c) => `| ${c.name} | ${c.status} | ${(c.detail ?? "").replace(/\|/g, "/")}${c.legal_ref ? ` (${c.legal_ref})` : ""} |`),
        ].join("\n")
      : "";
    return this.repos!.openPullRequest(ws.repository, ws.installation_id, {
      head: j.branch as string,
      title: `Mynt desk: ${j.goal ? String(j.goal).slice(0, 60) : `model for ${j.product_id}`}`,
      body: `${summary.slice(0, 3000)}\n\n${report}\n\nOpened by Mynt's product desk (job ${j.id}). The numbers above come from Mynt running this branch's code, not from the agent.`,
    });
  }

  private async spec(j: Row) {
    const p = j.product_id ? await this.store.getProduct(j.product_id as string) : null;
    const t = j.product_id ? await this.terms(j.product_id as string) : null;
    return {
      job: j.id,
      goal: j.goal,
      product: p ? { ...p.product, action: p.action } : null,
      terms: t?.terms ?? null,
      regulatory: p ? await this.regulatoryContext(p) : [],
    };
  }

  startWorker(intervalMs = Number(process.env.DESK_POLL_MS ?? 5000)) {
    if (this.timer || !this.enabled) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "desk worker");
  }

  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const attempt = async (fn: () => Promise<unknown>) => {
  try {
    return json(await fn());
  } catch (e) {
    return fail((e as Error).message);
  }
};

// The feasibility check test_product adds: advisory, from the latest report for the current term sheet.
export async function feasibilityCheck(desk: DeskService, productId: string) {
  const f = await desk.feasibility(productId);
  if (!f.terms) return { name: "feasibility", status: "warn" as const, message: "No term sheet yet: set_product_terms, then analyze_product" };
  if (!f.current) return { name: "feasibility", status: "warn" as const, message: f.stale ? "The term sheet changed since the last analysis; run analyze_product again" : "Not analysed yet: run analyze_product" };
  const r = f.current.report as DeskReport;
  return { name: "feasibility", status: r.verdict === "feasible" ? ("pass" as const) : ("warn" as const), message: `${r.verdict} (model ${f.current.model}): ${r.summary}` };
}

export function registerDeskTools(server: McpServer, store: Store, user: User, desk: DeskService) {
  const ownProduct = async (id: string) => {
    const p = await store.getProduct(id);
    return p && (p.owner_id === user.id || (!!user.entity_id && p.entity_id === user.entity_id)) ? p : null;
  };
  const ownJob = async (id: string) => {
    const j = await desk.job(id);
    return j && j.entity_id === user.entity_id ? j : null;
  };

  server.registerTool(
    "connect_desk_repository",
    {
      title: "Connect your desk workspace",
      description:
        "Innovator: connect your firm's GitHub repository as its product-desk workspace (install the Mynt GitHub App on it first). Your financial models live there as code; Mynt runs them, and the desk agent proposes new ones as pull requests.",
      inputSchema: { repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name") },
    },
    async ({ repository }) =>
      attempt(async () => {
        if (!user.entity_id) throw new Error("Join or create your firm first (create_entity)");
        await desk.connectWorkspace(user.entity_id, user.id, repository);
        await store.audit(user.id, "connect_desk_repository", repository);
        return { connected: repository };
      }),
  );

  server.registerTool(
    "set_product_terms",
    {
      title: "Set a product's term sheet",
      description:
        "Innovator: the economics of one of your products, as named inputs (e.g. apr_pct, processing_fee_pct, tenor_months, cost_of_funds_pct, expected_pd_pct, lgd_pct, opex_pct; or premium, sum_assured, commission_pct; or ter_pct, trail_pct) plus assumptions. The desk's models say which inputs they need. Changing it makes earlier analyses stale.",
      inputSchema: {
        product_id: z.string(),
        inputs: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([z.number(), z.string(), z.boolean()])),
        assumptions: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ product_id, inputs, assumptions }) =>
      attempt(async () => {
        if (!(await ownProduct(product_id))) throw new Error(`No product of yours with id '${product_id}'`);
        const h = await desk.setTerms(product_id, user.id, { inputs, ...(assumptions ? { assumptions } : {}) });
        return { product_id, terms_hash: h };
      }),
  );

  server.registerTool(
    "get_product_terms",
    { title: "A product's term sheet and feasibility", description: "Innovator: the term sheet, the latest feasibility report for it, and whether it's stale.", inputSchema: { product_id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ product_id }) => ((await ownProduct(product_id)) ? json(await desk.feasibility(product_id)) : fail(`No product of yours with id '${product_id}'`)),
  );

  server.registerTool(
    "analyze_product",
    {
      title: "Analyse a product's feasibility",
      description:
        "Innovator: work out whether a product makes sense. If a model in your workspace applies, Mynt runs it on the term sheet: code only, no AI, a few cents. If none applies yet and auto_agent is on, the desk agent builds one (intelligence work, within your cap) and Mynt runs that.",
      inputSchema: {
        product_id: z.string(),
        model: z.string().optional().describe("A specific model in your workspace; otherwise the most specific one that applies"),
        auto_agent: z.boolean().default(true),
        cap_usd: z.number().positive().optional().describe("For the agent, if it's needed"),
      },
    },
    async ({ product_id, model, auto_agent, cap_usd }) => attempt(() => desk.start(user, { kind: "run", product_id, model, escalate: auto_agent, cap_usd })),
  );

  server.registerTool(
    "desk_task",
    {
      title: "Give the desk agent a task",
      description:
        "Innovator: intelligence-driven work for the desk agent in your workspace: design or extend a model (e.g. 'add an ALM liquidity ladder for our FD book', 'model IRDAI commission caps'), stress scenarios, or a shared library. It writes code and tests on a branch; Mynt runs the code and opens a pull request.",
      inputSchema: { goal: z.string().min(10).max(2000), product_id: z.string().optional(), cap_usd: z.number().positive().optional() },
    },
    async ({ goal, product_id, cap_usd }) => attempt(() => desk.start(user, { kind: "agent", goal, product_id, cap_usd })),
  );

  server.registerTool(
    "get_desk_job",
    { title: "A desk job", description: "Innovator: status, cost, outcome and pull request of one of your firm's desk jobs.", inputSchema: { job_id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ job_id }) => ((await ownJob(job_id)) ? json(await ownJob(job_id)) : fail(`No desk job of your firm's with id '${job_id}'`)),
  );

  server.registerTool(
    "list_desk_jobs",
    { title: "Desk jobs", description: "Innovator: your firm's recent desk jobs and this month's desk spend.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () =>
      user.entity_id ? json({ workspace: await desk.workspace(user.entity_id), month_spend_usd: await desk.monthSpend(user.entity_id), jobs: await desk.jobs(user.entity_id) }) : fail("Join or create your firm first"),
  );

  server.registerTool(
    "stop_desk_job",
    { title: "Stop a desk job", description: "Innovator: stop a running desk job and its sandboxes.", inputSchema: { job_id: z.string() } },
    async ({ job_id }) => attempt(async () => {
      if (!(await ownJob(job_id))) throw new Error(`No desk job of your firm's with id '${job_id}'`);
      await desk.stop(job_id, `Stopped by ${user.name}`);
      return { stopped: job_id };
    }),
  );
}
