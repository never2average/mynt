import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { licenseInForce, productsAnsweredBy } from "./access.js";
import { RAMP_ADAPTER_IDS } from "./ramp-adapters/index.js";
import { licenseProducts, normalizeModel } from "./regulatory.js";
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
  state_source: (r.state_source as string | null) ?? null,
  expected_total_cents: r.expected_total_cents == null ? null : Number(r.expected_total_cents),
  settled_amount_cents: r.settled_amount_cents == null ? null : Number(r.settled_amount_cents),
  settled_amount_differs: (r.settled_amount_differs as boolean | null) ?? null,
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

// An admin declares it on the service type (moves_money); checkServiceType makes every non-quote `ramp` type declare it.
export const isMoneyMovement = (t: { moves_money?: boolean | null }) => t.moves_money === true;

// A name that says it moves money: such a type must declare moves_money, and a quote can't be named so.
const MONEY_WORDS = new Set(["transfer", "transfers", "payout", "payouts", "disburse", "disbursement", "disbursements", "withdraw", "withdrawal", "withdrawals", "remit", "remittance", "remittances", "wire", "ach", "rtp", "fednow"]);
export const namesMoneyMovement = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).some((w) => MONEY_WORDS.has(w));

const directionOfWord = (v: unknown): RailDirection | null => (v === "in" || v === "on" ? "on_ramp" : v === "out" || v === "off" ? "off_ramp" : null);
const directionOfKey = (key: string): RailDirection | null =>
  /(^|_)on_?ramp/.test(key) ? "on_ramp" : /(^|_)off_?ramp/.test(key) ? "off_ramp" : /(^|_)payouts?($|_)/.test(key) ? "payout" : /(^|_)deposits?($|_)/.test(key) ? "deposit" : null;

// Dollars as text ("100.00") to integer cents, without going through a float. null: not an amount.
export function centsOf(v: unknown): number | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "");
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

