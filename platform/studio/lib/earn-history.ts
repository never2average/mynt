// Earn's past conversations, kept per signed-in user in this browser (localStorage), so the user can
// pick one up again from the chat's "Past conversations" button. Earn's assistant keeps nothing on
// the server (app/api/earn never stores or logs what's asked), so this is the only copy: another
// browser, a private window or cleared site data starts with none. The user is the wallet list's
// owner, a hash of the user (lib/wallets-server.ts ownerOf), never their name or email.
//
// A thread keeps its messages (with the panel's data parts, so its matched pools and drafts come
// back) and, per draft, the idempotency key it was or will be sent with and whether it was sent:
// a restored draft is never sent twice under a new key.

import type { UIMessage } from "ai";

export const HISTORY_KEY = "mynt.earn.threads";
export const MAX_THREADS = 30;
const TITLE_CHARS = 120;

export type SavedOutcome = { key: string | null; sent: string | null }; // sent: what Mynt answered, once sent
export type EarnThreadRecord = { id: string; title: string; updatedAt: string; messages: UIMessage[]; outcomes: Record<string, SavedOutcome> };
type StorageLike = Pick<Storage, "getItem" | "setItem">;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function historyStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// The first question, on one line: the thread's title in the list.
export function threadTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text || "Untitled conversation";
}

function readAll(s: StorageLike | null): Record<string, EarnThreadRecord[]> {
  try {
    const v = JSON.parse(s?.getItem(HISTORY_KEY) ?? "{}") as unknown;
    if (!isObj(v)) return {};
    const out: Record<string, EarnThreadRecord[]> = {};
    for (const [owner, list] of Object.entries(v)) {
      if (!Array.isArray(list)) continue;
      out[owner] = list.filter((t): t is EarnThreadRecord => isObj(t) && typeof t.id === "string" && typeof t.title === "string" && typeof t.updatedAt === "string" && Array.isArray(t.messages)).map((t) => ({ ...t, outcomes: isObj(t.outcomes) ? (t.outcomes as Record<string, SavedOutcome>) : {} }));
    }
    return out;
  } catch {
    return {};
  }
}

// This user's threads in this browser, newest first.
export function listThreads(owner: string | null, s: StorageLike | null = historyStorage()): EarnThreadRecord[] {
  if (!owner) return [];
  return [...(readAll(s)[owner] ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// Saves (or replaces) one thread and returns the user's list as it now is, newest first, at most
// MAX_THREADS (the oldest go first). When the browser's storage is full, older threads are dropped
// until it fits; when storage is blocked, nothing is kept and the list is what it was.
export function saveThread(owner: string | null, thread: EarnThreadRecord, s: StorageLike | null = historyStorage()): EarnThreadRecord[] {
  if (!owner || !s || !thread.messages.length) return listThreads(owner, s);
  const all = readAll(s);
  let mine = [thread, ...(all[owner] ?? []).filter((t) => t.id !== thread.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_THREADS);
  for (;;) {
    try {
      s.setItem(HISTORY_KEY, JSON.stringify({ ...all, [owner]: mine }));
      announceThreads();
      return mine;
    } catch {
      if (mine.length <= 1) return listThreads(owner, s);
      mine = mine.slice(0, Math.ceil(mine.length / 2));
    }
  }
}

export const newThreadId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);

// "21 Nov 2026, 14:05" in the user's own locale and time zone.
export const threadDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

// Told to the sidebar's chat search whenever this browser's threads change.
export const THREADS_CHANGED = "mynt:earn-threads-changed";
export function announceThreads() {
  try {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(THREADS_CHANGED));
  } catch {
    // nothing listens outside a browser
  }
}

// The sidebar's Search chats, already on Earn: open this thread (detail: its id; null for a new one)
// without reloading the page.
export const OPEN_THREAD = "mynt:earn-open-thread";

// A thread's words, on one line: what the chat search looks through.
export function threadText(t: EarnThreadRecord): string {
  return t.messages
    .flatMap((m) => (m.parts ?? []).map((p) => (p.type === "text" ? p.text : "")))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ThreadMatch = { thread: EarnThreadRecord; snippet: string | null };

// The threads whose title or words contain every word of the query (any case), in the order given, each
// with the words around its first match. An empty query matches every thread, with no snippet.
export function searchThreads(threads: EarnThreadRecord[], query: string, around = 40): ThreadMatch[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return threads.map((thread) => ({ thread, snippet: null }));
  const out: ThreadMatch[] = [];
  for (const thread of threads) {
    const text = threadText(thread);
    const hay = `${thread.title} ${text}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const i = text.toLowerCase().indexOf(words[0]);
    if (i < 0) {
      out.push({ thread, snippet: null });
      continue;
    }
    const start = Math.max(0, i - around);
    const end = Math.min(text.length, i + words[0].length + around);
    out.push({ thread, snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}` });
  }
  return out;
}
