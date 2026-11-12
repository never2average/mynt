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
  MAYBE_LOST_NOTE,
  planSteer,
  START_BUSY_NOTE,
} from "@/lib/chat";
import { NotAllowedError } from "@/lib/mynt-client";
import { currentSession, fromOwnOrigin } from "@/lib/session";
import { sessionStore, type Release, type Session } from "@/lib/session-store";
import {
  callStudioTool,
  certainlyNotDone,
  ensureRoles,
  GENERIC_REFUSAL,
  isAuthError,
  listMyntTools,
  logLine,
  sessionIsDeveloper,
  ToolRefusedError,
} from "@/lib/studio-server";
import { connectStudio } from "@/lib/tokens";

export const dynamic = "force-dynamic";
// Vercel ends a function after this many seconds. The watch stops well before, counted from when
// the request arrived: its last activity call can take up to the MCP client's 60 s timeout.
export const maxDuration = 300;
export const WATCH_MS = 220_000;
const POLL_MS = 2_000;
// A message sent twice (a double click, a retry, a second device) acts once.
const SAME_MESSAGE_SECONDS = 10 * 60;
const SAME_TEXT_SECONDS = 30;
// Two devices pressing send at the same moment start one build, not two. The lock outlives the
// slowest start_build (the MCP client's 60 s timeout); it's released once the start is done.
export const START_LOCK_SECONDS = 70;

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

