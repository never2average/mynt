import { sessionAccess } from "@/lib/liquidity-server";
import { isLicenceProvider } from "@/lib/lp-agreements";
import { ownerOf } from "@/lib/wallets-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { sessionIsDeveloper } from "@/lib/studio-server";

export const dynamic = "force-dynamic";

// Which liquidity roles the user has, for the sidebar's Liquidity entry and the header wallet control's
// links, and the dashboard's Builder / Investor switch; and whether they're a licence provider (the
// Licences page's Agreements tab). Roles come from Mynt's whoami, read again every few minutes; Mynt
// checks every call. `admin`: a Mynt admin (the sidebar's Admin group). `owner` is an opaque hash of the user, so a choice remembered in this browser is
// the user's own.
export async function GET() {
  return asDeveloper(
    "reading liquidity roles",
    async (_mynt, session) => json({ access: sessionAccess(session), developer: sessionIsDeveloper(session), licenceProvider: isLicenceProvider(session.roles ?? []), admin: (session.roles ?? []).includes("admin"), owner: ownerOf(session) }),
    () => true,
  );
}
