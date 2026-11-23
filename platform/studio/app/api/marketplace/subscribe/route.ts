import { z } from "zod";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// What the Marketplace's Subscribe sheet sends: subscribe_vendor_service's own arguments (always accepting a version of
// the provider's standard terms, for named apps). An empty optional field is left out.
const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
const Shape = STUDIO_TOOLS.subscribe_vendor_service.shape;
const Subscribe = STUDIO_TOOLS.subscribe_vendor_service.extend({
  test_credential: z.preprocess(blank, Shape.test_credential),
  credential_label: z.preprocess(blank, Shape.credential_label),
});

// POST: subscribe the user's firm to a listed service, accepting its provider's standard terms for the apps named.
// Same origin and a signed-in developer only; Mynt checks the rest again (the current terms version, owners and admins
// of each app, the prerequisites). A test credential goes to the firm's key vault on Mynt and is never sent back, logged
// or kept here: the answer is only a message and the subscription's id.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Subscribe.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That subscription isn't valid: choose at least one app and accept the terms." }, 400);
  return asDeveloper("subscribing to a service", async (mynt) => {
    const tool = (await listMyntTools(mynt)).find((t) => t.name === "subscribe_vendor_service");
    const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
    if (!props || !("accept_terms_version" in props)) return json({ error: "unsupported", message: "Subscribing from the Marketplace comes with Mynt's next update." }, 501);
    const args = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const reply = (await callStudioTool(mynt, "subscribe_vendor_service", args)) as { subscription_id?: unknown } | null;
    const subscriptionId = typeof reply?.subscription_id === "string" ? reply.subscription_id : null;
    return json({ ok: true, subscription_id: subscriptionId, message: "Subscribed. The agreement is signed and shows in each app's Agreements tab; the provider bills you directly." });
  });
}
