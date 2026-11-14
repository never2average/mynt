import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction, type Db } from "./db.js";
import type { App, Store, User } from "./store.js";
import type { OrgDirectory, OrgRole } from "./org-directory.js";

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
  -- Each workspace is one organization of the identity provider (org-directory.ts), which decides who is in it; Mynt
  -- alone decides platform roles and ownership (workspace-sync.ts). Null until backfilled (mynt clerk sync-workspaces).
  ALTER TABLE ${T}.workspaces ADD COLUMN IF NOT EXISTS external_org_id text UNIQUE;
  -- creating (its organization is being made), backfill (being given one; members still to add) or done. Only done
  -- workspaces are synced.
  ALTER TABLE ${T}.workspaces ADD COLUMN IF NOT EXISTS org_sync text CHECK (org_sync IN ('creating', 'backfill', 'done'));
  -- Its organization was deleted in the provider (confirmed with it): frozen until an owner relinks or archives it.
  ALTER TABLE ${T}.workspaces ADD COLUMN IF NOT EXISTS org_missing_at timestamptz;
  -- Archived by an owner: undone with unarchive_workspace until archive_offboard_at, when everyone is offboarded.
  ALTER TABLE ${T}.workspaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
  ALTER TABLE ${T}.workspaces ADD COLUMN IF NOT EXISTS archive_offboard_at timestamptz;
  ALTER TABLE ${T}.workspaces ADD COLUMN IF NOT EXISTS archive_done_at timestamptz;
  -- When Mynt last saw this member in the organization, or put them there. Null: in Mynt only so far (from before
  -- organizations, or not signed in through the provider yet), so they're added there, never taken out.
  ALTER TABLE ${T}.workspace_members ADD COLUMN IF NOT EXISTS org_synced_at timestamptz;
  ALTER TABLE ${T}.workspace_invites ADD COLUMN IF NOT EXISTS external_invitation_id text;
  -- The provider says this invite's own invitation (matched by id) was accepted: Mynt's acceptance rules then apply.
  ALTER TABLE ${T}.workspace_invites ADD COLUMN IF NOT EXISTS external_accepted_at timestamptz;
  -- Someone not on Mynt who joined a workspace's organization in the provider: shown to its owners and admins, who
  -- invite them from Mynt to let them in. Nobody gets onto Mynt this way.
  CREATE TABLE IF NOT EXISTS ${T}.workspace_join_requests (
    workspace_id uuid NOT NULL REFERENCES ${T}.workspaces(id),
    subject text NOT NULL,
    email text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, subject)
  );
  -- The provider's webhook events already handled (once each; kept 30 days).
  CREATE TABLE IF NOT EXISTS ${T}.org_webhook_events (id text PRIMARY KEY, type text, received_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS org_webhook_events_received_idx ON ${T}.org_webhook_events (received_at);
  -- The reconcile worker's last run, and whether its circuit breaker stopped it (ops_status).
  CREATE TABLE IF NOT EXISTS ${T}.org_sync_status (id integer PRIMARY KEY CHECK (id = 1), last_run_at timestamptz, last_ok_at timestamptz, halted_at timestamptz, halted_reason text);
  -- This installation's id, stamped on the organizations it makes (only its own orphans are ever deleted).
  ALTER TABLE ${T}.org_sync_status ADD COLUMN IF NOT EXISTS instance_id text;
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
  -- leave (someone left or was removed) or demotion (an owner or admin made a member: their VM logins only).
  ALTER TABLE ${T}.workspace_offboards ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'leave';
  -- pending, done, superseded (they're back, so nothing more is revoked) or failed (gave up: ops_status says so).
  ALTER TABLE ${T}.workspace_offboards ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
  ALTER TABLE ${T}.workspace_offboards ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
  -- The steps done so far (only the rest are tried again), and the VM logins that were theirs when they left.
  ALTER TABLE ${T}.workspace_offboards ADD COLUMN IF NOT EXISTS steps jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE ${T}.workspace_offboards ADD COLUMN IF NOT EXISTS vm_logins jsonb NOT NULL DEFAULT '[]';
  CREATE INDEX IF NOT EXISTS workspace_offboards_due_idx ON ${T}.workspace_offboards (attempts, next_attempt_at) WHERE status = 'pending';
  -- Lapsed workspace invites already looked at for releasing their Mynt invite.
  ALTER TABLE ${T}.workspace_invites ADD COLUMN IF NOT EXISTS lapse_checked_at timestamptz;
`;

type Q = Pick<Db, "query">;
const one = async (q: Q, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows[0] as Record<string, unknown> | undefined;

const personalName = (u: { name?: string | null; email?: string | null }) => `${(u.name || u.email || "My").trim().slice(0, 180)}'s workspace`;

// The identity provider's organizations, when Mynt's workspaces follow them (set at startup; null: Mynt's own).
let orgs: OrgDirectory | null = null;
export function setOrgDirectory(d: OrgDirectory | null) {
  orgs = d;
}
export const orgRole = (r: string): OrgRole => (r === "member" ? "member" : "admin"); // the provider has no owner role
export const subjectOf = async (q: Q, userId: string) =>
  ((await one(q, `SELECT clerk_user_id FROM ${T}.users WHERE id::text = $1`, [userId]))?.clerk_user_id as string | null) ?? null;
// The organization, unless the provider deleted it (the workspace is frozen then, and nothing is sent there).
const liveOrgOf = async (q: Q, workspaceId: string) =>
  ((await one(q, `SELECT external_org_id FROM ${T}.workspaces WHERE id::text = $1 AND org_missing_at IS NULL`, [workspaceId]))?.external_org_id as string | null) ?? null;
// Apps of the workspace that are live: published, or running (or deploying) on Mynt's hosting.
async function liveApps(q: Q, workspaceId: string): Promise<number> {
  const published = Number((await one(q, `SELECT count(*)::int AS n FROM ${T}.apps WHERE workspace_id::text = $1 AND status = 'published'`, [workspaceId]))!.n);
  // Checked first, not caught: a failed query would abort the caller's transaction.
  if (!(await one(q, `SELECT to_regclass('${T}.hosted_apps') AS t`))?.t) return published;
  const hosted = Number(
    (await one(
      q,
      `SELECT count(*)::int AS n FROM ${T}.hosted_apps h JOIN ${T}.apps a ON a.id = h.app_id WHERE a.workspace_id::text = $1 AND a.status <> 'published' AND h.status IN ('deploying', 'running')`,
      [workspaceId],
    ))!.n,
  );
  return published + hosted;
}
const orgOf = async (q: Q, workspaceId: string) => ((await one(q, `SELECT external_org_id FROM ${T}.workspaces WHERE id::text = $1`, [workspaceId]))?.external_org_id as string | null) ?? null;

// Why nobody new may join a workspace now, if so: it's archived, or its organization was deleted in the provider.
export async function frozenReason(q: Q, workspaceId: string): Promise<string | null> {
  const r = await one(q, `SELECT org_missing_at, archived_at FROM ${T}.workspaces WHERE id::text = $1`, [workspaceId]);
  if (r?.archived_at) return "This workspace is archived (an owner can unarchive it with unarchive_workspace)";
  if (r?.org_missing_at)
    return "This workspace's organization was deleted in the identity provider, so it's frozen: an owner relinks it (relink_workspace_org) or archives it (archive_workspace)";
  return null;
}

// The provider's invitation for a Mynt invite that no longer stands (withdrawn, declined, lapsed or void) is withdrawn
// too. Best effort: the provider's invitations also expire, and accepting one still goes through Mynt's rules.
async function revokeOrgInvitation(q: Q, inviteId: string) {
  if (!orgs) return;
  const r = await one(
    q,
    `SELECT i.external_invitation_id AS ext, w.external_org_id AS org FROM ${T}.workspace_invites i JOIN ${T}.workspaces w ON w.id = i.workspace_id WHERE i.id::text = $1`,
    [inviteId],
  );
  if (!r?.ext || !r.org) return;
  await orgs.revokeInvitation(r.org as string, r.ext as string, null).catch((e) => console.error(`withdrawing an organization invitation: ${(e as Error).message}`));
}

async function insertWorkspace(q: Q, name: string, ownerId: string, personal = false, creating = false): Promise<string> {
  const id = randomUUID();
  await q.query(`INSERT INTO ${T}.workspaces (id, name, created_by, personal, org_sync) VALUES ($1, $2, $3, $4, $5)`, [id, name, ownerId, personal, creating ? "creating" : null]);
  await q.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, ownerId]);
  return id;
}

