import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Redis } from "@upstash/redis";
import { newAppState, type AppState } from "./app-session";

// Everything the server keeps for one browser. None of it is ever sent to the browser: the
// browser only holds the random session id in an httpOnly cookie.
//
// session.ts, oauth-provider.ts, mynt-client.ts and app/api/auth/* are shared, byte for byte,
// with mynt-chat (CI diffs them). This store has the same methods as mynt-chat's in-memory one,
// but keeps sessions in a key-value store, because the studio runs on serverless functions
// whose instances share no memory: hosted Redis when it's configured, memory otherwise (local
// development and tests).
//
// Several requests from one browser run at once, each with its own copy of the session. So:
// - a session that was signed out (destroyed) stays gone: saving an existing session only
//   overwrites a stored one (SET XX), and only a new session is created (SET NX);
// - newer tokens win: a request holding older tokens never writes them over newer ones;
// - tokens are refreshed by one request at a time (lock(), used by lib/tokens.ts).
export interface Session extends AppState {
  id: string;
  createdAt: number;
  lastSeen: number;
  tokens?: OAuthTokens;
  tokensAt?: number; // when these tokens were issued (saved), for their expiry
  codeVerifier?: string;
  oauthState?: string; // CSRF check between /api/auth/login and /api/auth/callback
  busy?: boolean; // one state-changing request at a time per session
  userId?: string; // the signed-in Mynt user (from whoami)
  roles?: string[]; // their effective Mynt roles (from whoami)
  rolesAt?: number; // when the roles were last read from Mynt
}

const SESSION_ID = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

// The few key-value operations the store needs, with expiry in seconds. `only` makes a write
// conditional: "nx" only creates, "xx" only replaces. It returns whether it wrote.
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number, only?: "nx" | "xx"): Promise<boolean>;
  del(key: string): Promise<void>;
  // Adds one to a counter and returns it; the counter expires ttlSeconds after it's created.
  incr(key: string, ttlSeconds: number): Promise<number>;
}

const GCM_TAG_BYTES = 16;
const GCM_IV_BYTES = 12;

// The id of a key: the first bytes of its hash, so a sealed value says which key sealed it.
export const keyId = (key: Buffer) => createHash("sha256").update(key).digest("base64url").slice(0, 8);

// Encrypts every value at rest with AES-256-GCM, bound to its key: OAuth tokens, the PKCE
// verifier and the client registration are never stored in the clear, and a value copied to
// another key (another session's id) fails to decrypt.
//
// Sealed values name their key (`v2.<key id>.<iv>.<tag>.<ciphertext>`). New values use the
// first key; the others still open older values, so SESSION_ENCRYPTION_KEY can be rotated by
// moving the old key to SESSION_ENCRYPTION_KEYS_OLD.
export class Sealer {
  private keys: Map<string, Buffer>;
  private current: { id: string; key: Buffer };

  constructor(current: Buffer, old: Buffer[] = []) {
    for (const k of [current, ...old]) {
      if (k.length !== 32) throw new Error("Session encryption keys must be 32 bytes, base64-encoded");
    }
    this.current = { id: keyId(current), key: current };
    this.keys = new Map([current, ...old].map((k) => [keyId(k), k]));
  }

  seal(storeKey: string, plaintext: string): string {
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.current.key, iv, { authTagLength: GCM_TAG_BYTES });
    cipher.setAAD(Buffer.from(storeKey));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v2", this.current.id, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(storeKey: string, sealed: string): string | undefined {
    const [version, kid, ivText, tagText, body, ...extra] = sealed.split(".");
    if (version !== "v2" || !kid || !ivText || !tagText || body === undefined || extra.length) return undefined;
    const key = this.keys.get(kid);
    if (!key) return undefined;
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    // A short tag would let a forger guess it; only full-length tags are accepted.
    if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
      decipher.setAAD(Buffer.from(storeKey));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return undefined; // tampered with, or sealed under a key we don't have
    }
  }
}

export interface SessionStoreOptions {
  ttlMs?: number; // a signed-in session, idle
  signedOutTtlMs?: number; // a session that never finished signing in
  clientTtlMs?: number; // the app's dynamic client registration
  touchAfterMs?: number; // how stale lastSeen may get before a read writes it back
  now?: () => number;
  prefix?: string;
}

