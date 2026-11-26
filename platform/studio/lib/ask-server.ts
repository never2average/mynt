// What Ask AI's two routes share (app/api/ask for the studio, app/api/admin/ask for the platform admin): reading the
// question, the limits (one answer at a time and ASK_PER_HOUR questions an hour per person, counted in the session
// store with no question text), and the answer itself, streamed as server-sent events (lib/ask-answer.ts
// AskStreamEvent): the sources as they're read, the text as the model writes it, then the cleaned answer.
//
// The model is the first that answers among lib/llm.ts askModels(): when one fails, what it wrote so far is dropped
// (reset) and the next starts. What's asked and answered is never logged or stored.
import { NextResponse } from "next/server";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type Anthropic from "@anthropic-ai/sdk";
import { readCapped, STREAM_HEADERS, TOO_LARGE } from "./ai-route";
import { runAsk, type AskDeps } from "./ask";
import { cleanAnswer, NOT_COVERED, questionFrom, sourceOf, type AskAnswer, type AskArea, type AskSource, type AskStreamEvent } from "./ask-answer";
import { askModels, createLlm } from "./llm";
import type { Session } from "./session-store";
import { sessionStore } from "./session-store";
import { isAuthError, logLine } from "./studio-server";

// One answer at a time per user (a second tab or a double send waits for the first).
export const BUSY_SECONDS = 130;
// The request body's limit (a question is far smaller), and questions per user per hour.
export const MAX_BODY_BYTES = 64 * 1024;
export const ASK_PER_HOUR = 20;
export const ASK_WINDOW_SECONDS = 60 * 60;

const noStore = { "Cache-Control": "no-store" };
export const askJson = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

/** The question in a request's body ({ "question": "…" }), or the refusal to send. */
export async function readQuestion(req: Request): Promise<string | NextResponse> {
  const raw = await readCapped(req, MAX_BODY_BYTES);
  if (raw === TOO_LARGE) return askJson({ error: "too_large", message: "That question is too long." }, 413);
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const question = questionFrom((body as { question?: unknown } | null)?.question);
  if (!question) return askJson({ error: "bad_request", message: "Ask a question of a few words, in at most 400 characters." }, 400);
  return question;
}

const none = (reason: AskAnswer["reason"]): AskAnswer => ({ answer: null, covered: null, sources: [], model: null, reason });

export type AnswerRun = Pick<AskDeps, "tools" | "workspaceId" | "system" | "context" | "allowTool" | "knownTool" | "callTool">;

/**
 * Answers `question` for a signed-in session already connected to Mynt: counts it against the limits, then streams
 * the answer. `bucket` names the limits' counters (the studio's and the platform admin's are counted apart), `what`
 * the route in the server log, and `prepare` gives the area's tools, instructions and the one way its reads reach Mynt.
 */
export async function answerQuestion(
  req: Request,
  o: { area: AskArea; bucket: string; what: string; question: string; session: Session; mynt: Client; prepare: () => Promise<AnswerRun> },
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
  // Questions per user per hour, counted in the session store (shared by every instance). Past it there is no
  // answer, and the reason says why.
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
        await writeAnswer(o.area, o.what, o.question, session, await o.prepare(), send, req.signal);
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

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

async function writeAnswer(area: AskArea, what: string, question: string, session: Session, run: AnswerRun, send: (e: AskStreamEvent) => void, signal: AbortSignal) {
  const sources: AskSource[] = [];
  let text = "";
  // What was written before a read (the model saying it will look), or by a model that then failed, is dropped.
  const reset = () => {
    if (!text) return;
    text = "";
    send({ type: "reset" });
  };
  const cite = (s: Omit<AskSource, "n">) => {
    let found = sources.find((x) => x.href === s.href && x.title === s.title && x.heading === s.heading);
    if (!found) {
      found = { n: sources.length + 1, ...s };
      sources.push(found);
      send({ type: "sources", sources: [...sources] });
    }
    return found;
  };
  const history: MessageParam[] = [{ role: "user", content: question }];
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
          const out = await run.callTool(name, args);
          if (out.isError) return out;
          // Each read is a numbered source: the model cites it by that number.
          const s = cite(sourceOf(area, name, args));
          return { text: `Source [${s.n}] (${s.title}${s.heading ? `, ${s.heading}` : ""}):\n${out.text}`, isError: false };
        },
        emit: (ev) => {
          if (ev.type === "text") {
            text += ev.delta;
            send({ type: "delta", text: ev.delta });
          } else if (ev.type === "tool") reset();
        },
      });
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
  const answer = model ? cleanAnswer(text, sources.length) : "";
  if (!answer) return send({ type: "done", ...none("unavailable") });
  send({ type: "done", answer, covered: !NOT_COVERED.test(answer), model, reason: null });
}
