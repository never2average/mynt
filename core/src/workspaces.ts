import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction, type Db } from "./db.js";
import type { App, Store, User } from "./store.js";

// Workspaces: the teams developers build apps in. Every app belongs to one workspace, and everyone in it may see and
// work on its apps and their builds (build, steer, deploy). Only its owners and admins manage who is in it.
// Workspaces are not firms (entities): a firm is a regulated legal party; a workspace is just who works on which apps.
//
// Joining is invite → membership, as for Mynt itself, and the invitee decides: any member invites an email address
// (members as members only; owners and admins as admins too; owners as owners), and the person signed in with that
// verified address sees it (list_my_invitations) and accepts or declines it. Nothing here reads an allow-list from
// settings. The inviter picks the Mynt role the invite offers: developer or user (Mynt's consumer role), never more.
// An open invite lets someone new onto Mynt as a consumer; accepting a developer invite makes a consumer-only account
// a developer, and never touches a firm's account (vendor, licence or liquidity provider) or an admin's, or roles an
// admin set after the invite was sent. Someone a Mynt admin revoked stays out. Each person may send
// WORKSPACE_INVITES_PER_DAY invites a day.
//
// Leaving (or being removed) cuts access at once: the API keys and webhooks they made for the workspace's apps are
// revoked and disabled, their running builds and reopened sandboxes stop, Solana programs they reserved for its apps
// pass to an owner, and VM logins to the workspace's hosting are revoked (offboard).

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
  ALTER TABLE ${T}.workspace_invites ADD COLUMN IF NOT EXISTS declined_at timestamptz;
  -- Each person's own workspace, at most one: where their apps go by default (and the migration put their old ones).
  ALTER TABLE ${T}.workspaces ADD COLUMN IF NOT EXISTS personal boolean NOT NULL DEFAULT false;
  CREATE UNIQUE INDEX IF NOT EXISTS workspaces_one_personal_idx ON ${T}.workspaces (created_by) WHERE personal;
  -- A Mynt invite a workspace invite made, and whether anyone changed it since (only then is it withdrawn with it);
  -- when an admin last chose its roles (a workspace invite sent before that never raises them).
  ALTER TABLE ${T}.invites ADD COLUMN IF NOT EXISTS created_by_workspace_invite_id uuid;
  ALTER TABLE ${T}.invites ADD COLUMN IF NOT EXISTS updated_at timestamptz;
  UPDATE ${T}.invites SET updated_at = created_at WHERE updated_at IS NULL;
  ALTER TABLE ${T}.invites ALTER COLUMN updated_at SET DEFAULT now();
  ALTER TABLE ${T}.invites ADD COLUMN IF NOT EXISTS admin_roles_at timestamptz;
  -- A webhook its maker can no longer answer for (they left the app's workspace) gets no more deliveries.
  ALTER TABLE ${T}.webhooks ADD COLUMN IF NOT EXISTS disabled_at timestamptz;
  -- A workspace's audit trail is found by what each event is about: its target, or the app an event names.
  CREATE INDEX IF NOT EXISTS audit_log_target_idx ON ${T}.audit_log (target, created_at DESC);
  CREATE INDEX IF NOT EXISTS audit_log_app_idx ON ${T}.audit_log ((details->>'app_id'), created_at DESC);
  -- Any change to a Mynt invite (an admin's, a role added) counts it up: a workspace invite withdraws only one at 0.
  ALTER TABLE ${T}.invites ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
  -- Who received a key's or webhook's current secret: someone leaving can't keep using one they hold.
  ALTER TABLE ${T}.api_keys ADD COLUMN IF NOT EXISTS last_secret_issued_to uuid;
  ALTER TABLE ${T}.webhooks ADD COLUMN IF NOT EXISTS last_secret_issued_to uuid;
  -- Someone leaving a workspace: cut off step by step, retried until every step is done (offboard).
  CREATE TABLE IF NOT EXISTS ${T}.workspace_offboards (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    actor_id uuid,
    started_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0,
    done jsonb NOT NULL DEFAULT '{}',
    error text,
    completed_at timestamptz,
    PRIMARY KEY (workspace_id, user_id, started_at)
  );
  CREATE INDEX IF NOT EXISTS workspace_offboards_pending_idx ON ${T}.workspace_offboards (started_at) WHERE completed_at IS NULL;
`;

type Q = Pick<Db, "query">;
const one = async (q: Q, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows[0] as Record<string, unknown> | undefined;

const personalName = (u: { name?: string | null; email?: string | null }) => `${(u.name || u.email || "My").trim().slice(0, 180)}'s workspace`;

async function insertWorkspace(q: Q, name: string, ownerId: string, personal = false): Promise<string> {
  const id = randomUUID();
  await q.query(`INSERT INTO ${T}.workspaces (id, name, created_by, personal) VALUES ($1, $2, $3, $4)`, [id, name, ownerId, personal]);
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
      // Their own workspace, unless they already have one (made since): then the apps go there.
      const existing = await one(tx, `SELECT id FROM ${T}.workspaces WHERE created_by = $1 AND personal`, [u.id]);
      const id = (existing?.id as string | undefined) ?? (await insertWorkspace(tx, personalName(u), u.id, true));
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

// The workspaces a user created and is still in: their own. New apps go only in one of these by default, never in a
// workspace they were invited into.
export async function createdWorkspaces(q: Q, userId: string): Promise<string[]> {
  return (
    await q.query(
      `SELECT w.id::text AS id FROM ${T}.workspaces w JOIN ${T}.workspace_members m ON m.workspace_id = w.id AND m.user_id = $1
       WHERE w.created_by = $1 ORDER BY w.created_at`,
      [userId],
    )
  ).rows.map((r) => (r as { id: string }).id);
}

// The user's own workspace: the first they created, or a new personal one. At most one personal workspace per person
// (a unique index), so two first apps at once can't make two.
export async function personalWorkspace(db: Db, userId: string): Promise<string> {
  const mine = await createdWorkspaces(db, userId);
  if (mine.length) return mine[0];
  const u = (await one(db, `SELECT name, email FROM ${T}.users WHERE id = $1`, [userId])) as { name: string | null; email: string | null } | undefined;
  const made = await one(
    db,
    `INSERT INTO ${T}.workspaces (id, name, created_by, personal) VALUES ($1, $2, $3, true) ON CONFLICT (created_by) WHERE personal DO NOTHING RETURNING id`,
    [randomUUID(), personalName(u ?? {}), userId],
  );
  const id = (made?.id as string | undefined) ?? ((await one(db, `SELECT id FROM ${T}.workspaces WHERE created_by = $1 AND personal`, [userId]))!.id as string);
  // Its first member is its maker, as its owner (and nobody is put back into one they left).
  await db.query(
    `INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) SELECT $1, $2, 'owner'
     WHERE NOT EXISTS (SELECT 1 FROM ${T}.workspace_members WHERE workspace_id = $1)`,
    [id, userId],
  );
  return (await workspaceRole(db, id, userId)) ? id : inTransaction(db, (tx) => insertWorkspace(tx, personalName(u ?? {}), userId));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID.test(v);

export async function workspaceRole(q: Q, workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  if (!isUuid(workspaceId) || !isUuid(userId)) return null;
  const r = await one(q, `SELECT role FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id = $2`, [workspaceId, userId]);
  return (r?.role as WorkspaceRole | undefined) ?? null;
}

// ---- app and build access: the one check every developer tool on an app or its builds uses ----

// The app, if the user may work on it: a member of its workspace (or its creator, for an app not yet in one).
export async function memberApp(store: Store, user: Pick<User, "id">, appId: string): Promise<App | undefined> {
  if (!isUuid(appId)) return undefined;
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

// The caller's role in the app's workspace (owner or admin for what only they may do, like live keys).
export async function appRole(store: Store, user: Pick<User, "id">, app: Pick<App, "workspace_id" | "owner_id">): Promise<WorkspaceRole | null> {
  if (app.workspace_id) return workspaceRole(store.db, app.workspace_id, user.id);
  return app.owner_id === user.id ? "owner" : null;
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

// ---- invites: the invitee accepts or declines them ----

// The Mynt roles a workspace invite can offer: developer, or user (Mynt's consumer role). Never anything else.
export const INVITE_MYNT_ROLES = { developer: "developer", user: "consumer" } as const;
export type InviteMyntRole = keyof typeof INVITE_MYNT_ROLES;
export const WORKSPACE_INVITES_PER_DAY = 20;
// An invite not answered within this many days lapses.
export const WORKSPACE_INVITE_DAYS = 30;
const OPEN = `accepted_at IS NULL AND revoked_at IS NULL AND created_at > now() - interval '${WORKSPACE_INVITE_DAYS} days'`;

const FIRM_ROLES: Record<string, string> = { vendor: "a vendor", license_provider: "a licence provider", liquidity_provider: "a liquidity provider", admin: "a Mynt admin" };

// What accepting an invite would let this person do, by the same rules accept_workspace_invite applies: for the
// studio's "Accepting lets you:".
export function inviteGrants(inv: { role: string; mynt_role: string; created_at: string }, held: string[], adminRolesAt: string | null): { grants: string[]; developer: "granted" | "already" | "not_eligible" | "not_offered" } {
  const builds = held.some((r) => r === "developer" || r === "innovator");
  let developer: "granted" | "already" | "not_eligible" | "not_offered" = "not_offered";
  if (inv.mynt_role === "developer") {
    if (builds) developer = "already";
    else if (!promotable(held) || (adminRolesAt && new Date(adminRolesAt) > new Date(inv.created_at))) developer = "not_eligible";
    else developer = "granted";
  }
  const canBuild = builds || developer === "granted";
  const grants: string[] = [];
  if (canBuild) grants.push("Build and steer this workspace's apps", "Invite people as members");
  else grants.push("Be a member of this workspace (building its apps needs the developer role on Mynt)");
  if (canBuild && (inv.role === "admin" || inv.role === "owner")) grants.push("Invite admins, rename the workspace and manage its members");
  if (canBuild && inv.role === "owner") grants.push("Make, unmake and remove the workspace's owners");
  const firm = held.find((r) => FIRM_ROLES[r]);
  if (developer === "granted") grants.push("Become a developer on Mynt");
  else grants.push(firm ? `Your Mynt role stays as it is (you're ${FIRM_ROLES[firm]})` : "Your Mynt role stays as it is");
  return { grants, developer };
}

// Accounts a developer invite may make developers: consumer-only (or no roles yet). Never a firm's account (vendor,
// licence or liquidity provider), an admin's, or one that already builds.
export const promotable = (roles: readonly string[]) => roles.every((r) => r === "consumer");

// An open workspace invite lets someone new onto Mynt, as a consumer (they become a developer only by accepting a
// developer invite). Someone a Mynt admin revoked (a signup block) stays out, and an existing Mynt invite is left
// as it is. The Mynt invite records the workspace invite that made it, so withdrawing that invite can withdraw it
// too, while nobody has changed it. `clerk` keeps the identity provider's allowlist in step, as admins' invites do.
export async function admitWorkspaceInvitee(
  store: Store,
  email: string,
  invite: { id: string; invited_by: string | null },
  clerk?: { allow(email: string): Promise<string | null> } | null,
): Promise<{ admitted: "new" | "already" | "blocked"; warning?: string }> {
  const lower = email.toLowerCase();
  if (await store.isSignupBlocked(lower)) return { admitted: "blocked" };
  if (await store.getInvite(lower)) return { admitted: "already" };
  const added = await one(
    store.db,
    `INSERT INTO ${T}.invites (email, roles, invited_by, created_by_workspace_invite_id, created_at, updated_at)
     VALUES ($1, '{consumer}', $2, $3, now(), now()) ON CONFLICT (email) DO NOTHING RETURNING email`,
    [lower, invite.invited_by, invite.id],
  );
  if (!added) return { admitted: "already" };
  await store.audit(invite.invited_by, "invite_via_workspace", lower, { roles: ["consumer"], workspace_invite_id: invite.id });
  const warning = (await clerk?.allow(lower)) ?? undefined;
  return { admitted: "new", ...(warning ? { warning } : {}) };
}

// An open workspace invite for this address, if any (the sign-in gate admits its invitee).
export async function openWorkspaceInvite(db: Db, email: string): Promise<{ id: string; invited_by: string | null } | null> {
  const r = await one(
    db,
    `SELECT id::text AS id, invited_by::text AS invited_by FROM ${T}.workspace_invites WHERE email = $1 AND ${OPEN} ORDER BY created_at LIMIT 1`,
    [email.toLowerCase()],
  );
  return r ? { id: r.id as string, invited_by: (r.invited_by as string | null) ?? null } : null;
}

// Withdraws the Mynt invite a workspace invite made, if it's still exactly as that invite made it (revision 0, no
// admin's choice) and its person never signed in. An admin's invite, or one anyone changed since, is never touched.
async function releaseMyntInvite(store: Store, inviteId: string, email: string, actor: string | null, clerk: ClerkAllowlist | null) {
  const gone = await one(
    store.db,
    `DELETE FROM ${T}.invites i WHERE i.email = $1 AND i.created_by_workspace_invite_id::text = $2 AND i.revision = 0
       AND i.admin_roles_at IS NULL AND NOT EXISTS (SELECT 1 FROM ${T}.users u WHERE u.email = $1)
       AND NOT EXISTS (SELECT 1 FROM ${T}.workspace_invites w WHERE w.email = $1 AND w.${OPEN.split(" AND ").join(" AND w.")})
     RETURNING email`,
    [email, inviteId],
  );
  if (!gone) return false;
  await store.audit(actor, "uninvite_via_workspace", email, { workspace_invite_id: inviteId });
  await clerk?.disallow?.(email).catch(() => undefined);
  return true;
}

// Invites that lapsed unanswered: the Mynt invites they made go too, where nobody used or changed them.
export async function releaseLapsedInvites(store: Store, clerk: ClerkAllowlist | null = null): Promise<number> {
  const lapsed = (
    await store.db.query(
      `SELECT w.id::text AS id, w.email FROM ${T}.workspace_invites w JOIN ${T}.invites i ON i.created_by_workspace_invite_id = w.id
       WHERE w.accepted_at IS NULL AND w.revoked_at IS NULL AND w.created_at <= now() - interval '${WORKSPACE_INVITE_DAYS} days' LIMIT 100`,
    )
  ).rows as { id: string; email: string }[];
  let n = 0;
  for (const l of lapsed) if (await releaseMyntInvite(store, l.id, l.email, null, clerk)) n++;
  return n;
}

// ---- leaving: cut access at once ----

export interface OffboardServices {
  // Stops the leaver's running builds of these apps and closes the sandboxes they reopened (builds.ts): the ones
  // stopped, and the ones that couldn't be (retried).
  stopBuilds?(userId: string, appIds: string[]): Promise<{ stopped: string[]; failed: string[] }>;
  // Revokes current VM logins to the tenants that host these apps (hosting.ts): how many, and how many couldn't be.
  revokeVmAccess?(workspaceId: string, appIds: string[]): Promise<{ revoked: number; failed: number }>;
}

// Cuts someone off from a workspace's apps, step by step. Every step is idempotent, and the whole is recorded first
// (workspace_offboards) so a step that fails (the sandbox host or hosting provider down) is retried on the next
// worker tick (retryOffboards) or by an admin (retry_offboard) until all are done. Hosted apps' runtime keys belong
// to the workspace (created_by NULL), so the deployer leaving never takes a running app down.
export async function offboard(store: Store, services: OffboardServices, workspaceId: string, userId: string, actor: string | null, startedAt?: string) {
  const db = store.db;
  const started =
    startedAt ??
    ((await one(db, `INSERT INTO ${T}.workspace_offboards (workspace_id, user_id, actor_id) VALUES ($1, $2, $3) RETURNING started_at::text AS at`, [workspaceId, userId, actor]))!
      .at as string);
  await db.query(`UPDATE ${T}.workspace_offboards SET attempts = attempts + 1 WHERE workspace_id = $1 AND user_id = $2 AND started_at = $3::timestamptz`, [workspaceId, userId, started]);
  const apps = (await db.query(`SELECT id::text AS id FROM ${T}.apps WHERE workspace_id::text = $1`, [workspaceId])).rows.map((r) => (r as { id: string }).id);
  const ids = (rows: unknown[]) => rows.map((r) => (r as { id: string }).id);
  const failures: string[] = [];
  // Keys they made, or whose current secret they were given (by rotating it).
  const keys = ids(
    (
      await db.query(
        `UPDATE ${T}.api_keys SET status = 'revoked', revoked_at = now()
         WHERE app_id::text = ANY($1) AND status = 'active' AND (created_by = $2 OR last_secret_issued_to = $2) RETURNING id::text AS id`,
        [apps, userId],
      )
    ).rows,
  );
  // Webhooks they made stop; others whose secret they were given get a new one nobody has yet.
  const webhooks = ids(
    (await db.query(`UPDATE ${T}.webhooks SET disabled_at = now() WHERE app_id::text = ANY($1) AND created_by = $2 AND disabled_at IS NULL RETURNING id::text AS id`, [apps, userId])).rows,
  );
  const rotated = [];
  for (const id of ids((await db.query(`SELECT id::text AS id FROM ${T}.webhooks WHERE app_id::text = ANY($1) AND last_secret_issued_to = $2`, [apps, userId])).rows)) {
    await store.rotateWebhookSecret(id, null);
    rotated.push(id);
  }
  // Invites they sent and nobody has answered: void, so they can't come back through one.
  const invites = (
    await db.query(
      `UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE workspace_id::text = $1 AND invited_by = $2 AND accepted_at IS NULL AND revoked_at IS NULL
       RETURNING id::text AS id, email`,
      [workspaceId, userId],
    )
  ).rows as { id: string; email: string }[];
  for (const i of invites) await releaseMyntInvite(store, i.id, i.email, actor, null);
  let builds: string[] = [];
  if (services.stopBuilds) {
    const r = await services.stopBuilds(userId, apps).catch((e) => ({ stopped: [], failed: [`all (${(e as Error).message})`] }));
    builds = r.stopped;
    if (r.failed.length) failures.push(`builds not stopped yet: ${r.failed.join(", ")}`);
  }
  // Programs they reserved for the team's apps pass to the workspace's longest-standing owner.
  let programs: string[] = [];
  try {
    programs = (
      await db.query(
        `UPDATE ${T}.solana_programs SET owner_id = (SELECT user_id FROM ${T}.workspace_members WHERE workspace_id::text = $3 AND role = 'owner' ORDER BY joined_at LIMIT 1)
         WHERE app_id::text = ANY($1) AND owner_id = $2 RETURNING program_id`,
        [apps, userId, workspaceId],
      )
    ).rows.map((r) => (r as { program_id: string }).program_id);
  } catch (e) {
    if ((e as { code?: string }).code !== "42P01") throw e; // no Solana service here
  }
  let vmLogins = 0;
  if (services.revokeVmAccess) {
    const r = await services.revokeVmAccess(workspaceId, apps).catch(() => ({ revoked: 0, failed: 1 }));
    vmLogins = r.revoked;
    if (r.failed) failures.push(`${r.failed} VM login(s) not revoked yet`);
  }
  const done = {
    user_id: userId,
    revoked_api_keys: keys,
    disabled_webhooks: webhooks,
    rotated_webhook_secrets: rotated,
    revoked_invites: invites.map((i) => i.id),
    stopped_builds: builds,
    programs_to_owner: programs,
    vm_logins_revoked: vmLogins,
    ...(failures.length ? { pending: failures } : {}),
  };
  await db.query(
    `UPDATE ${T}.workspace_offboards SET done = done || $4::jsonb, error = $5, completed_at = CASE WHEN $5::text IS NULL THEN now() END
     WHERE workspace_id = $1 AND user_id = $2 AND started_at = $3::timestamptz`,
    [workspaceId, userId, started, JSON.stringify(done), failures.length ? failures.join("; ") : null],
  );
  await store.audit(actor, "workspace_offboard", workspaceId, done);
  return done;
}

// Offboardings with a step still to do: tried again (worker tick, retry_offboard).
export async function retryOffboards(store: Store, services: OffboardServices, filter: { workspace_id?: string; user_id?: string } = {}) {
  const pending = (
    await store.db.query(
      `SELECT workspace_id::text AS workspace_id, user_id::text AS user_id, actor_id::text AS actor_id, started_at::text AS started_at FROM ${T}.workspace_offboards
       WHERE completed_at IS NULL AND ($1::text IS NULL OR workspace_id::text = $1) AND ($2::text IS NULL OR user_id::text = $2) ORDER BY started_at LIMIT 50`,
      [filter.workspace_id ?? null, filter.user_id ?? null],
    )
  ).rows as { workspace_id: string; user_id: string; actor_id: string | null; started_at: string }[];
  const out = [];
  for (const o of pending) out.push(await offboard(store, services, o.workspace_id, o.user_id, o.actor_id, o.started_at));
  return out;
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

class Refused extends Error {}

type ClerkAllowlist = { allow(email: string): Promise<string | null>; disallow?(email: string): Promise<unknown> };

export function registerWorkspaceTools(
  server: McpServer,
  store: Store,
  user: User,
  ctx: { clerk?: ClerkAllowlist | null; offboarding?: OffboardServices } = {},
) {
  const clerk = ctx.clerk ?? null;
  const db = store.db;
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const notYours = (id: string) => `No workspace of yours with id '${id}'`;

  // Membership changes run in a transaction holding the workspace's row, so "is this the last owner?" can't race.
  const locked = async <R>(workspaceId: string, f: (tx: Q, myRole: WorkspaceRole) => Promise<R>): Promise<R> =>
    inTransaction(db, async (tx) => {
      if (!isUuid(workspaceId) || !(await one(tx, `SELECT id FROM ${T}.workspaces WHERE id::text = $1 FOR UPDATE`, [workspaceId])))
        throw new Refused(notYours(workspaceId));
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
  // Owners who can manage the workspace: they hold a builder's role on Mynt (the workspace tools are a developer's).
  const owners = async (tx: Q, workspaceId: string) =>
    Number(
      (await one(
        tx,
        `SELECT count(*)::int AS n FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id
         WHERE m.workspace_id::text = $1 AND m.role = 'owner' AND u.roles && ARRAY['developer', 'innovator', 'admin']::text[]`,
        [workspaceId],
      ))!.n,
    );

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
             (w.personal AND w.created_by = $1) AS personal,
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
        "Developer: invite an email address to a workspace you're in. role is their place in the workspace: member (anyone may invite members), admin (owners and admins only) or owner (owners only). mynt_role is what accepting offers them on Mynt: developer (build apps; given only to an account that's just a user, never a firm's or an admin's) or user (nothing more; they can be in the workspace but can't build). Someone new can sign in to Mynt at once, as a user; they see the invite with list_my_invitations and accept or decline it. Someone a Mynt admin removed stays out. Up to 20 invites a day each. Mynt doesn't email them: tell them yourself.",
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
          if (mynt_role === "user" && role !== "member") throw new Refused("Someone invited as a user can't build or manage, so they can only be a member");
          // One count at a time per sender, whichever workspace: the daily cap can't be raced past.
          await tx.query("SELECT pg_advisory_xact_lock(hashtext('mynt.workspace_invites:' || $1))", [user.id]);
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
          // A lapsed invite to the same address makes way for this one.
          await tx.query(
            `UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE workspace_id::text = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL
               AND created_at <= now() - interval '${WORKSPACE_INVITE_DAYS} days'`,
            [workspace_id, lower],
          );
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
        // Someone new may now sign in to Mynt (as a user), unless an admin revoked them.
        const mynt = await admitWorkspaceInvitee(store, lower, { id: invite.id, invited_by: user.id }, clerk);
        const offer = mynt_role === "developer" ? "accepting it makes them a developer if their account is just a user's" : "it adds no Mynt role";
        const note = {
          new: `${lower} can now sign in to Mynt as a user and accept the invite (list_my_invitations); ${offer}`,
          already: `${lower} sees the invite when they sign in (list_my_invitations) and accepts or declines it; ${offer}`,
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
        const inv = isUuid(invite_id) ? await one(db, `SELECT workspace_id::text AS workspace_id FROM ${T}.workspace_invites WHERE id::text = $1`, [invite_id]) : undefined;
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
        // The way onto Mynt this invite opened closes with it, if nobody used or changed it.
        await releaseMyntInvite(store, invite_id, revoked.email as string, user.id, clerk);
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
        if (from !== "member" && role === "member" && ctx.offboarding?.revokeVmAccess) {
          const apps = (await db.query(`SELECT id::text AS id FROM ${T}.apps WHERE workspace_id::text = $1`, [workspace_id])).rows.map((r) => (r as { id: string }).id);
          await ctx.offboarding.revokeVmAccess(workspace_id, apps).catch(() => undefined);
        }
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
        const cut = await offboard(store, ctx.offboarding ?? {}, workspace_id, user_id, user.id);
        return json({ workspace_id, user_id, removed: true, access_cut: cut });
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
        const cut = await offboard(store, ctx.offboarding ?? {}, workspace_id, user.id, user.id);
        return json({ workspace_id, left: true, access_cut: cut });
      }),
  );
}

// The invitee's side, for anyone signed in (a user invited to a workspace needn't be a developer yet): see the open
// invites to their own address, and accept or decline each.
export function registerInvitationTools(server: McpServer, store: Store, user: User, clerk: ClerkAllowlist | null = null) {
  const db = store.db;
  const email = user.email?.toLowerCase() ?? null;
  const mine = async (q: Q, id: string, lock = false) =>
    email && isUuid(id)
      ? ((await one(
          q,
          `SELECT i.id::text AS id, i.workspace_id::text AS workspace_id, i.role, i.mynt_role, i.created_at, i.invited_by::text AS invited_by
           FROM ${T}.workspace_invites i WHERE i.id::text = $1 AND i.email = $2 AND i.${OPEN.split(" AND ").join(" AND i.")}${lock ? " FOR UPDATE" : ""}`,
          [id, email],
        )) as { id: string; workspace_id: string; role: WorkspaceRole; mynt_role: string; created_at: string; invited_by: string | null } | undefined)
      : undefined;
  const none = (id: string) => fail(`No open invitation to you with id '${id}'`);

  server.registerTool(
    "list_my_invitations",
    {
      title: "Invitations to workspaces",
      description:
        "Workspaces you've been invited to and haven't answered: who invited you, your role there, and the Mynt role accepting offers (developer only if your account is just a user's). accept_workspace_invite or decline_workspace_invite.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!email) return json({ invitations: [] });
      const rows = (
        await db.query(
          `SELECT i.id::text AS id, i.workspace_id::text AS workspace_id, w.name AS workspace, i.role, i.mynt_role, u.name AS inviter_name, u.email AS inviter_email, i.created_at
           FROM ${T}.workspace_invites i JOIN ${T}.workspaces w ON w.id = i.workspace_id LEFT JOIN ${T}.users u ON u.id = i.invited_by
           WHERE i.email = $1 AND i.${OPEN.split(" AND ").join(" AND i.")} ORDER BY i.created_at`,
          [email],
        )
      ).rows as Record<string, unknown>[];
      const held = ((await one(db, `SELECT roles FROM ${T}.users WHERE id = $1`, [user.id]))?.roles as string[] | undefined) ?? [];
      const adminAt = ((await one(db, `SELECT admin_roles_at FROM ${T}.invites WHERE email = $1`, [email]))?.admin_roles_at as string | null | undefined) ?? null;
      return json({
        invitations: rows.map((r) => {
          const created = new Date(r.created_at as string);
          return {
            id: r.id as string,
            workspace: { id: r.workspace_id as string, name: r.workspace as string },
            invited_by: { name: (r.inviter_name as string | null) ?? null, email: (r.inviter_email as string | null) ?? null },
            role: r.role as string,
            grants: inviteGrants({ role: r.role as string, mynt_role: r.mynt_role as string, created_at: created.toISOString() }, held, adminAt).grants,
            expires_at: new Date(created.getTime() + WORKSPACE_INVITE_DAYS * 86_400_000).toISOString(),
          };
        }),
      });
    },
  );

  server.registerTool(
    "accept_workspace_invite",
    {
      title: "Join a workspace",
      description:
        "Accept an invitation to a workspace (list_my_invitations). You join with the role it names. A developer invitation also makes you a developer on Mynt if your account is just a user's; it never changes a firm's account (vendor, licence or liquidity provider), an admin's, or roles a Mynt admin set for you after it was sent.",
      inputSchema: { invite_id: z.string() },
    },
    async ({ invite_id }) => {
      const r = await inTransaction(db, async (tx) => {
        const inv = await mine(tx, invite_id, true);
        if (!inv) return null;
        // Whoever sent it must still be in the workspace, with the standing to invite to that role; otherwise the
        // invite is void (someone removed can't bring themselves, or anyone, back through one).
        const sender = inv.invited_by ? await workspaceRole(tx, inv.workspace_id, inv.invited_by) : null;
        const allowed = sender && (inv.role === "member" || (inv.role === "admin" && sender !== "member") || (inv.role === "owner" && sender === "owner"));
        if (!allowed) {
          await tx.query(`UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE id::text = $1`, [invite_id]);
          return { void: true as const, workspace_id: inv.workspace_id };
        }
        await tx.query(`UPDATE ${T}.workspace_invites SET accepted_at = now(), accepted_by = $2 WHERE id::text = $1`, [invite_id, user.id]);
        // Someone already in keeps the role they have.
        const joined =
          (
            await tx.query(
              `INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING role`,
              [inv.workspace_id, user.id, inv.role],
            )
          ).rows.length > 0;
        const held = ((await one(tx, `SELECT roles FROM ${T}.users WHERE id = $1`, [user.id]))?.roles as string[] | undefined) ?? [];
        const myntInvite = await one(tx, `SELECT roles, admin_roles_at FROM ${T}.invites WHERE email = $1`, [email]);
        // The Mynt invite's roles count too (an admin may have granted more than the account shows yet).
        let { developer } = inviteGrants(
          { role: inv.role, mynt_role: inv.mynt_role, created_at: new Date(inv.created_at).toISOString() },
          [...new Set([...held, ...(((myntInvite?.roles as string[] | undefined) ?? []))])],
          (myntInvite?.admin_roles_at as string | null | undefined) ?? null,
        );
        if (developer === "granted") {
          await tx.query(`UPDATE ${T}.users SET roles = array_append(roles, 'developer') WHERE id = $1 AND NOT ('developer' = ANY(roles))`, [user.id]);
          await tx.query(`UPDATE ${T}.invites SET roles = array_append(roles, 'developer'), updated_at = now(), revision = revision + 1 WHERE email = $1 AND NOT ('developer' = ANY(roles))`, [email]);
        }
        developer = developer as typeof developer;
        await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, 'accept_workspace_invite', $3, $4)`, [
          randomUUID(),
          user.id,
          inv.workspace_id,
          JSON.stringify({ invite_id, role: inv.role, joined, developer }),
        ]);
        return { workspace_id: inv.workspace_id, role: inv.role, joined, developer };
      });
      if (!r) return none(invite_id);
      if ("void" in r) {
        await store.audit(user.id, "void_workspace_invite", r.workspace_id, { invite_id, reason: "its sender can no longer invite to that role" });
        return fail("This invitation no longer stands: whoever sent it can't invite to that role any more");
      }
      return json({
        workspace_id: r.workspace_id,
        role: r.role,
        developer: r.developer,
        note:
          r.developer === "granted"
            ? "You're a developer on Mynt now: the developer tools appear the next time your client reconnects"
            : r.developer === "not_eligible"
              ? "You joined the workspace; your Mynt roles stay as they are (a developer invitation doesn't change a firm's or an admin's account, or roles an admin chose)"
              : "You joined the workspace",
      });
    },
  );

  server.registerTool(
    "decline_workspace_invite",
    {
      title: "Decline a workspace invitation",
      description: "Decline an invitation to a workspace (list_my_invitations).",
      inputSchema: { invite_id: z.string() },
    },
    async ({ invite_id }) => {
      const inv = await inTransaction(db, async (tx) => {
        const i = await mine(tx, invite_id, true);
        if (i) await tx.query(`UPDATE ${T}.workspace_invites SET declined_at = now(), revoked_at = now() WHERE id::text = $1`, [invite_id]);
        return i;
      });
      if (!inv) return none(invite_id);
      await store.audit(user.id, "decline_workspace_invite", inv.workspace_id, { invite_id });
      await releaseMyntInvite(store, invite_id, email!, user.id, clerk);
      return json({ declined: true });
    },
  );
  void clerk;
}
