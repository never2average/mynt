import { serviceTypesFrom } from "@/lib/admin";
import { writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Vendors → Add service type (define_service_type): a new standard service in a region, with its input and
// output JSON Schemas. Only new ones: define_service_type replaces one with the same key, so a key the region already
// has is refused here (changing one stays with the MCP tool, where its every field is set).
export async function POST(req: Request) {
  const w = await writeBody(req, ADMIN_TOOLS.define_service_type);
  if (!w.ok) return w.res;
  const t = w.body.service_type;
  return asAdmin("adding a service type", async (mynt, session) => {
    const existing = serviceTypesFrom(await callAdminTool(mynt, session, "list_service_types", { region: t.region })) ?? [];
    if (existing.some((x) => x.key === t.key)) return json({ error: "exists", message: `${t.region} already has a service type '${t.key}'. Choose another key.` }, 409);
    await callAdminTool(mynt, session, "define_service_type", w.body);
    return json({ ok: true, message: `${t.name} (${t.region}/${t.key}) is added. Vendors can now offer it.` });
  });
}
