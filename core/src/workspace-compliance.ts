import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redact } from "./boxes.js";
import type { Db } from "./db.js";
import type { ProductRecord, Store, User } from "./store.js";
import { productRegime } from "./regime.js";
import { workspaceRole } from "./workspaces.js";

// What a workspace's apps rest on, for its members: where in the US its products are covered (by whose approved
// sponsorship, under which licences, over which approved money rails), the licences behind that, and the workspace's
// own audit trail. Read-only, members only, and only the workspace's own: other workspaces' apps, products they
// alone use, sealed figures (rail limits, pool books) and secrets never appear.

const T = "financial_products";

export const US_STATE_NAMES: Record<string, string> = {
  "us-al": "Alabama", "us-ak": "Alaska", "us-az": "Arizona", "us-ar": "Arkansas", "us-ca": "California", "us-co": "Colorado",
  "us-ct": "Connecticut", "us-de": "Delaware", "us-dc": "District of Columbia", "us-fl": "Florida", "us-ga": "Georgia",
  "us-hi": "Hawaii", "us-id": "Idaho", "us-il": "Illinois", "us-in": "Indiana", "us-ia": "Iowa", "us-ks": "Kansas",
  "us-ky": "Kentucky", "us-la": "Louisiana", "us-me": "Maine", "us-md": "Maryland", "us-ma": "Massachusetts", "us-mi": "Michigan",
  "us-mn": "Minnesota", "us-ms": "Mississippi", "us-mo": "Missouri", "us-mt": "Montana", "us-ne": "Nebraska", "us-nv": "Nevada",
  "us-nh": "New Hampshire", "us-nj": "New Jersey", "us-nm": "New Mexico", "us-ny": "New York", "us-nc": "North Carolina",
  "us-nd": "North Dakota", "us-oh": "Ohio", "us-ok": "Oklahoma", "us-or": "Oregon", "us-pa": "Pennsylvania", "us-ri": "Rhode Island",
  "us-sc": "South Carolina", "us-sd": "South Dakota", "us-tn": "Tennessee", "us-tx": "Texas", "us-ut": "Utah", "us-vt": "Vermont",
  "us-va": "Virginia", "us-wa": "Washington", "us-wv": "West Virginia", "us-wi": "Wisconsin", "us-wy": "Wyoming",
};
const STATES = Object.keys(US_STATE_NAMES);

type Row = Record<string, unknown>;
const rows = async (db: Db, sql: string, params: unknown[]) => {
  try {
    return (await db.query(sql, params)).rows as Row[];
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return []; // a service this Mynt doesn't run
    throw e;
  }
};
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

// The products the workspace's apps use.
async function workspaceProductIds(db: Db, workspaceId: string): Promise<string[]> {
  const r = await rows(db, `SELECT DISTINCT unnest(product_ids) AS id FROM ${T}.apps WHERE workspace_id::text = $1`, [workspaceId]);
  return r.map((x) => x.id as string);
}

// Where one published product may be sold in the US, by Mynt's own rules (regime.ts): every regulated component
// covered in the state by a licence in force, counting where the regulatory model says it does, under an approved
// sponsorship where a licence provider provides it; and nothing paused (a covenant breach or anything else that
// drifted it stops new sales everywhere). Each covered state maps to the licences covering it there.
type Cover = { entity_id: string; licence_id: string };
export async function coveredStates(store: Store, record: ProductRecord): Promise<Map<string, Cover[]>> {
  const out = new Map<string, Cover[]>();
  if (record.status !== "published" || record.drift) return out;
  const regime = await productRegime(store, record, { live: Boolean(record.pins) });
  const us = regime.regions.find((r) => r.region === "US");
  if (!regime.composed || !us) return out;
  type Row = (typeof us.components)[number];
  const coversOf = (c: Row, j: string | null): Cover[] => {
    const cov = j === null ? c.coverage : (c.jurisdictions?.find((x) => x.jurisdiction === j)?.coverage ?? c.coverage);
    return cov.status === "covered" ? cov.by.map((b) => ({ entity_id: b.entity_id, licence_id: b.licence_id })) : [];
  };
  const add = (states: string[], covers: Cover[]) => {
    for (const st of states) out.set(st, [...(out.get(st) ?? []), ...covers]);
  };
  if (us.jurisdictions) {
    for (const j of us.jurisdictions.filter((x) => x.covered))
      add(j.jurisdiction.toLowerCase() === "us" ? STATES : [j.jurisdiction.toLowerCase()], us.components.flatMap((c) => coversOf(c, j.jurisdiction)));
  } else if (us.covered) add(STATES, us.components.flatMap((c) => coversOf(c, null)));
  return out;
}

