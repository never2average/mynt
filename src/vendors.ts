import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { licenseInForce } from "./access.js";
import { DATA_DICTIONARY, type CaptureMethod } from "./data-dictionary.js";
import { cryptoName, cryptoPropertyProblem, cryptoText, cryptoValue, DOLLARS_ONLY_RULE } from "./dollars-only.js";
import { EntityFactsSchema, partyActive, validateParty } from "./parties.js";
import { driftSweep } from "./pins.js";
import { normalizeModel } from "./regulatory.js";
import { checkWebhookUrl, emitFirmEvent, emitEvent, FIRM_WEBHOOK_EVENTS } from "./runtime.js";
import type { Db } from "./db.js";
import type { HeldLicense, ProductRecord, Store, User, VendorBinding } from "./store.js";
import { fixtureValue, open, seal, validateValue, vaultAvailable } from "./vault.js";
import { rampCustomerKey, serveRampAdapter } from "./ramp-adapters/index.js";
import { callVendor, resolveVendorUrl, signBody, type VendorCallOptions, type VendorResult } from "./vendor-call.js";

// Vendors: firms that offer standard services (identity, KYC, account data, bureau reports, e-sign,
// e-mandates…) which innovators plug into their products instead of each integrating them.
//
// Admins define each service type per region: one input and output contract (JSON Schema) every vendor in
// that region implements, the consent purpose it needs from the customer, the data dictionary fields its
// output fills, and the licence types the subscribing innovator and the vendor must hold (from the
// regulatory model). Vendors list offerings of a type; Mynt runs a conformance test against the vendor's
// test endpoint before an offering can be listed. Innovators subscribe their firm (the vendor joins their
// roster as a party), bind a product's partner handoff to the subscription, and Mynt calls the vendor at
// runtime: when an app asks to prefill a customer's data, and when a device starts the client action of a
// bound handoff (the vendor's result goes to the innovator; the device gets only the outcome the service type's
// client_result allows). Billing is between vendor and innovator: Mynt only counts calls.

// `ramp` is the Mynt Ramp's own category: fiat in and out of digital-asset liquidity, offered only by the one firm
// an admin designates as operating the Mynt Ramp (set_mynt_ramp), so every product shares the same ramp.
export const SERVICE_CATEGORIES = ["identity", "kyc", "account_data", "analytics", "credit_bureau", "documents", "esign", "mandate", "fraud", "ramp", "other"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];
// Types of key a firm's key vault holds.
export const KEY_TYPES = ["vendor_test_credential", "vendor_live_credential", "ramp_partner_test_credential", "ramp_partner_live_credential"] as const;
// The prefill source (POST /v1/client/prefill) a category of service answers.
export const PREFILL_SOURCE: Partial<Record<ServiceCategory, CaptureMethod>> = {
  kyc: "ckyc",
  documents: "digilocker",
  account_data: "account_aggregator",
  analytics: "account_aggregator",
};
// What a device may be told of a vendor-served action's outcome.
export const CLIENT_STATUSES = ["verified", "not_verified", "completed", "failed", "pending"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export interface ClientResult {
  status?: { from: string; map: Record<string, ClientStatus> }; // output property → device status
  fields: string[]; // output properties the device may see (never personal data)
  redirect: boolean; // whether the device gets the vendor's redirect_url (e-sign, e-mandate, DigiLocker)
}
export const SERVICE_TYPES_DIR = fileURLToPath(new URL("../schemas/service-types/", import.meta.url));

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });
const today = () => new Date().toISOString().slice(0, 10);
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

// ---- JSON Schema checks (the contracts are JSON Schema) ----

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (opts: object) => { compile: (s: object) => AjvValidate };
const addFormats = require("ajv-formats").default as (ajv: unknown) => void;
type AjvValidate = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
let ajv: InstanceType<typeof Ajv2020> | null = null;
const compiled = new Map<string, AjvValidate>();
function validator(schema: object): AjvValidate {
  const k = JSON.stringify(schema);
  let v = compiled.get(k);
  if (!v) {
    if (!ajv) {
      ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
    }
    v = ajv.compile(schema);
    if (compiled.size > 500) compiled.clear();
    compiled.set(k, v);
  }
  return v;
}
// Problems with `data` against `schema`, as paths and rules only (never the values: they may be a customer's).
export function schemaProblems(schema: object, data: unknown): string[] {
  const v = validator(schema);
  return v(data) ? [] : (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`).slice(0, 20);
}

// ---- records ----

export interface ServiceType {
  region: string;
  key: string;
  name: string;
  category: ServiceCategory;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  consent_purpose: string;
  fills: string[];
  innovator_licences: string[];
  vendor_licences: string[];
  fixtures: Record<string, unknown>[];
  client_result: ClientResult | null; // null: the device gets the status and a reference only
  params_schema: Record<string, unknown> | null; // what the device sends with each call (never customer data)
  params_fixture: Record<string, unknown> | null; // params for conformance
  quote: boolean; // a price quote: output carries quote_id and expires_at
  accepts: string | null; // the quote service type this one executes
  updated_at: string;
}
export type OfferingStatus = "draft" | "conformance_passed" | "listed" | "suspended";
export interface Offering {
  id: string;
  entity_id: string;
  region: string;
  service_type: string;
  name: string;
  test_base_url: string;
  live_base_url: string | null;
  price: { amount: number; currency: string; per: "call" };
  sla_notes: string;
  licence_ids: string[];
  requires_credential: boolean;
  adapter: string | null; // a ramp offering Mynt answers through an adapter in front of the partner's API (src/ramp-adapters/)
  status: OfferingStatus;
  status_note: string | null;
  created_at: string;
  updated_at: string;
}
export interface Subscription {
  id: string;
  offering_id: string;
  entity_id: string;
  party_id: string;
  party_created: boolean;
  live: boolean;
  test_credential_key_id: string | null; // sent to the test endpoint only
  live_credential_key_id: string | null; // sent to the live endpoint only
  status: "active" | "ended";
  secret_shown: boolean;
  created_at: string;
  ended_at: string | null;
}
type Row = Record<string, unknown>;
const toType = (r: Row): ServiceType => ({
  region: r.region as string,
  key: r.key as string,
  name: r.name as string,
  category: r.category as ServiceCategory,
  description: r.description as string,
  input_schema: r.input_schema as Record<string, unknown>,
  output_schema: r.output_schema as Record<string, unknown>,
  consent_purpose: r.consent_purpose as string,
  fills: r.fills as string[],
  innovator_licences: r.innovator_licences as string[],
  vendor_licences: r.vendor_licences as string[],
  fixtures: r.fixtures as Record<string, unknown>[],
  client_result: (r.client_result as ClientResult | null) ?? null,
  params_schema: (r.params_schema as Record<string, unknown> | null) ?? null,
  params_fixture: (r.params_fixture as Record<string, unknown> | null) ?? null,
  quote: (r.quote as boolean | null) ?? false,
  accepts: (r.accepts as string | null) ?? null,
  updated_at: iso(r.updated_at)!,
});
const toOffering = (r: Row): Offering => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  region: r.region as string,
  service_type: r.service_type as string,
  name: r.name as string,
  test_base_url: r.test_base_url as string,
  live_base_url: (r.live_base_url as string | null) ?? null,
  price: r.price as Offering["price"],
  sla_notes: r.sla_notes as string,
  licence_ids: (r.licence_ids as string[]) ?? [],
  requires_credential: r.requires_credential as boolean,
  adapter: (r.adapter as string | null) ?? null,
  status: r.status as OfferingStatus,
  status_note: (r.status_note as string | null) ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});
const toSubscription = (r: Row): Subscription => ({
  id: r.id as string,
  offering_id: r.offering_id as string,
  entity_id: r.entity_id as string,
  party_id: r.party_id as string,
  party_created: r.party_created as boolean,
  live: r.live as boolean,
  test_credential_key_id: (r.test_credential_key_id as string | null) ?? null,
  live_credential_key_id: (r.live_credential_key_id as string | null) ?? null,
  status: r.status as Subscription["status"],
  secret_shown: r.secret_shown_at != null,
  created_at: iso(r.created_at)!,
  ended_at: iso(r.ended_at),
});

const T = "financial_products";
const uuidLike = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export async function serviceTypes(db: Db, f: { region?: string; category?: string } = {}): Promise<ServiceType[]> {
  const { rows } = await db.query(
    `SELECT * FROM ${T}.service_types WHERE ($1::text IS NULL OR region = $1) AND ($2::text IS NULL OR category = $2) ORDER BY region, key`,
    [f.region ?? null, f.category ?? null],
  );
  return rows.map(toType);
}
export async function serviceType(db: Db, region: string, key: string): Promise<ServiceType | undefined> {
  const { rows } = await db.query(`SELECT * FROM ${T}.service_types WHERE region = $1 AND key = $2`, [region, key]);
  return rows[0] ? toType(rows[0]) : undefined;
}
export async function getOffering(db: Db, id: string): Promise<Offering | undefined> {
  if (!uuidLike(id)) return undefined;
  const { rows } = await db.query(`SELECT * FROM ${T}.vendor_offerings WHERE id = $1`, [id]);
  return rows[0] ? toOffering(rows[0]) : undefined;
}
export async function getSubscription(db: Db, id: string): Promise<Subscription | undefined> {
  if (!uuidLike(id)) return undefined;
  const { rows } = await db.query(`SELECT * FROM ${T}.vendor_subscriptions WHERE id = $1`, [id]);
  return rows[0] ? toSubscription(rows[0]) : undefined;
}
async function sealedColumn(db: Db, table: string, column: string, id: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT ${column} AS v FROM ${T}.${table} WHERE id = $1`, [id]);
  return (rows[0]?.v as string | undefined) ?? null;
}

// One signed call to an offering: over HTTPS to the vendor's endpoint, or, for a ramp offering run through an
// adapter, answered in-process by the adapter in front of the partner's API (the same signed body, the same checks).
async function callOffering(
  store: Store,
  o: Offering,
  req: { environment: "test" | "live"; service_type: string; body: unknown; signing_secret: string; credential?: string | null; signature?: string; customer_key?: string | null },
  opts: VendorCallOptions,
): Promise<VendorResult> {
  if (o.adapter) {
    const payload = JSON.stringify(req.body);
    return serveRampAdapter(store, o, req.service_type, payload, req.signature ?? signBody(req.signing_secret, payload), req.environment, req.customer_key ?? null, opts);
  }
  const base = req.environment === "test" ? o.test_base_url : o.live_base_url!;
  return callVendor({ base_url: base, service_type: req.service_type, body: req.body, signing_secret: req.signing_secret, credential: req.credential, signature: req.signature }, opts);
}

// Calls counted per subscription, day and environment; no customer data.
export async function recordUsage(db: Db, subscriptionId: string, environment: "test" | "live", ok: boolean): Promise<void> {
  await db.query(
    `INSERT INTO ${T}.vendor_usage (subscription_id, day, environment, ok, errors) VALUES ($1, current_date, $2, $3, $4)
     ON CONFLICT (subscription_id, day, environment) DO UPDATE SET ok = ${T}.vendor_usage.ok + EXCLUDED.ok, errors = ${T}.vendor_usage.errors + EXCLUDED.errors`,
    [subscriptionId, environment, ok ? 1 : 0, ok ? 0 : 1],
  );
}
export async function usageOf(db: Db, subscriptionIds: string[], days = 30) {
  if (!subscriptionIds.length) return [];
  const { rows } = await db.query(
    `SELECT subscription_id, to_char(day, 'YYYY-MM-DD') AS day, environment, ok, errors FROM ${T}.vendor_usage
     WHERE subscription_id = ANY($1::uuid[]) AND day > current_date - $2::int ORDER BY day DESC, environment`,
    [subscriptionIds, days],
  );
  return rows as { subscription_id: string; day: string; environment: "test" | "live"; ok: number; errors: number }[];
}
const usageFor = (rows: Awaited<ReturnType<typeof usageOf>>, id: string) => {
  const mine = rows.filter((r) => r.subscription_id === id).map(({ subscription_id, ...r }) => r);
  return { calls: mine.reduce((n, r) => n + r.ok + r.errors, 0), errors: mine.reduce((n, r) => n + r.errors, 0), by_day: mine };
};

const newSecret = () => `mvs_${randomBytes(32).toString("base64url")}`;

// ---- service types ----

