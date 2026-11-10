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
//   DELETE /v0/transfers/{id}                                    void one still awaiting_funds
//   GET  /v0/customers?limit=1                                   the conformance probe (read-only)
//   GET  /v0/customers/{id}                                      the identity a link is checked against
//   webhooks, X-Webhook-Signature: t=<ms>,v0=<base64>            RSA over SHA-256(`${t}.${body}`)
//
// Bridge has no quote that locks a price, so Mynt issues the quote: the fee is the Mynt Ramp's (developer_fee on
// the transfer), the amount out follows from it, and Mynt sets the validity. In: the customer pushes dollars by ACH
// to the deposit account Bridge returns, with its deposit message; Bridge sends the USDC to the ramp's settlement
// address on Solana. Out: USDC from that address, dollars by ACH to the customer's payout account at Bridge; it's
// refused (always in live) until the USDC leg from the settlement address into Bridge exists.
//
// What Mynt doesn't do here, and refuses clearly instead: onboarding the customer at Bridge (KYC, terms of
// service, and the postal address Bridge's external accounts need). The customer asks to be linked from their own
// session; the ramp firm completes it with link_ramp_partner_customer, which Mynt checks against Bridge's identity.

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
  receipt?: { destination_tx_hash?: unknown; source_tx_hash?: unknown; initial_amount?: unknown; final_amount?: unknown; final_amount_currency?: unknown; subtotal_amount?: unknown } | null;
  source_deposit_instructions?: Record<string, unknown> | null;
};
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function updateOf(t: BridgeTransfer, direction: RampDirection): RampTransferUpdate | RampError {
  const id = str(t.id);
  const status = bridgeStatus(t.state);
  if (!id || !status) return { ...rampError("partner_bad_answer", "The ramp partner's answer wasn't a transfer Mynt understands"), ...(id ? { partner_transfer_id: id } : {}) };
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
    // Bridge's receipt: final_amount is what reached the destination after every fee (USDC in, dollars out). It's
    // only reported, never assumed; until Bridge reports it, it stays null.
    ...receiptAmounts(t, direction),
    // Off-ramp: where the USDC leg goes (the stablecoin leg with the product's provider isn't built yet).
    partner_side:
      direction === "out" && d ? { deposit_rail: str(d.payment_rail), deposit_to: str(d.to_address), deposit_amount: str(d.amount), deposit_currency: str(d.currency) } : {},
  };
}

const AMOUNT_TEXT = /^[0-9]{1,12}(\.[0-9]{1,8})?$/;
const usd = (v: string | null) => (v && AMOUNT_TEXT.test(v) ? (Math.round(Number(v) * 100) / 100).toFixed(2) : null);
// What Bridge's receipt says actually moved, never assumed. total_usd means what it means in the leg's quote: in,
// the dollars added to the customer's balance (final_amount, the USDC delivered); out, what the customer is charged
// (initial_amount, the USDC sent: amount plus fees). paid_out_usd is what reached the customer's bank (out only).
function receiptAmounts(t: BridgeTransfer, direction: RampDirection): { total_usd: string | null; settlement_amount: string | null; paid_out_usd?: string | null } {
  const final = str(t.receipt?.final_amount);
  const initial = str(t.receipt?.initial_amount);
  if (direction === "in") return { total_usd: usd(final), settlement_amount: final && AMOUNT_TEXT.test(final) ? final : null };
  return { total_usd: usd(initial), settlement_amount: initial && AMOUNT_TEXT.test(initial) ? initial : null, paid_out_usd: usd(final) };
}

// Bridge's documented hosts and key prefix (apidocs.bridge.xyz: sandbox keys start sk-test).
const SANDBOX_HOST = "api.sandbox.bridge.xyz";
const LIVE_HOST = "api.bridge.xyz";
const hostOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

