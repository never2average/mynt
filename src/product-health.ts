import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { defaultLedgerFor, isLedgerError, type PartnerLedger, type PartnerLedgerReading } from "./partner-ledger/index.js";
import type { Db } from "./db.js";
import { base58Decode, isAddress, isOnCurve, Keypair } from "./solana/codec.js";
import { decodeHead, headAddress, healthIx, KIND_MISSED, KIND_SNAPSHOT, nextChain, subjectKey, ZERO_32, type HeadAccount, type MissedEntry, type SnapshotEntry } from "./solana/product-health-chain.js";
import { verifyEd25519 } from "./solana/signer.js";
import type { SolanaService } from "./solana/service.js";
import { effectiveRoles, type Store, type User } from "./store.js";
import { open as openSealed, seal, vaultAvailable } from "./vault.js";
import { serialLoop } from "./worker.js";

// Each product's financial health, on the record: reserves against what customers are owed, what flowed, what's
// pending, what failed. Licence providers and liquidity providers read it to pull a licence or move capital, so:
//
//   - the partner's numbers come from the partner's own ledger, never the developer's app;
//   - each snapshot is encoded canonically and its sha256 goes on chain, so nobody (Mynt included) can change a
//     report afterwards without it showing; a random salt inside keeps the numbers from being guessed from it;
//   - the report is encrypted per product and opened only for entitled readers, through get_product_health;
//   - a figure Mynt can't measure is null with a reason, never 0; money is integer cents, ratios integer basis points;
//   - a live product's snapshot counts as verified only when the partner co-signs its fingerprint.
//
// Mynt never holds funds and no customer data goes on chain; this module only reports.

const T = "financial_products";
export const SCHEMA = "mynt.product_health.v1";
const TABLES = `
  -- Each licence provider firm's key for co-signing snapshots.
  CREATE TABLE IF NOT EXISTS ${T}.product_health_signing_keys (
    entity_id uuid PRIMARY KEY,
    public_key text NOT NULL,
    registered_by uuid,
    registered_at timestamptz NOT NULL DEFAULT now()
  );
  -- Per product (or pool): the data key its reports are encrypted with, sealed under MYNT_VAULT_KEY.
  CREATE TABLE IF NOT EXISTS ${T}.product_health_keys (
    subject text PRIMARY KEY,
    sealed_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ${T}.product_health_snapshots (
    id uuid PRIMARY KEY,
    subject text NOT NULL,
    product_id text NOT NULL,
    pool_id text NOT NULL DEFAULT '',
    sequence integer NOT NULL,
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('pending_signature', 'ready', 'published', 'missed')),
    source text NOT NULL,
    live boolean NOT NULL DEFAULT false,
    partner_entity_id uuid,
    fingerprint text,
    report_sealed text,
    attestation text,
    partner_key text,
    partner_signature text,
    sign_deadline timestamptz,
    publish_deadline timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    missed_reason text,
    last_error text,
    on_chain boolean NOT NULL DEFAULT false,
    tx_signature text,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (subject, sequence),
    UNIQUE (subject, period_start)
  );
  CREATE INDEX IF NOT EXISTS product_health_status_idx ON ${T}.product_health_snapshots (status, subject, sequence);
`;

// ---- canonical encoding ----

// JSON with sorted keys and no spaces, so the same report always has the same bytes and so the same fingerprint.
// Only what encodes one way is allowed: integers, strings, booleans, null, arrays, objects. No floats, ever.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Canonical JSON allows only safe integers, got ${value}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => {
        if (obj[k] === undefined) throw new Error(`Canonical JSON has no 'undefined' (${k})`);
        return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
      })
      .join(",")}}`;
  }
  throw new Error(`Canonical JSON can't encode ${typeof value}`);
}

export const fingerprintOf = (canonical: string) => createHash("sha256").update(canonical, "utf8").digest("hex");

// ---- figures: a value, or null with a reason, never 0 for "unknown" ----

export interface Figure {
  value: number | null;
  reason: string | null;
}
export const measured = (value: number): Figure => ({ value, reason: null });
export const unmeasured = (reason: string): Figure => ({ value: null, reason });

export const FIGURE_NAMES = [
  "reserves_cents",
  "obligations_cents",
  "coverage_bps",
  "flows_in_cents",
  "flows_out_cents",
  "pending_settlements_cents",
  "reversal_rate_bps",
  "failure_rate_bps",
  "open_withdrawal_requests",
  "open_complaints",
  "open_incidents",
] as const;
export type Figures = Record<(typeof FIGURE_NAMES)[number], Figure>;

// What the money rails (src/money-rails.ts) report for a product and period: totals in integer cents by direction
// and status, or null when it can't say. Injected so the two features ship in either order.
export interface FlowBuckets {
  settled: number | null;
  pending: number | null;
  failed: number | null;
  reversed: number | null;
}
export interface NormalizedFlows {
  in: FlowBuckets;
  out: FlowBuckets;
}
export type FlowsFor = (productId: string, from: Date, to: Date) => Promise<unknown>;

const cents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const bucket = (s: Record<string, unknown> | undefined): FlowBuckets => ({
  settled: cents(s?.settled ?? s?.completed),
  pending: cents(s?.pending ?? s?.in_flight),
  failed: cents(s?.failed),
  reversed: cents(s?.reversed ?? s?.returned ?? s?.reversal),
});

