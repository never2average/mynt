import { workspaceDetailFrom } from "@/lib/admin";
import { hasTools, isUuid, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

// Admin → Workspaces → one workspace: its members, apps, invitations and activity (admin_get_workspace).
export async function GET(_req: Request, { params }: Params) {
  const { workspaceId } = await params;
  if (!isUuid(workspaceId)) return json({ error: "bad_request" }, 400);
  return asAdmin("reading a workspace", async (mynt, session) => {
    if (!(await hasTools(mynt, "admin_get_workspace"))) return json(UNSUPPORTED);
    const detail = workspaceDetailFrom(await callAdminTool(mynt, session, "admin_get_workspace", { workspace_id: workspaceId }));
    return detail ? json({ detail }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
