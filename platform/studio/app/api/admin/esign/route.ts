import { z } from "zod";
import { esignStatusFrom } from "@/lib/esign-settings";
import { hasTools } from "@/lib/admin-routes";
import { fromOwnOrigin } from "@/lib/session";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Session } from "@/lib/session-store";

export const dynamic = "force-dynamic";

// Admin → Platform settings → E-signature: Mynt admins only (anyone else: 404). The key goes through once, to Mynt,
// which checks it with the service and keeps it sealed; nothing here logs, stores or returns it.
const NOT_YET = json({ error: "unsupported", message: "Setting e-signature up in the studio comes with Mynt's next update." }, 501);

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_key"), provider: ADMIN_TOOLS.set_esign_api_key.shape.provider, api_key: ADMIN_TOOLS.set_esign_api_key.shape.api_key }).strict(),
  z.object({ action: z.literal("register_webhook") }).strict(),
  z.object({ action: z.literal("remove_key"), confirm: z.literal(true) }).strict(),
  z.object({ action: z.literal("test_mode"), test_mode: z.boolean() }).strict(),
]);

const status = async (mynt: Client, session: Session) => esignStatusFrom(await callAdminTool(mynt, session, "get_esign_settings", {}));

export async function GET() {
  return asAdmin("reading e-signature settings", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_esign_settings"))) return NOT_YET;
    const s = await status(mynt, session);
    return s ? json({ settings: s }) : json({ error: "unreadable", message: "Mynt didn't answer with its e-signature settings." }, 502);
  });
}

// POST { action }: set the key, re-register the webhook, remove the key, or switch test mode.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That isn't a change these settings take." }, 400);
  const a = parsed.data;
  return asAdmin("changing e-signature settings", async (mynt, session) => {
    if (!(await hasTools(mynt, "set_esign_api_key"))) return NOT_YET;
    let message: string;
    if (a.action === "set_key") {
      const r = (await callAdminTool(mynt, session, "set_esign_api_key", { provider: a.provider, api_key: a.api_key })) as { webhook?: { registered?: boolean; reused?: boolean; reason?: string } } | null;
      message = r?.webhook?.registered
        ? `Key checked and saved. The webhook is registered${r.webhook.reused ? " (an existing one pointing here was reused)" : ""}.`
        : `Key checked and saved. The webhook isn't registered yet: ${r?.webhook?.reason ?? "try Re-register webhook"}.`;
    } else if (a.action === "register_webhook") {
      const r = (await callAdminTool(mynt, session, "register_esign_webhook", {})) as { reused?: boolean } | null;
      message = r?.reused ? "Webhook registered (an existing one pointing here was reused)." : "Webhook registered.";
    } else if (a.action === "remove_key") {
      const r = (await callAdminTool(mynt, session, "remove_esign_api_key", { confirm: true })) as { webhook_deleted?: boolean; still_configured_by_environment?: boolean } | null;
      message = `Key removed${r?.webhook_deleted ? " and the webhook deleted at the service" : ""}.${r?.still_configured_by_environment ? " The server's environment still sets a key, so e-signature stays on." : " Program agreements are signed by hand until a key is set again."}`;
    } else {
      await callAdminTool(mynt, session, "set_esign_test_mode", { test_mode: a.test_mode });
      message = a.test_mode ? "Test mode is on: new documents aren't legally binding." : "Live: new documents are legally binding.";
    }
    return json({ ok: true, message, settings: await status(mynt, session) });
  });
}
