import { callStudioTool } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { asVendor, hasVendorTools, vendorWrite } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

// POST: Create service (create_vendor_offering): a standard service type in a region, from the firm's test endpoint,
// with its price per call and the licences it relies on. It starts as a draft. Mynt shows the conformance signing
// secret once, so it goes back to the sheet once (to copy into the endpoint, which checks Mynt-Signature with it) and
// is never logged or kept here.
export async function POST(req: Request) {
  const w = await vendorWrite(req, STUDIO_TOOLS.create_vendor_offering);
  if (!w.ok) return w.res;
  return asVendor("creating a service", async (mynt) => {
    if (!(await hasVendorTools(mynt, "create_vendor_offering"))) return json({ error: "unsupported", message: "Creating a service here comes with Mynt's next update." }, 501);
    const reply = (await callStudioTool(mynt, "create_vendor_offering", w.body as Record<string, unknown>)) as { id?: unknown; conformance_signing_secret?: unknown } | null;
    return json({
      ok: true,
      offering_id: typeof reply?.id === "string" ? reply.id : null,
      signing_secret: typeof reply?.conformance_signing_secret === "string" ? reply.conformance_signing_secret : null,
      message: (w.body as { test_base_url?: unknown }).test_base_url
        ? "Service created as a draft. Copy the signing secret now: Mynt shows it once. Your endpoint checks Mynt-Signature with it. Then run conformance."
        : "Service created as a draft, with no test endpoint yet. Copy the signing secret now: Mynt shows it once. Run a practice test to see what Mynt sends and expects, then add your test endpoint and run conformance.",
    });
  });
}
