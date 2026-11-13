// Invitations to other people's workspaces (list_my_invitations). Joining is always explicit:
// the user sees who invited them, to which workspace, with what role and what that grants on
// Mynt, and accepts or declines. Nothing joins a workspace on its own. Pure, for the routes, the
// banner, the switcher and the tests.

import { ROLES, WORKSPACE_ID, type Role } from "./workspaces";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export type Invitation = {
  id: string;
  workspaceId: string | null;
  workspaceName: string;
  inviter: string | null; // name, else email
  role: Role;
  grants: string[]; // what accepting grants on Mynt
  expiresAt: string | null;
};

export const INVITATION_ID = /^[A-Za-z0-9_-]{1,200}$/;

// What each role grants, for when Mynt doesn't spell it out.
export const ROLE_GRANTS: Record<Role, string[]> = {
  owner: ["Full control of the workspace, its apps, members and billing"],
  admin: [
    "See and build the workspace's apps, and start builds that count against its budget",
    "See its coverage, licences and audit trail",
    "Invite and remove members, and change their roles",
  ],
  member: ["See and build the workspace's apps, and start builds that count against its budget", "See its coverage, licences and audit trail"],
};

export function fromInvitations(reply: unknown): Invitation[] {
  const list = Array.isArray(reply) ? reply : isObj(reply) && Array.isArray(reply.invitations) ? reply.invitations : [];
  return list.filter(isObj).flatMap((i): Invitation[] => {
    const id = str(i.id) ?? str(i.invite_id);
    if (!id || !INVITATION_ID.test(id)) return [];
    const ws = isObj(i.workspace) ? i.workspace : {};
    const by = isObj(i.invited_by) ? i.invited_by : isObj(i.inviter) ? i.inviter : {};
    const workspaceId = str(ws.id) ?? str(i.workspace_id);
    const role = ROLES.includes(i.role as Role) ? (i.role as Role) : "member";
    const grants = Array.isArray(i.grants) ? i.grants.flatMap((g) => (str(g) ? [str(g)!] : [])) : [];
    return [
      {
        id,
        workspaceId: workspaceId && WORKSPACE_ID.test(workspaceId) ? workspaceId : null,
        workspaceName: str(ws.name) ?? str(i.workspace_name) ?? "A workspace",
        inviter: str(by.name) ?? str(by.email) ?? (typeof i.invited_by === "string" ? str(i.invited_by) : null),
        role,
        grants: grants.length ? grants : ROLE_GRANTS[role],
        expiresAt: str(i.expires_at),
      },
    ];
  });
}
