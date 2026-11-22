import { ProductActionRequest, ProductId, testSummary } from "@/lib/products";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// A draft's row actions on New app: Test (test_product, whose report says whether it may be published)
// and Publish (publish_product). Mynt may refuse to publish (untested, failing checks, no licence or
// sponsorship covering it): its reason comes back in its own words.
export async function POST(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const id = ProductId.safeParse((await params).productId);
  const body = ProductActionRequest.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success) return json({ error: "bad_request", message: "Check what you entered." }, 400);
  const productId = id.data;
  if (body.data.action === "test")
    return asDeveloper("testing a product", async (mynt) => json(testSummary(await callStudioTool(mynt, "test_product", { id: productId }))));
  return asDeveloper("publishing a product", async (mynt) => {
    await callStudioTool(mynt, "publish_product", { id: productId });
    return json({ published: true, message: "Published. You can build on it now." });
  });
}
