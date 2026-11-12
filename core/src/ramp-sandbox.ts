import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import { open } from "./vault.js";
import { signBody } from "./vendor-call.js";
import { vendorCallback } from "./vendors.js";

// The Mynt Ramp's sandbox: a test endpoint Mynt serves itself, so developers can build and test on- and off-ramp
// before the ramp partner's live endpoint exists. The ramp firm points its offerings' test_base_url at
// <PUBLIC_URL>/ramp-sandbox; the live_base_url is the partner's. It speaks exactly the vendor wire contract
// (docs/reference.md): signed requests only (a subscription's secret, or an offering's conformance secret), test
// environment only, and it never moves money.
//
// Prices: in US dollars only (the device never sees the USDC leg, which the sandbox settles 1:1), and a fee of 0.5%
// (at least $0.50). Transfers answer pending and settle by Mynt's
// own signed callback after RAMP_SANDBOX_SETTLE_MS (default 3000). Amounts ending in .13 come back returned (a
// bank transfer that bounced) and .66 failed, so apps can test both.

export const RAMP_SANDBOX_PATH = "/ramp-sandbox";
export const RAMP_SANDBOX_KEYS = ["onramp_quote", "onramp_transfer", "offramp_quote", "offramp_transfer"] as const;
const QUOTE_SECONDS = 60;
const T = "financial_products";

type Signer = { secret: string; subscription_id: string | null }; // null: a conformance run
async function signers(store: Store, key: string): Promise<Signer[]> {
  const { rows } = await store.db.query(
    `SELECT o.conformance_secret, s.id AS subscription_id, s.signing_secret
     FROM ${T}.vendor_offerings o LEFT JOIN ${T}.vendor_subscriptions s ON s.offering_id = o.id AND s.status = 'active'
     WHERE o.service_type = $1 AND rtrim(o.test_base_url, '/') LIKE $2`,
    [key, `%${RAMP_SANDBOX_PATH}`],
  );
  const out: Signer[] = [];
  const seen = new Set<string>();
  for (const r of rows as { conformance_secret: string | null; subscription_id: string | null; signing_secret: string | null }[]) {
    if (r.conformance_secret && !seen.has(r.conformance_secret)) {
      seen.add(r.conformance_secret);
      out.push({ secret: open(r.conformance_secret, false), subscription_id: null });
    }
    if (r.subscription_id && r.signing_secret) out.push({ secret: open(r.signing_secret, false), subscription_id: r.subscription_id });
  }
  return out;
}

function verified(header: string | undefined, raw: string, candidates: Signer[]): Signer | null {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return null;
  const got = Buffer.from(m[2], "hex");
  return candidates.find((c) => timingSafeEqual(createHmac("sha256", c.secret).update(`${m[1]}.${raw}`).digest(), got)) ?? null;
}

const settleMs = () => Number(process.env.RAMP_SANDBOX_SETTLE_MS ?? 3000);
const cents = (amount: string) => Math.round(Number(amount) * 100);
const dollars = (c: number) => (c / 100).toFixed(2);
const feeCents = (fiat: number) => Math.max(50, Math.round(fiat * 0.005));

// The quote id carries what the transfer needs, so the sandbox keeps no state and survives restarts.
const quoteId = (key: string, fiat: string) => `sbq.${key}.${fiat}.${randomBytes(6).toString("hex")}`;
const fiatOfQuote = (id: string) => /^sbq\.[a-z_]+\.([0-9]+(?:\.[0-9]{1,2})?)\.[0-9a-f]+$/.exec(id)?.[1] ?? null;

export async function rampSandbox(store: Store, req: IncomingMessage, res: ServerResponse, url: URL) {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const key = url.pathname.slice(`${RAMP_SANDBOX_PATH}/v1/`.length);
  if (!url.pathname.startsWith(`${RAMP_SANDBOX_PATH}/v1/`) || !(RAMP_SANDBOX_KEYS as readonly string[]).includes(key)) return reply(404, { status: "error", error: { code: "not_found" } });
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 64 * 1024) return reply(413, { status: "error", error: { code: "too_large" } });
  }
  let body: { request_id?: string; environment?: string; params?: Record<string, unknown>; quote?: { quote_id?: string }; consent?: { artefact_ref?: string } };
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { status: "error", error: { code: "invalid_json" } });
  }
  const signer = verified(req.headers["mynt-signature"] as string | undefined, raw, await signers(store, key));
  if (!signer) return reply(401, { request_id: body.request_id ?? null, status: "error", output: null, error: { code: "bad_signature", message: "Mynt-Signature doesn't verify" } });
  const error = (code: string, message: string) => reply(200, { request_id: body.request_id, status: "error", output: null, error: { code, message } });
  if (body.environment !== "test") return error("sandbox_only", "The Mynt Ramp sandbox answers test requests only");

  if (key.endsWith("_quote")) {
    const p = body.params ?? {};
    const fiat = cents(String(p.amount_usd));
    if (!Number.isFinite(fiat) || fiat < 100) return error("amount_too_small", "The smallest amount is $1.00");
    const fee = feeCents(fiat);
    const on = key === "onramp_quote";
    if (on && fiat <= fee) return error("amount_too_small", "The amount doesn't cover the fee");
    // On-ramp: the customer's bank sends amount_usd and their balance gets it less the fee. Off-ramp: their bank
    // receives amount_usd and their balance gives it plus the fee. The USDC leg is the partner's, 1:1.
    const total = on ? fiat - fee : fiat + fee;
    return reply(200, {
      request_id: body.request_id,
      status: "ok",
      output: {
        quote_id: quoteId(key, dollars(fiat)),
        expires_at: new Date(Date.now() + QUOTE_SECONDS * 1000).toISOString(),
        direction: on ? "in" : "out",
        amount_usd: dollars(fiat),
        fee_usd: dollars(fee),
        total_usd: dollars(total),
        currency: "USD",
        estimated_arrival: new Date(Date.now() + settleMs()).toISOString(),
        settlement_asset: "USDC",
        settlement_network: "solana",
        settlement_amount: dollars(total),
      },
    });
  }

  // A transfer accepts a quote. Conformance sends a placeholder quote and gets an answer, never a callback.
  const qid = body.quote?.quote_id ?? "";
  const conformance = signer.subscription_id === null || body.consent?.artefact_ref === "mynt_conformance";
  if (conformance) return reply(200, { request_id: body.request_id, status: "ok", output: { transfer_status: "submitted", settlement_ref: null } });
  const fiat = fiatOfQuote(qid);
  if (!fiat || !qid.startsWith(`sbq.${key.replace("_transfer", "_quote")}.`)) return error("unknown_quote", "That quote wasn't issued by the sandbox for this service");
  const outcome = fiat.endsWith(".13") ? "returned" : fiat.endsWith(".66") ? "failed" : "settled";
  const requestId = body.request_id!;
  const subscriptionId = signer.subscription_id!;
  const secret = signer.secret;
  // Settle later, through the same signed callback a partner would send.
  setTimeout(() => {
    const cb = JSON.stringify({
      request_id: requestId,
      status: "ok",
      output: { transfer_status: outcome, estimated_arrival: null, settlement_ref: outcome === "settled" ? `sbx_${randomBytes(6).toString("hex")}` : null, settlement_tx: null },
    });
    vendorCallback(store, subscriptionId, cb, signBody(secret, cb)).catch((e) => console.error("ramp sandbox settlement:", (e as Error).message));
  }, settleMs()).unref();
  return reply(200, { request_id: body.request_id, status: "ok", output: { transfer_status: "submitted", settlement_ref: null } });
}
