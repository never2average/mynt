import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SLA_WINDOWS } from "./agreement-slas-schema.js";
import type { Db } from "./db.js";
import { noticeFirm } from "./firm-notices.js";
import { effectiveRoles, type App, type Store, type User } from "./store.js";
import { appRole, memberApp, workspaceRole } from "./workspaces.js";

// Service levels under a service-level agreement (app-agreements.ts, kind 'sla', for one app or a whole workspace).
// An SLA agreement carries commitments: a metric (uptime, complaint response time, ...), its target and unit, the
// window it's measured over, where the measurement comes from and the remedy when it's missed. Each commitment (1:n on
// the agreement) has breaches over time (1:n): a period in which the measured value missed the target.
//
// - Either party (the counterparty firm's licence providers, or the workspace's owners and admins) adds commitments
//   while the agreement is proposed or accepted, and retires them while it's open. There's no acceptance of each
//   commitment: they're the agreement's terms, in force once it's signed.
// - Either party records a breach once the agreement is signed and while the commitment is active, and either resolves
//   it. Any member of the workspace reads them.
// - Only the agreement's two parties read its SLAs.
// - An open breach flags the app (get_workspace_attention, agreement_sla_breach) and shows in ops_status.
// Every change is audited in the obligations class (with the app's id); a breach is told to both parties' firms on
// their webhooks and notices (agreement_sla.breached).

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

type Row = Record<string, unknown>;
type Window = (typeof SLA_WINDOWS)[number];
const MANAGERS = ["owner", "admin"];
const AGREEMENT_OPEN = ["proposed", "accepted", "signed"];
// Commitments are added while the agreement's terms are still being settled.
const ADDABLE = ["proposed", "accepted"];
const MAX_ACTIVE = 50;
const MAX_BREACHES = 1000;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD").refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "A real date");
const UUID = z.string().uuid();

export interface Sla {
  id: string;
  agreement_id: string;
  metric: string;
  target: string;
  target_value: number | null;
  unit: string | null;
  measurement_window: Window;
  measurement_source: string;
  remedy: string | null;
  status: "active" | "retired";
  created_by: string | null;
  created_at: string;
  retired_by: string | null;
  retired_at: string | null;
  retire_reason: string | null;
}
export interface SlaBreach {
  id: string;
  sla_id: string;
  agreement_id: string;
  period_start: string;
  period_end: string;
  measured_value: string;
  recorded_by: string | null;
  recorded_side: "app" | "counterparty";
  note: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

const toSla = (r: Row): Sla => ({
  id: r.id as string,
  agreement_id: r.agreement_id as string,
  metric: r.metric as string,
  target: r.target as string,
  target_value: r.target_value == null ? null : Number(r.target_value),
  unit: (r.unit as string | null) ?? null,
  measurement_window: r.measurement_window as Window,
  measurement_source: r.measurement_source as string,
  remedy: (r.remedy as string | null) ?? null,
  status: r.status as Sla["status"],
  created_by: (r.created_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
  retired_by: (r.retired_by as string | null) ?? null,
  retired_at: iso(r.retired_at),
  retire_reason: (r.retire_reason as string | null) ?? null,
});
const toBreach = (r: Row): SlaBreach => ({
  id: r.id as string,
  sla_id: r.sla_id as string,
  agreement_id: r.agreement_id as string,
  period_start: day(r.period_start)!,
  period_end: day(r.period_end)!,
  measured_value: r.measured_value as string,
  recorded_by: (r.recorded_by as string | null) ?? null,
  recorded_side: r.recorded_side as SlaBreach["recorded_side"],
  note: (r.note as string | null) ?? null,
  created_at: iso(r.created_at)!,
  resolved_at: iso(r.resolved_at),
  resolved_by: (r.resolved_by as string | null) ?? null,
  resolution_note: (r.resolution_note as string | null) ?? null,
});

async function getSla(store: Store, id: string) {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`SELECT * FROM ${T}.agreement_slas WHERE id = $1`, [id])).rows[0];
  return r ? toSla(r) : undefined;
}
async function getBreach(store: Store, id: string) {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`SELECT * FROM ${T}.agreement_sla_breaches WHERE id = $1`, [id])).rows[0];
  return r ? toBreach(r) : undefined;
}
type AgreementRef = { id: string; app_id: string | null; workspace_id: string | null; counterparty_entity_id: string; kind: string; status: string };
async function getAgreementRef(store: Store, id: string): Promise<AgreementRef | undefined> {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`SELECT id, app_id, workspace_id, counterparty_entity_id, kind, status FROM ${T}.app_agreements WHERE id = $1`, [id])).rows[0];
  return r ? { id: r.id as string, app_id: (r.app_id as string | null) ?? null, workspace_id: (r.workspace_id as string | null) ?? null, counterparty_entity_id: r.counterparty_entity_id as string, kind: r.kind as string, status: r.status as string } : undefined;
}

