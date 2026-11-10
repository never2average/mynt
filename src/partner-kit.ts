import { randomBytes, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkStatement, failedCases, requestLedger, signBody, type CheckCase, type Statement } from "./partner-ledger/contract.js";
import { ledgerError, sandboxPartnerLedger, type PartnerLedger, type PartnerLedgerContext, type PartnerLedgerReading } from "./partner-ledger/index.js";
import type { Store, User } from "./store.js";
import { OutboundRefused, resolveVendorUrl, type VendorCallOptions, type VendorResult } from "./vendor-call.js";
import { open, seal, vaultAvailable } from "./vault.js";
import { probeIdentityOffering } from "./vendors.js";

// The partner integration kit: what Mynt needs from a licence provider, connected and checked the way vendors are.
//
//   (a) its ledger: funds held and customer obligations per product it sponsors, signed with its registered Ed25519
//       key. Read over HTTPS from fixed endpoints an admin sets (HttpPartnerLedger), or from a signed daily file the
//       firm uploads (FilePartnerLedger). Until the firm passes conformance and switches, its source is the sandbox.
//   (b) the customer's verified residential state, from an identity provider it accepts;
//   (c) money rails, from the rails' own conformance.
//
// run_partner_conformance tests (a) against the firm's test endpoint (or its latest file), (b) through the identity
// providers' test environments, and reports (c). Only a passed ledger part lets the firm go live on a source: (b) and
// (c) have their own gates on every money movement (money-rails.ts), and are reported here so a firm sees all three.
//
// Hard rules kept: a test statement never reads as live; admins configure endpoints and see pass or fail, never the
// figures (uploads are sealed, and no case or problem carries a number); anything unsure is null with a reason.

const T = "financial_products";
const HOUR = 3_600_000;
export const httpMaxAgeMs = () => (Number(process.env.PARTNER_LEDGER_MAX_AGE_HOURS) || 24) * HOUR;
export const fileMaxAgeMs = () => (Number(process.env.PARTNER_LEDGER_FILE_MAX_AGE_HOURS) || 36) * HOUR;
export const LEDGER_SOURCES = ["sandbox", "http", "file"] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export interface PartnerKitDeps {
  signingKeyOf: (entityId: string) => Promise<string | null>; // the firm's registered key (product-health.ts)
  opts?: VendorCallOptions; // tests only: loopback endpoints
  now?: () => Date;
}

