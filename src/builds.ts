import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentMeter } from "./agent-meter.js";
import type { AgentRun } from "./agent-proxy.js";
import { serialLoop } from "./worker.js";
import { AGENT_DIR, agentState, launchAgent, workspaceCwd, workspaceFiles, type AgentBackend } from "./agent-host.js";
import { CLAUDE_CODE_VERSION, type AgentState } from "./agent-runner.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessStatus, productEntity } from "./access.js";
import type { SandboxHost } from "./sandbox-host.js";
import { BOX_OUTPUT_LIMIT, BOX_TIMEOUT_MAX, boxOutput, EDITOR_CONFIG, EDITOR_PORT, editorCommand, editorConfig, redact, shellQuote } from "./boxes.js";
import { inTransaction, type Db } from "./db.js";
import type { RepoAccess } from "./github.js";
import { requirePush, type RepoOwnershipService } from "./repo-ownership.js";
import { GoogleServiceAccount } from "./google-auth.js";
import { generateSdk, SDK_LANGUAGES, type SdkProduct } from "./sdk.js";
import { VERIFY_APP, VERIFY_DIR, VERIFY_SCRIPT } from "./verify-script.js";
import { SOLANA_TOOLCHAIN, SOLANA_TOOLCHAIN_SCRIPT, SOLANA_VERIFY_SCRIPT, toolchainRecord, type ToolchainRecord } from "./solana/toolchain.js";
import { loadCrateAllowlist } from "./solana/vuln-db.js";
import { SOLANA_ENV_WIPE_COMMAND, SolanaBuildEnv, ENV_FILES, type SolanaEnvSnapshot } from "./build-env.js";
import type { Store, User } from "./store.js";
import { defaultGraceMs, failureMessage, GraceTracker } from "./transient.js";
export { isQuotaExhausted, isTransient, QUOTA_MESSAGE, QUOTA_PATTERN } from "./transient.js";

// Coding-agent builds: a developer asks Mynt to build or ship one of their experiences; Mynt runs a coding
// agent (Claude Code, run by Mynt itself) in a sandbox that writes the code, passes a Maxwell security audit and a production-
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

