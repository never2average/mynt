import { appDetailFrom } from "@/lib/admin";
import { hasTools, isUuid, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };

// Admin → Apps → one app: its products, builds and hosting (admin_get_app). Never a preview link.
export async function GET(_req: Request, { params }: Params) {
  const { appId } = await params;
  if (!isUuid(appId)) return json({ error: "bad_request" }, 400);
  return asAdmin("reading an app", async (mynt, session) => {
    if (!(await hasTools(mynt, "admin_get_app"))) return json(UNSUPPORTED);
    const detail = appDetailFrom(await callAdminTool(mynt, session, "admin_get_app", { app_id: appId }));
    return detail ? json({ detail }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
