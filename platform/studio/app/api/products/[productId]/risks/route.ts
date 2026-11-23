import { workspaceProduct } from "@/lib/product-panel-server";
import { ProductId } from "@/lib/products";
import { applyRiskChange, NO_REGISTER_YET, RiskChangeRequest } from "@/lib/risk-register-server";
import { fromOwnOrigin } from "@/lib/session";
import { listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string }> };

// POST: the product Risk tab's Add risk and Review risk sheets, for this product's risk register. Same origin and a
// signed-in developer only; the product must be one Mynt lists as theirs, and Mynt checks the rest again (only the
// product's own firm keeps it; its sponsors read it), its refusal coming back as the message.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const id = ProductId.safeParse((await params).productId);
  if (!id.success) return json({ error: "bad_request" }, 400);
  const parsed = RiskChangeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That risk isn't valid." }, 400);
  return asDeveloper(parsed.data.action === "add" ? "adding a product risk" : "reviewing a product risk", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === (parsed.data.action === "add" ? "add_risk" : "update_risk"))) return json({ error: "unsupported", message: NO_REGISTER_YET }, 501);
    const product = await workspaceProduct(mynt, id.data);
    if (!product) return json({ error: "not_found", message: "That product isn't one of yours." }, 404);
    return json({ ok: true, message: await applyRiskChange(mynt, { type: "product", id: product.id }, parsed.data) });
  });
}