const Key = z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase key like 'pan_verification'").max(60);
export const ServiceTypeSchema = z
  .object({
    region: z.string().regex(/^[A-Z]{2}$/, "An ISO country code like IN or US, defined as a region"),
    key: Key.describe("Unique in the region; vendors serve it at POST <base>/v1/<key>"),
    name: z.string().min(1).max(200),
    category: z.enum(SERVICE_CATEGORIES),
    description: z.string().max(2000).default(""),
    input_schema: z.record(z.string(), z.unknown()).describe("JSON Schema of `input`. Required properties must be data dictionary fields: Mynt sends them from the customer's vault"),
    output_schema: z.record(z.string(), z.unknown()).describe("JSON Schema of `output`"),
    consent_purpose: Key.describe("The consent purpose the customer must give first; a handoff bound to this service uses it"),
    fills: z.array(z.string()).max(30).default([]).describe("Data dictionary fields the output fills (output properties of the same name), saved to the customer's vault"),
    innovator_licences: z.array(z.string()).max(20).default([]).describe("Licence type ids (regulatory model) the subscribing firm must hold one of; empty for none"),
    vendor_licences: z.array(z.string()).max(20).default([]).describe("Licence type ids the vendor must hold one of; empty for none"),
    fixtures: z.array(z.record(z.string(), z.unknown())).max(5).default([]).describe("Inputs for Mynt's conformance test; by default one built from Mynt's sandbox fixtures"),
    client_result: z
      .object({
        status: z
          .object({ from: z.string().describe("An output property"), map: z.record(z.string(), z.enum(CLIENT_STATUSES)).describe("Its values → the status the device sees; others are 'completed'") })
          .strict()
          .optional(),
        fields: z.array(z.string()).max(10).default([]).describe("Output properties the device may see; never personal data"),
        redirect: z.boolean().default(false).describe("true for services the customer finishes on the provider's page (e-sign, e-mandate, DigiLocker): the device gets the vendor's redirect_url"),
      })
      .strict()
      .optional()
      .describe("What a device that starts an action served by this service is told. The full output goes to the innovator; by default the device gets only a status and a reference"),
    params_schema: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe(
        "JSON Schema of `params`: what the device sends with each call (an amount, a currency, an asset), never customer data, which comes from the vault. An object of plain scalar properties with additionalProperties false",
      ),
    params_fixture: z.record(z.string(), z.unknown()).nullable().optional().describe("params for Mynt's conformance test; needed when params_schema has required properties"),
    quote: z
      .boolean()
      .default(false)
      .describe("true for a price quote: its output must require quote_id (string) and expires_at (date-time, at most an hour ahead). The device is shown expires_at and accepts the quote through the service type whose `accepts` names this one"),
    accepts: Key.nullable().optional().describe(
      "The key of the quote service type (same region) this service executes. The device sends the quote's reference; Mynt sends the vendor its quote_id, once, only while it hasn't expired, and only to the vendor that quoted",
    ),
  })
  .strict();
export type ServiceTypeInput = z.infer<typeof ServiceTypeSchema>;

// Every licence type id in a region's regulatory model.
async function licenceTypeIds(store: Store, region: string): Promise<Set<string> | null> {
  const r = (await store.referenceData(true)).regions.find((x) => x.code === region);
  if (!r) return null;
  return new Set(normalizeModel(r.regulatory).regulators.flatMap((g) => g.license_types.map((l) => l._id)));
}

// A property a device may be shown: one plain scalar type (or several, null included), a scalar enum or a scalar
// const, and nothing that can nest (no $ref, combinators, items or properties).
const SCALAR_TYPES = new Set(["string", "number", "integer", "boolean", "null"]);
const isScalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
function scalarSchema(prop: unknown): boolean {
  if (!prop || typeof prop !== "object" || Array.isArray(prop)) return false;
  const p = prop as Record<string, unknown>;
  if (["$ref", "allOf", "anyOf", "oneOf", "not", "if", "items", "prefixItems", "properties", "patternProperties", "additionalProperties"].some((k) => k in p)) return false;
  if (Array.isArray(p.enum)) return p.enum.every(isScalar) && (p.type === undefined || scalarSchema({ type: p.type }));
  if ("const" in p) return isScalar(p.const);
  const types = Array.isArray(p.type) ? p.type : [p.type];
  return types.length > 0 && types.every((x) => typeof x === "string" && SCALAR_TYPES.has(x));
}

export async function checkServiceType(store: Store, t: ServiceTypeInput): Promise<{ errors: string[]; fixtures: Record<string, unknown>[] }> {
  const errors: string[] = [];
  const ids = await licenceTypeIds(store, t.region);
  if (!ids) return { errors: [`No region '${t.region}'; see list_regions`], fixtures: [] };
  for (const [name, schema] of [
    ["input_schema", t.input_schema],
    ["output_schema", t.output_schema],
  ] as const) {
    if (schema.type !== "object") errors.push(`${name} must be a JSON Schema of type object`);
    try {
      validator(schema);
    } catch (e) {
      errors.push(`${name} isn't a valid JSON Schema: ${(e as Error).message}`);
    }
  }
  const required = Array.isArray(t.input_schema.required) ? (t.input_schema.required as string[]) : [];
  for (const f of required) if (!DATA_DICTIONARY[f]) errors.push(`input '${f}' isn't in Mynt's data dictionary: required inputs come from the customer's vault`);
  const outputProps = (t.output_schema.properties ?? {}) as Record<string, unknown>;
  for (const f of t.fills) {
    if (!DATA_DICTIONARY[f]) errors.push(`fills: '${f}' isn't in Mynt's data dictionary`);
    else if (!(f in outputProps)) errors.push(`fills: '${f}' isn't a property of output_schema`);
  }
  if (t.client_result) {
    const cr = t.client_result;
    if (cr.status && !(cr.status.from in outputProps)) errors.push(`client_result.status.from: '${cr.status.from}' isn't a property of output_schema`);
    for (const f of cr.fields) {
      if (!(f in outputProps)) errors.push(`client_result.fields: '${f}' isn't a property of output_schema`);
      else if (!scalarSchema(outputProps[f])) errors.push(`client_result.fields: '${f}' must be a plain string, number, boolean or enum property; objects and arrays never go to the device`);
      else if (DATA_DICTIONARY[f] && DATA_DICTIONARY[f].sensitivity !== "public") errors.push(`client_result.fields: '${f}' is customer data (${DATA_DICTIONARY[f].sensitivity}); it goes to the innovator, never the device`);
      else if (t.fills.includes(f)) errors.push(`client_result.fields: '${f}' fills the customer's vault; it goes to the innovator, never the device`);
      else {
        const crypto = cryptoPropertyProblem(f, outputProps[f], { usdOnly: t.category === "ramp" });
        if (crypto) errors.push(`client_result.fields: ${crypto}. ${DOLLARS_ONLY_RULE}`);
      }
    }
  }
  // The name reaches devices in error messages ("The <name> service this product uses isn't available").
  if (cryptoText(t.name)) errors.push(`name: '${t.name}' names a crypto concept, and devices can be shown it. ${DOLLARS_ONLY_RULE}`);
  if (t.params_schema) {
    const ps = t.params_schema;
    if (ps.type !== "object") errors.push("params_schema must be a JSON Schema of type object");
    if (ps.additionalProperties !== false) errors.push("params_schema must set additionalProperties: false, so a device can't send anything it doesn't declare");
    try {
      validator(ps);
    } catch (e) {
      errors.push(`params_schema isn't a valid JSON Schema: ${(e as Error).message}`);
    }
    for (const [name, prop] of Object.entries((ps.properties ?? {}) as Record<string, unknown>)) {
      if (!scalarSchema(prop)) errors.push(`params_schema: '${name}' must be a plain string, number, boolean or enum property`);
      if (DATA_DICTIONARY[name] && DATA_DICTIONARY[name].sensitivity !== "public") errors.push(`params_schema: '${name}' is customer data; it comes from the vault as an input, never from the device as a param`);
      const crypto = cryptoPropertyProblem(name, prop, { usdOnly: t.category === "ramp" });
      if (crypto) errors.push(`params_schema: ${crypto}; a device sends only dollar amounts and plain choices. ${DOLLARS_ONLY_RULE}`);
    }
    const needed = Array.isArray(ps.required) ? (ps.required as string[]) : [];
    if (needed.length && !t.params_fixture) errors.push("params_fixture: needed for Mynt's conformance test, because params_schema has required properties");
  } else if (t.params_fixture) errors.push("params_fixture: there is no params_schema");
  const outRequired = Array.isArray(t.output_schema.required) ? (t.output_schema.required as string[]) : [];
  if (t.quote) {
    for (const f of ["quote_id", "expires_at"]) if (!(f in outputProps) || !outRequired.includes(f)) errors.push(`quote: output_schema must require '${f}'`);
    if (t.client_result?.fields.includes("quote_id")) errors.push("client_result.fields: 'quote_id' stays between Mynt and the vendor; the device accepts a quote by Mynt's reference");
    if (t.accepts) errors.push("A service type is a quote or accepts one, not both");
  }
  if (t.accepts) {
    const q = t.accepts === t.key ? undefined : await serviceType(store.db, t.region, t.accepts);
    if (!q) errors.push(`accepts: no service type '${t.accepts}' in ${t.region} (define the quote service type first)`);
    else if (!q.quote) errors.push(`accepts: '${t.accepts}' isn't a quote service type (quote: true)`);
    else if (q.category !== t.category) errors.push(`accepts: '${t.accepts}' is ${q.category}; a quote and the service accepting it share a category`);
  }
  for (const [side, list] of [
    ["innovator_licences", t.innovator_licences],
    ["vendor_licences", t.vendor_licences],
  ] as const)
    for (const id of list) if (!ids.has(id)) errors.push(`${side}: no licence type '${id}' in ${t.region}'s regulatory model (see get_regulator)`);
  let fixtures = t.fixtures;
  if (!fixtures.length) {
    const derived: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const f of required) {
      const v = fixtureValue(f);
      if (v == null) missing.push(f);
      else derived[f] = DATA_DICTIONARY[f]?.type === "number" || DATA_DICTIONARY[f]?.type === "integer" ? Number(v) : v;
    }
    if (missing.length) errors.push(`Mynt has no sandbox fixture for ${missing.join(", ")}: give fixtures`);
    fixtures = [derived];
  }
  if (!errors.length)
    fixtures.forEach((f, i) => {
      const p = schemaProblems(t.input_schema, f);
      if (p.length) errors.push(`fixture ${i + 1} doesn't match input_schema: ${p.join("; ")}`);
    });
  if (!errors.length && t.params_schema && t.params_fixture) {
    const p = schemaProblems(t.params_schema, t.params_fixture);
    if (p.length) errors.push(`params_fixture doesn't match params_schema: ${p.join("; ")}`);
  }
  return { errors, fixtures };
}

export async function upsertServiceType(store: Store, t: ServiceTypeInput, fixtures: Record<string, unknown>[], by: string | null): Promise<ServiceType> {
  const { rows } = await store.db.query(
    `INSERT INTO ${T}.service_types (region, key, name, category, description, input_schema, output_schema, consent_purpose, fills, innovator_licences, vendor_licences, fixtures, updated_by, client_result,
       params_schema, params_fixture, quote, accepts, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
     ON CONFLICT (region, key) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, description = EXCLUDED.description,
       input_schema = EXCLUDED.input_schema, output_schema = EXCLUDED.output_schema, consent_purpose = EXCLUDED.consent_purpose, fills = EXCLUDED.fills,
       innovator_licences = EXCLUDED.innovator_licences, vendor_licences = EXCLUDED.vendor_licences, fixtures = EXCLUDED.fixtures,
       updated_by = EXCLUDED.updated_by, client_result = EXCLUDED.client_result, params_schema = EXCLUDED.params_schema, params_fixture = EXCLUDED.params_fixture,
       quote = EXCLUDED.quote, accepts = EXCLUDED.accepts, updated_at = now()
     RETURNING *`,
    [
      t.region,
      t.key,
      t.name,
      t.category,
      t.description,
      JSON.stringify(t.input_schema),
      JSON.stringify(t.output_schema),
      t.consent_purpose,
      t.fills,
      t.innovator_licences,
      t.vendor_licences,
      JSON.stringify(fixtures),
      by,
      t.client_result ? JSON.stringify(t.client_result) : null,
      t.params_schema ? JSON.stringify(t.params_schema) : null,
      t.params_fixture ? JSON.stringify(t.params_fixture) : null,
      t.quote,
      t.accepts ?? null,
    ],
  );
  return toType(rows[0]);
}

// The example definitions shipped in schemas/service-types/<region>/*.json.
export function exampleServiceTypes(region?: string): { file: string; data: unknown }[] {
  if (!existsSync(SERVICE_TYPES_DIR)) return [];
  const out: { file: string; data: unknown }[] = [];
  for (const dir of readdirSync(SERVICE_TYPES_DIR).sort()) {
    if (region && dir !== region.toLowerCase()) continue;
    const path = join(SERVICE_TYPES_DIR, dir);
    if (!existsSync(path) || !/^[a-z]{2}$/.test(dir)) continue;
    for (const f of readdirSync(path).filter((x) => x.endsWith(".json")).sort()) out.push({ file: `${dir}/${f}`, data: JSON.parse(readFileSync(join(path, f), "utf8")) });
  }
  return out;
}

// ---- licences ----

// The innovator-side prerequisite: the firm holds a verified, in-force licence of one of the types.
export async function innovatorLicenceGap(store: Store, entityId: string, t: ServiceType): Promise<string | null> {
  if (!t.innovator_licences.length) return null;
  const held = (await store.licensesOf(entityId)).filter((l) => l.region === t.region && licenseInForce(l) && t.innovator_licences.includes(l.license_id));
  return held.length ? null : `${t.name} in ${t.region} needs your firm to hold a verified licence of one of: ${t.innovator_licences.join(", ")}`;
}
// The vendor-side prerequisite, against the licences the offering names.
export async function vendorLicenceGap(store: Store, o: Offering, t: ServiceType): Promise<string | null> {
  if (!t.vendor_licences.length) return null;
  const named = (await store.licensesOf(o.entity_id)).filter((l) => o.licence_ids.includes(l.id));
  const ok = named.some((l) => l.region === t.region && licenseInForce(l) && t.vendor_licences.includes(l.license_id));
  return ok ? null : `${t.name} in ${t.region} needs the vendor to hold, and name on the offering, a verified licence of one of: ${t.vendor_licences.join(", ")}`;
}
// What a product bound to a subscription rests on, pinned at publish and compared by the drift sweep: the
// subscription still active, the offering not suspended, and both sides' licence prerequisites still met.
export async function vendorStateOf(store: Store, subscriptionId: string): Promise<string> {
  const sub = await getSubscription(store.db, subscriptionId);
  const o = sub && (await getOffering(store.db, sub.offering_id));
  const t = o && (await serviceType(store.db, o.region, o.service_type));
  if (!sub || !o || !t) return "missing";
  return [
    `subscription:${sub.status}`,
    `offering:${o.status === "suspended" ? "suspended" : "available"}`,
    `innovator_licences:${(await innovatorLicenceGap(store, sub.entity_id, t)) ? "gap" : "met"}`,
    `vendor_licences:${(await vendorLicenceGap(store, o, t)) ? "gap" : "met"}`,
  ].join(" ");
}

