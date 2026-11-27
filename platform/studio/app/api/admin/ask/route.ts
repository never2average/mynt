import { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { adminAskRun } from "@/lib/ask-runs";
import { answerQuestion, askJson as json, readAsk } from "@/lib/ask-server";
import { askConfigured } from "@/lib/llm";
import { NotAllowedError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { finishSession } from "@/lib/session-response";
import { asAdmin, NOT_FOUND } from "@/lib/studio-route";
import { callAdminTool, ensureRoles, isAuthError, listMyntTools, logLine, rolesFresh, sessionIsAdmin } from "@/lib/studio-server";
import { connectStudio } from "@/lib/tokens";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Whether the platform admin's Ask AI can answer (its search says "AI is not configured" otherwise). Mynt admins only:
// anyone else is told there's nothing here.
export async function GET() {
  return asAdmin("checking the platform admin's Ask AI", async () => json({ enabled: askConfigured() }));
}

// The platform admin's Ask AI: a short answer to a Mynt admin's question across every workspace and firm, streamed as
// the studio's is (app/api/ask). Only for an account Mynt says is an admin (404 for anyone else, as every
// /api/admin route). It reads through Mynt's tools as that admin, and only the reads in lib/admin-ask.ts, each through
// the Admin area's allow-list with its strict arguments. No workspace is read: nothing here is scoped to one. What's
// asked and answered is never logged.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  // Roles read in the last few minutes that aren't an admin's: nothing here, without connecting to Mynt.
  if (rolesFresh(session) && !sessionIsAdmin(session)) return finishSession(json(NOT_FOUND, 404), session);

  let mynt: Client;
  try {
    mynt = await connectStudio(session);
    await ensureRoles(session, mynt);
  } catch (err) {
    if (isAuthError(err)) {
      session.tokens = undefined;
      return finishSession(json({ error: "auth_required" }, 401), session);
    }
    if (err instanceof NotAllowedError) return finishSession(json({ error: "not_allowed", message: err.message }, 403), session);
    console.error(logLine("connecting for the platform admin's Ask AI", err));
    return finishSession(json({ error: "unreachable", message: "Couldn't reach Mynt. Please try again." }, 502), session);
  }
  const refuse = async (res: ReturnType<typeof json>) => {
    await mynt.close().catch(() => undefined);
    return finishSession(res, session);
  };
  if (!sessionIsAdmin(session)) return refuse(json(NOT_FOUND, 404));
  if (!askConfigured()) return refuse(json({ error: "not_configured", message: "AI is not configured." }, 503));
  const asked = await readAsk(req);
  if (asked instanceof NextResponse) return refuse(asked);

  return answerQuestion(req, {
    area: "admin",
    bucket: "admin-ask",
    what: "the platform admin's Ask AI",
    asked,
    session,
    mynt,
    // The reads in lib/admin-ask.ts, each through the Admin area's strict arguments first (lib/ask-runs.ts).
    prepare: async () => adminAskRun(await listMyntTools(mynt), (tool, args) => callAdminTool(mynt, session, tool, args)),
  });
}
