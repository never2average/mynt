// The tables and atomic functions of liquidity pools, run with the store's schema. See liquidity.ts for what they mean.
//
// Every function here that changes a pool's queue or its positions starts by locking the pool's row, the way
// reserve_money_movement locks the rail: everything that claims, requests, cancels or commits on one pool happens one at
// a time, and each statement in it sees what the one before it committed.

const T = "financial_products";

export const LIQUIDITY_TABLES = `
  CREATE TABLE IF NOT EXISTS ${T}.liquidity_pools (
    id uuid PRIMARY KEY,
    product_id text NOT NULL,
    component_key text NOT NULL,
    sponsor_entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    name text NOT NULL,
    currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
    sandbox boolean NOT NULL,
    status text NOT NULL CHECK (status IN ('open', 'paused', 'closed')),
    pause_kind text CHECK (pause_kind IN ('awaiting_approval', 'manual', 'governance', 'health')),
    pause_reason text,
    paused_by_admin boolean NOT NULL DEFAULT false,
    paused_at timestamptz,
    hold_reason text, -- open or closed, but the queue can't move right now (a rail refused, no headroom left)
    min_reserve_bps integer NOT NULL CHECK (min_reserve_bps >= 0),
    min_reserve_floor_cents bigint NOT NULL CHECK (min_reserve_floor_cents >= 0),
    notice_period_days integer NOT NULL CHECK (notice_period_days >= 0),
    min_commitment_cents bigint NOT NULL DEFAULT 1 CHECK (min_commitment_cents > 0),
    max_commitment_cents bigint NOT NULL CHECK (max_commitment_cents > 0),
    deposit_rail_id uuid REFERENCES ${T}.money_rails(id),
    withdrawal_rail_id uuid REFERENCES ${T}.money_rails(id),
    created_by uuid,
    approved_by uuid,
    approved_at timestamptz,
    offering_cleared boolean NOT NULL DEFAULT false,
    offering_cleared_by uuid,
    offering_cleared_at timestamptz,
    offering_legal_basis text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (min_commitment_cents <= max_commitment_cents)
  );
  -- Lock-in and top-ups. Pools from before these existed keep what they had: no lock-in, top-ups taken while paused for
  -- health. lock_in_days: how long each commitment stays in from its settlement. topups_when_health_paused: whether new
  -- capital comes in while the worker has the pool paused for health (a sponsor's or admin's pause, and a closed pool,
  -- refuse it whatever this says). product_lock_in_days: the product's own lock-in when the terms were last set, the
  -- floor they can't go below. approved_terms: what the sponsor approved (null for pools approved before it was
  -- recorded). proposed_terms: a builder's change since, waiting for the sponsor's new approval.
  ALTER TABLE ${T}.liquidity_pools ADD COLUMN IF NOT EXISTS lock_in_days integer NOT NULL DEFAULT 0 CHECK (lock_in_days >= 0);
  ALTER TABLE ${T}.liquidity_pools ADD COLUMN IF NOT EXISTS topups_when_health_paused boolean NOT NULL DEFAULT true;
  ALTER TABLE ${T}.liquidity_pools ADD COLUMN IF NOT EXISTS product_lock_in_days integer;
  ALTER TABLE ${T}.liquidity_pools ADD COLUMN IF NOT EXISTS approved_terms jsonb;
  ALTER TABLE ${T}.liquidity_pools ADD COLUMN IF NOT EXISTS proposed_terms jsonb;
  CREATE INDEX IF NOT EXISTS liquidity_pools_product_idx ON ${T}.liquidity_pools (product_id);
  -- What needs a person, until a person has dealt with it: not a note that ages out. negative_balance: a settlement or
  -- return took a firm below zero. double_claim: a settlement refused because the amount was re-paid another way.
  -- link_conflict: a ledger row exists that its claim can't be tied to.
  CREATE TABLE IF NOT EXISTS ${T}.pool_flags (
    id uuid PRIMARY KEY,
    pool_id uuid NOT NULL REFERENCES ${T}.liquidity_pools(id),
    lp_entity_id uuid REFERENCES ${T}.entities(id),
    movement_id uuid REFERENCES ${T}.money_movements(id),
    kind text NOT NULL CHECK (kind IN ('negative_balance', 'double_claim', 'link_conflict')),
    amount_cents bigint,
    settled_amount_cents bigint,
    external_ref text,
    sandbox boolean NOT NULL,
    detail text,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    resolution text,
    resolved_by uuid,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS pool_flags_open_idx ON ${T}.pool_flags (COALESCE(movement_id, '00000000-0000-0000-0000-000000000000'::uuid), lp_entity_id, kind) WHERE status = 'open';
  -- Who said what about a firm's state. A sponsor's correction waits for the firm; an admin's applies at once and the
  -- firm can dispute it, which puts the old state back.
  CREATE TABLE IF NOT EXISTS ${T}.pool_state_corrections (
    id uuid PRIMARY KEY,
    pool_id uuid NOT NULL REFERENCES ${T}.liquidity_pools(id),
    lp_entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    from_state text NOT NULL,
    to_state text NOT NULL,
    source text NOT NULL CHECK (source IN ('sponsor_corrected', 'admin_corrected')),
    status text NOT NULL CHECK (status IN ('pending', 'applied', 'confirmed', 'disputed', 'superseded')),
    reason text,
    proposed_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid,
    decided_at timestamptz
  );
  ALTER TABLE ${T}.pool_state_corrections ADD COLUMN IF NOT EXISTS from_state_source text; -- who had set from_state, restored with it on a dispute
  CREATE INDEX IF NOT EXISTS pool_state_corrections_idx ON ${T}.pool_state_corrections (pool_id, lp_entity_id, status);
  -- A firm's standing in one pool. The money itself is only ever in the movement ledger; exited_at is set by
  -- refresh_pool_withdrawals when nothing of the firm's is left in the pool, and cleared when it comes back.
  CREATE TABLE IF NOT EXISTS ${T}.pool_commitments (
    pool_id uuid NOT NULL REFERENCES ${T}.liquidity_pools(id),
    lp_entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    state text NOT NULL, -- the US state its capital moves from; what the rail must serve
    state_source text NOT NULL DEFAULT 'liquidity_provider_stated', -- who set it: the firm, or a correction (sponsor_corrected, admin_corrected)
    committed_by uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    exited_at timestamptz,
    PRIMARY KEY (pool_id, lp_entity_id)
  );
  CREATE INDEX IF NOT EXISTS pool_commitments_lp_idx ON ${T}.pool_commitments (lp_entity_id);
  -- First in, first out, per pool: seq is the place in the queue.
  CREATE TABLE IF NOT EXISTS ${T}.pool_withdrawals (
    id uuid PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    seq bigint GENERATED ALWAYS AS IDENTITY,
    pool_id uuid NOT NULL REFERENCES ${T}.liquidity_pools(id),
    lp_entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    status text NOT NULL CHECK (status IN ('queued', 'paying', 'paid', 'paid_short', 'returned', 'cancelled', 'no_balance', 'parked')),
    status_reason text, -- why it was parked
    parked_at timestamptz, -- parked keeps its place: the worker checks it again, or it's lifted when the cause is fixed
    park_checks integer NOT NULL DEFAULT 0, -- how often it's been checked while parked, for the backoff
    requested_by uuid,
    requested_at timestamptz NOT NULL,
    eligible_at timestamptz NOT NULL,
    closed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS pool_withdrawals_queue_idx ON ${T}.pool_withdrawals (pool_id, status, seq);
  CREATE INDEX IF NOT EXISTS pool_withdrawals_lp_idx ON ${T}.pool_withdrawals (lp_entity_id, seq);
  -- Each attempt to move a firm's capital, tied to the ledger row that moved it. A row exists before the chokepoint is
  -- asked (state claimed), so a claim counts from the moment it's made and a crash leaves something to pick up.
  CREATE TABLE IF NOT EXISTS ${T}.pool_movements (
    id uuid PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    pool_id uuid NOT NULL REFERENCES ${T}.liquidity_pools(id),
    lp_entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    kind text NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
    withdrawal_id uuid REFERENCES ${T}.pool_withdrawals(id),
    amount_cents bigint NOT NULL CHECK (amount_cents > 0),
    customer_state text, -- a deposit's: the state the firm named; the commitment's only changes once the deposit is authorised
    movement_id uuid UNIQUE REFERENCES ${T}.money_movements(id),
    state text NOT NULL CHECK (state IN ('claimed', 'authorized', 'refused')),
    refusal text,
    claimed_at timestamptz NOT NULL
  );
  -- A deposit's lock-in, taken from the pool's terms when it was made: a later change of terms never moves an existing
  -- commitment's. Null (withdrawals, and deposits from before lock-ins) is none.
  ALTER TABLE ${T}.pool_movements ADD COLUMN IF NOT EXISTS lock_in_days integer;
  CREATE INDEX IF NOT EXISTS pool_movements_position_idx ON ${T}.pool_movements (pool_id, lp_entity_id);
  CREATE INDEX IF NOT EXISTS pool_movements_withdrawal_idx ON ${T}.pool_movements (withdrawal_id);
  CREATE INDEX IF NOT EXISTS pool_movements_claimed_idx ON ${T}.pool_movements (claimed_at) WHERE state = 'claimed';
  -- Where each attempt stands in the ledger. released: nothing moved and it never will. unresolved: Mynt swept it or gave
  -- up, so nobody knows (the two status_detail values are money-rails.ts's STALE_DETAIL and GAVE_UP_DETAIL).
  CREATE OR REPLACE VIEW ${T}.pool_movement_states AS
    SELECT pm.id, pm.pool_id, pm.lp_entity_id, pm.kind, pm.withdrawal_id, pm.amount_cents, pm.movement_id, pm.state, pm.refusal, pm.claimed_at,
      m.status AS movement_status, m.settled_at, m.reversed_at, m.external_ref,
      -- Never more than was asked: a partner reporting more can't inflate a position.
      LEAST(COALESCE(m.settled_amount_cents, m.amount_cents, pm.amount_cents), pm.amount_cents) AS amount_settled_cents,
      CASE
        WHEN pm.state = 'refused' THEN 'released'
        WHEN pm.movement_id IS NULL OR m.status IN ('requested', 'submitted') THEN 'in_flight'
        WHEN m.status = 'settled' THEN 'settled'
        WHEN m.status = 'reversed' THEN 'reversed'
        WHEN m.status = 'failed' AND m.status_detail IN ('stale_no_answer', 'mynt_gave_up') THEN 'unresolved'
        ELSE 'released'
      END AS ledger_state,
      pm.lock_in_days,
      -- When a settled deposit can be withdrawn: lock_in_days after it settled (null: no lock-in, never locked).
      CASE WHEN pm.kind = 'deposit' AND COALESCE(pm.lock_in_days, 0) > 0 AND m.settled_at IS NOT NULL THEN m.settled_at + COALESCE(pm.lock_in_days, 0) * interval '1 day' END AS unlocks_at
    FROM ${T}.pool_movements pm LEFT JOIN ${T}.money_movements m ON m.id = pm.movement_id;
  -- Each firm's position in cents, from settled movements only. A movement reversed after settling is no longer
  -- settled, so it leaves contributed or withdrawn by itself.
  CREATE OR REPLACE VIEW ${T}.pool_positions AS
    SELECT pool_id, lp_entity_id,
      COALESCE(sum(amount_settled_cents) FILTER (WHERE kind = 'deposit' AND ledger_state = 'settled'), 0)::bigint AS contributed_cents,
      COALESCE(sum(amount_settled_cents) FILTER (WHERE kind = 'withdrawal' AND ledger_state = 'settled'), 0)::bigint AS withdrawn_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE kind = 'deposit' AND ledger_state = 'in_flight'), 0)::bigint AS pending_in_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE kind = 'withdrawal' AND ledger_state = 'in_flight'), 0)::bigint AS pending_out_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE kind = 'deposit' AND ledger_state = 'unresolved'), 0)::bigint AS unresolved_in_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE kind = 'withdrawal' AND ledger_state = 'unresolved'), 0)::bigint AS unresolved_out_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE kind = 'deposit' AND ledger_state = 'reversed'), 0)::bigint AS reversed_in_cents,
      COALESCE(sum(amount_cents) FILTER (WHERE kind = 'withdrawal' AND ledger_state = 'reversed'), 0)::bigint AS reversed_out_cents
    FROM ${T}.pool_movement_states GROUP BY pool_id, lp_entity_id;

  -- A firm's deposit attempt, checked against the pool and its limits under the pool's lock.
  CREATE OR REPLACE FUNCTION ${T}.reserve_pool_deposit(p_id uuid, p_key text, p_pool uuid, p_lp uuid, p_amount bigint, p_state text, p_by uuid, p_now timestamptz)
  RETURNS TABLE (o_outcome text, o_id uuid, o_state text, o_exposure bigint) LANGUAGE plpgsql AS $fn$
  DECLARE
    p ${T}.liquidity_pools%ROWTYPE;
    prior ${T}.pool_movements%ROWTYPE;
    seen boolean;
    held text;
    x bigint;
  BEGIN
    SELECT * INTO p FROM ${T}.liquidity_pools WHERE id = p_pool FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'no_pool'::text, NULL::uuid, NULL::text, NULL::bigint;
      RETURN;
    END IF;
    SELECT * INTO prior FROM ${T}.pool_movements WHERE idempotency_key = p_key;
    seen := FOUND;
    IF seen THEN
      IF prior.pool_id <> p_pool OR prior.lp_entity_id <> p_lp OR prior.amount_cents <> p_amount THEN
        RETURN QUERY SELECT 'idempotency_conflict'::text, prior.id, prior.state, NULL::bigint;
        RETURN;
      END IF;
      -- A claim nothing has acted on yet is a deposit still to be made: it passes the same checks as a new one.
      IF prior.state <> 'claimed' OR prior.movement_id IS NOT NULL THEN
        RETURN QUERY SELECT 'replay'::text, prior.id, prior.state, NULL::bigint;
        RETURN;
      END IF;
    END IF;
    IF NOT p.sandbox AND NOT p.offering_cleared THEN
      RETURN QUERY SELECT 'offering_not_cleared'::text, NULL::uuid, NULL::text, NULL::bigint;
      RETURN;
    END IF;
    -- A health pause stops payments, not new capital: new capital is how a pool gets back above its reserve, unless the
    -- pool's terms say it takes none while paused for health. Every other pause, and a closed pool, takes none.
    IF p.status = 'closed' OR (p.status = 'paused' AND p.pause_kind IS DISTINCT FROM 'health') THEN
      RETURN QUERY SELECT 'pool_not_open'::text, NULL::uuid, NULL::text, NULL::bigint;
      RETURN;
    END IF;
    IF p.status = 'paused' AND NOT p.topups_when_health_paused THEN
      RETURN QUERY SELECT 'topups_closed'::text, NULL::uuid, NULL::text, NULL::bigint;
      RETURN;
    END IF;
    IF seen THEN
      RETURN QUERY SELECT 'replay'::text, prior.id, prior.state, NULL::bigint;
      RETURN;
    END IF;
    -- The state a firm's capital moves from can't change under a live position: every withdrawal depends on it.
    SELECT c.state INTO held FROM ${T}.pool_commitments c WHERE c.pool_id = p_pool AND c.lp_entity_id = p_lp;
    IF FOUND AND held <> p_state AND (
      EXISTS (SELECT 1 FROM ${T}.pool_positions s WHERE s.pool_id = p_pool AND s.lp_entity_id = p_lp AND (s.contributed_cents - s.withdrawn_cents > 0 OR s.pending_in_cents > 0 OR s.pending_out_cents > 0 OR s.unresolved_in_cents > 0 OR s.unresolved_out_cents > 0))
      OR EXISTS (SELECT 1 FROM ${T}.pool_withdrawals w WHERE w.pool_id = p_pool AND w.lp_entity_id = p_lp AND w.status IN ('queued', 'paying', 'parked'))
    ) THEN
      RETURN QUERY SELECT 'state_locked'::text, NULL::uuid, held, NULL::bigint;
      RETURN;
    END IF;
    SELECT COALESCE(sum(contributed_cents - withdrawn_cents + pending_in_cents + unresolved_in_cents), 0) INTO x
      FROM ${T}.pool_positions WHERE pool_id = p_pool AND lp_entity_id = p_lp;
    IF x + p_amount > p.max_commitment_cents THEN
      RETURN QUERY SELECT 'over_limit'::text, NULL::uuid, NULL::text, x;
      RETURN;
    END IF;
    IF x + p_amount < p.min_commitment_cents THEN
      RETURN QUERY SELECT 'under_minimum'::text, NULL::uuid, NULL::text, x;
      RETURN;
    END IF;
    INSERT INTO ${T}.pool_movements (id, idempotency_key, pool_id, lp_entity_id, kind, amount_cents, customer_state, state, claimed_at, lock_in_days)
      VALUES (p_id, p_key, p_pool, p_lp, 'deposit', p_amount, p_state, 'claimed', p_now, p.lock_in_days);
    -- The state itself only changes once this deposit is authorised (authorizePoolMovement).
    INSERT INTO ${T}.pool_commitments (pool_id, lp_entity_id, state, committed_by) VALUES (p_pool, p_lp, p_state, p_by)
      ON CONFLICT (pool_id, lp_entity_id) DO UPDATE SET committed_by = EXCLUDED.committed_by; -- exited_at clears once money settles
    RETURN QUERY SELECT 'reserved'::text, p_id, 'claimed'::text, x + p_amount;
  END $fn$;

  -- Joining the queue: only what the firm holds, settled and past its lock-in, less what it's already asked for or has on
  -- the way out. What's gone out came from unlocked money (nothing else could be asked for), so the locked part is all
  -- still there. 'locked': the request would fit if nothing were locked.
  CREATE OR REPLACE FUNCTION ${T}.request_pool_withdrawal(p_id uuid, p_key text, p_pool uuid, p_lp uuid, p_amount bigint, p_by uuid, p_now timestamptz, p_eligible timestamptz)
  RETURNS TABLE (o_outcome text, o_id uuid, o_available bigint) LANGUAGE plpgsql AS $fn$
  DECLARE
    p ${T}.liquidity_pools%ROWTYPE;
    prior ${T}.pool_withdrawals%ROWTYPE;
    balance bigint;
    open_requests bigint;
    available bigint;
    locked bigint;
  BEGIN
    SELECT * INTO p FROM ${T}.liquidity_pools WHERE id = p_pool FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'no_pool'::text, NULL::uuid, NULL::bigint;
      RETURN;
    END IF;
    SELECT * INTO prior FROM ${T}.pool_withdrawals WHERE idempotency_key = p_key;
    IF FOUND THEN
      IF prior.pool_id <> p_pool OR prior.lp_entity_id <> p_lp OR prior.amount_cents <> p_amount THEN
        RETURN QUERY SELECT 'idempotency_conflict'::text, prior.id, NULL::bigint;
        RETURN;
      END IF;
      RETURN QUERY SELECT 'replay'::text, prior.id, NULL::bigint;
      RETURN;
    END IF;
    SELECT COALESCE(sum(contributed_cents - withdrawn_cents - pending_out_cents - unresolved_out_cents), 0) INTO balance
      FROM ${T}.pool_positions WHERE pool_id = p_pool AND lp_entity_id = p_lp;
    SELECT COALESCE(sum(w.amount_cents - COALESCE(c.consumed, 0)), 0) INTO open_requests
      FROM ${T}.pool_withdrawals w
      LEFT JOIN LATERAL (SELECT sum(amount_cents) AS consumed FROM ${T}.pool_movement_states s WHERE s.withdrawal_id = w.id AND s.ledger_state <> 'released') c ON true
      WHERE w.pool_id = p_pool AND w.lp_entity_id = p_lp AND w.status IN ('queued', 'parked');
    SELECT COALESCE(sum(amount_settled_cents), 0) INTO locked FROM ${T}.pool_movement_states
      WHERE pool_id = p_pool AND lp_entity_id = p_lp AND kind = 'deposit' AND ledger_state = 'settled' AND unlocks_at > p_now;
    available := balance - open_requests - locked;
    IF p_amount > available THEN
      RETURN QUERY SELECT CASE WHEN locked > 0 AND p_amount <= balance - open_requests THEN 'locked' ELSE 'insufficient' END::text, NULL::uuid, GREATEST(available, 0);
      RETURN;
    END IF;
    INSERT INTO ${T}.pool_withdrawals (id, idempotency_key, pool_id, lp_entity_id, amount_cents, status, requested_by, requested_at, eligible_at)
      VALUES (p_id, p_key, p_pool, p_lp, p_amount, 'queued', p_by, p_now, p_eligible);
    RETURN QUERY SELECT 'queued'::text, p_id, available - p_amount;
  END $fn$;

  -- Leaving the queue. What's already on its way carries on; only the rest is cancelled.
  CREATE OR REPLACE FUNCTION ${T}.cancel_pool_withdrawal(p_id uuid, p_lp uuid, p_now timestamptz)
  RETURNS TABLE (o_outcome text, o_status text) LANGUAGE plpgsql AS $fn$
  DECLARE
    w ${T}.pool_withdrawals%ROWTYPE;
  BEGIN
    SELECT * INTO w FROM ${T}.pool_withdrawals WHERE id = p_id;
    IF NOT FOUND OR w.lp_entity_id <> p_lp THEN
      RETURN QUERY SELECT 'no_request'::text, NULL::text;
      RETURN;
    END IF;
    PERFORM 1 FROM ${T}.liquidity_pools WHERE id = w.pool_id FOR UPDATE;
    SELECT * INTO w FROM ${T}.pool_withdrawals WHERE id = p_id;
    IF w.status NOT IN ('queued', 'parked') THEN
      RETURN QUERY SELECT 'not_queued'::text, w.status;
      RETURN;
    END IF;
    UPDATE ${T}.pool_withdrawals SET status = 'cancelled', closed_at = p_now WHERE id = p_id;
    RETURN QUERY SELECT 'cancelled'::text, 'cancelled'::text;
  END $fn$;

  -- The head of the queue and how much of it may be paid now, in one locked step: the amount is taken from the request
  -- here, before the chokepoint is asked, so two workers can never both have it. A sponsor's reserves for a product are
  -- one figure (see partner-ledger/types.ts), so every pool of the product is locked (in id order: no deadlocks) and a
  -- sponsor's pools share one headroom: what the snapshot allowed, less what may have left since that snapshot's reading
  -- and it can't have seen. That's every withdrawal of that sponsor's pools, its other outflows on the product, and any
  -- deposit reversed since. A firm that's suspended, has a request parked, or whose own payment is still unknown is
  -- passed over: it doesn't stop the firms behind it.
  CREATE OR REPLACE FUNCTION ${T}.claim_pool_withdrawal(p_claim uuid, p_pool uuid, p_headroom bigint, p_as_of timestamptz, p_max_transfer bigint, p_now timestamptz)
  RETURNS TABLE (o_outcome text, o_withdrawal uuid, o_lp uuid, o_amount bigint) LANGUAGE plpgsql AS $fn$
  DECLARE
    p ${T}.liquidity_pools%ROWTYPE;
    w ${T}.pool_withdrawals%ROWTYPE;
    pid text;
    consumed bigint;
    remaining bigint;
    held bigint;
    out_flight bigint;
    spent bigint;
    other bigint;
    undone bigint;
    conflicted bigint;
    pay bigint;
  BEGIN
    SELECT product_id INTO pid FROM ${T}.liquidity_pools WHERE id = p_pool;
    IF FOUND THEN
      PERFORM 1 FROM ${T}.liquidity_pools WHERE product_id = pid ORDER BY id FOR UPDATE;
    END IF;
    SELECT * INTO p FROM ${T}.liquidity_pools WHERE id = p_pool;
    IF NOT FOUND OR p.status NOT IN ('open', 'closed') THEN
      RETURN QUERY SELECT 'not_open'::text, NULL::uuid, NULL::uuid, NULL::bigint;
      RETURN;
    END IF;
    FOR w IN SELECT * FROM ${T}.pool_withdrawals WHERE pool_id = p_pool AND status = 'queued' ORDER BY seq LOOP
      SELECT COALESCE(sum(amount_cents), 0) INTO consumed FROM ${T}.pool_movement_states WHERE withdrawal_id = w.id AND ledger_state <> 'released';
      remaining := w.amount_cents - consumed;
      IF remaining <= 0 THEN
        UPDATE ${T}.pool_withdrawals SET status = 'paying' WHERE id = w.id;
        CONTINUE;
      END IF;
      IF (SELECT status FROM ${T}.entities WHERE id = w.lp_entity_id) IS DISTINCT FROM 'active'
        OR EXISTS (SELECT 1 FROM ${T}.pool_withdrawals x WHERE x.pool_id = p_pool AND x.lp_entity_id = w.lp_entity_id AND x.status = 'parked') THEN
        CONTINUE;
      END IF;
      IF w.eligible_at > p_now THEN
        RETURN QUERY SELECT 'not_yet'::text, w.id, w.lp_entity_id, NULL::bigint;
        RETURN;
      END IF;
      SELECT COALESCE(sum(contributed_cents - withdrawn_cents), 0), COALESCE(sum(pending_out_cents + unresolved_out_cents), 0) INTO held, out_flight
        FROM ${T}.pool_positions WHERE pool_id = p_pool AND lp_entity_id = w.lp_entity_id;
      IF held - out_flight <= 0 THEN
        IF out_flight > 0 THEN -- it may come back: this request waits for it, and the firms behind don't
          CONTINUE;
        END IF;
        UPDATE ${T}.pool_withdrawals SET status = 'no_balance', closed_at = p_now WHERE id = w.id;
        CONTINUE;
      END IF;
      SELECT COALESCE(sum(s.amount_settled_cents), 0) INTO spent FROM ${T}.pool_movement_states s JOIN ${T}.liquidity_pools q ON q.id = s.pool_id
        WHERE q.product_id = p.product_id AND q.sponsor_entity_id = p.sponsor_entity_id AND q.sandbox = p.sandbox AND s.kind = 'withdrawal' AND (s.ledger_state IN ('in_flight', 'unresolved') OR (s.ledger_state = 'settled' AND s.settled_at > p_as_of));
      SELECT COALESCE(sum(COALESCE(m.settled_amount_cents, m.amount_cents, 0)), 0) INTO other FROM ${T}.money_movements m
        WHERE m.product_id = p.product_id AND m.sponsor_entity_id = p.sponsor_entity_id AND m.sandbox = p.sandbox AND m.direction IN ('off_ramp', 'payout') AND COALESCE(m.action, '') NOT IN ('pool_deposit', 'pool_withdrawal')
          AND (m.status IN ('requested', 'submitted') OR (m.status = 'failed' AND m.status_detail IN ('stale_no_answer', 'mynt_gave_up')) OR (m.status = 'settled' AND m.settled_at > p_as_of));
      SELECT COALESCE(sum(s.amount_cents), 0) INTO undone FROM ${T}.pool_movement_states s JOIN ${T}.liquidity_pools q ON q.id = s.pool_id
        WHERE q.product_id = p.product_id AND q.sponsor_entity_id = p.sponsor_entity_id AND q.sandbox = p.sandbox AND s.kind = 'deposit' AND s.ledger_state = 'reversed' AND s.reversed_at > p_as_of AND s.settled_at <= p_as_of;
      -- A ledger payout no claim can be tied to is money that may have left, until an admin links it or closes it.
      SELECT COALESCE(sum(COALESCE(m.settled_amount_cents, m.amount_cents, 0)), 0) INTO conflicted FROM ${T}.pool_flags f JOIN ${T}.money_movements m ON m.id = f.movement_id JOIN ${T}.liquidity_pools q ON q.id = f.pool_id
        WHERE f.kind = 'link_conflict' AND f.status = 'open' AND q.product_id = p.product_id AND q.sponsor_entity_id = p.sponsor_entity_id AND q.sandbox = p.sandbox AND m.direction IN ('off_ramp', 'payout')
          AND (m.status IN ('requested', 'submitted') OR (m.status = 'failed' AND m.status_detail IN ('stale_no_answer', 'mynt_gave_up')) OR (m.status = 'settled' AND m.settled_at > p_as_of));
      pay := LEAST(remaining, held - out_flight, p_headroom - spent - other - undone - conflicted, p_max_transfer);
      IF pay <= 0 THEN
        RETURN QUERY SELECT 'no_headroom'::text, w.id, w.lp_entity_id, NULL::bigint;
        RETURN;
      END IF;
      INSERT INTO ${T}.pool_movements (id, idempotency_key, pool_id, lp_entity_id, kind, withdrawal_id, amount_cents, state, claimed_at)
        VALUES (p_claim, 'pool-withdrawal:' || p_claim::text, p_pool, w.lp_entity_id, 'withdrawal', w.id, pay, 'claimed', p_now);
      IF pay = remaining THEN
        UPDATE ${T}.pool_withdrawals SET status = 'paying' WHERE id = w.id;
      END IF;
      RETURN QUERY SELECT 'claimed'::text, w.id, w.lp_entity_id, pay;
      RETURN;
    END LOOP;
    RETURN QUERY SELECT 'empty'::text, NULL::uuid, NULL::uuid, NULL::bigint;
  END $fn$;

  -- Brings a pool's requests and commitments in line with what the ledger now says. A payment that failed for certain
  -- puts its amount back at the same place in the queue; one that came back after settling isn't paid again by itself
  -- (a request whose whole amount came back is 'returned').
  CREATE OR REPLACE FUNCTION ${T}.refresh_pool_withdrawals(p_pool uuid, p_now timestamptz) RETURNS void LANGUAGE plpgsql AS $fn$
  DECLARE
    w ${T}.pool_withdrawals%ROWTYPE;
    consumed bigint;
    done bigint;
    actual bigint;
  BEGIN
    PERFORM 1 FROM ${T}.liquidity_pools WHERE id = p_pool FOR UPDATE;
    FOR w IN SELECT * FROM ${T}.pool_withdrawals x WHERE x.pool_id = p_pool AND (x.status IN ('queued', 'paying') OR (x.status IN ('paid', 'paid_short') AND EXISTS (SELECT 1 FROM ${T}.pool_movement_states s WHERE s.withdrawal_id = x.id AND s.ledger_state = 'reversed'))) ORDER BY x.seq LOOP
      SELECT COALESCE(sum(amount_cents) FILTER (WHERE ledger_state <> 'released'), 0), COALESCE(sum(amount_cents) FILTER (WHERE ledger_state IN ('settled', 'reversed')), 0),
             COALESCE(sum(amount_settled_cents) FILTER (WHERE ledger_state = 'settled'), 0) INTO consumed, done, actual
        FROM ${T}.pool_movement_states WHERE withdrawal_id = w.id;
      IF done >= w.amount_cents THEN
        UPDATE ${T}.pool_withdrawals SET status = CASE WHEN actual = 0 THEN 'returned' WHEN actual < w.amount_cents THEN 'paid_short' ELSE 'paid' END, closed_at = COALESCE(closed_at, p_now) WHERE id = w.id;
      ELSIF consumed >= w.amount_cents AND w.status <> 'paying' THEN
        UPDATE ${T}.pool_withdrawals SET status = 'paying' WHERE id = w.id;
      ELSIF consumed < w.amount_cents AND w.status <> 'queued' THEN
        UPDATE ${T}.pool_withdrawals SET status = 'queued' WHERE id = w.id;
      END IF;
    END LOOP;
    -- A commitment whose every attempt came to nothing never put a firm in the pool, so it leaves no trace of having
    -- been in it (and so no access to the product's health).
    DELETE FROM ${T}.pool_commitments c
      WHERE c.pool_id = p_pool AND NOT EXISTS (SELECT 1 FROM ${T}.pool_movement_states s WHERE s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id AND s.ledger_state <> 'released');
    -- A firm is out when nothing of its is left in the pool, in the ledger or the queue.
    UPDATE ${T}.pool_commitments c SET exited_at = p_now
      WHERE c.pool_id = p_pool AND c.exited_at IS NULL
        AND COALESCE((SELECT contributed_cents - withdrawn_cents FROM ${T}.pool_positions s WHERE s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id), 0) <= 0
        AND NOT EXISTS (SELECT 1 FROM ${T}.pool_movement_states s WHERE s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id AND s.ledger_state IN ('in_flight', 'unresolved'))
        AND NOT EXISTS (SELECT 1 FROM ${T}.pool_withdrawals w2 WHERE w2.pool_id = c.pool_id AND w2.lp_entity_id = c.lp_entity_id AND w2.status IN ('queued', 'paying', 'parked'));
    UPDATE ${T}.pool_commitments c SET exited_at = NULL
      WHERE c.pool_id = p_pool AND c.exited_at IS NOT NULL
        AND COALESCE((SELECT contributed_cents - withdrawn_cents FROM ${T}.pool_positions s WHERE s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id), 0) > 0;
  END $fn$;

  -- A sponsor's report that a withdrawal settled: a fact about money that moved, so it's recorded, even if it takes the
  -- firm below zero (the caller flags that). The one case refused is a double claim: this movement was written off for
  -- certain and its amount has since gone out another way, so recording it would count one payment twice. An admin can
  -- override that (p_force) once they've checked. Under the pool's lock, so it can't race a claim on the same amount.
  CREATE OR REPLACE FUNCTION ${T}.settle_pool_withdrawal(p_movement uuid, p_ref text, p_settled bigint, p_force boolean DEFAULT false)
  RETURNS TABLE (o_outcome text) LANGUAGE plpgsql AS $fn$
  DECLARE
    pm ${T}.pool_movements%ROWTYPE;
    w ${T}.pool_withdrawals%ROWTYPE;
    st text;
    detail text;
    others bigint;
    held bigint;
    out_flight bigint;
    amt bigint;
  BEGIN
    SELECT * INTO pm FROM ${T}.pool_movements WHERE movement_id = p_movement;
    IF NOT FOUND OR pm.kind <> 'withdrawal' THEN
      RETURN QUERY SELECT 'not_withdrawal'::text;
      RETURN;
    END IF;
    PERFORM 1 FROM ${T}.liquidity_pools WHERE id = pm.pool_id FOR UPDATE;
    SELECT status, status_detail INTO st, detail FROM ${T}.money_movements WHERE id = p_movement;
    IF st NOT IN ('requested', 'submitted', 'failed') THEN
      RETURN QUERY SELECT 'no_change'::text;
      RETURN;
    END IF;
    IF st = 'failed' AND COALESCE(detail, '') NOT IN ('stale_no_answer', 'mynt_gave_up') AND NOT p_force THEN
      SELECT * INTO w FROM ${T}.pool_withdrawals WHERE id = pm.withdrawal_id;
      SELECT COALESCE(sum(amount_cents), 0) INTO others FROM ${T}.pool_movement_states WHERE withdrawal_id = pm.withdrawal_id AND id <> pm.id AND ledger_state <> 'released';
      amt := LEAST(COALESCE(p_settled, pm.amount_cents), pm.amount_cents);
      SELECT COALESCE(sum(contributed_cents - withdrawn_cents), 0), COALESCE(sum(pending_out_cents + unresolved_out_cents), 0) INTO held, out_flight
        FROM ${T}.pool_positions WHERE pool_id = pm.pool_id AND lp_entity_id = pm.lp_entity_id;
      IF others + pm.amount_cents > w.amount_cents OR held - out_flight - amt < 0 THEN
        RETURN QUERY SELECT 'double_claim'::text;
        RETURN;
      END IF;
    END IF;
    UPDATE ${T}.money_movements SET status = 'settled', status_detail = CASE WHEN status = 'failed' THEN 'late_settlement' ELSE NULL END, settled_at = now(), updated_at = now(), external_ref = COALESCE(p_ref, external_ref),
      settled_amount_cents = COALESCE(p_settled, settled_amount_cents),
      settled_amount_differs = CASE WHEN p_settled IS NULL THEN settled_amount_differs ELSE p_settled <> amount_cents END
    WHERE id = p_movement AND status = st;
    RETURN QUERY SELECT 'settled'::text;
  END $fn$;

  -- An admin's decision on an open flag, in one transaction: what it does to the ledger and the flag's closing happen
  -- together or not at all, so a crash can't leave a settlement recorded and the decision still open.
  CREATE OR REPLACE FUNCTION ${T}.resolve_pool_flag(p_flag uuid, p_resolution text, p_note text, p_by uuid, p_now timestamptz)
  RETURNS TABLE (o_outcome text, o_negative boolean) LANGUAGE plpgsql AS $fn$
  DECLARE
    f ${T}.pool_flags%ROWTYPE;
    pm ${T}.pool_movements%ROWTYPE;
    w ${T}.pool_withdrawals%ROWTYPE;
    m ${T}.money_movements%ROWTYPE;
    res text;
    others bigint;
    held bigint;
    out_flight bigint;
    bal bigint;
    negative boolean := false;
  BEGIN
    SELECT * INTO f FROM ${T}.pool_flags WHERE id = p_flag FOR UPDATE;
    IF NOT FOUND OR f.status <> 'open' THEN
      RETURN QUERY SELECT 'not_open'::text, false;
      RETURN;
    END IF;
    IF p_resolution = 'accept_settlement' THEN
      SELECT s.o_outcome INTO res FROM ${T}.settle_pool_withdrawal(f.movement_id, f.external_ref, f.settled_amount_cents, true) AS s;
      IF res <> 'settled' THEN
        RETURN QUERY SELECT ('cannot_settle:' || res)::text, false;
        RETURN;
      END IF;
      PERFORM ${T}.refresh_pool_withdrawals(f.pool_id, p_now);
      SELECT COALESCE(sum(contributed_cents - withdrawn_cents), 0) INTO bal FROM ${T}.pool_positions WHERE pool_id = f.pool_id AND lp_entity_id = f.lp_entity_id;
      IF bal < 0 THEN
        negative := true;
        INSERT INTO ${T}.pool_flags (id, pool_id, lp_entity_id, movement_id, kind, amount_cents, external_ref, sandbox, detail)
          VALUES (gen_random_uuid(), f.pool_id, f.lp_entity_id, f.movement_id, 'negative_balance', bal, f.external_ref, f.sandbox,
                  'This firm''s settled position is below zero after an admin accepted a settlement')
          ON CONFLICT DO NOTHING;
      END IF;
    ELSIF p_resolution IN ('link_movement', 'close_movement') THEN
      SELECT * INTO m FROM ${T}.money_movements WHERE id = f.movement_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN QUERY SELECT 'no_movement'::text, false;
        RETURN;
      END IF;
      PERFORM 1 FROM ${T}.liquidity_pools WHERE id = f.pool_id FOR UPDATE;
      IF p_resolution = 'close_movement' THEN
        IF m.status IN ('settled', 'reversed') THEN
          RETURN QUERY SELECT 'already_settled'::text, false; -- money moved: it can only be linked
          RETURN;
        END IF;
        UPDATE ${T}.money_movements SET status = 'failed', status_detail = 'admin_closed', failed_at = COALESCE(failed_at, now()), updated_at = now() WHERE id = m.id;
      ELSE
        SELECT * INTO pm FROM ${T}.pool_movements WHERE idempotency_key = m.idempotency_key AND movement_id IS NULL;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 'no_claim'::text, false;
          RETURN;
        END IF;
        IF pm.kind = 'withdrawal' THEN
          SELECT * INTO w FROM ${T}.pool_withdrawals WHERE id = pm.withdrawal_id;
          SELECT COALESCE(sum(amount_cents), 0) INTO others FROM ${T}.pool_movement_states WHERE withdrawal_id = pm.withdrawal_id AND id <> pm.id AND ledger_state <> 'released';
          SELECT COALESCE(sum(contributed_cents - withdrawn_cents), 0), COALESCE(sum(pending_out_cents + unresolved_out_cents), 0) INTO held, out_flight
            FROM ${T}.pool_positions WHERE pool_id = pm.pool_id AND lp_entity_id = pm.lp_entity_id;
          IF others + pm.amount_cents > w.amount_cents OR held - out_flight - pm.amount_cents < 0 THEN
            RETURN QUERY SELECT 'already_repaid'::text, false; -- it would count the same money twice: close it, or investigate
            RETURN;
          END IF;
        END IF;
        UPDATE ${T}.pool_movements SET movement_id = m.id, state = 'authorized', refusal = NULL WHERE id = pm.id;
        PERFORM ${T}.refresh_pool_withdrawals(f.pool_id, p_now);
      END IF;
    END IF;
    UPDATE ${T}.pool_flags SET status = 'resolved', resolution = p_resolution || ': ' || p_note, resolved_by = p_by, resolved_at = now() WHERE id = p_flag;
    RETURN QUERY SELECT 'resolved'::text, negative;
  END $fn$;
`;
