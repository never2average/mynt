import { panelApp } from "@/lib/app-panel-server";
import { applyRiskChange, NO_REGISTER_YET, RiskChangeRequest } from "@/lib/risk-register-server";
import { fromOwnOrigin } from "@/lib/session";
import { listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };
const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;

// POST: the Security & risk tab's Add risk and Review risk sheets, for this app's risk register. Same origin and a
// signed-in developer only; the app must be one Mynt lists as theirs, and Mynt checks the rest again (only the
// workspace's owners and admins keep it), its refusal coming back as the message.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId } = await params;
  if (!APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  const parsed = RiskChangeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That risk isn't valid." }, 400);
  return asDeveloper(parsed.data.action === "add" ? "adding an app risk" : "reviewing an app risk", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === (parsed.data.action === "add" ? "add_risk" : "update_risk"))) return json({ error: "unsupported", message: NO_REGISTER_YET }, 501);
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: "That app isn't one of yours." }, 404);
    return json({ ok: true, message: await applyRiskChange(mynt, { type: "app", id: app.id }, parsed.data) });
  });
}
