import { randomUUID } from "node:crypto";
import { authorizeMovement, eligibleRails, resolveUnresolvedMovement, recordMovementOutput, STALE_DETAIL, GAVE_UP_DETAIL, type MovementRequest, type MovementVerdict } from "./money-rails.js";
import type { PoolHealthReading, ProductHealthService } from "./product-health.js";
import type { Store } from "./store.js";
import { serialLoop } from "./worker.js";

// Liquidity pools: firms or funds put capital into a product's pools and take it out, watching its health to decide
// where capital goes. Mynt never holds funds: it records and instructs, the money stays at the licensed partner, and
// every deposit and withdrawal asks money-rails' chokepoint for an approved rail of the pool's sponsor.
//
// A firm's position is worked out from the movement ledger, settled movements only: nothing is stored that could drift
// from it. Withdrawals queue first in, first out per pool. A worker pays the head of the queue only as far as the
// latest verified health snapshot still shows the pool above its minimum reserve; anything it can't confirm stops
// payment and says why (reserveGate). Pooled investor capital with withdrawal rights may be a securities offering, so
// real commitments are refused until an admin records who cleared the pool's offering and on what legal basis.

const T = "financial_products";

export const POOL_STATUSES = ["open", "paused", "closed"] as const;
export type PoolStatus = (typeof POOL_STATUSES)[number];
export const WITHDRAWAL_STATUSES = ["queued", "paying", "paid", "paid_short", "returned", "cancelled", "no_balance", "parked"] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];
export type PauseKind = "awaiting_approval" | "manual" | "governance" | "health";

export const OFFERING_NOT_CLEARED =
  "Real money can't be committed to this pool yet: pooled investor capital with withdrawal rights may be a securities offering, so a Mynt admin must first record that this pool's offering was cleared and on what legal basis (set_pool_offering_cleared). Sandbox pools move no real money and aren't subject to this.";

// A snapshot older than this can't release money. By default twice the health interval, so one late snapshot doesn't
// stop payments but two do; POOL_HEALTH_MAX_AGE_MINUTES overrides it.
export const POOL_HEALTH_MAX_AGE_INTERVALS = 2;

// How long a claim may sit with no movement before the worker picks it up after a crash.
export const CLAIM_RECOVERY_MS = 5 * 60_000;
// After the chokepoint refuses a payment, how long before asking again: a rail's daily limit or suspension doesn't clear
// in one poll, and each retry leaves a row.
export const REFUSAL_BACKOFF_MS = 15 * 60_000;
// Refusals about one firm rather than the rail: after this many its request is parked, so it can't freeze the queue.
// Parked keeps its place: it's tried again this often, in case what was wrong has cleared.
export const PARK_AFTER_REFUSALS = 3;
export const PARKED_RETRY_MS = 15 * 60_000;
// A parked request's checks back off to at most this far apart.
export const PARKED_RETRY_MAX_MS = 6 * 3_600_000;
// How long a firm has to dispute a correction an admin applied to its state; POOL_CORRECTION_DISPUTE_DAYS overrides it.
export const POOL_CORRECTION_DISPUTE_DAYS = 14;
export function correctionDisputeMs(env: NodeJS.ProcessEnv = process.env): number {
  const days = Number(env.POOL_CORRECTION_DISPUTE_DAYS);
  return (env.POOL_CORRECTION_DISPUTE_DAYS && days >= 1 ? Math.floor(days) : POOL_CORRECTION_DISPUTE_DAYS) * 86_400_000;
}
export const FIRM_SPECIFIC_REFUSALS = ["customer_state_required", "state_not_on_rail", "state_not_sponsored"];
// A tick pays at most this many slices of one pool, so one busy pool can't hold up the rest.
const MAX_CLAIMS_PER_TICK = 50;

export interface LiquidityConfig {
  maxHealthAgeMs: number;
  pollMs: number;
}
export function liquidityConfigFromEnv(env: NodeJS.ProcessEnv, healthIntervalMs: number): LiquidityConfig {
  const minutes = Number(env.POOL_HEALTH_MAX_AGE_MINUTES);
  return {
    maxHealthAgeMs: env.POOL_HEALTH_MAX_AGE_MINUTES && minutes >= 1 ? Math.floor(minutes) * 60_000 : POOL_HEALTH_MAX_AGE_INTERVALS * healthIntervalMs,
    pollMs: Number(env.LIQUIDITY_POLL_MS ?? 60_000),
  };
}

type Row = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
const num = (v: unknown) => Number(v);

export const toPool = (r: Row) => ({
  id: r.id as string,
  product_id: r.product_id as string,
  component_key: r.component_key as string,
  sponsor_entity_id: r.sponsor_entity_id as string,
  name: r.name as string,
  currency: r.currency as string,
  sandbox: r.sandbox as boolean,
  status: r.status as PoolStatus,
  pause_kind: (r.pause_kind as PauseKind | null) ?? null,
  pause_reason: (r.pause_reason as string | null) ?? null,
  paused_at: iso(r.paused_at),
  hold_reason: (r.hold_reason as string | null) ?? null,
  min_reserve_bps: num(r.min_reserve_bps),
  min_reserve_floor_cents: num(r.min_reserve_floor_cents),
  notice_period_days: num(r.notice_period_days),
  min_commitment_cents: num(r.min_commitment_cents),
  max_commitment_cents: num(r.max_commitment_cents),
  deposit_rail_id: (r.deposit_rail_id as string | null) ?? null,
  withdrawal_rail_id: (r.withdrawal_rail_id as string | null) ?? null,
  created_by: (r.created_by as string | null) ?? null,
  approved_by: (r.approved_by as string | null) ?? null,
  approved_at: iso(r.approved_at),
  offering_cleared: r.offering_cleared as boolean,
  offering_cleared_by: (r.offering_cleared_by as string | null) ?? null,
  offering_cleared_at: iso(r.offering_cleared_at),
  offering_legal_basis: (r.offering_legal_basis as string | null) ?? null,
  paused_by_admin: Boolean(r.paused_by_admin),
  // Lock-in and top-ups: what the sponsor approved (approved_terms), and any change the builder has proposed since that
  // waits for the sponsor's new approval (proposed_terms). See productLockIn for product_lock_in_days.
  lock_in_days: num(r.lock_in_days ?? 0),
  topups_when_health_paused: r.topups_when_health_paused == null ? true : Boolean(r.topups_when_health_paused),
  product_lock_in_days: r.product_lock_in_days == null ? null : num(r.product_lock_in_days),
  approved_terms: (r.approved_terms as ApprovedPoolTerms | null) ?? null,
  proposed_terms: (r.proposed_terms as ProposedPoolTerms | null) ?? null,
  created_at: iso(r.created_at)!,
});
export type Pool = ReturnType<typeof toPool>;

