import { NextResponse } from "next/server";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

// Whether the browser is signed in. Never includes tokens.
export async function GET() {
  const session = await currentSession();
  return NextResponse.json({ signedIn: Boolean(session?.tokens) }, { headers: { "Cache-Control": "no-store" } });
}
