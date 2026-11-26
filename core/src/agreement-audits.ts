import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  AGREEMENT_AUDIT_STATUSES,
  AUDIT_CADENCES,
  AUDIT_REQUIREMENT_KINDS,
  FINDING_SEVERITIES,
  OPEN_AUDIT_STATUSES,
} from "./agreement-audits-schema.js";
import { noticeFirm } from "./firm-notices.js";
import type { FirmWebhookEvent } from "./runtime.js";
import { effectiveRoles, type App, type Store, type User } from "./store.js";
import { appRole, memberApp } from "./workspaces.js";

// Oversight audits under an app's agreements (app-agreements.ts). A program agreement says which audits its sponsor,
// the licence provider, runs on the app: an annual compliance review, a quarterly complaints review, a review of the
// marketing material on each change. Each is a requirement on the agreement (1:n), and each requirement has audits over
// time (1:n), one open at a time: due on a date, opened, evidence submitted by the app's side, findings recorded by the
// licence provider and answered by the app's side, then passed, failed or waived.
//
// - The licence provider's members (of the agreement's counterparty firm) add and retire requirements, from the
//   proposal on (so they can come with the sponsor's terms), and open, pass, fail or waive audits and record findings.
// - The app's workspace owners and admins submit evidence (https links with their SHA-256: Mynt stores no files) and
//   answer findings. Any member of the workspace reads them.
// - Only the agreement's two parties read its audits.
// - The scheduler (sweepAgreementAudits, on a timer and after each change) opens the next audit of each requirement of
//   a signed agreement: for a cadence, when the previous one is closed and the next due date's window opens; once,
//   at its first due date's window; on_change, when the app's builds give it new verified source (Mynt can't tell
//   which files customers see, so every new verified source counts as a change), or by hand.
// - An audit past its due date and not closed is overdue: it's flagged on the app (get_workspace_attention), in
//   ops_status, and in the lists here.
// Every change is audited in the obligations class (with the app's id), and the other side is told on its firm's
// webhooks and notices (agreement_audit.opened / submitted / closed).

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

type Row = Record<string, unknown>;
type Cadence = (typeof AUDIT_CADENCES)[number];
type Status = (typeof AGREEMENT_AUDIT_STATUSES)[number];
const OPEN: readonly string[] = OPEN_AUDIT_STATUSES;
const MANAGERS = ["owner", "admin"];
const AGREEMENT_OPEN = ["proposed", "accepted", "signed"];
const DAY = 24 * 3600 * 1000;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "A real date");
const UUID = z.string().uuid();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/, "A SHA-256 as 64 lowercase hex characters");
const HTTPS = z.string().url().max(2000).refine((u) => u.startsWith("https://"), "An https link");

// The months between audits of each cadence, and how many days before its due date the next audit opens.
const STEP_MONTHS: Partial<Record<Cadence, number>> = { monthly: 1, quarterly: 3, annual: 12 };
const LEAD_DAYS: Partial<Record<Cadence, number>> = { monthly: 14, quarterly: 30, annual: 60 };
// An audit opened by a change or by hand is due this many days later, unless a date is given.
export const ON_CHANGE_DUE_DAYS = 30;
const MAX_FINDINGS = 100;
const MAX_EVIDENCE = 50;

// A due date runs to the end of its day (UTC).
const endOf = (date: string) => new Date(`${date}T23:59:59.000Z`);
export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), last), 23, 59, 59));
}

export interface Finding {
  id: string;
  severity: (typeof FINDING_SEVERITIES)[number];
  title: string;
  detail: string | null;
  status: "open" | "resolved";
  recorded_by: string | null;
  recorded_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  responses: { by: string; at: string; text: string }[];
}
export interface Evidence {
  id: string;
  name: string;
  url: string;
  sha256: string;
  note: string | null;
  submitted_by: string;
  submitted_at: string;
}
export interface Requirement {
  id: string;
  agreement_id: string;
  name: string;
  kind: (typeof AUDIT_REQUIREMENT_KINDS)[number];
  cadence: Cadence;
  first_due: string | null;
  description: string | null;
  evidence_required: string | null;
  created_by: string | null;
  created_at: string;
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
}
export interface AgreementAudit {
  id: string;
  requirement_id: string;
  agreement_id: string;
  app_id: string | null;
  due_at: string;
  status: Status;
  trigger: "schedule" | "manual" | "build";
  build_id: string | null;
  opened_by: string | null;
  opened_at: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  outcome_note: string | null;
  reviewer: string | null;
  findings: Finding[];
  evidence: Evidence[];
  created_at: string;
  updated_at: string;
}

