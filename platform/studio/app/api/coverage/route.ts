import { fromCoverage } from "@/lib/compliance";
import { complianceRead } from "@/lib/compliance-server";

export const dynamic = "force-dynamic";

// Coverage: each US state's status for the selected workspace, with its partners, licences,
// products and rails (get_compliance_coverage).
export async function GET(req: Request) {
  return complianceRead(req, "get_compliance_coverage", "loading coverage", (reply) => ({ coverage: fromCoverage(reply) }));
}
