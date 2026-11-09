import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { licenseInForce, productsAnsweredBy } from "./access.js";
import { RAMP_ADAPTER_IDS } from "./ramp-adapters/index.js";
import { coversJurisdiction } from "./regulatory.js";
import { whereHeld } from "./sponsorships.js";
import type { ProductRecord, Store, User } from "./store.js";
import { getOffering, getSubscription, serviceType } from "./vendors.js";

// Approved money rails. Money moves off-chain only, through rails an admin approved for a licence-provider firm;
// Mynt never holds customer funds, it instructs the provider's rail. authorizeMovement is the one chokepoint: every
// deposit, payout, withdrawal or ramp transfer asks it first, and nothing is instructed unless it says yes. Every
// movement is a row in the ledger (money_movements), in integer US cents, identified to a customer only by a
// pseudonymous key. flowsFor is what other parts of Mynt read.
//
// Sandbox: nothing real moves. A sandbox movement still goes through here and is recorded (sandbox: true, with
// would_refuse naming what live would have said), but it isn't refused, doesn't use a daily limit and isn't in flowsFor.

const T = "financial_products";

export const RAIL_KINDS = ["ramp_adapter", "ach", "wire", "rtp", "fednow", "push_to_card"] as const;
export const RAIL_DIRECTIONS = ["on_ramp", "off_ramp", "payout", "deposit"] as const;
export const RAIL_STATUSES = ["proposed", "approved", "suspended", "revoked"] as const;
export const MOVEMENT_STATUSES = ["requested", "submitted", "settled", "failed", "reversed"] as const;
export type RailKind = (typeof RAIL_KINDS)[number];
export type RailDirection = (typeof RAIL_DIRECTIONS)[number];
export type RailStatus = (typeof RAIL_STATUSES)[number];
export type MovementStatus = (typeof MOVEMENT_STATUSES)[number];

// Where a customer lives, from their own vault (POST /v1/client/fields); what decides which rails may serve them.
export const CUSTOMER_STATE_FIELD = "residence_state";
export const US_STATES = new Set(
  "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy pr gu vi as mp".split(" ").map((s) => `us-${s}`),
);
const stateOf = (value: unknown): string | null => {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return US_STATES.has(s) ? s : null;
};

export interface Rail {
  id: string;
  entity_id: string;
  kind: RailKind;
  provider: string;
  direction: RailDirection;
  states: string[];
  per_transfer_limit_cents: number;
  daily_limit_cents: number;
  status: RailStatus;
  status_reason: string | null;
  note: string | null;
  proposed_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  status_changed_by: string | null;
  status_changed_at: string | null;
  created_at: string;
}
type Row = Record<string, unknown>;
const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString());
const toRail = (r: Row): Rail => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  kind: r.kind as RailKind,
  provider: r.provider as string,
  direction: r.direction as RailDirection,
  states: r.states as string[],
  per_transfer_limit_cents: Number(r.per_transfer_limit_cents),
  daily_limit_cents: Number(r.daily_limit_cents),
  status: r.status as RailStatus,
  status_reason: (r.status_reason as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  proposed_by: (r.proposed_by as string | null) ?? null,
  approved_by: (r.approved_by as string | null) ?? null,
  approved_at: iso(r.approved_at),
  status_changed_by: (r.status_changed_by as string | null) ?? null,
  status_changed_at: iso(r.status_changed_at),
  created_at: iso(r.created_at)!,
});
const toMovement = (r: Row) => ({
  id: r.id as string,
  idempotency_key: r.idempotency_key as string,
  product_id: r.product_id as string,
  app_id: (r.app_id as string | null) ?? null,
  action: (r.action as string | null) ?? null,
  sponsor_entity_id: (r.sponsor_entity_id as string | null) ?? null,
  rail_id: (r.rail_id as string | null) ?? null,
  direction: (r.direction as RailDirection | null) ?? null,
  amount_cents: r.amount_cents == null ? null : Number(r.amount_cents),
  state: (r.state as string | null) ?? null,
  customer_key: (r.customer_key as string | null) ?? null,
  status: r.status as MovementStatus,
  status_detail: (r.status_detail as string | null) ?? null,
  external_ref: (r.external_ref as string | null) ?? null,
  sandbox: r.sandbox as boolean,
  would_refuse: (r.would_refuse as string | null) ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  submitted_at: iso(r.submitted_at),
  settled_at: iso(r.settled_at),
  failed_at: iso(r.failed_at),
  reversed_at: iso(r.reversed_at),
});
export type Movement = ReturnType<typeof toMovement>;

