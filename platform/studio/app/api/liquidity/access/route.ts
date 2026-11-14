import { sessionAccess } from "@/lib/liquidity-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Which liquidity roles the user has, for the sidebar's Liquidity entry and the header wallet control's
// links. Roles come from Mynt's whoami, read again every few minutes; Mynt checks every call.
export async function GET() {
  return asDeveloper("reading liquidity roles", async (_mynt, session) => json({ access: sessionAccess(session) }), () => true);
}
