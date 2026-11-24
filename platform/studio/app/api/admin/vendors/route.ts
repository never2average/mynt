import { adminOfferingsFrom, serviceTypesFrom, vendorFirmsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Vendors: the standard service types (list_service_types, every region), every vendor's offering of
// them, whatever its status, with its last conformance result (list_vendor_offerings, include_unlisted), and each
// vendor firm's onboarding progress (get_vendor_onboarding { all_firms }; firms: null on a Mynt without it).
export async function GET() {
  return asAdmin("reading the vendors", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_service_types", "list_vendor_offerings"))) return json(UNSUPPORTED);
    const serviceTypes = serviceTypesFrom(await callAdminTool(mynt, session, "list_service_types", {}));
    const offerings = adminOfferingsFrom(await callAdminTool(mynt, session, "list_vendor_offerings", { include_unlisted: true }));
    const firms = (await hasTools(mynt, "get_vendor_onboarding")) ? vendorFirmsFrom(await callAdminTool(mynt, session, "get_vendor_onboarding", { all_firms: true })) : null;
    return serviceTypes && offerings ? json({ serviceTypes, offerings, firms }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
