import { callStudioTool, isAuthError } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";
import { fromMyOfferings, fromOnboarding, licenceOptions, serviceTypeOptions } from "@/lib/vendor-area";
import { asVendor, hasVendorTools, UNSUPPORTED } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

// GET: My services (/vendor), for an account with the vendor role: its firm's onboarding checklist
// (get_vendor_onboarding), the firm's services (list_my_offerings), and what Create service offers: the standard service
// types (list_service_types) and the firm's licences (get_my_entity). `supported: false` until this Mynt has the
// checklist.
export async function GET() {
  return asVendor("loading my services", async (mynt) => {
    if (!(await hasVendorTools(mynt, "get_vendor_onboarding", "list_my_offerings"))) return json(UNSUPPORTED);
    const onboarding = fromOnboarding(await callStudioTool(mynt, "get_vendor_onboarding", {}));
    if (!onboarding) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    // Without a firm there's nothing of its own to list yet: the checklist says it waits on Mynt.
    if (!onboarding.entity) return json({ onboarding, offerings: [], serviceTypes: [], licences: [] });
    const offerings = fromMyOfferings(await callStudioTool(mynt, "list_my_offerings", {}));
    const optional = async <T>(f: () => Promise<T>, none: T): Promise<T> => {
      try {
        return await f();
      } catch (err) {
        if (isAuthError(err)) throw err;
        return none;
      }
    };
    const serviceTypes = await optional(async () => serviceTypeOptions(await callStudioTool(mynt, "list_service_types", {})), []);
    const licences = await optional(async () => licenceOptions(await callStudioTool(mynt, "get_my_entity", {})), []);
    return json({ onboarding, offerings, serviceTypes, licences });
  });
}
