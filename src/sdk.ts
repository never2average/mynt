import { flutterSdk, kotlinSdk, reactNativeSdk, swiftSdk } from "./sdk-clients.js";
import { createHash } from "node:crypto";
import { BuildTermsSchema, DEFAULT_PERMITTED, EXPERIENCE_ACTIONS } from "./access.js";
import type { BuildTerms, ProductRecord } from "./store.js";

// Generates versioned SDK bundles (an OpenAPI document plus typed clients) for the runtime API
// apps call with their keys: GET /v1/products, GET /v1/products/{id}, POST /v1/handoffs,
// POST /v1/events, and signed webhooks. Product text only ever lands in generated code as string
// literals (never in comments), so innovator-supplied content can't break the output.

export const SDK_LANGUAGES = ["typescript", "python", "react_native", "kotlin", "swift", "flutter"] as const;
export type SdkLanguage = (typeof SDK_LANGUAGES)[number];
export const HANDOFFS = ["deep_link", "initiate_onboarding"] as const;
export const EVENT_TYPES = ["view", "click", "handoff_started"] as const;
export const WEBHOOK_EVENTS = [
  "product.version_published",
  "product.unpublished",
  "product.suspended",
  "product.drifted",
  "product.drift_cleared",
  "access.approved",
  "access.revoked",
  "request.decided",
  "handoff.completed",
  "handoff.failed",
] as const;

export interface SdkProduct {
  record: ProductRecord;
  issuer: string | null;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export const fullTerms = (t: BuildTerms) => {
  const terms = { ...BuildTermsSchema.parse({}), ...t };
  if (!terms.permitted_actions.length) terms.permitted_actions = [...DEFAULT_PERMITTED] as never;
  return terms;
};

// Stable JSON (sorted keys), so equal terms always hash the same.
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(",")}]`
    : v && typeof v === "object"
      ? `{${Object.keys(v)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
      : JSON.stringify(v);

export const termsHash = (t: BuildTerms) => createHash("sha256").update(stable(fullTerms(t))).digest("hex").slice(0, 16);

export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const compareSemver = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

type FieldKind = "string" | "number" | "integer" | "boolean" | "string[]" | "number[]" | "object" | "unknown";
const kindOf = (v: unknown): FieldKind => {
  if (typeof v === "string") return "string";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v)) return v.every((x) => typeof x === "number") && v.length ? "number[]" : v.every((x) => typeof x === "string") ? "string[]" : "unknown";
  if (v && typeof v === "object") return "object";
  return "unknown";
};

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("") || "Product";

// Unique type names per product id, e.g. "green-fd" -> GreenFdProduct.
function typeNames(ids: string[]) {
  const used = new Set<string>();
  return new Map(
    ids.map((id) => {
      let base = pascal(id);
      if (/^\d/.test(base)) base = `P${base}`;
      let name = `${base}Product`;
      for (let i = 2; used.has(name); i++) name = `${base}Product${i}`;
      used.add(name);
      return [id, name];
    }),
  );
}

const fields = (p: SdkProduct) => Object.entries(p.record.product as unknown as Record<string, unknown>);

