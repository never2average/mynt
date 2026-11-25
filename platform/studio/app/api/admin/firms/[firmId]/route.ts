import { adminOfferingsFrom, firmsFrom, productsFrom } from "@/lib/admin";
import { fromOnboarding } from "@/lib/firm-area";
import { hasTools, isUuid, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ firmId: string }> };

// Admin → Firms → one firm: its record, members and licences (list_entities), the offerings it lists as a vendor
// (list_vendor_offerings, every status), and the products it owns or sponsors (list_all_products). A part this Mynt
// can't answer yet is null, and the tab says so. And its onboarding as a regulated firm
// (get_regulated_firm_onboarding { entity_id }): the checklist, the real-company check and every register's answer. Never the firm's encrypted health books: admins can't read them.
export async function GET(_req: Request, { params }: Params) {
  const { firmId } = await params;
  if (!isUuid(firmId)) return json({ error: "bad_request" }, 400);
  return asAdmin("reading a firm", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_entities"))) return json(UNSUPPORTED);
    const firm = (firmsFrom(await callAdminTool(mynt, session, "list_entities", {})) ?? []).find((f) => f.id === firmId);
    if (!firm) return json({ error: "not_found", message: "There's no firm with that id." }, 404);
    const offerings = (await hasTools(mynt, "list_vendor_offerings"))
      ? (adminOfferingsFrom(await callAdminTool(mynt, session, "list_vendor_offerings", { include_unlisted: true })) ?? []).filter((o) => o.vendorEntityId === firmId)
      : null;
    const all = (await hasTools(mynt, "list_all_products")) ? productsFrom(await callAdminTool(mynt, session, "list_all_products", { limit: 500, include_archived: true })) : null;
    const products = all ? all.rows.filter((p) => p.firm?.id === firmId || p.sponsors.some((s) => s.entityId === firmId)) : null;
    // Its onboarding towards sponsoring, with the real-company check and the registers' answers so far.
    const onboarding = (await hasTools(mynt, "get_regulated_firm_onboarding")) ? fromOnboarding(await callAdminTool(mynt, session, "get_regulated_firm_onboarding", { entity_id: firmId })) : null;
    return json({ firm, offerings, products, onboarding });
  });
}