// The terms a sponsor approved, recorded with the approval: committed firms can see exactly what was agreed, and a term
// changes after approval only through a new one (approve_pool_terms).
export interface ApprovedPoolTerms {
  lock_in_days: number;
  topups_when_health_paused: boolean;
  notice_period_days: number;
  min_reserve_bps: number;
  min_reserve_floor_cents: number;
  min_commitment_cents: number;
  max_commitment_cents: number;
  approved_by: string;
  approved_at: string;
}
export interface ProposedPoolTerms {
  lock_in_days: number;
  topups_when_health_paused: boolean;
  reason: string | null;
  proposed_by: string;
  proposed_at: string;
}
export const approvedTermsOf = (p: Pick<Pool, "lock_in_days" | "topups_when_health_paused" | "notice_period_days" | "min_reserve_bps" | "min_reserve_floor_cents" | "min_commitment_cents" | "max_commitment_cents">, by: string, at: Date): ApprovedPoolTerms => ({
  lock_in_days: p.lock_in_days,
  topups_when_health_paused: p.topups_when_health_paused,
  notice_period_days: p.notice_period_days,
  min_reserve_bps: p.min_reserve_bps,
  min_reserve_floor_cents: p.min_reserve_floor_cents,
  min_commitment_cents: p.min_commitment_cents,
  max_commitment_cents: p.max_commitment_cents,
  approved_by: by,
  approved_at: at.toISOString(),
});

// ---- the product's lock-in ----

// A product definition states a lock-in on a wraps connection (attributes.lock_in in financial-product.v2.schema.json):
// a wrapper's lock-in applies to withdrawals of the wrapper and, through it, of the component it wraps, so it's relevant
// to a pool of either end. It's turned into whole days, rounding up so a pool is never laxer than its product:
// - an ISO 8601 duration ("P30D", "P1Y6M"): a year counts 366 days, a month 31, a week 7, and any hours, minutes or
//   seconds make one more day;
// - a bare number: days;
// - null or false: no lock-in;
// - a term reference ({"$term": id}): that term's value. Its stated value (default) is the pool's default; the shortest
//   the product lets it be (the lowest of allowed, or range.min, else the default) is the floor a pool can't go below.
//   A number term reads its unit (day, week, month or year, singular or plural; none means days).
// Where several wraps connections touch the component, the longest wins. Anything else (money, a list, true, a term
// that isn't there or has no value) can't be read as days: Mynt refuses to guess, and the pool can't be created until
// the product's lock_in is one of the above.
export type ProductLockIn = { stated: false } | { stated: true; default_days: number; floor_days: number; connections: string[] } | { stated: "unreadable"; reason: string };

const UNIT_DAYS: Record<string, number> = { d: 1, day: 1, days: 1, w: 7, week: 7, weeks: 7, m: 31, month: 31, months: 31, y: 366, year: 366, years: 366 };

export function isoDurationDays(v: string): number | null {
  const m = v.match(/^P(?!$)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const n = (i: number) => Number(m[i] ?? 0);
  const time = n(5) * 3600 + n(6) * 60 + n(7);
  return n(1) * 366 + n(2) * 31 + n(3) * 7 + n(4) + Math.ceil(time / 86_400);
}

function valueDays(v: unknown, unit?: unknown): number | null | undefined {
  if (v === null || v === false) return 0;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
    const per = unit == null ? 1 : UNIT_DAYS[String(unit).trim().toLowerCase()];
    return per === undefined ? undefined : Math.ceil(v * per);
  }
  if (typeof v === "string") return isoDurationDays(v.trim()) ?? undefined;
  return undefined;
}

export function productLockIn(definition: Record<string, unknown> | null | undefined, componentKey: string): ProductLockIn {
  if (!definition) return { stated: false };
  const conns = Array.isArray(definition.connections) ? (definition.connections as { _id?: string; type?: string; from?: { kind?: string; id?: string }; to?: { kind?: string; id?: string }; attributes?: Record<string, unknown> }[]) : [];
  const terms = Array.isArray(definition.terms) ? (definition.terms as Record<string, unknown>[]) : [];
  let out = null as { default_days: number; floor_days: number; connections: string[] } | null;
  for (const c of conns) {
    if (c?.type !== "wraps" || !c.attributes || !("lock_in" in c.attributes)) continue;
    if (c.from?.id !== componentKey && c.to?.id !== componentKey) continue;
    const at = `connection '${c._id ?? "?"}'`;
    const raw = c.attributes.lock_in;
    let stated: number, floor: number;
    if (raw && typeof raw === "object" && !Array.isArray(raw) && "$term" in raw) {
      const id = (raw as { $term: unknown }).$term;
      const term = terms.find((t) => t._id === id);
      if (!term) return { stated: "unreadable", reason: `${at}: lock_in refers to term '${String(id)}', which the product doesn't define` };
      const allowed = Array.isArray(term.allowed) ? term.allowed.map((a) => valueDays(a, term.unit)) : [];
      if (allowed.some((a) => a == null)) return { stated: "unreadable", reason: `${at}: term '${String(id)}' allows a value that can't be read as days` };
      const range = term.range as { min?: unknown } | undefined;
      const min = range?.min !== undefined ? valueDays(range.min, term.unit) : undefined;
      const def = term.default !== undefined ? valueDays(term.default, term.unit) : undefined;
      if (term.default !== undefined && def == null) return { stated: "unreadable", reason: `${at}: term '${String(id)}' has a value that can't be read as days` };
      const lowest = allowed.length ? Math.min(...(allowed as number[])) : (min ?? def);
      if (lowest == null) return { stated: "unreadable", reason: `${at}: term '${String(id)}' states no value, allowed values or minimum` };
      floor = lowest;
      stated = Math.max(def ?? lowest, lowest);
    } else {
      const d = valueDays(raw);
      if (d == null) return { stated: "unreadable", reason: `${at}: lock_in ${JSON.stringify(raw).slice(0, 80)} can't be read as days (use an ISO 8601 duration such as "P90D", a number of days, or a term)` };
      stated = floor = d;
    }
    out = { default_days: Math.max(out?.default_days ?? 0, stated), floor_days: Math.max(out?.floor_days ?? 0, floor), connections: [...(out?.connections ?? []), c._id ?? "?"] };
  }
  return out ? { stated: true, ...out } : { stated: false };
}

