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
  turnOver,
} from "@/lib/chat";
import { connectMynt, NotAllowedError, NotSignedInError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { sessionStore, type Session } from "@/lib/session-store";
import { callStudioTool, listMyntTools, logLine, refreshRoles, sessionIsDeveloper, ToolRefusedError } from "@/lib/studio-server";

export const dynamic = "force-dynamic";
// Vercel ends a function after this many seconds; the stream stops watching a little before.
export const maxDuration = 300;
const WATCH_MS = 270_000;
const POLL_MS = 2_000;

const id = z.string().trim().min(1).max(200);
const Body = z.object({
  projectId: id,
  conversationId: id.nullish(),
  messages: z
    .array(z.object({ role: z.string(), parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional() }).passthrough())
    .min(1)
    .max(500),
});

// The text of the user's latest message.
function lastUserText(messages: z.infer<typeof Body>["messages"]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return (last?.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A message in the chat goes to Mynt's coding agent: it steers the app's running build, or
// starts a build for the app. The reply streams the agent's activity as it happens, as AI SDK
// UI message parts, until its turn ends, the build finishes, or the watch runs out of time
// (the build carries on either way).
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { projectId, conversationId } = parsed.data;
  const text = lastUserText(parsed.data.messages);

  const session = await currentSession();
  if (!session?.tokens) return NextResponse.json({ error: "auth_required" }, { status: 401 });

  let mynt: Client;
  try {
    mynt = await connectMynt(session);
    if (!session.roles) await refreshRoles(session, mynt);
  } catch (err) {
    await save(session);
    if (err instanceof NotSignedInError) return NextResponse.json({ error: "auth_required" }, { status: 401 });
    if (err instanceof NotAllowedError) return NextResponse.json({ error: "not_allowed", message: err.message }, { status: 403 });
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
        await converse(writer, mynt, { projectId, conversationId: conversationId ?? null, text, signal: req.signal });
      } finally {
        await mynt.close().catch(() => undefined);
        await save(session);
      }
    },
    onError: (err) => {
      if (err instanceof ToolRefusedError) return err.message;
      console.error(logLine("chat", err));
      return "Couldn't reach Mynt. Please try again.";
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

async function converse(
  writer: UIMessageStreamWriter,
  mynt: Client,
  opts: { projectId: string; conversationId: string | null; text: string; signal: AbortSignal },
) {
  const [tools, buildsReply] = await Promise.all([listMyntTools(mynt), callStudioTool(mynt, "list_builds", { app_id: opts.projectId })]);
  const action = chooseAction({
    appId: opts.projectId,
    selectedBuildId: opts.conversationId,
    builds: buildSummaries(buildsReply),
    text: opts.text,
    capabilities: capabilitiesFrom(tools),
  });
  if (action.kind === "refuse") {
    writeText(writer, action.message);
    return;
  }

  const follower = new ActivityFollower();
  let buildId: string;
  if (action.kind === "steer") {
    buildId = action.buildId;
    // What the agent did before this message isn't part of the reply.
    follower.baseline(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
    await callStudioTool(mynt, "steer_build", action.args);
  } else {
    const started = (await callStudioTool(mynt, "start_build", action.args)) as { id?: unknown } | null;
    if (typeof started?.id !== "string") throw new ToolRefusedError("Mynt didn't return the new build");
    buildId = started.id;
  }
  // Tells the page which build this conversation is (it shows that build's preview).
  writer.write({ type: "data-build", data: { buildId, started: action.kind === "start" }, transient: true });

  const deadline = Date.now() + WATCH_MS;
  let phase: string | null = null;
  let sawReply = false;
  while (!opts.signal.aborted) {
    const r = follower.take(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
    if (follower.missed) {
      writeText(writer, "_Some of the agent's activity was too old to show._");
      follower.missed = false;
    }
    for (const part of activityToParts(r.items)) {
      sawReply = true;
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
    if (turnOver(r.items, r.status) && (sawReply || r.status === null || !["queued", "provisioning"].includes(r.status))) return;
    if (Date.now() > deadline) {
      writeText(writer, "_Still working. The build carries on; open it again to see the rest._");
      return;
    }
    await sleep(POLL_MS);
  }
}
