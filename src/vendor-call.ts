import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";

// How Mynt calls a vendor's service: one signed POST, never to a private address, never following a
// redirect, with a time limit and a size cap. The caller never logs what goes in or comes back: the
// input is a customer's data.
//
// Production uses the defaults. Tests pass allowInsecureLoopback to reach a vendor they run on 127.0.0.1
// over plain HTTP; nothing in the server's own configuration sets it.

export interface VendorCallOptions {
  allowInsecureLoopback?: boolean; // tests only: http:// to 127.0.0.0/8 or ::1
  timeoutMs?: number; // default 10 s
  maxResponseBytes?: number; // default 256 KiB
}

export class OutboundRefused extends Error {}

const BLOCKED = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, and some clouds' metadata services
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including the 169.254.169.254 metadata service
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 reaches IPv4 space
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7], // unique local, including fd00:ec2::254
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(net, bits, "ipv6");

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

const family = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");
// An IPv4 address written as IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it is.
const unmap = (address: string) => {
  const m = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return m ? m[1] : address;
};
export const isLoopback = (address: string) => LOOPBACK.check(unmap(address), family(unmap(address)));
export const isBlockedAddress = (address: string) => {
  const a = unmap(address);
  if (!isIP(a)) return true;
  if (/^::ffff:/i.test(a)) return true; // a mapped form we couldn't read
  return BLOCKED.check(a, family(a));
};

// The address a vendor URL may be called at, or why it may not.
export async function resolveVendorUrl(raw: string, opts: VendorCallOptions = {}): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRefused("not a valid URL");
  }
  if (url.username || url.password) throw new OutboundRefused("URLs may not carry credentials");
  const insecure = url.protocol === "http:";
  if (url.protocol !== "https:" && !(insecure && opts.allowInsecureLoopback)) throw new OutboundRefused("HTTPS only");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new OutboundRefused(`${host} doesn't resolve`);
    }
  }
  if (!addresses.length) throw new OutboundRefused(`${host} doesn't resolve`);
  for (const a of addresses) {
    const loop = isLoopback(a.address);
    if (loop && opts.allowInsecureLoopback) continue;
    if (isBlockedAddress(a.address)) throw new OutboundRefused(`${host} resolves to a private, loopback, link-local or reserved address`);
    if (insecure) throw new OutboundRefused("HTTPS only");
  }
  return { url, address: addresses[0].address, family: addresses[0].family === 6 ? 6 : 4 };
}

// Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the signing secret>.
export function signBody(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface VendorResult {
  ok: boolean; // reached the vendor and got JSON back under 300
  http_status: number | null;
  body: unknown;
  error: string | null; // a short code-like reason, never the vendor's text
  latency_ms: number;
}

// POST <base>/v1/<service_type_key> with the signed JSON body. The credential, when there is one, goes as
// Authorization: Bearer and nowhere else.
export async function callVendor(
  req: { base_url: string; service_type: string; body: unknown; signing_secret: string; credential?: string | null; signature?: string },
  opts: VendorCallOptions = {},
): Promise<VendorResult> {
  const started = Date.now();
  const done = (r: Omit<VendorResult, "latency_ms">): VendorResult => ({ ...r, latency_ms: Date.now() - started });
  let target: Awaited<ReturnType<typeof resolveVendorUrl>>;
  const endpoint = `${req.base_url.replace(/\/+$/, "")}/v1/${req.service_type}`;
  try {
    target = await resolveVendorUrl(endpoint, opts);
  } catch (e) {
    return done({ ok: false, http_status: null, body: null, error: `refused: ${(e as Error).message}` });
  }
  const payload = JSON.stringify(req.body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(payload)),
    "User-Agent": "Mynt-Vendor-Client/1",
    "Mynt-Signature": req.signature ?? signBody(req.signing_secret, payload),
  };
  if (req.credential) headers.Authorization = `Bearer ${req.credential}`;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxResponseBytes ?? 256 * 1024;
  const { url, address, family: fam } = target;
  const client = url.protocol === "https:" ? https : http;
  return new Promise<VendorResult>((resolve) => {
    let settled = false;
    const finish = (r: Omit<VendorResult, "latency_ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(done(r));
    };
    const r = client.request(
      {
        method: "POST",
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers,
        agent: false,
        ...(isIP(url.hostname.replace(/^\[|\]$/g, "")) ? {} : { servername: url.hostname }),
        // Connect to the address that was checked, so DNS can't be switched under us.
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          o?.all ? cb(null, [{ address, family: fam }]) : cb(null, address, fam)) as never,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return finish({ ok: false, http_status: status, body: null, error: "redirects aren't followed" });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            finish({ ok: false, http_status: status, body: null, error: "response too large" });
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          let body: unknown = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            return finish({ ok: false, http_status: status, body: null, error: "response isn't JSON" });
          }
          finish({ ok: status >= 200 && status < 300, http_status: status, body, error: status >= 200 && status < 300 ? null : `http ${status}` });
        });
        res.on("error", () => finish({ ok: false, http_status: status, body: null, error: "connection error" }));
      },
    );
    const timer = setTimeout(() => {
      finish({ ok: false, http_status: null, body: null, error: "timeout" });
      r.destroy();
    }, timeoutMs);
    r.on("error", () => finish({ ok: false, http_status: null, body: null, error: "connection error" }));
    r.end(payload);
  });
}
