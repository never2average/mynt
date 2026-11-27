import { createHash } from "node:crypto";

// Product-health figures: the canonical encoding, each figure's rules and the report's shape. Pure (node:crypto only,
// no other import), because the same file runs in two places: Mynt's server (product-health.ts re-exports all of it)
// and the confidential service (deploy/confidential/src/shared/, a byte-for-byte copy of this file's build, checked by
// test/confidential.test.js), so a snapshot computed inside the enclave is the one Mynt would compute.

// What a partner's ledger gives for one product (partner-ledger/types.ts has the same shape).
export interface LedgerReading {
  reserves_held_cents: number | null;
  customer_obligations_cents: number | null;
  as_of: string;
  reason?: string | null;
}
const isLedgerError = (x: unknown): x is { error: { code: string; message: string } } => !!x && typeof x === "object" && "error" in (x as object);

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
  partial?: boolean; // a total of only what could be measured: `reason` says what's left out
}
export const measured = (value: number): Figure => ({ value, reason: null });
export const partialFigure = (value: number, reason: string): Figure => ({ value, reason, partial: true });
export const unmeasured = (reason: string): Figure => ({ value: null, reason });

export const FIGURE_NAMES = [
  "reserves_cents",
  "obligations_cents",
  "coverage_bps",
  "requested_in_cents",
  "requested_out_cents",
  "unresolved_cents",
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

// What every flow figure in a report measures, stated in the report: the money rails total movements by when they
// were requested, so a period's figures are that period's requests, not the money that settled in it.
export const FLOWS_BASIS =
  "Movements requested in this period, by each one's status when the snapshot was computed. requested_* is every movement requested; flows_* is the part of those already settled, so payments that take days to settle show as pending here and aren't counted in a later period; pending_settlements covers this period's requests only. Movements nobody ever answered for are in unresolved_cents and in requested_*, and in no other total. Rates are by value, among this period's completed requests. A figure marked partial totals only the directions the rails can see.";

export interface FlowBuckets {
  settled: number | null;
  pending: number | null;
  failed: number | null;
  reversed: number | null;
  unresolved: number | null;
}
export interface NormalizedFlows {
  in: FlowBuckets;
  out: FlowBuckets;
}
export interface PartialFlows {
  in: string | null; // what the money-in totals leave out, when they only cover part of it
  out: string | null;
  overall: string | null;
}
export interface AdaptedFlows {
  flows: NormalizedFlows | null;
  reason: string | null; // why anything is unmeasured
  not_measured: Record<string, string>; // the directions the rails can't see
  partial: PartialFlows;
}
// The money rails, bound to the store: what they report for a product and period.
export type FlowsFor = (productId: string, from: Date, to: Date) => Promise<unknown>;

const cents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const NULL_BUCKETS: FlowBuckets = { settled: null, pending: null, failed: null, reversed: null, unresolved: null };
export const NOT_PARTIAL: PartialFlows = { in: null, out: null, overall: null };
export const FLOWS_UNAVAILABLE = "The money rails aren't connected to this Mynt";
const FLOWS_UNREADABLE = "The money rails answered with something Mynt can't read";

const sumOrNull = (...xs: (number | null)[]) => {
  if (!xs.length || xs.some((x) => x === null)) return null;
  const n = (xs as number[]).reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(n) ? n : null;
};

type Tally = { count?: unknown; amount_cents?: unknown };
type Rail = Record<string, Tally | undefined>;
const amount = (d: Rail, status: string) => cents(d[status]?.amount_cents);

// Sums directions: only those the rails can see. Statuses requested and submitted are both still pending.
function sumDirections(directions: Rail[], unresolved: (number | null)[]): FlowBuckets {
  if (!directions.length) return { ...NULL_BUCKETS };
  return {
    settled: sumOrNull(...directions.map((d) => amount(d, "settled"))),
    pending: sumOrNull(...directions.flatMap((d) => [amount(d, "requested"), amount(d, "submitted")])),
    failed: sumOrNull(...directions.map((d) => amount(d, "failed"))),
    reversed: sumOrNull(...directions.map((d) => amount(d, "reversed"))),
    unresolved: sumOrNull(...unresolved),
  };
}

// The money rails' answer, in the report's terms: on_ramp and deposit are money in; off_ramp and payout are money out.
export function adaptRailFlows(raw: unknown): AdaptedFlows {
  if (!raw || typeof raw !== "object" || typeof (raw as { flows?: unknown }).flows !== "object" || (raw as { flows?: unknown }).flows === null) {
    console.error("product health: the money rails answered in an unknown shape");
    return { flows: null, reason: FLOWS_UNREADABLE, not_measured: {}, partial: NOT_PARTIAL };
  }
  const r = raw as { measured?: unknown; flows: Record<string, Rail | null | undefined>; unresolved?: Record<string, Tally | null | undefined>; not_measured?: Record<string, string> };
  const notMeasured = r.not_measured && typeof r.not_measured === "object" ? r.not_measured : {};
  const reasons = [...new Set(Object.values(notMeasured))];
  if (r.measured !== true) return { flows: null, reason: reasons.join("; ") || "The money rails can't measure this period", not_measured: notMeasured, partial: NOT_PARTIAL };
  const has = (n: string) => !!r.flows[n] && typeof r.flows[n] === "object";
  const leftOut = (names: string[]) => names.filter((n) => !has(n)).map((n) => `${n}: ${notMeasured[n] ?? "not measured"}`).join("; ") || null;
  const side = (names: string[]) => {
    const present = names.filter(has);
    return sumDirections(present.map((n) => r.flows[n] as Rail), present.map((n) => cents(r.unresolved?.[n]?.amount_cents)));
  };
  const IN = ["on_ramp", "deposit"];
  const OUT = ["off_ramp", "payout"];
  return {
    flows: { in: side(IN), out: side(OUT) },
    reason: reasons.join("; ") || null,
    not_measured: notMeasured,
    partial: { in: IN.some(has) ? leftOut(IN) : null, out: OUT.some(has) ? leftOut(OUT) : null, overall: [...IN, ...OUT].some(has) ? leftOut([...IN, ...OUT]) : null },
  };
}

// Rounded down: coverage is never overstated.
function basisPoints(numerator: number, denominator: number): Figure {
  const bps = (BigInt(numerator) * 10_000n) / BigInt(denominator);
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? unmeasured("The ratio is too large to represent") : measured(Number(bps));
}
// Rounded up: a failure or reversal rate is never understated.
function basisPointsUp(numerator: number, denominator: number): Figure {
  const d = BigInt(denominator);
  const bps = (BigInt(numerator) * 10_000n + d - 1n) / d;
  return bps > BigInt(Number.MAX_SAFE_INTEGER) ? unmeasured("The ratio is too large to represent") : measured(Number(bps));
}

const sideSeen = (b: FlowBuckets) => Object.values(b).some((v) => v !== null);

// The figures of one snapshot. Everything null carries the reason it couldn't be measured.
export function buildFigures(i: {
  reading: LedgerReading | { error: { code: string; message: string } } | null;
  flows: NormalizedFlows | null;
  flowsReason?: string | null;
  partial?: PartialFlows;
  complaints?: number | null;
  incidents?: number | null;
  withdrawals?: number | null;
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
  const why = i.flowsReason ?? (f ? null : FLOWS_UNAVAILABLE);
  const partial = i.partial ?? NOT_PARTIAL;
  const figure = (v: number | null, label: string, leavesOut: string | null): Figure => {
    if (v === null) return unmeasured(why ?? `The money rails gave no ${label} total`);
    return leavesOut ? partialFigure(v, `Partial: leaves out ${leavesOut}`) : measured(v);
  };
  const sides = f ? [f.in, f.out].filter(sideSeen) : [];
  const requested = (b: FlowBuckets | undefined) => (b && sideSeen(b) ? sumOrNull(b.settled, b.pending, b.failed, b.reversed, b.unresolved) : null);

  const rate = (top: (b: FlowBuckets) => number | null, parts: ((b: FlowBuckets) => number | null)[], what: string): Figure => {
    if (!sides.length) return unmeasured(why ?? `The money rails gave no ${what} totals`);
    const numerator = sumOrNull(...sides.map(top));
    const denominator = sumOrNull(...parts.flatMap((p) => sides.map(p)));
    if (numerator === null || denominator === null) return unmeasured(`The money rails gave no ${what} totals`);
    if (denominator === 0) return unmeasured(`No requests from this period have completed yet, so there's no ${what} rate`);
    const up = basisPointsUp(numerator, denominator);
    return up.value !== null && partial.overall ? partialFigure(up.value, `Partial: leaves out ${partial.overall}`) : up;
  };

  return {
    reserves_cents: reservesFig,
    obligations_cents: obligationsFig,
    coverage_bps: coverage,
    requested_in_cents: figure(requested(f?.in), "requested inflow", partial.in),
    requested_out_cents: figure(requested(f?.out), "requested outflow", partial.out),
    unresolved_cents: figure(sides.length ? sumOrNull(...sides.map((b) => b.unresolved)) : null, "unresolved", partial.overall),
    flows_in_cents: figure(f?.in.settled ?? null, "settled inflow", partial.in),
    flows_out_cents: figure(f?.out.settled ?? null, "settled outflow", partial.out),
    pending_settlements_cents: figure(sides.length ? sumOrNull(...sides.map((b) => b.pending)) : null, "pending", partial.overall),
    reversal_rate_bps: rate((b) => b.reversed, [(b) => b.settled, (b) => b.reversed], "reversal"),
    failure_rate_bps: rate((b) => b.failed, [(b) => b.settled, (b) => b.reversed, (b) => b.failed], "failure"),
    open_withdrawal_requests: typeof i.withdrawals === "number" ? measured(i.withdrawals) : unmeasured("Withdrawal requests aren't tracked for this product"),
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
  flows_basis: string;
  flows_not_measured: Record<string, string>;
  figures: Figures;
  notes: string[];
  // Only on a report the confidential host computed from a partner's sealed statement (health.ts): what it checked the
  // statement against and what it found. Part of the report, so the fingerprint the host's key signs covers it.
  sealed_statement?: SealedStatementCheck;
}

export interface SealedStatementCheck {
  result: string; // "ok", or the failed check's code (the figures are then unavailable)
  signer_public_key: string | null; // base58: the key whose signature over the statement verified; null when none did
  as_of: string | null; // the statement's own clock, when it passed
  checked: {
    entity_id: string; // the firm the statement had to be from
    environment: string;
    request_id: string | null; // the request it had to answer
    public_key: string | null; // the firm's registered key it had to be signed with
    max_age_ms: number;
    now: string; // the clock its freshness was judged against
  };
}
