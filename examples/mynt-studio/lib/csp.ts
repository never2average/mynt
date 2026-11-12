// The studio's Content-Security-Policy. Pure, so next.config.ts and the tests share it.
//
// Previews are framed straight from their own origins (never proxied through the studio), so
// frame-src lists exactly those origins, from PREVIEW_FRAME_SRC. Nobody may frame the studio.

// One CSP source a preview may come from: an https origin, optionally with a leading wildcard
// label (https://*.preview.example). No paths, quotes, semicolons or keywords.
const FRAME_SOURCE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;
const LOCAL_SOURCE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

export function frameSources(raw: string | undefined, dev = false): string[] {
  const out: string[] = [];
  for (const s of (raw ?? "").split(/[\s,]+/).filter(Boolean)) {
    if (FRAME_SOURCE.test(s) || (dev && LOCAL_SOURCE.test(s))) out.push(s);
    else throw new Error(`PREVIEW_FRAME_SRC: "${s}" isn't an https origin (like https://*.preview.example)`);
  }
  return out;
}

const NONCE = /^[A-Za-z0-9+/]{16,}={0,2}$/;

// With a nonce (one per request, from proxy.ts), only scripts carrying it run, and what they
// load ('strict-dynamic'); Next puts it on its own scripts. Eval only for the dev server.
export function contentSecurityPolicy(previewFrameSrc: string | undefined, dev = false, nonce?: string): string {
  const frames = frameSources(previewFrameSrc, dev);
  if (nonce !== undefined && !NONCE.test(nonce)) throw new Error("CSP nonce must be base64");
  const scripts = nonce ? `'self' 'nonce-${nonce}' 'strict-dynamic'` : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scripts}${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? " ws: wss:" : ""}`,
    `frame-src ${frames.length ? frames.join(" ") : "'none'"}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
