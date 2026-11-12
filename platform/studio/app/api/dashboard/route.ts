import { fromAppsAndBuilds, fromDashboardTool } from "@/lib/dashboard";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The dashboard: Mynt's get_developer_dashboard where it offers one; until then the user's apps
// and builds, with the money figures not measured.
export async function GET() {
  return asDeveloper("loading the dashboard", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (tools.some((t) => t.name === "get_developer_dashboard")) {
      return json({ dashboard: fromDashboardTool(await callStudioTool(mynt, "get_developer_dashboard", { days: 30 })) });
    }
    const [apps, builds] = await Promise.all([callStudioTool(mynt, "list_my_apps"), callStudioTool(mynt, "list_builds")]);
    return json({ dashboard: fromAppsAndBuilds(apps, builds) });
  });
}
