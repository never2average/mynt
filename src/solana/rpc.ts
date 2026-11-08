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

export class HttpSolanaRpc implements SolanaRpc {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly opts: VendorCallOptions = {},
  ) {}

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const r = await safePost(this.url, JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }), { "User-Agent": "Mynt-Solana/1" }, {
      timeoutMs: 30_000,
      maxResponseBytes: 8 * 1024 * 1024,
      ...this.opts,
    });
    // The provider's own error text may echo the URL (and its key): report only what kind of failure it was.
    if (!r.ok) throw new RpcError(`Solana RPC ${method} failed (${r.error ?? `http ${r.http_status}`})`);
    const body = r.body as { result?: T; error?: { code?: number; message?: string; data?: unknown } };
    if (body?.error) throw new RpcError(`Solana RPC ${method}: ${String(body.error.message ?? "error").slice(0, 300)}`, body.error.code, body.error.data);
    return body.result as T;
  }
}

// Which RPC each cluster uses: SOLANA_RPC_URL_DEVNET (default the public devnet endpoint) and
// SOLANA_RPC_URL_MAINNET (no default).
export function rpcUrlsFromEnv(env = process.env): Record<Cluster, string | null> {
  return { devnet: env.SOLANA_RPC_URL_DEVNET || PUBLIC_DEVNET_RPC, mainnet: env.SOLANA_RPC_URL_MAINNET || null };
}
