import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction, type Db } from "./db.js";
import type { Store, User } from "./store.js";
import { workspaceRole } from "./workspaces.js";

// The studio's chats, kept on Mynt's server for the signed-in user who had them: a financial-product chat on the
// Build page, an Earn chat, and (later) an app's build conversation, all in one shape. A chat is a session
// (financial_products.chat_sessions, chat-sessions-schema.ts) with an append-only log of events
// (financial_products.chat_events): one UI message, one draft's outcome, a new title, numbered 1, 2, 3 ... per
// session. Nothing is changed in place: a message that changed is appended again under its id (the later one wins
// when the log is replayed), and a draft sent or declined is a new 'outcome' event. Reading a session is replaying
// its events in order, which get_chat_session also hands back as JSONL, one event per line, as a coding agent keeps
// its session files.
//
// Only the user who had a chat reads, adds to or deletes it: not their workspace, not an admin. What was said is
// stored as given and never logged: the audit log records that a session was created, added to or deleted, with
// counts, never a message's text or a title.

export const CHAT_KINDS = ["product", "earn", "app"] as const;
export const EVENT_TYPES = ["message", "part", "draft", "outcome", "title", "metadata"] as const;
export const EVENT_ROLES = ["user", "assistant", "system"] as const;

// Limits, so one chat can't fill the database.
export const MAX_EVENT_BYTES = 128 * 1024; // one event's payload, as JSON
export const MAX_SESSION_BYTES = 1024 * 1024; // every event of a session together
export const MAX_SESSION_EVENTS = 5000;
export const MAX_APPEND = 100; // events in one append
export const MAX_SESSIONS_PER_KIND = 200; // a user's sessions of one kind; a new one past this prunes the oldest
export const MAX_METADATA_BYTES = 4 * 1024;
export const MAX_TITLE = 200;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;

export type ChatKind = (typeof CHAT_KINDS)[number];
export type ChatEventType = (typeof EVENT_TYPES)[number];
export interface ChatSession {
  id: string;
  kind: string;
  title: string;
  workspace_id: string | null;
  metadata: Record<string, unknown>;
  last_seq: number;
  bytes: number;
  created_at: string;
  updated_at: string;
}
export interface ChatEvent {
  seq: number;
  type: string;
  role: string | null;
  client_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}
export interface NewChatEvent {
  type: ChatEventType;
  role?: (typeof EVENT_ROLES)[number] | null;
  client_id?: string | null;
  payload: Record<string, unknown>;
}

export class ChatSessionError extends Error {}

type Q = Pick<Db, "query">;
const S = "financial_products.chat_sessions";
const E = "financial_products.chat_events";
const iso = (v: unknown) => new Date(v as string).toISOString();
const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cleanTitle = (t: string) => t.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
const notFound = (id: string) => new ChatSessionError(`No chat session of yours with id ${id}`);

const toSession = (r: Record<string, unknown>): ChatSession => ({
  id: r.id as string,
  kind: r.kind as string,
  title: r.title as string,
  workspace_id: (r.workspace_id as string | null) ?? null,
  metadata: isObj(r.metadata) ? r.metadata : {},
  last_seq: Number(r.last_seq),
  bytes: Number(r.bytes),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});
const toEvent = (r: Record<string, unknown>): ChatEvent => ({
  seq: Number(r.seq),
  type: r.type as string,
  role: (r.role as string | null) ?? null,
  client_id: (r.client_id as string | null) ?? null,
  payload: isObj(r.payload) ? r.payload : {},
  created_at: iso(r.created_at),
});

async function ownSession(q: Q, userId: string, id: string, lock = false): Promise<ChatSession | null> {
  const { rows } = await q.query(`SELECT * FROM ${S} WHERE id = $1 AND user_id = $2${lock ? " FOR UPDATE" : ""}`, [id, userId]);
  return rows[0] ? toSession(rows[0]) : null;
}

