import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkStatement, failedCases, ledgerUrl, requestLedger, signBody, type CheckCase, type Statement } from "./partner-ledger/contract.js";
import { isLedgerError, ledgerError, sandboxPartnerLedger, type LedgerError, type PartnerLedger, type PartnerLedgerContext, type PartnerLedgerReading } from "./partner-ledger/index.js";
import { emitFirmEvent } from "./runtime.js";
import { base58Decode, isAddress, isWeakEd25519Key } from "./solana/codec.js";
import type { Store, User } from "./store.js";
import { OutboundRefused, resolveVendorUrl, type VendorCallOptions, type VendorResult } from "./vendor-call.js";
import { derivedKey, open, seal, vaultAvailable } from "./vault.js";
import { probeIdentityOffering } from "./vendors.js";

// The partner integration kit: what Mynt needs from a licence provider, connected and checked the way vendors are.
//
//   (a) its ledger: funds held and customer obligations per product it sponsors, signed with its Ed25519 key for that
//       environment (a live key, and a separate test key). Read over HTTPS from fixed endpoints (HttpPartnerLedger), or
//       from a signed daily file the firm uploads (FilePartnerLedger). Until the firm passes conformance and switches,
//       its source is the sandbox.
//   (b) the customer's verified residential state, from an identity provider it accepts;
//   (c) money rails, from the rails' own conformance.
//
// run_partner_conformance tests (a) against the firm's test endpoint (or its latest file), (b) through the identity
// providers' test environments, and reports (c). Only a passed ledger part lets the firm go live on a source: (b) and
// (c) have their own gates on every money movement (money-rails.ts), and are reported here so a firm sees all three.
//
// Hard rules kept: a test statement never reads as live (its own key, its own environment, refused by the other
// endpoint); admins propose endpoints but only the firm's own member makes them take effect, so an admin can't send
// Mynt's live request somewhere it can read the answer; admins see pass or fail, never the figures (uploads are
// sealed, and no case or problem carries a number); anything unsure is null with a reason.

const T = "financial_products";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const httpMaxAgeMs = () => (Number(process.env.PARTNER_LEDGER_MAX_AGE_HOURS) || 24) * HOUR;
export const fileMaxAgeMs = () => (Number(process.env.PARTNER_LEDGER_FILE_MAX_AGE_HOURS) || 36) * HOUR;
// A conformance pass is good for this long, for going live and for staying live: run it again before it runs out.
export const conformanceMaxAgeMs = () => (Number(process.env.PARTNER_CONFORMANCE_MAX_AGE_DAYS) || 30) * DAY;
// One request per firm per snapshot round, with this time limit: a slow partner holds up only itself.
export const ledgerTimeoutMs = () => Number(process.env.PARTNER_LEDGER_TIMEOUT_MS) || 10_000;
const BATCH_REUSE_MS = 5 * 60_000;
export const LEDGER_SOURCES = ["sandbox", "http", "file"] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export interface PartnerKitDeps {
  signingKeyOf: (entityId: string) => Promise<string | null>; // the firm's registered live key, MAC-checked (product-health.ts)
  opts?: VendorCallOptions; // tests only: loopback endpoints
  now?: () => Date;
}

type Row = Record<string, unknown>;
interface SourceRow {
  entity_id: string;
  test_url: string | null;
  live_url: string | null;
  pending_test_url: string | null;
  pending_live_url: string | null;
  pending_at: string | null;
  signing_secret: string | null;
  secret_shown_at: string | null;
  config_version: number;
  configured_at: string | null;
  active_source: LedgerSource;
  active_run_id: string | null;
  activated_at: string | null;
}
interface RunRow {
  id: string;
  entity_id: string;
  source: "http" | "file";
  config_version: number | null;
  passed: boolean;
  ledger_passed: boolean;
  identity_passed: boolean;
  rails_passed: boolean;
  ledger: { cases: CaseResult[] };
  identity: unknown;
  rails: unknown;
  created_at: string | Date;
}
type CaseResult = CheckCase & { http_status?: number | null };

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const newSecret = () => `mpl_${randomBytes(32).toString("base64url")}`;

async function sourceRow(store: Store, entityId: string): Promise<SourceRow | null> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.partner_ledger_sources WHERE entity_id = $1`, [entityId]);
  return (rows[0] as unknown as SourceRow | undefined) ?? null;
}
async function runById(store: Store, id: string | null): Promise<RunRow | null> {
  if (!id) return null;
  const { rows } = await store.db.query(`SELECT * FROM ${T}.partner_conformance_runs WHERE id = $1`, [id]);
  return (rows[0] as unknown as RunRow | undefined) ?? null;
}
async function latestRun(store: Store, entityId: string, source: "http" | "file"): Promise<RunRow | null> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.partner_conformance_runs WHERE entity_id = $1 AND source = $2 ORDER BY created_at DESC LIMIT 1`, [entityId, source]);
  return (rows[0] as unknown as RunRow | undefined) ?? null;
}
// The products a firm sponsors now: what its statements must cover.
export async function sponsoredProducts(store: Store, entityId: string): Promise<string[]> {
  return [...new Set((await store.sponsorships({ provider_entity_id: entityId, status: "approved" })).map((s) => s.product_id))].sort();
}
const secretOf = (row: SourceRow | null) => (row?.signing_secret ? open(row.signing_secret, false) : null);
const firmActive = async (store: Store, entityId: string) => (await store.getEntity(entityId))?.status === "active";

// ---- the test signing key ----

const testKeyMac = (entityId: string, publicKey: string) => {
  const key = derivedKey("partner-test-signing-key");
  if (!key) throw new Error("The partner kit needs MYNT_VAULT_KEY set on the server");
  return createHmac("sha256", key).update(`${entityId}\u0000${publicKey}`).digest("hex");
};
// The firm's test key, only if Mynt really recorded it: a key written straight into the table doesn't count.
export async function testSigningKey(store: Store, entityId: string): Promise<string | null> {
  const { rows } = await store.db.query(`SELECT public_key, mac FROM ${T}.partner_test_signing_keys WHERE entity_id = $1`, [entityId]);
  const r = rows[0] as { public_key: string; mac: string } | undefined;
  return r && r.mac === testKeyMac(entityId, r.public_key) ? r.public_key : null;
}
const keysFor = async (store: Store, entityId: string, deps: PartnerKitDeps, environment: "test" | "live") => {
  const [live, test] = [await deps.signingKeyOf(entityId), await testSigningKey(store, entityId)];
  return environment === "live" ? { public_key: live, other_key: test } : { public_key: test, other_key: live };
};

