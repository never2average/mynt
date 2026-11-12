import { NextResponse, type NextRequest } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { logLine, parseDevCall, parseToolText } from "@/lib/developer";
import { refreshRoles, sessionIsDeveloper } from "@/lib/developer-server";
import { callMyntTool, connectMynt, NotAllowedError, NotSignedInError } from "@/lib/mynt";
import { currentSession, fromOwnOrigin } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // sandbox_run may take up to 300s

const noStore = { "Cache-Control": "no-store" };

// The developer console calls one of Mynt's developer tools (DEV_TOOLS) as the signed-in user,
// through the same MCP client and OAuth session as the chat. Replies go back to the page as
// they are and nothing is kept: the editor password and the SSH login in particular are never
// written to the session, the log or any cache.
export async function POST(req: NextRequest) {
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: noStore });
  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401, headers: noStore });

  const call = parseDevCall(await req.json().catch(() => null));
  if ("error" in call) return NextResponse.json({ error: call.error }, { status: 400, headers: noStore });

  let mynt: Client | undefined;
  try {
    mynt = await connectMynt(session);
    if (!session.roles) await refreshRoles(session, mynt);
    if (!sessionIsDeveloper(session)) {
      return NextResponse.json({ error: "Your Mynt account doesn't have the developer role." }, { status: 403, headers: noStore });
    }
    const outcome = await callMyntTool(mynt, call.tool, call.args);
    return NextResponse.json({ ok: !outcome.isError, data: parseToolText(outcome.text) }, { status: outcome.isError ? 422 : 200, headers: noStore });
  } catch (err) {
    if (err instanceof NotSignedInError) return NextResponse.json({ error: "auth_required" }, { status: 401, headers: noStore });
    if (err instanceof NotAllowedError) return NextResponse.json({ error: err.message }, { status: 403, headers: noStore });
    console.error(logLine(call.tool, err));
    return NextResponse.json({ error: "Couldn't reach Mynt. Please try again." }, { status: 502, headers: noStore });
  } finally {
    await mynt?.close().catch(() => undefined);
  }
}