const tableExists = async (db: Pick<Db, "query">, name: string) => Boolean((await db.query(`SELECT to_regclass('${T}.${name}') IS NOT NULL AS ok`)).rows[0]?.ok);

// Open breaches, for ops_status: how many and on how many agreements.
export async function openSlaBreaches(db: Pick<Db, "query">) {
  if (!(await tableExists(db, "agreement_sla_breaches"))) return { open: 0, agreements: 0 };
  const r = (await db.query(`SELECT count(*)::int AS n, count(DISTINCT agreement_id)::int AS agreements FROM ${T}.agreement_sla_breaches WHERE resolved_at IS NULL`)).rows[0];
  return { open: Number(r?.n ?? 0), agreements: Number(r?.agreements ?? 0) };
}

// The open breaches on some apps' agreements, for the workspace's attention list.
// workspaceId: also the breaches under the workspace's own SLA agreements (no app).
export async function openBreachesOfApps(store: Pick<Store, "db">, appIds: string[], workspaceId?: string) {
  if ((!appIds.length && !workspaceId) || !(await tableExists(store.db, "agreement_sla_breaches"))) return [];
  const { rows } = await store.db.query(
    `SELECT b.id, b.created_at, b.period_start, b.period_end, b.measured_value, a.app_id::text AS app_id, a.id AS agreement_id, s.metric, s.target, s.unit, e.name AS counterparty
       FROM ${T}.agreement_sla_breaches b JOIN ${T}.agreement_slas s ON s.id = b.sla_id
       JOIN ${T}.app_agreements a ON a.id = b.agreement_id LEFT JOIN ${T}.entities e ON e.id = a.counterparty_entity_id
      WHERE (a.app_id::text = ANY($1) OR (a.app_id IS NULL AND a.workspace_id::text = $2)) AND b.resolved_at IS NULL ORDER BY b.created_at`,
    [appIds, workspaceId ?? null],
  );
  return rows.map((r) => ({
    id: r.id as string,
    app_id: (r.app_id as string | null) ?? null,
    agreement_id: r.agreement_id as string,
    metric: r.metric as string,
    target: `${r.target as string}${r.unit ? ` ${r.unit as string}` : ""}`,
    measured_value: r.measured_value as string,
    period_start: day(r.period_start)!,
    period_end: day(r.period_end)!,
    counterparty: (r.counterparty as string | null) ?? null,
    at: iso(r.created_at)!,
  }));
}

// The firms of the app's workspace's members (or its owner's), told of a breach.
async function appSideFirms(store: Store, a: { app_id: string | null; workspace_id: string | null }): Promise<string[]> {
  const app = a.app_id ? await store.getApp(a.app_id) : undefined;
  const workspace = app ? app.workspace_id : a.workspace_id;
  if (!app && !workspace) return [];
  const { rows } = workspace
    ? await store.db.query(`SELECT DISTINCT u.entity_id FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.entity_id IS NOT NULL`, [workspace])
    : await store.db.query(`SELECT entity_id FROM ${T}.users WHERE id = $1 AND entity_id IS NOT NULL`, [app!.owner_id]);
  return rows.map((r) => r.entity_id as string);
}