// A run lets a firm be live on a source only while it's the one recorded, it passed its ledger part, it hasn't run out,
// and (for the HTTP feed) the endpoints haven't changed since.
const runQualifies = (row: SourceRow, run: RunRow | null, now: Date) =>
  !!run &&
  run.ledger_passed &&
  run.source === row.active_source &&
  now.getTime() - new Date(run.created_at).getTime() <= conformanceMaxAgeMs() &&
  (run.source !== "http" || (run.config_version === row.config_version && !!row.live_url));

// Endpoints are a bare origin and a path: no credentials, no query string, no fragment.
function endpointProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "isn't a URL";
  }
  if (u.username || u.password) return "may not carry credentials";
  if (u.search || u.hash || raw.includes("?") || raw.includes("#")) return "must be an origin and a path only: no query string or fragment";
  return null;
}
const normUrl = (u: string) => new URL(u).toString().replace(/\/+$/, "");

// ---- the ledgers ----

// One product's figures from a checked statement. A product the statement leaves out is null with a reason.
function readingFor(s: Statement, productId: string): PartnerLedgerReading {
  const p = s.products.find((x) => x.product_id === productId);
  if (!p) return { reserves_held_cents: null, customer_obligations_cents: null, as_of: s.as_of, reason: "The partner's statement didn't cover this product" };
  return { reserves_held_cents: p.reserves_held_cents, customer_obligations_cents: p.customer_obligations_cents, as_of: s.as_of, reason: p.reason };
}
const transportCode = (r: VendorResult) => (r.error?.startsWith("refused") ? "endpoint_refused" : r.http_status == null ? (r.error === "timeout" ? "timeout" : "unreachable") : r.ok ? "bad_answer" : `http_${r.http_status}`);

type Batch = { products: string[]; result: Promise<Statement | LedgerError> };
export type LedgerBatches = Map<string, { key: string; at: number; batch: Batch }>;

// One live read of the firm's books, for every product it sponsors (and the one asked about): a statement for the live
// environment, signed with the firm's live key, fresh and well-formed, or an error.
async function readLive(store: Store, entityId: string, row: SourceRow, productIds: string[], periodEnd: string, now: Date, deps: PartnerKitDeps): Promise<Statement | LedgerError> {
  const secret = secretOf(row);
  if (!row.live_url || !secret) return ledgerError("not_configured", "The partner's live endpoint isn't configured");
  const { request, result } = await requestLedger({ base_url: row.live_url, secret, environment: "live", entity_id: entityId, product_ids: productIds, period_end: periodEnd }, { timeoutMs: ledgerTimeoutMs(), ...deps.opts });
  if (!result.ok) return ledgerError(transportCode(result), "The partner's endpoint didn't answer with a statement");
  const check = checkStatement(result.body, { entity_id: entityId, environment: "live", request_id: request.request_id, ...(await keysFor(store, entityId, deps, "live")), now, max_age_ms: httpMaxAgeMs(), product_ids: productIds });
  if (!check.ok) return ledgerError(`statement_${failedCases(check)[0] ?? "invalid"}`, "The partner's statement didn't pass Mynt's checks");
  return check.statement!;
}

// The partner's live endpoint. Snapshots of every product the firm sponsors in one round share one request, so a
// firm costs one call (and at most one time limit) per round, however many products it sponsors.
export function httpPartnerLedger(store: Store, entityId: string, deps: PartnerKitDeps, batches: LedgerBatches = new Map()): PartnerLedger {
  return {
    id: "partner_http",
    name: "The licence provider's ledger, over HTTPS",
    kind: "live",
    async read(ctx: PartnerLedgerContext) {
      const row = await sourceRow(store, entityId);
      if (!row) return ledgerError("not_configured", "The partner's live endpoint isn't configured");
      const now = ctx.now();
      const key = `${ctx.period_end}|${row.config_version}`;
      let entry = batches.get(entityId);
      if (!entry || entry.key !== key || now.getTime() - entry.at > BATCH_REUSE_MS || !entry.batch.products.includes(ctx.product_id)) {
        const products = [...new Set([...(await sponsoredProducts(store, entityId)), ctx.product_id])].sort();
        entry = { key, at: now.getTime(), batch: { products, result: readLive(store, entityId, row, products, ctx.period_end, now, deps) } };
        batches.set(entityId, entry);
      }
      const s = await entry.batch.result;
      return isLedgerError(s) ? s : readingFor(s, ctx.product_id);
    },
  };
}

async function latestUpload(store: Store, entityId: string, environment?: "test" | "live") {
  const { rows } = await store.db.query(
    `SELECT * FROM ${T}.partner_ledger_uploads WHERE entity_id = $1 AND ($2::text IS NULL OR environment = $2) ORDER BY as_of DESC, uploaded_at DESC LIMIT 1`,
    [entityId, environment ?? null],
  );
  return (rows[0] as Row | undefined) ?? null;
}
const openUpload = (u: Row) => JSON.parse(open(u.statement_sealed as string, false)) as Statement;

