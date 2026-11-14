import { verifyWebhook } from "@clerk/backend/webhooks";
import { clerkAccountPortalUrl, frontendApiFromPublishableKey } from "./auth.js";
import type { Org, OrgDirectory, OrgEvent, OrgInvitation, OrgMembership, OrgRole } from "./org-directory.js";

// Clerk's organizations as Mynt's workspace directory (org-directory.ts), through Clerk's Backend API, and Clerk's
// webhooks (verified with Clerk's own verifyWebhook, a Svix/Standard Webhooks signature with its replay window)
// turned into Mynt's OrgEvents.

const roleIn = (r: unknown): OrgRole => (r === "org:admin" || r === "admin" ? "admin" : "member");
const roleOut = (r: OrgRole) => (r === "admin" ? "org:admin" : "org:member");

type Row = Record<string, unknown>;
const toOrg = (o: Row): Org => ({
  id: String(o.id),
  name: String(o.name ?? ""),
  created_by: (o.created_by as string | null | undefined) ?? null,
  workspace_id: (((o.private_metadata ?? {}) as Row).mynt_workspace_id as string | undefined) ?? null,
});
const toMembership = (m: Row): OrgMembership | null => {
  const u = (m.public_user_data ?? {}) as Row;
  return u.user_id ? { subject: String(u.user_id), role: roleIn(m.role) } : null;
};
const verified = (u: Row) =>
  ((u.email_addresses as Row[] | undefined) ?? [])
    .filter((e) => ((e.verification ?? {}) as Row).status === "verified")
    .map((e) => String(e.email_address).toLowerCase());
const status = (e: unknown) => (e as { status?: number }).status;
const PAGE = 100;

export class ClerkOrgDirectory implements OrgDirectory {
  private readonly api = "https://api.clerk.com/v1";
  private readonly portal: string | null;

  constructor(
    private readonly config: { secretKey: string; publishableKey: string; accountPortalUrl?: string },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    const user = clerkAccountPortalUrl(frontendApiFromPublishableKey(config.publishableKey), config.accountPortalUrl);
    this.portal = user ? user.replace(/\/user\/?$/, "/organization") : null;
  }

