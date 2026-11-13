import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction, type Db } from "./db.js";
import type { App, Store, User } from "./store.js";

// Workspaces: the teams developers build apps in. Every app belongs to one workspace, and everyone in it may see and
// work on its apps and their builds (build, steer, deploy). Only its owners and admins manage who is in it.
// Workspaces are not firms (entities): a firm is a regulated legal party; a workspace is just who works on which apps.
//
// Joining is invite → membership, as for Mynt itself: an owner or admin invites an email address with a role, and the
// invite is accepted when someone signs in with that verified address. Nothing here reads an allow-list from settings.

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

const T = "financial_products";

export const WORKSPACE_TABLES = `
  CREATE TABLE IF NOT EXISTS ${T}.workspaces (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ${T}.workspace_members (
    workspace_id uuid NOT NULL REFERENCES ${T}.workspaces(id),
    user_id uuid NOT NULL REFERENCES ${T}.users(id),
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON ${T}.workspace_members (user_id);
  CREATE TABLE IF NOT EXISTS ${T}.workspace_invites (
    id uuid PRIMARY KEY,
    workspace_id uuid NOT NULL REFERENCES ${T}.workspaces(id),
    email text NOT NULL CHECK (email = lower(email)),
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    invited_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    accepted_at timestamptz,
    accepted_by uuid REFERENCES ${T}.users(id),
    revoked_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_open_idx ON ${T}.workspace_invites (workspace_id, email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
  CREATE INDEX IF NOT EXISTS workspace_invites_email_idx ON ${T}.workspace_invites (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
  ALTER TABLE ${T}.apps ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES ${T}.workspaces(id);
  CREATE INDEX IF NOT EXISTS apps_workspace_idx ON ${T}.apps (workspace_id);
`;

type Q = Pick<Db, "query">;
const one = async (q: Q, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows[0] as Record<string, unknown> | undefined;

const personalName = (u: { name?: string | null; email?: string | null }) => `${(u.name || u.email || "My").trim().slice(0, 180)}'s workspace`;

async function insertWorkspace(q: Q, name: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await q.query(`INSERT INTO ${T}.workspaces (id, name, created_by) VALUES ($1, $2, $3)`, [id, name, ownerId]);
  await q.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, ownerId]);
  return id;
}