// Re-checks the products of every firm subscribed to a vendor's offerings (or one offering): a suspension or a
// lapsed licence drifts them, which pauses new sales and tells their innovators (product.drifted).
export async function vendorDriftSweep(store: Store, by: { offering_id?: string; vendor_entity_id?: string }): Promise<string[]> {
  const { rows } = await store.db.query(
    `SELECT DISTINCT s.entity_id FROM ${T}.vendor_subscriptions s JOIN ${T}.vendor_offerings o ON o.id = s.offering_id
     WHERE ($1::text IS NULL OR o.id::text = $1) AND ($2::text IS NULL OR o.entity_id::text = $2)`,
    [by.offering_id ?? null, by.vendor_entity_id ?? null],
  );
  const drifted: string[] = [];
  for (const r of rows) drifted.push(...(await driftSweep(store, r.entity_id as string)));
  return drifted;
}

const licenceView = (l: HeldLicense) => ({ id: l.id, regulator_id: l.regulator_id, license_id: l.license_id, registration_number: l.registration_number, status: l.status, in_force: licenseInForce(l) });

// ---- conformance ----

type CaseResult = { case: string; passed: boolean; http_status: number | null; latency_ms: number; problems: string[] };

// Mynt's own test of an offering's test endpoint: each fixture input, signed, must come back "ok" with output
// valid against the service type's schema; a request with a bad signature must be refused.
export async function runConformance(store: Store, o: Offering, t: ServiceType, opts: VendorCallOptions, by: string | null, credential?: string | null) {
  const secret = open((await sealedColumn(store.db, "vendor_offerings", "conformance_secret", o.id))!, false);
  const cases: CaseResult[] = [];
  const request = (input: Record<string, unknown>) => ({
    request_id: randomUUID(),
    environment: "test",
    input,
    ...(t.params_schema ? { params: t.params_fixture ?? {} } : {}),
    ...(t.accepts ? { quote: { quote_id: "mynt_conformance" } } : {}),
    consent: { purpose: t.consent_purpose, artefact_ref: "mynt_conformance", given_at: new Date().toISOString() },
  });
  for (const [i, input] of t.fixtures.entries()) {
    const body = request(input);
    const r = await callOffering(store, o, { environment: "test", service_type: t.key, body, signing_secret: secret, credential }, opts);
    const problems: string[] = [];
    if (!r.ok) problems.push(r.error ?? "failed");
    else problems.push(...responseProblems(r.body, body.request_id, t));
    cases.push({ case: `fixture_${i + 1}`, passed: !problems.length, http_status: r.http_status, latency_ms: r.latency_ms, problems });
  }
  {
    const body = request(t.fixtures[0] ?? {});
    const r = await callOffering(store, o, { environment: "test", service_type: t.key, body, signing_secret: secret, credential, signature: signBody(newSecret(), JSON.stringify(body)) }, opts);
    const refused = (r.http_status != null && r.http_status >= 400 && r.http_status < 500) || (r.ok && (r.body as { status?: string } | null)?.status === "error");
    cases.push({
      case: "bad_signature_refused",
      passed: refused,
      http_status: r.http_status,
      latency_ms: r.latency_ms,
      problems: refused ? [] : [r.error && r.http_status == null ? r.error : "a request with a bad Mynt-Signature wasn't refused (answer 401)"],
    });
  }
  {
    // Correctly signed, but ten minutes old: a replay, which must be refused.
    const body = request(t.fixtures[0] ?? {});
    const stale = Math.floor(Date.now() / 1000) - 600;
    const r = await callOffering(store, o, { environment: "test", service_type: t.key, body, signing_secret: secret, credential, signature: signBody(secret, JSON.stringify(body), stale) }, opts);
    const refused = (r.http_status != null && r.http_status >= 400 && r.http_status < 500) || (r.ok && (r.body as { status?: string } | null)?.status === "error");
    cases.push({
      case: "stale_timestamp_refused",
      passed: refused,
      http_status: r.http_status,
      latency_ms: r.latency_ms,
      problems: refused ? [] : [r.error && r.http_status == null ? r.error : "a request signed more than 300 s ago wasn't refused (answer 401)"],
    });
  }
  const gap = await vendorLicenceGap(store, o, t);
  const passed = cases.every((c) => c.passed) && !gap;
  const id = randomUUID();
  await store.db.query(`INSERT INTO ${T}.vendor_conformance_runs (id, offering_id, passed, cases, run_by) VALUES ($1, $2, $3, $4, $5)`, [
    id,
    o.id,
    passed,
    JSON.stringify(gap ? [...cases, { case: "vendor_licences", passed: false, http_status: null, latency_ms: 0, problems: [gap] }] : cases),
    by,
  ]);
  // A pass moves a draft on; a failure sends a passed-but-unlisted offering back. Listed or suspended
  // offerings keep their status (an admin suspends), and ops_status shows the failure.
  let status = o.status;
  if (passed && o.status === "draft") status = "conformance_passed";
  if (!passed && o.status === "conformance_passed") status = "draft";
  if (status !== o.status) await store.db.query(`UPDATE ${T}.vendor_offerings SET status = $2, updated_at = now() WHERE id = $1`, [o.id, status]);
  return { run_id: id, passed, status, cases, ...(gap ? { licence_gap: gap } : {}) };
}

// What's wrong with a vendor's response body, as rules only. With allowPending, an asynchronous service may
// answer "pending" (the customer finishes on the provider's page, then the vendor calls back).
function responseProblems(body: unknown, requestId: string, t: ServiceType, allowPending = false): string[] {
  const b = body as { request_id?: unknown; status?: unknown; output?: unknown; redirect_url?: unknown } | null;
  if (!b || typeof b !== "object") return ["the response isn't a JSON object"];
  const problems: string[] = [];
  if (b.request_id !== requestId) problems.push("request_id doesn't echo the request's");
  if (allowPending && b.status === "pending") {
    if (b.redirect_url != null && typeof b.redirect_url !== "string") problems.push("redirect_url must be a string");
  } else if (b.status !== "ok") problems.push(`status is ${JSON.stringify(b.status)}, not "ok"`);
  else {
    const p = schemaProblems(t.output_schema, b.output).map((x) => `output ${x}`);
    if (!p.length && t.quote) p.push(...quoteProblems(b.output as Record<string, unknown>));
    problems.push(...p);
  }
  return problems;
}

// A quote must be acceptable for a short, real window: expires_at in the future, at most an hour ahead.
export const QUOTE_MAX_SECONDS = 3600;
function quoteProblems(output: Record<string, unknown>): string[] {
  const at = Date.parse(String(output.expires_at));
  if (typeof output.quote_id !== "string" || !output.quote_id || output.quote_id.length > 200) return ["output quote_id must be a non-empty string of at most 200 characters"];
  if (Number.isNaN(at)) return ["output expires_at isn't a date-time"];
  if (at <= Date.now()) return ["output expires_at is already past"];
  if (at > Date.now() + QUOTE_MAX_SECONDS * 1000) return [`output expires_at is more than ${QUOTE_MAX_SECONDS} s ahead`];
  return [];
}

// A provider's hosted page a device may be sent to: https (plain http only to loopback in tests), no credentials.
function safeRedirect(raw: unknown, opts: VendorCallOptions): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password) return null;
    if (u.protocol === "https:") return u.toString();
    if (u.protocol === "http:" && opts.allowInsecureLoopback && /^(127\.|localhost$|\[::1\]$)/.test(u.hostname)) return u.toString();
  } catch {
    /* not a URL */
  }
  return null;
}

// ---- product handoffs bound to subscriptions ----

type Conn = { _id: string; type: string; from: { kind: string; id?: string }; to: { kind: string; id?: string }; attributes?: Record<string, unknown> };
type HandoffNode = { _id: string; sends?: unknown };

// Checks handoff_to_party connections that name a vendor subscription: the owner's active subscription, to
// the subscription's vendor party, under the purpose the service type needs; and that the handoff asks the
// customer for every input the service requires (so a device can collect them before starting the action).
export async function checkVendorHandoffs(store: Store, entityId: string | null, connections: Conn[], handoffs: HandoffNode[] = []): Promise<string[]> {
  const errors: string[] = [];
  for (const c of connections.filter((x) => x.type === "handoff_to_party" && (x.attributes?.vendor_subscription_id || x.attributes?.service_type))) {
    const at = `connection '${c._id}' (handoff_to_party)`;
    const subId = c.attributes?.vendor_subscription_id as string | undefined;
    if (!subId) {
      errors.push(`${at}: service_type needs vendor_subscription_id, the subscription that provides it`);
      continue;
    }
    const sub = await getSubscription(store.db, subId);
    if (!entityId || !sub || sub.entity_id !== entityId || sub.status !== "active") {
      errors.push(`${at}: no active vendor subscription '${subId}' of the product's firm (see list_my_vendor_subscriptions)`);
      continue;
    }
    if (c.to.id !== sub.party_id) errors.push(`${at}: the subscription's vendor is roster party ${sub.party_id}; hand off to it`);
    const o = await getOffering(store.db, sub.offering_id);
    const t = o && (await serviceType(store.db, o.region, o.service_type));
    if (!t) continue;
    if (c.attributes?.service_type && c.attributes.service_type !== t.key) errors.push(`${at}: the subscription provides '${t.key}', not '${String(c.attributes.service_type)}'`);
    if (c.attributes?.consent_purpose !== t.consent_purpose) errors.push(`${at}: consent_purpose must be '${t.consent_purpose}', the purpose ${t.name} needs`);
    if (o!.status === "suspended") errors.push(`${at}: the offering is suspended`);
    const gap = (await innovatorLicenceGap(store, sub.entity_id, t)) ?? (await vendorLicenceGap(store, o!, t));
    if (gap) errors.push(`${at}: ${gap}`);
    // A service type stored before the dollars-only rule can't be bound until an admin reloads it.
    const leak = deviceLeaks(t);
    if (leak.length) errors.push(`${at}: ${t.key} would show devices ${leak.join(", ")}; an admin redefines it (load_service_types). ${DOLLARS_ONLY_RULE}`);
    const h = handoffs.find((x) => x._id === c.from.id);
    if (h) {
      const sends = ((h.sends as { required?: unknown } | undefined)?.required as unknown[] | undefined) ?? [];
      const missing = ((t.input_schema.required as string[] | undefined) ?? []).filter((f) => !sends.includes(f));
      if (missing.length) errors.push(`partner handoff '${h._id}': sends.required must include ${missing.join(", ")}, which ${t.name} needs from the customer`);
    }
  }
  return errors;
}

// What of a service type a device would be shown or send that breaks the dollars-only rule.
export function deviceLeaks(t: ServiceType): string[] {
  const out = (t.output_schema.properties ?? {}) as Record<string, unknown>;
  const params = (t.params_schema?.properties ?? {}) as Record<string, unknown>;
  const usdOnly = t.category === "ramp";
  return [
    ...(t.client_result?.fields ?? []).filter((f) => cryptoPropertyProblem(f, out[f], { usdOnly })).map((f) => `client_result field '${f}'`),
    ...Object.entries(params).filter(([n, p]) => cryptoPropertyProblem(n, p, { usdOnly })).map(([n]) => `param '${n}'`),
  ];
}

// The bindings a live version runs through vendors, pinned at publish.
export async function vendorBindingsOf(store: Store, connections: Conn[]): Promise<VendorBinding[]> {
  const out: VendorBinding[] = [];
  for (const c of connections.filter((x) => x.type === "handoff_to_party" && x.attributes?.vendor_subscription_id)) {
    const sub = await getSubscription(store.db, c.attributes!.vendor_subscription_id as string);
    const o = sub && (await getOffering(store.db, sub.offering_id));
    const t = o && (await serviceType(store.db, o.region, o.service_type));
    if (sub && t) out.push({ handoff_id: c.from.id!, party_id: sub.party_id, subscription_id: sub.id, service_type: t.key, consent_purpose: t.consent_purpose });
  }
  return out;
}

// What the developer contract says of each vendor-served action: the service type, and what a device is told
// of its outcome. No subscription, vendor, endpoint or secret.
export type VendorServedActions = Record<string, { service_type: string; client_result: { statuses: ClientStatus[]; fields: string[]; redirect: boolean }; params_schema?: Record<string, unknown>; quote?: true; accepts_quote_from?: string }>;
export async function vendorServedActions(store: Store, connections: Conn[]): Promise<VendorServedActions> {
  const out: VendorServedActions = {};
  const accepting: Record<string, string> = {}; // handoff id → the quote service type it accepts
  for (const c of connections.filter((x) => x.type === "handoff_to_party" && x.attributes?.vendor_subscription_id && x.from.id)) {
    const sub = await getSubscription(store.db, c.attributes!.vendor_subscription_id as string);
    const o = sub && (await getOffering(store.db, sub.offering_id));
    const t = o && (await serviceType(store.db, o.region, o.service_type));
    if (!t) continue;
    const cr = t.client_result;
    const statuses = new Set<ClientStatus>(["completed", "failed", "pending", ...Object.values(cr?.status?.map ?? {})]);
    out[c.from.id!] = {
      service_type: t.key,
      // Never a field that names a crypto concept, even on a service type stored before the dollars-only rule.
      client_result: { statuses: CLIENT_STATUSES.filter((s) => statuses.has(s)), fields: (cr?.fields ?? []).filter((f) => !cryptoName(f)), redirect: cr?.redirect ?? false },
      // Only present when set, so contracts of services without them are unchanged.
      ...(t.params_schema ? { params_schema: t.params_schema } : {}),
      ...(t.quote ? { quote: true as const } : {}),
    };
    if (t.accepts) accepting[c.from.id!] = t.accepts;
  }
  // An accepting action names the product's action whose quotes it accepts.
  for (const [id, quoteKey] of Object.entries(accepting)) {
    const from = Object.entries(out).find(([, v]) => v.quote && v.service_type === quoteKey)?.[0];
    if (from) out[id].accepts_quote_from = from;
  }
  return out;
}

