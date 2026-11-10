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
  CREATE INDEX IF NOT EXISTS liquidity_pools_product_idx ON ${T}.liquidity_pools (product_id);
  -- A firm's standing in one pool. The money itself is only ever in the movement ledger; exited_at is set by
  -- refresh_pool_withdrawals when nothing of the firm's is left in the pool, and cleared when it comes back.
  CREATE TABLE IF NOT EXISTS ${T}.pool_commitments (
    pool_id uuid NOT NULL REFERENCES ${T}.liquidity_pools(id),
    lp_entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    state text NOT NULL, -- the US state its capital moves from, as the firm stated it; what the rail must serve
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
    status text NOT NULL CHECK (status IN ('queued', 'paying', 'paid', 'cancelled', 'no_balance')),
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
    movement_id uuid UNIQUE REFERENCES ${T}.money_movements(id),
    state text NOT NULL CHECK (state IN ('claimed', 'authorized', 'refused')),
    refusal text,
    claimed_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pool_movements_position_idx ON ${T}.pool_movements (pool_id, lp_entity_id);
  CREATE INDEX IF NOT EXISTS pool_movements_withdrawal_idx ON ${T}.pool_movements (withdrawal_id);
  CREATE INDEX IF NOT EXISTS pool_movements_claimed_idx ON ${T}.pool_movements (claimed_at) WHERE state = 'claimed';
  -- Where each attempt stands in the ledger. released: nothing moved and it never will. unresolved: Mynt swept it or gave
  -- up, so nobody knows (the two status_detail values are money-rails.ts's STALE_DETAIL and GAVE_UP_DETAIL).
  CREATE OR REPLACE VIEW ${T}.pool_movement_states AS
    SELECT pm.id, pm.pool_id, pm.lp_entity_id, pm.kind, pm.withdrawal_id, pm.amount_cents, pm.movement_id, pm.state, pm.refusal, pm.claimed_at,
      m.status AS movement_status, m.settled_at, m.external_ref,
      COALESCE(m.settled_amount_cents, m.amount_cents, pm.amount_cents) AS amount_settled_cents,
      CASE
        WHEN pm.state = 'refused' THEN 'released'
        WHEN pm.movement_id IS NULL OR m.status IN ('requested', 'submitted') THEN 'in_flight'
        WHEN m.status = 'settled' THEN 'settled'
        WHEN m.status = 'reversed' THEN 'reversed'
        WHEN m.status = 'failed' AND m.status_detail IN ('stale_no_answer', 'mynt_gave_up') THEN 'unresolved'
        ELSE 'released'
      END AS ledger_state
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
    x bigint;
  BEGIN
    SELECT * INTO p FROM ${T}.liquidity_pools WHERE id = p_pool FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'no_pool'::text, NULL::uuid, NULL::text, NULL::bigint;
      RETURN;
    END IF;
    SELECT * INTO prior FROM ${T}.pool_movements WHERE idempotency_key = p_key;
    IF FOUND THEN
      IF prior.pool_id <> p_pool OR prior.lp_entity_id <> p_lp OR prior.amount_cents <> p_amount THEN
        RETURN QUERY SELECT 'idempotency_conflict'::text, prior.id, prior.state, NULL::bigint;
        RETURN;
      END IF;
      RETURN QUERY SELECT 'replay'::text, prior.id, prior.state, NULL::bigint;
      RETURN;
    END IF;
    IF NOT p.sandbox AND NOT p.offering_cleared THEN
      RETURN QUERY SELECT 'offering_not_cleared'::text, NULL::uuid, NULL::text, NULL::bigint;
      RETURN;
    END IF;
    -- A health pause stops payments, not new capital: new capital is how a pool gets back above its reserve.
    IF p.status = 'closed' OR (p.status = 'paused' AND p.pause_kind IS DISTINCT FROM 'health') THEN
      RETURN QUERY SELECT 'pool_not_open'::text, NULL::uuid, NULL::text, NULL::bigint;
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
    INSERT INTO ${T}.pool_movements (id, idempotency_key, pool_id, lp_entity_id, kind, amount_cents, state, claimed_at)
      VALUES (p_id, p_key, p_pool, p_lp, 'deposit', p_amount, 'claimed', p_now);
    INSERT INTO ${T}.pool_commitments (pool_id, lp_entity_id, state, committed_by) VALUES (p_pool, p_lp, p_state, p_by)
      ON CONFLICT (pool_id, lp_entity_id) DO UPDATE SET state = EXCLUDED.state, committed_by = EXCLUDED.committed_by, exited_at = NULL;
    RETURN QUERY SELECT 'reserved'::text, p_id, 'claimed'::text, x + p_amount;
  END $fn$;

  -- Joining the queue: only what the firm holds, settled, less what it's already asked for or has on the way out.
  CREATE OR REPLACE FUNCTION ${T}.request_pool_withdrawal(p_id uuid, p_key text, p_pool uuid, p_lp uuid, p_amount bigint, p_by uuid, p_now timestamptz, p_eligible timestamptz)
  RETURNS TABLE (o_outcome text, o_id uuid, o_available bigint) LANGUAGE plpgsql AS $fn$
  DECLARE
    p ${T}.liquidity_pools%ROWTYPE;
    prior ${T}.pool_withdrawals%ROWTYPE;
    balance bigint;
    open_requests bigint;
    available bigint;
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
      WHERE w.pool_id = p_pool AND w.lp_entity_id = p_lp AND w.status = 'queued';
    available := balance - open_requests;
    IF p_amount > available THEN
      RETURN QUERY SELECT 'insufficient'::text, NULL::uuid, GREATEST(available, 0);
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
    IF w.status <> 'queued' THEN
      RETURN QUERY SELECT 'not_queued'::text, w.status;
      RETURN;
    END IF;
    UPDATE ${T}.pool_withdrawals SET status = 'cancelled', closed_at = p_now WHERE id = p_id;
    RETURN QUERY SELECT 'cancelled'::text, 'cancelled'::text;
  END $fn$;

  -- The head of the queue and how much of it may be paid now, in one locked step: the amount is taken from the request
  -- here, before the chokepoint is asked, so two workers can never both have it. Headroom is what the snapshot allowed,
  -- less every withdrawal that may have left since that snapshot's reading: those it can't have seen.
  CREATE OR REPLACE FUNCTION ${T}.claim_pool_withdrawal(p_claim uuid, p_pool uuid, p_headroom bigint, p_as_of timestamptz, p_max_transfer bigint, p_now timestamptz)
  RETURNS TABLE (o_outcome text, o_withdrawal uuid, o_lp uuid, o_amount bigint) LANGUAGE plpgsql AS $fn$
  DECLARE
    p ${T}.liquidity_pools%ROWTYPE;
    w ${T}.pool_withdrawals%ROWTYPE;
    consumed bigint;
    remaining bigint;
    held bigint;
    out_flight bigint;
    spent bigint;
    pay bigint;
  BEGIN
    SELECT * INTO p FROM ${T}.liquidity_pools WHERE id = p_pool FOR UPDATE;
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
      IF w.eligible_at > p_now THEN
        RETURN QUERY SELECT 'not_yet'::text, w.id, w.lp_entity_id, NULL::bigint;
        RETURN;
      END IF;
      SELECT COALESCE(sum(contributed_cents - withdrawn_cents), 0), COALESCE(sum(pending_out_cents + unresolved_out_cents), 0) INTO held, out_flight
        FROM ${T}.pool_positions WHERE pool_id = p_pool AND lp_entity_id = w.lp_entity_id;
      IF held - out_flight <= 0 THEN
        IF out_flight > 0 THEN -- it may come back: this request waits, and nothing behind it passes
          RETURN QUERY SELECT 'held'::text, w.id, w.lp_entity_id, NULL::bigint;
          RETURN;
        END IF;
        UPDATE ${T}.pool_withdrawals SET status = 'no_balance', closed_at = p_now WHERE id = w.id;
        CONTINUE;
      END IF;
      SELECT COALESCE(sum(amount_settled_cents), 0) INTO spent FROM ${T}.pool_movement_states
        WHERE pool_id = p_pool AND kind = 'withdrawal' AND (ledger_state IN ('in_flight', 'unresolved') OR (ledger_state = 'settled' AND settled_at > p_as_of));
      pay := LEAST(remaining, held - out_flight, p_headroom - spent, p_max_transfer);
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
  -- puts its amount back at the same place in the queue; one that came back after settling isn't paid again by itself.
  CREATE OR REPLACE FUNCTION ${T}.refresh_pool_withdrawals(p_pool uuid, p_now timestamptz) RETURNS void LANGUAGE plpgsql AS $fn$
  DECLARE
    w ${T}.pool_withdrawals%ROWTYPE;
    consumed bigint;
    done bigint;
  BEGIN
    PERFORM 1 FROM ${T}.liquidity_pools WHERE id = p_pool FOR UPDATE;
    FOR w IN SELECT * FROM ${T}.pool_withdrawals WHERE pool_id = p_pool AND status IN ('queued', 'paying') ORDER BY seq LOOP
      SELECT COALESCE(sum(amount_cents) FILTER (WHERE ledger_state <> 'released'), 0), COALESCE(sum(amount_cents) FILTER (WHERE ledger_state IN ('settled', 'reversed')), 0) INTO consumed, done
        FROM ${T}.pool_movement_states WHERE withdrawal_id = w.id;
      IF done >= w.amount_cents THEN
        UPDATE ${T}.pool_withdrawals SET status = 'paid', closed_at = p_now WHERE id = w.id;
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
        AND NOT EXISTS (SELECT 1 FROM ${T}.pool_withdrawals w2 WHERE w2.pool_id = c.pool_id AND w2.lp_entity_id = c.lp_entity_id AND w2.status IN ('queued', 'paying'));
    UPDATE ${T}.pool_commitments c SET exited_at = NULL
      WHERE c.pool_id = p_pool AND c.exited_at IS NOT NULL
        AND COALESCE((SELECT contributed_cents - withdrawn_cents FROM ${T}.pool_positions s WHERE s.pool_id = c.pool_id AND s.lp_entity_id = c.lp_entity_id), 0) > 0;
  END $fn$;
`;
