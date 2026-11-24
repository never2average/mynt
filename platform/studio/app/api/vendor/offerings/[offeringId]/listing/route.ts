import { z } from "zod";
import { callStudioTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";
import { offeringWrite } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ offeringId: string }> };

// POST { listed }: List service / Unlist service (update_vendor_offering { listed }). Mynt lists a service only once it
// passed conformance (and its licences are in force); unlisting takes it off the Marketplace, and current subscribers
// keep it.
const Body = z.object({ listed: z.boolean() }).strict();

export async function POST(req: Request, { params }: Params) {
  const { offeringId } = await params;
  return offeringWrite(req, offeringId, Body, "listing a service", "update_vendor_offering", async (mynt, body) => {
    await callStudioTool(mynt, "update_vendor_offering", { offering_id: offeringId, listed: body.listed });
    return json({ ok: true, message: body.listed ? "Listed. App teams see it in the Marketplace." : "Unlisted. It's off the Marketplace; current subscribers keep it." });
  });
}
