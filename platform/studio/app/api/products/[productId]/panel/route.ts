import { isProductTab } from "@/lib/product-panel";
import { loadProductTab, workspaceProduct } from "@/lib/product-panel-server";
import { ProductId } from "@/lib/products";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string }> };

// A financial product's workspace (/products/<id>), read-only. Without ?tab=: the product itself, for the
// header (its name, stage and whether it's archived). With ?tab=terms|customers|risk|compliance|integrations|
// apps|activity: that tab (lib/product-panel-server.ts), for this product only. Only the user's own products.
export async function GET(req: Request, { params }: Params) {
  const id = ProductId.safeParse((await params).productId);
  const tab = new URL(req.url).searchParams.get("tab");
  if (!id.success || (tab !== null && !isProductTab(tab))) return json({ error: "bad_request" }, 400);
  const productId = id.data;
  return asDeveloper(tab ? `loading a product's ${tab} tab` : "loading a product", async (mynt) => {
    const product = await workspaceProduct(mynt, productId);
    if (!product) return json({ error: "not_found", message: "That product isn't one of yours." }, 404);
    if (!tab) return json({ product });
    return json({ product, tab, data: await loadProductTab(mynt, product, tab) });
  });
}
