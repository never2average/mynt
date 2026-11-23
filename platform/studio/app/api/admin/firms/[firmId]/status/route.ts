import { z } from "zod";
import { isUuid, writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ firmId: string }> };

// Admin → Firms → Set firm status: the firm's status from its company registry (set_entity_status). Mynt re-checks
// every published product resting on it; drifted ones pause new sales.
const Body = z.object({ status: ADMIN_TOOLS.set_entity_status.shape.status, note: z.string().trim().min(3).max(2000) }).strict();

export async function POST(req: Request, { params }: Params) {
  const { firmId } = await params;
  if (!isUuid(firmId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  return asAdmin("setting a firm's status", async (mynt, session) => {
    const r = (await callAdminTool(mynt, session, "set_entity_status", { entity_id: firmId, ...w.body })) as { drifted_products?: unknown[] } | null;
    const drifted = Array.isArray(r?.drifted_products) ? r.drifted_products.length : 0;
    return json({ ok: true, message: `Status recorded.${drifted ? ` ${drifted} product(s) resting on it drifted and paused new sales.` : ""}` });
  });
}