// ---- the Mynt Ramp ----

// The one firm that operates the Mynt Ramp: in R1 the licensed ramp partner (it holds the funds in transit under
// its own licences); later, if Mynt is licensed itself, Mynt's own firm. Only that firm may offer `ramp` services,
// and calls go only to its offerings, so every product's fiat in and out runs through the same ramp.
export const MYNT_RAMP_SETTING = "mynt_ramp";
export async function myntRampEntity(store: Store): Promise<string | null> {
  return (await store.getSetting<{ entity_id: string }>(MYNT_RAMP_SETTING))?.entity_id ?? null;
}
async function rampRefusal(store: Store, t: ServiceType, entityId: string): Promise<string | null> {
  if (t.category !== "ramp") return null;
  const ramp = await myntRampEntity(store);
  if (!ramp) return "No firm operates the Mynt Ramp yet: an admin designates it with set_mynt_ramp";
  return ramp === entityId ? null : "Ramp services are offered only by the firm that operates the Mynt Ramp: all fiat in and out goes through the one Mynt Ramp";
}

// ---- runtime: calls through a product's bound vendor ----

type Bound = { sub: Subscription; o: Offering; t: ServiceType };
async function resolveSubscription(store: Store, subscriptionId: string): Promise<Bound | null> {
  const sub = await getSubscription(store.db, subscriptionId);
  const o = sub && (await getOffering(store.db, sub.offering_id));
  const t = o && (await serviceType(store.db, o.region, o.service_type));
  return sub && o && t ? { sub, o, t } : null;
}

type VendorAnswer =
  | { kind: "error"; status: number; code: string; message: string }
  | { kind: "ok"; output: Record<string, unknown> }
  | { kind: "pending"; redirect_url: string | null };

// One call to a bound vendor's service for a customer, shared by prefill and client actions: the subscription
// and offering still usable (live calls only to a listed offering, with both sides' licences in force today),
// the service type's consent recorded, its declared inputs (only those) from the customer's vault, the test
// endpoint and test credential for sandbox, the live ones for live, and the answer checked against the output
// schema. Nothing the vendor returned is kept here; the caller decides.
async function callBoundVendor(
  store: Store,
  { sub, o, t }: Bound,
  a: {
    sandbox: boolean;
    request_id: string;
    held: () => Promise<Record<string, string>>; // the customer's vault, opened
    consent: (purpose: string) => Promise<{ id: string; created_at: string } | null>; // the active grant in this session
    allowPending?: boolean;
    params?: Record<string, unknown>; // checked against the service type's params_schema by the caller
    quote_id?: string; // the vendor's own quote id, for a service that accepts a quote
    customer_key?: string; // Mynt's pseudonymous key for the customer, for a ramp adapter (never sent over the wire)
  },
  opts: VendorCallOptions,
): Promise<VendorAnswer> {
  const environment = a.sandbox ? "test" : "live";
  const unavailable = (why = "isn't available right now"): VendorAnswer => ({ kind: "error", status: 503, code: "vendor_unavailable", message: `The ${t.name} service this product uses ${why}` });
  if (sub.status !== "active" || !["listed", "conformance_passed"].includes(o.status)) return unavailable();
  // A ramp offering whose firm no longer operates the Mynt Ramp isn't called, in sandbox or live.
  if (await rampRefusal(store, t, o.entity_id)) return unavailable("isn't the Mynt Ramp");
  // Live calls go only to a listed offering, with both sides' licence prerequisites still met today.
  if (!a.sandbox) {
    if (o.status !== "listed") return unavailable();
    if ((await innovatorLicenceGap(store, sub.entity_id, t)) || (await vendorLicenceGap(store, o, t))) return unavailable("can't be used: a licence it needs isn't in force");
  }
  const consent = await a.consent(t.consent_purpose);
  if (!consent) return { kind: "error", status: 409, code: "consent_required", message: `Record consent '${t.consent_purpose}' (POST /v1/client/evidence) before fetching this customer's data` };
  const held = await a.held();
  const props = Object.keys((t.input_schema.properties ?? {}) as Record<string, unknown>);
  const input: Record<string, unknown> = {};
  for (const p of props) if (p in held) input[p] = DATA_DICTIONARY[p]?.type === "number" || DATA_DICTIONARY[p]?.type === "integer" ? Number(held[p]) : held[p];
  if (schemaProblems(t.input_schema, input).length) {
    const need = ((t.input_schema.required as string[] | undefined) ?? []).filter((f) => !(f in held));
    return { kind: "error", status: 409, code: "data_required", message: `${t.name} needs ${need.join(", ") || "valid inputs"} from the customer first (POST /v1/client/fields)` };
  }
  const base = a.sandbox ? o.test_base_url : o.live_base_url;
  if (!base) return { kind: "error", status: 503, code: "vendor_unavailable", message: `The ${t.name} service has no live endpoint` };
  const secret = open((await sealedColumn(store.db, "vendor_subscriptions", "signing_secret", sub.id))!, false);
  // Sandbox calls carry the test credential and never the live one.
  const keyId = a.sandbox ? sub.test_credential_key_id : sub.live_credential_key_id;
  const sealedCredential = keyId ? await sealedColumn(store.db, "key_vault", "sealed", keyId) : null;
  if (!a.sandbox && o.requires_credential && !sealedCredential) return unavailable("has no live credential set");
  const body = {
    request_id: a.request_id,
    environment,
    input,
    ...(t.params_schema ? { params: a.params ?? {} } : {}),
    ...(a.quote_id ? { quote: { quote_id: a.quote_id } } : {}),
    consent: { purpose: t.consent_purpose, artefact_ref: consent.id, given_at: consent.created_at },
  };
  const r = await callOffering(
    store,
    o,
    { environment, service_type: t.key, body, signing_secret: secret, credential: sealedCredential ? open(sealedCredential, false) : null, customer_key: a.customer_key ?? null },
    opts,
  );
  const problems = r.ok ? responseProblems(r.body, body.request_id, t, a.allowPending) : [r.error ?? "failed"];
  await recordUsage(store.db, sub.id, environment, !problems.length);
  if (problems.length) return { kind: "error", status: 502, code: "vendor_error", message: `The ${t.name} service didn't return a usable answer; try again later` };
  const answer = r.body as { status: string; output?: Record<string, unknown>; redirect_url?: unknown };
  if (answer.status === "pending") return { kind: "pending", redirect_url: safeRedirect(answer.redirect_url, opts) };
  return { kind: "ok", output: answer.output! };
}

export type VendorPrefill =
  | { kind: "none" } // no vendor bound for this source: today's behaviour
  | { kind: "error"; status: number; code: string; message: string }
  | { kind: "ok"; filled: string[]; missing: string[] };

export async function vendorPrefill(
  store: Store,
  a: {
    record: ProductRecord;
    sandbox: boolean;
    source: CaptureMethod;
    fields: string[];
    held: () => Promise<Record<string, string>>; // the customer's vault, opened
    consent: (purpose: string) => Promise<{ id: string; created_at: string } | null>; // the active grant in this session
    save: (field: string, value: string) => Promise<void>;
  },
  opts: VendorCallOptions = {},
): Promise<VendorPrefill> {
  for (const b of a.record.pins?.vendor_bindings ?? []) {
    const bound = await resolveSubscription(store, b.subscription_id);
    if (!bound) continue;
    const { sub, t } = bound;
    if (PREFILL_SOURCE[t.category] !== a.source || !t.fills.some((f) => a.fields.includes(f))) continue;
    if (!a.sandbox && !sub.live) return { kind: "none" };
    const answer = await callBoundVendor(store, bound, { sandbox: a.sandbox, request_id: randomUUID(), held: a.held, consent: a.consent }, opts);
    if (answer.kind === "error") return answer;
    if (answer.kind !== "ok") return { kind: "error", status: 502, code: "vendor_error", message: `The ${t.name} service didn't return a usable answer; try again later` };
    const filled: string[] = [];
    for (const f of a.fields.filter((x) => t.fills.includes(x))) {
      const v = answer.output[f];
      if (v == null || validateValue(f, v)) continue;
      await a.save(f, String(v).trim());
      filled.push(f);
    }
    return { kind: "ok", filled, missing: a.fields.filter((f) => !filled.includes(f)) };
  }
  return { kind: "none" };
}

// ---- runtime: client actions served by the bound vendor ----

// What a device is told: a status, a reference, and only the output fields (and redirect) the service type allows.
export interface ClientOutcome {
  reference: string;
  action: string;
  status: ClientStatus;
  redirect_url?: string;
  [field: string]: unknown;
}
const RESERVED = ["reference", "action", "status", "sandbox", "redirect_url"];
const deviceStatus = (t: ServiceType, output: Record<string, unknown>): ClientStatus => {
  const s = t.client_result?.status;
  return (s && s.map[String(output[s.from])]) || "completed";
};
// Dollars only: a field naming a crypto concept, or a value that is one (a token symbol, a chain name, an address
// or a transaction hash), is never sent to a device, whatever the service type says.
const deviceFields = (t: ServiceType, output: Record<string, unknown>) => ({
  ...Object.fromEntries(
    (t.client_result?.fields ?? [])
      .filter((f) => f in output && !RESERVED.includes(f) && f !== "quote_id" && !cryptoName(f) && !cryptoValue(output[f]))
      .map((f) => [f, output[f]]),
  ),
  // A quote's device is always told when it stops being acceptable.
  ...(t.quote ? { expires_at: output.expires_at } : {}),
});

type RunStatus = "calling" | "pending" | "completed" | "failed" | "withdrawn" | "expired";
const OPEN: RunStatus[] = ["calling", "pending"];
type RunRow = {
  id: string;
  request_id: string;
  subscription_id: string;
  entity_id: string;
  app_id: string;
  session_id: string;
  product_id: string;
  contract_hash: string | null;
  action: string;
  service_type: string;
  customer_ref: string | null;
  sandbox: boolean;
  status: RunStatus;
  client_outcome: Record<string, unknown>;
};
const outcomeOf = (r: RunRow): ClientOutcome & { sandbox: boolean } => ({
  ...r.client_outcome,
  reference: r.id,
  action: r.action,
  status: OPEN.includes(r.status) ? "pending" : ((r.client_outcome.status as ClientStatus | undefined) ?? "failed"),
  sandbox: r.sandbox,
});

// How a run ends: the vendor's valid output, its error, the customer's consent withdrawn (or their data erased)
// before it finished, or no answer in time.
type End = { kind: "output"; output: Record<string, unknown> } | { kind: "error"; code: string | null } | { kind: "withdrawn" } | { kind: "expired" };

// Ends a run once. A valid output whose status maps to "pending" (the customer hasn't finished on the provider's
// page) keeps it open for the vendor's callback. Otherwise: the full result sealed in Mynt's store, the fields it
// fills saved to the customer's vault (only when it completed), evidence of the outcome (status only) for the
// session, the result to the innovator's webhooks, and, for an action that finished after the device's call
// (`async`), a data-free handoff.completed or handoff.failed to the app's webhooks. Returns null when the run had
// already ended (a replayed callback).
async function finishRun(store: Store, run: RunRow, t: ServiceType | null, end: End, async: boolean): Promise<(ClientOutcome & { sandbox: boolean }) | null> {
  if (end.kind === "output" && t && deviceStatus(t, end.output) === "pending") {
    const { rows } = await store.db.query(
      `UPDATE ${T}.vendor_action_runs SET status = 'pending', client_outcome = client_outcome || $2::jsonb WHERE id = $1 AND status IN ('calling', 'pending') RETURNING *`,
      [run.id, JSON.stringify({ status: "pending", ...deviceFields(t, end.output) })],
    );
    return rows[0] ? outcomeOf(rows[0] as RunRow) : null;
  }
  const output = end.kind === "output" ? end.output : null;
  const shown: ClientStatus = output && t ? deviceStatus(t, output) : "failed";
  const status: RunStatus = end.kind === "withdrawn" ? "withdrawn" : end.kind === "expired" ? "expired" : shown === "failed" ? "failed" : "completed";
  const outcome: Record<string, unknown> = output && t ? { status: shown, ...deviceFields(t, output) } : { status: "failed" };
  // Sandbox results are sealed with a key that survives restarts, so a queued delivery can still be sent.
  const sealed = output ? seal(JSON.stringify(output), run.sandbox, true) : null;
  const { rows } = await store.db.query(
    `UPDATE ${T}.vendor_action_runs SET status = $2, client_outcome = $3, result_sealed = $4, completed_at = now()
     WHERE id = $1 AND status IN ('calling', 'pending') RETURNING *`,
    [run.id, status, JSON.stringify(outcome), sealed],
  );
  if (!rows[0]) return null;
  const done = rows[0] as RunRow;
  if (status === "completed" && output && t?.quote)
    await store.db.query(`UPDATE ${T}.vendor_action_runs SET quote_id = $2, quote_expires_at = $3 WHERE id = $1`, [run.id, String(output.quote_id), new Date(String(output.expires_at)).toISOString()]);
  if (status === "completed" && output && t && run.customer_ref)
    for (const f of t.fills) {
      const v = output[f];
      if (v == null || validateValue(f, v)) continue;
      await store.putVaultField({ app_id: run.app_id, customer_ref: run.customer_ref, sandbox: run.sandbox, field: f, sealed: seal(String(v).trim(), run.sandbox), source: PREFILL_SOURCE[t.category] ?? "vendor" });
    }
  await store.recordClientEvidence({
    app_id: run.app_id,
    session_id: run.session_id,
    product_id: run.product_id,
    contract_hash: run.contract_hash,
    type: status === "completed" ? "action_completed" : "action_failed",
    subject: run.action,
    content_hash: null,
    customer_ref: run.customer_ref,
    sandbox: run.sandbox,
  });
  const errorCode = end.kind === "error" ? end.code : end.kind === "withdrawn" ? "consent_withdrawn" : end.kind === "expired" ? "expired" : null;
  await emitFirmEvent(
    store,
    run.entity_id,
    status === "completed" ? "vendor_action.completed" : "vendor_action.failed",
    {
      reference: run.id,
      request_id: run.request_id,
      product_id: run.product_id,
      action: run.action,
      service_type: run.service_type,
      subscription_id: run.subscription_id,
      app_id: run.app_id,
      customer_ref: run.customer_ref,
      sandbox: run.sandbox,
      status: outcome.status,
      ...(errorCode ? { error_code: errorCode } : {}),
    },
    run.sandbox,
    sealed ?? undefined,
  );
  if (async)
    await emitEvent(
      store,
      [run.app_id],
      status === "completed" ? "handoff.completed" : "handoff.failed",
      { product_id: run.product_id, reference: run.id, action: run.action, status: outcome.status, sandbox: run.sandbox },
      run.sandbox,
    );
  return outcomeOf(done);
}

