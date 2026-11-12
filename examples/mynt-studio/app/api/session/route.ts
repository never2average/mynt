import { NextResponse } from "next/server";
import { currentSession, setSessionCookie } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";

export const dynamic = "force-dynamic";

// Whether the browser is signed in. Never includes tokens. When reading the session moved its
// expiry, the cookie is sent again with the new expiry.
export async function GET() {
  const session = await currentSession();
  const signedIn = Boolean(session?.tokens);
  const res = NextResponse.json({ signedIn }, { headers: { "Cache-Control": "no-store" } });
  if (session && signedIn && sessionStore().wasTouched(session)) setSessionCookie(res, session);
  return res;
}
