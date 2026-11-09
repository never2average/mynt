import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentMeter } from "../agent-meter.js";
import type { AgentRun } from "../agent-proxy.js";
import { agentState, launchAgent, workspaceCwd, type AgentHostConfig } from "../agent-host.js";
import type { BoatClient } from "../boat.js";
import type { Db } from "../db.js";
import { emitFirmEvent } from "../runtime.js";
import type { Store, User } from "../store.js";
import { defaultGraceMs, failureMessage, GraceTracker } from "../transient.js";
import { serialLoop } from "../worker.js";
import { GATE_ANALYSIS_SCRIPT, GATE_CONFIRM_SCRIPT, GATE_TOOLS } from "./gate-scripts.js";
import { checkProgramRules, upgradeAuthorityRule, type RuleFinding } from "./program-rules.js";
import type { MainnetGateCheck, MainnetGateClaim, ProgramRecord, SolanaService } from "./service.js";
import { SOLANA_TOOLCHAIN_SCRIPT } from "./toolchain.js";
import { agentChecklist, entryProblems, loadCrateAllowlist, loadVulnDb, VULN_CATEGORIES, type CrateAllowlist, type VulnDb } from "./vuln-db.js";
import { crossCheck, dependencyVerdict, evaluateDepInfo, resolveCrateTree, stripIdlDocs, verifyIdl, workspaceExceptions, type DepInfoCapture, type Exception } from "./crate-tree.js";
import { runDetections } from "./program-rules.js";

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
    cargoAuditIgnore: (env.PROGRAM_GATE_CARGO_AUDIT_IGNORE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^RUSTSEC-\d{4}-\d{4}$/.test(s)),
  };
}

