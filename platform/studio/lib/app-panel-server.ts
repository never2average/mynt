import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  appLicences,
  buildsFrom,
  eventsFrom,
  fromPnl,
  fromProductSdk,
  NOT_YET,
  SECURITY_CHECKS,
  type AppActivity,
  type AppLicences,
  type AppPnl,
  type AppSdk,
  type AppSecurity,
  type InfoTab,
  type NotYet,
} from "./app-panel";
import { fromPromotionChecks, nextStage, type PromotionTarget } from "./promotions";
import { callStudioTool, isAuthError, listMyntTools } from "./studio-server";
import { stageOf, type Stage } from "./workspaces";

// One information tab of an app's right-hand panel, read from Mynt as the signed-in user and only
// for that app: every call names the app (or its products, or its workspace and filters to the
// app), and the app must be one Mynt lists as the user's. A tool this Mynt lacks is "not
// available yet"; nothing is ever shown as 0 for want of data.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
type Tool = { name: string; inputSchema?: unknown };
const takes = (tool: Tool | undefined, arg: string) => {
  const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(props && arg in props);
};

export type PanelApp = { id: string; name: string; stage: Stage; workspaceId: string | null; productIds: string[] };

// The app as Mynt lists it to this user, or null when it isn't theirs.
export async function panelApp(mynt: Client, appId: string): Promise<PanelApp | null> {
  const apps = await callStudioTool(mynt, "list_my_apps", {});
  const a = (Array.isArray(apps) ? apps : []).filter(isObj).find((x) => x.id === appId);
  if (!a) return null;
  return {
    id: appId,
    name: typeof a.name === "string" && a.name ? a.name : "Untitled app",
    stage: stageOf(a),
    workspaceId: typeof a.workspace_id === "string" && a.workspace_id ? a.workspace_id : null,
    productIds: Array.isArray(a.product_ids) ? a.product_ids.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 20) : [],
  };
}

export async function loadPanelTab(mynt: Client, app: PanelApp, tab: InfoTab): Promise<AppPnl | AppLicences | AppSecurity | AppSdk | AppActivity | NotYet> {
  const tools = await listMyntTools(mynt);
  const tool = (name: string) => tools.find((t) => t.name === name);
  // A read that Mynt refuses is left out (null); a lost sign-in isn't.
  const read = async (name: string, args: Record<string, unknown>) => {
    if (!tool(name)) return null;
    try {
      return await callStudioTool(mynt, name, args);
    } catch (err) {
      if (isAuthError(err)) throw err;
      return null;
    }
  };
  const ws = app.workspaceId ? { workspace_id: app.workspaceId } : {};
  const checksFor = async () => {
    const to = nextStage(app.stage) as PromotionTarget | null;
    if (!to || !tool("get_promotion_checks")) return null;
    return fromPromotionChecks(await read("get_promotion_checks", { app_id: app.id, to_stage: to }), to);
  };
  const auditFor = async (security: boolean) => {
    const audit = tool("list_workspace_audit");
    if (!audit || !takes(audit, "app_id")) return { events: null, reason: "The app's audit trail isn't available yet" };
    if (security && !takes(audit, "class")) return { events: null, reason: "Security events come with Mynt's next update (its audit trail isn't classified yet)" };
    const reply = await read("list_workspace_audit", { ...ws, app_id: app.id, ...(security ? { class: "security" } : {}) });
    return reply === null ? { events: null, reason: "Mynt didn't answer with the app's audit trail" } : { events: eventsFrom(reply, app.id), reason: null };
  };

  switch (tab) {
    case "pnl": {
      if (!tool("get_workspace_pnl")) return NOT_YET("The app's P&L comes with Mynt's next update.");
      if (!app.workspaceId) return NOT_YET("The P&L is per workspace, and this app isn't in one.");
      const pnl = fromPnl(await read("get_workspace_pnl", { workspace_id: app.workspaceId, app_id: app.id }));
      return pnl ?? NOT_YET("Mynt's P&L for this app wasn't readable.");
    }
    case "licences": {
      if (!tool("get_compliance_coverage")) return NOT_YET("Licence coverage comes with Mynt's next update.");
      const products = await Promise.all(
        app.productIds.map(async (id) => {
          const p = (await read("get_product", { id })) as { name?: unknown } | null;
          return { id, name: typeof p?.name === "string" && p.name ? p.name : id };
        }),
      );
      const coverage = await read("get_compliance_coverage", takes(tool("get_compliance_coverage"), "workspace_id") ? ws : {});
      if (coverage === null) return NOT_YET("Mynt didn't answer with the workspace's coverage.");
      const checks = app.stage === "staging" ? await checksFor() : null;
      return appLicences(coverage, products, checks?.checks.find((c) => c.id === "licences") ?? null);
    }
    case "security": {
      const [audit, checks] = await Promise.all([auditFor(true), checksFor()]);
      if (!audit.events && !checks && !tool("list_workspace_audit") && !tool("get_promotion_checks")) return NOT_YET("Security information comes with Mynt's next update.");
      return {
        available: true,
        events: audit.events,
        eventsReason: audit.reason,
        checks: checks?.checks.filter((c) => SECURITY_CHECKS.includes(c.id)) ?? [],
        checksReason: checks ? null : app.stage === "production" ? "The app is in production: there's no next stage to check it for" : "Mynt's build checks aren't available yet",
      };
    }
    case "sdk": {
      if (!tool("get_product_sdk")) return NOT_YET("The SDK reference comes with Mynt's next update.");
      const products = await Promise.all(
        app.productIds.map(async (id) => {
          const reply = await read("get_product_sdk", { product_id: id });
          return reply === null ? { ...fromProductSdk(id, null), error: "Mynt didn't answer for this product (it may be private or unpublished)" } : fromProductSdk(id, reply);
        }),
      );
      return { available: true, products };
    }
    case "activity": {
      const [builds, audit] = await Promise.all([read("list_builds", { app_id: app.id }), auditFor(false)]);
      if (builds === null && audit.events === null) return NOT_YET("The app's activity isn't available yet.");
      return { available: true, builds: builds === null ? null : buildsFrom(builds, app.id), events: audit.events, eventsReason: audit.reason };
    }
  }
}