// With the identity provider's organizations, a new workspace is made first (org_sync 'creating'), then its
// organization, tagged with the workspace's id (so the provider's own event about it finds this workspace, whichever
// comes first), then the two are linked. If the organization can't be made or linked, neither stays.
const withOrgs = async (q: Q, userId: string) => Boolean(orgs && (await subjectOf(q, userId)));
async function makeOrgFor(q: Q, workspaceId: string, userId: string, name: string) {
  const org = await orgs!.createOrg(name, (await subjectOf(q, userId))!, workspaceId);
  try {
    await q.query(`UPDATE ${T}.workspaces SET external_org_id = $2, org_sync = 'done' WHERE id::text = $1`, [workspaceId, org.id]);
    await q.query(`UPDATE ${T}.workspace_members SET org_synced_at = now() WHERE workspace_id::text = $1 AND user_id::text = $2`, [workspaceId, userId]);
  } catch (e) {
    await orgs!.deleteOrg(org.id).catch(() => undefined);
    throw e;
  }
}
export async function dropNewWorkspace(q: Q, workspaceId: string) {
  await q.query(`DELETE FROM ${T}.workspace_join_requests WHERE workspace_id::text = $1`, [workspaceId]);
  await q.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1`, [workspaceId]);
  await q.query(`DELETE FROM ${T}.workspaces WHERE id::text = $1 AND NOT EXISTS (SELECT 1 FROM ${T}.apps WHERE workspace_id::text = $1)`, [workspaceId]);
}
async function newWorkspace(db: Db, name: string, userId: string): Promise<string> {
  const linked = await withOrgs(db, userId);
  const id = await inTransaction(db, (tx) => insertWorkspace(tx, name, userId, false, linked));
  if (linked)
    try {
      await makeOrgFor(db, id, userId, name);
    } catch (e) {
      await dropNewWorkspace(db, id);
      throw e;
    }
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
  const linked = await withOrgs(db, userId);
  const made = await one(
    db,
    `INSERT INTO ${T}.workspaces (id, name, created_by, personal, org_sync) VALUES ($1, $2, $3, true, $4) ON CONFLICT (created_by) WHERE personal DO NOTHING RETURNING id`,
    [randomUUID(), personalName(u ?? {}), userId, linked ? "creating" : null],
  );
  const id = (made?.id as string | undefined) ?? ((await one(db, `SELECT id FROM ${T}.workspaces WHERE created_by = $1 AND personal`, [userId]))!.id as string);
  // Its first member is its maker, as its owner (and nobody is put back into one they left).
  await db.query(
    `INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) SELECT $1, $2, 'owner'
     WHERE NOT EXISTS (SELECT 1 FROM ${T}.workspace_members WHERE workspace_id = $1)`,
    [id, userId],
  );
  if (made && linked)
    try {
      await makeOrgFor(db, id, userId, personalName(u ?? {}));
    } catch {
      await dropNewWorkspace(db, id);
      throw new Error("Your workspace couldn't be made just now (the identity provider didn't answer); try again");
    }
  return (await workspaceRole(db, id, userId)) ? id : newWorkspace(db, personalName(u ?? {}), userId);
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
  // Each lapsed invite is looked at once (lapse_checked_at), so ones that can't be released don't hold up the rest.
  const lapsed = (
    await store.db.query(
      `UPDATE ${T}.workspace_invites SET lapse_checked_at = now() WHERE id IN (
         SELECT w.id FROM ${T}.workspace_invites w
         WHERE w.accepted_at IS NULL AND w.revoked_at IS NULL AND w.lapse_checked_at IS NULL AND w.created_at <= now() - interval '${WORKSPACE_INVITE_DAYS} days'
         ORDER BY w.created_at LIMIT 100)
       RETURNING id::text AS id, email`,
    )
  ).rows as { id: string; email: string }[];
  let n = 0;
  for (const l of lapsed) {
    await revokeOrgInvitation(store.db, l.id);
    if (await releaseMyntInvite(store, l.id, l.email, null, clerk)) n++;
  }
  return n;
}

// ---- leaving: cut access at once ----

export interface OffboardServices {
  // Stops the leaver's running builds of these apps and closes the sandboxes they reopened (builds.ts): the ones
  // stopped, and the ones that couldn't be (tried again).
  stopBuilds?(userId: string, appIds: string[]): Promise<{ stopped: string[]; failed: string[] }>;
  // The VM logins someone holds now on the hosting that runs these apps (recorded when they leave, so a retry only
  // ever revokes those, never a login someone else got since).
  vmLoginsOf?(workspaceId: string, appIds: string[], userId: string): Promise<{ tenant_id: string; identity: string }[]>;
  // Revokes one login; throws unless the provider confirmed.
  revokeVmLogin?(tenantId: string, identity: string): Promise<void>;
}

export const OFFBOARD_MAX_ATTEMPTS = 10;
const LEAVE_STEPS = ["keys", "webhooks", "webhook_secrets", "invites", "repo_connections", "builds", "programs", "vm"] as const;
type Step = (typeof LEAVE_STEPS)[number];

export type OffboardRow = {
  workspace_id: string;
  user_id: string;
  actor_id: string | null;
  started_at: string;
  kind: "leave" | "demotion";
  attempts: number;
  steps: Record<string, boolean>;
  vm_logins: { tenant_id: string; identity: string; revoked?: boolean }[];
};

// Cuts someone off from a workspace's apps (kind "leave"), or ends an owner's or admin's VM logins when they're made
// a member ("demotion"). It's recorded first, with the VM logins that were theirs then; each step runs once it
// succeeds (keys, webhooks, invites, builds, VM logins...), and the ones that fail (a provider down) are tried again
// with backoff (retryOffboards: the worker, or an admin's retry_offboard), up to OFFBOARD_MAX_ATTEMPTS, after which
// it's marked failed and ops_status names it. If they're back in the workspace as an owner or admin before it's
// finished, it's superseded and nothing more is revoked; back only as a member, the rest is superseded but the VM
// logins of their admin days are still revoked (a member gets none). Hosted apps' runtime keys belong to the
// workspace (created_by NULL), so a deployer leaving never takes a running app down.
export async function offboard(store: Store, services: OffboardServices, workspaceId: string, userId: string, actor: string | null, kind: "leave" | "demotion" = "leave") {
  const db = store.db;
  const apps = await workspaceApps(db, workspaceId);
  // Their VM logins now. If that can't be read (the hosting side is down), the VM step reads it again on each retry:
  // a failed snapshot is never taken for "nothing to revoke".
  let logins: { tenant_id: string; identity: string }[] = [];
  let snapshot = !services.vmLoginsOf;
  if (services.vmLoginsOf)
    try {
      logins = await services.vmLoginsOf(workspaceId, apps, userId);
      snapshot = true;
    } catch {
      snapshot = false;
    }
  const initialSteps = {
    ...(kind === "demotion" ? Object.fromEntries(LEAVE_STEPS.filter((x) => x !== "vm").map((x) => [x, true])) : {}),
    ...(snapshot ? { vm_snapshot: true } : {}),
  };
  const row = (await one(
    db,
    `INSERT INTO ${T}.workspace_offboards (workspace_id, user_id, actor_id, kind, vm_logins, steps)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING workspace_id::text AS workspace_id, user_id::text AS user_id, actor_id::text AS actor_id,
       started_at::text AS started_at, kind, attempts, steps, vm_logins`,
    [workspaceId, userId, actor, kind, JSON.stringify(logins), JSON.stringify(initialSteps)],
  )) as unknown as OffboardRow;
  return runOffboard(store, services, row);
}

// An offboarding recorded inside a caller's transaction (archiving: the members' removal and their offboardings
// commit together), run afterwards with runRecordedOffboard. Which VM logins are theirs is read when it runs.
export async function recordOffboard(tx: Q, workspaceId: string, userId: string, actor: string | null): Promise<OffboardRow> {
  return (await one(
    tx,
    `INSERT INTO ${T}.workspace_offboards (workspace_id, user_id, actor_id, kind) VALUES ($1, $2, $3, 'leave')
     RETURNING workspace_id::text AS workspace_id, user_id::text AS user_id, actor_id::text AS actor_id, started_at::text AS started_at, kind, attempts, steps, vm_logins`,
    [workspaceId, userId, actor],
  )) as unknown as OffboardRow;
}
export const runRecordedOffboard = (store: Store, services: OffboardServices, row: OffboardRow) => runOffboard(store, services, row);

// Archived workspaces whose time is up (or an owner chose "now"): everyone is removed and offboarded, in one
// transaction with the archive's end, its open invites withdrawn, and its organization (if it still exists) deleted.
export async function finishArchives(store: Store, services: OffboardServices, workspaceId: string | null = null) {
  const due = (
    await store.db.query(
      `SELECT id::text AS id FROM ${T}.workspaces WHERE archived_at IS NOT NULL AND archive_done_at IS NULL AND archive_offboard_at <= now()
         AND ($1::text IS NULL OR id::text = $1) ORDER BY archive_offboard_at LIMIT 20`,
      [workspaceId],
    )
  ).rows as { id: string }[];
  let n = 0;
  for (const { id } of due) {
    const r = await inTransaction(store.db, async (tx) => {
      const w = await one(
        tx,
        `SELECT external_org_id FROM ${T}.workspaces WHERE id::text = $1 AND archived_at IS NOT NULL AND archive_done_at IS NULL AND archive_offboard_at <= now() FOR UPDATE`,
        [id],
      );
      if (!w) return null;
      if (await liveApps(tx, id)) {
        await tx.query(`UPDATE ${T}.workspaces SET archive_offboard_at = now() + interval '1 day' WHERE id::text = $1`, [id]);
        await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, NULL, 'workspace_archive_waiting', $2, $3)`, [
          randomUUID(),
          id,
          JSON.stringify({ reason: "an app is published or hosted: unpublish and undeploy it first" }),
        ]);
        return null;
      }
      const members = (await tx.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 RETURNING user_id::text AS user_id`, [id])).rows as { user_id: string }[];
      await tx.query(`UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE workspace_id::text = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [id]);
      await tx.query(`DELETE FROM ${T}.workspace_join_requests WHERE workspace_id::text = $1`, [id]);
      await tx.query(`UPDATE ${T}.workspaces SET archive_done_at = now() WHERE id::text = $1`, [id]);
      const rows = [];
      for (const m of members) rows.push(await recordOffboard(tx, id, m.user_id, null));
      await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, NULL, 'workspace_archive_done', $2, $3)`, [
        randomUUID(),
        id,
        JSON.stringify({ members: members.length }),
      ]);
      return { rows, org: (w.external_org_id as string | null) ?? null };
    });
    if (!r) continue;
    n++;
    for (const row of r.rows) await runOffboard(store, services, row);
    if (r.org && orgs) await orgs.deleteOrg(r.org).catch((e) => console.error(`deleting an archived workspace's organization: ${(e as Error).message}`));
  }
  return n;
}