export const toWithdrawal = (r: Row) => ({
  id: r.id as string,
  seq: num(r.seq),
  pool_id: r.pool_id as string,
  lp_entity_id: r.lp_entity_id as string,
  amount_cents: num(r.amount_cents),
  status: r.status as WithdrawalStatus,
  status_reason: (r.status_reason as string | null) ?? null,
  requested_at: iso(r.requested_at)!,
  eligible_at: iso(r.eligible_at)!,
  closed_at: iso(r.closed_at),
});

export async function getPool(store: Store, id: string): Promise<Pool | undefined> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.liquidity_pools WHERE id = $1`, [id]);
  return rows[0] ? toPool(rows[0]) : undefined;
}

// ---- what other parts of Mynt read ----

// The firms holding settled money in any of the product's real pools, for product health's list of entitled readers. A
// commitment that hasn't settled, or a sandbox one, never counts: neither is real capital, so neither is a way into a
// product's books.
export async function liquidityProvidersOf(store: Store, productId: string): Promise<string[]> {
  const { rows } = await store.db.query(
    `SELECT DISTINCT c.lp_entity_id FROM ${T}.pool_commitments c JOIN ${T}.liquidity_pools p ON p.id = c.pool_id JOIN ${T}.pool_positions s ON s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id
     WHERE p.product_id = $1 AND c.exited_at IS NULL AND NOT p.sandbox AND s.contributed_cents - s.withdrawn_cents > 0`,
    [productId],
  );
  return rows.map((r) => r.lp_entity_id as string);
}

// Whose books a firm may read: the sponsors of the real pools it's put money in, and no others.
export async function liquidityProviderBooks(store: Store, productId: string, entityId: string): Promise<string[]> {
  const { rows } = await store.db.query(
    `SELECT DISTINCT p.sponsor_entity_id FROM ${T}.pool_commitments c JOIN ${T}.liquidity_pools p ON p.id = c.pool_id JOIN ${T}.pool_positions s ON s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id
     WHERE p.product_id = $1 AND c.lp_entity_id = $2 AND NOT p.sandbox AND s.contributed_cents > 0`,
    [productId, entityId],
  );
  return rows.map((r) => r.sponsor_entity_id as string);
}

// The firm whose books a pool's snapshots read: its own sponsor's.
export async function poolSponsorOf(store: Store, poolId: string): Promise<string | null> {
  const { rows } = await store.db.query(`SELECT sponsor_entity_id FROM ${T}.liquidity_pools WHERE id = $1`, [poolId]);
  return (rows[0]?.sponsor_entity_id as string | undefined) ?? null;
}

// When a firm left the last of a product's real pools it held money in; null if it still holds some or never did.
export async function exitedLiquidityProvider(store: Store, productId: string, entityId: string): Promise<Date | null> {
  const { rows } = await store.db.query(
    `SELECT max(c.exited_at) AS at, bool_or(c.exited_at IS NULL AND COALESCE(s.contributed_cents - s.withdrawn_cents, 0) > 0) AS still_in
     FROM ${T}.pool_commitments c JOIN ${T}.liquidity_pools p ON p.id = c.pool_id LEFT JOIN ${T}.pool_positions s ON s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id
     WHERE p.product_id = $1 AND c.lp_entity_id = $2 AND NOT p.sandbox`,
    [productId, entityId],
  );
  return !rows[0]?.still_in && rows[0]?.at ? new Date(rows[0].at as string) : null;
}

// Each approved pool of a product that still needs its own health record.
export async function poolsOf(store: Store, productId: string): Promise<string[]> {
  const { rows } = await store.db.query(
    `SELECT p.id FROM ${T}.liquidity_pools p WHERE p.product_id = $1 AND p.approved_at IS NOT NULL
       AND (p.status <> 'closed' OR EXISTS (SELECT 1 FROM ${T}.pool_withdrawals w WHERE w.pool_id = p.id AND w.status IN ('queued', 'paying', 'parked')))`,
    [productId],
  );
  return rows.map((r) => r.id as string);
}

// Requests still waiting to be paid: one pool's, or a whole product's real pools'.
export async function openWithdrawalRequests(store: Store, productId: string, poolId: string | null): Promise<number> {
  const { rows } = await store.db.query(
    `SELECT count(*)::int AS n FROM ${T}.pool_withdrawals w JOIN ${T}.liquidity_pools p ON p.id = w.pool_id
     WHERE p.product_id = $1 AND (p.id = $2 OR ($2::uuid IS NULL AND NOT p.sandbox)) AND w.status IN ('queued', 'paying', 'parked')`,
    [productId, poolId],
  );
  return num(rows[0].n);
}

// ---- the reserve gate ----

// shortfall: a snapshot Mynt trusts says the pool is short of its reserve, which new capital can fix.
export type Gate = { ok: true; headroom_cents: number; as_of: Date; sequence: number } | { ok: false; kind: "governance" | "health"; reason: string; shortfall?: true };
const health = (reason: string): Gate => ({ ok: false, kind: "health", reason });

// What the latest health snapshot lets a pool pay out. Fails closed: whatever Mynt can't confirm stops payment and
// says why. Sandbox pools run on sandbox figures, so "verified" (which a sandbox snapshot can never be) applies only to
// live pools.
export function reserveGate(pool: Pick<Pool, "sandbox" | "sponsor_entity_id" | "min_reserve_bps" | "min_reserve_floor_cents">, r: PoolHealthReading | null, now: Date, maxAgeMs: number): Gate {
  if (!r) return health("No finished health snapshot of this pool exists yet");
  if (r.status === "missed") return health(`The latest health snapshot (sequence ${r.sequence}) is a missed period, so there's nothing to check the reserve against`);
  if (!pool.sandbox) {
    if (r.source === "sandbox") return health(`The latest health snapshot (sequence ${r.sequence}) is sandbox figures, and this is a live pool`);
    if (r.source !== "partner_ledger" || !r.live) return health(`The latest health snapshot (sequence ${r.sequence}) isn't from the partner's live ledger (source: ${r.source})`);
    if (!r.verified) return health(`The latest health snapshot (sequence ${r.sequence}) isn't verified${r.notes.length ? `: ${r.notes.join(" ")}` : ""}`);
  } else if (!r.report) return health(`The latest health snapshot (sequence ${r.sequence}) can't be read`);
  const report = r.report;
  if (!report) return health(`The latest health snapshot (sequence ${r.sequence}) can't be read`);
  if (report.partner.entity_id !== pool.sponsor_entity_id) return health(`The latest health snapshot (sequence ${r.sequence}) is from another sponsor's books, not this pool's sponsor's`);
  const asOf = report.ledger_as_of ? new Date(report.ledger_as_of) : null;
  if (!asOf || Number.isNaN(asOf.getTime())) return health(`The latest health snapshot (sequence ${r.sequence}) doesn't say when its figures were read, so its age can't be checked`);
  const age = now.getTime() - asOf.getTime();
  if (age > maxAgeMs) return health(`The latest health snapshot (sequence ${r.sequence}) is stale: its figures are from ${asOf.toISOString()}, older than the limit of ${Math.round(maxAgeMs / 60_000)} minutes (POOL_HEALTH_MAX_AGE_MINUTES)`);
  if (age < -5 * 60_000) return health(`The latest health snapshot (sequence ${r.sequence}) is dated in the future, so it isn't trusted`);
  const reserves = report.figures.reserves_cents;
  if (reserves.value === null) return health(`The pool's reserves can't be measured: ${reserves.reason ?? "no reason given"}`);
  const obligations = report.figures.obligations_cents;
  if (obligations.value === null) return health(`The pool's obligations can't be measured: ${obligations.reason ?? "no reason given"}`);
  const required = minimumReserve(pool, obligations.value);
  const headroom = BigInt(reserves.value) - required;
  if (headroom <= 0n) return { ok: false, kind: "health", reason: `The pool is at or below its minimum reserve: ${reserves.value} cents held against ${required} cents required`, shortfall: true };
  if (headroom > BigInt(Number.MAX_SAFE_INTEGER)) return health("The reserve headroom is too large to represent");
  return { ok: true, headroom_cents: Number(headroom), as_of: asOf, sequence: r.sequence };
}

