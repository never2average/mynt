import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentMeter } from "./agent-meter.js";
import type { AgentRun } from "./agent-proxy.js";
import { agentState, launchAgent, WORKSPACES_ROOT } from "./agent-host.js";
import type { BoatClient } from "./boat.js";
import type { Db } from "./db.js";
import type { DeskConfig, DeskService } from "./desk.js";
import { DATASET_SIZE, datasetInputs, generateDataset, jsonl, seedsFor, type Economics, type GeneratorParams } from "./explore-data.js";
import { OBJECTIVES, SCORER_SCRIPT, scoreWithStability, type Objective, type ScoringSpec } from "./explore-score.js";
import type { RepoAccess } from "./github.js";
import { REPO_DIR, startRepoRun } from "./repo-run.js";
import type { ReviewService } from "./review.js";
import type { Store, User } from "./store.js";
import { serialLoop } from "./worker.js";

// Algorithm explorations, an extension of the product desk. A product's core_algorithms (eligibility, underwriting,
// limits, pricing, fraud screening) are code in the firm's desk repository. An exploration tries to improve one:
//   1. Mynt generates synthetic applicants from the product (explore-data.ts): a dev set with outcomes, which the
//      explorers get, and a holdout only Mynt ever sees.
//   2. Several explorers (Claude Code, steered by workspaces/algorithm-explorer) each take a different angle and
//      iterate on the dev set in an autoresearch-style loop: one change, a short experiment with the scorer, keep
//      or revert, log it. Each pushes its best state to its own branch.
//   3. Mynt checks out each pushed branch (and the currently pinned version, as the baseline) in a clean sandbox
//      with no credentials, runs its `decide` on the holdout applicants (features only), and scores the decisions
//      itself against the hidden truth (explore-score.ts). The leaderboard comes only from that.
//   4. The firm may adopt a variant: Mynt opens a pull request. The product changes only when the firm merges it and
//      pins the new version through the normal product update.

export interface ExploreConfig {
  capUsd: number; // per exploration, shared by its explorers
  maxIterations: number;
  maxMinutes: number;
  experimentTimeoutSeconds: number;
  sandboxType: string;
}

export function exploreConfigFromEnv(desk: DeskConfig, env = process.env): ExploreConfig {
  return {
    capUsd: Number(env.EXPLORE_CAP_USD ?? 20),
    maxIterations: Number(env.EXPLORE_MAX_ITERATIONS ?? 25),
    maxMinutes: Number(env.EXPLORE_MAX_MINUTES ?? 60),
    experimentTimeoutSeconds: Number(env.EXPLORE_EXPERIMENT_TIMEOUT_SECONDS ?? 120),
    sandboxType: desk.sandboxType,
  };
}

