// The studio's chats, kept on Mynt's server for the signed-in user (core/src/chat-sessions.ts): the
// Build page's financial-product chats and Earn's chats share this one client. A chat is a session
// with an append-only log of events, as a coding agent keeps its session file: each UI message (data
// parts included) is a 'message' event, what became of a draft is an 'outcome' event, a new title a
// 'title' event, small references (the products a chat created) a 'metadata' event. Nothing is sent
// twice: each event carries a client id made from what it holds, so a retried save is skipped by Mynt,
// and only what changed since the last save is appended. A message appended again under its id
// replaces the earlier copy when the session is replayed.
//
// Saving never gets in the user's way: it's debounced, a failure (offline, Mynt down) keeps the chat
// as it is and tries again later, and Mynt refusing (the chat too long to keep) stops trying for that
// chat only. On first load, chats an older studio kept in this browser (localStorage) are uploaded
// once (the same client ids, so it's safe to repeat) and then cleared there.
//
// Pure apart from fetch, timers and the storage calls, so the components and the tests share it.
import type { UIMessage } from "ai";
import { z } from "zod";

export const CHAT_KINDS = ["product", "earn"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

// Mynt's limits (core/src/chat-sessions.ts), checked here too so junk stays off the wire.
export const MAX_EVENTS_PER_SAVE = 100;
export const MAX_TITLE = 200;
const TITLE_CHARS = 120;

export const SessionId = z.string().uuid();
export const ChatKindSchema = z.enum(CHAT_KINDS);
const metadataValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.string().max(200)).max(50)]);
export const SessionMetadata = z.record(z.string().max(60), metadataValue);
export const SessionEvent = z
  .object({
    type: z.enum(["message", "outcome", "title", "metadata"]),
    role: z.enum(["user", "assistant", "system"]).nullable().optional(),
    client_id: z.string().regex(/^[A-Za-z0-9:_.-]{1,200}$/),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type SessionEvent = z.infer<typeof SessionEvent>;
// POST /api/threads: start the session if it isn't there yet, then append these events.
export const SaveRequest = z
  .object({
    id: SessionId,
    kind: ChatKindSchema,
    title: z.string().max(MAX_TITLE).optional(),
    events: z.array(SessionEvent).max(MAX_EVENTS_PER_SAVE),
  })
  .strict();
export type SaveRequest = z.infer<typeof SaveRequest>;

// One kept chat in a list (no messages), and one read back whole.
export type ThreadSummary = { id: string; kind: string; title: string; updatedAt: string; metadata: Record<string, unknown>; snippet?: string | null };
export type Outcomes = Record<string, Record<string, unknown>>;
export type ChatThread = { id: string; kind: string; title: string; updatedAt: string; metadata: Record<string, unknown>; messages: UIMessage[]; outcomes: Outcomes };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

// The first question, on one line: the chat's title.
export function threadTitle(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS - 1)}…` : text || "Untitled conversation";
}

// A random UUID (Mynt's session ids are UUIDs), even where crypto.randomUUID isn't offered.
export function newThreadId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  h[12] = "4";
  h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8).join("")}-${h.slice(8, 12).join("")}-${h.slice(12, 16).join("")}-${h.slice(16, 20).join("")}-${h.slice(20).join("")}`;
}