// ---- what counts as moving money ----

// Category `ramp` is where money-moving services live (checkServiceType refuses a money-moving name in any other
// category). A quote only prices; everything else in the category instructs a transfer.
export const isMoneyMovement = (t: { category: string; quote?: boolean | null }) => t.category === "ramp" && !t.quote;

// A service type's name that says it moves money: such a type must be category `ramp`, so it can't dodge the chokepoint.
const MONEY_WORDS = new Set(["transfer", "transfers", "payout", "payouts", "disburse", "disbursement", "disbursements", "withdraw", "withdrawal", "withdrawals", "remit", "remittance", "remittances", "wire", "ach", "rtp", "fednow"]);
export const namesMoneyMovement = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).some((w) => MONEY_WORDS.has(w));

const directionOfWord = (v: unknown): RailDirection | null => (v === "in" || v === "on" ? "on_ramp" : v === "out" || v === "off" ? "off_ramp" : null);
const directionOfKey = (key: string): RailDirection | null => (/(^|_)on_?ramp/.test(key) ? "on_ramp" : /(^|_)off_?ramp/.test(key) ? "off_ramp" : null);

// Dollars as text ("100.00") to integer cents, without going through a float. null: not an amount.
export function centsOf(v: unknown): number | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "");
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

// Which way and how much a transfer moves: from the service type's key and the quote it accepts, or its params.
// The rail carries the customer's own amount (amount_usd), not the balance side of it, which differs by the fee.
export function movementShape(t: { key: string }, params?: Record<string, unknown>, quote?: Record<string, unknown> | null) {
  const source = quote ?? params ?? {};
  return {
    direction: directionOfKey(t.key) ?? directionOfWord(source.direction),
    amount_cents: centsOf(source.amount_usd ?? source.fiat_amount),
  };
}

// The directions a product's bound services can move money in.
export async function productMoneyDirections(store: Store, record: ProductRecord): Promise<Set<RailDirection>> {
  const out = new Set<RailDirection>();
  for (const b of record.pins?.vendor_bindings ?? []) {
    const sub = await getSubscription(store.db, b.subscription_id);
    const o = sub && (await getOffering(store.db, sub.offering_id));
    const t = o && (await serviceType(store.db, o.region, o.service_type));
    if (!t || !isMoneyMovement(t)) continue;
    const d = directionOfKey(t.key);
    for (const x of d ? [d] : (["on_ramp", "off_ramp"] as const)) out.add(x);
  }
  return out;
}

// Mynt's pseudonymous key for one app's customer: the ledger never holds the developer's own reference or a name.
const customerKey = (appId: string | null, customerRef: string | null) =>
  customerRef ? createHash("sha256").update(`mynt-ledger:${appId ?? ""}:${customerRef}`).digest("hex").slice(0, 40) : null;

// ---- the chokepoint ----

export interface MovementRequest {
  product_id: string;
  sandbox: boolean;
  direction: RailDirection | null;
  amount_cents: number | null;
  channel: { kind: RailKind; provider: string }; // how Mynt would instruct it: the rail must be this one
  customer_state: unknown; // from the customer's vault; checked here
  customer_ref: string | null; // kept only as a pseudonymous key
  idempotency_key: string; // the same for every attempt at one movement
  app_id?: string | null;
  action?: string | null;
  component_key?: string | null; // the component the action serves, when the contract says
  subscription_id?: string | null; // with request_id, how a partner's later answer finds this movement
  request_id?: string | null;
}
export type MovementVerdict =
  | { allowed: true; movement_id: string; status: MovementStatus; replay: boolean }
  | { allowed: false; status: number; code: string; message: string };
type Refusal = Extract<MovementVerdict, { allowed: false }>;
const refusal = (status: number, code: string, message: string): Refusal => ({ allowed: false, status, code, message });

