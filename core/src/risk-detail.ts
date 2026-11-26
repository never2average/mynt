import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadRiskGrading, methodWords } from "./risk-grading.js";
import { getRisk, NOT_KEEPER, riskHistory, riskRegisterAccess, type Risk, type RiskAccess, type RiskSides } from "./risk-register.js";
import { CONTROL_KINDS, CONTROL_TEST_RESULTS, RISK_FACTOR_KINDS, RISK_LINK_TARGETS, TREATMENT_EFFECTIVENESS, TREATMENT_STATUSES } from "./risk-register-schema.js";
import type { Store, User } from "./store.js";
import { memberApp } from "./workspaces.js";

// One risk, in full (get_risk), and what its keeper adds under it. Everything here follows the register's own rules
// (risk-register.ts riskRegisterAccess): whoever keeps the register writes, whoever reads it reads, and Mynt's admins
// also read (never write) an app's or a product's risk. Every write is audited against the risk's id, so the audit
// trail is the risk's history.
//
// - FACTORS explain the three scores: impact factors, likelihood factors and control factors, each scored 1-5 with a
//   rationale and a source (an https link, or type:id of something on Mynt). They explain; they don't set: the
//   keeper's likelihood, impact and control effectiveness stay the scores, and each list's average is shown beside
//   the score it explains.
// - TREATMENT TASKS are the work that brings the risk down: an owner, a due date, a status (todo, doing, done,
//   dropped), a progress note and, once done, whether it worked (not_assessed, ineffective, partly_effective,
//   effective).
// - CONTROLS keep it down: preventive, detective or corrective, with when each was last tested and the result
//   (passed, gaps_found, failed; not tested until someone says). A finished treatment task can become a control.
// - LINKS say what the risk is about: an app, a product, a vendor's offering, an agreement, an oversight audit, an
//   audit-trail entry, one of Mynt's risk models or a firm. You can link what you can read; a link's name is shown
//   only to someone who may read the thing it points at.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

type Row = Record<string, unknown>;
type LinkTarget = (typeof RISK_LINK_TARGETS)[number];
const UUID = z.string().uuid();
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD");
const SCORE = z.number().int().min(1).max(5);
const TARGET_ID = z.string().trim().regex(/^[A-Za-z0-9_-]{1,200}$/, "An id: letters, digits, dashes and underscores");
// Where a factor comes from: an https link, or something on Mynt as type:id (app:<id>, agreement_audit:<id>, …).
const REFERENCE = new RegExp(`^(${RISK_LINK_TARGETS.join("|")}):([A-Za-z0-9_-]{1,200})$`);
const SOURCE = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https:\/\/\S+$/.test(v) || REFERENCE.test(v), `An https link, or something on Mynt as type:id (type: ${RISK_LINK_TARGETS.join(", ")})`);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const today = () => new Date().toISOString().slice(0, 10);
const words = (v: string) => v.replace(/_/g, " ");
const person = (id: unknown, name: unknown) => (id ? { user_id: id as string, name: (name as string | null) ?? null } : null);

export const TARGET_WORDS: Record<LinkTarget, string> = {
  app: "App",
  product: "Product",
  vendor_offering: "Vendor service",
  agreement: "Agreement",
  agreement_audit: "Oversight audit",
  audit_entry: "Audit-trail entry",
  risk_model: "Risk model",
  firm: "Firm",
};

/** The risks linked to one of Mynt's risk models, for its page (risk-models.ts): highest residual first. */
export async function risksLinkedToModel(store: Store, modelId: string) {
  const { grading } = await loadRiskGrading(store);
  const { rows } = await store.db.query(`SELECT l.id AS link_id, l.risk_id, l.note FROM ${T}.risk_links l WHERE l.target_type = 'risk_model' AND l.target_id = $1 ORDER BY l.created_at`, [modelId]);
  const out = [];
  for (const l of rows) {
    const risk = await getRisk(store, l.risk_id as string, grading);
    if (!risk) continue;
    let source = "Mynt";
    if (risk.subject_type === "app") source = `App: ${((await store.db.query(`SELECT name FROM ${T}.apps WHERE id::text = $1`, [risk.subject_id])).rows[0]?.name as string | undefined) ?? "Unnamed"}`;
    else if (risk.subject_type === "product") source = `Product: ${(await store.getProduct(risk.subject_id))?.product.name ?? "Unnamed"}`;
    out.push({ link_id: l.link_id as string, note: (l.note as string | null) ?? null, source, risk });
  }
  return out.sort((a, b) => b.risk.residual.score - a.risk.residual.score);
}

