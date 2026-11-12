import { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectMynt, NotAllowedError, NotSignedInError } from "@/lib/mynt-client";
import { toProjects } from "@/lib/projects";
import { currentSession } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, logLine, refreshRoles, sessionIsDeveloper, ToolRefusedError } from "@/lib/studio-server";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

// The signed-in developer's projects: their Mynt apps, each with its builds and previews. Read
// from Mynt on every load; the studio keeps no copy.
export async function GET() {
  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401, headers: noStore });

  let mynt: Client | undefined;
  try {
    mynt = await connectMynt(session);
    if (!session.roles) await refreshRoles(session, mynt);
    if (!sessionIsDeveloper(session)) {
      return NextResponse.json({ error: "not_developer", message: "Mynt Studio is for developers. Ask a Mynt admin for the developer role." }, { status: 403, headers: noStore });
    }
    const [apps, builds] = await Promise.all([callStudioTool(mynt, "list_my_apps"), callStudioTool(mynt, "list_builds")]);
    return NextResponse.json({ projects: toProjects(apps, builds) }, { headers: noStore });
  } catch (err) {
    if (err instanceof NotSignedInError) return NextResponse.json({ error: "auth_required" }, { status: 401, headers: noStore });
    if (err instanceof NotAllowedError) return NextResponse.json({ error: "not_allowed", message: err.message }, { status: 403, headers: noStore });
    if (err instanceof ToolRefusedError) return NextResponse.json({ error: "mynt_refused", message: err.message }, { status: 422, headers: noStore });
    console.error(logLine("loading projects", err));
    return NextResponse.json({ error: "unreachable", message: "Couldn't reach Mynt. Please try again." }, { status: 502, headers: noStore });
  } finally {
    await mynt?.close().catch(() => undefined);
    // Keeps refreshed tokens, a sign-out by Mynt, and the user's roles.
    await sessionStore().save(session).catch((err) => console.error(logLine("saving the session", err)));
  }
}
