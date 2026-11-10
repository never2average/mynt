import { randomUUID } from "node:crypto";
import { authorizeMovement, resolveUnresolvedMovement, recordMovementOutput, STALE_DETAIL, GAVE_UP_DETAIL, type MovementVerdict } from "./money-rails.js";
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
export const WITHDRAWAL_STATUSES = ["queued", "paying", "paid", "cancelled", "no_balance"] as const;
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
  created_at: iso(r.created_at)!,
});
export type Pool = ReturnType<typeof toPool>;

export const toWithdrawal = (r: Row) => ({
  id: r.id as string,
  seq: num(r.seq),
  pool_id: r.pool_id as string,
  lp_entity_id: r.lp_entity_id as string,
  amount_cents: num(r.amount_cents),
  status: r.status as WithdrawalStatus,
  requested_at: iso(r.requested_at)!,
  eligible_at: iso(r.eligible_at)!,
  closed_at: iso(r.closed_at),
});

export async function getPool(store: Store, id: string): Promise<Pool | undefined> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.liquidity_pools WHERE id = $1`, [id]);
  return rows[0] ? toPool(rows[0]) : undefined;
}

// ---- what other parts of Mynt read ----

// The firms with money or a movement in any of the product's real pools, for product health's list of entitled readers.
// A sandbox commitment never counts: it isn't real capital, so it can't be a way into a product's books.
export async function liquidityProvidersOf(store: Store, productId: string): Promise<string[]> {
  const { rows } = await store.db.query(`SELECT DISTINCT c.lp_entity_id FROM ${T}.pool_commitments c JOIN ${T}.liquidity_pools p ON p.id = c.pool_id WHERE p.product_id = $1 AND c.exited_at IS NULL AND NOT p.sandbox`, [productId]);
  return rows.map((r) => r.lp_entity_id as string);
}

// When a firm left the last of a product's pools it was in; null if it's still in one or was never in any.
export async function exitedLiquidityProvider(store: Store, productId: string, entityId: string): Promise<Date | null> {
  const { rows } = await store.db.query(
    `SELECT max(c.exited_at) AS at, bool_and(c.exited_at IS NOT NULL) AS all_out FROM ${T}.pool_commitments c JOIN ${T}.liquidity_pools p ON p.id = c.pool_id WHERE p.product_id = $1 AND c.lp_entity_id = $2 AND NOT p.sandbox`,
    [productId, entityId],
  );
  return rows[0]?.all_out && rows[0].at ? new Date(rows[0].at as string) : null;
}

// Each approved pool of a product that still needs its own health record.
export async function poolsOf(store: Store, productId: string): Promise<string[]> {
  const { rows } = await store.db.query(
    `SELECT p.id FROM ${T}.liquidity_pools p WHERE p.product_id = $1 AND p.approved_at IS NOT NULL
       AND (p.status <> 'closed' OR EXISTS (SELECT 1 FROM ${T}.pool_withdrawals w WHERE w.pool_id = p.id AND w.status IN ('queued', 'paying')))`,
    [productId],
  );
  return rows.map((r) => r.id as string);
}

// Requests still waiting to be paid: one pool's, or a whole product's.
export async function openWithdrawalRequests(store: Store, productId: string, poolId: string | null): Promise<number> {
  const { rows } = await store.db.query(
    `SELECT count(*)::int AS n FROM ${T}.pool_withdrawals w JOIN ${T}.liquidity_pools p ON p.id = w.pool_id
     WHERE p.product_id = $1 AND ($2::uuid IS NULL OR p.id = $2) AND w.status IN ('queued', 'paying')`,
    [productId, poolId],
  );
  return num(rows[0].n);
}

// ---- the reserve gate ----

export type Gate = { ok: true; headroom_cents: number; as_of: Date; sequence: number } | { ok: false; kind: "governance" | "health"; reason: string };
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
  if (headroom <= 0n) return health(`The pool is at or below its minimum reserve: ${reserves.value} cents held against ${required} cents required`);
  if (headroom > BigInt(Number.MAX_SAFE_INTEGER)) return health("The reserve headroom is too large to represent");
  return { ok: true, headroom_cents: Number(headroom), as_of: asOf, sequence: r.sequence };
}

// Basis points of obligations, rounded up so the reserve is never understated, plus the floor in cents.
export function minimumReserve(pool: Pick<Pool, "min_reserve_bps" | "min_reserve_floor_cents">, obligationsCents: number): bigint {
  return (BigInt(obligationsCents) * BigInt(pool.min_reserve_bps) + 9999n) / 10000n + BigInt(pool.min_reserve_floor_cents);
}

// ---- moving capital ----

type PoolMovementRow = { id: string; idempotency_key: string; pool_id: string; lp_entity_id: string; kind: "deposit" | "withdrawal"; amount_cents: unknown; state: string; movement_id: string | null };

// One attempt at the chokepoint, on the pool's named rail of its sponsor. Repeating it (a crash, a retry) is the same
// movement: the attempt's idempotency key never changes.
export async function authorizePoolMovement(store: Store, pool: Pool, row: PoolMovementRow): Promise<MovementVerdict> {
  const railId = row.kind === "deposit" ? pool.deposit_rail_id : pool.withdrawal_rail_id;
  const refuse = async (code: string, message: string): Promise<MovementVerdict> => {
    await store.db.query(`UPDATE ${T}.pool_movements SET state = 'refused', refusal = $2 WHERE id = $1 AND state = 'claimed'`, [row.id, code]);
    return { allowed: false, status: 403, code, message };
  };
  if (!railId) return refuse("no_approved_rail", "This pool has no approved rail for that movement");
  const { rows: rails } = await store.db.query(`SELECT kind, provider, direction FROM ${T}.money_rails WHERE id = $1`, [railId]);
  const rail = rails[0] as { kind: never; provider: string; direction: never } | undefined;
  if (!rail) return refuse("no_approved_rail", "This pool's rail no longer exists");
  const { rows: commits } = await store.db.query(`SELECT state FROM ${T}.pool_commitments WHERE pool_id = $1 AND lp_entity_id = $2`, [pool.id, row.lp_entity_id]);
  const verdict = await authorizeMovement(store, {
    product_id: pool.product_id,
    sandbox: pool.sandbox,
    direction: rail.direction,
    amount_cents: num(row.amount_cents),
    channel: { kind: rail.kind, provider: rail.provider },
    customer_state: commits[0]?.state,
    state_source: "liquidity_provider_stated",
    customer_ref: `lp:${row.lp_entity_id}`,
    idempotency_key: row.idempotency_key,
    action: row.kind === "deposit" ? "pool_deposit" : "pool_withdrawal",
    component_key: pool.component_key,
    subscription_id: pool.id, // with request_id, how the sponsor's answer finds this movement
    request_id: row.id,
    sponsor_entity_id: pool.sponsor_entity_id,
  });
  if (!verdict.allowed) return refuse(verdict.code, verdict.message);
  await store.db.query(`UPDATE ${T}.pool_movements SET movement_id = $2, state = 'authorized' WHERE id = $1`, [row.id, verdict.movement_id]);
  return verdict;
}

export const refreshPool = (store: Store, poolId: string, now: Date) => store.db.query(`SELECT ${T}.refresh_pool_withdrawals($1, $2)`, [poolId, now.toISOString()]);

// What a sponsor says became of a movement. Dollars text only because that's the shape the ledger's own path takes.
export async function reportPoolMovement(store: Store, movementId: string, outcome: "submitted" | "settled" | "failed" | "returned", o: { external_ref?: string | null; settled_amount_cents?: number | null }, now: Date) {
  const { rows } = await store.db.query(`SELECT pm.pool_id, m.subscription_id, m.request_id, m.status AS status, m.status_detail FROM ${T}.pool_movements pm JOIN ${T}.money_movements m ON m.id = pm.movement_id WHERE pm.movement_id = $1`, [movementId]);
  const row = rows[0] as { pool_id: string; subscription_id: string; request_id: string; status: string; status_detail: string | null } | undefined;
  if (!row) return { found: false as const };
  const at = { subscription_id: row.subscription_id, request_id: row.request_id };
  const total = o.settled_amount_cents == null ? undefined : `${Math.floor(o.settled_amount_cents / 100)}.${String(o.settled_amount_cents % 100).padStart(2, "0")}`;
  if (outcome === "failed" && row.status === "failed" && row.status_detail && [STALE_DETAIL, GAVE_UP_DETAIL].includes(row.status_detail)) await resolveUnresolvedMovement(store, at, "sponsor_confirmed_failed");
  else await recordMovementOutput(store, at, { transfer_status: outcome === "submitted" ? "submitted" : outcome, ...(o.external_ref ? { settlement_ref: o.external_ref } : {}), ...(total ? { total_usd: total } : {}) });
  await refreshPool(store, row.pool_id, now);
  const { rows: after } = await store.db.query(`SELECT status, status_detail FROM ${T}.money_movements WHERE id = $1`, [movementId]);
  return { found: true as const, pool_id: row.pool_id, status: after[0].status as string, status_detail: (after[0].status_detail as string | null) ?? null };
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

  // Everything Mynt knows that stops a pool paying out. Governance first: a pool whose sponsorship is gone stops there.
  async evaluate(pool: Pool): Promise<Gate> {
    const record = await this.store.getProduct(pool.product_id);
    if (!record) return { ok: false, kind: "governance", reason: "The product no longer exists" };
    if (record.drift) return { ok: false, kind: "governance", reason: "The product has drifted from what was published: new money movements stop until a new version is published" };
    const sponsored = (await this.store.sponsorships({ product_id: pool.product_id, provider_entity_id: pool.sponsor_entity_id, status: "approved" })).some((s) => s.component_key === pool.component_key);
    if (!sponsored) return { ok: false, kind: "governance", reason: "The pool's sponsorship is no longer approved" };
    if ((await this.store.getEntity(pool.sponsor_entity_id))?.status !== "active") return { ok: false, kind: "governance", reason: "The pool's sponsor isn't active on Mynt" };
    if (!this.health) return health("Product health isn't running on this Mynt, so the reserve can't be checked");
    let reading: PoolHealthReading | null;
    try {
      reading = await this.health.latestFinished(pool.product_id, pool.id);
    } catch (e) {
      return health(`The pool's health couldn't be read: ${(e as Error).message.slice(0, 200)}`);
    }
    return reserveGate(pool, reading, this.now(), this.config.maxHealthAgeMs);
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
  private async recoverClaims(pool: Pool) {
    const cutoff = new Date(this.now().getTime() - CLAIM_RECOVERY_MS).toISOString();
    const { rows } = await this.store.db.query(`SELECT * FROM ${T}.pool_movements WHERE pool_id = $1 AND state = 'claimed' AND claimed_at < $2`, [pool.id, cutoff]);
    for (const row of rows as unknown as PoolMovementRow[]) await authorizePoolMovement(this.store, pool, row);
  }

  private async payQueue(pool: Pool, gate: Extract<Gate, { ok: true }>) {
    const { rows: rails } = await this.store.db.query(`SELECT per_transfer_limit_cents FROM ${T}.money_rails WHERE id = $1`, [pool.withdrawal_rail_id]);
    const perTransfer = rails[0] ? num(rails[0].per_transfer_limit_cents) : 0;
    if (perTransfer <= 0) return this.hold(pool, "This pool has no usable withdrawal rail");
    const { rows: refused } = await this.store.db.query(`SELECT max(claimed_at) AS last FROM ${T}.pool_movements WHERE pool_id = $1 AND kind = 'withdrawal' AND state = 'refused'`, [pool.id]);
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
          await this.store.audit(null, "pool_withdrawal_refused", pool.id, { withdrawal_id: c.o_withdrawal, amount_cents: num(c.o_amount), code: verdict.code });
          return this.hold(pool, `The money rail refused the next payment (${verdict.code}): ${verdict.message}`);
        }
        await this.store.audit(null, "pool_withdrawal_claimed", pool.id, { withdrawal_id: c.o_withdrawal, lp_entity_id: c.o_lp, amount_cents: num(c.o_amount), movement_id: verdict.movement_id, snapshot_sequence: gate.sequence });
        continue;
      }
      if (c.o_outcome === "no_headroom") return this.hold(pool, "The next payment would take the pool below its minimum reserve given what's already gone since the latest snapshot; it waits for the next one");
      if (c.o_outcome === "held") return this.hold(pool, "The firm at the head of the queue has a payment whose outcome isn't known yet; the queue waits for it");
      return this.hold(pool, null); // empty, or the head isn't due yet
    }
  }

  // One pool: bring it in line with the ledger, decide whether it may pay, then pay in queue order.
  async processPool(pool: Pool) {
    const now = this.now();
    await this.recoverClaims(pool);
    await refreshPool(this.store, pool.id, now);
    const gate = await this.evaluate(pool);
    if (!gate.ok) return this.autoPause(pool, gate.kind, gate.reason);
    await this.autoResume(pool);
    const current = await getPool(this.store, pool.id);
    if (current && (current.status === "open" || current.status === "closed")) await this.payQueue(current, gate);
    await refreshPool(this.store, pool.id, now);
  }

  // Safe to run at any time, and in several processes at once: everything that matters happens under a pool's lock.
  async tick() {
    const { rows } = await this.store.db.query(`SELECT * FROM ${T}.liquidity_pools WHERE approved_at IS NOT NULL AND (status <> 'closed' OR EXISTS (SELECT 1 FROM ${T}.pool_withdrawals w WHERE w.pool_id = liquidity_pools.id AND w.status IN ('queued', 'paying')))`);
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
