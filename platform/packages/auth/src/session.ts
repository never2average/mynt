import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { SessionOAuthProvider } from "./oauth-provider";
import type { AuthApp, AuthSession } from "./types";

// The session cookie and the session behind it, for one app's settings and store.
export function createSessions<S extends AuthSession>(app: AuthApp<S>) {
  const { config } = app;

  // Over https the cookie is __Host- prefixed: the browser then only accepts it Secure, for path
  // "/" and with no Domain, so no other host (a sibling subdomain included) can set or read it.
  // Plain http on localhost can't carry a Secure cookie, so local development uses the bare name.
  function sessionCookieName(): string {
    return config.secureCookies() ? `__Host-${app.sessionCookie}` : app.sessionCookie;
  }

  async function currentSession(): Promise<S | undefined> {
    const jar = await cookies();
    return app.sessionStore().get(jar.get(sessionCookieName())?.value);
  }

  async function currentOrNewSession(): Promise<{ session: S; isNew: boolean }> {
    const existing = await currentSession();
    if (existing) return { session: existing, isNew: false };
    return { session: app.sessionStore().create(), isNew: true };
  }

  function setSessionCookie(res: NextResponse, session: S): void {
    res.cookies.set(sessionCookieName(), session.id, {
      httpOnly: true,
      secure: config.secureCookies(),
      sameSite: "lax", // sent on the top-level redirect back from the authorization server
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  }

  function clearSessionCookie(res: NextResponse): void {
    res.cookies.set(sessionCookieName(), "", { httpOnly: true, secure: config.secureCookies(), sameSite: "lax", path: "/", maxAge: 0 });
  }

  // State-changing requests must come from this app's own pages. SameSite=Lax already keeps the
  // cookie off cross-site POSTs; this also rejects a request whose Origin is someone else's.
  function fromOwnOrigin(req: Request): boolean {
    const origin = req.headers.get("origin");
    return origin === null || origin === config.appUrl().origin;
  }

  function oauthProviderFor(session: S): SessionOAuthProvider<S> {
    return new SessionOAuthProvider(
      session,
      app.sessionStore(),
      config.oauthRedirectUrl(),
      config.oauthScope(),
      config.oauthClientName(),
      config.oauthClient?.() ?? null,
    );
  }

  return { sessionCookieName, currentSession, currentOrNewSession, setSessionCookie, clearSessionCookie, fromOwnOrigin, oauthProviderFor };
}

export type Sessions<S extends AuthSession> = ReturnType<typeof createSessions<S>>;