// The published products the workspace's apps use, with where each is covered.
async function usedCoverage(store: Store, productIds: string[]) {
  const out: { id: string; name: string; states: Map<string, Cover[]> }[] = [];
  for (const id of productIds) {
    const record = await store.getProduct(id);
    if (record?.status === "published") out.push({ id, name: record.product.name, states: await coveredStates(store, record) });
  }
  return out;
}

async function licencesById(db: Db, ids: string[]) {
  if (!ids.length) return new Map<string, Row>();
  const r = await rows(
    db,
    `SELECT l.id::text AS id, l.license_id, l.regulator_id, l.registration_number, l.valid_to, l.status, l.jurisdiction, e.name AS partner,
       l.entity_id::text AS entity_id
     FROM ${T}.held_licenses l JOIN ${T}.entities e ON e.id = l.entity_id WHERE l.id::text = ANY($1)`,
    [ids],
  );
  return new Map(r.map((x) => [x.id as string, x]));
}

export async function complianceCoverage(store: Store, workspaceId: string) {
  const db = store.db;
  const used = await workspaceProductIds(db, workspaceId);
  const ours = await usedCoverage(store, used);
  // Other published products, only to tell "available" from "unavailable": nothing of theirs is shown.
  const anywhere = new Set<string>();
  for (const p of await store.allProducts()) {
    if (p.status !== "published" || used.includes(p.product.id)) continue;
    for (const st of (await coveredStates(store, p)).keys()) anywhere.add(st);
  }
  const covers = ours.flatMap((p) => [...p.states.values()].flat());
  const licences = await licencesById(db, [...new Set(covers.map((c) => c.licence_id))]);
  const partners = [...new Set(covers.map((c) => c.entity_id))];
  const names = new Map(
    partners.length ? (await rows(db, `SELECT id::text AS id, name FROM ${T}.entities WHERE id::text = ANY($1)`, [partners])).map((r) => [r.id as string, r.name as string]) : [],
  );
  const rails = partners.length
    ? await rows(db, `SELECT entity_id::text AS entity_id, kind, direction, provider, status, states FROM ${T}.money_rails WHERE status = 'approved' AND entity_id::text = ANY($1)`, [partners])
    : [];
  return {
    workspace_id: workspaceId,
    states: STATES.map((code) => {
      const here = ours.filter((p) => p.states.has(code));
      const by = here.flatMap((p) => p.states.get(code)!);
      const who = [...new Set(by.map((c) => c.entity_id))];
      return {
        code,
        name: US_STATE_NAMES[code],
        status: here.length ? "unlocked" : anywhere.has(code) ? "available" : "unavailable",
        partners: who.map((entity_id) => ({ entity_id, name: names.get(entity_id) ?? null })),
        licences: [...new Set(by.map((c) => c.licence_id))]
          .map((id) => licences.get(id))
          .filter((l): l is Row => !!l)
          .map((l) => ({
            id: l.id as string,
            type: l.license_id as string,
            regulator: l.regulator_id as string,
            number: l.registration_number as string,
            expires_at: (l.valid_to as string | null) ?? null,
            status: l.status as string,
          })),
        products: here.map((p) => ({ id: p.id, name: p.name })),
        rails: rails
          .filter((r) => who.includes(r.entity_id as string) && ((r.states as string[]) ?? []).map((x) => x.toLowerCase()).includes(code))
          .map((r) => ({ kind: r.kind as string, direction: r.direction as string, provider: r.provider as string, status: r.status as string })),
      };
    }),
  };
}

