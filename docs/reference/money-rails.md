# Money rails

This file covers the pre-approved rails money moves on, the one check every money movement passes (the chokepoint), what a licence provider must supply before a live movement, and the money ledger. It is for licence providers, builders and Mynt admins.

See also: [Firms, licences and licence providers](licence-providers.md), [Liquidity pools and on-chain treasuries](liquidity-and-treasury.md), [Vendors and the marketplace](vendors-and-marketplace.md), [Runtime API](runtime-api.md).

Money moves off-chain only, through rails a Mynt admin has approved. Solana programs never move money, and Mynt never holds customer funds: it instructs the licence provider's rail. Rails, the chokepoint and the ledger are in `core/src/money-rails.ts`.

## Rails

A rail is a pre-approved way money moves. It belongs to a licence provider's firm.

### What a rail holds

| Field | Values |
| --- | --- |
| `kind` | `ramp_adapter`, `ach`, `wire`, `rtp`, `fednow`, `push_to_card` |
| `provider` | For a `ramp_adapter` rail, a ramp adapter id (`bridge`), or, for a ramp partner speaking Mynt's wire contract itself, the id of its transfer offering |
| `direction` | `on_ramp`, `off_ramp`, `payout`, `deposit` |
| States | The US states it may be used in, as ISO 3166-2 codes such as `us-ny` |
| Limits | A per-transfer limit and a daily limit, in integer US cents. The day is the UTC day |
| `status` | `proposed`, `approved`, `suspended`, `revoked` |
| Approval | Who approved it and when |

### Which rails Mynt instructs

