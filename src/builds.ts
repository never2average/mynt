import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentMeter } from "./agent-meter.js";
import type { AgentRun } from "./agent-proxy.js";
import { serialLoop } from "./worker.js";
import { AGENT_DIR, agentState, launchAgent, workspaceCwd, workspaceFiles, type AgentBackend } from "./agent-host.js";
import { CLAUDE_CODE_VERSION, type AgentState } from "./agent-runner.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessStatus, productEntity } from "./access.js";
import type { BoatClient } from "./boat.js";
import { BOX_OUTPUT_LIMIT, BOX_TIMEOUT_MAX, boxOutput, EDITOR_CONFIG, EDITOR_PORT, editorCommand, editorConfig, shellQuote } from "./boxes.js";
import type { Db } from "./db.js";
import type { RepoAccess } from "./github.js";
import { GoogleServiceAccount } from "./google-auth.js";
import { generateSdk, SDK_LANGUAGES, type SdkProduct } from "./sdk.js";
import { VERIFY_APP, VERIFY_DIR, VERIFY_SCRIPT } from "./verify-script.js";
import type { Store, User } from "./store.js";

// Coding-agent builds: a developer asks Mynt to build or ship one of their experiences; Mynt runs a coding
// agent (Claude Code, run by Mynt itself) in a boat.dev sandbox that writes the code, passes a Maxwell security audit and a production-
// readiness checklist, deploys a preview and opens a pull request. Developers track every step.

export const BUILD_STATUSES = [
  "queued",
  "provisioning",
  "coding",
  "auditing",
  "checking",
  "previewing",
  "pushing",
  "verifying",
  "succeeded",
  "blocked",
  "failed",
  "stopped",
  "over_budget",
] as const;
export type BuildStatus = (typeof BUILD_STATUSES)[number];
const TERMINAL: BuildStatus[] = ["succeeded", "blocked", "failed", "stopped", "over_budget"];
const AGENT_PHASES: BuildStatus[] = ["coding", "auditing", "checking", "previewing", "pushing"];

export type { AgentBackend };

// Vertex AI when a Google service account is configured, else the Anthropic API when there's a key.
function agentBackendFromEnv(env: NodeJS.ProcessEnv): AgentBackend | null {
  const google = GoogleServiceAccount.fromEnv(env);
  if (google) {
    const projectId = env.VERTEX_PROJECT_ID || google.projectId;
    if (!projectId) throw new Error("Set VERTEX_PROJECT_ID: the service account key doesn't name a project");
    return { kind: "vertex", projectId, region: env.VERTEX_REGION || "global", auth: google };
  }
  return env.ANTHROPIC_API_KEY ? { kind: "anthropic", apiKey: env.ANTHROPIC_API_KEY } : null;
}

export interface BuildConfig {
  capUsd: number; // per build
  monthlyCapUsd: number; // per developer per calendar month
  agentBackend: AgentBackend | null; // used only by Mynt's agent proxy; never sent to a sandbox
  model: string;
  sandboxType: string;
  ttlSeconds: number;
  maxwellRepo: string;
  publicUrl: string;
}

export function buildConfigFromEnv(env = process.env): BuildConfig {
  return {
    capUsd: Number(env.BUILD_CAP_USD ?? 10),
    monthlyCapUsd: Number(env.BUILD_MONTHLY_CAP_USD ?? 100),
    agentBackend: agentBackendFromEnv(env),
    model: env.BUILD_AGENT_MODEL ?? "claude-opus-5-5",
    sandboxType: env.BUILD_SANDBOX_TYPE ?? "default",
    ttlSeconds: Number(env.BUILD_SANDBOX_TTL_SECONDS ?? 4 * 3600),
    maxwellRepo: env.BUILD_MAXWELL_REPO ?? "https://github.com/OnFinance/Maxwell",
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
  };
}

