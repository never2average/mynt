import { z } from "zod";
import { removalFrom } from "@/lib/admin";
import { hasTools, isUuid, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { callAdminTool, MyntRefusedError } from "@/lib/studio-server";
import { parseToolText } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };

// Admin → Apps → Remove test app (remove_app): first a dry run (confirm: false) listing exactly what would go, then
// the removal itself (confirm: true, with a reason for the audit log). Mynt refuses an app that's published, hosted,
// has live customer data or money movements, or a mainnet program; its reasons come back as they are. Never
// proceed_without_closing: a devnet program Mynt can't close stops the removal.
const Body = z.object({ confirm: z.boolean(), reason: z.string().trim().min(3).max(500).optional() }).strict().refine((b) => !b.confirm || b.reason, { message: "Say why it's being removed." });

export async function POST(req: Request, { params }: Params) {
  const { appId } = await params;
  if (!isUuid(appId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  return asAdmin("removing an app", async (mynt, session) => {
    if (!(await hasTools(mynt, "remove_app"))) return json(UNSUPPORTED);
    let reply: unknown;
    try {
      reply = await callAdminTool(mynt, session, "remove_app", { app_id: appId, confirm: w.body.confirm, ...(w.body.reason ? { reason: w.body.reason } : {}) });
    } catch (err) {
      // A refusal is an answer: the reasons, in Mynt's words.
      const refused = err instanceof MyntRefusedError ? removalFrom(parseToolText(err.raw)) : null;
      if (refused?.kind === "refused") return json({ removal: refused }, 422);
      throw err;
    }
    const removal = removalFrom(reply);
    return removal ? json({ removal }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
