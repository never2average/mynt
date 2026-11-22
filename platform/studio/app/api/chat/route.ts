import { NextResponse } from "next/server";
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ActivityFollower,
  activityToLiveParts,
  LiveText,
  buildSummaries,
  capabilitiesFrom,
  chooseAction,
  consumeTurnEnds,
  FINISHED,
  HELD_NOTE,
  MAYBE_LOST_NOTE,
  outcomeNote,
  planSteer,
  SESSION_WAITING_NOTE,
  SHIPPING_NOTE,
  START_BUSY_NOTE,
  STEERABLE,
} from "@/lib/chat";
import { STREAM_HEADERS } from "@/lib/ai-route";
import { buildCap } from "@/lib/studio-tools";
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
// How often the agent's activity is read: often while it's active (its words show as it writes
// them; Mynt reads the agent's log at most once a second however often it's asked), less so
// while nothing is happening.
const POLL_MS = 2_000;
const ACTIVE_POLL_MS = 700;
// A message sent twice (a double click, a retry, a second device) acts once.
const SAME_MESSAGE_SECONDS = 10 * 60;
const SAME_TEXT_SECONDS = 30;
// Two devices pressing send at the same moment start one build, not two. The lock is held
// through the second list_builds and start_build, each up to the MCP client's 60 s timeout, so
// it lasts longer than both; it's released once the start is done.
export const START_LOCK_SECONDS = 130;

