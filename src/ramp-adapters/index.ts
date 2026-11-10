import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store, User } from "../store.js";
import { derivedKey, open, seal, vaultAvailable } from "../vault.js";
import { safeRequest, signBody, type VendorCallOptions, type VendorResult } from "../vendor-call.js";
import { emitFirmEvent } from "../runtime.js";
import { getOffering, lateVendorSettlement, myntRampEntity, reverseVendorRun, serviceType, vendorCallback, type Offering } from "../vendors.js";
import { eraseVerifiedCustomerState, identityDigest, recordMovementGaveUp, recordMovementOutput, recordVerifiedCustomerState } from "../money-rails.js";
import { bridgeAdapter } from "./bridge.js";
import { isRampError, type PartnerHttp, type RampAdapter, type RampAdapterContext, type RampPartnerIdentity, type RampDirection, type RampPrice, type RampTransferStatus, type RampTransferUpdate } from "./types.js";

// Mynt's side of a ramp adapter (see ./types.ts): it answers Mynt's own signed wire-contract requests for an
// offering that names an adapter, exactly as a partner speaking the contract would (the same signature and replay
// checks, the same answers), so conformance, quotes, accepts and callbacks don't know the difference. It holds the
// partner's credential only for the length of a call, opened from the ramp firm's key vault; it never logs or
// returns it.

export const RAMP_ADAPTERS: Record<string, RampAdapter> = { [bridgeAdapter.id]: bridgeAdapter };
export const RAMP_ADAPTER_IDS = Object.keys(RAMP_ADAPTERS) as [string, ...string[]];
export const RAMP_ADAPTER_WEBHOOK_PATH = "/v1/ramp-adapters/";
const T = "financial_products";
const QUOTE_KEYS: Record<string, RampDirection> = { onramp_quote: "in", offramp_quote: "out" };
const TRANSFER_KEYS: Record<string, { direction: RampDirection; quote: string }> = {
  onramp_transfer: { direction: "in", quote: "onramp_quote" },
  offramp_transfer: { direction: "out", quote: "offramp_quote" },
};

// Mynt's pseudonymous key for one app's customer: what the partner link is filed under, never the reference itself.
export const rampCustomerKey = (appId: string, customerRef: string) => createHash("sha256").update(`mynt-ramp:${appId}:${customerRef}`).digest("hex").slice(0, 40);

type AdapterRow = { adapter: string | null; adapter_config: Record<string, string> | null; adapter_test_key_id: string | null; adapter_live_key_id: string | null; conformance_secret: string };
async function adapterRow(store: Store, offeringId: string): Promise<AdapterRow | undefined> {
  const { rows } = await store.db.query(`SELECT adapter, adapter_config, adapter_test_key_id, adapter_live_key_id, conformance_secret FROM ${T}.vendor_offerings WHERE id = $1`, [offeringId]);
  return rows[0] as AdapterRow | undefined;
}
async function credentialOf(store: Store, keyId: string | null): Promise<string | null> {
  if (!keyId) return null;
  const { rows } = await store.db.query(`SELECT sealed FROM ${T}.key_vault WHERE id = $1`, [keyId]);
  return rows[0] ? open(rows[0].sealed as string, false) : null;
}

// The partner's API for one environment, under Mynt's outbound rules, with the credential added here and nowhere else.
function partnerHttp(adapter: RampAdapter, base: string, credential: string, opts: VendorCallOptions): PartnerHttp {
  return async (method, path, body, headers = {}) => {
    const r: VendorResult = await safeRequest(method, `${base.replace(/\/+$/, "")}${path}`, body === undefined ? null : JSON.stringify(body), {
      "User-Agent": "Mynt-Ramp-Adapter/1",
      Accept: "application/json",
      ...headers,
      ...adapter.authHeaders(credential),
    }, opts);
    return { status: r.http_status, body: r.body, error: r.error };
  };
}

async function contextFor(store: Store, o: Offering, row: AdapterRow, environment: "test" | "live", opts: VendorCallOptions): Promise<{ adapter: RampAdapter; ctx: RampAdapterContext } | { error: string }> {
  const adapter = row.adapter ? RAMP_ADAPTERS[row.adapter] : undefined;
  if (!adapter) return { error: "adapter_missing" };
  const base = environment === "test" ? o.test_base_url : o.live_base_url;
  const credential = await credentialOf(store, environment === "test" ? row.adapter_test_key_id : row.adapter_live_key_id);
  if (!base || !credential) return { error: "partner_credential_missing" };
  // Test never reaches the partner's production, and live never its sandbox (by its documented hosts and key prefixes).
  const mismatch = adapter.environmentProblems({
    test_base_url: environment === "test" ? base : "",
    live_base_url: environment === "live" ? base : null,
    ...(environment === "test" ? { test_credential: credential } : { live_credential: credential }),
  });
  if (mismatch.length) return { error: "environment_mismatch" };
  return { adapter, ctx: { environment, config: row.adapter_config ?? {}, http: partnerHttp(adapter, base, credential, opts), now: () => new Date() } };
}

// ---- Mynt's quote, for a partner with no quote that locks a price ----

const b64 = (s: string) => Buffer.from(s).toString("base64url");
// Signed with a key derived from MYNT_VAULT_KEY for the ramp firm, so its quote offering's quote is good at its
// transfer offering, and nowhere else.
const quoteMac = (secret: Buffer, payload: string) => createHmac("sha256", secret).update(`mynt-ramp-quote.${payload}`).digest("hex").slice(0, 32);
const quoteKey = (entityId: string, environment: string) => derivedKey(`ramp-quote:${entityId}:${environment}`);
// Compact: the service, the dollar amounts, the expiry and a nonce. The wire contract caps a quote id at 200
// characters; this one is well under, and it's parsed by splitting, so no length is assumed.
function issueQuote(secret: Buffer, key: string, price: RampPrice, expiresAt: Date): string {
  const fields = [key, price.amount_usd, price.fee_usd, price.total_usd, price.settlement_amount, price.estimated_arrival ?? "", expiresAt.getTime(), randomBytes(4).toString("hex")];
  const payload = b64(JSON.stringify(fields));
  return `maq.${payload}.${quoteMac(secret, payload)}`;
}
function readQuote(secret: Buffer, id: string): { k: string; p: RampPrice; e: number } | null {
  if (typeof id !== "string" || id.length > 4096) return null;
  const parts = id.split(".");
  if (parts.length !== 3 || parts[0] !== "maq" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[0-9a-f]{32}$/.test(parts[2])) return null;
  if (!timingSafeEqual(Buffer.from(quoteMac(secret, parts[1])), Buffer.from(parts[2]))) return null;
  try {
    const f = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!Array.isArray(f) || f.length < 7) return null;
    const [k, amount_usd, fee_usd, total_usd, settlement_amount, arrival, e] = f;
    return { k, e, p: { amount_usd, fee_usd, total_usd, settlement_amount, estimated_arrival: arrival || null, settlement_asset: "USDC", settlement_network: "solana" } };
  } catch {
    return null;
  }
}

