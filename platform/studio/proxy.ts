import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./lib/csp";
import { appUrlFor, clientAddress, loginAllowed, shouldGoToAppUrl, warnUntrustedEdgeOnce } from "./lib/rate-limit";
import { pageNeedsSignIn, signInPathFor } from "./lib/page-gate";
import { sessionCookieName } from "./lib/session";
import { sessionStore } from "./lib/session-store";

// Runs before every page and API route:
// - sets the Content-Security-Policy, from PREVIEW_FRAME_SRC as the server sees it now (not
//   when the app was built), with a fresh script nonce per request. Next reads the policy from
//   the request headers and puts the nonce on its own scripts, so no inline script runs
//   without it. The other security headers are static (next.config.ts);
// - limits how often one address may start sign-in (lib/rate-limit.ts);
// - when the studio is served on Mynt's domain through Mynt's server (TRUSTED_EDGE_IPS is set),
//   is reachable only through that server: every other caller is sent to APP_URL, for every
//   path (lib/rate-limit.ts, shouldGoToAppUrl); a request carrying X-Mynt-Client-IP from an
//   address not in TRUSTED_EDGE_IPS is served with a warning instead, so a missing server
//   address can't loop its users;
// - sends a visit to any page without a signed-in session straight to sign-in, which comes
//   back to that page afterwards (lib/page-gate.ts).
export async function proxy(req: NextRequest) {
  // Before the redirect, so a server address missing from TRUSTED_EDGE_IPS is named in the logs.
  warnUntrustedEdgeOnce(req.headers);
  if (shouldGoToAppUrl(req.headers)) {
    return NextResponse.redirect(appUrlFor(req.nextUrl.pathname, req.nextUrl.search), 308);
  }

  if (req.nextUrl.pathname === "/api/auth/login" && !(await loginAllowed(sessionStore(), clientAddress(req.headers)))) {
    return new NextResponse("Too many sign-in attempts. Please wait a few minutes and try again.", {
      status: 429,
      headers: { "Retry-After": "600", "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (pageNeedsSignIn(req.nextUrl.pathname) && !(await signedIn(req))) {
    const to = signInPathFor(req.nextUrl.pathname, req.nextUrl.search);
    return NextResponse.redirect(appUrlFor(to.pathname, to.search), 307);
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = contentSecurityPolicy(process.env.PREVIEW_FRAME_SRC, process.env.NODE_ENV !== "production", nonce);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);
  return res;
}

// Whether the request's session cookie names a signed-in session.
async function signedIn(req: NextRequest): Promise<boolean> {
  const id = req.cookies.get(sessionCookieName())?.value;
  if (!id) return false;
  const session = await sessionStore().get(id);
  return Boolean(session?.tokens);
}

// Every path, Next's own assets included, so the deployment address serves nothing directly
// once the studio is on Mynt's domain.
export const config = {
  matcher: ["/:path*"],
};
