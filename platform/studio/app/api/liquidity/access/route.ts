import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { sessionAccess } from "@/lib/liquidity-server";
import { isLicenceProvider } from "@/lib/lp-agreements";
import { ownerOf } from "@/lib/wallets-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { callStudioTool, isAuthError, sessionIsDeveloper } from "@/lib/studio-server";
import type { Session } from "@/lib/session-store";
import { isVendor } from "@/lib/vendor-area";
import { grantedLicenceProvider } from "@/lib/firm-server";

export const dynamic = "force-dynamic";

// Whether the account was given the vendor role (the sidebar's My services). An admin's roles imply it without a firm
// of services, so for an admin it's the role Mynt granted (whoami's roles), not the ones it implies.
async function grantedVendor(mynt: Client, session: Session): Promise<boolean> {
  const roles = session.roles ?? [];
  if (!isVendor(roles)) return false;
  if (!roles.includes("admin")) return true;
  try {
    const who = (await callStudioTool(mynt, "whoami")) as { roles?: unknown } | null;
    return Array.isArray(who?.roles) && who.roles.includes("vendor");
  } catch (err) {
    if (isAuthError(err)) throw err;
    return false;
  }
}

// Which liquidity roles the user has, for the sidebar's Liquidity entry and the header wallet control's
// links, and the dashboard's Builder / Investor switch; and whether they're a licence provider (the
// Licences page's Agreements tab). Roles come from Mynt's whoami, read again every few minutes; Mynt
// checks every call. `admin`: a Mynt admin (the sidebar's Admin group). `vendor`: a service provider (the sidebar's
// My services). `firm`: a regulated firm's own licence provider (the sidebar's My firm). `owner` is an opaque hash of the user, so a choice remembered in this browser is the user's own.
export async function GET() {
  return asDeveloper(
    "reading liquidity roles",
    async (mynt, session) =>
      json({
        access: sessionAccess(session),
        developer: sessionIsDeveloper(session),
        licenceProvider: isLicenceProvider(session.roles ?? []),
        admin: (session.roles ?? []).includes("admin"),
        vendor: await grantedVendor(mynt, session),
        // My firm in the sidebar: the licence-provider role as granted (an admin's roles only imply it).
        firm: await grantedLicenceProvider(mynt, session),
        owner: ownerOf(session),
      }),
    () => true,
  );
}