// The firm's latest live daily file, checked again on every read: against the firm's current live key (so a replaced
// key stops counting at once) and its age against the maximum (so an old file stops counting on its own).
export function filePartnerLedger(store: Store, entityId: string, deps: PartnerKitDeps): PartnerLedger {
  return {
    id: "partner_file",
    name: "The licence provider's ledger, from its signed daily file",
    kind: "live",
    async read(ctx: PartnerLedgerContext) {
      const u = await latestUpload(store, entityId, "live");
      if (!u) return ledgerError("no_daily_file", "The partner hasn't uploaded a live daily file");
      let s: Statement;
      try {
        s = openUpload(u);
      } catch {
        return ledgerError("daily_file_unreadable", "The stored daily file can't be opened");
      }
      const check = checkStatement(s, { entity_id: entityId, environment: "live", request_id: null, ...(await keysFor(store, entityId, deps, "live")), now: ctx.now(), max_age_ms: fileMaxAgeMs(), product_ids: [ctx.product_id] });
      if (!check.ok) return ledgerError(check.cases.find((c) => c.case === "clock" && !c.passed) ? "daily_file_stale" : `daily_file_${failedCases(check)[0] ?? "invalid"}`, "The partner's daily file can't be used");
      return readingFor(s, ctx.product_id);
    },
  };
}

// Which ledger a sponsor's snapshots read: its HTTP feed or daily file once it passed conformance (not yet run out) and
// switched to it, and the sandbox otherwise. Decided on every read, so switching back, an endpoint change or an expired
// run takes effect at once. It throws when it can't tell, and the caller treats that as unknown, never as sandbox.
export function partnerLedgerFor(store: Store, deps: PartnerKitDeps): (entityId: string) => Promise<PartnerLedger> {
  const batches: LedgerBatches = new Map();
  return async (entityId) => {
    const row = await sourceRow(store, entityId);
    if (!row || row.active_source === "sandbox") return sandboxPartnerLedger;
    if (!runQualifies(row, await runById(store, row.active_run_id), deps.now?.() ?? new Date())) return sandboxPartnerLedger;
    return row.active_source === "http" ? httpPartnerLedger(store, entityId, deps, batches) : filePartnerLedger(store, entityId, deps);
  };
}

// ---- conformance ----

const refusedCase = (name: string, r: VendorResult, want: number[], what: string): CaseResult => {
  const problems: string[] = [];
  if (r.http_status == null) problems.push(r.error ?? "no answer");
  else if (!want.includes(r.http_status)) problems.push(`${what} was answered ${r.http_status}, expected ${want.join(" or ")}`);
  else {
    const code = (r.body as { error?: { code?: unknown } } | null)?.error?.code;
    if (typeof code !== "string" || !/^[a-z0-9_]{1,64}$/.test(code)) problems.push('the refusal\'s body must be { "error": { "code": "…", "message": "…" } }');
  }
  return { case: name, passed: !problems.length, problems, http_status: r.http_status };
};
const REFUSALS = [400, 401, 403, 422];

// The ledger cases against the test endpoint, and the endpoint version they were run against (read once, up front, so
// an endpoint change during the run can't be credited with a pass it didn't earn).
async function httpLedgerCases(store: Store, entityId: string, products: string[], deps: PartnerKitDeps, now: Date): Promise<{ cases: CaseResult[]; config_version: number | null }> {
  const row = await sourceRow(store, entityId);
  const config_version = row?.config_version ?? null;
  const secret = secretOf(row);
  const keys = await keysFor(store, entityId, deps, "test");
  const setup: string[] = [];
  if (!row?.test_url || !row.live_url) setup.push("your firm hasn't confirmed test and live endpoints yet (an admin proposes them with configure_partner_ledger; you confirm with confirm_partner_ledger_endpoints)");
  if (!secret) setup.push("no request-signing secret has been issued");
  if (!keys.public_key) setup.push("your firm has no registered test signing key: use register_partner_test_signing_key");
  if (!keys.other_key) setup.push("your firm has no registered live signing key: use register_partner_signing_key");
  if (!products.length) setup.push("your firm sponsors no product yet, so coverage can't be checked");
  const cases: CaseResult[] = [{ case: "setup", passed: !setup.length, problems: setup }];
  if (setup.length) return { cases, config_version };
  const base = { base_url: row!.test_url!, secret: secret!, environment: "test" as const, entity_id: entityId, period_end: now.toISOString() };
  const opts = { timeoutMs: ledgerTimeoutMs(), ...deps.opts };

  // Every sponsored product, and one Mynt made up: an unknown product must come back null with a reason, never 0.
  const unknown = `mynt_conformance_unknown_${randomBytes(4).toString("hex")}`;
  const { request, result } = await requestLedger({ ...base, product_ids: [...products, unknown] }, opts);
  if (!result.ok) cases.push({ case: "answer", passed: false, problems: [result.error ?? "no answer"], http_status: result.http_status });
  else {
    const check = checkStatement(result.body, { entity_id: entityId, environment: "test", request_id: request.request_id, ...keys, now, max_age_ms: httpMaxAgeMs(), product_ids: products });
    cases.push({ case: "answer", passed: true, problems: [], http_status: result.http_status }, ...check.cases);
    if (check.statement) {
      const u = check.statement.products.find((p) => p.product_id === unknown);
      const problems = !u
        ? ["a product you don't know was left out: answer every product_id asked for, with null figures and a reason"]
        : u.reserves_held_cents !== null || u.customer_obligations_cents !== null
          ? ["a product you don't know came back with figures: it must be null with a reason, never 0"]
          : [];
      cases.push({ case: "unknown_product_null", passed: !problems.length, problems });
    }
  }
  const signed = (payload: string) => signBody(secret!, payload);
  cases.push(refusedCase("bad_signature_refused", (await requestLedger({ ...base, product_ids: products, sign: (p) => signBody(newSecret(), p) }, opts)).result, [401], "a request with a bad Mynt-Signature"));
  const stale = Math.floor(now.getTime() / 1000) - 600;
  cases.push(refusedCase("stale_request_refused", (await requestLedger({ ...base, product_ids: products, sign: (p) => signBody(secret!, p, stale) }, opts)).result, [401], "a request signed 600 s ago"));
  cases.push(refusedCase("malformed_request_refused", (await requestLedger({ ...base, product_ids: products, body: { schema: "mynt.partner_ledger.request.v1", request_id: randomUUID() }, sign: signed }, opts)).result, [400, 422], "a correctly signed request with no product_ids"));
  // The test deployment serves test books only: a live request sent to it must be refused, never answered.
  cases.push(refusedCase("wrong_environment_refused", (await requestLedger({ ...base, product_ids: products, environment_claim: "live" }, opts)).result, REFUSALS, "a correctly signed request for the live environment, sent to your test endpoint"));
  // A request meant for another URL may have been relayed: it must be refused.
  cases.push(refusedCase("wrong_audience_refused", (await requestLedger({ ...base, product_ids: products, audience: ledgerUrl(row!.live_url!) }, opts)).result, REFUSALS, "a correctly signed request whose audience is another URL (your live endpoint's)"));
  return { cases, config_version };
}

