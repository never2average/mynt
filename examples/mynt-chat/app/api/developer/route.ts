import { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isDeveloper } from "@/lib/developer";
import { refreshRoles } from "@/lib/developer-server";
import { connectMynt, NotAllowedError, NotSignedInError } from "@/lib/mynt";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// What the developer console needs on load: signed in? and does the user's Mynt role include
// developer? Asked of Mynt (whoami) each time the page loads, so a newly granted role shows up.
export async function GET() {
  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ signedIn: false, developer: false }, { headers: noStore });
  let mynt: Client | undefined;
  try {
    mynt = await connectMynt(session);
    const roles = await refreshRoles(session, mynt);
    return NextResponse.json({ signedIn: true, developer: isDeveloper(roles), roles }, { headers: noStore });
  } catch (err) {
    if (err instanceof NotSignedInError) return NextResponse.json({ signedIn: false, developer: false }, { headers: noStore });
    if (err instanceof NotAllowedError) {
      return NextResponse.json({ signedIn: true, developer: false, error: err.message }, { status: 403, headers: noStore });
    }
    console.error("developer: whoami failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ signedIn: true, developer: false, error: "Couldn't reach Mynt. Please try again." }, { status: 502, headers: noStore });
  } finally {
    await mynt?.close().catch(() => undefined);
  }
}
