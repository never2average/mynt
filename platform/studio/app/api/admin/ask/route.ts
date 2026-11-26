import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ADMIN_ASK_CONTEXT, ADMIN_ASK_SYSTEM_PROMPT, isAdminAskTool } from "@/lib/admin-ask";
import { askToolDefs } from "@/lib/ask";
import { answerQuestion, askJson as json, readQuestion } from "@/lib/ask-server";
import { askConfigured } from "@/lib/llm";
import { NotAllowedError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { finishSession } from "@/lib/session-response";
import { asAdmin, NOT_FOUND } from "@/lib/studio-route";
import { callAdminTool, ensureRoles, isAuthError, listMyntTools, logLine, MyntRefusedError, rolesFresh, sessionIsAdmin, ToolRefusedError } from "@/lib/studio-server";
import { isAdminTool, parseAdminCall } from "@/lib/studio-tools";
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
  const question = await readQuestion(req);
  if (typeof question !== "string") return refuse(question);

  return answerQuestion(req, {
    area: "admin",
    bucket: "admin-ask",
    what: "the platform admin's Ask AI",
    question,
    session,
    mynt,
    prepare: async () => ({
      tools: askToolDefs(await listMyntTools(mynt), isAdminAskTool),
      workspaceId: null,
      system: ADMIN_ASK_SYSTEM_PROMPT,
      context: ADMIN_ASK_CONTEXT,
      allowTool: isAdminAskTool,
      knownTool: isAdminTool,
      callTool: async (name, args) => {
        // The Admin area's strict arguments first: what they refuse never reaches Mynt, and the model is told why.
        const call = parseAdminCall(name, args);
        if ("error" in call || !isAdminAskTool(call.tool)) return { text: `Not sent to Mynt: ${"error" in call ? call.error : "it can only read"}`, isError: true };
        try {
          return { text: JSON.stringify(await callAdminTool(mynt, session, call.tool, call.args)), isError: false };
        } catch (err) {
          if (err instanceof MyntRefusedError || err instanceof ToolRefusedError) return { text: err.message, isError: true };
          throw err;
        }
      },
    }),
  });
}