type Row = Record<string, unknown>;
interface SourceRow {
  entity_id: string;
  test_url: string | null;
  live_url: string | null;
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

// A run lets a firm stay live on a source only while it's the one recorded, it passed its ledger part, and (for the
// HTTP feed) the endpoints haven't changed since.
const runQualifies = (row: SourceRow, run: RunRow | null) =>
  !!run && run.ledger_passed && run.source === row.active_source && (run.source !== "http" || (run.config_version === row.config_version && !!row.live_url));

// ---- the ledgers ----

// One product's figures from a checked statement. A product the statement leaves out is null with a reason.
function readingFor(s: Statement, productId: string): PartnerLedgerReading {
  const p = s.products.find((x) => x.product_id === productId);
  if (!p) return { reserves_held_cents: null, customer_obligations_cents: null, as_of: s.as_of, reason: "The partner's statement didn't cover this product" };
  return { reserves_held_cents: p.reserves_held_cents, customer_obligations_cents: p.customer_obligations_cents, as_of: s.as_of, reason: p.reason };
}
const transportCode = (r: VendorResult) => (r.error?.startsWith("refused") ? "endpoint_refused" : r.http_status == null ? "unreachable" : r.ok ? "bad_answer" : `http_${r.http_status}`);

// The partner's live endpoint, read once per product and period. Only a statement for the live environment, signed
// with the firm's registered key, fresh and well-formed, is used; anything else is an error and the snapshot says
// `unavailable`, with its figures null.
export function httpPartnerLedger(store: Store, entityId: string, deps: PartnerKitDeps): PartnerLedger {
  return {
    id: "partner_http",
    name: "The licence provider's ledger, over HTTPS",
    kind: "live",
    async read(ctx: PartnerLedgerContext) {
      const row = await sourceRow(store, entityId);
      const secret = secretOf(row);
      if (!row?.live_url || !secret) return ledgerError("not_configured", "The partner's live endpoint isn't configured");
      const { request, result } = await requestLedger({ base_url: row.live_url, secret, environment: "live", entity_id: entityId, product_ids: [ctx.product_id], period_end: ctx.period_end }, deps.opts);
      if (!result.ok) return ledgerError(transportCode(result), "The partner's endpoint didn't answer with a statement");
      const check = checkStatement(result.body, { entity_id: entityId, environment: "live", request_id: request.request_id, public_key: await deps.signingKeyOf(entityId), now: ctx.now(), max_age_ms: httpMaxAgeMs(), product_ids: [ctx.product_id] });
      if (!check.ok) return ledgerError(`statement_${failedCases(check)[0] ?? "invalid"}`, "The partner's statement didn't pass Mynt's checks");
      return readingFor(check.statement!, ctx.product_id);
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

// The firm's latest live daily file. It was checked when it was uploaded; here it's checked again (its own signature,
// and its age against the maximum), so an old file stops counting on its own.
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
      const check = checkStatement(s, { entity_id: entityId, environment: "live", request_id: null, public_key: u.public_key as string, now: ctx.now(), max_age_ms: fileMaxAgeMs(), product_ids: [ctx.product_id] });
      if (!check.ok) return ledgerError(check.cases.find((c) => c.case === "clock" && !c.passed) ? "daily_file_stale" : `daily_file_${failedCases(check)[0] ?? "invalid"}`, "The partner's daily file can't be used");
      return readingFor(s, ctx.product_id);
    },
  };
}

// Which ledger a sponsor's snapshots read: its HTTP feed or daily file once it passed conformance and switched to it,
// and the sandbox otherwise. Decided on every read, so switching back, or changing the endpoints, takes effect at once.
export function partnerLedgerFor(store: Store, deps: PartnerKitDeps): (entityId: string) => Promise<PartnerLedger> {
  return async (entityId) => {
    const row = await sourceRow(store, entityId);
    if (!row || row.active_source === "sandbox") return sandboxPartnerLedger;
    if (!runQualifies(row, await runById(store, row.active_run_id))) return sandboxPartnerLedger;
    return row.active_source === "http" ? httpPartnerLedger(store, entityId, deps) : filePartnerLedger(store, entityId, deps);
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

async function httpLedgerCases(store: Store, entityId: string, products: string[], publicKey: string | null, deps: PartnerKitDeps, now: Date): Promise<CaseResult[]> {
  const row = await sourceRow(store, entityId);
  const secret = secretOf(row);
  const setup: string[] = [];
  if (!row?.test_url || !row.live_url) setup.push("an admin hasn't set your test and live endpoints yet (configure_partner_ledger)");
  if (!secret) setup.push("no request-signing secret has been issued");
  if (!publicKey) setup.push("your firm has no registered signing key: use register_partner_signing_key");
  if (!products.length) setup.push("your firm sponsors no product yet, so coverage can't be checked");
  const cases: CaseResult[] = [{ case: "setup", passed: !setup.length, problems: setup }];
  if (setup.length) return cases;
  const base = { base_url: row!.test_url!, secret: secret!, environment: "test" as const, entity_id: entityId, period_end: now.toISOString() };

  // Every sponsored product, and one Mynt made up: an unknown product must come back null with a reason, never 0.
  const unknown = `mynt_conformance_unknown_${randomBytes(4).toString("hex")}`;
  const { request, result } = await requestLedger({ ...base, product_ids: [...products, unknown] }, deps.opts);
  if (!result.ok) cases.push({ case: "answer", passed: false, problems: [result.error ?? "no answer"], http_status: result.http_status });
  else {
    const check = checkStatement(result.body, { entity_id: entityId, environment: "test", request_id: request.request_id, public_key: publicKey, now, max_age_ms: httpMaxAgeMs(), product_ids: products });
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
  cases.push(refusedCase("bad_signature_refused", (await requestLedger({ ...base, product_ids: products, sign: (p) => signBody(newSecret(), p) }, deps.opts)).result, [401], "a request with a bad Mynt-Signature"));
  const stale = Math.floor(now.getTime() / 1000) - 600;
  cases.push(refusedCase("stale_request_refused", (await requestLedger({ ...base, product_ids: products, sign: (p) => signBody(secret!, p, stale) }, deps.opts)).result, [401], "a request signed 600 s ago"));
  cases.push(refusedCase("malformed_request_refused", (await requestLedger({ ...base, product_ids: products, body: { schema: "mynt.partner_ledger.request.v1", request_id: randomUUID() }, sign: signed }, deps.opts)).result, [400, 422], "a correctly signed request with no product_ids"));
  return cases;
}

async function fileLedgerCases(store: Store, entityId: string, products: string[], publicKey: string | null, now: Date): Promise<CaseResult[]> {
  const setup: string[] = [];
  if (!publicKey) setup.push("your firm has no registered signing key: use register_partner_signing_key");
  if (!products.length) setup.push("your firm sponsors no product yet, so coverage can't be checked");
  const u = await latestUpload(store, entityId);
  if (!u) setup.push("no daily file uploaded yet: upload_partner_ledger_file (a test one is fine)");
  const cases: CaseResult[] = [{ case: "setup", passed: !setup.length, problems: setup }];
  if (setup.length) return cases;
  let s: Statement | null = null;
  try {
    s = openUpload(u!);
  } catch {
    cases.push({ case: "daily_file", passed: false, problems: ["the stored file can't be opened"] });
    return cases;
  }
  const check = checkStatement(s, { entity_id: entityId, environment: u!.environment as "test" | "live", request_id: null, public_key: publicKey, now, max_age_ms: fileMaxAgeMs(), product_ids: products });
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
  const publicKey = await deps.signingKeyOf(entityId);
  const cases = source === "http" ? await httpLedgerCases(store, entityId, products, publicKey, deps, now) : await fileLedgerCases(store, entityId, products, publicKey, now);
  const ledger = { passed: cases.every((c) => c.passed), cases };
  const identity = await identityPart(store, entityId, deps.opts ?? {});
  const rails = await railsPart(store, entityId);
  const row = await sourceRow(store, entityId);
  const id = randomUUID();
  const passed = ledger.passed && identity.passed && rails.passed;
  await store.db.query(
    `INSERT INTO ${T}.partner_conformance_runs (id, entity_id, source, config_version, passed, ledger_passed, identity_passed, rails_passed, ledger, identity, rails, run_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, entityId, source, row?.config_version ?? null, passed, ledger.passed, identity.passed, rails.passed, JSON.stringify(ledger), JSON.stringify(identity), JSON.stringify(rails), by, now.toISOString()],
  );
  await store.audit(by, "run_partner_conformance", entityId, { run_id: id, source, passed, ledger_passed: ledger.passed, identity_passed: identity.passed, rails_passed: rails.passed });
  return {
    run_id: id,
    entity_id: entityId,
    source,
    at: now.toISOString(),
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
  passed: r.passed,
  ledger_passed: r.ledger_passed,
  identity_passed: r.identity_passed,
  rails_passed: r.rails_passed,
  ledger: r.ledger,
  identity: r.identity,
  rails: r.rails,
});

// What get_my_entity and admins see: the source in use, whether it's live, each conformance run with its time, and the
// uploads' metadata. Never a figure.
export async function partnerKitSummary(store: Store, entityId: string, o: { runs?: number } = {}) {
  const row = await sourceRow(store, entityId);
  const { rows: runs } = await store.db.query(`SELECT * FROM ${T}.partner_conformance_runs WHERE entity_id = $1 ORDER BY created_at DESC LIMIT $2`, [entityId, o.runs ?? 10]);
  const { rows: uploads } = await store.db.query(`SELECT id, environment, as_of, products, uploaded_at FROM ${T}.partner_ledger_uploads WHERE entity_id = $1 ORDER BY uploaded_at DESC LIMIT 10`, [entityId]);
  const active = row?.active_source ?? "sandbox";
  const live = !!row && active !== "sandbox" && runQualifies(row, await runById(store, row.active_run_id));
  const last = async (source: "http" | "file") => {
    const r = await latestRun(store, entityId, source);
    return r ? { run_id: r.id, at: iso(r.created_at), passed: r.passed, ledger_passed: r.ledger_passed, identity_passed: r.identity_passed, rails_passed: r.rails_passed } : null;
  };
  return {
    ledger_source: live ? active : "sandbox",
    live,
    ...(active !== "sandbox" && !live ? { note: `Set to ${active}, but its conformance no longer qualifies (an endpoint changed?), so the sandbox is read: run_partner_conformance again` } : {}),
    activated_at: live ? iso(row!.activated_at) : null,
    endpoints: row ? { test_url: row.test_url, live_url: row.live_url, config_version: row.config_version, configured_at: iso(row.configured_at) } : null,
    request_secret: { issued: !!row?.signing_secret, taken: !!row?.secret_shown_at },
    last_conformance: { http: await last("http"), file: await last("file") },
    conformance_runs: (runs as unknown as RunRow[]).map(runView),
    daily_files: uploads.map((u) => ({ upload_id: u.id, environment: u.environment, as_of: iso(u.as_of), products: u.products, uploaded_at: iso(u.uploaded_at) })),
    limits: { http_max_age_hours: httpMaxAgeMs() / HOUR, file_max_age_hours: fileMaxAgeMs() / HOUR, clock_skew_seconds: 300 },
    guide: "docs/partners.md",
  };
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });

export function registerPartnerKitTools(server: McpServer, store: Store, user: User, o: PartnerKitDeps & { admin: boolean; licenceProvider: boolean }) {
  const deps: PartnerKitDeps = { signingKeyOf: o.signingKeyOf, opts: o.opts, now: o.now };
  const now = () => o.now?.() ?? new Date();
  const myFirm = async () => ((await store.getUser(user.id)) ?? user).entity_id ?? null;
  // A firm's own member who isn't an admin: the only one who takes its secret, uploads its files or switches its source.
  const member = o.licenceProvider && !o.admin;
  const firmFor = async (entityId: string | undefined): Promise<string | { error: string }> => {
    if (o.admin) {
      if (!entityId) return { error: "Admin: name the licence provider's entity_id" };
      return (await store.getEntity(entityId)) ? entityId : { error: `No firm '${entityId}'` };
    }
    const mine = await myFirm();
    if (!mine) return { error: "You don't belong to a firm yet" };
    if (entityId && entityId !== mine) return { error: "Only your own firm's" };
    return mine;
  };

  server.registerTool(
    "get_partner_kit",
    {
      title: "Partner kit: your ledger source and conformance",
      description:
        "Licence provider (your firm) or admin (any firm): where the firm's ledger is read from (sandbox, http or file) and whether it's live, its endpoints, whether its request-signing secret was taken, every conformance run with its time and cases, and its daily files' times. Never the figures. The guide for a firm's engineers is docs/partners.md.",
      inputSchema: { entity_id: z.string().uuid().optional().describe("Admin: the licence provider's firm") },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id }) => {
      const firm = await firmFor(entity_id);
      if (typeof firm !== "string") return fail(firm.error);
      return json({ entity_id: firm, ...(await partnerKitSummary(store, firm)) });
    },
  );

  server.registerTool(
    "run_partner_conformance",
    {
      title: "Have Mynt test your ledger, identity and rails",
      description:
        "Licence provider (your firm) or admin: Mynt tests (a) your ledger: source http calls your test endpoint with signed requests and checks the statement's schema, Ed25519 signature, clock, null handling, coverage of every product you sponsor, and that bad, stale and malformed requests are refused; source file checks your latest uploaded daily file the same way. (b) An identity provider you accept answers a passed test check with residential_state. (c) Your money rails' own conformance, reported. Passing (a) lets you switch to that source with set_partner_ledger_source. Results are kept with their time.",
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
        title: "Set a licence provider's ledger endpoints",
        description:
          "Admin: fix a licence provider's test and live HTTPS endpoints for its ledger feed (Mynt POSTs to <url>/v1/ledger). HTTPS on 443 only, public addresses only. Changing them puts the firm back on the sandbox until it passes conformance again. The first time, Mynt issues the firm's request-signing secret, which its own member takes once with reveal_partner_ledger_secret: admins never see it. Audited.",
        inputSchema: { entity_id: z.string().uuid(), test_url: z.string().url().max(500), live_url: z.string().url().max(500) },
      },
      async ({ entity_id, test_url, live_url }) => {
        const entity = await store.getEntity(entity_id);
        if (!entity) return fail(`No firm '${entity_id}'`);
        if (!vaultAvailable(false)) return fail("The partner kit needs MYNT_VAULT_KEY set on the server");
        const norm = (u: string) => new URL(u).toString().replace(/\/+$/, "");
        if (norm(test_url) === norm(live_url)) return fail("test_url and live_url must be different endpoints: test books never stand in for live ones");
        for (const [name, url] of [["test_url", test_url], ["live_url", live_url]] as const) {
          try {
            await resolveVendorUrl(url, o.opts ?? {});
          } catch (e) {
            if (e instanceof OutboundRefused) return fail(`${name}: ${e.message}`);
            throw e;
          }
        }
        const row = await sourceRow(store, entity_id);
        const changed = !row || norm(row.test_url ?? "") !== norm(test_url) || norm(row.live_url ?? "") !== norm(live_url);
        const backToSandbox = !!row && changed && row.active_source === "http";
        await store.db.query(
          `INSERT INTO ${T}.partner_ledger_sources (entity_id, test_url, live_url, signing_secret, configured_by, configured_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (entity_id) DO UPDATE SET test_url = EXCLUDED.test_url, live_url = EXCLUDED.live_url,
             signing_secret = COALESCE(${T}.partner_ledger_sources.signing_secret, EXCLUDED.signing_secret),
             config_version = ${T}.partner_ledger_sources.config_version + CASE WHEN $6 THEN 1 ELSE 0 END,
             active_source = CASE WHEN $7 THEN 'sandbox' ELSE ${T}.partner_ledger_sources.active_source END,
             active_run_id = CASE WHEN $7 THEN NULL ELSE ${T}.partner_ledger_sources.active_run_id END,
             configured_by = EXCLUDED.configured_by, configured_at = now(), updated_at = now()`,
          [entity_id, test_url, live_url, seal(newSecret(), false), user.id, changed, backToSandbox],
        );
        await store.audit(user.id, "configure_partner_ledger", entity_id, { test_url, live_url, changed, back_to_sandbox: backToSandbox });
        const cur = (await sourceRow(store, entity_id))!;
        return json({
          entity_id,
          test_url,
          live_url,
          config_version: cur.config_version,
          ledger_source: cur.active_source,
          ...(backToSandbox ? { note: "The endpoints changed, so the firm is back on the sandbox until it passes run_partner_conformance again" } : {}),
          request_secret: cur.secret_shown_at ? "already taken by the firm" : "issued: the firm's licence provider takes it once with reveal_partner_ledger_secret",
        });
      },
    );
  }

  if (o.admin || member)
    server.registerTool(
      "set_partner_ledger_source",
      {
        title: "Switch your ledger source",
        description:
          "Licence provider: read your firm's ledger from http (your live endpoint) or file (your daily uploads) instead of the sandbox, or go back to sandbox. Refused until that source's latest run_partner_conformance passed its ledger part; switching to http also reads your live endpoint once and checks the statement (the figures are discarded), and switching to file needs a fresh live daily file. Admins can only send a firm back to sandbox. Audited.",
        inputSchema: { source: z.enum(LEDGER_SOURCES), entity_id: z.string().uuid().optional().describe("Admin: the firm to send back to sandbox") },
      },
      async ({ source, entity_id }) => {
        if (o.admin && source !== "sandbox") return fail("Only the firm's own licence provider can switch it to a live source; an admin can only send it back to sandbox");
        const firm = await firmFor(entity_id);
        if (typeof firm !== "string") return fail(firm.error);
        const set = async (runId: string | null) => {
          await store.db.query(
            `INSERT INTO ${T}.partner_ledger_sources (entity_id, active_source, active_run_id, activated_by, activated_at) VALUES ($1, $2, $3, $4, now())
             ON CONFLICT (entity_id) DO UPDATE SET active_source = EXCLUDED.active_source, active_run_id = EXCLUDED.active_run_id, activated_by = EXCLUDED.activated_by, activated_at = now(), updated_at = now()`,
            [firm, source, runId, user.id],
          );
          await store.audit(user.id, "set_partner_ledger_source", firm, { source, run_id: runId });
        };
        if (source === "sandbox") {
          await set(null);
          return json({ entity_id: firm, ledger_source: "sandbox", live: false });
        }
        const run = await latestRun(store, firm, source);
        const row = await sourceRow(store, firm);
        const refuse = async (reason: string, extra: Record<string, unknown> = {}) => {
          await store.audit(user.id, "set_partner_ledger_source_refused", firm, { source, reason });
          return fail(reason, extra);
        };
        if (!run || !run.ledger_passed) return refuse(`Your latest ${source} conformance hasn't passed its ledger part: run_partner_conformance { source: "${source}" } until it does`);
        if (source === "http") {
          if (!row?.live_url || run.config_version !== row.config_version) return refuse("Your endpoints changed after your last conformance run: run it again");
          // One read of the live endpoint, checked like any other; the figures are thrown away.
          const products = await sponsoredProducts(store, firm);
          const { request, result } = await requestLedger({ base_url: row.live_url, secret: secretOf(row)!, environment: "live", entity_id: firm, product_ids: products, period_end: now().toISOString() }, o.opts);
          if (!result.ok) return refuse(`Your live endpoint didn't answer with a statement (${transportCode(result)})`);
          const check = checkStatement(result.body, { entity_id: firm, environment: "live", request_id: request.request_id, public_key: await o.signingKeyOf(firm), now: now(), max_age_ms: httpMaxAgeMs(), product_ids: products });
          if (!check.ok || check.missing.length) return refuse("Your live endpoint's statement didn't pass Mynt's checks", { cases: check.cases });
        } else {
          const u = await latestUpload(store, firm, "live");
          if (!u || now().getTime() - new Date(u.as_of as string).getTime() > fileMaxAgeMs()) return refuse("Upload today's live daily file first (upload_partner_ledger_file with environment live)");
        }
        await set(run.id);
        return json({ entity_id: firm, ledger_source: source, live: true, conformance_run_id: run.id, conformance_at: iso(run.created_at), note: "Your next product-health snapshots read this source" });
      },
    );

  if (!member) return;

  server.registerTool(
    "reveal_partner_ledger_secret",
    {
      title: "Take your ledger request-signing secret",
      description:
        "Licence provider: the secret Mynt signs its ledger requests with (Mynt-Signature, HMAC-SHA256), shown once. Your endpoint verifies every request with it and refuses anything else with 401. Lost it? rotate_partner_ledger_secret.",
      inputSchema: {},
    },
    async () => {
      const firm = await myFirm();
      const row = firm ? await sourceRow(store, firm) : null;
      if (!row?.signing_secret) return fail("No secret yet: an admin sets your endpoints first (configure_partner_ledger)");
      const { rows } = await store.db.query(`UPDATE ${T}.partner_ledger_sources SET secret_shown_at = now() WHERE entity_id = $1 AND secret_shown_at IS NULL RETURNING entity_id`, [firm]);
      if (!rows.length) return fail("It was already shown once: rotate_partner_ledger_secret issues a new one");
      await store.audit(user.id, "reveal_partner_ledger_secret", firm!, {});
      return json({ secret: open(row.signing_secret, false), note: "Shown once. Keep it in your secrets store, never in code." });
    },
  );

  server.registerTool(
    "rotate_partner_ledger_secret",
    {
      title: "Replace your ledger request-signing secret",
      description: "Licence provider: issue a new request-signing secret, shown once. The old one stops being used at once, so update your endpoint first-thing.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    async () => {
      const firm = await myFirm();
      const row = firm ? await sourceRow(store, firm) : null;
      if (!row?.test_url) return fail("No endpoints yet: an admin sets them first (configure_partner_ledger)");
      const secret = newSecret();
      await store.db.query(`UPDATE ${T}.partner_ledger_sources SET signing_secret = $2, secret_shown_at = now(), updated_at = now() WHERE entity_id = $1`, [firm, seal(secret, false)]);
      await store.audit(user.id, "rotate_partner_ledger_secret", firm!, {});
      return json({ secret, note: "Shown once. Mynt signs with it from now on." });
    },
  );

  server.registerTool(
    "upload_partner_ledger_file",
    {
      title: "Upload your signed daily ledger file",
      description:
        "Licence provider, for a firm without an API: upload today's statement (schemas/partner-ledger/statement.v1.schema.json, request_id null), signed with your registered Ed25519 key. Mynt checks the schema, the signature, that as_of isn't in the future or older than the maximum age, and that it's newer than your last file; the result says which sponsored products it leaves out. It's stored sealed: admins never see the figures. A live file is your ledger once you've switched to source file.",
      inputSchema: { statement: z.record(z.string(), z.unknown()).describe("The signed statement, as JSON") },
    },
    async ({ statement }) => {
      const firm = await myFirm();
      if (!firm) return fail("You don't belong to a firm yet");
      if (!vaultAvailable(false)) return fail("The partner kit needs MYNT_VAULT_KEY set on the server");
      const products = await sponsoredProducts(store, firm);
      const environment = statement.environment === "test" ? "test" : "live";
      const check = checkStatement(statement, { entity_id: firm, environment, request_id: null, public_key: await o.signingKeyOf(firm), now: now(), max_age_ms: fileMaxAgeMs(), product_ids: products });
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