// Accepts { in: {settled, ...}, out: {...} } (or inbound/outbound); anything else is unmeasurable, never zeros.
export function normalizeFlows(raw: unknown): NormalizedFlows | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, Record<string, unknown> | undefined>;
  const incoming = o.in ?? o.inbound;
  const outgoing = o.out ?? o.outbound;
  if ((incoming === undefined && outgoing === undefined) || typeof (incoming ?? outgoing) !== "object") return null;
  return { in: bucket(incoming), out: bucket(outgoing) };
}

const FLOWS_UNAVAILABLE = "The money rails can't report flows for this period yet";

function basisPoints(numerator: number, denominator: number): Figure {
  const bps = (BigInt(numerator) * 10_000n) / BigInt(denominator);
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? unmeasured("The ratio is too large to represent") : measured(Number(bps));
}

const sumOrNull = (...xs: (number | null)[]) => {
  if (xs.some((x) => x === null)) return null;
  const n = (xs as number[]).reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(n) ? n : null;
};

// The figures of one snapshot. Everything null carries the reason it couldn't be measured.
export function buildFigures(i: {
  reading: PartnerLedgerReading | { error: { code: string; message: string } } | null;
  flows: NormalizedFlows | null;
  complaints?: number | null;
  incidents?: number | null;
}): Figures {
  const ledgerFailed = !i.reading || isLedgerError(i.reading) ? `The partner's ledger couldn't be read${isLedgerError(i.reading) ? ` (${i.reading.error.code})` : ""}` : null;
  const reading = !i.reading || isLedgerError(i.reading) ? null : i.reading;
  const held = cents(reading?.reserves_held_cents);
  const owed = cents(reading?.customer_obligations_cents);
  const reservesFig = held !== null ? measured(held) : unmeasured(ledgerFailed ?? reading?.reason ?? "The partner's ledger didn't give reserves as integer cents");
  const obligationsFig = owed !== null ? measured(owed) : unmeasured(ledgerFailed ?? reading?.reason ?? "The partner's ledger didn't give obligations as integer cents");

  let coverage: Figure;
  if (held === null || owed === null) coverage = unmeasured("Coverage needs both reserves and obligations from the partner's ledger");
  else if (owed === 0) coverage = unmeasured("No customer obligations: coverage is undefined, not infinite");
  else coverage = basisPoints(held, owed);

  const f = i.flows;
  const net = (v: number | null, label: string): Figure => (v !== null ? measured(v) : unmeasured(f ? `The money rails gave no ${label} total` : FLOWS_UNAVAILABLE));
  const flowsIn = net(f?.in.settled ?? null, "settled inflow");
  const flowsOut = net(f?.out.settled ?? null, "settled outflow");
  const pending = net(f ? sumOrNull(f.in.pending, f.out.pending) : null, "pending");

  const rate = (top: (b: FlowBuckets) => number | null, parts: ((b: FlowBuckets) => number | null)[], what: string): Figure => {
    if (!f) return unmeasured(FLOWS_UNAVAILABLE);
    const numerator = sumOrNull(top(f.in), top(f.out));
    const denominator = sumOrNull(...parts.flatMap((p) => [p(f.in), p(f.out)]));
    if (numerator === null || denominator === null) return unmeasured(`The money rails gave no ${what} totals`);
    if (denominator === 0) return unmeasured(`No flows completed in this period, so there's no ${what} rate`);
    return basisPoints(numerator, denominator);
  };
  const reversals = rate((b) => b.reversed, [(b) => b.settled, (b) => b.reversed], "reversal");
  const failures = rate((b) => b.failed, [(b) => b.settled, (b) => b.reversed, (b) => b.failed], "failure");

  return {
    reserves_cents: reservesFig,
    obligations_cents: obligationsFig,
    coverage_bps: coverage,
    flows_in_cents: flowsIn,
    flows_out_cents: flowsOut,
    pending_settlements_cents: pending,
    reversal_rate_bps: reversals,
    failure_rate_bps: failures,
    open_withdrawal_requests: unmeasured("Withdrawal requests aren't a feature of Mynt yet"),
    open_complaints: typeof i.complaints === "number" ? measured(i.complaints) : unmeasured("Complaints aren't tracked on Mynt yet"),
    open_incidents: typeof i.incidents === "number" ? measured(i.incidents) : unmeasured("Incidents aren't tracked on Mynt yet"),
  };
}

export interface HealthReport {
  schema: string;
  product_id: string;
  pool_id: string | null;
  sequence: number;
  period_start: string;
  period_end: string;
  computed_at: string;
  salt: string; // random: the fingerprint of a report can't be guessed from its numbers
  source: "sandbox" | "partner_ledger" | "unavailable";
  live: boolean;
  partner: { entity_id: string; ledger: string; ledger_name: string };
  ledger_as_of: string | null;
  figures: Figures;
  notes: string[];
}

// ---- encryption ----

// Per product: a random AES-256-GCM key, sealed under MYNT_VAULT_KEY, encrypts its reports. The sealed report is
// bound to its subject, sequence and fingerprint, so a stored report can't be moved to another row or edited.
const aad = (subject: string, sequence: number, fingerprint: string) => Buffer.from(`${subject}|${sequence}|${fingerprint}`, "utf8");

export function sealReport(key: Buffer, plaintext: string, subject: string, sequence: number, fingerprint: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(subject, sequence, fingerprint));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function openReport(key: Buffer, sealed: string, subject: string, sequence: number, fingerprint: string): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unknown report format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(aad(subject, sequence, fingerprint));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// ---- the record ----

