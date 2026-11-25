import { callFirmTool } from "@/lib/studio-server";
import { FIRM_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { firmWrite, isUuid, NOT_YOURS, ownParty } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ partyId: string }> };

// POST { until? }: End party (end_party): a party on the caller's own firm's roster no longer fills its role, from
// today or the date given. Parties aren't edited: end one and add the new one. Published products bound to it drift.
const Body = FIRM_TOOLS.end_party.omit({ party_id: true });

export async function POST(req: Request, { params }: Params) {
  const { partyId } = await params;
  if (!isUuid(partyId)) return json(NOT_YOURS, 404);
  return firmWrite(req, Body, "ending a party", ["end_party", "get_my_entity"], async (mynt, body, session) => {
    if (!(await ownParty(mynt, session, partyId))) return json(NOT_YOURS, 404);
    const r = (await callFirmTool(mynt, session, "end_party", { party_id: partyId, ...body })) as { until?: unknown; drifted_products?: unknown } | null;
    const drifted = Array.isArray(r?.drifted_products) ? r.drifted_products.length : 0;
    return json({
      ok: true,
      message: `Ended${typeof r?.until === "string" ? ` from ${r.until}` : ""}.${drifted ? ` ${drifted} published ${drifted === 1 ? "product" : "products"} bound to it drifted and paused new sales.` : ""}`,
    });
  });
}
