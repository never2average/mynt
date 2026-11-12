import { NextResponse } from "next/server";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ActivityFollower,
  activityToParts,
  buildSummaries,
  capabilitiesFrom,
  chooseAction,
  consumeTurnEnds,
  planSteer,
} from "@/lib/chat";
import { connectMynt, NotAllowedError, NotSignedInError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { sessionStore, type Session } from "@/lib/session-store";
import { callStudioTool, GENERIC_REFUSAL, listMyntTools, logLine, refreshRoles, sessionIsDeveloper, ToolRefusedError } from "@/lib/studio-server";

export const dynamic = "force-dynamic";
// Vercel ends a function after this many seconds. The stream stops watching well before, counted
// from when the request arrived, so it always closes cleanly.
export const maxDuration = 300;
const WATCH_MS = 240_000;
const POLL_MS = 2_000;
// A message sent twice (a double click, a retry) acts once.
const SAME_MESSAGE_SECONDS = 10 * 60;
const SAME_TEXT_SECONDS = 30;

const id = z.string().trim().min(1).max(200);
const Body = z.object({
  projectId: id,
  conversationId: id.nullish(),
  messages: z
    .array(
      z
        .object({
          id: z.string().max(200).optional(),
          role: z.string(),
          parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
        })
        .passthrough(),
    )
    .min(1)
    .max(500),
});

type Messages = z.infer<typeof Body>["messages"];

// The user's latest message: its id (from the browser) and text.
function lastUserMessage(messages: Messages): { id: string | null; text: string } {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const text = (last?.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
  return { id: last?.id ?? null, text };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A message in the chat goes to Mynt's coding agent: it steers the app's running build, or
// starts a build for the app. The reply streams the agent's activity as it happens, as AI SDK
// UI message parts, until it has answered, the build finishes, or the watch runs out of time
// (the build carries on either way).
export async function POST(req: Request) {
  const deadline = Date.now() + WATCH_MS;
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { projectId, conversationId } = parsed.data;
  const message = lastUserMessage(parsed.data.messages);

  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  let mynt: Client;
  try {
    mynt = await connectMynt(session);
    if (!session.roles) await refreshRoles(session, mynt);
  } catch (err) {
    await save(session);
    if (err instanceof NotSignedInError) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    if (err instanceof NotAllowedError) return NextResponse.json({ error: "not_allowed" }, { status: 403 });
    console.error(logLine("connecting for chat", err));
    return NextResponse.json({ error: "unreachable" }, { status: 502 });
  }
  if (!sessionIsDeveloper(session)) {
    await mynt.close().catch(() => undefined);
    await save(session);
    return NextResponse.json({ error: "not_developer" }, { status: 403 });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        await converse(writer, mynt, session, { projectId, conversationId: conversationId ?? null, message, signal: req.signal, deadline });
      } finally {
        await mynt.close().catch(() => undefined);
      }
    },
    onError: (err) => {
      if (err instanceof ToolRefusedError) return err.message;
      console.error(logLine("chat", err));
      return GENERIC_REFUSAL;
    },
  });
  return createUIMessageStreamResponse({ stream, headers: { "Cache-Control": "no-store" } });
}

async function save(session: Session) {
  await sessionStore()
    .save(session)
    .catch((err) => console.error(logLine("saving the session", err)));
}

