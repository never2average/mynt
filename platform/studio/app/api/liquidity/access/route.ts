import { sessionAccess } from "@/lib/liquidity-server";
import { ownerOf } from "@/lib/wallets-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Which liquidity roles the user has, for the sidebar's Liquidity entry and the header wallet control's
// links, and the dashboard's Builder / Investor switch. Roles come from Mynt's whoami, read again
// every few minutes; Mynt checks every call. `owner` is an opaque hash of the user, so a choice
// remembered in this browser is the user's own.
export async function GET() {
  return asDeveloper("reading liquidity roles", async (_mynt, session) => json({ access: sessionAccess(session), owner: ownerOf(session) }), () => true);
}
