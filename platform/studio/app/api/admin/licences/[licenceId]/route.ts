import { z } from "zod";
import { isUuid, writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ licenceId: string }> };

// Admin → Licences → Verify licence / Reject licence / Suspend licence (review_license), after checking it against
// the regulator's public register. Only verified, in-date licences let a firm publish products. A rejection or a
// suspension says why.
const Body = z
  .object({ decision: ADMIN_TOOLS.review_license.shape.decision, note: z.string().trim().max(2000).optional() })
  .strict()
  .refine((b) => b.decision === "verified" || (b.note?.length ?? 0) >= 3, { message: "Say why." });
const DONE = { verified: "Verified. The firm may now rely on it.", rejected: "Rejected. The firm sees your note.", suspended: "Suspended. Products resting on it are re-checked." } as const;

export async function POST(req: Request, { params }: Params) {
  const { licenceId } = await params;
  if (!isUuid(licenceId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  return asAdmin("reviewing a licence", async (mynt, session) => {
    await callAdminTool(mynt, session, "review_license", { license_record_id: licenceId, decision: w.body.decision, ...(w.body.note ? { note: w.body.note } : {}) });
    return json({ ok: true, message: DONE[w.body.decision] });
  });
}
