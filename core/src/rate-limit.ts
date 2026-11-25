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
