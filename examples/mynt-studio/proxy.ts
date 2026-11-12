import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy } from "./lib/csp";
import { appUrlFor, clientAddress, loginAllowed, shouldGoToAppUrl, warnUntrustedEdgeOnce } from "./lib/rate-limit";
import { sessionStore } from "./lib/session-store";

// Runs before every page and API route:
// - sets the Content-Security-Policy, from PREVIEW_FRAME_SRC as the server sees it now (not
//   when the app was built), with a fresh script nonce per request. Next reads the policy from
//   the request headers and puts the nonce on its own scripts, so no inline script runs
//   without it. The other security headers are static (next.config.ts);
// - limits how often one address may start sign-in (lib/rate-limit.ts);
// - when the studio is served on Mynt's domain through Mynt's server (TRUSTED_EDGE_IPS is set),
//   sends anyone reaching its own deployment address directly to that domain: sign-in only
//   works on APP_URL, where its callback and cookie are. Requests through the edge carry its
//   X-Mynt-Client-IP; that header only decides this redirect (a caller adding it just stays on
//   the deployment address), never whom the rate limit counts, so a wrong TRUSTED_EDGE_IPS can't
//   turn every visit into a redirect loop.
export async function proxy(req: NextRequest) {
  if (shouldGoToAppUrl(req.headers, req.nextUrl.host)) {
    return NextResponse.redirect(appUrlFor(req.nextUrl.pathname, req.nextUrl.search), 308);
  }
  warnUntrustedEdgeOnce(req.headers);

  if (req.nextUrl.pathname === "/api/auth/login" && !(await loginAllowed(sessionStore(), clientAddress(req.headers)))) {
    return new NextResponse("Too many sign-in attempts. Please wait a few minutes and try again.", {
      status: 429,
      headers: { "Retry-After": "600", "Content-Type": "text/plain; charset=utf-8" },
    });
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

export const config = {
  // Pages and API routes; not Next's static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
