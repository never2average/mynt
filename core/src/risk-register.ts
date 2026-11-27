import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ownFirms } from "./app-agreements.js";
import type { Db } from "./db.js";
import { CONTROL_STEP_WORDS, DEFAULT_RISK_GRADING, deriveResidual, levelOf, loadRiskGrading, NOT_ASSESSED, type ControlStep, type RiskGrading, type RiskLevelKey } from "./risk-grading.js";
import { CONTROL_STEPS, PLATFORM_SUBJECT_ID, RISK_AREA_OF_CATEGORY, RISK_AREAS, RISK_CATEGORIES, RISK_LEVEL_KEYS, RISK_STATUSES, RISK_SUBJECTS, type RiskArea } from "./risk-register-schema.js";
import { effectiveRoles, type App, type ProductRecord, type Store, type User } from "./store.js";
import { appRole, memberApp } from "./workspaces.js";

// A risk register, one shape for apps and financial products: each risk with its category, its risk area (one of the
// platform's seven: financial, compliance, third_party, operations, business_process, technology, regulated_product;
// by default its category's, RISK_AREA_OF_CATEGORY), likelihood and impact (1-5 each; the score is their product), an owner, the mitigation, a status (open, mitigating, accepted, closed) and the
// date it's next reviewed by.
//
// Scoring is three steps (risk-grading.ts holds the platform's grading): the INHERENT score is likelihood × impact; the
// CONTROL is how well the risk's controls work, in four steps (none, weak, partial, strong; not assessed until someone
// says); the RESIDUAL score is derived from the two by the platform's residual method, unless the keeper overrides it
// with their own residual likelihood and impact (who, when and why are kept). A risk whose control isn't assessed
// stands at its inherent score and says so: never a 0, never a blank. What explains each score (factors), the work
// that brings it down (treatment tasks), what keeps it down (controls) and what it's about (links) are in
// risk-detail.ts.
//
// Who keeps it: for an app, its workspace's owners and admins (any member reads it); for a product, its own firm (the
// product's owner, or a builder at the firm it belongs to). A licence provider sponsoring the product (an approved
// sponsorship) reads the product's register and never writes it. Mynt's own register (subject_type platform,
// subject_id "mynt") is kept and read by Mynt's admins only: to anyone else it doesn't exist. Every change is audited with the app's or product's
// id, and the audit trail is the risk's history (list_risks with risk_id). A review date that has passed on a risk
// that isn't closed is overdue, and ops_status says so.
//
// For an app, list_risks also brings the signals Mynt measures around it, each a list or "not available" with why
// (never an empty list for something Mynt doesn't measure): fraud, its vendors' failing services and ended contracts,
// conduct findings from agreement oversight audits, and its products with sales paused by a covenant or drifted.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

type Row = Record<string, unknown>;
type Subject = (typeof RISK_SUBJECTS)[number];
const MANAGERS = ["owner", "admin"];
const UUID = z.string().uuid();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD");
const SCORE = z.number().int().min(1).max(5);
const AREA = z.enum(RISK_AREAS);
// A list's filter: one area, or the risks with none (unassigned).
const AREA_FILTER = z.enum([...RISK_AREAS, "unassigned"]);
const areaWhere = (col: string, n: number) => `($${n}::text IS NULL OR ${col} = $${n} OR ($${n} = 'unassigned' AND ${col} IS NULL))`;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

/** A 5×5 score's level by Mynt's default bands: 1-4 low, 5-9 medium, 10-14 high, 15-25 critical. */
export function riskLevel(score: number): RiskLevelKey {
  return levelOf(DEFAULT_RISK_GRADING.inherent_bands, score);
}

