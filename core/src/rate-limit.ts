import type { IncomingMessage } from "node:http";

// The address a request came from, for limits kept per caller. Behind a proxy every request arrives from the proxy's
// own address, so the operator names the header their proxy sets in TRUSTED_PROXY_HEADER (the same setting Mynt Studio
// reads): its last value is used, because a proxy that appends (as with x-forwarded-for) adds the address it saw at
// the end, after anything the caller sent. Without the setting, a header is never believed: the socket's address.
export function callerAddress(req: Pick<IncomingMessage, "headers" | "socket">, env: NodeJS.ProcessEnv = process.env): string {
  const name = env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  const raw = name ? req.headers[name] : undefined;
  const last = (Array.isArray(raw) ? raw.join(",") : (raw ?? ""))
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .at(-1);
  return (last && last.length <= 64 ? last : (req.socket.remoteAddress ?? "unknown")).toLowerCase();
}

// Token bucket per key: `capacity` requests at once, refilled at `perMinute`.
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private capacity: number,
    private perMinute: number,
  ) {}

  // 0 if allowed, else seconds until the next request would be.
  take(key: string, now = Date.now()): number {
    const msPerToken = 60_000 / this.perMinute;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) / msPerToken);
    b.at = now;
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (v.tokens >= this.capacity) this.buckets.delete(k);
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) * msPerToken) / 1000));
  }
}
