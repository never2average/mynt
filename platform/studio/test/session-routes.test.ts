import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { MemoryKeyValue, Sealer, SessionStore, type Session } from "@/lib/session-store";

// The routes with a real (memory) store and a fake Mynt; the session id comes from `fake.id`.
const clock = { now: 0 };
const store = new SessionStore(new MemoryKeyValue(() => clock.now), new Sealer(randomBytes(32)), { now: () => clock.now });
const fake = { id: undefined as string | undefined, failWith: undefined as Error | undefined };

vi.mock("@/lib/session-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-store")>()),
  sessionStore: () => store,
}));

vi.mock("@/lib/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session")>()),
  currentSession: async () => store.get(fake.id),
}));

vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    callTool: async ({ name }: { name: string }) => {
      if (fake.failWith) throw fake.failWith;
      const data = name === "whoami" ? { id: "u1", effective_roles: ["developer"] } : name === "list_builds" ? { builds: [] } : [];
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    },
    close: async () => undefined,
  }),
}));

const session = await import("@/app/api/session/route");
const projects = await import("@/app/api/projects/route");

async function signedIn(): Promise<Session> {
  const s = store.create();
  s.tokens = { access_token: "t", token_type: "Bearer" };
  await store.save(s);
  fake.id = s.id;
  return s;
}

beforeEach(() => {
  clock.now = 0;
  fake.failWith = undefined;
});

describe("session cookie", () => {
  it("is sent again with a fresh 7-day Max-Age when the session's expiry moves", async () => {
    await signedIn();
    const quiet = await session.GET();
    expect(quiet.headers.get("set-cookie")).toBeNull(); // nothing moved yet

    clock.now = 3 * 24 * 60 * 60 * 1000; // used again after 3 days
    const res = await session.GET();
    expect(await res.json()).toEqual({ signedIn: true, name: null, email: null });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`=${fake.id}`);
    expect(cookie).toMatch(/Max-Age=604800/);
  });

  it("is refreshed by the projects route too", async () => {
    await signedIn();
    clock.now = 2 * 24 * 60 * 60 * 1000;
    const res = await projects.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/Max-Age=604800/);
  });
});

describe("projects route", () => {
  it("answers 401 (not 502) and signs the session out when Mynt refuses its sign-in mid-call", async () => {
    const s = await signedIn();
    fake.failWith = new UnauthorizedError();
    const res = await projects.GET();
    expect(res.status).toBe(401);
    expect((await store.get(s.id))?.tokens).toBeUndefined();
  });

  it("doesn't bring back a session signed out while it ran", async () => {
    const s = await signedIn();
    const pending = projects.GET();
    await store.destroy(s.id); // sign-out lands first
    await pending;
    expect(await store.get(s.id)).toBeUndefined();
  });
});
