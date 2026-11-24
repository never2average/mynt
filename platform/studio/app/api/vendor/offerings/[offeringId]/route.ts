import { callStudioTool, isAuthError } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";
import { fromMyOfferings, fromOnboarding, fromSubscribers } from "@/lib/vendor-area";
import { asVendor, hasVendorTools, isUuid, NOT_YOURS, offeringWrite, UNSUPPORTED } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ offeringId: string }> };

// GET: one of the firm's services, for its details: the service itself (list_my_offerings), its checklist with its
// history (get_vendor_onboarding { offering_id }: conformance runs, terms versions) and its subscribers
// (list_my_subscribers { offering_id }). Another firm's service is not found.
export async function GET(_req: Request, { params }: Params) {
  const { offeringId } = await params;
  if (!isUuid(offeringId)) return json(NOT_YOURS, 404);
  return asVendor("loading a service", async (mynt) => {
    if (!(await hasVendorTools(mynt, "get_vendor_onboarding", "list_my_offerings"))) return json(UNSUPPORTED);
    const offering = fromMyOfferings(await callStudioTool(mynt, "list_my_offerings", {})).find((o) => o.id === offeringId);
    if (!offering) return json(NOT_YOURS, 404);
    const onboarding = fromOnboarding(await callStudioTool(mynt, "get_vendor_onboarding", { offering_id: offeringId }));
    let subscribers = null;
    try {
      subscribers = fromSubscribers(await callStudioTool(mynt, "list_my_subscribers", { offering_id: offeringId }));
    } catch (err) {
      if (isAuthError(err)) throw err;
    }
    const history = onboarding?.history.find((h) => h.offeringId === offeringId) ?? null;
    return json({
      offering,
      checklist: onboarding?.offerings.find((o) => o.offeringId === offeringId) ?? null,
      runs: history?.runs ?? [],
      termsVersions: history?.termsVersions ?? [],
      // null: Mynt didn't answer, never shown as none.
      subscribers,
    });
  });
}

// POST: Edit service (update_vendor_offering): its name, endpoints, price, notes, licences and whether subscribers need a
// credential. Changing an endpoint or licences sends it back to draft, to pass conformance again.
const Edit = STUDIO_TOOLS.update_vendor_offering.omit({ offering_id: true, listed: true, standard_terms: true });

export async function POST(req: Request, { params }: Params) {
  const { offeringId } = await params;
  return offeringWrite(req, offeringId, Edit, "editing a service", "update_vendor_offering", async (mynt, body) => {
    const reply = (await callStudioTool(mynt, "update_vendor_offering", { offering_id: offeringId, ...(body as Record<string, unknown>) })) as { status?: unknown } | null;
    const draft = reply?.status === "draft";
    return json({ ok: true, status: typeof reply?.status === "string" ? reply.status : null, message: draft ? "Saved. It's a draft again: run conformance before it's listed." : "Saved." });
  });
}
