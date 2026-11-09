import { safePost, type VendorCallOptions } from "../vendor-call.js";

// Solana JSON-RPC, for devnet and mainnet. Calls go out under Mynt's outbound rules (https, never a private or
// loopback address, no redirects, a time limit and a size cap). An RPC URL may carry a provider's key in its
// query string, so it is a secret: read from the environment by name, never returned, logged or shown.

export const CLUSTERS = ["devnet", "mainnet"] as const;
export type Cluster = (typeof CLUSTERS)[number];

// Devnet's public endpoint is fine for sandbox use; mainnet needs a provider the operator chooses.
export const PUBLIC_DEVNET_RPC = "https://api.devnet.solana.com";

export interface SolanaRpc {
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

// How long a call keeps retrying a rate limit or an overloaded gateway, and how it waits. Tests pass their own
// clock and sleep.
export interface RetryOptions {
  maxRetryMs?: number; // the total a call may spend waiting between attempts (SOLANA_RPC_MAX_RETRY_SECONDS)
  baseDelayMs?: number; // the first backoff, doubled each attempt
  maxDelayMs?: number; // the longest single backoff
  maxRetryAfterMs?: number; // the longest single wait a Retry-After header can ask for
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export const DEFAULT_MAX_RETRY_SECONDS = 120;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A JSON-RPC error that means "slow down": Solana's and providers' codes, or their wording.
export function isRateLimitError(code: unknown, message: unknown): boolean {
  if (code === -32005 || code === -32429 || code === 429) return true;
  return /too many requests|rate[- ]?limit|request limit|limit exceeded|exceeded .*limit/i.test(String(message ?? ""));
}

// Retry-After in seconds or as an HTTP date, in milliseconds from now; null if absent or unreadable.
export function retryAfterMs(header: string | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const v = header.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

// Methods that may be sent again although an earlier attempt may have reached the node (a 502 or 504 can come
// back after the node took the request): reads, and sendTransaction, because a signed transaction is the same
// transaction however often it is sent (the cluster lands it once, by its signature). requestAirdrop isn't: a
// second one is a second airdrop. A 429 or 503 means the request wasn't taken, so any method retries on those.
const NOT_REPEATABLE = new Set(["requestAirdrop"]);

export class HttpSolanaRpc implements SolanaRpc {
  private id = 0;
  private readonly retry: Required<RetryOptions>;
  constructor(
    private readonly url: string,
    private readonly opts: VendorCallOptions = {},
    retry: RetryOptions = {},
  ) {
    this.retry = {
      maxRetryMs: DEFAULT_MAX_RETRY_SECONDS * 1000,
      baseDelayMs: 500,
      maxDelayMs: 20_000,
      maxRetryAfterMs: 60_000,
      sleep: sleepMs,
      now: Date.now,
      random: Math.random,
      ...Object.fromEntries(Object.entries(retry).filter(([, v]) => v !== undefined)),
    };
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const { maxRetryMs, baseDelayMs, maxDelayMs, maxRetryAfterMs, sleep, now, random } = this.retry;
    const deadline = now() + maxRetryMs;
    for (let attempt = 0; ; attempt++) {
      const r = await safePost(this.url, JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }), { "User-Agent": "Mynt-Solana/1" }, {
        timeoutMs: 30_000,
        maxResponseBytes: 8 * 1024 * 1024,
        ...this.opts,
      });
      const status = r.http_status ?? 0;
      const body = r.body as { result?: T; error?: { code?: number; message?: string; data?: unknown } } | null;
      // Slow down and try again: a rate limit (HTTP or JSON-RPC), an unavailable node, or a gateway error for a
      // method that is safe to repeat.
      const limited = status === 429 || (!!body?.error && isRateLimitError(body.error.code, body.error.message));
      // The devnet faucet's limit lasts hours, not seconds: an airdrop it refuses fails at once, so the caller
      // can fund another way instead of waiting out the retries.
      if (limited && method === "requestAirdrop") throw new RpcError(`Solana RPC requestAirdrop: the faucet's limit was reached`, body?.error?.code);
      const retryable = limited || status === 503 || ((status === 502 || status === 504) && !NOT_REPEATABLE.has(method));
      if (retryable) {
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        const asked = retryAfterMs(r.retry_after, now());
        // Equal jitter, so callers rate-limited together don't come back together; a Retry-After is honoured
        // (up to maxRetryAfterMs) with a little jitter on top.
        const wait = asked !== null ? Math.min(asked, maxRetryAfterMs) + random() * Math.min(1000, baseDelayMs) : backoff / 2 + (random() * backoff) / 2;
        if (now() + wait <= deadline) {
          await sleep(wait);
          continue;
        }
        const what = limited ? "rate-limited" : `unavailable (http ${status})`;
        throw new RpcError(
          `Solana RPC ${method} failed (${status ? `http ${status}` : "rate limit"}): the RPC was still ${what} after ${attempt + 1} attempts over ${Math.round(maxRetryMs / 1000)} s. A provider's RPC URL raises the limit; see SOLANA_RPC_URL_DEVNET and SOLANA_RPC_MAX_RETRY_SECONDS`,
          body?.error?.code,
        );
      }
      // The provider's own error text, and an outbound refusal, may name the host or echo the URL (and its key):
      // report only what kind of failure it was.
      if (!r.ok) {
        const why = r.error?.startsWith("refused") ? "refused by Mynt's outbound rules" : status >= 400 ? `http ${status}` : (r.error ?? `http ${status}`);
        throw new RpcError(`Solana RPC ${method} failed (${why})`);
      }
      if (body?.error) throw new RpcError(`Solana RPC ${method}: ${String(body.error.message ?? "error").slice(0, 300)}`, body.error.code, body.error.data);
      return body?.result as T;
    }
  }
}

// Paces requests to at most `rps` a second, spaced evenly, for everyone sharing it (all of a cluster's deploys).
export class RateLimiter {
  private next = 0;
  constructor(
    readonly rps: number,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = { now: Date.now, sleep: sleepMs },
  ) {}