// ---- the wire contract, answered in-process ----

type WireBody = {
  request_id?: string;
  environment?: string;
  input?: Record<string, unknown>;
  params?: Record<string, unknown>;
  quote?: { quote_id?: string };
  consent?: { artefact_ref?: string };
};

// Mynt's signed request for `key` to an adapter offering, answered as the partner would over HTTP. `customerKey`
// is Mynt's pseudonymous key for the customer (absent in conformance).
export async function serveRampAdapter(
  store: Store,
  o: Offering,
  key: string,
  payload: string,
  signature: string,
  environment: "test" | "live",
  customerKey: string | null,
  opts: VendorCallOptions,
): Promise<VendorResult> {
  const started = Date.now();
  const answer = (http_status: number, body: unknown): VendorResult => ({ ok: http_status >= 200 && http_status < 300, http_status, body, error: http_status >= 300 ? `http ${http_status}` : null, latency_ms: Date.now() - started });
  const row = await adapterRow(store, o.id);
  if (!row) return answer(404, { status: "error" });
  let body: WireBody;
  try {
    body = JSON.parse(payload);
  } catch {
    return answer(400, { status: "error", error: { code: "invalid_json" } });
  }
  // The same checks a partner speaking the contract must make: Mynt-Signature, from this offering's conformance
  // secret or an active subscriber's signing secret, at most 300 s old.
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature);
  const { rows: subs } = await store.db.query(`SELECT id, signing_secret FROM ${T}.vendor_subscriptions WHERE offering_id = $1 AND status = 'active'`, [o.id]);
  const candidates = [{ secret: open(row.conformance_secret, false), subscription_id: null as string | null }, ...subs.map((s) => ({ secret: open(s.signing_secret as string, false), subscription_id: s.id as string }))];
  const signer =
    m && Math.abs(Date.now() / 1000 - Number(m[1])) <= 300
      ? candidates.find((c) => timingSafeEqual(createHmac("sha256", c.secret).update(`${m[1]}.${payload}`).digest(), Buffer.from(m[2], "hex")))
      : undefined;
  if (!signer) return answer(401, { request_id: body.request_id ?? null, status: "error", output: null, error: { code: "bad_signature", message: "Mynt-Signature doesn't verify" } });
  const error = (code: string, message: string, partner_status?: number | null) =>
    answer(200, { request_id: body.request_id, status: "error", output: null, error: { code, message, ...(partner_status != null ? { partner_status } : {}) } });
  if (body.environment !== environment) return error("wrong_environment", "The request's environment doesn't match the endpoint");
  const conformance = signer.subscription_id === null || body.consent?.artefact_ref === "mynt_conformance";
  const c = await contextFor(store, o, row, environment, opts);
  if ("error" in c) {
    const why: Record<string, string> = {
      adapter_missing: "This offering's adapter isn't available",
      partner_credential_missing: "The ramp partner's credential for this environment isn't set",
      environment_mismatch: "This environment points at the partner's other environment (its URL or key)",
    };
    return error(c.error, why[c.error] ?? "The ramp partner can't be reached");
  }
  const { adapter, ctx } = c;
  // Conformance proves the partner answers Mynt with each credential set, without moving money.
  if (conformance) {
    const probe = await adapter.probe(ctx);
    if (probe) return error(probe.error.code, probe.error.message);
    if (row.adapter_live_key_id && o.live_base_url) {
      const live = await contextFor(store, o, row, "live", opts);
      if ("error" in live) return error(`live_${live.error}`, "The live credential or URL doesn't fit the partner's production environment");
      const liveProbe = await live.adapter.probe(live.ctx);
      if (liveProbe) return error(`live_${liveProbe.error.code}`.slice(0, 60), "The partner refused the live credential");
    }
  }
  const qKey = quoteKey(o.entity_id, environment);
  if (!qKey) return error("vault_not_configured", "This server can't sign quotes (MYNT_VAULT_KEY isn't set)");

  if (key in QUOTE_KEYS) {
    const direction = QUOTE_KEYS[key];
    if (body.params?.direction !== direction) return error("invalid_params", `${key} is direction '${direction}'`);
    // No price for a cash-out that can't run yet.
    if (direction === "out" && !conformance && !adapter.offrampReady(ctx)) return error("offramp_not_available", "Cashing out through this partner isn't available yet");
    const price = adapter.price(ctx, direction, String(body.params?.amount_usd ?? ""));
    if (isRampError(price)) return error(price.error.code, price.error.message);
    const seconds = Number(ctx.config.quote_seconds ?? 60) || 60;
    const expires = new Date(Date.now() + seconds * 1000);
    return answer(200, {
      request_id: body.request_id,
      status: "ok",
      output: { quote_id: issueQuote(qKey, key, price, expires), expires_at: expires.toISOString(), direction, currency: "USD", ...price },
    });
  }

  const t = TRANSFER_KEYS[key];
  if (!t) return answer(404, { status: "error", error: { code: "not_found" } });
  if (conformance) return answer(200, { request_id: body.request_id, status: "ok", output: { transfer_status: "submitted", estimated_arrival: null, settlement_ref: null, settlement_tx: null } });
  // Cash-out needs the USDC leg from the ramp's settlement address into the partner, which isn't built: refused
  // (live always), so no customer waits on a payout that can't come.
  if (t.direction === "out" && !adapter.offrampReady(ctx)) return error("offramp_not_available", "Cashing out through this partner isn't available yet");
  const q = readQuote(qKey, body.quote?.quote_id ?? "");
  if (!q || q.k !== t.quote) return error("unknown_quote", "That quote wasn't issued for this service");
  if (q.e <= Date.now()) return error("quote_expired", "That quote has expired");
  if (!customerKey) return error("customer_unknown", "Mynt didn't say which customer this is");
  const env = environment;
  // Only a link the customer asked for in their own session, whose partner identity matched theirs.
  const { rows: links } = await store.db.query(
    `SELECT partner_customer_id, partner_payout_account_id FROM ${T}.ramp_partner_links WHERE entity_id = $1 AND environment = $2 AND customer_key = $3 AND identity_verified_at IS NOT NULL`,
    [o.entity_id, env, customerKey],
  );
  const link = links[0] as { partner_customer_id: string; partner_payout_account_id: string | null } | undefined;
  const input = (body.input ?? {}) as Record<string, string>;
  const done = await adapter.transfer(ctx, {
    direction: t.direction,
    price: q.p,
    // The same for every attempt at one quote, so a retry can't move money twice.
    idempotency_key: createHash("sha256").update(`mynt-ramp:${o.id}:${body.quote!.quote_id}`).digest("hex").slice(0, 48),
    customer: { key: customerKey, partner_customer_id: link?.partner_customer_id ?? null, partner_payout_account_id: link?.partner_payout_account_id ?? null },
    input: { full_name: input.full_name, bank_account_number: input.bank_account_number, routing_number: input.routing_number },
  });
  if (isRampError(done)) {
    // The partner has a transfer with this id even though Mynt couldn't read the rest: keep it, so its webhooks and
    // the poller find it.
    if (done.partner_transfer_id)
      await store.db.query(
        `INSERT INTO ${T}.ramp_adapter_transfers (offering_id, environment, partner_transfer_id, subscription_id, request_id, direction, status, partner_side)
         VALUES ($1, $2, $3, $4, $5, $6, 'submitted', '{}') ON CONFLICT (offering_id, environment, partner_transfer_id) DO UPDATE SET subscription_id = EXCLUDED.subscription_id, request_id = EXCLUDED.request_id, updated_at = now()`,
        [o.id, env, done.partner_transfer_id, signer.subscription_id, body.request_id, t.direction],
      );
    return error(done.error.code, done.error.message, done.partner_status);
  }
  // A repeat of one quote's transfer (a retried accept) finds the partner's same transfer: its state only moves on.
  const { rows: kept } = await store.db.query(
    `INSERT INTO ${T}.ramp_adapter_transfers (offering_id, environment, partner_transfer_id, subscription_id, request_id, direction, status, partner_side)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (offering_id, environment, partner_transfer_id) DO UPDATE SET subscription_id = EXCLUDED.subscription_id, request_id = EXCLUDED.request_id,
       status = CASE WHEN ${T}.ramp_adapter_transfers.status = 'submitted' THEN EXCLUDED.status ELSE ${T}.ramp_adapter_transfers.status END,
       partner_side = EXCLUDED.partner_side, updated_at = now()
     RETURNING status`,
    [o.id, env, done.partner_transfer_id, signer.subscription_id, body.request_id, t.direction, done.status, JSON.stringify(done.partner_side ?? {})],
  );
  const status = (kept[0]?.status as RampTransferStatus | undefined) ?? done.status;
  return answer(200, { request_id: body.request_id, status: "ok", output: outputOf({ ...done, status: FINAL_ROW[status] ?? done.status }, t.direction) });
}

