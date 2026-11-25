import { callFirmTool } from "@/lib/studio-server";
import { FIRM_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { firmWrite } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

// POST: Set firm facts (set_entity_facts), for the caller's own firm: its identifiers (the LEI, the FinCEN MSB
// registration number, the NMLS ID; the list replaces what's there, so the sheet sends the others unchanged). Mynt
// re-checks the products resting on the firm. The real-company check runs on them when Mynt next runs it.
export async function POST(req: Request) {
  return firmWrite(req, FIRM_TOOLS.set_entity_facts, "setting my firm's facts", ["set_entity_facts"], async (mynt, body, session) => {
    const r = (await callFirmTool(mynt, session, "set_entity_facts", body)) as { drifted_products?: unknown } | null;
    const drifted = Array.isArray(r?.drifted_products) ? r.drifted_products.length : 0;
    return json({
      ok: true,
      message: `Saved. Mynt checks your firm against the public registers with these the next time it runs the real-company check.${drifted ? ` ${drifted} ${drifted === 1 ? "product" : "products"} resting on your firm drifted and paused new sales.` : ""}`,
    });
  });
}