const workspaceApps = async (db: Q, workspaceId: string) =>
  (await db.query(`SELECT id::text AS id FROM ${T}.apps WHERE workspace_id::text = $1`, [workspaceId])).rows.map((r) => (r as { id: string }).id);

async function runOffboard(store: Store, services: OffboardServices, row: OffboardRow) {
  const db = store.db;
  const { workspace_id: workspaceId, user_id: userId, actor_id: actor } = row;
  const key = [workspaceId, userId, row.started_at];
  const where = `workspace_id = $1 AND user_id = $2 AND started_at = $3::timestamptz`;
  // Back as an owner or admin since: what they have now was granted since, so it all stays. Back only as a member:
  // their keys, invites and the rest are a member's again, but a member holds no VM login, so any from before still go.
  const role = await workspaceRole(db, workspaceId, userId);
  if (role === "owner" || role === "admin") {
    await db.query(`UPDATE ${T}.workspace_offboards SET status = 'superseded', completed_at = now() WHERE ${where}`, key);
    await store.audit(null, "workspace_offboard_superseded", workspaceId, { user_id: userId, kind: row.kind });
    return { user_id: userId, superseded: true };
  }
  const steps: Record<string, boolean> = { ...row.steps };
  if (role === "member" && row.kind === "leave") {
    for (const x of LEAVE_STEPS) if (x !== "vm") steps[x] = true;
    await store.audit(null, "workspace_offboard_superseded", workspaceId, { user_id: userId, kind: row.kind, except: "vm" });
  }
  const apps = await workspaceApps(db, workspaceId);
  const done: Record<string, unknown> = { user_id: userId };
  const failures: string[] = [];
  const step = async (name: Step, f: () => Promise<unknown>) => {
    if (steps[name]) return;
    try {
      const r = await f();
      if (r !== undefined) done[name] = r;
      steps[name] = true;
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`);
    }
  };
  const ids = (rows: unknown[]) => rows.map((r) => (r as { id: string }).id);
  // Keys they made, or whose current secret they were given (by rotating it).
  await step("keys", async () =>
    ids(
      (
        await db.query(
          `UPDATE ${T}.api_keys SET status = 'revoked', revoked_at = now()
           WHERE app_id::text = ANY($1) AND status = 'active' AND (created_by = $2 OR last_secret_issued_to = $2) RETURNING id::text AS id`,
          [apps, userId],
        )
      ).rows,
    ),
  );
  // Webhooks they made stop; others whose secret they were given get a new one nobody has yet, and the workspace's
  // owners and admins are told (in its audit trail and ops_status) so the receiver can be given the new one.
  await step("webhooks", async () =>
    ids((await db.query(`UPDATE ${T}.webhooks SET disabled_at = now() WHERE app_id::text = ANY($1) AND created_by = $2 AND disabled_at IS NULL RETURNING id::text AS id`, [apps, userId])).rows),
  );
  await step("webhook_secrets", async () => {
    const rotated = [];
    for (const h of (await db.query(`SELECT id::text AS id, app_id::text AS app_id FROM ${T}.webhooks WHERE app_id::text = ANY($1) AND last_secret_issued_to = $2`, [apps, userId])).rows as {
      id: string;
      app_id: string;
    }[]) {
      await store.rotateWebhookSecret(h.id, null);
      await store.audit(null, "webhook_secret_rotated_on_offboard", h.id, { app_id: h.app_id, workspace_id: workspaceId, next: "an owner or admin rotates it (rotate_webhook_secret) and gives the receiver the new secret" });
      rotated.push(h.id);
    }
    return rotated;
  });
  // Invites they sent and nobody has answered: void, so they can't come back through one.
  await step("invites", async () => {
    const invites = (
      await db.query(
        `UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE workspace_id::text = $1 AND invited_by = $2 AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id::text AS id, email`,
        [workspaceId, userId],
      )
    ).rows as { id: string; email: string }[];
    for (const i of invites) {
      await revokeOrgInvitation(db, i.id);
      await releaseMyntInvite(store, i.id, i.email, actor, null);
    }
    return invites.map((i) => i.id);
  });
  // The access Mynt gave them to the apps' managed repositories (approved automatically) goes.
  await step("repo_connections", async () => {
    try {
      return (
        await db.query(
          `DELETE FROM ${T}.repo_connections WHERE developer_id = $1 AND repository IN (
             SELECT repository FROM ${T}.app_repositories WHERE app_id::text = ANY($2) AND managed
             UNION SELECT managed_repository FROM ${T}.app_repositories WHERE app_id::text = ANY($2) AND managed_repository IS NOT NULL)
           RETURNING repository`,
          [userId, apps],
        )
      ).rows.map((r) => (r as { repository: string }).repository);
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return []; // no builds service here
      throw e;
    }
  });
  await step("builds", async () => {
    if (!services.stopBuilds) return [];
    const r = await services.stopBuilds(userId, apps);
    if (r.failed.length) throw Object.assign(new Error(`not stopped yet: ${r.failed.join(", ")}`), { partial: r.stopped });
    return r.stopped;
  });
  // Programs they reserved for the team's apps pass to the workspace's longest-standing owner.
  await step("programs", async () => {
    try {
      return (
        await db.query(
          `UPDATE ${T}.solana_programs SET owner_id = (SELECT user_id FROM ${T}.workspace_members WHERE workspace_id::text = $3 AND role = 'owner' ORDER BY joined_at LIMIT 1)
           WHERE app_id::text = ANY($1) AND owner_id = $2 RETURNING program_id`,
          [apps, userId, workspaceId],
        )
      ).rows.map((r) => (r as { program_id: string }).program_id);
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return []; // no Solana service here
      throw e;
    }
  });
  // Only the logins that were theirs when they left (read again here if that failed then); each once the provider
  // confirms.
  let logins = row.vm_logins.map((l) => ({ ...l }));
  await step("vm", async () => {
    if (!steps.vm_snapshot) {
      if (!services.vmLoginsOf) throw new Error("hosting isn't available to say which VM logins are theirs");
      logins = (await services.vmLoginsOf(workspaceId, apps, userId)).map((l) => ({ ...l }));
      steps.vm_snapshot = true;
    }
    let revoked = 0;
    const left = [];
    for (const l of logins.filter((x) => !x.revoked)) {
      try {
        if (!services.revokeVmLogin) throw new Error("hosting isn't available");
        await services.revokeVmLogin(l.tenant_id, l.identity);
        l.revoked = true;
        revoked++;
      } catch {
        left.push(l.tenant_id);
      }
    }
    if (left.length) throw new Error(`${left.length} VM login(s) not revoked yet`);
    return revoked;
  });
  const attempts = row.attempts + 1;
  const status = failures.length ? (attempts >= OFFBOARD_MAX_ATTEMPTS ? "failed" : "pending") : "done";
  await db.query(
    `UPDATE ${T}.workspace_offboards SET attempts = $4::int, steps = $5::jsonb, vm_logins = $6::jsonb, done = done || $7::jsonb, error = $8::text, status = $9::text,
       next_attempt_at = now() + make_interval(mins => LEAST(60, power(2, $4::int)::int)), completed_at = CASE WHEN $9::text IN ('done', 'failed') THEN now() END
     WHERE ${where}`,
    [...key, attempts, JSON.stringify(steps), JSON.stringify(logins), JSON.stringify(done), failures.length ? failures.join("; ") : null, status],
  );
  const result = {
    user_id: userId,
    revoked_api_keys: (done.keys as string[] | undefined) ?? [],
    disabled_webhooks: (done.webhooks as string[] | undefined) ?? [],
    rotated_webhook_secrets: (done.webhook_secrets as string[] | undefined) ?? [],
    revoked_invites: (done.invites as string[] | undefined) ?? [],
    removed_repo_connections: (done.repo_connections as string[] | undefined) ?? [],
    stopped_builds: (done.builds as string[] | undefined) ?? [],
    programs_to_owner: (done.programs as string[] | undefined) ?? [],
    vm_logins_revoked: (done.vm as number | undefined) ?? 0,
    ...(failures.length ? { pending: failures } : {}),
    status,
  };
  await store.audit(actor, row.kind === "leave" ? "workspace_offboard" : "workspace_demotion_offboard", workspaceId, result);
  return result;
}

// Offboardings with a step still to do, the longest-waiting first among the least-tried (so one that keeps failing
// can't hold up newer ones). The worker takes the ones due; an admin (retry_offboard) any pending or failed one.
export async function retryOffboards(store: Store, services: OffboardServices, filter: { workspace_id?: string; user_id?: string; force?: boolean } = {}) {
  const rows = (
    await store.db.query(
      `SELECT workspace_id::text AS workspace_id, user_id::text AS user_id, actor_id::text AS actor_id, started_at::text AS started_at, kind,
         CASE WHEN status = 'failed' THEN 0 ELSE attempts END AS attempts, steps, vm_logins
       FROM ${T}.workspace_offboards
       WHERE ${filter.force ? "status IN ('pending', 'failed')" : "status = 'pending' AND next_attempt_at <= now()"}
         AND ($1::text IS NULL OR workspace_id::text = $1) AND ($2::text IS NULL OR user_id::text = $2)
       ORDER BY attempts, next_attempt_at LIMIT 50`,
      [filter.workspace_id ?? null, filter.user_id ?? null],
    )
  ).rows as unknown as OffboardRow[];
  const out = [];
  for (const r of rows) out.push(await runOffboard(store, services, r));
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
          `SELECT w.id::text AS id, w.name, m.role, w.created_at, m.joined_at, w.org_missing_at, w.archived_at, w.archive_offboard_at,
             (w.personal AND w.created_by = $1) AS personal,
             (SELECT count(*)::int FROM ${T}.workspace_members x WHERE x.workspace_id = w.id) AS members,
             (SELECT count(*)::int FROM ${T}.apps a WHERE a.workspace_id = w.id) AS apps
           FROM ${T}.workspace_members m JOIN ${T}.workspaces w ON w.id = m.workspace_id
           WHERE m.user_id = $1 ORDER BY w.created_at`,
          [user.id],
        )
      ).rows as Record<string, unknown>[];
      const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
      return json(
        rows.map(({ org_missing_at, archived_at, archive_offboard_at, ...r }) => ({
          ...r,
          created_at: iso(r.created_at),
          joined_at: iso(r.joined_at),
          // Frozen: its organization was deleted in the identity provider (an owner relinks or archives it).
          ...(org_missing_at ? { org_missing_since: iso(org_missing_at), note: "Its organization was deleted in the identity provider: an owner relinks it (relink_workspace_org) or archives it (archive_workspace)" } : {}),
          ...(archived_at ? { archived_at: iso(archived_at), offboarding_at: iso(archive_offboard_at) } : {}),
        })),
      );
    },
  );

  server.registerTool(
    "create_workspace",
    {
      title: "Create a workspace",
      description: "Developer: a new workspace for a team's apps. You're its owner; invite_to_workspace brings others in.",
      inputSchema: { name: z.string().trim().min(1).max(200) },
    },
    async ({ name }) =>
      attempt(async () => {
        // With the identity provider's organizations, it's one of those too; if that can't be made, neither is.
        let id: string;
        try {
          id = await newWorkspace(db, name, user.id);
        } catch (e) {
          if (orgs) throw new Refused(`The workspace couldn't be made just now (${(e as Error).message.slice(0, 120)}); try again`);
          throw e;
        }
        await audit("create_workspace", id, { name });
        return json({ id, name, role: "owner" });
      }),
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
          const org = orgs ? await liveOrgOf(tx, workspace_id) : null;
          if (org) await orgs!.renameOrg(org, name);
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
      const manage = orgs && (await orgOf(db, workspace_id)) ? orgs.manageUrl() : null;
      // People not on Mynt who joined the organization in the identity provider: let in only by an invite from Mynt.
      const requests =
        role === "member"
          ? []
          : (await db.query(`SELECT email, created_at FROM ${T}.workspace_join_requests WHERE workspace_id::text = $1 ORDER BY created_at`, [workspace_id])).rows;
      const frozen = await frozenReason(db, workspace_id);
      return json({
        workspace_id,
        your_role: role,
        members,
        ...(invites ? { open_invites: invites } : {}),
        ...(requests.length
          ? { join_requests: requests, join_requests_note: "They joined the organization in the identity provider but aren't on Mynt: invite_to_workspace lets them in" }
          : {}),
        ...(frozen ? { frozen } : {}),
        ...(manage ? { manage_url: manage } : {}),
      });
    },
  );

  server.registerTool(
    "invite_to_workspace",
    {
      title: "Invite someone to a workspace",
      description:
        "Developer: invite an email address to a workspace you're in. role is their place in the workspace: member (anyone may invite members), admin (owners and admins only) or owner (owners only). mynt_role is what accepting offers them on Mynt: developer (build apps; given only to an account that's just a user, never a firm's or an admin's) or user (nothing more; they can be in the workspace but can't build). Someone new can sign in to Mynt at once, as a user; they see the invite with list_my_invitations and accept or decline it. Someone a Mynt admin removed stays out. Up to 20 invites a day each. When the workspace is an organization of the identity provider, the provider emails them its invitation (accepting it there or in Mynt both apply these same rules); otherwise Mynt doesn't email them: tell them yourself.",
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
          const frozen = await frozenReason(tx, workspace_id);
          if (frozen) throw new Refused(frozen);
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
          const lapsed = (
            await tx.query(
              `UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE workspace_id::text = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL
                 AND created_at <= now() - interval '${WORKSPACE_INVITE_DAYS} days' RETURNING id::text AS id`,
              [workspace_id, lower],
            )
          ).rows as { id: string }[];
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
          return { id, workspace_id, email: lower, role, mynt_role, lapsed };
        });
        for (const l of invite.lapsed) await revokeOrgInvitation(db, l.id);
        delete (invite as { lapsed?: unknown }).lapsed;
        // An organization's invitation, which the invitee accepts with the identity provider (or in Mynt).
        const org = orgs ? await orgOf(db, workspace_id) : null;
        if (org) {
          try {
            const sent = await orgs!.invite(org, {
              email: lower,
              role: orgRole(role),
              inviter: await subjectOf(db, user.id),
              metadata: { mynt_role, mynt_workspace_role: role, mynt_invite_id: invite.id },
              redirectUrl: process.env.STUDIO_URL ?? null,
            });
            await db.query(`UPDATE ${T}.workspace_invites SET external_invitation_id = $2 WHERE id::text = $1`, [invite.id, sent.id]);
          } catch (e) {
            await db.query(`UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE id::text = $1`, [invite.id]);
            throw new Refused(`The invitation couldn't be sent just now (${(e as Error).message.slice(0, 120)}); try again`);
          }
        }
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
          const ext = (await one(tx, `SELECT external_invitation_id FROM ${T}.workspace_invites WHERE id::text = $1`, [invite_id]))?.external_invitation_id as string | null;
          const org = orgs && ext ? await orgOf(tx, ws) : null;
          if (org) await orgs!.revokeInvitation(org, ext!, await subjectOf(tx, user.id));
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
          // The organization agrees first (an owner is its admin): if that fails, nothing changes.
          const org = orgs ? await liveOrgOf(tx, workspace_id) : null;
          const subject = org ? await subjectOf(tx, user_id) : null;
          if (org && subject) await orgs!.setMemberRole(org, subject, orgRole(role));
          await tx.query(`UPDATE ${T}.workspace_members SET role = $3 WHERE workspace_id::text = $1 AND user_id::text = $2`, [workspace_id, user_id, role]);
          return current;
        });
        await audit("change_member_role", workspace_id, { user_id, from, to: role });
        if (from !== "member" && role === "member") await offboard(store, ctx.offboarding ?? {}, workspace_id, user_id, user.id, "demotion");
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
          const org = orgs ? await liveOrgOf(tx, workspace_id) : null;
          const subject = org ? await subjectOf(tx, user_id) : null;
          if (org && subject) await orgs!.removeMember(org, subject);
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
          const org = orgs ? await liveOrgOf(tx, workspace_id) : null;
          const subject = org ? await subjectOf(tx, user.id) : null;
          if (org && subject) await orgs!.removeMember(org, subject);
          await tx.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id = $2`, [workspace_id, user.id]);
          return mine;
        });
        await audit("leave_workspace", workspace_id, { role: was });
        const cut = await offboard(store, ctx.offboarding ?? {}, workspace_id, user.id, user.id);
        return json({ workspace_id, left: true, access_cut: cut });
      }),
  );

  const ownerOnly = (role: WorkspaceRole) => {
    if (role !== "owner") throw new Refused("Only the workspace's owners can do that");
  };

  server.registerTool(
    "relink_workspace_org",
    {
      title: "Give a workspace a new organization",
      description:
        "Developer: owners only. A workspace whose organization was deleted in the identity provider is frozen (list_workspaces says so). This makes it a new organization, with its members in it (owners and admins as the organization's admins), and unfreezes it. Members who haven't signed in through the identity provider yet are added when they do.",
      inputSchema: { workspace_id: z.string() },
    },
    async ({ workspace_id }) =>
      attempt(async () => {
        if (!orgs) return fail("Workspaces aren't organizations of an identity provider here");
        const me = await subjectOf(db, user.id);
        if (!me) throw new Refused("Sign in through the identity provider first");
        const r = await locked(workspace_id, async (tx, mine) => {
          ownerOnly(mine);
          const w = await one(tx, `SELECT name, org_missing_at, archived_at FROM ${T}.workspaces WHERE id::text = $1`, [workspace_id]);
          if (w!.archived_at) throw new Refused("This workspace is archived: unarchive it first");
          if (!w!.org_missing_at) throw new Refused("This workspace's organization still exists");
          const org = await orgs!.createOrg(w!.name as string, me, workspace_id);
          try {
            await tx.query(`UPDATE ${T}.workspaces SET external_org_id = $2, org_missing_at = NULL, org_sync = 'done' WHERE id::text = $1`, [workspace_id, org.id]);
            await tx.query(`UPDATE ${T}.workspace_members SET org_synced_at = NULL WHERE workspace_id::text = $1`, [workspace_id]);
            const members = (
              await tx.query(
                `SELECT m.user_id::text AS user_id, m.role, u.clerk_user_id AS subject FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id
                 WHERE m.workspace_id::text = $1 AND u.clerk_user_id IS NOT NULL`,
                [workspace_id],
              )
            ).rows as { user_id: string; role: string; subject: string }[];
            for (const m of members) {
              if (m.subject !== me) await orgs!.addMember(org.id, m.subject, orgRole(m.role));
              await tx.query(`UPDATE ${T}.workspace_members SET org_synced_at = now() WHERE workspace_id::text = $1 AND user_id::text = $2`, [workspace_id, m.user_id]);
            }
            return { org_id: org.id, members_added: members.length };
          } catch (e) {
            await orgs!.deleteOrg(org.id).catch(() => undefined);
            throw new Refused(`The organization couldn't be made just now (${(e as Error).message.slice(0, 120)}); try again`);
          }
        });
        await audit("relink_workspace_org", workspace_id, r);
        return json({ workspace_id, relinked: true, ...r });
      }),
  );

  server.registerTool(
    "archive_workspace",
    {
      title: "Archive a workspace",
      description:
        "Developer: owners only. Freezes the workspace (nobody new joins) and, 7 days later, removes and offboards everyone and deletes its organization in the identity provider. Until then any owner can undo it with unarchive_workspace. Not while any of its apps is published or hosted: unpublish and undeploy them first. now: true does it at once and can't be undone; only a workspace's sole owner can choose it.",
      inputSchema: { workspace_id: z.string(), now: z.boolean().default(false) },
      annotations: { destructiveHint: true },
    },
    async ({ workspace_id, now }) =>
      attempt(async () => {
        const at = await locked(workspace_id, async (tx, mine) => {
          ownerOnly(mine);
          const live = await liveApps(tx, workspace_id);
          if (live) throw new Refused(`${live} of this workspace's apps are published or hosted: unpublish and undeploy them first`);
          if (now && (await owners(tx, workspace_id)) > 1)
            throw new Refused("This workspace has other owners: archive it without now (any owner can undo that within 7 days)");
          const r = await one(
            tx,
            `UPDATE ${T}.workspaces SET archived_at = COALESCE(archived_at, now()),
               archive_offboard_at = CASE WHEN $2::boolean THEN now() ELSE COALESCE(archive_offboard_at, now() + interval '7 days') END
             WHERE id::text = $1 AND archive_done_at IS NULL RETURNING archive_offboard_at`,
            [workspace_id, now],
          );
          if (!r) throw new Refused("This workspace's archiving is already done");
          return new Date(r.archive_offboard_at as string).toISOString();
        });
        await audit("archive_workspace", workspace_id, { now, offboarding_at: at });
        if (now) await finishArchives(store, ctx.offboarding ?? {}, workspace_id);
        return json({ workspace_id, archived: true, offboarding_at: at, ...(now ? { done: true } : { undo: "unarchive_workspace, until then" }) });
      }),
  );

  server.registerTool(
    "unarchive_workspace",
    {
      title: "Unarchive a workspace",
      description: "Developer: owners only. Undoes archive_workspace while its 7 days haven't passed: nobody has been removed yet.",
      inputSchema: { workspace_id: z.string() },
    },
    async ({ workspace_id }) =>
      attempt(async () => {
        await locked(workspace_id, async (tx, mine) => {
          ownerOnly(mine);
          const r = await one(
            tx,
            `UPDATE ${T}.workspaces SET archived_at = NULL, archive_offboard_at = NULL WHERE id::text = $1 AND archived_at IS NOT NULL AND archive_done_at IS NULL RETURNING id`,
            [workspace_id],
          );
          if (!r) throw new Refused("This workspace isn't archived, or its archiving is already done");
        });
        await audit("unarchive_workspace", workspace_id);
        return json({ workspace_id, archived: false });
      }),
  );
}