  // One Backend API call. Rate-limited (429): waited out (its Retry-After, else 1, 2, 4 s) and tried again, 4 times
  // in all.
  private async call(method: string, path: string, body?: unknown): Promise<Row> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetchFn(`${this.api}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.config.secretKey}`, "Content-Type": "application/json", "User-Agent": "mynt" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 429 && attempt < 4) {
        const after = Number(res.headers.get("retry-after"));
        await this.sleep(Math.min(30_000, Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** (attempt - 1)));
        continue;
      }
      const text = await res.text();
      let data: Row = {};
      try {
        data = text ? (JSON.parse(text) as Row) : {};
      } catch {
        data = {};
      }
      if (!res.ok) {
        const errors = (data.errors as { message?: string; long_message?: string; code?: string }[] | undefined) ?? [];
        throw Object.assign(new Error(errors[0]?.long_message ?? errors[0]?.message ?? `Clerk API ${res.status}`), { status: res.status, code: errors[0]?.code });
      }
      return data;
    }
  }

  // Null only for Clerk's 404 (it doesn't exist); any other failure throws, so it's never taken for "gone".
  private async maybe(path: string): Promise<Row | null> {
    try {
      return await this.call("GET", path);
    } catch (e) {
      if (status(e) === 404) return null;
      throw e;
    }
  }

  async createOrg(name: string, createdBy: string, workspaceId: string) {
    return toOrg(await this.call("POST", "/organizations", { name, created_by: createdBy, private_metadata: { mynt_workspace_id: workspaceId } }));
  }

  async getOrg(orgId: string) {
    const r = await this.maybe(`/organizations/${encodeURIComponent(orgId)}`);
    return r ? toOrg(r) : null;
  }

  async renameOrg(orgId: string, name: string) {
    await this.call("PATCH", `/organizations/${encodeURIComponent(orgId)}`, { name });
  }

  async deleteOrg(orgId: string) {
    try {
      await this.call("DELETE", `/organizations/${encodeURIComponent(orgId)}`);
    } catch (e) {
      if (status(e) !== 404) throw e; // already gone
    }
  }

  async listOrgs(offset: number, limit: number) {
    const r = await this.call("GET", `/organizations?limit=${limit}&offset=${offset}&order_by=%2Bcreated_at`);
    return { orgs: ((r.data as Row[] | undefined) ?? []).map(toOrg), total: Number(r.total_count ?? 0) };
  }

  async listMemberships(orgId: string) {
    const out: OrgMembership[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const r = await this.call("GET", `/organizations/${encodeURIComponent(orgId)}/memberships?limit=${PAGE}&offset=${offset}&order_by=%2Bcreated_at`);
      const page = (r.data as Row[] | undefined) ?? [];
      for (const m of page) {
        const x = toMembership(m);
        if (x) out.push(x);
      }
      if (page.length < PAGE) return out;
    }
  }

  async getMembership(orgId: string, subject: string) {
    const r = await this.call("GET", `/organizations/${encodeURIComponent(orgId)}/memberships?user_id=${encodeURIComponent(subject)}&limit=1`);
    const m = ((r.data as Row[] | undefined) ?? []).map(toMembership).find((x) => x?.subject === subject);
    return m ?? null;
  }

  async userMemberships(subject: string) {
    const out: { org: Org; role: OrgRole }[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const r = await this.call("GET", `/users/${encodeURIComponent(subject)}/organization_memberships?limit=${PAGE}&offset=${offset}`);
      const page = (r.data as Row[] | undefined) ?? [];
      for (const m of page) out.push({ org: toOrg((m.organization ?? {}) as Row), role: roleIn(m.role) });
      if (page.length < PAGE) return out;
    }
  }

  async verifiedEmails(subject: string) {
    const u = await this.maybe(`/users/${encodeURIComponent(subject)}`);
    return u ? verified(u) : [];
  }

  async userByEmail(email: string) {
    const r = await this.call("GET", `/users?email_address=${encodeURIComponent(email)}&limit=2`);
    const users = (Array.isArray(r) ? (r as unknown as Row[]) : ((r.data as Row[] | undefined) ?? [])).filter((u) => verified(u).includes(email.toLowerCase()));
    return users.length === 1 ? String(users[0].id) : null;
  }

  async addMember(orgId: string, subject: string, role: OrgRole) {
    try {
      await this.call("POST", `/organizations/${encodeURIComponent(orgId)}/memberships`, { user_id: subject, role: roleOut(role) });
    } catch (e) {
      // Already a member: make the role agree instead.
      if (status(e) !== 422 && (e as { code?: string }).code !== "already_a_member_in_organization") throw e;
      await this.setMemberRole(orgId, subject, role);
    }
  }

  async setMemberRole(orgId: string, subject: string, role: OrgRole) {
    await this.call("PATCH", `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(subject)}`, { role: roleOut(role) });
  }

  async removeMember(orgId: string, subject: string) {
    try {
      await this.call("DELETE", `/organizations/${encodeURIComponent(orgId)}/memberships/${encodeURIComponent(subject)}`);
    } catch (e) {
      if (status(e) !== 404) throw e; // not a member any more
    }
  }

  async invite(orgId: string, o: { email: string; role: OrgRole; inviter: string | null; metadata: Record<string, unknown>; redirectUrl?: string | null }) {
    const r = await this.call("POST", `/organizations/${encodeURIComponent(orgId)}/invitations`, {
      email_address: o.email,
      role: roleOut(o.role),
      ...(o.inviter ? { inviter_user_id: o.inviter } : {}),
      public_metadata: o.metadata,
      ...(o.redirectUrl ? { redirect_url: o.redirectUrl } : {}),
    });
    return { id: String(r.id) };
  }

  async getInvitation(orgId: string, invitationId: string): Promise<OrgInvitation | null> {
    const r = await this.maybe(`/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`);
    return r
      ? { id: String(r.id), status: String(r.status ?? ""), email: String(r.email_address ?? "").toLowerCase(), metadata: (r.public_metadata as Record<string, unknown> | undefined) ?? {} }
      : null;
  }

  async revokeInvitation(orgId: string, invitationId: string, by: string | null) {
    try {
      await this.call("POST", `/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, by ? { requesting_user_id: by } : {});
    } catch (e) {
      if (status(e) !== 404 && status(e) !== 422) throw e; // accepted or gone already
    }
  }

  manageUrl() {
    return this.portal;
  }
}

// Clerk's webhook, verified, as Mynt's event: its id (for once-only handling) and what it's about, or null for an
// event Mynt doesn't follow. Only ids are taken from it: Mynt reads the current state back from Clerk. Throws on a
// bad or stale signature.
export async function clerkWebhookEvent(request: Request, signingSecret: string): Promise<{ id: string; type: string; event: OrgEvent | null }> {
  const id = request.headers.get("svix-id") ?? request.headers.get("webhook-id") ?? "";
  const evt = (await verifyWebhook(request, { signingSecret })) as unknown as { type: string; data: Row };
  if (!id) throw new Error("no event id");
  const d = evt.data ?? {};
  const orgId = (o: unknown) => (((o ?? {}) as Row).id as string | undefined) ?? null;
  let event: OrgEvent | null = null;
  switch (evt.type) {
    case "organization.created":
    case "organization.updated":
    case "organization.deleted":
      if (d.id) event = { type: "org.changed", orgId: String(d.id) };
      break;
    case "organizationMembership.created":
    case "organizationMembership.updated":
    case "organizationMembership.deleted": {
      const m = toMembership(d);
      const o = orgId(d.organization);
      if (m && o) event = { type: "membership.changed", orgId: o, subject: m.subject };
      break;
    }
    case "organizationInvitation.accepted":
      if (d.organization_id && d.id) event = { type: "invitation.accepted", orgId: String(d.organization_id), invitationId: String(d.id) };
      break;
  }
  return { id, type: evt.type, event };
}