export function openApiDocument(name: string, version: string, baseUrl: string, products: SdkProduct[]) {
  const names = typeNames(products.map((p) => p.record.product.id));
  const jsonType = (k: FieldKind): Record<string, unknown> =>
    k === "string[]"
      ? { type: "array", items: { type: "string" } }
      : k === "number[]"
        ? { type: "array", items: { type: "number" } }
        : k === "unknown"
          ? {}
          : { type: k };
  const productSchemas = Object.fromEntries(
    products.map((p) => {
      const id = p.record.product.id;
      const terms = fullTerms(p.record.build_terms);
      const props: Record<string, unknown> = Object.fromEntries(fields(p).map(([k, v]) => [k, jsonType(kindOf(v))]));
      props.id = { type: "string", const: id };
      props.version = { type: "integer", minimum: 1 };
      props.build_terms = { $ref: "#/components/schemas/BuildTerms" };
      return [
        names.get(id)!,
        {
          type: "object",
          title: p.record.product.name,
          "x-mynt-product-id": id,
          "x-mynt-permitted-actions": terms.permitted_actions,
          "x-mynt-required-disclosures": terms.required_disclosures,
          "x-mynt-branding": terms.branding,
          properties: props,
          required: [...new Set([...fields(p).map(([k]) => k), "version", "build_terms"])],
        },
      ];
    }),
  );
  const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
  const errors = {
    "400": { description: "Invalid request", content: { "application/json": { schema: ref("Error") } } },
    "401": { description: "Missing or invalid app key", content: { "application/json": { schema: ref("Error") } } },
    "403": { description: "The app may not use this product or action", content: { "application/json": { schema: ref("Error") } } },
    "404": { description: "Not found", content: { "application/json": { schema: ref("Error") } } },
    "429": {
      description: "Rate limited",
      headers: { "Retry-After": { schema: { type: "integer" }, description: "Seconds to wait" } },
      content: { "application/json": { schema: ref("Error") } },
    },
  };
  const productIds = products.map((p) => p.record.product.id);
  return {
    openapi: "3.1.0",
    info: {
      title: `${name} (Mynt app API)`,
      version,
      description:
        "Read the products your app may show, hand users off to the innovator's own regulated flow, and report engagement. Apps never collect funds or financial data.",
    },
    servers: [{ url: `${baseUrl}/v1`, description: "Use a mynt_test_ key for the sandbox and a mynt_live_ key in production" }],
    security: [{ appKey: [] }],
    paths: {
      "/products": {
        get: {
          operationId: "listProducts",
          summary: "Products this app may show",
          responses: {
            "200": { description: "Products", content: { "application/json": { schema: { type: "array", items: ref("Product") } } } },
            ...errors,
          },
        },
      },
      "/products/{id}": {
        get: {
          operationId: "getProduct",
          summary: "One product",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", enum: productIds } }],
          responses: { "200": { description: "The product", content: { "application/json": { schema: ref("Product") } } }, ...errors },
        },
      },
      "/handoffs": {
        post: {
          operationId: "startHandoff",
          summary: "Hand the user off to the innovator's flow",
          requestBody: { required: true, content: { "application/json": { schema: ref("HandoffRequest") } } },
          responses: { "200": { description: "Where to send the user", content: { "application/json": { schema: ref("Handoff") } } }, ...errors },
        },
      },
      "/events": {
        post: {
          operationId: "trackEvent",
          summary: "Report an engagement event",
          requestBody: { required: true, content: { "application/json": { schema: ref("Event") } } },
          responses: { "202": { description: "Accepted" }, ...errors },
        },
      },
      "/products/{id}/contract": {
        get: {
          operationId: "getContract",
          summary: "A product's developer contract (live version)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", enum: productIds } }],
          responses: { "200": { description: "The contract", content: { "application/json": { schema: ref("Contract") } } }, ...errors },
        },
      },
      "/client_sessions": {
        post: {
          operationId: "createClientSession",
          summary: "Mint a short-lived client session for one customer's device (server only)",
          requestBody: { required: true, content: { "application/json": { schema: ref("ClientSessionRequest") } } },
          responses: { "201": { description: "The session; send client_secret to the device", content: { "application/json": { schema: ref("ClientSession") } } }, ...errors },
        },
      },
      "/client/offers": {
        get: {
          operationId: "clientOffers",
          summary: "The session's products: offers, documents, consent purposes and startable actions",
          security: [{ clientSession: [] }],
          responses: { "200": { description: "Offers", content: { "application/json": { schema: ref("ClientOffers") } } }, ...errors },
        },
      },
      "/client/actions/{action}": {
        post: {
          operationId: "startClientAction",
          summary: "Start a provider-hosted action on the customer's device (its consent must be recorded first)",
          security: [{ clientSession: [] }],
          parameters: [{ name: "action", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: ref("ClientActionRequest") } } },
          responses: { "201": { description: "Where to send the customer", content: { "application/json": { schema: ref("ClientActionResult") } } }, ...errors },
        },
      },
      "/client/fields": {
        get: {
          operationId: "knownFields",
          summary: "Fields held for this customer (masked)",
          security: [{ clientSession: [] }],
          responses: { "200": { description: "Held fields", content: { "application/json": { schema: ref("HeldFields") } } }, ...errors },
        },
        post: {
          operationId: "saveFields",
          summary: "Store customer data a product's actions need (after consent; sensitive fields from secure inputs)",
          security: [{ clientSession: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("FieldsRequest") } } },
          responses: { "201": { description: "Stored", content: { "application/json": { schema: { type: "object", properties: { stored: { type: "array", items: { type: "string" } } }, required: ["stored"] } } } }, ...errors },
        },
        delete: {
          operationId: "forgetCustomer",
          summary: "Erase everything held for this customer",
          security: [{ clientSession: [] }],
          responses: { "200": { description: "Erased", content: { "application/json": { schema: { type: "object", properties: { erased: { type: "integer" } }, required: ["erased"] } } } }, ...errors },
        },
      },
      "/client/prefill": {
        post: {
          operationId: "prefill",
          summary: "Fetch fields from Account Aggregator, DigiLocker or CKYC with the customer's consent",
          security: [{ clientSession: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("PrefillRequest") } } },
          responses: { "201": { description: "Filled", content: { "application/json": { schema: ref("PrefillResult") } } }, ...errors },
        },
      },
      "/client/journeys/{journey}": {
        get: {
          operationId: "getJourney",
          summary: "A journey saved to this app, while it's built on the live contract",
          security: [{ clientSession: [] }],
          parameters: [{ name: "journey", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "The journey spec", content: { "application/json": { schema: { type: "object" } } } }, ...errors },
        },
      },
      "/client/evidence": {
        post: {
          operationId: "recordEvidence",
          summary: "Record that a document was shown, or consent given or withdrawn",
          security: [{ clientSession: [] }],
          requestBody: { required: true, content: { "application/json": { schema: ref("EvidenceRequest") } } },
          responses: { "201": { description: "Recorded", content: { "application/json": { schema: ref("EvidenceResult") } } }, ...errors },
        },
      },
    },
    webhooks: Object.fromEntries(
      WEBHOOK_EVENTS.map((t) => [
        t,
        {
          post: {
            summary: `${t} (signed with the Mynt-Signature header: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">)`,
            parameters: [{ name: "Mynt-Signature", in: "header", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: ref("WebhookEvent") } } },
            responses: { "200": { description: "Received" } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: {
        appKey: { type: "http", scheme: "bearer", description: "App key: mynt_live_… or mynt_test_… (your server only)" },
        clientSession: { type: "http", scheme: "bearer", description: "Client session secret: mcs_live_… or mcs_test_… (a customer's device)" },
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } }, required: ["error", "message"] },
        BuildTerms: {
          type: "object",
          properties: {
            permitted_actions: { type: "array", items: { type: "string", enum: [...EXPERIENCE_ACTIONS] } },
            required_disclosures: { type: "array", items: { type: "string" } },
            banned_phrases: { type: "array", items: { type: "string" } },
            allowed_personas: { type: "array", items: { type: "string" } },
            branding: { type: "string" },
            commercials: { type: "object" },
          },
        },
        Product: { oneOf: [...names.values()].map(ref) },
        ...productSchemas,
        HandoffRequest: {
          type: "object",
          properties: {
            product_id: { type: "string", enum: productIds },
            action: { type: "string", enum: [...HANDOFFS] },
            consumer_ref: { type: "string", description: "Your own opaque reference for the user; never personal or financial data" },
          },
          required: ["product_id", "action"],
        },
        Handoff: { type: "object", properties: { handoff_id: { type: "string" }, redirect_url: { type: "string", format: "uri" } }, required: ["handoff_id", "redirect_url"] },
        Event: {
          type: "object",
          properties: { type: { type: "string", enum: [...EVENT_TYPES] }, product_id: { type: "string", enum: productIds }, screen: { type: "string" } },
          required: ["type", "product_id"],
        },
        Contract: {
          type: "object",
          description: "What the app builds against: offers per segment, actions and where they run, events, consent purposes, documents",
          properties: {
            product_id: { type: "string" },
            version: { type: "integer" },
            offers: { type: "array", items: { type: "object" } },
            actions: { type: "array", items: ref("ContractAction") },
            events: { type: "array", items: { type: "object" } },
            consent_purposes: { type: "array", items: { type: "string" } },
            documents: { type: "object", additionalProperties: { type: "string" } },
            contract_hash: { type: "string" },
          },
          required: ["product_id", "version", "offers", "actions", "events", "consent_purposes", "documents", "contract_hash"],
        },
        ContractAction: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            surface: { type: "string", enum: ["client", "server", "either"] },
            flow: { type: "string", enum: ["hosted"] },
            consent_purpose: { type: ["string", "null"] },
            component: { type: "string" },
            served_by: {
              type: "object",
              description: "Served by a vendor's standard service: what the device is told of the outcome",
              properties: {
                kind: { type: "string", enum: ["vendor_service"] },
                service_type: { type: ["string", "null"] },
                client_result: {
                  type: "object",
                  properties: { statuses: { type: "array", items: { type: "string" } }, fields: { type: "array", items: { type: "string" } }, redirect: { type: "boolean" } },
                },
              },
            },
          },
          required: ["id", "name", "surface"],
        },
        ClientSessionRequest: {
          type: "object",
          properties: {
            product_ids: { type: "array", items: { type: "string", enum: productIds }, minItems: 1 },
            scopes: { type: "array", items: { type: "string" }, description: "Client actions the device may start (default view_offers)" },
            customer_ref: { type: "string", description: "Your own opaque reference for the customer" },
            ttl_seconds: { type: "integer", minimum: 60, maximum: 3600 },
          },
          required: ["product_ids"],
        },
        ClientSession: {
          type: "object",
          properties: {
            client_secret: { type: "string" },
            session_id: { type: "string" },
            expires_at: { type: "string" },
            product_ids: { type: "array", items: { type: "string" } },
            scopes: { type: "array", items: { type: "string" } },
          },
          required: ["client_secret", "session_id", "expires_at", "product_ids", "scopes"],
        },
        ClientOffers: {
          type: "object",
          properties: {
            products: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  product_id: { type: "string" },
                  name: { type: "string" },
                  version: { type: "integer" },
                  contract_hash: { type: "string" },
                  sales_paused: { type: "boolean" },
                  offers: { type: "array", items: { type: "object" } },
                  documents: { type: "object", additionalProperties: { type: "string" } },
                  consent_purposes: { type: "array", items: { type: "string" } },
                  actions: { type: "array", items: ref("ContractAction") },
                },
                required: ["product_id", "name", "version", "contract_hash", "sales_paused", "offers", "documents", "consent_purposes", "actions"],
              },
            },
            expires_at: { type: "string" },
          },
          required: ["products", "expires_at"],
        },
        ClientActionRequest: { type: "object", properties: { product_id: { type: "string", enum: productIds } }, required: ["product_id"] },
        ClientActionResult: {
          type: "object",
          description:
            "A hand-off to the innovator's flow (handoff_id, redirect_url), or, for an action served by a vendor's standard service (served_by in the contract), its outcome: reference, status and only what the service allows (a redirect_url to the provider's page for e-sign and e-mandate)",
          properties: {
            handoff_id: { type: "string" },
            redirect_url: { type: "string", format: "uri" },
            action: { type: "string" },
            reference: { type: "string" },
            status: { type: "string", enum: ["verified", "not_verified", "completed", "failed", "pending"] },
            sandbox: { type: "boolean" },
          },
          required: ["action"],
        },
        EvidenceRequest: {
          type: "object",
          properties: {
            product_id: { type: "string", enum: productIds },
            type: { type: "string", enum: ["disclosure_shown", "consent_given", "consent_withdrawn"] },
            subject: { type: "string" },
            content_hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
          },
          required: ["product_id", "type", "subject"],
        },
        HeldFields: {
          type: "object",
          properties: {
            fields: {
              type: "array",
              items: { type: "object", properties: { field: { type: "string" }, source: { type: "string" }, value: { type: "string" }, updated_at: { type: "string" } }, required: ["field", "source", "value"] },
            },
          },
          required: ["fields"],
        },
        FieldsRequest: {
          type: "object",
          properties: {
            product_id: { type: "string", enum: productIds },
            values: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
            source: { type: "string", enum: ["typed", "secure_field", "document_upload"] },
          },
          required: ["product_id", "values"],
        },
        PrefillRequest: {
          type: "object",
          properties: {
            product_id: { type: "string", enum: productIds },
            source: { type: "string", enum: ["account_aggregator", "digilocker", "ckyc"] },
            fields: { type: "array", items: { type: "string" } },
          },
          required: ["product_id", "source", "fields"],
        },
        PrefillResult: {
          type: "object",
          properties: { filled: { type: "array", items: { type: "string" } }, missing: { type: "array", items: { type: "string" } } },
          required: ["filled", "missing"],
        },
        EvidenceResult: { type: "object", properties: { evidence_id: { type: "string" }, recorded_at: { type: "string" } }, required: ["evidence_id", "recorded_at"] },
        WebhookEvent: {
          type: "object",
          properties: { id: { type: "string" }, type: { type: "string", enum: [...WEBHOOK_EVENTS] }, created_at: { type: "string" }, data: { type: "object" } },
          required: ["type"],
        },
      },
    },
  };
}


