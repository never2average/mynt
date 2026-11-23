import { fromFirmAgreements, fromTemplates } from "@/lib/agreement-esign";
import { asAgreementParty, hasTool, NOT_YET } from "@/lib/agreement-esign-server";
import { callStudioTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// A licence provider's Agreements page: its firm's agreement templates, the agreements apps made with its firm, and
// its licences (for the Upload agreement template sheet). Licence providers only; Mynt scopes each to the firm.
export async function GET() {
  return asAgreementParty(
    "reading a firm's agreements",
    async (mynt) => {
      if (!(await hasTool(mynt, "list_agreement_templates"))) return NOT_YET;
      const [templates, agreements, licences] = await Promise.all([
        callStudioTool(mynt, "list_agreement_templates", { include_retired: true }),
        callStudioTool(mynt, "list_app_agreements", {}),
        callStudioTool(mynt, "list_my_licenses", {}).catch(() => null),
      ]);
      const t = fromTemplates(templates);
      const lics = (licences && typeof licences === "object" && Array.isArray((licences as { licences?: unknown }).licences) ? (licences as { licences: Record<string, unknown>[] }).licences : [])
        .filter((l) => typeof l?.id === "string")
        .map((l) => ({ id: l.id as string, label: [l.license_id, l.registration_number, l.jurisdiction].filter((x) => typeof x === "string" && x).join(" · ") || "Licence" }));
      return json({ configured: t?.configured ?? false, testMode: t?.testMode ?? null, templates: t?.templates ?? [], agreements: fromFirmAgreements(agreements) ?? [], licences: lics });
    },
    true,
  );
}
