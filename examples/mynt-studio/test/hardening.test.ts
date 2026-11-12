import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { withoutPort } from "@/lib/rate-limit";
import { addressBucket, clientAddress, LOGIN_LIMIT, LOGIN_WINDOW_SECONDS, loginAllowed, SHARED_LOGIN_LIMIT } from "@/lib/rate-limit";
import { MemoryKeyValue, Sealer, SessionStore } from "@/lib/session-store";
import { certainlyNotDone, ensureRoles, isAuthError, MyntRefusedError, ROLES_MAX_AGE_MS, ToolRefusedError } from "@/lib/studio-server";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { NotSignedInError } from "@/lib/mynt-client";
import { deadlineFetch, normalIssuer, ensureFreshTokens, expiresSoon, RefreshFailedError, refreshWithMynt } from "@/lib/tokens";
import { oauthRedirectUrl } from "@/lib/config";
import { InvalidClientError, InvalidGrantError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

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

describe("refreshing with Mynt's authorization server", () => {
  const server = { authorizationServerUrl: "https://auth.example.com", authorizationServerMetadata: undefined } as unknown as Awaited<ReturnType<typeof import("@modelcontextprotocol/sdk/client/auth.js").discoverOAuthServerInfo>>;
  async function signedIn() {
    process.env.MYNT_MCP_URL = "https://mynt.example.com/mcp";
    const { store } = memoryStore();
    await store.saveClientInformation(oauthRedirectUrl(), { client_id: "c1" });
    const s = store.create();
    s.tokens = token("old");
    return { store, s };
  }

  it("keeps the tokens on a passing failure (timeout, 5xx, network)", async () => {
    const { store, s } = await signedIn();
    const refreshAuth = async () => {
      throw new ServerError("upstream down");
    };
    await expect(refreshWithMynt(s, store, { discover: async () => server, refreshAuth })).rejects.toBeInstanceOf(RefreshFailedError);
    expect(s.tokens?.access_token).toBe("old");
    expect(isAuthError(new RefreshFailedError("x"))).toBe(false); // answered 502, not a sign-out
  });

  it("signs out only when the server says the grant or the client is no longer valid", async () => {
    for (const E of [InvalidGrantError, InvalidClientError]) {
      const { store, s } = await signedIn();
      const refreshAuth = async () => {
        throw new E("no");
      };
      await expect(refreshWithMynt(s, store, { discover: async () => server, refreshAuth })).rejects.toBeInstanceOf(NotSignedInError);
      expect(s.tokens).toBeUndefined();
    }
  });

  it("won't send the refresh token to an authorization server other than the one that issued it", async () => {
    const { store, s } = await signedIn();
    s.tokens = { ...token("old"), issuer: "https://auth.example.com" } as typeof s.tokens;
    let sent = false;
    const elsewhere = { ...server, authorizationServerUrl: "https://elsewhere.example" };
    const refreshAuth = async () => {
      sent = true;
      return token("x");
    };
    await expect(refreshWithMynt(s, store, { discover: async () => elsewhere as typeof server, refreshAuth })).rejects.toBeInstanceOf(NotSignedInError);
    expect(sent).toBe(false);
    expect(s.tokens).toBeUndefined();
  });

  it("nor with a client registered at another one", async () => {
    const { store, s } = await signedIn();
    await store.saveClientInformation(oauthRedirectUrl(), { client_id: "c1", issuer: "https://elsewhere.example" } as never);
    let sent = false;
    const refreshAuth = async () => {
      sent = true;
      return token("x");
    };
    await expect(refreshWithMynt(s, store, { discover: async () => server, refreshAuth })).rejects.toBeInstanceOf(NotSignedInError);
    expect(sent).toBe(false);
  });

  it("compares issuers by their canonical URL, so a trailing slash or letter case isn't a mismatch", async () => {
    const { store, s } = await signedIn();
    s.tokens = { ...token("old"), issuer: "https://AUTH.example.com/" } as typeof s.tokens;
    await refreshWithMynt(s, store, { discover: async () => server, refreshAuth: (async () => token("new")) as never });
    expect(s.tokens?.access_token).toBe("new");
    expect(normalIssuer("https://auth.example.com/tenant/")).toBe("https://auth.example.com/tenant");
    expect(normalIssuer("https://auth.example.com")).toBe(normalIssuer("https://auth.example.com/"));
  });

  it("binds new tokens and the registration to the issuing server", async () => {
    const { store, s } = await signedIn();
    await refreshWithMynt(s, store, { discover: async () => server, refreshAuth: (async () => token("new")) as never });
    expect((s.tokens as { issuer?: string }).issuer).toBe("https://auth.example.com");
    expect(await store.clientInformation(oauthRedirectUrl())).toEqual({ client_id: "c1", issuer: "https://auth.example.com" });
  });

  it("gives the whole refresh (discovery and token request) one deadline", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const base = (async (_input: unknown, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response("{}");
    }) as typeof fetch;
    const f = deadlineFetch(400, base);
    await f("https://auth.example.com/.well-known/x");
    await tick(10);
    await f("https://auth.example.com/token");
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    await tick(600);
    expect(signals[0]?.aborted).toBe(true); // 400 ms after the refresh began, not after each request
  });

  it("stores the new tokens, refreshing with the registered client", async () => {
    const { store, s } = await signedIn();
    let used: unknown;
    const refreshAuth = async (_url: string | URL, o: { clientInformation: unknown; refreshToken: string }) => {
      used = [o.clientInformation, o.refreshToken];
      return token("new");
    };
    await refreshWithMynt(s, store, { discover: async () => server, refreshAuth: refreshAuth as never });
    expect(used).toEqual([{ client_id: "c1" }, "r-old"]);
    expect(s.tokens?.access_token).toBe("new");
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

  it("on Vercel, trusts only Vercel's own header, so a forged x-forwarded-for changes nothing", () => {
    const vercel = { VERCEL: "1" };
    expect(clientAddress(new Headers({ "x-vercel-forwarded-for": "client-c", "x-forwarded-for": "forged" }), vercel)).toBe("client-c");
    expect(clientAddress(new Headers({ "x-forwarded-for": "forged", "x-real-ip": "forged" }), vercel)).toBeNull();
  });

  it("elsewhere, trusts only a configured proxy header; without one the caller is unknown", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "forged" }), {})).toBeNull();
    expect(clientAddress(new Headers({ "x-real-ip": "client-d", "x-forwarded-for": "forged" }), { TRUSTED_PROXY_HEADER: "X-Real-IP" })).toBe("client-d");
  });

  it("takes the trusted header's last value: what the proxy appended, after anything the caller sent", () => {
    const env = { TRUSTED_PROXY_HEADER: "x-forwarded-for" };
    expect(clientAddress(new Headers({ "x-forwarded-for": "forged-1, forged-2, client-f" }), env)).toBe("client-f");
  });

  it("drops ports before counting", () => {
    const v4 = [192, 0, 2, 9].join(".");
    expect(addressBucket(`${v4}:51234`)).toBe(v4);
    expect(addressBucket("[2001:db8:1:2::9]:443")).toBe("2001:db8:1:2::/64");
    expect(withoutPort("client-g")).toBe("client-g");
  });

  it("counts IPv6 callers per /64", () => {
    expect(addressBucket("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe("2001:db8:1:2::/64");
    expect(addressBucket("[2001:DB8::1]")).toBe("2001:db8:0:0::/64");
    const v4 = [192, 0, 2, 7].join("."); // a documentation address, built so no literal address sits in the source
    expect(addressBucket(`::ffff:${v4}`)).toBe(v4);
    expect(addressBucket("client-e")).toBe("client-e");
  });

  it("unknown callers share one larger bucket", async () => {
    const { store } = memoryStore();
    for (let i = 0; i < SHARED_LOGIN_LIMIT; i++) expect(await loginAllowed(store, null)).toBe(true);
    expect(await loginAllowed(store, null)).toBe(false);
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

describe("knowing a call had no effect", () => {
  const refused = (error: string) => new MyntRefusedError("shown", JSON.stringify({ error }));
  it("only for Mynt's refusals that come before it changes anything", () => {
    for (const before of [
      "Coding-agent builds aren't enabled on this Mynt yet",
      "No app of yours with id 'a1'",
      "No build of yours with id 'b1'",
      "Monthly build budget used up (US$100.00 of US$100 spent this month)",
      "This build's cap (US$20) is more than this month's remaining build budget (US$5.00 of US$100); start it with cap_usd of at most 5",
      "Repository 'o/r' isn't connected; run connect_repository first",
      "Build is succeeded; only a running agent can be steered",
    ]) {
      expect(certainlyNotDone(refused(before)), before).toBe(true);
    }
    expect(certainlyNotDone(new MyntRefusedError("shown", "MCP error -32602: Input validation error: goal too short"))).toBe(true);
    expect(certainlyNotDone(new McpError(ErrorCode.InvalidParams, "bad"))).toBe(true);
    expect(certainlyNotDone(new ToolRefusedError("The studio couldn't send that to Mynt."))).toBe(true); // never sent
  });

  it("not for other errors, which may have come after a build was inserted or a steer written", () => {
    expect(certainlyNotDone(refused("relation build_events does not exist"))).toBe(false);
    expect(certainlyNotDone(new MyntRefusedError("shown", "Internal error"))).toBe(false);
    expect(certainlyNotDone(new McpError(ErrorCode.RequestTimeout, "timed out"))).toBe(false);
    expect(certainlyNotDone(new Error("socket hang up"))).toBe(false);
  });
});

describe("auth errors", () => {
  it("treat Mynt refusing the sign-in as signed out", () => {
    expect(isAuthError(new UnauthorizedError())).toBe(true);
    expect(isAuthError(new NotSignedInError())).toBe(true);
    expect(isAuthError(new Error("network down"))).toBe(false);
  });
});
