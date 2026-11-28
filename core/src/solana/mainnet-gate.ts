import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentMeter } from "../agent-meter.js";
import type { AgentRun } from "../agent-proxy.js";
import { AGENT_DIR, agentState, launchAgent, workspaceCwd, workspaceFiles, type AgentHostConfig } from "../agent-host.js";
import type { AgentState } from "../agent-runner.js";
import { redact } from "../boxes.js";
import { roleBackend, roleBackendMissing, type SecondBackendKind } from "../model-backends/index.js";
import type { SandboxHost } from "../sandbox-host.js";
import type { Db } from "../db.js";
import { emitFirmEvent } from "../runtime.js";
import type { Store, User } from "../store.js";
import { defaultGraceMs, failureMessage, GraceTracker } from "../transient.js";
import { serialLoop } from "../worker.js";
import { buildCheck, readBackJson, readBuiltPrograms } from "./built-programs.js";
import { GATE_ANALYSIS_SCRIPT, GATE_CONFIRM_SCRIPT, GATE_SAMPLE_SCRIPT, GATE_TOOLS } from "./gate-scripts.js";
import { checkProgramRules, upgradeAuthorityRule, type RuleFinding } from "./program-rules.js";
import type { DepsCapture, MainnetGateCheck, MainnetGateClaim, ProgramRecord, SolanaService } from "./service.js";
import { SOLANA_TOOLCHAIN_SCRIPT, SOLANA_VERIFY_SCRIPT } from "./toolchain.js";
import { agentChecklist, entryProblems, loadCrateAllowlist, loadVulnDb, VULN_CATEGORIES, type CrateAllowlist, type VulnDb } from "./vuln-db.js";
import { crossCheck, dependencyVerdict, evaluateDepInfo, resolveCrateTree, stripIdlDocs, uncompiledHitExceptions, verifyIdl, workspaceExceptions, type DepInfoCapture, type Exception } from "./crate-tree.js";
import { runDetections } from "./program-rules.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (opts: object) => { compile: (s: object) => AjvValidate };
type AjvValidate = ((data: unknown) => boolean) & { errors?: { instancePath: string; keyword: string; message?: string; params?: Record<string, unknown> }[] | null };

// The mainnet program gate. Every mainnet deploy and every mainnet upgrade must pass, in order:
//   1. Mynt's hard rules (program-rules.ts): no value-moving program, no hidden admin, the upgrade authority stays
//      Mynt's own mainnet signer. Deterministic; no model.
//   2. White-box audit: open-source static analysis (cargo-audit, Radar) of the captured source in a sandbox of
//      Mynt's, then the program-audit agent (workspaces/program-audit) in that sandbox, which reads the source and
//      the findings so far. Mynt checks every finding's quote against the source; verified critical or high blocks.
//   3. Black-box red team: the program-red-team agent (workspaces/program-red-team) gets only the bytes Mynt stored
//      and the IDL, on a local validator in its own sandbox, and writes attacks as runnable proofs of concept. Mynt
//      re-runs each in a fresh sandbox of its own and judges it from the chain; a confirmed exploit blocks.
//   4. An admin's approval. An upgrade is also announced to the firm's webhooks when the gates pass and runs only
//      after a timelock (MAINNET_UPGRADE_TIMELOCK_HOURS, default 48), cancellable by the developer or an admin.
// deploy_program and upgrade_program on mainnet are refused unless an approved review covers exactly the build's
// program hash (SolanaService.deploy asks assertDeployable). Devnet has no gate. Agents never see each other's
// work or the builder's conversation, and never grade their own: Mynt does.

export interface GateConfig extends AgentHostConfig {
  sandboxType: string;
  gateModel: string;
  auditCapUsd: number;
  redTeamCapUsd: number;
  auditMinutes: number;
  redTeamMinutes: number;
  analysisMinutes: number;
  monthlyCapUsd: number;
  timelockHours: number;
  approvalTtlDays: number;
  sourceRetentionDays: number;
  cargoAuditIgnore: string[];
}

export function gateConfigFromEnv(host: AgentHostConfig, env = process.env): GateConfig {
  const num = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return env[name] && Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    ...host,
    sandboxType: env.BUILD_SANDBOX_TYPE ?? "default",
    gateModel: env.PROGRAM_GATE_MODEL || host.model,
    auditCapUsd: num("PROGRAM_AUDIT_CAP_USD", 5),
    redTeamCapUsd: num("PROGRAM_RED_TEAM_CAP_USD", 8),
    auditMinutes: num("PROGRAM_AUDIT_MINUTES", 45),
    redTeamMinutes: num("PROGRAM_RED_TEAM_MINUTES", 60),
    analysisMinutes: num("PROGRAM_ANALYSIS_MINUTES", 45),
    monthlyCapUsd: num("PROGRAM_GATE_MONTHLY_CAP_USD", 100),
    timelockHours: num("MAINNET_UPGRADE_TIMELOCK_HOURS", 48),
    approvalTtlDays: num("MAINNET_APPROVAL_TTL_DAYS", 14),
    sourceRetentionDays: num("PROGRAM_SOURCE_RETENTION_DAYS", 30),
    cargoAuditIgnore: (env.PROGRAM_GATE_CARGO_AUDIT_IGNORE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^RUSTSEC-\d{4}-\d{4}$/.test(s)),
  };
}

const T = "financial_products";
const REVIEW_TABLES = `
  CREATE TABLE IF NOT EXISTS ${T}.solana_mainnet_reviews (
    id uuid PRIMARY KEY,
    program uuid NOT NULL REFERENCES ${T}.solana_programs(id),
    program_id text NOT NULL,
    entity_id uuid,
    build_id uuid NOT NULL,
    sha256 text NOT NULL,
    action text NOT NULL CHECK (action IN ('deploy', 'upgrade')),
    status text NOT NULL,
    step text,
    phase_message text,
    requested_by uuid NOT NULL REFERENCES ${T}.users(id),
    rules jsonb,
    static_analysis jsonb,
    audit jsonb,
    red_team jsonb,
    confirmations jsonb,
    blocked_reason text,
    error text,
    analysis_sandbox_id text,
    analysis_process_id text,
    audit_process_id text,
    audit_token_hash text,
    audit_started_at timestamptz,
    red_sandbox_id text,
    red_process_id text,
    red_token_hash text,
    red_started_at timestamptz,
    confirm_sandbox_id text,
    confirm_process_id text,
    step_started_at timestamptz,
    cost_usd numeric NOT NULL DEFAULT 0,
    audit_cap_usd numeric NOT NULL,
    red_cap_usd numeric NOT NULL,
    executes_at timestamptz,
    announced_at timestamptz,
    decision text,
    decision_note text,
    decided_by uuid REFERENCES ${T}.users(id),
    decided_at timestamptz,
    cancelled_by uuid REFERENCES ${T}.users(id),
    cancelled_at timestamptz,
    started_at timestamptz,
    executed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS solana_mainnet_reviews_program_idx ON ${T}.solana_mainnet_reviews (program, created_at DESC);
  -- What can change the build beyond the reviewed source (an admin must allow each by id), the dependencies as the
  -- build used them, the IDL's check against the bytes, and what an admin allowed.
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS exceptions jsonb;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS allowed_exceptions jsonb;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS dependencies jsonb;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS idl_check jsonb;
  -- The program's hash when a deploy or upgrade claimed the approval, and the month's budget it reserved.
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS claimed_hash text;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
  -- An agent's earlier attempts in this review, by agent ("audit", "red_team"): how each ended and what it spent.
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS agent_attempts jsonb;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS budget_key text;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS budget_settled boolean NOT NULL DEFAULT false;
  -- The model backend and model the red team ran on ("default": the one every agent uses), fixed when it starts.
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS red_backend text;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS red_model text;
  -- What the review's budget counts for model calls whose spend couldn't be measured: what was left of the agent's
  -- cap, reserved. Never a cost, and never given back to the month.
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS reserved_usd numeric;
  -- One open review per program, whatever races.
  CREATE UNIQUE INDEX IF NOT EXISTS solana_mainnet_reviews_open_idx ON ${T}.solana_mainnet_reviews (program) WHERE status IN ('running', 'awaiting_approval', 'approved', 'started');
  -- Every step of every review, append-only.
  CREATE TABLE IF NOT EXISTS ${T}.solana_mainnet_review_log (
    id uuid PRIMARY KEY,
    review uuid NOT NULL REFERENCES ${T}.solana_mainnet_reviews(id),
    actor uuid,
    event text NOT NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS solana_mainnet_review_log_idx ON ${T}.solana_mainnet_review_log (review, created_at);
`;
const FLAG_TABLES = `
  -- A deployed mainnet program that a newer vulnerability database's hard rules refuse: its firm and admins are
  -- told, and its upgrades wait until an admin has reviewed it. Nothing is ever taken down.
  CREATE TABLE IF NOT EXISTS ${T}.solana_program_flags (
    id uuid PRIMARY KEY,
    program uuid NOT NULL REFERENCES ${T}.solana_programs(id),
    program_id text NOT NULL,
    entity_id uuid,
    db_version integer NOT NULL,
    verifiable_hash text,
    findings jsonb NOT NULL,
    status text NOT NULL DEFAULT 'open',
    resolution_note text,
    resolved_by uuid REFERENCES ${T}.users(id),
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS solana_program_flags_open_idx ON ${T}.solana_program_flags (program) WHERE status = 'open';
  -- Proposed vulnerability database entries: stored for review only; the database changes only by a pull request.
  CREATE TABLE IF NOT EXISTS ${T}.solana_vuln_rule_proposals (
    id uuid PRIMARY KEY,
    entry jsonb NOT NULL,
    rationale text,
    proposed_by uuid REFERENCES ${T}.users(id),
    status text NOT NULL DEFAULT 'proposed',
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;
const TABLES = REVIEW_TABLES + FLAG_TABLES;

// Benchmark samples (requestSample) are reviews of no program: they live in tables of their own, which no deploy,
// list, count or admin decision ever reads, with no link to the program registry and the sample itself in the row.
const SAMPLE_NAMES = /\bsolana_mainnet_review(?:s|_log)/g;
const sampleSql = (sql: string) => sql.replace(SAMPLE_NAMES, (name) => `bench_${name}`);
const SAMPLE_TABLES = sampleSql(
  REVIEW_TABLES.replace(` REFERENCES ${T}.solana_programs(id)`, "") + `ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS sample jsonb;`,
);
function sampleDb(db: Db): Db {
  return {
    query: (sql, params) => db.query(sampleSql(sql), params),
    exec: (sql) => db.exec(sampleSql(sql)),
    close: async () => undefined,
  };
}

// started: a deploy or upgrade claimed (consumed) the approval; executed: the program holds exactly the reviewed bytes.
export const REVIEW_STATUSES = ["running", "awaiting_approval", "approved", "started", "executed", "blocked", "rejected", "cancelled", "failed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
// Reviews that still hold the program: a new one waits until these end.
const OPEN: ReviewStatus[] = ["running", "awaiting_approval", "approved", "started"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];
const BLOCKING: Severity[] = ["critical", "high"];

const GATE_DIR = "/home/user/mynt-gate";
const SAMPLE_DIR = "/home/user/mynt-sample";
const CONFIRM_DIR = "/home/user/mynt-confirm";
const AUDIT_WS = "program-audit";
const RED_WS = "program-red-team";
// Where the red team's sandbox keeps the toolchain's installer, its log and, once it has ended, its exit code.
const TOOLCHAIN_INSTALLER = "/home/user/mynt-solana-toolchain.sh";
const TOOLCHAIN_LOG = "/home/user/.mynt-solana-install.log";
const TOOLCHAIN_EXIT = "/home/user/.mynt-solana-install.exit";
// An agent that stops without its result for no reason of time or budget (it ended its turn early, or its run broke
// off) runs once more in the same sandbox, within the same time limit and what is left of its budget.
export const GATE_AGENT_ATTEMPTS = 2;
const RETRY_MIN_USD = 0.5;
const RETRY_MIN_MINUTES = 5;
// What Mynt reads back of a red team's proofs of concept.
const MAX_POCS = 10;
const MAX_POC_FILES = 40;
const MAX_POC_FILE_BYTES = 256 * 1024;

type Row = Record<string, unknown>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const parse = <X>(text: string | null | undefined): X | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as X;
  } catch {
    return null;
  }
};
const JSON_COLS = new Set(["rules", "static_analysis", "audit", "red_team", "confirmations", "exceptions", "allowed_exceptions", "dependencies", "idl_check", "sample", "agent_attempts"]);

// A benchmark sample as its row keeps it: what was asked, and, once Mynt prepared it, what the agents and Mynt's
// own checks work from (the whole workspace; for the red team, the bytes and IDL of Mynt's own build of it).
export interface GateSample {
  mode: "audit" | "red_team";
  name: string;
  program_id: string;
  files: Record<string, string>;
  ref: string;
  prepared?: { sources: Record<string, string>; program_b64: string | null; idl: unknown; deps: unknown; depinfo: unknown };
}

// Said with every review, and with every approval: what the gate can't promise.
export const REVIEW_CAVEATS = [
  "A clean audit or red-team result isn't proof the program is safe: they found nothing in the time and budget they had. Mynt's hard rules block known shapes; they don't prove their absence.",
  "Mynt's local validator can't show behaviour that depends on: time or slot (Clock, deadlines, vesting), live state of other programs and accounts on mainnet (oracle prices, pools, other programs' upgrades), the cluster itself (feature gates, compute limits, fees, rent), transaction ordering under load (front-running, sandwiching, MEV), or what an upgrade later changes.",
  "The IDL only describes the instructions it lists: Mynt checks each against the program's bytes, but an instruction the IDL leaves out can't be found that way.",
];

export class GateError extends Error {}

export interface StaticTool {
  name: string;
  version: string;
  status: "ran" | "error";
  detail: string;
  findings: { severity: string; certainty?: string; title: string; location: string; detail: string; id?: string }[];
}

// Mynt's verdict on the static tools' report: a tool that didn't run blocks (Mynt can't vouch for what it didn't
// check), and so does any critical or high finding a tool is sure of. Radar's low-certainty highs go to the audit
// agent as leads; it must confirm them with a quote from the source for them to block.
export function assessStatic(report: { tools?: StaticTool[] } | null, expected = ["cargo-audit", "radar"]) {
  const tools = (report?.tools ?? []).filter((t) => t && typeof t.name === "string");
  const reasons: string[] = [];
  for (const name of expected) {
    const t = tools.find((x) => x.name === name);
    if (!t) reasons.push(`${name} didn't report`);
    else if (t.status !== "ran") reasons.push(`${name} couldn't run: ${String(t.detail ?? "").slice(0, 300)}`);
  }
  const serious = tools.flatMap((t) =>
    (Array.isArray(t.findings) ? t.findings : [])
      .filter((f) => BLOCKING.includes(String(f.severity).toLowerCase() as Severity) && String(f.certainty ?? "").toLowerCase() !== "low")
      .map((f) => `${t.name}: ${f.title} (${f.location})`),
  );
  if (serious.length) reasons.push(`${serious.length} critical/high finding(s): ${serious.slice(0, 5).join("; ")}${serious.length > 5 ? "; …" : ""}`);
  return { passed: reasons.length === 0, reasons, tools };
}