export type SnapshotStatus = "pending_signature" | "ready" | "published" | "missed";
export interface SnapshotRow {
  id: string;
  subject: string;
  product_id: string;
  pool_id: string;
  sequence: number;
  period_start: string;
  period_end: string;
  status: SnapshotStatus;
  source: string;
  live: boolean;
  partner_entity_id: string | null;
  fingerprint: string | null;
  report_sealed: string | null;
  attestation: string | null;
  partner_key: string | null;
  partner_signature: string | null;
  sign_deadline: string | null;
  publish_deadline: string | null;
  attempts: number;
  next_attempt_at: string | null;
  missed_reason: string | null;
  last_error: string | null;
  on_chain: boolean;
  tx_signature: string | null;
  published_at: string | null;
  created_at: string;
}

export interface Gap {
  kind: "missed" | "sequence_gap" | "period_gap" | "overdue" | "chain_behind" | "chain_ahead";
  sequence?: number;
  from?: string;
  to?: string;
  detail: string;
}

const iso = (t: string | Date) => new Date(t).toISOString();

// Where the record has a hole, for a monitor. Pure, from the rows (oldest first) and the chain's head.
export function findGaps(rows: Pick<SnapshotRow, "sequence" | "period_start" | "period_end" | "status" | "missed_reason" | "on_chain">[], head: HeadAccount | null, now: Date, intervalMs: number): Gap[] {
  const gaps: Gap[] = [];
  for (const [i, r] of rows.entries()) {
    if (r.status === "missed") gaps.push({ kind: "missed", sequence: r.sequence, from: iso(r.period_start), to: iso(r.period_end), detail: r.missed_reason ?? "No snapshot for this period" });
    const prev = rows[i - 1];
    if (prev && r.sequence !== prev.sequence + 1) gaps.push({ kind: "sequence_gap", sequence: r.sequence, detail: `Sequence jumps from ${prev.sequence} to ${r.sequence}` });
    if (prev && new Date(r.period_start).getTime() > new Date(prev.period_end).getTime())
      gaps.push({ kind: "period_gap", sequence: r.sequence, from: iso(prev.period_end), to: iso(r.period_start), detail: "No record covers this time" });
  }
  const last = rows[rows.length - 1];
  if (last && new Date(last.period_end).getTime() + 2 * intervalMs < now.getTime()) gaps.push({ kind: "overdue", from: iso(last.period_end), detail: "No snapshot has been recorded since" });
  const lastOnChain = [...rows].reverse().find((r) => r.on_chain)?.sequence ?? 0;
  if (head) {
    if (head.sequence < lastOnChain) gaps.push({ kind: "chain_behind", detail: `Mynt recorded sequence ${lastOnChain} as on chain, but the chain's head is at ${head.sequence}` });
    if (head.sequence > lastOnChain) gaps.push({ kind: "chain_ahead", detail: `The chain's head is at sequence ${head.sequence}, past Mynt's own record (${lastOnChain})` });
  }
  return gaps;
}

// What the record says about a snapshot, for anyone allowed to see that it exists: no figures.
export function snapshotStatus(r: SnapshotRow) {
  const source = r.source;
  // A sandbox figure can never read as live, whatever a row says.
  const live = r.live === true && source === "partner_ledger";
  const verified = live && r.attestation === "partner_signed";
  const notes: string[] = [];
  if (source === "sandbox") notes.push("Sandbox figures: test numbers, never a live product's health.");
  if (source === "unavailable") notes.push("The partner's ledger couldn't be read for this period.");
  if (r.status !== "missed" && r.attestation === "mynt_only") notes.push("Published without the licence provider's co-signature: Mynt alone attests this snapshot, so it isn't verified.");
  if (r.status === "pending_signature") notes.push("Waiting for the licence provider's co-signature.");
  if (r.status === "missed") notes.push(r.missed_reason ?? "No snapshot for this period.");
  return {
    product_id: r.product_id,
    pool_id: r.pool_id || null,
    sequence: r.sequence,
    period_start: iso(r.period_start),
    period_end: iso(r.period_end),
    status: r.status,
    source,
    live,
    attestation: r.attestation,
    verified,
    fingerprint: r.fingerprint,
    on_chain: r.on_chain,
    tx_signature: r.tx_signature,
    published_at: r.published_at ? iso(r.published_at) : null,
    notes,
  };
}

export interface ProductHealthConfig {
  intervalMs: number;
  cosignWindowMs: number; // how long a snapshot waits for the partner's co-signature before it's published mynt_only
  pollMs: number;
  programId: string | null; // the deployed product-health program; none, and the worker doesn't run
}

export function productHealthConfigFromEnv(env = process.env): ProductHealthConfig {
  const minutes = Number(env.PRODUCT_HEALTH_INTERVAL_MINUTES);
  const intervalMs = (env.PRODUCT_HEALTH_INTERVAL_MINUTES && minutes >= 1 ? Math.floor(minutes) : 60) * 60_000;
  const window = Number(env.PRODUCT_HEALTH_COSIGN_WINDOW_MINUTES);
  const cosignWindowMs = Math.min(env.PRODUCT_HEALTH_COSIGN_WINDOW_MINUTES && window >= 0 ? window * 60_000 : intervalMs / 2, intervalMs / 2);
  const programId = env.PRODUCT_HEALTH_PROGRAM_ID || null;
  return { intervalMs, cosignWindowMs, pollMs: Number(env.PRODUCT_HEALTH_POLL_MS ?? 60_000), programId: programId && isAddress(programId) ? programId : null };
}