// Pinned generator and runtime versions written into the generated packages. Keep these equal to
// the versions in Mynt's package.json (a test checks this).
export const OPENAPI_TYPESCRIPT_VERSION = "7.13.0";
export const OPENAPI_FETCH_VERSION = "0.17.0";
export const OPENAPI_PYTHON_CLIENT_VERSION = "0.29.1";

const lit = (v: unknown) => JSON.stringify(v);

// Python literal for JSON-like data (JSON string escapes are valid in Python string literals).
const py = (v: unknown): string =>
  v === null || v === undefined
    ? "None"
    : typeof v === "boolean"
      ? (v ? "True" : "False")
      : Array.isArray(v)
        ? `(${v.map(py).join(", ")}${v.length === 1 ? "," : ""})`
        : typeof v === "object"
          ? `{${Object.entries(v).map(([k, x]) => `${lit(k)}: ${py(x)}`).join(", ")}}`
          : lit(v);

// The per-product data both helper layers expose as constants.
function productData(products: SdkProduct[]) {
  const terms = (p: SdkProduct) => fullTerms(p.record.build_terms);
  const per = (f: (p: SdkProduct) => unknown) => products.map((p) => [p.record.product.id, f(p)] as const);
  return {
    ids: products.map((p) => p.record.product.id),
    permittedActions: per((p) => terms(p).permitted_actions),
    permittedHandoffs: per((p) => terms(p).permitted_actions.filter((a: string) => (HANDOFFS as readonly string[]).includes(a))),
    disclosures: per((p) => terms(p).required_disclosures),
    branding: per((p) => terms(p).branding),
    issuers: per((p) => p.issuer ?? ""),
    banned: per((p) => terms(p).banned_phrases),
    clientActions: per((p) => (p.record.pins?.contract?.actions ?? []).filter((a) => a.surface !== "server").map((a) => a.id)),
    consents: per((p) => p.record.pins?.contract?.consent_purposes ?? []),
    documents: per((p) => Object.keys(p.record.pins?.contract?.documents ?? {})),
  };
}

