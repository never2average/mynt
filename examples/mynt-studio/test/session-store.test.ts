import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionOAuthProvider } from "@/lib/oauth-provider";
import {
  MemoryKeyValue,
  RedisKeyValue,
  Sealer,
  SessionStore,
  redisConfig,
  storeFromEnv,
  type KeyValue,
  type RedisLike,
} from "@/lib/session-store";

const REDIRECT = "http://localhost:3000/api/auth/callback";
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// A fake key-value store that records what was written, with a settable clock.
class FakeKv implements KeyValue {
  inner: MemoryKeyValue;
  writes: { key: string; value: string; ttlSeconds: number }[] = [];
  constructor(public clock = { now: 0 }) {
    this.inner = new MemoryKeyValue(() => this.clock.now);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  async set(key: string, value: string, ttlSeconds: number, only?: "nx" | "xx") {
    this.writes.push({ key, value, ttlSeconds });
    return this.inner.set(key, value, ttlSeconds, only);
  }
  del(key: string) {
    return this.inner.del(key);
  }
  last() {
    return this.writes[this.writes.length - 1];
  }
}

function setup() {
  const kv = new FakeKv();
  const store = new SessionStore(kv, new Sealer(randomBytes(32)), { now: () => kv.clock.now });
  return { kv, store };
}

describe("SessionStore (key-value backed)", () => {
  it("creates sessions with unguessable ids, keeps nothing until saved, and finds saved ones", async () => {
    const { kv, store } = setup();
    const a = store.create();
    const b = store.create();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
    expect(await store.get(a.id)).toBeUndefined();
    await store.save(a);
    expect(kv.writes).toHaveLength(1);
    expect((await store.get(a.id))?.id).toBe(a.id);
  });

  it("ignores missing, malformed and unknown ids", async () => {
    const { store } = setup();
    await store.save(store.create());
    expect(await store.get(undefined)).toBeUndefined();
    expect(await store.get("../../etc/passwd")).toBeUndefined();
    expect(await store.get("A".repeat(43))).toBeUndefined();
  });

  it("encrypts everything at rest and keys entries by a hash of the session id", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = { access_token: "secret-access-token", refresh_token: "secret-refresh", token_type: "Bearer" };
    s.codeVerifier = "secret-verifier";
    await store.save(s);
    const { key, value } = kv.last();
    expect(key).not.toContain(s.id);
    expect(value).toMatch(/^v1\./);
    for (const secret of ["secret-access-token", "secret-refresh", "secret-verifier", s.id]) expect(value).not.toContain(secret);
    expect((await store.get(s.id))?.tokens?.access_token).toBe("secret-access-token");
  });

  it("rejects tampered values, values sealed under another key, and values moved to another session", async () => {
    const { kv, store } = setup();
    const a = store.create();
    a.tokens = { access_token: "a", token_type: "Bearer" };
    await store.save(a);
    const sealedA = kv.last();

    const [v, iv, tag, body] = sealedA.value.split(".");
    const flipped = body[0] === "A" ? `B${body.slice(1)}` : `A${body.slice(1)}`;
    await kv.inner.set(sealedA.key, [v, iv, tag, flipped].join("."), 60);
    expect(await store.get(a.id)).toBeUndefined();

    const other = new SessionStore(kv, new Sealer(randomBytes(32)), { now: () => kv.clock.now });
    await kv.inner.set(sealedA.key, sealedA.value, 60);
    expect(await other.get(a.id)).toBeUndefined();

    const b = store.create();
    await store.save(b);
    await kv.inner.set(kv.last().key, sealedA.value, 60); // a's record under b's key
    expect(await store.get(b.id)).toBeUndefined();
  });

  it("uses mynt-chat's lifetimes: 10 minutes until signed in, 7 days idle after", async () => {
    const { kv, store } = setup();
    const signedOut = store.create();
    await store.save(signedOut);
    expect(kv.last().ttlSeconds).toBe(10 * 60);

    const signedIn = store.create();
    signedIn.tokens = { access_token: "t", token_type: "Bearer" };
    await store.save(signedIn);
    expect(kv.last().ttlSeconds).toBe(7 * 24 * 60 * 60);

    kv.clock.now = 11 * MIN;
    expect(await store.get(signedOut.id)).toBeUndefined();
    expect(await store.get(signedIn.id)).toBeDefined();
  });

  it("slides a signed-in session's expiry on use, writing at most once a minute", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = { access_token: "t", token_type: "Bearer" };
    await store.save(s);
    const writes = kv.writes.length;

    kv.clock.now = 30 * 1000;
    await store.get(s.id);
    expect(kv.writes.length).toBe(writes); // too soon to write

    kv.clock.now = 6 * DAY;
    await store.get(s.id);
    expect(kv.writes.length).toBe(writes + 1);

    kv.clock.now = 12 * DAY; // 6 days after last use: still alive
    expect(await store.get(s.id)).toBeDefined();
    kv.clock.now = 20 * DAY; // 8 days idle: gone
    expect(await store.get(s.id)).toBeUndefined();
  });

