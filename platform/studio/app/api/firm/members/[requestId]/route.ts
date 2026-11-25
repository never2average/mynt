import { callFirmTool } from "@/lib/studio-server";
import { FIRM_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { fromOnboarding, peopleOf } from "@/lib/firm-area";
import { firmWrite, isUuid, NOT_YOURS } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ requestId: string }> };

// POST { accept }: Decide (decide_firm_member): one of the firm's existing licence providers accepts or declines an
// account a Mynt admin added to the firm. The request must be one waiting at the caller's own firm. Mynt refuses a
// decider who joined too recently or after the request, and an admin account: its words are shown.
const Body = FIRM_TOOLS.decide_firm_member.omit({ request_id: true });

export async function POST(req: Request, { params }: Params) {
  const { requestId } = await params;
  if (!isUuid(requestId)) return json(NOT_YOURS, 404);
  return firmWrite(req, Body, "deciding a firm member", ["decide_firm_member", "get_regulated_firm_onboarding"], async (mynt, body, session) => {
    const onboarding = fromOnboarding(await callFirmTool(mynt, session, "get_regulated_firm_onboarding", {}));
    if (!onboarding || !peopleOf(null, onboarding).some((p) => p.status === "waiting" && p.requestId === requestId)) return json(NOT_YOURS, 404);
    await callFirmTool(mynt, session, "decide_firm_member", { request_id: requestId, accept: body.accept });
    return json({ ok: true, message: body.accept ? "Accepted. They're a licence provider at your firm now; their waiting period starts from this moment." : "Declined. They have no standing at your firm." });
  });
}
