import { createHash } from "node:crypto";
const isLedgerError = (x) => !!x && typeof x === "object" && "error" in x;
// ---- canonical encoding ----
// JSON with sorted keys and no spaces, so the same report always has the same bytes and so the same fingerprint.
// Only what encodes one way is allowed: integers, strings, booleans, null, arrays, objects. No floats, ever.
export function canonicalJson(value) {
    if (value === null)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "string")
        return JSON.stringify(value);
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
            throw new Error(`Canonical JSON allows only safe integers, got ${value}`);
        return String(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const obj = value;
        return `{${Object.keys(obj)
            .sort()
            .map((k) => {
            if (obj[k] === undefined)
                throw new Error(`Canonical JSON has no 'undefined' (${k})`);
            return `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
        })
            .join(",")}}`;
    }
    throw new Error(`Canonical JSON can't encode ${typeof value}`);
}
export const fingerprintOf = (canonical) => createHash("sha256").update(canonical, "utf8").digest("hex");
export const measured = (value) => ({ value, reason: null });
export const partialFigure = (value, reason) => ({ value, reason, partial: true });
export const unmeasured = (reason) => ({ value: null, reason });
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
];
// What every flow figure in a report measures, stated in the report: the money rails total movements by when they
// were requested, so a period's figures are that period's requests, not the money that settled in it.
export const FLOWS_BASIS = "Movements requested in this period, by each one's status when the snapshot was computed. requested_* is every movement requested; flows_* is the part of those already settled, so payments that take days to settle show as pending here and aren't counted in a later period; pending_settlements covers this period's requests only. Movements nobody ever answered for are in unresolved_cents and in requested_*, and in no other total. Rates are by value, among this period's completed requests. A figure marked partial totals only the directions the rails can see.";
const cents = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const NULL_BUCKETS = { settled: null, pending: null, failed: null, reversed: null, unresolved: null };
export const NOT_PARTIAL = { in: null, out: null, overall: null };
export const FLOWS_UNAVAILABLE = "The money rails aren't connected to this Mynt";
const FLOWS_UNREADABLE = "The money rails answered with something Mynt can't read";
const sumOrNull = (...xs) => {
    if (!xs.length || xs.some((x) => x === null))
        return null;
    const n = xs.reduce((a, b) => a + b, 0);
    return Number.isSafeInteger(n) ? n : null;
};
const amount = (d, status) => cents(d[status]?.amount_cents);
// Sums directions: only those the rails can see. Statuses requested and submitted are both still pending.
function sumDirections(directions, unresolved) {
    if (!directions.length)
        return { ...NULL_BUCKETS };
    return {
        settled: sumOrNull(...directions.map((d) => amount(d, "settled"))),
        pending: sumOrNull(...directions.flatMap((d) => [amount(d, "requested"), amount(d, "submitted")])),
        failed: sumOrNull(...directions.map((d) => amount(d, "failed"))),
        reversed: sumOrNull(...directions.map((d) => amount(d, "reversed"))),
        unresolved: sumOrNull(...unresolved),
    };
}
// The money rails' answer, in the report's terms: on_ramp and deposit are money in; off_ramp and payout are money out.
export function adaptRailFlows(raw) {
    if (!raw || typeof raw !== "object" || typeof raw.flows !== "object" || raw.flows === null) {
        console.error("product health: the money rails answered in an unknown shape");
        return { flows: null, reason: FLOWS_UNREADABLE, not_measured: {}, partial: NOT_PARTIAL };
    }
    const r = raw;
    const notMeasured = r.not_measured && typeof r.not_measured === "object" ? r.not_measured : {};
    const reasons = [...new Set(Object.values(notMeasured))];
    if (r.measured !== true)
        return { flows: null, reason: reasons.join("; ") || "The money rails can't measure this period", not_measured: notMeasured, partial: NOT_PARTIAL };
    const has = (n) => !!r.flows[n] && typeof r.flows[n] === "object";
    const leftOut = (names) => names.filter((n) => !has(n)).map((n) => `${n}: ${notMeasured[n] ?? "not measured"}`).join("; ") || null;
    const side = (names) => {
        const present = names.filter(has);
        return sumDirections(present.map((n) => r.flows[n]), present.map((n) => cents(r.unresolved?.[n]?.amount_cents)));
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
function basisPoints(numerator, denominator) {
    const bps = (BigInt(numerator) * 10000n) / BigInt(denominator);
    return bps > BigInt(Number.MAX_SAFE_INTEGER) ? unmeasured("The ratio is too large to represent") : measured(Number(bps));
}
// Rounded up: a failure or reversal rate is never understated.
function basisPointsUp(numerator, denominator) {
    const d = BigInt(denominator);
    const bps = (BigInt(numerator) * 10000n + d - 1n) / d;
    return bps > BigInt(Number.MAX_SAFE_INTEGER) ? unmeasured("The ratio is too large to represent") : measured(Number(bps));
}
const sideSeen = (b) => Object.values(b).some((v) => v !== null);
// The figures of one snapshot. Everything null carries the reason it couldn't be measured.
export function buildFigures(i) {
    const ledgerFailed = !i.reading || isLedgerError(i.reading) ? `The partner's ledger couldn't be read${isLedgerError(i.reading) ? ` (${i.reading.error.code})` : ""}` : null;
    const reading = !i.reading || isLedgerError(i.reading) ? null : i.reading;
    const held = cents(reading?.reserves_held_cents);
    const owed = cents(reading?.customer_obligations_cents);
    const reservesFig = held !== null ? measured(held) : unmeasured(ledgerFailed ?? reading?.reason ?? "The partner's ledger didn't give reserves as integer cents");
    const obligationsFig = owed !== null ? measured(owed) : unmeasured(ledgerFailed ?? reading?.reason ?? "The partner's ledger didn't give obligations as integer cents");
    let coverage;
    if (held === null || owed === null)
        coverage = unmeasured("Coverage needs both reserves and obligations from the partner's ledger");
    else if (owed === 0)
        coverage = unmeasured("No customer obligations: coverage is undefined, not infinite");
    else
        coverage = basisPoints(held, owed);
    const f = i.flows;
    const why = i.flowsReason ?? (f ? null : FLOWS_UNAVAILABLE);
    const partial = i.partial ?? NOT_PARTIAL;
    const figure = (v, label, leavesOut) => {
        if (v === null)
            return unmeasured(why ?? `The money rails gave no ${label} total`);
        return leavesOut ? partialFigure(v, `Partial: leaves out ${leavesOut}`) : measured(v);
    };
    const sides = f ? [f.in, f.out].filter(sideSeen) : [];
    const requested = (b) => (b && sideSeen(b) ? sumOrNull(b.settled, b.pending, b.failed, b.reversed, b.unresolved) : null);
    const rate = (top, parts, what) => {
        if (!sides.length)
            return unmeasured(why ?? `The money rails gave no ${what} totals`);
        const numerator = sumOrNull(...sides.map(top));
        const denominator = sumOrNull(...parts.flatMap((p) => sides.map(p)));
        if (numerator === null || denominator === null)
            return unmeasured(`The money rails gave no ${what} totals`);
        if (denominator === 0)
            return unmeasured(`No requests from this period have completed yet, so there's no ${what} rate`);
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