export interface HealthChain {
  readonly programId: string;
  readonly publisher: string;
  head(subject: Uint8Array): Promise<HeadAccount | null>;
  publishSnapshot(subject: Uint8Array, entry: SnapshotEntry, opening: boolean): Promise<string>;
  publishMissed(subject: Uint8Array, entry: MissedEntry, opening: boolean): Promise<string>;
}

export interface ProductHealthDeps {
  chain?: HealthChain | null;
  flowsFor?: FlowsFor | null;
  ledgerFor?: (entityId: string) => PartnerLedger;
  liquidityProvidersOf?: (productId: string) => Promise<string[]>; // firms entitled alongside the licence provider
  poolsOf?: (productId: string) => Promise<string[]>; // none until pools exist
  now?: () => Date;
}

export class HealthError extends Error {}

const unix = (t: string | Date) => Math.floor(new Date(t).getTime() / 1000);
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

const ERROR_LIMIT = 300;

export class ProductHealthService {
  private timer: NodeJS.Timeout | null = null;
  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly config: ProductHealthConfig,
    private readonly deps: ProductHealthDeps,
  ) {}

  static async open(db: Db, store: Store, config: ProductHealthConfig = productHealthConfigFromEnv(), deps: ProductHealthDeps = {}) {
    await db.exec(TABLES);
    return new ProductHealthService(db, store, config, deps);
  }

  get chain() {
    return this.deps.chain ?? null;
  }
  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  // ---- keys ----

  private async dataKey(subject: string): Promise<Buffer> {
    const read = async () => (await this.db.query(`SELECT sealed_key FROM ${T}.product_health_keys WHERE subject = $1`, [subject])).rows[0] as { sealed_key: string } | undefined;
    let row = await read();
    if (!row) {
      await this.db.query(`INSERT INTO ${T}.product_health_keys (subject, sealed_key) VALUES ($1, $2) ON CONFLICT (subject) DO NOTHING`, [subject, seal(randomBytes(32).toString("base64"), false)]);
      row = await read(); // two at once: whichever was stored first is the key
    }
    return Buffer.from(openSealed(row!.sealed_key, false), "base64");
  }

  async signingKey(entityId: string): Promise<string | null> {
    const { rows } = await this.db.query(`SELECT public_key FROM ${T}.product_health_signing_keys WHERE entity_id = $1`, [entityId]);
    return (rows[0] as { public_key: string } | undefined)?.public_key ?? null;
  }

  // ---- entitlement ----

  // The firms that may read a product's numbers: its approved licence providers now; its liquidity providers when
  // they exist. The list is computed each time, so withdrawing a sponsorship ends access at once.
  async entitledFirms(productId: string): Promise<{ entity_id: string; as: "licence_provider" | "liquidity_provider" }[]> {
    const sponsors = await this.store.sponsorships({ product_id: productId, status: "approved" });
    const lps = this.deps.liquidityProvidersOf ? await this.deps.liquidityProvidersOf(productId) : [];
    const firms: { entity_id: string; as: "licence_provider" | "liquidity_provider" }[] = [...new Set(sponsors.map((s) => s.provider_entity_id))].map((entity_id) => ({ entity_id, as: "licence_provider" }));
    for (const entity_id of lps) if (!firms.some((f) => f.entity_id === entity_id)) firms.push({ entity_id, as: "liquidity_provider" });
    return firms;
  }

  async entitlement(user: User, productId: string): Promise<{ entity_id: string; as: string } | null> {
    const me = (await this.store.getUser(user.id)) ?? user;
    if (!me.entity_id) return null;
    const firms = await this.entitledFirms(productId);
    const hit = firms.find((f) => f.entity_id === me.entity_id);
    if (!hit) return null;
    if (hit.as === "licence_provider" && !effectiveRoles(me.roles).includes("license_provider")) return null;
    return hit;
  }

  // ---- computing a snapshot ----

  private async subjects(): Promise<{ productId: string; poolId: string | null; subject: string; partner: string; live: boolean }[]> {
    const sponsored = await this.store.sponsorships({ status: "approved" });
    const byProduct = new Map<string, typeof sponsored>();
    for (const s of sponsored) byProduct.set(s.product_id, [...(byProduct.get(s.product_id) ?? []), s]);
    const out: Awaited<ReturnType<ProductHealthService["subjects"]>> = [];
    for (const [productId, list] of byProduct) {
      const record = await this.store.getProduct(productId);
      if (!record || record.status === "unpublished") continue;
      // The earliest-approved licence provider's books and key, when more than one sponsors a product.
      const partner = [...list].sort((a, b) => new Date(a.decided_at ?? 0).getTime() - new Date(b.decided_at ?? 0).getTime() || a.id.localeCompare(b.id))[0].provider_entity_id;
      const pools = this.deps.poolsOf ? await this.deps.poolsOf(productId) : [];
      for (const poolId of [null, ...pools]) out.push({ productId, poolId, subject: Buffer.from(subjectKey(productId, poolId)).toString("hex"), partner, live: record.status === "published" });
    }
    return out;
  }

  private async lastRow(subject: string): Promise<SnapshotRow | undefined> {
    const { rows } = await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE subject = $1 ORDER BY sequence DESC LIMIT 1`, [subject]);
    return rows[0] as unknown as SnapshotRow | undefined;
  }

  private async insertMissed(s: { productId: string; poolId: string | null; subject: string; partner: string }, start: Date, end: Date, reason: string, sequence: number) {
    await this.db.query(
      `INSERT INTO ${T}.product_health_snapshots (id, subject, product_id, pool_id, sequence, period_start, period_end, status, source, partner_entity_id, missed_reason, publish_deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'missed', 'unavailable', $8, $9, $10) ON CONFLICT DO NOTHING`,
      [randomUUID(), s.subject, s.productId, s.poolId ?? "", sequence, start, end, s.partner, reason, end],
    );
  }

  // Builds one snapshot for a period, sealed and ready to go. Never throws for a figure it can't get.
  private async compute(s: { productId: string; poolId: string | null; subject: string; partner: string; live: boolean }, start: Date, end: Date, sequence: number) {
    const ledger = (this.deps.ledgerFor ?? defaultLedgerFor)(s.partner);
    const reading = await ledger
      .read({ product_id: s.productId, pool_id: s.poolId, provider_entity_id: s.partner, period_end: end.toISOString(), now: () => this.now() })
      .catch(() => ({ error: { code: "ledger_error", message: "The ledger call failed" } }));
    const raw = this.deps.flowsFor ? await this.deps.flowsFor(s.productId, start, end).catch(() => null) : null;
    const figures = buildFigures({ reading, flows: normalizeFlows(raw) });
    const failed = isLedgerError(reading);
    const source: HealthReport["source"] = failed ? "unavailable" : ledger.kind === "sandbox" ? "sandbox" : "partner_ledger";
    const report: HealthReport = {
      schema: SCHEMA,
      product_id: s.productId,
      pool_id: s.poolId,
      sequence,
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      computed_at: this.now().toISOString(),
      salt: randomBytes(32).toString("hex"),
      source,
      // Sandbox figures are never live, whatever the product's status.
      live: s.live && source === "partner_ledger",
      partner: { entity_id: s.partner, ledger: ledger.id, ledger_name: ledger.name },
      ledger_as_of: failed ? null : (reading as PartnerLedgerReading).as_of,
      figures,
      notes: source === "sandbox" ? ["Sandbox ledger: test figures, not real money."] : [],
    };
    const canonical = canonicalJson(report);
    const fingerprint = fingerprintOf(canonical);
    const sealed = sealReport(await this.dataKey(s.subject), canonical, s.subject, sequence, fingerprint);
    return { report, fingerprint, sealed };
  }

  // Brings one product's record up to the last complete period. A stretch Mynt didn't cover is one missed record.
  private async advance(s: Awaited<ReturnType<ProductHealthService["subjects"]>>[number], now: Date) {
    const interval = this.config.intervalMs;
    const lastEnd = new Date(Math.floor(now.getTime() / interval) * interval);
    const periodStart = new Date(lastEnd.getTime() - interval);
    const last = await this.lastRow(s.subject);
    if (last && new Date(last.period_end).getTime() >= lastEnd.getTime()) return;
    let sequence = (last?.sequence ?? 0) + 1;
    if (last && new Date(last.period_end).getTime() < periodStart.getTime()) {
      await this.insertMissed(s, new Date(last.period_end), periodStart, "Mynt computed no snapshot for this period", sequence);
      sequence++;
    }
    let result: Awaited<ReturnType<ProductHealthService["compute"]>>;
    try {
      result = await this.compute(s, periodStart, lastEnd, sequence);
    } catch (e) {
      await this.insertMissed(s, periodStart, lastEnd, `The snapshot couldn't be computed: ${(e as Error).message.slice(0, ERROR_LIMIT)}`, sequence);
      return;
    }
    const key = await this.signingKey(s.partner);
    const signDeadline = key ? new Date(now.getTime() + this.config.cosignWindowMs) : null;
    const publishDeadline = new Date(lastEnd.getTime() + interval);
    await this.db.query(
      `INSERT INTO ${T}.product_health_snapshots
        (id, subject, product_id, pool_id, sequence, period_start, period_end, status, source, live, partner_entity_id, fingerprint, report_sealed, attestation, sign_deadline, publish_deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'mynt_only', $14, $15) ON CONFLICT DO NOTHING`,
      [randomUUID(), s.subject, s.productId, s.poolId ?? "", sequence, periodStart, lastEnd, key ? "pending_signature" : "ready", result.report.source, result.report.live, s.partner, result.fingerprint, result.sealed, signDeadline, publishDeadline],
    );
  }

  // ---- publishing ----

  private entry(r: SnapshotRow): SnapshotEntry {
    return {
      sequence: r.sequence,
      fingerprint: hexToBytes(r.fingerprint!),
      period_start: unix(r.period_start),
      period_end: unix(r.period_end),
      source: r.source as SnapshotEntry["source"],
      partner_key: r.partner_key ? base58Decode(r.partner_key) : null,
      partner_signature: r.partner_signature ? hexToBytes(r.partner_signature) : null,
    };
  }

  private async failPublish(r: SnapshotRow, e: unknown, now: Date) {
    const error = (e as Error).message.slice(0, ERROR_LIMIT);
    const wait = Math.min(this.config.intervalMs, 30_000 * 2 ** Math.min(r.attempts, 8));
    await this.db.query(`UPDATE ${T}.product_health_snapshots SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3 WHERE id = $1`, [r.id, error, new Date(now.getTime() + wait)]);
  }

  // One row on chain. Returns whether the next row of this product may go.
  private async publishRow(r: SnapshotRow, now: Date): Promise<boolean> {
    const chain = this.chain;
    if (!chain) return false;
    if (r.next_attempt_at && new Date(r.next_attempt_at) > now) return false;
    const subject = hexToBytes(r.subject);
    const missed = r.status === "missed";
    const kind = missed ? KIND_MISSED : KIND_SNAPSHOT;
    const fingerprint = missed ? ZERO_32 : hexToBytes(r.fingerprint!);
    try {
      const head = await chain.head(subject);
      const at = head?.sequence ?? 0;
      if (at >= r.sequence) {
        // Already there (a confirmation Mynt never saw): take it as done, if it's this record.
        if (at === r.sequence && Buffer.from(head!.fingerprint).equals(Buffer.from(fingerprint)) && head!.kind === kind) {
          await this.db.query(`UPDATE ${T}.product_health_snapshots SET status = CASE WHEN status = 'ready' THEN 'published' ELSE status END, on_chain = true, published_at = $2, last_error = NULL WHERE id = $1`, [r.id, now]);
          return true;
        }
        await this.db.query(`UPDATE ${T}.product_health_snapshots SET status = 'missed', missed_reason = $2 WHERE id = $1`, [r.id, `The chain's head is at sequence ${at} and doesn't match this record`]);
        return false;
      }
      if (at !== r.sequence - 1) throw new HealthError(`The chain's head is at sequence ${at}, not the one before ${r.sequence}`);
      const opening = head === null;
      const tx = missed
        ? await chain.publishMissed(subject, { sequence: r.sequence, period_start: unix(r.period_start), period_end: unix(r.period_end), reason: 0 }, opening)
        : await chain.publishSnapshot(subject, this.entry(r), opening);
      await this.db.query(
        `UPDATE ${T}.product_health_snapshots SET status = CASE WHEN status = 'ready' THEN 'published' ELSE status END, on_chain = true, tx_signature = $2, published_at = $3, last_error = NULL WHERE id = $1`,
        [r.id, tx, now],
      );
      return true;
    } catch (e) {
      await this.failPublish(r, e, now);
      return false;
    }
  }

  private async publishDue(now: Date) {
    if (!this.chain) return;
    const { rows } = await this.db.query(
      `SELECT * FROM ${T}.product_health_snapshots WHERE status IN ('pending_signature', 'ready') OR (status = 'missed' AND NOT on_chain) ORDER BY subject, sequence`,
    );
    const bySubject = new Map<string, SnapshotRow[]>();
    for (const r of rows as unknown as SnapshotRow[]) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r]);
    for (const list of bySubject.values()) {
      for (let r of list) {
        if (r.status === "pending_signature") {
          if (new Date(r.sign_deadline!) > now) break;
          await this.db.query(`UPDATE ${T}.product_health_snapshots SET status = 'ready' WHERE id = $1 AND status = 'pending_signature'`, [r.id]);
          r = { ...r, status: "ready" };
        }
        // Past its deadline, a snapshot still not on chain is recorded as missed; the chain gets a marker in its place.
        if (r.status === "ready" && r.publish_deadline && new Date(r.publish_deadline) <= now) {
          const reason = `Couldn't publish before the deadline: ${r.last_error ?? "the chain wasn't reachable"}`;
          await this.db.query(`UPDATE ${T}.product_health_snapshots SET status = 'missed', missed_reason = $2 WHERE id = $1`, [r.id, reason.slice(0, ERROR_LIMIT)]);
          r = { ...r, status: "missed", missed_reason: reason };
        }
        if (!(await this.publishRow(r, now))) break;
      }
    }
  }

  // One round: bring every product's record up to date, then send what's due. Safe to run at any time.
  async tick() {
    const now = this.now();
    if (!vaultAvailable(false)) return;
    for (const s of await this.subjects()) await this.advance(s, now).catch((e) => console.error("product health:", s.productId, (e as Error).message));
    await this.publishDue(now);
  }

  startWorker() {
    if (!this.config.programId || !this.chain) {
      console.error("product health: not running (set PRODUCT_HEALTH_PROGRAM_ID to the deployed program, and keep MYNT_VAULT_KEY set)");
      return;
    }
    this.timer = serialLoop(() => this.tick(), this.config.pollMs, "product health");
  }
  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- co-signing ----

  async registerSigningKey(user: User, publicKey: string) {
    const me = (await this.store.getUser(user.id)) ?? user;
    if (!me.entity_id) throw new HealthError("You don't belong to a firm yet");
    if (!effectiveRoles(me.roles).includes("license_provider")) throw new HealthError("Only a licence provider firm registers a signing key");
    if (!isAddress(publicKey) || !isOnCurve(base58Decode(publicKey))) throw new HealthError("public_key must be an Ed25519 public key, base58 (a Solana-style address)");
    await this.db.query(
      `INSERT INTO ${T}.product_health_signing_keys (entity_id, public_key, registered_by) VALUES ($1, $2, $3)
       ON CONFLICT (entity_id) DO UPDATE SET public_key = EXCLUDED.public_key, registered_by = EXCLUDED.registered_by, registered_at = now()`,
      [me.entity_id, publicKey, me.id],
    );
    await this.store.audit(user.id, "register_partner_signing_key", me.entity_id, { public_key: publicKey });
    return { entity_id: me.entity_id, public_key: publicKey, sign: "the 32 bytes of the snapshot's fingerprint (sha256, hex in list_product_health), with Ed25519" };
  }

  // A partner's co-signature over one snapshot's fingerprint. Refused unless it verifies with the firm's registered key.
  async submitSignature(user: User, productId: string, poolId: string | null, sequence: number, signature: string) {
    const me = (await this.store.getUser(user.id)) ?? user;
    const subject = Buffer.from(subjectKey(productId, poolId)).toString("hex");
    const r = (await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE subject = $1 AND sequence = $2`, [subject, sequence])).rows[0] as unknown as SnapshotRow | undefined;
    if (!r) throw new HealthError(`No snapshot ${sequence} for that product`);
    if (!me.entity_id || r.partner_entity_id !== me.entity_id || !effectiveRoles(me.roles).includes("license_provider")) throw new HealthError("Only the licence provider this snapshot's numbers came from can co-sign it");
    if (r.status !== "pending_signature") throw new HealthError(`Snapshot ${sequence} is ${r.status}: it can only be co-signed while it waits for a signature`);
    const key = await this.signingKey(me.entity_id);
    if (!key) throw new HealthError("Your firm has no registered signing key: use register_partner_signing_key");
    const bytes = /^[0-9a-fA-F]{128}$/.test(signature) ? hexToBytes(signature) : (() => { try { return base58Decode(signature); } catch { return new Uint8Array(0); } })();
    if (!verifyEd25519(key, hexToBytes(r.fingerprint!), bytes)) {
      await this.store.audit(user.id, "submit_partner_signature_refused", productId, { sequence, reason: "signature doesn't verify" });
      throw new HealthError("That signature doesn't verify over this snapshot's fingerprint with your firm's registered key");
    }
    const { rows } = await this.db.query(
      `UPDATE ${T}.product_health_snapshots SET status = 'ready', attestation = 'partner_signed', partner_key = $2, partner_signature = $3 WHERE id = $1 AND status = 'pending_signature' RETURNING id`,
      [r.id, key, Buffer.from(bytes).toString("hex")],
    );
    if (!rows.length) throw new HealthError(`Snapshot ${sequence} is no longer waiting for a signature`);
    await this.store.audit(user.id, "submit_partner_signature", productId, { sequence, fingerprint: r.fingerprint });
    return { product_id: productId, sequence, status: "ready", attestation: "partner_signed" };
  }

  // ---- reading ----

  private async rows(subject: string) {
    return (await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE subject = $1 ORDER BY sequence`, [subject])).rows as unknown as SnapshotRow[];
  }

  private async headOf(subject: Uint8Array): Promise<{ head: HeadAccount | null; error: string | null }> {
    if (!this.chain) return { head: null, error: "The product-health program isn't deployed on this Mynt yet" };
    try {
      return { head: await this.chain.head(subject), error: null };
    } catch (e) {
      return { head: null, error: (e as Error).message.slice(0, ERROR_LIMIT) };
    }
  }

  // Replays the chain from Mynt's own fingerprints and compares it to the head: any change to history shows.
  verifyAgainstChain(rows: SnapshotRow[], head: HeadAccount | null, chainError: string | null) {
    const verdict = new Map<number, string>();
    for (const r of rows) verdict.set(r.sequence, r.on_chain ? "pending" : "not_on_chain");
    if (chainError) {
      for (const r of rows) if (r.on_chain) verdict.set(r.sequence, "unavailable");
      return verdict;
    }
    const ours = rows.filter((r) => r.on_chain);
    let chain: Uint8Array = ZERO_32;
    let expected = 1;
    let continuous = true;
    const upto = head?.sequence ?? 0;
    for (const r of ours) {
      if (r.sequence > upto) break;
      if (r.sequence !== expected++) continuous = false;
      chain = nextChain(chain, r.sequence, r.status === "missed" ? ZERO_32 : hexToBytes(r.fingerprint ?? ""), r.status === "missed" ? KIND_MISSED : KIND_SNAPSHOT);
    }
    const ok = !!head && continuous && expected - 1 === head.sequence && Buffer.from(chain).equals(Buffer.from(head.chain));
    for (const r of ours) verdict.set(r.sequence, ok && r.sequence <= upto ? "matches" : "mismatch");
    return verdict;
  }

  // What anyone allowed to see a product's record gets: fingerprints and status, no numbers.
  async listFor(user: User, productId: string | undefined, limit: number) {
    const me = (await this.store.getUser(user.id)) ?? user;
    const admin = effectiveRoles(me.roles).includes("admin");
    const where = productId ? `WHERE product_id = $1` : "";
    const { rows } = await this.db.query(`SELECT DISTINCT subject, product_id, pool_id FROM ${T}.product_health_snapshots ${where}`, productId ? [productId] : []);
    const out = [];
    for (const row of rows as unknown as { subject: string; product_id: string; pool_id: string }[]) {
      if (!admin) {
        const record = await this.store.getProduct(row.product_id);
        const mine = !!me.entity_id && (record?.entity_id === me.entity_id || (await this.entitlement(user, row.product_id)) !== null);
        if (!mine) continue;
      }
      const all = await this.rows(row.subject);
      const { head, error } = await this.headOf(hexToBytes(row.subject));
      out.push({
        product_id: row.product_id,
        pool_id: row.pool_id || null,
        chain: error ? { status: "unavailable", detail: error } : head ? { status: "ok", head_sequence: head.sequence } : { status: "no_record_yet" },
        gaps: findGaps(all, head, this.now(), this.config.intervalMs),
        snapshots: all.slice(-limit).reverse().map(snapshotStatus),
      });
    }
    return out;
  }

  async get(user: User, productId: string, poolId: string | null, limit: number) {
    const firm = await this.entitlement(user, productId);
    if (!firm) {
      await this.store.audit(user.id, "get_product_health_refused", productId, {});
      throw new HealthError("You aren't entitled to this product's numbers: only its licence provider and liquidity providers are");
    }
    const subjectBytes = subjectKey(productId, poolId);
    const subject = Buffer.from(subjectBytes).toString("hex");
    const all = await this.rows(subject);
    const { head, error } = await this.headOf(subjectBytes);
    const verdict = this.verifyAgainstChain(all, head, error);
    const key = await this.dataKey(subject);
    const history = all.slice(-limit).reverse().map((r) => {
      let report: HealthReport | null = null;
      let reportMatches: boolean | null = null;
      if (r.report_sealed && r.fingerprint) {
        try {
          const text = openReport(key, r.report_sealed, r.subject, r.sequence, r.fingerprint);
          reportMatches = fingerprintOf(text) === r.fingerprint;
          report = reportMatches ? (JSON.parse(text) as HealthReport) : null;
        } catch {
          reportMatches = false;
        }
      }
      const onChain = verdict.get(r.sequence) ?? "not_on_chain";
      return {
        ...snapshotStatus(r),
        report,
        verification: {
          report_matches_fingerprint: reportMatches,
          on_chain: onChain,
          verified: reportMatches === true && onChain === "matches",
          detail: onChain === "unavailable" ? error : reportMatches === false ? "The stored report doesn't match its fingerprint: it was changed after it was recorded, so it's withheld" : null,
        },
      };
    });
    await this.store.audit(user.id, "get_product_health", productId, { as: firm.as, pool_id: poolId, sequences: history.map((h) => h.sequence) });
    return {
      product_id: productId,
      pool_id: poolId,
      entitled_as: firm.as,
      latest: history[0] ?? null,
      history,
      gaps: findGaps(all, head, this.now(), this.config.intervalMs),
      chain: { program_id: this.chain?.programId ?? null, cluster: "devnet", head_sequence: head?.sequence ?? null, ...(error ? { unavailable: error } : {}) },
    };
  }
}

