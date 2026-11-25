import { callFirmTool } from "@/lib/studio-server";
import { FIRM_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { firmWrite, ownLicences } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

// POST: Add party (add_party), to the caller's own firm's roster: a person in the firm, or another firm (one already
// on Mynt by its id, or a new one by its legal name), with the required roles it fills on the firm's licences. Mynt
// checks each role against the licence type and re-checks the products resting on the firm.
export async function POST(req: Request) {
  return firmWrite(req, FIRM_TOOLS.add_party, "adding a party", ["add_party", "list_my_licenses"], async (mynt, body, session) => {
    const fills = body.fills ?? [];
    if (fills.length && !(await ownLicences(mynt, session, fills.map((f) => f.licence_id)))) return json({ error: "not_found", message: "One of those isn't a licence your firm holds." }, 404);
    await callFirmTool(mynt, session, "add_party", { ...body, fills });
    return json({ ok: true, message: fills.length ? `Added. ${fills.length === 1 ? "The role is" : `${fills.length} roles are`} filled.` : "Added to your roster." });
  });
}
