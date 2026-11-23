import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// POST { subscription_id, reason? }: end a subscription to a service provider (the app's Agreements tab's End
// subscription). Mynt ends the agreements accepted with it and tells the provider, and refuses while a live product
// hands off through it; its reason comes back as the message.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = STUDIO_TOOLS.unsubscribe_vendor_service.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That subscription isn't valid." }, 400);
  return asDeveloper("ending a subscription", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "unsubscribe_vendor_service")) return json({ error: "unsupported", message: "Ending subscriptions here comes with Mynt's next update." }, 501);
    await callStudioTool(mynt, "unsubscribe_vendor_service", parsed.data);
    return json({ ok: true, message: "Subscription ended. Its agreements have ended and the provider is told." });
  });
}