// Starts a session, or answers the one this user already started under that id (a retried create). Past
// MAX_SESSIONS_PER_KIND, the user's oldest of that kind are deleted with their events. An id another user has is
// refused in the same words as a missing one.
export async function createChatSession(
  db: Db,
  userId: string,
  f: { id: string; kind: ChatKind; title?: string; workspace_id?: string | null; metadata?: Record<string, unknown> },
): Promise<{ session: ChatSession; created: boolean; pruned: number }> {
  const metadata = f.metadata ?? {};
  if (bytesOf(metadata) > MAX_METADATA_BYTES) throw new ChatSessionError(`A session's metadata is at most ${MAX_METADATA_BYTES} bytes: ids and references only`);
  if (f.workspace_id && !(await workspaceRole(db, f.workspace_id, userId))) throw new ChatSessionError(`You aren't a member of workspace ${f.workspace_id}`);
  return inTransaction(db, async (tx) => {
    const existing = await tx.query(`SELECT * FROM ${S} WHERE id = $1`, [f.id]);
    if (existing.rows[0]) {
      const s = toSession(existing.rows[0]);
      if (existing.rows[0].user_id !== userId || s.kind !== f.kind) throw notFound(f.id);
      return { session: s, created: false, pruned: 0 };
    }
    const { rows } = await tx.query(
      `INSERT INTO ${S} (id, user_id, workspace_id, kind, title, metadata) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [f.id, userId, f.workspace_id ?? null, f.kind, cleanTitle(f.title ?? ""), JSON.stringify(metadata)],
    );
    const pruned = await tx.query(
      `DELETE FROM ${S} WHERE id IN (
         SELECT id FROM ${S} WHERE user_id = $1 AND kind = $2 ORDER BY updated_at DESC, created_at DESC, id OFFSET $3
       ) RETURNING id`,
      [userId, f.kind, MAX_SESSIONS_PER_KIND],
    );
    return { session: toSession(rows[0]), created: true, pruned: pruned.rows.length };
  });
}

// Adds events to the end of a session's log, numbered on from its last one with no gaps. An event whose client_id
// the session already has (a retried append) is skipped, not added twice. With expect_seq, the append is refused
// unless the log still ends there (another tab added to it meanwhile). A title event retitles the session; a
// metadata event merges its payload into the session's metadata.
export async function appendChatEvents(
  db: Db,
  userId: string,
  id: string,
  events: NewChatEvent[],
  opts: { expect_seq?: number } = {},
): Promise<{ session: ChatSession; appended: number[]; duplicates: string[] }> {
  if (events.length > MAX_APPEND) throw new ChatSessionError(`At most ${MAX_APPEND} events in one append`);
  for (const e of events) {
    if (bytesOf(e.payload) > MAX_EVENT_BYTES) throw new ChatSessionError(`One event is at most ${MAX_EVENT_BYTES / 1024} KB; this one is larger`);
    if (e.type === "title" && typeof e.payload.title !== "string") throw new ChatSessionError("A title event's payload is { title: string }");
  }
  return inTransaction(db, async (tx) => {
    const s = await ownSession(tx, userId, id, true);
    if (!s) throw notFound(id);
    if (opts.expect_seq !== undefined && opts.expect_seq !== s.last_seq) throw new ChatSessionError(`The session has moved on: it ends at event ${s.last_seq}, not ${opts.expect_seq}. Read it again with get_chat_session`);
    const ids = events.map((e) => e.client_id).filter((c): c is string => Boolean(c));
    const known = new Set<string>();
    if (ids.length) {
      const { rows } = await tx.query(`SELECT client_id FROM ${E} WHERE session_id = $1 AND client_id = ANY($2::text[])`, [id, ids]);
      for (const r of rows) known.add(r.client_id as string);
    }
    const duplicates: string[] = [];
    const fresh: NewChatEvent[] = [];
    for (const e of events) {
      if (e.client_id && known.has(e.client_id)) {
        duplicates.push(e.client_id);
        continue;
      }
      if (e.client_id) known.add(e.client_id);
      fresh.push(e);
    }
    const added = fresh.reduce((n, e) => n + bytesOf(e.payload), 0);
    if (s.bytes + added > MAX_SESSION_BYTES)
      throw new ChatSessionError(`This conversation is too long to keep (${MAX_SESSION_BYTES / 1024 / 1024} MB at most). Start a new one`);
    if (s.last_seq + fresh.length > MAX_SESSION_EVENTS) throw new ChatSessionError(`This conversation is too long to keep (${MAX_SESSION_EVENTS} events at most). Start a new one`);
    const appended: number[] = [];
    let seq = s.last_seq;
    let title = s.title;
    let metadata = s.metadata;
    for (const e of fresh) {
      seq += 1;
      await tx.query(`INSERT INTO ${E} (session_id, seq, type, role, client_id, payload) VALUES ($1, $2, $3, $4, $5, $6)`, [
        id,
        seq,
        e.type,
        e.role ?? null,
        e.client_id ?? null,
        JSON.stringify(e.payload),
      ]);
      appended.push(seq);
      if (e.type === "title") title = cleanTitle(e.payload.title as string);
      if (e.type === "metadata") metadata = { ...metadata, ...e.payload };
    }
    if (bytesOf(metadata) > MAX_METADATA_BYTES) throw new ChatSessionError(`A session's metadata is at most ${MAX_METADATA_BYTES} bytes: ids and references only`);
    const { rows } = await tx.query(
      `UPDATE ${S} SET last_seq = $2, bytes = bytes + $3, title = $4, metadata = $5, updated_at = CASE WHEN $6 THEN now() ELSE updated_at END
       WHERE id = $1 RETURNING *`,
      [id, seq, added, title, JSON.stringify(metadata), fresh.length > 0],
    );
    return { session: toSession(rows[0]), appended, duplicates };
  });
}

export type ChatSessionSummary = Pick<ChatSession, "id" | "kind" | "title" | "workspace_id" | "metadata" | "last_seq" | "created_at" | "updated_at"> & { snippet?: string | null };

// A message event's words, on one line (its text parts only).
export function messageText(payload: Record<string, unknown>): string {
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  return parts
    .map((p) => (isObj(p) && p.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// The user's own sessions, newest first, without their events. With a query, only those whose title or messages'
// words hold every word of it (any case), each with the words around its first match.
export async function listChatSessions(q: Q, userId: string, opts: { kind?: string; query?: string; limit?: number } = {}): Promise<ChatSessionSummary[]> {
  const limit = Math.min(LIST_MAX, Math.max(1, opts.limit ?? LIST_DEFAULT));
  const words = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  const { rows } = await q.query(
    `SELECT id, kind, title, workspace_id, metadata, last_seq, created_at, updated_at FROM ${S}
     WHERE user_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY updated_at DESC, id LIMIT $3`,
    [userId, opts.kind ?? null, words.length ? LIST_MAX : limit],
  );
  const sessions = rows.map((r) => {
    const { bytes: _b, ...s } = toSession({ ...r, bytes: 0 });
    return s as ChatSessionSummary;
  });
  if (!words.length) return sessions;
  const out: ChatSessionSummary[] = [];
  for (const s of sessions) {
    if (out.length >= limit) break;
    const { rows: ev } = await q.query(`SELECT payload FROM ${E} WHERE session_id = $1 AND type = 'message' ORDER BY seq`, [s.id]);
    // The latest copy of each message, in the order they first appeared.
    const latest = new Map<string, string>();
    ev.forEach((r, i) => {
      const p = isObj(r.payload) ? r.payload : {};
      latest.set(typeof p.id === "string" ? p.id : `#${i}`, messageText(p));
    });
    const text = [...latest.values()].join(" ").trim();
    const hay = `${s.title} ${text}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const i = text.toLowerCase().indexOf(words[0]);
    let snippet: string | null = null;
    if (i >= 0) {
      const start = Math.max(0, i - 40);
      const end = Math.min(text.length, i + words[0].length + 40);
      snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    }
    out.push({ ...s, snippet });
  }
  return out;
}

// One of the user's sessions with its events in order (only those after after_seq, for catching up).
export async function getChatSession(q: Q, userId: string, id: string, opts: { after_seq?: number } = {}): Promise<{ session: ChatSession; events: ChatEvent[] }> {
  const session = await ownSession(q, userId, id);
  if (!session) throw notFound(id);
  const { rows } = await q.query(`SELECT * FROM ${E} WHERE session_id = $1 AND seq > $2 ORDER BY seq`, [id, opts.after_seq ?? 0]);
  return { session, events: rows.map(toEvent) };
}

export async function deleteChatSession(q: Q, userId: string, id: string): Promise<void> {
  const { rows } = await q.query(`DELETE FROM ${S} WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  if (!rows[0]) throw notFound(id);
}

// A session as JSONL: the session's own line first, then one line per event.
export const toJsonl = (session: ChatSession, events: ChatEvent[]) =>
  [JSON.stringify({ type: "session", ...session }), ...events.map((e) => JSON.stringify({ session_id: session.id, ...e }))].join("\n");

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const refusal = (e: unknown) => {
  if (e instanceof ChatSessionError) return fail(e.message);
  throw e;
};

const sessionId = z.string().uuid().describe("The session's id (a UUID the caller picks when it creates the session)");
const kind = z.enum(CHAT_KINDS);
const metadata = z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.string().max(200)).max(50)]));
const event = z
  .object({
    type: z.enum(EVENT_TYPES).describe("message: one UI message as the studio has it (its id, role and parts); outcome: what became of a draft; title: { title }; metadata: references merged into the session's metadata; part, draft: kind-specific state"),
    role: z.enum(EVENT_ROLES).nullable().optional().describe("A message's role"),
    client_id: z.string().regex(/^[A-Za-z0-9:_.-]{1,200}$/).nullable().optional().describe("The caller's own id for this event: an append retried with it is never added twice"),
    payload: z.record(z.string(), z.unknown()).describe(`The event itself, as JSON (at most ${MAX_EVENT_BYTES / 1024} KB)`),
  })
  .strict();

export function registerChatSessionTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "create_chat_session",
    {
      title: "Start a chat session",
      description: `Signed-in user: keep one of your studio chats on Mynt (a financial-product chat, an Earn chat), under an id you pick. Creating it again with the same id answers the one you have. Only you can read it. You keep at most ${MAX_SESSIONS_PER_KIND} of each kind: a new one past that deletes your oldest of that kind.`,
      inputSchema: {
        id: sessionId,
        kind,
        title: z.string().max(MAX_TITLE).optional(),
        workspace_id: z.string().uuid().nullable().optional().describe("The workspace the chat was had in, if any (you must be a member)"),
        metadata: metadata.optional().describe("Small references only: a product id, pool ids"),
      },
    },
    async ({ id, kind, title, workspace_id, metadata }) => {
      try {
        const r = await createChatSession(store.db, user.id, { id, kind, title, workspace_id, metadata });
        if (r.created) await store.audit(user.id, "create_chat_session", id, { kind, workspace_id: workspace_id ?? null, pruned: r.pruned });
        return json(r);
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "append_chat_events",
    {
      title: "Add to a chat session",
      description: `Signed-in user: add events to the end of one of your chat sessions, in order: messages (one UI message each; a message appended again under its id replaces the earlier copy when the session is replayed), draft outcomes, a new title. Events are never changed or removed one by one. An event with a client_id the session already has is skipped, so a retried append never adds anything twice. Limits: ${MAX_APPEND} events per call, ${MAX_EVENT_BYTES / 1024} KB per event, ${MAX_SESSION_BYTES / 1024 / 1024} MB and ${MAX_SESSION_EVENTS} events per session.`,
      inputSchema: {
        id: sessionId,
        events: z.array(event).min(1).max(MAX_APPEND),
        expect_seq: z.number().int().min(0).optional().describe("Refuse unless the session still ends at this event number"),
      },
    },
    async ({ id, events, expect_seq }) => {
      try {
        const r = await appendChatEvents(store.db, user.id, id, events, { expect_seq });
        if (r.appended.length)
          await store.audit(user.id, "append_chat_events", id, { kind: r.session.kind, events: r.appended.length, types: [...new Set(events.map((e) => e.type))], last_seq: r.session.last_seq });
        return json({ id, last_seq: r.session.last_seq, appended: r.appended, duplicates: r.duplicates.length, updated_at: r.session.updated_at });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "list_chat_sessions",
    {
      title: "Your chat sessions",
      description:
        "Signed-in user: your own chat sessions, newest first, without their events: id, kind, title, metadata, last event number and when each changed. With a query, only those whose title or messages hold every word of it, each with the words around the match.",
      inputSchema: {
        kind: kind.optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(LIST_MAX).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ kind, query, limit }) => json({ sessions: await listChatSessions(store.db, user.id, { kind, query, limit }) }),
  );

  server.registerTool(
    "get_chat_session",
    {
      title: "Read a chat session",
      description:
        "Signed-in user: one of your chat sessions with its events in order (replay them to get the chat back); after_seq gives only the newer ones. format 'jsonl' gives the session as JSONL instead: its own line, then one line per event.",
      inputSchema: {
        id: sessionId,
        after_seq: z.number().int().min(0).optional(),
        format: z.enum(["json", "jsonl"]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, after_seq, format }) => {
      try {
        const r = await getChatSession(store.db, user.id, id, { after_seq });
        return format === "jsonl" ? json({ id, jsonl: toJsonl(r.session, r.events) }) : json(r);
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "delete_chat_session",
    {
      title: "Delete a chat session",
      description: "Signed-in user: delete one of your chat sessions and every event in it, for good.",
      inputSchema: { id: sessionId },
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      try {
        await deleteChatSession(store.db, user.id, id);
        await store.audit(user.id, "delete_chat_session", id, {});
        return json({ deleted: id });
      } catch (e) {
        return refusal(e);
      }
    },
  );
}
