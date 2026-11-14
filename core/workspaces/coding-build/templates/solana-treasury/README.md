# Mynt treasury template (devnet only)

Each Mynt app with a liquidity pool holds the pool's capital on chain, as USDC, in its own treasury program built
from this one template. Mynt never holds a key over the funds: the vault is a token account owned by the pool's PDA,
and the program's own rules are the only way money leaves it.

**Devnet only.** The mainnet program gate refuses this program (it calls the token program), and this template
doesn't change that. A later change lets the gate accept a deployed treasury only when its build matches the hash
recorded in `core/schemas/solana-treasury-template.json`.

Built and tested with the same pinned toolchain as `templates/solana-program` (`core/schemas/solana-toolchain.json`),
by CI's `solana-treasury` job: a verifiable build in Anchor's image, then `anchor test` on a local validator.

## Custody: what can move the vault's USDC

| Path | Who | Where it can go |
|---|---|---|
| `process_queue` | anyone | the requester's own associated token account, from the head of the queue only |
| `reject_deposit` | the pool's authority | the depositor's own associated token account, only what's left of that deposit |

Nothing else signs for the pool. There is no instruction that approves a delegate, changes the vault's owner, closes
it, or pays the authority, and the tests check the list of instructions so a new one can't slip in without review.

## Terms (account state, not code)

`initialize_pool(pool_id, terms, floor, min_timelock_seconds)` records:

