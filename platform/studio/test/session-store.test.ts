import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionOAuthProvider } from "@mynt/auth";
import { oauthClientName } from "@/lib/config";
import {
  keyId,
  MemoryKeyValue,
  RedisKeyValue,
  Sealer,
  SessionStore,
  encryptionKeys,
  redisConfig,
  storeFromEnv,
  type KeyValue,
  type RedisLike,
  CLIENT_REJECTIONS,
  DEL_IF_EQUALS,
  INCR_WITH_EXPIRY,
} from "@/lib/session-store";

const REDIRECT = "http://localhost:3000/api/auth/callback";
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

// A fake key-value store that records what was written, with a settable clock.
class FakeKv implements KeyValue {
  inner: MemoryKeyValue;
  writes: { key: string; value: string; ttlSeconds: number; only?: "nx" | "xx"; ok: boolean }[] = [];
  constructor(public clock = { now: 0 }) {
    this.inner = new MemoryKeyValue(() => this.clock.now);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  async set(key: string, value: string, ttlSeconds: number, only?: "nx" | "xx") {
    const ok = await this.inner.set(key, value, ttlSeconds, only);
    this.writes.push({ key, value, ttlSeconds, only, ok });
    return ok;
  }
  del(key: string) {
    return this.inner.del(key);
  }
  delIfEquals(key: string, value: string) {
    return this.inner.delIfEquals(key, value);
  }
  expire(key: string, ttlSeconds: number) {
    return this.inner.expire(key, ttlSeconds);
  }
  incr(key: string, ttlSeconds: number) {
    return this.inner.incr(key, ttlSeconds);
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

const token = (access_token: string) => ({ access_token, refresh_token: `r-${access_token}`, token_type: "Bearer", expires_in: 3600 });

describe("SessionStore (key-value backed)", () => {
  it("creates sessions with unguessable ids, keeps nothing until saved, and finds saved ones", async () => {
    const { kv, store } = setup();
    const a = store.create();
    const b = store.create();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
    expect(await store.get(a.id)).toBeUndefined();
    expect(await store.save(a)).toBe(true);
    expect(kv.last().only).toBe("nx"); // a new session is created, never written over another
    expect((await store.get(a.id))?.id).toBe(a.id);
  });

  it("ignores missing, malformed and unknown ids", async () => {
    const { store } = setup();
    await store.save(store.create());
    expect(await store.get(undefined)).toBeUndefined();
    expect(await store.get("../../etc/passwd")).toBeUndefined();
    expect(await store.get("A".repeat(43))).toBeUndefined();
  });

  it("encrypts everything at rest, names the key, and keys entries by a hash of the session id", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = { access_token: "secret-access-token", refresh_token: "secret-refresh", token_type: "Bearer" };
    s.codeVerifier = "secret-verifier";
    await store.save(s);
    const { key, value } = kv.last();
    expect(key).not.toContain(s.id);
    expect(value).toMatch(/^v2\.[A-Za-z0-9_-]{8}\./);
    for (const secret of ["secret-access-token", "secret-refresh", "secret-verifier", s.id]) expect(value).not.toContain(secret);
    expect((await store.get(s.id))?.tokens?.access_token).toBe("secret-access-token");
  });

  it("rejects tampered values, unknown keys, and values moved to another session", async () => {
    const { kv, store } = setup();
    const a = store.create();
    a.tokens = token("a");
    await store.save(a);
    const sealedA = kv.last();

    const [v, kid, iv, tag, body] = sealedA.value.split(".");
    const flipped = body[0] === "A" ? `B${body.slice(1)}` : `A${body.slice(1)}`;
    await kv.inner.set(sealedA.key, [v, kid, iv, tag, flipped].join("."), 60);
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
    signedIn.tokens = token("t");
    await store.save(signedIn);
    expect(kv.last().ttlSeconds).toBe(7 * 24 * 60 * 60);

    kv.clock.now = 11 * MIN;
    expect(await store.get(signedOut.id)).toBeUndefined();
    expect(await store.get(signedIn.id)).toBeDefined();
  });

  it("slides a signed-in session's expiry on use, writing at most once a minute, and says when it did", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = token("t");
    await store.save(s);
    const writes = kv.writes.length;

    kv.clock.now = 30 * 1000;
    const early = await store.get(s.id);
    expect(kv.writes.length).toBe(writes); // too soon to write
    expect(store.wasTouched(early!)).toBe(false);

    kv.clock.now = 6 * DAY;
    const later = await store.get(s.id);
    expect(kv.writes.length).toBe(writes + 1);
    expect(store.wasTouched(later!)).toBe(true); // the route sends the cookie again

    kv.clock.now = 12 * DAY; // 6 days after last use: still alive
    expect(await store.get(s.id)).toBeDefined();
    kv.clock.now = 20 * DAY; // 8 days idle: gone
    expect(await store.get(s.id)).toBeUndefined();
  });

  it("rotates to a new id after sign-in, so the old id stops working", async () => {
    const { store } = setup();
    const old = store.create();
    old.tokens = token("t");
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

describe("concurrent requests on one session", () => {
  it("a request finishing after sign-out doesn't bring the session back", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = token("t");
    await store.save(s);

    const inFlight = await store.get(s.id); // a slow request's copy
    await store.destroy(s.id); // the user signs out meanwhile
    inFlight!.roles = ["developer"];
    const writes = kv.writes.length;
    expect(await store.save(inFlight!)).toBe(false);
    expect(kv.writes.length).toBe(writes); // nothing written
    expect(await store.get(s.id)).toBeUndefined();
  });

  it("even when sign-out lands between reading and writing, the write only replaces (XX) and so fails", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = token("t");
    await store.save(s);
    const inFlight = await store.get(s.id);
    const realSet = kv.set.bind(kv);
    kv.set = async (key, value, ttl, only) => {
      await store.destroy(s.id); // sign-out, just before the write
      return realSet(key, value, ttl, only);
    };
    expect(await store.save(inFlight!)).toBe(false);
    expect(kv.last()).toMatchObject({ only: "xx", ok: false });
    kv.set = realSet;
    expect(await store.get(s.id)).toBeUndefined();
  });

  it("a request holding older tokens never writes them over newer ones", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = token("old");
    await store.save(s);

    const a = await store.get(s.id);
    const b = await store.get(s.id);
    kv.clock.now = 1000;
    a!.tokens = token("new"); // request A refreshed
    await store.save(a!);
    kv.clock.now = 2000;
    b!.roles = ["developer"]; // request B only changed its roles, but still holds the old tokens
    await store.save(b!);

    const stored = await store.get(s.id);
    expect(stored?.tokens?.access_token).toBe("new");
    expect(stored?.roles).toEqual(["developer"]);
    expect(b!.tokens?.access_token).toBe("new"); // B's copy caught up too
  });

  it("a request's own sign-out (tokens cleared) is kept", async () => {
    const { store } = setup();
    const s = store.create();
    s.tokens = token("t");
    await store.save(s);
    const a = await store.get(s.id);
    a!.tokens = undefined;
    await store.save(a!);
    expect((await store.get(s.id))?.tokens).toBeUndefined();
  });

  it("a stale sign-out (Mynt refused the old token) doesn't clear newer tokens another request got", async () => {
    const { kv, store } = setup();
    const s = store.create();
    s.tokens = token("old");
    await store.save(s);
    const refresher = await store.get(s.id);
    const stale = await store.get(s.id);
    kv.clock.now = 1000;
    refresher!.tokens = token("new");
    await store.save(refresher!);
    stale!.tokens = undefined; // its call with "old" was refused
    await store.save(stale!);
    expect((await store.get(s.id))?.tokens?.access_token).toBe("new");
    expect((stale as typeof s).tokens?.access_token).toBe("new"); // reloaded instead
  });

  it("a lock taken over after its TTL isn't released by its first holder", async () => {
    const { kv, store } = setup();
    const s = store.create();
    await store.save(s);
    const first = await store.lock(s.id, "refresh", 15);
    kv.clock.now = 16_000; // the first holder overran its TTL
    const second = await store.lock(s.id, "refresh", 15);
    expect(second).not.toBeNull();
    await first!(); // late release by the first holder
    expect(await store.lock(s.id, "refresh", 15)).toBeNull(); // still the second's
    await second!();
    expect(await store.lock(s.id, "refresh", 15)).not.toBeNull();
  });

  it("a late release of a lapsed claim doesn't free the claim another request took since", async () => {
    const { kv, store } = setup();
    const first = await store.claim("start-lock", "user\napp", 10);
    kv.clock.now = 11_000;
    const second = await store.claim("start-lock", "user\napp", 10);
    expect(second).not.toBeNull();
    await first!();
    expect(await store.claim("start-lock", "user\napp", 10)).toBeNull();
  });

  it("only one request at a time holds the refresh lock; it frees on release or after its TTL", async () => {
    const { kv, store } = setup();
    const s = store.create();
    await store.save(s);
    const release = await store.lock(s.id, "refresh", 15);
    expect(release).not.toBeNull();
    expect(await store.lock(s.id, "refresh", 15)).toBeNull();
    await release!();
    const again = await store.lock(s.id, "refresh", 15);
    expect(again).not.toBeNull();
    kv.clock.now = 16_000;
    expect(await store.lock(s.id, "refresh", 15)).not.toBeNull();
  });
});

describe("Sealer", () => {
  it("only accepts full 16-byte GCM tags and 12-byte IVs", () => {
    const sealer = new Sealer(randomBytes(32));
    const sealed = sealer.seal("k", "hello");
    expect(sealer.open("k", sealed)).toBe("hello");
    const [v, kid, iv, tag, body] = sealed.split(".");
    const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
    expect(sealer.open("k", [v, kid, iv, shortTag, body].join("."))).toBeUndefined();
    const shortIv = Buffer.from(iv, "base64url").subarray(0, 8).toString("base64url");
    expect(sealer.open("k", [v, kid, shortIv, tag, body].join("."))).toBeUndefined();
    expect(sealer.open("k", `${sealed}.extra`)).toBeUndefined();
    expect(sealer.open("k", sealed.replace(/^v2/, "v1"))).toBeUndefined();
  });

  it("rotates keys: new values use the current key, old values still open with the old one", () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = new Sealer(oldKey).seal("k", "kept");
    const after = new Sealer(newKey, [oldKey]);
    expect(after.open("k", before)).toBe("kept");
    expect(after.seal("k", "x").split(".")[1]).toBe(keyId(newKey));
    expect(new Sealer(newKey).open("k", before)).toBeUndefined(); // once the old key is dropped
    expect(() => new Sealer(newKey, [Buffer.alloc(16)])).toThrow(/32 bytes/);
  });

  it("reads the current and old keys from the environment", () => {
    const a = randomBytes(32).toString("base64");
    const b = randomBytes(32).toString("base64");
    const c = randomBytes(32).toString("base64");
    const keys = encryptionKeys({ SESSION_ENCRYPTION_KEY: a, SESSION_ENCRYPTION_KEYS_OLD: `${b}, ${c}` });
    expect(keys?.current.toString("base64")).toBe(a);
    expect(keys?.old.map((k) => k.toString("base64"))).toEqual([b, c]);
    expect(encryptionKeys({})).toBeUndefined();
  });
});

describe("client registration", () => {
  it("survives a key rotation: re-sealed with the new key when read, then the old key can go", async () => {
    const kv = new FakeKv();
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = new SessionStore(kv, new Sealer(oldKey), { now: () => kv.clock.now });
    await before.saveClientInformation(REDIRECT, { client_id: "c1" });

    const rotating = new SessionStore(kv, new Sealer(newKey, [oldKey]), { now: () => kv.clock.now });
    expect(await rotating.clientInformation(REDIRECT)).toEqual({ client_id: "c1" });
    expect(kv.last().value.split(".")[1]).toBe(keyId(newKey)); // re-sealed

    const after = new SessionStore(kv, new Sealer(newKey), { now: () => kv.clock.now });
    expect(await after.clientInformation(REDIRECT)).toEqual({ client_id: "c1" });
  });

  it("doesn't expire while it's being used", async () => {
    const { kv, store } = setup();
    await store.saveClientInformation(REDIRECT, { client_id: "c1" });
    for (let day = 1; day <= 60; day += 20) {
      kv.clock.now = day * DAY;
      expect(await store.clientInformation(REDIRECT)).toEqual({ client_id: "c1" });
    }
  });
});

describe("SessionOAuthProvider over the key-value store", () => {
  it("keeps the client registration app-wide and encrypted, and forgets it on request", async () => {
    const { kv, store } = setup();
    const s1 = store.create();
    const s2 = store.create();
    const p1 = new SessionOAuthProvider(s1, store, REDIRECT, "openid", oauthClientName());
    const p2 = new SessionOAuthProvider(s2, store, REDIRECT, "openid", oauthClientName());

    await p1.saveClientInformation!({ client_id: "client-1", client_secret: "client-secret" });
    expect(kv.last().value).not.toContain("client-secret");
    expect(await p2.clientInformation()).toEqual({ client_id: "client-1", client_secret: "client-secret" });

    p1.saveTokens({ access_token: "t", token_type: "Bearer" });
    expect(s1.tokens?.access_token).toBe("t");
    expect(p2.tokens()).toBeUndefined();

    // One refused sign-in clears that session's tokens, not the app-wide registration.
    await p1.invalidateCredentials("all");
    expect(s1.tokens).toBeUndefined();
    expect(await p2.clientInformation()).toEqual({ client_id: "client-1", client_secret: "client-secret" });
    // Repeated refusals mean the registration really is gone: then it's dropped.
    for (let i = 1; i < CLIENT_REJECTIONS; i++) await p1.invalidateCredentials("client");
    expect(await p2.clientInformation()).toBeUndefined();
  });

  it("counts refusals per client: three drop c1, and one more refusal doesn't drop its replacement c2", async () => {
    const { store } = setup();
    const p = new SessionOAuthProvider(store.create(), store, REDIRECT, "openid", oauthClientName());
    await p.saveClientInformation!({ client_id: "c1" });
    for (let i = 0; i < CLIENT_REJECTIONS; i++) await p.invalidateCredentials("client");
    expect(await p.clientInformation()).toBeUndefined();
    await p.saveClientInformation!({ client_id: "c2" }); // the next sign-in registers again
    await p.invalidateCredentials("client");
    expect(await p.clientInformation()).toEqual({ client_id: "c2" });
  });

  it("a refusal more than an hour after the last doesn't add up to dropping the registration", async () => {
    const { kv, store } = setup();
    const p = new SessionOAuthProvider(store.create(), store, REDIRECT, "openid", oauthClientName());
    await p.saveClientInformation!({ client_id: "c" });
    for (let i = 0; i < CLIENT_REJECTIONS; i++) {
      kv.clock.now = i * 61 * MIN;
      await p.invalidateCredentials("all");
    }
    expect(await p.clientInformation()).toEqual({ client_id: "c" });
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

  it("evicts counters too when full", async () => {
    const kv = new MemoryKeyValue(() => 0, 3);
    for (let i = 0; i < 10; i++) await kv.incr(`rate-${i}`, 60);
    expect(kv.size).toBe(3);
  });

  it("honours NX and XX, and counts within a window", async () => {
    let now = 0;
    const kv = new MemoryKeyValue(() => now);
    expect(await kv.set("k", "1", 60, "xx")).toBe(false);
    expect(await kv.set("k", "1", 60, "nx")).toBe(true);
    expect(await kv.set("k", "2", 60, "nx")).toBe(false);
    expect(await kv.set("k", "3", 60, "xx")).toBe(true);
    expect(await kv.get("k")).toBe("3");
    expect(await kv.incr("c", 60)).toBe(1);
    expect(await kv.incr("c", 60)).toBe(2);
    now = 61_000;
    expect(await kv.incr("c", 60)).toBe(1);
  });
});

describe("Redis wiring", () => {
  it("reads Vercel's or Upstash's variable names", () => {
    expect(redisConfig({})).toBeUndefined();
    expect(redisConfig({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t" })).toEqual({ url: "https://kv.example", token: "t" });
    expect(redisConfig({ UPSTASH_REDIS_REST_URL: "https://u.example", UPSTASH_REDIS_REST_TOKEN: "u" })).toEqual({ url: "https://u.example", token: "u" });
  });

  it("requires an encryption key with Redis, and refuses memory on Vercel and in production unless allowed", () => {
    const redis = { KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "t" };
    expect(() => storeFromEnv(redis)).toThrow(/SESSION_ENCRYPTION_KEY/);
    expect(() => storeFromEnv({ ...redis, SESSION_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/32 bytes/);
    expect(() => storeFromEnv({ VERCEL: "1" })).toThrow(/Redis/);
    expect(() => storeFromEnv({ NODE_ENV: "production" })).toThrow(/SESSION_STORE=memory/);
    expect(storeFromEnv({ NODE_ENV: "production", SESSION_STORE: "memory" })).toBeInstanceOf(SessionStore);
    expect(storeFromEnv({})).toBeInstanceOf(SessionStore);
  });

  it("stores sessions through the Redis client: NX to create, XX to replace, with an expiry", async () => {
    const data = new Map<string, string>();
    const calls: { key: string; opts: object }[] = [];
    const evals: { key: string; expire: unknown }[] = [];
    const fake: RedisLike = {
      get: async (key) => data.get(key) ?? null,
      set: async (key, value, opts) => {
        calls.push({ key, opts });
        if ((opts.nx && data.has(key)) || (opts.xx && !data.has(key))) return null;
        data.set(key, value);
        return "OK";
      },
      del: async (key) => (data.delete(key) ? 1 : 0),
      expire: async () => 1,
      // The two scripts, as Redis would run them.
      eval: async (script, keys, args) => {
        const [key] = keys;
        if (script === INCR_WITH_EXPIRY) {
          const n = Number(data.get(key) ?? 0) + 1;
          data.set(key, String(n));
          if (n === 1) evals.push({ key, expire: args[0] });
          return n;
        }
        if (script === DEL_IF_EQUALS) return data.get(key) === args[0] && data.delete(key) ? 1 : 0;
        throw new Error("unknown script");
      },
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
    expect(calls[0]).toEqual({ key: expect.stringMatching(/^mynt-studio:session:/), opts: { ex: 600, nx: true } });
    const loaded = await store.get(s.id);
    await store.save(loaded!);
    expect(calls[1].opts).toEqual({ ex: 600, xx: true });
    await store.destroy(s.id);
    expect(await store.save(loaded!)).toBe(false);
    expect(data.size).toBe(0);
    expect(await new RedisKeyValue(fake).get("missing")).toBeNull();
    expect(await new RedisKeyValue(fake).incr("c", 60)).toBe(1);
    expect(await new RedisKeyValue(fake).incr("c", 60)).toBe(2);
    expect(evals).toEqual([{ key: "c", expire: 60 }]); // INCR and EXPIRE in one script
    data.set("lock", "mine");
    expect(await new RedisKeyValue(fake).delIfEquals("lock", "theirs")).toBe(false);
    expect(await new RedisKeyValue(fake).delIfEquals("lock", "mine")).toBe(true);
  });
});
