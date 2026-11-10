import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { productsAnsweredBy } from "./access.js";
import { getPool, liquidityConfigFromEnv, evaluatePool, minimumReserve, OFFERING_NOT_CLEARED, POOL_STATUSES, refreshPool, reportPoolMovement, toPool, toWithdrawal, WITHDRAWAL_STATUSES, authorizePoolMovement, type Pool } from "./liquidity.js";
import { US_STATES } from "./money-rails.js";
import type { ProductHealthService } from "./product-health.js";
import { effectiveRoles, type Store, type User } from "./store.js";

// The tools of liquidity pools. See liquidity.ts for what a pool is and why money only ever moves on an approved rail.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });
const Cents = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const IdemKey = z.string().min(8).max(200).describe("A key you choose for this one action: repeating a call with the same key is the same action, not a second one");
const StateCode = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => US_STATES.has(s), "A US state as ISO 3166-2, e.g. 'us-ny'");

export interface LiquidityRoles {
  admin: boolean;
  licenceProvider: boolean;
  builder: boolean;
  liquidityProvider: boolean;
}

export const hasLiquidityRole = (roles: LiquidityRoles) => roles.admin || roles.licenceProvider || roles.builder || roles.liquidityProvider;

export function registerLiquidityTools(server: McpServer, store: Store, user: User, roles: LiquidityRoles, health: ProductHealthService | null) {
  const now = () => (health ? health.clock() : new Date());
  const healthAgeMs = () => liquidityConfigFromEnv(process.env, health?.config.intervalMs ?? 3_600_000).maxHealthAgeMs;
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const me = async () => (await store.getUser(user.id)) ?? user;
  const myFirm = async () => (await me()).entity_id;
  const noFirm = "You don't belong to a firm yet; an admin adds your firm (register_firm) and you to it (add_entity_member)";

  // A firm's request is only as good as the firm's standing: a suspended firm moves no capital.
  const activeFirm = async () => {
    const firm = await myFirm();
    if (!firm) return { error: noFirm } as const;
    return (await store.getEntity(firm))?.status === "active" ? ({ firm } as const) : ({ error: "Your firm isn't active on Mynt" } as const);
  };

  const positionsOf = async (firm: string, poolId?: string) => {
    const { rows } = await store.db.query(
      `SELECT c.pool_id, c.state, c.created_at, c.exited_at, p.name, p.product_id, p.sandbox, p.status AS pool_status,
         COALESCE(s.contributed_cents, 0) AS contributed_cents, COALESCE(s.withdrawn_cents, 0) AS withdrawn_cents,
         COALESCE(s.pending_in_cents, 0) AS pending_in_cents, COALESCE(s.pending_out_cents, 0) AS pending_out_cents,
         COALESCE(s.unresolved_in_cents, 0) AS unresolved_in_cents, COALESCE(s.unresolved_out_cents, 0) AS unresolved_out_cents,
         COALESCE(s.reversed_in_cents, 0) AS reversed_in_cents, COALESCE(s.reversed_out_cents, 0) AS reversed_out_cents,
         (SELECT COALESCE(sum(w.amount_cents - COALESCE((SELECT sum(m.amount_cents) FROM ${T}.pool_movement_states m WHERE m.withdrawal_id = w.id AND m.ledger_state <> 'released'), 0)), 0)
            FROM ${T}.pool_withdrawals w WHERE w.pool_id = c.pool_id AND w.lp_entity_id = c.lp_entity_id AND w.status IN ('queued', 'parked')) AS queued_cents
       FROM ${T}.pool_commitments c JOIN ${T}.liquidity_pools p ON p.id = c.pool_id LEFT JOIN ${T}.pool_positions s ON s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id
       WHERE c.lp_entity_id = $1 AND ($2::uuid IS NULL OR c.pool_id = $2) ORDER BY c.created_at, c.pool_id`,
      [firm, poolId ?? null],
    );
    return rows.map((r) => {
      const n = (k: string) => Number(r[k]);
      const balance = n("contributed_cents") - n("withdrawn_cents");
      const queued = n("queued_cents");
      return {
        pool_id: r.pool_id as string,
        name: r.name as string,
        product_id: r.product_id as string,
        pool_status: r.pool_status as string,
        sandbox: r.sandbox as boolean, // true: test money, none of it real
        state: r.state as string,
        exited: r.exited_at != null,
        exited_at: r.exited_at == null ? null : new Date(r.exited_at as string).toISOString(),
        contributed_cents: n("contributed_cents"),
        withdrawn_cents: n("withdrawn_cents"),
        balance_cents: balance,
        pending_in_cents: n("pending_in_cents"),
        pending_out_cents: n("pending_out_cents"),
        queued_withdrawal_cents: queued,
        available_to_withdraw_cents: Math.max(0, balance - n("pending_out_cents") - n("unresolved_out_cents") - queued),
        unresolved_in_cents: n("unresolved_in_cents"),
        unresolved_out_cents: n("unresolved_out_cents"),
        reversed_in_cents: n("reversed_in_cents"),
        reversed_out_cents: n("reversed_out_cents"),
      };
    });
  };

  // The firm's movements in a pool, for tracing a position line by line.
  const entriesOf = async (firm: string, poolId: string, sandbox: boolean) => {
    const { rows } = await store.db.query(`SELECT id, kind, amount_cents, amount_settled_cents, movement_id, ledger_state, movement_status, settled_at, refusal, claimed_at FROM ${T}.pool_movement_states WHERE lp_entity_id = $1 AND pool_id = $2 ORDER BY claimed_at, id`, [firm, poolId]);
    return rows.map((r) => ({ sandbox, kind: r.kind as string, amount_cents: Number(r.amount_cents), settled_amount_cents: r.ledger_state === "settled" ? Number(r.amount_settled_cents) : null, movement_id: (r.movement_id as string | null) ?? null, ledger_state: r.ledger_state as string, movement_status: (r.movement_status as string | null) ?? null, refusal: (r.refusal as string | null) ?? null }));
  };

  // A firm may see a pool's terms if it's approved and either sandbox or cleared, or if the firm is already in it.
  const canSee = (p: Pool, committedPools: Set<string>) => committedPools.has(p.id) || (p.approved_at !== null && (p.sandbox || p.offering_cleared) && p.status !== "closed");
  const committedPools = async (firm: string) => {
    const { rows } = await store.db.query(`SELECT pool_id FROM ${T}.pool_commitments WHERE lp_entity_id = $1`, [firm]);
    return new Set(rows.map((r) => r.pool_id as string));
  };

  // ---- the builder ----

  if (roles.builder)
    server.registerTool(
      "create_pool",
      {
        title: "Create a liquidity pool for a product",
        description:
          "Builder: propose a pool that liquidity providers can put capital into, on a product of your firm whose component is sponsored by an approved licence provider (with no approved sponsorship, it's refused). A minimum reserve (basis points of the pool's obligations plus a floor in cents), a notice period in days (0 allowed), and per-firm commitment limits in cents. Sandbox pools move no real money. The sponsor must approve it (approve_pool) and name its rails before it can take commitments.",
        inputSchema: {
          product_id: z.string().min(1),
          component_key: z.string().min(1).describe("The sponsored component this pool serves"),
          name: z.string().min(1).max(200),
          sandbox: z.boolean(),
          min_reserve_bps: z.number().int().min(0).max(1_000_000).describe("Minimum reserve as basis points of obligations, 10000 = 100%"),
          min_reserve_floor_cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
          notice_period_days: z.number().int().min(0).max(3650),
          min_commitment_cents: Cents.default(1).describe("A firm's smallest total position in this pool, integer cents"),
          max_commitment_cents: Cents.describe("A firm's largest total position in this pool, integer cents"),
          sponsor_entity_id: z.string().uuid().optional().describe("If more than one licence provider sponsors the component"),
        },
      },
      async ({ product_id, component_key, name, sandbox, min_reserve_bps, min_reserve_floor_cents, notice_period_days, min_commitment_cents, max_commitment_cents, sponsor_entity_id }) => {
        const u = await me();
        if (!u.entity_id) return fail(noFirm);
        if (min_commitment_cents > max_commitment_cents) return fail("min_commitment_cents can't be more than max_commitment_cents");
        const record = (await productsAnsweredBy(store, u)).find((p) => p.product.id === product_id);
        if (!record || record.entity_id !== u.entity_id) return fail(`No product of your firm with id '${product_id}'`);
        const sponsored = (await store.sponsorships({ product_id, status: "approved" })).filter((s) => s.component_key === component_key && (!sponsor_entity_id || s.provider_entity_id === sponsor_entity_id));
        const sponsors = [...new Set(sponsored.map((s) => s.provider_entity_id))];
        if (!sponsors.length) {
          await audit("create_pool_refused", product_id, { component_key, reason: "no_approved_sponsorship" });
          return fail(`Component '${component_key}' of product '${product_id}' has no approved sponsorship, so it can't have a pool: a licence provider must sponsor it first`);
        }
        if (sponsors.length > 1) return fail("More than one licence provider sponsors that component: name the pool's sponsor with sponsor_entity_id", { sponsors });
        const id = randomUUID();
        await store.db.query(
          `INSERT INTO ${T}.liquidity_pools (id, product_id, component_key, sponsor_entity_id, name, sandbox, status, pause_kind, pause_reason, min_reserve_bps, min_reserve_floor_cents, notice_period_days, min_commitment_cents, max_commitment_cents, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'paused', 'awaiting_approval', 'Waiting for the sponsoring licence provider to approve it', $7, $8, $9, $10, $11, $12)`,
          [id, product_id, component_key, sponsors[0], name, sandbox, min_reserve_bps, min_reserve_floor_cents, notice_period_days, min_commitment_cents, max_commitment_cents, user.id],
        );
        await audit("create_pool", id, { product_id, component_key, sponsor: sponsors[0], sandbox });
        return json(await getPool(store, id));
      },
    );

  // ---- the sponsor ----

  if (roles.licenceProvider)
    server.registerTool(
      "approve_pool",
      {
        title: "Approve a liquidity pool",
        description:
          "Licence provider: approve a pool on a product your firm sponsors, naming the approved money rails its capital moves on: a deposit rail (direction deposit or on_ramp) and a withdrawal rail (direction payout or off_ramp), both your firm's and approved. Every state the deposit rail serves must also be served by the withdrawal rail, so capital that came in can get out. Deposits and withdrawals are refused without them, and later refused at the chokepoint if a named rail is suspended or revoked: a pool never follows a replacement rail.",
        inputSchema: {
          pool_id: z.string().uuid(),
          deposit_rail_id: z.string().uuid(),
          withdrawal_rail_id: z.string().uuid(),
          note: z.string().max(2000).optional(),
        },
      },
      async ({ pool_id, deposit_rail_id, withdrawal_rail_id, note }) => {
        const firm = await myFirm();
        if (!firm) return fail(noFirm);
        const pool = await getPool(store, pool_id);
        if (!pool || pool.sponsor_entity_id !== firm) return fail(`No pool '${pool_id}' sponsored by your firm`);
        if (pool.approved_at) return fail("This pool is already approved");
        if (pool.status === "closed") return fail("This pool is closed");
        const sponsored = (await store.sponsorships({ product_id: pool.product_id, provider_entity_id: firm, status: "approved" })).some((s) => s.component_key === pool.component_key);
        if (!sponsored) return fail("Your firm no longer has an approved sponsorship of this pool's component");
        const railRow = async (id: string) => (await store.db.query(`SELECT * FROM ${T}.money_rails WHERE id = $1`, [id])).rows[0];
        const [depositRail, withdrawalRail] = await Promise.all([railRow(deposit_rail_id), railRow(withdrawal_rail_id)]);
        const rails = (r: typeof depositRail, id: string, directions: string[], label: string) => {
          if (!r || r.entity_id !== firm) return `No ${label} rail '${id}' of your firm`;
          if (r.status !== "approved") return `That ${label} rail is ${r.status}; only an approved rail can carry a pool's capital (see list_rails)`;
          if (!directions.includes(r.direction as string)) return `That ${label} rail moves ${r.direction}; it needs to be ${directions.join(" or ")}`;
          return null;
        };
        let bad = rails(depositRail, deposit_rail_id, ["deposit", "on_ramp"], "deposit") ?? rails(withdrawalRail, withdrawal_rail_id, ["payout", "off_ramp"], "withdrawal");
        if (!bad) {
          const outside = (depositRail!.states as string[]).filter((s) => !(withdrawalRail!.states as string[]).includes(s));
          if (outside.length) bad = `The deposit rail serves states the withdrawal rail doesn't (${outside.join(", ")}): capital that came in there couldn't get out`;
        }
        if (bad) {
          await audit("approve_pool_refused", pool_id, { reason: bad });
          return fail(bad);
        }
        const { rows } = await store.db.query(
          // A live pool stays paused until the worker has looked at its health once; a sandbox pool has nothing to protect.
          `UPDATE ${T}.liquidity_pools SET status = CASE WHEN sandbox THEN 'open' ELSE 'paused' END, pause_kind = CASE WHEN sandbox THEN NULL ELSE 'health' END, pause_reason = CASE WHEN sandbox THEN NULL ELSE 'Approved; waiting for the worker to check its health for the first time' END, deposit_rail_id = $2, withdrawal_rail_id = $3, approved_by = $4, approved_at = now(), updated_at = now()
           WHERE id = $1 AND approved_at IS NULL AND status = 'paused' AND pause_kind = 'awaiting_approval' RETURNING *`,
          [pool_id, deposit_rail_id, withdrawal_rail_id, user.id],
        );
        if (!rows[0]) return fail("The pool was approved by another call just now");
        await audit("approve_pool", pool_id, { deposit_rail_id, withdrawal_rail_id, note: note ?? null });
        return json(toPool(rows[0]));
      },
    );

  if (roles.licenceProvider)
    server.registerTool(
      "report_pool_movement",
      {
        title: "Report what became of a pool movement",
        description:
          "Licence provider: say what became of a deposit or withdrawal of a pool your firm sponsors (submitted, settled, failed, or returned after settling). Mynt holds no funds, so it learns of a pool's money movements only from you, on the rail you approved. Find them in list_withdrawals and list_money_movements. A position moves only on settled, and a movement Mynt swept with no answer can be settled or failed here too. A live settlement needs external_ref, and a settled amount can't be more than was asked.",
        inputSchema: {
          movement_id: z.string().uuid(),
          outcome: z.enum(["submitted", "settled", "failed", "returned"]),
          external_ref: z.string().max(200).optional(),
          settled_amount_cents: Cents.optional().describe("What actually settled, if it isn't the amount asked"),
        },
      },
      async ({ movement_id, outcome, external_ref, settled_amount_cents }) => {
        const firm = await myFirm();
        if (!firm) return fail(noFirm);
        const { rows } = await store.db.query(`SELECT p.sponsor_entity_id FROM ${T}.pool_movements pm JOIN ${T}.liquidity_pools p ON p.id = pm.pool_id WHERE pm.movement_id = $1`, [movement_id]);
        if (rows[0]?.sponsor_entity_id !== firm) return fail(`No pool movement '${movement_id}' of a pool your firm sponsors`);
        const out = await reportPoolMovement(store, movement_id, outcome, { external_ref: external_ref ?? null, settled_amount_cents: settled_amount_cents ?? null }, now());
        if (!out.found) return fail(`No pool movement '${movement_id}'`);
        if ("refused" in out) {
          if (out.refused === "over_settlement") {
            await audit("pool_movement_over_settlement", movement_id, { pool_id: out.pool_id, amount_cents: out.amount_cents, settled_amount_cents, external_ref: external_ref ?? null, sandbox: out.sandbox });
            return fail(`That settlement (${settled_amount_cents} cents) is more than the ${out.amount_cents} cents asked for, so it's refused and Mynt's admins have been flagged`, { code: out.refused, sandbox: out.sandbox });
          }
          if (out.refused === "external_ref_required") return fail("A live settlement needs external_ref: the partner's reference for the money that moved", { code: out.refused, sandbox: out.sandbox });
          await audit("pool_late_settlement_refused", movement_id, { pool_id: out.pool_id, amount_cents: out.amount_cents, external_ref: external_ref ?? null, code: out.refused, sandbox: out.sandbox });
          return fail(out.refused === "overdrawn" ? "Settling that would take the firm's position below zero, counting what's on its way out, so it's refused and Mynt's admins have been flagged" : "That withdrawal was written off and its amount has since been paid again, so this settlement would pay it twice. It's refused and Mynt's admins have been flagged", { code: out.refused, sandbox: out.sandbox });
        }
        await audit("report_pool_movement", movement_id, { outcome, external_ref: external_ref ?? null, settled_amount_cents: settled_amount_cents ?? null, status: out.status, sandbox: out.sandbox });
        return json(out);
      },
    );

  // ---- an admin: the securities gate ----

  if (roles.admin)
    server.registerTool(
      "set_pool_offering_cleared",
      {
        title: "Record that a pool's offering was cleared",
        description:
          "Admin: record that this pool's offering has been cleared for real commitments, and the legal basis (who advised, and on what exemption or registration). Pooled investor capital with withdrawal rights may be a securities offering, so real (non-sandbox) commitments are refused until this is set. Setting cleared to false stops new commitments; money already in stays subject to the withdrawal queue. Whoever belongs to the pool's product firm or its sponsor can't set this. Audited.",
        inputSchema: { pool_id: z.string().uuid(), cleared: z.boolean(), legal_basis: z.string().min(10).max(2000) },
      },
      async ({ pool_id, cleared, legal_basis }) => {
        const pool = await getPool(store, pool_id);
        if (!pool) return fail(`No pool '${pool_id}'`);
        const firm = await myFirm();
        const record = await store.getProduct(pool.product_id);
        if (firm && (firm === pool.sponsor_entity_id || firm === record?.entity_id)) {
          await audit("set_pool_offering_cleared_refused", pool_id, { reason: "own_pool" });
          return fail("You can't clear the offering of a pool belonging to your own firm: another admin must");
        }
        const { rows } = await store.db.query(`UPDATE ${T}.liquidity_pools SET offering_cleared = $2, offering_cleared_by = $3, offering_cleared_at = now(), offering_legal_basis = $4, updated_at = now() WHERE id = $1 RETURNING *`, [pool_id, cleared, user.id, legal_basis]);
        await audit("set_pool_offering_cleared", pool_id, { cleared, legal_basis });
        return json(toPool(rows[0]));
      },
    );

  // ---- pausing ----

  if (roles.admin || roles.licenceProvider) {
    const canControl = async (pool: Pool) => roles.admin || pool.sponsor_entity_id === (await myFirm());
    server.registerTool(
      "pause_pool",
      {
        title: "Pause or close a liquidity pool",
        description:
          "Admin, or the pool's sponsor: stop a pool's payments and new commitments, saying why. The worker never lifts a pause made here; resume_pool does. With close: true, the pool stops taking commitments for good but keeps paying its queue, subject to the same checks. A sponsor can't change or close a pool an admin has paused.",
        inputSchema: { pool_id: z.string().uuid(), reason: z.string().min(3).max(1000), close: z.boolean().default(false) },
        annotations: { destructiveHint: true },
      },
      async ({ pool_id, reason, close }) => {
        const pool = await getPool(store, pool_id);
        if (!pool || !(await canControl(pool))) return fail(`No pool '${pool_id}' you can control`);
        if (pool.status === "closed") return fail("This pool is closed");
        if (pool.paused_by_admin && !roles.admin) {
          await audit("pause_pool_refused", pool_id, { reason: "admin_pause", close });
          return fail("An admin paused this pool: an admin must resume it");
        }
        const { rows } = close
          ? await store.db.query(`UPDATE ${T}.liquidity_pools SET status = 'closed', pause_kind = NULL, pause_reason = $2, updated_at = now() WHERE id = $1 AND status <> 'closed' AND ($3 OR NOT paused_by_admin) RETURNING *`, [pool_id, reason, roles.admin])
          : await store.db.query(
              `UPDATE ${T}.liquidity_pools SET status = 'paused', pause_kind = 'manual', pause_reason = $2, paused_by_admin = $3, paused_at = now(), updated_at = now()
               WHERE id = $1 AND status <> 'closed' AND pause_kind IS DISTINCT FROM 'awaiting_approval' AND ($3 OR NOT paused_by_admin) RETURNING *`,
              [pool_id, reason, roles.admin],
            );
        if (!rows[0]) return fail("That can't be done right now: a pool awaiting approval isn't running yet, and an admin's pause stands until an admin lifts it");
        await audit(close ? "close_pool" : "pause_pool", pool_id, { reason });
        return json(toPool(rows[0]));
      },
    );
    server.registerTool(
      "set_pool_firm_state",
      {
        title: "Correct a firm's state in a pool",
        description: "Admin, or the pool's sponsor: correct the US state a firm's capital moves from in this pool, when it's wrong or its rails no longer serve it. Its parked withdrawal requests go back to their place in the queue. The new state must be one the pool's withdrawal rail serves. Audited, with the old and new state.",
        inputSchema: { pool_id: z.string().uuid(), lp_entity_id: z.string().uuid(), state: StateCode, reason: z.string().min(3).max(1000) },
      },
      async ({ pool_id, lp_entity_id, state, reason }) => {
        const pool = await getPool(store, pool_id);
        if (!pool || !(await canControl(pool))) return fail(`No pool '${pool_id}' you can control`);
        const { rows: rail } = await store.db.query(`SELECT states FROM ${T}.money_rails WHERE id = $1`, [pool.withdrawal_rail_id]);
        if (!rail[0] || !(rail[0].states as string[]).includes(state)) return fail(`The pool's withdrawal rail doesn't serve ${state}`);
        const { rows: old } = await store.db.query(`SELECT state FROM ${T}.pool_commitments WHERE pool_id = $1 AND lp_entity_id = $2`, [pool_id, lp_entity_id]);
        if (!old[0]) return fail("That firm has no commitment in this pool");
        await store.db.query(`UPDATE ${T}.pool_commitments SET state = $3 WHERE pool_id = $1 AND lp_entity_id = $2`, [pool_id, lp_entity_id, state]);
        const { rows: lifted } = await store.db.query(`UPDATE ${T}.pool_withdrawals SET status = 'queued', status_reason = NULL, parked_at = NULL WHERE pool_id = $1 AND lp_entity_id = $2 AND status = 'parked' RETURNING id`, [pool_id, lp_entity_id]);
        await audit("set_pool_firm_state", pool_id, { lp_entity_id, was: old[0].state, state, reason, unparked: lifted.length });
        return json({ pool_id, lp_entity_id, state, sandbox: pool.sandbox, unparked: lifted.map((r) => r.id as string) });
      },
    );
    server.registerTool(
      "resume_pool",
      {
        title: "Resume a paused liquidity pool",
        description: "Admin, or the pool's sponsor: lift a pause made with pause_pool. A sponsor can't lift an admin's pause. A pause the worker made for health or sponsorship reasons lifts itself when the cause is gone. Audited.",
        inputSchema: { pool_id: z.string().uuid() },
      },
      async ({ pool_id }) => {
        const pool = await getPool(store, pool_id);
        if (!pool || !(await canControl(pool))) return fail(`No pool '${pool_id}' you can control`);
        if (pool.status !== "paused" || pool.pause_kind !== "manual") return fail(`This pool isn't under a manual pause (status ${pool.status}${pool.pause_kind ? `, ${pool.pause_kind}` : ""})`);
        if (pool.paused_by_admin && !roles.admin) return fail("An admin paused this pool: an admin must resume it");
        const { rows } = await store.db.query(`UPDATE ${T}.liquidity_pools SET status = 'open', pause_kind = NULL, pause_reason = NULL, paused_by_admin = false, paused_at = NULL, updated_at = now() WHERE id = $1 AND status = 'paused' AND pause_kind = 'manual' RETURNING *`, [pool_id]);
        if (!rows[0]) return fail("The pool was changed by another call just now");
        await audit("resume_pool", pool_id, {});
        return json(toPool(rows[0]));
      },
    );
  }

  // ---- reading ----

  if (hasLiquidityRole(roles))
    server.registerTool(
      "list_pools",
      {
        title: "Liquidity pools",
        description:
          "Liquidity pools you may see: an admin all of them; a builder its own products'; a licence provider those it sponsors; a liquidity provider those approved and either sandbox or with a cleared offering, plus any it's committed to. Each with its reserve terms, notice period, commitment limits, status and pause reason, in integer cents.",
        inputSchema: { product_id: z.string().optional(), status: z.enum(POOL_STATUSES).optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ product_id, status }) => {
        const { rows } = await store.db.query(`SELECT * FROM ${T}.liquidity_pools WHERE ($1::text IS NULL OR product_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY created_at, id`, [product_id ?? null, status ?? null]);
        const firm = await myFirm();
        const committed = firm ? await committedPools(firm) : new Set<string>();
        const owned = roles.builder && firm ? new Set((await productsAnsweredBy(store, await me())).filter((p) => p.entity_id === firm).map((p) => p.product.id)) : new Set<string>();
        const pools = rows.map(toPool).filter((p) => roles.admin || (roles.builder && owned.has(p.product_id)) || (roles.licenceProvider && p.sponsor_entity_id === firm) || (roles.liquidityProvider && canSee(p, committed)));
        await audit("list_pools", product_id ?? "all", { returned: pools.length });
        return json(pools);
      },
    );

  if (roles.admin || roles.licenceProvider || roles.builder || roles.liquidityProvider)
    server.registerTool(
      "list_withdrawals",
      {
        title: "Withdrawal requests",
        description:
          "Withdrawal requests in queue order, each with its status (queued, paying, paid, paid_short, returned, cancelled, no_balance, parked), what's actually settled and what's on its way, why it's waiting, whether it's test money (sandbox), and each ledger movement with the pool's hold state: a sponsor sees there if the pool is held before it moves money on a requested row. An admin sees all; a licence provider its pools'; a builder its products'; a liquidity provider its own.",
        inputSchema: { pool_id: z.string().uuid().optional(), status: z.enum(WITHDRAWAL_STATUSES).optional() },
        annotations: { readOnlyHint: true },
      },
      async ({ pool_id, status }) => {
        const firm = await myFirm();
        const { rows } = await store.db.query(
          `SELECT w.*, p.name AS pool_name, p.sandbox, p.status AS pool_status, p.pause_reason, p.hold_reason, p.sponsor_entity_id, p.product_id FROM ${T}.pool_withdrawals w JOIN ${T}.liquidity_pools p ON p.id = w.pool_id
           WHERE ($1::uuid IS NULL OR w.pool_id = $1) AND ($2::text IS NULL OR w.status = $2) ORDER BY w.pool_id, w.seq LIMIT 500`,
          [pool_id ?? null, status ?? null],
        );
        const owned = roles.builder && firm ? new Set((await productsAnsweredBy(store, await me())).filter((p) => p.entity_id === firm).map((p) => p.product.id)) : new Set<string>();
        const allowed = rows.filter((w) => roles.admin || (roles.licenceProvider && w.sponsor_entity_id === firm) || (roles.builder && owned.has(w.product_id as string)) || (roles.liquidityProvider && w.lp_entity_id === firm));
        const claims = allowed.length
          ? (await store.db.query(`SELECT withdrawal_id, amount_cents, amount_settled_cents, ledger_state, movement_id, movement_status FROM ${T}.pool_movement_states WHERE withdrawal_id = ANY($1::uuid[]) ORDER BY claimed_at`, [allowed.map((w) => w.id)])).rows
          : [];
        await audit("list_withdrawals", pool_id ?? "all", { returned: allowed.length });
        return json(
          allowed.map((w) => {
            const mine = claims.filter((c) => c.withdrawal_id === w.id);
            const sum = (states: string[]) => mine.filter((c) => states.includes(c.ledger_state as string)).reduce((n, c) => n + Number(c.amount_cents), 0);
            const settledCents = mine.filter((c) => c.ledger_state === "settled").reduce((n, c) => n + Number(c.amount_settled_cents), 0);
            const poolHold = (w.pool_status === "paused" ? (w.pause_reason as string | null) : null) ?? (w.hold_reason as string | null) ?? null;
            const paying = w.status === "queued" || w.status === "paying" || w.status === "parked";
            const waiting = w.status === "parked" ? (w.status_reason as string) : paying && new Date(w.eligible_at as string) > now() ? `Waiting out the notice period until ${new Date(w.eligible_at as string).toISOString()}` : paying ? ((w.pool_status === "paused" ? (w.pause_reason as string | null) : null) ?? (w.hold_reason as string | null) ?? null) : null;
            return {
              ...toWithdrawal(w),
              pool_name: w.pool_name as string,
              sandbox: w.sandbox as boolean,
              settled_cents: settledCents,
              in_flight_cents: sum(["in_flight"]),
              unresolved_cents: sum(["unresolved"]),
              reversed_cents: sum(["reversed"]),
              waiting_reason: waiting,
              movement_ids: mine.map((c) => c.movement_id as string | null).filter(Boolean),
              movements: mine.map((c) => ({ movement_id: (c.movement_id as string | null) ?? null, amount_cents: Number(c.amount_cents), ledger_state: c.ledger_state as string, movement_status: (c.movement_status as string | null) ?? null, sandbox: w.sandbox as boolean, pool_hold: poolHold })),
            };
          }),
        );
      },
    );

  if (!roles.liquidityProvider) return;

  // ---- the liquidity provider ----

  server.registerTool(
    "commit_to_pool",
    {
      title: "Commit capital to a pool",
      description:
        "Liquidity provider: commit capital to a pool. This asks for a deposit, in integer cents, on the pool's approved rail; your position counts only what has settled. Real (non-sandbox) commitments are refused until an admin records that the pool's offering was cleared and on what legal basis, because pooled investor capital with withdrawal rights may be a securities offering. Mynt never holds your funds. state: the US state your capital moves from, which the rail must serve.",
      inputSchema: { pool_id: z.string().uuid(), amount_cents: Cents, state: StateCode, idempotency_key: IdemKey },
    },
    async ({ pool_id, amount_cents, state, idempotency_key }) => {
      const standing = await activeFirm();
      if ("error" in standing) return fail(standing.error!);
      const firm = standing.firm;
      const pool = await getPool(store, pool_id);
      if (!pool || !pool.approved_at) return fail(`No approved pool '${pool_id}'`);
      const refuse = async (message: string, code: string, extra: Record<string, unknown> = {}) => {
        await audit("commit_to_pool_refused", pool_id, { code, amount_cents });
        return fail(message, { code, sandbox: pool.sandbox, ...extra });
      };
      const record = await store.getProduct(pool.product_id);
      if (firm === pool.sponsor_entity_id || firm === record?.entity_id) return refuse("A pool's sponsor or its product's firm can't be a liquidity provider in it", "own_pool");
      if (!pool.sandbox && record?.status !== "published") return fail("This pool's product isn't published, so it can't take real money");
      const id = randomUUID();
      const key = `pool-deposit:${pool_id}:${firm}:${idempotency_key}`;
      const { rows: earlier } = await store.db.query(`SELECT pm.state, pm.amount_cents, pm.movement_id, m.status AS movement_status FROM ${T}.pool_movements pm LEFT JOIN ${T}.money_movements m ON m.id = pm.movement_id WHERE pm.idempotency_key = $1`, [key]);
      if (earlier[0]) {
        if (Number(earlier[0].amount_cents) !== amount_cents) return refuse("That idempotency key was already used for a different commitment", "idempotency_conflict");
        if (earlier[0].state === "refused") return refuse("That commitment was refused earlier; use a new idempotency key to try again", "previously_refused");
        if (earlier[0].movement_id) {
          await audit("commit_to_pool", pool_id, { amount_cents, movement_id: earlier[0].movement_id, sandbox: pool.sandbox, replay: true });
          return json({ pool_id, amount_cents, sandbox: pool.sandbox, movement_id: earlier[0].movement_id, movement_status: earlier[0].movement_status, replay: true, position: (await positionsOf(firm, pool_id))[0] });
        }
      }
      // Real capital comes in only when a snapshot Mynt trusts says the pool is healthy or short of its reserve: otherwise
      // there's no telling what it could pay back.
      if (!pool.sandbox && !pool.offering_cleared) return refuse(OFFERING_NOT_CLEARED, "offering_not_cleared");
      if (!pool.sandbox && (pool.status === "open" || (pool.status === "paused" && pool.pause_kind === "health"))) {
        const gate = await evaluatePool(store, health, pool, now(), healthAgeMs());
        if (!gate.ok && !gate.shortfall) return refuse(`This pool isn't taking commitments right now: ${gate.reason}`, "health_unconfirmed");
      }
      const { rows } = await store.db.query(`SELECT * FROM ${T}.reserve_pool_deposit($1, $2, $3, $4, $5, $6, $7, $8)`, [id, key, pool_id, firm, amount_cents, state, user.id, now().toISOString()]);
      const r = rows[0] as { o_outcome: string; o_id: string | null; o_state: string | null; o_exposure: unknown };
      if (r.o_outcome === "offering_not_cleared") return refuse(OFFERING_NOT_CLEARED, "offering_not_cleared");
      if (r.o_outcome === "pool_not_open") return refuse(`This pool isn't taking commitments right now (${pool.status}${pool.pause_reason ? `: ${pool.pause_reason}` : ""})`, "pool_not_open");
      if (r.o_outcome === "over_limit") return refuse(`That would take your position to more than this pool's limit of ${pool.max_commitment_cents} cents per firm`, "over_limit", { exposure_cents: Number(r.o_exposure), limit_cents: pool.max_commitment_cents });
      if (r.o_outcome === "under_minimum") return refuse(`A firm's position in this pool must be at least ${pool.min_commitment_cents} cents`, "under_minimum");
      if (r.o_outcome === "idempotency_conflict") return refuse("That idempotency key was already used for a different commitment", "idempotency_conflict");
      if (r.o_outcome === "state_locked") return refuse(`Your position in this pool moves from ${r.o_state}: that can't change while you hold one`, "state_locked");
      const pmId = r.o_id!;
      const { rows: pm } = await store.db.query(`SELECT * FROM ${T}.pool_movements WHERE id = $1`, [pmId]);
      const verdict = await authorizePoolMovement(store, pool, pm[0] as never);
      if (!verdict.allowed) {
        await refreshPool(store, pool_id, now());
        return refuse(verdict.message, verdict.code);
      }
      await audit("commit_to_pool", pool_id, { amount_cents, movement_id: verdict.movement_id, state, sandbox: pool.sandbox, replay: r.o_outcome === "replay" });
      return json({ pool_id, amount_cents, sandbox: pool.sandbox, movement_id: verdict.movement_id, movement_status: verdict.status, replay: r.o_outcome === "replay", note: "Your position counts this only once the movement settles.", position: (await positionsOf(firm, pool_id))[0] });
    },
  );

  server.registerTool(
    "request_withdrawal",
    {
      title: "Ask to take capital out of a pool",
      description:
        "Liquidity provider: join a pool's withdrawal queue for up to what you have settled there. First in, first out, nobody jumps it; each request is paid only after the pool's notice period and only as far as the latest verified health snapshot keeps the pool above its minimum reserve, partly if that's all it allows.",
      inputSchema: { pool_id: z.string().uuid(), amount_cents: Cents, idempotency_key: IdemKey },
    },
    async ({ pool_id, amount_cents, idempotency_key }) => {
      const standing = await activeFirm();
      if ("error" in standing) return fail(standing.error!);
      const firm = standing.firm;
      const pool = await getPool(store, pool_id);
      if (!pool) return fail(`No pool '${pool_id}'`);
      const id = randomUUID();
      const eligible = new Date(now().getTime() + pool.notice_period_days * 86_400_000);
      const { rows } = await store.db.query(`SELECT * FROM ${T}.request_pool_withdrawal($1, $2, $3, $4, $5, $6, $7, $8)`, [id, `pool-withdrawal-request:${pool_id}:${firm}:${idempotency_key}`, pool_id, firm, amount_cents, user.id, now().toISOString(), eligible.toISOString()]);
      const r = rows[0] as { o_outcome: string; o_id: string | null; o_available: unknown };
      if (r.o_outcome === "insufficient") {
        await audit("request_withdrawal_refused", pool_id, { amount_cents, available_cents: Number(r.o_available) });
        return fail(`You can withdraw at most ${Number(r.o_available)} cents from this pool right now: what has settled, less what's already on its way out or queued`, { available_cents: Number(r.o_available) });
      }
      if (r.o_outcome === "idempotency_conflict") return fail("That idempotency key was already used for a different request");
      if (r.o_outcome === "no_pool") return fail(`No pool '${pool_id}'`);
      await audit("request_withdrawal", r.o_id!, { pool_id, amount_cents, replay: r.o_outcome === "replay" });
      const { rows: row } = await store.db.query(`SELECT * FROM ${T}.pool_withdrawals WHERE id = $1`, [r.o_id]);
      return json({ ...toWithdrawal(row[0]), sandbox: pool.sandbox, replay: r.o_outcome === "replay" });
    },
  );

  server.registerTool(
    "cancel_withdrawal",
    {
      title: "Cancel a withdrawal request",
      description: "Liquidity provider: leave the queue with one of your requests. Anything already on its way carries on; only the rest is cancelled. A fully-claimed request (paying) can't be cancelled; a parked one can.",
      inputSchema: { withdrawal_id: z.string().uuid() },
    },
    async ({ withdrawal_id }) => {
      const standing = await activeFirm();
      if ("error" in standing) return fail(standing.error!);
      const { rows } = await store.db.query(`SELECT * FROM ${T}.cancel_pool_withdrawal($1, $2, $3)`, [withdrawal_id, standing.firm, now().toISOString()]);
      const r = rows[0] as { o_outcome: string; o_status: string | null };
      if (r.o_outcome === "no_request") return fail(`No withdrawal request '${withdrawal_id}' of your firm`);
      if (r.o_outcome === "not_queued") return fail(`That request is ${r.o_status}; only a queued request can be cancelled`);
      await audit("cancel_withdrawal", withdrawal_id, {});
      const { rows: owner } = await store.db.query(`SELECT p.sandbox FROM ${T}.pool_withdrawals w JOIN ${T}.liquidity_pools p ON p.id = w.pool_id WHERE w.id = $1`, [withdrawal_id]);
      return json({ withdrawal_id, status: "cancelled", sandbox: owner[0].sandbox as boolean });
    },
  );

  server.registerTool(
    "list_my_positions",
    {
      title: "Your positions in pools",
      description:
        "Liquidity provider: your position in each pool, in integer cents: contributed, withdrawn and balance (from settled movements only), what's still on its way in or out, what's unresolved (its outcome isn't known, so it counts toward neither), what was reversed, and what's available to withdraw now. include_entries: every movement behind each position.",
      inputSchema: { pool_id: z.string().uuid().optional(), include_entries: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async ({ pool_id, include_entries }) => {
      const firm = await myFirm();
      if (!firm) return fail(noFirm);
      const positions = await positionsOf(firm, pool_id);
      await audit("list_my_positions", pool_id ?? "all", { returned: positions.length });
      return json(include_entries ? await Promise.all(positions.map(async (p) => ({ ...p, entries: await entriesOf(firm, p.pool_id, p.sandbox) }))) : positions);
    },
  );

  server.registerTool(
    "list_pools_with_health",
    {
      title: "Pools side by side, with their health",
      description:
        "Liquidity provider: the pools you may see, side by side: coverage, trend, gaps, verified status and reserve headroom. The numbers are shown only for pools of products you're committed to; a figure that can't be measured or isn't yours to see is null with its reason.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const firm = await myFirm();
      if (!firm) return fail(noFirm);
      const committed = await committedPools(firm);
      const { rows } = await store.db.query(`SELECT * FROM ${T}.liquidity_pools ORDER BY created_at, id`);
      const pools = rows.map(toPool).filter((p) => canSee(p, committed));
      const out = [];
      for (const pool of pools) out.push(await poolHealthRow(pool));
      await audit("list_pools_with_health", "all", { returned: out.length });
      return json(out);
    },
  );

  // The side-by-side row for one pool. Numbers need entitlement, which product health decides.
  async function poolHealthRow(pool: Pool) {
    const base = { pool_id: pool.id, name: pool.name, product_id: pool.product_id, status: pool.status, pause_kind: pool.pause_kind, pause_reason: pool.pause_reason, hold_reason: pool.hold_reason, sandbox: pool.sandbox, min_reserve_bps: pool.min_reserve_bps, min_reserve_floor_cents: pool.min_reserve_floor_cents, notice_period_days: pool.notice_period_days };
    const blank = (reason: string) => ({ ...base, coverage_bps: null, coverage_reason: reason, reserves_cents: null, obligations_cents: null, headroom_cents: null, headroom_reason: reason, trend: { direction: null, reason, coverage_series_bps: [] as number[] }, gaps: null, gaps_reason: reason, verified: null, verified_reason: reason, snapshot: null });
    if (!health) return blank("Product health isn't running on this Mynt");
    if (!(await health.entitlement(user, pool.product_id))) return blank("Commit to a pool of this product to read its health");
    let got: Awaited<ReturnType<ProductHealthService["get"]>>;
    try {
      got = await health.get(user, pool.product_id, pool.id, 6);
    } catch (e) {
      return blank(`The pool's health couldn't be read: ${(e as Error).message.slice(0, 200)}`);
    }
    if (!got.latest || !got.latest.report) return { ...blank(got.latest ? "The latest snapshot has no report" : "No health snapshot of this pool yet"), gaps: got.gaps, gaps_reason: null, verified: got.latest?.verified ?? null, verified_reason: got.latest?.verified === undefined ? "No health snapshot of this pool yet" : null, snapshot: got.latest ? { sequence: got.latest.sequence, source: got.latest.source, status: got.latest.status, period_end: got.latest.period_end } : null };
    const f = got.latest.report.figures;
    const required = f.obligations_cents.value === null ? null : minimumReserve(pool, f.obligations_cents.value);
    const headroom = required === null || f.reserves_cents.value === null ? null : Number(BigInt(f.reserves_cents.value) - required);
    const series = got.history.map((h) => h.report?.figures.coverage_bps.value ?? null).reverse();
    const measured = series.filter((v): v is number => v !== null);
    const trend = measured.length < 2 ? { direction: null, reason: "Fewer than two snapshots with measured coverage", coverage_series_bps: measured } : { direction: measured[measured.length - 1] > measured[measured.length - 2] ? ("up" as const) : measured[measured.length - 1] < measured[measured.length - 2] ? ("down" as const) : ("flat" as const), reason: null, coverage_series_bps: measured };
    return {
      ...base,
      coverage_bps: f.coverage_bps.value,
      coverage_reason: f.coverage_bps.reason,
      reserves_cents: f.reserves_cents.value,
      obligations_cents: f.obligations_cents.value,
      headroom_cents: headroom,
      headroom_reason: headroom === null ? "Headroom needs both reserves and obligations from the snapshot" : null,
      trend,
      gaps: got.gaps,
      gaps_reason: null,
      verified: got.latest.verified,
      verified_reason: null,
      snapshot: { sequence: got.latest.sequence, source: got.latest.source, status: got.latest.status, period_end: got.latest.period_end, as_of: got.latest.report.ledger_as_of },
    };
  }
}

export const rolesFrom = (user: User): LiquidityRoles => {
  const r = effectiveRoles(user.roles);
  return { admin: r.includes("admin"), licenceProvider: r.includes("license_provider"), builder: r.includes("innovator"), liquidityProvider: r.includes("liquidity_provider") };
};
