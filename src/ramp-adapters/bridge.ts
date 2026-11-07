import { createHash, createPublicKey, verify } from "node:crypto";
import {
  isRampError,
  rampError,
  type RampAdapter,
  type RampDirection,
  type RampError,
  type RampPrice,
  type RampTransferStatus,
  type RampTransferUpdate,
} from "./types.js";

// The reference adapter: Bridge (apidocs.bridge.xyz), dollars settling as USDC on Solana. It uses only documented
// endpoints:
//   POST /v0/transfers              (Api-Key, Idempotency-Key)  a transfer, fiat ↔ USDC on Solana
//   GET  /v0/transfers/{id}                                      its state
//   GET  /v0/customers?limit=1                                   the conformance probe (read-only)
//   webhooks, X-Webhook-Signature: t=<ms>,v0=<base64>            RSA over SHA-256(`${t}.${body}`)
//
// Bridge has no quote that locks a price, so Mynt issues the quote: the fee is the Mynt Ramp's (developer_fee on
// the transfer), the amount out follows from it, and Mynt sets the validity. In: the customer pushes dollars by ACH
// to the deposit account Bridge returns, with its deposit message; Bridge sends the USDC to the ramp's settlement
// address on Solana. Out: USDC from that address, dollars by ACH to the customer's payout account at Bridge.
//
// What Mynt doesn't do here, and refuses clearly instead: onboarding the customer at Bridge (KYC, terms of
// service, and the postal address Bridge's external accounts need). The ramp firm links the customer's Bridge
// customer id and payout account id with link_ramp_partner_customer.

const AMOUNT = /^[0-9]{1,9}(\.[0-9]{1,2})?$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const cents = (s: string) => Math.round(Number(s) * 100);
const dollars = (c: number) => (c / 100).toFixed(2);

// Bridge's transfer states (docs: platform/orchestration/transfers/transfer-states) → Mynt's wire statuses.
// error and missing_return_policy need the partner's attention and stay open; Mynt's sweep ends a run that never
// finishes.
const STATES: Record<string, RampTransferStatus> = {
  awaiting_funds: "submitted",
  in_review: "submitted",
  funds_received: "submitted",
  payment_submitted: "submitted",
  error: "submitted",
  missing_return_policy: "submitted",
  payment_processed: "settled",
  returned: "returned",
  refund_in_flight: "returned",
  refunded: "returned",
  refund_failed: "failed",
  undeliverable: "failed",
  canceled: "failed",
};
export const bridgeStatus = (state: unknown): RampTransferStatus | null => (typeof state === "string" ? (STATES[state] ?? null) : null);

type BridgeTransfer = {
  id?: unknown;
  state?: unknown;
  receipt?: { destination_tx_hash?: unknown; source_tx_hash?: unknown } | null;
  source_deposit_instructions?: Record<string, unknown> | null;
};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function updateOf(t: BridgeTransfer, direction: RampDirection): RampTransferUpdate | RampError {
  const id = str(t.id);
  const status = bridgeStatus(t.state);
  if (!id || !status) return rampError("partner_bad_answer", "The ramp partner's answer wasn't a transfer Mynt understands");
  const d = t.source_deposit_instructions ?? null;
  return {
    partner_transfer_id: id,
    status,
    estimated_arrival: null, // Bridge doesn't document an arrival estimate
    pay_to:
      direction === "in" && d
        ? { bank_name: str(d.bank_name), account_number: str(d.bank_account_number), routing_number: str(d.bank_routing_number), reference: str(d.deposit_message) }
        : null,
    settlement_ref: id,
    settlement_tx: str(direction === "in" ? t.receipt?.destination_tx_hash : t.receipt?.source_tx_hash),
    // Off-ramp: where the USDC leg goes (the stablecoin leg with the product's provider isn't built yet).
    partner_side:
      direction === "out" && d ? { deposit_rail: str(d.payment_rail), deposit_to: str(d.to_address), deposit_amount: str(d.amount), deposit_currency: str(d.currency) } : {},
  };
}