// Basis points of obligations, rounded up so the reserve is never understated, plus the floor in cents.
export function minimumReserve(pool: Pick<Pool, "min_reserve_bps" | "min_reserve_floor_cents">, obligationsCents: number): bigint {
  return (BigInt(obligationsCents) * BigInt(pool.min_reserve_bps) + 9999n) / 10000n + BigInt(pool.min_reserve_floor_cents);
}

// Everything Mynt knows that stops a pool paying out. Governance first: a pool whose sponsorship is gone stops there.
export async function evaluatePool(store: Store, service: ProductHealthService | null, pool: Pool, now: Date, maxAgeMs: number): Promise<Gate> {
  const record = await store.getProduct(pool.product_id);
  if (!record) return { ok: false, kind: "governance", reason: "The product no longer exists" };
  // A covenant's pause stops new sign-ups and never money movements, so on its own it doesn't stop a pool.
  const covenantOnly = !!record.drift?.changes?.length && record.drift.changes.every((c) => c.kind === "covenant");
  if (record.drift && !covenantOnly) return { ok: false, kind: "governance", reason: "The product has drifted from what was published: new money movements stop until a new version is published" };
  const sponsored = (await store.sponsorships({ product_id: pool.product_id, provider_entity_id: pool.sponsor_entity_id, status: "approved" })).some((s) => s.component_key === pool.component_key);
  if (!sponsored) return { ok: false, kind: "governance", reason: "The pool's sponsorship is no longer approved" };
  if ((await store.getEntity(pool.sponsor_entity_id))?.status !== "active") return { ok: false, kind: "governance", reason: "The pool's sponsor isn't active on Mynt" };
  if (!service) return health("Product health isn't running on this Mynt, so the reserve can't be checked");
  let reading: PoolHealthReading | null;
  try {
    reading = await service.latestFinished(pool.product_id, pool.id);
  } catch (e) {
    return health(`The pool's health couldn't be read: ${(e as Error).message.slice(0, 200)}`);
  }
  return reserveGate(pool, reading, now, maxAgeMs);
}

// ---- moving capital ----

type PoolMovementRow = { id: string; idempotency_key: string; pool_id: string; lp_entity_id: string; kind: "deposit" | "withdrawal"; amount_cents: unknown; state: string; movement_id: string | null; customer_state?: string | null };

// A durable open item for a person, once per movement and kind while it's open.
export async function raisePoolFlag(store: Store, f: { pool_id: string; lp_entity_id: string | null; movement_id: string | null; kind: "negative_balance" | "double_claim" | "link_conflict"; amount_cents?: number | null; settled_amount_cents?: number | null; external_ref?: string | null; sandbox: boolean; detail: string }) {
  const { rows } = await store.db.query(
    `INSERT INTO ${T}.pool_flags (id, pool_id, lp_entity_id, movement_id, kind, amount_cents, settled_amount_cents, external_ref, sandbox, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING id`,
    [randomUUID(), f.pool_id, f.lp_entity_id, f.movement_id, f.kind, f.amount_cents ?? null, f.settled_amount_cents ?? null, f.external_ref ?? null, f.sandbox, f.detail],
  );
  if (rows.length) await store.audit(null, "pool_flag_raised", f.pool_id, { kind: f.kind, movement_id: f.movement_id, lp_entity_id: f.lp_entity_id, sandbox: f.sandbox });
}

