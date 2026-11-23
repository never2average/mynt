import { productsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Products: every financial product across firms (list_all_products), archived ones too, the newest 500.
export async function GET() {
  return asAdmin("reading every product", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_all_products"))) return json(UNSUPPORTED);
    const page = productsFrom(await callAdminTool(mynt, session, "list_all_products", { limit: 500, include_archived: true }));
    return page ? json({ products: page.rows, total: page.total }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
