import { panelApp } from "@/lib/app-panel-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };
const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;
const Choice = STUDIO_TOOLS.set_app_target_segments.omit({ app_id: true });

// POST { segments: [{ product_id, segment_id }] }: the Customers tab's Choose personas sheet sets
// the personas this app targets (replacing its choice). Same origin and a signed-in developer only;
// Mynt checks again that each is a segment of the app's products and that the caller may choose.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId } = await params;
  if (!APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  const parsed = Choice.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That choice isn't valid." }, 400);
  return asDeveloper("choosing an app's personas", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "set_app_target_segments")) return json({ error: "unsupported", message: "Choosing personas comes with Mynt's next update." }, 501);
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: "That app isn't one of yours." }, 404);
    await callStudioTool(mynt, "set_app_target_segments", { app_id: app.id, segments: parsed.data.segments });
    return json({ ok: true, message: parsed.data.segments.length ? "Personas saved." : "Personas cleared." });
  });
}
