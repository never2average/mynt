# Mynt treasury template (devnet only)

Each Mynt app with a liquidity pool holds the pool's capital on chain, as USDC, in its own treasury program built
from this one template. Mynt never holds a key over the funds: the vault is a token account owned by the pool's PDA,
and the program's own rules are the only way money leaves it.

**Devnet only.** The mainnet program gate refuses this program (it calls the token program), and this template
doesn't change that. A later change lets the gate accept a deployed treasury only when it matches the template's
verifiable build (`core/schemas/solana-treasury-template.json`), rebuilt at the app's own address.

Built and tested with the same pinned toolchain as `templates/solana-program` (`core/schemas/solana-toolchain.json`),
by CI's `solana-treasury` job: a verifiable build in Anchor's image, then `anchor test` on a local validator. The
committed `Cargo.lock` holds every Anchor crate at the pinned release (the main suite checks it).

## Custody: what can move the vault's USDC

Every path pays a depositor's own associated token account, and nothing else ever signs for the pool.

| Path | Who | What |
|---|---|---|
| `process_queue` | anyone | the request at the head of the queue, after its notice, never below the reserve floor |
| `claim_parked` | anyone | a parked request (its account was frozen), once thawed, never below the reserve floor |
| `reject_deposit` | the authority | a deposit still in its review window: a refund of money the pool never accepted |
| `claim_surplus` | anyone | a wind-down's surplus above all principal, pro rata, once per depositor |

There is no instruction that approves a delegate, changes the vault's owner, closes it, or pays the authority, and
the tests check the list of instructions so a new one can't slip in without review.

## Terms and the product floor (account state, not code)

`initialize_pool(pool_id, cluster, terms, floor, min_timelock_seconds)` records:

- `terms`: `lock_in_seconds`, `notice_seconds`, `min_reserve` (USDC base units) and `min_reserve_bps` (of the last
  attested obligations figure), `obligations_max_staleness`, `commitment_min` / `commitment_max` (each depositor's
  total principal), `min_request`, `topups_when_health_paused`, `extension_program`, `attesters` (two slots),
  `health_authority`.
- `floor`: the product's bounds, which nothing changes. Terms may never be laxer than its minima (lock-in, notice,
  reserve, commitment, staleness, top-ups) nor stricter than its maxima (`max_lock_in_seconds`, `max_notice_seconds`,
  `max_min_reserve`, `max_reserve_bps`), so no terms change can lock exits shut. It also sets
  `review_window_seconds`.
- `cluster`: the cluster's genesis hash, which every attestation signs. The program can't read the genesis hash, so
  Mynt's gate and indexer check that a pool's `cluster` is the cluster it lives on.
- `authority`: any key; in production a Squads v4 vault PDA with a time lock (the template only checks its signature).
- `min_timelock_seconds`: at least the notice period.

The pool's address is `["pool", creator, pool_id]`; the vault's is `["vault", pool]`.

## Deposits and the allow-list