  it("rotates to a new id after sign-in, so the old id stops working", async () => {
    const { store } = setup();
    const old = store.create();
    old.tokens = { access_token: "t", token_type: "Bearer" };
    old.codeVerifier = "v";
    await store.save(old);
    const fresh = await store.rotate(old);
    expect(fresh.id).not.toBe(old.id);
    expect(await store.get(old.id)).toBeUndefined();
    const loaded = await store.get(fresh.id);
    expect(loaded?.tokens?.access_token).toBe("t");
    expect(loaded?.codeVerifier).toBeUndefined();
  });

  it("destroys sessions", async () => {
    const { store } = setup();
    const s = store.create();
    await store.save(s);
    await store.destroy(s.id);
    expect(await store.get(s.id)).toBeUndefined();
    await store.destroy(undefined); // no-op
  });
});

describe("SessionOAuthProvider over the key-value store", () => {
  it("keeps the client registration app-wide and encrypted, and forgets it on request", async () => {
    const { kv, store } = setup();
    const s1 = store.create();
    const s2 = store.create();
    const p1 = new SessionOAuthProvider(s1, store, REDIRECT, "openid");
    const p2 = new SessionOAuthProvider(s2, store, REDIRECT, "openid");

    await p1.saveClientInformation({ client_id: "client-1", client_secret: "client-secret" });
    expect(kv.last().value).not.toContain("client-secret");
    expect(await p2.clientInformation()).toEqual({ client_id: "client-1", client_secret: "client-secret" });

    p1.saveTokens({ access_token: "t", token_type: "Bearer" });
    expect(s1.tokens?.access_token).toBe("t");
    expect(p2.tokens()).toBeUndefined();

    await p1.invalidateCredentials("all");
    expect(s1.tokens).toBeUndefined();
    expect(await p2.clientInformation()).toBeUndefined();
  });
});

describe("MemoryKeyValue", () => {
  it("expires entries and drops the soonest-expiring one when full", async () => {
    let now = 0;
    const kv = new MemoryKeyValue(() => now, 2);
    await kv.set("short", "1", 60);
    await kv.set("long", "2", 3600);
    await kv.set("new", "3", 3600);
    expect(kv.size).toBe(2);
    expect(await kv.get("short")).toBeNull();
    now = 3601 * 1000;
    expect(await kv.get("long")).toBeNull();
  });
});

describe("Redis wiring", () => {
  it("reads Vercel's or Upstash's variable names", () => {
    expect(redisConfig({})).toBeUndefined();
    expect(redisConfig({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t" })).toEqual({ url: "https://kv.example", token: "t" });
    expect(redisConfig({ UPSTASH_REDIS_REST_URL: "https://u.example", UPSTASH_REDIS_REST_TOKEN: "u" })).toEqual({ url: "https://u.example", token: "u" });
  });

  it("requires an encryption key with Redis, and refuses memory on Vercel", () => {
    const redis = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t" };
    expect(() => storeFromEnv(redis)).toThrow(/SESSION_ENCRYPTION_KEY/);
    expect(() => storeFromEnv({ ...redis, SESSION_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/32 bytes/);
    expect(() => storeFromEnv({ VERCEL: "1" })).toThrow(/Redis/);
    expect(storeFromEnv({})).toBeInstanceOf(SessionStore);
  });

  it("stores sessions through the Redis client with an expiry", async () => {
    const data = new Map<string, string>();
    const calls: { key: string; ex: number }[] = [];
    const fake: RedisLike = {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value, opts) => {
        calls.push({ key, ex: opts.ex });
        data.set(key, value);
        return "OK";
      },
      del: async (key) => (data.delete(key) ? 1 : 0),
    };
    let made: { url: string; token: string } | undefined;
    const store = storeFromEnv(
      { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t", SESSION_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
      (cfg) => {
        made = cfg;
        return fake;
      },
    );
    expect(made).toEqual({ url: "https://kv.example", token: "t" });
    const s = store.create();
    await store.save(s);
    expect(calls).toEqual([{ key: expect.stringMatching(/^mynt-studio:session:/), ex: 600 }]);
    expect((await store.get(s.id))?.id).toBe(s.id);
    await store.destroy(s.id);
    expect(data.size).toBe(0);
    expect(await new RedisKeyValue(fake).get("missing")).toBeNull();
  });
});