const T = "financial_products";
const TABLES = `
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
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS budget_key text;
  ALTER TABLE ${T}.solana_mainnet_reviews ADD COLUMN IF NOT EXISTS budget_settled boolean NOT NULL DEFAULT false;
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

// started: a deploy or upgrade claimed (consumed) the approval; executed: the program holds exactly the reviewed bytes.
export const REVIEW_STATUSES = ["running", "awaiting_approval", "approved", "started", "executed", "blocked", "rejected", "cancelled", "failed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
// Reviews that still hold the program: a new one waits until these end.
const OPEN: ReviewStatus[] = ["running", "awaiting_approval", "approved", "started"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITIES)[number];
const BLOCKING: Severity[] = ["critical", "high"];

const GATE_DIR = "/home/user/mynt-gate";
const CONFIRM_DIR = "/home/user/mynt-confirm";
const AUDIT_WS = "program-audit";
const RED_WS = "program-red-team";
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
const JSON_COLS = new Set(["rules", "static_analysis", "audit", "red_team", "confirmations", "exceptions", "allowed_exceptions", "dependencies", "idl_check"]);

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

export function parseRedTeam(raw: string | null) {
  const parsed = parse<{ findings?: Row[]; summary?: unknown; attacks_tried?: unknown }>(raw);
  if (!parsed || !Array.isArray(parsed.findings)) return null;
  const findings: RedTeamFinding[] = parsed.findings.slice(0, 50).map((f, i) => ({
    id: typeof f.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(f.id) ? f.id : `R${i + 1}`,
    title: String(f.title ?? "").slice(0, 300),
    severity: (SEVERITIES as readonly string[]).includes(String(f.severity).toLowerCase()) ? (String(f.severity).toLowerCase() as Severity) : "info",
    category: String(f.category ?? "").slice(0, 60),
    description: String(f.description ?? "").slice(0, 3000),
    poc: typeof f.poc === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(f.poc.replace(/^poc\//, "")) ? f.poc.replace(/^poc\//, "") : null,
  }));
  return {
    findings,
    summary: typeof parsed.summary === "string" ? parsed.summary.slice(0, 3000) : null,
    attacks_tried: Array.isArray(parsed.attacks_tried) ? parsed.attacks_tried.filter((x) => typeof x === "string").slice(0, 40).map((x) => (x as string).slice(0, 300)) : [],
  };
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
    readonly boat: BoatClient | null,
    readonly config: GateConfig,
  ) {}

  // The vulnerability database the hard rules and the agents' checklist come from (tests swap in another version).
  vulnDb: VulnDb = loadVulnDb();

  static async open(db: Db, store: Store, solana: SolanaService, boat: BoatClient | null, config: GateConfig) {
    await db.exec(TABLES);
    const gate = new MainnetGateService(db, store, solana, boat, config);
    solana.gate = gate;
    return gate;
  }

  // Sandboxes, the agents' model backend and a public URL for their proxy: without all three no review can run,
  // and so (fail closed) no mainnet deploy or upgrade can happen.
  get enabled() {
    return !!this.boat && !!this.config.agentBackend && !!this.config.publicUrl;
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
    if (!this.enabled) throw new GateError("The mainnet program gate isn't available on this Mynt (it needs sandboxes, the agents' model backend and PUBLIC_URL), so mainnet deploys can't be reviewed");
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
      { name: m.name, program_id: p.program_id, program: m.program, idl, sources: m.sources, mynt_signer: signer?.address ?? null, compiled_files: compiled.rulesFiles },
      this.vulnDb,
    );
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
      `UPDATE ${T}.solana_mainnet_reviews SET budget_settled = true WHERE id = $1 AND budget_settled = false AND budget_key IS NOT NULL RETURNING budget_key, audit_cap_usd, red_cap_usd, cost_usd`,
      [id],
    );
    if (r) await this.release(r.budget_key as string, Math.max(0, Number(r.audit_cap_usd) + Number(r.red_cap_usd) - Number(r.cost_usd)));
  }

  // ---- decisions ----

  async decide(admin: User, id: string, decision: "approve" | "reject", note: string, allowExceptions: string[] = []) {
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
      { name: m.name, program_id: p.program_id, program: m.program, idl, sources: m.sources, mynt_signer: (await this.solana.mainnetSigner())?.address ?? null, compiled_files: compiled.rulesFiles },
      this.vulnDb,
    );
    if (!now.passed)
      throw new GateError(
        `The vulnerability database's current rules (v${now.db_version}) refuse this program: ${now.findings
          .filter((f) => f.blocks)
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
    const r = await this.one(`SELECT id, red_cap_usd FROM ${T}.solana_mainnet_reviews WHERE red_token_hash = $1 AND status = 'running'`, [h]);
    return r ? { key: `program-red-team:${r.id}`, capUsd: Number(r.red_cap_usd), model: this.config.gateModel } : null;
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
    await this.recheckDeployed();
    await this.runDueUpgrades();
    await this.markExecuted();
  }

  private async stopSandboxes(r: Row) {
    if (!this.boat) return;
    for (const id of [r.analysis_sandbox_id, r.red_sandbox_id, r.confirm_sandbox_id]) if (id) await this.boat.stop(id as string).catch(() => {});
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
    const boat = this.boat!;
    let c = 0;
    for (const id of [r.analysis_sandbox_id, r.red_sandbox_id, r.confirm_sandbox_id]) if (id) c += await boat.costDollars(id as string).catch(() => 0);
    if (this.meter) c += (await this.meter.spent(`program-audit:${r.id}`)) + (await this.meter.spent(`program-red-team:${r.id}`));
    if (c !== Number(r.cost_usd)) await this.update(r.id as string, { cost_usd: c });
    return c;
  }

  private async sandboxReady(id: string) {
    const s = await this.boat!.getSandbox(id);
    if (s.state === "error" || s.state === "cancelled") throw new Error(`Sandbox ${s.state}`);
    return ["ready", "idle", "running"].includes(s.state);
  }

  private async material(r: Row) {
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
    return { ...compiled, rulesFiles, buildTimeCode };
  }

  // The IDL the agents and the PoC re-run get: only one Mynt checked against the bytes, without doc strings.
  private agentIdl(r: Row, m: { idl: unknown }) {
    return (r.idl_check as { verified?: boolean } | null)?.verified ? stripIdlDocs(m.idl) : null;
  }

  private async newSandbox(r: Row, role: string) {
    return this.boat!.createSandbox({ name: `mynt-${role}-${r.id}`, type: this.config.sandboxType, ttlSeconds: 3 * 3600, labels: { mynt_mainnet_review: r.id as string, mynt_role: role }, env: {} });
  }

  private minutes(r: Row) {
    return r.step_started_at ? (Date.now() - Date.parse(new Date(r.step_started_at as string).toISOString())) / 60_000 : 0;
  }

  private async advance(r: Row) {
    const boat = this.boat!;
    const id = r.id as string;
    await this.cost(r);

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
      const run = await boat.exec(r.analysis_sandbox_id as string, `bash ${GATE_DIR}/analysis.sh ${GATE_DIR}/src ${GATE_DIR}/out '${this.config.cargoAuditIgnore.join(",")}'`, { detached: true });
      await this.update(id, { step: "analysis", analysis_process_id: String(run.processId ?? ""), step_started_at: new Date(), phase_message: "Static analysis: cargo-audit and Radar" });
      await this.log(id, null, "analysis_started", { tools: { cargo_audit: GATE_TOOLS.cargoAudit.version, radar: GATE_TOOLS.radar.commit } });
      return;
    }

    if (r.step === "analysis") {
      const timedOut = this.minutes(r) > this.config.analysisMinutes;
      if (!timedOut && (await boat.commandStatus(r.analysis_sandbox_id as string, Number(r.analysis_process_id))).running) return;
      const report = parse<{ tools?: StaticTool[] }>(await boat.readFile(r.analysis_sandbox_id as string, `${GATE_DIR}/out/static.json`));
      const verdict = assessStatic(report);
      const record = { passed: verdict.passed, reasons: verdict.reasons, tools: verdict.tools, ...(timedOut ? { timed_out: true } : {}) };
      await this.update(id, { static_analysis: record });
      await this.log(id, null, verdict.passed ? "analysis_passed" : "analysis_blocked", { reasons: verdict.reasons });
      if (timedOut && !report) return this.block(r, `Static analysis didn't finish within ${this.config.analysisMinutes} minutes`);
      if (!verdict.passed) return this.block(r, `Static analysis: ${verdict.reasons.join("; ")}`);
      // 2b. The program-audit agent, in the same sandbox, after Mynt has the tools' results.
      const token = `mynt_paudit_${randomBytes(24).toString("base64url")}`;
      await this.update(id, { audit_token_hash: hash(token) });
      const { p, m } = await this.material(r);
      const pid = await launchAgent(boat, this.config, r.analysis_sandbox_id as string, {
        prompt: "Audit the Solana program described in job/review.json, following CLAUDE.md and its skills. Write job/findings.json and run scripts/check_findings.py until it passes.",
        budgetUsd: Number(r.audit_cap_usd),
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
              deterministic_rules: (r.rules as Row | null) ?? null,
              static_analysis: record,
              idl: this.agentIdl(r, m),
              dependency_dirs: Object.fromEntries(Object.keys(m.deps?.sources ?? {}).filter((k) => ((r.exceptions as Exception[] | null) ?? []).some((e) => e.id === `crate:${k}`)).map((k) => [k, `${GATE_DIR}/deps/${k}`])),
              output: "job/findings.json",
              minutes: this.config.auditMinutes,
            },
            null,
            1,
          ),
        },
      });
      await this.update(id, { step: "audit", audit_process_id: pid, audit_started_at: new Date(), step_started_at: new Date(), phase_message: "The program-audit agent is reading the source" });
      await this.log(id, null, "audit_started", { model: this.config.gateModel, cap_usd: Number(r.audit_cap_usd) });
      return;
    }

    if (r.step === "audit") {
      const agent = await agentState(boat, r.analysis_sandbox_id as string, r.audit_process_id as string);
      const timedOut = agent.running && this.minutes(r) > this.config.auditMinutes;
      if (agent.running && !timedOut) return;
      const raw = await boat.readFile(r.analysis_sandbox_id as string, `${workspaceCwd(AUDIT_WS)}/job/findings.json`);
      const { m } = await this.material(r);
      const a = assessAudit(raw, m.sources ?? {});
      const audit = {
        finished: a.finished && agent.ok && !timedOut,
        agent: { result: timedOut ? `timed out after ${this.config.auditMinutes} min` : (agent.state?.last_subtype ?? null), summary: a.summary ?? agent.state?.summary?.slice(0, 1500) ?? null },
        findings: a.findings,
        blocking: a.blocking.map((f) => f.id),
      };
      await boat.stop(r.analysis_sandbox_id as string).catch(() => {});
      await this.update(id, { audit, audit_token_hash: null });
      await this.log(id, null, "audit_finished", { finished: audit.finished, findings: a.findings.length, blocking: a.blocking.length });
      if (!audit.finished) return this.block(r, `No complete independent audit (the program-audit agent: ${audit.agent.result ?? "no result"}${a.finished ? "" : ", no valid findings.json"}); a mainnet program can't pass without one`);
      if (a.blocking.length) return this.block(r, `Audit: ${a.blocking.length} verified critical/high finding(s): ${a.blocking.slice(0, 5).map((f) => `${f.severity} ${f.title} (${f.file}${f.line ? `:${f.line}` : ""})`).join("; ")}`);
      // 3. The red team, in a sandbox of its own.
      const s = await this.newSandbox(r, "program-red-team");
      await this.update(id, { step: "red_provisioning", red_sandbox_id: s.id, step_started_at: new Date(), phase_message: "Starting the red team's sandbox" });
      return;
    }

    if (r.step === "red_provisioning") {
      if (!(await this.sandboxReady(r.red_sandbox_id as string))) return;
      const { p, m } = await this.material(r);
      const sb = r.red_sandbox_id as string;
      const job = `${workspaceCwd(RED_WS)}/job`;
      // The bytes Mynt stored and the IDL; nothing of the source.
      await this.writeFiles(sb, { [`${job}/program.so.b64`]: Buffer.from(m.program).toString("base64"), "/home/user/mynt-solana-toolchain.sh": SOLANA_TOOLCHAIN_SCRIPT });
      const decoded = await boat.exec(sb, `base64 -d ${job}/program.so.b64 > ${job}/program.so && rm ${job}/program.so.b64 && sha256sum ${job}/program.so`, { timeoutSeconds: 120 });
      if (decoded.exitCode !== 0) throw new Error("Couldn't place the program in the red team's sandbox");
      await boat.exec(sb, "bash /home/user/mynt-solana-toolchain.sh > /home/user/.mynt-solana-install.log 2>&1", { detached: true });
      const token = `mynt_predteam_${randomBytes(24).toString("base64url")}`;
      await this.update(id, { red_token_hash: hash(token) });
      const pid = await launchAgent(boat, this.config, sb, {
        prompt: "Attack the Solana program described in job/target.json, following CLAUDE.md and its skills. Write job/report.json and a runnable proof of concept for every finding, and run scripts/check_report.py until it passes.",
        budgetUsd: Number(r.red_cap_usd),
        token,
        model: this.config.gateModel,
        workspace: RED_WS,
        jobFiles: {
          "job/idl.json": JSON.stringify(this.agentIdl(r, m), null, 1),
          "job/vulnerabilities.json": JSON.stringify(agentChecklist(this.vulnDb), null, 1),
          "job/target.json": JSON.stringify(
            {
              program_id: p.program_id,
              name: m.name,
              sha256: m.sha256,
              program_so: "job/program.so",
              idl: "job/idl.json",
              toolchain_env: "~/.mynt-solana/env",
              toolchain_log: "/home/user/.mynt-solana-install.log",
              output: "job/report.json",
              poc_dir: "job/poc",
              minutes: this.config.redTeamMinutes,
            },
            null,
            1,
          ),
        },
      });
      await this.update(id, { step: "red_team", red_process_id: pid, red_started_at: new Date(), step_started_at: new Date(), phase_message: "The red team is attacking the program on a local validator" });
      await this.log(id, null, "red_team_started", { model: this.config.gateModel, cap_usd: Number(r.red_cap_usd) });
      return;
    }

    if (r.step === "red_team") {
      const sb = r.red_sandbox_id as string;
      const agent = await agentState(boat, sb, r.red_process_id as string);
      const timedOut = agent.running && this.minutes(r) > this.config.redTeamMinutes;
      if (agent.running && !timedOut) return;
      const job = `${workspaceCwd(RED_WS)}/job`;
      const report = parseRedTeam(await boat.readFile(sb, `${job}/report.json`));
      const finished = !!report && agent.ok && !timedOut;
      // Every PoC the report names, read back as text, for Mynt to run itself.
      const pocs: Record<string, Record<string, string>> = {};
      for (const f of report?.findings ?? []) {
        if (!f.poc || pocs[f.poc] || Object.keys(pocs).length >= MAX_POCS) continue;
        const files = await this.readPoc(sb, `${job}/poc/${f.poc}`);
        if (files && files["run.sh"]) pocs[f.poc] = files;
      }
      const red = {
        finished,
        agent: { result: timedOut ? `timed out after ${this.config.redTeamMinutes} min` : (agent.state?.last_subtype ?? null), summary: report?.summary ?? agent.state?.summary?.slice(0, 1500) ?? null },
        attacks_tried: report?.attacks_tried ?? [],
        findings: (report?.findings ?? []).map((f) => ({ ...f, poc: f.poc && pocs[f.poc] ? f.poc : null, poc_files: f.poc && pocs[f.poc] ? Object.keys(pocs[f.poc]) : [] })),
      };
      await boat.stop(sb).catch(() => {});
      await this.update(id, { red_team: { ...red, pocs }, red_token_hash: null });
      await this.log(id, null, "red_team_finished", { finished, findings: red.findings.length, pocs: Object.keys(pocs).length });
      if (!finished) return this.block(r, `No complete red-team result (${red.agent.result ?? "no result"}${report ? "" : ", no valid report.json"}); a mainnet program can't pass without one`);
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
      const run = await boat.exec(
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
      if (!timedOut && (await boat.commandStatus(sb, Number(r.confirm_process_id))).running) return;
      const out = parse<{ results?: Record<string, { confirmed?: boolean; reason?: string; error?: boolean }> }>(await boat.readFile(sb, `${CONFIRM_DIR}/results.json`));
      await boat.stop(sb).catch(() => {});
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
    if (this.boat!.writeFiles) await this.boat!.writeFiles(sandbox, files);
    else for (const [path, content] of Object.entries(files)) await this.boat!.writeFile(sandbox, path, content);
  }

  // A PoC directory's text files (no links, nothing under node_modules), within Mynt's limits.
  private async readPoc(sandbox: string, dir: string): Promise<Record<string, string> | null> {
    const listed = await this.boat!.exec(sandbox, `cd ${dir} 2>/dev/null && find . -path ./node_modules -prune -o -type f -size -${MAX_POC_FILE_BYTES / 1024}k -print | head -${MAX_POC_FILES}`, { timeoutSeconds: 60 });
    if (listed.exitCode !== 0) return null;
    const out: Record<string, string> = {};
    for (const line of listed.stdout.split("\n").map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean)) {
      if (!/^[A-Za-z0-9_.\/-]+$/.test(line) || line.split("/").includes("..")) continue;
      const text = await this.boat!.readFile(sandbox, `${dir}/${line}`);
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
