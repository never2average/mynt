import { randomUUID } from "node:crypto";
import { EDGE_KEY_HEADER, EDGE_PLACEHOLDER } from "./freestyle.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { APP_EVENT_TYPES, appProducts, buildTerms, HANDOFF_ACTIONS, resolveHandoff } from "./runtime.js";
import type { DeveloperContract } from "./contract.js";
import type { HostingService } from "./hosting.js";
import { egressFor } from "./hosting-tools.js";
import { DATA_DICTIONARY } from "./data-dictionary.js";
import { masked, open, sandboxPrefill, seal, validateValue, vaultAvailable } from "./vault.js";
import type { ApiKey, App, ProductRecord, Store } from "./store.js";

// The runtime REST API under /v1, for developers' shipped apps. Authenticated with a per-app key
// (Authorization: Bearer mynt_live_… / mynt_test_…), read-only over products, plus hand-offs to
// the innovator's own flow and analytics events. It never takes or returns consumer financial data.
//
// Keys belong on the app's server. A customer's browser or phone gets a client session instead: the
// server mints it (POST /v1/client_sessions) for one customer, some products and some client-safe
// contract actions, for at most an hour, and the device calls /v1/client/* with its mcs_… secret: the
// contract's offers, the provider-hosted actions (only once their consent is recorded), and evidence of
// what was shown and agreed.

export interface RuntimeApiOptions {
  publicUrl?: string; // origin used for sandbox hand-off URLs (default PUBLIC_URL, else the Host header)
  rateLimit?: { capacity: number; perMinute: number }; // per key (default 60 a minute)
  maxBodyBytes?: number; // default 16 KiB
  hosting?: HostingService | null; // tenant VMs register and fetch their policy here
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

// Token bucket per key: `capacity` requests at once, refilled at `perMinute`.
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private capacity: number,
    private perMinute: number,
  ) {}

  // 0 if allowed, else seconds until the next request would be.
  take(key: string, now = Date.now()): number {
    const msPerToken = 60_000 / this.perMinute;
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.at) / msPerToken);
    b.at = now;
    if (this.buckets.size > 10_000) for (const [k, v] of this.buckets) if (v.tokens >= this.capacity) this.buckets.delete(k);
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil(((1 - b.tokens) * msPerToken) / 1000));
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  if (Number(req.headers["content-length"] ?? 0) > limit) throw new ApiError(413, "payload_too_large", `Request bodies are limited to ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, "payload_too_large", `Request bodies are limited to ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_json", "The request body must be JSON");
  }
}

const parse = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError(400, "invalid_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
};

// The app's own opaque id for its user: short, and not a phone, account or card number.
const consumerRef = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use your own opaque id (letters, digits, _ and -, up to 64)")
  .refine((v) => !/\d{9,}/.test(v), "Looks like a phone, account or card number; send an opaque id, never personal or financial data");

const HandoffBody = z.object({ product_id: z.string().min(1).max(100), action: z.enum(HANDOFF_ACTIONS), consumer_ref: consumerRef.optional() }).strict();
const EventBody = z
  .object({
    type: z.enum(APP_EVENT_TYPES),
    product_id: z.string().min(1).max(100),
    screen: z.string().regex(/^[A-Za-z0-9 _./:-]{1,100}$/, "A screen name, up to 100 characters").optional(),
  })
  .strict();
const SandboxOutcome = z.object({ outcome: z.enum(["completed", "failed"]) }).strict();
const ActionId = z.string().regex(/^[a-z][a-z0-9_]*$/);
const ClientSessionBody = z
  .object({
    product_ids: z.array(z.string().min(1).max(100)).min(1).max(20),
    scopes: z.array(ActionId).max(50).default(["view_offers"]),
    customer_ref: consumerRef.optional(),
    ttl_seconds: z.number().int().min(60).max(3600).default(1800),
  })
  .strict();
const ClientActionBody = z.object({ product_id: z.string().min(1).max(100) }).strict();
const EvidenceBody = z
  .object({
    product_id: z.string().min(1).max(100),
    type: z.enum(["disclosure_shown", "consent_given", "consent_withdrawn"]),
    subject: z.string().min(1).max(100).describe("A document key from the contract, or a consent purpose"),
    content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  })
  .strict();