const toRequirement = (r: Row): Requirement => ({
  id: r.id as string,
  agreement_id: r.agreement_id as string,
  name: r.name as string,
  kind: r.kind as Requirement["kind"],
  cadence: r.cadence as Cadence,
  first_due: day(r.first_due),
  description: (r.description as string | null) ?? null,
  evidence_required: (r.evidence_required as string | null) ?? null,
  created_by: (r.created_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
  retired_by: (r.retired_by as string | null) ?? null,
  retired_at: iso(r.retired_at),
  retire_reason: (r.retire_reason as string | null) ?? null,
});

const toAudit = (r: Row): AgreementAudit => ({
  id: r.id as string,
  requirement_id: r.requirement_id as string,
  agreement_id: r.agreement_id as string,
  app_id: (r.app_id as string | null) ?? null,
  due_at: iso(r.due_at)!,
  status: r.status as Status,
  trigger: r.trigger as AgreementAudit["trigger"],
  build_id: (r.build_id as string | null) ?? null,
  opened_by: (r.opened_by as string | null) ?? null,
  opened_at: iso(r.opened_at),
  submitted_by: (r.submitted_by as string | null) ?? null,
  submitted_at: iso(r.submitted_at),
  closed_by: (r.closed_by as string | null) ?? null,
  closed_at: iso(r.closed_at),
  outcome_note: (r.outcome_note as string | null) ?? null,
  reviewer: (r.reviewer as string | null) ?? null,
  findings: Array.isArray(r.findings) ? (r.findings as Finding[]) : [],
  evidence: Array.isArray(r.evidence) ? (r.evidence as Evidence[]) : [],
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

export const isOverdue = (a: Pick<AgreementAudit, "status" | "due_at">, now = new Date()) => OPEN.includes(a.status) && new Date(a.due_at).getTime() < now.getTime();

async function getRequirement(store: Store, id: string) {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`SELECT * FROM ${T}.agreement_audit_requirements WHERE id = $1`, [id])).rows[0];
  return r ? toRequirement(r) : undefined;
}
async function getAudit(store: Store, id: string) {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`SELECT * FROM ${T}.agreement_audits WHERE id = $1`, [id])).rows[0];
  return r ? toAudit(r) : undefined;
}
type AgreementRef = { id: string; app_id: string | null; workspace_id: string | null; counterparty_entity_id: string; kind: string; status: string; signed_at: string | null };
async function getAgreementRef(store: Store, id: string): Promise<AgreementRef | undefined> {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`SELECT id, app_id, workspace_id, counterparty_entity_id, kind, status, GREATEST(app_signed_at, counterparty_signed_at) AS signed_at FROM ${T}.app_agreements WHERE id = $1`, [id])).rows[0];
  return r ? { id: r.id as string, app_id: (r.app_id as string | null) ?? null, workspace_id: (r.workspace_id as string | null) ?? null, counterparty_entity_id: r.counterparty_entity_id as string, kind: r.kind as string, status: r.status as string, signed_at: iso(r.signed_at) } : undefined;
}

// The firms of the app's workspace's members (or its owner's), told of what the licence provider does.
async function appSideFirms(store: Store, appId: string | null): Promise<string[]> {
  if (!appId) return [];
  const app = await store.getApp(appId);
  if (!app) return [];
  const { rows } = app.workspace_id
    ? await store.db.query(`SELECT DISTINCT u.entity_id FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.entity_id IS NOT NULL`, [app.workspace_id])
    : await store.db.query(`SELECT entity_id FROM ${T}.users WHERE id = $1 AND entity_id IS NOT NULL`, [app.owner_id]);
  return rows.map((r) => r.entity_id as string);
}

// Both parties are told: the licence provider's firm, and the firms of the app's workspace members (if any).
async function tellParties(store: Store, agreement: AgreementRef, audit: AgreementAudit, requirement: Requirement, type: FirmWebhookEvent, extra: Record<string, unknown> = {}) {
  const data = { audit_id: audit.id, agreement_id: agreement.id, app_id: audit.app_id, requirement_id: requirement.id, name: requirement.name, kind: requirement.kind, status: audit.status, due_at: audit.due_at, ...extra };
  const firms = new Set([agreement.counterparty_entity_id, ...(await appSideFirms(store, audit.app_id))]);
  let told = 0;
  for (const f of firms) {
    const r = await noticeFirm(store, f, type, data).catch(() => null);
    told += r ? r.webhooks + r.members : 0;
  }
  return told;
}

async function insertAudit(store: Store, req: Requirement, agreement: AgreementRef, o: { due: Date; trigger: AgreementAudit["trigger"]; status: Status; build_id?: string | null; opened_by?: string | null }) {
  const opened = o.status === "in_progress";
  const r = (
    await store.db.query(
      `INSERT INTO ${T}.agreement_audits (id, requirement_id, agreement_id, app_id, due_at, status, trigger, build_id, opened_by, opened_at, reviewer)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN now() END, $9)
       ON CONFLICT (requirement_id) WHERE status IN ('scheduled', 'in_progress', 'submitted') DO NOTHING RETURNING *`,
      [randomUUID(), req.id, agreement.id, agreement.app_id, o.due.toISOString(), o.status, o.trigger, o.build_id ?? null, o.opened_by ?? null, opened],
    )
  ).rows[0];
  return r ? toAudit(r) : undefined;
}

// The newest verified source of the app's builds since `since` that differs from `previousBuild`'s (build_runs may not
// exist on a Mynt without the coding agent).
async function newSourceBuild(store: Store, appId: string, since: string | null, previousBuild: string | null): Promise<string | null> {
  if (!(await store.db.query(`SELECT to_regclass('${T}.build_runs') IS NOT NULL AS ok`)).rows[0]?.ok) return null;
  const r = (
    await store.db.query(
      `SELECT b.id FROM ${T}.build_runs b
        WHERE b.app_id = $1 AND b.status = 'succeeded' AND b.source_sha256 IS NOT NULL AND ($2::timestamptz IS NULL OR COALESCE(b.finished_at, b.updated_at) > $2::timestamptz)
          AND ($3::uuid IS NULL OR b.source_sha256 IS DISTINCT FROM (SELECT p.source_sha256 FROM ${T}.build_runs p WHERE p.id = $3::uuid))
        ORDER BY COALESCE(b.finished_at, b.updated_at) DESC LIMIT 1`,
      [appId, since, previousBuild],
    )
  ).rows[0];
  return (r?.id as string | undefined) ?? null;
}