async function fileLedgerCases(store: Store, entityId: string, products: string[], deps: PartnerKitDeps, now: Date): Promise<CaseResult[]> {
  const setup: string[] = [];
  if (!products.length) setup.push("your firm sponsors no product yet, so coverage can't be checked");
  const u = await latestUpload(store, entityId);
  if (!u) setup.push("no daily file uploaded yet: upload_partner_ledger_file (a test one is fine)");
  const keys = u ? await keysFor(store, entityId, deps, u.environment as "test" | "live") : null;
  if (u && !keys?.public_key) setup.push(`your firm has no registered ${u.environment} signing key`);
  const cases: CaseResult[] = [{ case: "setup", passed: !setup.length, problems: setup }];
  if (setup.length) return cases;
  let s: Statement | null = null;
  try {
    s = openUpload(u!);
  } catch {
    cases.push({ case: "daily_file", passed: false, problems: ["the stored file can't be opened"] });
    return cases;
  }
  const check = checkStatement(s, { entity_id: entityId, environment: u!.environment as "test" | "live", request_id: null, ...keys!, now, max_age_ms: fileMaxAgeMs(), product_ids: products });
  cases.push(...check.cases);
  return cases;
}

// (b): the identity providers this firm accepts for what it sponsors: its own firm's identity offerings, and those it
// approved for a sponsorship. At least one must answer a passed test check with a residential_state.
async function identityPart(store: Store, entityId: string, opts: VendorCallOptions) {
  const { rows } = await store.db.query(
    `SELECT o.id FROM ${T}.vendor_offerings o JOIN ${T}.service_types t ON t.region = o.region AND t.key = o.service_type
       WHERE o.entity_id = $1 AND t.category IN ('identity', 'kyc') AND o.status IN ('listed', 'conformance_passed')
     UNION
     SELECT p.offering_id FROM ${T}.sponsorship_identity_providers p JOIN ${T}.sponsorships s ON s.id = p.sponsorship_id
       WHERE s.provider_entity_id = $1 AND s.status = 'approved' AND p.revoked_at IS NULL`,
    [entityId],
  );
  const providers = [];
  for (const r of rows) providers.push(await probeIdentityOffering(store, r.id as string, opts));
  const passed = providers.some((p) => p.passed);
  const problems = passed
    ? []
    : providers.length
      ? ["none of the identity providers you accept answered a passed test check with residential_state"]
      : ["you accept no identity provider yet: offer one from your firm, or approve one with approve_identity_provider"];
  return { passed, problems, providers };
}

// (c): the firm's rails and what their own conformance says. Reported, not re-tested: a ramp adapter's or a wire
// partner's offering passes run_conformance; the other kinds carry no transfer yet.
async function railsPart(store: Store, entityId: string) {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.money_rails WHERE entity_id = $1 AND status <> 'revoked' ORDER BY created_at`, [entityId]);
  const rails = [];
  for (const r of rows) {
    let conformance: { offering_id: string; passed: boolean; at: string | null } | null = null;
    let note: string | null = null;
    if (r.kind === "ramp_adapter") {
      const uuid = /^[0-9a-f-]{36}$/i.test(r.provider as string);
      const { rows: runs } = await store.db.query(
        `SELECT c.offering_id, c.passed, c.created_at FROM ${T}.vendor_conformance_runs c JOIN ${T}.vendor_offerings o ON o.id = c.offering_id
         WHERE ${uuid ? "o.id::text = $1" : "o.adapter = $1"} ORDER BY c.created_at DESC LIMIT 1`,
        [r.provider],
      );
      conformance = runs[0] ? { offering_id: runs[0].offering_id as string, passed: runs[0].passed as boolean, at: iso(runs[0].created_at) } : null;
      if (!conformance) note = "its offering hasn't run conformance yet";
    } else note = "no path instructs this kind yet, so there's nothing to test";
    const ok = r.status === "approved" && r.kind === "ramp_adapter" && !!conformance?.passed;
    rails.push({ rail_id: r.id, kind: r.kind, provider: r.provider, direction: r.direction, status: r.status, states: r.states, conformance, ok, note });
  }
  const passed = rails.some((r) => r.ok);
  return { passed, problems: passed ? [] : ["no approved rail that carries transfers has passed its conformance (propose_rail, then the offering's run_conformance)"], rails };
}

export async function runPartnerConformance(store: Store, entityId: string, source: "http" | "file", by: string | null, deps: PartnerKitDeps) {
  const now = deps.now?.() ?? new Date();
  const products = await sponsoredProducts(store, entityId);
  let cases: CaseResult[];
  let configVersion: number | null;
  if (source === "http") ({ cases, config_version: configVersion } = await httpLedgerCases(store, entityId, products, deps, now));
  else {
    cases = await fileLedgerCases(store, entityId, products, deps, now);
    configVersion = (await sourceRow(store, entityId))?.config_version ?? null;
  }
  const ledger = { passed: cases.every((c) => c.passed), cases };
  const identity = await identityPart(store, entityId, deps.opts ?? {});
  const rails = await railsPart(store, entityId);
  const id = randomUUID();
  const passed = ledger.passed && identity.passed && rails.passed;
  await store.db.query(
    `INSERT INTO ${T}.partner_conformance_runs (id, entity_id, source, config_version, passed, ledger_passed, identity_passed, rails_passed, ledger, identity, rails, run_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, entityId, source, configVersion, passed, ledger.passed, identity.passed, rails.passed, JSON.stringify(ledger), JSON.stringify(identity), JSON.stringify(rails), by, now.toISOString()],
  );
  await store.audit(by, "run_partner_conformance", entityId, { run_id: id, source, passed, ledger_passed: ledger.passed, identity_passed: identity.passed, rails_passed: rails.passed });
  return {
    run_id: id,
    entity_id: entityId,
    source,
    at: now.toISOString(),
    expires_at: new Date(now.getTime() + conformanceMaxAgeMs()).toISOString(),
    config_version: configVersion,
    passed,
    can_go_live: ledger.passed,
    ledger,
    identity,
    rails,
    next: ledger.passed ? `set_partner_ledger_source { source: "${source}" } switches your ledger to it` : "fix what failed and run it again",
  };
}