// ---- Mynt's own chain, through the existing RPC client's retry and backoff ----

const PUBLISHER_FLOAT = 20_000_000; // lamports: enough rent and fees for a good while on devnet

export class SolanaHealthChain implements HealthChain {
  readonly programId: string;
  private publisherKey: Awaited<ReturnType<SolanaService["healthPublisher"]>> | null = null;
  constructor(
    private readonly solana: SolanaService,
    programId: string,
  ) {
    this.programId = programId;
  }

  get publisher() {
    return this.publisherKey?.address ?? "";
  }
  private async signer() {
    this.publisherKey ??= await this.solana.healthPublisher(this.programId);
    return this.publisherKey;
  }

  async head(subject: Uint8Array): Promise<HeadAccount | null> {
    const { value } = await this.solana.rpc("devnet").call<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [
      headAddress(this.programId, subject),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!value) return null;
    if (value.owner !== this.programId) throw new HealthError("The product's head account isn't owned by the product-health program");
    const head = decodeHead(Buffer.from(value.data[0], "base64"));
    if (!head) throw new HealthError("The product's head account can't be read");
    return head;
  }

  private async send(ixs: Parameters<SolanaService["sendAsHealthPublisher"]>[1]) {
    const signer = await this.signer();
    await this.solana.fundHealthPublisher(signer.address, PUBLISHER_FLOAT).catch(() => undefined); // the send says what's wrong if it can't pay
    return this.solana.sendAsHealthPublisher(signer, ixs);
  }