// The states a firm's verified, in-force US licences cover, as of now.
export async function outsideLicenceCoverage(store: Store, entityId: string, states: string[]): Promise<string[]> {
  const where: string[] = [];
  for (const h of await store.licensesOf(entityId)) if (h.region === "US" && licenseInForce(h)) where.push(...(await whereHeld(store, h)));
  return states.filter((s) => !coversJurisdiction(where, s));
}

// Which rails may carry this movement, or why none may. Limits are checked by the reservation (atomically), not here.
async function eligibleRails(store: Store, m: MovementRequest, onlyRail: string | null): Promise<{ rails: Rail[]; state: string } | Refusal> {
  if (!m.direction) return refusal(403, "movement_unknown", "Mynt can't tell which way this transfer moves money, so it isn't allowed");
  if (m.amount_cents === null) return refusal(403, "amount_unknown", "Mynt can't tell how much this transfer moves, so it isn't allowed");
  const state = stateOf(m.customer_state);
  if (!state) return refusal(409, "customer_state_required", `Record the customer's US state first: POST /v1/client/fields with ${CUSTOMER_STATE_FIELD}, e.g. us-ny`);
  let sponsorships = await store.sponsorships({ product_id: m.product_id, status: "approved" });
  if (!sponsorships.length) return refusal(403, "no_sponsor", "Money can't move for this product: no licence provider sponsors it");
  // The sponsors of the component this action serves, when it has any; otherwise the product's.
  const ofComponent = sponsorships.filter((s) => s.component_key === m.component_key);
  if (ofComponent.length) sponsorships = ofComponent;
  const sponsors = [...new Set(sponsorships.filter((s) => s.jurisdictions.includes(state) || s.jurisdictions.includes("us")).map((s) => s.provider_entity_id))];
  if (!sponsors.length) return refusal(403, "state_not_sponsored", `Money can't move for this product in ${state}: its licence provider doesn't sponsor it there`);
  const { rows } = await store.db.query(`SELECT * FROM ${T}.money_rails WHERE entity_id = ANY($1::uuid[]) AND direction = $2 AND kind = $3 AND provider = $4 ORDER BY created_at, id`, [
    sponsors,
    m.direction,
    m.channel.kind,
    m.channel.provider,
  ]);
  const all = rows.map(toRail);
  if (!all.length) return refusal(403, "no_approved_rail", `No approved money rail serves this product for ${m.direction}`);
  const inState = all.filter((r) => r.states.includes(state));
  if (!inState.length) return refusal(403, "state_not_on_rail", `No approved money rail for ${m.direction} can be used in ${state}`);
  let approved = inState.filter((r) => r.status === "approved");
  if (onlyRail) approved = approved.filter((r) => r.id === onlyRail); // a retry stays on the rail it was counted against
  if (!approved.length) {
    const stopped = inState.find((r) => r.status === "suspended" || r.status === "revoked");
    return stopped
      ? refusal(403, `rail_${stopped.status}`, `The money rail for ${m.direction} in ${state} is ${stopped.status}: new transfers are stopped`)
      : refusal(403, "no_approved_rail", `No approved money rail serves this product for ${m.direction} in ${state}`);
  }
  const usable: Rail[] = [];
  for (const r of approved) if (!(await outsideLicenceCoverage(store, r.entity_id, [state])).length) usable.push(r);
  if (!usable.length) return refusal(403, "licence_not_in_force", `The licence provider's licence no longer covers ${state}, so its money rail can't be used there`);
  return { rails: usable, state };
}

const REFUSAL_OF: Record<string, (m: MovementRequest) => Refusal> = {
  over_transfer_limit: (m) => refusal(403, "over_transfer_limit", `This transfer is over the per-transfer limit of the money rail for ${m.direction}`),
  over_daily_limit: (m) => refusal(403, "over_daily_limit", `This transfer would go over today's limit (UTC) of the money rail for ${m.direction}; try again tomorrow`),
  rail_not_approved: (m) => refusal(403, "rail_suspended", `The money rail for ${m.direction} stopped taking new transfers just now`),
  idempotency_conflict: () => refusal(409, "idempotency_conflict", "That idempotency key was already used for a different transfer"),
};