export interface AuditFinding {
  id: string;
  severity: Severity;
  title: string;
  vulnerability: string | null; // the vulnerability database entry it belongs to, as the agent says
  file: string;
  line: number | null;
  quote: string;
  description: string;
  recommendation: string;
  verified: boolean;
  reason?: string;
}

// Mynt's pass over the audit agent's findings: a finding counts only if its quote is really in the file it names
// (whitespace aside). Unverifiable findings are kept, marked, and never block.
export function assessAudit(raw: string | null, sources: Record<string, string>) {
  const parsed = parse<{ findings?: Row[]; summary?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.findings)) return { finished: false, findings: [] as AuditFinding[], summary: null as string | null, blocking: [] as AuditFinding[] };
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  const findings: AuditFinding[] = parsed.findings.slice(0, 100).map((f, i) => {
    const severity = (SEVERITIES as readonly string[]).includes(String(f.severity).toLowerCase()) ? (String(f.severity).toLowerCase() as Severity) : "info";
    const file = typeof f.file === "string" ? f.file.replace(/^\.\//, "") : "";
    const quote = typeof f.quote === "string" ? f.quote.slice(0, 2000) : "";
    const text = sources[file];
    const verified = !!text && squash(quote).length >= 8 && squash(text).includes(squash(quote));
    return {
      id: typeof f.id === "string" ? f.id.slice(0, 60) : `A${i + 1}`,
      severity,
      title: String(f.title ?? "").slice(0, 300),
      vulnerability: typeof f.vulnerability === "string" ? f.vulnerability.slice(0, 60) : null,
      file,
      line: Number.isInteger(f.line) ? (f.line as number) : null,
      quote,
      description: String(f.description ?? "").slice(0, 3000),
      recommendation: String(f.recommendation ?? "").slice(0, 2000),
      verified,
      ...(verified ? {} : { reason: !text ? `no file '${file}' in the captured source` : "the quote isn't in that file" }),
    };
  });
  return { finished: true, findings, summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 3000) : null, blocking: findings.filter((f) => f.verified && BLOCKING.includes(f.severity)) };
}

export interface RedTeamFinding {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  description: string;
  poc: string | null; // the PoC's directory under job/poc, when the red team wrote one
}

// The red team's report has one contract: schemas/program-red-team-report.schema.json. The gate validates against
// it here, and the red team's own check (workspaces/program-red-team/scripts/check_report.py) validates against the
// same file, handed to it as job/report.schema.json.
export const RED_TEAM_REPORT_SCHEMA_FILE = fileURLToPath(new URL("../../schemas/program-red-team-report.schema.json", import.meta.url));
export const RED_TEAM_REPORT_SCHEMA = readFileSync(RED_TEAM_REPORT_SCHEMA_FILE, "utf8");
let redTeamSchema: AjvValidate | null = null;

export interface RedTeamReport {
  findings: RedTeamFinding[];
  summary: string | null;
  attacks_tried: string[];
}

// Mynt's reading of job/report.json. `report` is null unless it validates; `problems` says why it doesn't;
// `incomplete` is the red team's own reason when a valid report says it isn't complete. Only a valid report that
// doesn't say so counts as the red team's result.
export function checkRedTeamReport(raw: string | null): { report: RedTeamReport | null; problems: string[]; incomplete: string | null } {
  if (raw == null || !raw.trim()) return { report: null, problems: ["report.json doesn't exist"], incomplete: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { report: null, problems: ["report.json isn't valid JSON"], incomplete: null };
  }
  redTeamSchema ??= new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(RED_TEAM_REPORT_SCHEMA));
  if (!redTeamSchema(parsed)) {
    const problems = (redTeamSchema.errors ?? [])
      .filter((e) => e.keyword !== "if")
      .map((e) => {
        const what = e.keyword === "pattern" && e.params?.pattern === "\\S" ? "must not be empty" : (e.message ?? "invalid");
        const allowed = e.keyword === "enum" ? ` (${((e.params?.allowedValues as unknown[] | undefined) ?? []).join(", ")})` : "";
        return `report.json${e.instancePath ? ` ${e.instancePath}` : ""}: ${what}${allowed}`.slice(0, 200);
      });
    return { report: null, problems: [...new Set(problems)].slice(0, 8), incomplete: null };
  }
  const p = parsed as { complete?: boolean; incomplete_reason?: string; findings: Row[]; summary: string; attacks_tried: string[] };
  const findings: RedTeamFinding[] = p.findings.map((f) => ({
    id: f.id as string,
    title: f.title as string,
    severity: f.severity as Severity,
    category: typeof f.category === "string" ? f.category : "",
    description: f.description as string,
    poc: typeof f.poc === "string" ? f.poc : null,
  }));
  const report = { findings, summary: p.summary.trim() ? p.summary : null, attacks_tried: p.attacks_tried.slice(0, 40).map((x) => x.slice(0, 300)) };
  return { report, problems: [], incomplete: p.complete === false ? p.incomplete_reason!.slice(0, 1000) : null };
}

// The report, when it validates (complete or not).
export const parseRedTeam = (raw: string | null) => checkRedTeamReport(raw).report;

// Why job/findings.json isn't the audit's result, or null when it is one.
export function auditFileProblem(raw: string | null) {
  if (raw == null || !raw.trim()) return "findings.json doesn't exist";
  const parsed = parse<{ findings?: unknown }>(raw);
  if (!parsed) return "findings.json isn't valid JSON";
  return Array.isArray(parsed.findings) ? null : "findings.json has no 'findings' list";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string, n: number) => clip(redact(s.replace(/\s+/g, " ").trim()), n);

// How a gate agent's run ended, from the runner's own record: `result` is the short form reviews have always shown
// (the last turn's subtype, or the timeout), `how` says it in words that follow the agent's name, and `retry` is whether one more attempt could
// help (it ended its turn early or its run broke off; never when it ran out of time or budget).
export function agentEnding(o: { state: AgentState | null; timedOut: boolean; minutes: number }): { result: string | null; how: string; retry: boolean; exit_code: number | null; error: string | null } {
  const s = o.state;
  const base = { exit_code: s?.exit_code ?? null, error: s?.error ? oneLine(s.error, 300) : null };
  if (o.timedOut) return { ...base, result: `timed out after ${o.minutes} min`, how: `ran out of time (${o.minutes} min)`, retry: false };
  if (!s) return { ...base, result: null, how: "left no record of its run (it never started, or its sandbox was lost)", retry: true };
  if (s.error) return { ...base, result: s.last_subtype, how: `failed to run (${base.error})`, retry: true };
  if (s.last_subtype === "success") return { ...base, result: "success", how: "ended its turn", retry: true };
  if (s.last_subtype === null) return { ...base, result: null, how: `broke off before its first turn ended${s.exit_code != null ? ` (exit ${s.exit_code})` : ""}`, retry: true };
  if (s.last_subtype === "error_max_budget_usd") return { ...base, result: s.last_subtype, how: "ran out of its budget", retry: false };
  return { ...base, result: s.last_subtype, how: `stopped with ${s.last_subtype}`, retry: true };
}

// Why an agent's run isn't its result, in one line for the review: how it ended, what is wrong with the file it
// was to write, anything Mynt saw itself (the toolchain's install), and the agent's own last message.
function noResult(o: { who: string; ending: ReturnType<typeof agentEnding>; file: string | null; problems: string[]; notes: string[]; lastMessage: string | null; attempt: number }) {
  const parts = [
    `${o.who} ${o.ending.how}${o.file ? ` without ${o.file}` : ""}${o.attempt > 1 ? `, on ${o.attempt === 2 ? "both" : `all ${o.attempt}`} attempts` : ""}`,
    ...o.problems,
    ...o.notes,
    ...(o.lastMessage?.trim() ? [`its last message: "${oneLine(o.lastMessage, 300)}"`] : []),
  ];
  return parts.length > 1 ? `${parts[0]}: ${parts.slice(1).join("; ")}` : parts[0];
}

// What a review says of model spend that couldn't be measured.
const RESERVED_NOTE = "Reserved, not measured: some of the red team's model calls couldn't be priced, so the budget counts what was left of its cap. It is not money known to be spent";
const RED_ROLE = "program-red-team" as const;

// One attempt of a gate agent that didn't count, as the review keeps it.
export interface AgentAttempt {
  attempt: number;
  result: string | null;
  detail: string;
  exit_code: number | null;
  error: string | null;
  summary: string | null;
  cost_usd: number;
}

