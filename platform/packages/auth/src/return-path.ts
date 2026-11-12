// Where to send someone after sign-in: the page they asked for, if it's a plain path on this app;
// anything else means "/".
//
// Refused: anything not starting with a single "/", a scheme or host ("//host", "/\host"),
// control characters (tab, newline, ...), backslashes, dot segments ("." or "..", raw or
// %2e-encoded in any case, which a URL parser collapses: "/.//evil" resolves to "//evil", a
// host), and encoded slashes or backslashes (%2f, %5c). What's left is checked again after
// parsing: same origin, a path that doesn't start with "//", and no backslash.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

export function safeReturnPath(raw: string | null | undefined, appUrl: URL): string {
  if (!raw || raw.length > 2000) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  const path = raw.split(/[?#]/, 1)[0];
  if (/%2f|%5c/i.test(path)) return "/";
  if (path.split("/").some((segment) => DOT_SEGMENT.test(segment))) return "/";
  let url: URL;
  try {
    url = new URL(raw, appUrl);
  } catch {
    return "/";
  }
  if (url.origin !== appUrl.origin) return "/";
  if (url.pathname.startsWith("//") || url.pathname.includes("\\")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

// The absolute address of a checked return path on this app, built field by field on a copy of
// the app's own URL (never by resolving the path against it, so the path can't change the host).
export function appUrlWithPath(appUrl: URL, returnPath: string): URL {
  const safe = safeReturnPath(returnPath, appUrl);
  const target = new URL(appUrl);
  const hashAt = safe.indexOf("#");
  const beforeHash = hashAt === -1 ? safe : safe.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  target.pathname = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  target.search = queryAt === -1 ? "" : beforeHash.slice(queryAt);
  target.hash = hashAt === -1 ? "" : safe.slice(hashAt);
  return target;
}