export interface Build {
  id: string;
  developer_id: string;
  app_id: string | null;
  goal: string;
  repository: string | null;
  status: BuildStatus;
  phase_message: string | null;
  sandbox_id: string | null;
  sandbox_key_id: string | null; // the app's Mynt sandbox key this build uses
  verify_sandbox_id: string | null; // the clean sandbox Mynt verifies the build in
  verify_step: "provisioning" | "checks" | "audit" | null;
  verify_process_id: number | null;
  verify_prompt_id: string | null; // the auditor's runner process in the verify sandbox
  source_sha256: string | null;
  source_url: string | null; // signed, short-lived; never shown to users
  agent_report: unknown; // the coding agent's own report: advisory only
  prompt_id: string | null; // the coding agent's runner process in the build sandbox
  preview_url: string | null;
  pr_url: string | null;
  branch: string | null;
  commit_sha: string | null;
  maxwell: unknown;
  readiness: unknown;
  cost_usd: number;
  cap_usd: number;
  error: string | null;
  // A sandbox reopened on the build's branch after the build ended, for the developer to keep working in.
  box_sandbox_id: string | null;
  box_until: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.build_runs (
    id uuid PRIMARY KEY,
    developer_id uuid NOT NULL REFERENCES financial_products.users(id),
    app_id uuid REFERENCES financial_products.apps(id),
    goal text NOT NULL,
    repository text,
    status text NOT NULL,
    phase_message text,
    sandbox_id text,
    prompt_id text,
    preview_url text,
    pr_url text,
    branch text,
    commit_sha text,
    maxwell jsonb,
    readiness jsonb,
    cost_usd numeric NOT NULL DEFAULT 0,
    cap_usd numeric NOT NULL,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS build_runs_developer_idx ON financial_products.build_runs (developer_id, created_at DESC);
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS sandbox_key_id text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS box_sandbox_id text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS box_until timestamptz;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS verify_sandbox_id text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS verify_step text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS verify_process_id integer;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS verify_prompt_id text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS source_sha256 text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS source_url text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS agent_report jsonb;
  -- sha256 of the token the build's agent uses with Mynt's agent proxy; cleared when the build ends.
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS agent_token_hash text;
  CREATE TABLE IF NOT EXISTS financial_products.build_events (
    id uuid PRIMARY KEY,
    build_id uuid NOT NULL REFERENCES financial_products.build_runs(id),
    at timestamptz NOT NULL DEFAULT now(),
    phase text NOT NULL,
    message text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS build_events_build_idx ON financial_products.build_events (build_id, at);
  CREATE TABLE IF NOT EXISTS financial_products.repo_connections (
    developer_id uuid NOT NULL REFERENCES financial_products.users(id),
    repository text NOT NULL,
    installation_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (developer_id, repository)
  );
`;

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
type Row = Record<string, unknown>;
const toBuild = ({ agent_token_hash: _, ...r }: Row): Build => ({
  ...(r as unknown as Build),
  cost_usd: Number(r.cost_usd ?? 0),
  cap_usd: Number(r.cap_usd),
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  finished_at: iso(r.finished_at),
  box_sandbox_id: (r.box_sandbox_id as string | null) ?? null,
  box_until: iso(r.box_until),
});

// Files the agent reads and writes inside the sandbox. boat.dev's file API only accepts paths under
// the sandbox user's home (/home/user) or /tmp.
// The coding agent works in Mynt's workspaces/coding-build folder; its job files live under job/ there.
const BUILD_JOB = `${workspaceCwd("coding-build")}/job`;
const FILES = { spec: `${BUILD_JOB}/build.json`, status: `${BUILD_JOB}/status.json`, result: `${BUILD_JOB}/result.json`, sdk: `${BUILD_JOB}/sdk` };
const WORKSPACE = "/home/user/workspace/app";
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const OUT = "/home/user/mynt-out";

export class BuildService {
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly boat: BoatClient | null,
    readonly repos: RepoAccess | null,
    readonly config: BuildConfig,
  ) {}

  static async open(db: Db, store: Store, boat: BoatClient | null, repos: RepoAccess | null, config: BuildConfig) {
    await db.exec(TABLES);
    return new BuildService(db, store, boat, repos, config);
  }

  get enabled() {
    return this.boat !== null && !!this.config.agentBackend && !!this.config.publicUrl;
  }

  // ---- the agent (Claude Code, run by Mynt in the sandbox) ----

  // A fresh proxy token for the build; it replaces any earlier one, so only the current agent can call.
  private async mintAgentToken(buildId: string) {
    const token = `mynt_agent_${randomBytes(24).toString("base64url")}`;
    await this.db.query("UPDATE financial_products.build_runs SET agent_token_hash = $2 WHERE id = $1", [buildId, hashToken(token)]);
    return token;
  }

  async agentTokenActive(token: string) {
    return !!(await this.agentRun(token));
  }

  // The build a live agent token belongs to, for the proxy's meter: both the coding agent and the auditor
  // (with whatever they start) spend against the build's cap.
  meter: AgentMeter | null = null;
  async agentRun(token: string): Promise<AgentRun | null> {
    const r = await this.one("SELECT id, cap_usd FROM financial_products.build_runs WHERE agent_token_hash = $1 AND status <> ALL($2)", [hashToken(token), TERMINAL]);
    return r ? { key: `build:${r.id}`, capUsd: Number(r.cap_usd) } : null;
  }

  private async metered(id: string) {
    return this.meter ? this.meter.spent(`build:${id}`) : 0;
  }

  // Claude Code in one of the build's sandboxes, with a fresh proxy token for the build.
  private async startAgent(b: Build, sandbox: string, o: { prompt: string; budgetUsd: number; workspace: string; jobFiles: Record<string, string> }) {
    return launchAgent(this.boat!, this.config, sandbox, { ...o, token: await this.mintAgentToken(b.id) });
  }

  private agentState(sandbox: string, processId: string) {
    return agentState(this.boat!, sandbox, processId);
  }

  // ---- persistence ----

  private async one(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows[0] as Row | undefined;
  }

  async get(id: string) {
    const r = await this.one("SELECT * FROM financial_products.build_runs WHERE id::text = $1", [id]);
    return r && toBuild(r);
  }

  async listFor(developerId: string | null, status?: string) {
    const rows = (
      await this.db.query(
        `SELECT * FROM financial_products.build_runs WHERE ($1::uuid IS NULL OR developer_id = $1) AND ($2::text IS NULL OR status = $2)
         ORDER BY created_at DESC LIMIT 200`,
        [developerId, status ?? null],
      )
    ).rows as Row[];
    return rows.map(toBuild);
  }

  async events(buildId: string) {
    const rows = (await this.db.query("SELECT at, phase, message, data FROM financial_products.build_events WHERE build_id = $1 ORDER BY at", [buildId])).rows as Row[];
    return rows.map((r) => ({ at: iso(r.at), phase: r.phase, message: r.message, data: r.data }));
  }

  private async event(buildId: string, phase: string, message: string, data: unknown = {}) {
    await this.db.query("INSERT INTO financial_products.build_events (id, build_id, phase, message, data) VALUES ($1, $2, $3, $4, $5)", [
      randomUUID(),
      buildId,
      phase,
      message,
      JSON.stringify(data),
    ]);
  }

  private async update(id: string, fields: Partial<Build>) {
    const keys = Object.keys(fields) as (keyof Build)[];
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const values = keys.map((k) => (k === "maxwell" || k === "readiness" || k === "agent_report" ? JSON.stringify(fields[k]) : fields[k]));
    const terminal = fields.status && TERMINAL.includes(fields.status);
    await this.db.query(
      `UPDATE financial_products.build_runs SET ${sets.join(", ")}, updated_at = now()${terminal ? ", finished_at = now()" : ""} WHERE id = $1`,
      [id, ...values],
    );
  }

  async monthSpend(developerId: string) {
    const r = await this.one(
      "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM financial_products.build_runs WHERE developer_id = $1 AND created_at >= date_trunc('month', now())",
      [developerId],
    );
    return Number(r?.s ?? 0);
  }

  async connectRepository(developerId: string, repository: string, installationId: number) {
    await this.db.query(
      `INSERT INTO financial_products.repo_connections (developer_id, repository, installation_id) VALUES ($1, $2, $3)
       ON CONFLICT (developer_id, repository) DO UPDATE SET installation_id = EXCLUDED.installation_id`,
      [developerId, repository.toLowerCase(), installationId],
    );
  }

  async repositories(developerId: string) {
    return (await this.db.query("SELECT repository, created_at FROM financial_products.repo_connections WHERE developer_id = $1 ORDER BY repository", [developerId]))
      .rows as { repository: string; created_at: string }[];
  }

  private async installation(developerId: string, repository: string) {
    const r = await this.one("SELECT installation_id FROM financial_products.repo_connections WHERE developer_id = $1 AND repository = $2", [
      developerId,
      repository.toLowerCase(),
    ]);
    return r ? Number(r.installation_id) : null;
  }

  // ---- lifecycle ----

  async start(developer: User, opts: { goal: string; app_id?: string; repository?: string; cap_usd?: number }) {
    const cap = Math.min(opts.cap_usd ?? this.config.capUsd, this.config.capUsd);
    const spent = await this.monthSpend(developer.id);
    if (spent + cap > this.config.monthlyCapUsd)
      throw new Error(`Monthly build budget reached (US$${spent.toFixed(2)} of US$${this.config.monthlyCapUsd} spent this month)`);
    if (opts.repository && !(await this.installation(developer.id, opts.repository)))
      throw new Error(`Repository '${opts.repository}' isn't connected; run connect_repository first`);
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, repository, status, cap_usd)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
      [id, developer.id, opts.app_id ?? null, opts.goal, opts.repository?.toLowerCase() ?? null, cap],
    );
    await this.event(id, "queued", `Build queued with a US$${cap} cap`);
    return (await this.get(id))!;
  }

  private async retireKey(build: Build) {
    await this.db.query("UPDATE financial_products.build_runs SET agent_token_hash = NULL WHERE id = $1", [build.id]);
    if (build.sandbox_key_id) await this.store.revokeApiKey(build.sandbox_key_id).catch(() => {});
  }

  async stop(build: Build, reason: string, status: BuildStatus = "stopped") {
    if (TERMINAL.includes(build.status)) return build;
    await this.retireKey(build);
    if (build.sandbox_id && this.boat) {
      await this.boat.stop(build.sandbox_id).catch(() => {});
    }
    if (build.verify_sandbox_id && this.boat) await this.boat.stop(build.verify_sandbox_id).catch(() => {});
    await this.update(build.id, { status, error: reason });
    await this.event(build.id, status, reason);
    return (await this.get(build.id))!;
  }

  async steer(build: Build, message: string) {
    if (!build.sandbox_id || !AGENT_PHASES.includes(build.status)) throw new Error(`Build is ${build.status}; only a running agent can be steered`);
    // The runner interrupts the current turn and sends this as the next one.
    await this.boat!.writeFile(build.sandbox_id, `${AGENT_DIR}/inbox/${Date.now()}-${randomUUID().slice(0, 8)}.json`, JSON.stringify({ message }));
    await this.event(build.id, build.status, "Steered by the developer", { message });
  }

  async activity(build: Build, limit = 30) {
    if (!build.sandbox_id || !this.boat) return [];
    const n = Math.max(1, Math.min(200, Math.floor(limit)));
    const tail = await this.boat.exec(build.sandbox_id, `tail -n ${n} ${AGENT_DIR}/agent.jsonl 2>/dev/null || true`, { timeoutSeconds: 30 });
    return tail.stdout
      .split("\n")
      .map((line) => parseJson<Record<string, unknown>>(line))
      .filter((m): m is Record<string, unknown> => !!m)
      .flatMap(summarizeAgentLine)
      .reverse();
  }

  // The build's box: the sandbox the coding agents work in, for as long as it's up (during the build and, once
  // it has shipped, while its preview runs). Everything a developer does there goes on the build's timeline.
  private async box(build: Build): Promise<string> {
    if (this.boat && build.box_sandbox_id && build.box_until && Date.parse(build.box_until) > Date.now()) {
      if (!(await this.prepareBox(build))) throw new Error("The reopened sandbox is still starting; try again in a few seconds");
      return build.box_sandbox_id;
    }
    if (!this.boat || !build.sandbox_id) throw new Error("This build has no sandbox");
    if (build.status === "stopped" || build.status === "over_budget") throw new Error(`The build is ${build.status}; its sandbox is gone (reopen_sandbox starts a fresh one on its branch)`);
    const s = await this.boat.getSandbox(build.sandbox_id);
    if (!["ready", "idle", "running", "provisioned"].includes(s.state)) throw new Error(`The build's sandbox is ${s.state}`);
    return build.sandbox_id;
  }

  async boxExec(build: Build, command: string, timeoutSeconds = 60) {
    const id = await this.box(build);
    const t = Math.max(1, Math.min(BOX_TIMEOUT_MAX, Math.floor(timeoutSeconds)));
    await this.event(build.id, "box", "The developer ran a command in the sandbox", { command });
    const r = await this.boat!.exec(id, `cd ${WORKSPACE} 2>/dev/null || cd ~; ${command}`, { timeoutSeconds: t });
    return { exit_code: r.exitCode, stdout: boxOutput(r.stdout), stderr: boxOutput(r.stderr) };
  }

  // A file's contents, or a directory's listing (paths relative to the app unless absolute).
  async boxFiles(build: Build, path = ".") {
    const id = await this.box(build);
    const target = path.startsWith("/") ? path : `${WORKSPACE}/${path}`;
    const r = await this.boat!.exec(id, `if [ -d ${shellQuote(target)} ]; then echo DIR; ls -la ${shellQuote(target)}; else echo FILE; head -c ${BOX_OUTPUT_LIMIT} ${shellQuote(target)}; fi`, { timeoutSeconds: 30 });
    if (r.exitCode !== 0) return { path: target, error: boxOutput(r.stderr) || "Not found" };
    const [kind, ...rest] = r.stdout.split("\n");
    return kind === "DIR" ? { path: target, listing: boxOutput(rest.join("\n")) } : { path: target, content: boxOutput(rest.join("\n")) };
  }

  // What the agents changed so far: git status and diff of the app.
  async boxDiff(build: Build) {
    const id = await this.box(build);
    const r = await this.boat!.exec(id, `cd ${WORKSPACE} && git status --short && echo ---- && git diff HEAD --stat && echo ---- && git diff HEAD`, { timeoutSeconds: 60 });
    return { exit_code: r.exitCode, diff: boxOutput(r.stdout), stderr: boxOutput(r.stderr) };
  }

  // VS Code in the browser on the sandbox, next to the agents: a token-gated URL plus a password.
  async openEditor(build: Build) {
    const id = await this.box(build);
    const password = randomBytes(18).toString("base64url");
    await this.boat!.writeFile(id, EDITOR_CONFIG, editorConfig(password));
    const r = await this.boat!.exec(id, editorCommand(WORKSPACE), { timeoutSeconds: 300 });
    if (r.exitCode !== 0) throw new Error(`The editor didn't start: ${boxOutput(r.stderr).slice(-500)}`);
    const { url } = await this.boat!.host(id, EDITOR_PORT);
    await this.event(build.id, "box", "The developer opened the editor");
    return { url, password, note: "Opens VS Code on the app the agents are building, with a terminal. Edits land in the same working tree; tell the agents with steer_build." };
  }

  // A fresh sandbox on a finished build's pushed branch: the app checked out where the agents had it, the coding
  // team's workspace beside it, a short-lived GitHub token to push with, for a few hours.
  async reopen(build: Build, hours = 4) {
    if (!this.boat) throw new Error("Sandboxes aren't configured on this deployment");
    if (!TERMINAL.includes(build.status)) throw new Error(`The build is still ${build.status}: use its own sandbox`);
    if (!build.repository || !build.branch || !this.repos) throw new Error("This build pushed no branch, so there's nothing to reopen");
    if (build.box_sandbox_id && build.box_until && Date.parse(build.box_until) > Date.now()) return { sandbox: "already open", until: build.box_until };
    const installation = await this.installation(build.developer_id, build.repository);
    if (!installation) throw new Error(`Mynt's GitHub App can't reach ${build.repository} any more`);
    const { token } = await this.repos.tokenFor(build.repository, installation);
    const ttl = Math.round(Math.max(1, Math.min(8, hours)) * 3600);
    const s = await this.boat.createSandbox({
      name: `mynt-box-${build.id}`,
      type: this.config.sandboxType,
      ttlSeconds: ttl,
      labels: { mynt_build: build.id, mynt_role: "box" },
      env: { GITHUB_REPOSITORY: build.repository, GITHUB_TOKEN: token, MYNT_BRANCH: build.branch, ...(this.config.publicUrl ? { MYNT_API_BASE: `${this.config.publicUrl}/v1` } : {}) },
    });
    const until = new Date(Date.now() + ttl * 1000).toISOString();
    await this.db.query("UPDATE financial_products.build_runs SET box_sandbox_id = $2, box_until = $3, updated_at = now() WHERE id = $1", [build.id, s.id, until]);
    await this.event(build.id, "box", "The developer reopened the build's sandbox on its branch", { until });
    return { sandbox: "provisioning", until };
  }

  // Once a reopened sandbox is up: the branch checked out (the token through a credential helper, never in the
  // URL or the remote), and the coding workspace written beside it.
  private async prepareBox(build: Build) {
    const id = build.box_sandbox_id!;
    const s = await this.boat!.getSandbox(id);
    if (!["ready", "idle", "running", "provisioned"].includes(s.state)) return false;
    if ((await this.boat!.readFile(id, `${OUT}/box.ready`)) !== null) return true;
    const helper = `!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f`;
    const r = await this.boat!.exec(
      id,
      `set -e; git config --global credential.helper ${shellQuote(helper)}; git config --global user.name "Mynt"; git config --global user.email "builds@mynt.invalid"; rm -rf ${WORKSPACE}; git clone --quiet --branch "$MYNT_BRANCH" "https://github.com/$GITHUB_REPOSITORY.git" ${WORKSPACE}; mkdir -p ${OUT}; touch ${OUT}/box.ready; git -C ${WORKSPACE} log --oneline -1`,
      { timeoutSeconds: 300 },
    );
    if (r.exitCode !== 0) throw new Error(`Couldn't check out ${build.branch}: ${boxOutput(r.stderr).slice(-300)}`);
    for (const [path, content] of Object.entries(workspaceFiles("coding-build"))) await this.boat!.writeFile(id, `${workspaceCwd("coding-build")}/${path}`, content);
    return true;
  }

  async boxReady(build: Build) {
    if (!build.box_sandbox_id) return false;
    return this.prepareBox(build);
  }

  async closeBox(build: Build) {
    if (!build.box_sandbox_id) throw new Error("No reopened sandbox for this build");
    if (this.boat) await this.boat.stop(build.box_sandbox_id).catch(() => undefined);
    await this.db.query("UPDATE financial_products.build_runs SET box_sandbox_id = NULL, box_until = NULL, updated_at = now() WHERE id = $1", [build.id]);
    await this.event(build.id, "box", "The developer closed the reopened sandbox");
    return { closed: true };
  }

  // Background loop; tests call tick() directly.
  startWorker(intervalMs = Number(process.env.BUILD_POLL_MS ?? 5000)) {
    if (this.timer || !this.boat) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "build worker");
  }

  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (!this.boat) return;
    const active = (await this.db.query(`SELECT * FROM financial_products.build_runs WHERE status <> ALL($1) ORDER BY created_at`, [TERMINAL])).rows as Row[];
    for (const r of active) {
      const build = toBuild(r);
      try {
        await this.advance(build);
      } catch (e) {
        const current = (await this.get(build.id)) ?? build;
        // Stopped (or otherwise ended) while this tick was in flight: its sandboxes are gone on purpose, and the
        // build keeps the status it ended with.
        if (TERMINAL.includes(current.status)) continue;
        await this.retireKey(current);
        // Don't leave a failed build's machines running until their TTL.
        for (const id of [current.sandbox_id, current.verify_sandbox_id]) if (id) await this.boat.stop(id).catch(() => {});
        await this.update(build.id, { status: "failed", error: (e as Error).message });
        await this.event(build.id, "failed", (e as Error).message);
      }
    }
  }

  private async advance(b: Build) {
    const boat = this.boat!;
    if (b.status === "queued") {
      const env: Record<string, string> = { MYNT_BUILD_ID: b.id };
      // A sandbox key for the app, so the agent tests against Mynt's sandbox (simulated hand-offs).
      let sandboxKeyId: string | null = null;
      if (b.app_id) {
        const { key, secret } = await this.store.createApiKey(b.developer_id, {
          app_id: b.app_id,
          environment: "sandbox",
          label: `build ${b.id.slice(0, 8)}`,
          allowed_origins: [],
        });
        sandboxKeyId = key.id;
        Object.assign(env, { MYNT_SANDBOX_KEY: secret, ...(this.config.publicUrl ? { MYNT_API_BASE: `${this.config.publicUrl}/v1` } : {}) });
      }
      if (b.repository && this.repos) {
        const installation = await this.installation(b.developer_id, b.repository);
        const { token } = await this.repos.tokenFor(b.repository, installation!);
        Object.assign(env, { GITHUB_REPOSITORY: b.repository, GITHUB_TOKEN: token, MYNT_BRANCH: `mynt/build-${b.id.slice(0, 8)}` });
      }
      const sandbox = await boat.createSandbox({
        name: `mynt-build-${b.id}`,
        type: this.config.sandboxType,
        ttlSeconds: this.config.ttlSeconds,
        labels: { mynt_build: b.id },
        env,
      });
      await this.update(b.id, { status: "provisioning", sandbox_id: sandbox.id, sandbox_key_id: sandboxKeyId, branch: env.MYNT_BRANCH ?? null });
      await this.event(b.id, "provisioning", "Sandbox requested", { sandbox_id: sandbox.id });
      return;
    }

    if (b.status === "provisioning") {
      const s = await boat.getSandbox(b.sandbox_id!);
      if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}: ${s.error ?? "no detail"}`);
      if (!["ready", "idle", "running"].includes(s.state)) return;
      const jobFiles: Record<string, string> = { "job/build.json": JSON.stringify(await this.spec(b), null, 2) };
      for (const file of await this.sdkFiles(b)) jobFiles[`job/sdk/${file.path}`] = file.content;
      const processId = await this.startAgent(b, b.sandbox_id!, {
        prompt: "Carry out the build in job/build.json, start to finish, following CLAUDE.md and its skills.",
        budgetUsd: b.cap_usd - b.cost_usd,
        workspace: "coding-build",
        jobFiles,
      });
      await this.update(b.id, { status: "coding", prompt_id: processId, phase_message: "Agent started" });
      await this.event(b.id, "coding", "Coding agent started", { agent: "claude-code", version: CLAUDE_CODE_VERSION, model: this.config.model });
      return;
    }

    if (b.status === "verifying") return this.verify(b);

    // The agent is working: follow its status file, its cost, and its runner.
    const agent = await this.agentState(b.sandbox_id!, b.prompt_id!);
    // The model spend is the larger of what the agent reports and what the proxy metered (which also sees any
    // nested runs the agent started).
    const cost = (await boat.costDollars(b.sandbox_id!)) + Math.max(agent.cost, await this.metered(b.id));
    if (cost !== b.cost_usd) await this.update(b.id, { cost_usd: cost });
    if (cost > b.cap_usd) {
      await this.stop({ ...b, cost_usd: cost }, `Stopped at US$${cost.toFixed(2)}: over the US$${b.cap_usd} cap`, "over_budget");
      return;
    }
    const status = parseJson<{ phase?: string; message?: string }>(await boat.readFile(b.sandbox_id!, FILES.status));
    const phase = status?.phase as BuildStatus | undefined;
    if (phase && AGENT_PHASES.includes(phase) && (phase !== b.status || status?.message !== b.phase_message)) {
      await this.update(b.id, { status: phase, phase_message: status?.message ?? null });
      await this.event(b.id, phase, status?.message ?? phase);
    }
    if (agent.running) return;
    if (!agent.ok) throw new Error(`Coding agent ${agent.state?.error ?? agent.state?.last_subtype ?? `exited with code ${agent.state?.exit_code ?? "unknown"}`}`);
    await this.startVerification(b);
  }

  // The coding agent doesn't grade its own work: Mynt packages the source and verifies it in a fresh
  // sandbox the agent never touched. The agent's report is kept, but only as advice.
  private async startVerification(b: Build) {
    const boat = this.boat!;
    const report = parseJson<AgentResult>(await boat.readFile(b.sandbox_id!, FILES.result));
    const pack = await boat.exec(
      b.sandbox_id!,
      `set -e; mkdir -p ${OUT}; cd ${WORKSPACE}; tar --exclude=./node_modules -czf ${OUT}/app.tgz .; sha256sum ${OUT}/app.tgz`,
      { timeoutSeconds: 300 },
    );
    const sha = pack.stdout.trim().split(/\s+/)[0];
    if (pack.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(sha ?? "")) throw new Error(`Couldn't package the build's source: ${pack.stderr.slice(0, 300)}`);
    // boat signs download URLs for at most an hour; the verifier fetches the source as soon as it starts.
    const url = await boat.downloadUrl(b.sandbox_id!, `${OUT}/app.tgz`, 3600);
    if (!/^https:\/\/[^\s'"`$\\]+$/.test(url)) throw new Error("Unexpected source URL from the sandbox host");
    // No secrets: the verifier needs none.
    const v = await boat.createSandbox({
      name: `mynt-verify-${b.id}`,
      type: this.config.sandboxType,
      ttlSeconds: 2 * 3600,
      labels: { mynt_build: b.id, mynt_role: "verify" },
      env: {},
    });
    await this.update(b.id, {
      status: "verifying",
      verify_step: "provisioning",
      verify_sandbox_id: v.id,
      source_sha256: sha,
      source_url: url,
      agent_report: report ?? null,
      phase_message: "Verifying in a clean sandbox",
    });
    await this.event(b.id, "verifying", "Source packaged; independent verification started", { source_sha256: sha, verify_sandbox_id: v.id });
  }

  private async verify(b: Build) {
    const boat = this.boat!;
    const vid = b.verify_sandbox_id!;
    // Both sandboxes' machine time, plus what the coding agent and the auditor spent on the model.
    const coder = parseJson<AgentState>(await boat.readFile(b.sandbox_id!, `${AGENT_DIR}/state.json`));
    const auditor = b.verify_step === "audit" ? await this.agentState(vid, b.verify_prompt_id!) : null;
    const cost =
      (await boat.costDollars(b.sandbox_id!)) + (await boat.costDollars(vid)) + Math.max((coder?.cost_usd ?? 0) + (auditor?.cost ?? 0), await this.metered(b.id));
    if (cost !== b.cost_usd) await this.update(b.id, { cost_usd: cost });
    if (cost > b.cap_usd) {
      await this.stop({ ...b, cost_usd: cost }, `Stopped at US$${cost.toFixed(2)}: over the US$${b.cap_usd} cap`, "over_budget");
      return;
    }

    if (b.verify_step === "provisioning") {
      const state = (await boat.getSandbox(vid)).state;
      if (state === "error" || state === "cancelled") throw new Error(`Verification sandbox ${state}`);
      if (!["ready", "idle", "running"].includes(state)) return;
      await boat.writeFile(vid, `${VERIFY_DIR}/verify.sh`, VERIFY_SCRIPT);
      await boat.writeFile(vid, `${VERIFY_DIR}/disclosures.json`, JSON.stringify(await this.requiredDisclosures(b)));
      const run = await boat.exec(vid, `bash ${VERIFY_DIR}/verify.sh '${b.source_url}' ${b.source_sha256}`, { detached: true });
      await this.update(b.id, { verify_step: "checks", verify_process_id: run.processId ?? null });
      await this.event(b.id, "verifying", "Running Mynt's checks: tests, lint and types, secrets, dependencies, SBOM, disclosures");
      return;
    }

    if (b.verify_step === "checks") {
      if ((await boat.commandStatus(vid, b.verify_process_id!)).running) return;
      const processId = await this.startAgent(b, vid, {
        prompt: "Audit the application described in job/audit.json, following CLAUDE.md and its skills.",
        budgetUsd: b.cap_usd - cost,
        workspace: "build-audit",
        jobFiles: { "job/audit.json": JSON.stringify({ app_dir: VERIFY_APP, maxwell_repo: this.config.maxwellRepo, output: `${VERIFY_DIR}/maxwell.json` }, null, 2) },
      });
      await this.update(b.id, { verify_step: "audit", verify_prompt_id: processId });
      await this.event(b.id, "verifying", "Checks finished; independent Maxwell audit started");
      return;
    }

    if (b.verify_step === "audit") {
      if (auditor!.running) return;
      await boat.exec(vid, `bash ${VERIFY_DIR}/verify.sh --rehash`, { timeoutSeconds: 300 });
      const [report, maxwell, before, after, changed] = await Promise.all([
        boat.readFile(vid, `${VERIFY_DIR}/report.json`).then((t) => parseJson<{ checks: Check[] }>(t)),
        boat.readFile(vid, `${VERIFY_DIR}/maxwell.json`).then((t) => parseJson<NonNullable<AgentResult["maxwell"]>>(t)),
        boat.readFile(vid, `${VERIFY_DIR}/before.sha`),
        boat.readFile(vid, `${VERIFY_DIR}/after.sha`),
        boat.readFile(vid, `${VERIFY_DIR}/changed.txt`).catch(() => null),
      ]);
      await boat.stop(vid).catch(() => {});
      await this.decide(b, { report, maxwell, unchanged: !!before && before.trim() === after?.trim(), changed: (changed ?? "").split("\n").map((l) => l.trim()).filter(Boolean), auditFinished: auditor!.ok });
    }
  }

  // Ship only what Mynt itself verified: the source unchanged through the audit, no critical or high
  // findings, every check passing, and a pushed branch identical to the verified source.
  private async decide(
    b: Build,
    v: { report: { checks: Check[] } | null; maxwell: AgentResult["maxwell"] | null; unchanged: boolean; changed?: string[]; auditFinished: boolean },
  ) {
    const boat = this.boat!;
    const counts = v.maxwell?.counts ?? {};
    const serious = (counts.critical ?? 0) + (counts.high ?? 0);
    const checks = v.report?.checks ?? [];
    await this.update(b.id, { maxwell: v.maxwell ?? null, readiness: checks });
    const end = async (status: BuildStatus, error: string, data: unknown = {}) => {
      await this.retireKey(b);
      await this.update(b.id, { status, error });
      await this.event(b.id, status, error, data);
    };
    if (!v.report) return end("failed", "Verification didn't produce a report");
    if (!v.unchanged) {
      const files = v.changed?.length ? `: ${v.changed.slice(0, 5).join(", ")}${v.changed.length > 5 ? ", …" : ""}` : "";
      return end("blocked", `The source changed during the audit${files}; the result can't be trusted`, { changed: v.changed ?? [] });
    }
    if (!v.auditFinished || !v.maxwell) return end("blocked", "No independent Maxwell audit result; a build can't ship without one");
    if (serious > 0) return end("blocked", `Security gate: ${serious} critical/high Maxwell finding(s)`, counts);
    const failed = checks.filter((c) => c.status === "fail");
    if (failed.length) return end("failed", `Not production-ready: ${failed.map((c) => c.name).join(", ")}`, failed);

    let commit: string | null = null;
    let pr: string | null = null;
    if (b.repository && b.branch && this.repos) {
      // The branch the agent pushed must be exactly the source Mynt verified.
      const head = await boat.exec(
        b.sandbox_id!,
        `cd ${WORKSPACE} && test -z "$(git status --porcelain)" && git fetch -q origin ${b.branch} && test "$(git rev-parse HEAD)" = "$(git rev-parse FETCH_HEAD)" && git rev-parse HEAD`,
        { timeoutSeconds: 120 },
      );
      commit = head.stdout.trim();
      if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit)) return end("blocked", "The pushed branch doesn't match the verified source");
      const installation = await this.installation(b.developer_id, b.repository);
      pr = await this.repos.openPullRequest(b.repository, installation!, {
        head: b.branch,
        title: `Mynt build: ${b.goal.slice(0, 72)}`,
        body: prBody(b, checks, counts),
      });
    }
    const advisory = b.agent_report as AgentResult | null;
    let preview: string | null = null;
    if (advisory?.preview?.port) preview = (await boat.host(b.sandbox_id!, advisory.preview.port)).url;
    await this.update(b.id, { status: "succeeded", preview_url: preview, pr_url: pr, commit_sha: commit, phase_message: "Verified" });
    await this.event(b.id, "succeeded", "Verified by Mynt and shipped", { preview_url: preview, pr_url: pr, maxwell: counts });
  }

  // Every required disclosure of the app's products, for the verifier to find in the source.
  private async requiredDisclosures(b: Build) {
    if (!b.app_id) return [];
    const app = await this.store.getApp(b.app_id);
    const out: { product_id: string; text: string }[] = [];
    for (const id of app?.product_ids ?? []) {
      const record = await this.store.getProduct(id);
      for (const text of record?.build_terms?.required_disclosures ?? []) out.push({ product_id: id, text });
    }
    return out;
  }

  // What the agent builds against: the app, its products and their terms.
  private async spec(b: Build) {
    const app = b.app_id ? await this.store.getApp(b.app_id) : undefined;
    const developer = await this.store.getUser(b.developer_id);
    const products = [];
    for (const id of app?.product_ids ?? []) {
      const record = await this.store.getProduct(id);
      if (!record || record.status !== "published" || !developer) continue;
      const access = await accessStatus(this.store, developer, record, app?.id ?? null);
      products.push({ ...record.product, version: record.version, build_terms: record.build_terms, access: access.via });
    }
    return {
      // The security audit (Maxwell) runs once, in Mynt's own verification; the coding agent doesn't get it.
      build: { id: b.id, repository: b.repository, branch: b.branch },
      goal: b.goal,
      app: app ?? null,
      products,
      mynt_api: this.config.publicUrl ? `${this.config.publicUrl}/v1` : null,
    };
  }

  // A typed SDK for the app's products, generated fresh for this build.
  private async sdkFiles(b: Build) {
    if (!b.app_id) return [];
    const app = await this.store.getApp(b.app_id);
    const developer = await this.store.getUser(b.developer_id);
    if (!app || !developer) return [];
    const products: SdkProduct[] = [];
    for (const id of app.product_ids) {
      const record = await this.store.getProduct(id);
      if (record?.status !== "published") continue;
      if (!(await accessStatus(this.store, developer, record, app.id)).granted) continue;
      products.push({ record, issuer: (await productEntity(this.store, record))?.name ?? null });
    }
    if (products.length === 0) return [];
    return generateSdk({
      name: app.name,
      version: "0.0.0",
      languages: [...SDK_LANGUAGES], // every stack the app may need: server, web, mobile
      baseUrl: this.config.publicUrl || "https://mynt.example.com",
      products,
    });
  }

}