async function typescriptSchema(doc: object): Promise<string> {
  const { default: openapiTS, astToString } = await import("openapi-typescript");
  const ast = await openapiTS(structuredClone(doc) as never, { silent: true });
  return `// Generated by Mynt with openapi-typescript ${OPENAPI_TYPESCRIPT_VERSION} from ../../openapi.json. Do not edit.\n\n${astToString(ast)}`;
}

// The browser client: runs on a customer's device with a client session, never an app key.
function typescriptBrowser(name: string, version: string, products: SdkProduct[]): string {
  const d = productData(products);
  const obj = (rows: (readonly [string, unknown])[]) => `{\n${rows.map(([id, v]) => `  ${lit(id)}: ${lit(v)},`).join("\n")}\n}`;
  return `// Generated by Mynt: ${lit(name)} ${lit(version)}. Do not edit; generate a new release instead.
// The browser client: runs on a customer's device with a client session (mcs_…) your server minted with
// createClientSession. It never sees your app key. Uses only web APIs (fetch, WebCrypto).
import createClient, { type Client } from "openapi-fetch";
import type { components, paths } from "./schema.js";

export const PRODUCT_IDS = ${lit(d.ids)} as const;
export type ProductId = (typeof PRODUCT_IDS)[number];
/** Actions a device may start, per product. */
export const CLIENT_ACTIONS = ${obj(d.clientActions)} as const;
/** Consent purposes each product's actions need. */
export const CONSENT_PURPOSES = ${obj(d.consents)} as const;
/** Documents each product requires you to show. */
export const DOCUMENTS = ${obj(d.documents)} as const;
export type ClientOffers = components["schemas"]["ClientOffers"];

export class MyntBrowserError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MyntBrowserError";
  }
}

/** sha256:<hex> of the exact text you showed, so the evidence proves what was on screen. */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return "sha256:" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface MyntBrowserOptions {
  /** The client session secret from your server: mcs_live_… or mcs_test_…. */
  clientSecret: string;
  baseUrl?: string;
  fetch?: (input: Request) => Promise<Response>;
}

export function createMyntBrowserClient(options: MyntBrowserOptions) {
  if (/^mynt_(live|test)_/.test(options.clientSecret)) throw new Error("That's an app key: keep it on your server and send the device a client session secret instead");
  if (!/^mcs_(live|test)_/.test(options.clientSecret)) throw new Error("clientSecret must be a mcs_live_ or mcs_test_ client session secret");
  const client: Client<paths> = createClient<paths>({
    baseUrl: (options.baseUrl ?? ${lit(`/v1`)}).replace(/\\/+$/, ""),
    headers: { Authorization: "Bearer " + options.clientSecret },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const fail = (response: Response, error: unknown) => {
    const e = (error ?? {}) as { error?: string; message?: string };
    return new MyntBrowserError(response.status, e.error ?? "http_" + response.status, e.message ?? response.statusText);
  };
  const evidence = async (body: components["schemas"]["EvidenceRequest"]) => {
    const { data, error, response } = await client.POST("/client/evidence", { body });
    if (!data) throw fail(response, error);
    return data;
  };
  return {
    client,
    /** The session's products: offers per segment, documents to show, consents and startable actions. */
    async offers(): Promise<ClientOffers> {
      const { data, error, response } = await client.GET("/client/offers");
      if (!data) throw fail(response, error);
      return data;
    },
    /** Records that a required document was shown, with a hash of the exact text. */
    async documentShown(productId: ProductId, document: string, shownText: string) {
      if (!(DOCUMENTS[productId] as readonly string[]).includes(document)) throw new Error(document + " isn't a document of " + productId);
      return evidence({ product_id: productId, type: "disclosure_shown", subject: document, content_hash: await hashText(shownText) });
    },
    /** Records the customer's consent for a purpose (needed before actions that use their data). */
    async giveConsent(productId: ProductId, purpose: string, consentText: string) {
      if (!(CONSENT_PURPOSES[productId] as readonly string[]).includes(purpose)) throw new Error(purpose + " isn't a consent purpose of " + productId);
      return evidence({ product_id: productId, type: "consent_given", subject: purpose, content_hash: await hashText(consentText) });
    },
    async withdrawConsent(productId: ProductId, purpose: string) {
      return evidence({ product_id: productId, type: "consent_withdrawn", subject: purpose });
    },
    /** Starts a provider-hosted action; send the customer to redirect_url. */
    async startAction<P extends ProductId>(productId: P, action: (typeof CLIENT_ACTIONS)[P][number]) {
      const { data, error, response } = await client.POST("/client/actions/{action}", { params: { path: { action } }, body: { product_id: productId } });
      if (!data) throw fail(response, error);
      return data;
    },
    /** Stores customer data the product's actions need. Sensitive fields must come from a secure input. */
    async saveFields(productId: ProductId, values: Record<string, string | number | boolean>, source: "typed" | "secure_field" | "document_upload" = "typed") {
      const { data, error, response } = await client.POST("/client/fields", { body: { product_id: productId, values, source } });
      if (!data) throw fail(response, error);
      return data;
    },
    /** Which fields are already held for this customer (masked), to skip asking again. */
    async knownFields() {
      const { data, error, response } = await client.GET("/client/fields");
      if (!data) throw fail(response, error);
      return data.fields;
    },
    /** Fetches fields from Account Aggregator, DigiLocker or CKYC, with the customer's consent. */
    async prefill(productId: ProductId, source: "account_aggregator" | "digilocker" | "ckyc", fields: string[]) {
      const { data, error, response } = await client.POST("/client/prefill", { body: { product_id: productId, source, fields } });
      if (!data) throw fail(response, error);
      return data;
    },
    /** Erases everything held for this customer. */
    async forgetMe() {
      const { data, error, response } = await client.DELETE("/client/fields");
      if (!data) throw fail(response, error);
      return data;
    },
    /** A journey saved to this app (refused once it's built on an outdated contract). */
    async journey(id: string): Promise<Journey> {
      const { data, error, response } = await client.GET("/client/journeys/{journey}", { params: { path: { journey: id } } });
      if (!data) throw fail(response, error);
      return data as unknown as Journey;
    },
  };
}
export type MyntBrowserClient = ReturnType<typeof createMyntBrowserClient>;

/** A journey spec, as saved with save_journey. */
export interface Journey {
  journey: string;
  built_on: { product_id: ProductId; contract_version: number };
  steps: JourneyStep[];
}
export interface JourneyStep {
  id: string;
  title?: string;
  screen?: (
    | { type: "offer_card"; segment?: string }
    | { type: "disclosure"; document: string }
    | { type: "field"; field: string; capture: string; required?: boolean; show_if?: Record<string, unknown> }
    | { type: "text"; text: string }
    | { type: "outcome"; outcome: string }
  )[];
  capture_consent?: string;
  action?: string;
  await_event?: string;
  next?: string;
  on?: Record<string, string>;
}

/** What the customer did on a step, for JourneyRunner.complete. */
export interface StepInput {
  /** The exact text shown for each document on a screen (it's hashed into the evidence). */
  documents?: Record<string, string>;
  /** Field values entered on a screen, by field. */
  fields?: Record<string, string | number | boolean>;
  /** The consent wording the customer agreed to, on a consent step. */
  consentText?: string;
  /** How a hosted action or wait ended (e.g. completed or failed). */
  outcome?: string;
}

/**
 * A headless journey runner: render \`current\` however you like, then call complete() with what the
 * customer did. It records document and consent evidence, stores fields (secure ones as secure), starts
 * hosted actions (returning where to send the customer) and follows the journey's branches.
 */
export async function createJourneyRunner(c: MyntBrowserClient, journeyId: string) {
  const journey = await c.journey(journeyId);
  const product = journey.built_on.product_id;
  const byId = new Map(journey.steps.map((s) => [s.id, s]));
  let current: JourneyStep | null = journey.steps[0] ?? null;
  const go = (id: string | undefined) => {
    current = id ? (byId.get(id) ?? null) : null;
  };
  return {
    journey,
    get current() {
      return current;
    },
    get done() {
      return current === null || (!current.next && !current.on && !current.action && !current.capture_consent && !current.await_event);
    },
    /** Completes the current step; for a hosted action, returns where to send the customer. */
    async complete(input: StepInput = {}): Promise<{ redirect_url?: string }> {
      const step = current;
      if (!step) throw new Error("The journey has ended");
      if (step.capture_consent) {
        if (!input.consentText) throw new Error("Pass the consent wording the customer agreed to");
        await c.giveConsent(product, step.capture_consent, input.consentText);
        go(step.next);
        return {};
      }
      if (step.action) {
        if (input.outcome) {
          go(step.on?.[input.outcome] ?? step.next);
          return {};
        }
        const started = await c.startAction(product, step.action as never);
        return { redirect_url: started.redirect_url };
      }
      if (step.await_event) {
        go(input.outcome ? (step.on?.[input.outcome] ?? step.next) : step.next);
        return {};
      }
      for (const e of step.screen ?? []) {
        if (e.type === "disclosure") {
          const text = input.documents?.[e.document];
          if (!text) throw new Error("Pass the text shown for document " + e.document);
          await c.documentShown(product, e.document, text);
        }
      }
      const fields = (step.screen ?? []).filter((e): e is Extract<NonNullable<JourneyStep["screen"]>[number], { type: "field" }> => e.type === "field");
      for (const source of ["typed", "secure_field", "document_upload"] as const) {
        const values = Object.fromEntries(fields.filter((f) => (f.capture === source) && input.fields?.[f.field] !== undefined).map((f) => [f.field, input.fields![f.field]]));
        if (Object.keys(values).length) await c.saveFields(product, values, source);
      }
      const prefilled = fields.filter((f) => ["account_aggregator", "digilocker", "ckyc"].includes(f.capture) && input.fields?.[f.field] === undefined);
      for (const source of ["account_aggregator", "digilocker", "ckyc"] as const) {
        const wanted = prefilled.filter((f) => f.capture === source).map((f) => f.field);
        if (wanted.length) await c.prefill(product, source, wanted);
      }
      go(input.outcome ? (step.on?.[input.outcome] ?? step.next) : step.next);
      return {};
    },
  };
}
`;
}

