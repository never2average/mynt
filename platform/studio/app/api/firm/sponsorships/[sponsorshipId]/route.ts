import { z } from "zod";
import { callFirmTool } from "@/lib/studio-server";
import { FIRM_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { firmWrite, isUuid, NOT_YOURS, ownLicences, ownSponsorship } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ sponsorshipId: string }> };

// POST: a licence provider's decision on a sponsorship of its own firm's.
//   { action: "approve", licence_ids, jurisdictions?, note? }  Approve sponsorship (approve_sponsorship): the request
//     must be waiting, and every licence named one the firm holds. Mynt refuses it until the firm passes the
//     real-company check, and says why.
//   { action: "decline", reason }                              Decline request (decline_sponsorship).
//   { action: "revoke", reason }                               Revoke sponsorship (revoke_sponsorship): an approved
//     one; published products resting on it drift. An admin account can't, even one that belongs to the firm.
const approve = FIRM_TOOLS.approve_sponsorship.omit({ sponsorship_id: true });
const reason = FIRM_TOOLS.decline_sponsorship.shape.reason;
const Body = z.discriminatedUnion("action", [
  approve.extend({ action: z.literal("approve") }).strict(),
  z.object({ action: z.literal("decline"), reason }).strict(),
  z.object({ action: z.literal("revoke"), reason }).strict(),
]);
const TOOL = { approve: "approve_sponsorship", decline: "decline_sponsorship", revoke: "revoke_sponsorship" } as const;

export async function POST(req: Request, { params }: Params) {
  const { sponsorshipId } = await params;
  if (!isUuid(sponsorshipId)) return json(NOT_YOURS, 404);
  return firmWrite(req, Body, "deciding a sponsorship", ["approve_sponsorship", "decline_sponsorship", "revoke_sponsorship", "list_sponsorship_requests", "list_sponsored_products"], async (mynt, body, session) => {
    if (!(await ownSponsorship(mynt, session, sponsorshipId, body.action === "revoke" ? "approved" : "pending"))) return json(NOT_YOURS, 404);
    if (body.action === "approve") {
      if (!(await ownLicences(mynt, session, body.licence_ids))) return json({ error: "not_found", message: "One of those isn't a licence your firm holds." }, 404);
      const { action: _a, ...args } = body;
      const r = (await callFirmTool(mynt, session, TOOL.approve, { sponsorship_id: sponsorshipId, ...args })) as { jurisdictions?: unknown } | null;
      const where = Array.isArray(r?.jurisdictions) ? r.jurisdictions.filter((j): j is string => typeof j === "string").map((j) => j.toUpperCase()) : [];
      return json({ ok: true, message: `Approved${where.length ? ` in ${where.join(", ")}` : ""}. The component is covered there by your licence.` });
    }
    if (body.action === "decline") {
      await callFirmTool(mynt, session, TOOL.decline, { sponsorship_id: sponsorshipId, reason: body.reason });
      return json({ ok: true, message: "Declined. The builder sees your reason." });
    }
    const r = (await callFirmTool(mynt, session, TOOL.revoke, { sponsorship_id: sponsorshipId, reason: body.reason })) as { drifted_products?: unknown } | null;
    const drifted = Array.isArray(r?.drifted_products) ? r.drifted_products.length : 0;
    return json({ ok: true, message: `Revoked.${drifted ? ` ${drifted} published ${drifted === 1 ? "product" : "products"} drifted and paused new sales.` : " The component is no longer covered by your licences."}` });
  });
}
