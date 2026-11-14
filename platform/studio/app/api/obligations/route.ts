import { fromObligations } from "@/lib/audit-classes";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { NOT_SCOPED, ownWorkspace, scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The Audits page's Licence obligations tab: get_workspace_obligations for the selected
// workspace (the user's own one for Personal). `supported: false` until this Mynt has the tool.
export async function GET(req: Request) {
  return asDeveloper("loading licence obligations", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "get_workspace_obligations")) return json({ supported: false });
    const support = workspaceSupport(tools);
    const scope = await scopeFor(mynt, req, support);
    if (scope.unavailable !== undefined) return json({ supported: true, unavailable: scope.unavailable });
    const workspace = scope.workspace ?? (await ownWorkspace(mynt, support));
    if (!workspace) return json({ supported: true, unavailable: support.workspaces ? NOT_SCOPED : "It comes with Mynt's workspaces." });
    return json({ supported: true, obligations: fromObligations(await callStudioTool(mynt, "get_workspace_obligations", { workspace_id: workspace })) });
  });
}
