import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { redact } from "./boxes.js";
import type { Db } from "./db.js";
import type { Store, User } from "./store.js";
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

// A sponsorship's jurisdictions as states: "us" is the whole country.
const statesOf = (jurisdictions: string[]) => new Set(jurisdictions.flatMap((j) => (j.toLowerCase() === "us" ? STATES : [j.toLowerCase()])));

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

interface Sponsorship {
  id: string;
  product_id: string;
  provider_entity_id: string;
  provider_name: string;
  licence_ids: string[];
  jurisdictions: string[];
}

// Approved sponsorships of published products: those `productIds` names, or (null) every one.
async function approvedSponsorships(db: Db, productIds: string[] | null): Promise<Sponsorship[]> {
  return (
    await rows(
      db,
      `SELECT s.id::text AS id, s.product_id, s.provider_entity_id::text AS provider_entity_id, e.name AS provider_name,
         s.licence_ids::text[] AS licence_ids, s.jurisdictions
       FROM ${T}.sponsorships s JOIN ${T}.products p ON p.id = s.product_id AND p.status = 'published'
       JOIN ${T}.entities e ON e.id = s.provider_entity_id
       WHERE s.status = 'approved' AND ($1::text[] IS NULL OR s.product_id = ANY($1))`,
      [productIds],
    )
  ).map((r) => ({ ...(r as unknown as Sponsorship), licence_ids: (r.licence_ids as string[]) ?? [], jurisdictions: (r.jurisdictions as string[]) ?? [] }));
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

export async function complianceCoverage(db: Db, workspaceId: string) {
  const used = await workspaceProductIds(db, workspaceId);
  const ours = await approvedSponsorships(db, used.length ? used : ["\u0000none"]);
  // Anyone's approved sponsorship of a published product, only to tell "available" from "unavailable": nothing of
  // theirs is shown.
  const anywhere = new Set<string>();
  for (const s of await approvedSponsorships(db, null)) for (const st of statesOf(s.jurisdictions)) anywhere.add(st);
  const licences = await licencesById(db, [...new Set(ours.flatMap((s) => s.licence_ids))]);
  const products = new Map(
    (await rows(db, `SELECT id, data->>'name' AS name FROM ${T}.products WHERE id = ANY($1)`, [[...new Set(ours.map((s) => s.product_id))]])).map((r) => [
      r.id as string,
      r.name as string,
    ]),
  );
  const providers = [...new Set(ours.map((s) => s.provider_entity_id))];
  const rails = await rows(
    db,
    `SELECT entity_id::text AS entity_id, kind, direction, provider, status, states FROM ${T}.money_rails WHERE status = 'approved' AND entity_id::text = ANY($1)`,
    [providers],
  );
  return {
    workspace_id: workspaceId,
    states: STATES.map((code) => {
      const here = ours.filter((s) => statesOf(s.jurisdictions).has(code));
      const partners = new Map(here.map((s) => [s.provider_entity_id, s.provider_name]));
      const lic = [...new Set(here.flatMap((s) => s.licence_ids))]
        .map((id) => licences.get(id))
        .filter((l): l is Row => !!l && (l.jurisdiction == null || String(l.jurisdiction).toLowerCase() === code || String(l.jurisdiction).toLowerCase() === "us"));
      return {
        code,
        name: US_STATE_NAMES[code],
        status: here.length ? "unlocked" : anywhere.has(code) ? "available" : "unavailable",
        partners: [...partners].map(([entity_id, name]) => ({ entity_id, name })),
        licences: lic.map((l) => ({
          id: l.id as string,
          type: l.license_id as string,
          regulator: l.regulator_id as string,
          number: l.registration_number as string,
          expires_at: (l.valid_to as string | null) ?? null,
          status: l.status as string,
        })),
        products: [...new Set(here.map((s) => s.product_id))].map((id) => ({ id, name: products.get(id) ?? id })),
        rails: rails
          .filter((r) => partners.has(r.entity_id as string) && ((r.states as string[]) ?? []).map((x) => x.toLowerCase()).includes(code))
          .map((r) => ({ kind: r.kind as string, direction: r.direction as string, provider: r.provider as string, status: r.status as string })),
      };
    }),
  };
}

// The licences behind the sponsorships of the products the workspace's apps use.
export async function workspaceLicences(db: Db, workspaceId: string, filter: { status?: string; regulator?: string; state?: string } = {}) {
  return licencesForProducts(db, await workspaceProductIds(db, workspaceId), filter);
}

// The licences behind the approved sponsorships of these (published) products.
export async function licencesForProducts(db: Db, used: string[], filter: { status?: string; regulator?: string; state?: string } = {}) {
  if (!used.length) return [];
  const ours = await approvedSponsorships(db, used);
  const licences = await licencesById(db, [...new Set(ours.flatMap((s) => s.licence_ids))]);
  const out = [...licences.values()].map((l) => {
    // Where it counts for this workspace: its own jurisdiction, within what the sponsorships naming it approved.
    const approved = new Set(ours.filter((s) => s.licence_ids.includes(l.id as string)).flatMap((s) => [...statesOf(s.jurisdictions)]));
    const own = l.jurisdiction ? statesOf([String(l.jurisdiction)]) : null;
    const states = [...approved].filter((st) => !own || own.has(st)).sort();
    return {
      id: l.id as string,
      partner: { entity_id: l.entity_id as string, name: l.partner as string },
      type: l.license_id as string,
      regulator: l.regulator_id as string,
      number: l.registration_number as string,
      states,
      status: l.status as string,
      expires_at: (l.valid_to as string | null) ?? null,
    };
  });
  return out
    .filter((l) => (!filter.status || l.status === filter.status) && (!filter.regulator || l.regulator === filter.regulator) && (!filter.state || l.states.includes(filter.state.toLowerCase())))
    .sort((a, b) => a.partner.name.localeCompare(b.partner.name) || a.type.localeCompare(b.type));
}

// ---- the workspace's audit trail ----

// Details are shown through redact(), and these keys never: whatever an action recorded under them.
const HIDDEN = /secret|token|password|key_hash|sealed|credential/i;
function scrub(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, HIDDEN.test(k) ? "[redacted]" : scrub(v)]));
  return value;
}