const FieldsBody = z
  .object({
    product_id: z.string().min(1).max(100),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    source: z.enum(["typed", "secure_field", "document_upload"]).default("typed"),
  })
  .strict();
const PrefillBody = z
  .object({
    product_id: z.string().min(1).max(100),
    source: z.enum(["account_aggregator", "digilocker", "ckyc"]),
    fields: z.array(z.string()).min(1).max(30),
  })
  .strict();
// Actions a customer's device may start: those the contract marks client or either.
const clientActions = (c: DeveloperContract) => c.actions.filter((a) => a.surface === "client" || a.surface === "either");

// A product as the API shows it: its fields, live version, and build terms (the innovator's
// hand-off URL is used through POST /v1/handoffs, not handed out).
const productView = (r: ProductRecord) => {
  const { handoff_url, ...terms } = buildTerms(r);
  return { ...r.product, version: r.version, build_terms: terms };
};

export function createRuntimeApi(store: Store, opts: RuntimeApiOptions = {}) {
  const limiter = new RateLimiter(opts.rateLimit?.capacity ?? 60, opts.rateLimit?.perMinute ?? 60);
  const maxBody = opts.maxBodyBytes ?? 16 * 1024;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };

  const authenticate = async (req: IncomingMessage): Promise<{ key: ApiKey; app: App }> => {
    const auth = req.headers.authorization;
    let secret = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    // A Mynt-hosted app: its key arrives in the header the edge adds, and only counts with the placeholder bearer
    // of the same environment.
    const placeholder = EDGE_PLACEHOLDER.exec(secret);
    if (placeholder) {
      const injected = req.headers[EDGE_KEY_HEADER];
      secret = typeof injected === "string" ? injected.trim() : "";
      if (!secret.startsWith(`mynt_${placeholder[1]}_`))
        throw new ApiError(401, "unauthorized", "That placeholder key only works from a Mynt-hosted app", { "WWW-Authenticate": "Bearer" });
    }
    if (!/^mynt_(live|test)_/.test(secret)) throw new ApiError(401, "unauthorized", "Send your app's API key as Authorization: Bearer mynt_…", { "WWW-Authenticate": "Bearer" });
    const found = await store.apiKeyBySecret(secret);
    if (!found) throw new ApiError(401, "invalid_key", "The API key is unknown or revoked", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
    return found;
  };

  // /v1/client/*: a customer's device, on a client session.
  const clientRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    method: string,
    cors: Record<string, string>,
    allow: (methods: string) => void,
  ) => {
    const auth = req.headers.authorization;
    const secret = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!/^mcs_(live|test)_/.test(secret))
      throw new ApiError(401, "unauthorized", "Send the client_secret your server created as Authorization: Bearer mcs_…", { "WWW-Authenticate": "Bearer" });
    const found = await store.clientSessionBySecret(secret);
    if (!found) throw new ApiError(401, "session_expired", "The client session is unknown, revoked or expired; ask your server for a new one", { "WWW-Authenticate": 'Bearer error="invalid_token"' });
    const { session, key, app } = found;
    const origin = req.headers.origin;
    if (origin) {
      if (!key.allowed_origins.includes(origin)) throw new ApiError(403, "origin_not_allowed", `Origin ${origin} isn't allowed for this app's key`);
      Object.assign(cors, { "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    }
    const wait = limiter.take(`session:${session.id}`);
    if (wait) throw new ApiError(429, "rate_limited", "Too many requests for this session", { "Retry-After": String(wait) });
    if (!session.sandbox && app.status !== "published") throw new ApiError(403, "app_not_published", "Live sessions work once the app is published");

    type Contracted = ProductRecord & { pins: { contract: DeveloperContract } };
    const inSession = async (productId: string): Promise<Contracted> => {
      if (!session.product_ids.includes(productId)) throw new ApiError(403, "product_not_in_session", `'${productId}' isn't part of this client session`);
      const record = (await appProducts(store, app)).find((r) => r.product.id === productId);
      if (!record?.pins?.contract) throw new ApiError(404, "product_not_found", `Product '${productId}' isn't available to this app`);
      return record as Contracted;
    };

    // Consent purposes whose latest evidence in this session is a grant.
    const activeConsents = async (productId: string) => {
      const latest = new Map<string, string>();
      for (const e of await store.clientEvidence(app.id, 1000))
        if (e.session_id === session.id && e.product_id === productId && e.type !== "disclosure_shown" && !latest.has(e.subject)) latest.set(e.subject, e.type);
      return new Set([...latest].filter(([, t]) => t === "consent_given").map(([p]) => p));
    };
    // The dictionary fields a product's client actions need: the only ones a device may store for it.
    const neededFields = (c: DeveloperContract) =>
      new Set(clientActions(c).flatMap((a) => (a.data_requirements ?? []).filter((r) => r.known).map((r) => r.field)));
    const requireCustomer = () => {
      if (!session.customer_ref) throw new ApiError(400, "customer_ref_required", "Create the client session with a customer_ref to keep this customer's data");
      if (!vaultAvailable(session.sandbox)) throw new ApiError(503, "vault_not_configured", "The customer vault isn't configured on this deployment");
      return session.customer_ref;
    };

    if (path === "/v1/client/fields") {
      allow("GET, POST, DELETE");
      const customer = requireCustomer();
      if (method === "GET") {
        const held = await store.vaultFields(app.id, customer, session.sandbox);
        return send(res, 200, { fields: held.map((h) => ({ field: h.field, source: h.source, value: masked(h.field, open(h.sealed, session.sandbox)), updated_at: h.updated_at })) }, cors);
      }
      if (method === "DELETE") {
        const erased = await store.eraseVault(app.id, customer, session.sandbox);
        return send(res, 200, { erased }, cors);
      }
      const body = parse(FieldsBody, await readJson(req, maxBody));
      const record = await inSession(body.product_id);
      const needed = neededFields(record.pins.contract);
      const consents = await activeConsents(record.product.id);
      const problems: string[] = [];
      for (const [field, value] of Object.entries(body.values)) {
        const f = DATA_DICTIONARY[field];
        const invalid = validateValue(field, value);
        if (invalid) problems.push(invalid);
        else if (!needed.has(field)) problems.push(`${field}: no action of '${record.product.id}' needs it`);
        else if (f.sensitivity !== "public" && !consents.size) problems.push(`${field}: record the customer's consent first`);
        else if (f.sensitivity === "sensitive" && body.source === "typed") problems.push(`${field} is sensitive: send it from a secure field`);
        else if (!f.capture.includes(body.source)) problems.push(`${field} can't be captured by ${body.source}`);
      }
      if (problems.length) throw new ApiError(400, "invalid_fields", problems.join("; "));
      for (const [field, value] of Object.entries(body.values))
        await store.putVaultField({ app_id: app.id, customer_ref: customer, sandbox: session.sandbox, field, sealed: seal(String(value).trim(), session.sandbox), source: body.source });
      return send(res, 201, { stored: Object.keys(body.values) }, cors);
    }
    if (path === "/v1/client/prefill") {
      allow("POST");
      const customer = requireCustomer();
      const body = parse(PrefillBody, await readJson(req, maxBody));
      const record = await inSession(body.product_id);
      if (!(await activeConsents(record.product.id)).size) throw new ApiError(409, "consent_required", "Record the customer's consent before fetching their data");
      const needed = neededFields(record.pins.contract);
      const bad = body.fields.filter((f) => !needed.has(f) || !DATA_DICTIONARY[f]?.capture.includes(body.source));
      if (bad.length) throw new ApiError(400, "invalid_fields", `Can't prefill ${bad.join(", ")} from ${body.source} for '${record.product.id}'`);
      if (!session.sandbox) throw new ApiError(501, "connector_not_configured", `The ${body.source} connector isn't configured on this deployment yet`);
      const filled: string[] = [];
      for (const field of body.fields) {
        const value = sandboxPrefill(field, body.source);
        if (!value) continue;
        await store.putVaultField({ app_id: app.id, customer_ref: customer, sandbox: true, field, sealed: seal(value, true), source: body.source });
        filled.push(field);
      }
      return send(res, 201, { filled, missing: body.fields.filter((f) => !filled.includes(f)), sandbox: true }, cors);
    }

    if (path === "/v1/client/offers") {
      allow("GET");
      const records = await appProducts(store, app);
      const products = [];
      for (const id of session.product_ids) {
        const record = records.find((r) => r.product.id === id);
        if (!record?.pins?.contract) continue;
        const c = record.pins.contract;
        products.push({
          product_id: id,
          name: record.product.name,
          version: c.version,
          contract_hash: c.contract_hash,
          sales_paused: Boolean(record.drift),
          offers: c.offers,
          documents: c.documents,
          consent_purposes: c.consent_purposes,
          actions: clientActions(c).filter((a) => session.scopes.includes(a.id)),
        });
      }
      return send(res, 200, { products, expires_at: session.expires_at }, cors);
    }
    const action = path.match(/^\/v1\/client\/actions\/([a-z][a-z0-9_]*)$/);
    if (action) {
      allow("POST");
      const body = parse(ClientActionBody, await readJson(req, maxBody));
      const record = await inSession(body.product_id);
      const a = clientActions(record.pins.contract).find((x) => x.id === action[1]);
      if (!a || !session.scopes.includes(a.id)) throw new ApiError(403, "action_not_in_scope", `'${action[1]}' isn't a client action this session may start`);
      if (a.flow !== "hosted") throw new ApiError(400, "not_startable", `'${a.id}' isn't a hosted flow; read it from /v1/client/offers`);
      if (record.drift) throw new ApiError(409, "sales_paused", `New applications to '${record.product.id}' are paused`);
      // The consent the action needs must be recorded in this session, and not withdrawn since.
      if (a.consent_purpose) {
        const latest = (await store.clientEvidence(app.id, 1000)).find(
          (e) => e.session_id === session.id && e.product_id === record.product.id && e.subject === a.consent_purpose && e.type !== "disclosure_shown",
        );
        if (latest?.type !== "consent_given") throw new ApiError(409, "consent_required", `Record consent '${a.consent_purpose}' (POST /v1/client/evidence) before starting '${a.id}'`);
      }
      // The personal data the action sends must be held for this customer first.
      const required = (a.data_requirements ?? []).filter((r) => r.known && r.sensitivity !== "public" && !r.capture?.includes("derived")).map((r) => r.field);
      if (required.length) {
        const held = session.customer_ref ? new Set((await store.vaultFields(app.id, session.customer_ref, session.sandbox)).map((h) => h.field)) : new Set<string>();
        const missing = required.filter((f) => !held.has(f));
        if (missing.length) throw new ApiError(409, "data_required", `'${a.id}' needs ${missing.join(", ")} from the customer first (POST /v1/client/fields or /v1/client/prefill)`);
      }
      const id = randomUUID();
      let redirect: string;
      if (session.sandbox) {
        const base = opts.publicUrl ?? process.env.PUBLIC_URL ?? `http://${req.headers.host ?? "localhost"}`;
        redirect = `${base.replace(/\/+$/, "")}/v1/sandbox/handoffs/${id}`;
      } else {
        const terms = buildTerms(record);
        if (!terms.handoff_url) throw new ApiError(409, "handoff_not_configured", `'${record.product.id}' has no handoff_url yet`);
        const u = new URL(terms.handoff_url);
        u.searchParams.set("handoff_id", id);
        u.searchParams.set("app_id", app.id);
        u.searchParams.set("action", a.id);
        redirect = u.toString();
      }
      const h = await store.createHandoff({
        id,
        app_id: app.id,
        key_id: session.key_id,
        product_id: record.product.id,
        action: a.id,
        consumer_ref: session.customer_ref,
        sandbox: session.sandbox,
        redirect_url: redirect,
      });
      return send(res, 201, { handoff_id: h.id, redirect_url: h.redirect_url, action: a.id, sandbox: session.sandbox }, cors);
    }
    const journey = path.match(/^\/v1\/client\/journeys\/([a-z][a-z0-9_]*)$/);
    if (journey) {
      allow("GET");
      const saved = (await store.journeysOf(app.id)).find((j) => j.journey_id === journey[1]);
      if (!saved) throw new ApiError(404, "journey_not_found", `This app has no journey '${journey[1]}'`);
      const record = await inSession(saved.product_id);
      // Served only while it's built on the live contract; a new contract means re-checking it.
      if (record.pins.contract.contract_hash !== saved.contract_hash)
        throw new ApiError(409, "journey_outdated", `'${saved.journey_id}' was checked against an earlier contract of '${saved.product_id}'; the developer must check and save it again`);
      return send(res, 200, { ...saved.spec, contract_hash: saved.contract_hash }, cors);
    }
    if (path === "/v1/client/evidence") {
      allow("POST");
      const body = parse(EvidenceBody, await readJson(req, maxBody));
      const record = await inSession(body.product_id);
      const c = record.pins.contract;
      if (body.type === "disclosure_shown" && !(body.subject in c.documents))
        throw new ApiError(400, "unknown_document", `'${body.subject}' isn't a document of this product (documents: ${Object.keys(c.documents).join(", ") || "none"})`);
      if (body.type !== "disclosure_shown" && !c.consent_purposes.includes(body.subject))
        throw new ApiError(400, "unknown_purpose", `'${body.subject}' isn't a consent purpose of this product (${c.consent_purposes.join(", ") || "none"})`);
      const e = await store.recordClientEvidence({
        app_id: app.id,
        session_id: session.id,
        product_id: record.product.id,
        contract_hash: c.contract_hash,
        type: body.type,
        subject: body.subject,
        content_hash: body.content_hash ?? null,
        customer_ref: session.customer_ref,
        sandbox: session.sandbox,
      });
      return send(res, 201, { evidence_id: e.id, recorded_at: e.created_at }, cors);
    }
    throw new ApiError(404, "not_found", `No route ${method} ${url.pathname}`);
  };

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL, cors: Record<string, string>) => {
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/\/+$/, "");
    const allow = (methods: string) => {
      if (!methods.split(", ").includes(method)) throw new ApiError(405, "method_not_allowed", `Use ${methods}`, { Allow: methods });
    };

    // The page a sandbox redirect_url points at; it needs no key, and shows no app data.
    const sandboxPage = path.match(/^\/v1\/sandbox\/handoffs\/([^/]+)$/);
    if (sandboxPage && method === "GET") {
      const h = await store.getHandoff(sandboxPage[1]);
      if (!h?.sandbox) throw new ApiError(404, "not_found", "No such sandbox hand-off");
      return send(res, 200, {
        handoff_id: h.id,
        sandbox: true,
        status: h.status,
        message: "Simulated hand-off. Resolve it with the simulate_handoff tool or POST /v1/sandbox/handoffs/{id} with a sandbox key.",
      });
    }

    if (path.startsWith("/v1/client/")) return clientRoute(req, res, url, path, method, cors, allow);

    // Tenant VMs: a one-time registration, then their policy on their agent token.
    if (path === "/v1/hosting/bootstrap") {
      allow("POST");
      if (!opts.hosting?.enabled) throw new ApiError(404, "not_found", "Hosting isn't configured");
      const body = parse(z.object({ token: z.string().min(16).max(200), wg_public_key: z.string() }).strict(), await readJson(req, maxBody));
      let registered;
      try {
        registered = await opts.hosting.bootstrap(body.token, body.wg_public_key);
      } catch (e) {
        throw new ApiError(400, "invalid_request", (e as Error).message);
      }
      if (!registered) throw new ApiError(401, "invalid_token", "The bootstrap token is unknown, used or expired");
      return send(res, 201, registered);
    }
    if (path === "/v1/hosting/policy") {
      allow("GET");
      if (!opts.hosting) throw new ApiError(404, "not_found", "Hosting isn't configured");
      const auth = req.headers.authorization;
      const tenant = auth?.startsWith("Bearer ") ? await opts.hosting.tenantByAgent(auth.slice(7).trim()) : undefined;
      if (!tenant) throw new ApiError(401, "unauthorized", "Send the tenant's agent token", { "WWW-Authenticate": "Bearer" });
      const hosting = opts.hosting;
      return send(res, 200, await hosting.policy(tenant, (appId) => egressFor(store, hosting, appId)));
    }
    // The developer's commands for their VM: claimed by its agent, results posted back.
    const commandResult = /^\/v1\/hosting\/commands\/([0-9a-f-]{36})\/result$/.exec(path);
    if (path === "/v1/hosting/commands" || commandResult) {
      allow(commandResult ? "POST" : "GET");
      if (!opts.hosting) throw new ApiError(404, "not_found", "Hosting isn't configured");
      const auth = req.headers.authorization;
      const tenant = auth?.startsWith("Bearer ") ? await opts.hosting.tenantByAgent(auth.slice(7).trim()) : undefined;
      if (!tenant) throw new ApiError(401, "unauthorized", "Send the tenant's agent token", { "WWW-Authenticate": "Bearer" });
      if (!commandResult) return send(res, 200, { commands: await opts.hosting.claimCommands(tenant) });
      const body = parse(z.object({ exit_code: z.number().int().nullable(), output: z.string().max(200_000) }).strict(), await readJson(req, maxBody));
      if (!(await opts.hosting.finishCommand(tenant, commandResult[1], body.exit_code, body.output))) throw new ApiError(404, "not_found", "No running command with that id");
      return send(res, 200, { ok: true });
    }

    const { key, app } = await authenticate(req);
    const origin = req.headers.origin;
    if (origin) {
      if (!key.allowed_origins.includes(origin)) throw new ApiError(403, "origin_not_allowed", `Origin ${origin} isn't allowed for this key`);
      Object.assign(cors, { "Access-Control-Allow-Origin": origin, Vary: "Origin" });
    }
    const wait = limiter.take(key.id);
    if (wait) throw new ApiError(429, "rate_limited", "Too many requests for this key", { "Retry-After": String(wait) });
    const sandbox = key.environment === "sandbox";
    if (!sandbox && app.status !== "published") throw new ApiError(403, "app_not_published", "Live keys work once the app is published; use a sandbox key until then");

    const available = async (productId: string) => {
      const record = (await appProducts(store, app)).find((r) => r.product.id === productId);
      if (!record) throw new ApiError(404, "product_not_found", `Product '${productId}' isn't available to this app`);
      return record;
    };

    if (path === "/v1/client_sessions") {
      allow("POST");
      // Minting is server-to-server: a request from a browser would mean the key is in the browser.
      if (origin) throw new ApiError(403, "server_only", "Create client sessions from your server, never from a browser: send the client_secret to the device instead");
      const body = parse(ClientSessionBody, await readJson(req, maxBody));
      const allowed = new Set<string>();
      for (const id of body.product_ids) {
        const record = await available(id);
        if (!record.pins?.contract) throw new ApiError(409, "no_contract", `'${id}' has no developer contract yet (published without a v2 definition)`);
        for (const a of clientActions(record.pins.contract)) allowed.add(a.id);
      }
      const bad = body.scopes.filter((s) => !allowed.has(s));
      if (bad.length) throw new ApiError(400, "invalid_scope", `Not client actions of these products: ${bad.join(", ")} (client actions: ${[...allowed].join(", ")})`);
      const { session, secret } = await store.createClientSession({
        app_id: app.id,
        key_id: key.id,
        customer_ref: body.customer_ref ?? null,
        product_ids: [...new Set(body.product_ids)],
        scopes: [...new Set(body.scopes)],
        sandbox,
        ttl_seconds: body.ttl_seconds,
      });
      return send(res, 201, { client_secret: secret, session_id: session.id, expires_at: session.expires_at, product_ids: session.product_ids, scopes: session.scopes, sandbox });
    }
    const contractOf = path.match(/^\/v1\/products\/([^/]+)\/contract$/);
    if (contractOf) {
      allow("GET");
      const record = await available(decodeURIComponent(contractOf[1]));
      if (!record.pins?.contract) throw new ApiError(404, "no_contract", `'${record.product.id}' has no developer contract yet`);
      return send(res, 200, { ...record.pins.contract, sales_paused: Boolean(record.drift) }, cors);
    }
    if (path === "/v1/products") {
      allow("GET");
      return send(res, 200, { products: (await appProducts(store, app)).map(productView) }, cors);
    }
    const one = path.match(/^\/v1\/products\/([^/]+)$/);
    if (one) {
      allow("GET");
      return send(res, 200, productView(await available(decodeURIComponent(one[1]))), cors);
    }
    if (path === "/v1/handoffs") {
      allow("POST");
      const body = parse(HandoffBody, await readJson(req, maxBody));
      const record = await available(body.product_id);
      const terms = buildTerms(record);
      if (!terms.permitted_actions.includes(body.action))
        throw new ApiError(403, "action_not_permitted", `'${record.product.id}' doesn't permit ${body.action} (permitted: ${terms.permitted_actions.join(", ")})`);
      const id = randomUUID();
      let redirect: string;
      if (sandbox) {
        const base = opts.publicUrl ?? process.env.PUBLIC_URL ?? `http://${req.headers.host ?? "localhost"}`;
        redirect = `${base.replace(/\/+$/, "")}/v1/sandbox/handoffs/${id}`;
      } else {
        if (!terms.handoff_url)
          throw new ApiError(409, "handoff_not_configured", `'${record.product.id}' has no handoff_url yet; its innovator sets one in the build terms`);
        const u = new URL(terms.handoff_url);
        u.searchParams.set("handoff_id", id);
        u.searchParams.set("app_id", app.id);
        redirect = u.toString();
      }
      const h = await store.createHandoff({
        id,
        app_id: app.id,
        key_id: key.id,
        product_id: record.product.id,
        action: body.action,
        consumer_ref: body.consumer_ref ?? null,
        sandbox,
        redirect_url: redirect,
      });
      return send(res, 201, { handoff_id: h.id, redirect_url: h.redirect_url, sandbox }, cors);
    }
    if (path === "/v1/events") {
      allow("POST");
      const body = parse(EventBody, await readJson(req, maxBody));
      const record = await available(body.product_id);
      const id = await store.recordAppEvent({ app_id: app.id, product_id: record.product.id, type: body.type, screen: body.screen ?? null, sandbox });
      return send(res, 202, { accepted: true, event_id: id, sandbox }, cors);
    }
    if (sandboxPage) {
      allow("GET, POST");
      if (!sandbox) throw new ApiError(403, "sandbox_only", "Resolve sandbox hand-offs with a sandbox key");
      const body = parse(SandboxOutcome, await readJson(req, maxBody));
      const h = await store.getHandoff(sandboxPage[1]);
      if (!h?.sandbox || h.app_id !== app.id) throw new ApiError(404, "not_found", "No such sandbox hand-off for this app");
      const resolved = await resolveHandoff(store, h, body.outcome);
      if (!resolved) throw new ApiError(409, "already_resolved", `The hand-off is already ${h.status}`);
      return send(res, 200, resolved, cors);
    }
    throw new ApiError(404, "not_found", `No route ${method} ${url.pathname}`);
  };

  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const origin = req.headers.origin;
    // Preflights carry no key, so allow an origin that any active key lists; the request itself
    // is then checked against its own key's origins.
    if (req.method === "OPTIONS") {
      const headers: Record<string, string> = { Vary: "Origin" };
      if (origin && (await store.originAllowed(origin)))
        Object.assign(headers, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, DELETE",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "600",
        });
      return send(res, 204, undefined, headers);
    }
    const cors: Record<string, string> = {};
    try {
      await route(req, res, url, cors);
    } catch (e) {
      if (res.headersSent) throw e;
      if (!(e instanceof ApiError)) {
        console.error(e);
        return send(res, 500, { error: "internal_error", message: "Something went wrong on our side" }, cors);
      }
      // Don't keep the connection for the rest of an oversized body.
      send(res, e.status, { error: e.code, message: e.message }, { ...cors, ...e.headers, ...(e.status === 413 ? { Connection: "close" } : {}) });
    }
  };
}
