import { z } from "zod";
import { workspaceProduct } from "@/lib/product-panel-server";
import { ProductId } from "@/lib/products";
import type { RiskDetailData } from "@/lib/risk-detail";
import { applyRiskDetailChange, loadRiskDetail, NO_DETAIL_YET, RiskDetailChangeRequest, type Call } from "@/lib/risk-detail-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string; riskId: string }> };
const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

// One risk on this product's register, in full (the product Risk tab's risk detail). GET: get_risk, only when the
// risk is on this product's register, with what the Link item picker can offer (the product itself). POST: one of
// the detail's labelled actions (lib/risk-detail-server.ts), for this risk and nothing else. Same origin and a
// signed-in developer only; the product must be one Mynt lists as theirs, and Mynt checks the rest again (only the
// product's own firm changes it; its sponsors read it), its refusal the message.
async function ready(mynt: Parameters<Parameters<typeof asDeveloper>[1]>[0], productId: string, riskId: string) {
  if (!(await listMyntTools(mynt)).some((t) => t.name === "get_risk")) return { ok: false, res: json({ error: "unsupported", message: NO_DETAIL_YET }, 501) } as const;
  const product = await workspaceProduct(mynt, productId);
  if (!product) return { ok: false, res: json({ error: "not_found", message: "That product isn't one of yours." }, 404) } as const;
  const call: Call = (tool, args) => callStudioTool(mynt, tool, args);
  const detail = await loadRiskDetail(call, riskId, { type: "product", id: product.id });
  if (!detail) return { ok: false, res: json({ error: "not_found", message: "That risk isn't on this product's register." }, 404) } as const;
  return { ok: true, product, call, detail } as const;
}

export async function GET(_req: Request, { params }: Params) {
  const { productId, riskId } = await params;
  const id = ProductId.safeParse(productId);
  if (!id.success || !isUuid(riskId)) return json({ error: "bad_request" }, 400);
  return asDeveloper("reading a product risk", async (mynt) => {
    const r = await ready(mynt, id.data, riskId);
    if (!r.ok) return r.res;
    // A product's risks and tasks are owned by whoever adds them unless Mynt is told otherwise: its firm isn't listed here.
    const data: RiskDetailData = { detail: r.detail, owners: [], linkChoices: { product: [{ id: r.product.id, name: r.product.name }] } };
    return json(data);
  });
}

export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { productId, riskId } = await params;
  const id = ProductId.safeParse(productId);
  if (!id.success || !isUuid(riskId)) return json({ error: "bad_request" }, 400);
  const parsed = RiskDetailChangeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That change isn't valid." }, 400);
  return asDeveloper("changing a product risk", async (mynt) => {
    const r = await ready(mynt, id.data, riskId);
    if (!r.ok) return r.res;
    return json({ ok: true, message: await applyRiskDetailChange(r.call, riskId, parsed.data) });
  });
}
