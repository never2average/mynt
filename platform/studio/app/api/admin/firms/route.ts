import { firmsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Firms: every registered firm with its members (and their roles) and licences (list_entities). Firms are
// added by hand by Mynt's admins: Register firm (register_firm), with no members yet.
export async function GET() {
  return asAdmin("reading the firms", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_entities"))) return json(UNSUPPORTED);
    const firms = firmsFrom(await callAdminTool(mynt, session, "list_entities", {}));
    return firms ? json({ firms }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
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