// A transfer update as the service type's output: dollars for the customer, the rest partner-side.
// pay_to_status: active while the customer may pay into the account; void once the partner confirmed it voided the
// transfer; unknown when Mynt ended it without that confirmation (late money is still recorded).
type PayToStatus = "active" | "void" | "unknown";
const outputOf = (u: RampTransferUpdate, direction: RampDirection, extra: { pay_to_status?: PayToStatus } = {}) => ({
  transfer_status: u.status,
  estimated_arrival: u.estimated_arrival,
  total_usd: u.total_usd ?? null,
  ...(direction === "out" ? { paid_out_usd: u.paid_out_usd ?? null } : {}),
  ...(direction === "in"
    ? {
        pay_to_bank_name: u.pay_to?.bank_name ?? null,
        pay_to_account_number: u.pay_to?.account_number ?? null,
        pay_to_routing_number: u.pay_to?.routing_number ?? null,
        pay_to_reference: u.pay_to?.reference ?? null,
        pay_to_status: extra.pay_to_status ?? (u.pay_to && Object.values(u.pay_to).some(Boolean) ? (u.status === "submitted" ? "active" : null) : null),
      }
    : {}),
  settlement_ref: u.settlement_ref,
  settlement_tx: u.settlement_tx,
});

// ---- a transfer's life at the partner, moving only forward ----
//
// Row statuses: submitted → settled | failed | returned (the run ends with it); settled → reversed (returned or
// refunded after it completed, the one change after the end); submitted → expired (its window passed and it was
// voided) or closed (the run ended another way); expired | closed → settled_late (the money came anyway: recorded,
// and the innovator handles it) → reversed. Anything else, including an earlier state arriving late, is ignored.

const FINAL_ROW: Record<string, RampTransferStatus> = { settled: "settled", failed: "failed", returned: "returned", reversed: "returned", settled_late: "settled" };
type TransferRow = { offering_id: string; environment: "test" | "live"; partner_transfer_id: string; subscription_id: string; request_id: string; direction: RampDirection; status: string; created_at: string | Date };

