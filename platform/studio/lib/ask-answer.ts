// Ask AI's conversation, as the browser and the server share it: a question, answered from Mynt's own data with
// numbered citations and the sources under it, then follow-ups answered with the conversation so far. The sources are
// the records the answer's reads returned, each as the page that holds it (lib/ask-sources.ts). Pure functions only:
// the panel (components/kbar/ask-ai.tsx) and the routes (app/api/ask, app/api/admin/ask through lib/ask-server.ts)
// both import this.

export type AskArea = "studio" | "admin";
/** A source of an answer: the record or page a fact came from, the read that returned it, and when it was read. */
export interface AskSource { n: number; title: string; href: string; tool: string; readAt: string }
/** Why there is no answer: the hourly limit, the sign-in ended, or no model answered. */
export type AskReason = "rate_limited" | "signed_out" | "unavailable" | null;
export interface AskAnswer {
  answer: string | null; covered: boolean | null; sources: AskSource[]; model: string | null; reason: AskReason;
  /** Some statement in the answer cites no source. */
  uncited?: boolean;
  /** How long the model thought, in milliseconds; absent when it returned no thinking. */
  thoughtMs?: number;
}

/**
 * What the stream sends, as it happens: the model's thinking as it's written (one id per block), each read as it
 * starts and as it ends, the sources so far, the answer's text as it is written (reset: drop what came so far), then
 * the final answer, cleaned, or none with the reason.
 */
export type AskStreamEvent =
  | { type: "reasoning"; id: string; text: string }
  | { type: "tool_start"; id: string; tool: string; label: string; args: string }
  | { type: "tool_end"; id: string; ok: boolean; ms: number; summary: string; result?: string; message?: string }
  | { type: "sources"; sources: AskSource[] }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "done"; answer: string | null; covered: boolean | null; model: string | null; reason: AskReason; uncited?: boolean; thoughtMs?: number };

export const ASK_URL: Record<AskArea, string> = { studio: "/api/ask", admin: "/api/admin/ask" };

export const MIN_QUESTION = 3;
export const MAX_ASK_QUESTION = 400;
/** Earlier turns sent with a question, and how much of an earlier answer is kept. */
export const MAX_HISTORY_TURNS = 20;
export const MAX_ANSWER_KEPT = 4000;

/** A question worth asking: two words or more (or one ending in "?"), at least 6 characters. */
export const askable = (q: string) => q.trim().length >= 6 && (q.trim().split(/\s+/).length >= 2 || q.trim().endsWith("?"));

/** The question as it's asked: whitespace folded; null when it's too short or too long to ask. */
export function questionFrom(value: unknown): string | null {
  const q = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return q.length >= MIN_QUESTION && q.length <= MAX_ASK_QUESTION ? q : null;
}

export type AskTurn = { role: "user" | "assistant"; text: string };

/**
 * The conversation as the model takes it: the earlier turns as text (the last MAX_HISTORY_TURNS, each cut to its
 * limit, an answer's [n] citations removed: every answer numbers its own sources), then the question. Turns of one
 * role in a row are joined, and it always starts with a question. Anything that isn't a turn is left out.
 */
export function conversationFrom(history: unknown, question: string): { role: "user" | "assistant"; content: string }[] {
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  const list = Array.isArray(history) ? history.slice(-MAX_HISTORY_TURNS) : [];
  for (const t of list) {
    const role = (t as AskTurn | null)?.role;
    const raw = (t as AskTurn | null)?.text;
    if ((role !== "user" && role !== "assistant") || typeof raw !== "string") continue;
    const content = role === "user" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_ASK_QUESTION) : raw.replace(/\s?\[\d{1,2}\]/g, "").trim().slice(0, MAX_ANSWER_KEPT);
    if (!content) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== "user") turns.shift();
  const last = turns[turns.length - 1];
  if (last && last.role === "user") last.content = `${last.content}\n\n${question}`;
  else turns.push({ role: "user", content: question });
  return turns;
}

/** An answer made safe to show: links and images become their text, HTML tags and headings go, citations of numbers
 *  outside 1..n are dropped, at most 1500 characters. */
export function cleanAnswer(text: string, n: number): string {
  let a = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\s?\[(\d{1,2})\]/g, (m, d) => (Number(d) >= 1 && Number(d) <= n ? m : ""))
    .trim();
  if (a.length > 1500) a = `${a.slice(0, a.lastIndexOf(" ", 1497))}…`;
  return a;
}

/** How an answer that the data doesn't cover starts (the instructions ask for it). */
export const NOT_COVERED = /^mynt.s data doesn.t cover this/i;

const CITED = /\[\d{1,2}\]/;
/**
 * Whether some statement in a cleaned answer cites no source: a sentence of five words or more with no [n], other
 * than a line that leads into a list (it ends with a colon) and an answer that says the data doesn't cover the
 * question. Nothing is added to the answer for it; the panel says "Some statements have no source".
 */
export function hasUncited(answer: string): boolean {
  if (NOT_COVERED.test(answer)) return false;
  const blocks = answer
    .split(/\n+/)
    .map((b) => b.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  for (const block of blocks)
    for (const sentence of block.split(/(?<=[.!?])\s+(?=[A-Z"“(])/)) {
      const s = sentence.trim();
      if (CITED.test(s) || s.endsWith(":")) continue;
      if (s.replace(/[*_`]/g, "").split(/\s+/).filter(Boolean).length >= 5) return true;
    }
  return false;
}

/** The answer's [n] citations as links to the cited sources; a number with no source stays text. */
export const linked = (md: string, sources: AskSource[]) =>
  md.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
    const s = sources.find((x) => x.n === Number(n));
    return s ? `[\\[${n}\\]](${s.href})` : m;
  });

export const UNAVAILABLE: Record<Exclude<AskReason, null>, string> = {
  unavailable: "Ask AI couldn't answer just now. Please ask again.",
  rate_limited: "That was a lot of questions in an hour. Ask AI will answer again shortly; search still works.",
  signed_out: "Your session ended. Sign in again to ask.",
};
export const UNCITED = "Some statements have no source.";

/** How long, in words: "under a second", "6s", "1m 5s". */
export function seconds(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 1 ? "under a second" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
