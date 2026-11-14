import { randomUUID } from "node:crypto";
import { inTransaction } from "./db.js";
import type { Org, OrgDirectory, OrgEvent, OrgMembership } from "./org-directory.js";
import type { Store } from "./store.js";
import { offboard, promotable, workspaceRole, type OffboardServices } from "./workspaces.js";

// Keeps Mynt's workspaces in step with the identity provider's organizations, which decide who belongs where. Every
// change arrives as an OrgEvent (the provider's webhook, or what reconciling finds) and is applied idempotently, with
// Mynt's own rules:
// - A workspace is one organization. The person who created it owns it (the provider has no owner role; ownership is
//   Mynt's, and stays with Mynt's tools); the provider's admins are its admins and its members its members.
// - Someone new to Mynt joining through a membership is let onto Mynt as a developer, or a user (consumer) when the
//   invitation said so, never more; someone a Mynt admin revoked is removed from the organization again (audited).
// - A membership deleted runs Mynt's offboarding (workspaces.ts), with its recorded, retried steps; an organization
//   deleted archives its workspace and offboards everyone.

const T = "financial_products";
type Row = Record<string, unknown>;

let active: WorkspaceSync | null = null;

// At sign-in (auth.ts): the person's memberships are reconciled, at most every few minutes each.
export function reconcileAtSignIn(userId: string, subject: string) {
  active?.reconcileUser(userId, subject).catch((e) => console.error(`workspace sync at sign-in: ${(e as Error).message}`));
}

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

  private one = async (sql: string, params: unknown[]) => (await this.store.db.query(sql, params)).rows[0] as Row | undefined;

  private async workspaceOf(orgId: string) {
    return (await this.one(`SELECT id::text AS id, name, created_by::text AS created_by, archived_at FROM ${T}.workspaces WHERE external_org_id = $1`, [orgId])) as
      | { id: string; name: string; created_by: string | null; archived_at: string | null }
      | undefined;
  }

  private async userOf(subject: string) {
    return (await this.one(`SELECT id::text AS id, email, roles FROM ${T}.users WHERE clerk_user_id = $1`, [subject])) as { id: string; email: string | null; roles: string[] } | undefined;
  }

  async handle(e: OrgEvent): Promise<void> {
    switch (e.type) {
      case "org.upserted":
        await this.upsertOrg(e.org);
        return;
      case "org.deleted":
        await this.deleteOrg(e.orgId);
        return;
      case "membership.upserted":
        await this.applyMembership(e.org, e.member);
        return;
      case "membership.deleted":
        await this.removeMembership(e.orgId, e.subject);
        return;
      case "invitation.accepted":
        await this.invitationAccepted(e.orgId, e.email, e.metadata);
        return;
    }
  }

  // The workspace for an organization, made if it's new (one created in the provider's own dashboard, say).
  async upsertOrg(org: Org) {
    const ws = await this.workspaceOf(org.id);
    if (ws) {
      if (org.name && ws.name !== org.name && !ws.archived_at) {
        await this.store.db.query(`UPDATE ${T}.workspaces SET name = $2 WHERE id::text = $1`, [ws.id, org.name.slice(0, 200)]);
        await this.store.audit(null, "workspace_renamed_from_directory", ws.id, { name: org.name });
      }
      return ws;
    }
    const creator = org.created_by ? await this.userOf(org.created_by) : undefined;
    const id = randomUUID();
    await inTransaction(this.store.db, async (tx) => {
      const made = await tx.query(
        `INSERT INTO ${T}.workspaces (id, name, created_by, external_org_id) VALUES ($1, $2, $3, $4) ON CONFLICT (external_org_id) DO NOTHING RETURNING id`,
        [id, (org.name || "Workspace").slice(0, 200), creator?.id ?? null, org.id],
      );
      if (made.rows.length && creator) await tx.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`, [id, creator.id]);
    });
    const now = (await this.workspaceOf(org.id))!;
    if (now.id === id) await this.store.audit(null, "workspace_from_directory", id, { org_id: org.id, owner: creator?.id ?? null });
    return now;
  }

  async applyMembership(org: Org, m: OrgMembership) {
    const ws = await this.upsertOrg(org);
    if (ws.archived_at) return;
    const user = await this.userOf(m.subject);
    const email = (m.email ?? user?.email ?? null)?.toLowerCase() ?? null;
    // Someone a Mynt admin removed from Mynt doesn't come back through an organization.
    if (email && (await this.store.isSignupBlocked(email))) {
      await this.dir.removeMember(org.id, m.subject);
      if (user) await this.store.db.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id = $2`, [ws.id, user.id]);
      await this.store.audit(null, "workspace_member_refused", ws.id, { org_id: org.id, reason: "revoked from Mynt by an admin" });
      return;
    }
    // What a Mynt invitation said (workspace role and Mynt role), if this came from one.
    const invite = email
      ? ((await this.one(
          `SELECT id::text AS id, role, mynt_role, created_at FROM ${T}.workspace_invites WHERE workspace_id::text = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          [ws.id, email],
        )) as { id: string; role: string; mynt_role: string; created_at: string } | undefined)
      : undefined;
    const myntRole = invite?.mynt_role === "consumer" ? "consumer" : "developer";
    if (!user) {
      // New to Mynt: let in, with that role and never more, unless an admin revoked them (checked above). They join the
      // workspace when they first sign in (reconcileUser).
      if (email && !(await this.store.getInvite(email))) {
        await this.store.db.query(`INSERT INTO ${T}.invites (email, roles, admitted_via, created_at, updated_at) VALUES ($1, ARRAY[$2::text], 'org_membership', now(), now()) ON CONFLICT (email) DO NOTHING`, [
          email,
          myntRole,
        ]);
        await this.store.audit(null, "invite_via_org_membership", email, { roles: [myntRole], workspace_id: ws.id });
      }
      return;
    }
    // Joining as a developer makes a consumer-only account a developer, never a firm's or an admin's (workspaces.ts).
    if (myntRole === "developer" && !user.roles.some((r) => r === "developer" || r === "innovator") && promotable(user.roles)) {
      const mi = email ? await this.one(`SELECT roles, admin_roles_at FROM ${T}.invites WHERE email = $1`, [email]) : undefined;
      const adminLater = mi?.admin_roles_at && invite && new Date(mi.admin_roles_at as string) > new Date(invite.created_at);
      if (!adminLater && promotable((mi?.roles as string[] | undefined) ?? [])) {
        await this.store.db.query(`UPDATE ${T}.users SET roles = array_append(roles, 'developer') WHERE id::text = $1 AND NOT ('developer' = ANY(roles))`, [user.id]);
        if (email) await this.store.db.query(`UPDATE ${T}.invites SET roles = array_append(roles, 'developer'), updated_at = now(), revision = revision + 1 WHERE email = $1 AND NOT ('developer' = ANY(roles))`, [email]);
        await this.store.audit(null, "developer_via_org_membership", ws.id, { user_id: user.id });
      }
    }
    // The creator owns it; an owner stays one (ownership is Mynt's); otherwise the provider's role.
    const current = await workspaceRole(this.store.db, ws.id, user.id);
    const role = ws.created_by === user.id || current === "owner" || invite?.role === "owner" ? "owner" : m.role;
    const changed = await this.store.db.query(
      `INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE workspace_members.role <> EXCLUDED.role RETURNING role`,
      [ws.id, user.id, role],
    );
    if (invite) await this.store.db.query(`UPDATE ${T}.workspace_invites SET accepted_at = now(), accepted_by = $2 WHERE id::text = $1 AND accepted_at IS NULL`, [invite.id, user.id]);
    if (changed.rows.length) await this.store.audit(null, "workspace_member_synced", ws.id, { user_id: user.id, role, from: current });
  }

  async removeMembership(orgId: string, subject: string) {
    const ws = await this.workspaceOf(orgId);
    const user = await this.userOf(subject);
    if (!ws || !user) return;
    const was = await workspaceRole(this.store.db, ws.id, user.id);
    if (!was) return;
    await this.store.db.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND user_id = $2`, [ws.id, user.id]);
    // The provider removed the last owner: its longest-standing admin owns it now.
    if (was === "owner" && !(await this.one(`SELECT 1 FROM ${T}.workspace_members WHERE workspace_id::text = $1 AND role = 'owner'`, [ws.id]))) {
      const next = await this.one(`SELECT user_id::text AS user_id FROM ${T}.workspace_members WHERE workspace_id::text = $1 ORDER BY (role = 'admin') DESC, joined_at LIMIT 1`, [ws.id]);
      if (next) {
        await this.store.db.query(`UPDATE ${T}.workspace_members SET role = 'owner' WHERE workspace_id::text = $1 AND user_id::text = $2`, [ws.id, next.user_id]);
        await this.store.audit(null, "workspace_owner_from_directory", ws.id, { user_id: next.user_id });
      }
    }
    await this.store.audit(null, "workspace_member_removed_by_directory", ws.id, { user_id: user.id, role: was });
    await offboard(this.store, this.services, ws.id, user.id, null);
  }

  async deleteOrg(orgId: string) {
    const ws = await this.workspaceOf(orgId);
    if (!ws || ws.archived_at) return;
    await this.store.db.query(`UPDATE ${T}.workspaces SET archived_at = now() WHERE id::text = $1`, [ws.id]);
    const members = (await this.store.db.query(`SELECT user_id::text AS user_id FROM ${T}.workspace_members WHERE workspace_id::text = $1`, [ws.id])).rows as { user_id: string }[];
    await this.store.db.query(`DELETE FROM ${T}.workspace_members WHERE workspace_id::text = $1`, [ws.id]);
    await this.store.db.query(`UPDATE ${T}.workspace_invites SET revoked_at = now() WHERE workspace_id::text = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [ws.id]);
    await this.store.audit(null, "workspace_archived", ws.id, { org_id: orgId, members: members.length });
    for (const m of members) await offboard(this.store, this.services, ws.id, m.user_id, null);
  }

  // The invitation said which Mynt role a newcomer gets: a user (consumer) admission stays that.
  async invitationAccepted(orgId: string, email: string, metadata: Record<string, unknown>) {
    if (metadata.mynt_role !== "user" && metadata.mynt_role !== "consumer") return;
    await this.store.db.query(
      `UPDATE ${T}.invites SET roles = '{consumer}' WHERE email = $1 AND admitted_via = 'org_membership' AND revision = 0
         AND NOT EXISTS (SELECT 1 FROM ${T}.users u WHERE u.email = $1)`,
      [email],
    );
    void orgId;
  }

  // One person's memberships, as the provider has them now (at sign-in, at most every USER_SYNC_MS).
  async reconcileUser(userId: string, subject: string, force = false) {
    const last = this.lastUserSync.get(userId) ?? 0;
    if (!force && Date.now() - last < WorkspaceSync.USER_SYNC_MS) return;
    this.lastUserSync.set(userId, Date.now());
    if (this.lastUserSync.size > 10_000) this.lastUserSync.delete(this.lastUserSync.keys().next().value!);
    const user = await this.userOf(subject);
    const memberships = await this.dir.userMemberships(subject);
    for (const m of memberships) await this.applyMembership(m.org, { subject, role: m.role, email: user?.email ?? null });
    const inOrgs = new Set(memberships.map((m) => m.org.id));
    const mine = (
      await this.store.db.query(
        `SELECT w.external_org_id AS org_id FROM ${T}.workspace_members m JOIN ${T}.workspaces w ON w.id = m.workspace_id WHERE m.user_id::text = $1 AND w.external_org_id IS NOT NULL`,
        [userId],
      )
    ).rows as { org_id: string }[];
    for (const x of mine) if (!inOrgs.has(x.org_id)) await this.removeMembership(x.org_id, subject);
  }

  // Everything, from the provider: the backstop for a webhook that never came. Deletions apply only after a full,
  // successful listing.
  async reconcileAll() {
    const seen = new Set<string>();
    let fixed = 0;
    for (let offset = 0; ; offset += 100) {
      const { orgs, total } = await this.dir.listOrgs(offset, 100);
      for (const org of orgs) {
        seen.add(org.id);
        const ws = await this.upsertOrg(org);
        if (ws.archived_at) continue;
        const members = await this.dir.listMemberships(org.id);
        for (const m of members) await this.applyMembership(org, m);
        const subjects = new Set(members.map((m) => m.subject));
        const mynt = (
          await this.store.db.query(
            `SELECT u.clerk_user_id AS subject FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id WHERE m.workspace_id::text = $1 AND u.clerk_user_id IS NOT NULL`,
            [ws.id],
          )
        ).rows as { subject: string }[];
        for (const x of mynt)
          if (!subjects.has(x.subject)) {
            await this.removeMembership(org.id, x.subject);
            fixed++;
          }
      }
      if (!orgs.length || offset + orgs.length >= total) break;
    }
    const gone = (await this.store.db.query(`SELECT external_org_id AS org_id FROM ${T}.workspaces WHERE external_org_id IS NOT NULL AND archived_at IS NULL`, [])).rows as {
      org_id: string;
    }[];
    for (const g of gone)
      if (!seen.has(g.org_id)) {
        await this.deleteOrg(g.org_id);
        fixed++;
      }
    return { orgs: seen.size, fixed };
  }

  // Workspaces from before organizations: an organization each, with its members and open invites. Dry run by default.
  async backfill(apply: boolean, redirectUrl: string | null = null) {
    const counts = { workspaces_without_org: 0, orgs_created: 0, members_added: 0, members_not_signed_in: 0, without_owner_signed_in: 0, invites_converted: 0 };
    const rows = (await this.store.db.query(`SELECT id::text AS id, name FROM ${T}.workspaces WHERE external_org_id IS NULL AND archived_at IS NULL ORDER BY created_at`, [])).rows as {
      id: string;
      name: string;
    }[];
    counts.workspaces_without_org = rows.length;
    for (const ws of rows) {
      const members = (
        await this.store.db.query(
          `SELECT m.user_id::text AS user_id, m.role, u.clerk_user_id AS subject FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id
           WHERE m.workspace_id::text = $1 ORDER BY (m.role = 'owner') DESC, m.joined_at`,
          [ws.id],
        )
      ).rows as { user_id: string; role: string; subject: string | null }[];
      const owner = members.find((m) => m.role === "owner" && m.subject);
      if (!owner) {
        counts.without_owner_signed_in++;
        continue;
      }
      const others = members.filter((m) => m !== owner);
      counts.members_not_signed_in += others.filter((m) => !m.subject).length;
      const invites = (
        await this.store.db.query(
          `SELECT id::text AS id, email, role, mynt_role, invited_by::text AS invited_by FROM ${T}.workspace_invites
           WHERE workspace_id::text = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND external_invitation_id IS NULL`,
          [ws.id],
        )
      ).rows as { id: string; email: string; role: string; mynt_role: string; invited_by: string | null }[];
      if (!apply) {
        counts.members_added += others.filter((m) => m.subject).length;
        counts.invites_converted += invites.length;
        continue;
      }
      const org = await this.dir.createOrg(ws.name, owner.subject!);
      const set = await this.store.db.query(`UPDATE ${T}.workspaces SET external_org_id = $2 WHERE id::text = $1 AND external_org_id IS NULL RETURNING id`, [ws.id, org.id]);
      if (!set.rows.length) {
        await this.dir.deleteOrg(org.id); // another run got there first
        continue;
      }
      counts.orgs_created++;
      for (const m of others.filter((x) => x.subject)) {
        await this.dir.addMember(org.id, m.subject!, m.role === "member" ? "member" : "admin");
        counts.members_added++;
      }
      for (const i of invites) {
        const inviter = i.invited_by ? ((await this.one(`SELECT clerk_user_id FROM ${T}.users WHERE id::text = $1`, [i.invited_by]))?.clerk_user_id as string | null) ?? null : null;
        const r = await this.dir.invite(org.id, {
          email: i.email,
          role: i.role === "member" ? "member" : "admin",
          inviter,
          metadata: { mynt_role: i.mynt_role === "consumer" ? "user" : "developer", mynt_workspace_role: i.role },
          redirectUrl,
        });
        await this.store.db.query(`UPDATE ${T}.workspace_invites SET external_invitation_id = $2 WHERE id::text = $1`, [i.id, r.id]);
        counts.invites_converted++;
      }
      await this.store.audit(null, "workspace_org_backfilled", ws.id, { org_id: org.id });
    }
    return counts;
  }
}
