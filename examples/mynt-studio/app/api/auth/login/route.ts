import { NextResponse } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { appUrl, myntMcpUrl, oauthScope } from "@/lib/config";
import { currentOrNewSession, oauthProviderFor, setSessionCookie } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";

export const dynamic = "force-dynamic";

// Starts sign-in: the MCP SDK discovers Mynt's authorization server from its OAuth metadata,
// registers this app if it hasn't yet (dynamic client registration), makes a PKCE verifier
// (kept in the server-side session) and gives us the URL to send the browser to.
//
// A GET, so another site can link here; it never signs anyone out. Someone already signed in
// just goes back to the app (to switch accounts, sign out first).
export async function GET() {
  const { session } = await currentOrNewSession();
  if (session.tokens) return NextResponse.redirect(new URL("/", appUrl()));
  const provider = oauthProviderFor(session);
  let res: NextResponse;
  try {
    const result = await auth(provider, { serverUrl: myntMcpUrl(), scope: oauthScope() });
    res =
      result === "REDIRECT" && provider.authorizationUrl
        ? NextResponse.redirect(provider.authorizationUrl)
        : NextResponse.redirect(new URL("/", appUrl()));
  } catch (err) {
    console.error("sign-in could not start:", err instanceof Error ? err.message : err);
    res = NextResponse.redirect(new URL("/?auth_error=start", appUrl()));
  }
  setSessionCookie(res, session);
  await sessionStore().save(session); // its PKCE verifier and state, for the callback
  return res;
}
