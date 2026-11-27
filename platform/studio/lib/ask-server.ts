// What Ask AI's two routes share (app/api/ask for the studio, app/api/admin/ask for the platform admin): reading the
// question and the conversation so far, the limits (one answer at a time and ASK_PER_HOUR questions an hour per
// person, counted in the session store with no question text), and the answer itself, streamed as server-sent events
// (lib/ask-answer.ts AskStreamEvent): the model's thinking as it's written, each read as it starts and ends, the
// sources as they're read, the text as the model writes it, then the cleaned answer.
//
// The model is the first that answers among lib/llm.ts askModels(): when one fails, what it wrote so far is dropped
// (reset) and the next starts. What's asked and answered is never logged or stored: the conversation is the browser's,
// sent again with each follow-up.
import { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type Anthropic from "@anthropic-ai/sdk";
import { readCapped, STREAM_HEADERS, TOO_LARGE } from "./ai-route";
import { runAsk, type AskDeps } from "./ask";
import { cleanAnswer, conversationFrom, hasUncited, NOT_COVERED, questionFrom, type AskAnswer, type AskArea, type AskSource, type AskStreamEvent } from "./ask-answer";
import { argsSummary, readLabel, readSummary, sourcesOf } from "./ask-sources";
import { askModels, createLlm } from "./llm";
import { scrub, scrubStream, scrubText } from "./scrub";
import type { Session } from "./session-store";
import { sessionStore } from "./session-store";
import { isAuthError, logLine } from "./studio-server";

// One answer at a time per user (a second tab or a double send waits for the first).
export const BUSY_SECONDS = 130;
// The request body's limit (a conversation as text is far smaller), and questions per user per hour.
export const MAX_BODY_BYTES = 64 * 1024;
export const ASK_PER_HOUR = 20;
export const ASK_WINDOW_SECONDS = 60 * 60;
/** Sources one answer can number (its citations are one or two digits), and how much of a read's reply the panel is shown. */
export const MAX_SOURCES = 60;
export const MAX_RESULT_SHOWN = 4000;

const noStore = { "Cache-Control": "no-store" };
export const askJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type Asked = { question: string; history: MessageParam[] };

/** The question in a request's body ({ "question": "…", "history": [{ role, text }] }) with the conversation so far, or the refusal to send. */
export async function readAsk(req: Request): Promise<Asked | NextResponse> {
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === TOO_LARGE) return askJson({ error: "too_large", message: "That conversation is too long. Start a new chat." }, 413);
  let body: { question?: unknown; history?: unknown } | null = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const question = questionFrom(body?.question);
  if (!question) return askJson({ error: "bad_request", message: "Ask a question of a few words, in at most 400 characters." }, 400);
  if (body?.history !== undefined && !Array.isArray(body.history)) return askJson({ error: "bad_request", message: "That isn't a conversation Ask AI can read." }, 400);
  return { question, history: conversationFrom(body?.history, question) };
}

const none = (reason: AskAnswer["reason"]): AskAnswer => ({ answer: null, covered: null, sources: [], model: null, reason });

export type AnswerRun = Pick<AskDeps, "tools" | "workspaceId" | "system" | "context" | "allowTool" | "knownTool" | "callTool">;

/**
 * Answers the last question of `asked` for a signed-in session already connected to Mynt: counts it against the
 * limits, then streams the answer. `bucket` names the limits' counters (the studio's and the platform admin's are
 * counted apart), `what` the route in the server log, and `prepare` gives the area's tools, instructions and the one
 * way its reads reach Mynt.
 */
