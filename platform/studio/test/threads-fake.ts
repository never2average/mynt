// A stand-in for the studio's /api/threads routes and Mynt's chat sessions behind them, for the
// component tests: sessions per kind with an append-only log of events, a client id never appended
// twice, read back by replaying the log (lib/chat-sessions.ts replay), newest first in the list.
// `down` makes every call fail as a network error would; `refuse` answers 422 as Mynt refusing.
import type { UIMessage } from "ai";

import { replay, SaveRequest, type Outcomes, type StoredEvent } from "@/lib/chat-sessions";

type FakeSession = { id: string; kind: string; title: string; metadata: Record<string, unknown>; updatedAt: string; events: (StoredEvent & { client_id: string | null })[] };

export function fakeThreads(opts: { fallback?: (url: string, init?: RequestInit) => Promise<Response> } = {}) {
  const sessions = new Map<string, FakeSession>();
  const posts: unknown[] = [];
  let clock = Date.parse("2026-11-22T12:00:00Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  const state = { down: false, refuse: false };
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.startsWith("/api/threads")) return opts.fallback ? opts.fallback(url, init) : ok({}, 404);
    if (state.down) throw new TypeError("Failed to fetch");
    const method = init?.method ?? "GET";
    const path = url.split("?")[0];
    const q = new URLSearchParams(url.split("?")[1] ?? "");
    if (path === "/api/threads" && method === "GET") {
      const words = (q.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const list = [...sessions.values()]
        .filter((s) => s.kind === q.get("kind"))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((s) => {
          const text = replay(s.events)
            .messages.flatMap((m) => m.parts.map((p) => (p.type === "text" ? p.text : "")))
            .join(" ");
          return { s, text };
        })
        .filter(({ s, text }) => words.every((w) => `${s.title} ${text}`.toLowerCase().includes(w)));
      return ok({
        threads: list.map(({ s, text }) => ({ id: s.id, kind: s.kind, title: s.title, updatedAt: s.updatedAt, metadata: s.metadata, ...(words.length ? { snippet: text.toLowerCase().includes(words[0]) ? text : null } : {}) })),
      });
    }
    if (path === "/api/threads" && method === "POST") {
      const parsed = SaveRequest.safeParse(JSON.parse(String(init?.body ?? "null")));
      if (!parsed.success) return ok({ error: "bad_request" }, 400);
      posts.push(parsed.data);
      if (state.refuse) return ok({ error: "mynt_refused", message: "This conversation is too long to keep" }, 422);
      const { id, kind, title, events } = parsed.data;
      let s = sessions.get(id);
      if (!s) sessions.set(id, (s = { id, kind, title: title ?? "", metadata: {}, updatedAt: tick(), events: [] }));
      for (const e of events) {
        if (s.events.some((x) => x.client_id === e.client_id)) continue;
        s.events.push({ seq: s.events.length + 1, type: e.type, role: e.role ?? null, client_id: e.client_id, payload: e.payload });
        if (e.type === "title") s.title = String(e.payload.title);
        if (e.type === "metadata") s.metadata = { ...s.metadata, ...e.payload };
        s.updatedAt = tick();
      }
      return ok({ saved: true, id, lastSeq: s.events.length });
    }
    const id = decodeURIComponent(path.slice("/api/threads/".length));
    const s = sessions.get(id);
    if (!s) return ok({ error: "mynt_refused", message: `No chat session of yours with id ${id}` }, 422);
    if (method === "DELETE") {
      sessions.delete(id);
      return ok({ deleted: true });
    }
    return ok({ id, kind: s.kind, title: s.title, updatedAt: s.updatedAt, metadata: s.metadata, ...replay(s.events) });
  }) as typeof fetch;

  // A session as Mynt would have it after a save of these messages and outcomes.
  const seed = (kind: string, t: { id: string; title: string; updatedAt: string; messages: UIMessage[]; outcomes?: Outcomes; metadata?: Record<string, unknown> }) => {
    const events: FakeSession["events"] = [
      ...t.messages.map((m, i) => ({ seq: i + 1, type: "message", role: m.role, client_id: `seed:${m.id}`, payload: m as unknown as Record<string, unknown> })),
      ...Object.entries(t.outcomes ?? {}).map(([d, o], i) => ({ seq: t.messages.length + i + 1, type: "outcome", role: null, client_id: `seed:o:${d}`, payload: { draft_id: d, ...o } })),
    ];
    sessions.set(t.id, { id: t.id, kind, title: t.title, metadata: t.metadata ?? {}, updatedAt: t.updatedAt, events });
  };
  // What Mynt has of a kind, replayed, newest first.
  const list = (kind: string) =>
    [...sessions.values()]
      .filter((s) => s.kind === kind)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, metadata: s.metadata, events: s.events, ...replay(s.events) }));
  return { fetcher, seed, list, posts, state, sessions };
}

export const uuid = (n: number | string) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