// Which way and how much a transfer moves: from the service type's key and the quote it accepts, or its params.
// The rail carries the customer's own amount (amount_usd), not the balance side of it, which differs by the fee.
// A service that accepts a quote takes its figures from that quote and nowhere else: what the device sends never counts.
export function movementShape(t: { key: string; accepts?: string | null }, params?: Record<string, unknown>, quote?: Record<string, unknown> | null) {
  const source = t.accepts ? (quote ?? {}) : (params ?? {});
  return {
    direction: directionOfKey(t.key) ?? directionOfWord(source.direction),
    amount_cents: centsOf(source.amount_usd ?? source.fiat_amount),
    expected_total_cents: centsOf(source.total_usd), // the balance side of it, what a partner's settled total is compared with
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
export const customerKey = (appId: string | null, customerRef: string | null) =>
  customerRef ? createHash("sha256").update(`mynt-ledger:${appId ?? ""}:${customerRef}`).digest("hex").slice(0, 40) : null;

// ---- the customer's state ----

// The one place that decides which US state a customer is in. Today it's what the customer told Mynt (their vault's
// residence_state). When a partner-verified address exists, this is the function that changes.
export function resolveCustomerState(held: Record<string, string>): { state: string | null; source: string } {
  return { state: stateOf(held[CUSTOMER_STATE_FIELD]), source: "customer_attested" };
}

// Appends one change of a customer's state to its history. Nothing updates or deletes that table.
export async function recordCustomerStateChange(store: Store, c: { app_id: string; customer_ref: string; sandbox: boolean; old_state: string | null; new_state: string | null; changed_by: string; source: string }): Promise<void> {
  if (c.old_state === c.new_state) return;
  await store.db.query(`INSERT INTO ${T}.customer_state_history (id, app_id, customer_key, sandbox, old_state, new_state, changed_by, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
    randomUUID(),
    c.app_id,
    customerKey(c.app_id, c.customer_ref),
    c.sandbox,
    c.old_state,
    c.new_state,
    c.changed_by,
    c.source,
  ]);
}

// ---- the chokepoint ----

export interface MovementRequest {
  product_id: string;
  sandbox: boolean;
  direction: RailDirection | null;
  amount_cents: number | null;
  expected_total_cents?: number | null; // what the quote said the balance side would be, to compare with what settles
  channel: { kind: RailKind; provider: string }; // how Mynt would instruct it: the rail must be this one
  customer_state: unknown; // from resolveCustomerState; checked here
  state_source?: string | null; // where that state came from, kept on the movement
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

// The states a firm may NOT transmit money in, as of now. A licence counts only if it's verified and in force, grants
// money transmission in the regulatory model, names that state (a country-wide or geography-only claim doesn't count:
// each state licenses it), and has its prerequisites held (the FinCEN registration). `only`: just these licences,
// e.g. what a sponsorship is under; a prerequisite counts whether or not it's named there.
export const MONEY_TRANSMISSION_PRODUCT_TYPE = "us_money_transmission";
export async function outsideLicenceCoverage(store: Store, entityId: string, states: string[], only?: string[]): Promise<string[]> {
  const held = (await store.licensesOf(entityId)).filter((h) => h.region === "US");
  const region = (await store.referenceData(true)).regions.find((r) => r.code === "US");
  const model = normalizeModel(region?.regulatory);
  const where = new Set<string>();
  for (const h of held) {
    if (!licenseInForce(h) || (only && !only.includes(h.id))) continue;
    const regulator = model.regulators.find((r) => r.id === h.regulator_id);
    const type = regulator?.license_types.find((l) => l._id === h.license_id);
    if (!regulator || !type || !licenseProducts(regulator, type).some((p) => p.id === MONEY_TRANSMISSION_PRODUCT_TYPE)) continue;
    const required = (type.requires ?? []).map((e) => (typeof e === "string" ? [e] : e));
    if (required.some((ids) => !held.some((p) => ids.includes(p.license_id) && licenseInForce(p)))) continue;
    for (const j of await whereHeld(store, h)) where.add(j);
  }
  return states.filter((s) => !where.has(s));
}

// Which rails may carry this movement, or why none may. Limits are checked by the reservation (atomically), not here.
async function eligibleRails(store: Store, m: MovementRequest, onlyRail: string | null): Promise<{ rails: Rail[]; state: string } | Refusal> {
  if (!m.direction) return refusal(403, "movement_unknown", "Mynt can't tell which way this transfer moves money, so it isn't allowed");
  if (m.amount_cents === null) return refusal(403, "amount_unknown", "Mynt can't tell how much this transfer moves, so it isn't allowed");
  const state = stateOf(m.customer_state);
  if (!state) return refusal(409, "customer_state_required", `Record the customer's US state first: POST /v1/client/fields with ${CUSTOMER_STATE_FIELD}, e.g. us-ny`);
  let sponsorships = await store.sponsorships({ product_id: m.product_id, status: "approved" });
  if (!sponsorships.length) return refusal(403, "no_sponsor", "Money can't move for this product: no licence provider sponsors it");
  // The sponsor of the component this action serves, and no other. An action naming no component is only clear when
  // the product has one sponsor.
  if (m.component_key) {
    sponsorships = sponsorships.filter((s) => s.component_key === m.component_key);
    if (!sponsorships.length) return refusal(403, "component_not_sponsored", "Money can't move for this action: no licence provider sponsors what it serves");
  } else if (new Set(sponsorships.map((s) => s.provider_entity_id)).size > 1) return refusal(403, "sponsor_ambiguous", "Money can't move for this action: it names no component, and this product has several licence providers");
  const here = sponsorships.filter((s) => s.jurisdictions.includes(state) || s.jurisdictions.includes("us"));
  const sponsors = [...new Set(here.map((s) => s.provider_entity_id))];
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
  for (const r of approved) {
    const named = here.filter((s) => s.provider_entity_id === r.entity_id).flatMap((s) => s.licence_ids);
    if (!(await outsideLicenceCoverage(store, r.entity_id, [state], named)).length) usable.push(r);
  }
  if (!usable.length) return refusal(403, "licence_not_in_force", `The licence provider holds no licence in force to transmit money in ${state}, so its money rail can't be used there`);
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
    const { rows } = await store.db.query(`SELECT * FROM ${T}.reserve_money_movement($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`, [
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
      m.expected_total_cents ?? null,
      m.state_source ?? null,
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
    `INSERT INTO ${T}.money_movements (id, idempotency_key, product_id, app_id, action, sponsor_entity_id, rail_id, direction, amount_cents, state, state_source, customer_key, expected_total_cents, status, subscription_id, request_id, sandbox, would_refuse)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $15, $11, $16, 'requested', $12, $13, true, $14)
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
      m.state_source ?? null,
      m.expected_total_cents ?? null,
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
  settled: ["requested", "submitted", "failed"], // money that arrived after Mynt gave up on it still moved
  failed: ["requested", "submitted"],
  reversed: ["settled"],
};

async function move(store: Store, at: Where, to: Exclude<MovementStatus, "requested">, o: { external_ref?: string | null; detail?: string | null; settled_cents?: number | null } = {}): Promise<boolean> {
  const { rows } = await store.db.query(
    `UPDATE ${T}.money_movements SET status = $3, external_ref = COALESCE($4, external_ref), status_detail = CASE WHEN status = 'failed' AND $3 = 'settled' THEN 'late_settlement' ELSE $5 END, ${to}_at = now(), updated_at = now(),
       settled_amount_cents = COALESCE($7::bigint, settled_amount_cents),
       settled_amount_differs = CASE WHEN $7::bigint IS NULL THEN settled_amount_differs ELSE $7::bigint <> COALESCE(expected_total_cents, amount_cents) END
     WHERE subscription_id = $1 AND request_id = $2 AND status = ANY($6::text[]) RETURNING id, product_id, amount_cents, expected_total_cents, settled_amount_cents, settled_amount_differs`,
    [at.subscription_id, at.request_id, to, o.external_ref ?? null, o.detail ?? null, FROM[to], o.settled_cents ?? null],
  );
  const r = rows[0];
  if (r?.settled_amount_differs && o.settled_cents != null)
    await store.audit(null, "money_movement_amount_differs", r.id as string, { product_id: r.product_id, amount_cents: Number(r.amount_cents), expected_total_cents: r.expected_total_cents == null ? null : Number(r.expected_total_cents), settled_amount_cents: o.settled_cents });
  return rows.length > 0;
}

// What a transfer's partner said, by the wire contract's transfer_status. A bank return before settlement is a
// failure; after settlement, a reversal.
export async function recordMovementOutput(store: Store, at: Where, output: Record<string, unknown>): Promise<void> {
  const external_ref = typeof output.settlement_ref === "string" ? output.settlement_ref.slice(0, 200) : null;
  const status = output.transfer_status;
  if (status === "settled") await move(store, at, "settled", { external_ref, settled_cents: centsOf(output.total_usd) });
  else if (status === "failed") await move(store, at, "failed", { external_ref, detail: "partner_failed" });
  else if (status === "returned") (await move(store, at, "reversed", { external_ref, detail: "returned" })) || (await move(store, at, "failed", { external_ref, detail: "returned" }));
  else await move(store, at, "submitted", { external_ref });
}
export const recordMovementPending = (store: Store, at: Where) => move(store, at, "submitted");
export const recordMovementFailed = (store: Store, at: Where, detail: string) => move(store, at, "failed", { detail });
export const recordMovementReversed = (store: Store, at: Where, detail = "reversed") => move(store, at, "reversed", { detail });
export const recordMovementLateSettlement = (store: Store, at: Where) => move(store, at, "settled", { detail: "late_settlement" });
// No clear answer (a timeout, a server error): it may have reached the partner, so it stays requested and keeps
// counting against the daily limit. A retry with the same idempotency key is the same movement.
export async function recordMovementUnknown(store: Store, at: Where, detail: string): Promise<void> {
  await store.db.query(`UPDATE ${T}.money_movements SET status_detail = $3, updated_at = now() WHERE subscription_id = $1 AND request_id = $2 AND status = 'requested'`, [at.subscription_id, at.request_id, `outcome_unknown:${detail}`]);
}

// A clear refusal by the partner means nothing moved, so the movement is `failed` and frees its share of the day.
// Only these codes say so, and only without a server error behind them: anything else (no answer, a 5xx, a rate
// limit, an answer Mynt couldn't read, a code Mynt doesn't know) may have reached the partner.
export const DEFINITE_PARTNER_REFUSALS = new Set([
  "partner_customer_required",
  "partner_customer_not_ready",
  "partner_payout_account_required",
  "partner_credential_refused",
  "customer_unknown",
  "unknown_quote",
  "quote_expired",
  "offramp_not_available",
  "adapter_missing",
  "partner_credential_missing",
  "environment_mismatch",
  "wrong_environment",
  "vault_not_configured",
]);
export const isDefiniteRefusal = (code: string | null, partnerStatus: unknown) => code !== null && DEFINITE_PARTNER_REFUSALS.has(code) && !(typeof partnerStatus === "number" && partnerStatus >= 500);

// Movements nobody ever answered for: no later than this, they stop counting as in flight. They're `failed` with
// status_detail stale_no_answer, which flowsFor reports apart (`unresolved`), because Mynt doesn't know what happened;
// a late settlement still moves one to `settled`.
export const STALE_DETAIL = "stale_no_answer";
export async function sweepStaleMovements(store: Store, o: { requestedHours?: number; submittedDays?: number; now?: Date } = {}): Promise<number> {
  const { rows } = await store.db.query(
    `UPDATE ${T}.money_movements SET status = 'failed', status_detail = $1, failed_at = now(), updated_at = now()
     WHERE (status = 'requested' AND updated_at < $2::timestamptz - make_interval(hours => $3))
        OR (status = 'submitted' AND updated_at < $2::timestamptz - make_interval(days => $4))
     RETURNING id, product_id, amount_cents, sandbox`,
    [STALE_DETAIL, (o.now ?? new Date()).toISOString(), o.requestedHours ?? 48, o.submittedDays ?? 45],
  );
  for (const r of rows) if (!r.sandbox) await store.audit(null, "money_movement_stale", r.id as string, { product_id: r.product_id, amount_cents: r.amount_cents == null ? null : Number(r.amount_cents) });
  return rows.length;
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
  // Movements swept with no answer: neither in flight nor known to have failed, so in none of the totals above.
  unresolved: Record<RailDirection, Tally | null>;
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
    unresolved: { on_ramp: null, off_ramp: null, payout: null, deposit: null },
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
    `SELECT direction, status, COALESCE(status_detail = $4, false) AS stale, count(*)::int AS n, sum(amount_cents)::text AS cents FROM ${T}.money_movements
     WHERE product_id = $1 AND NOT sandbox AND created_at >= $2 AND created_at < $3 GROUP BY 1, 2, 3`,
    [productId, start.toISOString(), end.toISOString(), STALE_DETAIL],
  );
  const measured = await productMoneyDirections(store, record!);
  for (const r of rows) measured.add(r.direction as RailDirection);
  for (const d of RAIL_DIRECTIONS) {
    if (!measured.has(d)) {
      out.not_measured[d] = `Mynt doesn't instruct ${d} for this product, so it can't see any`;
      continue;
    }
    const tally = Object.fromEntries(MOVEMENT_STATUSES.map((s) => [s, { count: 0, amount_cents: 0 } as Tally])) as Record<MovementStatus, Tally>;
    const unresolved: Tally = { count: 0, amount_cents: 0 };
    for (const r of rows.filter((x) => x.direction === d)) {
      const cents = r.cents == null ? null : Number(r.cents); // a sum over nothing measurable stays null, never 0
      const t = { count: r.n as number, amount_cents: cents !== null && Number.isSafeInteger(cents) ? cents : null };
      if (r.stale) {
        unresolved.count = t.count;
        unresolved.amount_cents = t.amount_cents;
      } else tally[r.status as MovementStatus] = t;
    }
    out.flows[d] = tally;
    out.unresolved[d] = unresolved;
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
        description: "Admin: approve a proposed rail, or put a suspended one back. Every state must be covered by a verified, in-force licence of the firm that grants money transmission there, with its prerequisites held (the FinCEN registration), or it's refused naming the states outside. Whoever proposed the rail, or belongs to its firm, can't approve it. Audited, with who approved it and when.",
        inputSchema: { rail_id: z.string().uuid(), note: z.string().max(2000).optional() },
      },
      async ({ rail_id, note }) => {
        const rail = await getRail(rail_id);
        if (!rail) return fail(`No money rail '${rail_id}'`);
        if (rail.status !== "proposed" && rail.status !== "suspended") return fail(`The rail is ${rail.status}; only a proposed or suspended rail can be approved`);
        // Four eyes: whoever proposed a rail, or works for the firm it belongs to, doesn't approve it.
        if (rail.proposed_by === user.id || (await myFirm()) === rail.entity_id) {
          await audit("approve_rail_refused", rail.id, { reason: "own_rail" });
          return fail("You can't approve a rail you proposed or one belonging to your own firm: another admin must");
        }
        const outside = await outsideLicenceCoverage(store, rail.entity_id, rail.states);
        if (outside.length) {
          await audit("approve_rail_refused", rail.id, { outside_licence_coverage: outside });
          return fail("The rail can't be approved: the firm holds no verified licence granting money transmission in some of its states", { outside_licence_coverage: outside });
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
