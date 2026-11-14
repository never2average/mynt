import { fromAttention } from "@/lib/attention";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { NOT_SCOPED, ownWorkspace, scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The dashboard's Needs attention card: get_workspace_attention for the selected workspace (the
// user's own one for Personal). `supported: false` until this Mynt has the tool.
export async function GET(req: Request) {
  return asDeveloper("loading what needs attention", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "get_workspace_attention")) return json({ supported: false });
    const support = workspaceSupport(tools);
    const scope = await scopeFor(mynt, req, support);
    if (scope.unavailable !== undefined) return json({ supported: true, unavailable: scope.unavailable });
    const workspace = scope.workspace ?? (await ownWorkspace(mynt, support));
    if (!workspace) return json({ supported: true, unavailable: support.workspaces ? NOT_SCOPED : "It comes with Mynt's workspaces." });
    return json({ supported: true, items: fromAttention(await callStudioTool(mynt, "get_workspace_attention", { workspace_id: workspace })) });
  });
}
