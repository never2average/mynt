import { ProductActionRequest, ProductId, testSummary } from "@/lib/products";
import { fromPromotionChecks, STAGE_NAMES } from "@/lib/promotions";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// A product's stage, as an app's: GET ?to=staging|production is Mynt's checks for moving it there
// (get_product_promotion_checks), for the approval sheet. POST is the sheet's actions: Test (test_product),
// Move to staging or production (promote_product), Move back (demote_product, with a reason), and Publish
// (publish_product) for older callers. Mynt checks everything again and may refuse (untested, failing
// checks, no licence or sponsorship covering it): its reason comes back in its own words.
export async function GET(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  const id = ProductId.safeParse((await params).productId);
  const to = new URL(req.url).searchParams.get("to");
  if (!id.success || (to !== "staging" && to !== "production")) return json({ error: "bad_request", message: "Move to staging or production." }, 400);
  const productId = id.data;
  return asDeveloper("loading a product's checks", async (mynt) => {
    const checks = fromPromotionChecks(await callStudioTool(mynt, "get_product_promotion_checks", { product_id: productId, to_stage: to }), to);
    if (!checks) return json({ error: "unreadable", message: "Mynt's checks weren't readable. Please try again." }, 502);
    return json({ checks });
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ productId: string }> }) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const id = ProductId.safeParse((await params).productId);
  const body = ProductActionRequest.safeParse(await req.json().catch(() => null));
  if (!id.success || !body.success) return json({ error: "bad_request", message: "Check what you entered." }, 400);
  const productId = id.data;
  const change = body.data;
  if (change.action === "test")
    return asDeveloper("testing a product", async (mynt) => json(testSummary(await callStudioTool(mynt, "test_product", { id: productId }))));
  if (change.action === "promote")
    return asDeveloper("moving a product up a stage", async (mynt) => {
      await callStudioTool(mynt, "promote_product", { product_id: productId, to_stage: change.to_stage });
      return json({ ok: true, stage: change.to_stage, message: change.to_stage === "staging" ? "Moved to Staging. Apps in the sandbox can build on it now." : "Moved to Production. Apps can build on it and go live with it now." });
    });
  if (change.action === "demote")
    return asDeveloper("moving a product back a stage", async (mynt) => {
      await callStudioTool(mynt, "demote_product", { product_id: productId, to_stage: change.to_stage, reason: change.reason });
      return json({ ok: true, stage: change.to_stage, message: `Moved back to ${STAGE_NAMES[change.to_stage]}.` });
    });
  return asDeveloper("publishing a product", async (mynt) => {
    await callStudioTool(mynt, "publish_product", { id: productId });
    return json({ published: true, stage: "production", message: "Published. You can build on it now." });
  });
}
