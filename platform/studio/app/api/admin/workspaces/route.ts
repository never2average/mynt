import { workspacesFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Workspaces: every workspace on Mynt (list_all_workspaces), never the one picked in the sidebar. The newest
// 500 are loaded; the tab searches and pages them, and says when there are more.
export async function GET() {
  return asAdmin("reading every workspace", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_all_workspaces"))) return json(UNSUPPORTED);
    const page = workspacesFrom(await callAdminTool(mynt, session, "list_all_workspaces", { limit: 500 }));
    return page ? json({ workspaces: page.rows, total: page.total }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
