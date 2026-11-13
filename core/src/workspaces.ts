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
// Any member may invite (members as members only; owners and admins as admins too), and the inviter picks the Mynt
// role the invite carries: developer or user (Mynt's consumer role), never more (admitWorkspaceInvitee). Someone a
// Mynt admin revoked stays out, and admins can still revoke anyone let in this way. Each person may send
// WORKSPACE_INVITES_PER_DAY invites a day.

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
  -- The Mynt role a workspace invite carries for someone new to Mynt: developer or consumer (shown as "user").
  ALTER TABLE ${T}.workspace_invites ADD COLUMN IF NOT EXISTS mynt_role text NOT NULL DEFAULT 'developer' CHECK (mynt_role IN ('developer', 'consumer'));
  CREATE INDEX IF NOT EXISTS workspace_invites_inviter_idx ON ${T}.workspace_invites (invited_by, created_at);
  -- Who let someone onto Mynt, when it wasn't an admin: the workspace member whose invite did.
  ALTER TABLE ${T}.invites ADD COLUMN IF NOT EXISTS invited_by uuid REFERENCES ${T}.users(id);
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

// The Mynt roles a workspace invite can carry: developer, or user (Mynt's consumer role). Never anything else.
export const INVITE_MYNT_ROLES = { developer: "developer", user: "consumer" } as const;
export type InviteMyntRole = keyof typeof INVITE_MYNT_ROLES;
export const WORKSPACE_INVITES_PER_DAY = 20;

// The roles that already give a builder's tools: nothing to add for them.
const BUILDER_ROLES = ["developer", "innovator", "admin"];
export const needsDeveloper = (roles: readonly string[]) => !roles.some((r) => BUILDER_ROLES.includes(r));

// A workspace invite lets its invitee onto Mynt itself, with the role it carries (developer or consumer) and no other.
// Someone a Mynt admin revoked (a signup block) stays out, and an existing Mynt invite is left as it is (sign-in adds
// developer to it when a developer invite is accepted). `clerk` keeps the identity provider's allowlist in step, as
// admins' invites do.
export async function admitWorkspaceInvitee(
  store: Store,
  email: string,
  invitedBy: string | null,
  myntRole: "developer" | "consumer",
  clerk?: { allow(email: string): Promise<string | null> } | null,
): Promise<{ admitted: "new" | "already" | "blocked"; warning?: string }> {
  const lower = email.toLowerCase();
  if (await store.isSignupBlocked(lower)) return { admitted: "blocked" };
  if (await store.getInvite(lower)) return { admitted: "already" };
  const role = myntRole === "developer" ? "developer" : "consumer";
  const added = await one(
    store.db,
    `INSERT INTO ${T}.invites (email, roles, invited_by) VALUES ($1, ARRAY[$3::text], $2) ON CONFLICT (email) DO NOTHING RETURNING email`,
    [lower, invitedBy, role],
  );
  if (!added) return { admitted: "already" };
  await store.audit(invitedBy, "invite_via_workspace", lower, { roles: [role] });
  const warning = (await clerk?.allow(lower)) ?? undefined;
  return { admitted: "new", ...(warning ? { warning } : {}) };
}

// An open workspace invite for this address, if any: who sent it and the Mynt role it carries (a developer invite
// first, if several are waiting).
export async function openWorkspaceInviter(db: Db, email: string): Promise<{ invited_by: string | null; mynt_role: "developer" | "consumer" } | null> {
  const r = await one(
    db,
    `SELECT invited_by::text AS invited_by, mynt_role FROM ${T}.workspace_invites WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL
     ORDER BY (mynt_role = 'developer') DESC, created_at LIMIT 1`,
    [email.toLowerCase()],
  );
  return r ? { invited_by: (r.invited_by as string | null) ?? null, mynt_role: r.mynt_role === "developer" ? "developer" : "consumer" } : null;
}

export async function acceptWorkspaceInvites(db: Db, userId: string, email: string | null): Promise<{ workspace_id: string; role: string; mynt_role: string }[]> {
  if (!email) return [];
  const lower = email.toLowerCase();
  // The common case (nothing waiting) costs one indexed lookup.
  if (!(await one(db, `SELECT 1 FROM ${T}.workspace_invites WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1`, [lower]))) return [];
  return inTransaction(db, async (tx) => {
    const open = (
      await tx.query(
        `UPDATE ${T}.workspace_invites SET accepted_at = now(), accepted_by = $2
         WHERE email = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id, workspace_id::text AS workspace_id, role, mynt_role`,
        [lower, userId],
      )
    ).rows as { id: string; workspace_id: string; role: string; mynt_role: string }[];
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
      if (added) joined.push({ workspace_id: i.workspace_id, role: i.role, mynt_role: i.mynt_role });
    }
    return joined;
  });
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

class Refused extends Error {}

type ClerkAllowlist = { allow(email: string): Promise<string | null>; disallow?(email: string): Promise<unknown> };

