import { adminOfferingsFrom, serviceTypesFrom, vendorFirmsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { typeRequestsFrom } from "@/lib/services";
import { callAdminTool, callStudioTool, listMyntTools } from "@/lib/studio-server";
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
    // Requested service types: what builders asked Mynt to define (list_service_type_requests answers an admin with
    // everyone's; it is the studio's own read, so it isn't an admin tool). Left out on a Mynt without requests.
    const requests = (await listMyntTools(mynt)).some((t) => t.name === "list_service_type_requests") ? typeRequestsFrom(await callStudioTool(mynt, "list_service_type_requests", {})) : undefined;
    return serviceTypes && offerings ? json({ serviceTypes, offerings, firms, ...(requests ? { requests } : {}) }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
