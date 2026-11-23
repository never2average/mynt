import { adminOfferingsFrom, serviceTypesFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Vendors: the standard service types (list_service_types, every region) and every vendor's offering of
// them, whatever its status, with its last conformance result (list_vendor_offerings, include_unlisted).
export async function GET() {
  return asAdmin("reading the vendors", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_service_types", "list_vendor_offerings"))) return json(UNSUPPORTED);
    const serviceTypes = serviceTypesFrom(await callAdminTool(mynt, session, "list_service_types", {}));
    const offerings = adminOfferingsFrom(await callAdminTool(mynt, session, "list_vendor_offerings", { include_unlisted: true }));
    return serviceTypes && offerings ? json({ serviceTypes, offerings }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
