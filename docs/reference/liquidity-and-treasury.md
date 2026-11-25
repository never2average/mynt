# Liquidity pools and on-chain treasuries

This file covers liquidity pools on a product, the positions liquidity providers hold in them, the withdrawal queue, and pools whose capital is held on chain in a Solana treasury program. It is for liquidity providers, for builders whose products have pools, and for the licence providers that sponsor those products.

See also: [Money rails](money-rails.md), [Firms, licences and licence providers](licence-providers.md), [Solana programs](solana-programs.md), [Workspaces and sign-in](workspaces-and-sign-in.md), [Mynt Studio](studio.md).

## Liquidity pools

**Pooled investor capital with withdrawal rights may be a securities offering.** Mynt builds the mechanics only and takes no view on whether a given pool is one. See [The offering gate](#the-offering-gate) for what Mynt refuses until a Mynt admin clears a pool.

Liquidity providers are firms or funds that put capital into a product's pools and take it out.

- **Mynt never holds funds.** It records and instructs. The money stays at the licensed partner.
- Every deposit and withdrawal goes only through the [chokepoint](money-rails.md#the-chokepoint) on an approved rail of the pool's sponsoring licence provider.
- Customers only ever see dollars. Every figure here is integer US cents.
- A figure that can't be measured is null with a reason, never 0.

The code is `core/src/liquidity.ts`, `core/src/liquidity-tools.ts` and `core/src/liquidity-schema.ts`.

### The offering gate

Real (non-sandbox) commitments are refused, by a hard gate on the deposit path, until a Mynt admin sets the pool's `offering_cleared` flag with `set_pool_offering_cleared`. That records who cleared it and the legal basis (`offering_cleared_by`, `offering_legal_basis`). The refusal (`offering_not_cleared`) says why.

- Sandbox pools move no real money and aren't subject to the gate.
- Someone at the pool's product firm or its licence provider can't set the flag, even with the admin role.
- An uncleared real pool isn't listed to liquidity providers.

### A pool

A pool belongs to one product component. The product's builder creates it (`create_pool`), for a component with an approved sponsorship. It is in US dollars.

| Term | Meaning |
| --- | --- |
| Status | `open`, `paused` or `closed` |
| Minimum reserve | `min_reserve_bps` of obligations (10000 = 100%, rounded up), plus `min_reserve_floor_cents` |
| Notice period | In days. 0 is allowed |
| Commitment limits | `min_commitment_cents` and `max_commitment_cents` per firm, counted against the firm's settled net position plus what is still on its way in |

A pool is paused until the component's licence provider approves it (`approve_pool`) and names its rails:

- an approved `deposit` or `on_ramp` rail and an approved `payout` or `off_ramp` rail, both the licence provider's own;
- every state the deposit rail serves must also be served by the payout rail, so capital that came in can get out.

A pool uses the rails named at approval and no other. It doesn't follow a replacement if one is revoked.

Sandbox pools (`sandbox: true`) run the same mechanics on sandbox ledger rows. A sandbox commitment gives no access to the product's health figures, so it can't be a way into a real product's books.

### Commitments and capital

`commit_to_pool` takes an amount and the US state the capital moves from. The firm states it, as a customer states `residence_state`, and the rail must serve it.

- The state can't change while the firm holds a position, and only takes effect once a deposit is authorised.
- A pool's licence provider or its product's firm can't be a liquidity provider in it.
- The call reserves a deposit under the pool's lock, checks the limits, and asks the chokepoint.
- Every movement is a row in the ledger tied to its pool and firm in `pool_movements`, with its own idempotency key, so a retried call is the same movement.
- A real commitment also needs the product published.

### Positions

`list_my_positions` shows `contributed_cents`, `withdrawn_cents` and `balance_cents`. They are worked out from the movement ledger, from **settled movements only**, so nothing stored can disagree with them.

- A movement still on its way (`pending_*`), or one Mynt swept with no answer (`unresolved_*`), doesn't count as settled.
- A deposit or withdrawal returned after settling leaves the position by itself. A reversal reduces contributed or restores what was withdrawn.
- `available_to_withdraw_cents` is the balance less what is on its way out, unresolved, or already queued.
- What settled is the partner's reported amount when it is less than what was asked. A short settlement shows the amount that settled and ends the request as `paid_short`.
- A report of more than was asked is refused and flagged to Mynt admins (`ops_status`).

### A pool's capital

Each `list_pools` row of a pool the caller may see whole carries `capital: { rails, on_chain }`. The callers who see a pool whole are a Mynt admin, the pool's product's builder and its licence provider. The totals are over every firm and wallet in the pool, never any one firm's or wallet's figures.

**`rails`** is from the movement ledger, in cents, settled movements only as for positions:

| Field | Meaning |
| --- | --- |
| `principal_cents` | Settled in less paid out |
| `settled_in_cents` | Deposits settled |
| `pending_in_cents` | Deposits asked for, not settled |
| `queued_withdrawal_cents` | What queued and parked requests still ask for |
| `pending_out_cents` | Withdrawals on their way |
| `paid_out_cents` | Withdrawals paid |
| `unresolved_cents` | Movements swept with no answer, either way |
| `firms_with_balance` | How many firms hold a balance |

**`on_chain`** is null unless the pool has an [on-chain treasury](#on-chain-treasuries). Then it is in USDC base units (`unit: "usdc_base_units"`, a number while exact, a decimal string above 2^53):

- `principal` is the pool account's `total_principal`, read at `principal_as_of`.
- `deposited` (deposits not rejected), `indexed_principal` (what is left of them), `queued` (open and parked requests' remaining) and `paid_out` are sums of what the indexer read, as of `indexed_at`.

A figure that can't be measured is null, never 0, with its reason in `not_measured` (keyed by field): the pool account couldn't be read, or the indexer hasn't read the treasury's history yet.

Any other caller, such as a liquidity provider browsing pools, gets `capital: null` and `capital_not_shown` saying why. Rows from a Mynt before this have neither field, and Studio's My pools shows Not measured for them.

### How money actually moves

Mynt has no direct path that instructs a pool's rail. Mynt instructs no `ach`, `wire`, `rtp`, `fednow` or `push_to_card` rail, and pool movements aren't ramp customer transfers. See [Which rails Mynt instructs](money-rails.md#which-rails-mynt-instructs).

1. A deposit or withdrawal is a `requested` row in the ledger.
2. The licence provider sees it (`list_money_movements`, `list_withdrawals`) and moves the money on its rail.
3. The licence provider says what happened with `report_pool_movement`: `submitted`, `settled`, `failed` or `returned`.

That report is what settles a position, so the licence provider's word on its own rail is the source of truth for these movements. A live settlement needs its `external_ref`.

A licence provider should check a movement's `pool_hold` in `list_withdrawals` before moving money on a requested row.

### Pool flags

A settlement is a fact, so it is recorded even if it takes the firm's position below zero (for example a deposit returned before a payout landed). That raises an open `negative_balance` flag with the partner's `external_ref`. The flag stays in `ops_status` and `list_pool_flags` until a Mynt admin closes it (`resolve_pool_flag`).

The one settlement refused is a double claim: a withdrawal written off for certain whose amount has since gone out another way. That is flagged too (`double_claim`), and a Mynt admin can accept or reject it.

### Pool tools

| Tool | Who | What it does |
| --- | --- | --- |
| `create_pool` | Builder | Proposes a pool on its firm's sponsored component |
| `approve_pool` | Licence provider | Approves a pool it sponsors and names its approved rails |
| `set_pool_offering_cleared` | Mynt admin | Records who cleared a pool's offering and the legal basis; the gate on real commitments |
| `report_pool_movement` | Licence provider | What became of a movement of a pool it sponsors |
| `list_pool_flags` | Mynt admin, licence provider | Items open until someone deals with them: `negative_balance`, `double_claim`, `link_conflict` |
| `resolve_pool_flag` | Mynt admin | Closes a flag, with a reason, together with its effect on the ledger |
| `set_pool_firm_state` | Mynt admin, the pool's licence provider | Corrects a firm's state |
| `respond_to_state_correction` | Liquidity provider | Accepts or disputes a correction |
| `commit_to_pool` | Liquidity provider | Commits capital: a deposit on the pool's rail |
| `request_withdrawal`, `cancel_withdrawal` | Liquidity provider | Joins or leaves the queue |
| `list_my_positions` | Liquidity provider | Contributed, withdrawn, balance, and what is pending, unresolved or reversed |
| `list_pools` | All of the above | Pools, scoped to the caller |
| `list_withdrawals` | All of the above | The queue, in order, with why each request is waiting |
| `pause_pool`, `resume_pool` | Mynt admin, the pool's licence provider | Stops or restarts a pool; with `close: true`, closes it |
| `list_pools_with_health` | Liquidity provider | The pools it may see, side by side: coverage, trend, gaps, verified status and reserve headroom |

Notes on the tools:

- **`create_pool`** takes an optional `idempotency_key` (8 to 200 characters, like `commit_to_pool`'s), which makes a retry safe. The same key with the same arguments from the same person returns the pool made the first time (`replay: true`) and not a second one. The same key with different arguments is refused (`idempotency_conflict`). Keys are each caller's own, so another person's same key is a separate proposal. Without a key, every call proposes a new pool.
- **`resolve_pool_flag`** accepts or rejects a double claim, or links or closes a `link_conflict` (counted against the pool's headroom until then). It can't be called by anyone at the pool's licence provider, the product's firm or the firm it concerns.
- **`list_pools`** scope: a Mynt admin sees all; a builder its products'; a licence provider what it sponsors; a liquidity provider those it is in, or that are approved and sandbox or cleared. Each row has its `capital` totals for a Mynt admin, its builder and its licence provider.
- **`list_pools_with_health`** gives numbers only for pools of products the caller is committed to, through product health's own entitlement, so an admin account is still refused them. Otherwise each is null with its reason.

### Audit and separation from customer figures

- Every one of these tools, and every refusal that matters, is in the audit log, including the read-only ones.
- The worker's own actions are `pool_auto_paused`, `pool_auto_resumed`, `pool_withdrawal_claimed` and `pool_withdrawal_refused`.
- Pool deposits and payouts are in the ledger but left out of the product's health flows and failure rates (`flowsFor`), which describe its customers.
- Sandbox pools are left out of the product's open withdrawal count.
- Everything a position, request or movement shows carries `sandbox`, so test money can't be read as real.

## The withdrawal queue

The withdrawal queue is first in, first out per pool (`request_withdrawal`, `cancel_withdrawal`, `list_withdrawals`). A request becomes eligible after the pool's notice period.

A worker pays the queue in order: `LiquidityWorker`, a `serialLoop` like Mynt's other workers, every `LIQUIDITY_POLL_MS` (default 60 seconds).

### The latest snapshot

The latest snapshot of the pool is the newest finished one, published or missed. A period still waiting for its co-signature or the chain doesn't count yet. See [Product health](licence-providers.md#product-health).

Payment stops, with the reason shown in `pause_reason` and each request's `waiting_reason`, if:

- there is no snapshot;
- it is a missed period;
- a live pool's snapshot is sandbox-sourced, or not from the licence provider's live ledger, or isn't verified;
- it is older than `POOL_HEALTH_MAX_AGE_MINUTES` (default twice the health interval);
- reserves or obligations are null (the reason is the one the figure carries);
- it is from a licence provider other than the pool's.

Sandbox pools use sandbox figures and don't need `verified`, which a sandbox snapshot never is.

A pool's snapshots read its own licence provider's books, so a second licence provider's pool is judged on its own firm's figures.

**A live pool needs a verified live-ledger snapshot, so no live pool can pay out until its licence provider's real ledger is connected** with the [partner kit](licence-providers.md#partner-kit).

### The reserve

A request is paid only as far as the pool's reserves, less whatever may have left since that snapshot was read, stay at or above the minimum.

A licence provider's reserves for a product are one figure (per sponsor per product: see `core/src/partner-ledger/types.ts`). So that licence provider's pools on the product share one headroom, locked together in id order. What is subtracted is:

- every withdrawal of its real pools on its way, unresolved, or settled after that reading;
- its other outflows on the product since then;
- any deposit reversed since.

Money leaving those reserves in a way Mynt can't see (outside its movement ledger) is treated as none until the next reading shows it.

Payment can be partial. The rest stays at the same place in the queue, with nothing behind it passing.

### Rail limits and refusals

- A payment is capped at the rail's per-transfer limit.
- The rail's daily limit and status are checked at the chokepoint. A refusal there sends the amount back to the queue and shows in `hold_reason`.
- The worker waits 15 minutes before asking again after a refusal about the rail.
- A refusal about one firm (a state the rail doesn't serve) parks that request after three refusals (`status: parked`, `status_reason`), so the queue moves on.
- A parked request keeps its place. The worker checks it again.
- Those re-checks ask the rails without making a movement, and back off (15 minutes doubling to 6 hours). A request that stays refused leaves no new rows or audit entries.
- A suspended firm, one with a parked request, or one whose own payment outcome isn't known yet is passed over and doesn't stop the firms behind it.

### Correcting a firm's state

The pool's licence provider or a Mynt admin can correct a parked firm's state with `set_pool_firm_state`. A correction must pass the money rails' own sponsorship and licence checks.

| Who corrects | When it applies | What the firm can do |
| --- | --- | --- |
| The pool's licence provider | Only when the firm accepts it (`respond_to_state_correction`, listed in `list_my_positions`). So it can't be used to park or pass over a firm | Accept or dispute |
| A Mynt admin | At once | Dispute it for `POOL_CORRECTION_DISPUTE_DAYS` days (14 by default), which restores the old state and who set it |

- A licence provider's proposal never replaces an admin's applied correction, so it can't take the right to dispute away. Only a newer admin correction, or the firm's own acceptance of a pending one, does.
- Only the latest correction can be answered. A new one replaces any the firm hasn't answered.
- The state's source is kept on the commitment and each movement (`sponsor_corrected`, `admin_corrected`), so a sponsorship change doesn't cost a firm its place.

### Automatic pausing and resuming

- **Health.** When health drops, the worker sets the pool to `paused` (`pause_kind: health`). When a snapshot shows it above its minimum again, the worker sets it back to `open`.
- **Governance.** A revoked sponsorship, an inactive licence provider or a drifted product pauses the pool the same way (`pause_kind: governance`). That clears itself once the cause is gone.
- **Covenants.** A [covenant](licence-providers.md#covenants) pause doesn't pause a pool. It stops new sign-ups and never money movements, so on its own it stops neither a pool's deposits nor its withdrawals (health gates still apply). Pool capital isn't in the money in flight a covenant reports.

A real deposit is checked against the pool's latest health every time, open or paused:

- It is let in only if a snapshot Mynt trusts shows the pool healthy, or short of its reserve, because new capital is how a pool gets back above it.
- If the snapshot is missing, stale or unverified, there is no telling what the pool could pay back, so the deposit is refused with the reason (`health_unconfirmed`).

A newly approved live pool stays paused until the worker's first check. Every other pause stops commitments too.

### Manual pauses

- A Mynt admin or the pool's licence provider can `pause_pool` and `resume_pool`. The worker never lifts a manual pause.
- A licence provider can't lift, change or close over an admin's pause. Only an admin's resume clears it.
- Approving never reopens a closed pool.
- With `close: true` a pool stops taking commitments for good but keeps paying its queue, subject to the same checks.

### Nobody gets paid twice

The claim is one Postgres function that locks the pool's row (as `reserve_money_movement` locks the rail) and takes the amount from the request before the chokepoint is asked. Concurrent workers can't both have it and can't overdraw the reserve between them.

- A worker that dies between the claim and the chokepoint is picked up on a later tick.
- A claim that already has a ledger row is tied to it first, under any pause, since that moves no money. It is never released.
- A withdrawal claim with no ledger row is released, so it is claimed again against headroom as it is now, once the pool has passed its gate.
- A deposit is re-checked against the pool's status and `offering_cleared`.
- A payment that failed for certain goes back to the same place in the queue.
- A payment whose outcome isn't known counts as gone until the licence provider says, and holds the firm's request.
- A payment returned after settling isn't paid again by itself, so the firm asks again. A request whose whole amount came back is `returned`.

## On-chain treasuries

A pool's capital can instead be held on chain, as USDC, in the app's own treasury program built from Mynt's template (`core/workspaces/coding-build/templates/solana-treasury`, program `mynt_treasury`; its README has the rules).

**Devnet by default.** A treasury is registered on mainnet only after a Mynt admin turns the switch on with `configure_treasury_mainnet` and the pool passes the mainnet checks. Otherwise every mainnet request is refused with `mainnet_disabled`. See [Treasury mainnet](#treasury-mainnet). The [mainnet program gate](solana-programs.md#mainnet-program-gate) is unchanged.

**Mynt never signs for a person's funds and never holds their keys.** It prepares an unsigned transaction whose fee payer and only signer is the person's own wallet, which signs and sends it.

The code is `core/src/treasury.ts`, `core/src/treasury-tools.ts` and `core/src/solana/treasury-chain.ts`.

### Registering a treasury

1. The builder of the pool's product initialises the treasury with Mynt's attester (`get_treasury_attester`) among its `attesters`.
2. The builder calls `register_treasury_pool({ pool_id, cluster: "devnet", program_id, pool_address })`.
3. Mynt reads both the program and the pool account from devnet and checks them.

Mynt refuses:

| Refusal | When |
| --- | --- |
| `not_a_program` | The program isn't an upgradeable program |
| `not_a_treasury_pool` | The account isn't a `mynt_treasury` Pool at its own address `["pool", creator, pool_id]` |
| `wrong_cluster` | The pool's `cluster` isn't devnet's genesis hash |
| `wrong_mint` | The mint isn't devnet USDC |
| `attester_missing`, `unexpected_attesters` | The attesters aren't exactly `[Mynt's attester, none]`. Another attester could admit depositors Mynt never checked |
| `not_pool_owner` | The pool isn't the builder's own |

The pool must be the builder's own: its `creator` or `authority` is a verified Solana wallet linked to the registering builder's sign-in. A Mynt admin may register any pool.

Registration records the program's executable hash (sha256 of its bytes without trailing zeros) and its upgrade authority.

`verified_build` is true only when the deployed bytes are the template's verifiable build at that address. A registration queues Mynt's own rebuild of the template at that program id. Until the rebuild finishes, the pool shows `build_status: "unverified build"`, which devnet accepts. See [Verified builds and upgrade locks](#verified-builds-and-upgrade-locks).

### A treasury in pool listings

`list_pools` and `list_pools_with_health` rows of such a pool carry a `treasury` object, read from the pool account (cached up to 60 seconds):

`treasury: { cluster, program_id, pool_address, verified_build, build_status, build_note, program_hash, upgrade_authority, on_chain_terms, on_chain_error }`

`on_chain_terms` has:

- terms: `lock_in_seconds`, `notice_seconds`, `review_window_seconds`, `min_reserve`, `min_reserve_bps`, `commitment_min`, `commitment_max`, `min_request`, `topups_when_health_paused`;
- state: `sponsor_paused`, `health_paused`, `winding_down`, `deposits_paused`, `pending_terms_effective_at`;
- attesters: `attesters`, `mynt_attester_approved`;
- accounts: `usdc_mint`, `vault`, `authority`;
- totals: `total_principal`, `total_queued` and `as_of`.

Amounts are USDC base units (6 decimals), a number while exact and a decimal string above 2^53.

### The attester

The attester is a dedicated Ed25519 key, generated once and sealed in the vault under its own role (`treasury_attester`), like the product-health publisher. Each cluster has its own. It holds no funds, pays no fees and is never an account of a transaction.

It signs only the program's deposit approval:

`"MYNTDEP3" ‖ program id ‖ cluster ‖ pool ‖ depositor ‖ nonce (u64 LE) ‖ amount (u64 LE) ‖ expiry (i64 LE)`

- It signs at the wallet's position nonce, for exactly the amount prepared, expiring within ten minutes.
- Every deposit moves the position's nonce on, so an approval admits one deposit of that amount.
- The cluster the devnet attester signs is always devnet's genesis hash. The attester itself refuses any other, and a pool account naming another is refused (`wrong_cluster`).

**Earlier builds.** Pools registered on builds before MYNTDEP3 keep the earlier `"MYNTDEP2"` layout: no amount, reusable until it expires. `register_treasury_pool` records which layout each pool's program checks (`deposit_approval`), knows it for the template's own builds (`earlier_builds` in `core/schemas/solana-treasury-template.json`), and keeps a pool's layout when it is registered again.

**Who it signs for.** It signs only when all of these hold:

- the wallet is a verified Solana wallet linked to the caller's sign-in (`get_linked_accounts`);
- the caller's firm is active, and isn't the pool's licence provider or its product's firm;
- the pool is approved and either sandbox or cleared (as for `commit_to_pool`);
- the deposit is within the pool's on-chain commitment limits per wallet and its per-firm limit across the firm's wallets;
- the pool is open at Mynt and not paused or winding down on chain.

**Attester changes stop it.** If the pool's attesters stop being exactly `[Mynt's, none]` (a `TermsApplied` or `AttesterRemoved` event the indexer reads, or the fresh read before signing), Mynt sets the pool's `attesters_flag`. The flag is shown in the pool's `treasury` view and in `ops_status`, and audited as `treasury_attesters_flagged`. Mynt approves no deposits to the pool (`attesters_changed`) until its builder registers it again with the attesters put back.

`prepare_*` calls are limited to 20 a minute per person (`rate_limited`).

### Deposits

`prepare_treasury_deposit({ pool_id, wallet, amount_usdc_base_units, max_lock_in_seconds })` returns:

`{ cluster, transaction_base64, expires_at, last_valid_block_height, summary: { pool, pool_id, pool_address, amount, lock_in_seconds, notice_seconds, review_window_seconds, wallet, verified_build } }`

The transaction is an unsigned v0 transaction with the Ed25519 attestation instruction then `deposit`, a fresh blockhash and the wallet as fee payer. A blockhash lasts about a minute, so a wallet that takes longer prepares again.

Refusals carry `code`: `wallet_not_linked`, `not_liquidity_provider`, `offering_not_cleared`, `over_limit`, `under_minimum`, `pool_paused`, `not_on_chain`, `mainnet_disabled`, `terms_changed` (the lock-in is longer than `max_lock_in_seconds`), `insufficient_usdc`, `attester_removed`, `rpc_unavailable`.

### Withdrawals

`prepare_treasury_withdrawal({ pool_id, wallet, deposit, amount_usdc_base_units, max_notice_seconds })` returns the same shape with one `request_withdrawal` instruction and no attestation. `deposit` is the deposit record's address.

Refusals: `deposit_not_found`, `deposit_rejected`, `in_review`, `deposit_locked`, `over_limit`, `below_min_request`, `terms_changed`, and the deposit's codes above.

### Health checks on a treasury pool

The liquidity worker pauses a pool that has no finished health snapshot. There is one exception, while there is no health reading at all (no snapshot yet, or product health not running): a **sandbox** pool with a registered on-chain treasury whose attesters aren't flagged. The treasury program enforces its own reserve floor and pauses on chain.

- The worker leaves such a pool open with `hold_reason: "Health checks not configured; the on-chain treasury enforces reserves"`.
- On its next tick it reopens one it had paused only for the missing snapshot (audited as `pool_auto_resumed` with that reason).
- `prepare_treasury_deposit` follows the same rule.

Nothing else changes:

- Real-money pools, pools on rails and flagged pools are still paused for a missing snapshot.
- A snapshot that exists and fails (missed, stale, below the reserve) still pauses even an exempt pool.
- A Mynt admin's or licence provider's pause stays until they lift it.

### Balances

`get_wallet_balances({ address, cluster })` returns `{ sol_lamports, usdc_base_units, usdc_mint, usdc_account }` for one of the caller's own verified linked wallets (`wallet_not_linked` otherwise).

### Indexing

Every `TREASURY_INDEX_POLL_MS` (30 seconds by default) the HTTP server indexes each registered pool in two steps, with bounded work per poll and nothing skipped:

1. **Scan.** A scan pages backward from the newest signature to the stored cursor: five pages of 1000 a poll, resuming where it stopped on the next poll, keeping what it finds.
2. **Read.** Once the scan reaches the cursor, the cursor moves to the newest signature the scan started from. The transactions found are read oldest first, `TREASURY_INDEX_PER_POLL` a poll (200 by default). A new scan starts once they have all been read.

It reads the events the treasury itself logged for that pool, each once: `DepositMade`, `DepositRejected`, `WithdrawalRequested`, `WithdrawalPaid`, `RequestCancelled`, `RequestVoided`, `RequestParked`.

### On-chain positions

`list_my_positions` also lists `source: "on-chain", cluster: "devnet"` rows per pool and wallet. Rows from the rails carry `source: "off-chain"`.

A wallet counts for a firm, in its positions and its per-firm limit, only through its current link: the caller's own linked wallets, and those the firm's people prepared from while each is still at the firm and still links it. A record whose person left or unlinked it is dropped.

Each row has:

- `principal`, `deposited`, `paid`, `queued`, `available_to_request`;
- a `deposits` array, each with `deposit` (the record's address to pass to `prepare_treasury_withdrawal`), `amount`, `remaining`, `queued`, `unlocks_at` and its review window;
- each request with its `status` (`open`, `parked`, `paid`, `cancelled`, `voided`) and `payable_at`.

### Transaction status

`get_treasury_tx_status({ signature })` says whether a sent transaction is `not_found`, `processed`, `confirmed`, `finalized` or `failed`.

Once the transaction is confirmed, the call queues the registered pools it touched for the indexer, which reads them in the background straight away (`queued_pools`). It is limited to 30 calls a minute per person (`rate_limited`).

### Treasury tools

| Tool | Who | What it does |
| --- | --- | --- |
| `get_treasury_attester` | Builder, Mynt admin | Mynt's attester key, to name in a pool's attesters |
| `register_treasury_pool` | The pool's product's builder, Mynt admin | Names a pool's treasury, checked on chain |
| `prepare_treasury_deposit` | Liquidity provider | An unsigned deposit for the person's own wallet to sign |
| `prepare_treasury_withdrawal` | Liquidity provider | An unsigned withdrawal request for the person's own wallet to sign |
| `get_wallet_balances` | Liquidity provider | SOL and USDC of one of their own linked wallets |
| `get_treasury_tx_status` | Liquidity provider, builder, licence provider, Mynt admin | Whether a sent transaction landed |
| `configure_treasury_mainnet` | Mynt admin | Whether treasury mainnet is on and ready; turns it on or off |

### Treasury settings

The server's settings, by name:

| Setting | What it is |
| --- | --- |
| `SOLANA_RPC_URL_DEVNET` | The devnet RPC. The public endpoint by default |
| `SOLANA_DEVNET_USDC_MINT` | Circle's devnet USDC by default |
| `SOLANA_RPC_URL_MAINNET` | The mainnet RPC, needed for treasury mainnet |
| `MYNT_VAULT_KEY` | Seals the attester |
| `TREASURY_INDEX_POLL_MS`, `TREASURY_INDEX_PER_POLL` | The indexer's pace |
| `TREASURY_WATCH_POLL_MS` | How often the watch reads each program |
| `TREASURY_MIN_UPGRADE_TIMELOCK_HOURS` | The shortest time lock a multisig may have (48 by default) |

### Before mainnet

Devnet takes the treasury as it is. Before any treasury holds mainnet money, three things are required. All three are built.

#### Approvals bound to the deposit

The template's `MYNTDEP3` approval signs the exact amount, and `deposit` moves the position's nonce on every deposit, so an approval admits one deposit of that amount.

Mynt records every MYNTDEP3 approval it issues (`treasury_approvals`) in the same transaction it signs it in, under a lock per firm and pool. It checks the firm's limit exactly, under one lock per pool. The limit counts:

- the on-chain principal of every wallet that counts for the firm: linked to its people now, or ever approved by Mynt for this firm in this pool (`treasury_firm_wallets`), so unlinking a wallet frees no room;
- every approval that can still land, whichever firm it was issued to.

An approval can still land when it is unexpired (by the cluster's own clock, read with the positions, or by Mynt's less two minutes) and at a nonce the wallet hasn't passed. Of several at one nonce only the largest counts, since only one can land.

Further rules:

- A program redeployed since its pool was registered gets no approvals (`program_upgraded`) until it is registered again.
- A pool reports `firm_limit: "exact"` only for a verified build on MYNTDEP3. An unverified build's layout is its builder's word, so its limit is shown as advisory.
- Pools still on the earlier `MYNTDEP2` build keep it on devnet, where Mynt's limit check stays advisory. Mainnet takes only MYNTDEP3 builds.

#### A pool's cluster checked against the chain it is on

The program binds an approval to `pool.cluster`, which the pool's creator sets and the program doesn't check. One program id can be deployed on several clusters at the same pool addresses.

- Mynt reads a treasury only through an RPC checked against the cluster's genesis hash.
- It refuses a pool whose `cluster` isn't that chain's genesis hash (`wrong_cluster`), on devnet and on mainnet.
- On mainnet it also requires a program id no devnet treasury uses.

A devnet approval can never admit a deposit into a pool Mynt registered on mainnet.

#### Only verified builds at their own address with a locked upgrade authority

Both are checked for every pool and listed in its `mainnet_blockers`. Mainnet itself stays off (`mainnet_disabled`) until a Mynt admin turns it on, a separate decision.

### Verified builds and upgrade locks

#### Verified build

Mynt rebuilds the treasury template at a pool's own program id itself.

- `core/src/treasury-template.ts` writes the template with its declared id swapped for the pool's: in the program's `declare_id!`, `Anchor.toml` and the extension probe. A template change that adds or drops one fails loudly.
- A worker (`buildTick`, once a minute, one at a time) builds it in an agent sandbox with Mynt's verifiable build script, as CI does. It reads back the program's hash, its declared id and its Cargo.lock (`treasury_builds`, one per program id and template build).
- A pool is a verified build when its deployed bytes are that build. The template's own id is checked against the manifest directly.

Queueing and retries:

- The first registration of a program id queues the rebuild (at most three waiting per person).
- Pools on that id are re-judged when it finishes, except one redeployed since it was registered, which is told to register again.
- A failed rebuild is retried when the pool is registered again, and after three failures a day after the last.
- The worker claims a rebuild before creating its sandbox, never runs two at once, and fails a rebuild whose sandbox is gone.

CI's `solana-treasury` job builds the template at a fresh id with the same code and checks it the same way. Only a verified MYNTDEP3 build has an exact firm limit.

#### Upgrade lock

At registration Mynt reads who can change the program:

| Value | Meaning |
| --- | --- |
| `immutable` | No upgrade authority |
| `timelocked_multisig` | The authority is a vault of the Squads v4 multisig named in `upgrade_multisig`, which has no config authority, needs at least two of its voting members, and has a time lock of at least `TREASURY_MIN_UPGRADE_TIMELOCK_HOURS` (48 by default) |
| `unlocked` | Anything else, with the reason |

- A multisig's config changes go through the same proposals and time lock.
- A program whose data can't be read is unlocked, never immutable.
- Mynt approves no deposits to a pool whose program was redeployed or whose upgrade authority changed since registration (`program_upgraded`).
- Mynt approves no deposits to a pool whose multisig has since been weakened: a shorter time lock, a lower threshold, or no longer locked (`upgrade_lock_changed`). The pool is recorded as unlocked.
- A time lock shorter than the pool's lock-in plus notice is a mainnet blocker: depositors couldn't leave before an approved upgrade runs.

What stays out of Mynt's reach: Squads' own program is upgradeable by Squads, and two members may be one party.

#### Asking for mainnet

`register_treasury_pool` with `cluster: "mainnet"`, when Mynt has a mainnet RPC, reads the treasury there and returns `mainnet_checks`:

- the pool bound to mainnet's genesis hash;
- a verified build (a rebuild is queued only for the pool's own builder);
- the upgrade lock;
- MYNTDEP3;
- USDC;
- a program id no devnet treasury uses;
- attesters exactly `[Mynt's mainnet attester, none]`;
- the caller owning the pool;
- a pool that isn't sandbox.

It registers the pool on mainnet only when treasury mainnet is on and every check passes. Otherwise it registers nothing (`mainnet_disabled`).

### Treasury mainnet

#### Off until a Mynt admin turns it on

`configure_treasury_mainnet` with no arguments says whether treasury mainnet is on and whether the server is ready. Ready means:

- a mainnet RPC (`SOLANA_RPC_URL_MAINNET`, checked against mainnet's genesis hash);
- the vault for Mynt's **mainnet attester**, a key of its own (`get_treasury_attester` with `cluster: "mainnet"`). It signs only mainnet approvals; the devnet attester signs only devnet's.

`enabled: true` turns it on only when ready (`mainnet_not_ready`). `enabled: false` turns it off at once.

Both are audited (`treasury_mainnet_enabled`, `treasury_mainnet_disabled`), as is each mainnet registration (`treasury_mainnet_registered`).

#### While it is on

A mainnet treasury works as a devnet one does, on mainnet:

- Approvals name mainnet's genesis hash and come from the mainnet attester.
- Deposits take Circle's USDC (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- `get_wallet_balances` and `get_treasury_tx_status` take `cluster: "mainnet"`.
- The indexer reads mainnet pools from mainnet.

Every mainnet deposit re-checks that the switch is on, the pool isn't sandbox, its offering is cleared, and it is still a verified MYNTDEP3 build with a locked upgrade authority, as well as everything a devnet deposit checks.

Separation between clusters:

- Each operation reads only its pool's own cluster. What Mynt caches or re-judges per pool is kept per cluster.
- A pool on mainnet is never registered back onto devnet.
- A devnet treasury can't share a mainnet treasury's program id (`cluster_mismatch`).
- A mainnet treasury can't move to another address while it still holds deposits, and an address with devnet records can't become one.
- A multisig's time lock must cover the pool's lock-in plus notice, at registration and at every deposit.

`get_wallet_balances` and `get_treasury_tx_status` read mainnet even with the switch off, when Mynt has a mainnet RPC.

Asking for the mainnet attester's address (`get_treasury_attester`) creates that key in the vault the first time. It holds no funds.

#### Turned off

With the switch off, or for a pool no longer passing, Mynt prepares no mainnet deposits and signs no approvals.

Withdrawal requests are never held to the conditions for depositing. They are still prepared, and the program pays them on its own terms.

#### The watch

Every five minutes (`TREASURY_WATCH_POLL_MS`), for every registered pool on either cluster, Mynt reads its program's last-deployed slot and upgrade authority, and its multisig when one holds it.

A redeploy, a new authority, or a multisig no longer locked or weaker than registered sets the pool's `program_flag`. The flag is audited as `treasury_program_flagged` and counted in `ops_status`. Mynt approves no deposits to the pool (`program_changed`) until its builder registers it again.

An unreadable chain flags nothing. Deposits still re-check the program themselves.

#### What is still the operator's before turning it on

- a mainnet RPC provider;
- the human audit of the treasury program;
- the legal review of liquidity deposits;
- the mainnet program gate letting the verified template through. It still refuses programs that move tokens.

## Earn in Studio

In Mynt Studio, pools are on the **Earn** page (`/earn`), in the sidebar for builders and liquidity providers. The page has an assistant and, beside it, a panel of tabs:

- **Pools**: every pool open to the person, with **Commit capital** for liquidity providers.
- **My pools**: for builders, their products' pools.
- **My strategies**: what the assistant drafted. Commitments and withdrawals for liquidity providers, pool proposals for builders.

See [Earn](studio.md#earn) for the page as a whole.