async function currentRun(store: Store, id: string) {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.vendor_action_runs WHERE id = $1`, [id]);
  return outcomeOf(rows[0] as RunRow);
}

export type VendorAction =
  | { kind: "none" } // the action isn't served by a vendor: today's hand-off to the innovator
  | { kind: "error"; status: number; code: string; message: string }
  | { kind: "ok"; outcome: ClientOutcome & { sandbox: boolean } };

// A device starts a client action whose handoff is bound to a vendor subscription: Mynt calls the vendor, keeps
// the result, sends it to the innovator, and tells the device only the outcome.
export async function vendorAction(
  store: Store,
  a: {
    record: ProductRecord;
    action: string;
    sandbox: boolean;
    app_id: string;
    session_id: string;
    customer_ref: string;
    held: () => Promise<Record<string, string>>;
    consent: (purpose: string) => Promise<{ id: string; created_at: string } | null>;
    params?: Record<string, unknown>; // what the device sent, for a service with a params_schema
    quote?: string; // the reference of the quote run this action accepts
  },
  opts: VendorCallOptions = {},
): Promise<VendorAction> {
  const b = a.record.pins?.vendor_bindings?.find((x) => x.handoff_id === a.action);
  if (!b) return { kind: "none" };
  const bound = await resolveSubscription(store, b.subscription_id);
  if (!bound) return { kind: "error", status: 503, code: "vendor_unavailable", message: `The service behind '${a.action}' isn't available right now` };
  const { sub, t } = bound;
  if (!a.sandbox && !sub.live) return { kind: "error", status: 503, code: "vendor_unavailable", message: `The ${t.name} service this product uses isn't turned on for live use yet` };
  const bad = (status: number, code: string, message: string): VendorAction => ({ kind: "error", status, code, message });
  if (a.params !== undefined && !t.params_schema) return bad(400, "params_not_accepted", `'${a.action}' takes no params`);
  if (t.params_schema) {
    const problems = schemaProblems(t.params_schema, a.params ?? {});
    if (problems.length) return bad(400, "invalid_params", `params for '${a.action}' don't match what it takes: ${problems.join("; ")}`);
  }
  if (a.quote !== undefined && !t.accepts) return bad(400, "quote_not_accepted", `'${a.action}' doesn't accept a quote`);
  if (t.accepts && !a.quote) return bad(400, "quote_required", `'${a.action}' accepts a quote: send the quote's reference as quote`);
  const runId = randomUUID();
  // Claim the quote for this run: the same app, customer, product and environment, from the same vendor, completed,
  // unexpired and not accepted before. Claiming is one UPDATE, so two accepts of one quote can't both go through.
  let quoteId: string | undefined;
  if (t.accepts) {
    const { rows: claimed } = await store.db.query(
      `UPDATE ${T}.vendor_action_runs q SET accepted_by = $2
       FROM ${T}.vendor_subscriptions s, ${T}.vendor_offerings o
       WHERE q.id::text = $1 AND q.app_id = $3 AND q.customer_ref = $4 AND q.sandbox = $5 AND q.product_id = $6 AND q.service_type = $7
         AND q.status = 'completed' AND q.quote_id IS NOT NULL AND q.accepted_by IS NULL AND q.quote_expires_at > now()
         AND s.id = q.subscription_id AND o.id = s.offering_id AND o.entity_id = $8
       RETURNING q.quote_id`,
      [a.quote, runId, a.app_id, a.customer_ref, a.sandbox, a.record.product.id, t.accepts, bound.o.entity_id],
    );
    if (!claimed[0]) {
      const { rows: seen } = uuidLike(a.quote!)
        ? await store.db.query(`SELECT accepted_by, quote_expires_at FROM ${T}.vendor_action_runs WHERE id = $1 AND app_id = $2 AND customer_ref = $3 AND sandbox = $4 AND service_type = $5`, [
            a.quote,
            a.app_id,
            a.customer_ref,
            a.sandbox,
            t.accepts,
          ])
        : { rows: [] };
      const q = seen[0] as { accepted_by: string | null; quote_expires_at: Date | string | null } | undefined;
      if (!q || !q.quote_expires_at) return bad(404, "quote_not_found", "No quote with that reference for this customer");
      if (q.accepted_by) return bad(409, "quote_used", "This quote was already accepted");
      return bad(409, "quote_expired", "This quote has expired; get a new one");
    }
    quoteId = claimed[0].quote_id as string;
  }
  const releaseQuote = () =>
    t.accepts ? store.db.query(`UPDATE ${T}.vendor_action_runs SET accepted_by = NULL WHERE id::text = $1 AND accepted_by = $2`, [a.quote, runId]) : Promise.resolve();
  // The run exists before the call, so a vendor that calls back before answering still finds it.
  const run: RunRow = {
    id: runId,
    request_id: randomUUID(),
    subscription_id: sub.id,
    entity_id: sub.entity_id,
    app_id: a.app_id,
    session_id: a.session_id,
    product_id: a.record.product.id,
    contract_hash: a.record.pins?.contract?.contract_hash ?? null,
    action: a.action,
    service_type: t.key,
    customer_ref: a.customer_ref,
    sandbox: a.sandbox,
    status: "calling",
    client_outcome: {},
  };
  await store.db.query(
    `INSERT INTO ${T}.vendor_action_runs (id, request_id, subscription_id, entity_id, app_id, session_id, product_id, contract_hash, action, service_type, customer_ref, sandbox, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'calling')`,
    [run.id, run.request_id, run.subscription_id, run.entity_id, run.app_id, run.session_id, run.product_id, run.contract_hash, run.action, run.service_type, run.customer_ref, run.sandbox],
  );
  // Nothing is kept of a call that was refused, failed, answered badly or threw, and its quote can be accepted again
  // (vendors treat a repeated quote_id as the same order, so a retry can't execute twice).
  const discard = async () => {
    await store.db.query(`DELETE FROM ${T}.vendor_action_runs WHERE id = $1 AND status = 'calling'`, [run.id]);
    await releaseQuote();
  };
  let answer: VendorAnswer;
  try {
    answer = await callBoundVendor(
      store,
      bound,
      { sandbox: a.sandbox, request_id: run.request_id, held: a.held, consent: a.consent, allowPending: true, params: a.params, quote_id: quoteId, customer_key: rampCustomerKey(a.app_id, a.customer_ref) },
      opts,
    );
  } catch (e) {
    await discard();
    throw e;
  }
  if (answer.kind === "error") {
    await discard();
    return answer;
  }
  if (answer.kind === "pending") {
    const outcome = { status: "pending", ...(t.client_result?.redirect && answer.redirect_url ? { redirect_url: answer.redirect_url } : {}) };
    const { rows } = await store.db.query(`UPDATE ${T}.vendor_action_runs SET status = 'pending', client_outcome = $2 WHERE id = $1 AND status = 'calling' RETURNING *`, [
      run.id,
      JSON.stringify(outcome),
    ]);
    // Without a row, the vendor's callback finished it first.
    return { kind: "ok", outcome: rows[0] ? outcomeOf(rows[0] as RunRow) : await currentRun(store, run.id) };
  }
  return { kind: "ok", outcome: (await finishRun(store, run, t, { kind: "output", output: answer.output }, false)) ?? (await currentRun(store, run.id)) };
}

// A run's outcome as a device of the same app and customer may read it (e.g. back from the provider's page).
export async function vendorActionRun(store: Store, id: string, who: { app_id: string; customer_ref: string | null; sandbox: boolean }) {
  if (!uuidLike(id) || !who.customer_ref) return undefined;
  const { rows } = await store.db.query(`SELECT * FROM ${T}.vendor_action_runs WHERE id = $1 AND app_id = $2 AND customer_ref = $3 AND sandbox = $4`, [
    id,
    who.app_id,
    who.customer_ref,
    who.sandbox,
  ]);
  return rows[0] ? outcomeOf(rows[0] as RunRow) : undefined;
}

// POST /v1/vendor/callback/<subscription_id>: an asynchronous service's final answer, signed like Mynt's
// requests (Mynt-Signature with the subscription's signing secret, at most 300 s old). Idempotent on request_id.
// `admit` is asked only once the signature verified (a per-subscription rate limit).
export async function vendorCallback(
  store: Store,
  subscriptionId: string,
  raw: string,
  signature: string | undefined,
  admit: () => boolean = () => true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const refused = { status: 401, body: { error: "bad_signature", message: 'Sign the body with the subscription\'s signing secret (Mynt-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">), at most 300 s old' } };
  const sub = await getSubscription(store.db, subscriptionId);
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature ?? "");
  if (!sub || !m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return refused;
  const secret = open((await sealedColumn(store.db, "vendor_subscriptions", "signing_secret", sub.id))!, false);
  const want = createHmac("sha256", secret).update(`${m[1]}.${raw}`).digest();
  if (!timingSafeEqual(want, Buffer.from(m[2], "hex"))) return refused;
  if (!admit()) return { status: 429, body: { error: "rate_limited", message: "Too many callbacks for this subscription" } };
  let body: { request_id?: unknown; status?: unknown; output?: unknown; error?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "invalid_json", message: "The body must be JSON" } };
  }
  if (typeof body?.request_id !== "string" || !uuidLike(body.request_id) || (body.status !== "ok" && body.status !== "error"))
    return { status: 400, body: { error: "invalid_request", message: 'Send { request_id, status: "ok" | "error", output }' } };
  const { rows } = await store.db.query(`SELECT * FROM ${T}.vendor_action_runs WHERE request_id = $1 AND subscription_id = $2`, [body.request_id, sub.id]);
  const run = rows[0] as RunRow | undefined;
  if (!run) return { status: 404, body: { error: "unknown_request", message: "No request with that request_id for this subscription" } };
  if (!OPEN.includes(run.status)) return { status: 200, body: { request_id: run.request_id, status: run.status, duplicate: true } };
  const bound = await resolveSubscription(store, sub.id);
  if (!bound) return { status: 409, body: { error: "service_missing", message: "The service type behind this subscription no longer exists" } };
  let end: End;
  if (body.status === "ok") {
    const problems = schemaProblems(bound.t.output_schema, body.output);
    if (problems.length) return { status: 400, body: { error: "invalid_output", message: "output doesn't match the service type's output schema", problems } };
    end = { kind: "output", output: body.output as Record<string, unknown> };
  } else {
    const code = (body.error as { code?: unknown } | null)?.code;
    end = { kind: "error", code: typeof code === "string" && /^[a-z0-9_]{1,60}$/.test(code) ? code : null };
  }
  // A late answer counts only while the customer's consent still stands; withdrawn, nothing of it is kept.
  const consent = await store.latestConsent(run.session_id, run.product_id, bound.t.consent_purpose);
  if (consent?.type !== "consent_given") end = { kind: "withdrawn" };
  const done = await finishRun(store, run, bound.t, end, true);
  if (!done) {
    const { rows: now } = await store.db.query(`SELECT status FROM ${T}.vendor_action_runs WHERE id = $1`, [run.id]);
    return { status: 200, body: { request_id: run.request_id, status: now[0]?.status, duplicate: true } };
  }
  const { rows: now } = await store.db.query(`SELECT status FROM ${T}.vendor_action_runs WHERE id = $1`, [run.id]);
  return { status: 200, body: { request_id: run.request_id, status: now[0]?.status } };
}