async function setRow(store: Store, r: TransferRow, status: string, from: string) {
  const { rows } = await store.db.query(
    `UPDATE ${T}.ramp_adapter_transfers SET status = $5, updated_at = now() WHERE offering_id = $1 AND environment = $2 AND partner_transfer_id = $3 AND status = $4 RETURNING status`,
    [r.offering_id, r.environment, r.partner_transfer_id, from, status],
  );
  return rows.length > 0; // false: someone else moved it first
}
async function runStatus(store: Store, r: TransferRow): Promise<string | null> {
  const { rows } = await store.db.query(`SELECT status FROM ${T}.vendor_action_runs WHERE request_id = $1 AND subscription_id = $2`, [r.request_id, r.subscription_id]);
  return (rows[0]?.status as string | undefined) ?? null;
}
async function callbackRun(store: Store, r: TransferRow, output: Record<string, unknown>) {
  const { rows: s } = await store.db.query(`SELECT signing_secret FROM ${T}.vendor_subscriptions WHERE id = $1`, [r.subscription_id]);
  if (!s[0]) return;
  const cb = JSON.stringify({ request_id: r.request_id, status: "ok", output });
  await vendorCallback(store, r.subscription_id, cb, signBody(open(s[0].signing_secret as string, false), cb));
}

type Applied = "unknown" | "open" | "finished" | "ignored" | "reversed" | "late";
async function applyUpdate(store: Store, offeringId: string, environment: "test" | "live", u: RampTransferUpdate): Promise<Applied> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.ramp_adapter_transfers WHERE offering_id = $1 AND environment = $2 AND partner_transfer_id = $3`, [offeringId, environment, u.partner_transfer_id]);
  const r = rows[0] as TransferRow | undefined;
  if (!r) return "unknown";
  const output = outputOf(u, r.direction);
  const at = { subscription_id: r.subscription_id, request_id: r.request_id };
  // What the partner says about money goes in the ledger whatever state the run or this row is in.
  if (u.status !== "submitted") await recordMovementOutput(store, at, output);
  switch (r.status) {
    case "submitted": {
      if (u.status === "submitted") return "open";
      // End the run first, and only then move the row: if ending it throws, the row is still submitted, so the
      // partner's retry (or the poller) ends it again; the 24-hour sweep never touches a submitted row.
      const before = await runStatus(store, r);
      if (before === "calling" || before === "pending") await callbackRun(store, r, output);
      // Settled, but the run ended without completing (its consent withdrawn, or swept): the money still moved.
      if (u.status === "settled" && (await runStatus(store, r)) !== "completed") {
        await lateVendorSettlement(store, at, output);
        await setRow(store, r, "settled_late", "submitted");
        return "late";
      }
      return (await setRow(store, r, u.status, "submitted")) ? "finished" : "ignored";
    }
    case "expired":
    case "closed":
      if (u.status === "settled") {
        await lateVendorSettlement(store, at, output);
        return (await setRow(store, r, "settled_late", r.status)) ? "late" : "ignored";
      }
      return "ignored";
    case "settled": {
      if (u.status === "returned") {
        if (!(await setRow(store, r, "reversed", r.status))) return "ignored";
        await reverseVendorRun(store, at, output);
        return "reversed";
      }
      if (u.status !== "settled") return "ignored";
      // The row says settled but the run didn't complete (an earlier attempt stopped part-way): finish it now, or,
      // if the run already ended another way, record the money as a late settlement. Both are idempotent.
      const rs = await runStatus(store, r);
      if (rs === "calling" || rs === "pending") await callbackRun(store, r, output);
      const now = await runStatus(store, r);
      if (now === "completed" || now === "reversed") return rs === now ? "ignored" : "finished";
      await lateVendorSettlement(store, at, output);
      return (await setRow(store, r, "settled_late", "settled")) ? "late" : "ignored";
    }
    case "settled_late":
      if (u.status === "returned") {
        if (!(await setRow(store, r, "reversed", r.status))) return "ignored";
        await reverseVendorRun(store, at, output);
        return "reversed";
      }
      return "ignored";
    default:
      return "ignored"; // failed, returned, reversed: final
  }
}

// POST /v1/ramp-adapters/<offering_id>/webhook/<test|live>: the partner's webhook, verified with its own scheme and
// applied once per partner event id.
export async function rampAdapterWebhook(store: Store, req: IncomingMessage, res: ServerResponse, url: URL) {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const m = /^\/v1\/ramp-adapters\/([0-9a-f-]{36})\/webhook\/(test|live)$/.exec(url.pathname);
  if (!m) return reply(404, { error: "not_found" });
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) return reply(413, { error: "too_large" });
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const o = await getOffering(store.db, m[1]);
  const row = o && (await adapterRow(store, o.id));
  const adapter = row?.adapter ? RAMP_ADAPTERS[row.adapter] : undefined;
  if (!o || !row || !adapter) return reply(404, { error: "not_found" });
  const environment = m[2] as "test" | "live";
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const event = adapter.webhook({ environment, config: row.adapter_config ?? {}, now: () => new Date() }, raw, headers);
  // A refused event answers 400, so the partner retries it (with a fresh signature).
  if (isRampError(event)) return reply(400, { error: event.error.code });
  if (!event) return reply(200, { received: true, ignored: true });
  const { rows: fresh } = await store.db.query(`INSERT INTO ${T}.ramp_adapter_events (offering_id, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id`, [o.id, event.event_id.slice(0, 200)]);
  if (!fresh.length) return reply(200, { received: true, duplicate: true });
  try {
    const applied = await applyUpdate(store, o.id, environment, event.update);
    return reply(200, { received: true, ...(applied === "unknown" || applied === "ignored" ? { ignored: true } : {}) });
  } catch (e) {
    // Not applied: forget the event, so the partner's retry is.
    await store.db.query(`DELETE FROM ${T}.ramp_adapter_events WHERE offering_id = $1 AND event_id = $2`, [o.id, event.event_id.slice(0, 200)]);
    throw e;
  }
}

// When an add-dollars transfer stops waiting for the customer's payment: `days` business days (Monday to Friday)
// after it started, because bank transfers take business days.
export function pendingDeadline(start: Date, days: number): Date {
  const d = new Date(start);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}
const pendingDays = (config: Record<string, string>) => Number(config.pending_business_days) || Number(process.env.RAMP_ADAPTER_PENDING_BUSINESS_DAYS) || 7;
const HARD_STOP_BUSINESS_DAYS = 30;

// Reads back adapter transfers (a missed or delayed webhook): open ones every `olderThanSeconds`, ended ones (for a
// reversal or a late settlement) every `finalOlderThanSeconds` for 45 days. Each row is claimed with SKIP LOCKED and
// its updated_at bumped first, so overlapping ticks never take the same row and a failing partner is backed off.
// An open transfer past its window is voided at the partner (when it can be) and its run ends as failed:
// pay_to_status is void when the partner confirmed the void, unknown otherwise (late money is still recorded).
export async function pollRampAdapterTransfers(
  store: Store,
  opts: VendorCallOptions = {},
  o: { olderThanSeconds?: number; finalOlderThanSeconds?: number; limit?: number; now?: Date } = {},
): Promise<number> {
  const { rows } = await store.db.query(
    `UPDATE ${T}.ramp_adapter_transfers SET updated_at = now()
     WHERE (offering_id, environment, partner_transfer_id) IN (
       SELECT offering_id, environment, partner_transfer_id FROM ${T}.ramp_adapter_transfers
       WHERE (status = 'submitted' AND updated_at <= now() - make_interval(secs => $1))
          OR (status IN ('settled', 'settled_late', 'expired', 'closed') AND updated_at <= now() - make_interval(secs => $3) AND created_at > now() - interval '45 days')
       ORDER BY updated_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [o.olderThanSeconds ?? 120, o.limit ?? 50, o.finalOlderThanSeconds ?? 6 * 3600],
  );
  const now = o.now ?? new Date();
  let n = 0;
  for (const r of rows as TransferRow[]) {
    const off = await getOffering(store.db, r.offering_id);
    const row = off && (await adapterRow(store, off.id));
    if (!off || !row) continue;
    // A run that ended another way (consent withdrawn, swept) isn't waited on; the row stays watched for the money.
    if (r.status === "submitted") {
      const rs = await runStatus(store, r);
      if (rs !== "calling" && rs !== "pending") {
        await setRow(store, r, "closed", "submitted");
        continue;
      }
    }
    const c = await contextFor(store, off, row, r.environment, opts);
    const config = row.adapter_config ?? {};
    let u: RampTransferUpdate | null = null;
    if (!("error" in c)) {
      const got = await c.adapter.status(c.ctx, r.partner_transfer_id, r.direction);
      if (!isRampError(got)) {
        const applied = await applyUpdate(store, r.offering_id, r.environment, got);
        if (applied === "finished" || applied === "reversed" || applied === "late") n++;
        u = got;
      }
    }
    if (r.status !== "submitted" || (u && u.status !== "submitted")) continue;
    // Still waiting: past its window?
    const started = new Date(r.created_at);
    if (now < pendingDeadline(started, pendingDays(config))) continue;
    const hardStop = now >= pendingDeadline(started, HARD_STOP_BUSINESS_DAYS);
    let voided = false;
    if (!("error" in c) && c.adapter.cancel) voided = (await c.adapter.cancel(c.ctx, r.partner_transfer_id)) === null;
    // The partner wouldn't void it (its money may be moving): keep waiting, up to the hard stop.
    if (!voided && !hardStop && !("error" in c) && c.adapter.cancel) continue;
    if (!(await setRow(store, r, "expired", "submitted"))) continue;
    // Without the partner's void this is Mynt's decision, not the partner's answer: the ledger says so, first, since
    // the callback below reports it as a failure.
    if (!voided) await recordMovementGaveUp(store, { subscription_id: r.subscription_id, request_id: r.request_id });
    await callbackRun(store, r, outputOf({ partner_transfer_id: r.partner_transfer_id, status: "failed", estimated_arrival: null, settlement_ref: r.partner_transfer_id, settlement_tx: null }, r.direction, { pay_to_status: voided ? "void" : "unknown" }));
    n++;
  }
  return n;
}

