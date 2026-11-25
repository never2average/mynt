import { callFirmTool } from "@/lib/studio-server";
import { FIRM_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { firmWrite } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

// POST: Register licence (register_license), for the caller's own firm: a licence type from the region's regulatory
// model, its number, the jurisdiction it was issued for when its type is issued per jurisdiction, and its dates. Mynt
// verifies it before it counts; registering one again sends it back for review.
export async function POST(req: Request) {
  return firmWrite(req, FIRM_TOOLS.register_license, "registering a licence", ["register_license"], async (mynt, body, session) => {
    const r = (await callFirmTool(mynt, session, "register_license", body)) as { license_id?: unknown; drifted_products?: unknown } | null;
    const drifted = Array.isArray(r?.drifted_products) ? r.drifted_products.length : 0;
    return json({
      ok: true,
      message: `Registered. It waits for Mynt to verify it against the regulator's register.${drifted ? ` ${drifted} ${drifted === 1 ? "product" : "products"} resting on your firm drifted and paused new sales.` : ""}`,
    });
  });
}
