import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { clientAddress, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS, loginAllowed } from "@/lib/rate-limit";
import { MemoryKeyValue, Sealer, SessionStore } from "@/lib/session-store";
import { ensureRoles, isAuthError, ROLES_MAX_AGE_MS } from "@/lib/studio-server";
import { NotSignedInError } from "@/lib/mynt-client";
import { ensureFreshTokens, expiresSoon } from "@/lib/tokens";

function memoryStore() {
  const clock = { now: 0 };
  const store = new SessionStore(new MemoryKeyValue(() => clock.now), new Sealer(randomBytes(32)), { now: () => clock.now });
  return { clock, store };
}

const token = (access_token: string, expires_in = 3600) => ({ access_token, refresh_token: `r-${access_token}`, token_type: "Bearer", expires_in });
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("token refresh", () => {
  it("knows when tokens are about to expire", () => {
    const s = { id: "x", createdAt: 0, lastSeen: 0, tokens: token("t"), tokensAt: 0 };
    expect(expiresSoon(s, 0)).toBe(false);
    expect(expiresSoon(s, 3600_000 - 30_000)).toBe(true);
    expect(expiresSoon({ ...s, tokens: { access_token: "t", token_type: "Bearer" } }, 9e9)).toBe(false); // no refresh token
  });

  it("two requests needing a refresh at once refresh once, and both end with the new tokens", async () => {
    const { clock, store } = memoryStore();
    const s = store.create();
    s.tokens = token("old");
    await store.save(s);
    clock.now = 3600_000 - 30_000; // expiring

    const a = (await store.get(s.id))!;
    const b = (await store.get(s.id))!;
    let refreshes = 0;
    const refresh = async (session: typeof a) => {
      refreshes++;
      await tick(30);
      session.tokens = token("new");
    };
    const opts = { store, refresh, now: () => clock.now, sleep: () => tick(5) };
    await Promise.all([ensureFreshTokens(a, opts), ensureFreshTokens(b, opts)]);

    expect(refreshes).toBe(1);
    expect(a.tokens?.access_token).toBe("new");
    expect(b.tokens?.access_token).toBe("new");
    expect((await store.get(s.id))?.tokens?.access_token).toBe("new");
    // B saving afterwards keeps the new tokens.
    await store.save(b);
    expect((await store.get(s.id))?.tokens?.access_token).toBe("new");
  });

  it("does nothing while the tokens are fresh", async () => {
    const { store } = memoryStore();
    const s = store.create();
    s.tokens = token("t");
    await store.save(s);
    let refreshes = 0;
    await ensureFreshTokens(s, { store, refresh: async () => void refreshes++, now: () => 0 });
    expect(refreshes).toBe(0);
  });
});

describe("sign-in rate limit", () => {
  it(`lets an address start sign-in ${LOGIN_LIMIT} times per window, then refuses it`, async () => {
    const { clock, store } = memoryStore();
    for (let i = 0; i < LOGIN_LIMIT; i++) expect(await loginAllowed(store, "client-a")).toBe(true);
    expect(await loginAllowed(store, "client-a")).toBe(false);
    expect(await loginAllowed(store, "client-b")).toBe(true); // another address
    clock.now = (LOGIN_WINDOW_SECONDS + 1) * 1000;
    expect(await loginAllowed(store, "client-a")).toBe(true); // a new window
  });

  it("reads the caller's address from the platform's headers", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "client-c, proxy-1" }))).toBe("client-c");
    expect(clientAddress(new Headers({ "x-real-ip": "client-d" }))).toBe("client-d");
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});

// A fake MCP client whose whoami reply can change.
function fakeClient(roles: () => string[]) {
  let calls = 0;
  const client = {
    callTool: async () => {
      calls++;
      return { content: [{ type: "text", text: JSON.stringify({ id: "u1", effective_roles: roles() }) }] };
    },
  } as unknown as Client;
  return { client, calls: () => calls };
}

describe("roles", () => {
  it("are read again from Mynt once they're a few minutes old", async () => {
    let roles = ["developer"];
    const { client, calls } = fakeClient(() => roles);
    const session = { id: "s", createdAt: 0, lastSeen: 0 } as Parameters<typeof ensureRoles>[0];
    expect(await ensureRoles(session, client, 0)).toEqual(["developer"]);
    roles = ["consumer"]; // an admin took developer away
    const t0 = session.rolesAt!;
    expect(await ensureRoles(session, client, t0 + 60_000)).toEqual(["developer"]); // still cached
    expect(calls()).toBe(1);
    expect(await ensureRoles(session, client, t0 + ROLES_MAX_AGE_MS + 1)).toEqual(["consumer"]);
    expect(calls()).toBe(2);
  });
});

describe("auth errors", () => {
  it("treat Mynt refusing the sign-in as signed out", () => {
    expect(isAuthError(new UnauthorizedError())).toBe(true);
    expect(isAuthError(new NotSignedInError())).toBe(true);
    expect(isAuthError(new Error("network down"))).toBe(false);
  });
});
