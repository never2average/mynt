import type { NextRequest } from "next/server";
import { fromAppsAndBuilds, fromDashboardTool } from "@/lib/dashboard";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { NOT_SCOPED, resolveWorkspace, workspaceOf, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The dashboard for the selected workspace (?workspace=<id>): Mynt's get_developer_dashboard
// where it offers one; until then the workspace's apps and builds, with the money figures not
// measured. A shared workspace this Mynt can't scope the figures to says so, never showing the
// user's unscoped figures under the workspace's name.
export async function GET(req: NextRequest) {
  const requested = workspaceOf(req);
  return asDeveloper("loading the dashboard", async (mynt) => {
    const tools = await listMyntTools(mynt);
    const support = workspaceSupport(tools);
    const workspace = await resolveWorkspace(mynt, requested, support);
    const scope = workspace ? { workspace_id: workspace } : {};
    if (tools.some((t) => t.name === "get_developer_dashboard")) {
      if (workspace && !support.dashboardByWorkspace) return json({ dashboard: null, unavailable: NOT_SCOPED });
      return json({ dashboard: fromDashboardTool(await callStudioTool(mynt, "get_developer_dashboard", { days: 30, ...scope })) });
    }
    if (workspace && !support.appsByWorkspace) return json({ dashboard: null, unavailable: NOT_SCOPED });
    const builds = workspace && support.buildsByWorkspace ? scope : {};
    const [apps, buildList] = await Promise.all([callStudioTool(mynt, "list_my_apps", scope), callStudioTool(mynt, "list_builds", builds)]);
    return json({ dashboard: fromAppsAndBuilds(apps, buildList) });
  });
}
