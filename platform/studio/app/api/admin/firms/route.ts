import { firmsFrom, regulatedFirmsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Firms: every registered firm with its members (and their roles) and licences (list_entities). Firms are
// added by hand by Mynt's admins: Register regulated firm (register_firm), with no members yet. Each regulated firm
// also carries its onboarding progress (get_regulated_firm_onboarding { all_firms }).
export async function GET() {
  return asAdmin("reading the firms", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_entities"))) return json(UNSUPPORTED);
    const firms = firmsFrom(await callAdminTool(mynt, session, "list_entities", {}));
    if (!firms) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    // Each regulated firm's onboarding progress (the Onboarding column); a Mynt without it leaves the column unknown.
    const regulated = (await hasTools(mynt, "get_regulated_firm_onboarding")) ? regulatedFirmsFrom(await callAdminTool(mynt, session, "get_regulated_firm_onboarding", { all_firms: true })) : null;
    if (!regulated) return json({ firms });
    const byId = new Map(regulated.map((r) => [r.entityId, r]));
    return json({ firms: firms.map((f) => ({ ...f, onboarding: byId.get(f.id) ?? null })) });
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, ADMIN_TOOLS.register_firm);
  if (!w.ok) return w.res;
  return asAdmin("registering a firm", async (mynt, session) => {
    const r = (await callAdminTool(mynt, session, "register_firm", w.body)) as { id?: string; name?: string } | null;
    return json({ ok: true, id: r?.id ?? null, message: `${r?.name ?? w.body.name} is registered, with no members yet. Invite its people next.` });
  });
}