v1 uses **Ed25519 attestations** (OnRe's pattern): the instruction just before `deposit` must be the Ed25519
precompile verifying one signature, by one of the pool's attesters, over exactly

    "MYNTDEP2" ‖ program id ‖ cluster ‖ pool ‖ depositor ‖ nonce (u64 LE) ‖ expiry (i64 LE)

where `nonce` is the depositor's position nonce. `deposit(amount, approval_expiry, max_lock_in_seconds)` fails if the
terms' lock-in has risen above what the depositor agreed to. Each deposit is its own record (`["deposit", pool,
seq]`) with its lock-in and notice copied from the terms in force when it was made, and `review_until = settled_at +
review_window_seconds`.

**Review window.** Until `review_until`, the authority may refuse the deposit (`reject_deposit`): the refund goes to
the depositor's own account, and the deposit can't be requested against meanwhile, so the refund never jumps a
queue it was never in. It isn't held to the reserve floor: the pool never accepted that money. A refusal moves the
depositor's nonce on, so the attestation they used can't admit them again. After the window, nothing can refuse it.

**Removing an attester** (`remove_attester`, the authority) takes effect at once, in the terms and any pending terms:
it only ever tightens admission.

The alternative to attestations, not built here, is a **Token ACL (sRFC-37) gated share token**: the pool would mint
Token-2022 shares whose accounts start frozen and are thawed by Token ACL's allow-list program, so only KYC'd holders
can hold or move them. It suits pools whose positions should be transferable; v1's positions aren't, so attestations
are simpler and need no extra mint.

**Cross-chain USDC (Circle CCTP V2)** stays outside the vault: a transfer lands in the depositor's own token account,
then enters through `deposit` and its allow-list like any other USDC. Nothing here receives CCTP messages.

## Withdrawals: a FIFO queue

- `request_withdrawal(amount, max_notice_seconds)` is made against one deposit, past its review window and
  unlocked; `amount` is at most what's left of it less what's already queued against it (so a depositor's requests
  never add up to more than their unlocked balance) and at least `min_request` unless it's all that's left. The
  notice is the shorter of the deposit's and the current terms', and must be at most `max_notice_seconds`.
- `process_queue` is permissionless and pays only the request at `pool.head_seq`, as much as the vault holds above
  the reserve floor. A partial fill keeps the request at the head; nothing behind it is paid until it's done. At pay
  time the deposit is checked again, and money still in its lock-in is never paid (#172).
- `park_head`: if the head's account is frozen (USDC's issuer can freeze accounts), anyone can park the request, which
  keeps its claim, and the queue moves on. `claim_parked` pays it once the account is thawed, under the same checks.
- `cancel_request` lets the depositor leave the queue; the queue skips a cancelled request.
- **Reserve floor:** `max(min_reserve, ⌈obligations × min_reserve_bps / 10000⌉)`, capped at `max_reserve_bps` of the
  principal still owed, and zero in a wind-down. `attest_obligations` takes Ed25519 attestations over `"MYNTOBL2" ‖
  program id ‖ cluster ‖ pool ‖ obligations (u64 LE) ‖ as_of (i64 LE)`, newer than the last and no older than
  `obligations_max_staleness`. A figure that **rises needs both attesters** (two Ed25519 instructions just before,
  distinct keys); one that falls or holds needs one. A stale figure is kept, not dropped, so the floor never falls
  by silence.

## Pauses

- `set_sponsor_pause` (the authority) stops new deposits.
- `set_health_pause` (the authority or the health authority) stops new deposits; if `topups_when_health_paused`,
  existing depositors (principal above zero) may still top up.
- Nothing pauses `request_withdrawal`, `cancel_request`, `process_queue`, `park_head` or `claim_parked`.

## Terms changes

`propose_terms(terms, effective_at)` (the authority) needs terms within the floor and `effective_at ≥ now +
max(min_timelock_seconds, notice_seconds)`. Lock-in and notice changes bind only deposits made afterwards (each
deposit keeps its own). A change that binds existing deposits, a higher `min_reserve`, `min_reserve_bps` or
`min_request`, must also wait at least the floor's `max_lock_in_seconds + max_notice_seconds`, so every depositor
can be out first. `apply_terms` is permissionless once `effective_at` has passed; `cancel_terms` withdraws a
proposal.

## Wind-down

`propose_wind_down(effective_at)` (the authority, no sooner than the timelock and notice; `cancel_wind_down` until
then). From `effective_at`: deposits and refusals are closed, lock-ins no longer hold and the reserve floor is zero,
so the queue pays everyone out. `start_wind_down` (anyone) records the surplus, what the vault holds above all
principal still owed, and `claim_surplus` (anyone, once per depositor) pays each depositor
`surplus × their deposits / all deposits` (deposits not refused), never out of principal still owed. Rounding dust
and anything sent to the vault after `start_wind_down` stay in the vault.

## The extension contract

An app's own reviewed program can extend the treasury without touching custody. When `terms.extension_program` is
set (it changes only through a timelocked terms change), the treasury calls it after a deposit and after each queue
payment, with `invoke_signed` and **only** the seeds of the pool's hook PDA, `["hook", pool]`, which owns nothing.
The instruction data is `sha256("global:on_treasury_event")[..8]` followed by `kind: u8` (0 deposit, 1 withdrawal
paid), `pool`, `depositor`, `record` (the deposit or request), `amount: u64` and `seq: u64` (Borsh), so an Anchor
extension handles it as `on_treasury_event`. Its accounts are the hook PDA (signer), the pool and the record
(read-only), then whatever the caller passes as remaining accounts.

**Every extension must require that the hook PDA for the pool it's told about signed the call** (`Pubkey::
find_program_address(&[b"hook", pool], treasury_id)`), or anyone could call it pretending to be the treasury.
`programs/extension_probe` shows the check.

An extension **can**: read the pool and the record (written back before the call), keep its own state in accounts it
owns, and refuse a deposit by failing (deposits must pass it when one is set).

An extension **can't**: sign as the pool (so it can't move the vault; the runtime enforces it), get any account as a
signer but the hook PDA (the depositor's signature is never passed on), write to any account it doesn't own (the
treasury passes every other account read-only, however the caller marked it), or hold up an exit: on payments the
hook is best effort, and whoever cranks the queue may leave the extension out (`ExtensionHook.called` is false).
Parked claims, refusals and surplus claims don't call it.

`programs/extension_probe` is a test fixture, a hostile extension that tries to move the vault with the pool as
authority. It is never deployed.

## Events and product health

Every state change emits an event for Mynt's indexer: `PoolInitialized`, `DepositMade`, `DepositRejected`,
`WithdrawalRequested`, `WithdrawalPaid` (with `partial` and `parked`), `RequestCancelled`, `RequestVoided`,
`RequestParked`, `QueueAdvanced`, `PauseChanged`, `AttesterRemoved`, `TermsProposed`, `TermsCancelled`,
`TermsApplied`, `ObligationsAttested`, `WindDownProposed`, `WindDownCancelled`, `WindDownStarted`, `SurplusClaimed`,
`ExtensionHook`. They're `emit!` (program logs), which an RPC can truncate; see the open questions.

`snapshot` is permissionless and emits `PoolSnapshot` (vault balance, principal, queued, parked, reserve floor,
obligations, queue positions, pauses, wind-down, slot and time). Mynt fingerprints it into its `product-health`
program (`core/programs/product-health`) as that program's `record_snapshot` expects: the numbers stay off its
chain, only the sha256. The treasury doesn't call product-health itself, so a health outage can't touch the funds.

## Open questions and what an audit should focus on

- **Build hash and address.** The build hash is for this template's placeholder address; each app's treasury declares
  its own, which changes the bytes. The gate should rebuild the template at the app's address and compare.
- **Admission checks (L2).** Who may open a pool, with which floor, authority, attesters and cluster, isn't the
  program's to judge: Mynt's gate and indexer must check each pool's initial state against the product it serves
  before treating it as that product's treasury.
- **Events through logs (L6).** `emit!` events ride on program logs, which can be truncated. Moving to `emit_cpi!`
  (Anchor's `event-cpi`) adds an event-authority account to every instruction; not done here.
- **Review findings L3 and the informational items** of the review of `f1b3658` are recorded with that review, not
  restated here; they aren't changed by this template.
- **Surplus share** is by deposits not refused, whenever they were made; a time-weighted share would need more state.
- **No authority hand-over instruction:** the authority is a Squads vault, whose members change inside Squads.
- **Audit focus:** the payment paths' accounting (`record_payment`, parked claims, surplus against principal still
  owed), the Ed25519 instruction parsing and the two-attester rule, rounding in the reserve floor and the surplus
  share, the hook PDA's signature being the extension's only privilege, and compute use with an extension attached.
