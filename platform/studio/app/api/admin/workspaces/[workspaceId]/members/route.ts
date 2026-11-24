import { z } from "zod";
import { workspaceDetailFrom } from "@/lib/admin";
import { hasTools, isUuid, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { WORKSPACE_MEMBER_ROLES } from "@/lib/admin-members";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS, type AdminTool } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

// Admin → Workspaces → one workspace → Members: Invite member, and each row's Change role and Remove (or, for an
// invitation not yet accepted, withdraw it). Each is Mynt's admin tool for it (admin_invite_workspace_member,
// admin_change_workspace_member_role, admin_remove_workspace_member, admin_revoke_workspace_invite), which follows the
// workspace's own rules exactly as its owners' tools do: the identity provider's organization is invited, changed or
// left the same way, a workspace never loses its last owner, and someone removed loses its apps and builds at once.
const uuid = z.string().uuid();
const role = z.enum(WORKSPACE_MEMBER_ROLES);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), email: ADMIN_TOOLS.invite_user.shape.email, role }).strict(),
  z.object({ action: z.literal("change_role"), user_id: uuid, role }).strict(),
  z.object({ action: z.literal("remove"), user_id: uuid, confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("revoke_invite"), invite_id: uuid }).strict(),
]);

const TOOL: Record<z.infer<typeof Body>["action"], AdminTool> = {
  invite: "admin_invite_workspace_member",
  change_role: "admin_change_workspace_member_role",
  remove: "admin_remove_workspace_member",
  revoke_invite: "admin_revoke_workspace_invite",
};

export async function POST(req: Request, { params }: Params) {
  const { workspaceId } = await params;
  if (!isUuid(workspaceId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  const body = w.body;
  return asAdmin("changing a workspace's members", async (mynt, session) => {
    const tool = TOOL[body.action];
    if (!(await hasTools(mynt, tool))) return json(UNSUPPORTED);
    if (body.action === "invite") {
      const r = (await callAdminTool(mynt, session, tool, { workspace_id: workspaceId, email: body.email, role: body.role })) as { note?: string } | null;
      return json({ ok: true, message: r?.note ? `Invited. ${r.note.charAt(0).toUpperCase()}${r.note.slice(1)}.` : `Invited ${body.email}.` });
    }
    if (body.action === "change_role") {
      await callAdminTool(mynt, session, tool, { workspace_id: workspaceId, user_id: body.user_id, role: body.role });
      return json({ ok: true, message: `Their role is now ${body.role}.` });
    }
    if (body.action === "remove") {
      await callAdminTool(mynt, session, tool, { workspace_id: workspaceId, user_id: body.user_id });
      return json({ ok: true, message: "Removed from the workspace. They lost its apps and builds at once." });
    }
    // The invitation must be this workspace's: the tool takes only its id.
    const detail = workspaceDetailFrom(await callAdminTool(mynt, session, "admin_get_workspace", { workspace_id: workspaceId }));
    if (!detail?.invitations.some((i) => i.id === body.invite_id && i.status === "open")) return json({ error: "not_found", message: "This workspace has no open invitation with that id." }, 404);
    await callAdminTool(mynt, session, tool, { invite_id: body.invite_id });
    return json({ ok: true, message: "Invitation withdrawn." });
  });
}
