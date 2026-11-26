import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { askToolDefs, type AskTool } from "@/lib/ask";
import { answerQuestion, askJson as json, readQuestion } from "@/lib/ask-server";
import { askConfigured } from "@/lib/llm";
import { NotAllowedError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { finishSession } from "@/lib/session-response";
import { callStudioTool, ensureRoles, isAuthError, listMyntTools, logLine, MyntRefusedError, sessionIsDeveloper, ToolRefusedError } from "@/lib/studio-server";
import { connectStudio } from "@/lib/tokens";
import { resolveWorkspace, workspaceOf, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Whether Ask AI can answer here (the search modal says "AI is not configured" otherwise).
export async function GET() {
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  return json({ enabled: askConfigured() });
}

// Ask AI: a short answer to the user's question about their own Mynt data, streamed as server-sent events
// (lib/ask-answer.ts AskStreamEvent): its sources, the text as it's written, then the cleaned answer. It reads through
// Mynt's tools as the signed-in user (their own sign-in, never an app key), and only the read tools in lib/ask.ts.
// What's asked and answered is never logged.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  if (!askConfigured()) return json({ error: "not_configured", message: "AI is not configured." }, 503);
  const question = await readQuestion(req);
  if (typeof question !== "string") return question;

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
    console.error(logLine("connecting for Ask AI", err));
    return finishSession(json({ error: "unreachable", message: "Couldn't reach Mynt. Please try again." }, 502), session);
  }
  if (!sessionIsDeveloper(session)) {
    await mynt.close().catch(() => undefined);
    return finishSession(json({ error: "not_developer", message: "Mynt Studio is for developers. Ask a Mynt admin for the developer role." }, 403), session);
  }
  return answerQuestion(req, {
    area: "studio",
    bucket: "ask",
    what: "Ask AI",
    question,
    session,
    mynt,
    prepare: async () => {
      const tools = await listMyntTools(mynt);
      return {
        tools: askToolDefs(tools),
        workspaceId: await resolveWorkspace(mynt, workspaceOf(req), workspaceSupport(tools)),
        callTool: async (name, args) => {
          try {
            return { text: JSON.stringify(await callStudioTool(mynt, name as AskTool, args)), isError: false };
          } catch (err) {
            if (err instanceof MyntRefusedError || err instanceof ToolRefusedError) return { text: err.message, isError: true };
            throw err;
          }
        },
      };
    },
  });
}
