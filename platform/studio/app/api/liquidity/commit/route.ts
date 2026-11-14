import { sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Commit capital to a pool (commit_to_pool): Mynt asks for a deposit on the pool's approved rail.
// Nothing moves here: the sponsor moves the money on that rail and reports when it settles, and
// the position counts it only then. Mynt refuses real money until the pool's offering is cleared.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = STUDIO_TOOLS.commit_to_pool.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Enter an amount, and the US state your capital moves from." }, 400);

  return asDeveloper(
    "committing to a pool",
    async (mynt, session) => {
      if (!sessionAccess(session).liquidityProvider) return json({ error: "not_liquidity_provider", message: "Only a liquidity provider can commit capital." }, 403);
      if (!(await listMyntTools(mynt)).some((t) => t.name === "commit_to_pool")) return json({ error: "unsupported", message: "Committing capital comes with Mynt's next update." }, 501);
      return json({ ok: true, commitment: await callStudioTool(mynt, "commit_to_pool", parsed.data) });
    },
    sessionCanUseLiquidity,
  );
}
