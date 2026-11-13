import type { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { loadWorkspaces, supportOf } from "@/lib/workspace-server";
import { canManageMembers, fromListMembers, WORKSPACE_ID, type Workspace } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

const UNSUPPORTED = "Workspace members come with Mynt's next update. For now, your Personal workspace is yours alone.";
const NOT_ALLOWED = "Only the workspace's owners and admins can manage its members.";

const id = z.string().trim().min(1).max(200);
const role = z.enum(["admin", "member"]);
const Invite = z.object({ email: z.string().trim().toLowerCase().email("Enter an email address.").max(320), role }).strict();
const ChangeRole = z.object({ user_id: id, role }).strict();
const Remove = z.union([z.object({ user_id: id }).strict(), z.object({ invite_id: id }).strict()]);

// The workspace, if it's the user's, with their role in it (Mynt checks again on every call).
async function theirWorkspace(mynt: Client, workspaceId: string): Promise<{ workspace?: Workspace; supported: boolean }> {
  const support = await supportOf(mynt);
  if (!support.workspaces) return { supported: false };
  return { supported: true, workspace: (await loadWorkspaces(mynt, support)).find((w) => w.id === workspaceId) };
}

// GET: the members and pending invites, and whether the user may manage them.
export async function GET(_req: Request, { params }: Params) {
  const { workspaceId } = await params;
  if (!WORKSPACE_ID.test(workspaceId)) return json({ error: "bad_request" }, 400);
  return asDeveloper("loading workspace members", async (mynt) => {
    const { workspace, supported } = await theirWorkspace(mynt, workspaceId);
    if (!supported) return json({ supported: false, message: UNSUPPORTED, members: [], invites: [], canManage: false });
    if (!workspace) return json({ error: "not_found", message: "That workspace isn't one of yours." }, 404);
    const { members, invites } = fromListMembers(await callStudioTool(mynt, "list_workspace_members", { workspace_id: workspaceId }));
    return json({ supported: true, role: workspace.role, canManage: canManageMembers(workspace.role), members, invites });
  });
}

// A change to the members: only owners and admins, checked here before anything reaches Mynt
// (which checks again).
async function manage(
  req: Request,
  params: Params["params"],
  what: string,
  act: (mynt: Client, workspaceId: string, body: unknown) => Promise<NextResponse | void>,
) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { workspaceId } = await params;
  if (!WORKSPACE_ID.test(workspaceId)) return json({ error: "bad_request" }, 400);
  const body = await req.json().catch(() => null);
  return asDeveloper(what, async (mynt) => {
    const { workspace, supported } = await theirWorkspace(mynt, workspaceId);
    if (!supported) return json({ error: "unsupported", message: UNSUPPORTED }, 501);
    if (!workspace) return json({ error: "not_found", message: "That workspace isn't one of yours." }, 404);
    if (!canManageMembers(workspace.role)) return json({ error: "not_allowed", message: NOT_ALLOWED }, 403);
    return (await act(mynt, workspaceId, body)) ?? json({ ok: true });
  });
}

const invalid = (message: string) => json({ error: "bad_request", message }, 400);

// POST: invite someone by email with a role.
export async function POST(req: Request, { params }: Params) {
  return manage(req, params, "inviting to a workspace", async (mynt, workspace_id, body) => {
    const p = Invite.safeParse(body);
    if (!p.success) return invalid(p.error.issues[0]?.message ?? "Check the email and role.");
    await callStudioTool(mynt, "invite_to_workspace", { workspace_id, ...p.data });
  });
}

// PATCH: change a member's role.
export async function PATCH(req: Request, { params }: Params) {
  return manage(req, params, "changing a member's role", async (mynt, workspace_id, body) => {
    const p = ChangeRole.safeParse(body);
    if (!p.success) return invalid("Pick a role.");
    await callStudioTool(mynt, "change_member_role", { workspace_id, ...p.data });
  });
}

// DELETE: remove a member ({ user_id }) or revoke an invite ({ invite_id }).
export async function DELETE(req: Request, { params }: Params) {
  return manage(req, params, "removing from a workspace", async (mynt, workspace_id, body) => {
    const p = Remove.safeParse(body);
    if (!p.success) return invalid("Say whom to remove.");
    if ("user_id" in p.data) await callStudioTool(mynt, "remove_workspace_member", { workspace_id, user_id: p.data.user_id });
    else await callStudioTool(mynt, "revoke_workspace_invite", { workspace_id, invite_id: p.data.invite_id });
  });
}