// Opens the next audit of each live requirement of a signed agreement that has none open, when it's time (see the top
// of this file). `only` narrows it to some requirements. Returns the audits it opened.
export async function sweepAgreementAudits(store: Store, now = new Date(), only?: { requirement_ids?: string[] }): Promise<AgreementAudit[]> {
  if (!(await store.db.query(`SELECT to_regclass('${T}.agreement_audit_requirements') IS NOT NULL AS ok`)).rows[0]?.ok) return [];
  const { rows } = await store.db.query(
    `SELECT r.* FROM ${T}.agreement_audit_requirements r JOIN ${T}.app_agreements a ON a.id = r.agreement_id
      WHERE r.retired_at IS NULL AND a.status = 'signed' AND ($1::uuid[] IS NULL OR r.id = ANY($1::uuid[]))
        AND NOT EXISTS (SELECT 1 FROM ${T}.agreement_audits x WHERE x.requirement_id = r.id AND x.status IN ('scheduled', 'in_progress', 'submitted'))
      ORDER BY r.created_at LIMIT 500`,
    [only?.requirement_ids ?? null],
  );
  const opened: AgreementAudit[] = [];
  for (const row of rows) {
    const req = toRequirement(row);
    const agreement = await getAgreementRef(store, req.agreement_id);
    if (!agreement) continue;
    const lastRow = (await store.db.query(`SELECT * FROM ${T}.agreement_audits WHERE requirement_id = $1 ORDER BY due_at DESC, created_at DESC LIMIT 1`, [req.id])).rows[0];
    const last = lastRow ? toAudit(lastRow) : undefined;
    let plan: { due: Date; trigger: AgreementAudit["trigger"]; build_id?: string | null } | null = null;
    if (req.cadence === "on_change") {
      if (!agreement.app_id) continue;
      const lastBuild = (await store.db.query(`SELECT build_id FROM ${T}.agreement_audits WHERE requirement_id = $1 AND build_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [req.id])).rows[0]?.build_id as string | undefined;
      const since = [agreement.signed_at, last?.created_at].filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
      const build = await newSourceBuild(store, agreement.app_id, since, lastBuild ?? null);
      if (build) plan = { due: new Date(now.getTime() + ON_CHANGE_DUE_DAYS * DAY), trigger: "build", build_id: build };
    } else if (req.cadence === "once") {
      if (!last && req.first_due) plan = { due: endOf(req.first_due), trigger: "schedule" };
    } else if (req.first_due) {
      const due = last ? addMonths(new Date(last.due_at), STEP_MONTHS[req.cadence]!) : endOf(req.first_due);
      if (due.getTime() - LEAD_DAYS[req.cadence]! * DAY <= now.getTime()) plan = { due, trigger: "schedule" };
    }
    if (!plan) continue;
    const audit = await insertAudit(store, req, agreement, { ...plan, status: "scheduled" });
    if (!audit) continue;
    await store.audit(null, "agreement_audit_scheduled", audit.id, { app_id: audit.app_id, workspace_id: agreement.workspace_id, agreement_id: agreement.id, requirement_id: req.id, cadence: req.cadence, trigger: audit.trigger, build_id: audit.build_id, due_at: audit.due_at });
    await tellParties(store, agreement, audit, req, "agreement_audit.opened", { by: "schedule" });
    opened.push(audit);
  }
  return opened;
}

// Overdue audits, for ops_status: how many and on how many apps.
export async function overdueAgreementAudits(store: Pick<Store, "db">, now = new Date()) {
  if (!(await store.db.query(`SELECT to_regclass('${T}.agreement_audits') IS NOT NULL AS ok`)).rows[0]?.ok) return { audits: 0, apps: 0 };
  const r = (await store.db.query(`SELECT count(*)::int AS n, count(DISTINCT app_id)::int AS apps FROM ${T}.agreement_audits WHERE status IN ('scheduled', 'in_progress', 'submitted') AND due_at < $1`, [now.toISOString()])).rows[0];
  return { audits: Number(r?.n ?? 0), apps: Number(r?.apps ?? 0) };
}

// The overdue audits of some apps, for the workspace's attention list.
export async function overdueAuditsOfApps(store: Pick<Store, "db">, appIds: string[], now = new Date()) {
  if (!appIds.length || !(await store.db.query(`SELECT to_regclass('${T}.agreement_audits') IS NOT NULL AS ok`)).rows[0]?.ok) return [];
  const { rows } = await store.db.query(
    `SELECT x.id, x.app_id::text AS app_id, x.agreement_id, x.due_at, r.name, e.name AS counterparty
       FROM ${T}.agreement_audits x JOIN ${T}.agreement_audit_requirements r ON r.id = x.requirement_id
       JOIN ${T}.app_agreements a ON a.id = x.agreement_id LEFT JOIN ${T}.entities e ON e.id = a.counterparty_entity_id
      WHERE x.app_id::text = ANY($1) AND x.status IN ('scheduled', 'in_progress', 'submitted') AND x.due_at < $2 ORDER BY x.due_at`,
    [appIds, now.toISOString()],
  );
  return rows.map((r) => ({ id: r.id as string, app_id: r.app_id as string, agreement_id: r.agreement_id as string, due_at: iso(r.due_at)!, name: r.name as string, counterparty: (r.counterparty as string | null) ?? null }));
}

// Developer (the app's side) and licence provider (the counterparty's side). One account can be both; each call works
// out which side it acts for from the agreement.
export function registerAgreementAuditTools(server: McpServer, store: Store, user: User, sides: { app: boolean; counterparty: boolean }) {
  // The caller's firm, when it acts for it as a licence provider (read afresh, like app-agreements.ts).
  const myFirm = async () => {
    if (!sides.counterparty) return null;
    const me = await store.getUser(user.id);
    return me?.entity_id && effectiveRoles(me.roles).includes("license_provider") ? me.entity_id : null;
  };
  // Who the caller is on this agreement: a member of the app's workspace (a manager or not), and/or its counterparty.
  const access = async (a: AgreementRef) => {
    let app: App | undefined;
    let manager = false;
    if (sides.app && a.app_id) {
      app = await memberApp(store, user, a.app_id);
      if (app) manager = MANAGERS.includes((await appRole(store, user, app)) ?? "");
    }
    const counterparty = (await myFirm()) === a.counterparty_entity_id;
    return { app: Boolean(app), manager, counterparty, party: Boolean(app) || counterparty };
  };

  const names = async (ids: (string | null)[]) => {
    const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (!list.length) return new Map<string, string>();
    const { rows } = await store.db.query(`SELECT id, name FROM ${T}.users WHERE id = ANY($1::uuid[])`, [list]);
    return new Map(rows.map((r) => [r.id as string, r.name as string]));
  };

  // What the caller may do next on an audit, by side.
  const actionsFor = (x: AgreementAudit, who: { manager: boolean; counterparty: boolean }) => {
    const open = OPEN.includes(x.status);
    const openFindings = x.findings.some((f) => f.status === "open");
    return [
      ...(who.counterparty && x.status === "scheduled" ? ["open"] : []),
      ...(who.counterparty && open ? ["record_finding"] : []),
      ...(who.counterparty && open && openFindings ? ["resolve_finding"] : []),
      ...(who.counterparty && x.status === "submitted" && !openFindings ? ["pass"] : []),
      ...(who.counterparty && open ? ["fail", "waive"] : []),
      ...(who.manager && open ? ["submit_evidence"] : []),
      ...(who.manager && open && openFindings ? ["respond_to_finding"] : []),
    ];
  };

  const describe = async (x: AgreementAudit, req: Requirement, a: AgreementRef, who: { app: boolean; manager: boolean; counterparty: boolean }, now = new Date()) => {
    const [app, firm] = await Promise.all([x.app_id ? store.getApp(x.app_id) : undefined, store.getEntity(a.counterparty_entity_id)]);
    return {
      ...x,
      overdue: isOverdue(x, now),
      findings_open: x.findings.filter((f) => f.status === "open").length,
      requirement: { id: req.id, name: req.name, kind: req.kind, cadence: req.cadence, description: req.description, evidence_required: req.evidence_required, retired: req.retired_at !== null },
      agreement: { id: a.id, kind: a.kind, status: a.status },
      app: x.app_id ? { id: x.app_id, name: app?.name ?? null, workspace_id: app?.workspace_id ?? null } : null,
      counterparty: { entity_id: a.counterparty_entity_id, name: firm?.name ?? null },
      your_side: who.counterparty ? (who.app ? "both" : "counterparty") : "app",
      actions: actionsFor(x, who),
    };
  };

  // An audit and its agreement, when the caller is one of the agreement's parties.
  const loadAudit = async (auditId: string) => {
    const x = await getAudit(store, auditId);
    const a = x ? await getAgreementRef(store, x.agreement_id) : undefined;
    const req = x ? await getRequirement(store, x.requirement_id) : undefined;
    if (!x || !a || !req) return null;
    const who = await access(a);
    return who.party ? { x, a, req, who } : null;
  };
  const save = async (x: AgreementAudit, from: Status, set: Record<string, unknown>) => {
    const cols = Object.keys(set);
    const r = (
      await store.db.query(
        `UPDATE ${T}.agreement_audits SET ${cols.map((c, i) => `${c} = ${c === "findings" || c === "evidence" ? `$${i + 3}::jsonb` : `$${i + 3}`}`).join(", ")}, updated_at = now() WHERE id = $1 AND status = $2 RETURNING *`,
        [x.id, from, ...cols.map((c) => (c === "findings" || c === "evidence" ? JSON.stringify(set[c]) : set[c]))],
      )
    ).rows[0];
    return r ? toAudit(r) : undefined;
  };
  const trail = (x: AgreementAudit, a: AgreementRef, extra: Record<string, unknown> = {}) => ({ app_id: x.app_id, workspace_id: a.workspace_id, agreement_id: a.id, requirement_id: x.requirement_id, ...extra });

  if (sides.counterparty) {
    server.registerTool(
      "add_agreement_audit_requirement",
      {
        title: "Add an oversight audit to an agreement",
        description:
          "Licence provider (a member of the agreement's counterparty firm): add an oversight audit you run on the app under a program agreement with your firm, from the proposal on (so it can come with your terms): its name, kind, cadence (once, monthly, quarterly, annual, or on_change: each time the app's builds give it new verified source, or when you open one by hand), the first due date (not for on_change), what it covers and the evidence you need. Once the agreement is signed, Mynt opens each audit when it's time (monthly 14 days before it's due, quarterly 30, annual 60) and the next when one closes. Audited; the app's side sees it in list_agreement_audits.",
        inputSchema: {
          agreement_id: UUID,
          name: z.string().trim().min(3).max(200),
          kind: z.enum(AUDIT_REQUIREMENT_KINDS),
          cadence: z.enum(AUDIT_CADENCES),
          first_due: DATE.optional().describe("YYYY-MM-DD; required unless cadence is on_change"),
          description: z.string().trim().max(4000).optional(),
          evidence_required: z.string().trim().max(4000).optional().describe("What the app's side must submit"),
        },
      },
      async ({ agreement_id, name, kind, cadence, first_due, description, evidence_required }) => {
        const a = await getAgreementRef(store, agreement_id);
        if (!a || (await myFirm()) !== a.counterparty_entity_id) return fail(`No agreement '${agreement_id}' with your firm`);
        if (a.kind !== "program") return fail("Oversight audits belong to program agreements (the licence provider sponsoring the app's products)");
        if (!AGREEMENT_OPEN.includes(a.status)) return fail(`That agreement is ${a.status}`);
        if (cadence === "on_change" && first_due) return fail("An on_change audit has no first due date: each opens on a change, due 30 days later");
        if (cadence !== "on_change" && !first_due) return fail("Give the first due date (first_due)");
        const count = (await store.db.query(`SELECT count(*)::int AS n FROM ${T}.agreement_audit_requirements WHERE agreement_id = $1 AND retired_at IS NULL`, [a.id])).rows[0]?.n as number;
        if (count >= 50) return fail("An agreement has at most 50 audit requirements; retire one first");
        const r = (
          await store.db.query(
            `INSERT INTO ${T}.agreement_audit_requirements (id, agreement_id, name, kind, cadence, first_due, description, evidence_required, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [randomUUID(), a.id, name, kind, cadence, first_due ?? null, description ?? null, evidence_required ?? null, user.id],
          )
        ).rows[0];
        const req = toRequirement(r);
        await store.audit(user.id, "add_agreement_audit_requirement", req.id, { app_id: a.app_id, workspace_id: a.workspace_id, agreement_id: a.id, name, kind, cadence, first_due: first_due ?? null });
        const opened = await sweepAgreementAudits(store, new Date(), { requirement_ids: [req.id] });
        return json({ requirement: req, opened: opened.map((x) => ({ id: x.id, due_at: x.due_at, status: x.status })) });
      },
    );

    server.registerTool(
      "retire_agreement_audit_requirement",
      {
        title: "Retire an oversight audit requirement",
        description:
          "Licence provider: stop an oversight audit requirement on an agreement with your firm, with the reason. Its open audit, if any, is waived with that reason; closed ones stay as they are. Audited.",
        inputSchema: { requirement_id: UUID, reason: z.string().trim().min(3).max(2000) },
      },
      async ({ requirement_id, reason }) => {
        const req = await getRequirement(store, requirement_id);
        const a = req ? await getAgreementRef(store, req.agreement_id) : undefined;
        if (!req || !a || (await myFirm()) !== a.counterparty_entity_id) return fail(`No audit requirement '${requirement_id}' on an agreement with your firm`);
        if (req.retired_at) return fail("It's already retired");
        const r = (await store.db.query(`UPDATE ${T}.agreement_audit_requirements SET retired_at = now(), retired_by = $2, retire_reason = $3 WHERE id = $1 AND retired_at IS NULL RETURNING *`, [req.id, user.id, reason])).rows[0];
        if (!r) return fail("It's already retired");
        const waived = (
          await store.db.query(
            `UPDATE ${T}.agreement_audits SET status = 'waived', closed_at = now(), closed_by = $2, reviewer = $2, outcome_note = $3, updated_at = now() WHERE requirement_id = $1 AND status IN ('scheduled', 'in_progress', 'submitted') RETURNING *`,
            [req.id, user.id, `Requirement retired: ${reason}`],
          )
        ).rows.map(toAudit);
        await store.audit(user.id, "retire_agreement_audit_requirement", req.id, { app_id: a.app_id, workspace_id: a.workspace_id, agreement_id: a.id, reason, waived: waived.map((x) => x.id) });
        for (const x of waived) {
          await store.audit(user.id, "waive_agreement_audit", x.id, trail(x, a, { note: `Requirement retired: ${reason}` }));
          await tellParties(store, a, x, req, "agreement_audit.closed", { outcome: "waived" });
        }
        return json({ requirement: toRequirement(r), waived: waived.map((x) => x.id) });
      },
    );

    server.registerTool(
      "open_agreement_audit",
      {
        title: "Open an oversight audit",
        description:
          "Licence provider: start an oversight audit on an app under a signed agreement with your firm. With audit_id: open a scheduled one (it's in progress, and you're its reviewer). With requirement_id: open one now by hand (an on_change review of a change you've seen, say), due on `due` or 30 days from now; refused while that requirement has one open. Audited; the app's side is told.",
        inputSchema: { audit_id: UUID.optional(), requirement_id: UUID.optional(), due: DATE.optional() },
      },
      async ({ audit_id, requirement_id, due }) => {
        if (Boolean(audit_id) === Boolean(requirement_id)) return fail("Give audit_id (a scheduled audit) or requirement_id (open one by hand), not both");
        const firm = await myFirm();
        if (audit_id) {
          const got = await loadAudit(audit_id);
          if (!got || !got.who.counterparty || got.a.counterparty_entity_id !== firm) return fail(`No audit '${audit_id}' on an agreement with your firm`);
          if (due) return fail("A scheduled audit keeps its due date");
          if (got.x.status !== "scheduled") return fail(`That audit is ${got.x.status.replace("_", " ")}, not scheduled`);
          const done = await save(got.x, "scheduled", { status: "in_progress", opened_by: user.id, opened_at: new Date().toISOString(), reviewer: user.id });
          if (!done) return fail("That audit changed meanwhile; read it again");
          await store.audit(user.id, "open_agreement_audit", done.id, trail(done, got.a, { manual: false }));
          await tellParties(store, got.a, done, got.req, "agreement_audit.opened", { by: "licence_provider" });
          return json(await describe(done, got.req, got.a, got.who));
        }
        const req = await getRequirement(store, requirement_id!);
        const a = req ? await getAgreementRef(store, req.agreement_id) : undefined;
        if (!req || !a || a.counterparty_entity_id !== firm) return fail(`No audit requirement '${requirement_id}' on an agreement with your firm`);
        if (req.retired_at) return fail("That requirement is retired");
        if (a.status !== "signed") return fail(`Audits run under a signed agreement; this one is ${a.status}`);
        const dueAt = due ? endOf(due) : new Date(Date.now() + ON_CHANGE_DUE_DAYS * DAY);
        if (dueAt.getTime() < Date.now()) return fail("The due date is in the past");
        const x = await insertAudit(store, req, a, { due: dueAt, trigger: "manual", status: "in_progress", opened_by: user.id });
        if (!x) {
          const open = (await store.db.query(`SELECT id FROM ${T}.agreement_audits WHERE requirement_id = $1 AND status IN ('scheduled', 'in_progress', 'submitted')`, [req.id])).rows[0];
          return fail(`An audit of that requirement is already open (${open?.id}); open or close that one`);
        }
        await store.audit(user.id, "open_agreement_audit", x.id, trail(x, a, { manual: true, due_at: x.due_at }));
        await tellParties(store, a, x, req, "agreement_audit.opened", { by: "licence_provider" });
        return json(await describe(x, req, a, await access(a)));
      },
    );

    server.registerTool(
      "record_agreement_audit_finding",
      {
        title: "Record a finding on an oversight audit",
        description:
          "Licence provider: record a finding on an open audit of an agreement with your firm (severity, title, detail). It's open until you resolve it (resolve_agreement_audit_finding); the app's side answers it (respond_to_agreement_audit_finding). A scheduled or submitted audit goes back to in progress. Audited.",
        inputSchema: { audit_id: UUID, severity: z.enum(FINDING_SEVERITIES), title: z.string().trim().min(3).max(200), detail: z.string().trim().max(4000).optional() },
      },
      async ({ audit_id, severity, title, detail }) => {
        const got = await loadAudit(audit_id);
        if (!got || !got.who.counterparty) return fail(`No audit '${audit_id}' on an agreement with your firm`);
        const { x, a, req } = got;
        if (!OPEN.includes(x.status)) return fail(`That audit is ${x.status}`);
        if (x.findings.length >= MAX_FINDINGS) return fail(`An audit has at most ${MAX_FINDINGS} findings`);
        const now = new Date().toISOString();
        const finding: Finding = { id: randomUUID(), severity, title, detail: detail ?? null, status: "open", recorded_by: user.id, recorded_at: now, resolved_by: null, resolved_at: null, resolution_note: null, responses: [] };
        const done = await save(x, x.status, {
          findings: [...x.findings, finding],
          status: "in_progress",
          reviewer: user.id,
          ...(x.opened_at ? {} : { opened_at: now, opened_by: user.id }),
        });
        if (!done) return fail("That audit changed meanwhile; read it again");
        await store.audit(user.id, "record_agreement_audit_finding", done.id, trail(done, a, { finding_id: finding.id, severity, title }));
        return json(await describe(done, req, a, got.who));
      },
    );

    server.registerTool(
      "resolve_agreement_audit_finding",
      {
        title: "Resolve a finding on an oversight audit",
        description: "Licence provider: mark an open finding on an open audit of an agreement with your firm resolved, with an optional note. Audited.",
        inputSchema: { audit_id: UUID, finding_id: UUID, note: z.string().trim().max(2000).optional() },
      },
      async ({ audit_id, finding_id, note }) => {
        const got = await loadAudit(audit_id);
        if (!got || !got.who.counterparty) return fail(`No audit '${audit_id}' on an agreement with your firm`);
        const { x, a, req } = got;
        if (!OPEN.includes(x.status)) return fail(`That audit is ${x.status}`);
        const f = x.findings.find((y) => y.id === finding_id);
        if (!f) return fail(`No finding '${finding_id}' on that audit`);
        if (f.status === "resolved") return fail("That finding is already resolved");
        const findings = x.findings.map((y) => (y.id === finding_id ? { ...y, status: "resolved" as const, resolved_by: user.id, resolved_at: new Date().toISOString(), resolution_note: note ?? null } : y));
        const done = await save(x, x.status, { findings });
        if (!done) return fail("That audit changed meanwhile; read it again");
        await store.audit(user.id, "resolve_agreement_audit_finding", done.id, trail(done, a, { finding_id, note: note ?? null }));
        return json(await describe(done, req, a, got.who));
      },
    );

    server.registerTool(
      "close_agreement_audit",
      {
        title: "Pass, fail or waive an oversight audit",
        description:
          "Licence provider: close an open audit of an agreement with your firm. passed: only once the app's side has submitted evidence and every finding is resolved. failed or waived: at any point, with a note saying why. Mynt opens the requirement's next audit when its time comes. Audited; the app's side is told.",
        inputSchema: { audit_id: UUID, outcome: z.enum(["passed", "failed", "waived"]), note: z.string().trim().max(4000).optional() },
      },
      async ({ audit_id, outcome, note }) => {
        const got = await loadAudit(audit_id);
        if (!got || !got.who.counterparty) return fail(`No audit '${audit_id}' on an agreement with your firm`);
        const { x, a, req } = got;
        if (!OPEN.includes(x.status)) return fail(`That audit is already ${x.status}`);
        if (outcome === "passed") {
          if (x.status !== "submitted") return fail("It passes once the app's side has submitted evidence");
          if (x.findings.some((f) => f.status === "open")) return fail("Resolve its open findings first, or fail it");
        } else if (!note || note.length < 3) return fail(`Say why it's ${outcome} (note)`);
        const done = await save(x, x.status, { status: outcome, closed_at: new Date().toISOString(), closed_by: user.id, reviewer: user.id, outcome_note: note ?? null });
        if (!done) return fail("That audit changed meanwhile; read it again");
        const details = trail(done, a, { from_status: x.status, note: note ?? null, findings_open: done.findings.filter((f) => f.status === "open").length });
        if (outcome === "passed") await store.audit(user.id, "pass_agreement_audit", done.id, details);
        else if (outcome === "failed") await store.audit(user.id, "fail_agreement_audit", done.id, details);
        else await store.audit(user.id, "waive_agreement_audit", done.id, details);
        await tellParties(store, a, done, req, "agreement_audit.closed", { outcome });
        const next = await sweepAgreementAudits(store, new Date(), { requirement_ids: [req.id] });
        return json({ ...(await describe(done, req, a, got.who)), next: next.map((n) => ({ id: n.id, due_at: n.due_at, status: n.status })) });
      },
    );
  }

  if (sides.app) {
    server.registerTool(
      "submit_agreement_audit_evidence",
      {
        title: "Submit evidence for an oversight audit",
        description:
          "Developer (the app's workspace owners and admins): submit evidence for an open oversight audit of your app: each item a name, an https link to it and its SHA-256 (Mynt stores links and hashes, not files), with an optional note. The audit becomes submitted, waiting for the licence provider's review. Audited; the licence provider is told.",
        inputSchema: {
          audit_id: UUID,
          evidence: z.array(z.object({ name: z.string().trim().min(1).max(200), url: HTTPS, sha256: SHA256 }).strict()).min(1).max(20),
          note: z.string().trim().max(4000).optional(),
        },
      },
      async ({ audit_id, evidence, note }) => {
        const got = await loadAudit(audit_id);
        if (!got || !got.who.app) return fail(`No audit '${audit_id}' of your apps`);
        if (!got.who.manager) return fail("Only the workspace's owners and admins submit evidence for its apps");
        const { x, a, req } = got;
        if (!OPEN.includes(x.status)) return fail(`That audit is already ${x.status}`);
        if (x.evidence.length + evidence.length > MAX_EVIDENCE) return fail(`An audit holds at most ${MAX_EVIDENCE} pieces of evidence`);
        const now = new Date().toISOString();
        const items: Evidence[] = evidence.map((e) => ({ id: randomUUID(), name: e.name, url: e.url, sha256: e.sha256, note: note ?? null, submitted_by: user.id, submitted_at: now }));
        const done = await save(x, x.status, { evidence: [...x.evidence, ...items], status: "submitted", submitted_by: user.id, submitted_at: now });
        if (!done) return fail("That audit changed meanwhile; read it again");
        await store.audit(user.id, "submit_agreement_audit_evidence", done.id, trail(done, a, { evidence: items.map((e) => ({ id: e.id, name: e.name, sha256: e.sha256 })), note: note ?? null }));
        await tellParties(store, a, done, req, "agreement_audit.submitted", { evidence: items.length });
        return json(await describe(done, req, a, got.who));
      },
    );

    server.registerTool(
      "respond_to_agreement_audit_finding",
      {
        title: "Answer a finding on an oversight audit",
        description:
          "Developer (the app's workspace owners and admins): answer an open finding the licence provider recorded on an open audit of your app (what you changed, or why it stands). The licence provider resolves it. Audited; the licence provider is told.",
        inputSchema: { audit_id: UUID, finding_id: UUID, response: z.string().trim().min(3).max(4000) },
      },
      async ({ audit_id, finding_id, response }) => {
        const got = await loadAudit(audit_id);
        if (!got || !got.who.app) return fail(`No audit '${audit_id}' of your apps`);
        if (!got.who.manager) return fail("Only the workspace's owners and admins answer findings for its apps");
        const { x, a, req } = got;
        if (!OPEN.includes(x.status)) return fail(`That audit is already ${x.status}`);
        const f = x.findings.find((y) => y.id === finding_id);
        if (!f) return fail(`No finding '${finding_id}' on that audit`);
        if (f.status !== "open") return fail("That finding is already resolved");
        if (f.responses.length >= 50) return fail("That finding has as many answers as it can hold");
        const findings = x.findings.map((y) => (y.id === finding_id ? { ...y, responses: [...y.responses, { by: user.id, at: new Date().toISOString(), text: response }] } : y));
        const done = await save(x, x.status, { findings });
        if (!done) return fail("That audit changed meanwhile; read it again");
        await store.audit(user.id, "respond_to_agreement_audit_finding", done.id, trail(done, a, { finding_id }));
        await tellParties(store, a, done, req, "agreement_audit.submitted", { response_to: finding_id });
        return json(await describe(done, req, a, got.who));
      },
    );
  }

  server.registerTool(
    "list_agreement_audits",
    {
      title: "Oversight audits under app agreements",
      description:
        "The oversight audits under app agreements you're a party to, with those agreements (can_add_requirements: whether you can add one to it) and their requirements. Developer: your apps' (any member of the app's workspace; workspace_id or app_id narrow it). Licence provider: those on agreements with your firm. agreement_id, status and overdue narrow it further; side picks one side when you're both. Each audit says whether it's overdue (past its due date and not closed), its open findings and what you may do next (actions).",
      inputSchema: {
        workspace_id: z.string().trim().min(1).max(100).optional(),
        app_id: UUID.optional(),
        agreement_id: UUID.optional(),
        status: z.enum(AGREEMENT_AUDIT_STATUSES).optional(),
        overdue: z.boolean().optional(),
        side: z.enum(["app", "counterparty"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, app_id, agreement_id, status, overdue, side }) => {
      const now = new Date();
      // The agreements the caller is a party to, on each side.
      const ids = new Set<string>();
      if (sides.app && side !== "counterparty") {
        let appIds: string[];
        if (app_id) {
          const app = await memberApp(store, user, app_id);
          if (!app) return fail(`No app '${app_id}' of yours`);
          appIds = [app.id];
        } else appIds = (await store.appsVisibleTo(user.id, workspace_id)).map((x) => x.id);
        if (appIds.length) (await store.db.query(`SELECT id FROM ${T}.app_agreements WHERE app_id = ANY($1::uuid[])`, [appIds])).rows.forEach((r) => ids.add(r.id as string));
      }
      const firm = side === "app" ? null : await myFirm();
      if (firm) (await store.db.query(`SELECT id FROM ${T}.app_agreements WHERE counterparty_entity_id = $1 AND ($2::uuid IS NULL OR app_id = $2::uuid)`, [firm, app_id ?? null])).rows.forEach((r) => ids.add(r.id as string));
      if (agreement_id) {
        if (!ids.has(agreement_id)) return fail(`No agreement '${agreement_id}' you're a party to`);
        ids.clear();
        ids.add(agreement_id);
      }
      const list = [...ids];
      if (!list.length) return json({ agreements: [], requirements: [], audits: [], counts: { audits: 0, open: 0, overdue: 0 } });
      const agreements = new Map<string, AgreementRef>();
      const whoOf = new Map<string, Awaited<ReturnType<typeof access>>>();
      for (const id of list) {
        const a = (await getAgreementRef(store, id))!;
        agreements.set(id, a);
        whoOf.set(id, await access(a));
      }
      const reqRows = (await store.db.query(`SELECT * FROM ${T}.agreement_audit_requirements WHERE agreement_id = ANY($1::uuid[]) ORDER BY created_at`, [list])).rows.map(toRequirement);
      const reqs = new Map(reqRows.map((r) => [r.id, r]));
      const auditRows = (await store.db.query(`SELECT * FROM ${T}.agreement_audits WHERE agreement_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) ORDER BY due_at DESC`, [list, status ?? null])).rows.map(toAudit);
      const shown = auditRows.filter((x) => overdue === undefined || isOverdue(x, now) === overdue);
      const audits = await Promise.all(shown.map((x) => describe(x, reqs.get(x.requirement_id)!, agreements.get(x.agreement_id)!, whoOf.get(x.agreement_id)!, now)));
      const all = (await store.db.query(`SELECT requirement_id, status, due_at FROM ${T}.agreement_audits WHERE agreement_id = ANY($1::uuid[])`, [list])).rows;
      const firms = new Map<string, string | null>();
      for (const a of agreements.values()) if (!firms.has(a.counterparty_entity_id)) firms.set(a.counterparty_entity_id, (await store.getEntity(a.counterparty_entity_id))?.name ?? null);
      const requirements = reqRows.map((r) => {
        const mine = all.filter((x) => x.requirement_id === r.id);
        const open = mine.filter((x) => OPEN.includes(x.status as string));
        const a = agreements.get(r.agreement_id)!;
        return {
          ...r,
          app_id: a.app_id,
          counterparty: { entity_id: a.counterparty_entity_id, name: firms.get(a.counterparty_entity_id) ?? null },
          audits: mine.length,
          next_due: open.length ? iso(open[0].due_at) : null,
          overdue: open.some((x) => isOverdue({ status: x.status as Status, due_at: iso(x.due_at)! }, now)),
          can_manage: whoOf.get(r.agreement_id)!.counterparty && !r.retired_at,
        };
      });
      const appNames = new Map<string, string | null>();
      for (const a of agreements.values()) if (a.app_id && !appNames.has(a.app_id)) appNames.set(a.app_id, (await store.getApp(a.app_id))?.name ?? null);
      return json({
        // The agreements themselves (the caller's side of each, and whether it can take requirements from the caller).
        agreements: [...agreements.values()].map((a) => {
          const who = whoOf.get(a.id)!;
          return {
            id: a.id,
            kind: a.kind,
            status: a.status,
            app: a.app_id ? { id: a.app_id, name: appNames.get(a.app_id) ?? null } : null,
            counterparty: { entity_id: a.counterparty_entity_id, name: firms.get(a.counterparty_entity_id) ?? null },
            your_side: who.counterparty ? (who.app ? "both" : "counterparty") : "app",
            can_add_requirements: who.counterparty && a.kind === "program" && AGREEMENT_OPEN.includes(a.status),
          };
        }),
        requirements,
        audits,
        counts: { audits: all.length, open: all.filter((x) => OPEN.includes(x.status as string)).length, overdue: all.filter((x) => isOverdue({ status: x.status as Status, due_at: iso(x.due_at)! }, now)).length },
      });
    },
  );

  server.registerTool(
    "get_agreement_audit",
    {
      title: "An oversight audit",
      description:
        "One oversight audit under an app agreement you're a party to: its requirement, due date, status, whether it's overdue, findings (with the app side's answers), evidence (links with their SHA-256), its history (every change, who made it and when) and what you may do next (actions).",
      inputSchema: { audit_id: UUID },
      annotations: { readOnlyHint: true },
    },
    async ({ audit_id }) => {
      const got = await loadAudit(audit_id);
      if (!got) return fail(`No audit '${audit_id}' you're a party to`);
      const { rows } = await store.db.query(`SELECT id, action, actor_id, details, created_at FROM ${T}.audit_log WHERE target = $1 ORDER BY created_at, seq`, [got.x.id]);
      const people = await names([...rows.map((r) => r.actor_id as string | null), got.x.reviewer, got.x.opened_by, got.x.submitted_by, got.x.closed_by, ...got.x.findings.flatMap((f) => [f.recorded_by, f.resolved_by, ...f.responses.map((y) => y.by)]), ...got.x.evidence.map((e) => e.submitted_by)]);
      return json({
        ...(await describe(got.x, got.req, got.a, got.who)),
        people: Object.fromEntries(people),
        history: rows.map((r) => ({ id: r.id, action: r.action, at: iso(r.created_at), actor: r.actor_id ? { id: r.actor_id, name: people.get(r.actor_id as string) ?? null } : null, details: r.details })),
      });
    },
  );
}
