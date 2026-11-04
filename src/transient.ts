// Telling a provider's passing hiccup (a 5xx, a rate limit, a dropped connection) from a real failure, so the
// agent workers can retry the first on later ticks instead of throwing away work that has already cost money.

// A provider that has used up the account's allowance (compute, credits): retrying won't help until someone
// adds billing, so it isn't transient, and ops_status calls it out.
export const QUOTA_PATTERN = /LIMIT_EXCEEDED|allowance for [\w_, ]+ has been used|insufficient (credits|balance)|quota exceeded/i;
export const isQuotaExhausted = (e: unknown) => QUOTA_PATTERN.test(String((e as Error)?.message ?? e));
export const QUOTA_MESSAGE = "The sandbox provider has used up this account's allowance; an admin must add billing in its dashboard.";

// Errors worth retrying: rate limits, server errors and network failures, as the providers' clients report them.
export function isTransient(e: unknown): boolean {
  if (isQuotaExhausted(e)) return false;
  const m = String((e as Error)?.message ?? e);
  // "boat: 503 ..." from the sandbox clients, "GitHub couldn't resolve x (502)" from the GitHub App.
  return /: (429|5\d\d)\b|\((429|5\d\d)\)|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|UND_ERR_/i.test(m);
}

// The message to record when an error does fail the work: quota exhaustion says what an admin must do.
export const failureMessage = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return isQuotaExhausted(e) ? `${QUOTA_MESSAGE} (${m})` : m;
};

// How long a transient error may persist before it fails the work (env MYNT_TRANSIENT_GRACE_MS, default 10 min).
export const defaultGraceMs = () => Number(process.env.MYNT_TRANSIENT_GRACE_MS || 600000);

// Remembers, per piece of work, when its current run of transient errors began.
export class GraceTracker {
  private since = new Map<string, number>();
  constructor(private graceMs: () => number = defaultGraceMs) {}

  // True when the error should be ridden out (retry on a later tick); false when it should fail the work now.
  rideOut(key: string, e: unknown): boolean {
    if (!isTransient(e)) {
      this.since.delete(key);
      return false;
    }
    const since = this.since.get(key) ?? Date.now();
    this.since.set(key, since);
    if (Date.now() - since < this.graceMs()) return true;
    this.since.delete(key);
    return false;
  }

  // The work made progress: forget any earlier errors.
  clear(key: string) {
    this.since.delete(key);
  }
}
