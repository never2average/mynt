import { NextResponse } from "next/server";
import { currentSession, setSessionCookie } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";
import { ownerOf } from "@/lib/wallets-server";

export const dynamic = "force-dynamic";

// Whether the browser is signed in, and as whom. Never includes tokens. When reading the session moved its
// expiry, the cookie is sent again with the new expiry.
export async function GET() {
  const session = await currentSession();
  const signedIn = Boolean(session?.tokens);
  // The account menu's name and email, as Mynt's whoami gave them (read when roles are).
  const res = NextResponse.json(
    {
      signedIn,
      name: signedIn ? (session?.name ?? null) : null,
      email: signedIn ? (session?.email ?? null) : null,
      // Whose Earn chats in this browser are this user's: the same hash of the user Earn keeps them under
      // (lib/wallets-server.ts ownerOf), so the sidebar's Search chats lists them. Never the name or email.
      historyOwner: signedIn && session ? ownerOf(session) : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
  if (session && signedIn && sessionStore().wasTouched(session)) setSessionCookie(res, session);
  return res;
}
