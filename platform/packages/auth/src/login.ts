import { NextResponse } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { RouteDeps } from "./routes";
import type { AuthSession } from "./types";

// GET /api/auth/login. Starts sign-in: the MCP SDK discovers Mynt's authorization server from its
// OAuth metadata, registers this app if it hasn't yet (dynamic client registration), makes a PKCE
// verifier (kept in the server-side session) and gives us the URL to send the browser to.
//
// A GET, so another site can link here; it never signs anyone out. Someone already signed in
// just goes back to the app (to switch accounts, sign out first).
export function loginRoute<S extends AuthSession>({ config, sessions, sessionStore }: RouteDeps<S>) {
  return async function GET() {
    const { session } = await sessions.currentOrNewSession();
    if (session.tokens) return NextResponse.redirect(new URL("/", config.appUrl()));
    const provider = sessions.oauthProviderFor(session);
    let res: NextResponse;
    try {
      const result = await auth(provider, { serverUrl: config.myntMcpUrl(), scope: config.oauthScope() });
      res =
        result === "REDIRECT" && provider.authorizationUrl
          ? NextResponse.redirect(provider.authorizationUrl)
          : NextResponse.redirect(new URL("/", config.appUrl()));
    } catch (err) {
      console.error("sign-in could not start:", err instanceof Error ? err.message : err);
      res = NextResponse.redirect(new URL("/?auth_error=start", config.appUrl()));
    }
    sessions.setSessionCookie(res, session);
    await sessionStore().save(session); // its PKCE verifier and state, for the callback
    return res;
  };
}
