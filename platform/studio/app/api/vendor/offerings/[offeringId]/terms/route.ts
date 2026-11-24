import { z } from "zod";
import { callStudioTool } from "@/lib/studio-server";
import { standardTerms } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { offeringWrite } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ offeringId: string }> };

// POST: Set standard terms (update_vendor_offering { standard_terms }): the document's https link and its SHA-256
// (computed in the browser from the file, or pasted), a summary and the pricing in words. Anything changed is a new
// version; agreements already made keep the version they accepted. Only the firm's own members set them.
const Body = z.object({ standard_terms: standardTerms }).strict();

export async function POST(req: Request, { params }: Params) {
  const { offeringId } = await params;
  return offeringWrite(req, offeringId, Body, "setting standard terms", "update_vendor_offering", async (mynt, body) => {
    const reply = (await callStudioTool(mynt, "update_vendor_offering", { offering_id: offeringId, standard_terms: body.standard_terms })) as { terms?: { version?: unknown } | null } | null;
    const version = typeof reply?.terms?.version === "number" ? reply.terms.version : null;
    return json({
      ok: true,
      version,
      message: `${version ? `Saved as version ${version}.` : "Saved."} New subscribers accept these terms; agreements already made keep the version they accepted.`,
    });
  });
}