// Bridge's error codes are short identifiers; anything else becomes a generic code. Its messages aren't relayed.
const partnerError = (r: { status: number | null; body: unknown; error: string | null }): RampError => {
  const code = (r.body as { code?: unknown } | null)?.code;
  const safe = typeof code === "string" && /^[a-z0-9_]{1,60}$/.test(code) ? code : null;
  if (r.status === 401) return rampError("partner_credential_refused", "The ramp partner refused Mynt's credential");
  if (safe === "requires_active_kyc_status" || safe === "has_not_accepted_tos") return rampError("partner_customer_not_ready", "The ramp partner hasn't finished verifying this customer");
  if (r.status === null) return rampError("partner_unreachable", "The ramp partner didn't answer");
  return rampError(safe ? `partner_${safe}`.slice(0, 60) : "partner_error", "The ramp partner refused the request");
};

const configNumber = (config: Record<string, string>, key: string, fallback: number) => {
  const v = config[key];
  return v === undefined || v === "" ? fallback : Number(v);
};

export const bridgeAdapter: RampAdapter = {
  id: "bridge",
  name: "Bridge",
  docs: "https://apidocs.bridge.xyz",
  config_fields: {
    settlement_address: { required: true, description: "The ramp's own Solana address that receives (in) and sends (out) the USDC. Partner-side only; never shown to a device" },
    fee_percent: { required: false, description: "The Mynt Ramp's fee, in percent of the amount (default 0.5), charged as Bridge's developer_fee" },
    fee_min_usd: { required: false, description: "The smallest fee in US dollars (default 0.50)" },
    quote_seconds: { required: false, description: "How long a Mynt quote can be accepted, in seconds (default 60, at most 900): Bridge has no quote that locks a price" },
    test_webhook_public_key: { required: false, description: "The PEM public key of the Bridge sandbox webhook endpoint (public, not a secret)" },
    live_webhook_public_key: { required: false, description: "The PEM public key of the Bridge production webhook endpoint (public, not a secret)" },
  },
  configProblems(config) {
    const p: string[] = [];
    for (const k of Object.keys(config)) if (!(k in this.config_fields)) p.push(`config: '${k}' isn't a setting of the Bridge adapter`);
    if (!SOLANA_ADDRESS.test(config.settlement_address ?? "")) p.push("config.settlement_address: a Solana address (base58, 32 to 44 characters) is required");
    const pct = configNumber(config, "fee_percent", 0.5);
    if (!(pct >= 0 && pct <= 5)) p.push("config.fee_percent: a number from 0 to 5");
    const min = configNumber(config, "fee_min_usd", 0.5);
    if (!(min >= 0 && min <= 100)) p.push("config.fee_min_usd: a number from 0 to 100");
    const secs = configNumber(config, "quote_seconds", 60);
    if (!(Number.isInteger(secs) && secs >= 10 && secs <= 900)) p.push("config.quote_seconds: a whole number from 10 to 900");
    for (const k of ["test_webhook_public_key", "live_webhook_public_key"])
      if (config[k])
        try {
          createPublicKey(config[k]);
        } catch {
          p.push(`config.${k}: not a PEM public key`);
        }
    return p;
  },
  authHeaders: (credential) => ({ "Api-Key": credential }),

  async probe(ctx) {
    const r = await ctx.http("GET", "/v0/customers?limit=1");
    return r.status !== null && r.status >= 200 && r.status < 300 ? null : partnerError(r);
  },

  price(ctx, direction, amount_usd) {
    if (!AMOUNT.test(amount_usd)) return rampError("invalid_amount", "The amount must be US dollars, like 100.00");
    const amount = cents(amount_usd);
    if (amount < 100) return rampError("amount_too_small", "The smallest amount is $1.00");
    const fee = Math.max(Math.round(configNumber(ctx.config, "fee_min_usd", 0.5) * 100), Math.round((amount * configNumber(ctx.config, "fee_percent", 0.5)) / 100));
    if (direction === "in" && amount <= fee) return rampError("amount_too_small", "The amount doesn't cover the fee");
    const total = direction === "in" ? amount - fee : amount + fee;
    return {
      amount_usd: dollars(amount),
      fee_usd: dollars(fee),
      total_usd: dollars(total),
      estimated_arrival: null,
      settlement_asset: "USDC",
      settlement_network: "solana",
      settlement_amount: dollars(total), // USDC is redeemable 1:1; Bridge's own fees, if any, show in its receipt
    } satisfies RampPrice;
  },

  async transfer(ctx, req) {
    const c = req.customer;
    if (!c.partner_customer_id) return rampError("partner_customer_required", "The ramp partner hasn't onboarded this customer yet");
    if (req.direction === "out" && !c.partner_payout_account_id) return rampError("partner_payout_account_required", "The ramp partner has no payout bank account for this customer yet");
    const p = req.price;
    // In: the customer pays amount_usd; the destination gets it less the developer fee (Bridge documents
    // destination = amount − developer_fee). Out: amount is the USDC sent (amount plus fee); the bank gets amount_usd.
    const body =
      req.direction === "in"
        ? {
            on_behalf_of: c.partner_customer_id,
            amount: p.amount_usd,
            developer_fee: p.fee_usd,
            source: { payment_rail: "ach_push", currency: "usd" },
            destination: { payment_rail: "solana", currency: "usdc", to_address: ctx.config.settlement_address },
          }
        : {
            on_behalf_of: c.partner_customer_id,
            amount: p.total_usd,
            developer_fee: p.fee_usd,
            source: { payment_rail: "solana", currency: "usdc", from_address: ctx.config.settlement_address },
            destination: { payment_rail: "ach", currency: "usd", external_account_id: c.partner_payout_account_id },
          };
    const r = await ctx.http("POST", "/v0/transfers", body, { "Idempotency-Key": req.idempotency_key });
    if (r.status === null || r.status < 200 || r.status >= 300) return partnerError(r);
    return updateOf(r.body as BridgeTransfer, req.direction);
  },

  async status(ctx, id, direction) {
    const r = await ctx.http("GET", `/v0/transfers/${encodeURIComponent(id)}`);
    if (r.status === null || r.status < 200 || r.status >= 300) return partnerError(r);
    return updateOf(r.body as BridgeTransfer, direction);
  },

  webhook(ctx, raw, headers) {
    const key = ctx.config[`${ctx.environment}_webhook_public_key`];
    if (!key) return rampError("webhook_not_configured", `Set the ${ctx.environment} webhook public key on the adapter first`);
    const m = /^t=(\d+),v0=([A-Za-z0-9+/=]+)$/.exec(headers["x-webhook-signature"] ?? "");
    if (!m) return rampError("bad_signature", "X-Webhook-Signature is missing or malformed");
    // Bridge's timestamp is in milliseconds; older than 10 minutes is a replay (Bridge retries with a new one).
    if (Math.abs(ctx.now().getTime() - Number(m[1])) > 10 * 60 * 1000) return rampError("stale_event", "The event's timestamp is too old");
    const digest = createHash("sha256").update(`${m[1]}.${raw}`).digest();
    let ok = false;
    try {
      ok = verify("sha256", digest, createPublicKey(key), Buffer.from(m[2], "base64"));
    } catch {
      ok = false;
    }
    if (!ok) return rampError("bad_signature", "X-Webhook-Signature doesn't verify");
    let e: { event_id?: unknown; event_category?: unknown; event_object?: unknown };
    try {
      e = JSON.parse(raw);
    } catch {
      return rampError("invalid_json", "The event isn't JSON");
    }
    if (e.event_category !== "transfer" || typeof e.event_id !== "string" || !e.event_object) return null;
    const t = e.event_object as BridgeTransfer & { source?: { payment_rail?: unknown } };
    const direction: RampDirection = t.source?.payment_rail === "solana" ? "out" : "in";
    const update = updateOf(t, direction);
    return isRampError(update) ? update : { event_id: e.event_id, update };
  },
};
