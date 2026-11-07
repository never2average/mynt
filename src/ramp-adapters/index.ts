import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store, User } from "../store.js";
import { derivedKey, open, seal, vaultAvailable } from "../vault.js";
import { safeRequest, signBody, type VendorCallOptions, type VendorResult } from "../vendor-call.js";
import { getOffering, myntRampEntity, serviceType, vendorCallback, type Offering } from "../vendors.js";
import { bridgeAdapter } from "./bridge.js";
import { isRampError, type PartnerHttp, type RampAdapter, type RampAdapterContext, type RampDirection, type RampPrice, type RampTransferUpdate } from "./types.js";

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
  return { adapter, ctx: { environment, config: row.adapter_config ?? {}, http: partnerHttp(adapter, base, credential, opts), now: () => new Date() } };
}

// ---- Mynt's quote, for a partner with no quote that locks a price ----

const b64 = (s: string) => Buffer.from(s).toString("base64url");
// Signed with a key derived from MYNT_VAULT_KEY for the ramp firm, so its quote offering's quote is good at its
// transfer offering, and nowhere else.
const quoteMac = (secret: Buffer, payload: string) => createHmac("sha256", secret).update(`mynt-ramp-quote.${payload}`).digest("hex").slice(0, 32);
const quoteKey = (entityId: string, environment: string) => derivedKey(`ramp-quote:${entityId}:${environment}`);
// Compact, so it fits the wire contract's 200 characters: the service, the dollar amounts, the expiry and a nonce.
function issueQuote(secret: Buffer, key: string, price: RampPrice, expiresAt: Date): string {
  const fields = [key, price.amount_usd, price.fee_usd, price.total_usd, price.settlement_amount, price.estimated_arrival ?? "", expiresAt.getTime(), randomBytes(4).toString("hex")];
  const payload = b64(JSON.stringify(fields));
  return `maq.${payload}.${quoteMac(secret, payload)}`;
}
function readQuote(secret: Buffer, id: string): { k: string; p: RampPrice; e: number } | null {
  const m = /^maq\.([A-Za-z0-9_-]{1,160})\.([0-9a-f]{32})$/.exec(id);
  if (!m || !timingSafeEqual(Buffer.from(quoteMac(secret, m[1])), Buffer.from(m[2]))) return null;
  try {
    const [k, amount_usd, fee_usd, total_usd, settlement_amount, arrival, e] = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
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
  const error = (code: string, message: string) => answer(200, { request_id: body.request_id, status: "error", output: null, error: { code, message } });
  if (body.environment !== environment) return error("wrong_environment", "The request's environment doesn't match the endpoint");
  const conformance = signer.subscription_id === null || body.consent?.artefact_ref === "mynt_conformance";
  const c = await contextFor(store, o, row, environment, opts);
  if ("error" in c) return error(c.error, c.error === "adapter_missing" ? "This offering's adapter isn't available" : "The ramp partner's credential for this environment isn't set");
  const { adapter, ctx } = c;
  // Conformance proves the partner answers Mynt with this credential, without moving money.
  if (conformance) {
    const probe = await adapter.probe(ctx);
    if (probe) return error(probe.error.code, probe.error.message);
  }

  const qKey = quoteKey(o.entity_id, environment);
  if (!qKey) return error("vault_not_configured", "This server can't sign quotes (MYNT_VAULT_KEY isn't set)");
  if (key in QUOTE_KEYS) {
    const direction = QUOTE_KEYS[key];
    if (body.params?.direction !== direction) return error("invalid_params", `${key} is direction '${direction}'`);
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
  const q = readQuote(qKey, body.quote?.quote_id ?? "");
  if (!q || q.k !== t.quote) return error("unknown_quote", "That quote wasn't issued for this service");
  if (q.e <= Date.now()) return error("quote_expired", "That quote has expired");
  if (!customerKey) return error("customer_unknown", "Mynt didn't say which customer this is");
  const env = environment;
  const { rows: links } = await store.db.query(`SELECT partner_customer_id, partner_payout_account_id FROM ${T}.ramp_partner_links WHERE entity_id = $1 AND environment = $2 AND customer_key = $3`, [
    o.entity_id,
    env,
    customerKey,
  ]);
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
  if (isRampError(done)) return error(done.error.code, done.error.message);
  await store.db.query(
    `INSERT INTO ${T}.ramp_adapter_transfers (offering_id, environment, partner_transfer_id, subscription_id, request_id, direction, status, partner_side)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (offering_id, environment, partner_transfer_id) DO UPDATE SET subscription_id = EXCLUDED.subscription_id, request_id = EXCLUDED.request_id, status = EXCLUDED.status,
       partner_side = EXCLUDED.partner_side, updated_at = now()`,
    [o.id, env, done.partner_transfer_id, signer.subscription_id, body.request_id, t.direction, done.status, JSON.stringify(done.partner_side ?? {})],
  );
  return answer(200, { request_id: body.request_id, status: "ok", output: outputOf(done, t.direction) });
}

// A transfer update as the service type's output: dollars for the customer, the rest partner-side.
const outputOf = (u: RampTransferUpdate, direction: RampDirection) => ({
  transfer_status: u.status,
  estimated_arrival: u.estimated_arrival,
  ...(direction === "in"
    ? { pay_to_bank_name: u.pay_to?.bank_name ?? null, pay_to_account_number: u.pay_to?.account_number ?? null, pay_to_routing_number: u.pay_to?.routing_number ?? null, pay_to_reference: u.pay_to?.reference ?? null }
    : {}),
  settlement_ref: u.settlement_ref,
  settlement_tx: u.settlement_tx,
});

// A partner's update for a transfer Mynt started: once it's final, Mynt's run ends through the same signed callback
// a partner speaking the contract would send.
async function applyUpdate(store: Store, offeringId: string, environment: "test" | "live", u: RampTransferUpdate): Promise<"unknown" | "open" | "finished"> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.ramp_adapter_transfers WHERE offering_id = $1 AND environment = $2 AND partner_transfer_id = $3`, [offeringId, environment, u.partner_transfer_id]);
  const tr = rows[0] as { subscription_id: string; request_id: string; direction: RampDirection; status: string } | undefined;
  if (!tr) return "unknown";
  await store.db.query(`UPDATE ${T}.ramp_adapter_transfers SET status = $4, updated_at = now() WHERE offering_id = $1 AND environment = $2 AND partner_transfer_id = $3`, [
    offeringId,
    environment,
    u.partner_transfer_id,
    u.status,
  ]);
  if (u.status === "submitted") return "open";
  const { rows: s } = await store.db.query(`SELECT signing_secret FROM ${T}.vendor_subscriptions WHERE id = $1`, [tr.subscription_id]);
  if (!s[0]) return "unknown";
  const cb = JSON.stringify({ request_id: tr.request_id, status: "ok", output: outputOf(u, tr.direction) });
  await vendorCallback(store, tr.subscription_id, cb, signBody(open(s[0].signing_secret as string, false), cb));
  return "finished";
}

// POST /v1/ramp-adapters/<offering_id>/webhook/<test|live>: the partner's webhook, verified with its own scheme.
export async function rampAdapterWebhook(store: Store, req: IncomingMessage, res: ServerResponse, url: URL) {
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const m = /^\/v1\/ramp-adapters\/([0-9a-f-]{36})\/webhook\/(test|live)$/.exec(url.pathname);
  if (!m) return reply(404, { error: "not_found" });
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > 256 * 1024) return reply(413, { error: "too_large" });
  }
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
  const applied = await applyUpdate(store, o.id, environment, event.update);
  return reply(200, { received: true, ...(applied === "unknown" ? { ignored: true } : {}) });
}

// Reads the state of adapter transfers still open (a missed or delayed webhook) and ends the ones that finished.
export async function pollRampAdapterTransfers(store: Store, opts: VendorCallOptions = {}, o: { olderThanSeconds?: number; limit?: number } = {}): Promise<number> {
  const { rows } = await store.db.query(
    `SELECT * FROM ${T}.ramp_adapter_transfers WHERE status = 'submitted' AND updated_at <= now() - make_interval(secs => $1) ORDER BY updated_at LIMIT $2`,
    [o.olderThanSeconds ?? 120, o.limit ?? 50],
  );
  let n = 0;
  for (const r of rows as { offering_id: string; environment: "test" | "live"; partner_transfer_id: string; direction: RampDirection }[]) {
    const off = await getOffering(store.db, r.offering_id);
    const row = off && (await adapterRow(store, off.id));
    if (!off || !row) continue;
    const c = await contextFor(store, off, row, r.environment, opts);
    if ("error" in c) continue;
    const u = await c.adapter.status(c.ctx, r.partner_transfer_id, r.direction);
    if (isRampError(u)) {
      await store.db.query(`UPDATE ${T}.ramp_adapter_transfers SET updated_at = now() WHERE offering_id = $1 AND environment = $2 AND partner_transfer_id = $3`, [r.offering_id, r.environment, r.partner_transfer_id]);
      continue;
    }
    if ((await applyUpdate(store, r.offering_id, r.environment, u)) === "finished") n++;
  }
  return n;
}

// ---- tools: the ramp firm (or an admin) plugs its partner in ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });

export function registerRampAdapterTools(server: McpServer, store: Store, user: User, opts: { admin?: boolean } = {}) {
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
      const problems = a.configProblems(config);
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
        "Mynt Ramp firm or admin: record the ramp partner's own ids for one app's customer, once the partner has onboarded them (its KYC, terms and the payout bank account it registered). Adapters need them to start a transfer for that customer. Mynt files them under a pseudonymous key, never the customer's reference.",
      inputSchema: {
        app_id: z.string().uuid(),
        customer_ref: z.string().min(1).max(200),
        environment: z.enum(["test", "live"]),
        partner_customer_id: z.string().min(1).max(200),
        partner_payout_account_id: z.string().min(1).max(200).optional().describe("Needed to cash out to the customer's bank"),
      },
    },
    async ({ app_id, customer_ref, environment, partner_customer_id, partner_payout_account_id }) => {
      const firm = await rampFirm();
      if (typeof firm !== "string") return fail(firm.error);
      const key = rampCustomerKey(app_id, customer_ref);
      await store.db.query(
        `INSERT INTO ${T}.ramp_partner_links (entity_id, environment, customer_key, partner_customer_id, partner_payout_account_id) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (entity_id, environment, customer_key) DO UPDATE SET partner_customer_id = EXCLUDED.partner_customer_id,
           partner_payout_account_id = COALESCE(EXCLUDED.partner_payout_account_id, ${T}.ramp_partner_links.partner_payout_account_id), updated_at = now()`,
        [firm, environment, key, partner_customer_id, partner_payout_account_id ?? null],
      );
      await audit("link_ramp_partner_customer", key, { environment, payout_account: !!partner_payout_account_id });
      return json({ customer_key: key, environment, linked: true });
    },
  );
}
