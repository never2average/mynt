import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { panelApp } from "@/lib/app-panel-server";
import { appsFrom, fromOfferings, type ForApp } from "@/lib/marketplace";
import { callStudioTool, isAuthError, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;
const OFFERING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  // ?offering=<id>: that offering too when it isn't in the list, which is how a service in testing is reached (its
  // builder gives the id). Anything that isn't an offering id is only a details link, as before.
  const named = new URL(req.url).searchParams.get("offering");
  const offeringId = named && OFFERING_ID.test(named) ? named.toLowerCase() : null;
  return asDeveloper("loading the marketplace", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "list_vendor_offerings")) return json({ supported: false });
    const terms = tools.find((t) => t.name === "subscribe_vendor_service")?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    const offerings = fromOfferings(await callStudioTool(mynt, "list_vendor_offerings", {}));
    if (offeringId && !offerings.some((o) => o.id === offeringId)) {
      const accepts = (tools.find((t) => t.name === "list_vendor_offerings")?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
      // A Mynt from before services could be tested in Staging takes no offering_id: nothing is added.
      if (accepts && "offering_id" in accepts) offerings.push(...fromOfferings(await callStudioTool(mynt, "list_vendor_offerings", { offering_id: offeringId })).filter((o) => o.id === offeringId && o.inTesting));
    }
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
