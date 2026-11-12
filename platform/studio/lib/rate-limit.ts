import { appUrl } from "./config";
import type { SessionStore } from "./session-store";

// Starting sign-in creates a session before anyone is signed in, so anyone could fill the
// store by calling /api/auth/login in a loop. Each address may start sign-in this many times
// per window (counted in the store, so across function instances).
export const LOGIN_LIMIT = 20;
export const LOGIN_WINDOW_SECONDS = 10 * 60;
// Callers whose address isn't known share one bucket, with room for this many.
export const SHARED_LOGIN_LIMIT = 200;

type Env = Record<string, string | undefined>;

// The address that connected to the studio, from a header only a trusted proxy can set: on
// Vercel its own x-vercel-forwarded-for (callers can't forge it; x-forwarded-for they can),
// elsewhere only the header named in TRUSTED_PROXY_HEADER. Without either, null.
//
// TRUSTED_PROXY_HEADER's last value is used: a proxy that appends (as with x-forwarded-for)
// adds the address it saw at the end, after anything the caller sent.
export function connectingAddress(headers: Headers, env: Env = process.env): string | null {
  const values = (name: string) => (headers.get(name) ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const value = env.VERCEL ? values("x-vercel-forwarded-for")[0] : env.TRUSTED_PROXY_HEADER?.trim() ? values(env.TRUSTED_PROXY_HEADER.trim().toLowerCase()).at(-1) : undefined;
  return value ? withoutPort(value).toLowerCase() : null;
}

// The edges allowed to pass on a caller's address: Mynt's own server, when it serves the studio
// on its domain (its host installer's --studio-upstream). TRUSTED_EDGE_IPS lists their addresses.
export function trustedEdges(env: Env = process.env): Set<string> {
  return new Set((env.TRUSTED_EDGE_IPS ?? "").split(/[\s,]+/).filter(Boolean).map((a) => withoutPort(a).toLowerCase()));
}

// Whether this request came through a trusted edge (Mynt's server proxying its domain).
export function viaTrustedEdge(headers: Headers, env: Env = process.env): boolean {
  const from = connectingAddress(headers, env);
  return from !== null && trustedEdges(env).has(from);
}

// The caller's address, for the rate limit: what a trusted edge says in X-Mynt-Client-IP (it
// removes any the caller sent and sets the address it saw), else the connecting address. From
// anywhere else X-Mynt-Client-IP is ignored, so callers can't choose their bucket.
export function clientAddress(headers: Headers, env: Env = process.env): string | null {
  if (viaTrustedEdge(headers, env)) {
    const passed = (headers.get("x-mynt-client-ip") ?? "").trim();
    if (passed && !passed.includes(",")) return addressBucket(passed);
  }
  const from = connectingAddress(headers, env);
  return from ? addressBucket(from) : null;
}

// An address without its port: an IPv4 address with ":443" after it, or a bracketed IPv6 one.
export function withoutPort(address: string): string {
  const bracketed = address.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const v4 = address.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  return v4 ? v4[1] : address;
}

// One bucket per IPv4 address, and per /64 for IPv6 (one home or host usually has a whole /64,
// so counting single IPv6 addresses would let it rotate past the limit).
export function addressBucket(address: string): string {
  const a = withoutPort(address.trim()).replace(/%.*$/, "").toLowerCase();
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

// A request carrying X-Mynt-Client-IP from an address not in TRUSTED_EDGE_IPS: usually one of
// Mynt's server's outbound addresses (often its IPv6 one) missing from the list, which puts
// every caller through it in one rate-limit bucket. Said once per instance, with the address to
// add.
let warnedUntrustedEdge = false;
export function warnUntrustedEdgeOnce(headers: Headers, env: Env = process.env, log: (msg: string) => void = console.warn): boolean {
  if (warnedUntrustedEdge || trustedEdges(env).size === 0 || !headers.has("x-mynt-client-ip") || viaTrustedEdge(headers, env)) return false;
  warnedUntrustedEdge = true;
  log(
    `X-Mynt-Client-IP came from ${connectingAddress(headers, env) ?? "an unknown address"}, which isn't in TRUSTED_EDGE_IPS, so the header is ignored. If that's Mynt's server, every caller coming through it now shares one sign-in rate-limit bucket (429 for all after 20 sign-in starts in 10 minutes): add this address to TRUSTED_EDGE_IPS and redeploy.`,
  );
  return true;
}

// For tests.
export function resetUntrustedEdgeWarning(): void {
  warnedUntrustedEdge = false;
}

// The host a request was made to: on Vercel the x-forwarded-host its edge sets, else Host.
// (Next's req.nextUrl.host isn't the request's Host under next start.)
export function requestHost(headers: Headers, env: Env = process.env): string {
  const forwarded = env.VERCEL ? headers.get("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
  return (forwarded || headers.get("host") || "").toLowerCase();
}

// Whether a request should go to APP_URL instead: once the studio is served on Mynt's domain
// (TRUSTED_EDGE_IPS set, on Vercel), people reach it only through Mynt's server. A request from
// any other address without X-Mynt-Client-IP (a browser on the deployment address, for any
// path) is sent to APP_URL.
//
// Not redirected:
// - requests from a trusted edge;
// - requests carrying X-Mynt-Client-IP from an untrusted address. That's what a server address
//   missing from TRUSTED_EDGE_IPS looks like, and redirecting it would loop every user coming
//   through it. They're served instead, with a warning (warnUntrustedEdgeOnce), and their callers
//   share one rate-limit bucket. A forger gains nothing: sign-in, its callback and the session
//   cookie only work on APP_URL, and the rate limit counts untrusted callers by their own address;
// - requests already on APP_URL's host (APP_URL pointing at the deployment itself would loop).
export function shouldGoToAppUrl(headers: Headers, env: Env = process.env, appHost = appUrl().host): boolean {
  if (!env.VERCEL || trustedEdges(env).size === 0) return false;
  if (viaTrustedEdge(headers, env)) return false;
  if (headers.has("x-mynt-client-ip")) return false;
  return requestHost(headers, env) !== appHost.toLowerCase();
}

// Where a direct visit goes: the same path and query on APP_URL (set field by field, never by
// resolving the request's path against it).
export function appUrlFor(pathname: string, search: string, base: URL = appUrl()): URL {
  const target = new URL(base);
  target.pathname = pathname;
  target.search = search;
  return target;
}

export async function loginAllowed(store: SessionStore, address: string | null): Promise<boolean> {
  if (address === null) return (await store.count("login", "(unknown)", LOGIN_WINDOW_SECONDS)) <= SHARED_LOGIN_LIMIT;
  return (await store.count("login", address, LOGIN_WINDOW_SECONDS)) <= LOGIN_LIMIT;
}