export function registerWorkspaceTools(server: McpServer, store: Store, user: User, clerk: ClerkAllowlist | null = null) {
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
        "Developer: invite an email address to a workspace you're in. role is their place in the workspace: member (anyone may invite members), admin (owners and admins only) or owner (owners only). mynt_role is what they may do on Mynt if they're new to it: developer (build apps) or user (use apps; in the workspace, but they can't build); never more. They join when they next sign in with that verified address; someone a Mynt admin removed stays out. Up to 20 invites a day each. Mynt doesn't email them: tell them yourself.",
      inputSchema: {
        workspace_id: z.string(),
        email: z.email(),
        role: z.enum(WORKSPACE_ROLES).default("member"),
        mynt_role: z.enum(["developer", "user"]).default("developer"),
      },
    },
    async ({ workspace_id, email, role, mynt_role }) =>
      attempt(async () => {
        const lower = email.toLowerCase();
        const myntRole = INVITE_MYNT_ROLES[mynt_role as InviteMyntRole];
        const invite = await locked(workspace_id, async (tx, mine) => {
          if (role !== "member") manager(mine);
          if (role === "owner" && mine !== "owner") throw new Refused("Only an owner can invite another owner");
          const sent = Number(
            (await one(tx, `SELECT count(*)::int AS n FROM ${T}.workspace_invites WHERE invited_by = $1 AND created_at > now() - interval '1 day'`, [user.id]))!.n,
          );
          if (sent >= WORKSPACE_INVITES_PER_DAY) throw new Refused(`You've sent ${WORKSPACE_INVITES_PER_DAY} workspace invites in the last day; try again later`);
          const already = await one(
            tx,
            `SELECT 1 FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id WHERE m.workspace_id::text = $1 AND u.email = $2`,
            [workspace_id, lower],
          );
          if (already) throw new Refused(`${lower} is already a member`);
          if (await one(tx, `SELECT 1 FROM ${T}.workspace_invites WHERE workspace_id::text = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [workspace_id, lower]))
            throw new Refused(`${lower} already has an open invite; revoke it first to change the role`);
          const id = randomUUID();
          await tx.query(`INSERT INTO ${T}.workspace_invites (id, workspace_id, email, role, invited_by, mynt_role) VALUES ($1, $2, $3, $4, $5, $6)`, [
            id,
            workspace_id,
            lower,
            role,
            user.id,
            myntRole,
          ]);
          return { id, workspace_id, email: lower, role, mynt_role };
        });
        await audit("invite_to_workspace", workspace_id, { invite_id: invite.id, email: lower, role, mynt_role });
        // The invite also lets them onto Mynt with the role it carries, unless an admin revoked them.
        const mynt = await admitWorkspaceInvitee(store, lower, user.id, myntRole, clerk);
        const as = mynt_role === "developer" ? "a developer" : "a user (they can't build)";
        const note = {
          new: `${lower} can now sign in to Mynt as ${as}; they join the workspace when they do`,
          already:
            mynt_role === "developer"
              ? `${lower} joins the workspace when they next sign in (with the developer role, if they don't have it yet)`
              : `${lower} joins the workspace when they next sign in, keeping their Mynt roles`,
          blocked: `${lower} was removed from Mynt by an admin, so they can't sign in: an admin has to let them back first`,
        }[mynt.admitted];
        return json({ ...invite, mynt_access: mynt.admitted, note, ...(mynt.warning ? { warning: mynt.warning } : {}) });
      }),
  );

  server.registerTool(
    "revoke_workspace_invite",
    {
      title: "Withdraw a workspace invite",
      description: "Developer: withdraw an invite that hasn't been accepted yet: your own, or anyone's if you're an owner or admin (list_workspace_members shows them).",
      inputSchema: { invite_id: z.string() },
    },
    async ({ invite_id }) =>
      attempt(async () => {
        const inv = await one(db, `SELECT workspace_id::text AS workspace_id FROM ${T}.workspace_invites WHERE id::text = $1`, [invite_id]);
        if (!inv) return fail(`No open invite with id '${invite_id}'`);
        const ws = inv.workspace_id as string;
        const revoked = await locked(ws, async (tx, mine) => {
          const r = await one(
            tx,
            `SELECT email, role, invited_by::text AS invited_by FROM ${T}.workspace_invites WHERE id::text = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
            [invite_id],
          );
          if (!r) throw new Refused(`No open invite with id '${invite_id}'`);
          if (r.invited_by !== user.id) manager(mine);
          if (r.role === "owner" && mine !== "owner") throw new Refused("Only an owner can withdraw an invite for an owner");
          await tx.query(`UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE id::text = $1`, [invite_id]);
          return r;
        });
        await audit("revoke_workspace_invite", ws, { invite_id, email: revoked.email });
        // The way onto Mynt that a workspace invite opened closes with it, if they never came in and no other
        // workspace invite is still waiting for them. An admin's own invite is never touched.
        const email = revoked.email as string;
        const unused = await one(
          db,
          `DELETE FROM ${T}.invites i WHERE i.email = $1 AND i.invited_by IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${T}.users u WHERE u.email = $1)
             AND NOT EXISTS (SELECT 1 FROM ${T}.workspace_invites w WHERE w.email = $1 AND w.accepted_at IS NULL AND w.revoked_at IS NULL)
           RETURNING email`,
          [email],
        );
        if (unused) {
          await audit("uninvite_via_workspace", email, { invite_id });
          await clerk?.disallow?.(email).catch(() => undefined);
        }
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
