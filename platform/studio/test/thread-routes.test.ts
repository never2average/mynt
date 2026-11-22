import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { parseStudioCall } from "@/lib/studio-tools";

// The chat routes (app/api/threads): the signed-in user's own chats on Mynt, through its chat-session
// tools as that user. Signed in, same origin, strict bodies; a save starts the session (Mynt answers the
// one already there) and appends its events; a chat read back is replayed; Mynt's refusals come back as
// 422 in its words. Developers and Earn's liquidity providers both keep chats.

const fake = {
  session: undefined as Session | undefined,
  roles: ["developer"] as string[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: {} as Record<string, string>,
  events: [] as unknown[],
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse[name] }) }] };
      switch (name) {
        case "whoami":
          return ok({ id: "u1", effective_roles: fake.roles });
        case "list_chat_sessions":
          return ok({ sessions: [{ id: ID, kind: "product", title: "A savings pot", workspace_id: null, metadata: { product_ids: ["pot"] }, last_seq: 3, created_at: "2026-11-21T10:00:00.000Z", updated_at: "2026-11-22T10:00:00.000Z", ...(args.query ? { snippet: "…a savings pot…" } : {}) }] });
        case "create_chat_session":
          return ok({ session: { id: args.id }, created: true, pruned: 0 });
        case "append_chat_events":
          return ok({ id: args.id, last_seq: 2, appended: [1, 2], duplicates: 0 });
        case "get_chat_session":
          return ok({ session: { id: args.id, kind: "earn", title: "Park $500", metadata: {}, last_seq: fake.events.length, updated_at: "2026-11-22T10:00:00.000Z" }, events: fake.events });
        case "delete_chat_session":
          return ok({ deleted: args.id });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const listRoute = await import("@/app/api/threads/route");
const oneRoute = await import("@/app/api/threads/[id]/route");

const ID = "00000000-0000-4000-8000-0000000000c1";
const ORIGIN = "http://localhost:3000";
const req = (path: string, method = "GET", body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, body === undefined ? { method, headers: { origin } } : { method, headers: { origin, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const getReq = (path: string, origin = ORIGIN) => Object.assign(req(path, "GET", undefined, origin), { nextUrl: new URL(`${ORIGIN}${path}`) }) as never;
const one = (id: string) => ({ params: Promise.resolve({ id }) });
const called = (name: string) => fake.calls.filter((c) => c.name === name);
const message = (id: string, role: "user" | "assistant", text: string) => ({ type: "message", role, client_id: `m:${id}:abc`, payload: { id, role, parts: [{ type: "text", text }] } });

beforeEach(() => {
  fake.session = { id: "s1", tokens: { access_token: "t", token_type: "Bearer" } } as Session;
  fake.roles = ["developer"];
  fake.calls = [];
  fake.refuse = {};
  fake.events = [];
});

describe("the chat routes", () => {
  it("list the user's own chats of a kind, without messages, and search them", async () => {
    const res = await listRoute.GET(getReq("/api/threads?kind=product"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threads: [{ id: ID, kind: "product", title: "A savings pot", updatedAt: "2026-11-22T10:00:00.000Z", metadata: { product_ids: ["pot"] } }] });
    expect(called("list_chat_sessions")[0].args).toEqual({ kind: "product" });
    const found = await (await listRoute.GET(getReq("/api/threads?kind=earn&q=savings%20pot"))).json();
    expect(called("list_chat_sessions")[1].args).toEqual({ kind: "earn", query: "savings pot" });
    expect(found.threads[0].snippet).toBe("…a savings pot…");
    expect((await listRoute.GET(getReq("/api/threads?kind=other"))).status).toBe(400);
  });

  it("save: starts the session (or finds it), then appends the events, as the user", async () => {
    const body = { id: ID, kind: "earn", title: "Park $500", events: [message("u1", "user", "Park $500"), { type: "outcome", client_id: "o:d1:k", payload: { draft_id: "d1", key: "key-1234567", sent: null } }] };
    const res = await listRoute.POST(req("/api/threads", "POST", body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, id: ID, lastSeq: 2 });
    expect(called("create_chat_session")[0].args).toEqual({ id: ID, kind: "earn", title: "Park $500" });
    expect(called("append_chat_events")[0].args).toEqual({ id: ID, events: body.events });
    // Every call went through the studio's allow-list.
    for (const c of fake.calls) expect(parseStudioCall(c.name, c.args)).not.toHaveProperty("error");
  });

  it("refuses another origin, a bad body, too many events, no sign-in, and someone without a chat surface", async () => {
    expect((await listRoute.POST(req("/api/threads", "POST", { id: ID, kind: "earn", events: [] }, "https://elsewhere.example"))).status).toBe(403);
    expect((await listRoute.GET(getReq("/api/threads?kind=earn", "https://elsewhere.example"))).status).toBe(403);
    for (const bad of [
      { id: "not-a-uuid", kind: "earn", events: [] },
      { id: ID, kind: "app", events: [] },
      { id: ID, kind: "earn", events: [{ type: "nonsense", client_id: "x", payload: {} }] },
      { id: ID, kind: "earn", events: [{ ...message("u", "user", "hi"), extra: true }] },
      { id: ID, kind: "earn", events: [], owner: "someone" },
      { id: ID, kind: "earn", events: Array.from({ length: 101 }, (_, i) => message(`m${i}`, "user", "hi")) },
    ])
      expect((await listRoute.POST(req("/api/threads", "POST", bad))).status).toBe(400);
    expect((await listRoute.POST(req("/api/threads", "POST", "not json"))).status).toBe(400);
    const huge = { id: ID, kind: "earn", events: [message("u", "user", "x".repeat(1024 * 1024 + 10))] };
    expect((await listRoute.POST(req("/api/threads", "POST", huge))).status).toBe(413);
    expect(called("create_chat_session")).toHaveLength(0);
    fake.session = undefined;
    expect((await listRoute.GET(getReq("/api/threads?kind=earn"))).status).toBe(401);
    fake.session = { id: "s1", tokens: { access_token: "t", token_type: "Bearer" } } as Session;
    fake.roles = ["consumer"];
    expect((await listRoute.GET(getReq("/api/threads?kind=earn"))).status).toBe(403);
    // A liquidity provider keeps Earn chats too.
    fake.session = { id: "s2", tokens: { access_token: "t", token_type: "Bearer" } } as Session;
    fake.roles = ["liquidity_provider"];
    expect((await listRoute.GET(getReq("/api/threads?kind=earn"))).status).toBe(200);
  });

  it("Mynt refusing a save (too long to keep) comes back as 422 in its words", async () => {
    fake.refuse.append_chat_events = "This conversation is too long to keep (1 MB at most). Start a new one";
    const res = await listRoute.POST(req("/api/threads", "POST", { id: ID, kind: "product", events: [message("u", "user", "hi")] }));
    expect(res.status).toBe(422);
    expect((await res.json()).message).toContain("too long to keep");
  });

  it("reads one chat back replayed: messages as last appended, each draft's latest outcome; deletes it", async () => {
    fake.events = [
      { seq: 1, type: "message", role: "user", payload: { id: "u1", role: "user", parts: [{ type: "text", text: "Park $500" }] } },
      { seq: 2, type: "message", role: "assistant", payload: { id: "a1", role: "assistant", parts: [{ type: "text", text: "Here" }] } },
      { seq: 3, type: "outcome", role: null, payload: { draft_id: "d1", key: "key-1234567", sent: null } },
      { seq: 4, type: "message", role: "assistant", payload: { id: "a1", role: "assistant", parts: [{ type: "text", text: "Here are two pools" }] } },
      { seq: 5, type: "outcome", role: null, payload: { draft_id: "d1", key: "key-1234567", sent: "Done." } },
    ];
    const res = await oneRoute.GET(req(`/api/threads/${ID}`), one(ID));
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(t.messages.map((m: { id: string; parts: { text: string }[] }) => [m.id, m.parts[0].text])).toEqual([
      ["u1", "Park $500"],
      ["a1", "Here are two pools"],
    ]);
    expect(t.outcomes).toEqual({ d1: { key: "key-1234567", sent: "Done." } });
    expect(t.title).toBe("Park $500");
    expect((await oneRoute.GET(req("/api/threads/nope"), one("nope"))).status).toBe(404);
    fake.refuse.get_chat_session = `No chat session of yours with id ${ID}`;
    expect((await oneRoute.GET(req(`/api/threads/${ID}`), one(ID))).status).toBe(422);
    const del = await oneRoute.DELETE(req(`/api/threads/${ID}`, "DELETE"), one(ID));
    expect(del.status).toBe(200);
    expect(called("delete_chat_session")[0].args).toEqual({ id: ID });
    expect((await oneRoute.DELETE(req(`/api/threads/${ID}`, "DELETE", undefined, "https://elsewhere.example"), one(ID))).status).toBe(403);
  });
});