Mynt instructs transfers only on `ramp_adapter` rails: through a ramp adapter, or through a ramp partner speaking the wire contract. See [The Mynt Ramp](vendors-and-marketplace.md#the-mynt-ramp).

Mynt instructs no `ach`, `wire`, `rtp`, `fednow` or `push_to_card` rail. Those can be proposed and approved. A liquidity pool's movements on them are authorised and recorded by Mynt, moved by the sponsoring licence provider on its own rail, and settled by its `report_pool_movement`. See [Liquidity pools](liquidity-and-treasury.md#liquidity-pools).

### Licence coverage of a rail

Each of a rail's states must be covered by a licence of the firm that:

- is verified and in force;
- grants `us_money_transmission` in the regulatory model;
- has its prerequisites held (the FinCEN registration);
- reaches the state: its type names that state, or it is a federal charter whose type covers `us`.

Further rules:

- A licence that reaches a state or the country without that grant counts for nothing.
- A federal regulator's licence type that doesn't set `covers` isn't counted anywhere. `approve_rail` says so, and the fix is to set it in the regulatory model.
- Valid states are the 50 states and DC. The territories aren't, until the model has licence types for them.
- Montana is valid, but has no state money transmitter licence, so a rail there can't be approved at present.

### Rail tools

| Tool | Who | What it does |
| --- | --- | --- |
| `propose_rail` | Licence provider | Proposes a rail for its firm. One live rail per firm, kind, provider and direction; to change one, revoke it and propose again. The result lists any `outside_licence_coverage` |
| `list_rails` | Licence provider, Mynt admin | Its own firm's rails; a Mynt admin sees all |
| `approve_rail` | Mynt admin | Approves a proposed rail, or puts a suspended one back. Refused, naming the states, if the firm holds no licence to transmit money in any of them. Whoever proposed the rail, or belongs to its firm, can't approve it |
| `suspend_rail`, `revoke_rail` | Mynt admin | Stop new movements at once. Movements in flight aren't cancelled: the result lists them as `in_flight` |
| `list_money_movements` | Mynt admin, licence provider, builder | The ledger, scoped: a Mynt admin all, a licence provider what it sponsors, a builder its firm's products |

Every rail change, and every refused approval, is in the audit log.

## The chokepoint

Every money movement goes through `authorizeMovement`. That means every service type a Mynt admin declared `moves_money: true` (`onramp_transfer`, `offramp_transfer`), whether its ramp partner runs through an adapter or the wire contract.

`define_service_type` makes every non-quote `ramp` type declare `moves_money`, and any type whose key or name says it moves money. A quote can't declare it or be named as a transfer. See [Declaring what moves money](vendors-and-marketplace.md#declaring-what-moves-money).

### The four conditions for a live movement

In live, a movement is refused unless all of these hold:

1. **A verified home state.** A licensed partner has verified the customer's home state in an identity check (see [Partner requirements](#partner-requirements)).
2. **A sponsorship covering that state.** A licence provider has an approved sponsorship covering that state, of the component the action serves. An action that names no component is refused: each of a product's `moves_money` actions needs a `handoff_serves_component` connection in its definition.
3. **An approved rail.** An approved rail of that licence provider fits the direction, the kind, the provider and the state, and a licence named on that sponsorship still lets the firm transmit money in the state today.
4. **Within limits.** The amount is within the rail's per-transfer limit and what is left of its daily limit.

### How the customer's state is decided

`resolveCustomerState` is the one place that decides the customer's state, afresh for every attempt.

- For live, only the verified state counts. It is recorded on the movement with `state_source: partner_verified`, the verifying partner and when.
- What a customer types (`residence_state`, through `POST /v1/client/fields`) is for sandbox mode and pre-filling forms only. It is marked `self_reported` and never satisfies a live check.
- A movement already in flight keeps the state it was reserved under.
- Erasing a customer's data takes their verified state and their ramp link with it.

The one exception is a liquidity pool's own deposit or withdrawal, which is a firm's money and not a customer's. It goes by the state the firm named, or the state a sponsoring licence provider or a Mynt admin corrected: `liquidity_provider_stated`, `sponsor_corrected`, `admin_corrected`. Those sources are accepted only with a `pool_*` action and a firm's `lp:` reference, so a customer's movement can't claim them.

Every change of state is appended to `customer_state_history` (who, when, old, new):

- It can't be updated, deleted or truncated.
- It never holds up the change it records. An old value that can't be decrypted is marked `old_state_unreadable`.
- Each movement keeps the state it used and where it came from.

### Refusals

| Refusal (`error` in the API's answer) | Status | Means |
| --- | --- | --- |
| `state_unverified` | 403 | Live only: no partner has verified this customer's home state. Nothing else stands in for it |
| `customer_state_required` | 409 | Sandbox mode only (recorded as `would_refuse`): no `residence_state` on file, or not a US state |
| `no_sponsor`, `state_not_sponsored` | 403 | No licence provider sponsors the product, or not in that state |
| `component_required`, `component_not_sponsored` | 403 | The action names no component, or no licence provider sponsors what it serves |
| `no_approved_rail`, `state_not_on_rail` | 403 | No approved rail fits, or none for that state |
| `rail_suspended`, `rail_revoked` | 403 | The rail stopped taking new transfers |
| `licence_not_in_force` | 403 | The sponsorship's licences don't let the firm transmit money in the state today |
| `over_transfer_limit`, `over_daily_limit` | 403 | Over a limit |
| `amount_unknown`, `movement_unknown` | 403 | Mynt can't tell how much it moves, or which way |
| `idempotency_conflict` | 409 | The key was used for a different movement |
| `too_many_attempts` | 409 | This movement has been tried as often as it may be |

The daily limit is checked atomically: a Postgres function locks the rail and adds up the day's ledger inside one transaction.

Each refusal is audited (`money_movement_refused`) and its quote stays usable.

### Sandbox movements

Movements in sandbox mode never move real money. They go through the same check but aren't refused and use no limit. They are in the ledger with `sandbox: true` and `would_refuse` naming what live would have said.

## Partner requirements

A live movement needs a home state verified by an identity provider its sponsoring licence provider accepts.

### Which identity providers count

An accepted identity provider is:

- the sponsoring licence provider itself; or
- an offering the licence provider (or a Mynt admin) approved for that sponsorship with `approve_identity_provider`. `revoke_identity_provider` and `list_identity_providers` go with it.

Rules on approval:

- A builder's own firm, or the firm of the person who owns the product, can never be approved for it.
- Nobody approves a provider from their own firm.
- Approval only looks forward. Checks made before it don't count.
- For a ramp, approving any of its firm's adapter offerings approves the firm's one verification record.

Each provider's result is kept separately. The latest from a provider the licence provider accepts is the one that counts, checked per movement. So another provider can't overwrite it, and a check for one licence provider doesn't satisfy another.

### When a verified state is refused

The movement is refused with `state_unverified` and the reason when:

- that provider's latest check didn't pass (`not_verified`, `no_match` or `deceased`);
- the customer's vault no longer matches what was checked. A keyed hash of the identity details is kept with the verification, so rotating `MYNT_VAULT_KEY` means verifying again;
- the check is older than `VERIFIED_STATE_MAX_AGE_DAYS` (default 365).

A `verified_at` in the future is refused. A check that began before a customer erased their data can't write a state back.

### Where a verified state comes from

Mynt takes the state from whichever of these says so:

| Source | Supplies a verified state? | What is needed |
| --- | --- | --- |
| An identity service (category `identity` or `kyc`, for example the US `identity_verification` type), with the customer's consent | Yes, if the vendor returns it | The vendor returns `residential_state` (ISO 3166-2, for example `us-ny`) in its output, only when its check verified the address and passed (the device status `verified`). A plain name, date of birth and SSN check doesn't verify an address, so it shouldn't send one. Running the check again is how a state is re-verified |
| A ramp adapter's partner record (`customerIdentity`), read when the customer is linked and before each live transfer | Only if the adapter's partner exposes it | The adapter returns `residential_state` from the partner's verified record. If it can't be read at that moment, what is on file stands |
| Bridge | **No** | See below |
| A ramp partner speaking Mynt's wire contract | Not through the ramp | It offers an identity service as in the first row |
| What the customer typed (`residence_state`) | Never, for live | |

**Bridge.** Bridge's documented `GET /v0/customers/{id}` response has no address. The address is on the create request only, and the response names `address_of_residence` just as a completed requirement. Until Bridge confirms a field carrying the verified residential state (a documented response field, or a report or webhook with it) and it is added to the adapter, customers on Bridge need a separate identity service that returns `residential_state`. Otherwise live movements are refused with `state_unverified`.

## The money ledger

The ledger (`money_movements`) has a row for every movement.

### What a row holds

- product, sponsoring licence provider, rail and direction;
- `amount_cents` and state;
- a pseudonymous customer key;
- `status`, `external_ref` and timestamps;
- an idempotency key: one quote is one movement.

The customer key is never the builder's reference or a name. It is an HMAC under a key derived from `MYNT_VAULT_KEY`. Rotating that key splits each customer's ledger and state-history rows into before and after, and nothing links the two.

### Statuses

Statuses only move forward: `requested` → `submitted` → `settled` → `reversed`, or `failed`.

- `failed` frees the amount for the day. Everything else keeps it.
- A retry of a failed movement is the same row.

### When a movement fails

Only an explicit list of partner refusals marks a movement `failed`: a customer not onboarded, an unknown quote, a refused credential and the like, never behind a 5xx.

Anything else, including a code Mynt doesn't know, leaves it `requested` with `status_detail: outcome_unknown:…`. It is still counted, because the money may have moved. From then on only the partner's own final answer to the current attempt can fail it. A retry being refused, or an earlier attempt failing, says nothing about the attempt in hand.

### Attempts

- Every attempt's request id is kept, so a settlement or reversal reported against any of them lands.
- One movement can be tried at most 10 times (`MAX_MOVEMENT_ATTEMPTS`). After that, the refusal is `too_many_attempts`.

### Settlements

- Partners' terminal answers are recorded whatever state the run is in.
- A settlement arriving after Mynt gave up moves `failed` on to `settled`, flagged `late_settlement`.
- A partner's reported total is kept in `settled_amount_cents`. `settled_amount_differs` flags a difference from what was quoted, and is null when the partner doesn't say.

### Movements nobody answers for

- Movements nobody answers for (48 hours `requested`, 45 days `submitted`) are swept to `failed` with `status_detail: stale_no_answer`.
- A transfer the poller stops waiting for without a void from the partner is `failed` with `status_detail: mynt_gave_up`.

### Reading the ledger

`flowsFor(productId, from, to)` returns, for live movements requested in `[from, to)`, `flows[direction][status] = { count, amount_cents }`.

A figure that can't be measured is `null`, never 0, with the reason in `not_measured`:

- a period starting before the ledger did;
- an unknown product;
- a direction Mynt doesn't instruct for that product. Money in a builder's own hosted flow is invisible to Mynt.

Swept movements and ones Mynt gave up on are in `unresolved[direction]`, in none of the status totals, because Mynt doesn't know what happened to them.

[Product health](licence-providers.md#product-health) reads its flows from here.
