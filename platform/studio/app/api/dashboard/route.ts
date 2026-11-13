import type { NextRequest } from "next/server";
import { fromAppsAndBuilds, fromDashboardTool } from "@/lib/dashboard";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { workspaceOf, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The dashboard for the selected workspace (?workspace=<id>): Mynt's get_developer_dashboard
// where it offers one (scoped to the workspace where it can be); until then the workspace's
// apps and builds, with the money figures not measured.
export async function GET(req: NextRequest) {
  const workspace = workspaceOf(req);
  return asDeveloper("loading the dashboard", async (mynt) => {
    const tools = await listMyntTools(mynt);
    const support = workspaceSupport(tools);
    if (tools.some((t) => t.name === "get_developer_dashboard")) {
      const scope = workspace && support.dashboardByWorkspace ? { workspace_id: workspace } : {};
      return json({ dashboard: fromDashboardTool(await callStudioTool(mynt, "get_developer_dashboard", { days: 30, ...scope })) });
    }
    const scope = workspace && support.appsByWorkspace ? { workspace_id: workspace } : {};
    const [apps, builds] = await Promise.all([callStudioTool(mynt, "list_my_apps", scope), callStudioTool(mynt, "list_builds")]);
    return json({ dashboard: fromAppsAndBuilds(apps, builds) });
  });
}
