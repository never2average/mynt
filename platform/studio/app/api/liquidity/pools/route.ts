import { fromSponsorships } from "@/lib/liquidity";
import { sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Propose a pool (create_pool) on a sponsored component of the builder's firm's product. Mynt
// creates it paused, waiting for the sponsoring licence provider to approve it and name its rails.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = STUDIO_TOOLS.create_pool.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Check the pool's terms and try again." }, 400);
  const input = parsed.data;

  return asDeveloper(
    "proposing a pool",
    async (mynt, session) => {
      if (!sessionAccess(session).builder) return json({ error: "not_builder", message: "Only a product's builder can propose a pool for it." }, 403);
      const names = new Set((await listMyntTools(mynt)).map((t) => t.name));
      if (!names.has("create_pool") || !names.has("list_my_sponsorships")) return json({ error: "unsupported", message: "Proposing pools comes with Mynt's next update." }, 501);
      // Only on a component an approved licence provider sponsors (Mynt checks again).
      const { approved } = fromSponsorships(await callStudioTool(mynt, "list_my_sponsorships"));
      if (!approved.some((s) => s.productId === input.product_id && s.componentKey === input.component_key && (!input.sponsor_entity_id || s.sponsorId === input.sponsor_entity_id)))
        return json({ error: "not_sponsored", message: "That component has no approved sponsorship, so it can't have a pool: a licence provider must sponsor it first." }, 422);
      return json({ ok: true, pool: await callStudioTool(mynt, "create_pool", input) });
    },
    sessionCanUseLiquidity,
  );
}