// ---- linking a customer to the ramp partner, started by the customer's own session ----

// A name compared across scripts: Unicode-decomposed (NFKD), marks removed, letters only (any script), case-folded,
// spaces collapsed. Empty when nothing of it is a letter.
export const normName = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("und")
    .replace(/[^\p{L}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

// Why the partner's identity isn't the customer's, or null when it is. Names must both be there and match; in
// live, dates of birth must too (in test, they're compared when both have one).
export function identityProblem(held: { full_name?: string; date_of_birth?: string }, partner: { full_name: string | null; date_of_birth: string | null }, environment: "test" | "live"): string | null {
  const a = normName(held.full_name);
  const b = normName(partner.full_name);
  if (!a || !b) return "The customer's name, or the partner's, has no letters to compare";
  if (a !== b) return "The partner's customer isn't the customer who asked: their names don't match";
  const ha = held.date_of_birth?.slice(0, 10) || null;
  const pb = partner.date_of_birth || null;
  if (environment === "live" && (!ha || !pb)) return "In live, both the customer and the partner must have a date of birth to compare";
  if (ha && pb && ha !== pb) return "The partner's customer isn't the customer who asked: their dates of birth don't match";
  return null;
}

const LINK_IDENTITY_FIELDS = ["full_name", "date_of_birth"]; // what a link compares with the partner's record

// Reads the partner's record again before a live transfer, so a re-verified state is used at once. A partner that
// can't be read, or doesn't say, leaves what's on file: the partner-verified state from the last time it did.
export async function refreshVerifiedCustomerState(store: Store, o: Offering, a: { app_id: string; customer_ref: string }, opts: VendorCallOptions = {}): Promise<void> {
  const started = new Date();
  try {
    const row = await adapterRow(store, o.id);
    if (!row) return;
    const { rows } = await store.db.query(`SELECT partner_customer_id FROM ${T}.ramp_partner_links WHERE entity_id = $1 AND environment = 'live' AND customer_key = $2 AND identity_verified_at IS NOT NULL`, [o.entity_id, rampCustomerKey(a.app_id, a.customer_ref)]);
    if (!rows[0]) return;
    const c = await contextFor(store, o, row, "live", opts);
    if ("error" in c) return;
    const got = await c.adapter.customerIdentity(c.ctx, rows[0].partner_customer_id as string);
    if (isRampError(got)) return;
    const base = { app_id: a.app_id, customer_ref: a.customer_ref, offering_id: o.id, source: "ramp_link" as const, verified_by_entity: o.entity_id, verified_by: c.adapter.id, started_at: started };
    // The partner's record must still be this customer's, as at linking.
    const held = Object.fromEntries((await store.vaultFields(a.app_id, a.customer_ref, false)).filter((h) => LINK_IDENTITY_FIELDS.includes(h.field)).map((h) => [h.field, open(h.sealed, false)]));
    if (identityProblem(held, got, "live")) {
      await recordVerifiedCustomerState(store, { ...base, status: "suspended", reason: "identity_changed" });
      return;
    }
    if (!got.residential_state) return;
    await recordVerifiedCustomerState(store, { ...base, state: got.residential_state, verified_at: got.verified_at ?? null, identity_fields: LINK_IDENTITY_FIELDS, identity_digest: identityDigest(held, LINK_IDENTITY_FIELDS) });
  } catch (e) {
    console.error("verified customer state:", (e as Error).message);
  }
}

// A customer erasing their data: their verified state, and the link that would bring it back.
export async function eraseCustomerVerification(store: Store, c: { app_id: string; customer_ref: string; sandbox: boolean; changed_by: string }): Promise<void> {
  await store.db.query(`DELETE FROM ${T}.ramp_partner_links WHERE environment = $1 AND customer_key = $2`, [c.sandbox ? "test" : "live", rampCustomerKey(c.app_id, c.customer_ref)]);
  if (!c.sandbox) await eraseVerifiedCustomerState(store, c);
}

// How many link requests a session, and a customer, may make; and how long a request waits for the ramp firm.
const LINKS_PER_SESSION_HOUR = 5;
const LINKS_PER_CUSTOMER_DAY = 10;
const linkExpiryHours = () => Number(process.env.RAMP_LINK_EXPIRY_HOURS) || 7 * 24;

// POST /v1/client/ramp_links (runtime API): a customer, in their own session, with the ramp's consent given there,
// asks to be linked to the ramp partner. The ramp firm is told only the request's id (ramp_link.requested); it
// never handles the developer's customer reference.
export async function requestRampLink(
  store: Store,
  a: { app_id: string; customer_ref: string; sandbox: boolean; session_id: string; product_id: string; vendor_subscription_ids: string[]; consented: (purpose: string) => Promise<boolean> },
): Promise<{ error: { status: number; code: string; message: string } } | { link_reference: string; status: "requested"; consent_purpose: string; expires_at: string }> {
  const bad = (status: number, code: string, message: string) => ({ error: { status, code, message } });
  const ramp = await myntRampEntity(store);
  if (!ramp) return bad(409, "ramp_not_available", "This product's ramp isn't available");
  const purposes: string[] = [];
  for (const id of a.vendor_subscription_ids) {
    const { rows } = await store.db.query(
      `SELECT t.consent_purpose FROM ${T}.vendor_subscriptions s JOIN ${T}.vendor_offerings o ON o.id = s.offering_id JOIN ${T}.service_types t ON t.region = o.region AND t.key = o.service_type
       WHERE s.id = $1 AND o.entity_id = $2 AND t.category = 'ramp'`,
      [id, ramp],
    );
    for (const r of rows) purposes.push(r.consent_purpose as string);
  }
  if (!purposes.length) return bad(400, "no_ramp", "This product doesn't use the Mynt Ramp");
  let purpose: string | undefined;
  for (const p of [...new Set(purposes)].sort()) if (await a.consented(p)) purpose = p;
  if (!purpose) return bad(409, "consent_required", `Record consent '${[...new Set(purposes)].sort().join("' or '")}' (POST /v1/client/evidence) first`);
  const { rows: counts } = await store.db.query(
    `SELECT count(*) FILTER (WHERE session_id = $1 AND created_at > now() - interval '1 hour')::int AS session,
            count(*) FILTER (WHERE app_id = $2 AND customer_ref = $3 AND sandbox = $4 AND created_at > now() - interval '1 day')::int AS customer
     FROM ${T}.ramp_link_requests WHERE (session_id = $1 OR (app_id = $2 AND customer_ref = $3)) AND created_at > now() - interval '1 day'`,
    [a.session_id, a.app_id, a.customer_ref, a.sandbox],
  );
  if (Number(counts[0]?.session ?? 0) >= LINKS_PER_SESSION_HOUR || Number(counts[0]?.customer ?? 0) >= LINKS_PER_CUSTOMER_DAY)
    return bad(429, "rate_limited", "Too many link requests for this customer; try again later");
  const id = randomUUID();
  await store.db.query(
    `INSERT INTO ${T}.ramp_link_requests (id, entity_id, app_id, customer_ref, sandbox, session_id, product_id, consent_purpose) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ramp, a.app_id, a.customer_ref, a.sandbox, a.session_id, a.product_id, purpose],
  );
  await emitFirmEvent(store, ramp, "ramp_link.requested", { link_reference: id, environment: a.sandbox ? "test" : "live", product_id: a.product_id }, a.sandbox);
  return { link_reference: id, status: "requested", consent_purpose: purpose, expires_at: new Date(Date.now() + linkExpiryHours() * 3600_000).toISOString() };
}

// ---- tools: the ramp firm (or an admin) plugs its partner in ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });

export function registerRampAdapterTools(server: McpServer, store: Store, user: User, opts: { admin?: boolean; vendors?: VendorCallOptions } = {}) {
  const vendorOpts = opts.vendors ?? {};
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const entityOf = async () => ((await store.getUser(user.id)) ?? user).entity_id;
  // Only the firm that operates the Mynt Ramp, or an admin.
  const rampFirm = async (): Promise<string | { error: string }> => {
    const ramp = await myntRampEntity(store);
    if (!ramp) return { error: "No firm operates the Mynt Ramp yet: an admin designates it with set_mynt_ramp" };
    if (!opts.admin && (await entityOf()) !== ramp) return { error: "Only the firm that operates the Mynt Ramp (or an admin) does this" };
    return ramp;
  };

  server.registerTool(
    "set_ramp_adapter",
    {
      title: "Run the ramp partner through an adapter",
      description: `Mynt Ramp firm or admin: answer a ramp offering through an adapter in front of the partner's own API, instead of the partner implementing Mynt's vendor wire contract. The offering's test_base_url and live_base_url are then the partner's API (for Bridge: https://api.sandbox.bridge.xyz and https://api.bridge.xyz). Credentials go sealed into the ramp firm's key vault and are never shown again; a credential left out keeps the one set. Setting it sends the offering back to draft: run_conformance again. Adapters: ${RAMP_ADAPTER_IDS.join(", ")}. adapter: null goes back to the wire contract.`,
      inputSchema: {
        offering_id: z.string().uuid(),
        adapter: z.enum(RAMP_ADAPTER_IDS).nullable(),
        config: z.record(z.string().max(64), z.string().max(4000)).default({}).describe("The adapter's non-secret settings (see the result's config_fields)"),
        test_credential: z.string().min(1).max(4000).optional().describe("The partner's sandbox API key"),
        live_credential: z.string().min(1).max(4000).optional().describe("The partner's production API key"),
      },
    },
    async ({ offering_id, adapter, config, test_credential, live_credential }) => {
      const firm = await rampFirm();
      if (typeof firm !== "string") return fail(firm.error);
      const o = await getOffering(store.db, offering_id);
      const t = o && (await serviceType(store.db, o.region, o.service_type));
      if (!o || !t || o.entity_id !== firm) return fail(`No ramp offering '${offering_id}' of the Mynt Ramp firm`);
      if (t.category !== "ramp" || !(t.key in QUOTE_KEYS || t.key in TRANSFER_KEYS)) return fail(`Adapters answer the Mynt Ramp's service types (${[...Object.keys(QUOTE_KEYS), ...Object.keys(TRANSFER_KEYS)].join(", ")}), not '${t.key}'`);
      const row = (await adapterRow(store, o.id))!;
      if (adapter === null) {
        await store.db.query(
          `UPDATE ${T}.vendor_offerings SET adapter = NULL, adapter_config = NULL, adapter_test_key_id = NULL, adapter_live_key_id = NULL,
             status = CASE WHEN status = 'suspended' THEN status ELSE 'draft' END, updated_at = now() WHERE id = $1`,
          [o.id],
        );
        for (const k of [row.adapter_test_key_id, row.adapter_live_key_id]) if (k) await store.db.query(`DELETE FROM ${T}.key_vault WHERE id = $1`, [k]);
        await audit("set_ramp_adapter", o.id, { adapter: null });
        return json({ offering_id: o.id, adapter: null, status: "draft", next: "run_conformance" });
      }
      const a = RAMP_ADAPTERS[adapter];
      const problems = [...a.configProblems(config), ...a.environmentProblems({ test_base_url: o.test_base_url, live_base_url: o.live_base_url, test_credential, live_credential })];
      if (problems.length) return fail("The adapter's settings aren't valid", { problems, config_fields: a.config_fields });
      if ((test_credential || live_credential) && !vaultAvailable(false)) return fail("This server's vault key (MYNT_VAULT_KEY) isn't configured, so it can't keep credentials");
      const keep = async (value: string | undefined, old: string | null, env: "test" | "live") => {
        if (!value) return old;
        const id = randomUUID();
        await store.db.query(`INSERT INTO ${T}.key_vault (id, entity_id, type, label, sealed, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [
          id,
          o.entity_id,
          env === "test" ? "ramp_partner_test_credential" : "ramp_partner_live_credential",
          `${a.name} ${env === "test" ? "sandbox" : "production"} API key (${o.service_type})`,
          seal(value, false),
          user.id,
        ]);
        return id;
      };
      const testKey = await keep(test_credential, row.adapter_test_key_id, "test");
      const liveKey = await keep(live_credential, row.adapter_live_key_id, "live");
      await store.db.query(
        `UPDATE ${T}.vendor_offerings SET adapter = $2, adapter_config = $3, adapter_test_key_id = $4, adapter_live_key_id = $5,
           status = CASE WHEN status = 'suspended' THEN status ELSE 'draft' END, updated_at = now() WHERE id = $1`,
        [o.id, adapter, JSON.stringify(config), testKey, liveKey],
      );
      for (const [old, now] of [
        [row.adapter_test_key_id, testKey],
        [row.adapter_live_key_id, liveKey],
      ])
        if (old && old !== now) await store.db.query(`DELETE FROM ${T}.key_vault WHERE id = $1`, [old]);
      // Never the credentials, in the audit log or the answer.
      await audit("set_ramp_adapter", o.id, { adapter, config_keys: Object.keys(config), test_credential_set: !!test_credential, live_credential_set: !!live_credential });
      const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, "");
      return json({
        offering_id: o.id,
        adapter,
        docs: a.docs,
        config,
        config_fields: a.config_fields,
        credentials: { test: testKey ? { key_id: testKey } : null, live: liveKey ? { key_id: liveKey } : null },
        ...(publicUrl ? { webhook_urls: { test: `${publicUrl}${RAMP_ADAPTER_WEBHOOK_PATH}${o.id}/webhook/test`, live: `${publicUrl}${RAMP_ADAPTER_WEBHOOK_PATH}${o.id}/webhook/live` } } : {}),
        status: o.status === "suspended" ? "suspended" : "draft",
        next: "run_conformance",
      });
    },
  );

  server.registerTool(
    "link_ramp_partner_customer",
    {
      title: "Link a customer to the ramp partner",
      description:
        "Mynt Ramp firm or admin: complete a link a customer asked for from their own session (ramp_link.requested gives its link_reference), once the partner has onboarded them. Mynt reads the partner's identity for partner_customer_id through the adapter and links only if it matches the name (and date of birth, when both have one) the customer gave Mynt; otherwise the request is refused. Transfers, and the payout account, are used only for a verified link. You never see the developer's customer reference.",
      inputSchema: {
        link_reference: z.string().uuid(),
        partner_customer_id: z.string().min(1).max(200),
        partner_payout_account_id: z.string().min(1).max(200).optional().describe("Needed to cash out to the customer's bank"),
      },
    },
    async ({ link_reference, partner_customer_id, partner_payout_account_id }) => {
      const firm = await rampFirm();
      if (typeof firm !== "string") return fail(firm.error);
      const { rows } = await store.db.query(`SELECT * FROM ${T}.ramp_link_requests WHERE id = $1 AND entity_id = $2`, [link_reference, firm]);
      const req = rows[0] as { id: string; app_id: string; customer_ref: string; sandbox: boolean; status: string; created_at: string | Date } | undefined;
      if (!req) return fail(`No link request '${link_reference}' for the Mynt Ramp`);
      if (req.status !== "requested") return fail(`This link request is already ${req.status}`);
      if (Date.now() - new Date(req.created_at).getTime() > linkExpiryHours() * 3600_000) {
        await store.db.query(`UPDATE ${T}.ramp_link_requests SET status = 'expired', decided_at = now() WHERE id = $1 AND status = 'requested'`, [req.id]);
        return fail("This link request has expired; the customer asks again from their app", { refusal: "expired" });
      }
      const environment = req.sandbox ? "test" : "live";
      // Any of the ramp firm's adapter offerings reaches the partner for this environment.
      const { rows: offs } = await store.db.query(`SELECT id FROM ${T}.vendor_offerings WHERE entity_id = $1 AND adapter IS NOT NULL AND status <> 'suspended' ORDER BY created_at`, [firm]);
      let identity: RampPartnerIdentity | null = null;
      let adapterId: string | null = null;
      let adapterOffering: string | null = null;
      let payoutOk: boolean | null = partner_payout_account_id ? false : null;
      for (const { id } of offs) {
        const o = await getOffering(store.db, id as string);
        const row = o && (await adapterRow(store, o.id));
        if (!o || !row) continue;
        const c = await contextFor(store, o, row, environment, vendorOpts);
        if ("error" in c) continue;
        const got = await c.adapter.customerIdentity(c.ctx, partner_customer_id);
        if (isRampError(got)) return fail(`The ramp partner couldn't confirm that customer (${got.error.code})`);
        identity = got;
        adapterId = c.adapter.id;
        adapterOffering = o.id;
        // The payout account must be this partner customer's own.
        if (partner_payout_account_id) {
          const owns = await c.adapter.payoutAccountOf(c.ctx, partner_customer_id, partner_payout_account_id);
          if (isRampError(owns)) return fail(`The ramp partner couldn't confirm that payout account (${owns.error.code})`);
          payoutOk = owns;
        }
        break;
      }
      if (!identity) return fail(`No adapter offering of the Mynt Ramp reaches the partner's ${environment} environment`);
      const held = Object.fromEntries(
        (await store.vaultFields(req.app_id, req.customer_ref, req.sandbox)).filter((h) => h.field === "full_name" || h.field === "date_of_birth").map((h) => [h.field, open(h.sealed, req.sandbox)]),
      );
      const refuse = async (why: string, message: string) => {
        await store.db.query(`UPDATE ${T}.ramp_link_requests SET status = 'refused', refusal = $2, decided_at = now() WHERE id = $1 AND status = 'requested'`, [req.id, why]);
        await audit("link_ramp_partner_customer", req.id, { environment, linked: false, refusal: why });
        return fail(message, { refusal: why });
      };
      const mismatch = identityProblem(held, identity, environment);
      if (mismatch) return refuse("identity_mismatch", mismatch);
      if (payoutOk === false) return refuse("payout_account_mismatch", "That payout account isn't the partner customer's own");
      const key = rampCustomerKey(req.app_id, req.customer_ref);
      // One partner customer is one Mynt customer.
      const { rows: taken } = await store.db.query(
        `SELECT 1 FROM ${T}.ramp_partner_links WHERE entity_id = $1 AND environment = $2 AND partner_customer_id = $3 AND customer_key <> $4 AND identity_verified_at IS NOT NULL`,
        [firm, environment, partner_customer_id, key],
      );
      if (taken.length) return refuse("partner_customer_already_linked", "That partner customer is already linked to another customer");
      // Claim the request: of two completions at once, exactly one goes through.
      const { rows: claimed } = await store.db.query(`UPDATE ${T}.ramp_link_requests SET status = 'linked', decided_at = now() WHERE id = $1 AND status = 'requested' RETURNING id`, [req.id]);
      if (!claimed.length) return fail("This link request was decided by another call just now");
      try {
        await store.db.query(
          `INSERT INTO ${T}.ramp_partner_links (entity_id, environment, customer_key, partner_customer_id, partner_payout_account_id, link_request_id, identity_verified_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (entity_id, environment, customer_key) DO UPDATE SET partner_customer_id = EXCLUDED.partner_customer_id,
             partner_payout_account_id = EXCLUDED.partner_payout_account_id, link_request_id = EXCLUDED.link_request_id, identity_verified_at = now(), updated_at = now()`,
          [firm, environment, key, partner_customer_id, partner_payout_account_id ?? null, req.id],
        );
      } catch {
        // The unique index caught a race on the same partner customer.
        await store.db.query(`UPDATE ${T}.ramp_link_requests SET status = 'refused', refusal = 'partner_customer_already_linked' WHERE id = $1`, [req.id]);
        return fail("That partner customer is already linked to another customer", { refusal: "partner_customer_already_linked" });
      }
      // The partner's own record of where the customer lives, when it gives one: what a live movement goes by.
      const stateVerified = environment === "live" && adapterId && adapterOffering
        ? await recordVerifiedCustomerState(store, { app_id: req.app_id, customer_ref: req.customer_ref, offering_id: adapterOffering, state: identity.residential_state, source: "ramp_link", verified_by_entity: firm, verified_by: adapterId, verified_at: identity.verified_at ?? new Date(), identity_fields: LINK_IDENTITY_FIELDS, identity_digest: identityDigest(held, LINK_IDENTITY_FIELDS), started_at: req.created_at })
        : false;
      await audit("link_ramp_partner_customer", req.id, { environment, linked: true, state_verified: stateVerified, payout_account: !!partner_payout_account_id });
      return json({ link_reference: req.id, environment, linked: true, identity: "verified", payout_account: !!partner_payout_account_id });
    },
  );
}