// Apps made before workspaces: each owner gets one workspace, "<their name>'s workspace", owned by them, holding all
// their apps. Idempotent; one server at a time (an advisory lock), so two starting together don't both create one.
export async function migrateAppWorkspaces(db: Db): Promise<number> {
  if (!(await one(db, `SELECT 1 FROM ${T}.apps WHERE workspace_id IS NULL LIMIT 1`))) return 0;
  return inTransaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('mynt.app_workspaces'))");
    const owners = (
      await tx.query(
        `SELECT DISTINCT u.id, u.name, u.email FROM ${T}.apps a JOIN ${T}.users u ON u.id = a.owner_id WHERE a.workspace_id IS NULL`,
      )
    ).rows as { id: string; name: string | null; email: string | null }[];
    for (const u of owners) {
      const id = await insertWorkspace(tx, personalName(u), u.id);
      const moved = (await tx.query(`UPDATE ${T}.apps SET workspace_id = $1 WHERE owner_id = $2 AND workspace_id IS NULL RETURNING id`, [id, u.id])).rows.length;
      await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, NULL, 'workspace_migrated', $2, $3)`, [
        randomUUID(),
        id,
        JSON.stringify({ owner_id: u.id, apps: moved }),
      ]);
    }
    return owners.length;
  });
}

// The workspace an app goes in when none is named: the oldest one the user owns, or a new one of their own.
export async function personalWorkspace(db: Db, userId: string): Promise<string> {
  const owned = await one(db, `SELECT workspace_id FROM ${T}.workspace_members WHERE user_id = $1 AND role = 'owner' ORDER BY joined_at LIMIT 1`, [userId]);
  if (owned) return owned.workspace_id as string;
  const u = (await one(db, `SELECT name, email FROM ${T}.users WHERE id = $1`, [userId])) as { name: string | null; email: string | null } | undefined;
  return inTransaction(db, (tx) => insertWorkspace(tx, personalName(u ?? {}), userId));
}

export async function workspaceRole(q: Q, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const r = await one(q, `SELECT role FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id = $2`, [workspaceId, userId]);
  return (r?.role as WorkspaceRole | undefined) ?? null;
}

// ---- app and build access: the one check every developer tool on an app or its builds uses ----

// The app, if the user may work on it: a member of its workspace (or its creator, for an app not yet in one).
export async function memberApp(store: Store, user: Pick<User, "id">, appId: string): Promise<App | undefined> {
  const app = await store.getApp(appId);
  if (!app) return undefined;
  if (app.workspace_id) return (await workspaceRole(store.db, app.workspace_id, user.id)) ? app : undefined;
  return app.owner_id === user.id ? app : undefined;
}

// A build is the team's when it's for an app: every member of the app's workspace may see and act on it, and nobody
// else (its starter included, once they've left). A build for no app stays its starter's.
export async function canSeeBuild(store: Store, user: Pick<User, "id">, b: { developer_id: string; app_id: string | null }): Promise<boolean> {
  return b.app_id ? !!(await memberApp(store, user, b.app_id)) : b.developer_id === user.id;
}

// ---- the app's stage, for the studio's folders ----

export type AppStage = "idea" | "staging" | "production";

// production: published and running on Mynt's hosting (a live deployment). staging: not live, but it has a build
// Mynt verified, or a deployment that isn't live (a draft app's sandbox deployment, or one stopped or still
// deploying). idea: no verified build yet. Builds and hosting are optional services: without their tables, apps are
// at most what the rest says.
export async function appStages(db: Db, apps: Pick<App, "id" | "status">[]): Promise<Map<string, AppStage>> {
  const ids = apps.map((a) => a.id);
  const optional = async (sql: string) => {
    if (!ids.length) return [] as Record<string, unknown>[];
    try {
      return (await db.query(sql, [ids])).rows as Record<string, unknown>[];
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return [];
      throw e;
    }
  };
  const built = new Set(
    (await optional(`SELECT DISTINCT app_id::text AS app_id FROM ${T}.build_runs WHERE app_id::text = ANY($1) AND status = 'succeeded'`)).map((r) => r.app_id as string),
  );
  const hosted = new Map((await optional(`SELECT app_id::text AS app_id, status FROM ${T}.hosted_apps WHERE app_id::text = ANY($1)`)).map((r) => [r.app_id as string, r.status as string]));
  return new Map(
    apps.map((a) => {
      const h = hosted.get(a.id);
      const stage: AppStage = h === "running" && a.status === "published" ? "production" : built.has(a.id) || h ? "staging" : "idea";
      return [a.id, stage];
    }),
  );
}

// ---- invites: accepted when the invited, verified email signs in ----

export async function acceptWorkspaceInvites(db: Db, userId: string, email: string | null): Promise<{ workspace_id: string; role: string }[]> {
  if (!email) return [];
  const lower = email.toLowerCase();
  // The common case (nothing waiting) costs one indexed lookup.
  if (!(await one(db, `SELECT 1 FROM ${T}.workspace_invites WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1`, [lower]))) return [];
  return inTransaction(db, async (tx) => {
    const open = (
      await tx.query(
        `UPDATE ${T}.workspace_invites SET accepted_at = now(), accepted_by = $2
         WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id, workspace_id::text AS workspace_id, role`,
        [lower, userId],
      )
    ).rows as { id: string; workspace_id: string; role: string }[];
    const joined = [];
    for (const i of open) {
      // Someone already in keeps the role they have: an invite never changes it.
      const added = (
        await tx.query(
          `INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING role`,
          [i.workspace_id, userId, i.role],
        )
      ).rows.length;
      await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, 'accept_workspace_invite', $3, $4)`, [
        randomUUID(),
        userId,
        i.workspace_id,
        JSON.stringify({ invite_id: i.id, role: i.role, joined: added > 0 }),
      ]);
      if (added) joined.push({ workspace_id: i.workspace_id, role: i.role });
    }
    return joined;
  });
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

class Refused extends Error {}

