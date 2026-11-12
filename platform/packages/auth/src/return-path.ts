// Where to send someone after sign-in: the page they asked for, if it's a path on this app.
// Only a relative path is accepted ("/x", never "//host", "/\\host", a scheme or a control
// character), and it must resolve to this app's own origin; anything else means "/".
export function safeReturnPath(raw: string | null | undefined, appUrl: URL): string {
  if (!raw || raw.length > 2000) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, appUrl);
  } catch {
    return "/";
  }
  if (url.origin !== appUrl.origin) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
