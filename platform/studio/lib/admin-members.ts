// The platform admin's people, where they belong: each firm's and each workspace's Members tab (there is no People
// section). Pure, for the routes, the views and the tests.
// - A firm's members have the roles of what the firm is (licence provider, vendor, liquidity provider, innovator);
//   Mynt's admin role is never given here, and changing a member's roles for one firm never drops any other role.
// - A workspace's members are owner, admin or member; its open invitations are people invited, not yet joined.
import type { Firm, FirmType, WorkspaceDetail } from "./admin"
import { ROLE_LABELS, type RoleChange } from "./people"

// ---- firms ----

export const FIRM_MEMBER_ROLES = ["developer", "vendor", "license_provider", "liquidity_provider"] as const
export type FirmMemberRole = (typeof FIRM_MEMBER_ROLES)[number]
export const FIRM_MEMBER_ROLE_LABELS: Record<FirmMemberRole, string> = {
  developer: "Innovator (builds products and apps)",
  vendor: "Vendor (offers standard services)",
  license_provider: "Licence provider (sponsors products)",
  liquidity_provider: "Liquidity provider (puts capital into pools)",
}
const ROLE_OF_TYPE: Record<FirmType, FirmMemberRole> = { builder: "developer", vendor: "vendor", license_provider: "license_provider", liquidity_provider: "liquidity_provider" }

/** The roles a firm's members can be given: what the firm is, by its members' roles; any of them for a firm with nobody in it yet. */
export function firmRoleOptions(firm: Pick<Firm, "types">): { value: FirmMemberRole; label: string }[] {
  const of = firm.types.map((t) => ROLE_OF_TYPE[t])
  return (of.length ? FIRM_MEMBER_ROLES.filter((r) => of.includes(r)) : [...FIRM_MEMBER_ROLES]).map((value) => ({ value, label: FIRM_MEMBER_ROLE_LABELS[value] }))
}

// Every role that is a firm's (innovator is developer's other name); anything else (admin, consumer) isn't touched.
const FIRM_ROLE_SET = new Set<string>([...FIRM_MEMBER_ROLES, "innovator"])
const canon = (r: string) => (r === "innovator" ? "developer" : r)

/** Change role at a firm: its roles become exactly `picked`; every role that isn't a firm's (Mynt admin, user) stays. */
export function firmRoleChange(had: string[], picked: string[]): RoleChange {
  const hadFirm = [...new Set(had.filter((r) => FIRM_ROLE_SET.has(r)).map(canon))]
  const want = [...new Set(picked.map(canon))]
  const kept = had.filter((r) => !FIRM_ROLE_SET.has(r))
  return {
    roles: [...new Set([...kept, ...want])],
    already: had,
    adding: want.filter((r) => !hadFirm.includes(r)),
    removing: hadFirm.filter((r) => !want.includes(r)),
  }
}

/** A firm member's roles in words, the firm's ones first. */
export const firmRolesWords = (roles: string[]) => [...new Set(roles.map(canon))].map((r) => ROLE_LABELS[r] ?? r).join(", ") || "—"

// ---- workspaces ----

export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "member"] as const
export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number]
export const WORKSPACE_ROLE_LABELS: Record<WorkspaceMemberRole, string> = { owner: "Owner", admin: "Admin", member: "Member" }
export const WORKSPACE_ROLE_HELP: Record<WorkspaceMemberRole, string> = {
  owner: "Owner (runs the workspace, its members and its apps)",
  admin: "Admin (manages members and apps)",
  member: "Member (builds the workspace's apps)",
}

export type MemberStatus = "signed_in" | "invited"
export const MEMBER_STATUS_LABELS: Record<MemberStatus, string> = { signed_in: "Signed in", invited: "Invited, not yet signed in" }

/** One row of a workspace's Members tab: a member, or an open invitation (Remove withdraws it). */
export type WorkspaceMemberRow =
  | { kind: "member"; key: string; userId: string; name: string | null; email: string | null; role: string; status: "signed_in"; since: string | null }
  | { kind: "invite"; key: string; inviteId: string; name: null; email: string; role: string; status: "invited"; since: string | null }

export function workspaceMemberRows(detail: Pick<WorkspaceDetail, "members" | "invitations">): WorkspaceMemberRow[] {
  return [
    ...detail.members.map((m): WorkspaceMemberRow => ({ kind: "member", key: `m:${m.userId}`, userId: m.userId, name: m.name, email: m.email, role: m.role, status: "signed_in", since: m.joinedAt })),
    ...detail.invitations
      .filter((i) => i.status === "open")
      .map((i): WorkspaceMemberRow => ({ kind: "invite", key: `i:${i.id}`, inviteId: i.id, name: null, email: i.email, role: i.role, status: "invited", since: i.createdAt })),
  ]
}

// ---- Invite person (the Overview's header): who joins what ----

export type JoinTarget = { kind: "firm" | "workspace"; id: string; name: string; hint: string }

/** The firms and workspaces a person can join, for the Joins picker, filtered by what's typed. */
export function joinTargets(firms: Pick<Firm, "id" | "name" | "types">[], workspaces: { id: string; name: string; personal: boolean; status: string }[], query = ""): JoinTarget[] {
  const all: JoinTarget[] = [
    ...firms.map((f): JoinTarget => ({ kind: "firm", id: f.id, name: f.name, hint: "Firm" })),
    ...workspaces.filter((w) => !w.personal && w.status === "active").map((w): JoinTarget => ({ kind: "workspace", id: w.id, name: w.name, hint: "Workspace" })),
  ]
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? all.filter((t) => words.every((w) => `${t.name} ${t.hint}`.toLowerCase().includes(w))) : all
}