// Session builds: how long one waits idle for the developer's next message before it finishes on its own, and the
// message that finishes it (sent by finish_build, or by the runner when idle). Finishing ships the work the usual
// way, so nothing is lost: Mynt then verifies it exactly as any build.
export const SESSION_IDLE_MS = 15 * 60 * 1000;
// Mynt finishes a session itself this long before its sandbox's time limit, or once it has spent this share of its
// cap, so the work is shipped rather than lost when the sandbox ends or the build goes over budget.
export const SESSION_TTL_MARGIN_S = 30 * 60;
export const SESSION_CAP_SHARE = 0.8;
const sessionIdleMs = (v: string | undefined) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n >= 60_000 && n <= 24 * 3600 * 1000 ? n : SESSION_IDLE_MS;
};
export const SESSION_FINISH_PROMPT =
  "Finish the session now: the developer is shipping, or the session has been idle too long. Follow steps 2 to 6 of CLAUDE.md (security self-review, production readiness, preview, push, job/result.json) on the work so far, then stop.";

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
  // Mynt's independent audit: its own model, budget (paid by Mynt, outside the developer's cap), time limit and
  // the Maxwell workflows it runs.
  // `mode`: "none" ships on Mynt's own checks (tests, types, secrets, static scan, dependencies, SBOM,
  // disclosures); "maxwell" adds the agent-run Maxwell audit as a further gate.
  audit: { mode: "none" | "maxwell"; model: string; capUsd: number; minutes: number; workflows: string[] };
  // Boot Solana sandboxes from a pre-built, hash-checked snapshot where the host can take one (build-env.ts).
  solanaSnapshot?: boolean;
  solanaSnapshotMaxAgeDays?: number; // rebuilt once older (SOLANA_BUILD_SNAPSHOT_MAX_AGE_DAYS, default 7)
  // A session build finishes on its own after this long idle (BUILD_SESSION_IDLE_MS, default 15 minutes).
  sessionIdleMs?: number;
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
    audit: {
      mode: env.BUILD_AUDIT === "maxwell" ? "maxwell" : "none",
      model: env.BUILD_AUDIT_MODEL ?? "claude-sonnet-5-5",
      capUsd: Number(env.BUILD_AUDIT_CAP_USD ?? 5),
      minutes: Number(env.BUILD_AUDIT_MINUTES ?? 20),
      workflows: (env.BUILD_AUDIT_WORKFLOWS ?? "execute-scr,probe-cicd-env").split(",").map((w) => w.trim()).filter(Boolean),
    },
    solanaSnapshot: env.SOLANA_BUILD_SNAPSHOT !== "off",
    solanaSnapshotMaxAgeDays: Number(env.SOLANA_BUILD_SNAPSHOT_MAX_AGE_DAYS ?? 7),
    sessionIdleMs: sessionIdleMs(env.BUILD_SESSION_IDLE_MS),
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
  verify_step: "provisioning" | "solana_build" | "checks" | "audit" | null;
  verify_process_id: number | null;
  verify_prompt_id: string | null; // the auditor's runner process in the verify sandbox
  audit_started_at: string | null;
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
  solana: boolean; // the sandbox gets the Solana toolchain, and the app may hold Anchor programs
  solana_check: unknown; // Mynt's own solana_build check, recorded when its Solana build ended
  // The pre-built environment each of the build's sandboxes booted from, if any (build-env.ts).
  solana_env: { build?: SolanaEnvSnapshot; verify?: SolanaEnvSnapshot } | null;
  solana_toolchain: ToolchainRecord | null; // the exact toolchain Mynt's verification built the programs with
  activity_offset: number; // bytes of the agent's stream-json log Mynt has read into build_activity
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  // "once": the agent builds and ships in one go. "session": it stays open between the developer's messages until
  // finish_build (or SESSION_IDLE_MS idle), then ships.
  mode: "once" | "session";
  finish_requested_at: string | null;
  // continue_from: the earlier build whose pushed branch this one starts from.
  continued_from: string | null;
  base_branch: string | null;
  base_commit: string | null;
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
  -- The auditor's own token: a separate meter key, budget and model; cleared when the build ends.
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS audit_token_hash text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS audit_started_at timestamptz;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS solana boolean NOT NULL DEFAULT false;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS solana_check jsonb;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS solana_env jsonb;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS solana_toolchain jsonb;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'once';
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS finish_requested_at timestamptz;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS continued_from uuid;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS base_branch text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS base_commit text;
  ALTER TABLE financial_products.build_runs ADD COLUMN IF NOT EXISTS activity_offset bigint NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS financial_products.build_events (
    id uuid PRIMARY KEY,
    build_id uuid NOT NULL REFERENCES financial_products.build_runs(id),
    at timestamptz NOT NULL DEFAULT now(),
    phase text NOT NULL,
    message text NOT NULL,
    data jsonb NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS build_events_build_idx ON financial_products.build_events (build_id, at);
  -- The coding agent's activity (its messages, commands and edits), summarised by Mynt as the build runs and kept
  -- after the sandbox goes. seq orders it within the build and is the cursor developers page with.
  CREATE TABLE IF NOT EXISTS financial_products.build_activity (
    build_id uuid NOT NULL REFERENCES financial_products.build_runs(id),
    seq integer NOT NULL,
    at timestamptz NOT NULL DEFAULT now(),
    type text NOT NULL,
    summary text NOT NULL,
    PRIMARY KEY (build_id, seq)
  );
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
const toBuild = ({ agent_token_hash: _, audit_token_hash: __, ...r }: Row): Build => ({
  ...(r as unknown as Build),
  cost_usd: Number(r.cost_usd ?? 0),
  cap_usd: Number(r.cap_usd),
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  finished_at: iso(r.finished_at),
  box_sandbox_id: (r.box_sandbox_id as string | null) ?? null,
  box_until: iso(r.box_until),
  mode: r.mode === "session" ? "session" : "once",
  finish_requested_at: iso(r.finish_requested_at),
  continued_from: (r.continued_from as string | null) ?? null,
  base_branch: (r.base_branch as string | null) ?? null,
  base_commit: (r.base_commit as string | null) ?? null,
  audit_started_at: iso(r.audit_started_at),
  solana: !!r.solana,
  solana_env: (r.solana_env as Build["solana_env"]) ?? null,
  solana_toolchain: (r.solana_toolchain as ToolchainRecord | null) ?? null,
  activity_offset: Number(r.activity_offset ?? 0),
});

// What builds need of Mynt's Solana programs (src/solana/): the addresses reserved for an app, so the agent
// declares them, and a place for the programs Mynt itself built while verifying.
export interface BuildSolanaHooks {
  programsForApp(appId: string): Promise<{ name: string; cluster: string; program_id: string; status: string }[]>;
  recordArtifacts(
    buildId: string,
    artifacts: {
      name: string;
      declared_id: string | null;
      sha256: string;
      size: number;
      program: Uint8Array;
      idl: unknown;
      reported_sha256?: string;
      cargo_lock_sha256?: string | null;
      // The workspace exactly as it went into the build container (for the mainnet program gate), as read back.
      sources?: { sha256: string; files: Record<string, string>; binary?: Record<string, string>; links?: Record<string, string> } | null;
      // Every crate of the Cargo.lock the build used, and the source of those not on Mynt's crate allowlist.
      deps?: { sha256: string; data: unknown } | null;
      depinfo?: { sha256: string; data: unknown } | null;
      idl_source?: "build" | null;
      toolchain?: ToolchainRecord;
    }[],
  ): Promise<string[]>;
  artifacts(buildId: string): Promise<{ name: string; sha256: string }[]>;
  recordIdl(buildId: string, name: string, idl: unknown): Promise<void>;
}
// The largest program Mynt reads back from its verify sandbox.
const MAX_PROGRAM_BYTES = 4 * 1024 * 1024;
// The largest captured workspace source or dependency capture (solana-verify.sh caps each at 16 MB of files; JSON
// adds escaping and base64).
const MAX_SOURCES_BYTES = 24 * 1024 * 1024;
// A Solana program is an ELF file.
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

// Files the agent reads and writes inside the sandbox. A sandbox host's file API may only accept paths under
// the sandbox user's home (/home/user) or /tmp.
// The coding agent works in Mynt's workspaces/coding-build folder; its job files live under job/ there.
const BUILD_JOB = `${workspaceCwd("coding-build")}/job`;
const FILES = { spec: `${BUILD_JOB}/build.json`, status: `${BUILD_JOB}/status.json`, result: `${BUILD_JOB}/result.json`, sdk: `${BUILD_JOB}/sdk` };
const WORKSPACE = "/home/user/workspace/app";
// What a failed audit left behind, kept on the build before its sandbox is deleted.
type AuditRun = { result: string | null; exit_code: number | null; error: string | null; summary: string | null; log: string | null; report_written: boolean };

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
// The agent's activity log is read up to ACTIVITY_CHUNK bytes at a time, a few chunks a tick (more once the agent has
// exited, to read it to the end), and each build keeps its latest ACTIVITY_KEEP entries.
const ACTIVITY_CHUNK = 256 * 1024;
const ACTIVITY_CHUNKS_PER_TICK = 8;
const ACTIVITY_CHUNKS_AT_END = 64;
export const ACTIVITY_KEEP = 5000;

// The complete lines in `buf`, read from the log one byte before the offset when `prefixed` (that byte is a newline
// when the offset is at the start of a line), and how many bytes past the offset are now dealt with. A line longer
// than a whole chunk (a huge tool result, say) is skipped rather than waited for; a shorter one with no newline yet
// is still being written, and waits.
export function activityLines(buf: Buffer, prefixed: boolean, chunk: number): { consumed: number; lines: string[] } {
  let start = 0;
  if (prefixed) {
    if (buf.length === 0) return { consumed: 0, lines: [] };
    start = 1;
    if (buf[0] !== 0x0a) {
      // Partway through a line being skipped: drop the rest of it.
      const nl = buf.indexOf(0x0a, 1);
      if (nl < 0) return { consumed: buf.length - 1, lines: [] };
      start = nl + 1;
    }
  }
  const skipped = start - (prefixed ? 1 : 0);
  const body = buf.subarray(start);
  const last = body.lastIndexOf(0x0a);
  if (last < 0) return { consumed: skipped + (body.length >= chunk ? body.length : 0), lines: [] };
  const lines = body.subarray(0, last + 1).toString("utf8").split("\n").filter((l) => l.trim());
  return { consumed: skipped + last + 1, lines };
}
const OUT = "/home/user/mynt-out";
const SOLANA_INSTALLER = ENV_FILES.installer;

export class BuildService {
  private timer: NodeJS.Timeout | null = null;
  solana: BuildSolanaHooks | null = null;
  // Who may push where (src/repo-ownership.ts): checked on every repository a developer connects or builds on.
  ownership: RepoOwnershipService | null = null;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly sandboxes: SandboxHost | null,
    readonly repos: RepoAccess | null,
    readonly config: BuildConfig,
    readonly solanaEnv: SolanaBuildEnv,
  ) {}

  static async open(db: Db, store: Store, sandboxes: SandboxHost | null, repos: RepoAccess | null, config: BuildConfig) {
    await db.exec(TABLES);
    const solanaEnv = await SolanaBuildEnv.open(db, sandboxes, { enabled: config.solanaSnapshot ?? true, sandboxType: config.sandboxType, maxAgeDays: config.solanaSnapshotMaxAgeDays });
    return new BuildService(db, store, sandboxes, repos, config, solanaEnv);
  }

  get enabled() {
    return this.sandboxes !== null && !!this.config.agentBackend && !!this.config.publicUrl;
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

  // The run a live agent token belongs to, for the proxy's meter. The coding agent (with whatever it starts)
  // spends against the build's cap; Mynt's auditor against its own budget, on its own model.
  meter: AgentMeter | null = null;
  async agentRun(token: string): Promise<AgentRun | null> {
    const h = hashToken(token);
    const r = await this.one("SELECT id, cap_usd FROM financial_products.build_runs WHERE agent_token_hash = $1 AND status <> ALL($2)", [h, TERMINAL]);
    if (r) return { key: `build:${r.id}`, capUsd: Number(r.cap_usd) };
    const a = await this.one("SELECT id FROM financial_products.build_runs WHERE audit_token_hash = $1 AND status <> ALL($2)", [h, TERMINAL]);
    return a ? { key: `audit:${a.id}`, capUsd: this.config.audit.capUsd, model: this.config.audit.model } : null;
  }

  // Mynt's auditor: its own token (the coding agent's is retired), budget and model.
  private async startAuditor(b: Build, sandbox: string, o: { prompt: string; workspace: string; jobFiles: Record<string, string> }) {
    const token = `mynt_agent_${randomBytes(24).toString("base64url")}`;
    await this.db.query("UPDATE financial_products.build_runs SET agent_token_hash = NULL, audit_token_hash = $2, audit_started_at = now() WHERE id = $1", [b.id, hashToken(token)]);
    return launchAgent(this.sandboxes!, this.config, sandbox, { ...o, budgetUsd: this.config.audit.capUsd, model: this.config.audit.model, token });
  }

  private async metered(id: string) {
    return this.meter ? this.meter.spent(`build:${id}`) : 0;
  }

  // Claude Code in one of the build's sandboxes, with a fresh proxy token for the build.
  private async startAgent(b: Build, sandbox: string, o: { prompt: string; budgetUsd: number; workspace: string; jobFiles: Record<string, string> }) {
    return launchAgent(this.sandboxes!, this.config, sandbox, { ...o, token: await this.mintAgentToken(b.id) });
  }

  private agentState(sandbox: string, processId: string) {
    return agentState(this.sandboxes!, sandbox, processId);
  }

  // The pinned Solana toolchain, installed in the background (a few minutes, about 2 GB); the agents wait for
  // ~/.mynt-solana/env before they use it. A sandbox booted from the pre-built environment checks it against the
  // hash Mynt kept first (holding the env file back until it passes); the installer then finds it complete, or
  // (when the check wiped it, or ended any other way and Mynt's wipe ran) installs it afresh.
  private async installSolana(sandbox: string, env?: SolanaEnvSnapshot) {
    await this.sandboxes!.writeFile(sandbox, SOLANA_INSTALLER, SOLANA_TOOLCHAIN_SCRIPT);
    let check = "";
    if (env) {
      await this.solanaEnv.writeCheck(sandbox);
      check = this.solanaEnv.backgroundCheck(env);
    }
    await this.sandboxes!.exec(sandbox, `${check}bash ${SOLANA_INSTALLER} > /home/user/.mynt-solana-install.log 2>&1`, { detached: true });
  }

  // A Solana sandbox: booted from the pre-built environment when there is one (a snapshot that won't boot is
  // dropped, and the sandbox starts plain; a transient host error is retried by the worker instead), else plain.
  // Returns the environment it booted from.
  private async solanaSandbox(opts: Parameters<SandboxHost["createSandbox"]>[0], solana: boolean) {
    const env = solana ? await this.solanaEnv.ready().catch(() => null) : null;
    if (env) {
      try {
        const sandbox = await this.sandboxes!.createSandbox({ ...opts, snapshot: env.snapshot_id });
        await this.solanaEnv.used(env);
        return { sandbox, env };
      } catch (e) {
        await this.solanaEnv.bootFailed(env, e);
      }
    }
    return { sandbox: await this.sandboxes!.createSandbox(opts), env: undefined };
  }

  // ---- persistence ----

  private async one(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows[0] as Row | undefined;
  }

  async get(id: string) {
    const r = await this.one("SELECT * FROM financial_products.build_runs WHERE id::text = $1", [id]);
    return r && toBuild(r);
  }

  async listFor(developerId: string | null, status?: string, appId?: string) {
    const rows = (
      await this.db.query(
        `SELECT * FROM financial_products.build_runs WHERE ($1::uuid IS NULL OR developer_id = $1) AND ($2::text IS NULL OR status = $2)
         AND ($3::text IS NULL OR app_id::text = $3)
         ORDER BY created_at DESC LIMIT 200`,
        [developerId, status ?? null, appId ?? null],
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
    const values = keys.map((k) =>
      k === "maxwell" || k === "readiness" || k === "agent_report" || k === "solana_check" || k === "solana_env" || k === "solana_toolchain" ? JSON.stringify(fields[k]) : fields[k],
    );
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

  async start(
    developer: User,
    opts: { goal: string; app_id?: string; repository?: string; cap_usd?: number; solana?: boolean; mode?: "once" | "session"; continue_from?: string },
  ) {
    // Continuing an earlier build: the agents start from the branch it pushed, on the same app and repository.
    let base: Build | null = null;
    if (opts.continue_from) {
      const prev = await this.get(opts.continue_from);
      if (!prev || prev.developer_id !== developer.id) throw new Error(`No build of yours with id '${opts.continue_from}' to continue from`);
      if (!TERMINAL.includes(prev.status)) throw new Error(`Build ${prev.id} is still ${prev.status}: steer it, or stop it before continuing from it`);
      // Only a build whose push Mynt confirmed: it verified the pushed commit (commit_sha) and opened its pull request.
      if (!prev.repository || !prev.branch || !(prev.commit_sha || prev.pr_url)) throw new Error(`Build ${prev.id} pushed no verified branch, so there's nothing to continue from`);
      if (opts.app_id && prev.app_id && opts.app_id !== prev.app_id) throw new Error(`Build ${prev.id} is for another app`);
      if (opts.repository && opts.repository.toLowerCase() !== prev.repository) throw new Error(`Build ${prev.id} pushed to ${prev.repository}, not ${opts.repository}`);
      base = prev;
      opts = { ...opts, app_id: opts.app_id ?? prev.app_id ?? undefined, repository: prev.repository, solana: opts.solana ?? (prev.solana || undefined) };
    }
    const cap = Math.min(opts.cap_usd ?? this.config.capUsd, this.config.capUsd);
    const spent = await this.monthSpend(developer.id);
    // A build reserves its whole cap, so say which limit it hit: the month is used up, or this cap is more than
    // what's left (and how much a smaller cap may be).
    const left = Math.max(0, this.config.monthlyCapUsd - spent);
    if (left < 0.5) throw new Error(`Monthly build budget used up (US$${spent.toFixed(2)} of US$${this.config.monthlyCapUsd} spent this month)`);
    if (cap > left)
      throw new Error(
        `This build's cap (US$${cap}) is more than this month's remaining build budget (US$${left.toFixed(2)} of US$${this.config.monthlyCapUsd}); start it with cap_usd of at most ${Math.floor(left * 100) / 100}`,
      );
    if (opts.repository && !(await this.installation(developer.id, opts.repository)))
      throw new Error(`Repository '${opts.repository}' isn't connected; run connect_repository first`);
    // Checked again at every build, connections made before this check existed included: a developer who can no
    // longer push there (or never could) gets no push token for it.
    if (opts.repository) await requirePush(this.ownership, developer.id, opts.repository);
    const id = randomUUID();
    // The Solana toolchain when asked for, or when the app has programs reserved.
    const solana = opts.solana ?? (!!opts.app_id && !!this.solana && (await this.solana.programsForApp(opts.app_id)).length > 0);
    const mode = opts.mode ?? "once";
    await this.db.query(
      `INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, repository, status, cap_usd, solana, mode, continued_from, base_branch, base_commit)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10, $11)`,
      [id, developer.id, opts.app_id ?? null, opts.goal, opts.repository?.toLowerCase() ?? null, cap, solana, mode, base?.id ?? null, base?.branch ?? null, base?.commit_sha ?? null],
    );
    const what = mode === "session" ? "Session build" : "Build";
    await this.event(id, "queued", `${what} queued with a US$${cap} cap${base ? `, continuing from ${base.branch}` : ""}`, base ? { continued_from: base.id } : {});
    return (await this.get(id))!;
  }

  // Ends a session: the agent gets the finish message once its current turn is over, ships the work (review,
  // checks, preview, push) and exits, and Mynt verifies it as any build. Spend stops only when the build ends.
  // `reason`: the developer's finish_build, or Mynt's own before the sandbox's time limit ("ttl") or the cap ("cap").
  // Claimed in the database first, so concurrent calls write one finish item, and a steer can't slip in after it.
  async finish(build: Build, reason: "developer" | "ttl" | "cap" = "developer") {
    if (build.mode !== "session") throw new Error("Only a session build is finished with finish_build; this build ships on its own");
    if (!build.sandbox_id || !AGENT_PHASES.includes(build.status)) throw new Error(`Build is ${build.status}; only a running session can be finished`);
    const claimed = await this.one(
      "UPDATE financial_products.build_runs SET finish_requested_at = now(), updated_at = now() WHERE id = $1 AND finish_requested_at IS NULL AND status = ANY($2) RETURNING finish_requested_at",
      [build.id, AGENT_PHASES],
    );
    if (!claimed) {
      const now = await this.get(build.id);
      if (now?.finish_requested_at) return { finishing: true, since: now.finish_requested_at };
      throw new Error(`Build is ${now?.status ?? "gone"}; only a running session can be finished`);
    }
    try {
      await this.toInbox(build.sandbox_id, { finish: true, reason, message: SESSION_FINISH_PROMPT }, "-finish");
    } catch (e) {
      await this.db.query("UPDATE financial_products.build_runs SET finish_requested_at = NULL WHERE id = $1", [build.id]);
      throw e;
    }
    const why = {
      developer: "The developer finished the session",
      ttl: "The session is near its sandbox's time limit, so Mynt finished it",
      cap: "The session has spent most of its cap, so Mynt finished it",
    }[reason];
    await this.event(build.id, build.status, `${why}: the agent ships the work, then Mynt verifies it`);
    return { finishing: true, since: iso(claimed.finish_requested_at)! };
  }

  // A running session: record a finish the runner started itself (idle), so steering stops; finish it before the
  // sandbox's time limit or the cap would end it with the work unshipped; and say when messages that arrived while it
  // was finishing weren't delivered.
  private async followSession(b: Build, state: AgentState | null, running: boolean, cost: number) {
    if (state?.finish && !b.finish_requested_at) {
      const set = await this.one(
        "UPDATE financial_products.build_runs SET finish_requested_at = now(), updated_at = now() WHERE id = $1 AND finish_requested_at IS NULL RETURNING id",
        [b.id],
      );
      if (set)
        await this.event(b.id, b.status, state.finish === "idle" ? "The session was idle too long: the agent ships the work, then Mynt verifies it" : `The session is finishing (${state.finish})`);
      b = { ...b, finish_requested_at: new Date().toISOString() };
    }
    if (running && !b.finish_requested_at && !state?.finish) {
      const nearTtl = Date.now() - Date.parse(b.created_at) > Math.max(0, this.config.ttlSeconds - SESSION_TTL_MARGIN_S) * 1000;
      if (nearTtl) await this.finish(b, "ttl").catch((e) => console.error(`Build ${b.id} finish: ${(e as Error).message}`));
      else if (cost >= SESSION_CAP_SHARE * b.cap_usd) await this.finish(b, "cap").catch((e) => console.error(`Build ${b.id} finish: ${(e as Error).message}`));
    }
    if (!running && (state?.undelivered ?? 0) > 0)
      await this.event(b.id, b.status, `${state!.undelivered} message(s) arrived while the session was finishing and weren't delivered; send them in a new build with continue_from`);
  }

  // An item for the runner's inbox, written under a dot-name and renamed into place, so the runner never reads half
  // of one.
  private async toInbox(sandbox: string, item: unknown, suffix = "") {
    const name = `${Date.now()}-${randomUUID().slice(0, 8)}${suffix}.json`;
    const tmp = `${AGENT_DIR}/inbox/.${name}`;
    await this.sandboxes!.writeFile(sandbox, tmp, JSON.stringify(item));
    const r = await this.sandboxes!.exec(sandbox, `mv -f ${shellQuote(tmp)} ${shellQuote(`${AGENT_DIR}/inbox/${name}`)}`, { timeoutSeconds: 30 });
    if (r.exitCode !== 0) throw new Error("Couldn't deliver the message to the agent");
  }

  private async retireKey(build: Build) {
    await this.db.query("UPDATE financial_products.build_runs SET agent_token_hash = NULL, audit_token_hash = NULL WHERE id = $1", [build.id]);
    if (build.sandbox_key_id) await this.store.revokeApiKey(build.sandbox_key_id).catch(() => {});
  }

  async stop(build: Build, reason: string, status: BuildStatus = "stopped") {
    if (TERMINAL.includes(build.status)) return build;
    await this.retireKey(build);
    // What the agent did last, read before its sandbox goes, briefly: a stuck sandbox mustn't hold up a stop.
    if (AGENT_PHASES.includes(build.status)) await this.collectActivitySafely((await this.get(build.id)) ?? build, { maxChunks: 4, timeoutSeconds: 10, toEnd: true });
    if (build.sandbox_id && this.sandboxes) {
      await this.sandboxes.stop(build.sandbox_id).catch(() => {});
    }
    if (build.verify_sandbox_id && this.sandboxes) await this.sandboxes.stop(build.verify_sandbox_id).catch(() => {});
    await this.update(build.id, { status, error: reason });
    await this.event(build.id, status, reason);
    return (await this.get(build.id))!;
  }

  async steer(build: Build, message: string) {
    if (!build.sandbox_id || !AGENT_PHASES.includes(build.status)) throw new Error(`Build is ${build.status}; only a running agent can be steered`);
    // Checked against the database as it is now, not as this request loaded it: a session that started finishing in
    // the meantime (finish_build, or the runner's own idle finish, recorded by the worker) takes no more messages.
    const open = await this.one(
      "UPDATE financial_products.build_runs SET updated_at = now() WHERE id = $1 AND finish_requested_at IS NULL AND status = ANY($2) RETURNING id",
      [build.id, AGENT_PHASES],
    );
    if (!open) {
      const now = await this.get(build.id);
      if (now?.finish_requested_at) throw new Error("The session is finishing; continue in a new build with continue_from once it ends");
      throw new Error(`Build is ${now?.status ?? "gone"}; only a running agent can be steered`);
    }
    // The runner interrupts the current turn and sends this as the next one. (If a finish lands between this check
    // and the write, the runner holds this message back and the build's timeline says it wasn't delivered.)
    await this.toInbox(build.sandbox_id, { message });
    await this.event(build.id, build.status, "Steered by the developer", { message });
  }

  // The agent's stored activity. Without `after`: the latest `limit` entries, newest first. With `after` (a cursor
  // from an earlier call): the entries after it, oldest first. `cursor` is the newest seq returned (or already
  // seen), to pass as `after` next time; it stays put while nothing new has arrived.
  async activity(build: Build, opts: { limit?: number; after?: number } = {}) {
    const n = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 30)));
    const rows = (
      opts.after == null
        ? await this.db.query("SELECT seq, at, type, summary FROM financial_products.build_activity WHERE build_id = $1 ORDER BY seq DESC LIMIT $2", [build.id, n])
        : await this.db.query("SELECT seq, at, type, summary FROM financial_products.build_activity WHERE build_id = $1 AND seq > $2 ORDER BY seq LIMIT $3", [build.id, opts.after, n])
    ).rows as Row[];
    const activity = rows.map((r) => ({ seq: Number(r.seq), at: iso(r.at)!, type: r.type as string, summary: r.summary as string }));
    // The oldest entry still kept: past the per-build limit, the oldest go, so a follower whose cursor is below
    // first_seq - 1 has missed some.
    const first = (await this.db.query("SELECT MIN(seq) AS m FROM financial_products.build_activity WHERE build_id = $1", [build.id])).rows[0] as Row | undefined;
    return { activity, cursor: activity.reduce((m, a) => Math.max(m, a.seq), opts.after ?? 0), first_seq: first?.m == null ? null : Number(first.m) };
  }

  // Reads what the agent wrote to its stream-json log since last time into build_activity: a chunk at a time,
  // base64-encoded so byte offsets stay exact, complete lines only. The new offset is claimed in the same transaction
  // that stores the rows, so two readers never store the same lines. What the agent says is its own account: shown
  // to the developer, never trusted.
  async collectActivity(b: Build, maxChunks = ACTIVITY_CHUNKS_PER_TICK, timeoutSeconds = 60): Promise<{ complete: boolean; offset: number } | null> {
    if (!this.sandboxes || !b.sandbox_id) return null;
    let offset = b.activity_offset;
    for (let i = 0; i < maxChunks; i++) {
      // From one byte before the offset, so the first byte says whether the offset is at the start of a line.
      const from = Math.max(0, offset - 1);
      const want = ACTIVITY_CHUNK + (offset > 0 ? 1 : 0);
      const r = await this.sandboxes.exec(
        b.sandbox_id,
        `f=${AGENT_DIR}/agent.jsonl; if [ -f "$f" ]; then tail -c +${from + 1} "$f" | head -c ${want} | base64 -w0; fi`,
        { timeoutSeconds },
      );
      if (r.exitCode !== 0) return { complete: false, offset };
      const buf = Buffer.from(r.stdout.trim(), "base64");
      const { consumed, lines } = activityLines(buf, offset > 0, ACTIVITY_CHUNK);
      if (consumed === 0) return { complete: true, offset };
      const entries = lines
        .map((line) => parseJson<Record<string, unknown>>(line))
        .filter((m): m is Record<string, unknown> => !!m)
        .flatMap(summarizeAgentLine);
      // All of the chunk's entries in one statement; if the database refuses that, one at a time, each on its own
      // savepoint, so an entry it won't take is dropped and the offset still moves on: one bad line never stalls it.
      let claimed: boolean;
      try {
        claimed = await this.storeActivity(b.id, offset, offset + consumed, entries, false);
      } catch (e) {
        console.error(`Build ${b.id} activity: storing entries one by one (${(e as Error).message})`);
        claimed = await this.storeActivity(b.id, offset, offset + consumed, entries, true);
      }
      if (!claimed) return { complete: true, offset };
      offset += consumed;
      if (buf.length < want) return { complete: true, offset }; // read to the end of what's there
    }
    return { complete: false, offset };
  }

  private storeActivity(buildId: string, from: number, to: number, entries: { type: string; summary: string }[], oneByOne: boolean) {
    return inTransaction(this.db, async (tx) => {
      const moved = await tx.query("UPDATE financial_products.build_runs SET activity_offset = $3 WHERE id = $1 AND activity_offset = $2 RETURNING id", [buildId, from, to]);
      if (moved.rows.length === 0) return false;
      if (entries.length === 0) return true;
      let top = Number(((await tx.query("SELECT COALESCE(MAX(seq), 0) AS m FROM financial_products.build_activity WHERE build_id = $1", [buildId])).rows[0] as Row).m);
      const insert = "INSERT INTO financial_products.build_activity (build_id, seq, type, summary) VALUES ";
      if (!oneByOne) {
        const values = entries.map((_, k) => `($1, $${k * 3 + 2}, $${k * 3 + 3}, $${k * 3 + 4})`);
        await tx.query(insert + values.join(", "), [buildId, ...entries.flatMap((e, k) => [top + k + 1, e.type, e.summary])]);
        top += entries.length;
      } else {
        for (const e of entries) {
          await tx.query("SAVEPOINT activity_entry");
          try {
            await tx.query(insert + "($1, $2, $3, $4)", [buildId, top + 1, e.type, e.summary]);
            await tx.query("RELEASE SAVEPOINT activity_entry");
            top += 1;
          } catch (err) {
            await tx.query("ROLLBACK TO SAVEPOINT activity_entry");
            console.error(`Build ${buildId} activity: dropped an entry the database refused (${(err as Error).message})`);
          }
        }
      }
      // Only a build's latest ACTIVITY_KEEP entries are kept.
      await tx.query("DELETE FROM financial_products.build_activity WHERE build_id = $1 AND seq <= $2", [buildId, top - ACTIVITY_KEEP]);
      return true;
    });
  }

  // Activity is a convenience: failing to read it never fails or holds up a build. When it should have been read to
  // the end (the agent exited, or the build is ending) and wasn't, say how much was left unread.
  private async collectActivitySafely(b: Build, opts: { maxChunks?: number; timeoutSeconds?: number; toEnd?: boolean } = {}) {
    try {
      const r = await this.collectActivity(b, opts.maxChunks, opts.timeoutSeconds);
      if (r && !r.complete && opts.toEnd && this.sandboxes && b.sandbox_id) {
        const size = await this.sandboxes.exec(b.sandbox_id, `stat -c %s ${AGENT_DIR}/agent.jsonl 2>/dev/null || echo 0`, { timeoutSeconds: opts.timeoutSeconds ?? 30 });
        const left = Math.max(0, Number(size.stdout.trim()) - r.offset);
        if (left > 0) console.error(`Build ${b.id} activity: ${left} bytes of the agent's log were left unread`);
      }
    } catch (e) {
      console.error(`Build ${b.id} activity: ${(e as Error).message}`);
    }
  }

  // The build's box: the sandbox the coding agents work in, for as long as it's up (during the build and, once
  // it has shipped, while its preview runs). Everything a developer does there goes on the build's timeline.
  private async box(build: Build): Promise<string> {
    if (this.sandboxes && build.box_sandbox_id && build.box_until && Date.parse(build.box_until) > Date.now()) {
      if (!(await this.prepareBox(build))) throw new Error("The reopened sandbox is still starting; try again in a few seconds");
      return build.box_sandbox_id;
    }
    if (!this.sandboxes || !build.sandbox_id) throw new Error("This build has no sandbox");
    if (build.status === "stopped" || build.status === "over_budget") throw new Error(`The build is ${build.status}; its sandbox is gone (reopen_sandbox starts a fresh one on its branch)`);
    const s = await this.sandboxes.getSandbox(build.sandbox_id);
    if (!["ready", "idle", "running", "provisioned"].includes(s.state)) throw new Error(`The build's sandbox is ${s.state}`);
    return build.sandbox_id;
  }

  async boxExec(build: Build, command: string, timeoutSeconds = 60) {
    const id = await this.box(build);
    const t = Math.max(1, Math.min(BOX_TIMEOUT_MAX, Math.floor(timeoutSeconds)));
    await this.event(build.id, "box", "The developer ran a command in the sandbox", { command });
    const r = await this.sandboxes!.exec(id, `cd ${WORKSPACE} 2>/dev/null || cd ~; ${command}`, { timeoutSeconds: t });
    return { exit_code: r.exitCode, stdout: boxOutput(r.stdout), stderr: boxOutput(r.stderr) };
  }

  // A file's contents, or a directory's listing (paths relative to the app unless absolute).
  async boxFiles(build: Build, path = ".") {
    const id = await this.box(build);
    const target = path.startsWith("/") ? path : `${WORKSPACE}/${path}`;
    const r = await this.sandboxes!.exec(id, `if [ -d ${shellQuote(target)} ]; then echo DIR; ls -la ${shellQuote(target)}; else echo FILE; head -c ${BOX_OUTPUT_LIMIT} ${shellQuote(target)}; fi`, { timeoutSeconds: 30 });
    if (r.exitCode !== 0) return { path: target, error: boxOutput(r.stderr) || "Not found" };
    const [kind, ...rest] = r.stdout.split("\n");
    return kind === "DIR" ? { path: target, listing: boxOutput(rest.join("\n")) } : { path: target, content: boxOutput(rest.join("\n")) };
  }

  // What the agents changed so far: git status and diff of the app.
  async boxDiff(build: Build) {
    const id = await this.box(build);
    const r = await this.sandboxes!.exec(id, `cd ${WORKSPACE} && git status --short && echo ---- && git diff HEAD --stat && echo ---- && git diff HEAD`, { timeoutSeconds: 60 });
    return { exit_code: r.exitCode, diff: boxOutput(r.stdout), stderr: boxOutput(r.stderr) };
  }

  // VS Code in the browser on the sandbox, next to the agents: a token-gated URL plus a password.
  async openEditor(build: Build) {
    const id = await this.box(build);
    const password = randomBytes(18).toString("base64url");
    await this.sandboxes!.writeFile(id, EDITOR_CONFIG, editorConfig(password));
    const r = await this.sandboxes!.exec(id, editorCommand(WORKSPACE), { timeoutSeconds: 300 });
    if (r.exitCode !== 0) throw new Error(`The editor didn't start: ${boxOutput(r.stderr).slice(-500)}`);
    const { url } = await this.sandboxes!.host(id, EDITOR_PORT);
    await this.event(build.id, "box", "The developer opened the editor");
    return { url, password, note: "Opens VS Code on the app the agents are building, with a terminal. Edits land in the same working tree; tell the agents with steer_build." };
  }

  // A fresh sandbox on a finished build's pushed branch: the app checked out where the agents had it, the coding
  // team's workspace beside it, a short-lived GitHub token to push with, for a few hours.
  async reopen(build: Build, hours = 4) {
    if (!this.sandboxes) throw new Error("Sandboxes aren't configured on this deployment");
    if (!TERMINAL.includes(build.status)) throw new Error(`The build is still ${build.status}: use its own sandbox`);
    if (!build.repository || !build.branch || !this.repos) throw new Error("This build pushed no branch, so there's nothing to reopen");
    if (build.box_sandbox_id && build.box_until && Date.parse(build.box_until) > Date.now()) return { sandbox: "already open", until: build.box_until };
    const installation = await this.installation(build.developer_id, build.repository);
    if (!installation) throw new Error(`Mynt's GitHub App can't reach ${build.repository} any more`);
    // The reopened sandbox gets a push token: only for a developer who can still push there.
    await requirePush(this.ownership, build.developer_id, build.repository);
    const { token } = await this.repos.tokenFor(build.repository, installation);
    const ttl = Math.round(Math.max(1, Math.min(8, hours)) * 3600);
    const s = await this.sandboxes.createSandbox({
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
    const s = await this.sandboxes!.getSandbox(id);
    if (!["ready", "idle", "running", "provisioned"].includes(s.state)) return false;
    if ((await this.sandboxes!.readFile(id, `${OUT}/box.ready`)) !== null) return true;
    const helper = `!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f`;
    const r = await this.sandboxes!.exec(
      id,
      `set -e; git config --global credential.helper ${shellQuote(helper)}; git config --global user.name "Mynt"; git config --global user.email "builds@mynt.invalid"; rm -rf ${WORKSPACE}; git clone --quiet --branch "$MYNT_BRANCH" "https://github.com/$GITHUB_REPOSITORY.git" ${WORKSPACE}; mkdir -p ${OUT}; touch ${OUT}/box.ready; git -C ${WORKSPACE} log --oneline -1`,
      { timeoutSeconds: 300 },
    );
    if (r.exitCode !== 0) throw new Error(`Couldn't check out ${build.branch}: ${boxOutput(r.stderr).slice(-300)}`);
    for (const [path, content] of Object.entries(workspaceFiles("coding-build"))) await this.sandboxes!.writeFile(id, `${workspaceCwd("coding-build")}/${path}`, content);
    if (build.solana) await this.installSolana(id);
    return true;
  }

  async boxReady(build: Build) {
    if (!build.box_sandbox_id) return false;
    return this.prepareBox(build);
  }

  async closeBox(build: Build) {
    if (!build.box_sandbox_id) throw new Error("No reopened sandbox for this build");
    if (this.sandboxes) await this.sandboxes.stop(build.box_sandbox_id).catch(() => undefined);
    await this.db.query("UPDATE financial_products.build_runs SET box_sandbox_id = NULL, box_until = NULL, updated_at = now() WHERE id = $1", [build.id]);
    await this.event(build.id, "box", "The developer closed the reopened sandbox");
    return { closed: true };
  }

  // Background loop; tests call tick() directly.
  startWorker(intervalMs = Number(process.env.BUILD_POLL_MS ?? 5000)) {
    if (this.timer || !this.sandboxes) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "build worker");
  }

  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // A provider's passing hiccup (a 5xx, a rate limit, a dropped connection) mustn't throw away a build that
  // has already spent money: retry it on the next ticks, and fail only once it has persisted this long.
  static TRANSIENT_GRACE_MS = defaultGraceMs();
  private transient = new GraceTracker(() => BuildService.TRANSIENT_GRACE_MS);

  async tick() {
    if (!this.sandboxes) return;
    await this.solanaEnv.tick().catch((e) => console.error(`Solana build environment: ${(e as Error).message}`));
    const active = (await this.db.query(`SELECT * FROM financial_products.build_runs WHERE status <> ALL($1) ORDER BY created_at`, [TERMINAL])).rows as Row[];
    for (const r of active) {
      const build = toBuild(r);
      try {
        await this.advance(build);
        this.transient.clear(build.id);
      } catch (e) {
        if (this.transient.rideOut(build.id, e)) continue;
        const current = (await this.get(build.id)) ?? build;
        // Stopped (or otherwise ended) while this tick was in flight: its sandboxes are gone on purpose, and the
        // build keeps the status it ended with.
        if (TERMINAL.includes(current.status)) continue;
        await this.retireKey(current);
        // What the agent did up to the failure, read before its sandbox goes.
        if (AGENT_PHASES.includes(current.status)) await this.collectActivitySafely(current, { maxChunks: ACTIVITY_CHUNKS_AT_END, timeoutSeconds: 30, toEnd: true });
        // Don't leave a failed build's machines running until their TTL.
        for (const id of [current.sandbox_id, current.verify_sandbox_id]) if (id) await this.sandboxes.stop(id).catch(() => {});
        const error = failureMessage(e);
        await this.update(build.id, { status: "failed", error });
        await this.event(build.id, "failed", error);
      }
    }
  }

  private async advance(b: Build) {
    const sandboxes = this.sandboxes!;
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
      const { sandbox, env: base } = await this.solanaSandbox(
        { name: `mynt-build-${b.id}`, type: this.config.sandboxType, ttlSeconds: this.config.ttlSeconds, labels: { mynt_build: b.id }, env },
        b.solana,
      );
      await this.update(b.id, {
        status: "provisioning",
        sandbox_id: sandbox.id,
        sandbox_key_id: sandboxKeyId,
        branch: env.MYNT_BRANCH ?? null,
        ...(base ? { solana_env: { ...b.solana_env, build: base } } : {}),
      });
      await this.event(b.id, "provisioning", "Sandbox requested", { sandbox_id: sandbox.id, ...(base ? { solana_environment: base.key } : {}) });
      return;
    }

    if (b.status === "provisioning") {
      const s = await sandboxes.getSandbox(b.sandbox_id!);
      if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}: ${s.error ?? "no detail"}`);
      if (!["ready", "idle", "running"].includes(s.state)) return;
      const jobFiles: Record<string, string> = { "job/build.json": JSON.stringify(await this.spec(b), null, 2) };
      for (const file of await this.sdkFiles(b)) jobFiles[`job/sdk/${file.path}`] = file.content;
      if (b.solana) await this.installSolana(b.sandbox_id!, b.solana_env?.build);
      const session = b.mode === "session";
      const idleMs = Math.max(60_000, Math.floor(this.config.sessionIdleMs ?? SESSION_IDLE_MS));
      const processId = await this.startAgent(b, b.sandbox_id!, {
        prompt: session
          ? "Carry out the developer's first request in job/build.json in session mode, following CLAUDE.md (\"Session mode\") and its skills."
          : "Carry out the build in job/build.json, start to finish, following CLAUDE.md and its skills.",
        budgetUsd: b.cap_usd - b.cost_usd,
        workspace: "coding-build",
        jobFiles,
        // A session stays open for the developer's next message, and finishes (ships) after idling this long.
        ...(session ? { runnerEnv: { MYNT_AGENT_HOLD: "1", MYNT_AGENT_IDLE_MS: String(idleMs) }, finishPrompt: SESSION_FINISH_PROMPT } : {}),
      });
      await this.update(b.id, { status: "coding", prompt_id: processId, phase_message: "Agent started" });
      await this.event(b.id, "coding", session ? "Coding agent started in a session" : "Coding agent started", {
        agent: "claude-code",
        version: CLAUDE_CODE_VERSION,
        model: this.config.model,
        ...(session ? { idle_minutes: Math.round(idleMs / 60_000) } : {}),
      });
      return;
    }

    if (b.status === "verifying") return this.verify(b);

    // The agent is working: follow its status file, its cost, and its runner.
    const agent = await this.agentState(b.sandbox_id!, b.prompt_id!);
    // The model spend is the larger of what the agent reports and what the proxy metered (which also sees any
    // nested runs the agent started).
    const cost = (await sandboxes.costDollars(b.sandbox_id!)) + Math.max(agent.cost, await this.metered(b.id));
    if (cost !== b.cost_usd) await this.update(b.id, { cost_usd: cost });
    if (cost > b.cap_usd) {
      await this.stop({ ...b, cost_usd: cost }, `Stopped at US$${cost.toFixed(2)}: over the US$${b.cap_usd} cap`, "over_budget");
      return;
    }
    const status = parseJson<{ phase?: string; message?: string }>(await sandboxes.readFile(b.sandbox_id!, FILES.status));
    const phase = status?.phase as BuildStatus | undefined;
    if (phase && AGENT_PHASES.includes(phase) && (phase !== b.status || status?.message !== b.phase_message)) {
      await this.update(b.id, { status: phase, phase_message: status?.message ?? null });
      await this.event(b.id, phase, status?.message ?? phase);
    }
    if (b.mode === "session") await this.followSession(b, agent.state, agent.running, cost);
    // Once the agent has exited, its log is read to the end before the build moves on.
    await this.collectActivitySafely(b, agent.running ? {} : { maxChunks: ACTIVITY_CHUNKS_AT_END, toEnd: true });
    if (agent.running) return;
    if (!agent.ok) throw new Error(`Coding agent ${agent.state?.error ?? agent.state?.last_subtype ?? `exited with code ${agent.state?.exit_code ?? "unknown"}`}`);
    await this.startVerification(b);
  }

  // The coding agent doesn't grade its own work: Mynt packages the source and verifies it in a fresh
  // sandbox the agent never touched. The agent's report is kept, but only as advice.
  private async startVerification(b: Build) {
    const sandboxes = this.sandboxes!;
    const report = parseJson<AgentResult>(await sandboxes.readFile(b.sandbox_id!, FILES.result));
    const pack = await sandboxes.exec(
      b.sandbox_id!,
      `set -e; mkdir -p ${OUT}; cd ${WORKSPACE}; tar --exclude=./node_modules -czf ${OUT}/app.tgz .; sha256sum ${OUT}/app.tgz`,
      { timeoutSeconds: 300 },
    );
    const sha = pack.stdout.trim().split(/\s+/)[0];
    if (pack.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(sha ?? "")) throw new Error(`Couldn't package the build's source: ${pack.stderr.slice(0, 300)}`);
    // Sandbox hosts sign download URLs for at most an hour; the verifier fetches the source as soon as it starts.
    const url = await sandboxes.downloadUrl(b.sandbox_id!, `${OUT}/app.tgz`, 3600);
    if (!/^https:\/\/[^\s'"`$\\]+$/.test(url)) throw new Error("Unexpected source URL from the sandbox host");
    // No secrets: the verifier needs none.
    const { sandbox: v, env: base } = await this.solanaSandbox(
      { name: `mynt-verify-${b.id}`, type: this.config.sandboxType, ttlSeconds: 2 * 3600, labels: { mynt_build: b.id, mynt_role: "verify" }, env: {} },
      b.solana,
    );
    await this.update(b.id, {
      ...(base ? { solana_env: { ...b.solana_env, verify: base } } : {}),
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
    const sandboxes = this.sandboxes!;
    const vid = b.verify_sandbox_id!;
    // Both sandboxes' machine time, plus what the coding agent spent on the model. Mynt's audit is on Mynt.
    const coder = parseJson<AgentState>(await sandboxes.readFile(b.sandbox_id!, `${AGENT_DIR}/state.json`));
    const auditor = b.verify_step === "audit" ? await this.agentState(vid, b.verify_prompt_id!) : null;
    const cost =
      (await sandboxes.costDollars(b.sandbox_id!)) + (await sandboxes.costDollars(vid)) + Math.max(coder?.cost_usd ?? 0, await this.metered(b.id));
    if (cost !== b.cost_usd) await this.update(b.id, { cost_usd: cost });
    if (cost > b.cap_usd) {
      await this.stop({ ...b, cost_usd: cost }, `Stopped at US$${cost.toFixed(2)}: over the US$${b.cap_usd} cap`, "over_budget");
      return;
    }

    if (b.verify_step === "provisioning") {
      const state = (await sandboxes.getSandbox(vid)).state;
      if (state === "error" || state === "cancelled") throw new Error(`Verification sandbox ${state}`);
      if (!["ready", "idle", "running"].includes(state)) return;
      // Booted from the pre-built environment: checked against the hash Mynt kept before anything else runs. It is
      // used only on exit 0 (matched). Exit 3 means the check wiped it; anything else (a timeout, no status) is
      // wiped by Mynt's own command, confirmed, or the sandbox is replaced by a plain one. The Solana run then
      // installs the toolchain and pulls the image as it would without a snapshot.
      let base = b.solana_env?.verify;
      if (base) {
        await this.solanaEnv.writeCheck(vid);
        const started = Date.now();
        const c = await sandboxes.exec(vid, this.solanaEnv.checkCommand(base), { timeoutSeconds: 300 }).catch((e) => ({ exitCode: null, stdout: "", stderr: (e as Error).message }));
        const ok = c.exitCode === 0;
        let wiped = c.exitCode === 3;
        if (!ok && !wiped) {
          const w = await sandboxes.exec(vid, SOLANA_ENV_WIPE_COMMAND, { timeoutSeconds: 120 }).catch(() => null);
          wiped = w?.exitCode === 0 && /^wiped$/m.test(w.stdout);
        }
        const data = { solana_environment: base.key, verified: ok, check_exit: c.exitCode, check_seconds: Math.round((Date.now() - started) / 1000) };
        if (!ok) await this.solanaEnv.invalidate(base, `a sandbox booted from it failed its check (exit ${c.exitCode ?? "none"})`);
        if (!ok && !wiped) {
          // Neither matched nor confirmed wiped: this machine isn't used. A plain one replaces it.
          await sandboxes.stop(vid).catch(() => undefined);
          const fresh = await sandboxes.createSandbox({ name: `mynt-verify-${b.id}-plain`, type: this.config.sandboxType, ttlSeconds: 2 * 3600, labels: { mynt_build: b.id, mynt_role: "verify" }, env: {} });
          await this.update(b.id, { verify_sandbox_id: fresh.id, solana_env: { ...b.solana_env, verify: undefined } });
          await this.event(b.id, "verifying", "The pre-built Solana environment couldn't be checked or wiped; verifying in a plain sandbox instead", { ...data, verify_sandbox_id: fresh.id });
          return;
        }
        await this.event(b.id, "verifying", ok ? "The pre-built Solana environment matched Mynt's record" : "The pre-built Solana environment didn't match Mynt's record; installing the toolchain afresh", data);
        if (!ok) base = undefined;
      }
      // The toolchain this verification builds and tests with, kept with the programs it builds.
      const solana_toolchain = toolchainRecord(base ? { source: "snapshot", snapshot_id: base.snapshot_id } : { source: "install" });
      await this.update(b.id, { solana_toolchain });
      b = { ...b, solana_toolchain };
      await this.writeVerifier(b, vid);
      // Mynt fetches the source in the clean sandbox and reads, itself, whether the hash-verified archive has an
      // Anchor workspace. If it does, Mynt's Solana build runs first, on its own, so the programs are read back
      // before any of the app's code runs on the machine; then the checks.
      const fetched = await sandboxes.exec(vid, `bash ${VERIFY_DIR}/verify.sh --fetch '${b.source_url}' ${b.source_sha256}`, { timeoutSeconds: 300 });
      if (!fetched.stdout.includes("anchor-workspace")) {
        await this.startChecks(b, vid, "Running Mynt's checks: tests, lint and types, secrets, dependencies, SBOM, disclosures");
        return;
      }
      const run = await sandboxes.exec(vid, `bash ${VERIFY_DIR}/verify.sh --solana-build ${b.source_sha256}`, { detached: true });
      await this.update(b.id, { verify_step: "solana_build", verify_process_id: run.processId ?? null, solana: true });
      await this.event(b.id, "verifying", "Building the Solana programs verifiably, in a container, before the checks");
      return;
    }

    if (b.verify_step === "solana_build") {
      if ((await sandboxes.commandStatus(vid, b.verify_process_id!)).running) return;
      // Nothing may outlive the build: every container and every process of the sandbox's user goes before Mynt
      // reads the programs back.
      await sandboxes.exec(vid, "docker ps -aq | xargs -r docker rm -f >/dev/null 2>&1; pkill -KILL -u user >/dev/null 2>&1; true", { timeoutSeconds: 60 }).catch(() => undefined);
      await this.collectPrograms(b, vid);
      // Mynt's scripts and data, written again: nothing from the build phase may have edited them.
      await this.writeVerifier(b, vid);
      await this.startChecks(b, vid, "Running Mynt's checks: tests, lint and types, secrets, dependencies, SBOM, disclosures, Solana tests");
      return;
    }

    if (b.verify_step === "checks") {
      if ((await sandboxes.commandStatus(vid, b.verify_process_id!)).running) return;
      // The tests ran against the programs Mynt hashed; they must still be exactly those bytes.
      const swapped = await this.recheckPrograms(b, vid);
      if (swapped) {
        await sandboxes.stop(vid).catch(() => {});
        await this.retireKey(b);
        await this.update(b.id, { status: "blocked", error: swapped });
        await this.event(b.id, "blocked", swapped);
        return;
      }
      const { audit } = this.config;
      if (audit.mode === "none") {
        // No agent audit: the source can't change after Mynt's checks, so decide on their report alone.
        const report = parseJson<{ checks: Check[] }>(await sandboxes.readFile(vid, `${VERIFY_DIR}/report.json`));
        await sandboxes.stop(vid).catch(() => {});
        await this.event(b.id, "verifying", "Checks finished; deciding on Mynt's checks (no agent audit configured)");
        await this.decide(b, { report, maxwell: null, unchanged: true, auditFinished: false, auditRequired: false });
        return;
      }
      const processId = await this.startAuditor(b, vid, {
        prompt: "Audit the application described in job/audit.json, following CLAUDE.md and its skills.",
        workspace: "build-audit",
        jobFiles: {
          "job/audit.json": JSON.stringify(
            { app_dir: VERIFY_APP, maxwell_repo: this.config.maxwellRepo, output: `${VERIFY_DIR}/maxwell.json`, workflows: audit.workflows, minutes: audit.minutes },
            null,
            2,
          ),
        },
      });
      await this.update(b.id, { verify_step: "audit", verify_prompt_id: processId });
      await this.event(b.id, "verifying", `Checks finished; independent Maxwell audit started (${audit.workflows.join(", ")}; up to ${audit.minutes} min)`, {
        model: audit.model,
        cap_usd: audit.capUsd,
      });
      return;
    }

    if (b.verify_step === "audit") {
      const started = b.audit_started_at ? Date.parse(b.audit_started_at) : Date.now();
      const timedOut = auditor!.running && Date.now() - started > this.config.audit.minutes * 60_000;
      if (auditor!.running && !timedOut) return;
      await sandboxes.exec(vid, `bash ${VERIFY_DIR}/verify.sh --rehash`, { timeoutSeconds: 300 });
      const [report, maxwell, before, after, changed] = await Promise.all([
        sandboxes.readFile(vid, `${VERIFY_DIR}/report.json`).then((t) => parseJson<{ checks: Check[] }>(t)),
        sandboxes.readFile(vid, `${VERIFY_DIR}/maxwell.json`).then((t) => parseJson<NonNullable<AgentResult["maxwell"]>>(t)),
        sandboxes.readFile(vid, `${VERIFY_DIR}/before.sha`),
        sandboxes.readFile(vid, `${VERIFY_DIR}/after.sha`),
        sandboxes.readFile(vid, `${VERIFY_DIR}/changed.txt`).catch(() => null),
      ]);
      // The sandbox goes next, and with it the only record of a failed audit: keep the agent's own account.
      let audit: AuditRun | undefined;
      if (!auditor!.ok || !maxwell) {
        const log = await sandboxes
          .exec(vid, `tail -c 1500 ${AGENT_DIR}/runner.log 2>/dev/null; echo; tail -n 3 ${AGENT_DIR}/agent.jsonl 2>/dev/null | cut -c1-600`, { timeoutSeconds: 30 })
          .then((r) => r.stdout ?? "")
          .catch(() => "");
        const st = auditor!.state;
        audit = { result: timedOut ? `timed out after ${this.config.audit.minutes} min` : (st?.last_subtype ?? null), exit_code: st?.exit_code ?? null, error: st?.error ?? null, summary: st?.summary?.slice(0, 1500) ?? null, log: log.slice(-3000) || null, report_written: !!maxwell };
      }
      await sandboxes.stop(vid).catch(() => {});
      await this.decide(b, {
        report,
        maxwell,
        unchanged: !!before && before.trim() === after?.trim(),
        changed: (changed ?? "").split("\n").map((l) => l.trim()).filter(Boolean),
        auditFinished: !timedOut && auditor!.ok,
        audit,
      });
    }
  }

  private async writeVerifier(b: Build, vid: string) {
    await this.sandboxes!.writeFile(vid, `${VERIFY_DIR}/verify.sh`, VERIFY_SCRIPT);
    await this.sandboxes!.writeFile(vid, `${VERIFY_DIR}/solana-toolchain.sh`, SOLANA_TOOLCHAIN_SCRIPT);
    await this.sandboxes!.writeFile(vid, `${VERIFY_DIR}/solana-verify.sh`, SOLANA_VERIFY_SCRIPT);
    await this.sandboxes!.writeFile(vid, `${VERIFY_DIR}/solana-crate-allowlist.json`, JSON.stringify(loadCrateAllowlist()));
    await this.sandboxes!.writeFile(vid, `${VERIFY_DIR}/disclosures.json`, JSON.stringify(await this.requiredDisclosures(b)));
  }

  private async startChecks(b: Build, vid: string, message: string) {
    const run = await this.sandboxes!.exec(vid, `bash ${VERIFY_DIR}/verify.sh '${b.source_url}' ${b.source_sha256}`, { detached: true });
    await this.update(b.id, { verify_step: "checks", verify_process_id: run.processId ?? null });
    await this.event(b.id, "verifying", message);
  }

  // solana_build is Mynt's own record, taken when the build phase ended; a row of that name in the checks' report
  // (written while the app's code ran) is never trusted.
  private withSolanaBuild(b: Build, checks: Check[]): Check[] {
    const rest = checks.filter((c) => c.name !== "solana_build");
    return b.solana_check ? [b.solana_check as Check, ...rest] : rest;
  }

  // Every program Mynt's verification built (programs.json, written by solana-verify.sh), read back in chunks and
  // handed to the program registry, which hashes the bytes itself.
  private async collectPrograms(b: Build, vid: string) {
    const built = (await this.sandboxes!.readFile(vid, `${VERIFY_DIR}/solana/checks.jsonl`)) ?? "";
    const row = built.split("\n").map((l) => parseJson<Check>(l)).find((c) => c?.name === "solana_build");
    const record = async (c: Check) => this.update(b.id, { solana_check: { name: "solana_build", status: c.status, detail: (c.detail ?? "").slice(0, 1500) } });
    await record(row ?? { name: "solana_build", status: "fail", detail: "Mynt's Solana build didn't finish" });
    if (!this.solana) return;
    type K = "sources" | "deps" | "idl" | "depinfo";
    type Kept = { [k in K]?: string } & { [k in `${K}_size`]?: number } & { [k in `${K}_sha256`]?: string };
    const listed = parseJson<({ name: string; size: number; sha256: string; declared_id: string | null; cargo_lock_sha256?: string | null } & Kept)[]>(
      await this.sandboxes!.readFile(vid, `${VERIFY_DIR}/solana/programs.json`),
    );
    if (!listed?.length) return;
    const artifacts = [];
    const refused: string[] = [];
    // Only ever a regular file, never through a link (which could point anywhere on the machine): checked in the
    // same command as each read.
    const readBack = async (path: string, size: number) => {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < size; offset += 192 * 1024) {
        const r = await this.sandboxes!.exec(vid, `[ -f ${path} ] && [ ! -L ${path} ] && tail -c +${offset + 1} ${path} | head -c ${192 * 1024} | base64 -w0`, { timeoutSeconds: 60 });
        if (r.exitCode !== 0) return null;
        chunks.push(Buffer.from(r.stdout.trim(), "base64"));
      }
      const data = Buffer.concat(chunks);
      return data.length === size ? data : null;
    };
    // A JSON file the build run kept beside a program (its workspace's source, its dependencies, its IDL), hashed
    // here by Mynt and kept only if it matches what the build recorded. Shared files are read once.
    const cache = new Map<string, { sha256: string; json: unknown } | null>();
    const keptJson = async (p: Kept, key: K, max: number) => {
      const file = p[key];
      const size = p[`${key}_size`];
      const sha = p[`${key}_sha256`];
      if (!file || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.json$/.test(file) || !size || size > max || !/^[0-9a-f]{64}$/.test(sha ?? "")) return null;
      if (!cache.has(file)) {
        const raw = await readBack(`${VERIFY_DIR}/solana/${file}`, size);
        const got = raw ? createHash("sha256").update(raw).digest("hex") : null;
        cache.set(file, raw && got === sha ? { sha256: got!, json: parseJson<unknown>(raw.toString("utf8")) } : null);
      }
      return cache.get(file) ?? null;
    };
    for (const p of listed) {
      if (!/^[a-z0-9_]+$/.test(p.name) || !(p.size > 0 && p.size <= MAX_PROGRAM_BYTES)) continue;
      const program = await readBack(`${VERIFY_DIR}/solana/${p.name}.so`, p.size);
      if (!program || !program.subarray(0, 4).equals(ELF_MAGIC)) {
        refused.push(p.name);
        continue;
      }
      const src = await keptJson(p, "sources", MAX_SOURCES_BYTES);
      const bundle = src?.json as { files?: Record<string, string>; binary?: Record<string, string>; links?: Record<string, string> } | null;
      const deps = await keptJson(p, "deps", MAX_SOURCES_BYTES);
      // What the compiler read (rustc's dep-info) and the build container's copies' hashes.
      const depinfo = await keptJson(p, "depinfo", MAX_SOURCES_BYTES);
      // The IDL Mynt built in its own offline container, after the program was out. (The test run's IDL, built on the
      // host by the workspace's own code, is recorded later only to name events.)
      const idl = await keptJson(p, "idl", 2 * 1024 * 1024);
      artifacts.push({
        name: p.name,
        declared_id: p.declared_id ?? null,
        sha256: p.sha256,
        reported_sha256: p.sha256,
        cargo_lock_sha256: p.cargo_lock_sha256 ?? null,
        toolchain: b.solana_toolchain ?? toolchainRecord(),
        size: p.size,
        program: new Uint8Array(program),
        idl: idl?.json ?? null,
        idl_source: idl?.json ? ("build" as const) : null,
        sources: bundle && typeof bundle.files === "object" ? { sha256: src!.sha256, files: bundle.files, binary: bundle.binary ?? {}, links: bundle.links ?? {} } : null,
        deps: deps?.json && typeof deps.json === "object" ? { sha256: deps.sha256, data: deps.json } : null,
        depinfo: depinfo?.json && typeof depinfo.json === "object" ? { sha256: depinfo.sha256, data: depinfo.json } : null,
      });
    }
    const kept = await this.solana.recordArtifacts(b.id, artifacts);
    if (refused.length) await record({ name: "solana_build", status: "fail", detail: `not a regular ELF program file of the size its build reported: ${refused.join(", ")}` });
    else if (kept.length < listed.length) await record({ name: "solana_build", status: "fail", detail: "a program Mynt read back didn't match the hash its build reported" });
    await this.event(b.id, "verifying", `Mynt built ${kept.length} Solana program(s) for deploys: ${kept.join(", ") || "none matched their hash"}`, {
      programs: listed.map((p) => ({ name: p.name, sha256: p.sha256, declared_id: p.declared_id, cargo_lock_sha256: p.cargo_lock_sha256 ?? null })),
    });
  }

  // After the tests: every copy of each program Mynt read back (its own copy, and the one the tests loaded) must
  // still hash as it did. Returns why not, or null.
  private async recheckPrograms(b: Build, vid: string): Promise<string | null> {
    if (!this.solana) return null;
    const kept = await this.solana.artifacts(b.id);
    for (const a of kept) {
      if (!/^[a-z0-9_]+$/.test(a.name)) continue;
      const r = await this.sandboxes!.exec(
        vid,
        `cd ${VERIFY_APP} && for f in ${VERIFY_DIR}/solana/${a.name}.so $(find . -path '*/node_modules' -prune -o -path '*/target/deploy/${a.name}.so' -print); do python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read().rstrip(b"\\0")).hexdigest())' "$f" 2>/dev/null || echo missing; done`,
        { timeoutSeconds: 120 },
      );
      const hashes = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      if (r.exitCode !== 0 || !hashes.length || hashes.some((h) => h !== a.sha256))
        return `The Solana program ${a.name} changed after Mynt built it (its tests didn't run against the bytes Mynt hashed); the result can't be trusted`;
      const idl = parseJson<unknown>(await this.sandboxes!.readFile(vid, `${VERIFY_DIR}/solana/${a.name}.idl.json`));
      if (idl) await this.solana.recordIdl(b.id, a.name, idl);
    }
    return null;
  }

  // Ship only what Mynt itself verified: the source unchanged through the audit, no critical or high
  // findings, every check passing, and a pushed branch identical to the verified source.
  private async decide(
    b: Build,
    v: { report: { checks: Check[] } | null; maxwell: AgentResult["maxwell"] | null; unchanged: boolean; changed?: string[]; auditFinished: boolean; audit?: AuditRun; auditRequired?: boolean },
  ) {
    const sandboxes = this.sandboxes!;
    const counts = v.maxwell?.counts ?? {};
    const serious = (counts.critical ?? 0) + (counts.high ?? 0);
    const checks = this.withSolanaBuild(b, v.report?.checks ?? []);
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
    if (v.auditRequired !== false && (!v.auditFinished || !v.maxwell)) {
      const a = v.audit;
      const why = !a ? "" : !a.report_written && a.result === "success" ? " (the auditor finished without writing its report)" : ` (auditor: ${[a.result ?? "no result", a.exit_code != null ? `exit ${a.exit_code}` : "", a.error ?? ""].filter(Boolean).join(", ")})`;
      return end("blocked", `No independent Maxwell audit result${why}; a build can't ship without one`, { audit: a ?? null });
    }
    if (serious > 0) return end("blocked", `Security gate: ${serious} critical/high Maxwell finding(s)`, counts);
    const failed = checks.filter((c) => c.status === "fail");
    if (failed.length) return end("failed", `Not production-ready: ${failed.map((c) => c.name).join(", ")}`, failed);

    let commit: string | null = null;
    let pr: string | null = null;
    if (b.repository && b.branch && this.repos) {
      // The branch the agent pushed must be exactly the source Mynt verified.
      const head = await sandboxes.exec(
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
    if (advisory?.preview?.port) preview = (await sandboxes.host(b.sandbox_id!, advisory.preview.port)).url;
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
      // mode "session": see CLAUDE.md's "Session mode". base: the earlier build's pushed branch (and its verified
      // commit, when it shipped) to start from instead of the default branch.
      build: {
        id: b.id,
        repository: b.repository,
        branch: b.branch,
        mode: b.mode,
        base: b.base_branch ? { branch: b.base_branch, commit_sha: b.base_commit, build_id: b.continued_from } : null,
      },
      goal: b.goal,
      app: app ?? null,
      products,
      mynt_api: this.config.publicUrl ? `${this.config.publicUrl}/v1` : null,
      ...(b.solana
        ? {
            solana: {
              programs: app && this.solana ? await this.solana.programsForApp(app.id) : [],
              toolchain: {
                agave: SOLANA_TOOLCHAIN.agave.version,
                anchor: SOLANA_TOOLCHAIN.anchor.version,
                anchor_ts: SOLANA_TOOLCHAIN.anchorTs.version,
                rust: SOLANA_TOOLCHAIN.rust.version,
                env: "~/.mynt-solana/env",
                docs: "docs/solana/README.md",
              },
            },
          }
        : {}),
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

// A build as developers see it: what they need to follow and use it, never Mynt's internals (sandbox and
// process ids, the app's sandbox key id, verification steps) nor the signed source link or the agent's own
// report. sandbox_open_until says until when a sandbox reopened on the build's branch stays up.
export function developerBuild(b: Build) {
  return {
    id: b.id,
    app_id: b.app_id,
    goal: b.goal,
    repository: b.repository,
    branch: b.branch,
    status: b.status,
    phase_message: b.phase_message,
    preview_url: b.preview_url,
    pr_url: b.pr_url,
    commit_sha: b.commit_sha,
    readiness: b.readiness,
    ...(b.maxwell != null ? { maxwell: b.maxwell } : {}),
    cost_usd: b.cost_usd,
    cap_usd: b.cap_usd,
    error: b.error,
    sandbox_open_until: b.box_sandbox_id && b.box_until ? b.box_until : null,
    mode: b.mode,
    ...(b.mode === "session" ? { finish_requested_at: b.finish_requested_at } : {}),
    continued_from: b.continued_from,
    solana: b.solana,
    ...(b.solana && b.solana_toolchain ? { solana_toolchain: b.solana_toolchain } : {}),
    created_at: b.created_at,
    updated_at: b.updated_at,
    finished_at: b.finished_at,
  };
}

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
      // The App being installed there only says Mynt can reach it: the developer must be able to push there themselves.
      try {
        await requirePush(builds.ownership, user.id, repository);
      } catch (e) {
        return fail((e as Error).message);
      }
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
        solana: z
          .boolean()
          .optional()
          .describe("Give the agents the Solana toolchain (Agave, Anchor, Rust) to build an Anchor program beside the app; on by default when the app has programs reserved"),
        mode: z
          .enum(["once", "session"])
          .default("once")
          .describe(
            "once (default): the agent builds and ships in one go. session: it does your first request, then stays open for your next ones (steer_build), keeping its context, until you call finish_build or it has been idle 15 minutes; then it ships and Mynt verifies it as usual. Idle time counts against the cap",
          ),
        continue_from: z.string().optional().describe("An earlier build of yours whose pushed branch this one starts from (same app and repository)"),
      },
    },
    async ({ goal, app_id, repository, cap_usd, solana, mode, continue_from }) => {
      if (!builds.enabled) return fail("Coding-agent builds aren't enabled on this Mynt yet");
      if (app_id) {
        const app = await store.getApp(app_id);
        if (!app || app.owner_id !== user.id) return fail(`No app of yours with id '${app_id}'`);
      }
      try {
        const b = await builds.start(user, { goal, app_id, repository, cap_usd, solana, mode, continue_from });
        await store.audit(user.id, "start_build", b.id, { app_id: b.app_id, repository: b.repository, cap_usd: b.cap_usd, mode, continue_from: continue_from ?? null });
        return json({ ...developerBuild(b), track_with: "get_build", ...(mode === "session" ? { next: "steer_build with each request; finish_build to ship" } : {}) });
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
      inputSchema: { status: z.enum(BUILD_STATUSES).optional(), app_id: z.string().optional().describe("Only this app's builds") },
      annotations: { readOnlyHint: true },
    },
    async ({ status, app_id }) =>
      json({
        month_spend_usd: await builds.monthSpend(user.id),
        monthly_cap_usd: builds.config.monthlyCapUsd,
        builds: (await builds.listFor(user.id, status, app_id)).map((b) => ({ ...developerBuild(b), goal: b.goal.slice(0, 140) })),
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
      return json({ ...developerBuild(b), timeline: await builds.events(b.id) });
    },
  );

  server.registerTool(
    "get_build_activity",
    {
      title: "What the coding agent is doing",
      description:
        "Developer: what the coding agent did (its messages, commands and edits), kept after its sandbox stops. Without `after`, the latest entries, newest first. To follow a build, pass the `cursor` you got back as `after`: you get only what's new, oldest first, and a new cursor.",
      inputSchema: {
        build_id: z.string(),
        limit: z.number().int().min(1).max(200).default(30),
        after: z.number().int().min(0).optional().describe("A cursor from an earlier call: only entries after it"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ build_id, limit, after }) => {
      const b = await own(build_id);
      if (!b) return fail(`No build of yours with id '${build_id}'`);
      return json({ status: b.status, phase_message: b.phase_message, ...(await builds.activity(b, { limit, after })) });
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
    "finish_build",
    {
      title: "Finish a session build and ship it",
      description:
        "Developer: end a session build (start_build with mode 'session'). Once its current request is done, the agent reviews, checks, previews and pushes the work, then Mynt verifies it in a clean sandbox exactly as any build: only that verification decides whether it ships. Follow it with get_build.",
      inputSchema: { build_id: z.string() },
    },
    async ({ build_id }) => {
      const b = await own(build_id);
      if (!b) return fail(`No build of yours with id '${build_id}'`);
      try {
        const r = await builds.finish(b);
        await store.audit(user.id, "finish_build", b.id);
        return json({ build_id, ...r, track_with: "get_build" });
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
      return b ? json(developerBuild(await builds.stop(b, reason))) : fail(`No build of yours with id '${build_id}'`);
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

  server.registerTool(
    "solana_build_environment",
    {
      title: "Pre-built Solana build environment",
      description:
        "Admin: the snapshot Solana build and verify sandboxes boot from (the pinned toolchain installed and checked, Anchor's image pulled by digest), keyed by the toolchain pins. 'status' shows it; 'prepare' builds it now instead of on the first Solana build; 'rebuild' replaces it. Each sandbox booted from it re-hashes it against Mynt's record before use, and installs from the pinned, checksum-verified downloads on any mismatch.",
      inputSchema: { action: z.enum(["status", "prepare", "rebuild"]).default("status") },
    },
    async ({ action }) => {
      try {
        const env = builds.solanaEnv;
        if (action !== "status") await env.prepare(action === "rebuild");
        const all = await env.list();
        const current = all.find((r) => r.key === env.key) ?? null;
        return json({
          supported: env.supported,
          key: env.key,
          toolchain: toolchainRecord(),
          current,
          // What a sandbox booted from it skips: the builder's own measured install and image pull.
          saves_seconds_per_sandbox: current?.status === "ready" ? current.install_seconds : null,
          earlier: all.filter((r) => r.key !== env.key).map(({ key, status, snapshot_id, uses, error, ready_at }) => ({ key, status, snapshot_id, uses, error, ready_at })),
        });
      } catch (e) {
        return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
      }
    },
  );
}

// One line of Claude Code's stream-json output, as activity a developer can follow.
// Summaries are stored and shown: control characters (NUL among them, which Postgres text refuses) go, secrets are
// scrubbed before the text is cut (so a cut can't leave a partial token the patterns miss), and a cut never leaves
// half a surrogate pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function activitySummary(text: string, limit = 400) {
  const clean = redact(
    text
      .replace(LONE_SURROGATE, "�")
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/\s+/g, " "),
  );
  return clean.slice(0, limit).replace(LONE_SURROGATE, "");
}

function summarizeAgentLine(m: Record<string, unknown>): { type: string; summary: string }[] {
  const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  if (m.type === "result") return [{ type: "turn_finished", summary: activitySummary(`${str(m.subtype)}, US$${Number(m.total_cost_usd ?? 0).toFixed(2)}`) }];
  const content = (m.message as { content?: unknown } | undefined)?.content;
  if (m.type !== "assistant" || !Array.isArray(content)) return [];
  return content.flatMap((c: Record<string, unknown>) =>
    c.type === "text"
      ? [{ type: "message", summary: activitySummary(str(c.text)) }]
      : c.type === "tool_use"
        ? [{ type: "tool_use", summary: activitySummary(`${str(c.name)} ${str(c.input)}`) }]
        : [],
  );
}
