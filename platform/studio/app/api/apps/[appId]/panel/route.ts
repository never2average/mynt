import { isInfoTab } from "@/lib/app-panel";
import { loadPanelTab, panelApp } from "@/lib/app-panel-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };
const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;

// GET ?tab=pnl|licences|security|sdk|activity: one information tab of the app's right-hand
// panel (lib/app-panel-server.ts), for this app only. Read-only.
export async function GET(req: Request, { params }: Params) {
  const { appId } = await params;
  const tab = new URL(req.url).searchParams.get("tab");
  if (!APP_ID.test(appId) || !isInfoTab(tab)) return json({ error: "bad_request" }, 400);
  return asDeveloper(`loading an app's ${tab} tab`, async (mynt) => {
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: "That app isn't one of yours." }, 404);
    return json({ tab, data: await loadPanelTab(mynt, app, tab) });
  });
}
