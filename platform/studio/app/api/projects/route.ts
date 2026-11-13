import type { NextRequest } from "next/server";
import { toProjects } from "@/lib/projects";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { NOT_SCOPED, resolveWorkspace, workspaceOf, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The signed-in developer's projects in the selected workspace (?workspace=<id>): their Mynt
// apps, each with its builds, previews and stage. Read from Mynt on every load; the studio keeps
// no copy. Before Mynt has workspaces, every app is in the implicit Personal workspace. A shared
// workspace this Mynt can't scope apps to shows none, never the user's unscoped apps.
export async function GET(req: NextRequest) {
  const requested = workspaceOf(req);
  return asDeveloper("loading projects", async (mynt) => {
    const support = workspaceSupport(await listMyntTools(mynt));
    const workspace = await resolveWorkspace(mynt, requested, support);
    if (workspace && !support.appsByWorkspace) return json({ projects: [], unavailable: NOT_SCOPED });
    const apps = workspace ? { workspace_id: workspace } : {};
    const builds = workspace && support.buildsByWorkspace ? { workspace_id: workspace } : {};
    const [appList, buildList] = await Promise.all([callStudioTool(mynt, "list_my_apps", apps), callStudioTool(mynt, "list_builds", builds)]);
    return json({ projects: toProjects(appList, buildList) });
  });
}
