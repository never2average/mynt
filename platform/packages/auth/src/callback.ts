import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { appUrlWithPath, safeReturnPath } from "./return-path";
import type { RouteDeps } from "./routes";
import type { AuthSession } from "./types";

// What the authorization server's ?error means for the person: they declined (access_denied), or sign-in is set up
// wrongly on Mynt's side (an unknown scope, client, request...), which only an admin can fix. The code and a short,
// cleaned description go to the server's log for that admin; state and code never do.
export function authorizationError(params: URLSearchParams): "denied" | "config" {
  const error = params.get("error") ?? "";
  if (error === "access_denied") return "denied";
  const clean = (v: string | null, max: number) => (v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, max);
  console.error(`sign-in refused by the authorization server: ${clean(error, 64)}${params.get("error_description") ? `: ${clean(params.get("error_description"), 300)}` : ""}`);
  return "config";
}

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
    if (params.get("error")) return fail(authorizationError(params));
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
