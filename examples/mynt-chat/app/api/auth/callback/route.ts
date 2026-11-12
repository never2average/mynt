import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { appUrl, myntMcpUrl, oauthScope } from "@/lib/config";
import { currentSession, oauthProviderFor, setSessionCookie } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";

export const dynamic = "force-dynamic";

function sameState(a: string | undefined, b: string | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// The authorization server sends the browser back here with ?code&state. The SDK exchanges the
// code (with the session's PKCE verifier) for tokens, which stay in the server-side session.
export async function GET(req: NextRequest) {
  const fail = (reason: string) => NextResponse.redirect(new URL(`/?auth_error=${reason}`, appUrl()));
  const session = await currentSession();
  if (!session) return fail("session");

  const params = req.nextUrl.searchParams;
  const expected = session.oauthState;
  session.oauthState = undefined; // single use
  await sessionStore().save(session);
  if (params.get("error")) return fail("denied");
  if (!sameState(expected, params.get("state"))) return fail("state");
  const code = params.get("code");
  if (!code) return fail("code");

  const provider = oauthProviderFor(session);
  try {
    const result = await auth(provider, { serverUrl: myntMcpUrl(), authorizationCode: code, scope: oauthScope() });
    if (result !== "AUTHORIZED") return fail("exchange");
  } catch (err) {
    console.error("sign-in could not finish:", err instanceof Error ? err.message : err);
    return fail("exchange");
  } finally {
    session.codeVerifier = undefined;
  }
  // A fresh session id and fresh app state for the signed-in user: a cookie planted before
  // sign-in stops working, and nobody inherits what an earlier user left on this device.
  const signedIn = await sessionStore().rotate(session);
  const res = NextResponse.redirect(new URL("/", appUrl()));
  setSessionCookie(res, signedIn);
  return res;
}
