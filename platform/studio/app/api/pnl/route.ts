import { fromPnl, GRANULARITIES, sumSeries, type Granularity } from "@/lib/pnl";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { NO_WORKSPACE, ownWorkspace, scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The dashboard's P&L: get_workspace_pnl for the selected workspace (the user's own one for
// Personal), ?granularity=month|week&periods=1..24, optionally for one app (?app=<id>) or a set of
// apps added up (?apps=<id>,<id>: the dashboard's stage filter; an empty set has nothing to show).
// `supported: false` until this Mynt has the tool; the rest of the dashboard works without it.
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
    if (!workspace) return json({ supported: true, unavailable: support.workspaces ? NO_WORKSPACE : "It comes with Mynt's workspaces." });
    const read = async (app?: string) => fromPnl(await callStudioTool(mynt, "get_workspace_pnl", { workspace_id: workspace, granularity, periods, ...(app ? { app_id: app } : {}) }));
    const id = (s: string) => /^[A-Za-z0-9_-]{1,100}$/.test(s);
    const app = url.searchParams.get("app")?.trim();
    if (app) return id(app) ? json({ supported: true, pnl: await read(app) }) : json({ supported: true, unavailable: "No such app" });
    if (url.searchParams.has("apps")) {
      const apps = [...new Set((url.searchParams.get("apps") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
      if (!apps.length) return json({ supported: true, unavailable: "No apps in this stage" });
      if (apps.length > 50 || !apps.every(id)) return json({ supported: true, unavailable: "Too many apps to add up here: pick one" });
      const each = await Promise.all(apps.map((a) => read(a)));
      return json({ supported: true, pnl: { ...each[0], series: sumSeries(each.map((p) => p.series)) } });
    }
    return json({ supported: true, pnl: await read() });
  });
}