  async publishSnapshot(subject: Uint8Array, entry: SnapshotEntry, opening: boolean) {
    const signer = await this.signer();
    return this.send([...(opening ? [healthIx.openSubject(this.programId, signer.address, subject)] : []), healthIx.recordSnapshot(this.programId, signer.address, subject, entry)]);
  }

  async publishMissed(subject: Uint8Array, entry: MissedEntry, opening: boolean) {
    const signer = await this.signer();
    return this.send([...(opening ? [healthIx.openSubject(this.programId, signer.address, subject)] : []), healthIx.recordMissed(this.programId, signer.address, subject, entry)]);
  }
}

// The money rails, if that module has landed: resolved at startup so the two PRs merge in either order.
export async function loadFlowsFor(): Promise<FlowsFor | null> {
  const specifier = "./money-rails.js";
  try {
    const m = (await import(specifier)) as { flowsFor?: unknown };
    return typeof m.flowsFor === "function" ? (m.flowsFor as FlowsFor) : null;
  } catch {
    return null;
  }
}

// For the operator's CLI: the publisher's address, and its one-time initialisation.
export async function initializeHealthProgram(solana: SolanaService, programId: string, authority: Keypair) {
  const publisher = await solana.healthPublisher(programId);
  return solana.initializeHealthProgram(publisher, authority);
}
