import type { SessionStore } from "./session-store";

// Starting sign-in creates a session before anyone is signed in, so anyone could fill the
// store by calling /api/auth/login in a loop. Each address may start sign-in this many times
// per window (counted in the store, so across function instances).
export const LOGIN_LIMIT = 20;
export const LOGIN_WINDOW_SECONDS = 10 * 60;
// Callers whose address isn't known share one bucket, with room for this many.
export const SHARED_LOGIN_LIMIT = 200;

type Env = Record<string, string | undefined>;

// The caller's address, from a header only a trusted proxy can set: on Vercel its own
// x-vercel-forwarded-for (callers can't forge it; x-forwarded-for they can), elsewhere only the
// header named in TRUSTED_PROXY_HEADER. Without either, null: the caller isn't known.
export function clientAddress(headers: Headers, env: Env = process.env): string | null {
  const name = env.VERCEL ? "x-vercel-forwarded-for" : env.TRUSTED_PROXY_HEADER?.trim().toLowerCase();
  if (!name) return null;
  const value = headers.get(name)?.split(",")[0]?.trim();
  return value ? addressBucket(value) : null;
}

// One bucket per IPv4 address, and per /64 for IPv6 (one home or host usually has a whole /64,
// so counting single IPv6 addresses would let it rotate past the limit).
export function addressBucket(address: string): string {
  const a = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
  if (!a.includes(":")) return a;
  const v4 = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return v4[1];
  const [head, tail = ""] = a.split("::");
  const left = head ? head.split(":") : [];
  const right = a.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = a.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g || "0", 16) || 0).toString(16))
    .join(":")}::/64`;
}

export async function loginAllowed(store: SessionStore, address: string | null): Promise<boolean> {
  if (address === null) return (await store.count("login", "(unknown)", LOGIN_WINDOW_SECONDS)) <= SHARED_LOGIN_LIMIT;
  return (await store.count("login", address, LOGIN_WINDOW_SECONDS)) <= LOGIN_LIMIT;
}
