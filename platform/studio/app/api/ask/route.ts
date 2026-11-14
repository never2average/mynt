import { NextResponse } from "next/server";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ChatBody, readCapped, TOO_LARGE } from "@/lib/ai-route";
import { askToolDefs, historyFrom, runAsk, type AskTool } from "@/lib/ask";
import { askConfigured, askModel, createLlm } from "@/lib/llm";
import { NotAllowedError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { finishSession } from "@/lib/session-response";
import { sessionStore } from "@/lib/session-store";
import {
  callStudioTool,
  ensureRoles,
  GENERIC_REFUSAL,
  isAuthError,
  listMyntTools,
  logLine,
  MyntRefusedError,
  sessionIsDeveloper,
  ToolRefusedError,
} from "@/lib/studio-server";
import { connectStudio } from "@/lib/tokens";
import { resolveWorkspace, workspaceOf, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
// One answer at a time per user (a second tab or a double send waits for the first).
export const BUSY_SECONDS = 130;

// The request body's limit (the conversation as text is far smaller), and questions per user per hour.
export const MAX_BODY_BYTES = 64 * 1024;
export const ASK_PER_HOUR = 20;
export const ASK_WINDOW_SECONDS = 60 * 60;

const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

// Whether Ask AI can answer here (the search modal shows "AI is not configured" otherwise).
export async function GET() {
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  return json({ enabled: askConfigured() });
}

// Ask AI: answers the user's question about their own Mynt data, streamed as AI SDK UI message
// parts. It reads through Mynt's tools as the signed-in user (their own sign-in, never an app
// key), and only the read tools in lib/ask.ts. What's asked and answered is never logged.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const session = await currentSession();
  if (!session?.tokens) return json({ error: "auth_required" }, 401);
  if (!askConfigured()) return json({ error: "not_configured", message: "AI is not configured." }, 503);
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === TOO_LARGE) return json({ error: "too_large", message: "That conversation is too long. Start a new chat." }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = ChatBody.safeParse(body);
  const history = parsed.success ? historyFrom(parsed.data.messages) : null;
  if (!history) return json({ error: "bad_request" }, 400);

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
  const done = async () => {
    await mynt.close().catch(() => undefined);
    await sessionStore()
      .save(session)
      .catch((err) => console.error(logLine("saving the session", err)));
  };
  if (!sessionIsDeveloper(session)) {
    await done();
    return json({ error: "not_developer", message: "Mynt Studio is for developers. Ask a Mynt admin for the developer role." }, 403);
  }
  const who = session.userId ?? session.id;
  const release = await sessionStore().claim("ask-busy", who, BUSY_SECONDS);
  if (!release) {
    await done();
    return json({ error: "busy", message: "Ask AI is still answering your last question." }, 429);
  }
  // Questions per user per hour, counted in the session store (shared by every instance).
  if ((await sessionStore().count("ask", who, ASK_WINDOW_SECONDS)) > ASK_PER_HOUR) {
    await release().catch(() => undefined);
    await done();
    return NextResponse.json(
      { error: "rate_limited", message: `You've asked ${ASK_PER_HOUR} questions in the last hour. Ask AI will answer again shortly; search still works.` },
      { status: 429, headers: { ...noStore, "Retry-After": String(ASK_WINDOW_SECONDS) } },
    );
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        const tools = await listMyntTools(mynt);
        const workspaceId = await resolveWorkspace(mynt, workspaceOf(req), workspaceSupport(tools));
        let textId = 0;
        await runAsk(history, {
          llm: createLlm(),
          model: askModel(),
          tools: askToolDefs(tools),
          workspaceId,
          signal: req.signal,
          callTool: async (name: AskTool, args) => {
            try {
              return { text: JSON.stringify(await callStudioTool(mynt, name, args)), isError: false };
            } catch (err) {
              if (err instanceof MyntRefusedError || err instanceof ToolRefusedError) return { text: err.message, isError: true };
              throw err;
            }
          },
          emit: (ev) => {
            if (ev.type === "text-start") writer.write({ type: "text-start", id: `t${++textId}` });
            else if (ev.type === "text") writer.write({ type: "text-delta", id: `t${textId}`, delta: ev.delta });
            else if (ev.type === "text-end") writer.write({ type: "text-end", id: `t${textId}` });
            else if (ev.type === "tool") {
              // The browser sees which reads ran, not what Mynt answered.
              writer.write({ type: "tool-input-available", toolCallId: ev.id, toolName: ev.name, input: ev.input });
              writer.write({ type: "tool-output-available", toolCallId: ev.id, output: { ok: ev.ok } });
            }
          },
        });
      } catch (err) {
        if (isAuthError(err)) {
          session.tokens = undefined;
          throw new ToolRefusedError("Your sign-in has expired. Sign in again to carry on.");
        }
        throw err;
      } finally {
        await release().catch(() => undefined);
        await done();
      }
    },
    onError: (err) => {
      if (err instanceof ToolRefusedError) return err.message;
      console.error(logLine("Ask AI", err));
      return GENERIC_REFUSAL;
    },
  });
  return createUIMessageStreamResponse({ stream, headers: noStore });
}