// The thin hand-written layer over the openapi-fetch client.
function typescriptHelpers(name: string, version: string, baseUrl: string, products: SdkProduct[]): string {
  const names = typeNames(products.map((p) => p.record.product.id));
  const d = productData(products);
  const obj = (rows: (readonly [string, unknown])[]) => `{\n${rows.map(([id, v]) => `  ${lit(id)}: ${lit(v)},`).join("\n")}\n}`;
  return `// Generated by Mynt: ${lit(name)} ${lit(version)}. Do not edit; generate a new release instead.
// The HTTP client is openapi-fetch over the types in ./schema.d.ts (openapi-typescript); this file adds
// Mynt's helpers: typed hand-offs, events, webhook verification and each product's terms.
import createClient, { type Client } from "openapi-fetch";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { components, paths } from "./schema.js";

export type { components, paths };

export const SDK_NAME = ${lit(name)};
export const SDK_VERSION = ${lit(version)};
export const DEFAULT_BASE_URL = ${lit(`${baseUrl}/v1`)};

export const PRODUCT_IDS = ${lit(d.ids)} as const;
export type ProductId = (typeof PRODUCT_IDS)[number];
export type Product = components["schemas"]["Product"];
${products.map((p) => `export type ${names.get(p.record.product.id)} = components["schemas"][${lit(names.get(p.record.product.id))}];`).join("\n")}
export type Handoff = components["schemas"]["Handoff"];
export type EventType = components["schemas"]["Event"]["type"];
export type WebhookEvent = components["schemas"]["WebhookEvent"];

/** What each product lets experiences do (from its build terms). */
export const PERMITTED_ACTIONS = ${obj(d.permittedActions)} as const;

/** Hand-offs each product permits; startHandoff only accepts these. */
export const PERMITTED_HANDOFFS = ${obj(d.permittedHandoffs)} as const;
export type HandoffAction<P extends ProductId> = (typeof PERMITTED_HANDOFFS)[P][number];

/** Text every experience must show with each product, verbatim. */
export const REQUIRED_DISCLOSURES = ${obj(d.disclosures)} as const;

/** How each product and its issuer or distributor must be labelled. */
export const BRANDING = ${obj(d.branding)} as const;

/** Who issues or distributes each product. */
export const ISSUERS = ${obj(d.issuers)} as const;

/** Words or claims experiences must not use with each product. */
export const BANNED_PHRASES = ${obj(d.banned)} as const;

/** Actions a customer's device may start, per product (from its developer contract). */
export const CLIENT_ACTIONS = ${obj(d.clientActions)} as const;
export type ClientAction<P extends ProductId> = (typeof CLIENT_ACTIONS)[P][number];
export type Contract = components["schemas"]["Contract"];
export type ClientSession = components["schemas"]["ClientSession"];

export function disclosuresFor(productId: ProductId): readonly string[] {
  const d = REQUIRED_DISCLOSURES[productId] as readonly string[] | undefined;
  if (!d) throw new Error("Unknown product: " + productId);
  return d;
}

export class MyntError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MyntError";
  }
}

export interface MyntClientOptions {
  /** An app key: mynt_live_… in production, mynt_test_… for the sandbox. */
  apiKey: string;
  baseUrl?: string;
  fetch?: (input: Request) => Promise<Response>;
}

const fail = (response: Response, error: unknown) => {
  const e = (error ?? {}) as { error?: string; message?: string };
  return new MyntError(response.status, e.error ?? "http_" + response.status, e.message ?? response.statusText);
};

/** Creates the typed client: \`client\` is openapi-fetch for every operation; the helpers wrap the common ones. */
export function createMyntClient(options: MyntClientOptions) {
  if (!/^mynt_(live|test)_/.test(options.apiKey)) throw new Error("apiKey must be a mynt_live_ or mynt_test_ app key");
  const client: Client<paths> = createClient<paths>({
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/+$/, ""),
    headers: { Authorization: "Bearer " + options.apiKey },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  return {
    client,
    sandbox: options.apiKey.startsWith("mynt_test_"),
    /** Hands the user off to the innovator's own flow; redirect them to redirect_url. */
    async startHandoff<P extends ProductId>(productId: P, action: HandoffAction<P>, consumerRef?: string): Promise<Handoff> {
      if (!(PERMITTED_HANDOFFS[productId] as readonly string[]).includes(action)) throw new Error(productId + " does not permit " + action);
      const { data, error, response } = await client.POST("/handoffs", {
        body: { product_id: productId, action, ...(consumerRef ? { consumer_ref: consumerRef } : {}) },
      });
      if (!data) throw fail(response, error);
      return data;
    },
    async trackEvent(type: EventType, productId: ProductId, screen?: string): Promise<void> {
      const { error, response } = await client.POST("/events", { body: { type, product_id: productId, ...(screen ? { screen } : {}) } });
      if (!response.ok) throw fail(response, error);
    },
    /** A product's developer contract (its live version). */
    async getContract(productId: ProductId): Promise<Contract> {
      const { data, error, response } = await client.GET("/products/{id}/contract", { params: { path: { id: productId } } });
      if (!data) throw fail(response, error);
      return data;
    },
    /**
     * Mints a client session for one customer's device: send client_secret to the device and use the
     * browser client there. Never call this from a browser; the app key stays on your server.
     */
    async createClientSession<P extends ProductId>(
      productIds: P[],
      scopes: ClientAction<P>[] = [],
      opts: { customerRef?: string; ttlSeconds?: number } = {},
    ): Promise<ClientSession> {
      for (const s of scopes) if (!productIds.some((p) => (CLIENT_ACTIONS[p] as readonly string[]).includes(s))) throw new Error(s + " isn't a client action of " + productIds.join(", "));
      const { data, error, response } = await client.POST("/client_sessions", {
        body: {
          product_ids: productIds,
          scopes: ["view_offers", ...scopes.filter((s) => s !== "view_offers")],
          ...(opts.customerRef ? { customer_ref: opts.customerRef } : {}),
          ...(opts.ttlSeconds ? { ttl_seconds: opts.ttlSeconds } : {}),
        },
      });
      if (!data) throw fail(response, error);
      return data;
    },
  };
}
export type MyntClient = ReturnType<typeof createMyntClient>;

/**
 * Verifies a webhook's Mynt-Signature header (t=<unix>,v1=<hex HMAC-SHA256 of "t.body">) against the raw
 * body and returns the event. Throws when the signature is missing, wrong or older than toleranceSeconds.
 */
export function verifyWebhook(rawBody: string | Uint8Array, header: string, secret: string, toleranceSeconds = 300): WebhookEvent {
  const parts = new Map<string, string[]>();
  for (const item of (header ?? "").split(",")) {
    const i = item.indexOf("=");
    if (i <= 0) continue;
    const k = item.slice(0, i).trim();
    parts.set(k, [...(parts.get(k) ?? []), item.slice(i + 1).trim()]);
  }
  const t = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!t || !/^\\d+$/.test(t) || signatures.length === 0) throw new Error("Malformed Mynt-Signature header");
  if (toleranceSeconds > 0 && Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) throw new Error("Webhook timestamp outside tolerance");
  const body = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  const expected = createHmac("sha256", secret).update(t + "." + body).digest();
  const ok = signatures.some((s) => /^[0-9a-f]+$/i.test(s) && s.length === expected.length * 2 && timingSafeEqual(Buffer.from(s, "hex"), expected));
  if (!ok) throw new Error("Invalid webhook signature");
  return JSON.parse(body) as WebhookEvent;
}
`;
}

