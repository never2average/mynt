import { licencesFrom, type AdminLicence } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "verified", "rejected", "suspended"] as const;

// Admin → Licences: every licence firms registered, in each review status (list_license_reviews), pending first.
export async function GET() {
  return asAdmin("reading the licences", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_license_reviews"))) return json(UNSUPPORTED);
    const licences: AdminLicence[] = [];
    for (const status of STATUSES) licences.push(...(licencesFrom(await callAdminTool(mynt, session, "list_license_reviews", { status })) ?? []));
    return json({ licences });
  });
}
