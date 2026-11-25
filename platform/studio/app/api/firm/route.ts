import { callFirmTool, isAuthError } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";
import { fromFirm, fromLicences, fromOnboarding, fromSponsorships, licenceTypeOptions, type LicenceTypeOption } from "@/lib/firm-area";
import { asLicenceProvider, hasFirmTools, UNSUPPORTED } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

// GET: My firm (/firm), for an account with the licence-provider role: its firm's onboarding checklist with the
// real-company check (get_regulated_firm_onboarding), the firm's record, roster and people (get_my_entity), its
// licences (list_my_licenses), the requests waiting for its decision (list_sponsorship_requests) and what it sponsors
// (list_sponsored_products), and what Register licence offers: the licence types of the firm's regions (get_region).
// `supported: false` until this Mynt has the checklist. A part Mynt didn't answer is null, and its tab says so.
export async function GET() {
  return asLicenceProvider("loading my firm", async (mynt, session) => {
    if (!(await hasFirmTools(mynt, "get_regulated_firm_onboarding"))) return json(UNSUPPORTED);
    const onboarding = fromOnboarding(await callFirmTool(mynt, session, "get_regulated_firm_onboarding", {}));
    if (!onboarding) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    // Without a firm there's nothing of its own to list yet: the checklist says it waits on Mynt.
    if (!onboarding.entity) return json({ onboarding, firm: null, licences: [], requests: [], sponsored: [], licenceTypes: [] });
    const optional = async <T>(f: () => Promise<T>): Promise<T | null> => {
      try {
        return await f();
      } catch (err) {
        if (isAuthError(err)) throw err;
        return null;
      }
    };
    const firm = await optional(async () => fromFirm(await callFirmTool(mynt, session, "get_my_entity", {})));
    const licences = await optional(async () => fromLicences(await callFirmTool(mynt, session, "list_my_licenses", {})));
    const requests = await optional(async () => fromSponsorships(await callFirmTool(mynt, session, "list_sponsorship_requests", { status: "pending" })));
    const sponsored = await optional(async () => fromSponsorships(await callFirmTool(mynt, session, "list_sponsored_products", {})));
    const licenceTypes: LicenceTypeOption[] = [];
    for (const region of (firm?.regions ?? []).filter((r) => /^[A-Z]{2}$/.test(r)).slice(0, 5)) {
      licenceTypes.push(...((await optional(async () => licenceTypeOptions(region, await callFirmTool(mynt, session, "get_region", { code: region })))) ?? []));
    }
    return json({ onboarding, firm, licences, requests, sponsored, licenceTypes });
  });
}