// The thin hand-written Python layer; the client itself comes from openapi-python-client.
function pythonHelpers(name: string, version: string, baseUrl: string, products: SdkProduct[]): string {
  const d = productData(products);
  const dict = (rows: (readonly [string, unknown])[]) => `{\n${rows.map(([id, v]) => `    ${lit(id)}: ${py(v)},`).join("\n")}\n}`;
  return `# Generated by Mynt. Do not edit; generate a new release instead.
# Standard library only. The HTTP client is generated from ../openapi.json by generate.sh.
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, List, Tuple, Union

SDK_NAME = ${lit(name)}
SDK_VERSION = ${lit(version)}
DEFAULT_BASE_URL = ${lit(`${baseUrl}/v1`)}

PRODUCT_IDS: Tuple[str, ...] = ${py(d.ids)}

# What each product lets experiences do (from its build terms).
PERMITTED_ACTIONS: Dict[str, Tuple[str, ...]] = ${dict(d.permittedActions)}

# Hand-offs each product permits.
PERMITTED_HANDOFFS: Dict[str, Tuple[str, ...]] = ${dict(d.permittedHandoffs)}

# Text every experience must show with each product, verbatim.
REQUIRED_DISCLOSURES: Dict[str, Tuple[str, ...]] = ${dict(d.disclosures)}

# How each product and its issuer or distributor must be labelled.
BRANDING: Dict[str, str] = ${dict(d.branding)}

ISSUERS: Dict[str, str] = ${dict(d.issuers)}

# Words or claims experiences must not use with each product.
BANNED_PHRASES: Dict[str, Tuple[str, ...]] = ${dict(d.banned)}


def disclosures_for(product_id: str) -> Tuple[str, ...]:
    if product_id not in REQUIRED_DISCLOSURES:
        raise KeyError("Unknown product: " + product_id)
    return REQUIRED_DISCLOSURES[product_id]


def check_handoff(product_id: str, action: str) -> None:
    """Raises ValueError unless the product permits this hand-off; call before POST /handoffs."""
    if action not in PERMITTED_HANDOFFS.get(product_id, ()):
        raise ValueError("%s does not permit %s" % (product_id, action))


def verify_webhook(raw_body: Union[bytes, str], header: str, secret: str, tolerance_seconds: int = 300) -> Dict[str, Any]:
    """Verifies a Mynt-Signature header (t=<unix>,v1=<hex>) and returns the parsed event."""
    parts: Dict[str, List[str]] = {}
    for item in (header or "").split(","):
        key, sep, value = item.partition("=")
        if sep:
            parts.setdefault(key.strip(), []).append(value.strip())
    t = (parts.get("t") or [""])[0]
    signatures = parts.get("v1") or []
    if not t.isdigit() or not signatures:
        raise ValueError("Malformed Mynt-Signature header")
    if tolerance_seconds > 0 and abs(time.time() - int(t)) > tolerance_seconds:
        raise ValueError("Webhook timestamp outside tolerance")
    body = raw_body.encode("utf-8") if isinstance(raw_body, str) else raw_body
    expected = hmac.new(secret.encode("utf-8"), t.encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, s.lower()) for s in signatures):
        raise ValueError("Invalid webhook signature")
    return json.loads(body)
`;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mynt-sdk";
const jsonFile = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

export async function generateSdk(opts: { name: string; version: string; languages: SdkLanguage[]; baseUrl: string; products: SdkProduct[] }): Promise<GeneratedFile[]> {
  const { name, version, languages, baseUrl, products } = opts;
  const pkg = slug(name);
  const doc = openApiDocument(name, version, baseUrl, products);
  const files: GeneratedFile[] = [{ path: "openapi.json", content: jsonFile(doc) }];
  if (languages.includes("typescript")) {
    files.push(
      { path: "typescript/src/schema.d.ts", content: await typescriptSchema(doc) },
      { path: "typescript/src/index.ts", content: typescriptHelpers(name, version, baseUrl, products) },
      { path: "typescript/src/browser.ts", content: typescriptBrowser(name, version, products) },
      {
        path: "typescript/package.json",
        content: jsonFile({
          name: pkg,
          version,
          type: "module",
          main: "dist/index.js",
          types: "dist/index.d.ts",
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./browser": { types: "./dist/browser.d.ts", default: "./dist/browser.js" },
          },
          engines: { node: ">=18" },
          scripts: { generate: "openapi-typescript ../openapi.json -o src/schema.d.ts", build: `tsc && node -e "require('node:fs').copyFileSync('src/schema.d.ts', 'dist/schema.d.ts')"` },
          dependencies: { "openapi-fetch": OPENAPI_FETCH_VERSION },
          devDependencies: { "@types/node": "^22.0.0", "openapi-typescript": OPENAPI_TYPESCRIPT_VERSION, typescript: "^5.9.0" },
        }),
      },
      {
        path: "typescript/tsconfig.json",
        content: jsonFile({
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2022", "DOM"],
            types: ["node"],
            strict: true,
            declaration: true,
            rootDir: "src",
            outDir: "dist",
          },
          include: ["src"],
        }),
      },
    );
  }
  // Device SDKs: the same client as the browser one, for React Native, Android, iOS and Flutter.
  const deviceData = productData(products);
  const asLists = (rows: (readonly [string, unknown])[]) => rows.map(([id, v]) => [id, v as string[]] as const);
  const device = { name, version, baseUrl, slug: pkg, data: { ids: deviceData.ids, clientActions: asLists(deviceData.clientActions), consents: asLists(deviceData.consents), documents: asLists(deviceData.documents) } };
  if (languages.includes("react_native"))
    files.push(...reactNativeSdk({ name, version, slug: pkg, browserSource: typescriptBrowser(name, version, products), schema: await typescriptSchema(doc), openapiFetchVersion: OPENAPI_FETCH_VERSION }));
  if (languages.includes("kotlin")) files.push(...kotlinSdk(device));
  if (languages.includes("swift")) files.push(...swiftSdk(device));
  if (languages.includes("flutter")) files.push(...flutterSdk(device));
  if (languages.includes("python")) {
    const mod = pkg.replace(/-/g, "_").replace(/^(\d)/, "sdk_$1");
    files.push(
      { path: "python/mynt_helpers.py", content: pythonHelpers(name, version, baseUrl, products) },
      { path: "python/config.yml", content: `project_name_override: ${lit(pkg)}\npackage_name_override: ${lit(mod)}\npackage_version_override: ${lit(version)}\npost_hooks: []\n` },
      {
        path: "python/generate.sh",
        content: `#!/bin/sh
# Generates the Python client from ../openapi.json into ./${pkg} (package ${mod}).
set -eu
cd "$(dirname "$0")"
openapi-python-client generate --path ../openapi.json --config config.yml --meta setup --overwrite
`,
      },
      {
        path: "python/README.md",
        content: `# Python

The client is generated from \`../openapi.json\` with openapi-python-client:

\`\`\`sh
pip install openapi-python-client==${OPENAPI_PYTHON_CLIENT_VERSION}
sh generate.sh        # writes ./${pkg} (package ${mod})
pip install ./${pkg}
\`\`\`

\`\`\`python
from ${mod} import AuthenticatedClient
client = AuthenticatedClient(base_url=${lit(`${baseUrl}/v1`)}, token="mynt_test_...")
\`\`\`

Operations live in \`${mod}.api.default\` (\`list_products\`, \`get_product\`, \`start_handoff\`, \`track_event\`); product models are named after each product.

\`mynt_helpers.py\` (standard library only) holds each product's required disclosures (\`disclosures_for(id)\`), branding,
banned phrases and permitted hand-offs (\`check_handoff\`), and \`verify_webhook(raw_body, header, secret)\`.
`,
      },
    );
  }
  files.push({
    path: "README.md",
    content: `# ${name.replace(/[\r\n]+/g, " ")} ${version}

Generated by Mynt for the app API at \`${baseUrl}/v1\`. Authenticate with an app key (\`mynt_test_…\` for the sandbox, \`mynt_live_…\` in production).

Products: ${products.map((p) => `\`${p.record.product.id}\` (v${p.record.version})`).join(", ")}.

\`openapi.json\` is the contract. \`typescript/\` is an openapi-fetch client over types generated by openapi-typescript, plus Mynt helpers (\`createMyntClient\`, \`startHandoff\`, \`trackEvent\`, \`verifyWebhook\`). For Python, run \`python/generate.sh\` (openapi-python-client) and use \`python/mynt_helpers.py\`.

Every screen that shows a product must render its required disclosures (\`disclosuresFor(id)\` / \`disclosures_for(id)\`) and branding. Onboarding, KYC and payments hand off to the innovator's own flow (\`startHandoff\` / \`POST /handoffs\`); apps never collect funds or financial data.
`,
  });
  return files;
}
