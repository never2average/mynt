import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { appUrlWithPath, safeReturnPath } from "./return-path";
import type { RouteDeps } from "./routes";
import type { AuthSession } from "./types";

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// GET /api/auth/callback. The authorization server sends the browser back here with ?code&state.
// The SDK exchanges the code (with the session's PKCE verifier) for tokens, which stay in the
// server-side session.
export function callbackRoute<S extends AuthSession>({ config, sessions, sessionStore }: RouteDeps<S>) {
  return async function GET(req: NextRequest) {
    const fail = (reason: string) => NextResponse.redirect(appUrlWithPath(config.appUrl(), `${config.authErrorPath?.() ?? "/"}?auth_error=${encodeURIComponent(reason)}`));
    const session = await sessions.currentSession();
    if (!session) return fail("session");

    const params = req.nextUrl.searchParams;
    const expected = session.oauthState;
    session.oauthState = undefined; // single use
    await sessionStore().save(session);
    if (params.get("error")) return fail("denied");
    if (!sameState(expected, params.get("state"))) return fail("state");
    const code = params.get("code");
    if (!code) return fail("code");

    const provider = sessions.oauthProviderFor(session);
    try {
      const result = await auth(provider, { serverUrl: config.myntMcpUrl(), authorizationCode: code, scope: config.oauthScope() });
      if (result !== "AUTHORIZED") return fail("exchange");
    } catch (err) {
      console.error("sign-in could not finish:", err instanceof Error ? err.message : err);
      return fail("exchange");
    } finally {
      session.codeVerifier = undefined;
    }
    // A fresh session id and fresh app state for the signed-in user: a cookie planted before
    // sign-in stops working, and nobody inherits what an earlier user left on this device.
    const back = safeReturnPath(session.returnTo, config.appUrl()); // checked again: it came from the store
    const signedIn = await sessionStore().rotate(session);
    const res = NextResponse.redirect(appUrlWithPath(config.appUrl(), back));
    sessions.setSessionCookie(res, signedIn);
    return res;
  };
}
