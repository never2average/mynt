// Keeps secrets out of what Ask AI shows of a read (its arguments and Mynt's reply, components/kbar/ask-ai.tsx) and of
// what it hands the model. Mynt's reads don't return secrets; this is the second lock: a value under a key that names
// a secret, or text that looks like one (a key, a bearer token, a signed token, a private key, a link's query string,
// which can carry a capability), is replaced before it leaves the server.
export const HIDDEN = "[hidden]";

const SECRET_KEY = /(secret|token|password|passwd|passphrase|api[_-]?key|apikey|authorization|credential|private[_-]?key|cookie|signing[_-]?link|preview[_-]?url)/i;

// The shapes Mynt's own server scrubs from what its agents print (core/src/boxes.ts), kept in step by hand because the
// studio doesn't import the server: test/scrub.test.ts reads that file and fails when a kind or a prefix there is
// missing here. The kinds of Mynt's own keys and tokens (mynt_<kind>_...):
export const MYNT_TOKEN_KINDS = ["live", "test", "agent", "bd", "explore", "desk", "review", "paudit", "predteam"] as const;
// ...and the prefixes that are followed directly by the secret: webhook secrets, Mynt's vendor and partner-ledger
// signing secrets and local user tokens, and other services' keys.
export const SECRET_PREFIXES = ["whsec_", "mvs_", "mpl_", "fpm_", "github_pat_", "sk-ant-", "sk-", "xapp-", "npm_"] as const;

const SECRET_TEXT: RegExp[] = [
  // A private key up to its END line, or to the end of the text when it was cut off. A bare BEGIN marker with no key
  // after it (someone describing one) stays.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----\r?\n(?:\r?\n)?(?=[A-Za-z0-9+/=])(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g,
  new RegExp(String.raw`\bmynt_(?:${MYNT_TOKEN_KINDS.join("|")})_[A-Za-z0-9_-]{8,}`, "g"),
  /\bmcs_(?:live|test)_[A-Za-z0-9_-]{8,}/g, // client sessions
  new RegExp(String.raw`\b(?:${SECRET_PREFIXES.filter((p) => p !== "sk-" && p !== "npm_").join("|")})[A-Za-z0-9_-]{8,}`, "g"),
  /\bnpm_[A-Za-z0-9]{36}\b/g, // exactly a registry token, so npm_config_... names stay
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{8,}/g, // the sign-in provider's and payment services' secret keys
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abpre]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{4,}/g,
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

// An unfinished last word that can be shown as it is: plain words and citations with their punctuation ("savings.",
// "[2]."), which no secret's shape can grow out of...
const PLAIN_WORD = /^(?:[A-Za-z'’]+|\[\d{1,3}\])*[.,;:!?)"'’\]]*$/;
// ...unless it may be the opening letters of one (a key's prefix arrives before its underscore does).
const OPENINGS = [...SECRET_PREFIXES, "mynt", "mcs", "rk", "gh", "xox", "eyj", "aiza", "akia", "asia", "bearer"].map((p) => p.replace(/[^a-z]/gi, "").toLowerCase());
const mayOpenSecret = (word: string) => {
  const letters = word.replace(/[^A-Za-z]/g, "").toLowerCase();
  return letters !== "" && OPENINGS.some((p) => p.startsWith(letters) || letters.startsWith(p));
};

// How much of a text being written may be shown yet. A secret's shape is only known once it's whole, and a key has no
// white space in it, so the unfinished last word waits for the white space after it unless it's a plain word. The
// opening of something that spans white space waits until it's closed: "Bearer" for its token, a private key for its
// END line.
function settled(raw: string): number {
  let space = raw.length;
  while (space > 0 && !/\s/.test(raw[space - 1])) space--;
  const last = raw.slice(space);
  let end = PLAIN_WORD.test(last) && !mayOpenSecret(last) ? raw.length : space;
  const bearer = /\bBearer\s*$/i.exec(raw.slice(0, space));
  if (bearer) end = Math.min(end, bearer.index);
  const begin = raw.lastIndexOf("-----BEGIN ");
  if (begin >= 0 && begin < end && !/-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/.test(raw.slice(begin))) end = begin;
  return end;
}

/**
 * Scrubs text that arrives a piece at a time (the model's answer and its reasoning as they're written), so a secret
 * split across pieces is still caught: a piece is passed on once the text up to it is settled, scrubbed as a whole.
 * `flush` passes on what's left when the text ends; `reset` forgets a text that was dropped.
 */
export function scrubStream(emit: (text: string) => void) {
  let raw = "";
  let sent = 0; // how much of the scrubbed text has been passed on
  const pass = (upTo: number) => {
    const clean = scrubText(raw.slice(0, upTo));
    if (clean.length > sent) emit(clean.slice(sent));
    sent = Math.max(sent, clean.length);
  };
  return {
    push(piece: string) {
      raw += piece;
      pass(settled(raw));
    },
    flush() {
      pass(raw.length);
      raw = "";
      sent = 0;
    },
    reset() {
      raw = "";
      sent = 0;
    },
  };
}