// A short, stable hash of a string (FNV-1a, twice with different seeds): what an event's client id is made of.
export function hashOf(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193 + 2);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An older chat's id as a session id: itself when it's a UUID, else a UUID made from it (always the same one).
export function sessionIdFor(id: string): string {
  if (UUID.test(id)) return id.toLowerCase();
  const h = (hashOf(`${id}#1`) + hashOf(`${id}#2`)).split("");
  h[12] = "5";
  h[16] = ((parseInt(h[16], 16) & 3) | 8).toString(16);
  const x = h.join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
const idPart = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "_";

// ---- replaying a session, and what to append to it ----

export type StoredEvent = { seq: number; type: string; role?: string | null; payload: Record<string, unknown> };

// A session's events, in order, as the chat: each message as last appended (in the order they first
// appeared), and each draft's latest outcome.
export function replay(events: readonly StoredEvent[]): { messages: UIMessage[]; outcomes: Outcomes } {
  const order: string[] = [];
  const messages = new Map<string, UIMessage>();
  const outcomes: Outcomes = {};
  for (const e of [...events].sort((x, y) => x.seq - y.seq)) {
    if (e.type === "message" && isObj(e.payload) && typeof e.payload.id === "string" && Array.isArray(e.payload.parts)) {
      const m = e.payload as unknown as UIMessage;
      if (!messages.has(m.id)) order.push(m.id);
      messages.set(m.id, m);
    } else if (e.type === "outcome" && isObj(e.payload) && typeof e.payload.draft_id === "string") {
      const { draft_id, ...rest } = e.payload;
      outcomes[draft_id as string] = rest;
    }
  }
  return { messages: order.map((id) => messages.get(id)!), outcomes };
}

// What a chat holds now, to be saved.
export type Snapshot = { messages: UIMessage[]; outcomes: Outcomes; metadata?: Record<string, unknown> };
// What Mynt already has of a chat: each message's and outcome's hash, its title and metadata.
export type Synced = { created: boolean; messages: Record<string, string>; outcomes: Record<string, string>; title: string; metadata: string };
export const NOT_SYNCED: Synced = { created: false, messages: {}, outcomes: {}, title: "", metadata: "{}" };

// What a chat read back from Mynt already holds (so reopening it appends nothing).
export function syncedFrom(t: Pick<ChatThread, "messages" | "outcomes" | "title" | "metadata">): Synced {
  return {
    created: true,
    messages: Object.fromEntries(t.messages.map((m) => [m.id, hashOf(JSON.stringify(m))])),
    outcomes: Object.fromEntries(Object.entries(t.outcomes).map(([id, o]) => [id, hashOf(JSON.stringify(o))])),
    title: t.title,
    metadata: JSON.stringify(t.metadata ?? {}),
  };
}

// The events to append so Mynt has the snapshot, and what it will then have.
export function eventsFor(s: Snapshot, synced: Synced): { title: string; events: SessionEvent[]; next: Synced } {
  const next: Synced = { created: true, messages: { ...synced.messages }, outcomes: { ...synced.outcomes }, title: synced.title, metadata: synced.metadata };
  const events: SessionEvent[] = [];
  for (const m of s.messages) {
    const h = hashOf(JSON.stringify(m));
    if (synced.messages[m.id] === h) continue;
    events.push({ type: "message", role: m.role, client_id: `m:${idPart(m.id)}:${h}`, payload: m as unknown as Record<string, unknown> });
    next.messages[m.id] = h;
  }
  for (const [id, o] of Object.entries(s.outcomes)) {
    const h = hashOf(JSON.stringify(o));
    if (synced.outcomes[id] === h) continue;
    events.push({ type: "outcome", client_id: `o:${idPart(id)}:${h}`, payload: { draft_id: id, ...o } });
    next.outcomes[id] = h;
  }
  const title = threadTitle(s.messages).slice(0, MAX_TITLE);
  if (synced.created && title !== synced.title) events.push({ type: "title", client_id: `t:${hashOf(title)}`, payload: { title } });
  next.title = title;
  const metadata = JSON.stringify(s.metadata ?? {});
  if (s.metadata && metadata !== synced.metadata) events.push({ type: "metadata", client_id: `d:${hashOf(metadata)}`, payload: s.metadata });
  next.metadata = s.metadata ? metadata : synced.metadata;
  return { title, events, next };
}

// ---- talking to the studio's /api/threads ----

type Fetcher = typeof fetch;
const defaultFetch: Fetcher = (...a) => fetch(...a);

export function summariesFrom(body: unknown): ThreadSummary[] {
  const list = isObj(body) && Array.isArray(body.threads) ? body.threads : [];
  return list
    .filter((t): t is Record<string, unknown> => isObj(t) && typeof t.id === "string" && typeof t.updatedAt === "string")
    .map((t) => ({ id: t.id as string, kind: str(t.kind), title: str(t.title) || "Untitled conversation", updatedAt: t.updatedAt as string, metadata: isObj(t.metadata) ? t.metadata : {}, ...(typeof t.snippet === "string" || t.snippet === null ? { snippet: t.snippet as string | null } : {}) }));
}

// The user's chats of a kind, newest first (null: couldn't be read just now). With a query, only the
// ones whose title or words hold every word of it, each with the words around the match.
export async function listChats(kind: ChatKind, opts: { query?: string; fetcher?: Fetcher } = {}): Promise<ThreadSummary[] | null> {
  const q = new URLSearchParams({ kind });
  if (opts.query?.trim()) q.set("q", opts.query.trim().slice(0, 200));
  try {
    const res = await (opts.fetcher ?? defaultFetch)(`/api/threads?${q}`, { cache: "no-store" });
    if (!res.ok) return null;
    return summariesFrom(await res.json());
  } catch {
    return null;
  }
}

// One chat, replayed (null: not the user's, or couldn't be read just now).
export async function loadChat(id: string, fetcher: Fetcher = defaultFetch): Promise<ChatThread | null> {
  try {
    const res = await fetcher(`/api/threads/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    const t = (await res.json()) as unknown;
    if (!isObj(t) || typeof t.id !== "string" || !Array.isArray(t.messages)) return null;
    return { id: t.id, kind: str(t.kind), title: str(t.title), updatedAt: str(t.updatedAt), metadata: isObj(t.metadata) ? t.metadata : {}, messages: t.messages as UIMessage[], outcomes: isObj(t.outcomes) ? (t.outcomes as Outcomes) : {} };
  } catch {
    return null;
  }
}

export async function deleteChat(id: string, fetcher: Fetcher = defaultFetch): Promise<boolean> {
  try {
    return (await fetcher(`/api/threads/${encodeURIComponent(id)}`, { method: "DELETE" })).ok;
  } catch {
    return false;
  }
}

// ok: saved; retry: not saved, try again later (offline, Mynt unreachable); refused: Mynt won't keep it.
export type SaveResult = "ok" | "retry" | "refused";
export async function postSave(body: SaveRequest, fetcher: Fetcher = defaultFetch): Promise<SaveResult> {
  try {
    const text = JSON.stringify(body);
    const res = await fetcher("/api/threads", { method: "POST", headers: { "content-type": "application/json" }, body: text, keepalive: text.length < 60_000 });
    if (res.ok) return "ok";
    return res.status === 413 || res.status === 422 || res.status === 400 || res.status === 403 ? "refused" : "retry";
  } catch {
    return "retry";
  }
}

// Saves a chat, in batches of at most MAX_EVENTS_PER_SAVE; returns what Mynt then has.
export async function saveChat(kind: ChatKind, id: string, s: Snapshot, synced: Synced, fetcher?: Fetcher): Promise<{ result: SaveResult; synced: Synced }> {
  const { title, events, next } = eventsFor(s, synced);
  if (!events.length && synced.created) return { result: "ok", synced };
  if (!s.messages.length && !synced.created) return { result: "ok", synced };
  for (let i = 0; i === 0 || i < events.length; i += MAX_EVENTS_PER_SAVE) {
    const result = await postSave({ id, kind, title, events: events.slice(i, i + MAX_EVENTS_PER_SAVE) }, fetcher);
    if (result !== "ok") return { result, synced: i === 0 ? synced : { ...synced, created: true } };
  }
  return { result: "ok", synced: next };
}

// ---- saving as the chat goes ----

// How long a save waits for the chat to settle, and the longest wait between retries.
export const saveTiming = { delayMs: 400, maxRetryMs: 60_000 };

// One per chat surface (the Build page's product mode, Earn). save() is called whenever the chat
// changes; the last snapshot of each chat is saved after a short pause (at once with `now`), one save
// at a time. A failure keeps the snapshot and tries again, waiting longer each time.
export class ChatSaver {
  private synced = new Map<string, Synced>();
  private pending = new Map<string, Snapshot>();
  private refused = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private failures = 0;
  private disposed = false;

  constructor(
    private kind: ChatKind,
    private opts: { fetcher?: Fetcher; onSaved?: (id: string) => void } = {},
  ) {
    // Closing the tab: what's waiting goes now (small saves as keepalive requests, which outlive the page).
    if (typeof window !== "undefined") window.addEventListener("pagehide", () => this.pending.size && void this.flush());
  }

  // A chat read back from Mynt: what it holds is already saved.
  adopt(id: string, t: Pick<ChatThread, "messages" | "outcomes" | "title" | "metadata">) {
    this.synced.set(id, syncedFrom(t));
    this.pending.delete(id);
  }

  save(id: string, s: Snapshot, opts: { now?: boolean } = {}) {
    if (this.refused.has(id) || !s.messages.length) return;
    // Saving again after dispose (React mounting the page again, as Strict Mode does) carries on.
    this.disposed = false;
    this.pending.set(id, s);
    this.schedule(opts.now ? 0 : saveTiming.delayMs);
  }

  // Whether this chat still has something waiting to be saved.
  isPending(id: string) {
    return this.pending.has(id);
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, ms);
  }

  async flush(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      let retry = false;
      for (const [id, s] of [...this.pending]) {
        this.pending.delete(id);
        const { result, synced } = await saveChat(this.kind, id, s, this.synced.get(id) ?? NOT_SYNCED, this.opts.fetcher);
        this.synced.set(id, synced);
        if (result === "ok") this.opts.onSaved?.(id);
        else if (result === "refused") this.refused.add(id);
        else {
          if (!this.pending.has(id)) this.pending.set(id, s);
          retry = true;
        }
      }
      this.running = null;
      if (this.disposed) return;
      if (retry) {
        this.failures += 1;
        this.schedule(Math.min(saveTiming.maxRetryMs, 1000 * 2 ** Math.min(this.failures, 6)));
      } else {
        this.failures = 0;
        if (this.pending.size) this.schedule(saveTiming.delayMs);
      }
    })();
    return this.running;
  }

  // Leaving the page: whatever is waiting goes now, once (no more retries after it).
  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size) void this.flush();
    this.disposed = true;
  }
}

// ---- chats an older studio kept in this browser ----

export const LEGACY_KEYS: Record<ChatKind, string> = { product: "mynt.studio.product-chats", earn: "mynt.earn.threads" };
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

type LegacyThread = { id: string; updatedAt: string; messages: UIMessage[]; outcomes: Outcomes; metadata?: Record<string, unknown> };
// An older chat as a snapshot: a product chat's created drafts become outcomes ({ product_id }) and its
// metadata's product_ids; an Earn chat's outcomes are kept as they were.
function legacyThreads(kind: ChatKind, list: unknown): LegacyThread[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((t): t is Record<string, unknown> => isObj(t) && typeof t.id === "string" && Array.isArray(t.messages) && t.messages.length > 0)
    .map((t) => {
      if (kind === "product") {
        const created = isObj(t.created) ? Object.entries(t.created).filter(([, v]) => typeof v === "string") : [];
        return {
          id: t.id as string,
          updatedAt: str(t.updatedAt),
          messages: t.messages as UIMessage[],
          outcomes: Object.fromEntries(created.map(([d, p]) => [d, { product_id: p }])),
          ...(created.length ? { metadata: { product_ids: created.map(([, p]) => p as string) } } : {}),
        };
      }
      return { id: t.id as string, updatedAt: str(t.updatedAt), messages: t.messages as UIMessage[], outcomes: isObj(t.outcomes) ? (t.outcomes as Outcomes) : {} };
    });
}

// Uploads this user's chats of a kind that an older studio kept in this browser, oldest first, then
// removes them there (other users' stay). A chat Mynt refuses (too long) is dropped; one that couldn't be
// sent (offline) stays for next time. Returns how many were uploaded.
export async function migrateLocalChats(kind: ChatKind, owner: string | null | undefined, opts: { fetcher?: Fetcher; storage?: StorageLike | null } = {}): Promise<number> {
  const s = opts.storage === undefined ? browserStorage() : opts.storage;
  if (!owner || !s) return 0;
  const key = LEGACY_KEYS[kind];
  let all: Record<string, unknown>;
  try {
    const v = JSON.parse(s.getItem(key) ?? "null") as unknown;
    if (!isObj(v) || !(owner in v)) return 0;
    all = v;
  } catch {
    return 0;
  }
  const threads = legacyThreads(kind, all[owner]).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const kept: unknown[] = [];
  let uploaded = 0;
  for (const t of threads) {
    const { result } = await saveChat(kind, sessionIdFor(t.id), { messages: t.messages, outcomes: t.outcomes, metadata: t.metadata }, NOT_SYNCED, opts.fetcher);
    if (result === "ok") uploaded += 1;
    else if (result === "retry") kept.push((all[owner] as unknown[]).find((x) => isObj(x) && x.id === t.id));
  }
  const rest = { ...all };
  if (kept.length) rest[owner] = kept;
  else delete rest[owner];
  try {
    if (Object.keys(rest).length) s.setItem(key, JSON.stringify(rest));
    else s.removeItem(key);
  } catch {
    // Blocked storage: it's tried again next time, and the same client ids make that safe.
  }
  return uploaded;
}
