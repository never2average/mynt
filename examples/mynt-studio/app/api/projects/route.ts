import { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { NotAllowedError } from "@/lib/mynt-client";
import { toProjects } from "@/lib/projects";
import { currentSession } from "@/lib/session";
import { finishSession } from "@/lib/session-response";
import { callStudioTool, ensureRoles, isAuthError, logLine, sessionIsDeveloper, ToolRefusedError } from "@/lib/studio-server";
import { connectStudio } from "@/lib/tokens";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// The signed-in developer's projects: their Mynt apps, each with its builds and previews. Read
// from Mynt on every load; the studio keeps no copy.
export async function GET() {
  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401, headers: noStore });

  let mynt: Client | undefined;
  let res: NextResponse;
  try {
    mynt = await connectStudio(session);
    await ensureRoles(session, mynt);
    if (!sessionIsDeveloper(session)) {
      res = NextResponse.json({ error: "not_developer", message: "Mynt Studio is for developers. Ask a Mynt admin for the developer role." }, { status: 403, headers: noStore });
    } else {
      const [apps, builds] = await Promise.all([callStudioTool(mynt, "list_my_apps"), callStudioTool(mynt, "list_builds")]);
      res = NextResponse.json({ projects: toProjects(apps, builds) }, { headers: noStore });
    }
  } catch (err) {
    if (isAuthError(err)) {
      session.tokens = undefined; // Mynt no longer accepts this sign-in
      res = NextResponse.json({ error: "auth_required" }, { status: 401, headers: noStore });
    } else if (err instanceof NotAllowedError) {
      res = NextResponse.json({ error: "not_allowed", message: err.message }, { status: 403, headers: noStore });
    } else if (err instanceof ToolRefusedError) {
      res = NextResponse.json({ error: "mynt_refused", message: err.message }, { status: 422, headers: noStore });
    } else {
      console.error(logLine("loading projects", err));
      res = NextResponse.json({ error: "unreachable", message: "Couldn't reach Mynt. Please try again." }, { status: 502, headers: noStore });
    }
  } finally {
    await mynt?.close().catch(() => undefined);
  }
  // Keeps refreshed tokens, a sign-out by Mynt, and the user's roles; moves the cookie's expiry
  // with the session's.
  return finishSession(res, session);
}
