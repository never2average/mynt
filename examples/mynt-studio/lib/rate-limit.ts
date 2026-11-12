import type { SessionStore } from "./session-store";

// Starting sign-in creates a session before anyone is signed in, so anyone could fill the
// store by calling /api/auth/login in a loop. Each address may start sign-in this many times
// per window (counted in the store, so across function instances).
export const LOGIN_LIMIT = 20;
export const LOGIN_WINDOW_SECONDS = 10 * 60;

// The caller's address as the platform's proxy reports it (Vercel sets x-forwarded-for, the
// client's address first). Unknown callers share one bucket.
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

export async function loginAllowed(store: SessionStore, address: string): Promise<boolean> {
  return (await store.count("login", address, LOGIN_WINDOW_SECONDS)) <= LOGIN_LIMIT;
}