  async take() {
    if (!(this.rps > 0) || !Number.isFinite(this.rps)) return;
    const t = this.clock.now();
    const at = Math.max(t, this.next);
    this.next = at + 1000 / this.rps;
    if (at > t) await this.clock.sleep(at - t);
  }
}

// Each cluster's genesis hash: what a node of that cluster answers to getGenesisHash.
export const GENESIS_HASH: Record<Cluster, string> = {
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
};

// An RPC that proves once, before its first call, that it serves the cluster it's configured for, so a devnet
// URL pointing at mainnet (or the reverse) is refused before anything is signed or sent.
export class GenesisCheckedRpc implements SolanaRpc {
  private checked: Promise<void> | null = null;
  constructor(
    readonly cluster: Cluster,
    private readonly inner: SolanaRpc,
  ) {}

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    this.checked ??= this.inner.call<string>("getGenesisHash").then((hash) => {
      if (hash !== GENESIS_HASH[this.cluster]) throw new RpcError(`The ${this.cluster} RPC serves another network (genesis ${String(hash).slice(0, 44)})`);
    });
    try {
      await this.checked;
    } catch (e) {
      this.checked = null; // ask again next time: the RPC may have been a transient failure
      throw e;
    }
    return this.inner.call<T>(method, params);
  }
}

// Which RPC each cluster uses: SOLANA_RPC_URL_DEVNET (default the public devnet endpoint) and
// SOLANA_RPC_URL_MAINNET (no default).
export function rpcUrlsFromEnv(env = process.env): Record<Cluster, string | null> {
  return { devnet: env.SOLANA_RPC_URL_DEVNET || PUBLIC_DEVNET_RPC, mainnet: env.SOLANA_RPC_URL_MAINNET || null };
}

// The public devnet endpoint allows 40 requests per 10 s for any one method from an address (100 per 10 s in
// all), so a deploy's writes go out at 4 a second there; a provider's RPC takes more. SOLANA_RPC_MAX_RPS sets
// both clusters' pace instead.
export const PUBLIC_DEVNET_MAX_RPS = 4;
export const PROVIDER_MAX_RPS = 25;

export function rpcPaceFromEnv(env = process.env): Record<Cluster, number> {
  const set = Number(env.SOLANA_RPC_MAX_RPS);
  if (env.SOLANA_RPC_MAX_RPS && set > 0) return { devnet: set, mainnet: set };
  const devnet = env.SOLANA_RPC_URL_DEVNET && env.SOLANA_RPC_URL_DEVNET !== PUBLIC_DEVNET_RPC ? PROVIDER_MAX_RPS : PUBLIC_DEVNET_MAX_RPS;
  return { devnet, mainnet: PROVIDER_MAX_RPS };
}

export function rpcMaxRetryMsFromEnv(env = process.env): number {
  const s = Number(env.SOLANA_RPC_MAX_RETRY_SECONDS);
  return env.SOLANA_RPC_MAX_RETRY_SECONDS && s >= 0 ? s * 1000 : DEFAULT_MAX_RETRY_SECONDS * 1000;
}
