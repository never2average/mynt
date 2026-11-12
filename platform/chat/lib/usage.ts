// A cap on chat messages per Mynt user per day (UTC), so an open sign-up can't run up the model
// bill. Kept in memory like the sessions (see session-store.ts): it resets on restart and isn't
// shared between processes, so run a single instance.
export class DailyLimiter {
  private counts = new Map<string, number>();

  constructor(
    private limit: number,
    private now: () => number = Date.now,
  ) {}

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  // Counts one message for the user; false once today's limit is reached (0 means no limit).
  take(userId: string): boolean {
    if (this.limit <= 0) return true;
    const key = `${this.day()}:${userId}`;
    const used = this.counts.get(key) ?? 0;
    if (used >= this.limit) return false;
    this.counts.set(key, used + 1);
    if (this.counts.size > 50_000) this.prune();
    return true;
  }

  remaining(userId: string): number {
    if (this.limit <= 0) return Infinity;
    return Math.max(0, this.limit - (this.counts.get(`${this.day()}:${userId}`) ?? 0));
  }

  get max(): number {
    return this.limit;
  }

  private prune(): void {
    const today = this.day();
    for (const key of this.counts.keys()) if (!key.startsWith(today)) this.counts.delete(key);
  }
}
