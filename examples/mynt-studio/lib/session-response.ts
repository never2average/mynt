import type { NextResponse } from "next/server";
import { setSessionCookie } from "./session";
import { sessionStore, type Session } from "./session-store";
import { logLine } from "./studio-server";

// The end of a request that used the session: save it (a session signed out meanwhile stays
// signed out), and when its server-side expiry moved, send the cookie again so the browser's
// expiry moves too ("7 days without use" holds for both).
export async function finishSession(res: NextResponse, session: Session): Promise<NextResponse> {
  const store = sessionStore();
  let saved = false;
  try {
    saved = await store.save(session);
  } catch (err) {
    console.error(logLine("saving the session", err));
  }
  if (saved && session.tokens && store.wasTouched(session)) setSessionCookie(res, session);
  return res;
}