// The licences covering the products the workspace's apps use, where they cover them (as get_compliance_coverage).
export async function workspaceLicences(store: Store, workspaceId: string, filter: { status?: string; regulator?: string; state?: string } = {}) {
  return licencesForProducts(store, await workspaceProductIds(store.db, workspaceId), filter);
}

export async function licencesForProducts(store: Store, used: string[], filter: { status?: string; regulator?: string; state?: string } = {}) {
  if (!used.length) return [];
  const where = new Map<string, Set<string>>();
  for (const p of await usedCoverage(store, used))
    for (const [st, covers] of p.states) for (const c of covers) where.set(c.licence_id, (where.get(c.licence_id) ?? new Set()).add(st));
  const licences = await licencesById(store.db, [...where.keys()]);
  return [...licences.values()]
    .map((l) => ({
      id: l.id as string,
      partner: { entity_id: l.entity_id as string, name: l.partner as string },
      type: l.license_id as string,
      regulator: l.regulator_id as string,
      number: l.registration_number as string,
      states: [...(where.get(l.id as string) ?? [])].sort(),
      status: l.status as string,
      expires_at: (l.valid_to as string | null) ?? null,
    }))
    .filter((l) => (!filter.status || l.status === filter.status) && (!filter.regulator || l.regulator === filter.regulator) && (!filter.state || l.states.includes(filter.state.toLowerCase())))
    .sort((a, b) => a.partner.name.localeCompare(b.partner.name) || a.type.localeCompare(b.type));
}

// ---- the workspace's audit trail ----

// Details are shown through redact(), and these keys never: whatever an action recorded under them.
const HIDDEN = /secret|token|password|key_hash|sealed|credential|api_?key|private_?key|authorization|cookie/i;
// What only owners and admins see: whom an invite went to (members see who's in, not who's been asked).
const MANAGERS_ONLY = new Set(["email", "invite_id"]);
function scrub(value: unknown, manager: boolean): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, manager));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => manager || !MANAGERS_ONLY.has(k))
        .map(([k, v]) => [k, HIDDEN.test(k) ? "[redacted]" : scrub(v, manager)]),
    );
  return value;
}

// The cursor carries the database's own timestamp text (microseconds), so rows in the same millisecond aren't skipped.
const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    return Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string" && DB_TIME.test(v[0]) && UUIDISH.test(v[1]) ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}
const UUIDISH = /^[0-9a-f-]{36}$/i;
// Postgres's own text for a timestamptz (e.g. "2026-01-02 00:00:00.123456+00"), as the cursor carries it.
const DB_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;

// A day (YYYY-MM-DD, a real calendar date) or an ISO time.
export function validTime(v: string): boolean {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return false;
  return !Number.isNaN(Date.parse(v));
}

export class AuditQueryError extends Error {}