// Developer (the app's side) and licence provider (the counterparty's side). One account can be both; each call works
// out which side it acts for from the agreement.
export function registerAgreementSlaTools(server: McpServer, store: Store, user: User, sides: { app: boolean; counterparty: boolean }) {
  const myFirm = async () => {
    if (!sides.counterparty) return null;
    const me = await store.getUser(user.id);
    return me?.entity_id && effectiveRoles(me.roles).includes("license_provider") ? me.entity_id : null;
  };
  // The caller's role on the app's side: in the app's workspace, or the agreement's workspace when it names no app.
  const appSideRole = async (a: AgreementRef): Promise<string | null> => {
    if (!sides.app) return null;
    if (a.app_id) {
      const app: App | undefined = await memberApp(store, user, a.app_id);
      return app ? ((await appRole(store, user, app)) ?? null) : null;
    }
    return a.workspace_id ? workspaceRole(store.db, a.workspace_id, user.id) : null;
  };
  const access = async (a: AgreementRef) => {
    const role = await appSideRole(a);
    const counterparty = (await myFirm()) === a.counterparty_entity_id;
    return { app: role !== null, manager: MANAGERS.includes(role ?? ""), counterparty, party: role !== null || counterparty };
  };
  type Who = Awaited<ReturnType<typeof access>>;
  const trail = (a: AgreementRef, extra: Record<string, unknown> = {}) => ({ app_id: a.app_id, workspace_id: a.workspace_id, agreement_id: a.id, ...extra });

  // An SLA and its agreement, when the caller is one of the agreement's parties.
  const loadSla = async (slaId: string) => {
    const s = await getSla(store, slaId);
    const a = s ? await getAgreementRef(store, s.agreement_id) : undefined;
    if (!s || !a) return null;
    const who = await access(a);
    return who.party ? { s, a, who } : null;
  };
  // The side the caller records or resolves breaches for: the counterparty, else the app's owners and admins.
  const actingSide = (who: Who): "counterparty" | "app" | null => (who.counterparty ? "counterparty" : who.manager ? "app" : null);
  const notManager = "Only the workspace's owners and admins record and resolve SLA breaches for it";

  server.registerTool(
    "add_agreement_sla",
    {
      title: "Add a service-level commitment to an SLA agreement",
      description:
        "Either party to a service-level agreement (kind 'sla', for one app or a whole workspace: the counterparty firm's licence providers, or the workspace's owners and admins): add a commitment while the agreement is proposed or accepted: the metric, its target (a number or words) and unit, the window it's measured over (daily, weekly, monthly, quarterly), where the measurement comes from and the remedy when it's missed. Commitments are the agreement's terms: there's no separate acceptance, and they're in force once it's signed. Either party records breaches then (record_sla_breach). Audited; both sides see it in list_agreement_slas.",
      inputSchema: {
        agreement_id: UUID,
        metric: z.string().trim().min(3).max(200),
        target: z.union([z.number().finite(), z.string().trim().min(1).max(200)]),
        unit: z.string().trim().max(40).optional(),
        measurement_window: z.enum(SLA_WINDOWS),
        measurement_source: z.string().trim().min(3).max(500).describe("Where the measured value comes from"),
        remedy: z.string().trim().max(2000).optional().describe("What happens when it's missed"),
      },
    },
    async ({ agreement_id, metric, target, unit, measurement_window, measurement_source, remedy }) => {
      const a = await getAgreementRef(store, agreement_id);
      const who = a ? await access(a) : null;
      if (!a || !who?.party) return fail(`No agreement '${agreement_id}' you're a party to`);
      const side = actingSide(who);
      if (!side) return fail("Only the workspace's owners and admins add service levels for it");
      if (a.kind !== "sla") return fail("Service levels belong to service-level agreements (kind sla); propose one first");
      if (!ADDABLE.includes(a.status)) return fail(`That agreement is ${a.status}: commitments are added while it's proposed or accepted`);
      const count = (await store.db.query(`SELECT count(*)::int AS n FROM ${T}.agreement_slas WHERE agreement_id = $1 AND status = 'active'`, [a.id])).rows[0]?.n as number;
      if (count >= MAX_ACTIVE) return fail(`An agreement has at most ${MAX_ACTIVE} active service levels; retire one first`);
      const text = typeof target === "number" ? String(target) : target;
      const numeric = typeof target === "number" ? target : /^-?\d+(\.\d+)?$/.test(target) ? Number(target) : null;
      const r = (
        await store.db.query(
          `INSERT INTO ${T}.agreement_slas (id, agreement_id, metric, target, target_value, unit, measurement_window, measurement_source, remedy, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [randomUUID(), a.id, metric, text, numeric, unit || null, measurement_window, measurement_source, remedy || null, user.id],
        )
      ).rows[0];
      const sla = toSla(r);
      await store.audit(user.id, "add_agreement_sla", sla.id, trail(a, { metric, target: text, unit: sla.unit, measurement_window, side }));
      return json({ sla });
    },
  );

  server.registerTool(
    "retire_agreement_sla",
    {
      title: "Retire a service-level commitment",
      description: "Either party (as for add_agreement_sla): stop a commitment on an open service-level agreement, with the reason. Its breaches stay as they are (open ones can still be resolved). Audited.",
      inputSchema: { sla_id: UUID, reason: z.string().trim().min(3).max(2000) },
    },
    async ({ sla_id, reason }) => {
      const got = await loadSla(sla_id);
      if (!got) return fail(`No service level '${sla_id}' you're a party to`);
      const side = actingSide(got.who);
      if (!side) return fail("Only the workspace's owners and admins retire service levels for it");
      if (got.s.status === "retired") return fail("It's already retired");
      if (!AGREEMENT_OPEN.includes(got.a.status)) return fail(`That agreement is ${got.a.status}`);
      const r = (await store.db.query(`UPDATE ${T}.agreement_slas SET status = 'retired', retired_at = now(), retired_by = $2, retire_reason = $3 WHERE id = $1 AND status = 'active' RETURNING *`, [sla_id, user.id, reason])).rows[0];
      if (!r) return fail("It's already retired");
      await store.audit(user.id, "retire_agreement_sla", sla_id, trail(got.a, { reason, side }));
      return json({ sla: toSla(r) });
    },
  );

  server.registerTool(
    "record_sla_breach",
    {
      title: "Record a missed service level",
      description:
        "Either party to a signed service-level agreement (the counterparty firm's licence providers, or the workspace's owners and admins): record that an active service level was missed in a period (period_start to period_end, YYYY-MM-DD) with the measured value and an optional note. It's open until either party resolves it (resolve_sla_breach). Audited; both parties' firms are told (agreement_sla.breached) and the app's workspace sees it in its attention list.",
      inputSchema: {
        sla_id: UUID,
        period_start: DATE,
        period_end: DATE,
        measured_value: z.union([z.number().finite(), z.string().trim().min(1).max(200)]),
        note: z.string().trim().max(4000).optional(),
      },
    },
    async ({ sla_id, period_start, period_end, measured_value, note }) => {
      const got = await loadSla(sla_id);
      if (!got) return fail(`No service level '${sla_id}' you're a party to`);
      const side = actingSide(got.who);
      if (!side) return fail(notManager);
      const { s, a } = got;
      if (s.status !== "active") return fail("That service level is retired");
      if (a.status !== "signed") return fail(`Breaches are recorded under a signed agreement; this one is ${a.status}`);
      if (period_end < period_start) return fail("The period ends before it starts");
      const n = (await store.db.query(`SELECT count(*)::int AS n FROM ${T}.agreement_sla_breaches WHERE sla_id = $1`, [s.id])).rows[0]?.n as number;
      if (n >= MAX_BREACHES) return fail(`A service level holds at most ${MAX_BREACHES} breaches`);
      const value = typeof measured_value === "number" ? String(measured_value) : measured_value;
      const r = (
        await store.db.query(
          `INSERT INTO ${T}.agreement_sla_breaches (id, sla_id, agreement_id, period_start, period_end, measured_value, recorded_by, recorded_side, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [randomUUID(), s.id, a.id, period_start, period_end, value, user.id, side, note || null],
        )
      ).rows[0];
      const breach = toBreach(r);
      await store.audit(user.id, "record_sla_breach", breach.id, trail(a, { sla_id: s.id, metric: s.metric, target: s.target, measured_value: value, period_start, period_end, side }));
      const data = { breach_id: breach.id, sla_id: s.id, agreement_id: a.id, app_id: a.app_id, metric: s.metric, target: s.target, unit: s.unit, measured_value: value, period_start, period_end, recorded_side: side };
      const firms = new Set([a.counterparty_entity_id, ...(await appSideFirms(store, a))]);
      for (const f of firms) await noticeFirm(store, f, "agreement_sla.breached", data).catch(() => null);
      return json({ breach, sla: s });
    },
  );

  server.registerTool(
    "resolve_sla_breach",
    {
      title: "Resolve a missed service level",
      description: "Either party (the counterparty firm's licence providers, or the app's workspace owners and admins): mark an open SLA breach resolved, with an optional note. Audited.",
      inputSchema: { breach_id: UUID, note: z.string().trim().max(2000).optional() },
    },
    async ({ breach_id, note }) => {
      const b = await getBreach(store, breach_id);
      const got = b ? await loadSla(b.sla_id) : null;
      if (!b || !got) return fail(`No SLA breach '${breach_id}' you're a party to`);
      if (!actingSide(got.who)) return fail(notManager);
      if (b.resolved_at) return fail("That breach is already resolved");
      const r = (await store.db.query(`UPDATE ${T}.agreement_sla_breaches SET resolved_at = now(), resolved_by = $2, resolution_note = $3 WHERE id = $1 AND resolved_at IS NULL RETURNING *`, [b.id, user.id, note || null])).rows[0];
      if (!r) return fail("That breach is already resolved");
      await store.audit(user.id, "resolve_sla_breach", b.id, trail(got.a, { sla_id: b.sla_id, note: note ?? null }));
      return json({ breach: toBreach(r) });
    },
  );

  server.registerTool(
    "list_agreement_slas",
    {
      title: "Service levels under app agreements",
      description:
        "The service-level commitments under the SLA agreements (kind sla) you're a party to, each with its breaches (open ones first counted in open_breaches) and what you may do (actions), and those agreements (can_add_slas: whether you can add one to it). Developer: your apps' (any member of the app's workspace; workspace_id or app_id narrow it). Licence provider: those on agreements with your firm. agreement_id narrows it further; side picks one side when you're both; include_retired lists retired ones too.",
      inputSchema: {
        workspace_id: z.string().trim().min(1).max(100).optional(),
        app_id: UUID.optional(),
        agreement_id: UUID.optional(),
        side: z.enum(["app", "counterparty"]).optional(),
        include_retired: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, app_id, agreement_id, side, include_retired }) => {
      const ids = new Set<string>();
      if (sides.app && side !== "counterparty") {
        let appIds: string[];
        if (app_id) {
          const app = await memberApp(store, user, app_id);
          if (!app) return fail(`No app '${app_id}' of yours`);
          appIds = [app.id];
        } else appIds = (await store.appsVisibleTo(user.id, workspace_id)).map((x) => x.id);
        if (appIds.length) (await store.db.query(`SELECT id FROM ${T}.app_agreements WHERE app_id = ANY($1::uuid[]) AND kind = 'sla'`, [appIds])).rows.forEach((r) => ids.add(r.id as string));
        // The workspace's own SLA agreements (no app), in the workspaces the caller belongs to.
        if (!app_id)
          (
            await store.db.query(
              `SELECT g.id FROM ${T}.app_agreements g JOIN ${T}.workspace_members m ON m.workspace_id = g.workspace_id AND m.user_id = $1
                WHERE g.app_id IS NULL AND g.kind = 'sla' AND ($2::text IS NULL OR g.workspace_id::text = $2)`,
              [user.id, workspace_id ?? null],
            )
          ).rows.forEach((r) => ids.add(r.id as string));
      }
      const firm = side === "app" ? null : await myFirm();
      if (firm) (await store.db.query(`SELECT id FROM ${T}.app_agreements WHERE counterparty_entity_id = $1 AND kind = 'sla' AND ($2::uuid IS NULL OR app_id = $2::uuid)`, [firm, app_id ?? null])).rows.forEach((r) => ids.add(r.id as string));
      if (agreement_id) {
        if (!ids.has(agreement_id)) return fail(`No agreement '${agreement_id}' you're a party to`);
        ids.clear();
        ids.add(agreement_id);
      }
      const list = [...ids];
      if (!list.length) return json({ agreements: [], slas: [], counts: { slas: 0, active: 0, open_breaches: 0 } });
      const agreements = new Map<string, AgreementRef>();
      const whoOf = new Map<string, Who>();
      for (const id of list) {
        const a = (await getAgreementRef(store, id))!;
        agreements.set(id, a);
        whoOf.set(id, await access(a));
      }
      const firms = new Map<string, string | null>();
      const appNames = new Map<string, string | null>();
      const workspaces = new Map<string, string | null>();
      for (const a of agreements.values()) {
        if (!firms.has(a.counterparty_entity_id)) firms.set(a.counterparty_entity_id, (await store.getEntity(a.counterparty_entity_id))?.name ?? null);
        if (a.app_id && !appNames.has(a.app_id)) appNames.set(a.app_id, (await store.getApp(a.app_id))?.name ?? null);
        if (a.workspace_id && !workspaces.has(a.workspace_id))
          workspaces.set(a.workspace_id, ((await store.db.query(`SELECT name FROM ${T}.workspaces WHERE id = $1`, [a.workspace_id])).rows[0]?.name as string | undefined) ?? null);
      }
      const slaRows = (await store.db.query(`SELECT * FROM ${T}.agreement_slas WHERE agreement_id = ANY($1::uuid[]) AND ($2::boolean OR status = 'active') ORDER BY created_at`, [list, include_retired])).rows.map(toSla);
      const breachRows = slaRows.length
        ? (await store.db.query(`SELECT * FROM ${T}.agreement_sla_breaches WHERE sla_id = ANY($1::uuid[]) ORDER BY created_at DESC`, [slaRows.map((s) => s.id)])).rows.map(toBreach)
        : [];
      const people = new Map<string, string>();
      const userIds = [...new Set(breachRows.map((b) => b.recorded_by).filter((x): x is string => Boolean(x)))];
      if (userIds.length) (await store.db.query(`SELECT id, name FROM ${T}.users WHERE id = ANY($1::uuid[])`, [userIds])).rows.forEach((r) => people.set(r.id as string, r.name as string));
      const slas = slaRows.map((s) => {
        const a = agreements.get(s.agreement_id)!;
        const who = whoOf.get(s.agreement_id)!;
        const can = actingSide(who) !== null;
        const breaches = breachRows
          .filter((b) => b.sla_id === s.id)
          .map((b) => ({
            id: b.id,
            sla_id: b.sla_id,
            period_start: b.period_start,
            period_end: b.period_end,
            measured_value: b.measured_value,
            recorded_side: b.recorded_side,
            recorded_by: b.recorded_by ? { id: b.recorded_by, name: people.get(b.recorded_by) ?? null } : null,
            note: b.note,
            created_at: b.created_at,
            resolved_at: b.resolved_at,
            resolution_note: b.resolution_note,
            open: b.resolved_at === null,
            actions: can && b.resolved_at === null ? ["resolve"] : [],
          }));
        return {
          id: s.id,
          agreement_id: s.agreement_id,
          metric: s.metric,
          target: s.target,
          target_value: s.target_value,
          unit: s.unit,
          measurement_window: s.measurement_window,
          measurement_source: s.measurement_source,
          remedy: s.remedy,
          status: s.status,
          created_by: s.created_by,
          created_at: s.created_at,
          retired_at: s.retired_at,
          retire_reason: s.retire_reason,
          app: a.app_id ? { id: a.app_id, name: appNames.get(a.app_id) ?? null } : null,
          counterparty: { entity_id: a.counterparty_entity_id, name: firms.get(a.counterparty_entity_id) ?? null },
          open_breaches: breaches.filter((b) => b.open).length,
          breaches,
          actions: [...(can && s.status === "active" && a.status === "signed" ? ["record_breach"] : []), ...(can && s.status === "active" && AGREEMENT_OPEN.includes(a.status) ? ["retire"] : [])],
        };
      });
      return json({
        agreements: [...agreements.values()].map((a) => {
          const who = whoOf.get(a.id)!;
          return {
            id: a.id,
            kind: a.kind,
            status: a.status,
            app: a.app_id ? { id: a.app_id, name: appNames.get(a.app_id) ?? null } : null,
            workspace: a.workspace_id ? { id: a.workspace_id, name: workspaces.get(a.workspace_id) ?? null } : null,
            counterparty: { entity_id: a.counterparty_entity_id, name: firms.get(a.counterparty_entity_id) ?? null },
            your_side: who.counterparty ? (who.app ? "both" : "counterparty") : "app",
            can_add_slas: actingSide(who) !== null && a.kind === "sla" && ADDABLE.includes(a.status),
          };
        }),
        slas,
        counts: { slas: slas.length, active: slas.filter((s) => s.status === "active").length, open_breaches: slas.reduce((n, s) => n + s.open_breaches, 0) },
      });
    },
  );
}
