import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { panelApp } from "@/lib/app-panel-server";
import { appsFrom, fromOfferings, type ForApp } from "@/lib/marketplace";
import { callStudioTool, isAuthError, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;

// The regions of an app's products (get_product), for Browse vendors: the Marketplace opens filtered to them.
async function appRegions(mynt: Client, productIds: string[]): Promise<string[]> {
  const regions = new Set<string>();
  for (const id of productIds.slice(0, 20)) {
    try {
      const p = (await callStudioTool(mynt, "get_product", { id })) as { region?: unknown } | null;
      if (typeof p?.region === "string" && /^[A-Za-z]{2}$/.test(p.region)) regions.add(p.region.toUpperCase());
    } catch (err) {
      if (isAuthError(err)) throw err;
    }
  }
  return [...regions].sort();
}

// GET: the Marketplace's offerings (list_vendor_offerings: listed services, each with its provider's standard terms,
// Mynt's conformance result and whether the user's firm meets the prerequisites), and the user's apps for the
// Subscribe sheet. ?app=<id>: that app too, with its products' regions (Browse vendors). `supported: false` until this
// Mynt lists offerings.
export async function GET(req: Request) {
  const appId = new URL(req.url).searchParams.get("app");
  if (appId !== null && !APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  return asDeveloper("loading the marketplace", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "list_vendor_offerings")) return json({ supported: false });
    const terms = tools.find((t) => t.name === "subscribe_vendor_service")?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    const offerings = fromOfferings(await callStudioTool(mynt, "list_vendor_offerings", {}));
    const apps = appsFrom(await callStudioTool(mynt, "list_my_apps", {}));
    let forApp: ForApp | null = null;
    if (appId) {
      const app = await panelApp(mynt, appId);
      if (app) forApp = { id: app.id, name: app.name, regions: await appRegions(mynt, app.productIds) };
    }
    // Subscribing accepts standard terms; a Mynt without them can list but not subscribe from here.
    return json({ supported: true, offerings, apps, forApp, canSubscribe: Boolean(terms?.properties && "accept_terms_version" in terms.properties) });
  });
}
