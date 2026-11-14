import { fromPnl, GRANULARITIES, type Granularity } from "@/lib/pnl";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { NOT_SCOPED, ownWorkspace, scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The dashboard's P&L chart and statement: get_workspace_pnl for the selected workspace (the
// user's own one for Personal), ?granularity=month|week&periods=1..24. `supported: false` until
// this Mynt has the tool; the rest of the dashboard works without it.
export async function GET(req: Request) {
  return asDeveloper("loading the P&L", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "get_workspace_pnl")) return json({ supported: false });
    const url = new URL(req.url);
    const g = url.searchParams.get("granularity");
    const granularity: Granularity = (GRANULARITIES as readonly string[]).includes(g ?? "") ? (g as Granularity) : "month";
    const n = Number(url.searchParams.get("periods"));
    const periods = Number.isInteger(n) && n >= 1 && n <= 24 ? n : 6;
    const support = workspaceSupport(tools);
    const scope = await scopeFor(mynt, req, support);
    if (scope.unavailable !== undefined) return json({ supported: true, unavailable: scope.unavailable });
    const workspace = scope.workspace ?? (await ownWorkspace(mynt, support));
    if (!workspace) return json({ supported: true, unavailable: support.workspaces ? NOT_SCOPED : "It comes with Mynt's workspaces." });
    return json({ supported: true, pnl: fromPnl(await callStudioTool(mynt, "get_workspace_pnl", { workspace_id: workspace, granularity, periods })) });
  });
}
