import { lpAgreementsFrom, isLicenceProvider } from "@/lib/lp-agreements";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The Licences page's Agreements tab: the agreements apps' workspaces proposed to or made with the signed-in licence
// provider's firm (list_app_agreements without app_id). Licence providers only; Mynt answers only for their own firm.
export async function GET() {
  return asDeveloper(
    "reading the firm's app agreements",
    async (mynt) => {
      if (!(await listMyntTools(mynt)).some((t) => t.name === "list_app_agreements")) return json({ error: "unsupported", message: "Agreements come with Mynt's next update." }, 501);
      const rows = lpAgreementsFrom(await callStudioTool(mynt, "list_app_agreements", {}));
      if (!rows) return json({ error: "unreadable", message: "Mynt didn't answer with your firm's agreements." }, 502);
      return json({ agreements: rows });
    },
    (session) => isLicenceProvider(session.roles ?? []),
  );
}
