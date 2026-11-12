import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { appUrl, oauthRedirectUrl, oauthScope, secureCookies } from "./config";
import { SessionOAuthProvider } from "./oauth-provider";
import { SESSION_COOKIE } from "./app-session";
import { sessionStore, type Session } from "./session-store";

// Over https the cookie is __Host- prefixed: the browser then only accepts it Secure, for path
// "/" and with no Domain, so no other host (a sibling subdomain included) can set or read it.
// Plain http on localhost can't carry a Secure cookie, so local development uses the bare name.
export function sessionCookieName(): string {
  return secureCookies() ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

export async function currentSession(): Promise<Session | undefined> {
  const jar = await cookies();
  return sessionStore().get(jar.get(sessionCookieName())?.value);
}

export async function currentOrNewSession(): Promise<{ session: Session; isNew: boolean }> {
  const existing = await currentSession();
  if (existing) return { session: existing, isNew: false };
  return { session: sessionStore().create(), isNew: true };
}

export function setSessionCookie(res: NextResponse, session: Session): void {
  res.cookies.set(sessionCookieName(), session.id, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "lax", // sent on the top-level redirect back from the authorization server
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(sessionCookieName(), "", { httpOnly: true, secure: secureCookies(), sameSite: "lax", path: "/", maxAge: 0 });
}

// State-changing requests must come from this app's own pages. SameSite=Lax already keeps the
// cookie off cross-site POSTs; this also rejects a request whose Origin is someone else's.
export function fromOwnOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  return origin === null || origin === appUrl().origin;
}

export function oauthProviderFor(session: Session): SessionOAuthProvider {
  return new SessionOAuthProvider(session, sessionStore(), oauthRedirectUrl(), oauthScope());
}