export async function answerQuestion(
  req: Request,
  o: { area: AskArea; bucket: string; what: string; asked: Asked; session: Session; mynt: Client; prepare: () => Promise<AnswerRun> },
): Promise<Response> {
  const { session, mynt } = o;
  const done = async () => {
    await mynt.close().catch(() => undefined);
    await sessionStore()
      .save(session)
      .catch((err) => console.error(logLine("saving the session", err)));
  };
  const who = session.userId ?? session.id;
  const release = await sessionStore().claim(`${o.bucket}-busy`, who, BUSY_SECONDS);
  if (!release) {
    await done();
    return askJson({ error: "busy", message: "Ask AI is still answering your last question." }, 429);
  }
  // Questions per user per hour (a follow-up is a question), counted in the session store (shared by every
  // instance). Past it there is no answer, and the reason says why.
  if ((await sessionStore().count(o.bucket, who, ASK_WINDOW_SECONDS)) > ASK_PER_HOUR) {
    await release().catch(() => undefined);
    await done();
    return askJson(none("rate_limited"));
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const send = (e: AskStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false; // the browser went away
        }
      };
      try {
        await writeAnswer(o.area, o.what, o.asked.history, await o.prepare(), send, req.signal);
      } catch (err) {
        if (isAuthError(err)) {
          session.tokens = undefined;
          send({ type: "done", ...none("signed_out") });
        } else {
          console.error(logLine(o.what, err));
          send({ type: "done", ...none("unavailable") });
        }
      } finally {
        await release().catch(() => undefined);
        await done();
        if (open) controller.close();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", ...STREAM_HEADERS } });
}

/** A read's reply as the panel is shown it: secrets replaced, as JSON, cut to MAX_RESULT_SHOWN. */
export function shownResult(result: unknown): string {
  const text = typeof result === "string" ? scrubText(result) : JSON.stringify(scrub(result), null, 1);
  return text.length > MAX_RESULT_SHOWN ? `${text.slice(0, MAX_RESULT_SHOWN)}\n…(cut short)` : text;
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

async function writeAnswer(area: AskArea, what: string, history: MessageParam[], run: AnswerRun, send: (e: AskStreamEvent) => void, signal: AbortSignal) {
  const sources: AskSource[] = [];
  let text = "";
  // What the model writes and thinks is scrubbed as it streams (scrub.ts scrubStream): it has only seen scrubbed reads,
  // and this is the second lock on what reaches the browser.
  const written = scrubStream((t) => send({ type: "delta", text: t }));
  let thinkingId = "";
  const thoughts = scrubStream((t) => send({ type: "reasoning", id: thinkingId, text: t }));
  // What was written before a read (the model saying it will look), or by a model that then failed, is dropped.
  const reset = () => {
    thoughts.flush();
    written.reset();
    if (!text) return;
    text = "";
    send({ type: "reset" });
  };
  // Each record a read returned is a numbered source; one already numbered keeps its number.
  const cite = (tool: string, refs: { title: string; href: string }[]): AskSource[] => {
    const cited: AskSource[] = [];
    let added = false;
    for (const ref of refs) {
      let found = sources.find((x) => x.href === ref.href && x.title === ref.title);
      if (!found && sources.length < MAX_SOURCES) {
        found = { n: sources.length + 1, title: ref.title, href: ref.href, tool, readAt: new Date().toISOString() };
        sources.push(found);
        added = true;
      }
      if (found) cited.push(found);
    }
    if (added) send({ type: "sources", sources: [...sources] });
    return cited;
  };

  let steps = 0;
  // Reads that reached callTool, by name: a "tool" event with none waiting is a call that was refused before it ran.
  const ran = new Map<string, number>();
  let thinking = 0;
  let thoughtAt = 0;
  let thoughtMs = 0;
  let thought = false;

  const llm = createLlm();
  let model: string | null = null;
  for (const candidate of askModels()) {
    try {
      await runAsk(history, {
        ...run,
        llm,
        model: candidate,
        signal,
        callTool: async (name, args) => {
          reset();
          const id = `s${++steps}`;
          ran.set(name, (ran.get(name) ?? 0) + 1);
          const started = Date.now();
          send({ type: "tool_start", id, tool: name, label: readLabel(area, name), args: scrubText(argsSummary(args)) });
          let out: { text: string; isError: boolean };
          try {
            out = await run.callTool(name, args);
          } catch (err) {
            send({ type: "tool_end", id, ok: false, ms: Date.now() - started, summary: "Failed", message: "Mynt couldn't be reached." });
            throw err;
          }
          const ms = Date.now() - started;
          if (out.isError) {
            const message = scrubText(out.text).slice(0, 300);
            send({ type: "tool_end", id, ok: false, ms, summary: "Failed", message });
            return { text: message, isError: true };
          }
          const result = parsed(out.text);
          const cited = cite(name, sourcesOf(area, name, args, result));
          send({ type: "tool_end", id, ok: true, ms, summary: readSummary(area, name, result), result: shownResult(result) });
          // The model is told this read's numbered sources, and cites only those.
          const legend = cited.map((s) => `[${s.n}] ${s.title}`).join("\n");
          // The model reads what the panel is shown, in full: values under secret-named keys hidden as well as text
          // that looks like a secret, never the reply as Mynt sent it.
          const forModel = typeof result === "string" ? scrubText(result) : JSON.stringify(scrub(result));
          return { text: `Sources for this read (cite a statement by the number of the source it comes from; the first is the whole read):\n${legend}\n\n${forModel}`, isError: false };
        },
        emit: (ev) => {
          if (ev.type === "text") {
            thoughts.flush();
            text += ev.delta;
            written.push(ev.delta);
          } else if (ev.type === "reasoning-start") {
            thoughts.flush();
            thinking++;
            thinkingId = `r${thinking}`;
            thoughtAt = Date.now();
          } else if (ev.type === "reasoning") {
            thought = true;
            thoughts.push(ev.delta);
          } else if (ev.type === "reasoning-end") {
            thoughts.flush();
            thoughtMs += Date.now() - thoughtAt;
          } else if (ev.type === "tool") {
            reset();
            const waiting = ran.get(ev.name) ?? 0;
            if (waiting > 0) ran.set(ev.name, waiting - 1);
            else {
              // Refused before it ran: not a read Ask AI may make, or one read too many.
              const id = `s${++steps}`;
              const input = ev.input && typeof ev.input === "object" ? (ev.input as Record<string, unknown>) : {};
              send({ type: "tool_start", id, tool: ev.name, label: readLabel(area, ev.name), args: scrubText(argsSummary(input)) });
              send({ type: "tool_end", id, ok: false, ms: 0, summary: "Not run", message: "Not run: Ask AI can only read, and only so much per question." });
            }
          }
        },
      });
      thoughts.flush();
      written.flush();
      model = candidate;
      break;
    } catch (err) {
      // A sign-in Mynt no longer accepts ends the answer; any other failure moves on to the next model.
      if (isAuthError(err)) throw err;
      if (signal.aborted) return;
      console.error(logLine(what, err));
      reset();
    }
  }
  if (signal.aborted) return;
  const answer = model ? cleanAnswer(scrubText(text), sources.length) : "";
  if (!answer) return send({ type: "done", ...none("unavailable"), ...(thought ? { thoughtMs } : {}) });
  send({ type: "done", answer, covered: !NOT_COVERED.test(answer), model, reason: null, uncited: hasUncited(answer), ...(thought ? { thoughtMs } : {}) });
}
