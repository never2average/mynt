// Every page of the studio needs a signed-in Mynt user. A visit without one goes straight to
// sign-in (no landing page in between), and comes back to the page it asked for.

// Pages anyone may see: where a failed sign-in and a sign-out land (they must not send anyone
// back to sign-in, or a failure would loop and signing out would sign straight back in).
export const OPEN_PAGES = new Set(["/signin-error", "/signed-out"]);

// Whether a path is a page that needs sign-in. API routes answer 401 themselves; Next's assets
// are never gated.
export function pageNeedsSignIn(pathname: string): boolean {
  if (pathname.startsWith("/api/") || pathname === "/api") return false;
  if (pathname.startsWith("/_next/") || pathname === "/favicon.ico") return false;
  return !OPEN_PAGES.has(pathname);
}

// The sign-in address for a visit to `pathname` + `search` (the login route checks `next` again).
export function signInPathFor(pathname: string, search: string): { pathname: string; search: string } {
  const next = `${pathname}${search}`;
  return { pathname: "/api/auth/login", search: next === "/" ? "" : `?next=${encodeURIComponent(next)}` };
}
