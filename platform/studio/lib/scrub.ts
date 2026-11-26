// Keeps secrets out of what Ask AI shows of a read (its arguments and Mynt's reply, components/kbar/ask-ai.tsx) and of
// what it hands the model. Mynt's reads don't return secrets; this is the second lock: a value under a key that names
// a secret, or text that looks like one (a key, a bearer token, a signed token, a private key, a link's query string,
// which can carry a capability), is replaced before it leaves the server.
export const HIDDEN = "[hidden]";

const SECRET_KEY = /(secret|token|password|passwd|passphrase|api[_-]?key|apikey|authorization|credential|private[_-]?key|cookie|signing[_-]?link|preview[_-]?url)/i;

const SECRET_TEXT: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bmynt_(?:live|test)_[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
];
// A link keeps its address and loses its query string.
const LINK_QUERY = /(\bhttps?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/g;

/** Text with anything that looks like a secret replaced. */
export function scrubText(text: string): string {
  let out = text;
  for (const re of SECRET_TEXT) out = out.replace(re, HIDDEN);
  return out.replace(LINK_QUERY, `$1?${HIDDEN}`);
}

/** A copy of a value with secrets replaced: text under a key that names a secret, and text that looks like one. */
export function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 12) return HIDDEN;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Whether a secret is set (a boolean), or how many there are, is not the secret.
    out[k] = SECRET_KEY.test(k) && typeof v === "string" && v !== "" ? HIDDEN : SECRET_KEY.test(k) && v && typeof v === "object" ? HIDDEN : scrub(v, depth + 1);
  }
  return out;
}