// ---- views (no figures, ever) ----

const runView = (r: RunRow) => ({
  run_id: r.id,
  source: r.source,
  at: iso(r.created_at),
  expires_at: new Date(new Date(r.created_at).getTime() + conformanceMaxAgeMs()).toISOString(),
  passed: r.passed,
  ledger_passed: r.ledger_passed,
  identity_passed: r.identity_passed,
  rails_passed: r.rails_passed,
  ledger: r.ledger,
  identity: r.identity,
  rails: r.rails,
});

// What get_my_entity and admins see: the source in use, whether it's live, any endpoint change waiting for the firm,
// each conformance run with its time, and the uploads' metadata. Never a figure.
export async function partnerKitSummary(store: Store, entityId: string, o: { runs?: number; now?: Date } = {}) {
  const now = o.now ?? new Date();
  const row = await sourceRow(store, entityId);
  const { rows: runs } = await store.db.query(`SELECT * FROM ${T}.partner_conformance_runs WHERE entity_id = $1 ORDER BY created_at DESC LIMIT $2`, [entityId, o.runs ?? 10]);
  const { rows: uploads } = await store.db.query(`SELECT id, environment, as_of, products, uploaded_at FROM ${T}.partner_ledger_uploads WHERE entity_id = $1 ORDER BY uploaded_at DESC LIMIT 10`, [entityId]);
  const active = row?.active_source ?? "sandbox";
  const activeRun = row ? await runById(store, row.active_run_id) : null;
  const live = !!row && active !== "sandbox" && runQualifies(row, activeRun, now);
  const last = async (source: "http" | "file") => {
    const r = await latestRun(store, entityId, source);
    return r ? { run_id: r.id, at: iso(r.created_at), passed: r.passed, ledger_passed: r.ledger_passed, identity_passed: r.identity_passed, rails_passed: r.rails_passed } : null;
  };
  return {
    ledger_source: live ? active : "sandbox",
    live,
    ...(active !== "sandbox" && !live ? { note: `Set to ${active}, but its conformance no longer qualifies (it ran out, or the endpoints changed), so the sandbox is read: run_partner_conformance again` } : {}),
    activated_at: live ? iso(row!.activated_at) : null,
    live_until: live && activeRun ? new Date(new Date(activeRun.created_at).getTime() + conformanceMaxAgeMs()).toISOString() : null,
    endpoints: row && (row.test_url || row.live_url) ? { test_url: row.test_url, live_url: row.live_url, config_version: row.config_version, confirmed_at: iso(row.configured_at) } : null,
    pending_endpoint_change: row?.pending_at
      ? { test_url: row.pending_test_url, live_url: row.pending_live_url, proposed_at: iso(row.pending_at), note: "Proposed by a Mynt admin. It doesn't take effect until your firm's own licence provider checks both URLs are yours and confirms with confirm_partner_ledger_endpoints." }
      : null,
    request_secret: { issued: !!row?.signing_secret, taken: !!row?.secret_shown_at },
    test_signing_key: await testSigningKey(store, entityId),
    last_conformance: { http: await last("http"), file: await last("file") },
    conformance_runs: (runs as unknown as RunRow[]).map(runView),
    daily_files: uploads.map((u) => ({ upload_id: u.id, environment: u.environment, as_of: iso(u.as_of), products: u.products, uploaded_at: iso(u.uploaded_at) })),
    limits: { http_max_age_hours: httpMaxAgeMs() / HOUR, file_max_age_hours: fileMaxAgeMs() / HOUR, conformance_max_age_days: conformanceMaxAgeMs() / DAY, request_timeout_ms: ledgerTimeoutMs(), clock_skew_seconds: 300 },
    guide: "docs/partners.md",
  };
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });
const notify = (store: Store, entityId: string, type: "partner_ledger.endpoint_change_pending" | "partner_ledger.source_changed", data: Record<string, unknown>) =>
  emitFirmEvent(store, entityId, type, data, false).catch((e) => {
    console.error("partner kit: webhook not queued:", (e as Error).message);
    return 0;
  });

