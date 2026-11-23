import { z } from "zod";
import { isUuid, writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ offeringId: string }> };

// Admin → Vendors → Suspend offering / Reinstate offering (suspend_vendor_offering). Suspending stops it being listed
// or called, and products bound to it drift (pausing new sales); reinstating puts it back to draft, to pass
// conformance again before it's listed.
const Body = z.object({ suspended: z.boolean(), note: z.string().trim().min(3).max(500) }).strict();

export async function POST(req: Request, { params }: Params) {
  const { offeringId } = await params;
  if (!isUuid(offeringId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  return asAdmin("suspending or reinstating an offering", async (mynt, session) => {
    await callAdminTool(mynt, session, "suspend_vendor_offering", { offering_id: offeringId, ...w.body });
    return json({ ok: true, message: w.body.suspended ? "Suspended. It's no longer listed or called; products bound to it pause new sales." : "Reinstated as a draft. It's listed again once it passes conformance." });
  });
}
