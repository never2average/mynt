import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Mynt's own check on evidence an agent cites: fetch the source and confirm the quote is really in it.
// Nothing is taken on the agent's word; a quote that can't be found doesn't count. The normalisation and
// text extraction match workspaces/governance-review/scripts, so what passes there passes here.

export type Verification = { verified: true } | { verified: false; reason: string };
export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; contentType: string; text: string }>;

const MAX_BYTES = 2 * 1024 * 1024;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return privateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// Public https pages only (no private or internal addresses), a few redirects, 2 MB and 15 seconds.
export const fetchPublic: Fetcher = async (start) => {
  let url = new URL(start);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "https:") throw new Error("only https sources");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
    if (addresses.length === 0 || addresses.some(privateAddress)) throw new Error("not a public host");
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "mynt-evidence-check", Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" } });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    return { ok: res.ok, status: res.status, contentType: res.headers.get("content-type") ?? "", text: Buffer.concat(chunks).toString("utf8") };
  }
  throw new Error("too many redirects");
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—" };

export function pageText(contentType: string, body: string) {
  if (/json/i.test(contentType)) {
    try {
      return JSON.stringify(JSON.parse(body), null, 1);
    } catch {
      return body;
    }
  }
  if (!/html|xml/i.test(contentType) && !/<html|<body|<div|<p[\s>]/i.test(body.slice(0, 2000))) return body;
  return body
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|td|th|h[1-6])>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Case, whitespace, curly quotes and dashes don't matter; words and their order do.
export const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[‘’‚′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Checks quotes against their sources, fetching each source once. `mynt://case` quotes are checked
// against the case Mynt handed the agent.
export function evidenceChecker(opts: { fetcher?: Fetcher; caseText?: string } = {}) {
  const fetcher = opts.fetcher ?? fetchPublic;
  const caseText = normalize(opts.caseText ?? "");
  const pages = new Map<string, Promise<{ text: string } | { error: string }>>();
  const load = (url: string) => {
    if (!pages.has(url)) {
      pages.set(
        url,
        fetcher(url).then(
          (r) => {
            if (!r.ok) return { error: `the source answered ${r.status}` };
            if (/pdf/i.test(r.contentType)) return { error: "PDF sources can't be verified yet" };
            return { text: normalize(pageText(r.contentType, r.text)) };
          },
          (e: Error) => ({ error: `couldn't fetch the source (${e.message})` }),
        ),
      );
    }
    return pages.get(url)!;
  };
  return async (e: { source_url: string; quote: string }): Promise<Verification> => {
    const quote = normalize(e.quote ?? "");
    if (quote.length < 12) return { verified: false, reason: "the quote is too short to verify" };
    if (e.source_url === "mynt://case") return caseText.includes(quote) ? { verified: true } : { verified: false, reason: "the quote isn't in the case" };
    let url: URL;
    try {
      url = new URL(e.source_url);
    } catch {
      return { verified: false, reason: "not a valid URL" };
    }
    if (url.protocol !== "https:") return { verified: false, reason: "only https sources" };
    const page = await load(url.toString());
    if ("error" in page) return { verified: false, reason: page.error };
    return page.text.includes(quote) ? { verified: true } : { verified: false, reason: "the quote isn't on that page" };
  };
}