export function registerWorkspaceTools(server: McpServer, store: Store, user: User) {
  const db = store.db;
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const notYours = (id: string) => `No workspace of yours with id '${id}'`;

  // Membership changes run in a transaction holding the workspace's row, so "is this the last owner?" can't race.
  const locked = async <R>(workspaceId: string, f: (tx: Q, myRole: WorkspaceRole) => Promise<R>): Promise<R> =>
    inTransaction(db, async (tx) => {
      if (!(await one(tx, `SELECT id FROM ${T}.workspaces WHERE id::text = $1 FOR UPDATE`, [workspaceId]))) throw new Refused(notYours(workspaceId));
      const role = await workspaceRole(tx, workspaceId, user.id);
      if (!role) throw new Refused(notYours(workspaceId));
      return f(tx, role);
    });
  const attempt = async (f: () => Promise<ReturnType<typeof json>>) => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof Refused) return fail(e.message);
      throw e;
    }
  };
  const manager = (role: WorkspaceRole) => {
    if (role === "member") throw new Refused("Only the workspace's owners and admins manage its members");
  };
  const owners = async (tx: Q, workspaceId: string) =>
    Number((await one(tx, `SELECT count(*)::int AS n FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND role = 'owner'`, [workspaceId]))!.n);

  server.registerTool(
    "list_workspaces",
    {
      title: "My workspaces",
      description: "Developer: the workspaces you belong to, your role in each (owner, admin or member), and how many members and apps each has.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = (
        await db.query(
          `SELECT w.id::text AS id, w.name, m.role, w.created_at, m.joined_at,
             (SELECT count(*)::int FROM ${T}.workspace_members x WHERE x.workspace_id = w.id) AS members,
             (SELECT count(*)::int FROM ${T}.apps a WHERE a.workspace_id = w.id) AS apps
           FROM ${T}.workspace_members m JOIN ${T}.workspaces w ON w.id = m.workspace_id
           WHERE m.user_id = $1 ORDER BY w.created_at`,
          [user.id],
        )
      ).rows as Record<string, unknown>[];
      return json(rows.map((r) => ({ ...r, created_at: new Date(r.created_at as string).toISOString(), joined_at: new Date(r.joined_at as string).toISOString() })));
    },
  );

  server.registerTool(
    "create_workspace",
    {
      title: "Create a workspace",
      description: "Developer: a new workspace for a team's apps. You're its owner; invite_to_workspace brings others in.",
      inputSchema: { name: z.string().trim().min(1).max(200) },
    },
    async ({ name }) => {
      const id = await inTransaction(db, (tx) => insertWorkspace(tx, name, user.id));
      await audit("create_workspace", id, { name });
      return json({ id, name, role: "owner" });
    },
  );

  server.registerTool(
    "rename_workspace",
    {
      title: "Rename a workspace",
      description: "Developer: owners and admins rename a workspace.",
      inputSchema: { workspace_id: z.string(), name: z.string().trim().min(1).max(200) },
    },
    async ({ workspace_id, name }) =>
      attempt(async () => {
        const before = await locked(workspace_id, async (tx, role) => {
          manager(role);
          const r = await one(tx, `SELECT name FROM ${T}.workspaces WHERE id::text = $1`, [workspace_id]);
          await tx.query(`UPDATE ${T}.workspaces SET name = $2 WHERE id::text = $1`, [workspace_id, name]);
          return r!.name as string;
        });
        await audit("rename_workspace", workspace_id, { from: before, to: name });
        return json({ id: workspace_id, name });
      }),
  );

  server.registerTool(
    "list_workspace_members",
    {
      title: "Who is in a workspace",
      description: "Developer: a workspace's members and their roles; owners and admins also see the invites still open.",
      inputSchema: { workspace_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id }) => {
      const role = await workspaceRole(db, workspace_id, user.id);
      if (!role) return fail(notYours(workspace_id));
      const members = (
        await db.query(
          `SELECT m.user_id::text AS user_id, u.name, u.email, m.role, m.joined_at FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id
           WHERE m.workspace_id::text = $1 ORDER BY m.joined_at`,
          [workspace_id],
        )
      ).rows;
      const invites =
        role === "member"
          ? undefined
          : (
              await db.query(
                `SELECT id::text AS id, email, role, invited_by::text AS invited_by, created_at FROM ${T}.workspace_invites
                 WHERE workspace_id::text = $1 AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at`,
                [workspace_id],
              )
            ).rows;
      return json({ workspace_id, your_role: role, members, ...(invites ? { open_invites: invites } : {}) });
    },
  );

  server.registerTool(
    "invite_to_workspace",
    {
      title: "Invite someone to a workspace",
      description:
        "Developer: owners and admins invite an email address with a role (member by default; only owners invite owners). They join when they next sign in to Mynt with that verified address. Mynt doesn't email them: tell them yourself.",
      inputSchema: { workspace_id: z.string(), email: z.email(), role: z.enum(WORKSPACE_ROLES).default("member") },
    },
    async ({ workspace_id, email, role }) =>
      attempt(async () => {
        const lower = email.toLowerCase();
        const invite = await locked(workspace_id, async (tx, mine) => {
          manager(mine);
          if (role === "owner" && mine !== "owner") throw new Refused("Only an owner can invite another owner");
          const already = await one(
            tx,
            `SELECT 1 FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id WHERE m.workspace_id::text = $1 AND u.email = $2`,
            [workspace_id, lower],
          );
          if (already) throw new Refused(`${lower} is already a member`);
          if (await one(tx, `SELECT 1 FROM ${T}.workspace_invites WHERE workspace_id::text = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [workspace_id, lower]))
            throw new Refused(`${lower} already has an open invite; revoke it first to change the role`);
          const id = randomUUID();
          await tx.query(`INSERT INTO ${T}.workspace_invites (id, workspace_id, email, role, invited_by) VALUES ($1, $2, $3, $4, $5)`, [
            id,
            workspace_id,
            lower,
            role,
            user.id,
          ]);
          return { id, workspace_id, email: lower, role };
        });
        await audit("invite_to_workspace", workspace_id, { invite_id: invite.id, email: lower, role });
        // A workspace invite doesn't let anyone onto Mynt itself: that's Mynt's own invite, which its admins give.
        const onMynt = (await store.getInvite(lower)) || (await one(db, `SELECT 1 FROM ${T}.users WHERE email = $1`, [lower]));
        return json({
          ...invite,
          ...(onMynt ? {} : { note: `${lower} can't sign in to Mynt yet: a Mynt admin has to invite them too (or public sign-up must be on)` }),
        });
      }),
  );

  server.registerTool(
    "revoke_workspace_invite",
    {
      title: "Withdraw a workspace invite",
      description: "Developer: owners and admins withdraw an invite that hasn't been accepted yet (list_workspace_members shows them).",
      inputSchema: { invite_id: z.string() },
    },
    async ({ invite_id }) =>
      attempt(async () => {
        const inv = await one(db, `SELECT workspace_id::text AS workspace_id FROM ${T}.workspace_invites WHERE id::text = $1`, [invite_id]);
        if (!inv) return fail(`No open invite with id '${invite_id}'`);
        const ws = inv.workspace_id as string;
        const revoked = await locked(ws, async (tx, mine) => {
          manager(mine);
          const r = await one(tx, `SELECT email, role FROM ${T}.workspace_invites WHERE id::text = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [invite_id]);
          if (!r) throw new Refused(`No open invite with id '${invite_id}'`);
          if (r.role === "owner" && mine !== "owner") throw new Refused("Only an owner can withdraw an invite for an owner");
          await tx.query(`UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE id::text = $1`, [invite_id]);
          return r;
        });
        await audit("revoke_workspace_invite", ws, { invite_id, email: revoked.email });
        return json({ invite_id, revoked: true });
      }),
  );

  server.registerTool(
    "change_member_role",
    {
      title: "Change a member's role",
      description:
        "Developer: owners and admins change a member's role. Only owners make or unmake owners, and a workspace always keeps at least one owner.",
      inputSchema: { workspace_id: z.string(), user_id: z.string(), role: z.enum(WORKSPACE_ROLES) },
    },
    async ({ workspace_id, user_id, role }) =>
      attempt(async () => {
        const from = await locked(workspace_id, async (tx, mine) => {
          manager(mine);
          const current = await workspaceRole(tx, workspace_id, user_id);
          if (!current) throw new Refused(`'${user_id}' isn't a member of this workspace`);
          if ((current === "owner" || role === "owner") && mine !== "owner") throw new Refused("Only an owner can make or unmake an owner");
          if (current === "owner" && role !== "owner" && (await owners(tx, workspace_id)) <= 1)
            throw new Refused("A workspace needs an owner: make someone else an owner first");
          await tx.query(`UPDATE ${T}.workspace_members SET role = $3 WHERE workspace_id::text = $1 AND user_id::text = $2`, [workspace_id, user_id, role]);
          return current;
        });
        await audit("change_member_role", workspace_id, { user_id, from, to: role });
        return json({ workspace_id, user_id, role });
      }),
  );

  server.registerTool(
    "remove_workspace_member",
    {
      title: "Remove someone from a workspace",
      description:
        "Developer: owners and admins remove a member; they lose access to the workspace's apps and builds at once. Only owners remove owners, and never the last one. To go yourself, use leave_workspace.",
      inputSchema: { workspace_id: z.string(), user_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ workspace_id, user_id }) =>
      attempt(async () => {
        if (user_id === user.id) return fail("To leave a workspace yourself, use leave_workspace");
        const was = await locked(workspace_id, async (tx, mine) => {
          manager(mine);
          const current = await workspaceRole(tx, workspace_id, user_id);
          if (!current) throw new Refused(`'${user_id}' isn't a member of this workspace`);
          if (current === "owner" && mine !== "owner") throw new Refused("Only an owner can remove an owner");
          if (current === "owner" && (await owners(tx, workspace_id)) <= 1) throw new Refused("A workspace needs an owner: it can't lose its last one");
          await tx.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id::text = $2`, [workspace_id, user_id]);
          return current;
        });
        await audit("remove_workspace_member", workspace_id, { user_id, role: was });
        return json({ workspace_id, user_id, removed: true });
      }),
  );

  server.registerTool(
    "leave_workspace",
    {
      title: "Leave a workspace",
      description: "Developer: leave a workspace; you lose access to its apps and builds. Its last owner can't leave: make someone else an owner first.",
      inputSchema: { workspace_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ workspace_id }) =>
      attempt(async () => {
        const was = await locked(workspace_id, async (tx, mine) => {
          if (mine === "owner" && (await owners(tx, workspace_id)) <= 1)
            throw new Refused("You're this workspace's last owner: make someone else an owner first");
          await tx.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id = $2`, [workspace_id, user.id]);
          return mine;
        });
        await audit("leave_workspace", workspace_id, { role: was });
        return json({ workspace_id, left: true });
      }),
  );
}
