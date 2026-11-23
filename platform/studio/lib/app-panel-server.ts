import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  appProductsFrom,
  buildsFrom,
  eventsFrom,
  fromAgreements,
  fromCustomers,
  fromPnl,
  fromProductSdk,
  gateFrom,
  NOT_YET,
  SECURITY_CHECKS,
  type InfoTab,
  type TabData,
} from "./app-panel";
import { fromAgreementAuditList, summariesByAgreement } from "./agreement-audits";
import { coverageFrom, fromPromotionChecks, nextStage, PROGRAM_AGREEMENTS_CHECK, type PromotionTarget } from "./promotions";
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

export async function loadPanelTab(mynt: Client, app: PanelApp, tab: InfoTab): Promise<TabData> {
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
      const pnl = fromPnl(await read("get_workspace_pnl", { workspace_id: app.workspaceId, granularity: "month", periods: 6, app_id: app.id }));
      return pnl ?? NOT_YET("Mynt's P&L for this app wasn't readable.");
    }
    case "products": {
      // Licence coverage is the products': each with its stage, its sponsors and the states they cover.
      if (!tool("list_app_agreements")) return NOT_YET("The app's products, with their sponsors, come with Mynt's next update.");
      const reply = await read("list_app_agreements", { app_id: app.id });
      if (reply === null) return NOT_YET("Mynt didn't answer with the app's products.");
      const checks = app.stage === "staging" ? await checksFor() : null;
      const r = isObj(reply) ? reply : {};
      return {
        available: true,
        products: appProductsFrom(reply),
        productionCheck: checks?.checks.find((c) => c.id === "licences") ?? null,
        // Production needs a signed program agreement with each product's sponsor: the check while the app is in
        // staging, and what Mynt lists either way (flagged once in production without one).
        agreementCheck: checks?.checks.find((c) => c.id === PROGRAM_AGREEMENTS_CHECK) ?? null,
        coverage: coverageFrom(r.program_coverage),
        gate: gateFrom(r.production_gate),
        canManage: r.can_manage === true,
      };
    }
    case "agreements": {
      if (!tool("list_app_agreements")) return NOT_YET("Agreements come with Mynt's next update.");
      const agreements = fromAgreements(await read("list_app_agreements", { app_id: app.id }));
      if (!agreements) return NOT_YET("Mynt didn't answer with the app's agreements.");
      // Each agreement's oversight audits: how many, the next due and how many are overdue (null when Mynt can't say).
      const audits = tool("list_agreement_audits") ? fromAgreementAuditList(await read("list_agreement_audits", { app_id: app.id, side: "app" })) : null;
      return { ...agreements, audits: audits ? Object.fromEntries(summariesByAgreement(audits)) : null };
    }
    case "customers": {
      if (!tool("get_app_customers")) return NOT_YET("The app's customers come with Mynt's next update.");
      return fromCustomers(await read("get_app_customers", { app_id: app.id })) ?? NOT_YET("Mynt didn't answer with the app's customers.");
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