// The invitee's side, for anyone signed in (a user invited to a workspace needn't be a developer yet): see the open
// invites to their own address, and accept or decline each.
export type OpenInvite = { id: string; workspace_id: string; email: string; role: WorkspaceRole; mynt_role: string; created_at: string; invited_by: string | null };
// An open invite (not accepted, withdrawn, declined or lapsed), locked; to this address only, when one is given.
export async function openInvite(q: Q, id: string, email: string | null = null): Promise<OpenInvite | undefined> {
  if (!isUuid(id)) return undefined;
  return (await one(
    q,
    `SELECT i.id::text AS id, i.workspace_id::text AS workspace_id, i.email, i.role, i.mynt_role, i.created_at, i.invited_by::text AS invited_by
     FROM ${T}.workspace_invites i WHERE i.id::text = $1 AND ($2::text IS NULL OR i.email = $2) AND i.${OPEN.split(" AND ").join(" AND i.")} FOR UPDATE`,
    [id, email],
  )) as OpenInvite | undefined;
}

export type Acceptance =
  | { void: true; workspace_id: string }
  | { frozen: string; workspace_id: string }
  | { workspace_id: string; role: WorkspaceRole; joined: boolean; developer: ReturnType<typeof inviteGrants>["developer"]; set_org_role: OrgRole | null };