let partCounter = 0;
const partId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(partCounter++).toString(36)}`;

function writeText(writer: UIMessageStreamWriter, text: string) {
  const tid = partId("t");
  writer.write({ type: "text-start", id: tid });
  writer.write({ type: "text-delta", id: tid, delta: text });
  writer.write({ type: "text-end", id: tid });
}

// True the first time this message (by id, and by its text for a few seconds) reaches this app.
async function firstTime(session: Session, projectId: string, message: { id: string | null; text: string }): Promise<boolean> {
  const store = sessionStore();
  const byText = await store.claim("chat-text", `${session.id}\n${projectId}\n${message.text}`, SAME_TEXT_SECONDS);
  const byId = message.id ? await store.claim("chat-id", `${session.id}\n${projectId}\n${message.id}`, SAME_MESSAGE_SECONDS) : true;
  return byText && byId;
}

async function converse(
  writer: UIMessageStreamWriter,
  mynt: Client,
  session: Session,
  opts: { projectId: string; conversationId: string | null; message: { id: string | null; text: string }; signal: AbortSignal; deadline: number },
) {
  const [tools, buildsReply] = await Promise.all([listMyntTools(mynt), callStudioTool(mynt, "list_builds", { app_id: opts.projectId })]);
  const capabilities = capabilitiesFrom(tools);
  const action = chooseAction({
    appId: opts.projectId,
    selectedBuildId: opts.conversationId,
    builds: buildSummaries(buildsReply),
    text: opts.message.text,
    capabilities,
  });
  if (action.kind === "refuse") {
    writeText(writer, action.message);
    return;
  }

  const follower = new ActivityFollower();
  let buildId: string;
  let skipTurnEnds = 0;
  if (action.kind === "follow") {
    buildId = action.buildId;
    writeText(writer, action.message);
  } else {
    if (!(await firstTime(session, opts.projectId, opts.message))) {
      writeText(writer, "You've just sent that. The agent has it already.");
      return;
    }
    if (action.kind === "steer") {
      buildId = action.buildId;
      // What the agent did before this message isn't part of the reply.
      const { latest } = follower.baseline(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
      const plan = planSteer(latest, capabilities);
      if (plan.send) {
        await callStudioTool(mynt, "steer_build", action.args);
        skipTurnEnds = plan.skipTurnEnds;
      } else {
        writeText(writer, plan.message);
      }
    } else {
      const started = (await callStudioTool(mynt, "start_build", action.args)) as { id?: unknown } | null;
      if (typeof started?.id !== "string") throw new ToolRefusedError(GENERIC_REFUSAL);
      buildId = started.id;
    }
  }
  // Tells the page which build this conversation is (it shows that build's preview).
  writer.write({ type: "data-build", data: { buildId, started: action.kind === "start" }, transient: true });

  // Saved now, before the long watch; at the end only if the sign-in changed meanwhile, so a
  // stale copy is never written back over a later sign-out.
  await save(session);
  const signedInWith = session.tokens?.access_token;
  try {
    await watch(writer, mynt, follower, buildId, skipTurnEnds, opts);
  } finally {
    if (session.tokens?.access_token !== signedInWith) await save(session);
  }
}

async function watch(
  writer: UIMessageStreamWriter,
  mynt: Client,
  follower: ActivityFollower,
  buildId: string,
  skip: number,
  opts: { signal: AbortSignal; deadline: number },
) {
  let phase: string | null = null;
  let toSkip = skip;
  while (!opts.signal.aborted) {
    const r = follower.take(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
    if (follower.missed) {
      writeText(writer, "_Some of the agent's activity was too old to show._");
      follower.missed = false;
    }
    // Items up to the end of the answer are shown; the interrupted turn's end is skipped.
    const end = consumeTurnEnds(r.items, toSkip, r.status);
    toSkip = end.skip;
    for (const part of activityToParts(r.items)) {
      if (part.kind === "text") writeText(writer, part.text);
      else {
        const toolCallId = partId("c");
        writer.write({ type: "tool-input-available", toolCallId, toolName: part.toolName, input: part.input });
        writer.write({ type: "tool-output-available", toolCallId, output: {} });
      }
    }
    if (r.phaseMessage && r.phaseMessage !== phase) {
      phase = r.phaseMessage;
      writeText(writer, `_${r.status ? `${r.status}: ` : ""}${phase}_`);
    }
    if (end.over) return;
    if (Date.now() + POLL_MS > opts.deadline) {
      writeText(writer, "_Still working. The build carries on; open it again to see the rest._");
      return;
    }
    await sleep(POLL_MS);
  }
}
