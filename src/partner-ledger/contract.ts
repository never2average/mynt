import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../product-health.js";
import { verifyEd25519 } from "../solana/signer.js";
import { callVendor, signBody, type VendorCallOptions, type VendorResult } from "../vendor-call.js";
import { schemaProblems } from "../vendors.js";

// The partner ledger contract (docs/partners.md): how a licence provider tells Mynt what it holds and what it owes,
// per product it sponsors. Mynt is the client. It POSTs a signed request to the partner's fixed endpoint (set by an
// admin) under the same outbound rules as a vendor call, and the partner answers with a statement it signed with its
// registered Ed25519 key. A partner without an API uploads the same statement as a daily file.
//
// Nothing here logs or returns a partner's figures in a problem: problems name rules and product ids only, because
// conformance results are shown to admins, who must never see a firm's numbers.

export const STATEMENT_SCHEMA_ID = "mynt.partner_ledger.v1";
export const REQUEST_SCHEMA_ID = "mynt.partner_ledger.request.v1";
export const LEDGER_PATH = "ledger"; // POST <base_url>/v1/ledger
export const MAX_CLOCK_SKEW_MS = 300_000; // an as_of more than this in the future is refused
export const MAX_RESPONSE_BYTES = 1024 * 1024;

const schemaFile = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../schemas/partner-ledger/${name}`, import.meta.url)), "utf8")) as object;
let schemas: { statement: object; request: object } | null = null;
export const partnerLedgerSchemas = () => (schemas ??= { statement: schemaFile("statement.v1.schema.json"), request: schemaFile("request.v1.schema.json") });

export interface StatementProduct {
  product_id: string;
  reserves_held_cents: number | null;
  customer_obligations_cents: number | null;
  reason: string | null;
}
export interface Statement {
  schema: typeof STATEMENT_SCHEMA_ID;
  provider_entity_id: string;
  environment: "test" | "live";
  request_id: string | null;
  as_of: string;
  products: StatementProduct[];
  signature: { public_key: string; value: string };
}
export interface LedgerRequest {
  schema: typeof REQUEST_SCHEMA_ID;
  request_id: string;
  environment: "test" | "live";
  provider_entity_id: string;
  product_ids: string[];
  period_end: string;
}

// What the partner signs: the domain text, one zero byte, then the canonical JSON of the statement without `signature`.
export function statementMessage(statement: Omit<Statement, "signature"> | Statement): Uint8Array {
  const { signature: _drop, ...unsigned } = statement as Statement;
  return Buffer.concat([Buffer.from(STATEMENT_SCHEMA_ID, "utf8"), Buffer.from([0]), Buffer.from(canonicalJson(unsigned), "utf8")]);
}

export interface CheckCase {
  case: string;
  passed: boolean;
  problems: string[];
}
export interface StatementExpectation {
  entity_id: string;
  environment: "test" | "live";
  request_id: string | null; // null: a daily file
  public_key: string | null; // the firm's registered key; null fails the signature check
  now: Date;
  max_age_ms: number;
  product_ids: string[]; // what must be covered
}
export interface StatementCheck {
  ok: boolean; // everything but coverage passed: the statement can be used, product by product
  cases: CheckCase[];
  statement: Statement | null;
  missing: string[]; // product ids asked for and not answered
}

// Checks a statement against the contract. Coverage is its own case: a statement that leaves a product out can still
// be used for the products it covers, and the one it left out is null with a reason.
export function checkStatement(body: unknown, x: StatementExpectation): StatementCheck {
  const cases: CheckCase[] = [];
  const add = (name: string, problems: string[]) => cases.push({ case: name, passed: !problems.length, problems });
  const schemaIssues = schemaProblems(partnerLedgerSchemas().statement, body);
  add("schema", schemaIssues);
  if (schemaIssues.length) return { ok: false, cases, statement: null, missing: [...x.product_ids] };
  const s = body as Statement;

  const who: string[] = [];
  if (s.provider_entity_id !== x.entity_id) who.push("provider_entity_id isn't your firm's id");
  if (s.environment !== x.environment) who.push(`environment is "${s.environment}", expected "${x.environment}": test books never stand in for live ones, or the other way round`);
  if (s.request_id !== x.request_id) who.push(x.request_id === null ? "request_id must be null in a daily file" : "request_id doesn't echo the request's");
  const ids = s.products.map((p) => p.product_id);
  if (new Set(ids).size !== ids.length) who.push("a product_id appears more than once");
  add("identity", who);

  const sig: string[] = [];
  if (!x.public_key) sig.push("your firm has no registered signing key: use register_partner_signing_key");
  else if (s.signature.public_key !== x.public_key) sig.push("signed with a key other than your firm's registered one");
  else {
    let verified = false;
    try {
      verified = verifyEd25519(x.public_key, statementMessage(s), Buffer.from(s.signature.value, "hex"));
    } catch {
      verified = false;
    }
    if (!verified) sig.push("the signature doesn't verify over the statement's canonical JSON with your registered key");
  }
  add("signature", sig);

  const clock: string[] = [];
  const asOf = new Date(s.as_of).getTime();
  if (Number.isNaN(asOf)) clock.push("as_of isn't a time");
  else {
    if (asOf - x.now.getTime() > MAX_CLOCK_SKEW_MS) clock.push(`as_of is more than ${MAX_CLOCK_SKEW_MS / 1000} s in the future: check your clock`);
    if (x.now.getTime() - asOf > x.max_age_ms) clock.push(`as_of is more than ${Math.round(x.max_age_ms / 3_600_000)} hours old`);
  }
  add("clock", clock);

  // A figure given as null always has its reason (the schema's rule, checked again here so it can't be skipped).
  const nulls: string[] = [];
  for (const p of s.products)
    if ((p.reserves_held_cents === null || p.customer_obligations_cents === null) && !(typeof p.reason === "string" && p.reason.trim()))
      nulls.push(`${p.product_id}: a null figure needs a reason`);
  add("null_handling", nulls);

  const answered = new Set(ids);
  const missing = x.product_ids.filter((id) => !answered.has(id));
  add("coverage", missing.length ? [`not answered for: ${missing.join(", ")}`] : []);

  const ok = cases.filter((c) => c.case !== "coverage").every((c) => c.passed);
  return { ok, cases, statement: ok ? s : null, missing };
}

export const failedCases = (c: StatementCheck) => c.cases.filter((k) => !k.passed).map((k) => k.case);

// One signed request to the partner's endpoint. `sign` replaces Mynt-Signature (conformance's bad and stale cases);
// `body` replaces the request (conformance's malformed case).
export async function requestLedger(
  r: { base_url: string; secret: string; environment: "test" | "live"; entity_id: string; product_ids: string[]; period_end: string; sign?: (payload: string) => string; body?: unknown },
  opts: VendorCallOptions = {},
): Promise<{ request: LedgerRequest; result: VendorResult }> {
  const request: LedgerRequest = { schema: REQUEST_SCHEMA_ID, request_id: randomUUID(), environment: r.environment, provider_entity_id: r.entity_id, product_ids: r.product_ids, period_end: r.period_end };
  const body = r.body ?? request;
  const signature = r.sign ? r.sign(JSON.stringify(body)) : undefined;
  const result = await callVendor({ base_url: r.base_url, service_type: LEDGER_PATH, body, signing_secret: r.secret, signature }, { maxResponseBytes: MAX_RESPONSE_BYTES, ...opts });
  return { request, result };
}

export { signBody };
