import { randomUUID } from "node:crypto";
import { inTransaction, type Db } from "./db.js";
import type { Org, OrgDirectory, OrgEvent, OrgEventSource, OrgMembership } from "./org-directory.js";
import type { Store } from "./store.js";
import { acceptInvite, dropNewWorkspace, offboard, openInvite, orgRole, WORKSPACE_INVITE_DAYS, workspaceRole, type OffboardServices } from "./workspaces.js";

// Keeps Mynt's workspaces in step with the identity provider's organizations. The provider decides who is in a
// workspace's organization; Mynt alone decides platform roles (developer, user, ...) and who owns a workspace. So:
// - Syncing never grants or changes anyone's platform roles. Those change only through Mynt's own invite acceptance
//   (workspaces.ts acceptInvite), which also runs when the provider reports a Mynt invite's own invitation (matched by
//   id) accepted.
// - Syncing never raises a workspace role: someone joining through the provider is a member, and an admin role given
//   there is put back. It may lower one (an admin made a member there: Mynt's demotion offboarding runs).
// - Ownership is Mynt's. An owner removed or demoted in the provider is put back there (workspace_owner_restored);
//   nobody is ever made an owner by syncing, except the creator of a new organization made in the provider, of that
//   new workspace only.
// - Nothing is destroyed on inference. Every event is re-read from the provider before it's applied (a late, repeated
//   or out-of-order delivery can't undo a newer change); a member is taken out only once the provider confirms they're
//   not in the organization, and only if Mynt has seen them there (someone in Mynt only is added there instead); an
//   organization the provider confirms deleted freezes its workspace (org_missing_at) until an owner relinks or archives
//   it; and the reconcile worker stops (ops_status) rather than remove more than RECONCILE_MAX_SHARE at once.
// - Someone not on Mynt who joins an organization in the provider isn't let onto Mynt: it's a join request the
//   workspace's owners and admins see (list_workspace_members), and an invite from Mynt lets them in. They're kept an
//   org:member there, so the provider's admins are only ever Mynt's owners and admins: a removal or role change made
//   in the provider is then one a Mynt owner or admin could make (an owner's is undone anyway). The provider doesn't
//   say who made a change, so the audit records its event id and the request's address and client.
// - The provider is written to only after Mynt's transaction is over (no waiting out its rate limit while holding a
//   workspace's row).
// - Someone a Mynt admin revoked (by their Mynt address or any address the provider verified as theirs) is removed
//   from the organization again, and that's audited.

const T = "financial_products";
type Q = Pick<Db, "query">;
type Row = Record<string, unknown>;
type Ws = { id: string; name: string; org_sync: string | null; org_missing_at: string | null; archived_at: string | null };

// Above this share of the linked organizations, or of the members Mynt has seen in them, to take out in one run, the
// reconcile worker changes nothing and says so in ops_status: an outage or a bad listing mustn't empty workspaces. One
// at a time always proceeds (each is confirmed with the provider first).
export const RECONCILE_MAX_SHARE = 0.1;
// How long a workspace or organization may stay half-made (its making crashed) before it's cleared away.
export const ABANDONED_MS = 60 * 60_000;

// This installation's id (made once), stamped on the organizations it makes.
export async function orgInstanceId(db: Q): Promise<string> {
  await db.query(
    `INSERT INTO ${T}.org_sync_status (id, instance_id) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET instance_id = COALESCE(${T}.org_sync_status.instance_id, EXCLUDED.instance_id)`,
    [randomUUID()],
  );
  return (await one(db, `SELECT instance_id FROM ${T}.org_sync_status WHERE id = 1`))!.instance_id as string;
}

let active: WorkspaceSync | null = null;

// At sign-in (auth.ts): the person's memberships are reconciled, at most every few minutes each.
export function reconcileAtSignIn(userId: string, subject: string) {
  active?.reconcileUser(userId, subject).catch((e) => console.error(`workspace sync at sign-in: ${(e as Error).message}`));
}