// A firm's position has gone below zero: true, and someone should know.
export async function flagNegativePosition(store: Store, poolId: string, lpEntityId: string, movementId: string, externalRef: string | null, sandbox: boolean) {
  const { rows } = await store.db.query(`SELECT contributed_cents - withdrawn_cents AS balance FROM ${T}.pool_positions WHERE pool_id = $1 AND lp_entity_id = $2`, [poolId, lpEntityId]);
  const balance = rows[0] ? num(rows[0].balance) : 0;
  if (balance < 0) await raisePoolFlag(store, { pool_id: poolId, lp_entity_id: lpEntityId, movement_id: movementId, kind: "negative_balance", amount_cents: balance, external_ref: externalRef, sandbox, detail: `This firm's settled position is ${balance} cents: more has gone out than is still in, for example a deposit returned after a payout was made` });
}

// Ties an attempt to its ledger row, only while it's still a live claim: zero rows means someone else ended it, and a
// ledger row with no claim behind it needs a person. A deposit's state becomes the commitment's only here.
export async function linkMovement(store: Store, row: PoolMovementRow, movementId: string): Promise<boolean> {
  const { rows } = await store.db.query(`UPDATE ${T}.pool_movements SET movement_id = $2, state = 'authorized' WHERE id = $1 AND state = 'claimed' RETURNING id`, [row.id, movementId]);
  if (!rows.length) {
    const { rows: now } = await store.db.query(`SELECT pm.movement_id, p.sandbox FROM ${T}.pool_movements pm JOIN ${T}.liquidity_pools p ON p.id = pm.pool_id WHERE pm.id = $1`, [row.id]);
    if (now[0]?.movement_id === movementId) return true;
    await raisePoolFlag(store, { pool_id: row.pool_id, lp_entity_id: row.lp_entity_id, movement_id: movementId, kind: "link_conflict", amount_cents: num(row.amount_cents), sandbox: Boolean(now[0]?.sandbox), detail: "A ledger movement exists for a claim that had already ended, so it can't be tied to it" });
    return false;
  }
  if (row.kind === "deposit" && row.customer_state) await store.db.query(`UPDATE ${T}.pool_commitments SET state = $3, state_source = 'liquidity_provider_stated' WHERE pool_id = $1 AND lp_entity_id = $2`, [row.pool_id, row.lp_entity_id, row.customer_state]);
  return true;
}

const conflict: MovementVerdict = { allowed: false, status: 409, code: "claim_conflict", message: "This attempt's claim was already ended; it's been flagged for an admin" };

// The chokepoint's request for one of a pool's rails, in a given state; shared by a real movement and a check of one.
function poolMovementRequest(pool: Pool, rail: { kind: never; provider: string; direction: never }, o: { amount_cents: number; state: unknown; state_source: string; lp_entity_id: string; idempotency_key: string; kind: "deposit" | "withdrawal"; request_id: string }, railId: string): MovementRequest {
  return {
    product_id: pool.product_id,
    sandbox: pool.sandbox,
    direction: rail.direction,
    amount_cents: o.amount_cents,
    channel: { kind: rail.kind, provider: rail.provider },
    customer_state: o.state,
    state_source: o.state_source,
    customer_ref: `lp:${o.lp_entity_id}`,
    idempotency_key: o.idempotency_key,
    action: o.kind === "deposit" ? "pool_deposit" : "pool_withdrawal",
    component_key: pool.component_key,
    subscription_id: pool.id, // with request_id, how the sponsor's answer finds this movement
    request_id: o.request_id,
    sponsor_entity_id: pool.sponsor_entity_id,
    rail_id: railId,
  };
}

// Would the chokepoint let this firm's money out in this state? Asked without leaving a row: null if yes, else why not.
export async function withdrawalRefusal(store: Store, pool: Pool, lpEntityId: string, state: string): Promise<{ code: string; message: string } | null> {
  if (!pool.withdrawal_rail_id) return { code: "no_approved_rail", message: "This pool has no withdrawal rail" };
  const { rows } = await store.db.query(`SELECT kind, provider, direction FROM ${T}.money_rails WHERE id = $1`, [pool.withdrawal_rail_id]);
  if (!rows[0]) return { code: "no_approved_rail", message: "This pool's rail no longer exists" };
  const out = await eligibleRails(store, poolMovementRequest(pool, rows[0] as never, { amount_cents: 1, state, state_source: "liquidity_provider_stated", lp_entity_id: lpEntityId, idempotency_key: "check", kind: "withdrawal", request_id: randomUUID() }, pool.withdrawal_rail_id), pool.withdrawal_rail_id);
  return "allowed" in out ? { code: out.code, message: out.message } : null;
}

// Refuses an attempt, unless the ledger already has it: a crash after the chokepoint left a row, and releasing the claim
// would pay it again. The row stands, and the attempt is tied to it.
export async function refusePoolMovement(store: Store, row: PoolMovementRow, code: string, message: string): Promise<MovementVerdict> {
  const { rows } = await store.db.query(`SELECT id, status FROM ${T}.money_movements WHERE idempotency_key = $1`, [row.idempotency_key]);
  if (rows[0]) {
    if (!(await linkMovement(store, row, rows[0].id as string))) return conflict;
    return { allowed: true, movement_id: rows[0].id as string, status: rows[0].status as never, replay: true };
  }
  await store.db.query(`UPDATE ${T}.pool_movements SET state = 'refused', refusal = $2 WHERE id = $1 AND state = 'claimed'`, [row.id, code]);
  return { allowed: false, status: 403, code, message };
}

