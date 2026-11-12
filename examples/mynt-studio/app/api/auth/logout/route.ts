import { NextResponse } from "next/server";
import { appUrl } from "@/lib/config";
import { clearSessionCookie, currentSession, fromOwnOrigin } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";

export const dynamic = "force-dynamic";

// POST only, so a link or image elsewhere can't sign the user out.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const session = await currentSession();
  await sessionStore().destroy(session?.id);
  const res = NextResponse.redirect(new URL("/", appUrl()), 303);
  clearSessionCookie(res);
  return res;
}