// Same lifetimes as mynt-chat: 7 days idle once signed in, 10 minutes for a session that never
// finished signing in (anyone can start one).
export class SessionStore {
  readonly ttlMs: number;
  private signedOutTtlMs: number;
  private clientTtlMs: number;
  private touchAfterMs: number;
  private now: () => number;
  private prefix: string;
  // Sessions made by create() and not saved yet: their first save creates them.
  private unsaved = new WeakSet<Session>();
  // Sessions whose expiry moved on this request, so the cookie's should move too.
  private touched = new WeakSet<Session>();
  // The access token each copy was read with, to tell this request's own refresh (or sign-out)
  // from another request's newer tokens.
  private readWith = new WeakMap<Session, string | undefined>();

  constructor(
    private kv: KeyValue,
    private sealer: Sealer,
    opts: SessionStoreOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.signedOutTtlMs = opts.signedOutTtlMs ?? 10 * 60 * 1000;
    this.clientTtlMs = opts.clientTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.touchAfterMs = opts.touchAfterMs ?? 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.prefix = opts.prefix ?? "mynt-studio";
  }

  // A new session, held in memory until it's saved.
  create(): Session {
    const id = randomBytes(32).toString("base64url");
    const t = this.now();
    const session: Session = { ...newAppState(), id, createdAt: t, lastSeen: t };
    this.unsaved.add(session);
    return session;
  }

  private async load(id: string): Promise<Session | undefined> {
    const key = this.sessionKey(id);
    const sealed = await this.kv.get(key);
    const plain = sealed ? this.sealer.open(key, sealed) : undefined;
    if (!plain) return undefined;
    try {
      const session = JSON.parse(plain) as Session;
      return session.id === id ? session : undefined;
    } catch {
      return undefined;
    }
  }

  async get(id: string | undefined): Promise<Session | undefined> {
    if (!id || !SESSION_ID.test(id)) return undefined;
    const session = await this.load(id);
    if (!session) return undefined;
    this.readWith.set(session, session.tokens?.access_token);
    const t = this.now();
    if (t - session.lastSeen > this.lifetime(session)) {
      await this.kv.del(this.sessionKey(id));
      return undefined;
    }
    // Sliding expiry, without a write on every request.
    if (t - session.lastSeen > this.touchAfterMs) {
      session.lastSeen = t;
      if (await this.save(session)) this.touched.add(session);
    }
    return session;
  }

  // Whether this request moved the session's expiry (the cookie's should follow).
  wasTouched(session: Session): boolean {
    return this.touched.has(session);
  }

  // Writes the session back. A new session is created; an existing one is only replaced, so a
  // session destroyed meanwhile (signed out) stays destroyed. Returns whether it was written.
  async save(session: Session): Promise<boolean> {
    session.lastSeen = Math.max(session.lastSeen, this.now());
    const key = this.sessionKey(session.id);
    const creating = this.unsaved.has(session);
    const changedHere = session.tokens?.access_token !== this.readWith.get(session);
    if (changedHere && session.tokens) session.tokensAt = this.now();
    if (!creating) {
      const stored = await this.load(session.id);
      if (!stored) return false; // signed out (or expired) meanwhile: stays gone
      // Never put back older tokens than the stored ones (another request refreshed them).
      if (!changedHere && stored.tokens && (stored.tokensAt ?? 0) > (session.tokensAt ?? 0)) {
        session.tokens = stored.tokens;
        session.tokensAt = stored.tokensAt;
      }
    }
    const ok = await this.kv.set(key, this.sealer.seal(key, JSON.stringify(session)), Math.ceil(this.lifetime(session) / 1000), creating ? "nx" : "xx");
    if (ok) {
      this.unsaved.delete(session);
      this.readWith.set(session, session.tokens?.access_token);
    }
    return ok;
  }

  // After sign-in: a new id holding the old session's tokens, with fresh app state. The old id
  // stops working, so a session id planted before sign-in is useless after it.
  async rotate(old: Session): Promise<Session> {
    const fresh = this.create();
    fresh.tokens = old.tokens;
    await this.save(fresh);
    await this.destroy(old.id);
    return fresh;
  }