export const MAX_EXPLORERS = 5;
export const DECISION_PURPOSES = ["eligibility", "underwriting", "limit_assignment", "pricing", "fraud_screening"];

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.explore_jobs (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    product_id text NOT NULL,
    algorithm_id text NOT NULL,
    model_dir text NOT NULL,
    base_ref text,
    objective text NOT NULL,
    constraints jsonb NOT NULL,
    explorers integer NOT NULL,
    status text NOT NULL,
    phase_message text,
    dataset jsonb NOT NULL,
    leaderboard jsonb,
    cost_usd numeric NOT NULL DEFAULT 0,
    cap_usd numeric NOT NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS explore_jobs_entity_idx ON financial_products.explore_jobs (entity_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS financial_products.explore_variants (
    job_id uuid NOT NULL REFERENCES financial_products.explore_jobs(id),
    k integer NOT NULL,
    angle text,
    branch text,
    status text NOT NULL,
    sandbox_id text,
    process_id text,
    token_hash text,
    started_at timestamptz,
    agent_cost_usd numeric NOT NULL DEFAULT 0,
    summary text,
    score_sandbox_id text,
    score_process_id text,
    commit_sha text,
    score jsonb,
    error text,
    pr_url text,
    review_case_id text,
    review_note text,
    proposed_by uuid,
    proposed_at timestamptz,
    PRIMARY KEY (job_id, k)
  );
`;

const DONE = ["finished", "failed", "stopped"];
const DIR = "/home/user/mynt-explore";
const JOB = `${DIR}/job`;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const parse = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};
const readJsonl = (text: string | null) =>
  (text ?? "")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });

type Row = Record<string, unknown>;
type Angle = { id: string; title: string; brief: string };

// The angles live in the workspace, with the rest of what steers the explorers.
export function explorationAngles(root = WORKSPACES_ROOT): Angle[] {
  return (JSON.parse(readFileSync(join(root, "algorithm-explorer", "angles.json"), "utf8")) as { angles: Angle[] }).angles;
}

// Runs a decision algorithm's `decide` on a file of applicants, the way Mynt does. Mynt runs it on the holdout in a
// clean sandbox; explorers get the same script to run on their dev set.
//
//   node run-decide.mjs <repo dir> <job dir with applicants.jsonl> <models/<name>>
// It writes <job dir>/decisions.jsonl and <job dir>/outcome.json: { outcome: "ran", commit, decisions } or
// { outcome: "no_decide" | "error", error }.
export const DECIDE_RUNNER = String.raw`
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [repo, job, modelDir] = process.argv.slice(2);
let log = "";
const done = (r) => {
  writeFileSync(join(job, "outcome.json"), JSON.stringify({ ...r, log: log.slice(-8000) }));
  process.exit(0);
};
let commit = null;
try { commit = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim(); } catch {}
const dir = join(repo, modelDir);
let model;
try { model = JSON.parse(readFileSync(join(dir, "model.json"), "utf8")); } catch { done({ outcome: "error", commit, error: "No readable " + modelDir + "/model.json" }); }
if (typeof model.decide !== "string" || !model.decide.trim()) done({ outcome: "no_decide", commit, error: "model.json declares no decide command" });

const venv = "/tmp/mynt-explore-venv-" + String(model.name ?? "model").replace(/[^a-z0-9_-]/gi, "_");
const applicants = resolve(job, "applicants.jsonl");
const decisions = resolve(job, "decisions.jsonl");
const env = { ...process.env, PATH: venv + "/bin:" + process.env.PATH, MYNT_APPLICANTS: applicants, MYNT_DECISIONS: decisions };
const sh = (cmd, timeout) => {
  const r = spawnSync("bash", ["-lc", cmd], { cwd: dir, env, encoding: "utf8", timeout });
  log += "$ " + cmd + "\n" + (r.stdout ?? "") + (r.stderr ?? "") + "\n";
  return r.status === 0;
};
if (!existsSync(venv) && !sh("python3 -m venv " + venv, 120000)) done({ outcome: "error", commit, error: "Couldn't create a Python environment" });
if (model.requirements && !sh("pip install -q -r " + JSON.stringify(model.requirements), 600000)) done({ outcome: "error", commit, error: "Couldn't install the model's requirements" });
writeFileSync(decisions, "");
if (!sh(model.decide, 600000)) done({ outcome: "error", commit, error: "decide exited with an error" });
const lines = readFileSync(decisions, "utf8").split("\n").filter((l) => l.trim());
done({ outcome: "ran", commit, decisions: lines.length });
`;

type RunOutcome = { outcome: "ran"; commit: string | null; decisions: number; log: string } | { outcome: "no_decide" | "error"; commit?: string | null; error: string; log: string };

export class ExploreService {
  private timer: NodeJS.Timeout | null = null;
  meter: AgentMeter | null = null;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly boat: BoatClient | null,
    readonly repos: RepoAccess | null,
    readonly config: ExploreConfig,
    private readonly desk: DeskService,
    private readonly review: ReviewService | null,
  ) {}

  static async open(db: Db, store: Store, boat: BoatClient | null, repos: RepoAccess | null, config: ExploreConfig, desk: DeskService, review: ReviewService | null = null) {
    await db.exec(TABLES);
    const s = new ExploreService(db, store, boat, repos, config, desk, review);
    // Explorations share the firm's monthly desk budget, both ways.
    desk.alsoCommitted = (entityId) => s.monthCommitted(entityId);
    return s;
  }

  get enabled() {
    return this.desk.agentsEnabled;
  }

  private async all(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as Row[];
  }

  private async one(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }

  async monthCommitted(entityId: string) {
    const r = await this.one(
      `SELECT COALESCE(SUM(CASE WHEN status = ANY($2) THEN cost_usd ELSE cap_usd END), 0) AS s FROM financial_products.explore_jobs
       WHERE entity_id = $1 AND created_at >= date_trunc('month', now())`,
      [entityId, DONE],
    );
    return Number(r?.s ?? 0);
  }

  // ---- starting ----

  async start(
    user: User,
    o: {
      product_id: string;
      algorithm_id: string;
      objective?: Objective;
      constraints?: { max_loss_rate_pct?: number; apr_cap_pct?: number; min_adverse_impact_ratio?: number };
      explorers?: number;
      cap_usd?: number;
    },
  ) {
    if (!this.enabled) throw new Error("Algorithm explorations aren't enabled on this Mynt yet");
    if (!user.entity_id) throw new Error("Join or create your firm first (create_entity)");
    if (!(await this.desk.workspace(user.entity_id))) throw new Error("Connect your firm's workspace repository first (connect_desk_repository)");
    const p = await this.store.getProduct(o.product_id);
    if (!p || (p.owner_id !== user.id && p.entity_id !== user.entity_id)) throw new Error(`No product of your firm's with id '${o.product_id}'`);
    const algorithms = ((p.definition?.core_algorithms as Row[] | undefined) ?? []) as { _id: string; purpose: string; repository: string; version?: string }[];
    const algorithm = algorithms.find((a) => a._id === o.algorithm_id);
    if (!algorithm) throw new Error(`The product's definition has no core algorithm '${o.algorithm_id}'${algorithms.length ? ` (it has: ${algorithms.map((a) => a._id).join(", ")})` : ""}`);
    if (!DECISION_PURPOSES.includes(algorithm.purpose)) throw new Error(`Explorations cover decision algorithms (${DECISION_PURPOSES.join(", ")}); '${algorithm._id}' is for ${algorithm.purpose}`);
    const running = await this.one("SELECT id FROM financial_products.explore_jobs WHERE product_id = $1 AND algorithm_id = $2 AND status <> ALL($3)", [p.product.id, algorithm._id, DONE]);
    if (running) throw new Error(`An exploration of this algorithm is already running (${running.id})`);
    const explorers = Math.min(Math.max(o.explorers ?? 3, 1), MAX_EXPLORERS);
    const cap = Math.min(o.cap_usd ?? this.config.capUsd, this.config.capUsd);
    const monthly = this.desk.config.monthlyCapUsd;
    if ((await this.desk.monthCommitted(user.entity_id)) + cap > monthly) throw new Error(`Your firm's monthly desk budget of US$${monthly} is used up`);

    const terms = (await this.desk.terms(p.product.id))?.terms ?? null;
    const inputs = (terms?.inputs ?? {}) as Record<string, unknown>;
    const { params, economics, assumptions } = datasetInputs(p, inputs);
    const constraints = this.constraints(p.definition, inputs, economics, params, o.constraints ?? {});
    const id = randomUUID();
    const seeds = seedsFor(id, hash);
    const dataset = { params, economics, assumptions, seeds, sizes: { dev: DATASET_SIZE, holdout: DATASET_SIZE } };
    await this.db.query(
      `INSERT INTO financial_products.explore_jobs (id, entity_id, user_id, product_id, algorithm_id, model_dir, base_ref, objective, constraints, explorers, status, dataset, cap_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', $11, $12)`,
      [id, user.entity_id, user.id, p.product.id, algorithm._id, algorithm.repository, algorithm.version ?? null, o.objective ?? "net_margin", JSON.stringify(constraints), explorers, JSON.stringify(dataset), cap],
    );
    const angles = explorationAngles();
    await this.db.query("INSERT INTO financial_products.explore_variants (job_id, k, angle, branch, status) VALUES ($1, 0, NULL, $2, 'waiting')", [id, algorithm.version ?? null]);
    for (let k = 1; k <= explorers; k++) {
      await this.db.query("INSERT INTO financial_products.explore_variants (job_id, k, angle, branch, status) VALUES ($1, $2, $3, $4, 'queued')", [
        id,
        k,
        angles[(k - 1) % angles.length].id,
        `mynt/explore-${id.slice(0, 8)}-${k}`,
      ]);
    }
    return (await this.get(id))!;
  }

  // The constraints, each from the job if given, else the term sheet or definition, else a stated default.
  private constraints(def: Record<string, unknown> | null, inputs: Record<string, unknown>, e: Economics, params: GeneratorParams, given: { max_loss_rate_pct?: number; apr_cap_pct?: number; min_adverse_impact_ratio?: number }) {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const rateCap = ((def?.rates as { kind?: string; cap?: number }[] | undefined) ?? []).find((r) => r.kind === "lending" && num(r.cap) !== undefined)?.cap;
    // The regulatory model holds law as text (legal_ref, summary), not numeric caps, so a cap comes from the job, the
    // term sheet or the product's own rate cap; the explorers still get the regulatory context to cite.
    const apr: [number | null, string] =
      given.apr_cap_pct !== undefined
        ? [given.apr_cap_pct, "the job"]
        : num(inputs.apr_cap_pct) !== undefined
          ? [num(inputs.apr_cap_pct)!, "term sheet apr_cap_pct"]
          : rateCap !== undefined
            ? [rateCap, "the definition's lending rate cap"]
            : [null, "not set"];
    const loss: [number, string] =
      given.max_loss_rate_pct !== undefined
        ? [given.max_loss_rate_pct, "the job"]
        : [Math.round(params.target_pd_pct * e.lgd_pct) / 100, "the term sheet's expected loss (mean default probability x loss given default)"];
    return {
      max_loss_rate_pct: loss[0],
      max_loss_rate_source: loss[1],
      apr_cap_pct: apr[0],
      apr_cap_source: apr[1],
      min_adverse_impact_ratio: given.min_adverse_impact_ratio ?? 0.8,
    };
  }

  private scoringSpec(j: Row): ScoringSpec {
    const c = j.constraints as { max_loss_rate_pct: number; apr_cap_pct: number | null; min_adverse_impact_ratio: number };
    return {
      objective: { maximise: j.objective as Objective },
      economics: (j.dataset as { economics: Economics }).economics,
      constraints: { max_loss_rate_pct: c.max_loss_rate_pct, apr_cap_pct: c.apr_cap_pct, min_adverse_impact_ratio: c.min_adverse_impact_ratio },
    };
  }

  private split(j: Row, which: "dev" | "holdout") {
    const d = j.dataset as { params: GeneratorParams; seeds: { dev: number; holdout: number }; sizes: { dev: number; holdout: number } };
    return generateDataset(d.params, d.seeds[which], which === "dev" ? "d" : "h", d.sizes[which]);
  }

  // ---- reading ----

  async get(id: string): Promise<Row | null> {
    const j = await this.one("SELECT * FROM financial_products.explore_jobs WHERE id::text = $1", [id]);
    if (!j) return null;
    const variants = (await this.all("SELECT * FROM financial_products.explore_variants WHERE job_id = $1 ORDER BY k", [j.id])).map(
      ({ token_hash: _t, job_id: _j, sandbox_id: _s, process_id: _p, score_sandbox_id: _ss, score_process_id: _sp, score, ...v }) => ({
        ...v,
        objective: (score as { objective?: unknown } | null)?.objective ?? null,
        eligible: (score as { eligible?: unknown } | null)?.eligible ?? null,
      }),
    );
    const { dataset, ...rest } = j;
    const d = dataset as { assumptions: string[]; sizes: unknown; economics: unknown };
    return { ...(rest as Row), dataset: { assumptions: d.assumptions, sizes: d.sizes, economics: d.economics, holdout: "kept by Mynt; never given to explorers" }, variants };
  }

  async list(entityId: string, limit = 30) {
    return this.all(
      "SELECT id, product_id, algorithm_id, objective, explorers, status, phase_message, cost_usd, cap_usd, created_at, finished_at FROM financial_products.explore_jobs WHERE entity_id = $1 ORDER BY created_at DESC LIMIT $2",
      [entityId, limit],
    );
  }

  async agentTokenActive(token: string) {
    return !!(await this.agentRun(token));
  }

  // Every explorer of a job spends against one key and one cap: they share the job's budget.
  async agentRun(token: string): Promise<AgentRun | null> {
    const r = await this.one(
      `SELECT j.id, j.cap_usd FROM financial_products.explore_variants v JOIN financial_products.explore_jobs j ON j.id = v.job_id
       WHERE v.token_hash = $1 AND j.status <> ALL($2)`,
      [hash(token), DONE],
    );
    return r ? { key: `explore:${r.id}`, capUsd: Number(r.cap_usd) } : null;
  }

  // ---- the state machine ----

  private async update(id: string, f: Row) {
    const keys = Object.keys(f);
    const done = typeof f.status === "string" && DONE.includes(f.status);
    await this.db.query(
      `UPDATE financial_products.explore_jobs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}${done ? ", finished_at = now()" : ""} WHERE id = $1`,
      [id, ...keys.map((k) => (k === "leaderboard" ? JSON.stringify(f[k]) : f[k]))],
    );
    if (done) await this.db.query("UPDATE financial_products.explore_variants SET token_hash = NULL WHERE job_id = $1", [id]);
  }

  private async updateVariant(jobId: string, k: number, f: Row) {
    const keys = Object.keys(f);
    await this.db.query(`UPDATE financial_products.explore_variants SET ${keys.map((key, i) => `${key} = $${i + 3}`).join(", ")} WHERE job_id = $1 AND k = $2`, [
      jobId,
      k,
      ...keys.map((key) => (key === "score" ? JSON.stringify(f[key]) : f[key])),
    ]);
  }

  private async variants(jobId: string) {
    return this.all("SELECT * FROM financial_products.explore_variants WHERE job_id = $1 ORDER BY k", [jobId]);
  }

  private async end(j: Row, status: string, f: Row = {}) {
    if (this.boat) for (const v of await this.variants(j.id as string)) for (const s of [v.sandbox_id, v.score_sandbox_id]) if (s) await this.boat.stop(s as string).catch(() => {});
    await this.update(j.id as string, { ...f, status });
  }

  async stop(id: string, reason: string) {
    const j = await this.one("SELECT * FROM financial_products.explore_jobs WHERE id::text = $1", [id]);
    if (!j || DONE.includes(j.status as string)) return false;
    await this.end(j, "stopped", { error: reason });
    return true;
  }

  private async newSandbox(j: Row, role: string, env: Record<string, string> = {}) {
    return (await this.boat!.createSandbox({ name: `mynt-explore-${role}-${j.id}`, type: this.config.sandboxType, ttlSeconds: 3 * 3600, labels: { mynt_explore: j.id as string, mynt_role: role }, env })).id;
  }

  private async ready(sandbox: string) {
    const s = await this.boat!.getSandbox(sandbox);
    if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}`);
    return ["ready", "idle", "running"].includes(s.state);
  }

  async tick() {
    if (!this.enabled) return;
    for (const j of await this.all("SELECT * FROM financial_products.explore_jobs WHERE status <> ALL($1) ORDER BY created_at", [DONE])) {
      try {
        await this.advance(j);
      } catch (e) {
        await this.end(j, "failed", { error: (e as Error).message });
      }
    }
  }

  private async advance(j: Row) {
    const boat = this.boat!;
    const id = j.id as string;
    let vs = await this.variants(id);
    const explorers = vs.filter((v) => Number(v.k) > 0);

    if (j.status === "queued") {
      const ws = (await this.desk.workspace(j.entity_id as string))!;
      for (const v of explorers) {
        const { token } = await this.repos!.tokenFor(ws.repository, ws.installation_id);
        const sandbox = await this.newSandbox(j, `explorer-${v.k}`, { GITHUB_REPOSITORY: ws.repository, GITHUB_TOKEN: token, MYNT_BRANCH: v.branch as string });
        await this.updateVariant(id, Number(v.k), { status: "provisioning", sandbox_id: sandbox });
      }
      await this.update(id, { status: "exploring", phase_message: `Starting ${explorers.length} explorer(s)` });
      return;
    }

    // Spend: every sandbox's machine time plus the explorers' model calls (metered at the proxy, all on one key).
    let cost = 0;
    for (const v of vs) for (const s of [v.sandbox_id, v.score_sandbox_id]) if (s) cost += await boat.costDollars(s as string);
    for (const v of explorers) {
      if (v.status !== "exploring" || !v.process_id) continue;
      const c = (await agentState(boat, v.sandbox_id as string, v.process_id as string)).cost;
      if (c !== Number(v.agent_cost_usd)) await this.updateVariant(id, Number(v.k), { agent_cost_usd: c });
      v.agent_cost_usd = c;
    }
    const agents = explorers.reduce((s, v) => s + Number(v.agent_cost_usd), 0);
    const total = cost + Math.max(agents, this.meter ? await this.meter.spent(`explore:${id}`) : 0);
    if (total !== Number(j.cost_usd)) await this.update(id, { cost_usd: total });
    if (total > Number(j.cap_usd)) return this.end(j, "stopped", { error: `Stopped at US$${total.toFixed(2)}: over the US$${j.cap_usd} cap`, cost_usd: total });

    if (j.status === "exploring") {
      for (const v of explorers) {
        const k = Number(v.k);
        if (v.status === "provisioning") {
          if (!(await this.ready(v.sandbox_id as string))) continue;
          const token = `mynt_explore_${randomBytes(24).toString("base64url")}`;
          await this.updateVariant(id, k, { token_hash: hash(token) });
          const pid = await launchAgent(boat, this.desk.config, v.sandbox_id as string, {
            prompt: "Explore the algorithm in job/explore.json, following CLAUDE.md and its skills.",
            budgetUsd: (Number(j.cap_usd) * 0.9) / explorers.length,
            token,
            workspace: "algorithm-explorer",
            jobFiles: await this.explorerFiles(j, v),
          });
          await this.updateVariant(id, k, { status: "exploring", process_id: pid, started_at: new Date().toISOString() });
        } else if (v.status === "exploring") {
          const agent = await agentState(boat, v.sandbox_id as string, v.process_id as string);
          // A margin past the explorer's own time limit; whatever it pushed by then is still scored.
          const overtime = Date.now() - new Date(v.started_at as string).getTime() > (this.config.maxMinutes + 15) * 60_000;
          if (agent.running && !overtime) continue;
          await boat.stop(v.sandbox_id as string).catch(() => {});
          await this.updateVariant(id, k, {
            status: agent.ok ? "explored" : "failed",
            token_hash: null,
            summary: agent.state?.summary?.slice(0, 4000) ?? null,
            error: agent.ok ? null : overtime && agent.running ? "Over the time limit" : `Explorer ${agent.state?.error ?? agent.state?.last_subtype ?? "exited"}`,
          });
        }
      }
      vs = await this.variants(id);
      if (vs.some((v) => Number(v.k) > 0 && !["explored", "failed"].includes(v.status as string))) return;
      // Every explorer is done: Mynt scores each pushed branch, and the pinned baseline, each in its own clean sandbox.
      for (const v of vs) await this.updateVariant(id, Number(v.k), { status: "scoring", score_sandbox_id: await this.newSandbox(j, `score-${v.k}`) });
      await this.update(id, { status: "scoring", phase_message: "Mynt is scoring every variant on the holdout" });
      return;
    }

    if (j.status === "scoring") {
      let holdout: ReturnType<ExploreService["split"]> | null = null;
      for (const v of vs) {
        if (v.status !== "scoring") continue;
        const k = Number(v.k);
        const sandbox = v.score_sandbox_id as string;
        if (!v.score_process_id) {
          if (!(await this.ready(sandbox))) continue;
          holdout ??= this.split(j, "holdout");
          const ws = (await this.desk.workspace(j.entity_id as string))!;
          // Only the holdout's features go in; the truth stays in Mynt.
          const pid = await startRepoRun(boat, this.repos!, sandbox, {
            repository: ws.repository,
            installationId: ws.installation_id,
            ref: (v.branch as string | null) ?? null,
            dir: DIR,
            outcome: `${JOB}/outcome.json`,
            cloneFailure: { outcome: "error", error: k === 0 ? "Couldn't check out the pinned version" : "The explorer's branch wasn't pushed", log: "" },
            files: { [`${DIR}/run-decide.mjs`]: DECIDE_RUNNER, [`${JOB}/applicants.jsonl`]: jsonl(holdout.applicants) },
            command: `node ${DIR}/run-decide.mjs ${REPO_DIR} ${JOB} '${String(j.model_dir).replace(/[^\w./-]/g, "")}'`,
          });
          await this.updateVariant(id, k, { score_process_id: pid });
          continue;
        }
        if ((await boat.commandStatus(sandbox, Number(v.score_process_id))).running) continue;
        const o = parse<RunOutcome>(await boat.readFile(sandbox, `${JOB}/outcome.json`)) ?? { outcome: "error" as const, error: "The run produced no outcome", log: "" };
        if (o.outcome !== "ran") {
          await this.updateVariant(id, k, { status: "unscorable", commit_sha: o.commit ?? null, error: o.error });
        } else {
          holdout ??= this.split(j, "holdout");
          const decisions = readJsonl(await boat.readFile(sandbox, `${JOB}/decisions.jsonl`));
          const score = scoreWithStability(holdout.applicants, holdout.truth, decisions, this.scoringSpec(j));
          await this.updateVariant(id, k, { status: "scored", commit_sha: o.commit, score });
        }
        await boat.stop(sandbox).catch(() => {});
      }
      vs = await this.variants(id);
      if (vs.some((v) => v.status === "scoring")) return;
      const leaderboard = this.leaderboard(j, vs);
      const top = leaderboard[0];
      return this.end(j, "finished", {
        leaderboard,
        phase_message: top?.objective.value !== undefined && top.objective.value !== null ? `Best: ${top.label} (${top.objective.metric} ${top.objective.value}${top.eligible ? "" : ", fails a constraint"})` : "No variant could be scored",
      });
    }
  }

  // Eligible variants (every constraint holds) first, by objective; then ineligible ones; then those Mynt couldn't run.
  private leaderboard(j: Row, vs: Row[]) {
    const entries = vs.map((v) => {
      const s = v.score as ReturnType<typeof scoreWithStability> | null;
      return {
        k: Number(v.k),
        label: Number(v.k) === 0 ? "baseline (pinned version)" : `explorer ${v.k}`,
        angle: v.angle as string | null,
        branch: v.branch as string | null,
        commit: v.commit_sha as string | null,
        scored: v.status === "scored",
        eligible: !!s?.eligible,
        objective: { metric: j.objective as string, value: s?.objective.value ?? null },
        constraints: s ? Object.fromEntries(s.checks.map((c) => [c.name, c.status])) : null,
        metrics: s?.metrics ?? null,
        stability: s?.stability ?? null,
        error: (v.error as string | null) ?? null,
      };
    });
    const tier = (e: (typeof entries)[number]) => (!e.scored ? 2 : e.eligible ? 0 : 1);
    entries.sort((a, b) => tier(a) - tier(b) || (b.objective.value ?? -Infinity) - (a.objective.value ?? -Infinity) || a.k - b.k);
    return entries.map((e, i) => ({ rank: e.scored ? i + 1 : null, ...e }));
  }

  // What an explorer gets: the job, the dev set (with outcomes), and Mynt's scorer and decide runner. Never the holdout.
  private async explorerFiles(j: Row, v: Row) {
    const p = (await this.store.getProduct(j.product_id as string))!;
    const algorithm = ((p.definition?.core_algorithms as Row[] | undefined) ?? []).find((a) => a._id === j.algorithm_id) ?? null;
    const angle = explorationAngles().find((a) => a.id === v.angle) ?? null;
    const dev = this.split(j, "dev");
    const d = j.dataset as { assumptions: string[]; sizes: { dev: number } };
    const spec = {
      job: j.id,
      explorer: Number(v.k),
      product: { id: p.product.id, name: p.product.name, product_line: p.product.product_line, category: p.product.category, region: p.product.region },
      algorithm,
      model_dir: j.model_dir,
      base_ref: j.base_ref,
      branch: v.branch,
      angle,
      objective: { maximise: j.objective },
      constraints: j.constraints,
      scoring: this.scoringSpec(j),
      limits: { max_iterations: this.config.maxIterations, max_minutes: this.config.maxMinutes, experiment_timeout_seconds: this.config.experimentTimeoutSeconds },
      dataset: { assumptions: d.assumptions, dev: { applicants: "job/dev/applicants.jsonl", truth: "job/dev/truth.jsonl", size: d.sizes.dev } },
      experiment_log: `${j.model_dir}/explore-log.tsv`,
      regulatory: await this.desk.regulatoryContext(p),
    };
    return {
      "job/explore.json": JSON.stringify(spec, null, 2),
      "job/dev/applicants.jsonl": jsonl(dev.applicants),
      // Outcomes and the synthetic protected group, for the scorer only; never the latent default probability.
      "job/dev/truth.jsonl": jsonl(dev.truth.map(({ id, defaulted, protected_group }) => ({ id, defaulted, protected_group }))),
      "scripts/score.mjs": SCORER_SCRIPT,
      "scripts/run-decide.mjs": DECIDE_RUNNER,
    };
  }

  // ---- adoption ----

  // Opens a pull request for a scored variant. The product doesn't change: the firm merges it, then pins the new
  // version on the algorithm through the normal product update.
  async adopt(user: User, jobId: string, k: number) {
    const j = await this.one("SELECT * FROM financial_products.explore_jobs WHERE id::text = $1", [jobId]);
    if (!j || j.entity_id !== user.entity_id) throw new Error(`No exploration of your firm's with id '${jobId}'`);
    if (j.status !== "finished") throw new Error("The exploration hasn't finished yet");
    if (k === 0) throw new Error("The baseline is the version already pinned");
    const v = (await this.variants(jobId)).find((x) => Number(x.k) === k);
    if (!v) throw new Error(`No explorer ${k} in this exploration`);
    if (v.status !== "scored" || !v.commit_sha) throw new Error(`Explorer ${k}'s variant wasn't scored by Mynt, so it can't be adopted`);
    if (v.pr_url) return { pr_url: v.pr_url, review_case_id: v.review_case_id ?? null, already_proposed: true };
    const entry = ((j.leaderboard as ReturnType<ExploreService["leaderboard"]>) ?? []).find((e) => e.k === k)!;
    const baseline = ((j.leaderboard as ReturnType<ExploreService["leaderboard"]>) ?? []).find((e) => e.k === 0);
    const ws = (await this.desk.workspace(j.entity_id as string))!;
    const s = v.score as ReturnType<typeof scoreWithStability>;
    const body = [
      `Explorer ${k} (${v.angle}) on \`${j.model_dir}\` for product \`${j.product_id}\`, algorithm \`${j.algorithm_id}\`.`,
      "",
      `**Holdout result (scored by Mynt, commit ${String(v.commit_sha).slice(0, 7)}):** ${j.objective} ${s.objective.value}${baseline?.objective.value !== null && baseline?.objective.value !== undefined ? ` (baseline ${baseline.objective.value})` : ""}; rank ${entry?.rank ?? "?"}; ${s.eligible ? "every constraint holds" : "fails a constraint"}.`,
      "",
      "| Check | Status | Detail |",
      "| --- | --- | --- |",
      ...s.checks.map((c) => `| ${c.name} | ${c.status} | ${c.detail.replace(/\|/g, "/")} |`),
      "",
      "| Metric | Value |",
      "| --- | --- |",
      ...Object.entries(s.metrics).map(([m, x]) => `| ${m} | ${x ?? "n/a"} |`),
      "",
      `Stability over three time slices: objective spread ${s.stability.objective_spread ?? "n/a"}; ${s.stability.eligible_in_every_slice ? "eligible in every slice" : "not eligible in every slice"}.`,
      "",
      "**The explorer's summary:**",
      String(v.summary ?? "(none)").slice(0, 3000),
      "",
      `Merging this doesn't change the product. To use it, merge, then set this algorithm's \`version\` in the product's definition to the merged ref. Opened by Mynt (exploration ${j.id}); the numbers come from Mynt scoring synthetic holdout applicants the explorer never saw.`,
    ].join("\n");
    const pr = await this.repos!.openPullRequest(ws.repository, ws.installation_id, {
      head: v.branch as string,
      title: `Mynt explorer: ${j.algorithm_id} (${v.angle})`,
      body,
    });
    // Filed for governance review when the governance desk runs here. A review case covers the product as a whole.
    let reviewCase: string | null = null;
    let reviewNote: string | null = null;
    if (this.review?.enabled) {
      try {
        reviewCase = (await this.review.openCase("product", j.product_id as string, user.id)).id as string;
      } catch (e) {
        reviewNote = (e as Error).message;
      }
    } else reviewNote = "Governance review isn't enabled on this Mynt";
    await this.updateVariant(jobId, k, { pr_url: pr, review_case_id: reviewCase, review_note: reviewNote, proposed_by: user.id, proposed_at: new Date().toISOString() });
    return { pr_url: pr, review_case_id: reviewCase, review_note: reviewNote, next: "Merge the pull request, then set the algorithm's version in the product's definition" };
  }

  startWorker(intervalMs = Number(process.env.DESK_POLL_MS ?? 5000)) {
    if (this.timer || !this.enabled) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "explore worker");
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