export class MainnetGateService implements MainnetGateCheck {
  private timer: NodeJS.Timeout | null = null;
  meter: AgentMeter | null = null;
  static TRANSIENT_GRACE_MS = defaultGraceMs();
  private transient = new GraceTracker(() => MainnetGateService.TRANSIENT_GRACE_MS);

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly solana: SolanaService,
    readonly sandboxes: SandboxHost | null,
    readonly config: GateConfig,
    // A gate for benchmark samples only (openForSamples): it reviews no program and can approve nothing.
    private readonly samples = false,
  ) {}

  // The vulnerability database the hard rules and the agents' checklist come from (tests swap in another version).
  vulnDb: VulnDb = loadVulnDb();

  static async open(db: Db, store: Store, solana: SolanaService, sandboxes: SandboxHost | null, config: GateConfig) {
    await db.exec(TABLES);
    const gate = new MainnetGateService(db, store, solana, sandboxes, config);
    solana.gate = gate;
    return gate;
  }

  // The gate for benchmark samples: the same agents, sandboxes, scripts and verdict logic, over tables of its own
  // (bench_solana_mainnet_reviews, bench_solana_mainnet_review_log). It has no program registry: it can't register,
  // approve, deploy or upgrade anything, no deploy ever asks it, and no month's review budget is touched.
  static async openForSamples(db: Db, store: Store, sandboxes: SandboxHost | null, config: GateConfig) {
    await db.exec(SAMPLE_TABLES);
    return new MainnetGateService(sampleDb(db), store, null as unknown as SolanaService, sandboxes, config, true);
  }

  private realOnly() {
    if (this.samples) throw new GateError("This gate only reviews benchmark samples: it has no programs to review, approve or deploy");
  }

  // Sandboxes, the agents' model backend and a public URL for their proxy: without all three no review can run,
  // and so (fail closed) no mainnet deploy or upgrade can happen.
  get enabled() {
    return !!this.sandboxes && !!this.config.agentBackend && !!this.config.publicUrl;
  }

  // Why the red team couldn't run on the model backend it is set to (its key, model or token prices aren't set);
  // null when it can, or runs on the backend every agent uses.
  redTeamMissing(): string | null {
    return roleBackendMissing(RED_ROLE);
  }

  // The backend and model a red team started now would run on.
  redTeamRunsOn(): { backend: "default" | SecondBackendKind; model: string | null } {
    const second = roleBackend(RED_ROLE);
    return second ? { backend: second.kind, model: second.model } : { backend: "default", model: this.config.gateModel };
  }

  private async all(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows as Row[];
  }
  private async one(sql: string, params: unknown[] = []) {
    return (await this.all(sql, params))[0];
  }

  private async update(id: string, f: Row) {
    const keys = Object.keys(f);
    if (!keys.length) return;
    await this.db.query(`UPDATE ${T}.solana_mainnet_reviews SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [
      id,
      ...keys.map((k) => (JSON_COLS.has(k) && f[k] != null ? JSON.stringify(f[k]) : f[k])),
    ]);
  }

  private async log(review: string, actor: string | null, event: string, detail: Row = {}) {
    await this.db.query(`INSERT INTO ${T}.solana_mainnet_review_log (id, review, actor, event, detail) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), review, actor, event, JSON.stringify(detail)]);
  }

  async row(id: string) {
    return this.one(`SELECT * FROM ${T}.solana_mainnet_reviews WHERE id::text = $1`, [id]);
  }

  // A review as people see it: every check's result, the findings, the cost; never a token or a sandbox id.
  async view(r: Row, opts: { log?: boolean } = {}) {
    const out = {
      review_id: r.id,
      program_id: r.program_id,
      build_id: r.build_id,
      sha256: r.sha256,
      action: r.action,
      status: r.status,
      step: r.step,
      phase_message: r.phase_message,
      blocked_reason: r.blocked_reason,
      error: r.error,
      checks: {
        rules: r.rules ?? null,
        static_analysis: r.static_analysis ?? null,
        audit: r.audit ?? null,
        // The PoCs' files stay in the record (Mynt re-ran exactly them); the view lists them by name.
        red_team: r.red_team ? (({ pocs: _, ...rest }) => rest)(r.red_team as Row) : null,
        poc_confirmations: r.confirmations ?? null,
      },
      // Build-influencing configuration and dependencies off the allowlist: an admin must allow each by id.
      exceptions: (r.exceptions as Exception[] | null) ?? [],
      allowed_exceptions: (r.allowed_exceptions as string[] | null) ?? [],
      dependencies: r.dependencies ?? null,
      idl_check: r.idl_check ?? null,
      caveats: [
        ...REVIEW_CAVEATS,
        ...(((r.exceptions as Exception[] | null) ?? []).length
          ? [`Exceptions in this program, each needing an admin's explicit allowance: ${((r.exceptions as Exception[]) ?? []).map((e) => e.id).join(", ")}${(r.allowed_exceptions as string[] | null)?.length ? ` (allowed: ${(r.allowed_exceptions as string[]).join(", ")})` : ""}`]
          : []),
      ],
      cost_usd: Number(r.cost_usd ?? 0),
      // Counted against the budget for model calls whose spend couldn't be measured: a reservation, never a cost.
      reserved_usd: r.reserved_usd === null || r.reserved_usd === undefined ? null : Number(r.reserved_usd),
      reserved_note: r.reserved_usd === null || r.reserved_usd === undefined ? null : RESERVED_NOTE,
      caps_usd: { audit: Number(r.audit_cap_usd), red_team: Number(r.red_cap_usd) },
      timelock: r.action === "upgrade" ? { hours: this.config.timelockHours, executes_at: iso(r.executes_at), announced_at: iso(r.announced_at) } : null,
      decision: r.decision ? { decision: r.decision, note: r.decision_note, by: r.decided_by, at: iso(r.decided_at) } : null,
      cancelled: r.cancelled_at ? { by: r.cancelled_by, at: iso(r.cancelled_at) } : null,
      started_at: iso(r.started_at),
      executed_at: iso(r.executed_at),
      requested_by: r.requested_by,
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    };
    if (!opts.log) return out;
    const log = await this.all(`SELECT actor, event, detail, created_at FROM ${T}.solana_mainnet_review_log WHERE review = $1 ORDER BY created_at, id`, [r.id]);
    return { ...out, log: log.map((l) => ({ ...l, created_at: iso(l.created_at) })) };
  }

  async list(f: { status?: string; program?: string } = {}) {
    return this.all(
      `SELECT * FROM ${T}.solana_mainnet_reviews WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR program_id = $2) ORDER BY created_at DESC LIMIT 200`,
      [f.status ?? null, f.program ?? null],
    );
  }

  // ---- requesting a review ----

  async request(user: User, programId: string, buildId: string) {
    this.realOnly();
    if (!this.enabled) throw new GateError("The mainnet program gate isn't available on this Mynt (it needs sandboxes, the agents' model backend and PUBLIC_URL), so mainnet deploys can't be reviewed");
    const redTeam = this.redTeamMissing();
    if (redTeam) throw new GateError(`The mainnet program gate can't review programs on this Mynt yet: ${redTeam}. A Mynt admin sets these in Platform settings`);
    const p = await this.solana.get(programId);
    if (!p || !this.solana.canAct(user, p)) throw new GateError(`No program of yours with id '${programId}'`);
    if (p.cluster !== "mainnet") throw new GateError("Only mainnet programs need a review; devnet deploys have no gate");
    if (p.status === "deploying" || p.operation) throw new GateError(`A ${p.operation ?? "deploy"} of this program is running`);
    const action: "deploy" | "upgrade" = p.status === "deployed" ? "upgrade" : "deploy";
    const open = await this.one(`SELECT id, status FROM ${T}.solana_mainnet_reviews WHERE program = $1 AND status = ANY($2) LIMIT 1`, [p.id, OPEN]);
    if (open) throw new GateError(`This program already has a review in progress (${open.id}, ${open.status}); cancel it first (cancel_mainnet_review)`);
    const m = await this.solana.reviewMaterial(user, p, buildId);
    if (action === "upgrade" && m.sha256 === p.verifiable_hash) throw new GateError("This build's program is the one already deployed");
    if (action === "upgrade") {
      const flag = await this.openFlag(p.id);
      if (flag) throw new GateError(`Upgrades of this program are paused: vulnerability database v${flag.db_version} flagged it (${flag.id}); an admin must review it first (resolve_program_flag)`);
    }

    // 1. Everything Mynt checks itself, here and now: cheap, and a program that fails never costs an agent.
    const signer = await this.solana.mainnetSigner();
    const refusals: string[] = [];
    // What the compiler compiles, and what in the workspace can change the build: exceptions an admin must allow.
    const tree = resolveCrateTree(m.sources ?? {});
    const exceptions: Exception[] = m.sources ? workspaceExceptions({ files: m.sources, binary: m.binary, links: m.links }, tree) : [];
    // What the compiler actually read (rustc's dep-info from Mynt's build container) is the authority: every file
    // it lists must be one Mynt captured, unchanged, and the rules read exactly those. The module-tree resolver is
    // a cross-check whose disagreements are exceptions.
    const compiled = this.compiledFiles(m);
    refusals.push(...compiled.problems);
    exceptions.push(...crossCheck(tree, compiled));
    // The dependencies: crates.io only, checksums matching, the allowlist or an admin's allowance; the hard rules run
    // over the source of every crate off the allowlist.
    const allow = this.allowlist;
    const deps = dependencyVerdict(m.deps, new Set(allow.crates), tree.packages);
    refusals.push(...deps.refusals);
    for (const c of deps.crates) if (allow.never?.[c.name]) refusals.push(`${c.name} ${c.version}: ${allow.never[c.name]}`);
    exceptions.push(...deps.exceptions);
    const depFindings: RuleFinding[] = [];
    for (const e of deps.exceptions) {
      const files = m.deps?.sources[e.id.slice("crate:".length)] ?? {};
      for (const f of runDetections({ name: e.id, program_id: p.program_id, program: null, idl: null, sources: files, mynt_signer: signer?.address ?? null }, this.vulnDb))
        if (f.blocks) depFindings.push({ ...f, detail: `in dependency ${e.id.slice("crate:".length)}: ${f.detail}` });
    }
    // The IDL: Mynt's own (built offline) or the test run's, used only if every instruction it lists is in the bytes.
    const idlCheck = m.idl ? { source: m.idl_source ?? "test-run", ...verifyIdl(m.idl, m.program) } : { source: null, verified: false, checked: 0, problems: ["no IDL was built for this program"] };
    if (m.idl && !idlCheck.verified) refusals.push(`The IDL doesn't match the program: ${idlCheck.problems.slice(0, 3).join("; ")}`);
    const idl = m.idl && idlCheck.verified ? m.idl : null;
    const result = checkProgramRules(
      { name: m.name, program_id: p.program_id, program: m.program, idl, sources: m.sources, mynt_signer: signer?.address ?? null, compiled_files: compiled.rulesFiles, listed_files: compiled.listedFiles },
      this.vulnDb,
    );
    // A blocking hit in a file dep-info doesn't list (read because build-time code ran): an exception, not a refusal.
    exceptions.push(...uncompiledHitExceptions(result.uncompiled_hits));
    const authority = upgradeAuthorityRule({ action, signer, recorded_authority: p.upgrade_authority });
    const findings: RuleFinding[] = [...result.findings, ...depFindings, authority];
    const passed = result.passed && !authority.blocks && !depFindings.length && !refusals.length;
    const rules = {
      passed,
      db_version: result.db_version,
      flags: result.flags,
      findings,
      signals: result.signals,
      limits: result.limits,
      upgrade_authority: authority.status,
      signer: signer ?? null,
      compiled: {
        workspace_files: compiled.workspace,
        registry_files: compiled.registry.length,
        generated_files: compiled.generated.map((g) => g.path),
        problems: compiled.problems,
        // Build-time code ran (a build script or proc macro): the rules also read every captured .rs file.
        rules_read_every_rust_file: compiled.buildTimeCode,
      },
    };
    const dependencies = { crates: deps.crates, allowlist_version: allow.version, off_allowlist: deps.exceptions.map((e) => e.id), refusals: deps.refusals };
    const id = randomUUID();
    const blockedBy = findings.filter((f) => f.blocks);
    // The month's budget, reserved atomically (a counter row updated only while it stays under the cap).
    const budgetKey = passed ? await this.reserve(this.config.auditCapUsd + this.config.redTeamCapUsd) : null;
    if (passed && !budgetKey) throw new GateError(`This month's mainnet review budget of US$${this.config.monthlyCapUsd} is used up (PROGRAM_GATE_MONTHLY_CAP_USD)`);
    const reasons = [
      ...refusals,
      ...blockedBy.map((f) => `${f.rule} (${f.signal}${f.file ? `, ${f.file}:${f.line}` : ""}): ${f.detail}`),
    ];
    try {
      await this.db.query(
        `INSERT INTO ${T}.solana_mainnet_reviews (id, program, program_id, entity_id, build_id, sha256, action, status, step, phase_message, requested_by, rules, blocked_reason, audit_cap_usd, red_cap_usd, step_started_at,
           exceptions, dependencies, idl_check, budget_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $16, $17, $18, $19)`,
        [
          id,
          p.id,
          p.program_id,
          p.entity_id,
          buildId,
          m.sha256,
          action,
          passed ? "running" : "blocked",
          passed ? "analysis_provisioning" : null,
          passed ? "Mynt's own checks passed; starting static analysis" : "Refused by Mynt's own checks",
          user.id,
          JSON.stringify(rules),
          passed ? null : `Hard rules: ${reasons.join("; ").slice(0, 3000)}`,
          this.config.auditCapUsd,
          this.config.redTeamCapUsd,
          JSON.stringify(exceptions.filter((e, i) => exceptions.findIndex((x) => x.id === e.id) === i)),
          JSON.stringify(dependencies),
          JSON.stringify(idlCheck),
          budgetKey,
        ],
      );
    } catch (e) {
      if (budgetKey) await this.release(budgetKey, this.config.auditCapUsd + this.config.redTeamCapUsd);
      if (/duplicate key|unique/i.test((e as Error).message)) throw new GateError("This program already has a review in progress; cancel it first (cancel_mainnet_review)");
      throw e;
    }
    await this.log(id, user.id, "requested", { action, build_id: buildId, sha256: m.sha256 });
    await this.log(id, null, passed ? "rules_passed" : "blocked", { findings: findings.length, blocking: blockedBy.length });
    await this.store.audit(user.id, "request_mainnet_review", p.program_id, { review_id: id, build_id: buildId, sha256: m.sha256, action, rules_passed: passed });
    return (await this.row(id))!;
  }

  // ---- benchmark samples ----

  // Puts sample source through the gate's agents for a benchmark: no program is registered, no program record is
  // read or written, nothing can be approved or deployed from it, and the month's review budget isn't touched (the
  // benchmark run's own cap governs). `audit` runs static analysis and the program-audit agent on the source;
  // `red_team` has Mynt build the sample and runs the red team on the bytes, then Mynt's own re-run of its proofs.
  // Mynt's hard rules are recorded but stop nothing here, and aren't shown to the auditor: a real audit only ever
  // sees a program that passed them, and a sample with a planted flaw must reach the agent being measured.
  async requestSample(o: { mode: "audit" | "red_team"; name: string; program_id: string; files: Record<string, string>; ref: string; requested_by: string; cap_usd: number }) {
    if (!this.samples) throw new GateError("Samples are reviewed only by the benchmark's own gate");
    if (!this.enabled) throw new GateError("The gate's agents can't run on this Mynt (they need sandboxes, the agents' model backend and PUBLIC_URL)");
    const redTeam = o.mode === "red_team" ? this.redTeamMissing() : null;
    if (redTeam) throw new GateError(`The red team can't run on this Mynt yet: ${redTeam}`);
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(o.name)) throw new GateError(`'${o.name}' isn't a program name`);
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(o.program_id)) throw new GateError("The sample declares no program address");
    const files = Object.fromEntries(Object.entries(o.files).filter(([path]) => /^[A-Za-z0-9_.\/-]+$/.test(path) && !path.split("/").includes("..") && !path.startsWith("/")));
    if (!Object.keys(files).some((f) => f.endsWith(".rs"))) throw new GateError("The sample has no Rust source");
    const id = randomUUID();
    const sample: GateSample = { mode: o.mode, name: o.name, program_id: o.program_id, files, ref: o.ref };
    await this.db.query(
      `INSERT INTO ${T}.solana_mainnet_reviews (id, program, program_id, build_id, sha256, action, status, step, phase_message, requested_by, audit_cap_usd, red_cap_usd, step_started_at, sample)
       VALUES ($1, $2, $3, $4, $5, 'deploy', 'running', 'sample_provisioning', 'Preparing the sample', $6, $7, $7, now(), $8)`,
      [id, randomUUID(), o.program_id, randomUUID(), hash(JSON.stringify(files)), o.requested_by, o.cap_usd, JSON.stringify(sample)],
    );
    await this.log(id, o.requested_by, "sample_requested", { mode: o.mode, ref: o.ref, name: o.name });
    return (await this.row(id))!;
  }

  // Stops a sample's review (its benchmark run was stopped): its sandboxes too.
  async stopSample(id: string, reason: string) {
    if (!this.samples) throw new GateError("Samples are reviewed only by the benchmark's own gate");
    const r = await this.row(id);
    if (!r || r.status !== "running") return;
    await this.end(r, "cancelled", { error: reason.slice(0, 1000), phase_message: "Stopped" });
    await this.log(id, null, "cancelled", { reason: reason.slice(0, 500) });
  }

  // The crate allowlist (tests swap in another).
  allowlist: CrateAllowlist = loadCrateAllowlist();

  // ---- the month's budget: a counter row, reserved and released atomically ----

  private async reserve(amount: number): Promise<string | null> {
    const key = `gate_budget:${new Date().toISOString().slice(0, 7)}`;
    await this.db.query(`INSERT INTO ${T}.solana_settings (key, value) VALUES ($1, '0'::jsonb) ON CONFLICT (key) DO NOTHING`, [key]);
    const r = await this.db.query(
      `UPDATE ${T}.solana_settings SET value = to_jsonb((value #>> '{}')::numeric + $2::numeric), updated_at = now()
       WHERE key = $1 AND (value #>> '{}')::numeric + $2::numeric <= $3::numeric RETURNING key`,
      [key, amount, this.config.monthlyCapUsd],
    );
    return r.rows.length ? key : null;
  }

  private async release(key: string, amount: number) {
    if (amount > 0) await this.db.query(`UPDATE ${T}.solana_settings SET value = to_jsonb(GREATEST(0, (value #>> '{}')::numeric - $2::numeric)), updated_at = now() WHERE key = $1`, [key, amount]);
  }

  // Once a review's agents are done (or it ends): what it reserved but didn't spend goes back to the month.
  private async settle(id: string) {
    const r = await this.one(
      `UPDATE ${T}.solana_mainnet_reviews SET budget_settled = true WHERE id = $1 AND budget_settled = false AND budget_key IS NOT NULL RETURNING budget_key, audit_cap_usd, red_cap_usd, cost_usd, reserved_usd`,
      [id],
    );
    if (r) await this.release(r.budget_key as string, Math.max(0, Number(r.audit_cap_usd) + Number(r.red_cap_usd) - Number(r.cost_usd) - Number(r.reserved_usd ?? 0)));
  }

  // ---- decisions ----

  async decide(admin: User, id: string, decision: "approve" | "reject", note: string, allowExceptions: string[] = []) {
    this.realOnly();
    const r = await this.row(id);
    if (!r) throw new GateError("No such mainnet review");
    if (r.status !== "awaiting_approval") throw new GateError(`The review is ${r.status}; only one awaiting approval can be ${decision === "approve" ? "approved" : "rejected"}`);
    // Every exception must be allowed by name: nothing in the build is waved through by a blanket approval.
    const exceptions = ((r.exceptions as Exception[] | null) ?? []).map((e) => e.id);
    if (decision === "approve") {
      const missing = exceptions.filter((e) => !allowExceptions.includes(e));
      const unknown = allowExceptions.filter((e) => !exceptions.includes(e));
      if (missing.length) throw new GateError(`Can't approve without allowing each exception by its id (allow_exceptions): ${missing.join(", ")}`);
      if (unknown.length) throw new GateError(`Not exceptions of this review: ${unknown.join(", ")}`);
    }
    // The authority rule once more, as things stand now.
    if (decision === "approve") {
      const p = (await this.solana.get(r.program_id as string))!;
      const authority = upgradeAuthorityRule({ action: r.action as "deploy" | "upgrade", signer: await this.solana.mainnetSigner(), recorded_authority: p.upgrade_authority });
      if (authority.blocks) throw new GateError(`Can't approve: ${authority.detail}`);
    }
    const status: ReviewStatus = decision === "approve" ? "approved" : "rejected";
    await this.db.query(
      `UPDATE ${T}.solana_mainnet_reviews SET status = $2, decision = $3, decision_note = $4, decided_by = $5, decided_at = now(), updated_at = now(),
         phase_message = $6, allowed_exceptions = $7 WHERE id = $1 AND status = 'awaiting_approval'`,
      [
        id,
        status,
        decision,
        note,
        admin.id,
        decision === "reject"
          ? "Rejected by an admin"
          : r.action === "upgrade"
            ? `Approved; the upgrade runs once its timelock ends (${iso(r.executes_at)})`
            : `Approved; deploy_program may deploy exactly this build, once, within ${this.config.approvalTtlDays} days`,
        JSON.stringify(decision === "approve" ? allowExceptions : []),
      ],
    );
    await this.log(id, admin.id, decision === "approve" ? "approved" : "rejected", { note, allowed_exceptions: decision === "approve" ? allowExceptions : [] });
    await this.store.audit(admin.id, decision === "approve" ? "approve_mainnet_program" : "reject_mainnet_program", r.program_id as string, {
      review_id: id,
      build_id: r.build_id,
      sha256: r.sha256,
      action: r.action,
      note,
      allowed_exceptions: decision === "approve" ? allowExceptions : [],
    });
    if (decision === "reject" && r.announced_at) await this.announceCancel(r, "rejected by an admin");
    return (await this.row(id))!;
  }

  async cancel(user: User, id: string, admin: boolean) {
    this.realOnly();
    const r = await this.row(id);
    if (!r) throw new GateError("No such mainnet review");
    const p = await this.solana.get(r.program_id as string);
    if (!admin && !(p && this.solana.canAct(user, p))) throw new GateError("No such mainnet review");
    if (!OPEN.includes(r.status as ReviewStatus)) throw new GateError(`The review is ${r.status}; there's nothing to cancel`);
    if (r.started_at || r.status === "started") throw new GateError(`The ${r.action} has already started; it can't be cancelled now`);
    const done = await this.db.query(
      `UPDATE ${T}.solana_mainnet_reviews SET status = 'cancelled', cancelled_by = $2, cancelled_at = now(), audit_token_hash = NULL, red_token_hash = NULL, updated_at = now(),
         phase_message = 'Cancelled' WHERE id = $1 AND status = ANY($3) AND started_at IS NULL RETURNING id`,
      [id, user.id, ["running", "awaiting_approval", "approved"]],
    );
    if (!done.rows.length) throw new GateError("The review changed meanwhile; look again with get_mainnet_review");
    await this.stopSandboxes(r);
    await this.settle(id);
    await this.log(id, user.id, "cancelled", { by: admin ? "admin" : "developer" });
    await this.store.audit(user.id, "cancel_mainnet_review", r.program_id as string, { review_id: id, as_admin: admin });
    if (r.announced_at) await this.announceCancel(r, admin ? "cancelled by an admin" : "cancelled by the developer");
    return (await this.row(id))!;
  }

  private async announceCancel(r: Row, why: string) {
    if (r.entity_id)
      await emitFirmEvent(this.store, r.entity_id as string, "program.upgrade_cancelled", { program_id: r.program_id, review_id: r.id, build_id: r.build_id, verifiable_hash: r.sha256, reason: why }, false);
  }

  // ---- what deploys ask ----

  // The approved review covering exactly these bytes, or why there's none. An approval is used once: a deploy or
  // upgrade claims it, so going A -> B -> A needs a fresh review (and, for an upgrade, a fresh timelock and
  // announcement).
  async check(p: ProgramRecord, sha256: string, action: "deploy" | "upgrade") {
    this.realOnly();
    if (action === "upgrade") {
      const flag = await this.openFlag(p.id);
      if (flag) throw new GateError(`Upgrades of this program are paused: vulnerability database v${flag.db_version} flagged it (${flag.id}); an admin must review it first`);
    }
    const r = await this.one(`SELECT * FROM ${T}.solana_mainnet_reviews WHERE program = $1 AND sha256 = $2 AND action = $3 AND status = 'approved' ORDER BY created_at DESC LIMIT 1`, [
      p.id,
      sha256,
      action,
    ]);
    if (!r) {
      const latest = await this.one(`SELECT id, status, sha256 FROM ${T}.solana_mainnet_reviews WHERE program = $1 ORDER BY created_at DESC LIMIT 1`, [p.id]);
      const about =
        latest && latest.sha256 === sha256
          ? latest.status === "executed" || latest.status === "started"
            ? ` (its approval in review ${latest.id} was used by an earlier ${action}; each approval is used once)`
            : ` (its review ${latest.id} is ${latest.status}${latest.status === "awaiting_approval" ? ": an admin must approve it" : ""})`
          : latest
            ? ` (the latest review, ${latest.id}, is for a different build's program)`
            : "";
      throw new GateError(`Mainnet ${action}s need an approved mainnet review of exactly this build's program (sha256 ${sha256})${about}; start one with request_mainnet_review`);
    }
    if (action === "upgrade") {
      const at = r.executes_at ? new Date(r.executes_at as string).getTime() : NaN;
      if (!Number.isFinite(at) || at > Date.now()) throw new GateError(`This upgrade is timelocked until ${iso(r.executes_at)}; it runs then (cancel_mainnet_review stops it)`);
      if (Date.now() - at > this.config.approvalTtlDays * 86_400_000)
        throw new GateError(`The approval (review ${r.id}) expired: an approved upgrade must start within ${this.config.approvalTtlDays} days of its timelock ending (MAINNET_APPROVAL_TTL_DAYS); request a new review`);
    } else {
      const decided = r.decided_at ? new Date(r.decided_at as string).getTime() : 0;
      if (Date.now() - decided > this.config.approvalTtlDays * 86_400_000)
        throw new GateError(`The approval (review ${r.id}) expired: first-deploy approvals last ${this.config.approvalTtlDays} days (MAINNET_APPROVAL_TTL_DAYS); request a new review`);
    }
    // The current vulnerability database's hard rules, once more, over exactly these bytes.
    const m = await this.solana.reviewMaterial(null, p, r.build_id as string);
    if (m.sha256 !== sha256) throw new GateError("The stored program no longer matches the reviewed hash");
    const idl = (r.idl_check as { verified?: boolean } | null)?.verified ? m.idl : null;
    const compiled = this.compiledFiles(m);
    if (compiled.problems.length) throw new GateError(`What the compiler read no longer checks out: ${compiled.problems.slice(0, 3).join("; ")}`);
    const now = checkProgramRules(
      { name: m.name, program_id: p.program_id, program: m.program, idl, sources: m.sources, mynt_signer: (await this.solana.mainnetSigner())?.address ?? null, compiled_files: compiled.rulesFiles, listed_files: compiled.listedFiles },
      this.vulnDb,
    );
    // An uncompiled hit passes only if the approving admin allowed it by name.
    const allowed = new Set((r.allowed_exceptions as string[] | null) ?? []);
    const unallowed = now.findings.filter((f) => f.uncompiled && !allowed.has(`uncompiled-hit:${f.file}`));
    if (!now.passed || unallowed.length)
      throw new GateError(
        `The vulnerability database's current rules (v${now.db_version}) refuse this program: ${now.findings
          .filter((f) => f.blocks || unallowed.includes(f))
          .map((f) => `${f.rule}: ${f.detail}`)
          .join("; ")
          .slice(0, 600)}; request a new review`,
      );
    return r;
  }

  // Claims (consumes) the approval, atomically: two deploys at once can't both use it, and a cancel can't race it.
  async claim(p: ProgramRecord, sha256: string, action: "deploy" | "upgrade"): Promise<MainnetGateClaim> {
    const r = await this.check(p, sha256, action);
    const claimed = await this.db.query(
      `UPDATE ${T}.solana_mainnet_reviews SET status = 'started', started_at = now(), claimed_hash = $2, error = NULL, updated_at = now(), phase_message = $3
       WHERE id = $1 AND status = 'approved' AND started_at IS NULL RETURNING id`,
      [r.id, p.verifiable_hash, `The ${action} started`],
    );
    if (!claimed.rows.length) throw new GateError("The approval was just used or changed; look again with get_mainnet_review");
    await this.log(r.id as string, null, "claimed", { action, program_hash_before: p.verifiable_hash });
    const id = r.id as string;
    return {
      reviewId: id,
      release: async () => {
        await this.db.query(
          `UPDATE ${T}.solana_mainnet_reviews SET status = 'approved', started_at = NULL, claimed_hash = NULL, updated_at = now(), phase_message = 'Approved; the last attempt didn''t start'
           WHERE id = $1 AND status = 'started'`,
          [id],
        );
        await this.log(id, null, "released", { why: "the deploy or upgrade couldn't start" });
      },
    };
  }

  // ---- the agents' tokens, for Mynt's agent proxy ----

  async agentRun(token: string): Promise<AgentRun | null> {
    const h = hash(token);
    const a = await this.one(`SELECT id, audit_cap_usd FROM ${T}.solana_mainnet_reviews WHERE audit_token_hash = $1 AND status = 'running'`, [h]);
    if (a) return { key: `program-audit:${a.id}`, capUsd: Number(a.audit_cap_usd), model: this.config.gateModel };
    const r = await this.one(`SELECT id, red_cap_usd, red_backend, red_model FROM ${T}.solana_mainnet_reviews WHERE red_token_hash = $1 AND status = 'running'`, [h]);
    if (!r) return null;
    const run = { key: `program-red-team:${r.id}`, capUsd: Number(r.red_cap_usd) };
    if (!r.red_backend || r.red_backend === "default") return { ...run, model: this.config.gateModel };
    // On a second backend: the model it started on, at the prices and under the access programme set now. If the
    // role has since been moved off that backend, no price is given and the proxy sends nothing.
    const now = roleBackend(RED_ROLE);
    const same = now?.kind === r.red_backend ? now : null;
    return { ...run, model: (r.red_model as string | null) ?? undefined, backend: { kind: r.red_backend as SecondBackendKind, price: same?.price ?? null, accessProgram: same?.accessProgram ?? null } };
  }

  // ---- the worker ----

  async tick() {
    for (const r of await this.all(`SELECT * FROM ${T}.solana_mainnet_reviews WHERE status = 'running' ORDER BY created_at`)) {
      try {
        await this.advance(r);
        this.transient.clear(r.id as string);
      } catch (e) {
        if (this.transient.rideOut(r.id as string, e)) continue;
        await this.end(r, "failed", { error: failureMessage(e).slice(0, 1000) });
        await this.log(r.id as string, null, "failed", { error: failureMessage(e).slice(0, 500) });
      }
    }
    if (this.samples) return;
    await this.recheckDeployed();
    await this.runDueUpgrades();
    await this.markExecuted();
    if (Date.now() - this.prunedAt >= 3_600_000) {
      this.prunedAt = Date.now();
      await this.pruneCapturedSources().catch((e) => console.error("program source retention:", (e as Error).message));
    }
  }

  private prunedAt = 0;

  // Retention for what builds capture for this gate (source, dependencies, dep-info): kept for any build a mainnet
  // review names or a program version was deployed from, and for every build newer than PROGRAM_SOURCE_RETENTION_DAYS
  // (30 by default); the rest, devnet builds nobody took further, goes. The rows are shared by hash, so a row is
  // deleted only when no kept build still points at it.
  async pruneCapturedSources() {
    const cutoff = new Date(Date.now() - this.config.sourceRetentionDays * 86_400_000).toISOString();
    const kept = `SELECT a.sources_sha256, a.deps_sha256, a.depinfo_sha256 FROM ${T}.solana_program_artifacts a
      WHERE a.created_at >= $1
         OR a.build_id IN (SELECT build_id FROM ${T}.solana_mainnet_reviews WHERE build_id IS NOT NULL)
         OR a.build_id IN (SELECT build_id FROM ${T}.solana_program_versions)
         OR a.build_id IN (SELECT build_id FROM ${T}.solana_programs WHERE build_id IS NOT NULL AND status = 'deployed')`;
    const deleted: Record<string, number> = {};
    for (const [table, column] of [
      ["solana_program_sources", "sources_sha256"],
      ["solana_program_deps", "deps_sha256"],
      ["solana_program_depinfo", "depinfo_sha256"],
    ] as const) {
      const { rows } = await this.db.query(
        `DELETE FROM ${T}.${table} WHERE created_at < $1 AND sha256 NOT IN (SELECT k.${column} FROM (${kept}) k WHERE k.${column} IS NOT NULL) RETURNING sha256`,
        [cutoff],
      );
      deleted[table] = rows.length;
    }
    return deleted;
  }

  private async stopSandboxes(r: Row) {
    if (!this.sandboxes) return;
    for (const id of [r.analysis_sandbox_id, r.red_sandbox_id, r.confirm_sandbox_id]) if (id) await this.sandboxes.stop(id as string).catch(() => {});
  }

  private async end(r: Row, status: ReviewStatus, f: Row = {}) {
    await this.stopSandboxes(r);
    await this.update(r.id as string, { ...f, status, step: null, audit_token_hash: null, red_token_hash: null });
    await this.settle(r.id as string);
  }

  private async block(r: Row, reason: string, f: Row = {}) {
    await this.end(r, "blocked", { ...f, blocked_reason: reason.slice(0, 3000), phase_message: "Blocked by the mainnet program gate" });
    await this.log(r.id as string, null, "blocked", { reason: reason.slice(0, 1000) });
  }

  private async cost(r: Row) {
    const sandboxes = this.sandboxes!;
    let c = 0;
    for (const id of [r.analysis_sandbox_id, r.red_sandbox_id, r.confirm_sandbox_id]) if (id) c += await sandboxes.costDollars(id as string).catch(() => 0);
    let reserved: number | null = null;
    if (this.meter) {
      const red = await this.meter.spent(`program-red-team:${r.id}`);
      c += (await this.meter.spent(`program-audit:${r.id}`)) + red;
      // Calls the proxy couldn't price: the budget counts what was left of the red team's cap. Never 0, never a cost.
      if (await this.meter.unmeasured(`program-red-team:${r.id}`)) reserved = Math.max(0, Number(r.red_cap_usd) - red);
    }
    const before = r.reserved_usd === null || r.reserved_usd === undefined ? null : Number(r.reserved_usd);
    if (c !== Number(r.cost_usd) || reserved !== before) await this.update(r.id as string, { cost_usd: c, reserved_usd: reserved });
    return c;
  }

  private async sandboxReady(id: string) {
    const s = await this.sandboxes!.getSandbox(id);
    if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}`);
    return ["ready", "idle", "running"].includes(s.state);
  }

  private async material(r: Row) {
    if (this.samples) {
      const s = r.sample as GateSample | null;
      if (!s?.prepared) throw new Error("The sample wasn't prepared");
      const program = s.prepared.program_b64 ? new Uint8Array(Buffer.from(s.prepared.program_b64, "base64")) : new Uint8Array();
      const m = { name: s.name, sha256: r.sha256 as string, sources: s.prepared.sources as Record<string, string> | null, program, idl: s.prepared.idl, deps: s.prepared.deps as DepsCapture | null };
      return { p: { program_id: s.program_id }, m };
    }
    const p = await this.solana.get(r.program_id as string);
    if (!p) throw new Error("The program is gone");
    const m = await this.solana.reviewMaterial(null, p, r.build_id as string);
    if (m.sha256 !== r.sha256) throw new Error("The stored program no longer matches the reviewed hash");
    return { p, m };
  }

  // What the compiler read for a build, checked against what Mynt captured, and the files the rules must read: the
  // compiled workspace files, or, when any build script or proc macro ran (a workspace one, or a dependency's),
  // every captured .rs file as well, since build-time code could have rewritten the dep-info itself.
  private compiledFiles(m: { sources: Record<string, string> | null; binary?: Record<string, string>; deps: { packages: { name: string; version: string; source?: string | null }[] } | null; depinfo?: DepInfoCapture | null }) {
    const lock = (m.deps?.packages ?? []).filter((x) => x.source);
    const lockCrates = new Set(lock.map((x) => `${x.name}-${x.version}`));
    const tree = resolveCrateTree(m.sources ?? {});
    const scripts = new Set([...lock.map((x) => x.name), ...tree.packages.filter((p) => p.build).map((p) => p.name)]);
    const compiled = evaluateDepInfo(m.depinfo ?? null, { files: m.sources ?? {}, binary: m.binary }, lockCrates, scripts);
    const buildTimeCode =
      tree.packages.some((p) => p.build || p.procMacro) ||
      compiled.generated.length > 0 ||
      Object.values(m.depinfo?.crate_files ?? {}).some((files) => files["build.rs"] !== undefined);
    const rulesFiles = buildTimeCode ? [...new Set([...compiled.workspace, ...Object.keys(m.sources ?? {}).filter((f) => f.endsWith(".rs"))])].sort() : compiled.workspace;
    // What dep-info lists: a blocking hit outside it (in a file read only because build-time code ran, such as an
    // integration test the compiler never compiled) is an admin-named exception, uncompiled-hit:<file>.
    const listedFiles = buildTimeCode && !compiled.problems.length ? compiled.workspace : null;
    return { ...compiled, rulesFiles, buildTimeCode, listedFiles };
  }

  // The IDL the agents and the PoC re-run get: only one Mynt checked against the bytes, without doc strings.
  private agentIdl(r: Row, m: { idl: unknown }) {
    return (r.idl_check as { verified?: boolean } | null)?.verified ? stripIdlDocs(m.idl) : null;
  }

  private async newSandbox(r: Row, role: string) {
    return this.sandboxes!.createSandbox({ name: `mynt-${role}-${r.id}`, type: this.config.sandboxType, ttlSeconds: 3 * 3600, labels: { mynt_mainnet_review: r.id as string, mynt_role: role }, env: {} });
  }

  // The earlier attempts of one of this review's agents: the ones that didn't count.
  private attempts(r: Row, kind: "audit" | "red_team") {
    return ((r.agent_attempts as Record<string, AgentAttempt[]> | null) ?? {})[kind] ?? [];
  }

  // Whether an agent that stopped without its result runs once more, and with what: the attempt's number, what is
  // left of the agent's budget (the proxy meters every attempt under one key) and of its time limit. Null when it
  // doesn't: the ending wasn't one another attempt could help, it already had its second, or too little is left.
  private async again(r: Row, kind: "audit" | "red_team", o: { retry: boolean; capUsd: number; limitMinutes: number; costUsd: number }) {
    const earlier = this.attempts(r, kind);
    if (!o.retry || earlier.length + 1 >= GATE_AGENT_ATTEMPTS) return null;
    const metered = this.meter ? await this.meter.spent(`program-${kind === "audit" ? "audit" : "red-team"}:${r.id}`) : 0;
    const budgetUsd = o.capUsd - Math.max(metered, earlier.reduce((n, a) => n + a.cost_usd, 0) + o.costUsd);
    const minutes = Math.floor(o.limitMinutes - this.minutes(r));
    return budgetUsd >= RETRY_MIN_USD && minutes >= RETRY_MIN_MINUTES ? { attempt: earlier.length + 2, budgetUsd, minutes } : null;
  }

  // Sets an attempt that didn't count aside and clears the runner's record of it, so the next one starts clean.
  private async setAside(r: Row, kind: "audit" | "red_team", sandbox: string, attempt: AgentAttempt) {
    const agent_attempts = { ...((r.agent_attempts as Record<string, AgentAttempt[]> | null) ?? {}), [kind]: [...this.attempts(r, kind), attempt] };
    await this.sandboxes!.exec(sandbox, `rm -f ${AGENT_DIR}/state.json`, { timeoutSeconds: 30 });
    await this.update(r.id as string, { agent_attempts });
    return { ...r, agent_attempts };
  }

  // The program-audit agent, in the analysis sandbox. A second attempt is told how the first ended.
  private async startAudit(r: Row, o: { attempt: number; budgetUsd: number; minutes: number; previous: string | null }) {
    const token = `mynt_paudit_${randomBytes(24).toString("base64url")}`;
    await this.update(r.id as string, { audit_token_hash: hash(token) });
    const { p, m } = await this.material(r);
    return launchAgent(this.sandboxes!, this.config, r.analysis_sandbox_id as string, {
      prompt: "Audit the Solana program described in job/review.json, following CLAUDE.md and its skills. Write job/findings.json and run scripts/check_findings.py until it passes.",
      budgetUsd: o.budgetUsd,
      token,
      model: this.config.gateModel,
      workspace: AUDIT_WS,
      jobFiles: {
        "job/vulnerabilities.json": JSON.stringify(agentChecklist(this.vulnDb), null, 1),
        "job/review.json": JSON.stringify(
          {
            program: { name: m.name, program_id: p.program_id, sha256: m.sha256, action: r.action },
            source_dir: `${GATE_DIR}/src`,
            files: Object.keys(m.sources ?? {}).sort(),
            deterministic_rules: this.samples ? null : ((r.rules as Row | null) ?? null),
            static_analysis: r.static_analysis ?? null,
            idl: this.agentIdl(r, m),
            dependency_dirs: Object.fromEntries(Object.keys(m.deps?.sources ?? {}).filter((k) => ((r.exceptions as Exception[] | null) ?? []).some((e) => e.id === `crate:${k}`)).map((k) => [k, `${GATE_DIR}/deps/${k}`])),
            output: "job/findings.json",
            minutes: o.minutes,
            attempt: o.attempt,
            attempts: GATE_AGENT_ATTEMPTS,
            ...(o.previous ? { previous_attempt: o.previous } : {}),
          },
          null,
          1,
        ),
      },
    });
  }

  // The red team, in its own sandbox, with the report's schema beside its job. A second attempt is told how the
  // first ended.
  private async startRedTeam(r: Row, o: { attempt: number; budgetUsd: number; minutes: number; previous: string | null }) {
    const token = `mynt_predteam_${randomBytes(24).toString("base64url")}`;
    await this.update(r.id as string, { red_token_hash: hash(token) });
    const { p, m } = await this.material(r);
    return launchAgent(this.sandboxes!, this.config, r.red_sandbox_id as string, {
      prompt: "Attack the Solana program described in job/target.json, following CLAUDE.md and its skills. Write job/report.json and a runnable proof of concept for every finding, and run scripts/check_report.py until it passes.",
      budgetUsd: o.budgetUsd,
      token,
      // The backend and model fixed when the red team first started (a second attempt runs on the same ones).
      model: (r.red_model as string | null) ?? this.config.gateModel,
      ...(r.red_backend && r.red_backend !== "default" ? { backend: r.red_backend as SecondBackendKind } : {}),
      workspace: RED_WS,
      jobFiles: {
        "job/idl.json": JSON.stringify(this.agentIdl(r, m), null, 1),
        "job/vulnerabilities.json": JSON.stringify(agentChecklist(this.vulnDb), null, 1),
        "job/report.schema.json": RED_TEAM_REPORT_SCHEMA,
        "job/target.json": JSON.stringify(
          {
            program_id: p.program_id,
            name: m.name,
            sha256: m.sha256,
            program_so: "job/program.so",
            idl: "job/idl.json",
            toolchain_env: "~/.mynt-solana/env",
            toolchain_log: TOOLCHAIN_LOG,
            toolchain_exit: TOOLCHAIN_EXIT,
            toolchain_installer: TOOLCHAIN_INSTALLER,
            output: "job/report.json",
            schema: "job/report.schema.json",
            poc_dir: "job/poc",
            minutes: o.minutes,
            attempt: o.attempt,
            attempts: GATE_AGENT_ATTEMPTS,
            ...(o.previous ? { previous_attempt: o.previous } : {}),
          },
          null,
          1,
        ),
      },
    });
  }

  private minutes(r: Row) {
    return r.step_started_at ? (Date.now() - Date.parse(new Date(r.step_started_at as string).toISOString())) / 60_000 : 0;
  }

  private async advance(r: Row) {
    const sandboxes = this.sandboxes!;
    const id = r.id as string;
    await this.cost(r);

    // 0. A benchmark sample: made whole (and, for the red team, built) in a sandbox of Mynt's.
    if (r.step === "sample_provisioning") {
      if (!r.analysis_sandbox_id) {
        const s = await this.newSandbox(r, "program-sample");
        await this.update(id, { analysis_sandbox_id: s.id, step_started_at: new Date() });
        return;
      }
      if (!(await this.sandboxReady(r.analysis_sandbox_id as string))) return;
      const sample = r.sample as GateSample;
      // The coding agents' own starter program and scaffold script, as shipped: the sample's files go over it.
      const kit = workspaceFiles("coding-build");
      const files: Record<string, string> = {
        [`${SAMPLE_DIR}/sample.sh`]: GATE_SAMPLE_SCRIPT,
        [`${SAMPLE_DIR}/solana-verify.sh`]: SOLANA_VERIFY_SCRIPT,
        [`${SAMPLE_DIR}/allowlist.json`]: JSON.stringify(this.allowlist),
      };
      for (const [path, text] of Object.entries(kit)) if (path === "scripts/scaffold_program.py" || path.startsWith("templates/solana-program/")) files[`${SAMPLE_DIR}/kit/${path}`] = text;
      for (const [path, text] of Object.entries(sample.files)) files[`${SAMPLE_DIR}/sample/${path}`] = text;
      await this.writeFiles(r.analysis_sandbox_id as string, files);
      const run = await sandboxes.exec(r.analysis_sandbox_id as string, `bash ${SAMPLE_DIR}/sample.sh ${SAMPLE_DIR} ${sample.name} ${sample.program_id} ${sample.mode === "red_team" ? "build" : "capture"}`, { detached: true });
      await this.update(id, {
        step: "sample_preparing",
        analysis_process_id: String(run.processId ?? ""),
        step_started_at: new Date(),
        phase_message: sample.mode === "red_team" ? "Mynt is building the sample" : "Mynt is laying out the sample's source",
      });
      await this.log(id, null, "sample_preparing", { mode: sample.mode });
      return;
    }

    if (r.step === "sample_preparing") {
      const sb = r.analysis_sandbox_id as string;
      const sample = r.sample as GateSample;
      const timedOut = this.minutes(r) > this.config.analysisMinutes;
      if (!timedOut && (await sandboxes.commandStatus(sb, Number(r.analysis_process_id))).running) return;
      const unprepared = (why: string) => this.end(r, "failed", { error: `Mynt couldn't prepare the sample: ${why}`.slice(0, 1000), phase_message: "Failed" });
      const prep = parse<{ error?: string; sources_size?: number; sources_sha256?: string }>(await sandboxes.readFile(sb, `${SAMPLE_DIR}/prep.json`));
      if (!prep) return unprepared(timedOut ? `it didn't finish within ${this.config.analysisMinutes} minutes` : "the preparation left no result");
      if (prep.error) return unprepared(prep.error);
      const out = `${SAMPLE_DIR}/build/out`;
      let prepared: NonNullable<GateSample["prepared"]>;
      let sha256 = r.sha256 as string;
      let idlCheck: Row = { source: null, verified: false, checked: 0, problems: ["no IDL was built for this sample"] };
      if (sample.mode === "red_team") {
        const built = (await readBuiltPrograms(sandboxes, sb, out)).find((b) => b.name === sample.name);
        if (!built) return unprepared(`Mynt's Solana build produced no program '${sample.name}' (${(await buildCheck(sandboxes, sb, out)).detail || "no detail"})`);
        if (built.declared_id !== sample.program_id) return unprepared(`the built program declares ${built.declared_id ?? "no address"}, not ${sample.program_id}`);
        prepared = { sources: built.sources?.files ?? sample.files, program_b64: Buffer.from(built.program).toString("base64"), idl: built.idl, deps: built.deps, depinfo: built.depinfo };
        sha256 = built.sha256;
        if (built.idl) idlCheck = { source: "build", ...verifyIdl(built.idl, built.program) };
      } else {
        const captured = await readBackJson<{ files?: Record<string, string> }>(sandboxes, sb, `${out}/sample.sources.json`, prep.sources_size, prep.sources_sha256);
        if (!captured?.files || !Object.keys(captured.files).some((f) => f.endsWith(".rs"))) return unprepared("the sample's source couldn't be read back");
        prepared = { sources: captured.files, program_b64: null, idl: null, deps: null, depinfo: null };
        sha256 = prep.sources_sha256!;
      }
      // Mynt's hard rules, for the record only: a sample must reach the agent being measured whatever they say.
      const result = checkProgramRules({ name: sample.name, program_id: sample.program_id, program: prepared.program_b64 ? new Uint8Array(Buffer.from(prepared.program_b64, "base64")) : null, idl: null, sources: prepared.sources, mynt_signer: null }, this.vulnDb);
      const rules = { sample: true, passed: result.passed, db_version: result.db_version, findings: result.findings, signals: result.signals, limits: result.limits, note: "Recorded only: a benchmark sample isn't stopped by the hard rules, and the auditor isn't shown them" };
      await this.update(id, { sample: { ...sample, prepared }, sha256, rules, idl_check: idlCheck });
      await this.log(id, null, "sample_prepared", { mode: sample.mode, files: Object.keys(prepared.sources).length, hard_rules_would_pass: result.passed });
      if (sample.mode === "audit") {
        // The same sandbox goes on to static analysis and the audit, as for any review.
        await this.update(id, { step: "analysis_provisioning", step_started_at: new Date(), phase_message: "The sample is ready; starting static analysis" });
        return;
      }
      await sandboxes.stop(sb).catch(() => {});
      const s = await this.newSandbox(r, "program-red-team");
      await this.update(id, { step: "red_provisioning", red_sandbox_id: s.id, step_started_at: new Date(), phase_message: "Starting the red team's sandbox" });
      return;
    }

    // 2a. Static analysis, in a sandbox of Mynt's with only the captured source.
    if (r.step === "analysis_provisioning") {
      if (!r.analysis_sandbox_id) {
        const s = await this.newSandbox(r, "program-analysis");
        await this.update(id, { analysis_sandbox_id: s.id, step_started_at: new Date() });
        return;
      }
      if (!(await this.sandboxReady(r.analysis_sandbox_id as string))) return;
      const { m } = await this.material(r);
      const files: Record<string, string> = { [`${GATE_DIR}/analysis.sh`]: GATE_ANALYSIS_SCRIPT };
      for (const [path, text] of Object.entries(m.sources ?? {})) if (!path.split("/").includes("..")) files[`${GATE_DIR}/src/${path}`] = text;
      // The Cargo.lock the build compiled with (what cargo-audit checks), whether or not the workspace committed one.
      if (m.deps?.lock) files[`${GATE_DIR}/src/Cargo.lock`] = m.deps.lock;
      // The source of each crate off the allowlist, for the auditor.
      for (const e of ((r.exceptions as Exception[] | null) ?? []).filter((x) => x.kind === "crate")) {
        const key = e.id.slice("crate:".length);
        for (const [path, text] of Object.entries(m.deps?.sources[key] ?? {})) if (!path.split("/").includes("..")) files[`${GATE_DIR}/deps/${key}/${path}`] = text;
      }
      await this.writeFiles(r.analysis_sandbox_id as string, files);
      const run = await sandboxes.exec(r.analysis_sandbox_id as string, `bash ${GATE_DIR}/analysis.sh ${GATE_DIR}/src ${GATE_DIR}/out '${this.config.cargoAuditIgnore.join(",")}'`, { detached: true });
      await this.update(id, { step: "analysis", analysis_process_id: String(run.processId ?? ""), step_started_at: new Date(), phase_message: "Static analysis: cargo-audit and Radar" });
      await this.log(id, null, "analysis_started", { tools: { cargo_audit: GATE_TOOLS.cargoAudit.version, radar: GATE_TOOLS.radar.commit } });
      return;
    }

    if (r.step === "analysis") {
      const timedOut = this.minutes(r) > this.config.analysisMinutes;
      if (!timedOut && (await sandboxes.commandStatus(r.analysis_sandbox_id as string, Number(r.analysis_process_id))).running) return;
      const report = parse<{ tools?: StaticTool[] }>(await sandboxes.readFile(r.analysis_sandbox_id as string, `${GATE_DIR}/out/static.json`));
      const verdict = assessStatic(report);
      const record = { passed: verdict.passed, reasons: verdict.reasons, tools: verdict.tools, ...(timedOut ? { timed_out: true } : {}) };
      await this.update(id, { static_analysis: record });
      await this.log(id, null, verdict.passed ? "analysis_passed" : "analysis_blocked", { reasons: verdict.reasons });
      if (timedOut && !report && this.samples) return this.end(r, "failed", { error: `Static analysis didn't finish within ${this.config.analysisMinutes} minutes`, phase_message: "Failed" });
      if (timedOut && !report) return this.block(r, `Static analysis didn't finish within ${this.config.analysisMinutes} minutes`);
      // A sample goes on to the auditor whatever the tools said: their verdict is recorded, and the agent is measured.
      if (!verdict.passed && !this.samples) return this.block(r, `Static analysis: ${verdict.reasons.join("; ")}`);
      // 2b. The program-audit agent, in the same sandbox, after Mynt has the tools' results.
      const pid = await this.startAudit({ ...r, static_analysis: record }, { attempt: 1, budgetUsd: Number(r.audit_cap_usd), minutes: this.config.auditMinutes, previous: null });
      await this.update(id, { step: "audit", audit_process_id: pid, audit_started_at: new Date(), step_started_at: new Date(), phase_message: "The program-audit agent is reading the source" });
      await this.log(id, null, "audit_started", { model: this.config.gateModel, cap_usd: Number(r.audit_cap_usd) });
      return;
    }

    if (r.step === "audit") {
      const sb = r.analysis_sandbox_id as string;
      const agent = await agentState(sandboxes, sb, r.audit_process_id as string);
      const timedOut = agent.running && this.minutes(r) > this.config.auditMinutes;
      if (agent.running && !timedOut) return;
      const raw = await sandboxes.readFile(sb, `${workspaceCwd(AUDIT_WS)}/job/findings.json`);
      const { m } = await this.material(r);
      const a = assessAudit(raw, m.sources ?? {});
      const finished = a.finished && agent.ok && !timedOut;
      const ending = agentEnding({ state: agent.state, timedOut, minutes: this.config.auditMinutes });
      const earlier = this.attempts(r, "audit");
      const fileProblem = auditFileProblem(raw);
      const detail = finished ? null : noResult({ who: "the program-audit agent", ending, file: fileProblem ? "a valid findings.json" : null, problems: fileProblem ? [fileProblem] : [], notes: [], lastMessage: agent.state?.summary ?? null, attempt: earlier.length + 1 });
      if (detail) {
        const next = await this.again(r, "audit", { retry: ending.retry, capUsd: Number(r.audit_cap_usd), limitMinutes: this.config.auditMinutes, costUsd: agent.cost });
        if (next) {
          const first = noResult({ who: "the program-audit agent", ending, file: fileProblem ? "a valid findings.json" : null, problems: fileProblem ? [fileProblem] : [], notes: [], lastMessage: null, attempt: 1 });
          const kept = await this.setAside(r, "audit", sb, { attempt: earlier.length + 1, result: ending.result, detail, exit_code: ending.exit_code, error: ending.error, summary: agent.state?.summary?.slice(0, 1500) ?? null, cost_usd: agent.cost });
          const pid = await this.startAudit(kept, { ...next, previous: first });
          await this.update(id, { audit_process_id: pid, audit_started_at: new Date(), phase_message: `The program-audit agent stopped without its findings; running it once more (attempt ${next.attempt} of ${GATE_AGENT_ATTEMPTS})` });
          await this.log(id, null, "audit_retried", { attempt: next.attempt, why: detail.slice(0, 1000) });
          return;
        }
      }
      const audit = {
        finished,
        attempt: earlier.length + 1,
        agent: { result: ending.result, summary: a.summary ?? agent.state?.summary?.slice(0, 1500) ?? null, exit_code: ending.exit_code, error: ending.error, ...(detail ? { detail } : {}) },
        ...(earlier.length ? { earlier_attempts: earlier } : {}),
        findings: a.findings,
        blocking: a.blocking.map((f) => f.id),
      };
      await sandboxes.stop(sb).catch(() => {});
      await this.update(id, { audit, audit_token_hash: null });
      await this.log(id, null, "audit_finished", { finished: audit.finished, findings: a.findings.length, blocking: a.blocking.length, ...(detail ? { why: detail.slice(0, 1000) } : {}) });
      if (detail) return this.block(r, `No complete independent audit (${detail}); a mainnet program can't pass without one`);
      if (a.blocking.length) return this.block(r, `Audit: ${a.blocking.length} verified critical/high finding(s): ${a.blocking.slice(0, 5).map((f) => `${f.severity} ${f.title} (${f.file}${f.line ? `:${f.line}` : ""})`).join("; ")}`);
      // An audit sample ends here: the red team has samples of its own.
      if (this.samples) return this.gatesPassed({ ...r, audit });
      // 3. The red team, in a sandbox of its own.
      const s = await this.newSandbox(r, "program-red-team");
      await this.update(id, { step: "red_provisioning", red_sandbox_id: s.id, step_started_at: new Date(), phase_message: "Starting the red team's sandbox" });
      return;
    }

    if (r.step === "red_provisioning") {
      if (!(await this.sandboxReady(r.red_sandbox_id as string))) return;
      const { m } = await this.material(r);
      const sb = r.red_sandbox_id as string;
      const job = `${workspaceCwd(RED_WS)}/job`;
      // The bytes Mynt stored and the IDL; nothing of the source.
      await this.writeFiles(sb, { [`${job}/program.so.b64`]: Buffer.from(m.program).toString("base64"), [TOOLCHAIN_INSTALLER]: SOLANA_TOOLCHAIN_SCRIPT });
      const decoded = await sandboxes.exec(sb, `base64 -d ${job}/program.so.b64 > ${job}/program.so && rm ${job}/program.so.b64 && sha256sum ${job}/program.so`, { timeoutSeconds: 120 });
      if (decoded.exitCode !== 0) throw new Error("Couldn't place the program in the red team's sandbox");
      // The install's exit code is kept beside its log: the red team's wait script reads it, and so does Mynt when
      // the red team stops without a report.
      await sandboxes.exec(sb, `bash ${TOOLCHAIN_INSTALLER} > ${TOOLCHAIN_LOG} 2>&1; echo $? > ${TOOLCHAIN_EXIT}`, { detached: true });
      // Which model backend it runs on is decided here, once, and kept on the review. One that has lost its key,
      // model or prices since the review was requested blocks: there is no red team to run.
      const missing = this.redTeamMissing();
      if (missing) return this.block(r, `No red-team result (${missing}); a mainnet program can't pass without one`);
      const on = this.redTeamRunsOn();
      await this.update(id, { red_backend: on.backend, red_model: on.model });
      const pid = await this.startRedTeam({ ...r, red_backend: on.backend, red_model: on.model }, { attempt: 1, budgetUsd: Number(r.red_cap_usd), minutes: this.config.redTeamMinutes, previous: null });
      await this.update(id, { step: "red_team", red_process_id: pid, red_started_at: new Date(), step_started_at: new Date(), phase_message: "The red team is attacking the program on a local validator" });
      await this.log(id, null, "red_team_started", { backend: on.backend, model: on.model, cap_usd: Number(r.red_cap_usd) });
      return;
    }

    if (r.step === "red_team") {
      const sb = r.red_sandbox_id as string;
      const agent = await agentState(sandboxes, sb, r.red_process_id as string);
      const timedOut = agent.running && this.minutes(r) > this.config.redTeamMinutes;
      if (agent.running && !timedOut) return;
      const job = `${workspaceCwd(RED_WS)}/job`;
      const { report, problems, incomplete } = checkRedTeamReport(await sandboxes.readFile(sb, `${job}/report.json`));
      // The red team's result is a report that validates against the schema and doesn't say it is incomplete, from
      // a run that ended cleanly and in time. Anything else blocks.
      const finished = !!report && !incomplete && agent.ok && !timedOut;
      const ending = agentEnding({ state: agent.state, timedOut, minutes: this.config.redTeamMinutes });
      const earlier = this.attempts(r, "red_team");
      // What Mynt sees of the toolchain's install itself: the red team can't attack without it.
      let toolchain: string | null = null;
      const notes: string[] = [];
      if (!finished) {
        const exit = (await sandboxes.readFile(sb, TOOLCHAIN_EXIT).catch(() => null))?.trim();
        toolchain = exit === "0" ? "installed" : exit ? `failed (exit ${exit.slice(0, 8)})` : "still installing";
        if (!exit) notes.push("the Solana toolchain was still installing when it stopped");
        else if (exit !== "0") {
          const log = (await sandboxes.readFile(sb, TOOLCHAIN_LOG).catch(() => null)) ?? "";
          notes.push(`the Solana toolchain's install failed (exit ${exit.slice(0, 8)}${log.trim() ? `: ${oneLine(log.trim().split("\n").pop()!, 200)}` : ""})`);
        }
      }
      // The model provider's safeguards declined the red team's requests (the proxy records each, with the
      // provider's request id): said as that, and never tried again, since a second attempt would be refused too.
      const refusals = !finished && this.meter ? await this.meter.refusals(`program-red-team:${id}`) : [];
      const refusal = refusals.length ? { category: refusals[refusals.length - 1].category, request_ids: [...new Set(refusals.map((x) => x.request_id).filter((x): x is string => !!x))].slice(-3), count: refusals.length } : null;
      if (refusal) notes.push(`the model provider's safeguards refused the red team's work${refusal.category ? ` [${oneLine(refusal.category, 60)}]` : ""}${refusal.request_ids.length ? ` (request id ${refusal.request_ids.join(", ")})` : ""}`);
      const why = (attempt: number, lastMessage: string | null) =>
        noResult({
          who: "the red team",
          ending,
          file: !report ? "a valid report.json" : incomplete ? "a complete report.json" : null,
          problems: !report ? problems : incomplete ? [`its report says it is incomplete: ${oneLine(incomplete, 300)}`] : [],
          notes,
          lastMessage,
          attempt,
        });
      const detail = finished ? null : why(earlier.length + 1, agent.state?.summary ?? null);
      if (detail) {
        const next = await this.again(r, "red_team", { retry: ending.retry && !refusal, capUsd: Number(r.red_cap_usd), limitMinutes: this.config.redTeamMinutes, costUsd: agent.cost });
        if (next) {
          const kept = await this.setAside(r, "red_team", sb, { attempt: earlier.length + 1, result: ending.result, detail, exit_code: ending.exit_code, error: ending.error, summary: agent.state?.summary?.slice(0, 1500) ?? null, cost_usd: agent.cost });
          const pid = await this.startRedTeam(kept, { ...next, previous: why(1, null) });
          await this.update(id, { red_process_id: pid, phase_message: `The red team stopped without a complete report; running it once more (attempt ${next.attempt} of ${GATE_AGENT_ATTEMPTS})` });
          await this.log(id, null, "red_team_retried", { attempt: next.attempt, why: detail.slice(0, 1000) });
          return;
        }
      }
      // Every PoC the report names, read back as text, for Mynt to run itself.
      const pocs: Record<string, Record<string, string>> = {};
      for (const f of report?.findings ?? []) {
        if (!f.poc || pocs[f.poc] || Object.keys(pocs).length >= MAX_POCS) continue;
        const files = await this.readPoc(sb, `${job}/poc/${f.poc}`);
        if (files && files["run.sh"]) pocs[f.poc] = files;
      }
      const red = {
        finished,
        attempt: earlier.length + 1,
        // What it ran on: the model backend ("default": the one every agent uses) and the model.
        backend: (r.red_backend as string | null) ?? "default",
        model: (r.red_model as string | null) ?? this.config.gateModel,
        ...(refusal ? { refusal } : {}),
        agent: { result: ending.result, summary: report?.summary ?? agent.state?.summary?.slice(0, 1500) ?? null, exit_code: ending.exit_code, error: ending.error, ...(detail ? { detail } : {}) },
        ...(detail ? { report_problems: problems, incomplete_reason: incomplete, toolchain } : {}),
        ...(earlier.length ? { earlier_attempts: earlier } : {}),
        attacks_tried: report?.attacks_tried ?? [],
        findings: (report?.findings ?? []).map((f) => ({ ...f, poc: f.poc && pocs[f.poc] ? f.poc : null, poc_files: f.poc && pocs[f.poc] ? Object.keys(pocs[f.poc]) : [] })),
      };
      await sandboxes.stop(sb).catch(() => {});
      await this.update(id, { red_team: { ...red, pocs }, red_token_hash: null });
      await this.log(id, null, "red_team_finished", { finished, findings: red.findings.length, pocs: Object.keys(pocs).length, ...(detail ? { why: detail.slice(0, 1000) } : {}) });
      if (detail) return this.block(r, `No complete red-team result (${detail}); a mainnet program can't pass without one`);
      if (!Object.keys(pocs).length) return this.gatesPassed({ ...r, red_team: red });
      const s = await this.newSandbox(r, "program-poc-confirm");
      await this.update(id, { step: "confirm_provisioning", confirm_sandbox_id: s.id, step_started_at: new Date(), phase_message: `Mynt is re-running ${Object.keys(pocs).length} proof(s) of concept itself` });
      return;
    }

    if (r.step === "confirm_provisioning") {
      const sb = r.confirm_sandbox_id as string;
      if (!(await this.sandboxReady(sb))) return;
      const { p, m } = await this.material(r);
      const pocs = ((r.red_team as Row | null)?.pocs ?? {}) as Record<string, Record<string, string>>;
      const files: Record<string, string> = {
        [`${CONFIRM_DIR}/confirm.py`]: GATE_CONFIRM_SCRIPT,
        [`${CONFIRM_DIR}/toolchain.sh`]: SOLANA_TOOLCHAIN_SCRIPT,
        [`${CONFIRM_DIR}/program.so.b64`]: Buffer.from(m.program).toString("base64"),
        [`${CONFIRM_DIR}/idl.json`]: JSON.stringify(this.agentIdl(r, m)),
        [`${CONFIRM_DIR}/job.json`]: JSON.stringify({ program_id: p.program_id, pocs: Object.keys(pocs), timeout_seconds: 600 }),
      };
      for (const [poc, fs] of Object.entries(pocs)) for (const [path, text] of Object.entries(fs)) files[`${CONFIRM_DIR}/pocs/${poc}/${path}`] = text;
      await this.writeFiles(sb, files);
      const run = await sandboxes.exec(
        sb,
        `cd ${CONFIRM_DIR} && base64 -d program.so.b64 > program.so && bash toolchain.sh > toolchain.log 2>&1 && . "$HOME/.mynt-solana/env" && python3 confirm.py job.json > confirm.log 2>&1`,
        { detached: true },
      );
      await this.update(id, { step: "confirming", confirm_process_id: String(run.processId ?? ""), step_started_at: new Date() });
      return;
    }

    if (r.step === "confirming") {
      const sb = r.confirm_sandbox_id as string;
      const timedOut = this.minutes(r) > 90;
      if (!timedOut && (await sandboxes.commandStatus(sb, Number(r.confirm_process_id))).running) return;
      const out = parse<{ results?: Record<string, { confirmed?: boolean; reason?: string; error?: boolean }> }>(await sandboxes.readFile(sb, `${CONFIRM_DIR}/results.json`));
      await sandboxes.stop(sb).catch(() => {});
      const red = r.red_team as { findings: RedTeamFinding[] };
      const results = out?.results ?? {};
      const confirmations = Object.fromEntries(
        Object.keys(((r.red_team as Row | null)?.pocs ?? {}) as Row).map((poc) => {
          const x = results[poc];
          return [poc, x ? { confirmed: x.confirmed === true, reason: String(x.reason ?? "").slice(0, 1500), ...(x.error ? { error: true } : {}), ...(x.confirmed ? { detail: x } : {}) } : { confirmed: false, reason: "Mynt's re-run produced no result", error: true }];
        }),
      );
      await this.update(id, { confirmations });
      const confirmed = Object.entries(confirmations).filter(([, c]) => c.confirmed);
      await this.log(id, null, "pocs_rerun", { confirmed: confirmed.map(([poc]) => poc), total: Object.keys(confirmations).length });
      if (!out) return this.end(r, "failed", { error: `Mynt couldn't re-run the red team's proofs of concept${timedOut ? " in time" : ""}; request the review again`, phase_message: "Failed" });
      if (confirmed.length) {
        const titles = confirmed.map(([poc]) => red.findings.find((f) => f.poc === poc)?.title ?? poc);
        return this.block(r, `Red team: ${confirmed.length} exploit(s) confirmed by Mynt's own re-run: ${titles.slice(0, 5).join("; ")}`);
      }
      return this.gatesPassed(r);
    }
  }

  // Every automated gate passed: an admin decides. An upgrade is announced now, and its timelock starts.
  private async gatesPassed(r: Row) {
    const id = r.id as string;
    await this.settle(id);
    if (this.samples) {
      // Nothing to approve: the benchmark reads what Mynt's checks recorded.
      await this.update(id, { status: "awaiting_approval", step: null, phase_message: "The sample passed the checks it was put through" });
      await this.log(id, null, "sample_passed", {});
      return;
    }
    if (r.action === "upgrade") {
      const executesAt = new Date(Date.now() + this.config.timelockHours * 3600_000);
      await this.update(id, { status: "awaiting_approval", step: null, executes_at: executesAt, announced_at: new Date(), phase_message: `Gates passed; awaiting an admin's approval. The upgrade can run from ${executesAt.toISOString()}` });
      if (r.entity_id)
        await emitFirmEvent(
          this.store,
          r.entity_id as string,
          "program.upgrade_scheduled",
          { program_id: r.program_id, review_id: id, build_id: r.build_id, verifiable_hash: r.sha256, executes_at: executesAt.toISOString(), timelock_hours: this.config.timelockHours, needs_admin_approval: true },
          false,
        );
      await this.log(id, null, "gates_passed", { announced: true, executes_at: executesAt.toISOString() });
    } else {
      await this.update(id, { status: "awaiting_approval", step: null, phase_message: "Gates passed; awaiting an admin's approval" });
      await this.log(id, null, "gates_passed", {});
    }
  }

  // Approved upgrades whose timelock is over: Mynt starts them, as the developer who asked.
  private async runDueUpgrades() {
    // The deploy claims the approval itself (atomically); a failed start is retried no more than every 10 minutes.
    const due = await this.all(
      `SELECT * FROM ${T}.solana_mainnet_reviews WHERE status = 'approved' AND action = 'upgrade' AND executes_at <= now()
         AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '10 minutes') ORDER BY executes_at LIMIT 5`,
    );
    for (const r of due) {
      const id = r.id as string;
      await this.update(id, { last_attempt_at: new Date() });
      try {
        const p = await this.solana.get(r.program_id as string);
        const user = await this.store.getUser(r.requested_by as string);
        if (!p || !user) throw new Error("The program or the developer who asked is gone");
        await this.solana.deploy(user, p, r.build_id as string, "upgrade");
        await this.update(id, { phase_message: "Timelock over; the upgrade is running (get_program follows it)" });
        await this.log(id, null, "upgrade_started", {});
      } catch (e) {
        // Not started: still approved, retried later, the reason shown.
        await this.update(id, { error: `The upgrade couldn't start: ${(e as Error).message}`.slice(0, 1000) });
        await this.log(id, null, "upgrade_not_started", { error: (e as Error).message.slice(0, 500) });
      }
    }
  }

  // ---- the vulnerability database: re-checks, flags and proposals ----

  async openFlag(programUuid: string) {
    return this.one(`SELECT id, db_version FROM ${T}.solana_program_flags WHERE program = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1`, [programUuid]);
  }

  // A new database version: every deployed mainnet program is checked again against its hard rules. One that fails
  // is flagged to its firm (program.review_flagged) and to admins (list_program_flags, ops_status), and its upgrades
  // wait for an admin's review. Nothing is taken down: the program keeps running.
  async recheckDeployed() {
    const done = Number((await this.one(`SELECT value FROM ${T}.solana_settings WHERE key = 'vuln_db_version'`))?.value ?? 0);
    const version = this.vulnDb.version;
    if (done >= version) return { rechecked: 0, flagged: 0 };
    let rechecked = 0;
    let flagged = 0;
    for (const p of (await this.solana.list(null)).filter((x) => x.cluster === "mainnet" && x.status === "deployed" && x.build_id)) {
      rechecked++;
      let result: ReturnType<typeof checkProgramRules> | null = null;
      let why: string | null = null;
      try {
        const m = await this.solana.reviewMaterial(null, p, p.build_id!);
        const compiled = this.compiledFiles(m);
        result = checkProgramRules(
          {
            name: m.name,
            program_id: p.program_id,
            program: m.program,
            idl: m.idl && verifyIdl(m.idl, m.program).verified ? m.idl : null,
            sources: m.sources,
            mynt_signer: (await this.solana.mainnetSigner())?.address ?? null,
            compiled_files: compiled.problems.length ? null : compiled.rulesFiles,
            listed_files: compiled.listedFiles,
          },
          this.vulnDb,
        );
      } catch (e) {
        why = `Mynt couldn't re-check it: ${(e as Error).message}`;
      }
      if (result?.passed) continue;
      const blocking = result ? result.findings.filter((f) => f.blocks) : [{ rule: "RECHECK-FAILED", detail: why }];
      if (await this.one(`SELECT 1 FROM ${T}.solana_program_flags WHERE program = $1 AND db_version = $2`, [p.id, version])) continue;
      const id = randomUUID();
      await this.db.query(
        `INSERT INTO ${T}.solana_program_flags (id, program, program_id, entity_id, db_version, verifiable_hash, findings) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, p.id, p.program_id, p.entity_id, version, p.verifiable_hash, JSON.stringify(blocking)],
      );
      flagged++;
      await this.store.audit(null, "program_review_flagged", p.program_id, { flag_id: id, db_version: version, rules: blocking.map((f) => f.rule) });
      if (p.entity_id)
        await emitFirmEvent(
          this.store,
          p.entity_id,
          "program.review_flagged",
          {
            program_id: p.program_id,
            flag_id: id,
            db_version: version,
            verifiable_hash: p.verifiable_hash,
            findings: blocking.map((f) => ({ rule: f.rule, detail: f.detail })),
            upgrades_paused: true,
            program_running: true,
          },
          false,
        );
    }
    await this.db.query(
      `INSERT INTO ${T}.solana_settings (key, value) VALUES ('vuln_db_version', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(version)],
    );
    return { rechecked, flagged };
  }

  async flags(status?: string) {
    return this.all(`SELECT * FROM ${T}.solana_program_flags WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 200`, [status ?? null]);
  }

  async resolveFlag(admin: User, id: string, note: string) {
    const r = await this.db.query(
      `UPDATE ${T}.solana_program_flags SET status = 'reviewed', resolution_note = $2, resolved_by = $3, resolved_at = now() WHERE id::text = $1 AND status = 'open' RETURNING *`,
      [id, note, admin.id],
    );
    const f = r.rows[0] as Row | undefined;
    if (!f) throw new GateError("No open flag with that id");
    await this.store.audit(admin.id, "resolve_program_flag", f.program_id as string, { flag_id: id, db_version: f.db_version, note });
    return f;
  }

  async propose(user: User, entry: unknown, rationale: string) {
    const problems = entryProblems(entry, new Set(this.vulnDb.entries.map((e) => e.id)));
    if (problems.length) throw new GateError(`The entry isn't valid: ${problems.join("; ")}`);
    const id = randomUUID();
    await this.db.query(`INSERT INTO ${T}.solana_vuln_rule_proposals (id, entry, rationale, proposed_by) VALUES ($1, $2, $3, $4)`, [id, JSON.stringify(entry), rationale, user.id]);
    await this.store.audit(user.id, "propose_vulnerability_rule", (entry as { id: string }).id, { proposal_id: id });
    return { proposal_id: id, status: "proposed", next: "A maintainer adds it to schemas/solana-vulnerabilities.json with its bad and good fixtures in a pull request; the database only changes after that review." };
  }

  async proposals() {
    return this.all(`SELECT id, entry, rationale, proposed_by, status, created_at FROM ${T}.solana_vuln_rule_proposals ORDER BY created_at DESC LIMIT 200`);
  }

  // Approved reviews whose program now holds exactly the reviewed bytes.
  // Started reviews, settled from the registry: the program holds the reviewed bytes (executed); the attempt ended
  // with nothing changed (the approval is given back, to retry); or the program now holds something else (failed:
  // a new review is needed).
  private async markExecuted() {
    await this.db.query(
      `UPDATE ${T}.solana_mainnet_reviews r SET status = 'executed', executed_at = now(), updated_at = now(), error = NULL, phase_message = 'Deployed on mainnet'
       FROM ${T}.solana_programs p WHERE r.program = p.id AND r.status = 'started' AND p.status = 'deployed' AND p.verifiable_hash = r.sha256 AND p.operation IS NULL`,
    );
    const ended = await this.all(
      `SELECT r.id, r.claimed_hash, p.verifiable_hash, p.error FROM ${T}.solana_mainnet_reviews r JOIN ${T}.solana_programs p ON p.id = r.program
       WHERE r.status = 'started' AND p.operation IS NULL AND p.verifiable_hash IS DISTINCT FROM r.sha256 AND r.started_at < now() - interval '2 minutes'`,
    );
    for (const x of ended) {
      if (x.verifiable_hash === x.claimed_hash || (x.verifiable_hash == null && x.claimed_hash == null)) {
        await this.db.query(
          `UPDATE ${T}.solana_mainnet_reviews SET status = 'approved', started_at = NULL, claimed_hash = NULL, error = $2, updated_at = now(), phase_message = 'Approved; the last attempt didn''t complete'
           WHERE id = $1 AND status = 'started'`,
          [x.id, `The last attempt didn't complete${x.error ? `: ${String(x.error).slice(0, 500)}` : ""}`],
        );
        await this.log(x.id as string, null, "released", { why: "the deploy or upgrade ended without changing the program" });
      } else {
        await this.db.query(
          `UPDATE ${T}.solana_mainnet_reviews SET status = 'failed', error = $2, updated_at = now(), phase_message = 'Failed' WHERE id = $1 AND status = 'started'`,
          [x.id, `The program now holds another build (${x.verifiable_hash}); request a new review`],
        );
        await this.log(x.id as string, null, "failed", { program_hash: x.verifiable_hash });
      }
    }
  }


  private async writeFiles(sandbox: string, files: Record<string, string>) {
    if (this.sandboxes!.writeFiles) await this.sandboxes!.writeFiles(sandbox, files);
    else for (const [path, content] of Object.entries(files)) await this.sandboxes!.writeFile(sandbox, path, content);
  }

  // A PoC directory's text files (no links, nothing under node_modules), within Mynt's limits.
  private async readPoc(sandbox: string, dir: string): Promise<Record<string, string> | null> {
    const listed = await this.sandboxes!.exec(sandbox, `cd ${dir} 2>/dev/null && find . -path ./node_modules -prune -o -type f -size -${MAX_POC_FILE_BYTES / 1024}k -print | head -${MAX_POC_FILES}`, { timeoutSeconds: 60 });
    if (listed.exitCode !== 0) return null;
    const out: Record<string, string> = {};
    for (const line of listed.stdout.split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean)) {
      if (!/^[A-Za-z0-9_.\/-]+$/.test(line) || line.split("/").includes("..")) continue;
      const text = await this.sandboxes!.readFile(sandbox, `${dir}/${line}`);
      if (text != null && !text.includes("\u0000")) out[line] = text;
    }
    return out;
  }

  startWorker(intervalMs = Number(process.env.PROGRAM_GATE_POLL_MS ?? 15000)) {
    if (this.timer || !this.enabled) return;
    this.timer = serialLoop(() => this.tick(), intervalMs, "mainnet program gate");
  }

  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const attempt = async (f: () => Promise<unknown>) => {
  try {
    return json(await f());
  } catch (e) {
    return fail((e as Error).message);
  }
};
const ADDRESS = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "a Solana address (base58)");