// Mynt's rules for accepting a workspace invite, the same whether its invitee accepts it in Mynt or the identity
// provider reports that invite's own invitation (by id) accepted: whoever sent it must still be in the workspace with
// the standing to invite to that role (else it's void), the workspace mustn't be frozen; then they join with its role,
// and a developer invite makes an account that's just a user's a developer (inviteGrants), never past roles a Mynt
// admin set after it was sent. `inOrg`: their role in the workspace's organization when the provider reported it
// (null: from Mynt, so they're added there). Reported by the provider, a role to set there is returned
// (set_org_role) for the caller to send once its transaction is over.
export async function acceptInvite(tx: Q, inv: OpenInvite, user: { id: string; email: string | null }, inOrg: OrgRole | null = null): Promise<Acceptance> {
  const sender = inv.invited_by ? await workspaceRole(tx, inv.workspace_id, inv.invited_by) : null;
  const allowed = sender && (inv.role === "member" || (inv.role === "admin" && sender !== "member") || (inv.role === "owner" && sender === "owner"));
  if (!allowed) {
    await tx.query(`UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE id::text = $1`, [inv.id]);
    return { void: true, workspace_id: inv.workspace_id };
  }
  const frozen = await frozenReason(tx, inv.workspace_id);
  if (frozen) return { frozen, workspace_id: inv.workspace_id };
  await tx.query(`UPDATE ${T}.workspace_invites SET accepted_at = now(), accepted_by = $2 WHERE id::text = $1`, [inv.id, user.id]);
  const already = await workspaceRole(tx, inv.workspace_id, user.id);
  // With an organization behind it: in it too, with the invite's role (or nothing changes); the invitation is spent.
  const org = orgs ? await orgOf(tx, inv.workspace_id) : null;
  const subject = org ? await subjectOf(tx, user.id) : null;
  let setOrgRole: OrgRole | null = null;
  if (org && subject && !already) {
    if (inOrg === null) await orgs!.addMember(org, subject, orgRole(inv.role));
    else if (inOrg !== orgRole(inv.role)) setOrgRole = orgRole(inv.role);
  }
  if (org && inOrg === null) await revokeOrgInvitation(tx, inv.id);
  // Someone already in keeps the role they have.
  const joined =
    (
      await tx.query(
        `INSERT INTO ${T}.workspace_members (workspace_id, user_id, role, org_synced_at) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, user_id) DO NOTHING RETURNING role`,
        [inv.workspace_id, user.id, inv.role, org && subject ? new Date().toISOString() : null],
      )
    ).rows.length > 0;
  const email = user.email?.toLowerCase() ?? null;
  const held = ((await one(tx, `SELECT roles FROM ${T}.users WHERE id = $1`, [user.id]))?.roles as string[] | undefined) ?? [];
  const myntInvite = email ? await one(tx, `SELECT roles, admin_roles_at FROM ${T}.invites WHERE email = $1`, [email]) : undefined;
  // The Mynt invite's roles count too (an admin may have granted more than the account shows yet).
  const { developer } = inviteGrants(
    { role: inv.role, mynt_role: inv.mynt_role, created_at: new Date(inv.created_at).toISOString() },
    [...new Set([...held, ...(((myntInvite?.roles as string[] | undefined) ?? []))])],
    (myntInvite?.admin_roles_at as string | null | undefined) ?? null,
  );
  if (developer === "granted") {
    await tx.query(`UPDATE ${T}.users SET roles = array_append(roles, 'developer') WHERE id = $1 AND NOT ('developer' = ANY(roles))`, [user.id]);
    if (email)
      await tx.query(`UPDATE ${T}.invites SET roles = array_append(roles, 'developer'), updated_at = now(), revision = revision + 1 WHERE email = $1 AND NOT ('developer' = ANY(roles))`, [email]);
  }
  await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, 'accept_workspace_invite', $3, $4)`, [
    randomUUID(),
    user.id,
    inv.workspace_id,
    JSON.stringify({ invite_id: inv.id, role: inv.role, joined, developer, ...(inOrg !== null ? { via: "identity provider" } : {}) }),
  ]);
  return { workspace_id: inv.workspace_id, role: inv.role, joined, developer, set_org_role: setOrgRole };
}

export function registerInvitationTools(server: McpServer, store: Store, user: User, clerk: ClerkAllowlist | null = null) {
  const db = store.db;
  const email = user.email?.toLowerCase() ?? null;
  const mine = async (q: Q, id: string) => (email ? openInvite(q, id, email) : undefined);
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
        const inv = await mine(tx, invite_id);
        if (!inv) return null;
        // Whoever sent it must still be in the workspace, with the standing to invite to that role; otherwise the
        // invite is void (someone removed can't bring themselves, or anyone, back through one).
        return acceptInvite(tx, inv, { id: user.id, email });
      });
      if (!r) return none(invite_id);
      if ("frozen" in r) return fail(r.frozen);
      if ("void" in r) {
        await revokeOrgInvitation(db, invite_id);
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
        const i = await mine(tx, invite_id);
        if (i) await tx.query(`UPDATE ${T}.workspace_invites SET declined_at = now(), revoked_at = now() WHERE id::text = $1`, [invite_id]);
        return i;
      });
      if (!inv) return none(invite_id);
      await revokeOrgInvitation(db, invite_id);
      await store.audit(user.id, "decline_workspace_invite", inv.workspace_id, { invite_id });
      // They came onto Mynt only through this invite (a user's admission nobody changed) and belong to no workspace:
      // declining it takes them back off, unless another invite is still waiting for them.
      const out = await one(
        db,
        `DELETE FROM ${T}.invites i WHERE i.email = $1 AND i.created_by_workspace_invite_id::text = $2 AND i.revision = 0 AND i.admin_roles_at IS NULL
           AND i.roles = '{consumer}' AND NOT EXISTS (SELECT 1 FROM ${T}.workspace_members m WHERE m.user_id = $3)
           AND NOT EXISTS (SELECT 1 FROM ${T}.workspace_invites w WHERE w.email = $1 AND w.${OPEN.split(" AND ").join(" AND w.")})
         RETURNING email`,
        [email, invite_id, user.id],
      );
      if (out) {
        await store.audit(user.id, "uninvite_via_workspace", email!, { workspace_invite_id: invite_id, declined: true });
        await clerk?.disallow?.(email!).catch(() => undefined);
      }
      return json({ declined: true });
    },
  );
  void clerk;
}