export function registerExploreTools(server: McpServer, store: Store, user: User, explore: ExploreService) {
  const own = async (id: string) => {
    const j = await explore.get(id);
    return j && j.entity_id === user.entity_id ? j : null;
  };

  server.registerTool(
    "start_exploration",
    {
      title: "Explore improvements to an algorithm",
      description:
        "Innovator: have several explorer agents try to improve one of a product's decision algorithms (from its core_algorithms) on synthetic applicants. Mynt scores every variant, and the version pinned now, on a holdout set the explorers never see, and ranks them. Nothing changes until you adopt one.",
      inputSchema: {
        product_id: z.string(),
        algorithm_id: z.string().describe("The _id of one of the product's core_algorithms"),
        objective: z.enum(OBJECTIVES).default("net_margin").describe("The one metric to maximise"),
        max_loss_rate_pct: z.number().positive().optional().describe("Realised loss ceiling, % of the approved amount; default: the term sheet's expected loss"),
        apr_cap_pct: z.number().positive().optional().describe("Default: the term sheet's apr_cap_pct or the product's lending rate cap"),
        min_adverse_impact_ratio: z.number().min(0).max(1).optional().describe("Default 0.8"),
        explorers: z.number().int().min(1).max(MAX_EXPLORERS).default(3),
        cap_usd: z.number().positive().optional().describe("Shared by all explorers"),
      },
    },
    async ({ product_id, algorithm_id, objective, max_loss_rate_pct, apr_cap_pct, min_adverse_impact_ratio, explorers, cap_usd }) =>
      attempt(async () => {
        const j = await explore.start(user, { product_id, algorithm_id, objective, explorers, cap_usd, constraints: { max_loss_rate_pct, apr_cap_pct, min_adverse_impact_ratio } });
        await store.audit(user.id, "start_exploration", product_id, { job: j.id, algorithm_id });
        return j;
      }),
  );

  server.registerTool(
    "get_exploration",
    {
      title: "An exploration",
      description: "Innovator: an exploration's status, leaderboard, dataset assumptions and spend. Without job_id, your firm's recent explorations.",
      inputSchema: { job_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ job_id }) => {
      if (!job_id) return user.entity_id ? json(await explore.list(user.entity_id)) : fail("Join or create your firm first");
      const j = await own(job_id);
      return j ? json(j) : fail(`No exploration of your firm's with id '${job_id}'`);
    },
  );

  server.registerTool(
    "adopt_variant",
    {
      title: "Adopt an explored variant",
      description:
        "Innovator: propose one explorer's variant: Mynt opens a pull request in your workspace with its holdout results. The product doesn't change until you merge it and set the algorithm's new version.",
      inputSchema: { job_id: z.string(), explorer: z.number().int().min(1).max(MAX_EXPLORERS) },
    },
    async ({ job_id, explorer }) =>
      attempt(async () => {
        const r = await explore.adopt(user, job_id, explorer);
        await store.audit(user.id, "adopt_variant", job_id, { explorer, pr_url: r.pr_url });
        return r;
      }),
  );

  server.registerTool(
    "stop_exploration",
    { title: "Stop an exploration", description: "Innovator: stop a running exploration and all its sandboxes.", inputSchema: { job_id: z.string() } },
    async ({ job_id }) =>
      attempt(async () => {
        if (!(await own(job_id))) throw new Error(`No exploration of your firm's with id '${job_id}'`);
        await explore.stop(job_id, `Stopped by ${user.name}`);
        return { stopped: job_id };
      }),
  );
}
