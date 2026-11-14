import { verifyWebhook } from "@clerk/backend/webhooks";
import { clerkAccountPortalUrl, frontendApiFromPublishableKey } from "./auth.js";
import type { Org, OrgDirectory, OrgEvent, OrgMembership, OrgRole } from "./org-directory.js";

// Clerk's organizations as Mynt's workspace directory (org-directory.ts), through Clerk's Backend API, and Clerk's
// webhooks (verified with Clerk's own verifyWebhook, a Svix/Standard Webhooks signature with its replay window)
// turned into Mynt's OrgEvents.

const roleIn = (r: unknown): OrgRole => (r === "org:admin" || r === "admin" ? "admin" : "member");
const roleOut = (r: OrgRole) => (r === "admin" ? "org:admin" : "org:member");

type Row = Record<string, unknown>;
const toOrg = (o: Row): Org => ({ id: String(o.id), name: String(o.name ?? ""), created_by: (o.created_by as string | null | undefined) ?? null });
const toMembership = (m: Row): OrgMembership | null => {
  const u = (m.public_user_data ?? {}) as Row;
  return u.user_id ? { subject: String(u.user_id), role: roleIn(m.role), email: (u.identifier as string | undefined)?.toLowerCase() ?? null } : null;
};

export class ClerkOrgDirectory implements OrgDirectory {
  private readonly api = "https://api.clerk.com/v1";
  private readonly portal: string | null;

  constructor(
    private readonly config: { secretKey: string; publishableKey: string; accountPortalUrl?: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    const user = clerkAccountPortalUrl(frontendApiFromPublishableKey(config.publishableKey), config.accountPortalUrl);
    this.portal = user ? user.replace(/\/user\/?$/, "/organization") : null;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Row> {
    const res = await this.fetchFn(`${this.api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.config.secretKey}`, "Content-Type": "application/json", "User-Agent": "mynt" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as Row) : {};
    if (!res.ok) {
      const errors = (data.errors as { message?: string; long_message?: string; code?: string }[] | undefined) ?? [];
      throw Object.assign(new Error(errors[0]?.long_message ?? errors[0]?.message ?? `Clerk API ${res.status}`), { status: res.status, code: errors[0]?.code });
    }
    return data;
  }

  async createOrg(name: string, createdBy: string) {
    return toOrg(await this.call("POST", "/organizations", { name, created_by: createdBy }));
  }

  async renameOrg(orgId: string, name: string) {
    await this.call("PATCH", `/organizations/${encodeURIComponent(orgId)}`, { name });
  }

  async deleteOrg(orgId: string) {
    try {
      await this.call("DELETE", `/organizations/${encodeURIComponent(orgId)}`);
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e; // already gone
    }
  }

  async listOrgs(offset: number, limit: number) {
    const r = await this.call("GET", `/organizations?limit=${limit}&offset=${offset}`);
    return { orgs: ((r.data as Row[] | undefined) ?? []).map(toOrg), total: Number(r.total_count ?? 0) };
  }

  async listMemberships(orgId: string) {
    const out: OrgMembership[] = [];
    for (let offset = 0; ; offset += 100) {
      const r = await this.call("GET", `/organizations/${encodeURIComponent(orgId)}/memberships?limit=100&offset=${offset}`);
      const page = (r.data as Row[] | undefined) ?? [];
      for (const m of page) {
        const x = toMembership(m);
        if (x) out.push(x);
      }
      if (page.length < 100) return out;
    }
  }

  async userMemberships(subject: string) {
    const r = await this.call("GET", `/users/${encodeURIComponent(subject)}/organization_memberships?limit=100`);
    return ((r.data as Row[] | undefined) ?? []).map((m) => ({ org: toOrg((m.organization ?? {}) as Row), role: roleIn(m.role) }));
  }

  async addMember(orgId: string, subject: string, role: OrgRole) {
    try {
      await this.call("POST", `/organizations/${encodeURIComponent(orgId)}/memberships`, { user_id: subject, role: roleOut(role) });
    } catch (e) {
      // Already a member: make the role agree instead.
      if ((e as { status?: number }).status !== 422 && (e as { code?: string }).code !== "already_a_member_in_organization") throw e;
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
      if ((e as { status?: number }).status !== 404) throw e; // not a member any more
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

  async revokeInvitation(orgId: string, invitationId: string, by: string | null) {
    try {
      await this.call("POST", `/organizations/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}/revoke`, by ? { requesting_user_id: by } : {});
    } catch (e) {
      if ((e as { status?: number }).status !== 404 && (e as { status?: number }).status !== 422) throw e; // accepted or gone already
    }
  }

  manageUrl() {
    return this.portal;
  }
}

// Clerk's webhook, verified, as Mynt's event: its id (for once-only handling) and what it says, or null for an event
// Mynt doesn't follow. Throws on a bad or stale signature.
export async function clerkWebhookEvent(request: Request, signingSecret: string): Promise<{ id: string; event: OrgEvent | null }> {
  const id = request.headers.get("svix-id") ?? request.headers.get("webhook-id") ?? "";
  const evt = (await verifyWebhook(request, { signingSecret })) as unknown as { type: string; data: Row };
  if (!id) throw new Error("no event id");
  const d = evt.data ?? {};
  const org = (o: unknown) => toOrg((o ?? {}) as Row);
  switch (evt.type) {
    case "organization.created":
    case "organization.updated":
      return { id, event: { type: "org.upserted", org: org(d) } };
    case "organization.deleted":
      return { id, event: d.id ? { type: "org.deleted", orgId: String(d.id) } : null };
    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const m = toMembership(d);
      return { id, event: m ? { type: "membership.upserted", org: org(d.organization), member: m } : null };
    }
    case "organizationMembership.deleted": {
      const m = toMembership(d);
      const o = (d.organization ?? {}) as Row;
      return { id, event: m && o.id ? { type: "membership.deleted", orgId: String(o.id), subject: m.subject } : null };
    }
    case "organizationInvitation.accepted":
      return {
        id,
        event: d.organization_id && d.email_address
          ? { type: "invitation.accepted", orgId: String(d.organization_id), email: String(d.email_address).toLowerCase(), metadata: (d.public_metadata as Record<string, unknown>) ?? {} }
          : null,
      };
    default:
      return { id, event: null };
  }
}
