# Vendors and the marketplace

This file covers the standard services vendors offer per region: service types, offerings and conformance, subscriptions, the marketplace and its standard terms, vendor onboarding, how Mynt calls a vendor, the Mynt Ramp and the wire contract. It is for vendors, for builders who subscribe to services, and for Mynt admins who define service types.

See also: [Roles and tools](roles-and-tools.md), [Agreements](agreements.md), [Runtime API](runtime-api.md), [Money rails](money-rails.md), [Platform administration](platform-admin.md).

Vendors are firms that offer standard services builders plug into their products, so that no builder has to integrate identity, verification, account data, bureau or ramp providers itself. Mynt Studio calls vendors "service providers".

A vendor's firm is a legal entity a Mynt admin adds by hand with `register_firm`. There is no self-serve discovery. To set one up:

1. A Mynt admin registers the firm (`register_firm`).
2. The admin invites the vendor's people with the `vendor` role (`invite_user`) and attaches them to the firm (`add_entity_member`). Both can be done before the person has signed in: they join the firm when they first do.
3. The vendor registers its licences (`register_license`), and an admin verifies them as for any firm.

## Service types

Like regulators, service types are defined per region. Mynt admins define them with `define_service_type`; vendors and builders read them with `list_service_types`.

### What a service type holds

