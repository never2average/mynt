// Earn's past conversations, kept per signed-in user on Mynt's server (lib/chat-sessions.ts, through
// app/api/threads), so the user can pick one up again from the chat's "Past conversations" button, in
// any browser they sign in from. Only the user reads their own. Earn's assistant itself (app/api/earn)
// never stores or logs what's asked.
//
// A thread keeps its messages (with the panel's data parts, so its matched pools and drafts come
// back) and, per draft, the idempotency key it was or will be sent with and whether it was sent:
// a restored draft is never sent twice under a new key.

import type { ThreadSummary } from "./chat-sessions";

export { newThreadId, threadTitle } from "./chat-sessions";

// sent: what Mynt answered, once sent; declined: the user declined the draft, so it's never sent.
export type SavedOutcome = { key: string | null; sent: string | null; declined?: true };
// One past conversation in the list (its messages are read when it's opened).
export type EarnThreadRecord = Pick<ThreadSummary, "id" | "title" | "updatedAt">;

// What a saved outcome read back from Mynt holds, checked (anything else counts as not sent, with no key).
export function savedOutcomesFrom(all: Record<string, Record<string, unknown>>): Record<string, SavedOutcome> {
  return Object.fromEntries(
    Object.entries(all).map(([id, o]) => [id, { key: typeof o.key === "string" ? o.key : null, sent: typeof o.sent === "string" ? o.sent : null, ...(o.declined === true ? { declined: true as const } : {}) }]),
  );
}

// "21 Nov 2026, 14:05" in the user's own locale and time zone.
export const threadDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

export type ThreadMatch = { thread: EarnThreadRecord; snippet: string | null };

// The threads whose title holds every word of the query (any case), in the order given: what the chat
// search shows at once, before Mynt answers with the ones whose words match too. An empty query
// matches every thread, with no snippet.
export function searchThreads(threads: EarnThreadRecord[], query: string): ThreadMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return threads.filter((t) => words.every((w) => t.title.toLowerCase().includes(w))).map((thread) => ({ thread, snippet: null }));
}