export function registerMainnetGateTools(server: McpServer, store: Store, user: User, gate: MainnetGateService, solana: SolanaService, o: { admin: boolean }) {
  // A review the caller may see: of a program they (or their firm) own, or any, for an admin.
  const visible = async (reviewId: string) => {
    const r = await gate.row(reviewId);
    if (!r) return null;
    if (o.admin) return r;
    const p = await solana.get(r.program_id as string);
    return p && solana.canAct(user, p) ? r : null;
  };

  server.registerTool(
    "request_mainnet_review",
    {
      title: "Request a mainnet program review",
      description:
        "Developer: start the mainnet program gate for one of your mainnet programs and a succeeded build. Every mainnet deploy and upgrade needs one, for exactly that build's program. Mynt first applies its hard rules (no value-moving program: no token or Associated Token CPIs and no system transfers; no hidden admin: no hard-coded admin key, authority moved to a non-signer, or close paying a non-signer; the upgrade authority stays Mynt's mainnet signer); then static analysis (cargo-audit, Radar) and an independent program-audit agent on the source; then a red-team agent that gets only the program's bytes and IDL and must prove each attack with a script Mynt re-runs itself. Then an admin approves. An upgrade is also announced to your firm's webhooks (program.upgrade_scheduled) and runs only after its timelock. Follow it with get_mainnet_review.",
      inputSchema: { program_id: ADDRESS, build_id: z.string().describe("A succeeded build whose verification built this program") },
    },
    async ({ program_id, build_id }) => attempt(async () => gate.view(await gate.request(user, program_id, build_id))),
  );

  server.registerTool(
    "get_mainnet_review",
    {
      title: "A mainnet program review",
      description:
        "Developer: a mainnet review's status and step, every check's result (hard rules with the signals they used and their limits, static analysis, the audit agent's findings as Mynt verified them, the red team's findings and Mynt's re-run of each proof of concept), the cost, the decision, an upgrade's timelock, and its audit log. Give review_id, or program_id for its latest review.",
      inputSchema: { review_id: z.string().optional(), program_id: ADDRESS.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ review_id, program_id }) =>
      attempt(async () => {
        let id = review_id;
        if (!id && program_id) id = (await gate.list({ program: program_id }))[0]?.id as string | undefined;
        const r = id ? await visible(id) : null;
        if (!r) throw new GateError("No such mainnet review of yours");
        return gate.view(r, { log: true });
      }),
  );

  server.registerTool(
    "cancel_mainnet_review",
    {
      title: "Cancel a mainnet program review",
      description: "Developer (or admin): cancel a mainnet review that is running, awaiting approval, or approved but not yet started, including a scheduled upgrade during its timelock. The firm's webhooks hear of a cancelled upgrade (program.upgrade_cancelled).",
      inputSchema: { review_id: z.string() },
    },
    async ({ review_id }) =>
      attempt(async () => {
        if (!(await visible(review_id))) throw new GateError("No such mainnet review of yours");
        return gate.view(await gate.cancel(user, review_id, o.admin));
      }),
  );

  if (!o.admin) return;

  server.registerTool(
    "list_vulnerability_rules",
    {
      title: "The Solana vulnerability database",
      description:
        "Admin: Mynt's Solana vulnerability database (schemas/solana-vulnerabilities.json), which drives the mainnet program gate's hard rules and is the audit and red-team agents' checklist: its version and every entry (id, title, severity, category, whether it blocks or flags, detections, references), plus the proposals waiting for review.",
      inputSchema: { category: z.enum(VULN_CATEGORIES).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ category }) =>
      json({
        version: gate.vulnDb.version,
        updated: gate.vulnDb.updated,
        entries: gate.vulnDb.entries.filter((e) => !category || e.category === category).map(({ fixtures: _f, ...e }) => ({ ...e, detection: e.detection.map((d) => d.type + ("builtin" in d ? `:${d.builtin}` : "")) })),
        proposals: await gate.proposals(),
      }),
  );

  server.registerTool(
    "propose_vulnerability_rule",
    {
      title: "Propose a vulnerability database entry",
      description:
        "Admin: propose a new entry for the Solana vulnerability database (the same shape as list_vulnerability_rules' entries, with detection, references and fixture paths). Mynt checks its shape and stores it as a proposal; the database itself changes only when a pull request adds the entry with its bad and good fixtures, so every rule is reviewed and tested.",
      inputSchema: { entry: z.record(z.string(), z.unknown()).describe("The proposed entry"), rationale: z.string().min(10).max(4000) },
    },
    async ({ entry, rationale }) => attempt(() => gate.propose(user, entry, rationale)),
  );

  server.registerTool(
    "list_program_flags",
    {
      title: "Deployed programs flagged by the vulnerability database",
      description: "Admin: mainnet programs a newer vulnerability database version refuses. Each keeps running; its upgrades wait until an admin reviews it with resolve_program_flag.",
      inputSchema: { status: z.enum(["open", "reviewed"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json(await gate.flags(status)),
  );

  server.registerTool(
    "resolve_program_flag",
    {
      title: "Review a flagged program",
      description: "Admin: record that you reviewed a flagged mainnet program (say what you found and what the firm will do). Its upgrades can go through the mainnet program gate again. Recorded in the audit log.",
      inputSchema: { flag_id: z.string(), note: z.string().min(10).max(2000) },
    },
    async ({ flag_id, note }) => attempt(() => gate.resolveFlag(user, flag_id, note)),
  );

  server.registerTool(
    "list_mainnet_reviews",
    {
      title: "Mainnet program reviews",
      description: "Admin: every mainnet program review, newest first, with its status; awaiting_approval ones wait for approve_mainnet_program or reject_mainnet_program.",
      inputSchema: { status: z.enum(REVIEW_STATUSES).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) =>
      json(
        await Promise.all(
          (await gate.list({ status })).map(async (r) => {
            const v = await gate.view(r);
            return { review_id: v.review_id, program_id: v.program_id, action: v.action, status: v.status, step: v.step, blocked_reason: v.blocked_reason, cost_usd: v.cost_usd, timelock: v.timelock, created_at: v.created_at };
          }),
        ),
      ),
  );

  server.registerTool(
    "approve_mainnet_program",
    {
      title: "Approve a mainnet program",
      description:
        "Admin: approve a mainnet deploy or upgrade whose automated gates all passed. Name every exception the review lists in allow_exceptions (what can change the build beyond the reviewed source, and crates off the allowlist); approval is refused otherwise. The answer shows the whole report again, with what the gate can't promise. The approval is used once: a first deploy may then go ahead with deploy_program for exactly that build within MAINNET_APPROVAL_TTL_DAYS (default 14); an upgrade runs once its timelock ends. Recorded in the audit log.",
      inputSchema: {
        review_id: z.string(),
        note: z.string().min(3).max(2000).describe("Why it's approved, for the audit log"),
        allow_exceptions: z
          .array(z.string())
          .max(200)
          .optional()
          .describe("The id of every exception the review lists (build scripts, proc macros, cargo config, non-Rust includes, crates off the allowlist...), each one you allow; approval is refused unless all are named"),
      },
    },
    async ({ review_id, note, allow_exceptions }) => attempt(async () => gate.view(await gate.decide(user, review_id, "approve", note, allow_exceptions ?? []), { log: true })),
  );

  server.registerTool(
    "reject_mainnet_program",
    {
      title: "Reject a mainnet program",
      description: "Admin: reject a mainnet deploy or upgrade awaiting approval. A scheduled upgrade is cancelled and the firm's webhooks hear of it. Recorded in the audit log.",
      inputSchema: { review_id: z.string(), note: z.string().min(3).max(2000) },
    },
    async ({ review_id, note }) => attempt(async () => gate.view(await gate.decide(user, review_id, "reject", note))),
  );
  void store;
}