  async destroy(id: string | undefined): Promise<void> {
    if (id && SESSION_ID.test(id)) await this.kv.del(this.sessionKey(id));
  }

  // Claims something once for a while (true the first time, false on repeats until it
  // expires); used so a message sent twice doesn't start two builds.
  async claim(name: string, subject: string, ttlSeconds: number): Promise<boolean> {
    return this.kv.set(this.claimKey(name, subject), "1", ttlSeconds, "nx");
  }

  // Gives a claim back (nothing was done with it).
  async unclaim(name: string, subject: string): Promise<void> {
    await this.kv.del(this.claimKey(name, subject));
  }

  private claimKey(name: string, subject: string): string {
    return `${this.prefix}:claim:${name}:${createHash("sha256").update(subject).digest("base64url")}`;
  }

  // A short lock per session, so one request at a time refreshes its tokens. Returns a release
  // function, or null when another request holds it.
  async lock(sessionId: string, name: string, ttlSeconds = 15): Promise<(() => Promise<void>) | null> {
    const key = `${this.sessionKey(sessionId)}:lock:${name}`;
    const ok = await this.kv.set(key, randomBytes(8).toString("base64url"), ttlSeconds, "nx");
    return ok ? () => this.kv.del(key) : null;
  }

  // Re-reads the stored session's tokens into this copy (after another request refreshed them).
  async reloadTokens(session: Session): Promise<void> {
    const stored = await this.load(session.id);
    if (stored?.tokens && (stored.tokensAt ?? 0) >= (session.tokensAt ?? 0)) {
      session.tokens = stored.tokens;
      session.tokensAt = stored.tokensAt;
      this.readWith.set(session, stored.tokens.access_token);
    }
  }

  // Counts an event for a key (an IP address, hashed) within a window; for rate limits.
  async count(name: string, subject: string, windowSeconds: number): Promise<number> {
    return this.kv.incr(`${this.prefix}:rate:${name}:${createHash("sha256").update(subject).digest("base64url")}`, windowSeconds);
  }

  // Dynamic client registration happens once per app (per redirect URL), not per user.
  async clientInformation(redirectUrl: string): Promise<OAuthClientInformationMixed | undefined> {
    const key = this.clientKey(redirectUrl);
    const sealed = await this.kv.get(key);
    const plain = sealed ? this.sealer.open(key, sealed) : undefined;
    if (!plain) return undefined;
    try {
      return JSON.parse(plain) as OAuthClientInformationMixed;
    } catch {
      return undefined;
    }
  }

  async saveClientInformation(redirectUrl: string, info: OAuthClientInformationMixed): Promise<void> {
    const key = this.clientKey(redirectUrl);
    await this.kv.set(key, this.sealer.seal(key, JSON.stringify(info)), Math.ceil(this.clientTtlMs / 1000));
  }

  async forgetClient(redirectUrl: string): Promise<void> {
    await this.kv.del(this.clientKey(redirectUrl));
  }

  private lifetime(s: Session): number {
    return s.tokens ? this.ttlMs : Math.min(this.ttlMs, this.signedOutTtlMs);
  }

  // Keys hold a hash of the session id, so reading the store's keys gives no usable cookie.
  private sessionKey(id: string): string {
    return `${this.prefix}:session:${createHash("sha256").update(id).digest("base64url")}`;
  }

  private clientKey(redirectUrl: string): string {
    return `${this.prefix}:client:${createHash("sha256").update(redirectUrl).digest("base64url")}`;
  }
}

// For local development and tests: entries expire like Redis's, and at most `maxEntries` are
// kept (the soonest to expire, usually unfinished sign-ins, go first). Not shared between
// processes, so it's never used on Vercel or in production unless explicitly allowed.
export class MemoryKeyValue implements KeyValue {
  private entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private now: () => number = Date.now,
    private maxEntries = 10_000,
  ) {}

  private live(key: string): { value: string; expiresAt: number } | undefined {
    const e = this.entries.get(key);
    if (e && e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds: number, only?: "nx" | "xx"): Promise<boolean> {
    const exists = this.live(key) !== undefined;
    if ((only === "nx" && exists) || (only === "xx" && !exists)) return false;
    const t = this.now();
    this.entries.delete(key);
    for (const [k, e] of this.entries) if (e.expiresAt <= t) this.entries.delete(k);
    while (this.entries.size >= this.maxEntries) {
      let victim: string | undefined;
      let soonest = Infinity;
      for (const [k, e] of this.entries) if (e.expiresAt < soonest) [victim, soonest] = [k, e.expiresAt];
      if (victim === undefined) break;
      this.entries.delete(victim);
    }
    this.entries.set(key, { value, expiresAt: t + ttlSeconds * 1000 });
    return true;
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const e = this.live(key);
    const n = (e ? Number(e.value) : 0) + 1;
    this.entries.set(key, { value: String(n), expiresAt: e?.expiresAt ?? this.now() + ttlSeconds * 1000 });
    return n;
  }

  get size(): number {
    return this.entries.size;
  }
}

