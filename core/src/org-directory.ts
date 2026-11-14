// The organizations of the identity provider: Mynt's workspaces are one-to-one with them. The provider decides who is
// in a workspace's organization; Mynt alone decides platform roles (developer, user, ...) and who owns a workspace
// (workspace-sync.ts applies the provider's changes under those rules). Brand-neutral: the Clerk implementation is
// clerk-orgs.ts. A person is the provider's id for them (users.clerk_user_id for Clerk).

export type OrgRole = "admin" | "member"; // the provider has no owner: Mynt keeps who owns a workspace

export interface OrgMembership {
  subject: string;
  role: OrgRole;
}

export interface Org {
  id: string;
  name: string;
  created_by: string | null;
  // The Mynt workspace an organization was made for, from the organization's private metadata (null: made in the
  // provider itself).
  workspace_id: string | null;
}

export interface OrgInvitation {
  id: string;
  status: string; // pending, accepted, revoked, expired
  email: string;
  metadata: Record<string, unknown>;
}

export interface OrgDirectory {
  // Made for a Mynt workspace (tagged with its id, so the provider's own event about it finds that workspace).
  createOrg(name: string, createdBy: string, workspaceId: string): Promise<Org>;
  getOrg(orgId: string): Promise<Org | null>; // null only when the provider says it doesn't exist
  renameOrg(orgId: string, name: string): Promise<void>;
  deleteOrg(orgId: string): Promise<void>;
  // Every organization, oldest first, a page at a time.
  listOrgs(offset: number, limit: number): Promise<{ orgs: Org[]; total: number }>;
  listMemberships(orgId: string): Promise<OrgMembership[]>; // every page
  getMembership(orgId: string, subject: string): Promise<OrgMembership | null>; // null only when they're not in it
  userMemberships(subject: string): Promise<{ org: Org; role: OrgRole }[]>; // every page
  verifiedEmails(subject: string): Promise<string[]>;
  // The one person whose verified address this is, if any.
  userByEmail(email: string): Promise<string | null>;
  addMember(orgId: string, subject: string, role: OrgRole): Promise<void>;
  setMemberRole(orgId: string, subject: string, role: OrgRole): Promise<void>;
  removeMember(orgId: string, subject: string): Promise<void>;
  // An invitation the invitee accepts with the provider (or in Mynt); metadata travels with it (Mynt's invite id).
  invite(orgId: string, o: { email: string; role: OrgRole; inviter: string | null; metadata: Record<string, unknown>; redirectUrl?: string | null }): Promise<{ id: string }>;
  getInvitation(orgId: string, invitationId: string): Promise<OrgInvitation | null>;
  revokeInvitation(orgId: string, invitationId: string, by: string | null): Promise<void>;
  // Where members manage the organization themselves, if the provider has such a page.
  manageUrl(): string | null;
}

// What the provider says changed. Only which organization, membership or invitation: Mynt reads its current state
// back from the provider before acting, so an event delivered late, twice or out of order can't undo a newer change.
export type OrgEvent =
  | { type: "org.changed"; orgId: string }
  | { type: "membership.changed"; orgId: string; subject: string }
  | { type: "invitation.accepted"; orgId: string; invitationId: string };