- `terms`: `lock_in_seconds` (per deposit), `notice_seconds` (per request), `min_reserve` (a fixed floor in USDC base
  units) and `min_reserve_bps` (of the last attested obligations figure), `obligations_max_staleness`,
  `commitment_min` / `commitment_max` (each depositor's total principal), `topups_when_health_paused`,
  `extension_program`, `attesters` (two slots), `health_authority`.
- `floor`: the product floor. Nothing changes it, and no terms the pool ever has may be laxer: no shorter lock-in or
  notice, no lower reserve, no staler obligations figure, no lower minimum or higher maximum commitment, and top-ups
  during a health pause only if the floor allows them.
- `authority`: any key; in production a Squads v4 vault PDA with a time lock (the template only checks its signature).
- `min_timelock_seconds`: at least the notice period.

The pool's address is `["pool", creator, pool_id]`; the vault's is `["vault", pool]`.

## Deposits and the allow-list

v1 uses **Ed25519 attestations** (OnRe's pattern): the instruction just before `deposit` must be the Ed25519
precompile verifying one signature, by one of the pool's attesters, over exactly

    "MYNTDEP1" ‖ program id ‖ pool ‖ depositor ‖ expiry (i64 LE)

with `expiry` not yet passed. Each deposit is its own record (`["deposit", pool, seq]`) with
`unlock_at = settled_at + lock_in_seconds` copied from the terms in force when it was made.

The alternative, not built here, is a **Token ACL (sRFC-37) gated share token**: the pool would mint Token-2022 shares
whose accounts start frozen and are thawed by Token ACL's allow-list program, so only KYC'd holders can hold or move
them. It suits pools whose positions should be transferable; v1's positions aren't, so attestations are simpler and
need no extra mint. Switching would replace the attestation check with a check that the depositor's share account is
thawed.

**Cross-chain USDC (Circle CCTP V2)** stays outside the vault: a transfer lands in the depositor's own token account,
then enters through `deposit` and its allow-list like any other USDC. Nothing here receives CCTP messages.

## Withdrawals: a FIFO queue

- `request_withdrawal(amount)` is made against one deposit, which must be unlocked; `amount` is at most what's left
  of that deposit less what's already queued against it, so the requests on a depositor's unlocked deposits never
  add up to more than their unlocked balance. The request gets the next sequence number and
  `payable_at = now + notice_seconds`.
- `process_queue` is permissionless and pays only the request at `pool.head_seq`, as much as the vault holds above the
  reserve floor. A partial fill keeps the request at the head; nothing behind it is paid until it's done.
- At pay time the deposit is checked again: if it was rejected, the request is voided and the head moves on, so
  money still in its lock-in is never paid (#172). A locked deposit can't be requested against at all.
- `cancel_request` lets the depositor leave the queue; the queue skips a cancelled request.
- Reserve floor: `max(min_reserve, obligations × min_reserve_bps / 10000)`. `attest_obligations` takes an Ed25519
  attestation over `"MYNTOBL1" ‖ program id ‖ pool ‖ obligations (u64 LE) ‖ as_of (i64 LE)`, newer than the last and
  no older than `obligations_max_staleness`. A stale figure is kept, not dropped, so the floor never falls by
  silence.

## Pauses

- `set_sponsor_pause` (the authority) stops new deposits.
- `set_health_pause` (the authority or the health authority) stops new deposits unless `topups_when_health_paused`.
- Nothing pauses `request_withdrawal`, `cancel_request` or `process_queue`.

## Terms changes

`propose_terms(terms, effective_at)` (the authority) needs `effective_at ≥ now + max(min_timelock_seconds,
notice_seconds)`, so a depositor who dislikes the change can be paid out first, and terms within the floor.
`apply_terms` is permissionless once `effective_at` has passed; `cancel_terms` withdraws a proposal. Existing deposits
keep their lock-in and existing requests their payable time.

## The extension contract

An app's own reviewed program can extend the treasury without touching custody. When `terms.extension_program` is
set (it changes only through a timelocked terms change), the treasury calls it with plain `invoke`, never
`invoke_signed`, after a deposit and after each payment. The instruction data is
`sha256("global:on_treasury_event")[..8]` followed by `kind: u8` (0 deposit, 1 withdrawal paid), `pool`, `depositor`,
`record` (the deposit or request), `amount: u64` and `seq: u64` (Borsh), so an Anchor extension handles it as
`on_treasury_event`. Its accounts are the pool and the record, read-only, then whatever the caller passes as remaining
accounts.

An extension **can**: read the pool and the record (written back before the call), keep its own state in accounts it
owns, and refuse a deposit by failing (deposits must pass it when one is set).

An extension **can't**: sign as the pool (so it can't move the vault, which the runtime enforces), get any account as a
signer (the depositor's signature is never passed on), write to any account it doesn't own (the treasury refuses
the call), or hold up an exit: on payments the hook is best effort, and whoever cranks the queue may leave the
extension out (`ExtensionHook.called` is false).

`programs/extension_probe` is a test fixture, a hostile extension that tries to move the vault with the pool as
authority. It is never deployed.

## Events and product health

Every state change emits an event for Mynt's indexer: `PoolInitialized`, `DepositMade`, `DepositRejected`,
`WithdrawalRequested`, `WithdrawalPaid` (with `partial`), `RequestCancelled`, `RequestVoided`, `QueueAdvanced`,
`PauseChanged`, `TermsProposed`, `TermsCancelled`, `TermsApplied`, `ObligationsAttested`, `ExtensionHook`.

`snapshot` is permissionless and emits `PoolSnapshot` (vault balance, principal, queued, reserve floor, obligations,
queue positions, pauses, slot and time). Mynt fingerprints it into its `product-health` program
(`core/programs/product-health`) as that program's `record_snapshot` expects: the numbers stay off its chain, only
the sha256. The treasury doesn't call product-health itself, so a health outage can't touch the funds.

## Open questions

- The build hash is for this template's placeholder address; each app's treasury declares its own, which changes the
  bytes. The gate will need to rebuild the template at the app's address (or the template must stop embedding it).
- A depositor whose associated token account is frozen by the mint would hold the head of the queue. Moving such a
  request to the back is not built.
- No authority hand-over instruction: the authority is a Squads vault, whose members change inside Squads.
- `reject_deposit` pays the depositor ahead of the queue (only their own deposit, only to them). Whether it should
  also respect the reserve floor is a product decision.