// The session is saved on every way out when this request changed what's worth keeping (a token
// refresh, a sign-out by Mynt, fresh roles). The store never brings back a session signed out
// meanwhile, nor writes older tokens over newer ones.
function sessionSaver(session: Session) {
  let token = session.tokens?.access_token;
  let rolesAt = session.rolesAt;
  return async (force = false) => {
    if (!force && session.tokens?.access_token === token && session.rolesAt === rolesAt) return;
    token = session.tokens?.access_token;
    rolesAt = session.rolesAt;
    await sessionStore()
      .save(session)
      .catch((err) => console.error(logLine("saving the session", err)));
  };
}

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
  const saveIfChanged = sessionSaver(session);

  let mynt: Client;
  try {
    mynt = await connectStudio(session);
    await ensureRoles(session, mynt);
  } catch (err) {
    if (isAuthError(err)) {
      session.tokens = undefined;
      await saveIfChanged();
      return NextResponse.json({ error: "auth_required" }, { status: 401 });
    }
    await saveIfChanged();
    if (err instanceof NotAllowedError) return NextResponse.json({ error: "not_allowed" }, { status: 403 });
    console.error(logLine("connecting for chat", err));
    return NextResponse.json({ error: "unreachable" }, { status: 502 });
  }
  if (!sessionIsDeveloper(session)) {
    await mynt.close().catch(() => undefined);
    await saveIfChanged();
    return NextResponse.json({ error: "not_developer" }, { status: 403 });
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        await converse(writer, mynt, session, saveIfChanged, { projectId, conversationId: conversationId ?? null, message, signal: req.signal, deadline });
      } catch (err) {
        if (isAuthError(err)) {
          session.tokens = undefined;
          throw new ToolRefusedError("Your sign-in has expired. Sign in again to carry on.");
        }
        throw err;
      } finally {
        await mynt.close().catch(() => undefined);
        await saveIfChanged();
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

let partCounter = 0;
const partId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(partCounter++).toString(36)}`;

function writeText(writer: UIMessageStreamWriter, text: string) {
  const tid = partId("t");
  writer.write({ type: "text-start", id: tid });
  writer.write({ type: "text-delta", id: tid, delta: text });
  writer.write({ type: "text-end", id: tid });
}

// Claims a message for delivery: by its id for a while, and by its text for a few seconds, per
// Mynt user and app (so a second device counts too). Returns the releases to call if the message
// certainly wasn't delivered, or null if it was already sent.
async function claimMessage(who: string, projectId: string, message: { id: string | null; text: string }): Promise<Release[] | null> {
  const store = sessionStore();
  const wanted: [string, string, number][] = [["chat-text", `${who}\n${projectId}\n${message.text}`, SAME_TEXT_SECONDS]];
  if (message.id) wanted.push(["chat-id", `${who}\n${projectId}\n${message.id}`, SAME_MESSAGE_SECONDS]);
  const held: Release[] = [];
  for (const [name, subject, ttl] of wanted) {
    const release = await store.claim(name, subject, ttl);
    if (!release) {
      await releaseAll(held);
      return null;
    }
    held.push(release);
  }
  return held;
}

async function releaseAll(releases: Release[]) {
  for (const r of releases) await r().catch(() => undefined);
}

// After a call that failed: the claims are given back only if the call certainly had no effect
// (Mynt refused it, or it was never sent). After a timeout or a lost reply it may have worked,
// so they're kept, and a retry can't steer or start twice.
async function afterFailure(err: unknown, releases: Release[]) {
  if (certainlyNotDone(err)) await releaseAll(releases);
}

async function decide(
  mynt: Client,
  opts: { projectId: string; conversationId: string | null; message: { text: string } },
  capabilities: ReturnType<typeof capabilitiesFrom>,
) {
  const builds = buildSummaries(await callStudioTool(mynt, "list_builds", { app_id: opts.projectId }));
  return chooseAction({ appId: opts.projectId, selectedBuildId: opts.conversationId, builds, text: opts.message.text, capabilities });
}

async function converse(
  writer: UIMessageStreamWriter,
  mynt: Client,
  session: Session,
  saveIfChanged: (force?: boolean) => Promise<void>,
  opts: { projectId: string; conversationId: string | null; message: { id: string | null; text: string }; signal: AbortSignal; deadline: number },
) {
  const capabilities = capabilitiesFrom(await listMyntTools(mynt));
  let action = await decide(mynt, opts, capabilities);
  const who = session.userId ?? session.id;

  let startedId: string | null = null;
  if (action.kind === "start") {
    const claims = await claimMessage(who, opts.projectId, opts.message);
    if (!claims) {
      writeText(writer, "You've just sent that. The agent has it already.");
      return;
    }
    // One start at a time per user and app, across devices.
    const unlock = await sessionStore().claim("start-lock", `${who}\n${opts.projectId}`, START_LOCK_SECONDS);
    if (!unlock) {
      await releaseAll(claims);
      writeText(writer, START_BUSY_NOTE);
      return;
    }
    // Decided again under the lock: another device may have started a build meanwhile.
    const again = await decide(mynt, opts, capabilities).catch(async (err) => {
      await releaseAll([...claims, unlock]);
      throw err;
    });
    if (again.kind !== "start") {
      await releaseAll([...claims, unlock]); // nothing sent; a steer below claims afresh
      action = again;
    } else {
      try {
        const started = (await callStudioTool(mynt, "start_build", again.args)) as { id?: unknown } | null;
        if (typeof started?.id !== "string") throw new Error("start_build returned no build id");
        startedId = started.id;
      } catch (err) {
        await afterFailure(err, [...claims, unlock]);
        throw err;
      }
      // Started: the new build is listed now, so a second device deciding under the lock after
      // this follows or steers it.
      await releaseAll([unlock]);
    }
  }
  if (action.kind === "refuse") {
    writeText(writer, action.message);
    return;
  }

  const follower = new ActivityFollower();
  let buildId: string;
  let skipTurnEnds = 0;
  let steered = false;
  if (startedId !== null) {
    buildId = startedId;
  } else if (action.kind === "follow") {
    buildId = action.buildId;
    writeText(writer, action.message);
  } else if (action.kind === "steer") {
    buildId = action.buildId;
    // What the agent did before this message isn't part of the reply.
    const { latest } = follower.baseline(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
    const plan = planSteer(latest, capabilities);
    if (!plan.send) {
      writeText(writer, plan.message); // nothing sent, so nothing claimed
    } else {
      const claims = await claimMessage(who, opts.projectId, opts.message);
      if (!claims) {
        writeText(writer, "You've just sent that. The agent has it already.");
        return;
      }
      try {
        await callStudioTool(mynt, "steer_build", action.args);
      } catch (err) {
        await afterFailure(err, claims);
        throw err;
      }
      skipTurnEnds = plan.skipTurnEnds;
      steered = true;
    }
  } else {
    return; // a second "start" can't follow a decision made under the lock
  }
  // Tells the page which build this conversation is (it shows that build's preview).
  writer.write({ type: "data-build", data: { buildId, started: startedId !== null }, transient: true });

  // Saved before the long watch (refreshed tokens, roles); at the end only if changed again.
  await saveIfChanged(true);
  const watched = await watch(writer, mynt, follower, buildId, skipTurnEnds, opts);
  if (watched !== "answered" && steered && !capabilities.sessionBuilds) writeText(writer, MAYBE_LOST_NOTE);
  else if (watched === "timeout") writeText(writer, "_Still working. The build carries on; open it again to see the rest._");
}

// Follows the build until the agent has answered, the build finishes, the deadline, or the
// browser goes away.
async function watch(
  writer: UIMessageStreamWriter,
  mynt: Client,
  follower: ActivityFollower,
  buildId: string,
  skip: number,
  opts: { signal: AbortSignal; deadline: number },
): Promise<"answered" | "finished" | "timeout" | "aborted"> {
  let phase: string | null = null;
  let toSkip = skip;
  let answered = false;
  while (!opts.signal.aborted) {
    const r = follower.take(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
    if (follower.missed) {
      writeText(writer, "_Some of the agent's activity was too old to show._");
      follower.missed = false;
    }
    // Items up to the end of the answer are shown; the interrupted turn's end is skipped.
    const end = consumeTurnEnds(r.items, toSkip, r.status);
    toSkip = end.skip;
    answered ||= end.answered;
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
    if (end.over) return answered ? "answered" : "finished";
    if (Date.now() + POLL_MS > opts.deadline) return answered ? "answered" : "timeout";
    await sleep(POLL_MS);
  }
  return "aborted";
}