// Every money movement asks this first. Live: refused (and audited) unless an approved rail fits the sponsor, the
// product, the direction, the customer's state and its limits; the row it reserves is what counts against the daily
// limit, atomically (reserve_money_movement locks the rail). A repeat of one idempotency key is the same movement.
export async function authorizeMovement(store: Store, m: MovementRequest): Promise<MovementVerdict> {
  const { rows: seen } = await store.db.query(`SELECT * FROM ${T}.money_movements WHERE idempotency_key = $1`, [m.idempotency_key]);
  const existing = seen[0] ? toMovement(seen[0]) : null;
  const eligible = await eligibleRails(store, m, !m.sandbox && existing?.status === "requested" ? existing.rail_id : null);
  if (m.sandbox) return recordSandbox(store, m, existing, eligible);
  if (existing && existing.status !== "failed" && existing.status !== "requested") return { allowed: true, movement_id: existing.id, status: existing.status, replay: true };
  const refuse = async (r: Refusal): Promise<Refusal> => {
    await store.audit(null, "money_movement_refused", m.product_id, {
      code: r.code,
      direction: m.direction,
      amount_cents: m.amount_cents,
      state: stateOf(m.customer_state),
      app_id: m.app_id ?? null,
      action: m.action ?? null,
      idempotency_key: m.idempotency_key,
    });
    return r;
  };
  if ("allowed" in eligible) return refuse(eligible);
  let last: string | null = null;
  const id = randomUUID();
  for (const rail of eligible.rails) {
    const { rows } = await store.db.query(`SELECT * FROM ${T}.reserve_money_movement($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [
      rail.id,
      id,
      m.idempotency_key,
      m.product_id,
      m.app_id ?? null,
      m.action ?? null,
      rail.entity_id,
      m.direction,
      m.amount_cents,
      eligible.state,
      customerKey(m.app_id ?? null, m.customer_ref),
      m.subscription_id ?? null,
      m.request_id ?? null,
    ]);
    const r = rows[0] as { o_outcome: string; o_id: string | null; o_status: MovementStatus | null };
    if (r.o_outcome === "reserved") return { allowed: true, movement_id: r.o_id!, status: "requested", replay: false };
    if (r.o_outcome === "duplicate") {
      // A retry after an answer that never came: later answers are for this attempt.
      if (r.o_status === "requested" && m.request_id)
        await store.db.query(`UPDATE ${T}.money_movements SET request_id = $2, subscription_id = COALESCE($3, subscription_id), updated_at = now() WHERE id = $1 AND status = 'requested'`, [r.o_id, m.request_id, m.subscription_id ?? null]);
      return { allowed: true, movement_id: r.o_id!, status: r.o_status!, replay: r.o_status !== "requested" };
    }
    if (r.o_outcome === "idempotency_conflict") return refuse(REFUSAL_OF.idempotency_conflict(m));
    // A later rail may still have room; report the most useful reason if none does.
    if (last !== "over_daily_limit") last = r.o_outcome;
  }
  return refuse(REFUSAL_OF[last ?? "rail_not_approved"](m));
}

async function recordSandbox(store: Store, m: MovementRequest, existing: Movement | null, eligible: { rails: Rail[]; state: string } | Refusal): Promise<MovementVerdict> {
  const rail = "allowed" in eligible ? null : eligible.rails[0];
  const overLimit = rail && m.amount_cents !== null && m.amount_cents > rail.per_transfer_limit_cents ? "over_transfer_limit" : null;
  const wouldRefuse = "allowed" in eligible ? eligible.code : overLimit;
  if (existing && existing.status !== "failed") {
    // A retry after an answer that never came: later answers are for this attempt.
    if (existing.status === "requested" && m.request_id)
      await store.db.query(`UPDATE ${T}.money_movements SET request_id = $2, subscription_id = COALESCE($3, subscription_id), updated_at = now() WHERE id = $1 AND status = 'requested'`, [existing.id, m.request_id, m.subscription_id ?? null]);
    return { allowed: true, movement_id: existing.id, status: existing.status, replay: existing.status !== "requested" };
  }
  const { rows } = await store.db.query(
    `INSERT INTO ${T}.money_movements (id, idempotency_key, product_id, app_id, action, sponsor_entity_id, rail_id, direction, amount_cents, state, customer_key, status, subscription_id, request_id, sandbox, would_refuse)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'requested', $12, $13, true, $14)
     ON CONFLICT (idempotency_key) DO UPDATE SET status = 'requested', status_detail = NULL, failed_at = NULL, request_id = EXCLUDED.request_id, subscription_id = EXCLUDED.subscription_id, updated_at = now()
       WHERE ${T}.money_movements.status = 'failed'
     RETURNING id`,
    [
      randomUUID(),
      m.idempotency_key,
      m.product_id,
      m.app_id ?? null,
      m.action ?? null,
      rail?.entity_id ?? null,
      rail?.id ?? null,
      m.direction,
      m.amount_cents,
      stateOf(m.customer_state),
      customerKey(m.app_id ?? null, m.customer_ref),
      m.subscription_id ?? null,
      m.request_id ?? null,
      wouldRefuse,
    ],
  );
  if (rows[0]) return { allowed: true, movement_id: rows[0].id as string, status: "requested", replay: false };
  const { rows: now } = await store.db.query(`SELECT id, status FROM ${T}.money_movements WHERE idempotency_key = $1`, [m.idempotency_key]);
  return { allowed: true, movement_id: now[0].id as string, status: now[0].status as MovementStatus, replay: true };
}

// ---- a movement's life, moving only forward ----

type Where = { subscription_id: string; request_id: string };
const FROM: Record<Exclude<MovementStatus, "requested">, MovementStatus[]> = {
  submitted: ["requested"],
  settled: ["requested", "submitted"],
  failed: ["requested", "submitted"],
  reversed: ["settled"],
};

async function move(store: Store, at: Where, to: Exclude<MovementStatus, "requested">, o: { external_ref?: string | null; detail?: string | null; late?: boolean } = {}): Promise<boolean> {
  // Money that arrived after Mynt gave up on it still moved.
  const from = to === "settled" && o.late ? [...FROM.settled, "failed"] : FROM[to];
  const { rows } = await store.db.query(
    `UPDATE ${T}.money_movements SET status = $3, external_ref = COALESCE($4, external_ref), status_detail = $5, ${to}_at = now(), updated_at = now()
     WHERE subscription_id = $1 AND request_id = $2 AND status = ANY($6::text[]) RETURNING id`,
    [at.subscription_id, at.request_id, to, o.external_ref ?? null, o.detail ?? null, from],
  );
  return rows.length > 0;
}

// What a transfer's partner said, by the wire contract's transfer_status. A bank return before settlement is a
// failure; after settlement, a reversal.
export async function recordMovementOutput(store: Store, at: Where, output: Record<string, unknown>, o: { late?: boolean } = {}): Promise<void> {
  const external_ref = typeof output.settlement_ref === "string" ? output.settlement_ref.slice(0, 200) : null;
  const status = output.transfer_status;
  if (status === "settled") await move(store, at, "settled", { external_ref, late: o.late, detail: o.late ? "late_settlement" : null });
  else if (status === "failed") await move(store, at, "failed", { external_ref, detail: "partner_failed" });
  else if (status === "returned") (await move(store, at, "reversed", { external_ref, detail: "returned" })) || (await move(store, at, "failed", { external_ref, detail: "returned" }));
  else await move(store, at, "submitted", { external_ref });
}
export const recordMovementPending = (store: Store, at: Where) => move(store, at, "submitted");
export const recordMovementFailed = (store: Store, at: Where, detail: string) => move(store, at, "failed", { detail });
export const recordMovementReversed = (store: Store, at: Where, detail = "reversed") => move(store, at, "reversed", { detail });
export const recordMovementLateSettlement = (store: Store, at: Where) => move(store, at, "settled", { late: true, detail: "late_settlement" });
// No clear answer (a timeout, a server error): it may have reached the partner, so it stays requested and keeps
// counting against the daily limit. A retry with the same idempotency key is the same movement.
export async function recordMovementUnknown(store: Store, at: Where, detail: string): Promise<void> {
  await store.db.query(`UPDATE ${T}.money_movements SET status_detail = $3, updated_at = now() WHERE subscription_id = $1 AND request_id = $2 AND status = 'requested'`, [at.subscription_id, at.request_id, `outcome_unknown:${detail}`]);
}

// ---- reading the ledger ----

export const LEDGER_STARTED_SETTING = "money_ledger_started_at";
type Tally = { count: number; amount_cents: number | null };
export type Flows = {
  product_id: string;
  from: string;
  to: string;
  measured: boolean;
  // By direction, then status. A direction Mynt can't measure for this product is null, with the reason in not_measured.
  flows: Record<RailDirection, Record<MovementStatus, Tally> | null>;
  not_measured: Partial<Record<RailDirection, string>>;
};

// Live money movements of a product requested in [from, to), totalled by direction and status. Null, never 0, for
// what can't be measured: a period that starts before the ledger did, or a direction Mynt doesn't instruct for this
// product (its money, if any, moves in the provider's own flow).
export async function flowsFor(store: Store, productId: string, from: string | Date, to: string | Date): Promise<Flows> {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw new RangeError("flowsFor needs a valid from before to");
  const out: Flows = {
    product_id: productId,
    from: start.toISOString(),
    to: end.toISOString(),
    measured: false,
    flows: { on_ramp: null, off_ramp: null, payout: null, deposit: null },
    not_measured: {},
  };
  const startedAt = await store.getSetting<string>(LEDGER_STARTED_SETTING);
  const record = await store.getProduct(productId);
  let unmeasurable: string | null = null;
  if (!startedAt || start < new Date(startedAt)) unmeasurable = "the period starts before Mynt's money ledger did";
  else if (!record) unmeasurable = "no such product";
  if (unmeasurable) {
    for (const d of RAIL_DIRECTIONS) out.not_measured[d] = unmeasurable;
    return out;
  }
  const { rows } = await store.db.query(
    `SELECT direction, status, count(*)::int AS n, sum(amount_cents)::text AS cents FROM ${T}.money_movements
     WHERE product_id = $1 AND NOT sandbox AND created_at >= $2 AND created_at < $3 GROUP BY direction, status`,
    [productId, start.toISOString(), end.toISOString()],
  );
  const measured = await productMoneyDirections(store, record!);
  for (const r of rows) measured.add(r.direction as RailDirection);
  for (const d of RAIL_DIRECTIONS) {
    if (!measured.has(d)) {
      out.not_measured[d] = `Mynt doesn't instruct ${d} for this product, so it can't see any`;
      continue;
    }
    const tally = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, { count: 0, amount_cents: 0 } as Tally])) as Record<MovementStatus, Tally>;
    for (const r of rows.filter((x) => x.direction === d)) {
      const cents = Number(r.cents);
      tally[r.status as MovementStatus] = { count: r.n as number, amount_cents: Number.isSafeInteger(cents) ? cents : null };
    }
    out.flows[d] = tally;
  }
  out.measured = RAIL_DIRECTIONS.some((d) => out.flows[d] !== null);
  return out;
}

const movementsIn = async (store: Store, railId: string, statuses: MovementStatus[]) => {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.money_movements WHERE rail_id = $1 AND status = ANY($2::text[]) AND NOT sandbox ORDER BY created_at`, [railId, statuses]);
  return rows.map(toMovement);
};

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });
const Cents = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const State = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => US_STATES.has(s), "A US state as ISO 3166-2, e.g. 'us-ny'");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerMoneyRailTools(server: McpServer, store: Store, user: User, roles: { admin: boolean; licenceProvider: boolean; builder: boolean }) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const myFirm = async () => ((await store.getUser(user.id)) ?? user).entity_id;
  const getRail = async (id: string) => {
    if (!UUID.test(id)) return undefined;
    const { rows } = await store.db.query(`SELECT * FROM ${T}.money_rails WHERE id = $1`, [id]);
    return rows[0] ? toRail(rows[0]) : undefined;
  };
  // One UPDATE, guarded by the status it was read in, so two admins can't both decide it.
  const setStatus = async (rail: Rail, to: RailStatus, reason: string | null, approving: boolean) => {
    const { rows } = await store.db.query(
      `UPDATE ${T}.money_rails SET status = $3, status_reason = $4, status_changed_by = $5, status_changed_at = now(), updated_at = now(),
         approved_by = CASE WHEN $6 THEN $5::uuid ELSE approved_by END, approved_at = CASE WHEN $6 THEN now() ELSE approved_at END
       WHERE id = $1 AND status = $2 RETURNING *`,
      [rail.id, rail.status, to, reason, user.id, approving],
    );
    return rows[0] ? toRail(rows[0]) : undefined;
  };

  if (roles.licenceProvider)
    server.registerTool(
      "propose_rail",
      {
        title: "Propose a money rail",
        description:
          "Licence provider: propose a rail your firm's sponsored products may move money through. An admin must approve it (approve_rail) before any money moves on it; the states must be within your firm's verified licences by then. kind: ramp_adapter (provider: a ramp adapter id, or the id of a ramp vendor offering that speaks Mynt's wire contract), or ach, wire, rtp, fednow, push_to_card (no current path instructs these directly). Limits are integer US cents; the daily limit runs per UTC day. To change a rail, revoke it and propose again.",
        inputSchema: {
          kind: z.enum(RAIL_KINDS),
          provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Lowercase letters, digits, _ and -, e.g. 'bridge'"),
          direction: z.enum(RAIL_DIRECTIONS),
          states: z.array(State).min(1).max(60).describe("US states it may be used in, ISO 3166-2, e.g. ['us-ny', 'us-ca']"),
          per_transfer_limit_cents: Cents,
          daily_limit_cents: Cents,
          note: z.string().max(2000).optional(),
        },
      },
      async ({ kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, note }) => {
        const entity = await myFirm();
        if (!entity) return fail("You don't belong to a firm yet; an admin adds your firm (register_firm) and you to it (add_entity_member)");
        if (per_transfer_limit_cents > daily_limit_cents) return fail("per_transfer_limit_cents can't be more than daily_limit_cents");
        if (kind === "ramp_adapter" && !RAMP_ADAPTER_IDS.includes(provider) && !(await getOffering(store.db, provider)))
          return fail(`A ramp_adapter rail's provider is a ramp adapter id (${RAMP_ADAPTER_IDS.join(", ")}) or the id of a ramp vendor offering`);
        const unique = [...new Set(states)];
        const id = randomUUID();
        try {
          await store.db.query(
            `INSERT INTO ${T}.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status, note, proposed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'proposed', $9, $10)`,
            [id, entity, kind, provider, direction, unique, per_transfer_limit_cents, daily_limit_cents, note ?? null, user.id],
          );
        } catch (e) {
          if ((e as { code?: string }).code === "23505" || /money_rails_one_live_idx/.test((e as Error).message)) return fail(`Your firm already has a ${direction} rail on ${kind}/${provider}: revoke it first to change it`);
          throw e;
        }
        await audit("propose_rail", id, { kind, provider, direction, states: unique, per_transfer_limit_cents, daily_limit_cents });
        return json({ ...(await getRail(id)), outside_licence_coverage: await outsideLicenceCoverage(store, entity, unique) });
      },
    );

  if (roles.licenceProvider || roles.admin)
    server.registerTool(
      "list_rails",
      {
        title: "Money rails",
        description: "Money rails: a licence provider sees its own firm's; an admin sees every firm's. Each with its kind, provider, direction, states, limits in US cents, status, and who approved it and when.",
        inputSchema: { status: z.enum(RAIL_STATUSES).optional(), entity_id: z.string().uuid().optional().describe("Admin: one firm's") },
        annotations: { readOnlyHint: true },
      },
      async ({ status, entity_id }) => {
        const firm = roles.admin ? (entity_id ?? null) : await myFirm();
        if (!roles.admin && !firm) return json([]);
        const { rows } = await store.db.query(`SELECT * FROM ${T}.money_rails WHERE ($1::uuid IS NULL OR entity_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY created_at, id`, [firm, status ?? null]);
        return json(rows.map(toRail));
      },
    );

  if (roles.admin) {
    server.registerTool(
      "approve_rail",
      {
        title: "Approve a money rail",
        description: "Admin: approve a proposed rail, or put a suspended one back. Every state must be within the firm's verified, in-force US licences, or it's refused naming the states outside. Audited, with who approved it and when.",
        inputSchema: { rail_id: z.string().uuid(), note: z.string().max(2000).optional() },
      },
      async ({ rail_id, note }) => {
        const rail = await getRail(rail_id);
        if (!rail) return fail(`No money rail '${rail_id}'`);
        if (rail.status !== "proposed" && rail.status !== "suspended") return fail(`The rail is ${rail.status}; only a proposed or suspended rail can be approved`);
        const outside = await outsideLicenceCoverage(store, rail.entity_id, rail.states);
        if (outside.length) {
          await audit("approve_rail_refused", rail.id, { outside_licence_coverage: outside });
          return fail("The rail can't be approved: some of its states are outside the firm's verified licences", { outside_licence_coverage: outside });
        }
        const done = await setStatus(rail, "approved", note ?? null, true);
        if (!done) return fail("The rail was changed by another call just now; look at it again");
        await audit("approve_rail", rail.id, { was: rail.status, states: rail.states, per_transfer_limit_cents: rail.per_transfer_limit_cents, daily_limit_cents: rail.daily_limit_cents, note: note ?? null });
        return json(done);
      },
    );

    for (const [name, to, title, doing] of [
      ["suspend_rail", "suspended", "Suspend a money rail", "Stops new movements on it at once; approve_rail puts it back."],
      ["revoke_rail", "revoked", "Revoke a money rail", "Stops new movements on it at once, for good: its firm proposes a new rail to replace it."],
    ] as const)
      server.registerTool(
        name,
        {
          title,
          description: `Admin: ${doing} Movements already in flight aren't cancelled; they're listed in the result (in_flight), and carry on to their end in the ledger. Audited.`,
          inputSchema: { rail_id: z.string().uuid(), reason: z.string().min(3).max(2000) },
          annotations: { destructiveHint: true },
        },
        async ({ rail_id, reason }) => {
          const rail = await getRail(rail_id);
          if (!rail) return fail(`No money rail '${rail_id}'`);
          if (rail.status === "revoked" || rail.status === to) return fail(`The rail is already ${rail.status}`);
          if (to === "suspended" && rail.status !== "approved") return fail(`The rail is ${rail.status}; only an approved rail can be suspended`);
          const done = await setStatus(rail, to, reason, false);
          if (!done) return fail("The rail was changed by another call just now; look at it again");
          const in_flight = await movementsIn(store, rail.id, ["requested", "submitted"]);
          await audit(name, rail.id, { was: rail.status, reason, in_flight: in_flight.length });
          return json({ ...done, in_flight });
        },
      );
  }

  server.registerTool(
    "list_money_movements",
    {
      title: "Money movements",
      description:
        "The ledger of money movements, newest first: product, sponsor, rail, direction, amount in integer US cents, customer's state, status (requested, submitted, settled, failed, reversed), external reference and timestamps. Scoped: an admin sees all; a licence provider what it sponsors; a builder its own products. Customers appear only as a pseudonymous key. Sandbox movements only with include_sandbox: their would_refuse says what live would have refused.",
      inputSchema: {
        product_id: z.string().optional(),
        rail_id: z.string().uuid().optional(),
        status: z.enum(MOVEMENT_STATUSES).optional(),
        include_sandbox: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id, rail_id, status, include_sandbox, limit }) => {
      let scope = "";
      const params: unknown[] = [product_id ?? null, rail_id ?? null, status ?? null, include_sandbox, limit];
      if (!roles.admin) {
        const firm = await myFirm();
        const products = roles.builder && firm ? (await productsAnsweredBy(store, user)).filter((p) => p.entity_id === firm).map((p) => p.product.id) : [];
        const sponsor = roles.licenceProvider ? firm : null;
        if (!sponsor && !products.length) return json([]);
        params.push(sponsor, products);
        scope = `AND (sponsor_entity_id = $6::uuid OR product_id = ANY($7::text[]))`;
      }
      const { rows } = await store.db.query(
        `SELECT * FROM ${T}.money_movements
         WHERE ($1::text IS NULL OR product_id = $1) AND ($2::uuid IS NULL OR rail_id = $2) AND ($3::text IS NULL OR status = $3) AND ($4 OR NOT sandbox) ${scope}
         ORDER BY created_at DESC, id LIMIT $5`,
        params,
      );
      return json(rows.map(toMovement));
    },
  );
}
