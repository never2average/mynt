import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { auditForAdmin } from "./covenants.js";
import type { Db } from "./db.js";

// The platform admin's reads across every workspace, app and financial product (Mynt Studio's Admin area,
// platform/studio/app/(studio)/admin). Admins only, read-only, paged. Nothing here changes anything: the admin
// actions the Studio offers are the existing admin tools (remove_app, register_firm, review_license, ...). No preview
// link, key, token or sealed value is ever in an answer.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true });
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());
const exists = async (db: Db, table: string) => !!(await db.query(`SELECT to_regclass('${T}.${table}') AS t`)).rows[0]?.t;
const like = (q: string | undefined) => (q && q.trim() ? `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null);

const page = {
  limit: z.number().int().min(1).max(500).default(100).describe("Rows per page (at most 500)"),
  offset: z.number().int().min(0).default(0),
};

// A workspace's status, in one word: archived (by an owner), frozen (its organization was deleted in the identity
// provider: frozen until an owner relinks or archives it) or active.
const WORKSPACE_STATUS = `CASE WHEN w.archived_at IS NOT NULL THEN 'archived' WHEN w.org_missing_at IS NOT NULL THEN 'frozen' ELSE 'active' END`;
const workspaceRow = (r: Record<string, unknown>) => ({
  id: r.id as string,
  name: r.name as string,
  personal: r.personal === true,
  status: r.status as string,
  owner: r.owner_id ? { id: r.owner_id as string, name: (r.owner_name as string | null) ?? null, email: (r.owner_email as string | null) ?? null } : null,
  members: Number(r.members ?? 0),
  apps: Number(r.apps ?? 0),
  created_at: iso(r.created_at),
  archived_at: iso(r.archived_at),
  org_missing_at: iso(r.org_missing_at),
});
const WORKSPACE_SELECT = `
  SELECT w.id::text AS id, w.name, w.personal, ${WORKSPACE_STATUS} AS status, w.created_at, w.archived_at, w.org_missing_at,
         u.id::text AS owner_id, u.name AS owner_name, u.email AS owner_email,
         (SELECT count(*)::int FROM ${T}.workspace_members m WHERE m.workspace_id = w.id) AS members,
         (SELECT count(*)::int FROM ${T}.apps a WHERE a.workspace_id = w.id) AS apps
  FROM ${T}.workspaces w
  LEFT JOIN LATERAL (SELECT m.user_id FROM ${T}.workspace_members m WHERE m.workspace_id = w.id AND m.role = 'owner' ORDER BY m.joined_at LIMIT 1) o ON true
  LEFT JOIN ${T}.users u ON u.id = o.user_id`;

// The optional tables the app reads join: each service creates its own, so a server without it reads none.
async function appParts(db: Db) {
  const [promotions, builds, hosting] = await Promise.all([exists(db, "app_promotions"), exists(db, "build_runs"), exists(db, "hosted_apps")]);
  return {
    stage: promotions ? `COALESCE((SELECT ap.stage FROM ${T}.app_promotions ap WHERE ap.app_id = a.id), 'idea')` : `'idea'`,
    build: builds
      ? `(SELECT json_build_object('id', b.id::text, 'status', b.status, 'created_at', b.created_at) FROM ${T}.build_runs b WHERE b.app_id = a.id ORDER BY b.created_at DESC LIMIT 1)`
      : "NULL::json",
    builds: builds ? `(SELECT count(*)::int FROM ${T}.build_runs b WHERE b.app_id = a.id)` : "NULL::int",
    hosting: hosting ? `(SELECT json_build_object('status', h.status, 'updated_at', h.updated_at) FROM ${T}.hosted_apps h WHERE h.app_id = a.id)` : "NULL::json",
    hasBuilds: builds,
    hasHosting: hosting,
  };
}
const appRow = (r: Record<string, unknown>) => {
  const b = r.latest_build as { id: string; status: string; created_at: string } | null;
  const h = r.hosting as { status: string; updated_at: string } | null;
  return {
    id: r.id as string,
    name: r.name as string,
    status: r.status as string,
    stage: r.stage as string,
    workspace: r.workspace_id ? { id: r.workspace_id as string, name: (r.workspace_name as string | null) ?? null } : null,
    owner: r.owner_id ? { id: r.owner_id as string, name: (r.owner_name as string | null) ?? null, email: (r.owner_email as string | null) ?? null } : null,
    product_ids: (r.product_ids as string[] | null) ?? [],
    latest_build: b ? { id: b.id, status: b.status, created_at: iso(b.created_at) } : null,
    builds: r.builds === null || r.builds === undefined ? null : Number(r.builds),
    hosting: h ? { status: h.status, updated_at: iso(h.updated_at) } : null,
    created_at: iso(r.created_at),
  };
};
const appSelect = (p: Awaited<ReturnType<typeof appParts>>) => `
  SELECT a.id::text AS id, a.name, a.status, a.product_ids, a.created_at, ${p.stage} AS stage,
         w.id::text AS workspace_id, w.name AS workspace_name, u.id::text AS owner_id, u.name AS owner_name, u.email AS owner_email,
         ${p.build} AS latest_build, ${p.builds} AS builds, ${p.hosting} AS hosting
  FROM ${T}.apps a
  LEFT JOIN ${T}.workspaces w ON w.id = a.workspace_id
  LEFT JOIN ${T}.users u ON u.id = a.owner_id`;

export function registerPlatformAdminTools(server: McpServer, db: Db) {
  server.registerTool(
    "list_all_workspaces",
    {
      title: "Every workspace",
      description:
        "Admin: every workspace on Mynt, newest first, paged: its name, first owner, members and apps counted, status (active; archived by an owner; or frozen, its organization deleted in the identity provider until an owner relinks or archives it) and when it was made. query matches the name, the owner's email or the id.",
      inputSchema: { query: z.string().max(200).optional(), status: z.enum(["active", "archived", "frozen"]).optional(), ...page },
      annotations: { readOnlyHint: true },
    },
    async ({ query, status, limit, offset }) => {
      const where = `WHERE ($1::text IS NULL OR w.name ILIKE $1 OR u.email ILIKE $1 OR w.id::text = $2) AND ($3::text IS NULL OR ${WORKSPACE_STATUS} = $3)`;
      const args = [like(query), query?.trim() ?? null, status ?? null];
      const total = Number((await db.query(`SELECT count(*)::int AS n FROM (${WORKSPACE_SELECT} ${where}) x`, args)).rows[0]?.n ?? 0);
      const { rows } = await db.query(`${WORKSPACE_SELECT} ${where} ORDER BY w.created_at DESC, w.id LIMIT $4 OFFSET $5`, [...args, limit, offset]);
      return json({ workspaces: rows.map(workspaceRow), total, limit, offset });
    },
  );

  server.registerTool(
    "admin_get_workspace",
    {
      title: "One workspace, as an admin sees it",
      description:
        "Admin: one workspace with its members (name, email, role, when they joined), its apps (stage, status, latest build), its invitations (open, accepted, declined or revoked) and its latest activity from the audit log (events about the workspace or its apps, newest first).",
      inputSchema: { workspace_id: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const w = (await db.query(`${WORKSPACE_SELECT} WHERE w.id = $1`, [workspace_id])).rows[0];
      if (!w) return fail(`No workspace '${workspace_id}'`);
      const members = (
        await db.query(
          `SELECT u.id::text AS user_id, u.name, u.email, m.role, m.joined_at FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id
           WHERE m.workspace_id = $1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at`,
          [workspace_id],
        )
      ).rows.map((r) => ({ user_id: r.user_id as string, name: (r.name as string | null) ?? null, email: (r.email as string | null) ?? null, role: r.role as string, joined_at: iso(r.joined_at) }));
      const parts = await appParts(db);
      const apps = (await db.query(`${appSelect(parts)} WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT 500`, [workspace_id])).rows.map(appRow);
      const invitations = (
        await db.query(
          `SELECT i.id::text AS id, i.email, i.role, i.mynt_role, i.created_at, i.accepted_at, i.declined_at, i.revoked_at, u.name AS invited_by
           FROM ${T}.workspace_invites i LEFT JOIN ${T}.users u ON u.id = i.invited_by WHERE i.workspace_id = $1 ORDER BY i.created_at DESC LIMIT 200`,
          [workspace_id],
        )
      ).rows.map((r) => ({
        id: r.id as string,
        email: r.email as string,
        role: r.role as string,
        mynt_role: r.mynt_role as string,
        status: r.accepted_at ? "accepted" : r.revoked_at ? "revoked" : r.declined_at ? "declined" : "open",
        invited_by: (r.invited_by as string | null) ?? null,
        created_at: iso(r.created_at),
      }));
      const appIds = apps.map((a) => a.id);
      const activity = (
        await db.query(
          `SELECT l.id::text AS id, l.action, l.target, l.details, l.created_at, u.name AS actor FROM ${T}.audit_log l LEFT JOIN ${T}.users u ON u.id = l.actor_id
           WHERE l.target = $1 OR l.target = ANY($2::text[]) OR l.details->>'app_id' = ANY($2::text[]) OR l.details->>'workspace_id' = $1
           ORDER BY l.created_at DESC LIMIT 50`,
          [workspace_id, appIds],
        )
      ).rows.map((r) => auditForAdmin({ id: r.id as string, action: r.action as string, target: r.target as string, actor: (r.actor as string | null) ?? null, details: r.details, created_at: iso(r.created_at) }));
      return json({ workspace: workspaceRow(w), members, apps, invitations, activity });
    },
  );

  server.registerTool(
    "list_all_apps",
    {
      title: "Every app",
      description:
        "Admin: every app on Mynt across all workspaces, newest first, paged: its workspace, owner, stage (idea, staging or production), status, products, latest build and whether Mynt hosts it. query matches the name, the workspace's name, the owner's email or the id. Remove a test app with remove_app.",
      inputSchema: {
        query: z.string().max(200).optional(),
        workspace_id: z.string().uuid().optional(),
        stage: z.enum(["idea", "staging", "production"]).optional(),
        ...page,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, workspace_id, stage, limit, offset }) => {
      const parts = await appParts(db);
      const where = `WHERE ($1::text IS NULL OR a.name ILIKE $1 OR w.name ILIKE $1 OR u.email ILIKE $1 OR a.id::text = $2) AND ($3::uuid IS NULL OR a.workspace_id = $3) AND ($4::text IS NULL OR ${parts.stage} = $4)`;
      const args = [like(query), query?.trim() ?? null, workspace_id ?? null, stage ?? null];
      const total = Number((await db.query(`SELECT count(*)::int AS n FROM ${T}.apps a LEFT JOIN ${T}.workspaces w ON w.id = a.workspace_id LEFT JOIN ${T}.users u ON u.id = a.owner_id ${where}`, args)).rows[0]?.n ?? 0);
      const { rows } = await db.query(`${appSelect(parts)} ${where} ORDER BY a.created_at DESC, a.id LIMIT $5 OFFSET $6`, [...args, limit, offset]);
      return json({ apps: rows.map(appRow), total, limit, offset });
    },
  );

  server.registerTool(
    "admin_get_app",
    {
      title: "One app, as an admin sees it",
      description:
        "Admin: one app with its workspace, owner, stage, products (with names), its latest coding-agent builds (status, goal, cost, when; never a preview link) and its hosting on Mynt (status, runtime, last error), if any.",
      inputSchema: { app_id: z.string().uuid() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      const parts = await appParts(db);
      const a = (await db.query(`${appSelect(parts)} WHERE a.id = $1`, [app_id])).rows[0];
      if (!a) return fail(`No app '${app_id}'`);
      const app = appRow(a);
      const names = new Map(
        (await db.query(`SELECT id, data->>'name' AS name FROM ${T}.products WHERE id = ANY($1::text[])`, [app.product_ids])).rows.map((r) => [r.id as string, r.name as string]),
      );
      const builds = parts.hasBuilds
        ? (
            await db.query(
              `SELECT id::text AS id, status, left(goal, 300) AS goal, cost_usd, created_at, finished_at, left(coalesce(error, ''), 300) AS error FROM ${T}.build_runs WHERE app_id = $1 ORDER BY created_at DESC LIMIT 50`,
              [app_id],
            )
          ).rows.map((r) => ({ id: r.id as string, status: r.status as string, goal: r.goal as string, cost_usd: Number(r.cost_usd ?? 0), created_at: iso(r.created_at), finished_at: iso(r.finished_at), error: (r.error as string) || null }))
        : null;
      const hosting = parts.hasHosting
        ? ((
            await db.query(`SELECT status, runtime, left(coalesce(error, ''), 300) AS error, updated_at, build_id::text AS build_id FROM ${T}.hosted_apps WHERE app_id = $1`, [app_id])
          ).rows.map((r) => ({ status: r.status as string, runtime: (r.runtime as string | null) ?? null, error: (r.error as string) || null, build_id: r.build_id as string, updated_at: iso(r.updated_at) }))[0] ?? null)
        : null;
      return json({ app: { ...app, products: app.product_ids.map((id) => ({ id, name: names.get(id) ?? null })) }, builds, hosting });
    },
  );

  server.registerTool(
    "list_all_products",
    {
      title: "Every financial product",
      description:
        "Admin: every financial product on Mynt across all firms, newest first, paged: its name, line and region, the firm that owns it (none: one of Mynt's reference products), status, stage (idea, staging or production), whether it's archived, and its sponsors (licence providers' sponsorships, approved or pending). query matches the name, the id or the firm's name.",
      inputSchema: {
        query: z.string().max(200).optional(),
        status: z.enum(["draft", "published", "unpublished"]).optional(),
        include_archived: z.boolean().default(true),
        ...page,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, status, include_archived, limit, offset }) => {
      const sponsors = (await exists(db, "sponsorships"))
        ? `(SELECT COALESCE(json_agg(json_build_object('entity_id', s.provider_entity_id::text, 'name', se.name, 'status', s.status) ORDER BY se.name), '[]'::json)
             FROM (SELECT DISTINCT provider_entity_id, status FROM ${T}.sponsorships WHERE product_id = p.id AND status IN ('approved', 'pending')) s
             JOIN ${T}.entities se ON se.id = s.provider_entity_id)`
        : `'[]'::json`;
      const where = `WHERE ($1::text IS NULL OR p.data->>'name' ILIKE $1 OR e.name ILIKE $1 OR p.id = $2) AND ($3::text IS NULL OR p.status = $3) AND ($4::boolean OR p.archived_at IS NULL)`;
      const args = [like(query), query?.trim() ?? null, status ?? null, include_archived];
      const from = `FROM ${T}.products p LEFT JOIN ${T}.users u ON u.id = p.owner_id LEFT JOIN ${T}.entities e ON e.id = p.entity_id`;
      const total = Number((await db.query(`SELECT count(*)::int AS n ${from} ${where}`, args)).rows[0]?.n ?? 0);
      const { rows } = await db.query(
        `SELECT p.id, p.data->>'name' AS name, p.data->>'product_line' AS product_line, p.data->>'region' AS region, p.status, p.stage, p.archived_at, p.created_at, p.updated_at,
                e.id::text AS entity_id, e.name AS entity_name, u.id::text AS owner_id, u.name AS owner_name, ${sponsors} AS sponsors
         ${from} ${where} ORDER BY p.created_at DESC, p.id LIMIT $5 OFFSET $6`,
        [...args, limit, offset],
      );
      return json({
        products: rows.map((r) => ({
          id: r.id as string,
          name: (r.name as string | null) ?? (r.id as string),
          product_line: (r.product_line as string | null) ?? null,
          region: (r.region as string | null) ?? null,
          status: r.status as string,
          stage: r.status === "published" ? "production" : r.stage === "staging" ? "staging" : "idea",
          archived: r.archived_at !== null && r.archived_at !== undefined,
          archived_at: iso(r.archived_at),
          firm: r.entity_id ? { id: r.entity_id as string, name: r.entity_name as string } : null,
          owner: r.owner_id ? { id: r.owner_id as string, name: (r.owner_name as string | null) ?? null } : null,
          sponsors: (r.sponsors as { entity_id: string; name: string; status: string }[] | null) ?? [],
          created_at: iso(r.created_at),
          updated_at: iso(r.updated_at),
        })),
        total,
        limit,
        offset,
      });
    },
  );
}