// After a ramp transfer completed, the partner reports it reversed (the bank sent the payment back, or it was
// refunded): the one change allowed after a run ended. The run becomes `reversed`; the device is told it failed
// (with the new transfer_status, and reversed: true); the innovator gets vendor_action.reversed with the sealed
// details, and the app a data-free handoff.reversed.
export async function reverseVendorRun(store: Store, at: { subscription_id: string; request_id: string }, output: Record<string, unknown>): Promise<boolean> {
  const { rows: found } = await store.db.query(`SELECT * FROM ${T}.vendor_action_runs WHERE request_id = $1 AND subscription_id = $2`, [at.request_id, at.subscription_id]);
  const run = found[0] as RunRow | undefined;
  if (!run) return false;
  const sealed = seal(JSON.stringify(output), run.sandbox, true);
  const shown = { status: "failed", ...(typeof output.transfer_status === "string" ? { transfer_status: output.transfer_status } : {}), reversed: true };
  const { rows } = await store.db.query(
    `UPDATE ${T}.vendor_action_runs SET status = 'reversed', client_outcome = client_outcome || $2::jsonb, late_result_sealed = $3 WHERE id = $1 AND status = 'completed' RETURNING id`,
    [run.id, JSON.stringify(shown), sealed],
  );
  const wasCompleted = rows.length > 0;
  await emitFirmEvent(
    store,
    run.entity_id,
    "vendor_action.reversed",
    {
      reference: run.id,
      request_id: run.request_id,
      product_id: run.product_id,
      action: run.action,
      service_type: run.service_type,
      subscription_id: run.subscription_id,
      app_id: run.app_id,
      customer_ref: run.customer_ref,
      sandbox: run.sandbox,
      // false: the run had already ended another way (a late settlement), so the customer was never told it completed
      run_was_completed: wasCompleted,
    },
    run.sandbox,
    sealed,
  );
  if (wasCompleted) await emitEvent(store, [run.app_id], "handoff.reversed", { product_id: run.product_id, reference: run.id, action: run.action, status: "failed", sandbox: run.sandbox }, run.sandbox);
  return true;
}