// One attempt at the chokepoint, on the pool's named rail of its sponsor. Repeating it (a crash, a retry) is the same
// movement: the attempt's idempotency key never changes.
export async function authorizePoolMovement(store: Store, pool: Pool, row: PoolMovementRow): Promise<MovementVerdict> {
  // As it stands now: a claim recovered and released while this one was running is over.
  const { rows: current } = await store.db.query(`SELECT state FROM ${T}.pool_movements WHERE id = $1`, [row.id]);
  if (current[0]?.state === "refused") return { allowed: false, status: 409, code: "claim_released", message: "This attempt was released" };
  const railId = row.kind === "deposit" ? pool.deposit_rail_id : pool.withdrawal_rail_id;
  const refuse = (code: string, message: string) => refusePoolMovement(store, row, code, message);
  if (!railId) return refuse("no_approved_rail", "This pool has no approved rail for that movement");
  const { rows: rails } = await store.db.query(`SELECT kind, provider, direction, status FROM ${T}.money_rails WHERE id = $1`, [railId]);
  const rail = rails[0] as { kind: never; provider: string; direction: never; status: string } | undefined;
  if (!rail) return refuse("no_approved_rail", "This pool's rail no longer exists");
  // The rail the sponsor named at approval, and no other: a replacement needs the sponsor to approve the pool's use of it.
  if (rail.status !== "approved") return refuse(`rail_${rail.status}`, `The money rail this pool was approved with is ${rail.status}: new transfers are stopped`);
  const { rows: commits } = await store.db.query(`SELECT state, state_source FROM ${T}.pool_commitments WHERE pool_id = $1 AND lp_entity_id = $2`, [pool.id, row.lp_entity_id]);
  const state = row.kind === "deposit" ? (row.customer_state ?? commits[0]?.state) : commits[0]?.state;
  // A deposit's state is what the firm just said; a withdrawal's is on the commitment, and says who set it.
  const stateSource = row.kind === "deposit" ? "liquidity_provider_stated" : ((commits[0]?.state_source as string | undefined) ?? "liquidity_provider_stated");
  const verdict = await authorizeMovement(store, poolMovementRequest(pool, rail, { amount_cents: num(row.amount_cents), state, state_source: stateSource, lp_entity_id: row.lp_entity_id, idempotency_key: row.idempotency_key, kind: row.kind, request_id: row.id }, railId));
  if (!verdict.allowed) return refuse(verdict.code, verdict.message);
  if (!(await linkMovement(store, row, verdict.movement_id))) return conflict;
  return verdict;
}

export const refreshPool = (store: Store, poolId: string, now: Date) => store.db.query(`SELECT ${T}.refresh_pool_withdrawals($1, $2)`, [poolId, now.toISOString()]);

// What a sponsor says became of a movement. Dollars text only because that's the shape the ledger's own path takes.
export async function reportPoolMovement(store: Store, movementId: string, outcome: "submitted" | "settled" | "failed" | "returned", o: { external_ref?: string | null; settled_amount_cents?: number | null }, now: Date) {
  const { rows } = await store.db.query(
    `SELECT pm.pool_id, pm.lp_entity_id, pm.kind, pm.amount_cents, p.sandbox, p.product_id, m.subscription_id, m.request_id, m.status AS status, m.status_detail
     FROM ${T}.pool_movements pm JOIN ${T}.money_movements m ON m.id = pm.movement_id JOIN ${T}.liquidity_pools p ON p.id = pm.pool_id WHERE pm.movement_id = $1`,
    [movementId],
  );
  const row = rows[0] as { pool_id: string; lp_entity_id: string; kind: string; amount_cents: unknown; sandbox: boolean; product_id: string; subscription_id: string; request_id: string; status: string; status_detail: string | null } | undefined;
  if (!row) return { found: false as const };
  const asked = num(row.amount_cents);
  const refused = (code: "over_settlement" | "external_ref_required" | "double_claim") => ({ found: true as const, refused: code, pool_id: row.pool_id, sandbox: row.sandbox, amount_cents: asked });
  if (outcome === "settled") {
    if (o.settled_amount_cents != null && o.settled_amount_cents > asked) return refused("over_settlement");
    if (!row.sandbox && !o.external_ref) return refused("external_ref_required");
    if (row.kind === "withdrawal") {
      const { rows: settled } = await store.db.query(`SELECT * FROM ${T}.settle_pool_withdrawal($1, $2, $3)`, [movementId, o.external_ref ?? null, o.settled_amount_cents ?? null]);
      if (settled[0].o_outcome === "double_claim") {
        await raisePoolFlag(store, { pool_id: row.pool_id, lp_entity_id: row.lp_entity_id, movement_id: movementId, kind: "double_claim", amount_cents: asked, settled_amount_cents: o.settled_amount_cents ?? null, external_ref: o.external_ref ?? null, sandbox: row.sandbox, detail: "A settlement was reported for a withdrawal written off for certain, and its amount has since gone out another way: recording it would count one payment twice. An admin decides (resolve_pool_flag)" });
        return refused("double_claim");
      }
      if (settled[0].o_outcome === "settled") {
        if (o.settled_amount_cents != null && o.settled_amount_cents !== asked) await store.audit(null, "money_movement_amount_differs", movementId, { product_id: row.product_id, amount_cents: asked, expected_total_cents: null, settled_amount_cents: o.settled_amount_cents });
        await flagNegativePosition(store, row.pool_id, row.lp_entity_id, movementId, o.external_ref ?? null, row.sandbox);
      }
      await refreshPool(store, row.pool_id, now);
      const { rows: done } = await store.db.query(`SELECT status, status_detail FROM ${T}.money_movements WHERE id = $1`, [movementId]);
      return { found: true as const, pool_id: row.pool_id, sandbox: row.sandbox, status: done[0].status as string, status_detail: (done[0].status_detail as string | null) ?? null };
    }
  }
  const at = { subscription_id: row.subscription_id, request_id: row.request_id };
  const total = o.settled_amount_cents == null ? undefined : `${Math.floor(o.settled_amount_cents / 100)}.${String(o.settled_amount_cents % 100).padStart(2, "0")}`;
  if (outcome === "failed" && row.status === "failed" && row.status_detail && [STALE_DETAIL, GAVE_UP_DETAIL].includes(row.status_detail)) await resolveUnresolvedMovement(store, at, "sponsor_confirmed_failed");
  else await recordMovementOutput(store, at, { transfer_status: outcome === "submitted" ? "submitted" : outcome, ...(o.external_ref ? { settlement_ref: o.external_ref } : {}), ...(total ? { total_usd: total } : {}) });
  await refreshPool(store, row.pool_id, now);
  await flagNegativePosition(store, row.pool_id, row.lp_entity_id, movementId, o.external_ref ?? null, row.sandbox);
  const { rows: after } = await store.db.query(`SELECT status, status_detail FROM ${T}.money_movements WHERE id = $1`, [movementId]);
  return { found: true as const, pool_id: row.pool_id, sandbox: row.sandbox, status: after[0].status as string, status_detail: (after[0].status_detail as string | null) ?? null };
}

