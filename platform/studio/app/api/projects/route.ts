import type { NextRequest } from "next/server";
import { toProjects } from "@/lib/projects";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { supportOf, workspaceOf } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The signed-in developer's projects in the selected workspace (?workspace=<id>): their Mynt
// apps, each with its builds, previews and stage. Read from Mynt on every load; the studio keeps
// no copy. Before Mynt has workspaces, every app is in the implicit Personal workspace.
export async function GET(req: NextRequest) {
  const workspace = workspaceOf(req);
  return asDeveloper("loading projects", async (mynt) => {
    const support = await supportOf(mynt);
    const scope = workspace && support.appsByWorkspace ? { workspace_id: workspace } : {};
    const [apps, builds] = await Promise.all([callStudioTool(mynt, "list_my_apps", scope), callStudioTool(mynt, "list_builds")]);
    return json({ projects: toProjects(apps, builds) });
  });
}