export function registerRiskDetailTools(server: McpServer, store: Store, user: User, sides: RiskSides) {
  const { me, access, readAccess, ownerOk, ownerSide } = riskRegisterAccess(store, user, sides);
  const isAdmin = async () => Boolean(sides.admin && (await me())?.roles.includes("admin"));

  // The risk and what the caller may do with its register; `write` refuses a reader.
  const open = async (riskId: string, write: boolean): Promise<{ ok: true; risk: Risk; a: RiskAccess } | { ok: false; error: string }> => {
    const risk = await getRisk(store, riskId);
    const a = risk ? await (write ? access : readAccess)(risk.subject_type, risk.subject_id) : undefined;
    if (!risk || !a) return { ok: false, error: `No risk '${riskId}' on a register you ${write ? "keep" : "can read"}` };
    if (write && !a.manage) return { ok: false, error: NOT_KEEPER(risk.subject_type) };
    return { ok: true, risk, a };
  };
  const scores = (r: Risk) => ({ inherent: r.inherent.score, control: r.control.effectiveness, residual: r.residual.score });
  // Every write under a risk is audited against the risk itself, with what happened in words: that is its history.
  const base = (risk: Risk, a: RiskAccess, what: string, more: Row = {}) => ({ subject_type: risk.subject_type, subject_id: risk.subject_id, ...a.audit, what, scores: { before: scores(risk), after: scores(risk) }, ...more });

  // The name of something a risk links to, when it exists and the caller may read it; null otherwise (said the same
  // way for both, so a link never tells a reader whether something they can't see exists).
  const targetName = async (type: LinkTarget, id: string): Promise<string | null> => {
    const admin = await isAdmin();
    const now = await me();
    const one = async (sql: string) => (await store.db.query(sql, [id])).rows[0] as Row | undefined;
    const mine = async (appId: unknown) => Boolean(appId && (await memberApp(store, user, String(appId))));
    if (type === "app") {
      if (admin) return ((await one(`SELECT name FROM ${T}.apps WHERE id::text = $1`))?.name as string | undefined) ?? null;
      return (await memberApp(store, user, id))?.name ?? null;
    }
    if (type === "product") {
      const p = await store.getProduct(id);
      if (!p) return null;
      const own = p.owner_id === user.id || Boolean(p.entity_id && now?.entity_id === p.entity_id);
      return admin || own || p.status === "published" ? p.product.name : null;
    }
    if (type === "vendor_offering") {
      const o = await one(`SELECT o.name, o.status, o.entity_id::text AS entity_id, e.name AS vendor FROM ${T}.vendor_offerings o LEFT JOIN ${T}.entities e ON e.id = o.entity_id WHERE o.id::text = $1`);
      if (!o || !(admin || o.status === "listed" || (now?.entity_id && o.entity_id === now.entity_id))) return null;
      return `${o.name as string}${o.vendor ? ` (${o.vendor as string})` : ""}`;
    }
    if (type === "agreement") {
      const g = await one(`SELECT g.kind, g.app_id::text AS app_id, g.counterparty_entity_id::text AS counterparty, e.name AS firm FROM ${T}.app_agreements g LEFT JOIN ${T}.entities e ON e.id = g.counterparty_entity_id WHERE g.id::text = $1`);
      if (!g || !(admin || (now?.entity_id && g.counterparty === now.entity_id) || (await mine(g.app_id)))) return null;
      return `${words(String(g.kind))} agreement with ${(g.firm as string | null) ?? "a firm"}`.replace(/^./, (c) => c.toUpperCase());
    }
    if (type === "agreement_audit") {
      const x = await one(
        `SELECT r.name, x.app_id::text AS app_id, g.app_id::text AS agreement_app, g.counterparty_entity_id::text AS counterparty FROM ${T}.agreement_audits x JOIN ${T}.agreement_audit_requirements r ON r.id = x.requirement_id JOIN ${T}.app_agreements g ON g.id = x.agreement_id WHERE x.id::text = $1`,
      );
      if (!x || !(admin || (now?.entity_id && x.counterparty === now.entity_id) || (await mine(x.app_id ?? x.agreement_app)))) return null;
      return `Audit: ${x.name as string}`;
    }
    if (type === "audit_entry") {
      const l = await one(`SELECT action, created_at, details->>'app_id' AS app_id FROM ${T}.audit_log WHERE id::text = $1`);
      if (!l || !(admin || (await mine(l.app_id)))) return null;
      return `${words(String(l.action))} (${day(l.created_at)})`;
    }
    if (type === "risk_model") {
      if (!admin) return null;
      return ((await one(`SELECT v.name FROM ${T}.risk_models m JOIN ${T}.risk_model_versions v ON v.model_id = m.id AND v.version = m.version WHERE m.id::text = $1`))?.name as string | undefined) ?? null;
    }
    const firm = await one(`SELECT name FROM ${T}.entities WHERE id::text = $1`);
    return firm && (admin || now?.entity_id === id) ? (firm.name as string) : null;
  };
  // A factor's source as a reader sees it: a link, or a reference with its name when they may read it.
  const sourceOf = async (source: string | null) => {
    if (!source) return null;
    const ref = REFERENCE.exec(source);
    if (!ref) return { kind: "link" as const, url: source };
    const type = ref[1] as LinkTarget;
    return { kind: "reference" as const, target_type: type, target_id: ref[2], type_words: TARGET_WORDS[type], name: await targetName(type, ref[2]) };
  };

  const factorsOf = async (riskId: string) => {
    const { rows } = await store.db.query(`SELECT f.*, u.name AS author FROM ${T}.risk_factors f LEFT JOIN ${T}.users u ON u.id = f.created_by WHERE f.risk_id = $1 ORDER BY f.created_at, f.id`, [riskId]);
    const out = [];
    for (const f of rows)
      out.push({ id: f.id as string, kind: f.kind as (typeof RISK_FACTOR_KINDS)[number], name: f.name as string, score: Number(f.score), rationale: (f.rationale as string | null) ?? null, source: await sourceOf((f.source as string | null) ?? null), created_by: person(f.created_by, f.author), created_at: iso(f.created_at), updated_at: iso(f.updated_at) });
    return out;
  };
  const toTreatment = (t: Row) => {
    const due = day(t.due);
    const status = t.status as (typeof TREATMENT_STATUSES)[number];
    const openTask = status === "todo" || status === "doing";
    return {
      id: t.id as string,
      title: t.title as string,
      owner: person(t.owner_user_id, t.owner_name),
      due,
      overdue: Boolean(due && openTask && due < today()),
      status,
      progress_note: (t.progress_note as string | null) ?? null,
      effectiveness: t.effectiveness as (typeof TREATMENT_EFFECTIVENESS)[number],
      effectiveness_note: (t.effectiveness_note as string | null) ?? null,
      done_at: iso(t.done_at),
      created_at: iso(t.created_at),
      updated_at: iso(t.updated_at),
    };
  };
  const TREATMENT_SELECT = `SELECT t.*, u.name AS owner_name FROM ${T}.risk_treatments t LEFT JOIN ${T}.users u ON u.id = t.owner_user_id`;
  const treatmentsOf = async (riskId: string) => (await store.db.query(`${TREATMENT_SELECT} WHERE t.risk_id = $1 ORDER BY t.created_at, t.id`, [riskId])).rows.map(toTreatment);
  const toControl = (c: Row) => ({
    id: c.id as string,
    name: c.name as string,
    kind: c.kind as (typeof CONTROL_KINDS)[number],
    description: (c.description as string | null) ?? null,
    last_tested_at: day(c.last_tested_at),
    test_result: (c.test_result as (typeof CONTROL_TEST_RESULTS)[number] | null) ?? null,
    from_treatment: c.source_treatment_id ? { id: c.source_treatment_id as string, title: (c.treatment_title as string | null) ?? null } : null,
    retired: c.retired_at ? { at: iso(c.retired_at), reason: (c.retire_reason as string | null) ?? null } : null,
    created_at: iso(c.created_at),
    updated_at: iso(c.updated_at),
  });
  const CONTROL_SELECT = `SELECT c.*, t.title AS treatment_title FROM ${T}.risk_controls c LEFT JOIN ${T}.risk_treatments t ON t.id = c.source_treatment_id`;
  const controlsOf = async (riskId: string) => (await store.db.query(`${CONTROL_SELECT} WHERE c.risk_id = $1 ORDER BY c.created_at, c.id`, [riskId])).rows.map(toControl);
  const linksOf = async (riskId: string) => {
    const { rows } = await store.db.query(`SELECT * FROM ${T}.risk_links WHERE risk_id = $1 ORDER BY created_at, id`, [riskId]);
    const out = [];
    for (const l of rows) {
      const type = l.target_type as LinkTarget;
      out.push({ id: l.id as string, target_type: type, type_words: TARGET_WORDS[type], target_id: l.target_id as string, name: await targetName(type, l.target_id as string), note: (l.note as string | null) ?? null, created_at: iso(l.created_at) });
    }
    return out;
  };
  const average = (xs: { score: number }[]) => (xs.length ? Math.round((xs.reduce((n, x) => n + x.score, 0) / xs.length) * 10) / 10 : null);

  server.registerTool(
    "get_risk",
    {
      title: "One risk, in full",
      description:
        "A risk on a register you can read (see list_risks; Mynt's admins also read any app's or product's): the risk with its three scores, then scoring (the impact, likelihood and control factors that explain them, each list with its average, or null when it has none, and the formula in words), treatments (the tasks that bring it down: owner, due date and whether it's overdue, status, progress, and whether it worked), controls (what keeps it down: kind, when last tested and the result, the task it came from; retired ones stay), links (what it's about; a link's name only when you may read what it points at), treatment_due (the earliest due date among its open tasks) and history (every change from the audit trail, oldest first, each with what changed in words and the scores before and after). can_manage says whether you may change it.",
      inputSchema: { risk_id: UUID },
      annotations: { readOnlyHint: true },
    },
    async ({ risk_id }) => {
      const o = await open(risk_id, false);
      if (!o.ok) return fail(o.error);
      const { grading, version } = await loadRiskGrading(store);
      const [factors, treatments, controls, links, history] = [await factorsOf(risk_id), await treatmentsOf(risk_id), await controlsOf(risk_id), await linksOf(risk_id), await riskHistory(store, risk_id)];
      const of = (kind: string) => factors.filter((f) => f.kind === kind);
      const dues = treatments.filter((t) => (t.status === "todo" || t.status === "doing") && t.due).map((t) => t.due!).sort();
      return json({
        subject: o.a.subject,
        can_manage: o.a.manage,
        risk: o.risk,
        scoring: {
          grading_version: version,
          impact: { recorded: o.risk.impact, average: average(of("impact")), factors: of("impact"), formula: "Impact is scored 1 (negligible) to 5 (severe) by the risk's keeper; these factors explain it. Inherent score = likelihood × impact." },
          likelihood: { recorded: o.risk.likelihood, average: average(of("likelihood")), factors: of("likelihood"), formula: "Likelihood is scored 1 (rare) to 5 (almost certain) by the risk's keeper; these factors explain it. Inherent score = likelihood × impact." },
          control: { recorded: o.risk.control.effectiveness, average: average(of("control")), factors: of("control"), formula: `Control effectiveness is none, weak, partial or strong, set by the risk's keeper; these factors, each scored 1 (not working) to 5 (working fully), explain it. ${methodWords(grading)}` },
        },
        treatments,
        treatment_due: dues[0] ?? null,
        controls,
        links,
        history,
      });
    },
  );

  if (!(sides.builder || sides.admin)) return;

  server.registerTool(
    "link_risk",
    {
      title: "Link a risk to what it's about",
      description:
        "Link a risk on a register you keep to something it's about: an app, a product, a vendor's offering (vendor_offering), an agreement, an oversight audit (agreement_audit), an audit-trail entry (audit_entry), one of Mynt's risk models (risk_model; Mynt's admins) or a firm, by its id, with an optional note. You can link what you can read: your own apps, products and firm, published products, listed vendor services, your agreements and their audits. One link per risk and item. Audited.",
      inputSchema: { risk_id: UUID, target_type: z.enum(RISK_LINK_TARGETS), target_id: TARGET_ID, note: z.string().trim().max(1000).optional() },
    },
    async ({ risk_id, target_type, target_id, note }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const name = await targetName(target_type, target_id);
      if (name === null) return fail(`No ${TARGET_WORDS[target_type].toLowerCase()} '${target_id}' you can read`);
      if ((await store.db.query(`SELECT 1 FROM ${T}.risk_links WHERE risk_id = $1 AND target_type = $2 AND target_id = $3`, [risk_id, target_type, target_id])).rows.length) return fail("This risk is already linked to it");
      const id = randomUUID();
      await store.db.query(`INSERT INTO ${T}.risk_links (id, risk_id, target_type, target_id, note, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [id, risk_id, target_type, target_id, note ?? null, user.id]);
      await store.audit(user.id, "link_risk", risk_id, base(o.risk, o.a, `Linked to ${TARGET_WORDS[target_type].toLowerCase()}: ${name}`, { link_id: id, target_type, target_id, note: note ?? null }));
      return json({ link: { id, target_type, type_words: TARGET_WORDS[target_type], target_id, name, note: note ?? null } });
    },
  );

  server.registerTool(
    "unlink_risk",
    {
      title: "Remove a risk's link",
      description: "Remove a link from a risk on a register you keep (link_id, from get_risk). The risk and the thing it pointed at stay as they are. Audited.",
      inputSchema: { risk_id: UUID, link_id: UUID },
    },
    async ({ risk_id, link_id }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const l = (await store.db.query(`DELETE FROM ${T}.risk_links WHERE id = $1 AND risk_id = $2 RETURNING target_type, target_id`, [link_id, risk_id])).rows[0];
      if (!l) return fail(`No link '${link_id}' on this risk`);
      const type = l.target_type as LinkTarget;
      await store.audit(user.id, "unlink_risk", risk_id, base(o.risk, o.a, `Link removed: ${TARGET_WORDS[type].toLowerCase()} ${(await targetName(type, l.target_id as string)) ?? (l.target_id as string)}`, { link_id, target_type: type, target_id: l.target_id }));
      return json({ unlinked: link_id });
    },
  );

  // ---- factors ----

  server.registerTool(
    "add_risk_factor",
    {
      title: "Add a scoring factor to a risk",
      description:
        "Add a factor that explains one of a risk's three scores, on a register you keep: kind impact (how bad it would be), likelihood (how likely it is) or control (how well a control works), a name, a score 1-5 (impact and likelihood as the risk's own; a control factor 1 not working to 5 working fully), a rationale, and optionally its source: an https link, or something on Mynt as type:id (app, product, vendor_offering, agreement, agreement_audit, audit_entry, risk_model, firm). Factors explain a score, they don't set it: change the risk's likelihood, impact or control effectiveness with update_risk. Audited.",
      inputSchema: { risk_id: UUID, kind: z.enum(RISK_FACTOR_KINDS), name: z.string().trim().min(2).max(200), score: SCORE, rationale: z.string().trim().max(2000).optional(), source: SOURCE.optional() },
    },
    async ({ risk_id, kind, name, score, rationale, source }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const id = randomUUID();
      await store.db.query(`INSERT INTO ${T}.risk_factors (id, risk_id, kind, name, score, rationale, source, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, risk_id, kind, name, score, rationale ?? null, source ?? null, user.id]);
      await store.audit(user.id, "add_risk_factor", risk_id, base(o.risk, o.a, `${kind[0].toUpperCase()}${kind.slice(1)} factor added: ${name} (${score} of 5)`, { factor_id: id, kind, name, score }));
      return json({ factor: (await factorsOf(risk_id)).find((f) => f.id === id) });
    },
  );

  server.registerTool(
    "update_risk_factor",
    {
      title: "Change a risk's scoring factor",
      description: "Change a factor of a risk on a register you keep (factor_id, from get_risk): its name, score (1-5), rationale or source. Its kind stays; only what you pass changes. Audited, with what it was and what it became.",
      inputSchema: { risk_id: UUID, factor_id: UUID, name: z.string().trim().min(2).max(200).optional(), score: SCORE.optional(), rationale: z.string().trim().max(2000).optional(), source: SOURCE.optional() },
    },
    async ({ risk_id, factor_id, ...next }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const was = (await store.db.query(`SELECT * FROM ${T}.risk_factors WHERE id = $1 AND risk_id = $2`, [factor_id, risk_id])).rows[0];
      if (!was) return fail(`No factor '${factor_id}' on this risk`);
      const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && v !== (k === "score" ? Number(was[k]) : was[k])).map(([k, v]) => [k, { from: was[k] ?? null, to: v }]));
      const cols = Object.keys(changes);
      if (!cols.length) return fail("Nothing to change: pass what's different");
      await store.db.query(`UPDATE ${T}.risk_factors SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [factor_id, ...cols.map((c) => changes[c].to)]);
      await store.audit(user.id, "update_risk_factor", risk_id, base(o.risk, o.a, `${words(String(was.kind)).replace(/^./, (c) => c.toUpperCase())} factor changed: ${(next.name ?? was.name) as string}${changes.score ? ` (${changes.score.from} → ${changes.score.to} of 5)` : ""}`, { factor_id, kind: was.kind, changes }));
      return json({ factor: (await factorsOf(risk_id)).find((f) => f.id === factor_id), changed: cols });
    },
  );

  server.registerTool(
    "remove_risk_factor",
    {
      title: "Remove a risk's scoring factor",
      description: "Remove a factor from a risk on a register you keep (factor_id, from get_risk). The risk's scores stay as they are; the audit trail keeps what the factor was.",
      inputSchema: { risk_id: UUID, factor_id: UUID },
    },
    async ({ risk_id, factor_id }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const f = (await store.db.query(`DELETE FROM ${T}.risk_factors WHERE id = $1 AND risk_id = $2 RETURNING kind, name, score, rationale, source`, [factor_id, risk_id])).rows[0];
      if (!f) return fail(`No factor '${factor_id}' on this risk`);
      await store.audit(user.id, "remove_risk_factor", risk_id, base(o.risk, o.a, `${words(String(f.kind)).replace(/^./, (c) => c.toUpperCase())} factor removed: ${f.name as string}`, { factor_id, removed: { kind: f.kind, name: f.name, score: Number(f.score), rationale: f.rationale ?? null, source: f.source ?? null } }));
      return json({ removed: factor_id });
    },
  );

  // ---- treatment tasks ----

  server.registerTool(
    "add_risk_treatment",
    {
      title: "Add a treatment task to a risk",
      description:
        "Add a task that brings a risk down, on a register you keep: a title, its owner (someone on the register's side: a member of the app's workspace or the product's firm, a Mynt admin for Mynt's own; you by default), a due date and an optional progress note. It starts todo, its effectiveness not assessed. Audited.",
      inputSchema: { risk_id: UUID, title: z.string().trim().min(3).max(200), owner_user_id: UUID.optional(), due: DATE.optional(), progress_note: z.string().trim().max(2000).optional() },
    },
    async ({ risk_id, title, owner_user_id, due, progress_note }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const owner = owner_user_id ?? user.id;
      if (!(await ownerOk(o.a, owner))) return fail(`The task's owner must be ${ownerSide(o.risk.subject_type)}`);
      const id = randomUUID();
      await store.db.query(`INSERT INTO ${T}.risk_treatments (id, risk_id, title, owner_user_id, due, progress_note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, risk_id, title, owner, due ?? null, progress_note ?? null, user.id]);
      await store.audit(user.id, "add_risk_treatment", risk_id, base(o.risk, o.a, `Treatment task added: ${title}${due ? `, due ${due}` : ""}`, { treatment_id: id, title, owner_user_id: owner, due: due ?? null }));
      return json({ treatment: toTreatment((await store.db.query(`${TREATMENT_SELECT} WHERE t.id = $1`, [id])).rows[0]) });
    },
  );

  server.registerTool(
    "update_risk_treatment",
    {
      title: "Update a risk's treatment task",
      description:
        "Update a treatment task of a risk on a register you keep (treatment_id, from get_risk): its title, owner, due date, status (todo, doing, done, dropped), progress note, and whether it worked (effectiveness: not_assessed, ineffective, partly_effective, effective, with an effectiveness_note; saying it worked or didn't needs the task done). Marking it done records when. Only what you pass changes. Audited, with what it was and what it became.",
      inputSchema: {
        risk_id: UUID,
        treatment_id: UUID,
        title: z.string().trim().min(3).max(200).optional(),
        owner_user_id: UUID.optional(),
        due: DATE.optional(),
        status: z.enum(TREATMENT_STATUSES).optional(),
        progress_note: z.string().trim().max(2000).optional(),
        effectiveness: z.enum(TREATMENT_EFFECTIVENESS).optional(),
        effectiveness_note: z.string().trim().max(2000).optional(),
      },
    },
    async ({ risk_id, treatment_id, ...next }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const row = (await store.db.query(`SELECT * FROM ${T}.risk_treatments WHERE id = $1 AND risk_id = $2`, [treatment_id, risk_id])).rows[0];
      if (!row) return fail(`No treatment task '${treatment_id}' on this risk`);
      if (next.owner_user_id && !(await ownerOk(o.a, next.owner_user_id))) return fail(`The task's owner must be ${ownerSide(o.risk.subject_type)}`);
      const was: Row = { ...row, due: day(row.due) };
      const status = next.status ?? (row.status as string);
      if (next.effectiveness && next.effectiveness !== "not_assessed" && status !== "done") return fail("Say whether a task worked once it's done (status done)");
      const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && v !== was[k]).map(([k, v]) => [k, { from: was[k] ?? null, to: v }]));
      const cols = Object.keys(changes);
      if (!cols.length) return fail("Nothing to change: pass what's different");
      const doneAt = changes.status ? (status === "done" ? ", done_at = now()" : ", done_at = NULL") : "";
      await store.db.query(`UPDATE ${T}.risk_treatments SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}${doneAt}, updated_at = now() WHERE id = $1`, [treatment_id, ...cols.map((c) => changes[c].to)]);
      const title = (next.title ?? row.title) as string;
      const said = [changes.status ? `status ${words(String(changes.status.from))} → ${words(String(changes.status.to))}` : null, changes.effectiveness ? `effectiveness ${words(String(changes.effectiveness.to))}` : null, changes.due ? `due ${String(changes.due.to)}` : null].filter(Boolean);
      await store.audit(user.id, "update_risk_treatment", risk_id, base(o.risk, o.a, `Treatment task updated: ${title}${said.length ? ` (${said.join(", ")})` : ""}`, { treatment_id, changes }));
      return json({ treatment: toTreatment((await store.db.query(`${TREATMENT_SELECT} WHERE t.id = $1`, [treatment_id])).rows[0]), changed: cols });
    },
  );

  // ---- controls ----

  server.registerTool(
    "add_risk_control",
    {
      title: "Add a control to a risk",
      description:
        "Add a control that keeps a risk down, on a register you keep: its name, kind (preventive: stops it happening; detective: notices it; corrective: puts it right), a description, and optionally when it was last tested (not in the future) and the result (passed, gaps_found, failed). With source_treatment_id, the control is made from one of the risk's treatment tasks that is done (its name is the task's title unless you give one). A control records what's in place; how well the controls work together is the risk's control effectiveness (update_risk). Audited.",
      inputSchema: {
        risk_id: UUID,
        name: z.string().trim().min(3).max(200).optional().describe("Needed unless source_treatment_id gives it"),
        kind: z.enum(CONTROL_KINDS),
        description: z.string().trim().max(4000).optional(),
        last_tested_at: DATE.optional(),
        test_result: z.enum(CONTROL_TEST_RESULTS).optional(),
        source_treatment_id: UUID.optional().describe("A done treatment task of this risk to make the control from"),
      },
    },
    async ({ risk_id, name, kind, description, last_tested_at, test_result, source_treatment_id }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      let from: Row | undefined;
      if (source_treatment_id) {
        from = (await store.db.query(`SELECT id, title, status FROM ${T}.risk_treatments WHERE id = $1 AND risk_id = $2`, [source_treatment_id, risk_id])).rows[0];
        if (!from) return fail(`No treatment task '${source_treatment_id}' on this risk`);
        if (from.status !== "done") return fail("Only a treatment task that is done can become a control");
        if ((await store.db.query(`SELECT 1 FROM ${T}.risk_controls WHERE source_treatment_id = $1`, [source_treatment_id])).rows.length) return fail("This treatment task is already a control");
      }
      const controlName = name ?? (from?.title as string | undefined);
      if (!controlName) return fail("Give the control's name");
      if (last_tested_at && last_tested_at > today()) return fail("last_tested_at can't be in the future");
      if (test_result && !last_tested_at) return fail("A test result needs the date it was tested (last_tested_at)");
      const id = randomUUID();
      await store.db.query(`INSERT INTO ${T}.risk_controls (id, risk_id, name, kind, description, last_tested_at, test_result, source_treatment_id, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
        id,
        risk_id,
        controlName,
        kind,
        description ?? null,
        last_tested_at ?? null,
        test_result ?? null,
        source_treatment_id ?? null,
        user.id,
      ]);
      await store.audit(user.id, "add_risk_control", risk_id, base(o.risk, o.a, `Control added: ${controlName} (${kind})${from ? `, from the task ${from.title as string}` : ""}`, { control_id: id, name: controlName, kind, source_treatment_id: source_treatment_id ?? null }));
      return json({ control: toControl((await store.db.query(`${CONTROL_SELECT} WHERE c.id = $1`, [id])).rows[0]) });
    },
  );

  server.registerTool(
    "update_risk_control",
    {
      title: "Update a risk's control",
      description:
        "Update a control of a risk on a register you keep (control_id, from get_risk; not a retired one): its name, kind, description, or a test: when it was last tested (not in the future) and the result (passed, gaps_found, failed). Only what you pass changes. Audited, with what it was and what it became.",
      inputSchema: {
        risk_id: UUID,
        control_id: UUID,
        name: z.string().trim().min(3).max(200).optional(),
        kind: z.enum(CONTROL_KINDS).optional(),
        description: z.string().trim().max(4000).optional(),
        last_tested_at: DATE.optional(),
        test_result: z.enum(CONTROL_TEST_RESULTS).optional(),
      },
    },
    async ({ risk_id, control_id, ...next }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const row = (await store.db.query(`SELECT * FROM ${T}.risk_controls WHERE id = $1 AND risk_id = $2`, [control_id, risk_id])).rows[0];
      if (!row) return fail(`No control '${control_id}' on this risk`);
      if (row.retired_at) return fail("This control is retired: it can't be changed");
      if (next.last_tested_at && next.last_tested_at > today()) return fail("last_tested_at can't be in the future");
      const was: Row = { ...row, last_tested_at: day(row.last_tested_at) };
      if (next.test_result && !(next.last_tested_at ?? was.last_tested_at)) return fail("A test result needs the date it was tested (last_tested_at)");
      const changes = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && v !== was[k]).map(([k, v]) => [k, { from: was[k] ?? null, to: v }]));
      const cols = Object.keys(changes);
      if (!cols.length) return fail("Nothing to change: pass what's different");
      await store.db.query(`UPDATE ${T}.risk_controls SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [control_id, ...cols.map((c) => changes[c].to)]);
      const tested = changes.last_tested_at || changes.test_result ? ` (tested ${String(next.last_tested_at ?? was.last_tested_at)}${next.test_result ? `: ${words(next.test_result)}` : ""})` : "";
      await store.audit(user.id, "update_risk_control", risk_id, base(o.risk, o.a, `Control updated: ${(next.name ?? row.name) as string}${tested}`, { control_id, changes }));
      return json({ control: toControl((await store.db.query(`${CONTROL_SELECT} WHERE c.id = $1`, [control_id])).rows[0]), changed: cols });
    },
  );

  server.registerTool(
    "retire_risk_control",
    {
      title: "Retire a risk's control",
      description: "Retire a control of a risk on a register you keep, saying why. It stays listed under the risk, marked retired, and can't be changed again. Audited.",
      inputSchema: { risk_id: UUID, control_id: UUID, reason: z.string().trim().min(3).max(2000) },
    },
    async ({ risk_id, control_id, reason }) => {
      const o = await open(risk_id, true);
      if (!o.ok) return fail(o.error);
      const row = (await store.db.query(`SELECT name, retired_at FROM ${T}.risk_controls WHERE id = $1 AND risk_id = $2`, [control_id, risk_id])).rows[0];
      if (!row) return fail(`No control '${control_id}' on this risk`);
      if (row.retired_at) return fail("This control is already retired");
      await store.db.query(`UPDATE ${T}.risk_controls SET retired_at = now(), retired_by = $2, retire_reason = $3, updated_at = now() WHERE id = $1`, [control_id, user.id, reason]);
      await store.audit(user.id, "retire_risk_control", risk_id, base(o.risk, o.a, `Control retired: ${row.name as string}`, { control_id, reason }));
      return json({ control: toControl((await store.db.query(`${CONTROL_SELECT} WHERE c.id = $1`, [control_id])).rows[0]) });
    },
  );
}
