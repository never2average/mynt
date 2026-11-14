import { sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Ask for capital back (request_withdrawal): the request joins the pool's first-in-first-out
// queue, is paid no sooner than the pool's notice period, and only as far as the latest verified
// health snapshot keeps the pool above its minimum reserve.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = STUDIO_TOOLS.request_withdrawal.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Enter an amount to withdraw." }, 400);

  return asDeveloper(
    "requesting a withdrawal",
    async (mynt, session) => {
      if (!sessionAccess(session).liquidityProvider) return json({ error: "not_liquidity_provider", message: "Only a liquidity provider can withdraw capital." }, 403);
      if (!(await listMyntTools(mynt)).some((t) => t.name === "request_withdrawal")) return json({ error: "unsupported", message: "Withdrawals come with Mynt's next update." }, 501);
      return json({ ok: true, withdrawal: await callStudioTool(mynt, "request_withdrawal", parsed.data) });
    },
    sessionCanUseLiquidity,
  );
}
