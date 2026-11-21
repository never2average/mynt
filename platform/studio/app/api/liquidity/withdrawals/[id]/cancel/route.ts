import { sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

// Cancel one of the firm's withdrawal requests (cancel_withdrawal): it leaves the pool's queue.
// Mynt cancels only a queued or parked request, and whatever is already on its way carries on.
// The request is named by the path; the body is empty (or {}), nothing else.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { id } = await params;
  const text = await req.text().catch(() => "");
  let body: unknown = {};
  try {
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  const empty = typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 0;
  const parsed = STUDIO_TOOLS.cancel_withdrawal.safeParse({ withdrawal_id: id });
  if (!empty || !parsed.success) return json({ error: "bad_request", message: "Pick a withdrawal request to cancel." }, 400);

  return asDeveloper(
    "cancelling a withdrawal",
    async (mynt, session) => {
      if (!sessionAccess(session).liquidityProvider) return json({ error: "not_liquidity_provider", message: "Only a liquidity provider can cancel a withdrawal request." }, 403);
      if (!(await listMyntTools(mynt)).some((t) => t.name === "cancel_withdrawal")) return json({ error: "unsupported", message: "Cancelling a withdrawal request comes with Mynt's next update." }, 501);
      return json({ ok: true, withdrawal: await callStudioTool(mynt, "cancel_withdrawal", parsed.data) });
    },
    sessionCanUseLiquidity,
  );
}