// ---- the worker ----

export interface LiquidityDeps {
  now?: () => Date;
}

export class LiquidityWorker {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly store: Store,
    private readonly health: ProductHealthService | null,
    readonly config: LiquidityConfig,
    private readonly deps: LiquidityDeps = {},
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  evaluate(pool: Pool): Promise<Gate> {
    return evaluatePool(this.store, this.health, pool, this.now(), this.config.maxHealthAgeMs);
  }

  private async hold(pool: Pool, reason: string | null) {
    await this.store.db.query(`UPDATE ${T}.liquidity_pools SET hold_reason = $2, updated_at = now() WHERE id = $1 AND hold_reason IS DISTINCT FROM $2`, [pool.id, reason]);
  }

  // Worker-made pauses only ever replace worker-made pauses: an admin's or sponsor's manual pause stays until they lift it.
  private async autoPause(pool: Pool, kind: "governance" | "health", reason: string) {
    if (pool.status === "closed") return this.hold(pool, reason);
    const { rows } = await this.store.db.query(
      `UPDATE ${T}.liquidity_pools SET status = 'paused', pause_kind = $2, pause_reason = $3, paused_at = CASE WHEN status = 'paused' THEN paused_at ELSE $4::timestamptz END, hold_reason = NULL, updated_at = now()
       WHERE id = $1 AND (status = 'open' OR (status = 'paused' AND pause_kind IN ('governance', 'health')))
         AND (status <> 'paused' OR pause_kind IS DISTINCT FROM $2 OR pause_reason IS DISTINCT FROM $3) RETURNING id`,
      [pool.id, kind, reason.slice(0, 500), this.now().toISOString()],
    );
    if (rows.length && !(pool.status === "paused" && pool.pause_kind === kind && pool.pause_reason === reason)) await this.store.audit(null, "pool_auto_paused", pool.id, { kind, reason });
  }

  private async autoResume(pool: Pool) {
    const { rows } = await this.store.db.query(`UPDATE ${T}.liquidity_pools SET status = 'open', pause_kind = NULL, pause_reason = NULL, paused_at = NULL, updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_kind IN ('governance', 'health') RETURNING id`, [pool.id]);
    if (rows.length) await this.store.audit(null, "pool_auto_resumed", pool.id, {});
  }

  // Claims a crash left between the claim and the chokepoint: the same idempotency key, so it can only be one movement.
  // Only ever called once the pool has passed the gate; a deposit is held to what a new one would be.
  private async recoverClaims(pool: Pool) {
    const cutoff = new Date(this.now().getTime() - CLAIM_RECOVERY_MS).toISOString();
    const { rows } = await this.store.db.query(`SELECT * FROM ${T}.pool_movements WHERE pool_id = $1 AND state = 'claimed' AND claimed_at < $2`, [pool.id, cutoff]);
    for (const row of rows as unknown as PoolMovementRow[]) {
      // A withdrawal goes back to the queue, to be claimed against headroom as it is now, not as it was when it crashed.
      if (row.kind === "withdrawal") await refusePoolMovement(this.store, row, "claim_recovered", "Released after a crash");
      else if (!pool.sandbox && !pool.offering_cleared) await refusePoolMovement(this.store, row, "offering_not_cleared", OFFERING_NOT_CLEARED);
      else if (pool.status !== "open") await refusePoolMovement(this.store, row, "pool_not_open", "This pool isn't taking commitments");
      else await authorizePoolMovement(this.store, pool, row);
    }
    await refreshPool(this.store, pool.id, this.now());
  }

  // Ties crashed claims to the ledger rows they made. Moves no money, so it happens under any pause.
  private async linkCrashRows(pool: Pool) {
    const cutoff = new Date(this.now().getTime() - CLAIM_RECOVERY_MS).toISOString();
    const { rows } = await this.store.db.query(`SELECT pm.*, m.id AS ledger_id FROM ${T}.pool_movements pm JOIN ${T}.money_movements m ON m.idempotency_key = pm.idempotency_key WHERE pm.pool_id = $1 AND pm.state = 'claimed' AND pm.claimed_at < $2`, [pool.id, cutoff]);
    for (const row of rows as unknown as (PoolMovementRow & { ledger_id: string })[]) await linkMovement(this.store, row, row.ledger_id); // a conflict flags itself
  }

  // Parked requests are looked at now and then, keeping their place: a sponsorship or rail change may have cleared it.
  // Each look is a question, not a payment, so a request that's still refused leaves no row and no audit entry.
  private async unparkDue(pool: Pool) {
    const { rows } = await this.store.db.query(
      `SELECT w.id, w.lp_entity_id, w.parked_at, w.park_checks, c.state FROM ${T}.pool_withdrawals w JOIN ${T}.pool_commitments c ON c.pool_id = w.pool_id AND c.lp_entity_id = w.lp_entity_id WHERE w.pool_id = $1 AND w.status = 'parked'`,
      [pool.id],
    );
    const now = this.now();
    for (const r of rows as unknown as { id: string; lp_entity_id: string; parked_at: string; park_checks: number; state: string }[]) {
      const wait = Math.min(PARKED_RETRY_MS * 2 ** num(r.park_checks), PARKED_RETRY_MAX_MS);
      if (now.getTime() - new Date(r.parked_at).getTime() < wait) continue;
      if (await withdrawalRefusal(this.store, pool, r.lp_entity_id, r.state)) await this.store.db.query(`UPDATE ${T}.pool_withdrawals SET parked_at = $2, park_checks = park_checks + 1 WHERE id = $1 AND status = 'parked'`, [r.id, now.toISOString()]);
      else await this.store.db.query(`UPDATE ${T}.pool_withdrawals SET status = 'queued', status_reason = NULL, parked_at = NULL, park_checks = 0 WHERE id = $1 AND status = 'parked'`, [r.id]);
    }
  }

