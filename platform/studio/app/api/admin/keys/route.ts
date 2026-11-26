import { z } from "zod";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { keyVaultFrom } from "@/lib/platform-settings";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Platform admin → Platform settings → Key vault. GET: every key Mynt's own server uses (list_platform_keys), one row
// per key type: where it comes from, who set it and when, its fingerprint. Never a value: Mynt doesn't answer with
// one, and keyVaultFrom has no field for one. POST: Set key or Replace key (set_platform_key: the value goes to Mynt
// once, in this request's body, and nothing here logs, stores or returns it), or Remove key (remove_platform_key),
// which needs the key's type typed out. Same origin, signed in, and an account Mynt says is an admin, or 404; Mynt
// checks the role and the value again, its refusal the message. Every answer is no-store (lib/studio-route.ts json).
const KeyChange = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), type: ADMIN_TOOLS.set_platform_key.shape.type, value: ADMIN_TOOLS.set_platform_key.shape.value }).strict(),
  z.object({ action: z.literal("remove"), type: ADMIN_TOOLS.remove_platform_key.shape.type, confirm: z.string().max(80) }).strict(),
]);
const NOT_YET = { error: "unsupported", message: "The key vault comes with Mynt's next update." } as const;
const words = (reply: unknown, fallback: string) => (typeof (reply as { message?: unknown } | null)?.message === "string" ? (reply as { message: string }).message : fallback);

export async function GET() {
  return asAdmin("reading the platform key vault", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_platform_keys"))) return json(UNSUPPORTED);
    const vault = keyVaultFrom(await callAdminTool(mynt, session, "list_platform_keys", {}));
    return vault ? json({ vault }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, KeyChange);
  // A body that doesn't parse is refused in fixed words: a parser's own message could quote what was sent.
  if (!w.ok) return w.res.status === 400 ? json({ error: "bad_request", message: "That isn't a change the key vault takes." }, 400) : w.res;
  const change = w.body;
  if (change.action === "remove" && change.confirm !== change.type) return json({ error: "bad_request", message: `Type ${change.type} to confirm removing it.` }, 400);
  return asAdmin(change.action === "set" ? "setting a platform key" : "removing a platform key", async (mynt, session) => {
    if (!(await hasTools(mynt, "set_platform_key", "remove_platform_key"))) return json(NOT_YET, 422);
    const reply =
      change.action === "set"
        ? await callAdminTool(mynt, session, "set_platform_key", { type: change.type, value: change.value })
        : await callAdminTool(mynt, session, "remove_platform_key", { type: change.type, confirm: true });
    // Only Mynt's sentence goes back: never its whole answer, and never what was sent.
    return json({ ok: true, message: words(reply, change.action === "set" ? "The key is kept in the vault." : "The key is removed from the vault.") });
  });
}
