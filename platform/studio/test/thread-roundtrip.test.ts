import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { UIMessage } from "ai";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// A chat saved and read back for real: the studio's client (ChatSaver, listChats, loadChat) through the
// studio's own /api/threads route handlers, to Mynt's chat-session tools (core's built server) on an
// in-memory Postgres (PGlite), as one signed-in user. Needs core built (cd core && npm run build); CI's
// platform job has no core build, so there it's skipped (core's own chat-sessions test covers the tools).

const CORE = fileURLToPath(new URL("../../../core/", import.meta.url));
const built = existsSync(`${CORE}dist/server.js`) && existsSync(`${CORE}node_modules/@electric-sql/pglite`);

const live = { client: null as unknown };
vi.mock("@/lib/session", () => ({
  currentSession: async () => ({ id: "s1", tokens: { access_token: "t", token_type: "Bearer" } }) as Session,
  fromOwnOrigin: () => true,
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({ connectStudio: async () => live.client }));

describe.skipIf(!built)("a chat saved through the studio's routes and read back from Mynt", () => {
  let fetcher: typeof fetch;
  beforeAll(async () => {
    const imp = (p: string) => import(/* @vite-ignore */ `${CORE}${p}`);
    const { PGlite } = await imp("node_modules/@electric-sql/pglite/dist/index.js");
    const { Store } = await imp("dist/store.js");
    const { createServer } = await imp("dist/server.js");
    const { CATALOG } = await imp("test/helpers.js");
    const { InMemoryTransport } = await imp("node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js");
    const { Client } = await imp("node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
    const pg = new PGlite();
    const store = await Store.open({ query: (s: string, p: unknown[]) => pg.query(s, p), exec: (s: string) => pg.exec(s), close: () => pg.close() }, CATALOG);
    // A developer with no wallets and no liquidity-provider role: no hashed owner key anywhere.
    const { user } = await store.createUser("Dev", ["developer"]);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, {}).connect(s);
    const client = new Client({ name: "studio-test", version: "0" });
    await client.connect(c);
    // The route closes its client after each call; this one stays open for the next.
    live.client = Object.assign(Object.create(client), { close: async () => undefined });

    const listRoute = await import("@/app/api/threads/route");
    const oneRoute = await import("@/app/api/threads/[id]/route");
    fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:3000");
      const req = new Request(url, { method: init?.method ?? "GET", headers: init?.headers, body: init?.body ?? undefined });
      if (url.pathname === "/api/threads") return init?.method === "POST" ? listRoute.POST(req) : listRoute.GET(Object.assign(req, { nextUrl: url }) as never);
      const id = decodeURIComponent(url.pathname.slice("/api/threads/".length));
      return init?.method === "DELETE" ? oneRoute.DELETE(req, { params: Promise.resolve({ id }) }) : oneRoute.GET(req, { params: Promise.resolve({ id }) });
    }) as typeof fetch;
  }, 120_000);

  it("saves a product chat (with a created product), lists it, and loads it back whole", async () => {
    const { ChatSaver, listChats, loadChat, newThreadId } = await import("@/lib/chat-sessions");
    const id = newThreadId();
    const messages: UIMessage[] = [
      { id: "Xb3kPq9LmN2rT7vW", role: "user", parts: [{ type: "text", text: "A savings pot for students" }] },
      {
        id: "a1-reply",
        role: "assistant",
        parts: [
          { type: "step-start" },
          { type: "text", text: "Here is a draft", state: "done" },
          { type: "data-product-draft", id: "d1", data: { id: "d1", request: { id: "student-pot", name: "Student pot" } } },
        ],
      } as UIMessage,
    ];
    const saver = new ChatSaver("product", { fetcher });
    saver.save(id, { messages, outcomes: { d1: { product_id: "student-pot" } }, metadata: { product_ids: ["student-pot"] } }, { now: true });
    await saver.flush();
    await vi.waitFor(async () => expect(saver.isPending(id)).toBe(false));

    const list = await listChats("product", { fetcher });
    expect(list?.map((t) => [t.id, t.title, t.metadata.product_ids])).toEqual([[id, "A savings pot for students", ["student-pot"]]]);
    const back = await loadChat(id, fetcher);
    expect(back?.messages).toEqual(messages);
    expect(back?.outcomes).toEqual({ d1: { product_id: "student-pot" } });

    // A follow-up appends only what changed, and the reply edited in place replaces its copy.
    const more: UIMessage[] = [...messages, { id: "u2", role: "user", parts: [{ type: "text", text: "Lower the fee" }] }];
    saver.adopt(id, back!);
    saver.save(id, { messages: more, outcomes: back!.outcomes, metadata: back!.metadata as Record<string, string[]> }, { now: true });
    await saver.flush();
    expect((await loadChat(id, fetcher))?.messages.map((m) => m.id)).toEqual(["Xb3kPq9LmN2rT7vW", "a1-reply", "u2"]);
    saver.dispose();
  });

  it("saves an Earn chat with a draft's outcome and reads it back", async () => {
    const { saveChat, loadChat, NOT_SYNCED, newThreadId } = await import("@/lib/chat-sessions");
    const id = newThreadId();
    const messages: UIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "Park $500 for 90 days" }] }];
    const { result } = await saveChat("earn", id, { messages, outcomes: { d1: { key: "key-1234567", sent: null } } }, NOT_SYNCED, fetcher);
    expect(result).toBe("ok");
    const back = await loadChat(id, fetcher);
    expect(back?.kind).toBe("earn");
    expect(back?.messages).toEqual(messages);
    expect(back?.outcomes).toEqual({ d1: { key: "key-1234567", sent: null } });
  });
});