  private async payQueue(pool: Pool, gate: Extract<Gate, { ok: true }>) {
    const { rows: rails } = await this.store.db.query(`SELECT per_transfer_limit_cents FROM ${T}.money_rails WHERE id = $1`, [pool.withdrawal_rail_id]);
    const perTransfer = rails[0] ? num(rails[0].per_transfer_limit_cents) : 0;
    if (perTransfer <= 0) return this.hold(pool, "This pool has no usable withdrawal rail");
    const { rows: refused } = await this.store.db.query(`SELECT max(claimed_at) AS last FROM ${T}.pool_movements WHERE pool_id = $1 AND kind = 'withdrawal' AND state = 'refused' AND refusal <> ALL($2::text[])`, [pool.id, FIRM_SPECIFIC_REFUSALS]);
    if (refused[0]?.last && this.now().getTime() - new Date(refused[0].last as string).getTime() < REFUSAL_BACKOFF_MS) return;
    for (let i = 0; i < MAX_CLAIMS_PER_TICK; i++) {
      const id = randomUUID();
      const { rows } = await this.store.db.query(`SELECT * FROM ${T}.claim_pool_withdrawal($1, $2, $3, $4, $5, $6)`, [id, pool.id, gate.headroom_cents, gate.as_of.toISOString(), perTransfer, this.now().toISOString()]);
      const c = rows[0] as { o_outcome: string; o_withdrawal: string | null; o_lp: string | null; o_amount: unknown };
      if (c.o_outcome === "claimed") {
        const { rows: claim } = await this.store.db.query(`SELECT * FROM ${T}.pool_movements WHERE id = $1`, [id]);
        const verdict = await authorizePoolMovement(this.store, pool, claim[0] as unknown as PoolMovementRow);
        if (!verdict.allowed) {
          await refreshPool(this.store, pool.id, this.now());
          // Once for each state of affairs: the same refusal of the same request isn't news.
          const { rows: seen } = await this.store.db.query(`SELECT count(*)::int AS n FROM ${T}.pool_movements WHERE withdrawal_id = $1 AND state = 'refused' AND refusal = $2`, [c.o_withdrawal, verdict.code]);
          if (num(seen[0].n) <= 1) await this.store.audit(null, "pool_withdrawal_refused", pool.id, { withdrawal_id: c.o_withdrawal, amount_cents: num(c.o_amount), code: verdict.code });
          if (FIRM_SPECIFIC_REFUSALS.includes(verdict.code) && (await this.parkIfPersistent(pool, c.o_withdrawal!, verdict.code))) continue;
          return this.hold(pool, `The money rail refused the next payment (${verdict.code}): ${verdict.message}`);
        }
        await this.store.audit(null, "pool_withdrawal_claimed", pool.id, { withdrawal_id: c.o_withdrawal, lp_entity_id: c.o_lp, amount_cents: num(c.o_amount), movement_id: verdict.movement_id, snapshot_sequence: gate.sequence });
        continue;
      }
      if (c.o_outcome === "no_headroom") return this.hold(pool, "The next payment would take the pool below its minimum reserve given what's already gone since the latest snapshot; it waits for the next one");
      return this.hold(pool, null); // empty, or the head isn't due yet
    }
  }

  // A refusal that's about one firm, repeated: its request stops holding up the firms behind it, keeps its place and
  // comes back when what's wrong is fixed.
  private async parkIfPersistent(pool: Pool, withdrawalId: string, code: string): Promise<boolean> {
    const { rows } = await this.store.db.query(`SELECT count(*)::int AS n FROM ${T}.pool_movements WHERE withdrawal_id = $1 AND state = 'refused' AND refusal = ANY($2::text[])`, [withdrawalId, FIRM_SPECIFIC_REFUSALS]);
    if (num(rows[0].n) < PARK_AFTER_REFUSALS) return false;
    const reason = `Refused ${PARK_AFTER_REFUSALS} times for a reason about this firm (${code}). It keeps its place and is tried again; an admin, or the pool's sponsor with the firm's agreement, can correct its state (set_pool_firm_state)`;
    const { rows: parked } = await this.store.db.query(`UPDATE ${T}.pool_withdrawals SET status = 'parked', status_reason = $2, parked_at = $3, park_checks = 0 WHERE id = $1 AND status = 'queued' RETURNING id`, [withdrawalId, reason, this.now().toISOString()]);
    if (parked.length) await this.store.audit(null, "pool_withdrawal_parked", pool.id, { withdrawal_id: withdrawalId, code });
    return true;
  }

  // One pool: bring it in line with the ledger, decide whether it may pay, then pay in queue order.
  async processPool(pool: Pool) {
    const now = this.now();
    await this.linkCrashRows(pool);
    await refreshPool(this.store, pool.id, now);
    const gate = await this.evaluate(pool);
    if (!gate.ok) return this.autoPause(pool, gate.kind, gate.reason);
    await this.autoResume(pool);
    const current = await getPool(this.store, pool.id);
    if (current && (current.status === "open" || current.status === "closed")) {
      await this.recoverClaims(current);
      await this.unparkDue(current);
      await this.payQueue(current, gate);
    }
    await refreshPool(this.store, pool.id, now);
  }

  // Safe to run at any time, and in several processes at once: everything that matters happens under a pool's lock.
  async tick() {
    const { rows } = await this.store.db.query(`SELECT * FROM ${T}.liquidity_pools WHERE approved_at IS NOT NULL AND (status <> 'closed' OR EXISTS (SELECT 1 FROM ${T}.pool_withdrawals w WHERE w.pool_id = liquidity_pools.id AND w.status IN ('queued', 'paying', 'parked')))`);
    for (const r of rows) await this.processPool(toPool(r)).catch((e) => console.error("liquidity:", r.id, (e as Error).message));
  }

  startWorker() {
    this.timer = serialLoop(() => this.tick(), this.config.pollMs, "liquidity worker");
  }
  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