const encodeCursor = (at: string, id: string) => Buffer.from(JSON.stringify([at, id])).toString("base64url");
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    return Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string" && !Number.isNaN(Date.parse(v[0])) ? [v[0], v[1]] : null;
  } catch {
    return null;
  }
}

// Events about the workspace, chosen by what they're about, never by searching text: the workspace itself (its
// members and invites), its apps (and what's done to them: keys, deploys, hosting commands, releases), their builds,
// and decisions on connections to its apps' repositories made for its members.
export async function workspaceAudit(
  db: Db,
  workspaceId: string,
  o: { cursor?: string; action?: string; user_id?: string; app_id?: string; from?: string; to?: string; limit: number },
) {
  const after = o.cursor ? decodeCursor(o.cursor) : null;
  if (o.cursor && !after) throw new Error("That cursor isn't one this tool gave out");
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
  const filtered = (
    await db.query(
      `WITH apps AS (SELECT id, name FROM ${T}.apps WHERE workspace_id::text = $1),
            builds AS (${builds}),
            repos AS (${repos}),
            members AS (SELECT user_id FROM ${T}.workspace_members WHERE workspace_id::text = $1),
            events AS (
              SELECT l.id::text AS id, l.created_at, l.action, l.target, l.details, l.actor_id::text AS actor_id,
                CASE WHEN l.target = $1 THEN 'workspace'
                     WHEN l.target IN (SELECT id::text FROM apps) THEN 'app'
                     WHEN l.target IN (SELECT id::text FROM builds) THEN 'build'
                     ELSE 'repository_connection' END AS target_type,
                COALESCE((SELECT a.id::text FROM apps a WHERE a.id::text = l.target), (SELECT b.app_id::text FROM builds b WHERE b.id::text = l.target)) AS app_id
              FROM ${T}.audit_log l
              WHERE l.target = $1
                 OR l.target IN (SELECT id::text FROM apps)
                 OR l.target IN (SELECT id::text FROM builds)
                 OR (l.action IN ('approve_repository_connection', 'reject_repository_connection')
                     AND l.details->>'kind' = 'developer'
                     AND l.details->>'repository' IN (SELECT repository FROM repos)
                     AND l.details->>'user_id' IN (SELECT user_id::text FROM members))
            )
       SELECT e.*, u.name AS actor_name,
         COALESCE((SELECT a.name FROM apps a WHERE a.id::text = e.target),
                  (SELECT left(b.goal, 80) FROM builds b WHERE b.id::text = e.target),
                  (SELECT w.name FROM ${T}.workspaces w WHERE w.id::text = e.target),
                  e.details->>'repository') AS target_name
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
  const page = filtered.slice(0, o.limit);
  const events = page.map((x) => ({
    at: iso(x.created_at),
    actor: x.actor_id ? { id: x.actor_id as string, name: (x.actor_name as string | null) ?? null } : { id: null, name: "Mynt" },
    action: x.action as string,
    target: { type: x.target_type as string, id: x.target as string, name: (x.target_name as string | null) ?? null },
    details: scrub(x.details ?? {}),
  }));
  const last = page.at(-1);
  return { events, next_cursor: filtered.length > o.limit && last ? encodeCursor(iso(last.created_at)!, last.id as string) : null };
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/, "A date (YYYY-MM-DD) or an ISO time");

export function registerWorkspaceComplianceTools(server: McpServer, store: Store, user: User) {
  const member = async (id: string) => !!(await workspaceRole(store.db, id, user.id));
  const notYours = (id: string) => fail(`No workspace of yours with id '${id}'`);

  server.registerTool(
    "get_compliance_coverage",
    {
      title: "Where a workspace's products are covered",
      description:
        "Developer: for each of the 50 US states and DC, whether the workspace's apps can serve it. unlocked: a product one of its apps uses has a licence provider's approved sponsorship there (with the partners, their licences, the products and the partners' approved money rails there). available: some published product is sponsored there, but none the workspace uses. unavailable: none is.",
      inputSchema: { workspace_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => ((await member(workspace_id)) ? json(await complianceCoverage(store.db, workspace_id)) : notYours(workspace_id)),
  );

  server.registerTool(
    "list_workspace_licences",
    {
      title: "Licences behind a workspace's products",
      description:
        "Developer: the licences backing the approved sponsorships of the products the workspace's apps use: whose they are, type, regulator, number, the states they count in for this workspace, status and expiry.",
      inputSchema: {
        workspace_id: z.string(),
        status: z.enum(["pending", "verified", "rejected", "suspended"]).optional(),
        regulator: z.string().optional(),
        state: z.string().regex(/^us-[a-z]{2}$/i, "A US state as ISO 3166-2, e.g. 'us-ny'").optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, status, regulator, state }) =>
      (await member(workspace_id)) ? json({ licences: await workspaceLicences(store.db, workspace_id, { status, regulator, state }) }) : notYours(workspace_id),
  );

  server.registerTool(
    "list_workspace_audit",
    {
      title: "A workspace's audit trail",
      description:
        "Developer: what happened in a workspace, newest first: to its apps, their builds and deployments, its members and invites, and decisions on its members' connections to its apps' repositories. Secrets are never shown. Page with next_cursor.",
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
      if (!(await member(workspace_id))) return notYours(workspace_id);
      try {
        return json(await workspaceAudit(store.db, workspace_id, o));
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
}
