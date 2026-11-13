import { fromLicences } from "@/lib/compliance";
import { complianceRead } from "@/lib/compliance-server";

export const dynamic = "force-dynamic";

// Licences: the partner licences behind the selected workspace's products
// (list_workspace_licences). The page searches and filters them itself.
export async function GET(req: Request) {
  return complianceRead(req, "list_workspace_licences", "loading licences", (reply) => ({ licences: fromLicences(reply) }));
}
