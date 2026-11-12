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
export interface Session extends AppState {
  id: string;
  createdAt: number;
  lastSeen: number;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  oauthState?: string; // CSRF check between /api/auth/login and /api/auth/callback
  busy?: boolean; // one state-changing request at a time per session
  userId?: string; // the signed-in Mynt user (from whoami)
  roles?: string[]; // their effective Mynt roles (from whoami)
}

const SESSION_ID = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

// The few key-value operations the store needs, with expiry in seconds.
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

// Encrypts every value at rest with AES-256-GCM, bound to its key: OAuth tokens, the PKCE
// verifier and the client registration are never stored in the clear, and a value copied to
// another key (another session's id) fails to decrypt.
export class Sealer {
  constructor(private key: Buffer) {
    if (key.length !== 32) throw new Error("SESSION_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  }

  seal(storeKey: string, plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(storeKey));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  open(storeKey: string, sealed: string): string | undefined {
    const [version, iv, tag, body] = sealed.split(".");
    if (version !== "v1" || !iv || !tag || body === undefined) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(storeKey));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      return undefined; // tampered with, or sealed under another key
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
  private ttlMs: number;
  private signedOutTtlMs: number;
  private clientTtlMs: number;
  private touchAfterMs: number;
  private now: () => number;
  private prefix: string;

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
    return { ...newAppState(), id, createdAt: t, lastSeen: t };
  }

  async get(id: string | undefined): Promise<Session | undefined> {
    if (!id || !SESSION_ID.test(id)) return undefined;
    const key = this.sessionKey(id);
    const sealed = await this.kv.get(key);
    const plain = sealed ? this.sealer.open(key, sealed) : undefined;
    if (!plain) return undefined;
    let session: Session;
    try {
      session = JSON.parse(plain) as Session;
    } catch {
      return undefined;
    }
    if (session.id !== id) return undefined;
    const t = this.now();
    if (t - session.lastSeen > this.lifetime(session)) {
      await this.kv.del(key);
      return undefined;
    }
    // Sliding expiry, without a write on every request.
    if (t - session.lastSeen > this.touchAfterMs) {
      session.lastSeen = t;
      await this.save(session);
    }
    return session;
  }

  async save(session: Session): Promise<void> {
    session.lastSeen = Math.max(session.lastSeen, this.now());
    const key = this.sessionKey(session.id);
    await this.kv.set(key, this.sealer.seal(key, JSON.stringify(session)), Math.ceil(this.lifetime(session) / 1000));
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
// processes, so it's never used on Vercel.
export class MemoryKeyValue implements KeyValue {
  private entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(
    private now: () => number = Date.now,
    private maxEntries = 10_000,
  ) {}

  async get(key: string): Promise<string | null> {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
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
  }

  async del(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

// The subset of an Upstash Redis client the store uses.
export interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { ex: number }): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export class RedisKeyValue implements KeyValue {
  constructor(private redis: RedisLike) {}

  async get(key: string): Promise<string | null> {
    const v = await this.redis.get(key);
    return typeof v === "string" ? v : null;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, { ex: Math.max(1, ttlSeconds) });
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
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

export function encryptionKey(env: Env): Buffer | undefined {
  const raw = env.SESSION_ENCRYPTION_KEY?.trim();
  return raw ? Buffer.from(raw, "base64") : undefined;
}

// Picks the store from the environment: Redis when it's configured (then an encryption key is
// required), memory otherwise, except on Vercel, where memory would lose sessions between
// function instances.
export function storeFromEnv(env: Env, redisClient?: (cfg: { url: string; token: string }) => RedisLike): SessionStore {
  const redis = redisConfig(env);
  const key = encryptionKey(env);
  if (redis) {
    if (!key) throw new Error("SESSION_ENCRYPTION_KEY is not set (see .env.example); it's required with Redis");
    const client = redisClient
      ? redisClient(redis)
      : new Redis({ url: redis.url, token: redis.token, automaticDeserialization: false });
    return new SessionStore(new RedisKeyValue(client), new Sealer(key));
  }
  if (env.VERCEL) throw new Error("No session store: connect a Redis database (KV_REST_API_URL and KV_REST_API_TOKEN)");
  // Local development: a per-process key is enough, since memory goes when the process does.
  return new SessionStore(new MemoryKeyValue(), new Sealer(key ?? randomBytes(32)));
}

// One store per server process. Kept on globalThis so Next's dev-mode module reloads don't
// drop everyone's session.
const globalStore = globalThis as typeof globalThis & { __myntStudioSessions?: SessionStore };
export function sessionStore(): SessionStore {
  globalStore.__myntStudioSessions ??= storeFromEnv(process.env);
  return globalStore.__myntStudioSessions;
}