const one = async (q: Q, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows[0] as Row | undefined;
const auditRow = (q: Q, action: string, target: string, details: unknown) =>
  q.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, NULL, $2, $3, $4)`, [randomUUID(), action, target, JSON.stringify(details)]);
const OPEN = `accepted_at IS NULL AND revoked_at IS NULL AND created_at > now() - interval '${WORKSPACE_INVITE_DAYS} days'`;

export class WorkspaceSync {
  private readonly lastUserSync = new Map<string, number>();
  static USER_SYNC_MS = 5 * 60_000;

  constructor(
    readonly store: Store,
    readonly dir: OrgDirectory,
    private readonly services: OffboardServices = {},
    { register = true }: { register?: boolean } = {},
  ) {
    if (register) active = this;
  }

  private get db() {
    return this.store.db;
  }

  private async workspaceOf(q: Q, orgId: string, lock = false) {
    return (await one(
      q,
      `SELECT id::text AS id, name, org_sync, org_missing_at, archived_at FROM ${T}.workspaces WHERE external_org_id = $1${lock ? " FOR UPDATE" : ""}`,
      [orgId],
    )) as Ws | undefined;
  }

  private static synced = (w: Ws) => w.org_sync === "done" && !w.org_missing_at && !w.archived_at;

  private async userOf(q: Q, subject: string) {
    return (await one(q, `SELECT id::text AS id, email FROM ${T}.users WHERE clerk_user_id = $1`, [subject])) as { id: string; email: string | null } | undefined;
  }

  // Revoked by a Mynt admin: their Mynt address, or any address the provider verified as theirs.
  private async blocked(q: Q, email: string | null, subject: string) {
    if (!(await one(q, `SELECT 1 FROM ${T}.signup_blocks LIMIT 1`))) return false;
    const emails = new Set([email?.toLowerCase(), ...(await this.dir.verifiedEmails(subject))].filter((e): e is string => Boolean(e)));
    for (const e of emails) if (await one(q, `SELECT 1 FROM ${T}.signup_blocks WHERE email = $1`, [e])) return true;
    return false;
  }

  async handle(e: OrgEvent): Promise<void> {
    switch (e.type) {
      case "org.changed":
        await this.syncOrg(e.orgId);
        return;
      case "membership.changed":
        await this.syncMembership(e.orgId, e.subject, undefined, e.source);
        return;
      case "invitation.accepted":
        await this.invitationAccepted(e.orgId, e.invitationId);
        return;
    }
  }

  // An organization, as the provider has it now: renamed, adopted if new, or (confirmed deleted) its workspace frozen.
  async syncOrg(orgId: string): Promise<Ws | null> {
    const org = await this.dir.getOrg(orgId);
    const ws = await this.workspaceOf(this.db, orgId);
    if (!org) {
      if (ws) await this.orgMissing(ws, orgId);
      return null;
    }
    if (!ws) return this.adoptOrg(org);
    if (WorkspaceSync.synced(ws) && org.name && org.name !== ws.name) {
      await this.db.query(`UPDATE ${T}.workspaces SET name = $2 WHERE id::text = $1`, [ws.id, org.name.slice(0, 200)]);
      await this.store.audit(null, "workspace_renamed_from_directory", ws.id, { name: org.name });
    }
    return ws;
  }

  // The provider confirmed the organization doesn't exist: the workspace is frozen as it is (nobody removed, nobody
  // new), for its owners to relink or archive; ops_status names it.
  private async orgMissing(ws: Ws, orgId: string) {
    if (!WorkspaceSync.synced(ws)) return false;
    const r = await one(this.db, `UPDATE ${T}.workspaces SET org_missing_at = now() WHERE id::text = $1 AND org_missing_at IS NULL AND archived_at IS NULL RETURNING id`, [ws.id]);
    if (r) await this.store.audit(null, "workspace_org_missing", ws.id, { org_id: orgId, next: "an owner relinks it (relink_workspace_org) or archives it (archive_workspace)" });
    return Boolean(r);
  }

  // An organization Mynt hasn't linked. One Mynt made (tagged with its workspace, whose making may still be finishing)
  // is linked to that workspace. One made in the provider (a person's first, at sign-in) becomes its creator's
  // workspace, owned by them only, if they're on Mynt and not revoked. Nobody's platform roles change.
  private async adoptOrg(org: Org): Promise<Ws | null> {
    if (org.workspace_id) {
      await this.db.query(`UPDATE ${T}.workspaces SET external_org_id = $2 WHERE id::text = $1 AND external_org_id IS NULL`, [org.workspace_id, org.id]);
      const ws = await this.workspaceOf(this.db, org.id);
      if (ws) return ws;
      // Made by this installation for a workspace that doesn't exist (or has another organization): its making failed
      // after the organization was made. Deleted once it's old enough not to be one still being made. Another
      // installation's are never touched.
      const ours = Boolean(org.instance_id && org.instance_id === this.dir.instanceId);
      if (ours && org.created_at !== null && Date.now() - org.created_at > ABANDONED_MS) {
        await this.dir.deleteOrg(org.id);
        await this.store.audit(null, "workspace_orphan_org_deleted", org.id, { workspace_id: org.workspace_id });
      }
      return null;
    }
    if (!org.created_by) return null;
    const creator = await this.userOf(this.db, org.created_by);
    if (!creator) return null; // not on Mynt (yet): theirs if they sign in to Mynt
    if (await this.blocked(this.db, creator.email, org.created_by)) {
      await this.store.audit(null, "workspace_member_refused", org.id, { user_id: creator.id, reason: "revoked from Mynt by an admin" });
      return null;
    }
    const id = randomUUID();
    await inTransaction(this.db, async (tx) => {
      const made = await tx.query(
        `INSERT INTO ${T}.workspaces (id, name, created_by, external_org_id, org_sync) VALUES ($1, $2, $3, $4, 'done') ON CONFLICT (external_org_id) DO NOTHING RETURNING id`,
        [id, (org.name || "Workspace").slice(0, 200), creator.id, org.id],
      );
      if (made.rows.length)
        await tx.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role, org_synced_at) VALUES ($1, $2, 'owner', now())`, [id, creator.id]);
    });
    const ws = await this.workspaceOf(this.db, org.id);
    if (ws?.id === id) await this.store.audit(null, "workspace_from_directory", id, { org_id: org.id, owner: creator.id });
    return ws ?? null;
  }

  // One person's place in one workspace, from the provider's current state (`known`: just listed by the caller; else
  // read now), under Mynt's rules (above). The workspace's row is locked meanwhile, so a Mynt tool changing the same
  // membership (which writes to the provider first) has finished. Returns what changed, or null.
  async syncMembership(orgId: string, subject: string, known?: OrgMembership | null, source?: OrgEventSource): Promise<string | null> {
    const ws = (await this.workspaceOf(this.db, orgId)) ?? (await this.syncOrg(orgId));
    if (!ws || !WorkspaceSync.synced(ws)) return null;
    // Run once the transaction is over: the provider's writes (then offboardings), in order.
    const after: (() => Promise<unknown>)[] = [];
    const via = source ? { via: "provider webhook", event: source } : { via: "reconcile" };
    const auditTx = (q: Q, action: string, target: string, details: Record<string, unknown>) => auditRow(q, action, target, { ...details, ...via });
    const outcome = await inTransaction(this.db, async (tx): Promise<string | null> => {
      const w = await this.workspaceOf(tx, orgId, true);
      if (!w || !WorkspaceSync.synced(w)) return null;
      const m = known !== undefined ? known : await this.dir.getMembership(orgId, subject);
      const user = await this.userOf(tx, subject);
      const current = user ? await workspaceRole(tx, w.id, user.id) : null;
      const forget = () => tx.query(`DELETE FROM ${T}.workspace_join_requests WHERE workspace_id::text = $1 AND subject = $2`, [w.id, subject]);

      if (!m) {
        // Not in the organization (the provider says so).
        await forget();
        if (!user || !current) return null;
        if (current === "owner") {
          after.push(() => this.dir.addMember(orgId, subject, "admin"));
          await auditTx(tx, "workspace_owner_restored", w.id, { user_id: user.id, reason: "ownership is Mynt's: an owner leaves with leave_workspace, or another owner removes them" });
          return "owner_restored";
        }
        const seen = (await one(tx, `SELECT org_synced_at FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id::text = $2`, [w.id, user.id]))?.org_synced_at;
        if (!seen) {
          // In Mynt only so far (from before organizations): added there, never taken out. Marked seen only once
          // the provider has them, so a failure here is retried, never taken for a removal.
          after.push(async () => {
            await this.dir.addMember(orgId, subject, orgRole(current));
            await this.db.query(`UPDATE ${T}.workspace_members SET org_synced_at = now() WHERE workspace_id::text = $1 AND user_id::text = $2`, [w.id, user.id]);
          });
          await auditTx(tx, "workspace_member_added_to_directory", w.id, { user_id: user.id, role: current });
          return "added_to_org";
        }
        await tx.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id::text = $2`, [w.id, user.id]);
        await auditTx(tx, "workspace_member_removed_by_directory", w.id, { user_id: user.id, role: current });
        after.push(() => offboard(this.store, this.services, w.id, user.id, null));
        return "removed";
      }

      if (await this.blocked(tx, user?.email ?? null, subject)) {
        after.push(() => this.dir.removeMember(orgId, subject));
        await forget();
        if (user && current) {
          await tx.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id::text = $2`, [w.id, user.id]);
          after.push(() => offboard(this.store, this.services, w.id, user.id, null));
        }
        await auditTx(tx, "workspace_member_refused", w.id, { user_id: user?.id ?? null, reason: "revoked from Mynt by an admin" });
        return "refused";
      }

      if (!user) {
        // Not on Mynt: a join request for the workspace's owners and admins; nobody gets onto Mynt this way. Kept a
        // member in the provider, so they can't manage the organization.
        let outcome: string | null = null;
        if (m.role === "admin") {
          after.push(() => this.dir.setMemberRole(orgId, subject, "member"));
          await auditTx(tx, "workspace_role_restored", w.id, { subject, role: "member", reason: "not on Mynt: a join request, kept a member of the organization" });
          outcome = "role_restored";
        }
        if (await one(tx, `SELECT 1 FROM ${T}.workspace_join_requests WHERE workspace_id::text = $1 AND subject = $2`, [w.id, subject])) return outcome;
        const email = (await this.dir.verifiedEmails(subject))[0] ?? null;
        await tx.query(`INSERT INTO ${T}.workspace_join_requests (workspace_id, subject, email) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [w.id, subject, email]);
        await auditTx(tx, "workspace_join_request", w.id, { email });
        return "join_request";
      }
      await forget();

      if (current) {
        await tx.query(`UPDATE ${T}.workspace_members SET org_synced_at = now() WHERE workspace_id::text = $1 AND user_id::text = $2 AND org_synced_at IS NULL`, [w.id, user.id]);
        if (current === "owner" && m.role !== "admin") {
          after.push(() => this.dir.setMemberRole(orgId, subject, "admin"));
          await auditTx(tx, "workspace_owner_restored", w.id, { user_id: user.id, reason: "ownership is Mynt's: owners are the organization's admins" });
          return "owner_restored";
        }
        if (current === "admin" && m.role === "member") {
          await tx.query(`UPDATE ${T}.workspace_members SET role = 'member' WHERE workspace_id::text = $1 AND user_id::text = $2`, [w.id, user.id]);
          await auditTx(tx, "workspace_member_synced", w.id, { user_id: user.id, from: "admin", role: "member" });
          after.push(() => offboard(this.store, this.services, w.id, user.id, null, "demotion"));
          return "demoted";
        }
        if (current === "member" && m.role === "admin") {
          after.push(() => this.dir.setMemberRole(orgId, subject, "member"));
          await auditTx(tx, "workspace_role_restored", w.id, { user_id: user.id, role: "member", reason: "workspace roles are raised in Mynt (change_member_role)" });
          return "role_restored";
        }
        return null;
      }

      // Joining. A Mynt invite whose own invitation the provider reported accepted, to an address it verified as
      // theirs, goes through Mynt's acceptance rules (the role it names; a developer invite's developer role).
      const accepted = (await tx.query(
        `SELECT id::text AS id, email FROM ${T}.workspace_invites WHERE workspace_id::text = $1 AND external_accepted_at IS NOT NULL AND ${OPEN} ORDER BY created_at`,
        [w.id],
      )).rows as { id: string; email: string }[];
      if (accepted.length) {
        const emails = new Set(await this.dir.verifiedEmails(subject));
        for (const a of accepted.filter((x) => emails.has(x.email))) {
          const inv = await openInvite(tx, a.id);
          if (!inv) continue;
          const r = await acceptInvite(tx, inv, user, m.role);
          if ("set_org_role" in r && r.set_org_role) {
            const role = r.set_org_role;
            after.push(() => this.dir.setMemberRole(orgId, subject, role));
          }
          if ("void" in r) {
            await auditTx(tx, "void_workspace_invite", w.id, { invite_id: a.id, reason: "its sender can no longer invite to that role" });
            continue;
          }
          return "frozen" in r ? null : "accepted";
        }
      }
      // Otherwise (an invitation made in the provider, or a Mynt invite that no longer stands): a member, nothing more.
      await tx.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role, org_synced_at) VALUES ($1, $2, 'member', now()) ON CONFLICT DO NOTHING`, [w.id, user.id]);
      if (m.role === "admin") after.push(() => this.dir.setMemberRole(orgId, subject, "member"));
      await auditTx(tx, "workspace_member_synced", w.id, { user_id: user.id, role: "member" });
      return "joined";
    });
    for (const f of after) await f();
    return outcome;
  }

  // The provider says an invitation was accepted. Only a Mynt invite's own invitation counts (its id and the invite's
  // id must match both ways, so an invitation made in the provider can't claim a Mynt invite by its metadata); then
  // the person whose verified address it was joins through Mynt's acceptance rules.
  async invitationAccepted(orgId: string, invitationId: string) {
    const inv = await this.dir.getInvitation(orgId, invitationId);
    if (!inv || inv.status !== "accepted") return;
    const myntId = inv.metadata.mynt_invite_id;
    if (typeof myntId !== "string") return; // made in the provider: the membership is a plain join
    const r = await one(
      this.db,
      `UPDATE ${T}.workspace_invites SET external_accepted_at = COALESCE(external_accepted_at, now()) WHERE id::text = $1 AND external_invitation_id = $2 RETURNING id`,
      [myntId, invitationId],
    );
    if (!r) return;
    const subject = await this.dir.userByEmail(inv.email);
    if (subject) await this.syncMembership(orgId, subject);
  }

  // One person's memberships, as the provider has them now (at sign-in, at most every USER_SYNC_MS): each of theirs,
  // and each Mynt membership the provider didn't list, confirmed one by one.
  async reconcileUser(userId: string, subject: string, force = false) {
    const last = this.lastUserSync.get(userId) ?? 0;
    if (!force && Date.now() - last < WorkspaceSync.USER_SYNC_MS) return;
    this.lastUserSync.set(userId, Date.now());
    if (this.lastUserSync.size > 10_000) this.lastUserSync.delete(this.lastUserSync.keys().next().value!);
    const seen = new Set<string>();
    for (const m of await this.dir.userMemberships(subject)) {
      seen.add(m.org.id);
      await this.syncMembership(m.org.id, subject, { subject, role: m.role });
    }
    const mine = (
      await this.db.query(
        `SELECT w.external_org_id AS org_id FROM ${T}.workspace_members m JOIN ${T}.workspaces w ON w.id = m.workspace_id
         WHERE m.user_id::text = $1 AND w.external_org_id IS NOT NULL AND w.org_sync = 'done' AND w.org_missing_at IS NULL AND w.archived_at IS NULL`,
        [userId],
      )
    ).rows as { org_id: string }[];
    for (const x of mine) if (!seen.has(x.org_id)) await this.syncMembership(x.org_id, subject);
  }

  // Everything: the backstop for a webhook that never came. It reads first and changes nothing until it has; each
  // organization and each member to take out is confirmed with the provider on its own; and if that's more than
  // RECONCILE_MAX_SHARE (or the provider lists no organizations at all), it stops and ops_status says why.
  async reconcileAll() {
    const db = this.db;
    await db.query(`DELETE FROM ${T}.org_webhook_events WHERE received_at < now() - interval '30 days'`);
    await db.query(`INSERT INTO ${T}.org_sync_status (id, last_run_at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET last_run_at = now()`);
    // Workspaces whose making crashed before their organization was linked, with no apps yet: cleared away (an
    // organization made for one is then an orphan, deleted below once it's as old). Ones with apps wait for
    // mynt clerk sync-workspaces.
    const abandoned = (
      await db.query(
        `SELECT id::text AS id FROM ${T}.workspaces w WHERE org_sync = 'creating' AND external_org_id IS NULL AND created_at < now() - make_interval(secs => $1::int)
           AND NOT EXISTS (SELECT 1 FROM ${T}.apps a WHERE a.workspace_id = w.id)`,
        [ABANDONED_MS / 1000],
      )
    ).rows as { id: string }[];
    for (const a of abandoned) {
      await dropNewWorkspace(db, a.id);
      await this.store.audit(null, "workspace_creation_abandoned", a.id, {});
    }
    const linked = (
      await db.query(
        `SELECT id::text AS id, external_org_id AS org_id FROM ${T}.workspaces
         WHERE external_org_id IS NOT NULL AND org_sync = 'done' AND org_missing_at IS NULL AND archived_at IS NULL ORDER BY created_at`,
      )
    ).rows as { id: string; org_id: string }[];
    const plan: { orgId: string; members: OrgMembership[]; removals: string[]; myntOnly: string[] }[] = [];
    const missing: string[] = [];
    let seenMembers = 0;
    for (const w of linked) {
      if (!(await this.dir.getOrg(w.org_id))) {
        missing.push(w.org_id);
        continue;
      }
      const members = await this.dir.listMemberships(w.org_id);
      const inOrg = new Set(members.map((m) => m.subject));
      const mynt = (
        await db.query(
          `SELECT u.clerk_user_id AS subject, m.org_synced_at FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id
           WHERE m.workspace_id::text = $1 AND u.clerk_user_id IS NOT NULL`,
          [w.id],
        )
      ).rows as { subject: string; org_synced_at: string | null }[];
      seenMembers += mynt.filter((x) => x.org_synced_at).length;
      const removals: string[] = [];
      const myntOnly: string[] = [];
      for (const x of mynt.filter((y) => !inOrg.has(y.subject))) {
        if (!x.org_synced_at) myntOnly.push(x.subject);
        else if (!(await this.dir.getMembership(w.org_id, x.subject))) removals.push(x.subject);
      }
      plan.push({ orgId: w.org_id, members, removals, myntOnly });
    }
    // Organizations made in the provider that Mynt hasn't seen (someone's first, at sign-in).
    const known = new Set(((await db.query(`SELECT external_org_id AS id FROM ${T}.workspaces WHERE external_org_id IS NOT NULL`)).rows as { id: string }[]).map((r) => r.id));
    const fresh: string[] = [];
    let listed = 0;
    for (let offset = 0; ; offset += 100) {
      const { orgs, total } = await this.dir.listOrgs(offset, 100);
      listed += orgs.length;
      for (const o of orgs) if (!known.has(o.id)) fresh.push(o.id);
      if (!orgs.length || offset + orgs.length >= total) break;
    }
    const removals = plan.reduce((n, p) => n + p.removals.length, 0);
    const halt =
      linked.length && !listed
        ? "the identity provider listed no organizations while Mynt has workspaces linked to some"
        : missing.length > Math.max(1, RECONCILE_MAX_SHARE * linked.length)
          ? `${missing.length} of ${linked.length} workspaces' organizations are gone in the identity provider`
          : removals > Math.max(1, RECONCILE_MAX_SHARE * seenMembers)
            ? `${removals} of ${seenMembers} workspace members would be taken out`
            : null;
    if (halt) {
      await db.query(`UPDATE ${T}.org_sync_status SET halted_at = now(), halted_reason = $1 WHERE id = 1`, [halt]);
      await this.store.audit(null, "workspace_reconcile_halted", "workspaces", { reason: halt });
      return { halted: halt, workspaces: linked.length, missing: missing.length, removals };
    }
    let fixed = 0;
    const count = (r: string | null) => void (r && fixed++);
    for (const p of plan) {
      for (const m of p.members) count(await this.syncMembership(p.orgId, m.subject, m));
      for (const s of [...p.removals, ...p.myntOnly]) count(await this.syncMembership(p.orgId, s, null));
    }
    for (const orgId of missing) {
      const ws = await this.workspaceOf(db, orgId);
      if (ws && (await this.orgMissing(ws, orgId))) fixed++;
    }
    for (const orgId of fresh) {
      if (!(await this.syncOrg(orgId))) continue;
      fixed++;
      for (const m of await this.dir.listMemberships(orgId)) count(await this.syncMembership(orgId, m.subject, m));
    }
    await db.query(`UPDATE ${T}.org_sync_status SET last_ok_at = now(), halted_at = NULL, halted_reason = NULL WHERE id = 1`);
    return { workspaces: linked.length, fixed, missing: missing.length, removed: removals, new_orgs: fresh.length };
  }

  // Workspaces from before organizations get one each, made for their owner and tagged with the workspace, and their
  // members (owners and admins as its admins). Each workspace is 'backfill' until all its members are in, so a rerun
  // resumes it, and reconciling leaves it alone meanwhile. Members who never signed in through the provider stay in
  // Mynt and are added at their first sign-in. Open invites become the provider's invitations, which email people,
  // only with sendInvites. A dry run unless apply; counts only.
  async backfill(apply: boolean, { sendInvites = false, redirectUrl = null }: { sendInvites?: boolean; redirectUrl?: string | null } = {}) {
    const db = this.db;
    const counts = {
      workspaces_to_link: 0,
      orgs_created: 0,
      resumed: 0,
      members_added: 0,
      members_not_signed_in: 0,
      without_owner_signed_in: 0,
      invitation_emails_would_send: 0,
      invitation_emails_sent: 0,
      failed: 0,
    };
    const rows = (
      await db.query(
        `SELECT id::text AS id, name, external_org_id FROM ${T}.workspaces WHERE archived_at IS NULL AND org_missing_at IS NULL AND (
           org_sync = 'backfill' OR (external_org_id IS NULL AND (org_sync IS NULL OR (org_sync = 'creating' AND created_at < now() - interval '1 hour'))))
         ORDER BY created_at`,
      )
    ).rows as { id: string; name: string; external_org_id: string | null }[];
    counts.workspaces_to_link = rows.length;
    for (const ws of rows) {
      const members = (
        await db.query(
          `SELECT m.user_id::text AS user_id, m.role, u.clerk_user_id AS subject, m.org_synced_at FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id
           WHERE m.workspace_id::text = $1 ORDER BY (m.role = 'owner') DESC, m.joined_at`,
          [ws.id],
        )
      ).rows as { user_id: string; role: string; subject: string | null; org_synced_at: string | null }[];
      const owner = members.find((m) => m.role === "owner" && m.subject);
      counts.members_not_signed_in += members.filter((m) => !m.subject).length;
      if (!ws.external_org_id && !owner) {
        counts.without_owner_signed_in++;
        continue;
      }
      const toAdd = members.filter((m) => m.subject && !m.org_synced_at && m !== owner);
      if (!apply) {
        counts.members_added += toAdd.length;
        continue;
      }
      try {
        let orgId = ws.external_org_id;
        if (!orgId) {
          await db.query(`UPDATE ${T}.workspaces SET org_sync = 'backfill' WHERE id::text = $1 AND external_org_id IS NULL`, [ws.id]);
          const org = await this.dir.createOrg(ws.name, owner!.subject!, ws.id);
          const set = await one(db, `UPDATE ${T}.workspaces SET external_org_id = $2 WHERE id::text = $1 AND external_org_id IS NULL RETURNING id`, [ws.id, org.id]);
          if (!set) {
            await this.dir.deleteOrg(org.id); // another run got there first
            continue;
          }
          await db.query(`UPDATE ${T}.workspace_members SET org_synced_at = now() WHERE workspace_id::text = $1 AND user_id::text = $2`, [ws.id, owner!.user_id]);
          orgId = org.id;
          counts.orgs_created++;
        } else counts.resumed++;
        for (const m of toAdd) {
          await this.dir.addMember(orgId, m.subject!, orgRole(m.role));
          await db.query(`UPDATE ${T}.workspace_members SET org_synced_at = now() WHERE workspace_id::text = $1 AND user_id::text = $2`, [ws.id, m.user_id]);
          counts.members_added++;
        }
        await db.query(`UPDATE ${T}.workspaces SET org_sync = 'done' WHERE id::text = $1`, [ws.id]);
        await this.store.audit(null, "workspace_org_backfilled", ws.id, { org_id: orgId });
      } catch (e) {
        counts.failed++; // left 'backfill': the next run resumes it
        console.error(`sync-workspaces: workspace ${ws.id}: ${(e as Error).message}`);
      }
    }
    // Open invites in workspaces that are (or are about to be) organizations, without the provider's invitation yet.
    const invites = (
      await db.query(
        `SELECT i.id::text AS id, i.email, i.role, i.mynt_role, w.external_org_id AS org_id, w.org_sync, u.clerk_user_id AS inviter
         FROM ${T}.workspace_invites i JOIN ${T}.workspaces w ON w.id = i.workspace_id LEFT JOIN ${T}.users u ON u.id = i.invited_by
         WHERE i.${OPEN.split(" AND ").join(" AND i.")} AND i.external_invitation_id IS NULL AND w.archived_at IS NULL AND w.org_missing_at IS NULL
           AND (w.org_sync = 'done' OR w.id::text = ANY($1))`,
        [rows.map((r) => r.id)],
      )
    ).rows as { id: string; email: string; role: string; mynt_role: string; org_id: string | null; org_sync: string | null; inviter: string | null }[];
    for (const i of invites) {
      if (!apply || !sendInvites || !i.org_id || i.org_sync !== "done") {
        counts.invitation_emails_would_send++;
        continue;
      }
      try {
        const sent = await this.dir.invite(i.org_id, {
          email: i.email,
          role: orgRole(i.role),
          inviter: i.inviter,
          metadata: { mynt_role: i.mynt_role === "consumer" ? "user" : "developer", mynt_workspace_role: i.role, mynt_invite_id: i.id },
          redirectUrl,
        });
        await db.query(`UPDATE ${T}.workspace_invites SET external_invitation_id = $2 WHERE id::text = $1`, [i.id, sent.id]);
        counts.invitation_emails_sent++;
      } catch (e) {
        counts.failed++;
        console.error(`sync-workspaces: invite ${i.id}: ${(e as Error).message}`);
      }
    }
    return counts;
  }
}
