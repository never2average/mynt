import { loadLiquidity, sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The /liquidity page: the builder's pools and, for a liquidity provider, the pools open to it,
// its positions and its withdrawal requests (lib/liquidity-server.ts).
export async function GET() {
  return asDeveloper("loading liquidity", async (mynt, session) => json(await loadLiquidity(mynt, sessionAccess(session))), sessionCanUseLiquidity);
}