export function registerPartnerKitTools(server: McpServer, store: Store, user: User, o: PartnerKitDeps & { admin: boolean; licenceProvider: boolean }) {
  const deps: PartnerKitDeps = { signingKeyOf: o.signingKeyOf, opts: o.opts, now: o.now };
  const now = () => o.now?.() ?? new Date();
  const myFirm = async () => ((await store.getUser(user.id)) ?? user).entity_id ?? null;
  // A firm's own member who isn't an admin: the only one who takes its secret, registers its test key, confirms its
  // endpoints, uploads its files or switches it to live.
  const member = o.licenceProvider && !o.admin;
  const firmFor = async (entityId: string | undefined, needActive = true): Promise<string | { error: string }> => {
    let firm: string;
    if (o.admin) {
      if (!entityId) return { error: "Admin: name the licence provider's entity_id" };
      if (!(await store.getEntity(entityId))) return { error: `No firm '${entityId}'` };
      firm = entityId;
    } else {
      const mine = await myFirm();
      if (!mine) return { error: "You don't belong to a firm yet" };
      if (entityId && entityId !== mine) return { error: "Only your own firm's" };
      firm = mine;
    }
    if (needActive && !(await firmActive(store, firm))) return { error: "The firm isn't active" };
    return firm;
  };

  server.registerTool(
    "get_partner_kit",
    {
      title: "Partner kit: your ledger source and conformance",
      description:
        "Licence provider (your firm) or admin (any firm): where the firm's ledger is read from (sandbox, http or file) and whether it's live, its endpoints and any change an admin proposed that waits for the firm's confirmation, whether its request-signing secret was taken, its test signing key, every conformance run with its time and expiry, and its daily files' times. Never the figures. The guide for a firm's engineers is docs/partners.md.",
      inputSchema: { entity_id: z.string().uuid().optional().describe("Admin: the licence provider's firm") },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id }) => {
      const firm = await firmFor(entity_id, false);
      if (typeof firm !== "string") return fail(firm.error);
      return json({ entity_id: firm, ...(await partnerKitSummary(store, firm, { now: now() })) });
    },
  );

  server.registerTool(
    "run_partner_conformance",
    {
      title: "Have Mynt test your ledger, identity and rails",
      description:
        "Licence provider (your firm) or admin: Mynt tests (a) your ledger: source http calls your test endpoint with signed requests and checks the statement's schema, Ed25519 signature with your test key, clock, null handling, coverage of every product you sponsor, and that bad, stale, malformed, wrong-environment and wrong-audience requests are refused; source file checks your latest uploaded daily file the same way. (b) An identity provider you accept answers a passed test check with residential_state. (c) Your money rails' own conformance, reported. Passing (a) lets you switch to that source with set_partner_ledger_source; a pass runs out after a while (expires_at). Results are kept with their time.",
      inputSchema: { source: z.enum(["http", "file"]), entity_id: z.string().uuid().optional().describe("Admin: the licence provider's firm") },
    },
    async ({ source, entity_id }) => {
      const firm = await firmFor(entity_id);
      if (typeof firm !== "string") return fail(firm.error);
      if (!vaultAvailable(false)) return fail("The partner kit needs MYNT_VAULT_KEY set on the server");
      return json(await runPartnerConformance(store, firm, source, user.id, deps));
    },
  );

  if (o.admin) {
    server.registerTool(
      "configure_partner_ledger",
      {
        title: "Propose a licence provider's ledger endpoints",
        description:
          "Admin: propose a licence provider's test and live HTTPS endpoints for its ledger feed (Mynt POSTs to <url>/v1/ledger). An origin and a path only: HTTPS on 443, public addresses, no query string or fragment, and different from each other. Nothing changes until the firm's own licence provider confirms them (confirm_partner_ledger_endpoints); the firm is told on its webhooks. Audited.",
        inputSchema: { entity_id: z.string().uuid(), test_url: z.string().url().max(500), live_url: z.string().url().max(500) },
      },
      async ({ entity_id, test_url, live_url }) => {
        const entity = await store.getEntity(entity_id);
        if (!entity) return fail(`No firm '${entity_id}'`);
        if (entity.status !== "active") return fail("The firm isn't active");
        if (!vaultAvailable(false)) return fail("The partner kit needs MYNT_VAULT_KEY set on the server");
        for (const [name, url] of [["test_url", test_url], ["live_url", live_url]] as const) {
          const bad = endpointProblem(url);
          if (bad) return fail(`${name} ${bad}`);
          try {
            await resolveVendorUrl(url, o.opts ?? {});
          } catch (e) {
            if (e instanceof OutboundRefused) return fail(`${name}: ${e.message}`);
            throw e;
          }
        }
        if (normUrl(test_url) === normUrl(live_url)) return fail("test_url and live_url must be different endpoints: test books never stand in for live ones");
        await store.db.query(
          `INSERT INTO ${T}.partner_ledger_sources (entity_id, pending_test_url, pending_live_url, pending_by, pending_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (entity_id) DO UPDATE SET pending_test_url = EXCLUDED.pending_test_url, pending_live_url = EXCLUDED.pending_live_url, pending_by = EXCLUDED.pending_by, pending_at = now(), updated_at = now()`,
          [entity_id, normUrl(test_url), normUrl(live_url), user.id],
        );
        await store.audit(user.id, "configure_partner_ledger", entity_id, { test_url: normUrl(test_url), live_url: normUrl(live_url), status: "pending_confirmation" });
        const notified = await notify(store, entity_id, "partner_ledger.endpoint_change_pending", { test_url: normUrl(test_url), live_url: normUrl(live_url), proposed_at: now().toISOString(), confirm_with: "confirm_partner_ledger_endpoints" });
        return json({ entity_id, test_url: normUrl(test_url), live_url: normUrl(live_url), status: "pending_confirmation", firm_notified_webhooks: notified, note: "Nothing changes until the firm's own licence provider confirms these with confirm_partner_ledger_endpoints" });
      },
    );
  }

  if (o.admin || member)
    server.registerTool(
      "set_partner_ledger_source",
      {
        title: "Switch your ledger source",
        description:
          "Licence provider: read your firm's ledger from http (your live endpoint) or file (your daily uploads) instead of the sandbox, or go back to sandbox. Refused until that source's latest run_partner_conformance passed its ledger part and hasn't run out; switching to http also reads your live endpoint once and checks the statement, signed with your live key (the figures are discarded), and switching to file needs a fresh live daily file. Admins can only send a firm back to sandbox, and the firm is told on its webhooks. Audited.",
        inputSchema: { source: z.enum(LEDGER_SOURCES), entity_id: z.string().uuid().optional().describe("Admin: the firm to send back to sandbox") },
      },
      async ({ source, entity_id }) => {
        if (o.admin && source !== "sandbox") return fail("Only the firm's own licence provider can switch it to a live source; an admin can only send it back to sandbox");
        const firm = await firmFor(entity_id, source !== "sandbox");
        if (typeof firm !== "string") return fail(firm.error);
        const set = async (runId: string | null) => {
          await store.db.query(
            `INSERT INTO ${T}.partner_ledger_sources (entity_id, active_source, active_run_id, activated_by, activated_at) VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (entity_id) DO UPDATE SET active_source = EXCLUDED.active_source, active_run_id = EXCLUDED.active_run_id, activated_by = EXCLUDED.activated_by, activated_at = now(), updated_at = now()`,
            [firm, source, runId, user.id],
          );
          await store.audit(user.id, o.admin ? "admin_set_partner_ledger_source" : "set_partner_ledger_source", firm, { source, run_id: runId });
        };
        if (source === "sandbox") {
          await set(null);
          const notified = o.admin ? await notify(store, firm, "partner_ledger.source_changed", { source: "sandbox", by: "admin", at: now().toISOString() }) : 0;
          return json({ entity_id: firm, ledger_source: "sandbox", live: false, ...(o.admin ? { firm_notified_webhooks: notified } : {}) });
        }
        const run = await latestRun(store, firm, source);
        const row = await sourceRow(store, firm);
        const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
          await store.audit(user.id, "set_partner_ledger_source_refused", firm, { source, reason });
          return fail(reason, extra);
        };
        if (!run || !run.ledger_passed) return refuse(`Your latest ${source} conformance hasn't passed its ledger part: run_partner_conformance { source: "${source}" } until it does`);
        if (now().getTime() - new Date(run.created_at).getTime() > conformanceMaxAgeMs()) return refuse("Your latest conformance pass has run out: run it again");
        if (source === "http") {
          if (!row?.live_url || run.config_version !== row.config_version) return refuse("Your endpoints changed after your last conformance run: run it again");
          // One read of the live endpoint, checked like any other (live key only); the figures are thrown away.
          const s = await readLive(store, firm, row, await sponsoredProducts(store, firm), now().toISOString(), now(), deps);
          if (isLedgerError(s)) return refuse(`Your live endpoint's statement didn't pass Mynt's checks (${s.error.code})`);
        } else {
          const u = await latestUpload(store, firm, "live");
          if (!u || now().getTime() - new Date(u.as_of as string).getTime() > fileMaxAgeMs()) return refuse("Upload today's live daily file first (upload_partner_ledger_file with environment live)");
        }
        await set(run.id);
        return json({ entity_id: firm, ledger_source: source, live: true, conformance_run_id: run.id, conformance_at: iso(run.created_at), live_until: new Date(new Date(run.created_at).getTime() + conformanceMaxAgeMs()).toISOString(), note: "Your next product-health snapshots read this source" });
      },
    );

  if (!member) return;

  server.registerTool(
    "confirm_partner_ledger_endpoints",
    {
      title: "Confirm (or decline) the ledger endpoints an admin proposed",
      description:
        "Licence provider: an admin's proposed test and live endpoints (get_partner_kit, pending_endpoint_change) take effect only when you confirm them. Check both are your own deployments, then pass them back exactly. Confirming a change puts your firm back on the sandbox until it passes conformance again. accept: false declines it. Audited.",
      inputSchema: { test_url: z.string().url().max(500), live_url: z.string().url().max(500), accept: z.boolean().default(true) },
    },
    async ({ test_url, live_url, accept }) => {
      const firm = await firmFor(undefined);
      if (typeof firm !== "string") return fail(firm.error);
      const row = await sourceRow(store, firm);
      if (!row?.pending_at) return fail("No endpoint change is waiting for your firm");
      if (normUrl(test_url) !== row.pending_test_url || normUrl(live_url) !== row.pending_live_url) return fail("Those aren't the URLs proposed: read pending_endpoint_change in get_partner_kit and pass them back exactly");
      if (!accept) {
        await store.db.query(`UPDATE ${T}.partner_ledger_sources SET pending_test_url = NULL, pending_live_url = NULL, pending_by = NULL, pending_at = NULL, updated_at = now() WHERE entity_id = $1`, [firm]);
        await store.audit(user.id, "decline_partner_ledger_endpoints", firm, { test_url: row.pending_test_url, live_url: row.pending_live_url });
        return json({ entity_id: firm, status: "declined" });
      }
      const changed = row.test_url !== row.pending_test_url || row.live_url !== row.pending_live_url;
      const backToSandbox = changed && row.active_source === "http";
      await store.db.query(
        `UPDATE ${T}.partner_ledger_sources SET test_url = pending_test_url, live_url = pending_live_url, pending_test_url = NULL, pending_live_url = NULL, pending_by = NULL, pending_at = NULL,
           signing_secret = COALESCE(signing_secret, $2), config_version = config_version + CASE WHEN $3 THEN 1 ELSE 0 END,
           active_source = CASE WHEN $4 THEN 'sandbox' ELSE active_source END, active_run_id = CASE WHEN $4 THEN NULL ELSE active_run_id END,
           configured_by = $5, configured_at = now(), updated_at = now()
         WHERE entity_id = $1`,
        [firm, seal(newSecret(), false), changed, backToSandbox, user.id],
      );
      await store.audit(user.id, "confirm_partner_ledger_endpoints", firm, { test_url: row.pending_test_url, live_url: row.pending_live_url, changed, back_to_sandbox: backToSandbox });
      const cur = (await sourceRow(store, firm))!;
      return json({
        entity_id: firm,
        status: "confirmed",
        test_url: cur.test_url,
        live_url: cur.live_url,
        config_version: cur.config_version,
        ledger_source: cur.active_source,
        ...(backToSandbox ? { note: "Your endpoints changed, so your firm is back on the sandbox until it passes run_partner_conformance again" } : {}),
        request_secret: cur.secret_shown_at ? "already taken" : "issued: take it once with reveal_partner_ledger_secret",
      });
    },
  );

  server.registerTool(
    "register_partner_test_signing_key",
    {
      title: "Register your firm's test signing key",
      description:
        "Licence provider: register a separate Ed25519 public key (base58) that signs your test statements only. A statement signed with it is never valid for live, and one signed with your live key (register_partner_signing_key) is never valid for test, so test books can't be read as live. It must differ from your live key. Registering again replaces it.",
      inputSchema: { public_key: z.string().min(32).max(64).describe("Your firm's test Ed25519 public key, base58") },
    },
    async ({ public_key }) => {
      const firm = await firmFor(undefined);
      if (typeof firm !== "string") return fail(firm.error);
      if (!vaultAvailable(false)) return fail("The partner kit needs MYNT_VAULT_KEY set on the server");
      if (!isAddress(public_key) || isWeakEd25519Key(base58Decode(public_key))) return fail("public_key must be a usable Ed25519 public key, base58 (a Solana-style address)");
      if ((await o.signingKeyOf(firm)) === public_key || (await everLiveKey(store, firm, public_key))) return fail("That's a live signing key of your firm: the test key must be a different key");
      await store.db.query(
        `INSERT INTO ${T}.partner_test_signing_keys (entity_id, public_key, registered_by, mac) VALUES ($1, $2, $3, $4)
         ON CONFLICT (entity_id) DO UPDATE SET public_key = EXCLUDED.public_key, registered_by = EXCLUDED.registered_by, registered_at = now(), mac = EXCLUDED.mac`,
        [firm, public_key, user.id, testKeyMac(firm, public_key)],
      );
      await store.audit(user.id, "register_partner_test_signing_key", firm, { public_key });
      return json({ entity_id: firm, public_key, environment: "test", note: "Sign test statements with this key only; live statements with your live key." });
    },
  );

  server.registerTool(
    "reveal_partner_ledger_secret",
    {
      title: "Take your ledger request-signing secret",
      description:
        "Licence provider: the secret Mynt signs its ledger requests with (Mynt-Signature, HMAC-SHA256), shown once. Your endpoint verifies every request with it and refuses anything else with 401. Lost it? rotate_partner_ledger_secret.",
      inputSchema: {},
    },
    async () => {
      const firm = await firmFor(undefined);
      if (typeof firm !== "string") return fail(firm.error);
      const row = await sourceRow(store, firm);
      if (!row?.signing_secret) return fail("No secret yet: confirm your endpoints first (confirm_partner_ledger_endpoints)");
      const { rows } = await store.db.query(`UPDATE ${T}.partner_ledger_sources SET secret_shown_at = now() WHERE entity_id = $1 AND secret_shown_at IS NULL RETURNING entity_id`, [firm]);
      if (!rows.length) return fail("It was already shown once: rotate_partner_ledger_secret issues a new one");
      await store.audit(user.id, "reveal_partner_ledger_secret", firm, {});
      return json({ secret: open(row.signing_secret, false), note: "Shown once. Keep it in your secrets store, never in code." });
    },
  );

  server.registerTool(
    "rotate_partner_ledger_secret",
    {
      title: "Replace your ledger request-signing secret",
      description: "Licence provider: issue a new request-signing secret, shown once. The old one stops being used at once, so update your endpoint straight away.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => {
      const firm = await firmFor(undefined);
      if (typeof firm !== "string") return fail(firm.error);
      const row = await sourceRow(store, firm);
      if (!row?.signing_secret) return fail("No secret yet: confirm your endpoints first (confirm_partner_ledger_endpoints)");
      const secret = newSecret();
      await store.db.query(`UPDATE ${T}.partner_ledger_sources SET signing_secret = $2, secret_shown_at = now(), updated_at = now() WHERE entity_id = $1`, [firm, seal(secret, false)]);
      await store.audit(user.id, "rotate_partner_ledger_secret", firm, {});
      return json({ secret, note: "Shown once. Mynt signs with it from now on." });
    },
  );

  server.registerTool(
    "upload_partner_ledger_file",
    {
      title: "Upload your signed daily ledger file",
      description:
        "Licence provider, for a firm without an API: upload today's statement (schemas/partner-ledger/statement.v1.schema.json, request_id null), signed with your live key (environment live) or your test key (environment test). Mynt checks the schema, the signature, that as_of isn't in the future or older than the maximum age, and that it's newer than your last file; the result says which sponsored products it leaves out. It's stored sealed: admins never see the figures. A live file is your ledger once you've switched to source file, and is checked against your current live key on every read.",
      inputSchema: { statement: z.record(z.string(), z.unknown()).describe("The signed statement, as JSON") },
    },
    async ({ statement }) => {
      const firm = await firmFor(undefined);
      if (typeof firm !== "string") return fail(firm.error);
      if (!vaultAvailable(false)) return fail("The partner kit needs MYNT_VAULT_KEY set on the server");
      const products = await sponsoredProducts(store, firm);
      const environment = statement.environment === "test" ? "test" : "live";
      const check = checkStatement(statement, { entity_id: firm, environment, request_id: null, ...(await keysFor(store, firm, deps, environment)), now: now(), max_age_ms: fileMaxAgeMs(), product_ids: products });
      if (!check.ok) {
        await store.audit(user.id, "upload_partner_ledger_file_refused", firm, { failed: failedCases(check) });
        return fail("The file didn't pass Mynt's checks, and wasn't stored", { cases: check.cases.filter((c) => !c.passed) });
      }
      const s = check.statement!;
      const last = await latestUpload(store, firm, environment);
      if (last && new Date(last.as_of as string).getTime() >= new Date(s.as_of).getTime()) {
        await store.audit(user.id, "upload_partner_ledger_file_refused", firm, { failed: ["older_than_latest"] });
        return fail("Its as_of isn't after your latest file's: a file can't replace a newer one");
      }
      const id = randomUUID();
      await store.db.query(
        `INSERT INTO ${T}.partner_ledger_uploads (id, entity_id, environment, as_of, public_key, statement_sealed, products, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, firm, environment, s.as_of, s.signature.public_key, seal(JSON.stringify(s), false), s.products.length, user.id],
      );
      await store.audit(user.id, "upload_partner_ledger_file", firm, { upload_id: id, environment, as_of: s.as_of, products: s.products.length });
      const sponsored = new Set(products);
      const row = await sourceRow(store, firm);
      return json({
        upload_id: id,
        environment,
        as_of: s.as_of,
        products: s.products.length,
        missing: check.missing,
        not_sponsored: s.products.map((p) => p.product_id).filter((p) => !sponsored.has(p)),
        used_for_live: environment === "live" && row?.active_source === "file",
        ...(environment === "test" ? { note: "A test file is for conformance only: it never reads as live" } : {}),
      });
    },
  );
}

// Whether a key was ever the firm's live key (product-health's history table, when it exists).
async function everLiveKey(store: Store, entityId: string, publicKey: string): Promise<boolean> {
  try {
    const { rows } = await store.db.query(`SELECT 1 FROM ${T}.product_health_signing_key_history WHERE entity_id = $1 AND public_key = $2`, [entityId, publicKey]);
    return rows.length > 0;
  } catch {
    return false;
  }
}
