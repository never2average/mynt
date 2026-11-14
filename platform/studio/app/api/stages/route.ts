import { readinessFor } from "@/lib/promotion-server";
import { promotionSupport } from "@/lib/promotions";
import { toProjects } from "@/lib/projects";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { NOT_SCOPED, scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The dashboard's Apps by stage: the selected workspace's apps by stage (as the sidebar's
// folders show them) and, where Mynt has promotion checks, each app's readiness for its next
// stage. `checks: false` until Mynt has them.
export async function GET(req: Request) {
  return asDeveloper("loading apps by stage", async (mynt) => {
    const tools = await listMyntTools(mynt);
    const support = workspaceSupport(tools);
    const scoped = await scopeFor(mynt, req, support);
    if (scoped.unavailable !== undefined) return json({ supported: true, unavailable: scoped.unavailable });
    const { workspace } = scoped;
    if (workspace && !support.appsByWorkspace) return json({ supported: true, unavailable: NOT_SCOPED });
    const apps = workspace ? { workspace_id: workspace } : {};
    const builds = workspace && support.buildsByWorkspace ? { workspace_id: workspace } : {};
    const [appList, buildList] = await Promise.all([callStudioTool(mynt, "list_my_apps", apps), callStudioTool(mynt, "list_builds", builds)]);
    const projects = toProjects(appList, buildList).map((p) => ({ id: p.id, name: p.name, stage: p.stage }));
    const ps = promotionSupport(tools);
    if (!ps.checks) return json({ supported: true, checks: false, apps: projects.map((p) => ({ ...p, readiness: null })) });
    const readiness = await readinessFor(mynt, projects);
    return json({ supported: true, checks: true, apps: projects.map((p) => ({ ...p, readiness: readiness.get(p.id) ?? null })) });
  });
}