// Events about the workspace, chosen by what they're about, never by searching text: the workspace itself (its
// members and invites), its apps (and what's done to them: keys and webhooks, by the app they name, deploys,
// hosting commands, releases), their builds, and decisions on its members' connections to its apps' repositories.
export async function workspaceAudit(
  db: Db,
  workspaceId: string,
  o: { cursor?: string; action?: string; user_id?: string; app_id?: string; from?: string; to?: string; limit: number; manager: boolean },
) {
  const after = o.cursor ? decodeCursor(o.cursor) : null;
  if (o.cursor && !after) throw new AuditQueryError("That cursor isn't one this tool gave out");
  for (const t of [o.from, o.to]) if (t && !validTime(t)) throw new AuditQueryError(`'${t}' isn't a date (YYYY-MM-DD) or an ISO time`);
  // Builds and repositories belong to a service this Mynt may not run: without its tables, there's nothing of theirs.
  const present = new Set(
    ((await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${T}' AND table_name IN ('build_runs', 'app_repositories')`)).rows as {
      table_name: string;
    }[]).map((r) => r.table_name),
  );
  const builds = present.has("build_runs")
    ? `SELECT b.id, b.app_id, b.goal FROM ${T}.build_runs b WHERE b.app_id IN (SELECT id FROM apps)`
    : "SELECT NULL::uuid AS id, NULL::uuid AS app_id, NULL::text AS goal WHERE false";
  const repos = present.has("app_repositories")
    ? `SELECT r.repository FROM ${T}.app_repositories r WHERE r.app_id IN (SELECT id FROM apps)
       UNION SELECT r.managed_repository FROM ${T}.app_repositories r WHERE r.app_id IN (SELECT id FROM apps) AND r.managed_repository IS NOT NULL`
    : "SELECT NULL::text AS repository WHERE false";
  let filtered: Row[];
  try {
    filtered = (
      await db.query(
        `WITH apps AS (SELECT id, name FROM ${T}.apps WHERE workspace_id::text = $1),
              builds AS (${builds}),
              repos AS (${repos}),
              members AS (SELECT user_id FROM ${T}.workspace_members WHERE workspace_id::text = $1),
              events AS (
                SELECT l.id::text AS id, l.created_at, l.created_at::text AS at_text, l.action, l.target, l.details, l.actor_id::text AS actor_id,
                  CASE WHEN l.target = $1 THEN 'workspace'
                       WHEN l.target IN (SELECT id::text FROM apps) THEN 'app'
                       WHEN l.target IN (SELECT id::text FROM builds) THEN 'build'
                       WHEN l.details->>'app_id' IN (SELECT id::text FROM apps) THEN split_part(l.action, '_', array_length(string_to_array(l.action, '_'), 1))
                       ELSE 'repository_connection' END AS target_type,
                  COALESCE((SELECT a.id::text FROM apps a WHERE a.id::text = l.target),
                           (SELECT b.app_id::text FROM builds b WHERE b.id::text = l.target),
                           (SELECT a.id::text FROM apps a WHERE a.id::text = l.details->>'app_id')) AS app_id
                FROM ${T}.audit_log l
                WHERE l.target = $1
                   OR l.target IN (SELECT id::text FROM apps)
                   OR l.target IN (SELECT id::text FROM builds)
                   OR l.details->>'app_id' IN (SELECT id::text FROM apps)
                   OR (l.action IN ('approve_repository_connection', 'reject_repository_connection')
                       AND l.details->>'kind' = 'developer'
                       AND l.details->>'repository' IN (SELECT repository FROM repos)
                       AND l.details->>'user_id' IN (SELECT user_id::text FROM members))
              )
         SELECT e.*, u.name AS actor_name,
           COALESCE((SELECT a.name FROM apps a WHERE a.id::text = e.target),
                    (SELECT left(b.goal, 80) FROM builds b WHERE b.id::text = e.target),
                    (SELECT w.name FROM ${T}.workspaces w WHERE w.id::text = e.target),
                    e.details->>'repository',
                    (SELECT a.name FROM apps a WHERE a.id::text = e.app_id)) AS target_name
         FROM events e LEFT JOIN ${T}.users u ON u.id::text = e.actor_id
         WHERE ($2::text IS NULL OR e.action = $2)
           AND ($3::text IS NULL OR e.actor_id = $3)
           AND ($4::timestamptz IS NULL OR e.created_at >= $4)
           AND ($5::timestamptz IS NULL OR e.created_at < $5)
           AND ($6::timestamptz IS NULL OR (e.created_at, e.id) < ($6::timestamptz, $7::text))
           AND ($8::text IS NULL OR e.app_id = $8)
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT $9`,
        [workspaceId, o.action ?? null, o.user_id ?? null, o.from ?? null, o.to ?? null, after?.[0] ?? null, after?.[1] ?? null, o.app_id ?? null, o.limit + 1],
      )
    ).rows as Row[];
  } catch (e) {
    console.error(`list_workspace_audit: ${(e as Error).message}`);
    throw new AuditQueryError("The audit trail couldn't be read with those filters");
  }
  const page = filtered.slice(0, o.limit);
  const events = page.map((x) => ({
    at: iso(x.created_at),
    actor: x.actor_id ? { id: x.actor_id as string, name: (x.actor_name as string | null) ?? null } : { id: null, name: "Mynt" },
    action: x.action as string,
    target: { type: x.target_type as string, id: x.target as string, name: (x.target_name as string | null) ?? null },
    details: scrub(x.details ?? {}, o.manager),
  }));
  const last = page.at(-1);
  return { events, next_cursor: filtered.length > o.limit && last ? encodeCursor(last.at_text as string, last.id as string) : null };
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const day = z.string().refine(validTime, "A date (YYYY-MM-DD) or an ISO time");

export function registerWorkspaceComplianceTools(server: McpServer, store: Store, user: User) {
  const role = (id: string) => workspaceRole(store.db, id, user.id);
  const notYours = (id: string) => fail(`No workspace of yours with id '${id}'`);

  server.registerTool(
    "get_compliance_coverage",
    {
      title: "Where a workspace's products are covered",
      description:
        "Developer: for each of the 50 US states and DC, whether the workspace's apps can serve it, by Mynt's own rules (every regulated component of a product covered there by a licence in force, under an approved sponsorship where a licence provider provides it, and the product's sales not paused). unlocked: a product one of its apps uses is covered there (with the firms whose licences cover it, those licences, the products and those firms' approved money rails there). available: some other published product is covered there. unavailable: none is.",
      inputSchema: { workspace_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => ((await role(workspace_id)) ? json(await complianceCoverage(store, workspace_id)) : notYours(workspace_id)),
  );

  server.registerTool(
    "list_workspace_licences",
    {
      title: "Licences behind a workspace's products",
      description:
        "Developer: the licences covering the products the workspace's apps use (as get_compliance_coverage counts them): whose they are, type, regulator, number, the states they cover them in, status and expiry.",
      inputSchema: {
        workspace_id: z.string(),
        status: z.enum(["pending", "verified", "rejected", "suspended"]).optional(),
        regulator: z.string().optional(),
        state: z.string().regex(/^us-[a-z]{2}$/i, "A US state as ISO 3166-2, e.g. 'us-ny'").optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, status, regulator, state }) =>
      (await role(workspace_id)) ? json({ licences: await workspaceLicences(store, workspace_id, { status, regulator, state }) }) : notYours(workspace_id),
  );

  server.registerTool(
    "list_workspace_audit",
    {
      title: "A workspace's audit trail",
      description:
        "Developer: what happened in a workspace, newest first: to its apps (their keys, webhooks, deployments and releases), their builds, its members and invites, and decisions on its members' connections to its apps' repositories. Secrets are never shown, and whom an invite went to only to owners and admins. Page with next_cursor.",
      inputSchema: {
        workspace_id: z.string(),
        cursor: z.string().optional(),
        action: z.string().optional(),
        user_id: z.string().optional().describe("Only what this person did"),
        app_id: z.string().optional().describe("Only events about this app or its builds"),
        from: day.optional(),
        to: day.optional().describe("Before this time (a date means its start)"),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, ...o }) => {
      const mine = await role(workspace_id);
      if (!mine) return notYours(workspace_id);
      try {
        return json(await workspaceAudit(store.db, workspace_id, { ...o, manager: mine !== "member" }));
      } catch (e) {
        if (e instanceof AuditQueryError) return fail(e.message);
        throw e;
      }
    },
  );
}
