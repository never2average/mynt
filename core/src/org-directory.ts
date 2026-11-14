// The organizations of the identity provider: Mynt's workspaces are one-to-one with them, and the provider is the
// source of truth for who belongs to which (workspace-sync.ts keeps Mynt in step). Brand-neutral: the Clerk
// implementation is clerk-orgs.ts. A person is the provider's id for them (users.clerk_user_id for Clerk).

export type OrgRole = "admin" | "member"; // the provider has no owner: Mynt keeps who owns a workspace

export interface OrgMembership {
  subject: string;
  role: OrgRole;
  email: string | null;
}

export interface Org {
  id: string;
  name: string;
  created_by: string | null;
}

export interface OrgDirectory {
  createOrg(name: string, createdBy: string): Promise<Org>;
  renameOrg(orgId: string, name: string): Promise<void>;
  deleteOrg(orgId: string): Promise<void>;
  // Every organization, a page at a time.
  listOrgs(offset: number, limit: number): Promise<{ orgs: Org[]; total: number }>;
  listMemberships(orgId: string): Promise<OrgMembership[]>;
  userMemberships(subject: string): Promise<{ org: Org; role: OrgRole }[]>;
  addMember(orgId: string, subject: string, role: OrgRole): Promise<void>;
  setMemberRole(orgId: string, subject: string, role: OrgRole): Promise<void>;
  removeMember(orgId: string, subject: string): Promise<void>;
  // An invitation the invitee accepts themselves; metadata travels with it (Mynt's role for a newcomer).
  invite(orgId: string, o: { email: string; role: OrgRole; inviter: string | null; metadata: Record<string, unknown>; redirectUrl?: string | null }): Promise<{ id: string }>;
  revokeInvitation(orgId: string, invitationId: string, by: string | null): Promise<void>;
  // Where members manage the organization themselves, if the provider has such a page.
  manageUrl(): string | null;
}

// A change the provider reports (its webhook, or what reconciling finds), in Mynt's terms.
export type OrgEvent =
  | { type: "org.upserted"; org: Org }
  | { type: "org.deleted"; orgId: string }
  | { type: "membership.upserted"; org: Org; member: OrgMembership }
  | { type: "membership.deleted"; orgId: string; subject: string }
  | { type: "invitation.accepted"; orgId: string; email: string; metadata: Record<string, unknown> };
