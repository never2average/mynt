import { NextResponse } from "next/server";
import { appUrlWithPath } from "./return-path";
import type { RouteDeps } from "./routes";
import type { AuthSession } from "./types";

// POST /api/auth/logout. POST only, so a link or image elsewhere can't sign the user out.
export function logoutRoute<S extends AuthSession>({ config, sessions, sessionStore }: RouteDeps<S>) {
  return async function POST(req: Request) {
    if (!sessions.fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
    const session = await sessions.currentSession();
    await sessionStore().destroy(session?.id);
    const res = NextResponse.redirect(appUrlWithPath(config.appUrl(), config.signedOutPath?.() ?? "/"), 303);
    sessions.clearSessionCookie(res);
    return res;
  };
}
