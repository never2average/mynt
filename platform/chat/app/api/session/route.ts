import { NextResponse } from "next/server";
import { currentSession } from "@/lib/session";
import { visibleItems } from "@/lib/transcript";

export const dynamic = "force-dynamic";

// What the page needs on load: whether the user is signed in, the chat so far, and which of
// its cards and requests were already acted on (so their buttons stay done after a reload).
// Never includes tokens.
export async function GET() {
  const session = await currentSession();
  const signedIn = Boolean(session?.tokens);
  return NextResponse.json(
    {
      signedIn,
      transcript: signedIn ? visibleItems(session!.transcript) : [],
      accepted: signedIn ? session!.accepted : [],
      sentRequests: signedIn ? session!.sentRequests : [],
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