// Bridge's error codes are short identifiers; anything else becomes a generic code. Its messages aren't relayed.
const partnerError = (r: { status: number | null; body: unknown; error: string | null }): RampError => {
  const code = (r.body as { code?: unknown } | null)?.code;
  const safe = typeof code === "string" && /^[a-z0-9_]{1,60}$/.test(code) ? code : null;
  const withStatus = (e: RampError): RampError => ({ ...e, partner_status: r.status });
  if (r.status === 401) return withStatus(rampError("partner_credential_refused", "The ramp partner refused Mynt's credential"));
  if (safe === "requires_active_kyc_status" || safe === "has_not_accepted_tos") return withStatus(rampError("partner_customer_not_ready", "The ramp partner hasn't finished verifying this customer"));
  if (r.status === null) return withStatus(rampError("partner_unreachable", "The ramp partner didn't answer"));
  return withStatus(rampError(safe ? `partner_${safe}`.slice(0, 60) : "partner_error", "The ramp partner refused the request"));
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
    min_usd: { required: false, description: "The smallest transfer in US dollars (default 1.00)" },
    max_usd: { required: false, description: "The largest transfer in US dollars (default 10000.00)" },
    pending_business_days: { required: false, description: "How many business days an add-dollars transfer waits for the customer's payment before it's voided (default 7, from 1 to 30)" },
    test_offramp: { required: false, description: "\"true\" lets cash-out run in the test environment only (against a fake or the sandbox). Live cash-out stays refused until the USDC leg into Bridge exists" },
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
    const lo = configNumber(config, "min_usd", 1);
    const hi = configNumber(config, "max_usd", 10000);
    if (!(lo >= 1 && hi >= lo && hi <= 1_000_000)) p.push("config.min_usd and max_usd: dollars, at least 1.00, min_usd no more than max_usd, max_usd at most 1000000");
    const days = configNumber(config, "pending_business_days", 7);
    if (!(Number.isInteger(days) && days >= 1 && days <= 30)) p.push("config.pending_business_days: a whole number from 1 to 30");
    if (config.test_offramp !== undefined && !["true", "false"].includes(config.test_offramp)) p.push('config.test_offramp: "true" or "false"');
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
    const lo = Math.round(configNumber(ctx.config, "min_usd", 1) * 100);
    const hi = Math.round(configNumber(ctx.config, "max_usd", 10000) * 100);
    if (amount < lo) return rampError("amount_too_small", `The smallest amount is $${dollars(lo)}`);
    if (amount > hi) return rampError("amount_too_large", `The largest amount is $${dollars(hi)}`);
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

  // DELETE /v0/transfers/{id}: Bridge cancels a transfer only while it's awaiting_funds (transfer-states docs).
  async cancel(ctx, id) {
    const r = await ctx.http("DELETE", `/v0/transfers/${encodeURIComponent(id)}`);
    return r.status !== null && r.status >= 200 && r.status < 300 ? null : partnerError(r);
  },

  // GET /v0/customers/{id}. The name and birth date fields (first_name, last_name, birth_date) are as Bridge's
  // customer object is documented; checked against the sandbox before live use.
  async customerIdentity(ctx, id) {
    const r = await ctx.http("GET", `/v0/customers/${encodeURIComponent(id)}`);
    if (r.status === null || r.status < 200 || r.status >= 300) return partnerError(r);
    const c = (r.body ?? {}) as { first_name?: unknown; last_name?: unknown; full_name?: unknown; birth_date?: unknown };
    const name = str(c.full_name) ?? ([str(c.first_name), str(c.last_name)].filter(Boolean).join(" ") || null);
    const dob = str(c.birth_date);
    // Bridge's documented customer response has no address (it's request-only), so it can't say where the customer lives.
    return { full_name: name, date_of_birth: dob && /^\d{4}-\d{2}-\d{2}/.test(dob) ? dob.slice(0, 10) : null, residential_state: null };
  },

  // GET /v0/customers/{customerID}/external_accounts/{externalAccountID}: the payout account is this customer's.
  async payoutAccountOf(ctx, customerId, accountId) {
    const r = await ctx.http("GET", `/v0/customers/${encodeURIComponent(customerId)}/external_accounts/${encodeURIComponent(accountId)}`);
    if (r.status === 404) return false;
    if (r.status === null || r.status < 200 || r.status >= 300) return partnerError(r);
    const a = (r.body ?? {}) as { id?: unknown; customer_id?: unknown; active?: unknown };
    return a.id === accountId && (a.customer_id === undefined || a.customer_id === customerId) && a.active !== false;
  },

  environmentProblems(e) {
    const p: string[] = [];
    if (hostOf(e.test_base_url) === LIVE_HOST) p.push(`test_base_url: ${LIVE_HOST} is Bridge's production API; the test environment uses https://${SANDBOX_HOST}`);
    if (hostOf(e.live_base_url) === SANDBOX_HOST) p.push(`live_base_url: ${SANDBOX_HOST} is Bridge's sandbox; the live environment uses https://${LIVE_HOST}`);
    if (e.test_credential && !e.test_credential.startsWith("sk-test")) p.push("test_credential: Bridge sandbox keys start with sk-test; this looks like a production key");
    if (e.live_credential && e.live_credential.startsWith("sk-test")) p.push("live_credential: this is a Bridge sandbox key (sk-test…); the live environment needs a production key");
    return p;
  },

  offrampReady: (ctx) => ctx.environment === "test" && ctx.config.test_offramp === "true",

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