| Field | Meaning |
| --- | --- |
| `key`, `region`, `name` | Its identity |
| `category` | One of `identity`, `kyc`, `account_data`, `analytics`, `credit_bureau`, `documents`, `esign`, `mandate`, `fraud`, `ramp`, `other` |
| `input_schema`, `output_schema` | JSON Schema: the one contract every vendor in that region implements |
| `consent_purpose` | The consent the customer must give |
| `fills` | The data dictionary fields its output fills |
| `innovator_licences` | Licence types, from the region's regulatory model, of which the subscribing firm must hold one |
| `vendor_licences` | Licence types of which the vendor must hold one |
| `moves_money` | Whether it instructs a money movement (see [Declaring what moves money](#declaring-what-moves-money)) |

Required inputs are data dictionary fields, because Mynt sends them from the customer's vault.

### The service types that ship

Examples ship as JSON in [`core/schemas/service-types/`](../../core/schemas/service-types). `load_service_types` loads them. An example that names a licence type your regulatory model calls something else is skipped, with the reason, until you pass `licence_map`.

The nine US service types, in `core/schemas/service-types/us`:

| Key | Service |
| --- | --- |
| `bank_account_verification` | Bank account verification |
| `credit_bureau_report` | Credit bureau report |
| `identity_verification` | Identity and SSN verification |
| `kyb_business_verification` | Business verification (state good standing) |
| `onramp_quote` | Mynt Ramp: add dollars quote |
| `onramp_transfer` | Mynt Ramp: add dollars |
| `offramp_quote` | Mynt Ramp: dollars out quote |
| `offramp_transfer` | Mynt Ramp: cash out dollars |
| `smart_contract_audit` | Smart contract audit |

The India examples, in `core/schemas/service-types/in`, ship as data only: PAN verification, CKYC search and download, Account Aggregator data fetch, bank statement analytics, credit bureau report, DigiLocker documents, eSign and e-mandate. No Indian products run today.

### What a device may be told

An optional `client_result` says what a customer's device may be told when it starts an action this service serves.

- `status` maps an output property's values to `verified`, `not_verified`, `completed`, `failed` or `pending`. Anything else is `completed`.
- `fields` lists output properties the device may see. It never lists data dictionary fields that are personal or sensitive, nor ones the service fills.
- `redirect: true` lets the device have the vendor's `redirect_url`: the provider's page, for e-sign, e-mandate and DigiLocker.

Without `client_result` the device gets a status and a reference only.

In the examples: PAN and identity verification and bank account verification give a mapped status only; bureau reports a status only; e-sign and e-mandate a mapped status and the redirect; DigiLocker the redirect.

## Offerings and conformance

### Creating an offering

`create_vendor_offering` offers a service type in a region. It names:

- a test HTTPS endpoint, and later a live one. The test endpoint may be left out of a new draft, so a vendor can [practise first](#practising-first-the-vendor-sandbox); `run_conformance` and listing need it (`update_vendor_offering { test_base_url }`);
- a fixed price per call, for builders to see. Billing is between vendor and builder, never through Mynt;
- service-level agreement (SLA) notes;
- the firm's licences it relies on.

An offering starts as `draft`. `list_my_offerings` lists a vendor's own.

### Conformance

Mynt tests the offering itself with `run_conformance`:

- signed requests with fixture inputs valid against the input schema, and every answer checked against the output schema;
- a badly signed request, and a correctly signed but stale one (over 300 seconds old), which must both be refused;
- timeouts and errors recorded;
- the vendor's licences checked against the service type.

A pass makes the offering `conformance_passed`. `update_vendor_offering { listed: true }` then lists it. Changing an endpoint or licences sends it back to draft.

### Practising first: the vendor sandbox

A vendor that has no test endpoint yet can still see Mynt's test run. Mynt serves a practice endpoint itself for every offering (`core/src/vendor-sandbox.ts`):

```http
POST <PUBLIC_URL>/vendor-sandbox/<offering_id>
```

(`<PUBLIC_URL>/vendor-sandbox/<offering_id>/v1/<service_type_key>` is the same endpoint, in the wire contract's own shape.)

It behaves as a correct vendor of the offering's service type:

- it verifies `Mynt-Signature` with the offering's conformance signing secret, and answers `401` to a bad signature or one more than 300 seconds old (and to an offering that doesn't exist, so it never says which do);
- it checks `input` against the service type's input schema;
- it answers with a fixture `output` valid against the output schema, built from the schema itself: a property's `const`, `default`, first `examples` value or first `enum` value, else Mynt's sandbox fixture for a data dictionary field of that name, else the simplest value its type, format and pattern allow. The same schema always gives the same answer (a quote's `expires_at` is one minute ahead). If Mynt can't build a valid answer for a schema it says so (`no_sandbox_answer`) and never sends an invalid one;
- it takes bodies up to 64 KB, 30 requests a minute per offering, makes no outbound call, and keeps nothing a caller sends. Its inputs are Mynt's sandbox fixtures, never customer data.

`run_practice_conformance { offering_id }` runs **the same test cases as `run_conformance`** against that endpoint, in-process, so nothing leaves Mynt and no credential is needed (ten runs a minute per offering). It returns:

- `kind: "practice"`, `passed`, `counts_as_conformance: false`, the offering's unchanged `status`, and each case's result;
- `reference`: what Mynt sends and expects for the service type, to build an endpoint against. It has the request (`sends`: method, address, the signature rule, the input and params schemas), the answer (`expects`: the shape, the time limit and the output schema), and `transcript`: every request Mynt sent in the run and the answer it got, with what Mynt expected of each. The signing secret is never in it, and each `Mynt-Signature` is shown as `t=<seconds>,v1=<redacted>`.

On a pass it says: "Practice run passed — now point Mynt at your own test endpoint and run the real test".

A practice pass is never conformance:

- **It never moves an offering.** A practice run doesn't change an offering's status, so it never makes one `conformance_passed`, and listing still needs a real pass on the vendor's own endpoint.
- **It is recorded apart.** Practice runs are kept in their own table (`vendor_practice_runs`, `kind: "practice"`), which nothing that reads conformance reads: not listing, not the marketplace's conformance result, not `list_my_offerings`' `last_conformance`, not `ops_status` or the risk register.
- **The sandbox answers practice only.** A practice request is marked `consent.artefact_ref: "mynt_practice"`; the real test marks its requests `mynt_conformance`, which the sandbox refuses (`practice_only`). So the real test fails against the sandbox however a request reaches it.
- **The sandbox is never an offering's endpoint.** `create_vendor_offering` and `update_vendor_offering` refuse a test or live endpoint whose path is `/vendor-sandbox`, and `run_conformance` refuses again.

An admin running it for another firm's offering is audited as `admin_run_practice_conformance`.

### Suspension and admin changes

- A Mynt admin can suspend an offering with `suspend_vendor_offering`, which stops listing and calls.
- An admin's changes to another firm's offering are audited as admin actions (`admin_update_vendor_offering` and the like), naming the firm.

## Subscriptions

### Finding and subscribing

`list_vendor_offerings` shows listed offerings by region, service type or category, and whether your firm meets the licence prerequisites.

`subscribe_vendor_service` checks the prerequisites and then:

- keeps the credentials the vendor issued you (if it needs any) in your firm's key vault. The vault holds one row per key, typed `vendor_test_credential` or `vendor_live_credential`, sealed with `MYNT_VAULT_KEY` and never shown again;
- sends the test credential only to the test endpoint and the live one only to the live endpoint;
- adds the vendor's firm to your roster as a party, so the regime check and drift see it.

Bind a product's partner handoff to the subscription in its definition (see [Handoffs to a vendor's standard service](products.md#handoffs-to-a-vendors-standard-service)). `list_my_vendor_subscriptions` lists a firm's subscriptions.

### Test and live

- Sandbox sessions use the vendor's test endpoint.
- `set_subscription_live` turns live calls on, with the live credential if one is needed.
- Live calls go only to a listed offering, and both sides' licence prerequisites are re-checked on every call.

### Pins and drift

The subscription's state (active, offering not suspended, both sides' licences in force) is pinned with each product version that uses it. A suspension or a lapsed licence drifts those products, pausing new sales and sending `product.drifted`, until it is restored.

### Unsubscribing

`unsubscribe_vendor_service` is refused while a live product version hands off through the subscription. Otherwise it deletes the credentials and, if the vendor joined your roster for it, ends that party. Apps built on the product change nothing.

### The signing secret

The signing secret is per subscription, and Mynt generates it.

- `list_my_subscribers` says whether it has been taken.
- `reveal_subscription_secret` shows it to the vendor once.
- `rotate_subscription_secret` replaces it. The new one is shown once, and the old one stops verifying at once.

Conformance runs use the offering's own secret, shown once by `create_vendor_offering`.

## The marketplace and standard terms

Vendor agreements are a marketplace, not a negotiation. Each offering carries the vendor's standard terms, and a subscriber accepts them by click-through.

### Standard terms

A vendor sets terms with `create_vendor_offering` or `update_vendor_offering`, as `standard_terms`:

| Field | Meaning |
| --- | --- |
| `document_url` | A link to the terms document (https) |
| `document_sha256` | Its SHA-256, 64 lowercase hex characters |
| `summary` | A short summary |
| `pricing_summary` | The pricing in words. The vendor bills subscribers directly; Mynt never bills or holds money for it |
| `scopes` | Required. What the terms cover: one or more of the agreement scopes `technology`, `manpower` and `financial_regulatory_operations`, each once (see [Scopes](agreements.md#scopes)) |

- Each change, a change of scopes included, is a new `version`. The same terms set again keep their version, whatever order the scopes are named in.
- Each new version is audited as `set_vendor_terms` with its scopes.
- Terms versions set before scopes were recorded keep none. They stay as they were until the vendor sets new terms, which then name them.
- Only the vendor's own members set terms, never a Mynt admin for it.
- Listing an offering with terms is the vendor's standing acceptance of them. Who set them and when is kept.

### What a subscriber sees

`list_vendor_offerings` shows each offering's:

- `standard_terms`: version, document link and SHA-256, summary, pricing, `scopes` and `scope_labels` (empty for a version from before scopes). It is `null` when none are on file;
- last conformance result (`null` before any run);
- whether your firm meets the licence prerequisites;
- `your_subscription_id`.

### Accepting terms by click-through

Subscribing to an offering with terms is click-through:

```json
{ "offering_id": "…", "accept_terms_version": 3, "app_ids": ["…"], "products": ["…"], "test_credential": "…" }
```

`subscribe_vendor_service` must name:

- `accept_terms_version`: the current version. An older one is refused, naming the current;
- `app_ids`: the apps it is for. The caller must be an owner or admin of each app's workspace;
- optionally `products`: the apps' products it is used for.

In one transaction Mynt records the subscription and, per app, an app agreement of kind `vendor` with the vendor's firm, already `signed`:

- by the vendor through its listing. Its signer and time are the terms' setter and time;
- by the subscriber through the click;
- with the version, document link, SHA-256, summary, pricing and scopes accepted. The scopes are the accepted version's own: an agreement on a version from before scopes records none ("Not set"), never invented ones.

Each is audited as `accept_vendor_terms`, in the obligations class, with the app's id, and the vendor is told (`app_agreement.signed`).

- A firm already subscribed names more apps the same way, to accept the current version for them too.
- A later version doesn't change agreements already made.
- Prerequisites are checked as for any subscription.

### Ending an agreement

The agreement and the subscription end together.

- `unsubscribe_vendor_service({ subscription_id, reason? })` ends every agreement accepted with it, audited as `terminate_app_agreement`, and the vendor is told.
- `terminate_app_agreement` by either side on the last open agreement of a subscription ends the subscription too.
- Both are refused while a live product version hands off through the subscription.

### What vendors and older subscribers see

- Vendors see their subscribers with the version and scopes each accepted, per app, in `list_my_subscribers`' `terms_accepted`, and the agreements in `list_app_agreements` without `app_id`.
- Subscriptions made before an offering had terms stay as they were. `list_app_agreements`' `vendor_contracts` flags them `no_standard_terms: true`, and `terms_accepted` is `null` elsewhere.
- A negotiated `vendor` agreement (`propose_app_agreement`) is still possible beside a click-through one.

### Appearing in the marketplace

To appear in the marketplace:

1. A Mynt admin adds the vendor's firm (`register_firm`) and its people with the `vendor` role.
2. The vendor creates an offering of a service type in its region.
3. The offering passes Mynt's conformance test.
4. The vendor lists it (`update_vendor_offering { listed: true }`).
5. The vendor sets its standard terms.

In Mynt Studio, the Marketplace page (`/marketplace`, for builders) lists those offerings with a Subscribe sheet. An offering's Standard terms tab and the Subscribe sheet show the scope being accepted ("You accept <vendor>'s standard terms v<n> — Scope: …"). The vendor's Set standard terms sheet has the required Scope checkboxes.

## Onboarding a vendor

`get_vendor_onboarding` shows where a vendor's onboarding stands as one ordered checklist: for the firm, then for each of its offerings. It only reads. Each step is done with the tools it names, which decide as before.

| Caller | Reads |
| --- | --- |
| A vendor's own member | Their firm's: no arguments, or their own `entity_id` |
| A Mynt admin | Any firm's (`entity_id`, or `offering_id` alone), and every vendor firm's progress (`all_firms: true`: firms with a member holding the vendor role, someone invited with it who hasn't signed in yet, or an offering) |

### Steps and statuses

Each step has a `key`, a `title`, a `status`, a `detail` in plain words, the `tool` that does it, `by` (`vendor`, `admin` or `subscriber`) and `facts`.

| Status | Meaning |
| --- | --- |
| `done` | The step is complete |
| `next` | The first thing the vendor can do now. One per checklist |
| `not_started` | The vendor's to do, after the next one |
| `blocked` | Waiting on Mynt, or on an earlier step. The detail says which, for example "Waiting for Mynt to verify your licence rbi_pa (PA-1)" |

### The checklist

| Step | Done when | Otherwise |
| --- | --- | --- |
| `firm_registered` (firm) | The firm is on Mynt and `active` | Blocked on an admin (`register_firm`, `set_entity_status`). Every step after it waits too |
| `vendor_members` (firm) | Someone at the firm has the vendor role (`facts.members`) | Blocked on an admin (`invite_user`, `add_entity_member`). Once people are invited, it waits for them to sign in (`facts.invited`) |
| `first_service` (firm) | The firm has an offering | Next: `create_vendor_offering`. Blocked while nobody at the firm has the vendor role |
| `service_created` (offering) | Always, with its service type and region | |
| `licence` (offering, only when the service type needs a vendor licence) | A verified, in-force licence of one of the types is named on the offering | Register one (`register_license`). Blocked while Mynt verifies it (`review_license`) or has suspended it. Register again if rejected or lapsed. Name it on the offering (`update_vendor_offering { licence_ids }`) |
| `practice` (offering, informational) | The latest `run_practice_conformance` passed (`facts.last_run`, `facts.counts_as_conformance: false`). The detail says to point Mynt at the vendor's own endpoint and run the real test | Not started: optional, never counted, and never the `conformance` step (see [Practising first](#practising-first-the-vendor-sandbox)) |
| `conformance` (offering) | The latest `run_conformance` passed and the offering is `conformance_passed` or `listed` (`facts.last_run`: when, who, failures; `facts.test_endpoint`: whether the offering has its own) | Run it, or run it again after a failure (named in the detail) or a change of endpoint or licences. With no test endpoint yet, give one first (`update_vendor_offering { test_base_url }`). Blocked while the licence waits on Mynt |
| `terms` (offering) | Standard terms naming their scopes are on file (`facts.terms_version`, `facts.scopes`) | Set them, with their scopes (`update_vendor_offering { standard_terms }`). App teams can't subscribe from the Marketplace without them |
| `listed` (offering) | Listed | List it once it passed (`update_vendor_offering { listed: true }`) |
| `first_subscriber` (offering, informational) | A firm subscribes (`facts.subscribers`) | Not started: it is the subscribers' choice, and never counted |

An offering can be listed before it has standard terms. Both steps then say the same thing: `listed` is done, "without standard terms: app teams can't subscribe until you set them", and `terms` is the next step.

Terms from before scopes were recorded stand, and subscribers can still accept them, but the `terms` step stays to do until new terms name their scopes.

A suspended offering's steps wait on Mynt (`suspend_vendor_offering`). Terms already set stay done.

### Progress and history

`progress`, per offering and for the firm, counts the steps done out of those counted, names the `next` one (the vendor's own first, else what waits on Mynt) and says whether it is `complete`.

With `offering_id`, `history` adds:

- that offering's conformance runs, newest first, up to 20;
- its practice runs (`practice_runs`), apart from them, newest first, up to 20;
- every version of its standard terms Mynt knows: the current one in full, and earlier ones from the audit log (version, SHA-256, scopes, when, by whom) and from the agreements that accepted them, with how many did.

A figure Mynt doesn't keep (an earlier version's summary nobody accepted, a firm not yet registered) is `null`, never 0.

### My services in Studio

Mynt Studio shows the checklist to vendors as My services (`/vendor`, in the sidebar only for accounts with the vendor role):

- the checklist on top, each step's status in words, with a labelled button where Studio can do it: Create service, Run practice test, Run conformance, Set standard terms, List service. The practice run is a line "for information";
- the firm's services in a table;
- each service's details: Conformance runs, Practice runs, Terms versions, Subscribers;
- Run practice test, beside Run conformance on a service, opens a sheet with each case's result, what Mynt sends and expects, and the run's transcript (Download transcript saves it as JSON). Create service takes a service with no test endpoint yet, to practise on.

The platform admin's Vendors section has a Vendor firms tab with each firm's onboarding progress (see [The platform admin in Studio](platform-admin.md#the-platform-admin-in-studio)).

## Calling a vendor's service

### Client actions served by the vendor

When a product's partner handoff is bound to a subscription, its client action (`POST /v1/client/actions/<handoff>`) is served by Mynt calling the vendor, instead of handing off to the product builder's URL. That holds whatever the service: identity, bureau, e-sign, e-mandate, KYC.

The developer contract marks the action `served_by: { kind: "vendor_service", service_type, client_result }`. It carries no subscription, vendor, URL or secret.

What the device needs:

- a client session with a `customer_ref`;
- the service's consent (`409 consent_required` otherwise);
- its required inputs in the vault (`409 data_required` otherwise). Only the service type's declared inputs are sent.

Which endpoint is called:

- Sandbox sessions call the test endpoint with the test credential.
- Live sessions call the live endpoint with the live credential, once the product's builder turned the subscription live (`503 vendor_unavailable` before), and only for a listed offering with both sides' licences in force.

An answer that breaks the output schema is `502 vendor_error`, and nothing is kept.

### What happens to a good answer

A good answer is:

- kept by Mynt, sealed, for the session, with evidence `action_completed` (or `action_failed`) of the action (status only), and the fields the service fills saved to the customer's vault;
- sent in full to the product builder's firm webhooks (see [Firm webhooks](#firm-webhooks)) as `vendor_action.completed`. `vendor_action.failed` carries no result;
- answered to the device with only `{ reference, action, status, sandbox }` plus what the service type's `client_result` allows.

`GET /v1/client/action_runs/<reference>` reads the device's answer back, for the same app and customer.

Handoffs not bound to a vendor keep the hand-off to the product builder's own flow.

### Asynchronous services

Asynchronous services (e-sign, e-mandate, DigiLocker) may answer the call with:

```json
{ "request_id": "…", "status": "pending", "redirect_url": "https://…" }
```

The device gets `status: "pending"` and, when the service type allows it, the `redirect_url`.

The vendor then sends the final answer to `POST /v1/vendor/callback/<subscription_id>`, signed exactly like Mynt's requests: `Mynt-Signature` with the subscription's signing secret, at most 300 seconds old (`401` otherwise). Its body is:

```json
{ "request_id": "<Mynt's>", "status": "ok", "output": {} }
```

`status` is `ok` or `error`.

- An output that breaks the schema is refused (`400 invalid_output`) and changes nothing. A good one completes the action as above.
- A repeated `request_id` is answered with `duplicate: true` and applied once.
- A valid answer whose own status maps to `pending` (the customer hasn't finished yet) also leaves the action open for the callback.
- One that maps to `failed` ends the action as failed (`action_failed`, and `vendor_action.failed` with the result).
- When an asynchronous action ends, the app's own webhooks get `handoff.completed` or `handoff.failed` with only the product, `reference`, `action` and `status`.

### The customer stays in control

- A callback that arrives after the customer withdrew the service's consent ends the action as withdrawn. Nothing of the answer is kept, and the product's builder gets `vendor_action.failed` with `error_code: "consent_withdrawn"` and no result.
- `DELETE /v1/client/fields` also erases the vendor results kept for the customer and any still queued for the product's builder, and stops their open actions.
- Actions that never finish expire (`error_code: "expired"`): a call cut short after 5 minutes, a pending one after `VENDOR_PENDING_EXPIRY_HOURS` (default 24).
- Callbacks are rate limited per caller address before the signature is checked, and per subscription only once it is.
- Sandbox results are sealed with a key derived from `MYNT_VAULT_KEY`, so a queued delivery survives a restart.

### Params and quotes

Two optional parts of a service type let a device ask for something specific and act on a price.

**Params.** `params_schema` (with `params_fixture` for conformance) declares what the device sends with each call, as `params` in `POST /v1/client/actions/<handoff>`: an amount, a currency, an asset.

- It must be an object of plain scalar properties with `additionalProperties: false`.
- It must never hold a data dictionary field that is customer data. That comes from the vault, as `input`.
- Mynt checks the params against it before calling (`400 invalid_params`). An action that takes none refuses them (`400 params_not_accepted`).

**Quotes.** `quote: true` makes the service a quote. Its output must require `quote_id` and `expires_at`, in the future and at most an hour ahead (`502 vendor_error` otherwise). The device gets `expires_at` and whatever `client_result` allows, never `quote_id`.

A service type with `accepts: "<quote key>"` (same region and category) accepts a quote.

- The device starts it with `quote: "<the quote's reference>"`, and Mynt sends the vendor `quote: { quote_id }`.
- That works only for a quote of the same app, customer, product and environment, from the same vendor, unexpired and not accepted before (`404 quote_not_found`, `409 quote_expired`, `409 quote_used`).
- Claiming a quote is atomic, so two accepts of one quote can't both go through.
- A call that fails or is refused releases the quote for another try, so vendors must treat a repeated `quote_id` as the same order.

In the developer contract, such an action's `served_by` carries `params_schema`, `quote: true`, or `accepts_quote_from: "<the quoting action>"`. The SDKs' `startAction` takes `params` and `quote`.

### Declaring what moves money

Every service type sets `moves_money`. It is `true` when the service instructs a money movement, which sends it through approved money rails (see [Money rails](money-rails.md)).

- `ops_status` reports a stored type whose name says it moves money but which is declared `false`.
- A service type can't fill `residence_state`. A partner-verified state comes as `residential_state` in an identity service's output (see [Partner requirements](money-rails.md#partner-requirements)).
- A ramp offering's `test_base_url` and `live_base_url` must be different endpoints, however they are written.

## The Mynt Ramp

All dollars in and out of digital-asset liquidity go through one ramp.

- Its service types have the category `ramp`.
- Only the firm a Mynt admin designates with `set_mynt_ramp` (audited) may offer or list them. That firm is the ramp partner, which holds funds in transit and transmits money under its own licences. Mynt never holds funds or keys.
- Mynt calls only that firm's ramp offerings, in sandbox and live. Re-designating the ramp stops calls to the old firm's at once.
- Builders subscribe to the ramp and bind handoffs to it like any vendor service.

### The four ramp service types

The shipped US types come in two pairs, each with its own consent purpose.

| Pair | Quote | Accepted by | Consent |
| --- | --- | --- | --- |
| Add dollars | `onramp_quote` | `onramp_transfer` | `fiat_onramp` |
| Cash out | `offramp_quote` | `offramp_transfer` | `fiat_offramp` |

A quote takes params `direction` (`in` or `out`) and `amount_usd`, and the customer's name and bank account from the vault. The device is shown `amount_usd`, `fee_usd`, `total_usd` (in: added to the balance; out: taken from it), `currency` (`USD`), `estimated_arrival` and `expires_at`.

A transfer usually answers pending until the bank transfer settles: `submitted`, then `settled`, `failed` or `returned`. When the customer pushes the payment, an add-dollars transfer also shows the US bank account to pay: `pay_to_bank_name`, `pay_to_account_number`, `pay_to_routing_number` and `pay_to_reference`.

The settlement leg (`settlement_asset` USDC, `settlement_network` solana, `settlement_amount`, `settlement_ref`, `settlement_tx`) is in the output, sealed to the product's builder, and never reaches a device.

All four name the licence type `fincen_msb`. Map it to yours with `licence_map`.

### Dollars only for customers

A builder's customers never see or touch crypto. Every customer-facing value is a US dollar amount, a fee, a total, a status, an arrival time or a reference.

Mynt enforces it in code (`core/src/dollars-only.ts`):

- `define_service_type` refuses a `client_result` field or a `params_schema` property whose name carries a crypto concept (asset, chain, network, wallet, address, tx, hash, token, coin, memo, a token symbol or chain name), or whose enum, const or default is a token symbol or chain name.
- It refuses a ramp currency field that isn't `USD`.
- It refuses a service type name that names a crypto concept, because the name reaches devices in error messages.
- Publishing refuses a binding to a service type stored before the rule.
- The developer contract drops such fields.
- The device's outcome drops any field, or any value that looks like a token, a chain, an address or a transaction hash, whatever the service type says.

Keep the settlement asset in the output, where it goes sealed to the product's builder.

### How the ramp partner plugs in

There are two ways. Either way, Mynt's quote and accept, conformance, callbacks and the dollars-only rule are the same.

1. **The wire contract.** The partner serves Mynt's vendor wire contract at its offerings' base URLs (see [The wire contract](#the-wire-contract)).
2. **An adapter in front of its own API** (`core/src/ramp-adapters/`). The ramp firm, or a Mynt admin, runs `set_ramp_adapter { offering_id, adapter, config?, test_credential?, live_credential? }` on each ramp offering.

With an adapter:

- The offering's base URLs are the partner's API.
- The credentials go sealed into the ramp firm's key vault (key types `ramp_partner_test_credential` and `ramp_partner_live_credential`). They are never shown, logged or put in the audit log.
- Mynt answers its own signed requests in-process. The adapter is a small typed interface (`probe`, `price`, `transfer`, `status`, `webhook`) that translates each request to the partner's API, and the partner's states and webhooks back to Mynt's.
- Partner webhooks go to `<PUBLIC_URL>/v1/ramp-adapters/<offering_id>/webhook/<test|live>`, verified with the partner's own scheme. Transfers whose webhook hasn't come are read back every minute.
- Conformance probes the partner with the credential and moves no money.
- Test and live stay apart. A URL or key that looks like the partner's other environment (by its documented hosts and key prefixes) is refused, and conformance probes both credentials when both are set.

### Linking a customer to the partner

The customer starts the link, from their own session and after giving the ramp's consent there.

1. `POST /v1/client/ramp_links { product_id }` answers a `link_reference`.
2. The ramp firm gets `ramp_link.requested` with only that reference, never the builder's customer reference.
3. Once the partner has onboarded the customer, the ramp firm completes it with `link_ramp_partner_customer { link_reference, partner_customer_id, partner_payout_account_id? }`.

Mynt reads the partner's identity for that customer through the adapter and links only if:

- the name matches what the customer gave Mynt, compared in any script after Unicode normalisation (an empty name never matches);
- in live, the date of birth matches too (in test, when both have one);
- the payout account is that partner customer's own;
- the partner customer is linked to one Mynt customer only.

Otherwise the request is refused.

A session may ask five times an hour, and a customer ten times a day. A request expires after seven days (`RAMP_LINK_EXPIRY_HOURS`). Transfers and payouts use only a verified link, filed under a pseudonymous key.

### A transfer's life

Statuses only move forward: `submitted`, then `settled`, `failed` or `returned`. An earlier state arriving late is ignored, and each partner event is applied once, by its event id.

**Waiting for payment.** An add-dollars transfer waits for the customer's payment for business days, not the 24 hours other vendor actions get (`pending_business_days`, default 7, or `RAMP_ADAPTER_PENDING_BUSINESS_DAYS`).

- Past that, Mynt voids it at the partner when the partner can, and the run fails.
- `pay_to_status` is `active` while the account can be paid into. It becomes `void` when the partner confirmed the void and `unknown` when it couldn't. Either way the app tells the customer not to pay into that account.
- A transfer the partner won't void, because its money is already moving, keeps waiting, up to 30 business days.

**Late settlement.** Money that settles after the run ended is never dropped. It is kept sealed on the run and the product's builder gets `vendor_action.late_settlement` to handle by hand.

**Reversal.** A settled transfer the bank later sends back (returned or refunded) is the one change after the end. The run becomes `reversed`, the device sees `failed` with `reversed: true`, the product's builder gets `vendor_action.reversed` (sealed details) and the app a data-free `handoff.reversed`.

**Amounts.** A transfer's amounts are what the partner reports, never an assumed 1:1. `total_usd` means what it means in that leg's quote: in, added to the balance; out, what the customer is charged, amount plus fees. A cash-out's `paid_out_usd` is what reached the bank.

A run ends before its transfer's record moves on, so a failure part-way is finished by the partner's retry or the poller, never lost.

### The Bridge adapter

The Bridge adapter (`adapter: "bridge"`, [apidocs.bridge.xyz](https://apidocs.bridge.xyz)) is the reference adapter.

| Topic | How |
| --- | --- |
| Base URLs | `https://api.sandbox.bridge.xyz` and `https://api.bridge.xyz` |
| Authentication | `Api-Key` |
| Idempotency | `Idempotency-Key` on every transfer, one per quote, so a retry never moves money twice |
| Quotes | Bridge has no quote that locks a price, so Mynt issues it. The fee (`fee_percent`, default 0.5, at least `fee_min_usd`, default 0.50) is charged as Bridge's `developer_fee`, and Mynt sets the validity (`quote_seconds`, default 60) |
| Add dollars | `POST /v0/transfers` from `ach_push` USD to USDC on `solana` at the ramp's `settlement_address`. The customer is shown Bridge's deposit account and deposit message |
| Cash out | USDC on `solana` from that address to `ach` USD at the customer's payout account |
| Webhooks | Verified with the endpoint's public key (`test_webhook_public_key`, `live_webhook_public_key`): `X-Webhook-Signature`, at most 10 minutes old |
| Voiding | An unpaid add-dollars transfer is voided with `DELETE /v0/transfers/{id}`. Bridge cancels only while `awaiting_funds` |
| Identity | A customer's identity is read with `GET /v0/customers/{id}` |
| Limits | Each transfer is between `min_usd` (default 1.00) and `max_usd` (default 10000.00) |

Bridge's states map to Mynt's:

| Bridge | Mynt |
| --- | --- |
| `payment_processed` | `settled` |
| `returned`, `refund_in_flight`, `refunded` | `returned` |
| `undeliverable`, `canceled`, `refund_failed` | `failed` |
| anything else | `submitted` |

Cash-out through Bridge isn't built yet. It needs the USDC leg from the ramp's settlement address into Bridge, so `offramp_quote` and `offramp_transfer` are refused on a Bridge offering, always in live. `test_offramp: "true"` lets them run in the test environment only.

### The Mynt Ramp sandbox

Mynt serves a test ramp itself at `<PUBLIC_URL>/ramp-sandbox` (`core/src/ramp-sandbox.ts`), so apps can be built and tested on both ramps before the partner's live endpoint exists.

- The ramp firm sets its offerings' `test_base_url` to it (`set_mynt_ramp` shows the address) and its `live_base_url` to the partner's.
- It speaks the same wire contract, answers only requests Mynt signed for a ramp offering pointed at it, refuses live requests, and never moves money.
- Prices are in dollars with a 0.5% fee (at least $0.50). The settlement leg is 1:1.
- Transfers settle a few seconds later (`RAMP_SANDBOX_SETTLE_MS`, default 3000) through Mynt's own signed callback.
- An amount ending in `.13` comes back `returned` and one ending in `.66` `failed`.

## Usage

Mynt counts calls per subscription and day: successes and errors, never customer data.

- Vendors see them in `list_my_subscribers`.
- Builders see them in `list_my_vendor_subscriptions`.
- `ops_status` lists failed conformance runs and subscriptions whose calls mostly fail.

## Firm webhooks

A firm gets events at its own webhooks about what Mynt did for it. They are separate from an app's webhooks (see [Webhooks](runtime-api.md#webhooks)), and customers never see them.

| Tool | Does |
| --- | --- |
| `create_firm_webhook` | Registers an https URL for the firm, with the events it wants |
| `list_firm_webhooks` | Lists the firm's webhooks with their recent deliveries (status and response code only) |
| `delete_firm_webhook` | Removes one and drops its delivery history |

Builders and licence providers hold these tools.

### How firm events are delivered

- Each is signed with `Mynt-Signature` like an app's webhooks and retried the same way.
- A result is queued sealed and opened only to send.
- `vendor_action.completed` carries `data.result`, the product, action, app, `customer_ref`, `reference` and `sandbox`.
- Firm webhook URLs pass the same address checks as app webhook URLs (see [Webhook addresses](runtime-api.md#webhook-addresses)).

### Firm events

| Events | About |
| --- | --- |
| `vendor_action.completed`, `vendor_action.failed` | A client action that a product's bound vendor service answered, or that failed |
| `vendor_action.reversed` | A completed ramp transfer the partner later reversed |
| `vendor_action.late_settlement` | A transfer the partner settled after Mynt had ended the run, to handle by hand |
| `ramp_link.requested` | To the Mynt Ramp firm: a customer asked to be linked to the ramp partner |
| `program.deployed`, `program.upgraded`, `program.event` | The firm's Solana programs, deployed or upgraded by Mynt, and each Anchor event they emit |
| `program.upgrade_scheduled`, `program.upgrade_cancelled` | A mainnet upgrade passed the mainnet program gate and is announced before its timelock ends, or was cancelled or rejected |
| `program.review_flagged` | A new vulnerability database version refuses a deployed mainnet program. It keeps running; its upgrades wait for a Mynt admin's review |
| `covenant.breached`, `covenant.cleared` | To a licence provider: one of its rules on a sponsored product tripped or passed again |
| `partner_ledger.endpoint_change_pending`, `partner_ledger.endpoints_confirmed`, `partner_ledger.source_changed`, `partner_ledger.key_changed`, `partner_ledger.approval_requested`, `partner_ledger.conformance_expiring` | Changes to a licence provider's ledger connection (see [Partner kit](licence-providers.md#partner-kit)) |
| `confidential.release_announced` | A new release of the confidential service was announced (see [Confidential computing](confidential-computing.md)) |
| `firm.member_added`, `firm.member_pending`, `firm.member_standing_lost`, `firm.member_removed`, `firm.recovery_pending` | Changes to who belongs to the firm and who has licence-provider standing there |
| `app_agreement.proposed`, `app_agreement.signed`, `app_agreement.terminated`, `app_agreement.answered` | An app agreement proposed to the firm, signed, ended, or accepted or declined by the app's side |
| `agreement_audit.opened`, `agreement_audit.submitted`, `agreement_audit.closed` | An oversight audit under an app agreement opened, answered by the app's side, or closed. Told to both parties' firms |
| `agreement_sla.breached` | A service level under an app agreement was missed in a period. Told to both parties' firms |

## The wire contract

Mynt calls the vendor with:

```http
POST <base_url>/v1/<service_type_key>
Content-Type: application/json
Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
Authorization: Bearer <the subscriber's credential>
```

The `Authorization` header is sent only when the offering requires a credential.

The body is:

```json
{
  "request_id": "…",
  "environment": "test",
  "input": {},
  "params": {},
  "quote": { "quote_id": "…" },
  "consent": {
    "purpose": "<the service type's consent_purpose>",
    "artefact_ref": "<Mynt's consent evidence id>",
    "given_at": "<ISO 8601>"
  }
}
```

- `environment` is `test` or `live`.
- `input` is valid against the service type's `input_schema`.
- `params` is sent only for a service type with a `params_schema`.
- `quote` is sent only for a service type that accepts a quote. In conformance runs its `quote_id` is `mynt_conformance`, as is `consent.artefact_ref`; in a practice run against [Mynt's sandbox](#practising-first-the-vendor-sandbox) both are `mynt_practice`.

Mynt expects `200` with:

```json
{
  "request_id": "<the same>",
  "status": "ok",
  "output": {},
  "error": null
}
```

- `status` is `ok` or `error`.
- `output` is valid against the service type's `output_schema`.
- `error` is `{ "code": "…", "message": "…" }` or `null`.

A vendor must answer `401` to anything whose signature doesn't verify or whose timestamp is more than 300 seconds old. It must treat a repeated `request_id` as a replay and answer it once.

The signing secret is the subscription's (see [The signing secret](#the-signing-secret)).

## Outbound safety

These rules apply to every call Mynt makes to a vendor.

- HTTPS on port 443 only.
- The host is resolved and refused if any address is private, loopback, link-local (including cloud metadata addresses), carrier-grade NAT or otherwise reserved. That includes site-local addresses and IPv6 forms that embed an IPv4 address: IPv4-mapped and IPv4-compatible, NAT64 and 6to4.
- Mynt connects to the address it checked.
- Redirects aren't followed.
- Each call has 10 seconds.
- Responses are capped at 256 KiB.
- Credentials and customer data never reach logs or responses.