const id = z.string().trim().min(1).max(200);
const Body = z.object({
  projectId: id,
  conversationId: id.nullish(),
  // The cap the developer picked for a new build (the composer's Cap); used only when the message starts one.
  capUsd: buildCap.nullish(),
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
  const { projectId, conversationId, capUsd } = parsed.data;
  const message = lastUserMessage(parsed.data.messages);

  const opened = await openMynt();
  if (opened instanceof Response) return opened;
  return streamReply(opened, (writer) =>
    converse(writer, opened.mynt, opened.session, opened.saveIfChanged, { projectId, conversationId: conversationId ?? null, message, capUsd: capUsd ?? null, signal: req.signal, deadline }),
  );
}

const FollowQuery = z.object({ projectId: id, buildId: id, after: z.coerce.number().int().min(0).optional(), shipping: z.literal("1").optional() });

// Following a build on, with no message: when its page opens while it's still going, and when a
// reply's watch ran out of time or the agent handed over to Mynt's verification. Streams what the
// agent and Mynt do from `after` (the activity cursor already shown), until the agent has answered
// in a session that then waits for the developer, the build finishes, or the watch's deadline.
// With shipping=1 (the page's Ship was just pressed) it first says what shipping does. 204 when there's nothing to follow (the AI SDK's resumeStream then leaves the chat as it is).
export async function GET(req: Request) {
  const deadline = Date.now() + WATCH_MS;
  if (!fromOwnOrigin(req)) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const params = new URL(req.url).searchParams;
  const parsed = FollowQuery.safeParse({
    projectId: params.get("projectId"),
    buildId: params.get("buildId"),
    after: params.get("after") ?? undefined,
    shipping: params.get("shipping") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { projectId, buildId, after, shipping } = parsed.data;
  const opened = await openMynt();
  if (opened instanceof Response) return opened;
  const { mynt, saveIfChanged } = opened;
  let build: Record<string, unknown> | null;
  try {
    build = (await callStudioTool(mynt, "get_build", { build_id: buildId })) as Record<string, unknown> | null;
  } catch (err) {
    await mynt.close().catch(() => undefined);
    await saveIfChanged();
    if (err instanceof ToolRefusedError) return NextResponse.json({ error: "not_found" }, { status: 404 });
    console.error(logLine("following a build", err));
    return NextResponse.json({ error: "unreachable" }, { status: 502 });
  }
  const status = typeof build?.status === "string" ? build.status : null;
  if (build?.app_id !== projectId || !status || FINISHED.has(status)) {
    await mynt.close().catch(() => undefined);
    await saveIfChanged();
    return new Response(null, { status: build?.app_id !== projectId ? 404 : 204 });
  }
  return streamReply(opened, async (writer) => {
    const capabilities = capabilitiesFrom(await listMyntTools(mynt));
    const follower = new ActivityFollower({ textDeltas: capabilities.textDeltas, reasoning: capabilities.reasoning, after });
    // A session's agent at work is followed to the end of its turn: then it waits for the
    // developer, who must be able to type. Anything else (a one-off build, a session that's
    // shipping, Mynt's verification, a build still starting) is followed until it finishes.
    const finishing = typeof build.finish_requested_at === "string" && !!build.finish_requested_at;
    const session = build.mode === "session" && STEERABLE.has(status) && !finishing;
    if (shipping && finishing) writeText(writer, SHIPPING_NOTE);
    await saveIfChanged(true);
    const meta = { session: build.mode === "session", finishing };
    const watched = await watch(writer, mynt, follower, buildId, session ? 0 : Number.POSITIVE_INFINITY, { signal: req.signal, deadline }, meta);
    await afterWatch(writer, mynt, follower, buildId, watched, session);
  });
}

type Opened = { mynt: Client; session: Session; saveIfChanged: (force?: boolean) => Promise<void> };

// The signed-in developer's connection to Mynt, or the response refusing the request.
async function openMynt(): Promise<Opened | Response> {
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
  return { mynt, session, saveIfChanged };
}

// The reply as AI SDK UI message parts. The connection is closed and the session saved on every
// way out.
function streamReply({ mynt, session, saveIfChanged }: Opened, run: (writer: UIMessageStreamWriter) => Promise<void>) {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        await run(writer);
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
  return createUIMessageStreamResponse({ stream, headers: STREAM_HEADERS });
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
  opts: { projectId: string; conversationId: string | null; message: { text: string }; capUsd: number | null },
  capabilities: ReturnType<typeof capabilitiesFrom>,
) {
  const builds = buildSummaries(await callStudioTool(mynt, "list_builds", { app_id: opts.projectId }));
  const action = chooseAction({ appId: opts.projectId, selectedBuildId: opts.conversationId, builds, text: opts.message.text, capabilities, capUsd: opts.capUsd });
  // Whether the build the action is about is a session (it waits for the developer's next message), and shipping.
  const target = "buildId" in action ? builds.find((b) => b.id === action.buildId) : undefined;
  return Object.assign(action, { session: target?.mode === "session", finishing: target?.finishing === true });
}

async function converse(
  writer: UIMessageStreamWriter,
  mynt: Client,
  session: Session,
  saveIfChanged: (force?: boolean) => Promise<void>,
  opts: { projectId: string; conversationId: string | null; message: { id: string | null; text: string }; capUsd: number | null; signal: AbortSignal; deadline: number },
) {
  const capabilities = capabilitiesFrom(await listMyntTools(mynt));
  let action = await decide(mynt, opts, capabilities);
  const who = session.userId ?? session.id;

  let startedId: string | null = null;
  let isSession = action.session;
  if (action.kind === "start") {
    const claims = await claimMessage(who, opts.projectId, opts.message);
    if (!claims) {
      writeText(writer, "You've just sent that. The agent has it already.");
      return;
    }
    // One start at a time per app, across devices and teammates: two people in a workspace
    // can't start two paid builds on one app.
    const unlock = await sessionStore().claim("start-lock", opts.projectId, START_LOCK_SECONDS);
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
        isSession = again.args.mode === "session";
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

  const follower = new ActivityFollower({ textDeltas: capabilities.textDeltas, reasoning: capabilities.reasoning });
  let buildId: string;
  let skipTurnEnds = 0;
  let steered = false;
  if (startedId !== null) {
    buildId = startedId;
  } else if (action.kind === "follow") {
    buildId = action.buildId;
    writeText(writer, action.message);
  } else if (action.kind === "hold") {
    // Shipping or being verified: nothing is sent. The page keeps the message (data-hold) and sends
    // it once verification ends; until then the chat follows the build to its end.
    buildId = action.buildId;
    follower.baseline(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
    writeText(writer, HELD_NOTE);
    writer.write({ type: "data-hold", data: { buildId, text: opts.message.text, after: follower.position }, transient: true });
    skipTurnEnds = Number.POSITIVE_INFINITY;
    isSession = false;
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
  writer.write({ type: "data-build", data: { buildId, started: startedId !== null, session: isSession }, transient: true });

  // Saved before the long watch (refreshed tokens, roles); at the end only if changed again.
  await saveIfChanged(true);
  const meta = { session: action.kind === "start" ? isSession : action.session, finishing: action.finishing };
  const watched = await watch(writer, mynt, follower, buildId, skipTurnEnds, opts, meta);
  if (watched.how !== "answered" && steered && !capabilities.sessionBuilds) writeText(writer, MAYBE_LOST_NOTE);
  await afterWatch(writer, mynt, follower, buildId, watched, isSession);
}

type Watched = { how: "answered" | "finished" | "timeout" | "aborted"; status: string | null };

// What follows a watch: a session's agent that has answered waits for the developer's next
// message (and the chat says how to ship), unless it's shipping (Ship was pressed meanwhile).
// Otherwise, while the build is still going (the watch
// ran out of time, or a one-off build's agent handed over to Mynt's verification), the page is
// told to follow it on from here (data-follow), so the chat keeps showing what happens.
async function afterWatch(writer: UIMessageStreamWriter, mynt: Client, follower: ActivityFollower, buildId: string, watched: Watched, session: boolean) {
  if (watched.how === "aborted" || watched.how === "finished" || (watched.status && FINISHED.has(watched.status))) return;
  if (watched.how === "answered" && session) {
    const build = (await callStudioTool(mynt, "get_build", { build_id: buildId }).catch(() => null)) as { finish_requested_at?: unknown } | null;
    const shipping = typeof build?.finish_requested_at === "string" && !!build.finish_requested_at;
    if (!shipping) {
      if (watched.status && STEERABLE.has(watched.status)) writeText(writer, SESSION_WAITING_NOTE);
      return;
    }
  }
  if (follower.position === null) {
    if (watched.how === "timeout") writeText(writer, "_Still working. The build carries on; open it again to see the rest._");
    return;
  }
  writer.write({ type: "data-follow", data: { buildId, after: follower.position }, transient: true });
}

// How a finished build ended (shipped, or why not) and what the developer's next message does.
// Best effort: the phase line already said how it ended.
async function writeOutcome(writer: UIMessageStreamWriter, mynt: Client, buildId: string) {
  try {
    const note = outcomeNote(await callStudioTool(mynt, "get_build", { build_id: buildId }));
    if (note) writeText(writer, note);
  } catch (err) {
    console.error(logLine("reading how a build ended", err));
  }
}

// Follows the build until the agent has answered (its `skip`+1th finished turn), the build
// finishes (the chat then says how it ended), the deadline, or the browser goes away. The agent's
// words are written into the reply as they arrive (LiveText).
async function watch(
  writer: UIMessageStreamWriter,
  mynt: Client,
  follower: ActivityFollower,
  buildId: string,
  skip: number,
  opts: { signal: AbortSignal; deadline: number },
  // What the page shows about the build (data-state, sent as its status changes): Ship, the cap, held messages.
  meta: { session: boolean; finishing: boolean } = { session: false, finishing: false },
): Promise<Watched> {
  let phase: string | null = null;
  let status: string | null = null;
  let toSkip = skip;
  let answered = false;
  const live = new LiveText((chunk) => writer.write(chunk), () => partId("t"));
  try {
    while (!opts.signal.aborted) {
      const r = follower.take(await callStudioTool(mynt, "get_build_activity", follower.next(buildId)));
      if (r.status && r.status !== status) writer.write({ type: "data-state", data: { buildId, status: r.status, after: follower.position, ...meta }, transient: true });
      status = r.status ?? status;
      if (follower.missed) {
        live.close();
        writeText(writer, "_Some of the agent's activity was too old to show._");
        follower.missed = false;
      }
      // Items up to the end of the answer are shown; the interrupted turn's end is skipped.
      const end = consumeTurnEnds(r.items, toSkip, r.status);
      toSkip = end.skip;
      answered ||= end.answered;
      for (const part of activityToLiveParts(r.items)) {
        if (live.text(part) || part.kind !== "tool") continue;
        live.close();
        const toolCallId = partId("c");
        writer.write({ type: "tool-input-available", toolCallId, toolName: part.toolName, input: part.input });
        writer.write({ type: "tool-output-available", toolCallId, output: {} });
      }
      if (r.phaseMessage && r.phaseMessage !== phase) {
        phase = r.phaseMessage;
        live.close();
        writeText(writer, `_${r.status ? `${r.status}: ` : ""}${phase}_`);
      }
      if (end.over) {
        if (status && FINISHED.has(status)) {
          live.close();
          await writeOutcome(writer, mynt, buildId);
        }
        return { how: answered ? "answered" : "finished", status };
      }
      // Read again soon while the agent is active (it wrote something, or is mid-message).
      const wait = live.streaming || r.items.length > 0 ? ACTIVE_POLL_MS : POLL_MS;
      if (Date.now() + wait > opts.deadline) return { how: answered ? "answered" : "timeout", status };
      await sleep(wait);
    }
    return { how: "aborted", status };
  } finally {
    live.close();
    // Where the chat has got to, so the page can follow on from there (after Ship, say).
    if (status && !opts.signal.aborted) writer.write({ type: "data-state", data: { buildId, status, after: follower.position, ...meta }, transient: true });
  }
}
