import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { memberFirms } from "./app-agreements.js";
import type { Db } from "./db.js";
import { RISK_CATEGORIES, RISK_STATUSES, RISK_SUBJECTS } from "./risk-register-schema.js";
import { effectiveRoles, type App, type ProductRecord, type Store, type User } from "./store.js";
import { appRole, memberApp } from "./workspaces.js";

// A risk register, one shape for apps and financial products: each risk with its category, likelihood and impact (1-5
// each; the score is their product), an owner, the mitigation, a status (open, mitigating, accepted, closed) and the
// date it's next reviewed by.
//
// Who keeps it: for an app, its workspace's owners and admins (any member reads it); for a product, its own firm (the
// product's owner, or a builder at the firm it belongs to). A licence provider sponsoring the product (an approved
// sponsorship) reads the product's register and never writes it. Every change is audited with the app's or product's
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
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);

/** A 5×5 score's level: 1-4 low, 5-9 medium, 10-14 high, 15-25 critical. */
export function riskLevel(score: number): "low" | "medium" | "high" | "critical" {
  return score <= 4 ? "low" : score <= 9 ? "medium" : score <= 14 ? "high" : "critical";
}

export interface Risk {
  id: string;
  subject_type: Subject;
  subject_id: string;
  title: string;
  category: (typeof RISK_CATEGORIES)[number];
  description: string | null;
  likelihood: number;
  impact: number;
  score: number;
  level: ReturnType<typeof riskLevel>;
  owner: { user_id: string; name: string | null } | null;
  mitigation: string | null;
  status: (typeof RISK_STATUSES)[number];
  review_by: string | null;
  overdue: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const toRisk = (r: Row): Risk => {
  const likelihood = Number(r.likelihood);
  const impact = Number(r.impact);
  const review_by = day(r.review_by);
  const status = r.status as Risk["status"];
  return {
    id: r.id as string,
    subject_type: r.subject_type as Subject,
    subject_id: r.subject_id as string,
    title: r.title as string,
    category: r.category as Risk["category"],
    description: (r.description as string | null) ?? null,
    likelihood,
    impact,
    score: likelihood * impact,
    level: riskLevel(likelihood * impact),
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

async function getRisk(store: Store, id: string): Promise<Risk | undefined> {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`${SELECT} WHERE r.id = $1`, [id])).rows[0];
  return r ? toRisk(r) : undefined;
}

const tableExists = async (store: Store, table: string) => Boolean((await store.db.query(`SELECT to_regclass('${T}.${table}') IS NOT NULL AS ok`)).rows[0]?.ok);

// ---- the signals around an app ----

type Signal<R> = { available: true; rows: R[] } | { available: false; reason: string };

// Mynt records no fraud or velocity signals from customer sessions: client sessions carry who and what, not risk.
const fraudSignals = (): Signal<never> => ({ available: false, reason: "Not measured yet: Mynt records no fraud or velocity signals from customer sessions." });

// The vendor services the app's workspace relies on that are failing: the offering's latest conformance run failed,
// most of its calls in the last week erred, or the subscription or a vendor contract has ended.
async function vendorSignals(store: Store, app: App) {
  const firms = await memberFirms(store, app);
  const rows: { subscription_id: string | null; agreement_id: string | null; vendor: string | null; offering: string | null; issue: string; detail: string; since: string | null }[] = [];
  if (firms.length) {
    const { rows: subs } = await store.db.query(
      `SELECT s.id, s.status, s.live, s.created_at, s.ended_at, o.id AS offering_id, o.name AS offering, e.name AS vendor,
              (SELECT r.passed FROM ${T}.vendor_conformance_runs r WHERE r.offering_id = o.id ORDER BY r.created_at DESC LIMIT 1) AS last_passed,
              (SELECT r.created_at FROM ${T}.vendor_conformance_runs r WHERE r.offering_id = o.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_at,
              (SELECT coalesce(sum(u.ok + u.errors), 0)::int FROM ${T}.vendor_usage u WHERE u.subscription_id = s.id AND u.day > current_date - 7) AS calls,
              (SELECT coalesce(sum(u.errors), 0)::int FROM ${T}.vendor_usage u WHERE u.subscription_id = s.id AND u.day > current_date - 7) AS errors
         FROM ${T}.vendor_subscriptions s JOIN ${T}.vendor_offerings o ON o.id = s.offering_id LEFT JOIN ${T}.entities e ON e.id = o.entity_id
        WHERE s.entity_id = ANY($1::uuid[]) AND (s.status = 'active' OR s.ended_at > now() - interval '90 days')
        ORDER BY s.created_at`,
      [firms],
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

// Open findings from oversight audits of the app's agreements, of the marketing and complaints kinds. The audits
// come with a later version of Mynt: until its table is here, this says so.
async function conductSignals(store: Store, app: App): Promise<Signal<{ audit_id: string; agreement_id: string | null; kind: string; finding: string; severity: string | null; since: string | null }>> {
  if (!(await tableExists(store, "agreement_audits"))) return { available: false, reason: "Not available yet: oversight audits of agreements come with Mynt's next update." };
  try {
    const { rows } = await store.db.query(
      `SELECT a.* FROM ${T}.agreement_audits a JOIN ${T}.app_agreements g ON g.id = a.agreement_id
        WHERE g.app_id = $1 AND a.kind IN ('marketing', 'complaints') ORDER BY a.created_at DESC LIMIT 50`,
      [app.id],
    );
    const out = [];
    for (const a of rows) {
      const findings = Array.isArray(a.findings) ? (a.findings as Row[]) : [];
      for (const f of findings) {
        const status = typeof f?.status === "string" ? f.status : "open";
        if (["closed", "resolved", "remediated"].includes(status)) continue;
        out.push({
          audit_id: String(a.id),
          agreement_id: (a.agreement_id as string | null) ?? null,
          kind: String(a.kind),
          finding: typeof f?.title === "string" ? f.title : typeof f?.summary === "string" ? f.summary : "Finding",
          severity: typeof f?.severity === "string" ? f.severity : null,
          since: iso(a.created_at),
        });
      }
    }
    return { available: true, rows: out };
  } catch {
    return { available: false, reason: "Not available yet: this server's agreement audits aren't in a shape the risk register reads." };
  }
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

type Access = { subject: { type: Subject; id: string; name: string }; manage: boolean; app?: App; product?: ProductRecord; audit: Record<string, unknown> };

export function registerRiskRegisterTools(server: McpServer, store: Store, user: User, sides: { builder: boolean; sponsor: boolean }) {
  // The caller as Mynt knows them now (roles with standing, firm).
  const me = async () => {
    const u = await store.getUser(user.id);
    return u ? { entity_id: u.entity_id, roles: effectiveRoles(u.roles) } : null;
  };
  // What the caller may do with this subject's register: read and manage, read only, or nothing (undefined).
  const access = async (type: Subject, id: string): Promise<Access | undefined> => {
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
  const noSubject = (type: Subject, id: string) => fail(type === "app" ? `No app '${id}' of yours` : `No product '${id}' whose risk register you can read`);
  // A risk's owner must be someone on the subject's side: a member of the app's workspace, or of the product's firm.
  const ownerOk = async (a: Access, ownerId: string) => {
    if (ownerId === user.id) return true;
    const owner = await store.getUser(ownerId);
    if (!owner) return false;
    if (a.app) return Boolean(await memberApp(store, owner, a.app.id));
    return Boolean(a.product && (a.product.owner_id === ownerId || (a.product.entity_id && owner.entity_id === a.product.entity_id)));
  };

  if (sides.builder) {
    server.registerTool(
      "add_risk",
      {
        title: "Add a risk to a register",
        description:
          "Add a risk to an app's or a financial product's risk register: the app's workspace owners and admins, or the product's own firm. Give a title, a category (security, fraud, vendor, conduct, operational, compliance, credit, liquidity, other), how likely it is and how bad it would be (1-5 each; the score is their product: 1-4 low, 5-9 medium, 10-14 high, 15-25 critical), and optionally a description, the mitigation, its owner (a member of the app's workspace or the product's firm; you by default) and the date it's next reviewed by. It starts open. Audited.",
        inputSchema: {
          subject_type: z.enum(RISK_SUBJECTS),
          subject_id: z.string().min(1).max(200).describe("The app's id, or the product's id"),
          title: z.string().trim().min(3).max(200),
          category: z.enum(RISK_CATEGORIES),
          description: z.string().trim().max(4000).optional(),
          likelihood: SCORE,
          impact: SCORE,
          mitigation: z.string().trim().max(4000).optional(),
          owner_user_id: UUID.optional(),
          review_by: DATE.optional(),
        },
      },
      async ({ subject_type, subject_id, title, category, description, likelihood, impact, mitigation, owner_user_id, review_by }) => {
        const a = await access(subject_type, subject_id);
        if (!a) return noSubject(subject_type, subject_id);
        if (!a.manage) return fail(subject_type === "app" ? "Only the workspace's owners and admins keep its apps' risk registers" : "Only the product's own firm keeps its risk register; its sponsors read it");
        const owner = owner_user_id ?? user.id;
        if (!(await ownerOk(a, owner))) return fail(`The risk's owner must be a member of ${subject_type === "app" ? "the app's workspace" : "the product's firm"}`);
        const id = randomUUID();
        await store.db.query(
          `INSERT INTO ${T}.risk_register (id, subject_type, subject_id, title, category, description, likelihood, impact, owner_user_id, mitigation, review_by, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [id, subject_type, a.subject.id, title, category, description ?? null, likelihood, impact, owner, mitigation ?? null, review_by ?? null, user.id],
        );
        const risk = (await getRisk(store, id))!;
        await store.audit(user.id, "add_risk", id, { subject_type, subject_id: a.subject.id, ...a.audit, title, category, likelihood, impact, score: risk.score, status: risk.status, owner_user_id: owner, review_by: review_by ?? null });
        return json({ subject: a.subject, risk });
      },
    );

    server.registerTool(
      "update_risk",
      {
        title: "Review a risk",
        description:
          "Review a risk on a register you keep (see add_risk): change its status (open, mitigating, accepted, closed), mitigation, likelihood and impact, owner, or the date it's next reviewed by. Accepting or closing a risk needs a note saying why. Only what you pass changes; every change is audited with what it was and what it became, and list_risks with risk_id shows that history.",
        inputSchema: {
          risk_id: UUID,
          status: z.enum(RISK_STATUSES).optional(),
          mitigation: z.string().trim().max(4000).optional(),
          likelihood: SCORE.optional(),
          impact: SCORE.optional(),
          owner_user_id: UUID.optional(),
          review_by: DATE.optional(),
          note: z.string().trim().max(2000).optional().describe("Why: needed to accept or close a risk"),
        },
      },
      async ({ risk_id, status, mitigation, likelihood, impact, owner_user_id, review_by, note }) => {
        const before = await getRisk(store, risk_id);
        const a = before ? await access(before.subject_type, before.subject_id) : undefined;
        if (!before || !a) return fail(`No risk '${risk_id}' on a register you keep`);
        if (!a.manage) return fail(before.subject_type === "app" ? "Only the workspace's owners and admins keep its apps' risk registers" : "Only the product's own firm keeps its risk register; its sponsors read it");
        if ((status === "accepted" || status === "closed") && status !== before.status && !note) return fail(`Say why the risk is ${status} (note)`);
        if (owner_user_id && !(await ownerOk(a, owner_user_id))) return fail(`The risk's owner must be a member of ${before.subject_type === "app" ? "the app's workspace" : "the product's firm"}`);
        const next: Record<string, unknown> = { status, mitigation, likelihood, impact, owner_user_id, review_by };
        const was: Record<string, unknown> = { status: before.status, mitigation: before.mitigation, likelihood: before.likelihood, impact: before.impact, owner_user_id: before.owner?.user_id ?? null, review_by: before.review_by };
        const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && v !== was[k]).map(([k, v]) => [k, { from: was[k], to: v }]));
        if (!Object.keys(changes).length) return fail("Nothing to change: pass what's different");
        const cols = Object.keys(changes);
        await store.db.query(`UPDATE ${T}.risk_register SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [risk_id, ...cols.map((c) => changes[c].to)]);
        const risk = (await getRisk(store, risk_id))!;
        await store.audit(user.id, "update_risk", risk_id, { subject_type: risk.subject_type, subject_id: risk.subject_id, ...a.audit, changes, score: risk.score, status: risk.status, note: note ?? null });
        return json({ subject: a.subject, risk, changed: cols });
      },
    );
  }

  server.registerTool(
    "list_risks",
    {
      title: "A risk register",
      description:
        "An app's or a financial product's risk register: each risk with its category, likelihood × impact score and level, owner, mitigation, status, review-by date and whether that review is overdue, newest first, with counts by status. Any member of the app's workspace reads an app's; the product's own firm, and the licence providers sponsoring it (read-only), read a product's. can_manage says whether you may add and review risks. Filter by status, category or overdue_only. With risk_id: that one risk and its history (every change, from the audit trail). For an app, signals lists what Mynt measures around it, each a list or not available with why: fraud, vendors (failing conformance, erroring calls, ended subscriptions or contracts), conduct (open findings from marketing and complaints audits of its agreements) and products (sales paused by a covenant, or drifted).",
      inputSchema: {
        subject_type: z.enum(RISK_SUBJECTS),
        subject_id: z.string().min(1).max(200),
        status: z.enum(RISK_STATUSES).optional(),
        category: z.enum(RISK_CATEGORIES).optional(),
        overdue_only: z.boolean().default(false),
        risk_id: UUID.optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ subject_type, subject_id, status, category, overdue_only, risk_id }) => {
      const a = await access(subject_type, subject_id);
      if (!a) return noSubject(subject_type, subject_id);
      if (risk_id) {
        const risk = await getRisk(store, risk_id);
        if (!risk || risk.subject_type !== subject_type || risk.subject_id !== a.subject.id) return fail(`No risk '${risk_id}' on this register`);
        const { rows } = await store.db.query(
          `SELECT l.action, l.details, l.created_at, l.actor_id, u.name AS actor FROM ${T}.audit_log l LEFT JOIN ${T}.users u ON u.id = l.actor_id
            WHERE l.target = $1 AND l.action IN ('add_risk', 'update_risk') ORDER BY l.created_at, l.id`,
          [risk_id],
        );
        const history = rows.map((r) => {
          const d = (r.details ?? {}) as Row;
          return { at: iso(r.created_at), action: r.action, actor: r.actor_id ? { user_id: r.actor_id, name: (r.actor as string | null) ?? null } : null, changes: d.changes ?? null, note: d.note ?? null };
        });
        return json({ subject: a.subject, can_manage: a.manage, risk, history });
      }
      const { rows } = await store.db.query(
        `${SELECT} WHERE r.subject_type = $1 AND r.subject_id = $2 AND ($3::text IS NULL OR r.status = $3) AND ($4::text IS NULL OR r.category = $4)
          AND (NOT $5::boolean OR (r.status <> 'closed' AND r.review_by < current_date)) ORDER BY r.created_at DESC LIMIT 500`,
        [subject_type, a.subject.id, status ?? null, category ?? null, overdue_only],
      );
      const risks = rows.map(toRisk);
      const all = (await store.db.query(`SELECT status, review_by FROM ${T}.risk_register WHERE subject_type = $1 AND subject_id = $2`, [subject_type, a.subject.id])).rows;
      const counts = Object.fromEntries(RISK_STATUSES.map((s) => [s, all.filter((r) => r.status === s).length])) as Record<string, number>;
      counts.overdue = all.filter((r) => r.status !== "closed" && r.review_by && day(r.review_by)! < today()).length;
      return json({ subject: a.subject, can_manage: a.manage, risks, counts, ...(a.app ? { signals: await appRiskSignals(store, a.app) } : {}) });
    },
  );
}