export interface Risk {
  id: string;
  subject_type: Subject;
  subject_id: string;
  title: string;
  category: (typeof RISK_CATEGORIES)[number];
  risk_area: RiskArea | null;
  description: string | null;
  likelihood: number;
  impact: number;
  score: number; // the inherent score
  level: RiskLevelKey;
  inherent: { likelihood: number; impact: number; score: number; level: RiskLevelKey; level_name: string };
  control: { effectiveness: ControlStep | null; words: string; note: string | null };
  residual: {
    score: number;
    level: RiskLevelKey;
    level_name: string;
    assessed: boolean; // false: the control isn't assessed and nothing overrides it, so this is the inherent score
    overridden: boolean;
    likelihood: number | null; // an override's own
    impact: number | null;
    override: { by: string | null; at: string | null; why: string | null } | null;
    words: string;
  };
  owner: { user_id: string; name: string | null } | null;
  mitigation: string | null;
  status: (typeof RISK_STATUSES)[number];
  review_by: string | null;
  overdue: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The residual score a risk row stands at: its override, else what the grading derives, else its inherent score. */
export function residualOf(g: RiskGrading, r: { likelihood: number; impact: number; control_effectiveness: ControlStep | null; residual_likelihood: number | null; residual_impact: number | null }): number {
  if (r.residual_likelihood != null && r.residual_impact != null) return r.residual_likelihood * r.residual_impact;
  return r.control_effectiveness ? deriveResidual(g, r.likelihood * r.impact, r.control_effectiveness) : r.likelihood * r.impact;
}

const toRisk = (r: Row, g: RiskGrading): Risk => {
  const likelihood = Number(r.likelihood);
  const impact = Number(r.impact);
  const review_by = day(r.review_by);
  const status = r.status as Risk["status"];
  const inherent = likelihood * impact;
  const inherentLevel = levelOf(g.inherent_bands, inherent);
  const effectiveness = (r.control_effectiveness as ControlStep | null) ?? null;
  const rl = r.residual_likelihood == null ? null : Number(r.residual_likelihood);
  const ri = r.residual_impact == null ? null : Number(r.residual_impact);
  const overridden = rl !== null && ri !== null;
  const residual = residualOf(g, { likelihood, impact, control_effectiveness: effectiveness, residual_likelihood: rl, residual_impact: ri });
  const residualLevel = levelOf(g.residual_bands, residual);
  const assessed = overridden || effectiveness !== null;
  return {
    inherent: { likelihood, impact, score: inherent, level: inherentLevel, level_name: g.levels[inherentLevel] },
    control: { effectiveness, words: effectiveness ? CONTROL_STEP_WORDS[effectiveness] : NOT_ASSESSED, note: (r.control_note as string | null) ?? null },
    residual: {
      score: residual,
      level: residualLevel,
      level_name: g.levels[residualLevel],
      assessed,
      overridden,
      likelihood: overridden ? rl : null,
      impact: overridden ? ri : null,
      override: overridden ? { by: (r.residual_overridden_by as string | null) ?? null, at: iso(r.residual_overridden_at), why: (r.residual_override_reason as string | null) ?? null } : null,
      words: overridden
        ? `${residual} (${g.levels[residualLevel]}), overridden: ${rl} × ${ri}`
        : effectiveness
          ? `${residual} (${g.levels[residualLevel]})`
          : `${residual} (${g.levels[residualLevel]}): same as inherent, control not assessed`,
    },
    id: r.id as string,
    subject_type: r.subject_type as Subject,
    subject_id: r.subject_id as string,
    title: r.title as string,
    category: r.category as Risk["category"],
    risk_area: (r.risk_area as RiskArea | null) ?? null,
    description: (r.description as string | null) ?? null,
    likelihood,
    impact,
    score: inherent,
    level: inherentLevel,
    owner: r.owner_user_id ? { user_id: r.owner_user_id as string, name: (r.owner_name as string | null) ?? null } : null,
    mitigation: (r.mitigation as string | null) ?? null,
    status,
    review_by,
    overdue: Boolean(review_by && status !== "closed" && review_by < today()),
    created_by: (r.created_by as string | null) ?? null,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
};

const SELECT = `SELECT r.*, u.name AS owner_name FROM ${T}.risk_register r LEFT JOIN ${T}.users u ON u.id = r.owner_user_id`;

export async function getRisk(store: Store, id: string, grading?: RiskGrading): Promise<Risk | undefined> {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];
  return r ? toRisk(r, grading ?? (await loadRiskGrading(store)).grading) : undefined;
}

// The residual score in SQL, for sorting: the stored one (derived or overridden), else the inherent score.
const RESIDUAL_SQL = "coalesce(r.residual_score, r.likelihood * r.impact)";
const scoresOf = (r: Risk) => ({ inherent: r.inherent.score, control: r.control.effectiveness, residual: r.residual.score });

// ---- a risk's history, from the audit trail ----

/** Every audited action on a risk, in words. */
export const RISK_HISTORY_ACTIONS = [
  "add_risk",
  "update_risk",
  "rederive_risk_residual",
  "add_risk_factor",
  "update_risk_factor",
  "remove_risk_factor",
  "add_risk_treatment",
  "update_risk_treatment",
  "add_risk_control",
  "update_risk_control",
  "retire_risk_control",
  "link_risk",
  "unlink_risk",
] as const;

type Scores = { inherent: number | null; control: string | null; residual: number | null };
export type RiskHistoryEntry = {
  at: string | null;
  action: string;
  actor: { user_id: string; name: string | null } | null;
  what: string;
  changes: unknown;
  note: unknown;
  score: { before: Scores | null; after: Scores | null };
};

const FIELD_WORDS: Record<string, string> = {
  status: "status",
  risk_area: "risk area",
  mitigation: "mitigation",
  likelihood: "likelihood",
  impact: "impact",
  owner_user_id: "owner",
  review_by: "review date",
  control_effectiveness: "control effectiveness",
  control_note: "control note",
  residual_override: "residual override",
};
const shown = (v: unknown) => (v == null ? "none" : typeof v === "object" ? JSON.stringify(v) : String(v).replace(/_/g, " "));

/** A risk's history: every change the audit trail holds for it, oldest first, each with what changed in words and the
 * scores before and after it (an entry from before three-step scoring carries the inherent score only: its residual
 * is null, "not recorded", never a guess). */
export async function riskHistory(store: Store, riskId: string): Promise<RiskHistoryEntry[]> {
  const { rows } = await store.db.query(
    `SELECT l.action, l.details, l.created_at, l.actor_id, u.name AS actor FROM ${T}.audit_log l LEFT JOIN ${T}.users u ON u.id = l.actor_id
      WHERE l.target = $1 AND l.action = ANY($2::text[]) ORDER BY l.created_at, l.seq`,
    [riskId, [...RISK_HISTORY_ACTIONS]],
  );
  let last: Scores | null = null;
  return rows.map((r) => {
    const d = (r.details ?? {}) as Row;
    const recorded = (d.scores ?? null) as { before?: Scores | null; after?: Scores | null } | null;
    let before: Scores | null = recorded?.before ?? last;
    let after: Scores | null = recorded?.after ?? null;
    if (!after) {
      if (r.action === "rederive_risk_residual") {
        const m = (d.residual ?? {}) as { from?: number | null; to?: number | null };
        before = last ? { ...last, residual: m.from ?? last.residual } : null;
        after = { inherent: last?.inherent ?? null, control: last?.control ?? null, residual: m.to ?? null };
      } else if (typeof d.score === "number") after = { inherent: d.score, control: null, residual: null };
      else after = last;
    }
    if (r.action === "add_risk") before = null;
    last = after;
    const changes = (d.changes ?? null) as Record<string, { from?: unknown; to?: unknown }> | null;
    const what =
      typeof d.what === "string"
        ? d.what
        : r.action === "add_risk"
          ? "Risk added"
          : changes && Object.keys(changes).length
            ? `Changed ${Object.entries(changes).map(([k, c]) => `${FIELD_WORDS[k] ?? k.replace(/_/g, " ")} (${shown(c?.from)} → ${shown(c?.to)})`).join(", ")}`
            : "Reviewed";
    return { at: iso(r.created_at), action: r.action as string, actor: r.actor_id ? { user_id: r.actor_id as string, name: (r.actor as string | null) ?? null } : null, what, changes, note: d.note ?? null, score: { before, after } };
  });
}

const tableExists = async (store: Store, table: string) => Boolean((await store.db.query(`SELECT to_regclass('${T}.${table}') IS NOT NULL AS ok`)).rows[0]?.ok);

// ---- the signals around an app ----

type Signal<R> = { available: true; rows: R[] } | { available: false; reason: string };

// Mynt records no fraud or velocity signals from customer sessions: client sessions carry who and what, not risk.
const fraudSignals = (): Signal<never> => ({ available: false, reason: "Not measured yet: Mynt records no fraud or velocity signals from customer sessions." });

// The vendor services the app's workspace relies on that are failing: the offering's latest conformance run failed,
// most of its calls in the last week erred, or the subscription or a vendor contract has ended.
async function vendorSignals(store: Store, app: App) {
  // Its workspace's own firms' subscriptions and those whose terms were accepted for this app; never those of another
  // firm a member happens to belong to (app-agreements.ts ownFirms).
  const firms = await ownFirms(store, app);
  const rows: { subscription_id: string | null; agreement_id: string | null; vendor: string | null; offering: string | null; issue: string; detail: string; since: string | null }[] = [];
  {
    const { rows: subs } = await store.db.query(
      `SELECT s.id, s.status, s.live, s.created_at, s.ended_at, o.id AS offering_id, o.name AS offering, e.name AS vendor,
              (SELECT r.passed FROM ${T}.vendor_conformance_runs r WHERE r.offering_id = o.id ORDER BY r.created_at DESC LIMIT 1) AS last_passed,
              (SELECT r.created_at FROM ${T}.vendor_conformance_runs r WHERE r.offering_id = o.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_at,
              (SELECT coalesce(sum(u.ok + u.errors), 0)::int FROM ${T}.vendor_usage u WHERE u.subscription_id = s.id AND u.day > current_date - 7) AS calls,
              (SELECT coalesce(sum(u.errors), 0)::int FROM ${T}.vendor_usage u WHERE u.subscription_id = s.id AND u.day > current_date - 7) AS errors
         FROM ${T}.vendor_subscriptions s JOIN ${T}.vendor_offerings o ON o.id = s.offering_id LEFT JOIN ${T}.entities e ON e.id = o.entity_id
        WHERE (s.entity_id = ANY($1::uuid[]) OR EXISTS (SELECT 1 FROM ${T}.app_agreements g WHERE g.vendor_subscription_id = s.id AND g.app_id = $2))
          AND (s.status = 'active' OR s.ended_at > now() - interval '90 days')
        ORDER BY s.created_at`,
      [firms, app.id],
    );
    for (const s of subs) {
      const base = { subscription_id: s.id as string, agreement_id: null, vendor: (s.vendor as string | null) ?? null, offering: (s.offering as string | null) ?? null };
      if (s.status === "ended") rows.push({ ...base, issue: "subscription_ended", detail: "The subscription has ended", since: iso(s.ended_at) });
      else {
        if (s.last_passed === false) rows.push({ ...base, issue: "conformance_failed", detail: "The service's latest conformance run failed", since: iso(s.last_run_at) });
        const calls = Number(s.calls ?? 0);
        const errors = Number(s.errors ?? 0);
        if (calls >= 10 && errors * 5 > calls) rows.push({ ...base, issue: "erroring", detail: `${errors} of ${calls} calls erred in the last 7 days`, since: null });
      }
    }
  }
  // Vendor contracts the app's workspace made (app-agreements.ts) that have ended.
  const { rows: ended } = await store.db.query(
    `SELECT a.id, a.terminated_at, a.termination_reason, a.effective_to, a.status, e.name AS vendor FROM ${T}.app_agreements a LEFT JOIN ${T}.entities e ON e.id = a.counterparty_entity_id
      WHERE a.app_id = $1 AND a.kind = 'vendor' AND (a.status = 'terminated' OR (a.status = 'signed' AND a.effective_to < current_date)) ORDER BY a.updated_at DESC LIMIT 20`,
    [app.id],
  );
  for (const a of ended)
    rows.push({
      subscription_id: null,
      agreement_id: a.id as string,
      vendor: (a.vendor as string | null) ?? null,
      offering: null,
      issue: "contract_ended",
      detail: a.status === "terminated" ? `The vendor contract was ended${a.termination_reason ? `: ${a.termination_reason}` : ""}` : "The vendor contract's end date has passed",
      since: a.status === "terminated" ? iso(a.terminated_at) : day(a.effective_to),
    });
  return { available: true as const, rows };
}

// Open findings from the oversight audits licence providers run under the app's agreements (agreement-audits.ts),
// for requirements of the marketing and complaints kinds: each finding still "open", newest audit first. A server
// without those tables says so.
async function conductSignals(store: Store, app: App): Promise<Signal<{ audit_id: string; agreement_id: string; kind: string; requirement: string; finding: string; severity: string | null; since: string | null }>> {
  if (!(await tableExists(store, "agreement_audits")) || !(await tableExists(store, "agreement_audit_requirements")))
    return { available: false, reason: "Not available yet: oversight audits of agreements come with Mynt's next update." };
  const { rows } = await store.db.query(
    `SELECT a.id, a.agreement_id, a.findings, a.created_at, r.kind, r.name AS requirement
       FROM ${T}.agreement_audits a JOIN ${T}.agreement_audit_requirements r ON r.id = a.requirement_id JOIN ${T}.app_agreements g ON g.id = a.agreement_id
      WHERE (a.app_id = $1 OR g.app_id = $1) AND r.kind IN ('marketing_review', 'complaints_review') ORDER BY a.created_at DESC LIMIT 100`,
    [app.id],
  );
  const out = [];
  for (const a of rows) {
    const findings = Array.isArray(a.findings) ? (a.findings as Row[]) : [];
    for (const f of findings) {
      if (f?.status !== "open") continue;
      out.push({
        audit_id: String(a.id),
        agreement_id: String(a.agreement_id),
        kind: a.kind === "complaints_review" ? "complaints" : "marketing",
        requirement: String(a.requirement),
        finding: typeof f.title === "string" ? f.title : "Finding",
        severity: typeof f.severity === "string" ? f.severity : null,
        since: iso(typeof f.recorded_at === "string" ? f.recorded_at : a.created_at),
      });
    }
  }
  return { available: true, rows: out };
}

// The app's products whose new sales are paused: by a licence provider's covenant, or because the product drifted
// from its published composition.
async function productSignals(store: Store, app: App) {
  const covenants = await tableExists(store, "covenant_holds");
  const rows: { product_id: string; name: string; issue: "paused_by_covenant" | "drifted"; detail: string; since: string | null }[] = [];
  for (const id of app.product_ids) {
    const record = await store.getProduct(id);
    if (!record) continue;
    const name = record.product.name;
    if (record.drift) rows.push({ product_id: id, name, issue: "drifted", detail: "Drifted from its published composition: new sales are paused until it's fixed", since: record.drift.detected_at ?? null });
    if (covenants) {
      const { rows: holds } = await store.db.query(
        `SELECT h.rule_type, h.paused_at, e.name AS provider FROM ${T}.covenant_holds h JOIN ${T}.sponsorships s ON s.id = h.sponsorship_id LEFT JOIN ${T}.entities e ON e.id = h.provider_entity_id
          WHERE h.product_id = $1 AND h.released_at IS NULL AND s.status = 'approved' ORDER BY h.paused_at`,
        [id],
      );
      for (const h of holds) rows.push({ product_id: id, name, issue: "paused_by_covenant", detail: `Sales paused by ${(h.provider as string | null) ?? "a licence provider"}'s covenant (${String(h.rule_type).replace(/_/g, " ")})`, since: iso(h.paused_at) });
    }
  }
  return { available: true as const, rows };
}

export async function appRiskSignals(store: Store, app: App) {
  const [vendors, conduct, products] = await Promise.all([vendorSignals(store, app), conductSignals(store, app), productSignals(store, app)]);
  return { fraud: fraudSignals(), vendors, conduct, products };
}

// ---- ops_status ----

/** Risks whose review date has passed and that aren't closed, for ops_status. */
export async function overdueRiskReviews(db: Db): Promise<{ count: number; risks: { id: string; subject_type: string; subject_id: string; review_by: string | null }[] }> {
  const { rows } = await db.query(`SELECT id, subject_type, subject_id, review_by FROM ${T}.risk_register WHERE status <> 'closed' AND review_by < current_date ORDER BY review_by LIMIT 20`);
  const n = Number((await db.query(`SELECT count(*)::int AS n FROM ${T}.risk_register WHERE status <> 'closed' AND review_by < current_date`)).rows[0]?.n ?? 0);
  return { count: n, risks: rows.map((r) => ({ id: r.id as string, subject_type: r.subject_type as string, subject_id: r.subject_id as string, review_by: day(r.review_by) })) };
}

// ---- the tools ----

export type RiskAccess = { subject: { type: Subject; id: string; name: string }; manage: boolean; app?: App; product?: ProductRecord; audit: Record<string, unknown> };
type Access = RiskAccess;
export type RiskSides = { builder: boolean; sponsor: boolean; admin?: boolean };

export const PLATFORM_SUBJECT_NAME = "Mynt platform";
export const NOT_KEEPER = (type: Subject) => (type === "app" ? "Only the workspace's owners and admins keep its apps' risk registers" : type === "product" ? "Only the product's own firm keeps its risk register; its sponsors read it" : "Only Mynt's admins keep Mynt's own risk register");

/** Who may do what with each register, for the register's tools and a risk's own (risk-detail.ts). */
export function riskRegisterAccess(store: Store, user: User, sides: RiskSides) {
  // The caller as Mynt knows them now (roles with standing, firm).
  const me = async () => {
    const u = await store.getUser(user.id);
    return u ? { entity_id: u.entity_id, roles: effectiveRoles(u.roles) } : null;
  };
  // What the caller may do with this subject's register: read and manage, read only, or nothing (undefined).
  const access = async (type: Subject, id: string): Promise<Access | undefined> => {
    if (type === "platform") {
      // Mynt admins only, read again from the store (a role taken away ends it at once).
      if (!sides.admin || id !== PLATFORM_SUBJECT_ID || !(await me())?.roles.includes("admin")) return undefined;
      return { subject: { type, id: PLATFORM_SUBJECT_ID, name: PLATFORM_SUBJECT_NAME }, manage: true, audit: { platform: true } };
    }
    if (type === "app") {
      if (!sides.builder) return undefined;
      const app = await memberApp(store, user, id);
      if (!app) return undefined;
      return { subject: { type, id: app.id, name: app.name }, manage: MANAGERS.includes((await appRole(store, user, app)) ?? ""), app, audit: { app_id: app.id, workspace_id: app.workspace_id } };
    }
    const product = await store.getProduct(id);
    if (!product || product.owner_id === null) return undefined;
    const now = await me();
    const subject = { type, id: product.product.id, name: product.product.name };
    const audit = { product_id: product.product.id, entity_id: product.entity_id };
    if (sides.builder && (product.owner_id === user.id || (product.entity_id && now?.entity_id === product.entity_id && now.roles.includes("innovator")))) return { subject, manage: true, product, audit };
    if (sides.sponsor && now?.entity_id && now.roles.includes("license_provider")) {
      const sponsoring = await store.sponsorships({ product_id: product.product.id, provider_entity_id: now.entity_id, status: "approved" });
      if (sponsoring.length) return { subject, manage: false, product, audit };
    }
    return undefined;
  };
  const noSubject = (type: Subject, id: string) =>
    fail(type === "app" ? `No app '${id}' of yours` : type === "product" ? `No product '${id}' whose risk register you can read` : `No risk register '${id}' you can read`);
  const ownerSide = (type: Subject) => (type === "app" ? "a member of the app's workspace" : type === "product" ? "a member of the product's firm" : "a Mynt admin");
  // A risk's owner must be someone on the subject's side: a member of the app's workspace, or of the product's firm.
  const ownerOk = async (a: Access, ownerId: string) => {
    if (ownerId === user.id) return true;
    const owner = await store.getUser(ownerId);
    if (!owner) return false;
    if (a.subject.type === "platform") return owner.roles.includes("admin");
    if (a.app) return Boolean(await memberApp(store, owner, a.app.id));
    return Boolean(a.product && (a.product.owner_id === ownerId || (a.product.entity_id && owner.entity_id === a.product.entity_id)));
  };
  // Mynt's admins read (never write) any register's risks, as admin_list_risks lists them: an app's or a product's
  // risk opened from the platform's Risk register.
  const readAccess = async (type: Subject, id: string): Promise<Access | undefined> => {
    const a = await access(type, id);
    if (a || type === "platform" || !sides.admin || !(await me())?.roles.includes("admin")) return a;
    if (type === "app") {
      const app = (await store.db.query(`SELECT id::text AS id, name, workspace_id::text AS workspace_id FROM ${T}.apps WHERE id::text = $1`, [id])).rows[0];
      return app ? { subject: { type, id: app.id as string, name: app.name as string }, manage: false, audit: { app_id: app.id, workspace_id: app.workspace_id ?? null } } : undefined;
    }
    const product = await store.getProduct(id);
    return product ? { subject: { type, id: product.product.id, name: product.product.name }, manage: false, product, audit: { product_id: product.product.id, entity_id: product.entity_id } } : undefined;
  };
  return { me, access, readAccess, noSubject, ownerSide, ownerOk };
}

export function registerRiskRegisterTools(server: McpServer, store: Store, user: User, sides: RiskSides) {
  const { me, access, noSubject, ownerSide, ownerOk } = riskRegisterAccess(store, user, sides);
  const CONTROL = z.enum(CONTROL_STEPS);

  if (sides.builder || sides.admin) {
    server.registerTool(
      "add_risk",
      {
        title: "Add a risk to a register",
        description:
          "Add a risk to an app's or a financial product's risk register (the app's workspace owners and admins, or the product's own firm), or, for Mynt's admins, to the platform's own (subject_type platform, subject_id mynt). Give a title, a category (security, fraud, vendor, conduct, operational, compliance, credit, liquidity, other), its risk area (financial, compliance, third_party, operations, business_process, technology, regulated_product: required on the platform's register; otherwise the category's by default: credit and liquidity financial, compliance and conduct compliance, vendor third_party, operational and fraud operations, security technology, other none), how likely it is and how bad it would be (1-5 each; their product is the inherent score, graded by the platform's bands: by default 1-4 low, 5-9 medium, 10-14 high, 15-25 critical), and optionally how well its controls work (control_effectiveness: none, weak, partial, strong, with a control_note; the residual score is derived from it by the platform's grading, and a risk without it stands at its inherent score, control not assessed), a description, the mitigation, its owner (a member of the app's workspace or the product's firm, a Mynt admin for the platform's; you by default) and the date it's next reviewed by. It starts open. Audited.",
        inputSchema: {
          subject_type: z.enum(RISK_SUBJECTS),
          subject_id: z.string().min(1).max(200).describe("The app's id, the product's id, or mynt for the platform's register"),
          title: z.string().trim().min(3).max(200),
          category: z.enum(RISK_CATEGORIES),
          risk_area: AREA.optional().describe("The platform's risk area; required for subject_type platform"),
          description: z.string().trim().max(4000).optional(),
          likelihood: SCORE,
          impact: SCORE,
          mitigation: z.string().trim().max(4000).optional(),
          owner_user_id: UUID.optional(),
          review_by: DATE.optional(),
          control_effectiveness: CONTROL.optional().describe("How well the risk's controls work; left out: not assessed"),
          control_note: z.string().trim().max(2000).optional(),
        },
      },
      async ({ subject_type, subject_id, title, category, risk_area, description, likelihood, impact, mitigation, owner_user_id, review_by, control_effectiveness, control_note }) => {
        const a = await access(subject_type, subject_id);
        if (!a) return noSubject(subject_type, subject_id);
        if (subject_type === "platform" && !risk_area) return fail(`Give the risk's area (risk_area: ${RISK_AREAS.join(", ")}): every risk on Mynt's own register has one`);
        const area = risk_area ?? RISK_AREA_OF_CATEGORY[category];
        if (!a.manage) return fail(NOT_KEEPER(subject_type));
        const owner = owner_user_id ?? user.id;
        if (!(await ownerOk(a, owner))) return fail(`The risk's owner must be ${ownerSide(subject_type)}`);
        const id = randomUUID();
        const { grading } = await loadRiskGrading(store);
        const residual = control_effectiveness ? deriveResidual(grading, likelihood * impact, control_effectiveness) : null;
        await store.db.query(
          `INSERT INTO ${T}.risk_register (id, subject_type, subject_id, title, category, risk_area, description, likelihood, impact, owner_user_id, mitigation, review_by, created_by, control_effectiveness, control_note, residual_score)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
          [id, subject_type, a.subject.id, title, category, area, description ?? null, likelihood, impact, owner, mitigation ?? null, review_by ?? null, user.id, control_effectiveness ?? null, control_note ?? null, residual],
        );
        const risk = (await getRisk(store, id, grading))!;
        await store.audit(user.id, "add_risk", id, { subject_type, subject_id: a.subject.id, ...a.audit, title, category, risk_area: area, likelihood, impact, score: risk.score, control_effectiveness: control_effectiveness ?? null, scores: { before: null, after: scoresOf(risk) }, status: risk.status, owner_user_id: owner, review_by: review_by ?? null });
        return json({ subject: a.subject, risk });
      },
    );

    server.registerTool(
      "update_risk",
      {
        title: "Review a risk",
        description:
          "Review a risk on a register you keep (see add_risk): change its status (open, mitigating, accepted, closed), risk area, mitigation, likelihood and impact (the inherent score), how well its controls work (control_effectiveness: none, weak, partial, strong, with a control_note), owner, or the date it's next reviewed by. The residual score is derived from the inherent score and the control by the platform's grading; to set it yourself instead, pass residual_likelihood and residual_impact (1-5 each) with residual_override_reason (an override: who, when and why are kept, and the grading never re-derives it), and clear_residual_override to go back to the derived one. Accepting or closing a risk needs a note saying why. Only what you pass changes; every change is audited with what it was and what it became and the scores before and after, and get_risk shows that history.",
        inputSchema: {
          risk_id: UUID,
          status: z.enum(RISK_STATUSES).optional(),
          risk_area: AREA.optional(),
          mitigation: z.string().trim().max(4000).optional(),
          likelihood: SCORE.optional(),
          impact: SCORE.optional(),
          owner_user_id: UUID.optional(),
          review_by: DATE.optional(),
          control_effectiveness: CONTROL.optional(),
          control_note: z.string().trim().max(2000).optional(),
          residual_likelihood: SCORE.optional().describe("An override: your own residual likelihood (with residual_impact and residual_override_reason)"),
          residual_impact: SCORE.optional(),
          residual_override_reason: z.string().trim().min(3).max(2000).optional().describe("Why the derived residual score doesn't fit"),
          clear_residual_override: z.boolean().optional().describe("true: drop the override and derive the residual score again"),
          note: z.string().trim().max(2000).optional().describe("Why: needed to accept or close a risk"),
        },
      },
      async ({ risk_id, status, risk_area, mitigation, likelihood, impact, owner_user_id, review_by, control_effectiveness, control_note, residual_likelihood, residual_impact, residual_override_reason, clear_residual_override, note }) => {
        const { grading } = await loadRiskGrading(store);
        const before = await getRisk(store, risk_id, grading);
        const a = before ? await access(before.subject_type, before.subject_id) : undefined;
        if (!before || !a) return fail(`No risk '${risk_id}' on a register you keep`);
        if (!a.manage) return fail(NOT_KEEPER(before.subject_type));
        const overriding = residual_likelihood !== undefined || residual_impact !== undefined || residual_override_reason !== undefined;
        if (overriding && clear_residual_override) return fail("Pass an override or clear_residual_override, not both");
        if (overriding && (residual_likelihood === undefined || residual_impact === undefined || !residual_override_reason)) return fail("An override needs residual_likelihood, residual_impact and residual_override_reason (why the derived score doesn't fit)");
        if (clear_residual_override && !before.residual.overridden) return fail("This risk's residual score isn't overridden");
        if ((status === "accepted" || status === "closed") && status !== before.status && !note) return fail(`Say why the risk is ${status} (note)`);
        if (owner_user_id && !(await ownerOk(a, owner_user_id))) return fail(`The risk's owner must be ${ownerSide(before.subject_type)}`);
        const next: Record<string, unknown> = { status, risk_area, mitigation, likelihood, impact, owner_user_id, review_by, control_effectiveness, control_note };
        const was: Record<string, unknown> = { status: before.status, risk_area: before.risk_area, mitigation: before.mitigation, likelihood: before.likelihood, impact: before.impact, owner_user_id: before.owner?.user_id ?? null, review_by: before.review_by, control_effectiveness: before.control.effectiveness, control_note: before.control.note };
        const changes: Record<string, { from: unknown; to: unknown }> = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && v !== was[k]).map(([k, v]) => [k, { from: was[k], to: v }]));
        const cols = Object.keys(changes);
        // The override: set, replaced or dropped.
        const override = overriding ? { likelihood: residual_likelihood!, impact: residual_impact! } : clear_residual_override ? null : before.residual.overridden ? { likelihood: before.residual.likelihood!, impact: before.residual.impact! } : null;
        const overrideChanged = clear_residual_override || (overriding && (override!.likelihood !== before.residual.likelihood || override!.impact !== before.residual.impact || residual_override_reason !== before.residual.override?.why));
        if (overrideChanged)
          changes.residual_override = {
            from: before.residual.overridden ? { likelihood: before.residual.likelihood, impact: before.residual.impact, why: before.residual.override?.why ?? null } : null,
            to: override ? { ...override, why: residual_override_reason } : null,
          };
        if (!Object.keys(changes).length) return fail("Nothing to change: pass what's different");
        // The residual score as it stands after this change: the override's, else derived, else none (control not assessed).
        const l = (changes.likelihood?.to as number | undefined) ?? before.likelihood;
        const i = (changes.impact?.to as number | undefined) ?? before.impact;
        const step = ((changes.control_effectiveness?.to as ControlStep | undefined) ?? before.control.effectiveness) as ControlStep | null;
        const residual = override ? override.likelihood * override.impact : step ? deriveResidual(grading, l * i, step) : null;
        const sets = cols.map((c, n) => `${c} = $${n + 2}`);
        const params: unknown[] = [risk_id, ...cols.map((c) => changes[c].to)];
        const set = (col: string, v: unknown) => (params.push(v), sets.push(`${col} = $${params.length}`));
        set("residual_score", residual);
        if (overrideChanged) {
          set("residual_likelihood", override?.likelihood ?? null);
          set("residual_impact", override?.impact ?? null);
          set("residual_overridden_by", override ? user.id : null);
          set("residual_override_reason", override ? residual_override_reason : null);
          sets.push(`residual_overridden_at = ${override ? "now()" : "NULL"}`);
        }
        await store.db.query(`UPDATE ${T}.risk_register SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
        const risk = (await getRisk(store, risk_id, grading))!;
        await store.audit(user.id, "update_risk", risk_id, { subject_type: risk.subject_type, subject_id: risk.subject_id, ...a.audit, changes, score: risk.score, scores: { before: scoresOf(before), after: scoresOf(risk) }, status: risk.status, note: note ?? null });
        return json({ subject: a.subject, risk, changed: Object.keys(changes) });
      },
    );
  }

  server.registerTool(
    "list_risks",
    {
      title: "A risk register",
      description:
        "An app's or a financial product's risk register: each risk with its category, its three scores (inherent: likelihood × impact with its level; control: how well its controls work, or not assessed; residual: derived by the platform's grading or overridden, with its level; a risk whose control isn't assessed stands at its inherent score and says so), owner, mitigation, status, review-by date and whether that review is overdue, highest residual score first, with counts by status and by residual level. Any member of the app's workspace reads an app's; the product's own firm, and the licence providers sponsoring it (read-only), read a product's; Mynt's admins read and keep the platform's (subject_type platform, subject_id mynt). can_manage says whether you may add and review risks. Filter by status, category, risk_area (one area, or unassigned: none), residual_level (low, medium, high, critical) or overdue_only. With risk_id: that one risk and its history (every change, from the audit trail; get_risk adds its factors, treatment tasks, controls and links). For an app, signals lists what Mynt measures around it, each a list or not available with why: fraud, vendors (failing conformance, erroring calls, ended subscriptions or contracts), conduct (open findings from marketing and complaints audits of its agreements) and products (sales paused by a covenant, or drifted).",
      inputSchema: {
        subject_type: z.enum(RISK_SUBJECTS),
        subject_id: z.string().min(1).max(200),
        status: z.enum(RISK_STATUSES).optional(),
        category: z.enum(RISK_CATEGORIES).optional(),
        risk_area: AREA_FILTER.optional(),
        overdue_only: z.boolean().default(false),
        residual_level: z.enum(RISK_LEVEL_KEYS).optional(),
        risk_id: UUID.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ subject_type, subject_id, status, category, risk_area, overdue_only, residual_level, risk_id }) => {
      const a = await access(subject_type, subject_id);
      if (!a) return noSubject(subject_type, subject_id);
      const { grading } = await loadRiskGrading(store);
      if (risk_id) {
        const risk = await getRisk(store, risk_id, grading);
        if (!risk || risk.subject_type !== subject_type || risk.subject_id !== a.subject.id) return fail(`No risk '${risk_id}' on this register`);
        return json({ subject: a.subject, can_manage: a.manage, risk, history: await riskHistory(store, risk_id) });
      }
      const { rows } = await store.db.query(
        `${SELECT} WHERE r.subject_type = $1 AND r.subject_id = $2 AND ($3::text IS NULL OR r.status = $3) AND ($4::text IS NULL OR r.category = $4)
          AND (NOT $5::boolean OR (r.status <> 'closed' AND r.review_by < current_date)) AND ${areaWhere("r.risk_area", 6)} ORDER BY ${RESIDUAL_SQL} DESC, r.likelihood * r.impact DESC, r.created_at DESC LIMIT 500`,
        [subject_type, a.subject.id, status ?? null, category ?? null, overdue_only, risk_area ?? null],
      );
      const risks = rows.map((r) => toRisk(r, grading)).filter((r) => !residual_level || r.residual.level === residual_level);
      const all = (await store.db.query(`${SELECT} WHERE r.subject_type = $1 AND r.subject_id = $2`, [subject_type, a.subject.id])).rows.map((r) => toRisk(r, grading));
      const counts = Object.fromEntries(RISK_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length])) as Record<string, number>;
      counts.overdue = all.filter((r) => r.overdue).length;
      // Risks not yet closed, by the level of their residual score.
      const residual_levels = Object.fromEntries(RISK_LEVEL_KEYS.map((k) => [k, all.filter((r) => r.status !== "closed" && r.residual.level === k).length]));
      return json({ subject: a.subject, can_manage: a.manage, risks, counts, residual_levels, level_names: grading.levels, ...(a.app ? { signals: await appRiskSignals(store, a.app) } : {}) });
    },
  );

  if (sides.admin) {
    server.registerTool(
      "admin_list_risks",
      {
        title: "Open risks across Mynt",
        description:
          "Admin: the risks not yet closed on every register (apps', products' and the platform's own), or one kind (subject_type), or one risk area (risk_area; unassigned: those with none): counts by inherent level (critical, high, medium, low) and by residual level (residual_counts), how many are overdue for review, the total, and the risks with the highest residual score (then the inherent score, then the earliest review date), each with its three scores (inherent, control, residual; a risk whose control isn't assessed stands at its inherent score and says so) and its subject's name. Filter the list by residual_level.",
        inputSchema: { limit: z.number().int().min(1).max(100).default(20), subject_type: z.enum(RISK_SUBJECTS).optional(), risk_area: AREA_FILTER.optional(), residual_level: z.enum(RISK_LEVEL_KEYS).optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ limit, subject_type, risk_area, residual_level }) => {
        if (!(await me())?.roles.includes("admin")) return fail("Only Mynt's admins read every risk register");
        const { grading } = await loadRiskGrading(store);
        const open = `r.status <> 'closed' AND ($1::text IS NULL OR r.subject_type = $1) AND ${areaWhere("r.risk_area", 2)}`;
        const all = (
          await store.db.query(`${SELECT} WHERE ${open} ORDER BY ${RESIDUAL_SQL} DESC, r.likelihood * r.impact DESC, r.review_by ASC NULLS LAST, r.created_at DESC`, [subject_type ?? null, risk_area ?? null])
        ).rows.map((r) => toRisk(r, grading));
        const counts = { critical: 0, high: 0, medium: 0, low: 0 };
        const residual_counts = { critical: 0, high: 0, medium: 0, low: 0 };
        for (const x of all) {
          counts[x.level] += 1;
          residual_counts[x.residual.level] += 1;
        }
        const overdue = all.filter((x) => x.overdue).length;
        const risks = [];
        for (const risk of all.filter((x) => !residual_level || x.residual.level === residual_level).slice(0, limit)) {
          // Where it lives, so a reader can link to it: an app's workspace, a product's own firm (null for a reference product).
          if (risk.subject_type === "platform") risks.push({ ...risk, subject_name: PLATFORM_SUBJECT_NAME });
          else if (risk.subject_type === "app") {
            const a = (await store.db.query(`SELECT name, workspace_id::text AS workspace_id FROM ${T}.apps WHERE id::text = $1`, [risk.subject_id])).rows[0];
            risks.push({ ...risk, subject_name: (a?.name as string | undefined) ?? null, workspace_id: (a?.workspace_id as string | null | undefined) ?? null });
          } else {
            const p = await store.getProduct(risk.subject_id);
            risks.push({ ...risk, subject_name: p?.product.name ?? null, firm_id: p?.entity_id ?? null });
          }
        }
        return json({ counts, residual_counts, level_names: grading.levels, overdue, total: all.length, risks });
      },
    );
  }
}
