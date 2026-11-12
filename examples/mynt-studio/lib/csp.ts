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

export function contentSecurityPolicy(previewFrameSrc: string | undefined, dev = false): string {
  const frames = frameSources(previewFrameSrc, dev);
  return [
    "default-src 'self'",
    // Next's inline bootstrap scripts; eval only for the dev server's hot reload.
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
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