// The subset of an Upstash Redis client the store uses.
export interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { ex: number; nx?: true; xx?: true }): Promise<unknown>;
  del(key: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export class RedisKeyValue implements KeyValue {
  constructor(private redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    const v = await this.redis.get(key);
    return typeof v === "string" ? v : null;
  }

  async set(key: string, value: string, ttlSeconds: number, only?: "nx" | "xx"): Promise<boolean> {
    const ex = Math.max(1, ttlSeconds);
    const r = await this.redis.set(key, value, only === "nx" ? { ex, nx: true } : only === "xx" ? { ex, xx: true } : { ex });
    return r !== null; // a conditional SET that didn't apply replies nil
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, Math.max(1, ttlSeconds));
    return n;
  }
}

type Env = Record<string, string | undefined>;

// The hosted Redis's REST endpoint and token, under the names Vercel's Redis integration
// (KV_REST_API_*) or Upstash itself (UPSTASH_REDIS_REST_*) sets.
export function redisConfig(env: Env): { url: string; token: string } | undefined {
  const url = (env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL)?.trim();
  const token = (env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN)?.trim();
  return url && token ? { url, token } : undefined;
}

const decodeKey = (raw: string) => Buffer.from(raw.trim(), "base64");

// The current key, and older ones that still open values sealed before a rotation.
export function encryptionKeys(env: Env): { current: Buffer; old: Buffer[] } | undefined {
  const raw = env.SESSION_ENCRYPTION_KEY?.trim();
  if (!raw) return undefined;
  const old = (env.SESSION_ENCRYPTION_KEYS_OLD ?? "").split(/[\s,]+/).filter(Boolean).map(decodeKey);
  return { current: decodeKey(raw), old };
}

// Picks the store from the environment: Redis when it's configured (then an encryption key is
// required), memory otherwise. Memory is refused on Vercel, where function instances share no
// memory, and in production unless SESSION_STORE=memory says it's wanted (one process only).
export function storeFromEnv(env: Env, redisClient?: (cfg: { url: string; token: string }) => RedisLike): SessionStore {
  const redis = redisConfig(env);
  const keys = encryptionKeys(env);
  if (redis) {
    if (!keys) throw new Error("SESSION_ENCRYPTION_KEY is not set (see .env.example); it's required with Redis");
    const client = redisClient
      ? redisClient(redis)
      : (new Redis({ url: redis.url, token: redis.token, automaticDeserialization: false }) as unknown as RedisLike);
    return new SessionStore(new RedisKeyValue(client), new Sealer(keys.current, keys.old));
  }
  if (env.VERCEL) throw new Error("No session store: connect a Redis database (KV_REST_API_URL and KV_REST_API_TOKEN)");
  if (env.NODE_ENV === "production" && env.SESSION_STORE !== "memory") {
    throw new Error("No session store: set KV_REST_API_URL and KV_REST_API_TOKEN, or SESSION_STORE=memory for a single local process");
  }
  // Local development: a per-process key is enough, since memory goes when the process does.
  return new SessionStore(new MemoryKeyValue(), new Sealer(keys?.current ?? randomBytes(32), keys?.old ?? []));
}

// One store per server process. Kept on globalThis so Next's dev-mode module reloads don't
// drop everyone's session.
const globalStore = globalThis as typeof globalThis & { __myntStudioSessions?: SessionStore };
export function sessionStore(): SessionStore {
  globalStore.__myntStudioSessions ??= storeFromEnv(process.env);
  return globalStore.__myntStudioSessions;
}