// The partner settled a ramp transfer after Mynt had already ended its run (its window passed, or the customer's
// consent was withdrawn): the money moved, so it's never dropped. The result is kept sealed on the run and the
// innovator gets vendor_action.late_settlement to handle it by hand; the device's answer doesn't change.
export async function lateVendorSettlement(store: Store, at: { subscription_id: string; request_id: string }, output: Record<string, unknown>): Promise<boolean> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.vendor_action_runs WHERE request_id = $1 AND subscription_id = $2`, [at.request_id, at.subscription_id]);
  const run = rows[0] as (RunRow & { status: string }) | undefined;
  if (!run) return false;
  const sealed = seal(JSON.stringify(output), run.sandbox, true);
  await store.db.query(`UPDATE ${T}.vendor_action_runs SET late_result_sealed = $2 WHERE id = $1`, [run.id, sealed]);
  await emitFirmEvent(
    store,
    run.entity_id,
    "vendor_action.late_settlement",
    {
      reference: run.id,
      request_id: run.request_id,
      product_id: run.product_id,
      action: run.action,
      service_type: run.service_type,
      subscription_id: run.subscription_id,
      app_id: run.app_id,
      customer_ref: run.customer_ref,
      sandbox: run.sandbox,
      run_status: run.status,
      needs: "manual_handling",
    },
    run.sandbox,
    sealed,
  );
  return true;
}

// Ends runs that will never finish: a call still "calling" after `callingMinutes` (the process died mid-call) and
// a "pending" one older than `pendingHours` (VENDOR_PENDING_EXPIRY_HOURS, default 24). Each ends as expired, and
// the innovator and the app are told (without data).
export async function sweepVendorActionRuns(store: Store, o: { callingMinutes?: number; pendingHours?: number; now?: Date } = {}): Promise<number> {
  const now = o.now ?? new Date();
  const pendingHours = o.pendingHours ?? (Number(process.env.VENDOR_PENDING_EXPIRY_HOURS) || 24);
  const { rows } = await store.db.query(
    `SELECT * FROM ${T}.vendor_action_runs
     WHERE (status = 'calling' AND created_at < $1::timestamptz - make_interval(mins => $2))
        OR (status = 'pending' AND created_at < $1::timestamptz - make_interval(hours => $3)
            -- A ramp transfer an adapter started has its own, longer window (bank transfers take business days): the
            -- adapter's poller ends it, voiding it at the partner first (src/ramp-adapters/).
            AND NOT EXISTS (SELECT 1 FROM ${T}.ramp_adapter_transfers t WHERE t.request_id = vendor_action_runs.request_id AND t.subscription_id = vendor_action_runs.subscription_id AND t.status = 'submitted'))
     ORDER BY created_at LIMIT 500`,
    [now.toISOString(), o.callingMinutes ?? 5, pendingHours],
  );
  let n = 0;
  for (const run of rows as RunRow[]) if (await finishRun(store, run, null, { kind: "expired" }, true)) n++;
  return n;
}

// ---- tools ----

const PriceSchema = z.object({ amount: z.number().min(0), currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217, e.g. INR, USD") });
const OfferingFields = {
  name: z.string().min(1).max(200),
  test_base_url: z.string().url().describe("HTTPS base URL of your test endpoint; Mynt calls POST <base>/v1/<service_type>"),
  live_base_url: z.string().url().optional().describe("HTTPS base URL of your live endpoint"),
  price: PriceSchema.describe("Your fixed price per call, for innovators to see; billing is between you and them, not through Mynt"),
  sla_notes: z.string().max(2000).default(""),
  licence_ids: z.array(z.string().uuid()).max(10).default([]).describe("Licences your firm holds (get_my_entity) that this offering relies on"),
  requires_credential: z.boolean().default(false).describe("true when subscribers must give Mynt a credential you issue them; it's sent as Authorization: Bearer"),
};

async function entityOf(store: Store, user: User) {
  return ((await store.getUser(user.id)) ?? user).entity_id;
}

// list_service_types, for vendors and innovators.
export function registerServiceTypeCatalog(server: McpServer, store: Store) {
  server.registerTool(
    "list_service_types",
    {
      title: "Standard services",
      description:
        "The standard services vendors offer per region (identity, KYC, account data, bureau, e-sign, e-mandate…): the input and output contract every vendor implements, the customer consent it needs, the fields it fills, and the licences subscriber and vendor must hold.",
      inputSchema: { region: z.string().optional(), category: z.enum(SERVICE_CATEGORIES).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ region, category }) => json(await serviceTypes(store.db, { region, category })),
  );
}

export function registerVendorAdminTools(server: McpServer, store: Store, user: User) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);

  server.registerTool(
    "set_mynt_ramp",
    {
      title: "Designate the Mynt Ramp",
      description:
        "Admin: name the firm that operates the Mynt Ramp, the one on- and off-ramp every product's fiat in and out goes through (category `ramp` service types). Today that's the licensed ramp partner, which holds funds in transit under its own licences. Only that firm may offer or list ramp services, and Mynt calls only its offerings. Omit entity_id to see the current one.",
      inputSchema: { entity_id: z.string().uuid().optional().describe("The ramp operator's firm (register_firm)") },
    },
    async ({ entity_id }) => {
      const current = await myntRampEntity(store);
      if (!entity_id) return json({ entity_id: current, name: current ? ((await store.getEntity(current))?.name ?? null) : null });
      const entity = await store.getEntity(entity_id);
      if (!entity) return fail(`No firm '${entity_id}'; register it with register_firm`);
      await store.setSetting(MYNT_RAMP_SETTING, { entity_id }, user.id);
      await audit("set_mynt_ramp", entity_id, { was: current });
      const { rows } = await store.db.query(
        `SELECT o.id FROM ${T}.vendor_offerings o JOIN ${T}.service_types t ON t.region = o.region AND t.key = o.service_type
         WHERE t.category = 'ramp' AND o.entity_id <> $1 AND o.status <> 'suspended'`,
        [entity_id],
      );
      const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, "");
      return json({
        entity_id,
        name: entity.name,
        // Until the partner's live endpoint exists, its offerings' test_base_url can be Mynt's own sandbox ramp.
        ...(publicUrl ? { sandbox_test_base_url: `${publicUrl}/ramp-sandbox` } : {}),
        ...(rows.length ? { note: `${rows.length} ramp offering(s) by another firm are no longer called; suspend them with suspend_vendor_offering` } : {}),
      });
    },
  );

  server.registerTool(
    "define_service_type",
    {
      title: "Define a standard service",
      description:
        "Admin: add or replace a standard service type in a region: the input and output JSON Schemas every vendor implements, the consent purpose, the data dictionary fields its output fills, and the licence types (from the region's regulatory model) the subscribing firm and the vendor must hold.",
      inputSchema: { service_type: ServiceTypeSchema },
    },
    async ({ service_type }) => {
      const { errors, fixtures } = await checkServiceType(store, service_type);
      if (errors.length) return fail("The service type can't be saved", { errors });
      const saved = await upsertServiceType(store, service_type, fixtures, user.id);
      await audit("define_service_type", `${saved.region}/${saved.key}`, { category: saved.category });
      return json(saved);
    },
  );

  server.registerTool(
    "load_service_types",
    {
      title: "Load the example standard services",
      description:
        "Admin: load the example service types shipped with Mynt (IN: PAN verification, CKYC, account aggregator data, bank statement analytics, credit bureau, DigiLocker, e-sign, e-mandate; US: identity, bank account verification, credit bureau, and the Mynt Ramp's on-ramp and off-ramp quotes and transfers). Each is checked like define_service_type; one whose licence types your regulatory model names differently is skipped with the reason, unless licence_map renames them.",
      inputSchema: {
        region: z.string().regex(/^[A-Z]{2}$/).optional(),
        licence_map: z.record(z.string(), z.string()).default({}).describe("Example licence type id → the id in your regulatory model"),
      },
    },
    async ({ region, licence_map }) => {
      const loaded: string[] = [];
      const skipped: { file: string; errors: string[] }[] = [];
      // Quote service types first, so a service type that accepts one finds it.
      const examples = exampleServiceTypes(region).sort((x, y) => Number(!(x.data as { quote?: boolean }).quote) - Number(!(y.data as { quote?: boolean }).quote));
      for (const { file, data } of examples) {
        const parsed = ServiceTypeSchema.safeParse(data);
        if (!parsed.success) {
          skipped.push({ file, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
          continue;
        }
        const t = parsed.data;
        t.innovator_licences = t.innovator_licences.map((id) => licence_map[id] ?? id);
        t.vendor_licences = t.vendor_licences.map((id) => licence_map[id] ?? id);
        const { errors, fixtures } = await checkServiceType(store, t);
        if (errors.length) skipped.push({ file, errors });
        else {
          await upsertServiceType(store, t, fixtures, user.id);
          loaded.push(`${t.region}/${t.key}`);
        }
      }
      await audit("load_service_types", region ?? "all", { loaded, skipped: skipped.map((s) => s.file) });
      return json({ loaded, skipped });
    },
  );

  server.registerTool(
    "suspend_vendor_offering",
    {
      title: "Suspend a vendor's offering",
      description: "Admin: stop an offering being listed or called (suspended: true), or lift that (false: it goes back to draft and must pass conformance again). Products bound to it drift, pausing new sales, until it's lifted.",
      inputSchema: { offering_id: z.string(), suspended: z.boolean().default(true), note: z.string().max(500).optional() },
      annotations: { destructiveHint: true },
    },
    async ({ offering_id, suspended, note }) => {
      const o = await getOffering(store.db, offering_id);
      if (!o) return fail(`No offering '${offering_id}'`);
      const status = suspended ? "suspended" : "draft";
      if (!suspended && o.status !== "suspended") return fail("That offering isn't suspended");
      await store.db.query(`UPDATE ${T}.vendor_offerings SET status = $2, status_note = $3, updated_at = now() WHERE id = $1`, [o.id, status, note ?? null]);
      await audit("suspend_vendor_offering", o.id, { suspended, note: note ?? null, vendor_entity_id: o.entity_id });
      return json({ ...o, status, status_note: note ?? null, drifted_products: await vendorDriftSweep(store, { offering_id: o.id }) });
    },
  );

  server.registerTool(
    "register_firm",
    {
      title: "Register a firm",
      description:
        "Admin: add a legal entity to Mynt by hand, with no members yet (e.g. a vendor). Then invite_user its people and add_entity_member them to it.",
      inputSchema: { name: z.string().min(1).max(200), ...EntityFactsSchema, regions: z.array(z.string()).default([]) },
    },
    async (e) => {
      const entity = await store.createEntity(user.id, { ...e, registration_numbers: {} });
      await audit("register_firm", entity.id, { name: entity.name });
      return json(entity);
    },
  );
}

export function registerVendorTools(server: McpServer, store: Store, user: User, opts: VendorCallOptions & { admin?: boolean } = {}) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const mine = async (id: string) => {
    const o = await getOffering(store.db, id);
    const entity = await entityOf(store, user);
    return o && (o.entity_id === entity || opts.admin) ? o : undefined;
  };
  // An admin acting on another firm's offering is recorded as an admin action, naming the firm.
  const auditOffering = async (action: string, o: Offering, details: Record<string, unknown>) => {
    const own = o.entity_id === (await entityOf(store, user));
    await audit(own ? action : `admin_${action}`, o.id, own ? details : { ...details, as_admin: true, vendor_entity_id: o.entity_id });
  };
  const checkUrls = async (urls: (string | undefined)[]) => {
    for (const u of urls.filter((x): x is string => Boolean(x)))
      try {
        await resolveVendorUrl(u, opts);
      } catch (e) {
        return `${u}: ${(e as Error).message}`;
      }
    return null;
  };
  const checkLicences = async (entityId: string, region: string, ids: string[]) => {
    const held = await store.licensesOf(entityId);
    const bad = ids.filter((id) => !held.some((l) => l.id === id && l.region === region));
    return bad.length ? `Your firm holds no licence ${bad.join(", ")} in ${region}; see get_my_entity` : null;
  };

  server.registerTool(
    "create_vendor_offering",
    {
      title: "Offer a standard service",
      description:
        "Vendor: offer a standard service type in a region from your test (and live) HTTPS endpoint, with your per-call price and the licences you hold for it. It starts as a draft: run_conformance, then update_vendor_offering { listed: true }. The conformance signing secret is shown once.",
      inputSchema: { region: z.string().regex(/^[A-Z]{2}$/), service_type: Key, ...OfferingFields },
    },
    async (o) => {
      const entityId = await entityOf(store, user);
      if (!entityId) return fail("You don't belong to a firm yet; an admin adds you to one");
      const t = await serviceType(store.db, o.region, o.service_type);
      if (!t) return fail(`No service type '${o.service_type}' in ${o.region}; see list_service_types`);
      const ramp = await rampRefusal(store, t, entityId);
      if (ramp) return fail(ramp);
      const bad = (await checkUrls([o.test_base_url, o.live_base_url])) ?? (await checkLicences(entityId, o.region, o.licence_ids));
      if (bad) return fail(bad);
      if (!vaultAvailable(false)) return fail("This server's vault key (MYNT_VAULT_KEY) isn't configured, so it can't keep signing secrets");
      const secret = newSecret();
      const { rows } = await store.db.query(
        `INSERT INTO ${T}.vendor_offerings (id, entity_id, region, service_type, name, test_base_url, live_base_url, price, sla_notes, licence_ids, requires_credential, conformance_secret, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [
          randomUUID(),
          entityId,
          o.region,
          o.service_type,
          o.name,
          o.test_base_url,
          o.live_base_url ?? null,
          JSON.stringify({ ...o.price, per: "call" }),
          o.sla_notes,
          o.licence_ids,
          o.requires_credential,
          seal(secret, false),
          user.id,
        ],
      );
      const offering = toOffering(rows[0]);
      await audit("create_vendor_offering", offering.id, { region: o.region, service_type: o.service_type });
      return json({
        ...offering,
        conformance_signing_secret: secret,
        note: "Shown once. Mynt signs its conformance requests with this secret; each subscriber gets its own (list_my_subscribers).",
        next: "run_conformance",
      });
    },
  );

  server.registerTool(
    "update_vendor_offering",
    {
      title: "Change or list an offering",
      description:
        "Vendor: change an offering (changing an endpoint or licences sends it back to draft, to pass conformance again), or list it (listed: true, once conformance passed) or take it off the list (listed: false; current subscribers keep it).",
      // No defaults here: a field left out keeps its value.
      inputSchema: {
        offering_id: z.string(),
        name: OfferingFields.name.optional(),
        test_base_url: OfferingFields.test_base_url.optional(),
        live_base_url: OfferingFields.live_base_url,
        price: OfferingFields.price.optional(),
        sla_notes: z.string().max(2000).optional(),
        licence_ids: z.array(z.string().uuid()).max(10).optional(),
        requires_credential: z.boolean().optional(),
        listed: z.boolean().optional(),
      },
    },
    async (args) => {
      const a = args as Partial<Record<keyof typeof OfferingFields, unknown>> & { offering_id: string; listed?: boolean };
      const o = await mine(a.offering_id);
      if (!o) return fail(`No offering of yours '${a.offering_id}'`);
      const bad =
        (await checkUrls([a.test_base_url as string | undefined, a.live_base_url as string | undefined])) ??
        (a.licence_ids ? await checkLicences(o.entity_id, o.region, a.licence_ids as string[]) : null);
      if (bad) return fail(bad);
      const next: Offering = {
        ...o,
        ...(a.name !== undefined ? { name: a.name as string } : {}),
        ...(a.test_base_url !== undefined ? { test_base_url: a.test_base_url as string } : {}),
        ...(a.live_base_url !== undefined ? { live_base_url: a.live_base_url as string } : {}),
        ...(a.price !== undefined ? { price: { ...(a.price as { amount: number; currency: string }), per: "call" as const } } : {}),
        ...(a.sla_notes !== undefined ? { sla_notes: a.sla_notes as string } : {}),
        ...(a.licence_ids !== undefined ? { licence_ids: a.licence_ids as string[] } : {}),
        ...(a.requires_credential !== undefined ? { requires_credential: a.requires_credential as boolean } : {}),
      };
      const reverify = next.test_base_url !== o.test_base_url || next.live_base_url !== o.live_base_url || JSON.stringify(next.licence_ids) !== JSON.stringify(o.licence_ids);
      if (reverify && o.status !== "suspended") next.status = "draft";
      if (a.listed !== undefined) {
        if (o.status === "suspended") return fail("An admin suspended this offering");
        if (a.listed) {
          if (next.status !== "conformance_passed" && next.status !== "listed") return fail("Run run_conformance until it passes before listing");
          const t = (await serviceType(store.db, o.region, o.service_type))!;
          const gap = (await rampRefusal(store, t, o.entity_id)) ?? (await vendorLicenceGap(store, next, t));
          if (gap) return fail(gap);
          next.status = "listed";
        } else if (next.status === "listed") next.status = "conformance_passed";
      }
      const { rows } = await store.db.query(
        `UPDATE ${T}.vendor_offerings SET name = $2, test_base_url = $3, live_base_url = $4, price = $5, sla_notes = $6, licence_ids = $7, requires_credential = $8, status = $9, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [o.id, next.name, next.test_base_url, next.live_base_url, JSON.stringify(next.price), next.sla_notes, next.licence_ids, next.requires_credential, next.status],
      );
      await auditOffering("update_vendor_offering", o, { status: next.status, reverify, fields: Object.keys(a).filter((k) => k !== "offering_id") });
      return json(toOffering(rows[0]));
    },
  );

  server.registerTool(
    "run_conformance",
    {
      title: "Have Mynt test your endpoint",
      description:
        "Vendor: Mynt calls your test endpoint with signed fixture requests and checks every answer against the service type's output schema, that a badly signed request is refused, and your licences. A pass lets you list the offering. If you require a credential, pass a test one; it isn't kept.",
      inputSchema: { offering_id: z.string(), test_credential: z.string().min(1).max(2000).optional() },
    },
    async ({ offering_id, test_credential }) => {
      const o = await mine(offering_id);
      if (!o) return fail(`No offering of yours '${offering_id}'`);
      if (o.requires_credential && !test_credential) return fail("This offering requires a credential: pass a test_credential");
      const t = (await serviceType(store.db, o.region, o.service_type))!;
      const result = await runConformance(store, o, t, opts, user.id, test_credential ?? null);
      await auditOffering("run_conformance", o, { passed: result.passed });
      return json(result);
    },
  );

  server.registerTool(
    "list_my_offerings",
    {
      title: "My offerings",
      description: "Vendor: your firm's offerings, their status, the last conformance run and how many firms subscribe.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const entityId = await entityOf(store, user);
      if (!entityId) return fail("You don't belong to a firm yet; an admin adds you to one");
      const { rows } = await store.db.query(`SELECT * FROM ${T}.vendor_offerings WHERE entity_id = $1 ORDER BY created_at`, [entityId]);
      const out = [];
      for (const o of rows.map(toOffering)) {
        const run = (await store.db.query(`SELECT id, passed, cases, created_at FROM ${T}.vendor_conformance_runs WHERE offering_id = $1 ORDER BY created_at DESC LIMIT 1`, [o.id])).rows[0];
        const subs = (await store.db.query(`SELECT count(*)::int AS n FROM ${T}.vendor_subscriptions WHERE offering_id = $1 AND status = 'active'`, [o.id])).rows[0];
        out.push({ ...o, last_conformance: run ? { run_id: run.id, passed: run.passed, cases: run.cases, at: iso(run.created_at) } : null, subscribers: subs?.n ?? 0 });
      }
      return json(out);
    },
  );

  server.registerTool(
    "list_my_subscribers",
    {
      title: "Who subscribes to my offerings",
      description:
        "Vendor: firms subscribed to your offerings, whether they're live, whether you've taken each signing secret (reveal_subscription_secret), and calls per day (counts only).",
      inputSchema: { offering_id: z.string().optional(), days: z.number().int().min(1).max(90).default(30) },
    },
    async ({ offering_id, days }) => {
      const entityId = await entityOf(store, user);
      if (!entityId) return fail("You don't belong to a firm yet; an admin adds you to one");
      const { rows } = await store.db.query(
        `SELECT s.*, o.name AS offering_name, e.name AS subscriber FROM ${T}.vendor_subscriptions s
         JOIN ${T}.vendor_offerings o ON o.id = s.offering_id JOIN ${T}.entities e ON e.id = s.entity_id
         WHERE o.entity_id = $1 AND ($2::text IS NULL OR o.id::text = $2) ORDER BY s.created_at`,
        [entityId, offering_id ?? null],
      );
      const usage = await usageOf(store.db, rows.map((r) => r.id as string), days);
      const out = [];
      for (const r of rows) {
        const s = toSubscription(r);
        out.push({
          subscription_id: s.id,
          offering_id: s.offering_id,
          offering: r.offering_name,
          subscriber: r.subscriber,
          live: s.live,
          status: s.status,
          created_at: s.created_at,
          secret_revealed: s.secret_shown,
          usage: usageFor(usage, s.id),
        });
      }
      return json(out);
    },
  );

  // A subscription to one of the caller's offerings (admins: any).
  const subscriberOf = async (id: string) => {
    const sub = await getSubscription(store.db, id);
    const o = sub && (await mine(sub.offering_id));
    return sub && o && sub.status === "active" ? { sub, o } : undefined;
  };

  server.registerTool(
    "reveal_subscription_secret",
    {
      title: "Take a subscriber's signing secret",
      description:
        "Vendor: the secret Mynt signs a subscriber's requests with (verify Mynt-Signature with it). Shown once; if it's lost, rotate_subscription_secret.",
      inputSchema: { subscription_id: z.string() },
    },
    async ({ subscription_id }) => {
      const found = await subscriberOf(subscription_id);
      if (!found) return fail(`No active subscription '${subscription_id}' to your offerings`);
      // One statement, so two callers can't both see it.
      const { rows } = await store.db.query(
        `UPDATE ${T}.vendor_subscriptions SET secret_shown_at = now() WHERE id = $1 AND secret_shown_at IS NULL RETURNING signing_secret`,
        [found.sub.id],
      );
      if (!rows[0]) return fail("That secret was already revealed; rotate_subscription_secret for a new one");
      await auditOffering("reveal_subscription_secret", found.o, { subscription_id: found.sub.id });
      return json({ subscription_id: found.sub.id, signing_secret: open(rows[0].signing_secret as string, false), note: "Shown once: keep it to verify Mynt-Signature on this subscriber's requests" });
    },
  );

  server.registerTool(
    "rotate_subscription_secret",
    {
      title: "Rotate a subscriber's signing secret",
      description: "Vendor: replace a subscriber's signing secret. Mynt signs with the new one at once and the old one stops verifying. The new one is shown once, here.",
      inputSchema: { subscription_id: z.string() },
    },
    async ({ subscription_id }) => {
      const found = await subscriberOf(subscription_id);
      if (!found) return fail(`No active subscription '${subscription_id}' to your offerings`);
      const secret = newSecret();
      await store.db.query(`UPDATE ${T}.vendor_subscriptions SET signing_secret = $2, secret_shown_at = now() WHERE id = $1`, [found.sub.id, seal(secret, false)]);
      await auditOffering("rotate_subscription_secret", found.o, { subscription_id: found.sub.id });
      return json({ subscription_id: found.sub.id, signing_secret: secret, note: "Shown once. The previous secret no longer verifies." });
    },
  );
}

export function registerVendorInnovatorTools(server: McpServer, store: Store, user: User, opts: { admin?: boolean } = {}) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const mySubscription = async (id: string) => {
    const s = await getSubscription(store.db, id);
    const entity = await entityOf(store, user);
    return s && entity && s.entity_id === entity ? s : undefined;
  };
  // A vendor credential into the firm's key vault (sealed; never returned).
  const vaultKey = async (entityId: string, type: (typeof KEY_TYPES)[number], label: string, value: string) => {
    const id = randomUUID();
    await store.db.query(`INSERT INTO ${T}.key_vault (id, entity_id, type, label, sealed, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [id, entityId, type, label, seal(value, false), user.id]);
    return id;
  };
  const subscriptionView = async (s: Subscription) => {
    const o = (await getOffering(store.db, s.offering_id))!;
    const vendor = await store.getEntity(o.entity_id);
    const keyView = async (id: string | null) => {
      const k = id ? (await store.db.query(`SELECT id, label, created_at FROM ${T}.key_vault WHERE id = $1`, [id])).rows[0] : null;
      return k ? { key_id: k.id, label: k.label, set_at: iso(k.created_at) } : null;
    };
    return {
      subscription_id: s.id,
      offering_id: o.id,
      offering: o.name,
      region: o.region,
      service_type: o.service_type,
      vendor: vendor?.name ?? o.entity_id,
      vendor_party_id: s.party_id,
      live: s.live,
      status: s.status,
      offering_status: o.status,
      credentials: { test: await keyView(s.test_credential_key_id), live: await keyView(s.live_credential_key_id) },
      created_at: s.created_at,
      ended_at: s.ended_at,
    };
  };

  server.registerTool(
    "list_vendor_offerings",
    {
      title: "Standard services you can plug in",
      description:
        "Innovator: listed vendors' offerings of standard services, by region, service type or category: price per call, SLA notes, the vendor's licences, and whether your firm meets the licence prerequisites to subscribe.",
      inputSchema: {
        region: z.string().optional(),
        service_type: z.string().optional(),
        category: z.enum(SERVICE_CATEGORIES).optional(),
        include_unlisted: z.boolean().default(false).describe("Admins: every offering, whatever its status"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ region, service_type, category, include_unlisted }) => {
      const entityId = await entityOf(store, user);
      const { rows } = await store.db.query(
        `SELECT o.* FROM ${T}.vendor_offerings o JOIN ${T}.service_types t ON t.region = o.region AND t.key = o.service_type
         WHERE ($1::boolean OR o.status = 'listed') AND ($2::text IS NULL OR o.region = $2) AND ($3::text IS NULL OR o.service_type = $3) AND ($4::text IS NULL OR t.category = $4)
         ORDER BY o.region, o.service_type, o.created_at`,
        [Boolean(include_unlisted && opts.admin), region ?? null, service_type ?? null, category ?? null],
      );
      const out = [];
      for (const o of rows.map(toOffering)) {
        const t = (await serviceType(store.db, o.region, o.service_type))!;
        const vendor = await store.getEntity(o.entity_id);
        const licences = (await store.licensesOf(o.entity_id)).filter((l) => o.licence_ids.includes(l.id)).map(licenceView);
        const gap = entityId ? await innovatorLicenceGap(store, entityId, t) : "You don't belong to a firm";
        out.push({
          offering_id: o.id,
          name: o.name,
          vendor: vendor?.name ?? o.entity_id,
          region: o.region,
          service_type: { key: t.key, name: t.name, category: t.category, consent_purpose: t.consent_purpose, fills: t.fills },
          price: o.price,
          sla_notes: o.sla_notes,
          live_available: Boolean(o.live_base_url),
          requires_credential: o.requires_credential,
          vendor_licences: licences,
          ...(include_unlisted && opts.admin ? { status: o.status } : {}),
          you_can_subscribe: !gap,
          ...(gap ? { prerequisite: gap } : {}),
        });
      }
      return json(out);
    },
  );

  server.registerTool(
    "subscribe_vendor_service",
    {
      title: "Subscribe to a vendor's service",
      description:
        "Innovator: subscribe your firm to a listed offering (in the sandbox first). Checks the licences the service needs your firm to hold, keeps the test (and live) credentials the vendor gave you, if it needs them, in your firm's key vault, never shown again, and adds the vendor to your roster as a party. Then bind a partner handoff to it: handoff_to_party to that party with attributes.vendor_subscription_id.",
      inputSchema: {
        offering_id: z.string(),
        test_credential: z.string().min(1).max(2000).optional().describe("The test API credential the vendor issued your firm, if the offering requires one; sent only to its test endpoint"),
        live_credential: z.string().min(1).max(2000).optional().describe("The live credential; sent only to its live endpoint (can also be given to set_subscription_live)"),
        credential_label: z.string().min(1).max(100).optional(),
      },
    },
    async ({ offering_id, test_credential, live_credential, credential_label }) => {
      const entityId = await entityOf(store, user);
      if (!entityId) return fail("You don't belong to an entity yet; create one with create_entity");
      const o = await getOffering(store.db, offering_id);
      if (!o || o.status !== "listed") return fail(`No listed offering '${offering_id}'; see list_vendor_offerings`);
      const t = (await serviceType(store.db, o.region, o.service_type))!;
      const gap = await innovatorLicenceGap(store, entityId, t);
      if (gap) return fail(gap);
      if (o.requires_credential && !test_credential) return fail(`${o.name} requires a credential the vendor issues you: pass its test one as test_credential`);
      const existing = (await store.db.query(`SELECT id FROM ${T}.vendor_subscriptions WHERE offering_id = $1 AND entity_id = $2 AND status = 'active'`, [o.id, entityId])).rows[0];
      if (existing) return fail(`Your firm already subscribes to this offering (${existing.id})`);
      if (!vaultAvailable(false)) return fail("This server's vault key (MYNT_VAULT_KEY) isn't configured, so it can't keep credentials or signing secrets");
      // The vendor stands behind the handoffs bound to it, so it goes on the roster (an existing party is reused).
      let party = (await store.partiesOf(entityId)).find((p) => p.kind === "external" && p.legal_entity_id === o.entity_id && partyActive(p));
      let created = false;
      if (!party) {
        const errors = await validateParty(store, entityId, { kind: "external", legal_entity_id: o.entity_id, fills: [] });
        if (errors.length) return fail("The vendor can't join your roster", { errors });
        party = await store.addParty(user.id, { entity_id: entityId, kind: "external", person: null, legal_entity_id: o.entity_id, attributes: {}, fills: [], relationship: "vendor_service_agreement", since: today() });
        created = true;
        await audit("add_party", party.id, { entity_id: entityId, kind: "external", via: "subscribe_vendor_service" });
      }
      const label = credential_label ?? o.name;
      const testKey = test_credential ? await vaultKey(entityId, "vendor_test_credential", `${label} (test)`, test_credential) : null;
      const liveKey = live_credential ? await vaultKey(entityId, "vendor_live_credential", `${label} (live)`, live_credential) : null;
      const { rows } = await store.db.query(
        `INSERT INTO ${T}.vendor_subscriptions (id, offering_id, entity_id, party_id, party_created, signing_secret, test_credential_key_id, live_credential_key_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [randomUUID(), o.id, entityId, party.id, created, seal(newSecret(), false), testKey, liveKey, user.id],
      );
      const s = toSubscription(rows[0]);
      await audit("subscribe_vendor_service", s.id, { offering_id: o.id, test_credential: Boolean(testKey), live_credential: Boolean(liveKey) });
      return json({
        ...(await subscriptionView(s)),
        next: `Bind a partner handoff: handoff_to_party to party ${party.id} with attributes { vendor_subscription_id: '${s.id}', service_type: '${t.key}', consent_purpose: '${t.consent_purpose}' }. Sandbox sessions then call the vendor's test endpoint; set_subscription_live when you're ready for live.`,
      });
    },
  );

  server.registerTool(
    "list_my_vendor_subscriptions",
    {
      title: "My firm's vendor services",
      description: "Innovator: the vendor services your firm subscribes to, whether each is live, its credential (label only) and calls per day (counts only).",
      inputSchema: { days: z.number().int().min(1).max(90).default(30), include_ended: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async ({ days, include_ended }) => {
      const entityId = await entityOf(store, user);
      if (!entityId) return fail("You don't belong to an entity yet; create one with create_entity");
      const { rows } = await store.db.query(`SELECT * FROM ${T}.vendor_subscriptions WHERE entity_id = $1 AND ($2::boolean OR status = 'active') ORDER BY created_at`, [entityId, include_ended]);
      const subs = rows.map(toSubscription);
      const usage = await usageOf(store.db, subs.map((s) => s.id), days);
      const out = [];
      for (const s of subs) out.push({ ...(await subscriptionView(s)), usage: usageFor(usage, s.id) });
      return json(out);
    },
  );

  server.registerTool(
    "set_subscription_live",
    {
      title: "Turn a vendor service live",
      description:
        "Innovator: let live sessions call the vendor's live endpoint (live: true), or stop that (false). Sandbox sessions always use its test endpoint. Give the live credential here if the offering needs one and you haven't yet; it replaces any earlier one.",
      inputSchema: { subscription_id: z.string(), live: z.boolean(), live_credential: z.string().min(1).max(2000).optional() },
    },
    async ({ subscription_id, live, live_credential }) => {
      const s = await mySubscription(subscription_id);
      if (!s || s.status !== "active") return fail(`No active subscription of your firm '${subscription_id}'`);
      if (live) {
        const o = (await getOffering(store.db, s.offering_id))!;
        if (o.status !== "listed") return fail(`The offering is ${o.status}, not listed`);
        if (!o.live_base_url) return fail("The vendor hasn't given a live endpoint yet");
        const gap = await innovatorLicenceGap(store, s.entity_id, (await serviceType(store.db, o.region, o.service_type))!);
        if (gap) return fail(gap);
        if (o.requires_credential && !live_credential && !s.live_credential_key_id) return fail(`${o.name} requires a credential: pass the live one the vendor issued you as live_credential`);
      }
      if (live_credential) {
        const old = s.live_credential_key_id;
        s.live_credential_key_id = await vaultKey(s.entity_id, "vendor_live_credential", `${(await getOffering(store.db, s.offering_id))!.name} (live)`, live_credential);
        await store.db.query(`UPDATE ${T}.vendor_subscriptions SET live_credential_key_id = $2 WHERE id = $1`, [s.id, s.live_credential_key_id]);
        if (old) await store.db.query(`DELETE FROM ${T}.key_vault WHERE id = $1`, [old]);
      }
      await store.db.query(`UPDATE ${T}.vendor_subscriptions SET live = $2 WHERE id = $1`, [s.id, live]);
      await audit("set_subscription_live", s.id, { live, live_credential_replaced: Boolean(live_credential) });
      return json(await subscriptionView({ ...s, live }));
    },
  );

  server.registerTool(
    "unsubscribe_vendor_service",
    {
      title: "End a vendor service",
      description:
        "Innovator: end your firm's subscription. Refused while a live product version hands off through it (publish a version without it first). Its credentials are deleted from your key vault, and the vendor leaves your roster if it joined for this subscription.",
      inputSchema: { subscription_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ subscription_id }) => {
      const s = await mySubscription(subscription_id);
      if (!s || s.status !== "active") return fail(`No active subscription of your firm '${subscription_id}'`);
      const using = (await store.pinnedProducts(s.entity_id)).filter((r) => r.status === "published" && r.pins?.vendor_bindings?.some((b) => b.subscription_id === s.id));
      if (using.length) return fail(`Live products hand off through it: ${using.map((r) => r.product.id).join(", ")}. Publish versions without it first.`);
      await store.db.query(
        `UPDATE ${T}.vendor_subscriptions SET status = 'ended', live = false, ended_at = now(), test_credential_key_id = NULL, live_credential_key_id = NULL WHERE id = $1`,
        [s.id],
      );
      for (const k of [s.test_credential_key_id, s.live_credential_key_id]) if (k) await store.db.query(`DELETE FROM ${T}.key_vault WHERE id = $1`, [k]);
      let partyEnded = false;
      if (s.party_created) {
        const others = (await store.db.query(`SELECT 1 FROM ${T}.vendor_subscriptions WHERE party_id = $1 AND status = 'active'`, [s.party_id])).rows.length;
        if (!others) {
          await store.endParty(s.party_id, today());
          partyEnded = true;
        }
      }
      await audit("unsubscribe_vendor_service", s.id, { party_ended: partyEnded });
      return json({ subscription_id: s.id, status: "ended", party_ended: partyEnded, drifted_products: partyEnded ? await driftSweep(store, s.entity_id) : [] });
    },
  );

  // ---- the firm's own webhooks: results of client actions its vendor services answered ----

  server.registerTool(
    "create_firm_webhook",
    {
      title: "Receive your vendor services' results",
      description:
        "Innovator: an https URL where Mynt sends your firm the full result of every client action a product's bound vendor service answered (vendor_action.completed, with data.result) or that failed (vendor_action.failed), so your firm acts on it; apps' devices only get a status. Each POST carries Mynt-Signature (t=<unix>,v1=<HMAC-SHA256 of \"t.body\" with the secret>). The secret is shown once.",
      inputSchema: { url: z.string().url(), events: z.array(z.enum(FIRM_WEBHOOK_EVENTS)).min(1).default([...FIRM_WEBHOOK_EVENTS]) },
    },
    async ({ url, events }) => {
      const entityId = await entityOf(store, user);
      if (!entityId) return fail("Register your firm first (create_entity)");
      const problem = await checkWebhookUrl(url);
      if (problem) return fail(problem);
      if ((await store.firmWebhooks(entityId)).length >= 5) return fail("A firm can have at most 5 webhooks");
      const { webhook, secret } = await store.createFirmWebhook(user.id, { entity_id: entityId, url, events: [...new Set(events)] });
      await audit("create_firm_webhook", webhook.id, { entity_id: entityId, url, events: webhook.events });
      return json({ id: webhook.id, url: webhook.url, events: webhook.events, created_at: webhook.created_at, secret, note: "Save the signing secret now; it can't be shown again." });
    },
  );

  server.registerTool(
    "list_firm_webhooks",
    {
      title: "My firm's webhooks",
      description: "Innovator: your firm's webhooks for vendor service results, with their recent deliveries (status and response code only).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const entityId = await entityOf(store, user);
      if (!entityId) return json([]);
      const hooks = await store.firmWebhooks(entityId);
      return json(
        await Promise.all(
          hooks.map(async (h) => ({
            id: h.id,
            url: h.url,
            events: h.events,
            created_at: h.created_at,
            deliveries: (await store.webhookDeliveries(h.id, 20)).map((d) => ({ type: d.type, status: d.status, attempts: d.attempts, last_response_code: d.last_response_code, sandbox: d.sandbox, created_at: d.created_at })),
          })),
        ),
      );
    },
  );

  server.registerTool(
    "delete_firm_webhook",
    {
      title: "Delete a firm webhook",
      description: "Innovator: stop sending vendor service results to one of your firm's webhooks, and drop its delivery history.",
      inputSchema: { webhook_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ webhook_id }) => {
      const entityId = await entityOf(store, user);
      const hook = entityId ? (await store.firmWebhooks(entityId)).find((h) => h.id === webhook_id) : undefined;
      if (!hook) return fail(`No webhook '${webhook_id}' of your firm`);
      await store.deleteWebhook(hook.id);
      await audit("delete_firm_webhook", hook.id, { entity_id: entityId, url: hook.url });
      return json({ deleted: hook.id });
    },
  );
}