interface Check {
  name: string;
  status: "pass" | "fail" | "warn";
  detail?: string;
}

function prBody(b: Build, checks: Check[], counts: Record<string, number>) {
  const row = (c: Check) => `| ${c.name} | ${c.status} |`;
  return [
    `Built by a Mynt coding agent and **verified by Mynt** in a clean sandbox.`,
    "",
    `**Goal:** ${b.goal}`,
    "",
    `**Maxwell (independent audit):** critical ${counts.critical ?? 0}, high ${counts.high ?? 0}, medium ${counts.medium ?? 0}, low ${counts.low ?? 0}`,
    "",
    "| Check | Result |",
    "| --- | --- |",
    ...checks.map(row),
    "",
    `Mynt build \`${b.id}\` · source sha256 \`${b.source_sha256}\``,
  ].join("\n");
}

interface AgentResult {
  maxwell?: { counts?: Record<string, number>; findings?: unknown[]; report_path?: string; summary?: string };
  readiness?: { name: string; status: "pass" | "fail" | "warn"; detail?: string }[];
  preview?: { port?: number };
  push?: { branch?: string; commit?: string; pr_url?: string };
  notes?: string;
}

const parseJson = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export function registerCodingAgentTools(server: McpServer, store: Store, user: User, builds: BuildService) {
  const own = async (id: string) => {
    const b = await builds.get(id);
    return b && b.developer_id === user.id ? b : undefined;
  };

  server.registerTool(
    "connect_repository",
    {
      title: "Connect a GitHub repository for builds",
      description:
        "Developer: let Mynt's coding agent push branches and open pull requests on one of your repositories. Install the Mynt GitHub App on it first (the result tells you where).",
      inputSchema: { repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name") },
    },
    async ({ repository }) => {
      if (!builds.repos) return fail("Pushing to repositories isn't set up on this Mynt yet; builds still run and give you a preview");
      const installation = await builds.repos.installationFor(repository);
      if (!installation) return json({ connected: false, install_url: builds.repos.installUrl(), next: `Install the app on ${repository}, then run this again` });
      await builds.connectRepository(user.id, repository, installation);
      await store.audit(user.id, "connect_repository", repository);
      return json({ connected: true, repository });
    },
  );

  server.registerTool(
    "list_repositories",
    { title: "My connected repositories", description: "Developer: repositories builds can push to.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => json(await builds.repositories(user.id)),
  );

  server.registerTool(
    "start_build",
    {
      title: "Start a coding-agent build",
      description:
        "Developer: have Mynt's coding agent build or ship one of your experiences in a sandbox: it writes the code, passes a Maxwell security audit (critical/high findings block it) and a production-readiness checklist, deploys a preview and, with a connected repository, opens a pull request. Spend is capped per build and per month. Track it with get_build.",
      inputSchema: {
        goal: z.string().min(10).describe("What to build or change, in plain words"),
        app_id: z.string().optional().describe("The experience to build (its products, terms and screens are given to the agent)"),
        repository: z.string().optional().describe("A connected repository (owner/name) to push to"),
        cap_usd: z.number().positive().optional().describe("Spend cap for this build, up to the platform maximum"),
      },
    },
    async ({ goal, app_id, repository, cap_usd }) => {
      if (!builds.enabled) return fail("Coding-agent builds aren't enabled on this Mynt yet");
      if (app_id) {
        const app = await store.getApp(app_id);
        if (!app || app.owner_id !== user.id) return fail(`No app of yours with id '${app_id}'`);
      }
      try {
        const b = await builds.start(user, { goal, app_id, repository, cap_usd });
        await store.audit(user.id, "start_build", b.id, { app_id, repository, cap_usd: b.cap_usd });
        return json({ ...b, track_with: "get_build" });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "list_builds",
    {
      title: "My builds",
      description: "Developer: your coding-agent builds, newest first, with status, cost and links; plus this month's spend against your budget.",
      inputSchema: { status: z.enum(BUILD_STATUSES).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) =>
      json({
        month_spend_usd: await builds.monthSpend(user.id),
        monthly_cap_usd: builds.config.monthlyCapUsd,
        builds: (await builds.listFor(user.id, status)).map(({ goal, source_url, agent_report, ...b }) => ({ ...b, goal: goal.slice(0, 140) })),
      }),
  );

  server.registerTool(
    "get_build",
    {
      title: "Track a build",
      description:
        "Developer: one build in full: its phase, timeline, cost against the cap, the Maxwell security summary, readiness checks, preview URL and pull request.",
      inputSchema: { build_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ build_id }) => {
      const b = await own(build_id);
      if (!b) return fail(`No build of yours with id '${build_id}'`);
      const { source_url, ...shown } = b;
      return json({ ...shown, timeline: await builds.events(b.id) });
    },
  );

  server.registerTool(
    "get_build_activity",
    {
      title: "What the coding agent is doing",
      description: "Developer: the coding agent's most recent activity in the sandbox (commands, edits, messages), live.",
      inputSchema: { build_id: z.string(), limit: z.number().int().min(1).max(200).default(30) },
      annotations: { readOnlyHint: true },
    },
    async ({ build_id, limit }) => {
      const b = await own(build_id);
      return b ? json({ status: b.status, phase_message: b.phase_message, activity: await builds.activity(b, limit) }) : fail(`No build of yours with id '${build_id}'`);
    },
  );

  server.registerTool(
    "steer_build",
    {
      title: "Steer a running build",
      description: "Developer: send the coding agent an instruction mid-build (e.g. 'use the existing design system').",
      inputSchema: { build_id: z.string(), message: z.string().min(3) },
    },
    async ({ build_id, message }) => {
      const b = await own(build_id);
      if (!b) return fail(`No build of yours with id '${build_id}'`);
      try {
        await builds.steer(b, message);
        return json({ build_id, steered: true });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  server.registerTool(
    "stop_build",
    {
      title: "Stop a build",
      description: "Developer: stop a build now; its sandbox is stopped and billing ends.",
      inputSchema: { build_id: z.string(), reason: z.string().default("Stopped by the developer") },
      annotations: { destructiveHint: true },
    },
    async ({ build_id, reason }) => {
      const b = await own(build_id);
      return b ? json(await builds.stop(b, reason)) : fail(`No build of yours with id '${build_id}'`);
    },
  );

  // The sandbox where the coding agents work: the developer can look around, run things and edit alongside them.
  const onBox = async <T>(build_id: string, f: (b: Build) => Promise<T>) => {
    const b = await own(build_id);
    if (!b) return fail(`No build of yours with id '${build_id}'`);
    try {
      return json(await f(b));
    } catch (e) {
      return fail((e as Error).message);
    }
  };

  server.registerTool(
    "reopen_sandbox",
    {
      title: "Reopen a finished build's sandbox",
      description:
        "Developer: a fresh sandbox on a finished build's pushed branch, with the coding team's workspace, for a few hours: then open_sandbox_editor, sandbox_run, sandbox_files and sandbox_diff work on it, and you can commit and push to the branch. Call again to see when it's ready.",
      inputSchema: { build_id: z.string(), hours: z.number().min(1).max(8).default(4) },
    },
    async ({ build_id, hours }) =>
      onBox(build_id, async (b) => {
        if (b.box_sandbox_id && b.box_until && Date.parse(b.box_until) > Date.now()) {
          const ready = await builds.boxReady(b);
          return { build_id, ready, until: b.box_until, ...(ready ? { next: "open_sandbox_editor or sandbox_run" } : { next: "call reopen_sandbox again in a few seconds" }) };
        }
        return { build_id, ...(await builds.reopen(b, hours)), ready: false, next: "call reopen_sandbox again in a few seconds" };
      }),
  );

  server.registerTool(
    "close_sandbox",
    {
      title: "Close a reopened sandbox",
      description: "Developer: end the sandbox you reopened on a build's branch (anything not pushed is lost).",
      inputSchema: { build_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ build_id }) => onBox(build_id, (b) => builds.closeBox(b)),
  );

  server.registerTool(
    "open_sandbox_editor",
    {
      title: "Open the build's sandbox in VS Code",
      description:
        "Developer: VS Code in your browser on the sandbox where the coding agents are building your app, with a terminal. Returns a private link and a password. Works while the build runs and, after it ships, while its preview is up.",
      inputSchema: { build_id: z.string() },
    },
    async ({ build_id }) => onBox(build_id, (b) => builds.openEditor(b)),
  );

  server.registerTool(
    "sandbox_run",
    {
      title: "Run a command in the build's sandbox",
      description:
        "Developer: run a shell command in your build's sandbox, in the app's directory (e.g. 'npm test', 'docker compose ps', 'git log --oneline -5'). Output is capped and secrets are scrubbed; every command is on the build's timeline.",
      inputSchema: { build_id: z.string(), command: z.string().min(1).max(4000), timeout_seconds: z.number().int().min(1).max(300).default(60) },
    },
    async ({ build_id, command, timeout_seconds }) => onBox(build_id, (b) => builds.boxExec(b, command, timeout_seconds)),
  );

  server.registerTool(
    "sandbox_files",
    {
      title: "Browse the build's files",
      description: "Developer: list a directory or read a file in your build's sandbox (paths relative to the app, e.g. 'api/src/server.ts').",
      inputSchema: { build_id: z.string(), path: z.string().max(1000).default(".") },
      annotations: { readOnlyHint: true },
    },
    async ({ build_id, path }) => onBox(build_id, (b) => builds.boxFiles(b, path)),
  );

  server.registerTool(
    "sandbox_diff",
    {
      title: "What the agents changed",
      description: "Developer: git status and the full diff of your app in the build's sandbox, so far.",
      inputSchema: { build_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ build_id }) => onBox(build_id, (b) => builds.boxDiff(b)),
  );
}

export function registerCodingAgentAdminTools(server: McpServer, builds: BuildService) {
  server.registerTool(
    "list_all_builds",
    {
      title: "All builds and spend",
      description: "Admin: every developer's coding-agent builds, newest first, and total spend this month.",
      inputSchema: { status: z.enum(BUILD_STATUSES).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      const all = await builds.listFor(null, status);
      return json({ builds: all.map(({ source_url, agent_report, ...b }) => b), total_cost_usd: all.reduce((s, b) => s + b.cost_usd, 0) });
    },
  );
}

// One line of Claude Code's stream-json output, as activity a developer can follow.
function summarizeAgentLine(m: Record<string, unknown>): { type: string; summary: string }[] {
  const clip = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/\s+/g, " ").slice(0, 400);
  if (m.type === "result") return [{ type: "turn_finished", summary: `${clip(m.subtype)}, US$${Number(m.total_cost_usd ?? 0).toFixed(2)}` }];
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (m.type !== "assistant" || !Array.isArray(content)) return [];
  return content.flatMap((c: Record<string, unknown>) =>
    c.type === "text" ? [{ type: "message", summary: clip(c.text) }] : c.type === "tool_use" ? [{ type: "tool_use", summary: `${clip(c.name)} ${clip(c.input)}` }] : [],
  );
}
