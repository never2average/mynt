# Mynt technical reference

Every tool, the runtime API, hosting, deployment and operations. For what Mynt is, see the [README](../README.md); for how the parts fit together, see [`architecture.md`](architecture.md).

Mynt knows five kinds of user, and each one sees only the tools its roles allow. **Innovator and developer are one role, the builder**: the two names are aliases (each implies the other), so whoever holds either composes and publishes products and builds apps on them. Builders needn't be licensed: a licence provider can sponsor a product under its licences.

| User type | Can | Tools (in addition to the catalog tools) |
| --- | --- | --- |
| **Consumer** | Use financial products, respond to offers and ask for products that don't exist yet | `enroll_in_product`, `list_my_enrollments`, `cancel_enrollment`, `list_offers`, `upgrade_enrollment`, `request_product`, `list_my_product_requests` (the last two for any signed-in user) |
| **Builder** (`innovator` or `developer`): apps | Build app experiences and run GTM engineering around financial products | Apps: `create_app`, `update_app`, `list_my_apps`, `preview_app`, `publish_app`. GTM: `create_segment`, `list_my_segments`, `create_campaign`, `update_campaign`, `lint_campaign`, `launch_campaign`, `pause_campaign`, `end_campaign`, `list_my_campaigns`, `get_campaign_metrics`. Runtime: `create_api_key`, `list_api_keys`, `rotate_api_key`, `revoke_api_key`, `create_webhook`, `list_webhooks`, `delete_webhook`, `rotate_webhook_secret`, `list_webhook_deliveries`, `create_test_consumer`, `simulate_handoff`, `release_app`, `list_app_releases`, `rollback_app`, `get_app_metrics` |
| **Builder** (`innovator` or `developer`): products | Create, test, publish, version and upgrade financial products, covered by their own licences or a licence provider's sponsorship | `create_product`, `update_product`, `test_product`, `publish_product`, `unpublish_product`, `list_my_products`, `create_product_version`, `update_product_version`, `list_product_versions`, `diff_product_versions`, `restore_product_version`, `upgrade_enrollments`, `get_product_distribution_metrics`, `report_handoff_outcome`, `get_product_take_rate`. Product requests: `list_product_requests` (requesters appear only under a pseudonymous id), `respond_to_product_request` (offer one of your published products; audited). Sponsorship: `request_sponsorship`, `list_my_sponsorships` |
| **Licence provider** (`license_provider`) | Hold the licences (verified by admins) and sponsor builders' products under them: approve, decline or revoke sponsorship of a product's component under a held licence, in the jurisdictions it covers; a peer of builders. Its firm is added by hand by an admin | `list_my_licenses`, `list_sponsorship_requests`, `approve_sponsorship`, `decline_sponsorship`, `revoke_sponsorship`, `list_sponsored_products`, plus their firm's `get_my_entity`, `register_license`, `set_entity_facts`, `add_party` and `end_party` (its roster fills the stakeholders its licences mandate). See [Licence providers](#licence-providers-sponsoring-builders-products) |
| **Vendor** | Offer standard services (identity, KYC, account data, bureau, e-sign, e-mandate, the Mynt Ramp…) that builders plug into their products; a peer of builders, neither above nor below them | `list_service_types`, `create_vendor_offering`, `update_vendor_offering`, `run_conformance`, `list_my_offerings`, `list_my_subscribers`, `reveal_subscription_secret`, `rotate_subscription_secret`, plus their firm's `get_my_entity` and `register_license`. Innovators get `list_vendor_offerings`, `subscribe_vendor_service`, `list_my_vendor_subscriptions`, `set_subscription_live` and `unsubscribe_vendor_service`, and `create_firm_webhook`, `list_firm_webhooks` and `delete_firm_webhook` for their vendor services' results. See [Vendors](#vendors-standard-services-per-region) |
| **Admin** | Run Mynt itself: geographies, product types, the whitelist and oversight, all from inside Mynt | `define_region`, `define_product_category`, `list_whitelist`, `invite_user`, `revoke_user`, `list_all_campaigns`, `admin_pause_campaign`, `admin_set_product_status`, `define_take_rate`, `list_take_rates`, `recompute_product_derived`, `audit_log`; vendors: `define_service_type`, `load_service_types`, `suspend_vendor_offering`, `register_firm`, `set_mynt_ramp`, `set_ramp_adapter`, `link_ramp_partner_customer` (also the Mynt Ramp firm's) |

Everyone, including guests without a token, gets the catalog tools: `whoami`, `list_products`, `get_product`, `list_categories`, `list_regions`, `list_product_categories`, `list_apps`, plus the resource `mynt://catalog`.

### Administration

Admins own Mynt's reference data and its access list. **Every admin action lands in the audit log with the name of who did it.**
- **Geographies** (`define_region`) say where products may be offered. Each region records its regulators, its regulatory ecosystem (each regulator's remit, the key laws and bodies), the legal procedure for launching each product line there (licences, approvals, filings, timeline), and the official sources. Fields you leave out keep their values. Innovators read the full picture with `get_region`.
- **Regulated product types** (`define_regulated_product_type`, `list_regulated_product_types`) form, per region, a catalogue of the product types regulators supervise, kept apart from any single regulator. Each has a Mynt category, the actions that can be taken on it, and optionally its underlying and wrapper (see [Product lines, actions and primitives](#product-lines-actions-and-primitives)). Regulators map onto it **many to many**: one product type, such as a sovereign gold bond, can be supervised by several regulators, each for its own subset of actions. A product type can't be removed, or lose an action, while a regulator still supervises it.
- **The regulatory model** (`define_regulator`, `define_legislation`, `define_judgment`) records, per region, each regulator's **scope** (the regulated product types it supervises, by id, with the actions it covers; and the customer personas with their qualifications) and the **licence types** it grants. A licence **grants specific actions on specific product types** (a bare id grants everything its regulator supervises on it), so `find_licenses` returns only licences that genuinely permit the action. Persona and licence ids belong to one regulator: they must start with `<regulator id>_` and can't be reused by another regulator in the region. Each licence carries **GRC**: registers of obligations, reporting/disclosure filings, risks and controls; repositories of regulatory communications, enforcement actions, press releases, policies and risk models; the product types and customer segments it allows; mandatory internal and external stakeholders; and how to apply. **Legal** sits alongside in two branches. **Legislative** covers acts, ordinances, rules, regulations, master directions, circulars, guidelines, notifications and orders, each with its issuer, the instrument it's made under (`parent_id`), status and effective date. **Judiciary** covers court and tribunal decisions, each with court and level, bench, holding, the legislation it interprets, and whether it's still good law. Obligations and filings cite either kind by `legal_ref`. Broken links inside a regulator are refused; looser links come back as warnings. Innovators read all of it with `get_regulator` and `list_legal_instruments` (both branches, filterable), and ask `find_licenses` which licence covers a category, action and persona. `test_product` names the covering licence, or warns when there is none.
- <a id="coverage-per-state"></a>**Coverage per state.** Where a country licenses state by state (US money transmission and virtual-currency business), the model says where each licence counts, with ISO 3166-2 codes written lowercase like entities' incorporation (`us-ny`, `us-ca`; the country code `us` is the whole country). A state regulator carries `jurisdiction`, and its licence types cover only that state. A national regulator's licences cover the whole country. A licence type may set `covers` (a list of codes, or `["us"]`, e.g. for a federal charter that pre-empts state licensing for what it grants) with a `coverage_note` giving the basis. A type issued separately in many states sets `issued_per_jurisdiction: true`, and the firm registers one held licence per state (`register_license … jurisdiction`). A product lists where it's offered with `offered_in` (on its v2 definition, or on a component in `set_product_composition`): `["us-ny", "us-ca"]`, or `["us"]` for the whole country, which needs a licence covering all of it. Each component is then checked in each state. It's covered there when its provider (the firm itself, or a partner on its roster) holds a verified, in-force licence that grants it and covers that state, and publishing is blocked for every component × state with none (`publish_blockers` carry `jurisdiction`). Without `offered_in`, the country is checked as a whole, exactly as before, so regions without states are unchanged. A licence type may also `require` others: a held licence counts only when its holder also holds each prerequisite verified and in force (an entry may list several ids, any one of which will do), and the prerequisite is pinned with it. A licence type with `covers: []` covers nowhere by itself: the FinCEN money services business registration, which each state's money transmitter licence requires.
- <a id="base-products"></a>**Base products: money transmission first.** A product can be built on others instead of declaring what they already provide: a v2 definition lists them in `builds_on` (`product_id`, and optionally the components the base `funds` and those that `settles_from` back through it), and saving it sets the product's `underlying_product_ids`. The composed product inherits the base's coverage: in each state it's offered in, every base must be published, not drifted, and covered there, or publishing is blocked there with a `builds_on:<product id>` blocker naming the base's reason. Its live version pins each base, so it drifts when a base drifts (naming the base's states), is offered somewhere else, or is unpublished. The first base product is US money transmission ([`schemas/examples/us/money-transmission.v2.json`](../schemas/examples/us/money-transmission.v2.json)), owned by the licensed ramp partner's firm and offered in the states it holds a money transmitter licence in; dollar products such as [`dollar-account.v2.json`](../schemas/examples/us/dollar-account.v2.json) are built on it.
- **GRC: data and templates.** Each licence's GRC holds two kinds of thing.
  - **Data the regulator requires or has identified:**
    - obligations: recurrence, criticality, how to comply, links to a risk, an owner and the law
    - reporting, disclosure and filings: category, frequency, due rule, form, channels, priority, the obligation it evidences
    - risks: impact, likelihood, how often controls over it must be tested
    - regulatory communications, enforcement actions and press releases

    Frequencies share one vocabulary: one_time, daily … annual, biennial, periodic, event_driven, continuous, on_demand. Free text is mapped onto it, and any detail that doesn't fit is kept in `frequency_note`.
  - **Templates (schemas of schemas):** **controls**, **policies**, **risk models**, **inspection history** and **inspection events** aren't records. They teach licensees how to define their own. Each template carries:
    - `guidance` on what the regulator expects
    - the `legal_ref` behind it
    - kind-specific settings (a control's minimum test frequency, a policy's review cadence and approver)
    - a **field schema** licensees' records must follow

    Schemas start from Mynt's defaults (a control's type, test method, test frequency, test status and last test rating; a risk model's scoring methods, factors and thresholds; an inspection's type, outcome and findings by severity). The regulator adds or overrides fields by key, each with its own guidance, or opts out of the defaults. Innovators read a template's resolved schema with `get_template`, and the defaults with `list_template_defaults`.
- **Product types** (`define_product_category`) are the categories products may carry, and the product lines each may be used in (a category can sit in several, e.g. `exchange_traded` in wealth and securitization).
- **Take rates** (`define_take_rate`, `list_take_rates`) are what Mynt earns on each product line: a base percentage plus a percentage per workload point, with a floor, a cap and the basis it applies to. Every change is audited. A product's owner, its firm and admins see the rate and its full per-component breakdown with `get_product_take_rate`. If no rate is configured for the line, it says so.
- **What Mynt stores on each product** (`recompute_product_derived`). So that coverage and take rate are exact and cheap to read, Mynt keeps two results of its own checks on every product: `regime_summary` (per region and component, its coverage status and the regulator and licence type covering it, per state too when the product lists `offered_in`, who supervises it, the providing licence's mandated stakeholders required, filled and bound, and the publish blockers, all taken from `get_product_regime`'s own result, without registration numbers or who the parties are) and `take_rate` (exactly what `get_product_take_rate` shows, or why no rate applies), with `derived_at`. They're recomputed when a product is composed, defined, published or unpublished; when anything it rests on changes (licence reviews, roster and entity changes, and the hourly drift sweep, which recomputes every product); when the regulatory model or the line's take rate changes; and on boot for products without them. Computing them never stops a publish: a failure is stored as a note. Admins recompute one product or all of them with `recompute_product_derived`.
- **How products are checked against them.** `test_product` fails a product whose region or category isn't defined and active, or whose category doesn't allow its product line. It warns when the regulator isn't one listed for the region, and when no launch procedure is documented for the product's line there. Retiring a region or category (`active: false`) stops new products from using it; live products stay. A new Mynt starts with neither: admins define them.
- **Whitelist** (`invite_user`, `revoke_user`, `list_whitelist`) is kept in step with Clerk's allowlist. Mynt refuses any change that would remove the last admin.
- **Oversight.** See every campaign and pause any of them. Unpublish any product, or republish one; republishing re-runs the tests first.

**Inviting from Clerk** works too, and is the easiest way to create the first admin:
1. In the Clerk dashboard, go to **Users → Invite**, enter the email, and set **public metadata** to `{"mynt_roles": ["admin"]}`. Any role works: `admin`, `innovator`, `developer` or `consumer`.
2. The person accepts Clerk's emailed invitation and signs up.
3. On their first Mynt request, Mynt whitelists them with those roles and logs `invite_via_clerk` in the audit log.

Only Clerk dashboard owners can set public metadata; users can't edit their own. After that first sign-in, manage the person in Mynt: role changes and revocations are written back to their Clerk metadata, so an old grant can't restore access. With Clerk's allowlist on, add the email under **Configure → Restrictions → Allowlist** too, in case the invitation alone isn't enough to sign up.

The CLI (`users invite --role admin`) remains as a fallback for creating the first admin.

### Who does what: licensed innovators, software developers

- **Innovators are the licensed layer.** Any firm doing a regulated financial action:
  - issuing a product (a bank, NBFC, AMC or insurer)
  - selling another issuer's product (a mutual fund distributor, insurance broker, lending service provider)
  - repackaging others' products (a model portfolio)

  Each innovator acts for a **firm** (`create_entity`) and registers the **licences** it holds (`register_license`), which an admin verifies against the regulator's register (`review_license`). A product declares its `action` (`issuance`, `sale` or `repackaging`, with `underlying_product_ids` for the last two). **`publish_product` requires a verified, in-date licence held by the firm that covers that action on that category in that region.**
- **Developers are the software layer.** They build SDKs, apps and experiences on innovators' products, and never issue, sell, hold funds or collect financial data. Onboarding, KYC and payments hand off to the innovator's own flow (`deep_link` / `initiate_onboarding`).
- **Vendors offer standard services** that innovators plug into their products instead of each integrating them: identity checks, KYC records, account data, bank statement analytics, bureau reports, documents, e-sign, e-mandates. See [Vendors](#vendors-standard-services-per-region).

**Opening products to developers.** Each product has an **access mode**, set with `set_product_access`:

| Mode | Developers |
| --- | --- |
| `open` | Build and publish any experience that meets the terms |
| `approval` (default) | Build now; go live once the innovator approves their request |
| `private` | Only developers the innovator invites (`invite_developer`) |

Each product also has **build terms**:
- **permitted actions:** display, compare, prefill, deep_link, embed_widget, initiate_onboarding
- **required disclosures**
- **banned phrases**
- **allowed customer personas**
- **branding**
- **commercials:** none, referral fee or revenue share
- **handoff_url:** where runtime API hand-offs send the user (https)

**On the developer side:**
- **Find products:** `list_buildable_products` and `get_product_sdk` (data shape, sandbox sample, permitted actions, hand-offs).
- **Ask for access:** `request_product_access` and `list_my_requests`.
- **Check and publish:** `check_experience`, then `publish_app`. Publishing needs access to every product **and** a passing check against each product's terms.

**On the innovator side:**
- **Inbox:** `list_requests` and `review_request` (approve or reject, with a note).
- **Visibility:** `list_experiences` shows every app using their products.
- **Control:** `revoke_access`, and **`suspend_product_experiences`** as a kill switch (the product goes private, every grant is revoked, and live campaigns using it are paused).

**Campaigns.** Promoting a financial product is a regulated act, and Mynt treats it as one:
- A campaign over the launcher's own (or their firm's) products, or the open reference catalogue, goes live once its copy passes the lint.
- A campaign over **another innovator's** products becomes `pending_approval` and lands in that innovator's inbox. It goes live when every product's innovator approves, and drops back to draft on any rejection.

### Vendors: standard services, per region

Vendors are firms (legal entities an admin adds by hand with `register_firm`; there's no self-serve discovery) that offer **standard services** innovators plug into their products. The point is that no innovator should have to integrate identity, KYC, account aggregator data, analytics, bureau, e-sign or e-mandate providers itself, ever again. An admin invites a vendor's people with the `vendor` role (`invite_user`) and attaches them to the firm (`add_entity_member`). The vendor registers its licences (`register_license`), and an admin verifies them as for any firm.

**Service types (admins).** Like regulators, service types are defined per region (`define_service_type`, `list_service_types`). Each has a `key`, `region`, `name`, `category` (identity, kyc, account_data, analytics, credit_bureau, documents, esign, mandate, fraud, ramp, other), an `input_schema` and `output_schema` (JSON Schema: the one contract every vendor in that region implements), the `consent_purpose` the customer must give, the data dictionary fields its output `fills`, and the licence types, from the region's regulatory model, of which the **subscribing firm** (`innovator_licences`) and the **vendor** (`vendor_licences`) must each hold one. Required inputs are data dictionary fields, because Mynt sends them from the customer's vault. Examples ship as JSON in [`schemas/service-types/`](../schemas/service-types) (India: PAN verification, CKYC search and download, Account Aggregator data fetch, bank statement analytics, credit bureau report, DigiLocker documents, eSign, e-mandate; US: identity and SSN verification, bank account verification, credit bureau report, and the Mynt Ramp's `onramp_quote`, `onramp_transfer`, `offramp_quote` and `offramp_transfer`). `load_service_types` loads them; an example naming a licence type your regulatory model calls something else is skipped with the reason until you pass `licence_map`.

An optional `client_result` says what a customer's device may be told when it starts an action this service serves (below): `status` maps an output property's values to `verified`, `not_verified`, `completed`, `failed` or `pending` (anything else is `completed`); `fields` lists output properties the device may see (never data dictionary fields that are personal or sensitive, nor ones the service fills); `redirect: true` lets the device have the vendor's `redirect_url` (the provider's page, for e-sign, e-mandate and DigiLocker). Without it the device gets a status and a reference only. In the examples, PAN and identity verification and bank account verification give a mapped status only; bureau reports a status only; e-sign and e-mandate a mapped status and the redirect; DigiLocker the redirect.

**Offerings (vendors).** `create_vendor_offering` offers a service type in a region from a test (and later live) HTTPS endpoint, with a fixed price per call (for innovators to see: billing is between vendor and innovator, never through Mynt), SLA notes and the firm's licences it relies on. It starts as `draft`. **Mynt tests it itself** (`run_conformance`): signed requests with fixture inputs valid against the input schema, every answer checked against the output schema, a badly signed request and a correctly signed but stale one (over 300 s old) that must both be refused, timeouts and errors recorded, and the vendor's licences checked against the service type. A pass makes it `conformance_passed`; `update_vendor_offering { listed: true }` lists it. Changing an endpoint or licences sends it back to draft. Admins can suspend an offering (`suspend_vendor_offering`), which stops listing and calls. An admin's changes to another firm's offering are audited as admin actions (`admin_update_vendor_offering`, …) naming the firm.

**Subscriptions (innovators).** `list_vendor_offerings` shows listed offerings by region, service type or category, and whether your firm meets the licence prerequisites. `subscribe_vendor_service` checks them, keeps the credentials the vendor issued you (if it needs any) in your firm's **key vault** (one row per key, typed `vendor_test_credential` or `vendor_live_credential`, sealed with `MYNT_VAULT_KEY`, never shown again), sends the test one only to the test endpoint and the live one only to the live endpoint, and adds the vendor's firm to your roster as a party, so the regime check and drift see it. Bind a product's partner handoff to the subscription in its definition (see Product definitions). Sandbox sessions then use the vendor's test endpoint; `set_subscription_live` turns live calls on (with the live credential, if needed). Live calls go only to a listed offering, and both sides' licence prerequisites are re-checked on every call. The subscription's state (active, offering not suspended, both sides' licences in force) is pinned with each product version that uses it: a suspension or a lapsed licence drifts those products, pausing new sales and sending `product.drifted`, until it's restored. `unsubscribe_vendor_service` is refused while a live product version hands off through the subscription; otherwise it deletes the credentials and, if the vendor joined your roster for it, ends that party. Developer apps change nothing.

**Client actions served by the vendor.** When a product's partner handoff is bound to a subscription, its client action (`POST /v1/client/actions/<handoff>`) is served by Mynt calling the vendor, instead of handing off to the innovator's URL, whatever the service: identity, bureau, e-sign, e-mandate, KYC. The developer contract marks the action `served_by: { kind: "vendor_service", service_type, client_result }` (no subscription, vendor, URL or secret). The device needs a client session with a `customer_ref`, the service's consent (`409 consent_required`) and its required inputs in the vault (`409 data_required`; only the service type's declared inputs are sent). Sandbox sessions call the test endpoint with the test credential; live ones the live endpoint with the live credential, once the innovator turned the subscription live (`503 vendor_unavailable` before), only for a listed offering with both sides' licences in force. An answer that breaks the output schema is `502 vendor_error`, and nothing is kept. A good answer is:
- kept by Mynt, sealed, for the session, with evidence `action_completed` (or `action_failed`) of the action (status only), and the fields the service fills saved to the customer's vault;
- sent in full to the innovator's **firm webhooks** (`create_firm_webhook`): `vendor_action.completed` with `data.result`, the product, action, app, `customer_ref`, `reference` and `sandbox`, signed with `Mynt-Signature` like developers' webhooks and retried the same way (queued sealed; opened only to send). `vendor_action.failed` carries no result;
- answered to the device with only `{ reference, action, status, sandbox }` plus what the service type's `client_result` allows. `GET /v1/client/action_runs/<reference>` reads it back, for the same app and customer.

Handoffs not bound to a vendor keep the hand-off to the innovator's own flow.

**Asynchronous services** (e-sign, e-mandate, DigiLocker) may answer the call with `{ "request_id", "status": "pending", "redirect_url": "https://…" }`. The device gets `status: "pending"` and, when the service type allows it, the `redirect_url`. The vendor then sends the final answer to `POST /v1/vendor/callback/<subscription_id>`, signed exactly like Mynt's requests (`Mynt-Signature` with the subscription's signing secret, at most 300 seconds old; `401` otherwise): `{ "request_id": "<Mynt's>", "status": "ok" | "error", "output": { … } }`. An output that breaks the schema is refused (`400 invalid_output`) and changes nothing; a good one completes the action as above. A repeated `request_id` is answered with `duplicate: true` and applied once. A valid answer whose own status maps to `pending` (the customer hasn't finished yet) also leaves the action open for the callback, and one that maps to `failed` ends it as failed (`action_failed`, `vendor_action.failed` with the result). When an asynchronous action ends, the app's own webhooks get `handoff.completed` or `handoff.failed` with only the product, `reference`, `action` and `status`.

The customer stays in control while an action is open. A callback that arrives after they withdrew the service's consent ends the action as withdrawn: nothing of the answer is kept, and the innovator gets `vendor_action.failed` with `error_code: "consent_withdrawn"` and no result. `DELETE /v1/client/fields` also erases the vendor results kept for the customer and any still queued for the innovator, and stops their open actions. Actions that never finish expire (`error_code: "expired"`): a call cut short after 5 minutes, a pending one after `VENDOR_PENDING_EXPIRY_HOURS` (default 24). Callbacks are rate limited per caller address before the signature is checked, and per subscription only once it is. Sandbox results are sealed with a key derived from `MYNT_VAULT_KEY`, so a queued delivery survives a restart.

**Params and quotes.** Two optional parts of a service type let a device ask for something specific and act on a price:
- `params_schema` (with `params_fixture` for conformance) declares what the device sends with each call, as `params` in `POST /v1/client/actions/<handoff>`: an amount, a currency, an asset. It must be an object of plain scalar properties with `additionalProperties: false`, and never a data dictionary field that is customer data (that comes from the vault, as `input`). Mynt checks the params against it before calling (`400 invalid_params`); an action that takes none refuses them (`400 params_not_accepted`).
- `quote: true` makes the service a **quote**: its output must require `quote_id` and `expires_at` (in the future, at most an hour ahead; otherwise `502 vendor_error`). The device gets `expires_at` and whatever `client_result` allows, never `quote_id`. A service type with `accepts: "<quote key>"` (same region and category) **accepts** a quote: the device starts it with `quote: "<the quote's reference>"`, and Mynt sends the vendor `quote: { quote_id }`, but only for a quote of the same app, customer, product and environment, from the same vendor, unexpired and not accepted before (`404 quote_not_found`, `409 quote_expired`, `409 quote_used`). Claiming a quote is atomic, so two accepts of one quote can't both go through. A call that fails or is refused releases the quote for another try, so vendors must treat a repeated `quote_id` as the same order.

In the developer contract, such an action's `served_by` carries `params_schema`, `quote: true`, or `accepts_quote_from: "<the quoting action>"`. The SDKs' `startAction` takes `params` and `quote`.

**The Mynt Ramp.** All dollars in and out of digital-asset liquidity go through one ramp. Its service types have the category `ramp`, and only the firm an admin designates with `set_mynt_ramp` (audited) may offer or list them: today the licensed ramp partner, which holds funds in transit and transmits money under its own licences (Mynt never holds funds or keys). Mynt calls only that firm's ramp offerings, in sandbox and live, so re-designating the ramp stops calls to the old firm's at once. Innovators subscribe to the ramp and bind handoffs to it like any vendor service. The shipped US types come in two pairs, each with its own consent purpose: **add dollars** (`onramp_quote`, accepted by `onramp_transfer`, consent `fiat_onramp`) and **cash out** (`offramp_quote`, accepted by `offramp_transfer`, consent `fiat_offramp`). A quote takes params `direction` (`in` or `out`) and `amount_usd`, and the customer's name and bank account from the vault; the device is shown `amount_usd`, `fee_usd`, `total_usd` (in: added to the balance; out: taken from it), `currency` (`USD`), `estimated_arrival` and `expires_at`. A transfer usually answers pending until the bank transfer settles (`submitted`, then `settled`, `failed` or `returned`); when the customer pushes the payment, an add-dollars transfer also shows the US bank account to pay (`pay_to_bank_name`, `pay_to_account_number`, `pay_to_routing_number`, `pay_to_reference`). The settlement leg (`settlement_asset` USDC, `settlement_network` solana, `settlement_amount`, `settlement_ref`, `settlement_tx`) is in the output, sealed to the innovator, and never reaches a device. All four name the licence type `fincen_msb`; map it to yours with `licence_map`.

**Dollars only for customers.** A developer's customers never see or touch crypto: every customer-facing value is a US dollar amount, a fee, a total, a status, an arrival time or a reference. Mynt enforces it in code (`src/dollars-only.ts`): `define_service_type` refuses a `client_result` field or a `params_schema` property whose name carries a crypto concept (asset, chain, network, wallet, address, tx, hash, token, coin, memo, a token symbol or chain name) or whose enum, const or default is a token symbol or chain name, a ramp currency field that isn't `USD`, and a name that names one (it reaches devices in error messages). Publishing refuses a binding to a service type stored before the rule; the developer contract drops such fields; and the device's outcome drops any field, or any value that looks like a token, a chain, an address or a transaction hash, whatever the service type says. Keep the settlement asset in the output, where it goes sealed to the innovator.

**How the ramp partner plugs in.** Either way, Mynt's quote → accept, conformance, callbacks and the dollars-only rule are the same:
1. **The wire contract.** The partner serves Mynt's vendor wire contract (below) at its offerings' base URLs.
2. **An adapter in front of its own API** (`src/ramp-adapters/`). The ramp firm (or an admin) runs `set_ramp_adapter { offering_id, adapter, config, test_credential, live_credential }` on each ramp offering. Its base URLs are then the partner's API; the credentials go sealed into the ramp firm's key vault (key types `ramp_partner_test_credential`, `ramp_partner_live_credential`) and are never shown, logged or put in the audit log. Mynt answers its own signed requests in-process: the adapter (a small typed interface: `probe`, `price`, `transfer`, `status`, `webhook`) translates each to the partner's API and the partner's states and webhooks back to Mynt's. Partner webhooks go to `<PUBLIC_URL>/v1/ramp-adapters/<offering_id>/webhook/<test|live>`, verified with the partner's own scheme; transfers whose webhook hasn't come are read back every minute. Conformance probes the partner with the credential and moves no money. Test and live stay apart: a URL or key that looks like the partner's other environment (by its documented hosts and key prefixes) is refused, and conformance probes both credentials when both are set.

**Linking a customer to the partner.** The customer starts it, from their own session and after giving the ramp's consent there: `POST /v1/client/ramp_links { product_id }` answers a `link_reference`, and the ramp firm gets `ramp_link.requested` with only that reference, never the developer's customer reference. Once the partner has onboarded the customer, the ramp firm completes it with `link_ramp_partner_customer { link_reference, partner_customer_id, partner_payout_account_id }`: Mynt reads the partner's identity for that customer through the adapter and links only if the name matches what the customer gave Mynt (compared in any script, after Unicode normalisation; an empty name never matches) and, in live, the date of birth too (in test, when both have one); the payout account must be that partner customer's own; and one partner customer is linked to one Mynt customer only. Otherwise the request is refused. A session may ask five times an hour (a customer ten a day), and a request expires after seven days (`RAMP_LINK_EXPIRY_HOURS`). Transfers and payouts use only a verified link, filed under a pseudonymous key.

**A transfer's life.** Statuses only move forward: `submitted` → `settled`, `failed` or `returned`; an earlier state arriving late is ignored, and each partner event is applied once (by its event id). An add-dollars transfer waits for the customer's payment for business days, not the 24 hours other vendor actions get (`pending_business_days`, default 7, or `RAMP_ADAPTER_PENDING_BUSINESS_DAYS`). Past that, Mynt voids it at the partner when the partner can, and the run fails; `pay_to_status` (`active` while the account can be paid into) becomes `void` when the partner confirmed the void and `unknown` when it couldn't, and either way the app tells the customer not to pay into that account; a transfer the partner won't void (its money is already moving) keeps waiting, up to 30 business days. Money that settles after the run ended is never dropped: it's kept sealed on the run and the innovator gets `vendor_action.late_settlement` to handle by hand. A settled transfer the bank later sends back (returned or refunded) is the one change after the end: the run becomes `reversed`, the device sees `failed` with `reversed: true`, the innovator gets `vendor_action.reversed` (sealed details) and the app a data-free `handoff.reversed`. A transfer's amounts are what the partner reports, never an assumed 1:1: `total_usd` means what it means in that leg's quote (in: added to the balance; out: what the customer is charged, amount plus fees), and a cash-out's `paid_out_usd` is what reached the bank. A run ends before its transfer's record moves on, so a failure part-way is finished by the partner's retry or the poller, never lost.

**The Bridge adapter** (`adapter: "bridge"`, [apidocs.bridge.xyz](https://apidocs.bridge.xyz)) is the reference: base URLs `https://api.sandbox.bridge.xyz` and `https://api.bridge.xyz`, `Api-Key` auth, `Idempotency-Key` on every transfer (one per quote, so a retry never moves money twice). Bridge has no quote that locks a price, so Mynt issues it: the fee (`fee_percent`, default 0.5, at least `fee_min_usd`, default 0.50) is charged as Bridge's `developer_fee`, and Mynt sets the validity (`quote_seconds`, default 60). Add dollars is `POST /v0/transfers` from `ach_push` USD to USDC on `solana` at the ramp's `settlement_address`, and the customer is shown Bridge's deposit account and deposit message; cash out is USDC on `solana` from that address to `ach` USD at the customer's payout account. Bridge's states map to Mynt's: `payment_processed` is `settled`; `returned`, `refund_in_flight` and `refunded` are `returned`; `undeliverable`, `canceled` and `refund_failed` are `failed`; the rest stay `submitted`. Webhooks are verified with the endpoint's public key (`test_webhook_public_key`, `live_webhook_public_key`: `X-Webhook-Signature`, at most 10 minutes old). An unpaid add-dollars transfer is voided with `DELETE /v0/transfers/{id}` (Bridge cancels only while `awaiting_funds`); a customer's identity is read with `GET /v0/customers/{id}`. Each transfer is between `min_usd` (default 1.00) and `max_usd` (default 10000.00). **Cash-out through Bridge isn't built yet:** it needs the USDC leg from the ramp's settlement address into Bridge, so `offramp_quote` and `offramp_transfer` are refused on a Bridge offering, always in live; `test_offramp: "true"` lets them run in the test environment only.

**The Mynt Ramp sandbox.** Mynt serves a test ramp itself at `<PUBLIC_URL>/ramp-sandbox` (`src/ramp-sandbox.ts`), so apps can be built and tested on both ramps before the partner's live endpoint exists: the ramp firm sets its offerings' `test_base_url` to it (`set_mynt_ramp` shows the address) and its `live_base_url` to the partner's. It speaks the same wire contract, answers only requests Mynt signed for a ramp offering pointed at it, refuses live requests, and never moves money. Prices are in dollars with a 0.5% fee (at least $0.50); the settlement leg is 1:1. Transfers settle a few seconds later (`RAMP_SANDBOX_SETTLE_MS`, default 3000) through Mynt's own signed callback; an amount ending in `.13` comes back `returned` and one ending in `.66` `failed`.

**Usage.** Mynt counts calls per subscription and day (successes and errors, never customer data): vendors see them in `list_my_subscribers`, innovators in `list_my_vendor_subscriptions`. `ops_status` lists failed conformance runs and subscriptions whose calls mostly fail.

**The wire contract.** Mynt calls the vendor with

```
POST <base_url>/v1/<service_type_key>
Content-Type: application/json
Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
Authorization: Bearer <the subscriber's credential>        (only when the offering requires one)

{ "request_id": "…", "environment": "test" | "live", "input": { …valid against input_schema… },
  "params": { … },                  (only for a service type with a params_schema)
  "quote": { "quote_id": "…" },     (only for a service type that accepts a quote; "mynt_conformance" in conformance runs)
  "consent": { "purpose": "<the service type's consent_purpose>", "artefact_ref": "<Mynt's consent evidence id>", "given_at": "<ISO 8601>" } }
```

and expects `200` with `{ "request_id": "<the same>", "status": "ok" | "error", "output": { …valid against output_schema… }, "error": { "code": "…", "message": "…" } | null }`. The signing secret is per subscription: Mynt generates it, `list_my_subscribers` says whether it's been taken, and `reveal_subscription_secret` shows it to the vendor once. `rotate_subscription_secret` replaces it (shown once; the old one stops verifying at once). Conformance runs use the offering's own secret, shown once by `create_vendor_offering`. Answer `401` to anything whose signature doesn't verify or whose timestamp is more than 300 seconds old, and treat a repeated `request_id` as a replay: answer it once.

**Outbound safety.** HTTPS on port 443 only. The host is resolved and refused if any address is private, loopback, link-local (including cloud metadata addresses), carrier-grade NAT or otherwise reserved, including IPv6 forms that embed an IPv4 address (IPv4-mapped and -compatible, NAT64, 6to4) and site-local, and Mynt connects to the address it checked. Redirects aren't followed, each call has 10 seconds, and responses are capped at 256 KiB. Credentials and customer data never reach logs or responses.

### Coding-agent builds (developers)

A developer can have Mynt **build and ship** one of their experiences. `start_build` runs a coding agent in a fresh [boat.dev](https://boat.dev) sandbox. boat.dev only provides the machine: Mynt installs a pinned Claude Code there and runs it headless with a dollar budget (`--max-budget-usd`, from the build's cap). The agent reaches the model only through Mynt's agent proxy (`/agent`), using a token that works only while its build runs. Mynt calls Claude on Google Cloud Vertex AI with its own service account, or the Anthropic API with its own key, so no credentials ever enter a sandbox. Developers follow the agent's activity live and can steer it: Mynt interrupts the current turn and sends their message as the next one. The agent writes the code against the app's products and their build terms, using a freshly generated SDK and a Mynt **sandbox key** (simulated hand-offs) for end-to-end tests. It reviews its own code for security issues and fixes them, starts a preview, and pushes a branch. The [Maxwell](https://github.com/OnFinance/Maxwell) security audit runs once, in Mynt's independent verification below, never in the agent's sandbox.

**What the agent builds is a whole app, not just a server:** one Docker Compose project with `api/` (holds the app key, mints client sessions, handles webhooks), `web/` and `mobile/` (Expo React Native by default; Kotlin, Swift or Flutter on request), started from `workspaces/coding-build/templates/mynt-app/` with the build's generated SDKs wired in. The lead agent works with a team of subagents in `workspaces/coding-build/.claude/agents/` (architect, server, web and mobile engineers, a read-only compliance reviewer, QA and release). Their skills are human-written skills found on GitHub by HyDE search (Mynt's own drafts used as the queries) and vendored with their upstream licence and source, plus a short Mynt layer.

**Agent sandboxes on Freestyle.** Builds, the product desk, governance review and the connector run in boat.dev sandboxes by default. With `SANDBOX_PROVIDER=freestyle` (and `FREESTYLE_API_KEY`), the same agents run in Freestyle VMs instead (`src/freestyle-sandboxes.ts`):
- each sandbox is a VM with the agents' own `user` account and the sandbox env in a 0600 file;
- previews and source downloads are served at unguessable `style.dev` names, so the link is the credential, as with boat's token-gated links;
- stopping a sandbox deletes the VM;
- machine spend counts toward the caps at `FREESTYLE_USD_PER_HOUR`.

**The developer works in the same box.** While a build runs, and after it ships for as long as its preview is up, `open_sandbox_editor` opens VS Code in the browser on the sandbox (a private, token-gated link plus a password), with a terminal next to the agents. `sandbox_run`, `sandbox_files` and `sandbox_diff` do the same from any MCP client. Output is capped and scrubbed of credentials, and everything the developer does is on the build's timeline. After a build ends, `reopen_sandbox` brings back a fresh sandbox on its pushed branch (with the coding team's workspace and a short-lived GitHub token to push with) for a few hours, so the same tools keep working; `close_sandbox` ends it.

**The agent doesn't grade its own work.** When it finishes, Mynt verifies the build itself, in a **fresh sandbox the agent never touched**, with no secrets:
1. **Package.** Mynt packages the workspace source (without dependencies), records its SHA-256, and the verifier downloads it and checks the checksum.
2. **Mynt's own checks** (`src/verify-script.ts`): tests; lint and types; a secrets scan with `gitleaks`; a dependency audit; a CycloneDX SBOM with `syft`; and every required disclosure present in the source. `gitleaks` and `syft` are pinned versions, checked against their releases' published checksums.
3. **Independent audit.** A separate, audit-only Claude Code run executes the Maxwell static workflows. Mynt then re-hashes the source tree to prove the audit changed nothing.
4. **Decision**, from Mynt's results only. The agent's own report is kept, as advice:
   - the source changed during the audit, no audit, or **critical or high** findings → `blocked`
   - a failing check → `failed`
   - with a repository, the pushed branch must be exactly the verified source, or the build is `blocked`
5. **Ship.** On success, Mynt exposes the token-gated **preview** and **opens the pull request itself**, through its GitHub App, with the verified results in the description. The agent never opens PRs.

**Tracking.** Developers follow builds with `get_build` (phase, timeline, cost against the cap, Maxwell summary, readiness, links), see the agent's live activity with `get_build_activity`, `steer_build` it, or `stop_build` it. `list_builds` shows this month's spend. Admins see every build and total spend with `list_all_builds`.

**Spend** is capped per build (`BUILD_CAP_USD`, default 10) and per developer per month (`BUILD_MONTHLY_CAP_USD`, default 100). Mynt reads the sandbox's machine and model cost as it runs, and stops a build that passes its cap.

**Repositories.** Developers install the Mynt GitHub App on a repository and run `connect_repository`. Each build gets an installation token limited to that one repository, with contents and pull-request write access for an hour. No long-lived credential enters the sandbox.

**Configuration:** `BOAT_API_KEY`, `PUBLIC_URL` and a model backend for the agent proxy (builds are disabled without them): either `GOOGLE_APPLICATION_CREDENTIALS` (a service account key file with Vertex AI User on a project where the Claude models are enabled; optional `VERTEX_PROJECT_ID`, `VERTEX_REGION`, default `global`) or `ANTHROPIC_API_KEY` (a dedicated key with a spend limit); `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` (pushing is disabled without them); optional `BUILD_AGENT_MODEL` (default `claude-opus-5-5`), `BUILD_SANDBOX_TYPE` and `BUILD_SANDBOX_TTL_SECONDS`.

### Solana programs (developers)

Some apps need a program on Solana (a smart contract) beside them. Developers, and innovators (who are developers too), build them with the coding agents and deploy them through Mynt (`src/solana/`). Programs are developer- and firm-side only: customers never see crypto, only dollars.

**1. Reserve the address.** `reserve_program_id` (`name`, `cluster`: `devnet` or `mainnet`, and the `app_id` or `product_id` it belongs to) gives the program its address before any code exists. Mynt generates the address's keypair and seals it in its vault (`MYNT_VAULT_KEY`); it is used once, at the first deploy, then deleted. The program declares the address in `declare_id!` and `Anchor.toml`, and Mynt deploys only a program that does.

**2. Build it.** `start_build` gives the coding agents the Solana toolchain (`solana: true`, on by default when the app has reserved programs) and the app's reserved addresses in the build spec. They scaffold an Anchor workspace in `solana/` from `workspaces/coding-build/templates/solana-program/` (a minimal ledger that emits an event per entry, with its tests) and test it with `anchor test` on a local validator. They never deploy anything.

**3. Mynt builds it again, itself.** Mynt never deploys the agent's artifact, and none of the developer's code runs on the verify machine before Mynt has the program.
- **Fetch.** Mynt fetches the source into its clean verify sandbox, checks its hash, and reads the answer itself: does the archive have an Anchor workspace?
- **Build, in a container only.** If it does, a run of its own (`verify.sh --solana-build`, with `solana-verify.sh build` from `src/solana/toolchain.ts`) compiles each program crate with `cargo build-sbf` inside Anchor's verifiable-build image, pinned by digest. This is the same command `anchor build --verifiable` runs there, so the program is reproducible. First, a throwaway container with a network fetches the crates. It gets only a skeleton of the source: the `Cargo.toml` files, `Cargo.lock` and empty stub files. No `.cargo/` config, no `rust-toolchain.toml`, no build script or code, and the compiler and every rustc wrapper are pinned by environment, so nothing of the developer's runs while there is a network. Then a fresh container, created with no network at all and no mount of the host, gets the full source as a copy plus the crate caches and lock from the fetch container (streamed container to container; the fetch container is removed before the build starts), and compiles offline as its own main process. When the build ends the container stops, so nothing the developer's build scripts, macros or wrappers left running can touch the program afterwards. Mynt pins the image's own Rust for cargo itself and resolves dependencies to versions the platform tools can build; a workspace's own cargo config applies only inside the offline build. The program comes out with `docker cp -L`, which resolves a link inside the container instead of copying it out as a link to a host path, and is kept only if it is a regular ELF file. Program crate names must be plain identifiers (`^[a-z0-9_]+$`). `anchor build --verifiable` itself isn't used, because after its container it builds the IDL on the host, compiling and running the developer's build scripts and macros there.
- **Capture.** When that run ends, Mynt kills every process and container of the sandbox's user, reads each program back into its own server and hashes it there; it reads only a regular file, never through a link, and stores it only if it is an ELF program. The hash is sha256 of the program with its trailing zero padding removed: the same "executable hash" `solana-verify` reports and the on-chain bytes give. Mynt stores those bytes with the build, and records the `solana_build` check itself; a row of that name in the later report is ignored.
- **Test.** Mynt writes its scripts into the sandbox again, then runs the checks. Among them, the workspace's IDL is built (`anchor idl build`) and its `anchor test` runs on a local validator against the bytes Mynt hashed. Test setups that would run other code at the programs' addresses are refused: `[[test.genesis]]`, validator clones, preloaded accounts, or `[programs.localnet]` pointing elsewhere.
- **Re-check.** Afterwards Mynt hashes every copy of the program again; if any changed, the build is `blocked`.

Mynt also records the sha256 of the `Cargo.lock` the build compiled with (read back from the build container) next to each program's hash, on the program and on each version (`get_program`), so anyone can rebuild exactly those bytes. A source without a committed `Cargo.lock` still builds (the fetch resolves one), with a warning in `solana_build` to commit it. The skeleton the fetch container gets stubs every place cargo looks for a target: `[lib]`, `src/main.rs`, and named `[[bin]]`, `[[example]]`, `[[test]]` and `[[bench]]` targets at their paths or cargo's default ones.

Two checks join the build's readiness, `solana_build` and `solana_tests`; either failing fails the build. Deploys use only the bytes Mynt stored. CI's `solana-program` job follows the same path, and checks that a build script rewriting the program on the host neither changes what is captured nor goes unnoticed.

**4. Deploy and upgrade.** `deploy_program` (`program_id`, `build_id`) deploys the program Mynt built from a **succeeded** build whose program declares the reserved address. Mynt does it itself, with the upgradeable BPF loader: a buffer account, the program written in chunks, then deploy, with twice the program's size reserved for upgrades; a failed deploy closes its buffer to recover the rent. `upgrade_program` replaces the code from a newer verified build at the same address (the same bytes, or a program larger than the reserved space, are refused). Both run in the background; `get_program` shows progress, every version with its build, hash and transaction, and recent events. `list_programs` lists a developer's programs.

Deploys hold up when things go wrong:
- **It landed, but Mynt didn't see it confirmed** (a timeout, a restart): before sending anything, Mynt reads what the chain holds at the address. If that is exactly the build's program under Mynt's signer, it is recorded as deployed (or upgraded) instead of being sent again or refused. If it is an earlier build of the same program that shipped (the owner's, or someone's in the owner's firm) under Mynt's signer, that build is recorded first and the new one goes through as an upgrade, with the operation held throughout.
- **Its job died:** a running deploy refreshes its timestamp after every batch of writes. One that has gone 30 minutes without that is reconciled the same way, on the HTTP server's indexer polls only (a stdio server or a CLI command sharing the database never touches it); otherwise it's marked interrupted and can be started again.
- **Someone sent lamports to the reserved address** (it is public once reserved): as the Solana CLI does, Mynt tops the account up, sizes it and assigns it to the loader, signed by the program's own keypair, instead of failing to create it.
- **The wrong network:** each RPC must answer the cluster's genesis hash before Mynt sends it anything, so a devnet URL pointing at mainnet (or the reverse) is refused.

The registry records, per program: its address, the app or product it belongs to, cluster, version, verifiable-build hash, deployer, upgrade authority, signer backend, deploy transaction and status (`reserved`, `deploying`, `deployed`, `failed`).

**5. Call it.** `simulate_program_call` runs an instruction without sending it (logs, compute used, error). `call_program` simulates first and sends only if the simulation succeeds. An instruction is an Anchor `method` (snake_case; Mynt adds the discriminator) with `args_base64` (Borsh-encoded arguments), or raw `data_base64`, plus its accounts. Each developer has two keys per cluster in Mynt's vault. A **fee payer** pays every call's fees and is never passed to a program, so no program can spend it. A **caller key** (`"$caller"` in the accounts) signs only when the call lists it as a signer, and it is the only signer a call may have. A call may never include Mynt's deploy authority or the fee payer, so one firm's program can never act with a key that controls another's.

**6. Events.** Mynt's indexer polls every deployed program's new transactions (`SOLANA_INDEX_POLL_MS`, default 30 s; up to 1,000 per program per poll, oldest first, the rest on the next poll, none skipped) and forwards each Anchor event the program itself logged (`emit!`) to the owning firm's webhooks as `program.event` (with the event's name from the build's IDL and its data, base64), once each. Deploys and upgrades go out as `program.deployed` and `program.upgraded`. Devnet events are sandbox deliveries; mainnet's are live.

**Signers.** Every deploy, upgrade and call goes through one signer interface (`src/solana/signer.ts`):

| Backend | Cluster | How it signs |
|---|---|---|
| `devnet-vault` | devnet | A Mynt-generated key sealed in the vault. Mynt asks the devnet faucet for rent; when the faucet's limit is reached, the error names the address to fund. |
| `mainnet-vault` | mainnet | A key in Mynt's vault, generated by `configure_solana_signer` (only its address is ever shown) or imported by the operator on the server with `mynt solana import-key --cluster mainnet --file <keypair.json>`. Needs `SOLANA_MAINNET_VAULT_SIGNER=enabled` on the server. |
| `custody-service` | mainnet | A key-custody service (Turnkey or Fireblocks style) signs each transaction without Mynt seeing the key. The interface is in place; until a provider is connected it refuses. |
| `multisig` | mainnet | A multisig (Squads style) holds the upgrade authority and its members approve each change as a proposal. The interface is in place; until a multisig client is connected it refuses. |

**Mainnet is off until an admin turns it on.** Every mainnet deploy, upgrade, simulation and call is refused with "Mainnet signer not configured: …", naming everything still missing, until all of these hold: `SOLANA_RPC_URL_MAINNET` is set; an admin has chosen a backend with `configure_solana_signer` and that backend is ready (for `mainnet-vault`: the server flag and a key in the vault); and the admin has set `enabled: true`. Program calls on mainnet sign with per-developer vault keys, so they need the `mainnet-vault` backend. `configure_solana_signer` with no arguments shows the current state; `list_all_programs` shows every program on both clusters.

**Toolchain** (pinned, each checked against its published sha256 before use): Agave (Solana CLI, `solana-test-validator`, `cargo-build-sbf`) 2.3.13, Anchor CLI 0.32.1 (built from its tagged commit where the release binary's glibc is too new), Rust 1.89.0 through rustup 1.28.2, and Anchor's verifiable-build image `solanafoundation/anchor:v0.32.1` by digest. It installs under `~/.mynt-solana` in the background when a Solana build's sandbox starts: about 2 GB, a few minutes. Agave publishes Linux binaries for x86_64 only. CI's `solana-program` job installs the same toolchain with the same script and builds and tests the template program the same way Mynt's verify sandbox does.

**Configuration:** `MYNT_VAULT_KEY` (required: programs' and signers' keys are sealed with it); `SOLANA_RPC_URL_DEVNET` (default the public devnet endpoint); `SOLANA_RPC_URL_MAINNET` (no default; may carry a provider key, so it is treated as a secret and never shown); `SOLANA_MAINNET_VAULT_SIGNER=enabled` (only for the `mainnet-vault` backend); optional `SOLANA_INDEX_POLL_MS`, `SOLANA_CONFIRM_TIMEOUT_MS`. RPC calls follow Mynt's outbound rules (HTTPS, no private or loopback addresses, no redirects, time and size limits).

**For mainnet, the operator provides:** a mainnet RPC provider's URL as `SOLANA_RPC_URL_MAINNET`; a signer choice; and SOL for the deploy authority's address (about 0.021 SOL per KB of program: the program data reserves twice its size, and the upload buffer holds a copy until the deploy) plus each developer's fee-payer address for calls (and their caller address when their programs make the caller pay rent).

### The product desk (innovators)

The desk answers one question for a firm: does this product make sense, financially and legally? Each firm connects its own GitHub repository as its **workspace** (`connect_desk_repository`, after installing the Mynt GitHub App on it). Its computational logic accumulates there as models: `models/<name>/model.json` declares which products a model applies to, the inputs it needs, and how to run it. The code reads the product, its term sheet and the relevant regulation, and writes a report: a verdict (feasible, marginal or infeasible), metrics, checks that cite the law by `legal_ref`, and stress scenarios.

Work is split by what it needs:
- **Code runs (no AI).** `analyze_product` checks the workspace for a model that applies. If the product's term sheet (`set_product_terms`) has that model's inputs, Mynt clones the repository in a sandbox and executes the model. This is deterministic and re-runnable, costs cents, and never involves an agent. The clone token is removed before any model code runs. If inputs are missing, you get the list to fill in.
- **Agent tasks (intelligence).** If no model applies yet, or you ask for one with `desk_task` (e.g. "add an ALM liquidity ladder for our FD book"), the desk agent takes over. That's Claude Code in a sandbox, through Mynt's agent proxy. It designs the model, chooses and states the assumptions, interprets the regulation from the admins' model, and writes the code and tests on a branch. All arithmetic happens in code. **Mynt then runs that branch itself** in a clean sandbox with no credentials, saves that report, and opens a pull request on the workspace with Mynt's numbers. The agent's own numbers are never used.

`test_product` adds an advisory `feasibility` check from the latest report for the current term sheet, and reports stale when the terms changed. `get_product_terms` shows the term sheet and its analysis; `list_desk_jobs`, `get_desk_job` and `stop_desk_job` track the work.

**Configuration:** a boat.dev key and the GitHub App, plus a model backend for agent tasks. Optional: `DESK_JOB_CAP_USD` (per agent task, default 5), `DESK_RUN_CAP_USD` (per code run, default 1) and `DESK_MONTHLY_CAP_USD` (per firm, default 50; unfinished jobs count at their cap).

**Algorithm explorations.** A product's decision algorithms (the eligibility, underwriting, limit, pricing and fraud-screening entries in its `core_algorithms`) can be improved by experiment. `start_exploration` names one algorithm, an objective to maximise (`net_margin`, `approved_volume`, …) and its constraints: a loss-rate ceiling, an APR cap, a minimum adverse-impact ratio (default 0.8), and reason codes on every decline.
- **Synthetic data.** Mynt generates applicants from the product, deterministically and from a seed (`src/explore-data.ts`). It makes a dev set with outcomes for the explorers, and a holdout only Mynt sees. Its assumptions are saved on the job.
- **The explorers.** Up to five run, each taking a different angle (`workspaces/algorithm-explorer/angles.json`). They loop in the autoresearch style: one change to the algorithm's folder, a short experiment with Mynt's scorer on the dev set, then keep the change or revert it, logged in `explore-log.tsv`. Each pushes every kept state to its own branch. Its push token is a file that Mynt refreshes, never an environment variable.
- **Mynt's ranking.** Mynt runs each branch's `decide`, and the pinned version as a baseline, on the holdout in clean sandboxes. It runs exactly the commits it pinned: the baseline when the job starts, and each branch's head when its explorer finishes. The holdout comes from a random secret per job that only Mynt holds, so it can't be rebuilt from the job's id or data. Mynt scores the decisions itself (`src/explore-score.ts`): the objective, the constraints, and stability over three time slices. Variants that fail a constraint rank below those that pass.
- **Adoption.** `adopt_variant` opens a pull request from a branch Mynt creates at the scored commit. An APR cap is required to start. The product changes only when you merge it and pin the new `version`.

`get_exploration` and `stop_exploration` track the work. Explorers share one cap (`EXPLORE_CAP_USD`, default 20) within the firm's monthly desk budget. `EXPLORE_MAX_ITERATIONS` and `EXPLORE_MAX_MINUTES` bound each explorer's loop.

### Agent workspaces

Every hosted agent is steered by a folder in this repository, never by prompts in the code. When an agent starts, Mynt copies its folder into the sandbox and makes it the agent's working directory. Claude Code picks up its `CLAUDE.md` and skills from there, the skills call the folder's scripts, and the job's data arrives under `job/`. To improve an agent, change its folder.

```
workspaces/
├── coding-build/        developers' coding agent: CLAUDE.md, agents/ (its team), skills, templates/mynt-app (Compose app), scripts
├── build-audit/         the audit-only agent in a build's clean verification sandbox (maxwell-static-audit)
├── product-desk/        innovators' desk agent: designs models in the firm's repo (model-contract, financial-modelling)
├── governance-review/   admins' review agent: checklists, register skills, evidence scripts
└── connector/           the business-development agent (prospecting, outreach, replies-and-consent, introductions)
```

Whatever an agent produces, Mynt checks it itself afterwards:
- **builds:** a clean-sandbox verification;
- **the desk:** running the agent's code;
- **reviews:** re-verifying quotes and computing the recommendation;
- **the connector:** the rules in `send()`.

### The governance desk (admins)

Admins can have an agent review a firm, a licence it registered, or a product it offers, before they decide (`open_review_case`). With `REVIEW_AUTO_OPEN=1`, a case opens for every licence awaiting review. The agent only researches and judges. It can't change anything, and the admin makes every decision.

**The agent is steered by a workspace folder in this repository**, `workspaces/governance-review/`. It's copied into the sandbox and becomes the agent's working directory:

```
workspaces/governance-review/
├── CLAUDE.md                         standing instructions: evidence or nothing, silent ≠ failed, never guess
├── .claude/skills/
│   ├── review-entity/SKILL.md        company registries and GLEIF
│   ├── review-licence/SKILL.md       the regulator's own register: entry, holder, type, in force, enforcement
│   ├── review-product/SKILL.md       limits, misleading claims, disclosures against the recorded regulation
│   └── cite-evidence/SKILL.md        how to quote so Mynt can verify it
├── checklists/{entity,license,product}.json   every item: who checks it (Mynt or the agent), and whether it's material
└── scripts/
    ├── fetch_page.py                 saves a page's text for verbatim quoting
    └── check_review.py               the agent runs it until its review meets Mynt's rules
```

**Mynt does the rest itself:**
- **Its own items.** It decides the items it can from its own records (licence coverage, segments, product tests, feasibility, the licence type) and freezes the case.
- **Evidence.** After the agent finishes, Mynt re-fetches every cited source (public https pages only) and checks each quote is really there. An item backed only by quotes it can't find becomes **unverified**; a "silent" answer that doesn't say what was searched becomes **not reviewed**.
- **The recommendation is Mynt's, not the agent's:**
  - any material item that fails → reject;
  - any material item not confirmed → needs info;
  - otherwise verify;
  - no recommendation at all if more than 20% of items weren't reviewed.
- **Admins:**
  - `get_review_case` shows the dossier: each item's status, verified and unverified evidence, what was searched, the agent's notes, and its suggestions for improving the workspace.
  - `decide_review_case` records the decision in the audit log next to Mynt's recommendation. For a licence, verify or reject sets its review status, as `review_license` does.

**Configuration:** a boat.dev key, `PUBLIC_URL` and a model backend. Optional: `REVIEW_AUTO_OPEN`, `REVIEW_CASE_CAP_USD` (default 3) and `REVIEW_MONTHLY_CAP_USD` (default 60).

### The connector: business development by an agent

Mynt's **connector** is the AI agent that grows Mynt. It finds innovators (licensed firms that could offer products) and developers (who could build on them), talks with them, and introduces people who should work together. It runs on its own schedule on the same harness as builds: Claude Code in a sandbox, using the model through Mynt's agent proxy. Its only tools are Mynt's MCP server: the `bd_*` tools and the public catalogue. Prospects, conversations and introductions live only in Mynt's database.

Everything the connector does to a person goes through one path, and Mynt enforces the rules there, whatever the agent intends:
- **First contact is by email only.** It can go to an address the person or their firm published for business contact (the source is recorded), or to someone a Mynt user referred. WhatsApp and calls are only for people who asked for them.
- **Every message says who's writing** (an AI agent for Mynt) and carries an opt-out. Email gets a one-click unsubscribe link and `List-Unsubscribe` headers. Replying STOP, the link, or an admin's `bd_suppress` ends contact for good. Opted-out addresses are kept as hashes so they can't be re-added.
- **Caps:**
  - a few unanswered messages at most, days apart;
  - weekday working hours where the person is;
  - a daily message cap;
  - a spend cap per run and per month.
- **Introductions share each person's details only once both said yes.**
- **Consent is a per-purpose ledger:** contacting by email, by WhatsApp or by phone, introductions, and the profile itself.
  - Every grant and withdrawal is appended with its basis (consent, published business contact, referral, or publicly available information), its evidence and its actor.
  - Tools check the latest entry, and the agent can ask first with `bd_check_consent`.
- **Erasure:**
  - A person can have the connector forget them, with `connect_forget_me`, or by asking in a reply, which the agent handles with `bd_erase_on_request`. Admins use `bd_erase`.
  - Their profile, messages, introductions and consents are deleted. Only the suppression hashes and the reason remain.
- **Retention:** profiles built from public sources, for people who never replied, are erased after `BD_PROFILE_RETENTION_DAYS` (default 180), without suppressing them.
- Replies, web pages and emails are data to the agent, never instructions.

Anyone signed in can talk to the connector from their MCP client: `connect_with_mynt` (what you do and who you'd like to meet), `connect_refer`, and `connect_my_intros` / `connect_answer_intro`. Admins have `bd_overview`, `bd_prospects`, `bd_run_now`, `bd_suppress` and the kill switch `bd_pause`, which also stops a running agent.

**Configuration:** `BD_ENABLED=1`, on top of what builds need (a boat.dev key, `PUBLIC_URL` and a model backend). Optional: `BD_DAILY_CAP` (default 40), `BD_MAX_UNANSWERED` (3), `BD_FOLLOW_UP_GAP_DAYS` (3), `BD_RUN_CAP_USD` (3), `BD_MONTHLY_CAP_USD` (60), `BD_RUN_EVERY_HOURS` (6) and `BD_SENDER_NAME`. Sending providers for email, WhatsApp and voice plug into `ChannelSender`. Until a channel has one, its messages are kept as drafts for admins to review.

### SDKs and experiences (developers)

**SDKs.** `create_sdk(name, languages, product_ids)` defines an SDK over products you can build on: open or approval products, or private ones you were invited to. `generate_sdk_release(sdk_id, version, changelog)` then writes an immutable, semver-versioned bundle:
- `openapi.json`: an OpenAPI 3.1 document for the app API (`GET /v1/products`, `GET /v1/products/{id}`, `POST /v1/handoffs`, `POST /v1/events`, signed webhooks), with a schema per product built from its fields.
- `typescript/`: `src/schema.d.ts` generated from the document by [openapi-typescript](https://openapi-ts.dev), an [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client for every operation, and a thin `src/index.ts` of Mynt helpers: `createMyntClient`, `startHandoff` (typed to each product's permitted hand-offs), `trackEvent`, `verifyWebhook`, and constants for every product's required disclosures, branding and banned phrases (`disclosuresFor(id)`).
- `python/`: `generate.sh` runs [openapi-python-client](https://github.com/openapi-generators/openapi-python-client) on the document to produce the client, plus a standard-library `mynt_helpers.py` (`verify_webhook`, `disclosures_for`, `check_handoff`, the same constants). openapi-python-client is not a Mynt dependency; tests use it only when installed (set `OPENAPI_PYTHON_CLIENT` to its path to point at a virtualenv).

`list_sdks`, `list_sdk_releases` and `get_sdk_release` (files as `{path, content}`) flag a release **stale**, with reasons, when a product has published a newer version, changed its build terms, been unpublished, or your access was revoked. Generate a new release to pick the changes up. `get_product_sdk` still describes a single product.

**Experiences.** `set_experience(app_id, experience)` gives an app a structured definition: screens of `product_card`, `comparison_table`, `calculator` (maturity, emi, sip), `disclosure_block`, `handoff_cta` and `text` components. On top of the terms lint, `check_experience` and `publish_app` then require:
- every screen showing a product also carries that product's `disclosure_block`, which renders its required disclosures verbatim
- CTAs use only hand-offs the product permits, and comparisons only products that permit `compare`
- components reference only the app's products
- no banned phrase in any title, text or label

`render_experience_preview(app_id)` returns a self-contained HTML page (no scripts or external assets, everything escaped) with product data, disclosures and branding, for review.

### GTM engineering (campaigns)

- **Segments** pick consumers by what they currently hold: `enrolled_in`, `enrolled_in_lines`, and `not_enrolled_in` for cross-sell.
- **Campaigns** target a segment (or everyone) on chosen channels, with up to 5 copy variants for A/B tests.
- **`lint_campaign`** checks every variant against its products. It blocks guaranteed or risk-free claims for products that can lose value, requires a market-risk disclosure for market-linked products, and requires interest/fee disclosure for credit. `launch_campaign` refuses copy that fails.
- **Attribution.** Live campaigns show up in consumers' `list_offers`. Each consumer always sees the same variant, and `enroll_in_product` with the offer's `campaign_id` is attributed. `get_campaign_metrics` reports audience, enrollments, conversion, and results per variant and per product.

### Versioning (innovators)

A published product is never edited in place:
- `create_product_version` drafts the next version with a changelog. `test_product` and `publish_product` then act on that draft, with the same gates as a new product. The live version keeps serving until the draft is published.
- `list_product_versions` and `diff_product_versions` show the history.
- `restore_product_version` drafts a rollback as a new version, so history stays linear.
- Enrollments remember the version they joined on. `upgrade_enrollments` moves all of them to the live version, and a consumer can `upgrade_enrollment` their own.

### Runtime API, webhooks and sandbox (developers)

The MCP tools are for building. A shipped app talks to Mynt's **runtime API** under `/v1`, which is separate from `/mcp`: requests authenticate with a per-app key, not a Clerk sign-in.

**Keys.** `create_api_key(app_id, environment, label, allowed_origins?)` returns a key once (Mynt stores only its SHA-256 hash). Manage keys with `list_api_keys`, `rotate_api_key` (the old secret stops working at once) and `revoke_api_key`; each of these is audit-logged.
- `mynt_live_…` keys work only once the app is published.
- `mynt_test_…` (sandbox) keys work on drafts too.

Send the key as `Authorization: Bearer mynt_live_…`.

| Endpoint | Does |
| --- | --- |
| `GET /v1/products` | `{ products: [...] }`: the products this app may show right now (published, and access granted for the app), each with its fields, `version` and `build_terms`. Revoked or suspended products drop out immediately |
| `GET /v1/products/{id}` | One of those, else `404` |
| `POST /v1/handoffs` | `{ product_id, action: "deep_link" \| "initiate_onboarding", consumer_ref? }` → `201 { handoff_id, redirect_url, sandbox }`. Only if the product's build terms permit the action (`403`). Live: `redirect_url` is the innovator's `handoff_url` with `?handoff_id=…&app_id=…`, or `409 handoff_not_configured` if it has none |
| `POST /v1/events` | `{ type: "view" \| "click" \| "handoff_started", product_id, screen? }` → `202` |
| `POST /v1/sandbox/handoffs/{id}` | Sandbox key only: `{ outcome: "completed" \| "failed" }` resolves a simulated hand-off |

The API never takes or returns consumer financial data:
- `consumer_ref` is the app's own opaque id (letters, digits, `_`, `-`, up to 64 characters). Anything that looks like a phone, account or card number is refused.
- Unknown body fields are refused.

**Errors** are JSON `{ error, message }`, with status `400`, `401`, `403`, `404`, `405`, `409`, `413`, `429` or `500`.

**Limits.**
- Each key gets 60 requests a minute (a token bucket). Past that, the API answers `429` with `Retry-After`.
- Request bodies are limited to 16 KiB.

**CORS.** No wildcard: a browser may call the API only from the origins listed on the key (`allowed_origins`). A key with no origins is for server-side use only.

**Hand-offs.** Innovators set `handoff_url` (https) in a product's build terms with `set_product_access`. When their onboarding finishes or is abandoned, they call `report_handoff_outcome(handoff_id, outcome)`. Only the outcome is shared, never customer data.

**Webhooks.** Each app can register webhooks. Webhook URLs (apps' and firms') must be https on a public address, checked when they're created and again at every delivery: the name is resolved, refused if any address is private, loopback, link-local, carrier-grade NAT or reserved (in any notation), and Mynt connects to the address it checked, without following redirects. Plain http to loopback is allowed outside production, for local testing.
- **Tools:** `create_webhook(app_id, url, events[])` returns the signing secret once. Then `list_webhooks`, `rotate_webhook_secret`, `delete_webhook`, and `list_webhook_deliveries(webhook_id)` (status, attempts, last response code).
- **Events:** `product.version_published`, `product.unpublished`, `product.suspended`, `access.approved`, `access.revoked`, `request.decided`, `handoff.completed`, `handoff.failed`. Each goes to every webhook of every app affected.
- **URLs:** must be https and publicly reachable in production. Plain `http://127.0.0.1` is allowed only outside production, for local testing.
- **Delivery:** each body is `{ id, type, created_at, data }`, where `data` includes the receiving `app_id`. A delivery that fails is retried with exponential backoff (30 s, 1 m, 2 m and so on, doubling each time, 8 attempts in all). `serve-http` runs the delivery worker.

Verify the `Mynt-Signature: t=<unix>,v1=<hex>` header against the raw body:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyMynt(secret, header, rawBody, toleranceSec = 300) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return v1?.length === expected.length && timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}
```

**Sandbox.** Sandbox keys see the same product data as live keys. Hand-offs are simulated:
- `redirect_url` points at a Mynt sandbox page.
- Resolve a hand-off with `simulate_handoff(handoff_id, outcome)` or `POST /v1/sandbox/handoffs/{id}`. Either one sends `handoff.completed` or `handoff.failed` to your webhooks.
- `create_test_consumer(app_id, label)` gives you an opaque `consumer_ref` to test with.
- Sandbox events and hand-offs are stored but flagged, and are left out of live analytics.

**Releases.** `release_app(app_id, version, changelog)` runs `publish_app`'s checks, publishes the app, and snapshots the whole app definition.
- Versions are semver and must increase.
- `list_app_releases` shows the history.
- `rollback_app(app_id, version)` makes an earlier snapshot current again, if it still passes the products' current terms.
- `publish_app` records a first release (`1.0.0`) if an app has none.

**Client sessions: SDKs for servers and for devices.** An app key belongs on the developer's server. A customer's browser or phone gets a client session instead.
- **`POST /v1/client_sessions`** (app key, server only: refused when sent from a browser) mints a session for one customer:
  - its products, each of which needs a developer contract;
  - its scopes: client actions taken from those contracts;
  - a lifetime of at most an hour.

  It returns a `mcs_…` secret to send to the device.
- **The device calls `/v1/client/*`** with that secret, and only from the origins the app's key allows:
  - `GET /v1/client/offers` returns the contract's offers, documents, consent purposes and the actions the session may start.
  - `POST /v1/client/evidence` records that a document was shown (with a hash of the exact text), or that consent was given or withdrawn. It only accepts the contract's own documents and consent purposes.
  - `POST /v1/client/actions/{action}` starts a provider-hosted flow and returns where to send the customer. It's refused until the action's consent is recorded in that session, and again after the consent is withdrawn.

  Evidence is stored against the contract version, ready for the developer's GRC folder.
- **Servers read a contract** with `GET /v1/products/{id}/contract`.

**Generated SDKs.** A generated TypeScript SDK has two entry points:
- **The default (server) entry** adds `createClientSession` and `getContract`. A session's scopes are typed to the client actions of its products.
- **`./browser`** is `createMyntBrowserClient({ clientSecret })`, with `offers`, `documentShown`, `giveConsent`, `withdrawConsent` and `startAction`. It uses only web APIs (fetch and WebCrypto) and refuses an app key. Its typing won't let a device start a server-only action.

**Journeys.** A journey is how an app walks a customer through a product, written as a declarative spec rather than code. It's a graph of steps, and each step does one thing:
- a screen of elements: offer cards, documents, data fields, text or an outcome;
- a consent capture;
- one of the provider's hosted actions;
- a wait for a lifecycle event.

Branches use `on: { outcome: step }`.

**Data fields come from Mynt's data dictionary** (`get_data_dictionary`). Each field has a type and validation, a sensitivity level, and the ways it may be captured: typed, a secure field, a document upload, Account Aggregator, DigiLocker or CKYC. Each contract action lists the dictionary fields it needs (its `data_requirements`, taken from its handoff's input schema).

**`check_journey` checks every path through the journey:**
- consent is captured before any personal data;
- every document the product requires is shown before any hosted action;
- every field an action needs is collected before it;
- no field is collected that no action needs;
- sensitive fields go only in secure inputs;
- every step is reachable, and every path ends.

Each error names the step and the fix. The check also lists every path through the journey, for simulation.

**Tools.** `get_default_journey` builds the minimum compliant journey from the product's contract, so developers start from something that already works. `preview_journey` renders an HTML outline. `save_journey` stores a journey on an app, and `list_journeys` shows whether each saved journey is still current.

**Serving to devices.** Devices fetch a saved journey with `GET /v1/client/journeys/{journey}`. It's served only while it was checked against the product's live contract. Once a new contract is published, it returns `journey_outdated` until the developer checks and saves it again.

**The customer vault.** Data a customer gives once is kept per app and per customer reference, so the next journey can skip asking for it. It's encrypted at rest with AES-256-GCM, using `MYNT_VAULT_KEY`; the host installer generates that key once and keeps it across runs. Sandbox sessions use a key that exists only in that process.

The device routes need a client session that has a `customer_ref`:
- **`POST /v1/client/fields`** stores values. The server enforces the rules:
  - only fields one of the product's client actions needs;
  - only after an active consent;
  - sensitive fields only from a secure field;
  - every value validated against the data dictionary.
- **`GET /v1/client/fields`** shows what's held, masked.
- **`POST /v1/client/prefill`** fetches fields from Account Aggregator, DigiLocker or CKYC, with consent. When the product hands off to a vendor's standard service for that source (see [Vendors](#vendors-standard-services-per-region)), Mynt calls the vendor: its test endpoint for sandbox sessions, its live one once the innovator turned the subscription live. The service's own consent purpose must be recorded first (`409 consent_required`), its inputs must be in the customer's vault (`409 data_required`), and the answer is checked against the service's output schema before any field is saved (`502 vendor_error` otherwise; `503 vendor_unavailable` when the offering is suspended). Without a vendor, sandbox sessions get realistic fixture values and live connectors return `501` until they're configured. The app sends the same request either way.
- **`DELETE /v1/client/fields`** erases everything held for the customer.

A hosted action refuses to start (`data_required`) until the personal data it sends is held for the customer. An action served by a vendor's standard service (`served_by` in the contract) answers with `{ reference, action, status, sandbox }` and only what the service type allows (a `redirect_url` to the provider's page for e-sign and e-mandate), never the vendor's result: that goes to the innovator. See [Vendors](#vendors-standard-services-per-region).

**SDKs for every client.** `create_sdk` languages: `typescript` (server, plus `./browser`), `python` (server), `react_native`, `kotlin` (Android), `swift` (iOS and macOS) and `flutter` (Dart).

Every device SDK has the same client and journey runner as `./browser`, and each:
- runs on a client session, never an app key;
- carries the app's contract constants (client actions, consent purposes, documents), so misuse fails before any request is sent;
- hashes evidence with the platform's SHA-256: WebCrypto, `MessageDigest`, CryptoKit or swift-crypto, Dart's `crypto`, or plain TypeScript on React Native.

The device SDKs are generated from source templates in [`sdk-templates/`](../sdk-templates). CI compiles a generated set on every change: Kotlin with `kotlinc`, Dart with `dart analyze`, Swift with `swift build`.

**Hosted runtime.** Developers can run their apps' financial part on Mynt: the server that holds the app key, calls contract actions and handles webhooks. There are two modes. **Direct hosting on Freestyle** (below) is the default whenever `FREESTYLE_API_KEY` is set. The legacy **gateway mode** (`HOSTING_GATEWAY_*`, used only without Freestyle) gives each developer one VM (`request_hosting`, `hosting_status`) that's never reachable from the internet or from the platform's network:
- **First boot.** The VM installs Docker, gVisor and WireGuard, then generates its own WireGuard key, which never leaves it.
- **Registration.** It registers with a one-time token (`POST /v1/hosting/bootstrap`). Mynt then locks its cloud firewall down to WireGuard to the gateway, and nothing else in or out.
- **All traffic goes through the tunnel.** The gateway forwards nothing directly. Its egress proxy reaches only Mynt's API, GitHub, package registries and the hand-off hosts of the app's products.
- **Deploying.** `deploy_app(app_id, build_id)` takes only a build that passed Mynt's verification. The VM's agent then polls its policy (`GET /v1/hosting/policy`), which gives it the verified commit, a read-only, short-lived token to fetch it, and the app's dedicated key (stored sealed). The agent builds the image and runs it under gVisor: read-only, with no capabilities, and limited CPU and memory.
- **Serving.** Customers reach the app at `<app>.<HOSTING_APPS_DOMAIN>`, through the edge and the tunnel.
- **The kill switch.** An admin's `suspend_tenant` takes the VM off the gateway at once (peers, routes and egress) and powers it off. `resume_tenant` brings it back, and `undeploy_app` stops a single app.

**Direct hosting on Freestyle** (set `FREESTYLE_API_KEY`; the default when present). Instead of a tunnel, Mynt drives [Freestyle](https://www.freestyle.sh) VMs through Freestyle's API, **one VM per hosted app**:
- **The app's key is never on its VM.** Calls to Mynt's API get the app's key added on the way out by Freestyle's edge as `X-Mynt-App-Key`, from a rule only Mynt can write (it reads back masked). Mynt honours that header only next to the placeholder bearer of the same environment, and never on `/v1/client/*`, so a customer's client session is never swapped for the app's key. Because anything the app sends to Mynt's other routes carries the key, an app must never forward callers' requests there: the starter app's web server forwards only `/v1/client/*`, and the compliance reviewer and readiness checks hold every build to that. The app holds a placeholder of the right shape (`mynt_<env>_injected_at_edge`) and trusts the edge's CA through the VM's bundle, mounted read-only (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`). A VM per app is what lets each app's calls carry its own key.
- **The VM starts with nothing in and nothing out.** Its first boot may reach only gVisor's release host, to install its pinned, checksummed release. After that its egress is exactly the app's allowlist, as per-domain rules that pass TLS straight through (only Mynt's host is terminated, to add the key). The npm registries, which Freestyle's edge can't carry yet, are allowed by their own addresses instead.
- **Deploying** builds the verified commit on the app's VM as a detached job; the source token travels as the job's environment, never its text. Containers run under gVisor, read-only, with no capabilities and limited CPU and memory, and the VM is a Firecracker microVM of its own.
- **Serving.** Each app (each labelled compose service) gets a public HTTPS route, `https://mynt-<app>.style.dev` (or `<app>.<HOSTING_APPS_DOMAIN>`), straight to its port.
- **The developer logs in.** `vm_access` returns SSH commands for their own Linux user (in the docker group, no sudo) on each of their apps' VMs, valid for a few hours. They work as VS Code Remote-SSH hosts too, and new logins revoke the last. `app_status`, `app_logs`, `app_run` and `restart_app` run at once.
- **The kill switch** pauses every app VM; `undeploy_app` deletes the app's VM, which takes its rules and key with it.

**Working with a hosted app.** Developers reach their app's container through Mynt: `app_status` (state, health, restarts, CPU and memory), `app_logs`, `app_run` (a command inside the app's container, under gVisor, never on the VM itself) and `restart_app`. Mynt runs it on the app's VM (in gateway mode, the VM's agent claims it over the tunnel within a few seconds), only against that developer's own app container, and posts the result back, scrubbed of secrets. Every request is audited.

[`deploy/host/hosting-gateway.sh`](../deploy/host/hosting-gateway.sh) sets up the gateway on the host that runs Mynt, and a timer re-syncs it every minute from `mynt hosting wg-peers`, `egress-allowlist` and `routes`. Hosting is enabled with `HOSTING_DO_TOKEN`, `HOSTING_GATEWAY_ENDPOINT`, `HOSTING_GATEWAY_PUBLIC_KEY` and `PUBLIC_URL`; DigitalOcean is the first provider.

**Developer modules.** Developers publish reusable modules under their own namespace: `check_module`, `publish_module`, `list_modules`. A module is something like an EMI planner component, a journey step or a webhook handler, built on products' developer contracts. Mynt checks each manifest against the live contracts:
- the actions exist, and may run where the module runs: client modules only client actions, isomorphic ones only actions that run on either side;
- every consent those actions need is declared;
- a client component renders every document its products require.

Beyond the checks:
- **Namespaces** are first come, first served.
- **Versions** are immutable.
- **Verified:** a module is marked verified when its code comes from a build Mynt verified.
- **Outdated:** once a product publishes a new contract, modules built on the old one show as not current.

**The journey runner.** The browser SDK has methods for all of this: `saveFields`, `knownFields`, `prefill`, `forgetMe` and `journey`. It also has `createJourneyRunner(client, journeyId)`, a headless runner: the app renders the current step however it likes, then calls `complete()` with what the customer did. The runner then:
- records document and consent evidence;
- stores fields, with secure ones sent as secure;
- triggers prefill;
- starts hosted actions and returns where to send the customer;
- follows the journey's branches.

**Analytics.**
- Developers: `get_app_metrics(app_id, from?, to?, include_sandbox?)` gives views, clicks and hand-offs (started, completed, failed) per product and per day. It also gives conversion (completed hand-offs per view) and the hand-off completion rate. Only live traffic counts unless you set `include_sandbox`.
- Innovators: `get_product_distribution_metrics(product_id)` shows how one of their products performs across every app that shows it.

Roles nest: **every admin is also a builder, and every builder a consumer**. `innovator` and `developer` are two names for the builder role: each implies the other, so existing users, invites and docs keep working, and `whoami` shows both among the effective roles. Each role gets its own tools plus everything below it. **Vendors** and **licence providers** stand beside builders: they get the catalog tools, their firm and their own tools only, and can't publish products or build apps. Every admin is also a vendor and a licence provider, and an admin can grant one person several of these roles. Tools are registered per user, so a client only *sees* the tools its roles allow. `whoami` shows both the granted and the effective roles.

## Licence providers: sponsoring builders' products

A builder needn't hold licences. A **licence provider** is a firm that does: an admin adds it by hand (`register_firm`, `invite_user` with the `license_provider` role, `add_entity_member`), it registers its licences (`register_license`) and an admin verifies them (`review_license`), as for any firm. Its people share its firm id with builders out of band; there is no directory of firms.

1. **The builder names the provider** as a component's provider: `{ by: "sponsor", entity_id }` in `set_product_composition`, or `component_provided_by` to `{ kind: "sponsor", id }` in a v2 definition.
2. **The builder asks** with `request_sponsorship` (product, component, provider firm id, and the jurisdictions, by default where the component is offered). One request may be pending per component and provider; asking again later adds jurisdictions.
3. **The provider decides**: `approve_sponsorship` names its held licences (verified and in force; a registration that covers nowhere by itself, like the FinCEN registration, isn't named: it counts automatically as the named licences' prerequisite) and the jurisdictions they cover; or `decline_sponsorship`. `revoke_sponsorship` withdraws an approved one.

**The regime rule.** A sponsored component is covered in a jurisdiction only by a licence of that provider which an approved sponsorship names for that jurisdiction, verified, in force, granting the component, covering the jurisdiction, and with the provider's own prerequisites held. Anywhere else it's blocked ("Ramp Partner Inc (sponsor) doesn't sponsor this in us-ca"), and with no approved sponsorship at all it's blocked everywhere. A builder with no licence and no sponsor is blocked as before ("Your entity holds no verified licence granting this").

**Mandated stakeholders** are the licensee's. The regulatory model attaches them to the licence type, and the licence is the provider's, so they must be filled on the **provider's** roster (enforced: a gap blocks publishing, as for the owner's own licences), but they aren't bound to the builder's product, since they aren't on the builder's roster. The builder still names its own `product_owner`.

**Pins and drift.** Publishing pins each covering sponsorship (with the jurisdictions it covers), the provider's licences and its stakeholder parties, and the provider's firm. Revoking the sponsorship, or the provider's licence lapsing or being suspended, drifts the product, naming the jurisdictions. The stored `regime_summary` shows `provided_by: "sponsor"`, the provider's name, and on each covered jurisdiction a note such as "Covered by Ramp Partner Inc's Money transmitter licence (New York Banking Law Article 13-B) (sponsored)".

**`test_product`** doesn't warn a builder that holds no licence when it needn't hold one: if it provides no component itself and every component is covered by a sponsor (or a partner), `licence_held` passes and names who covers what ("Example Money Transmitter (placeholder) sponsors 'transmission' in us-ny, us-ca"); while a sponsorship is still pending it warns only that the composition isn't covered yet. A builder providing a component itself is still warned when it holds no licence.

### A sponsored US product, end to end

`scripts/sponsored-product.mjs` runs the whole path from an unlicensed builder to a developer-ready US product: the licence provider's firm (registered by hand), its licences (registered, then verified by an admin) and the roster filling the stakeholders they mandate; the builder's firm and its product, the money transmission template (`schemas/examples/us/money-transmission.v2.json`) with transmission provided by the sponsor; `request_sponsorship` and `approve_sponsorship` for every state it's offered in; `test_product`, `publish_product`; and a check that `list_products` with `developer_ready` lists it. `test/sponsored-product-e2e.test.js` runs the same function on an in-process server.

What it runs on is a JSON fixture. The shipped one, `schemas/examples/us/sponsored-product.placeholder.json`, is a **placeholder for staging and tests only**: "Example Money Transmitter (placeholder)" isn't a real firm, its registration numbers start `PLACEHOLDER-`, and it has `"placeholder": true`, so the script refuses it unless told it's staging. It holds a FinCEN MSB registration and money transmitter licences for New York and California, the states the US model (`schemas/regulatory/us.json`) has regulators for; another state needs its regulator and licence type added to the model first, researched from the state's own sources.

Every step reads first and does only what's missing, so rerunning is safe and picks up where a run stopped. Three people act, each in their own session (`MYNT_ADMIN_TOKEN`, `MYNT_LICENCE_PROVIDER_TOKEN`, `MYNT_BUILDER_TOKEN`, from the environment, never the command line); with only some of them set, it does their steps and stops naming who's needed next (the partner usually approves in its own session).

```bash
node scripts/apply-sponsored-product.mjs --url <a staging server's MCP URL> --staging --dry-run   # read only: what it would do
node scripts/apply-sponsored-product.mjs --url <a staging server's MCP URL> --staging             # run it with the placeholder
```

**When the real partner signs**, an admin swaps it in and reruns:

1. Copy the fixture (say `sponsored-product.partner.json`, kept out of the repository if it names the partner before that's public) and set `"placeholder": false`; delete `placeholder_note`.
2. In `licence_provider`: the partner's legal name (or `entity_id`, if its firm is already on Mynt), the email its person signs in with (`member_email`; invite them with the `license_provider` role first), its legal form and incorporation, each licence it holds as on the regulator's register (`regulator_id`, `license_id`, `registration_number`, and `valid_from`/`valid_to` when known), and the people who fill each stakeholder its licences mandate (`roster`).
3. Change `product.offered_in` to the states it will sponsor in.
4. Check every licence against the regulator's public register, then run with `--verify-licences` (without it the run stops for `review_license`):

```bash
node scripts/apply-sponsored-product.mjs --url <the server's MCP URL> --fixture sponsored-product.partner.json --dry-run
node scripts/apply-sponsored-product.mjs --url <the server's MCP URL> --fixture sponsored-product.partner.json --verify-licences
```

A product already live under the placeholder gets a new version sponsored by the partner (its definition changes, so it's saved as the draft version, sponsored, tested and published). The placeholder firm's own sponsorship is then left over: revoke it (`revoke_sponsorship`, as the placeholder's licence provider) and suspend its licences (`review_license`) so nothing can rest on it again.

## Product lines, actions and primitives

Product lines group products by **economic function**, not asset class: what a product does for the person or firm using it. Every product has one `product_line`:

- **credit**: lending and debt instruments, issued or bought: cards, personal/home/auto/education/gold loans, BNPL, working-capital loans, leasing, government and corporate bonds, T-bills, commercial paper
- **securitization**: pooling assets into securities: PTCs, ABS/MBS, direct assignment, co-lending pools, REIT/InvIT unit issuance, asset reconstruction
- **payments**: moving money: acceptance, payouts, mandates, wallets, remittances, CBDC
- **account_operations**: holding and running money: savings, current, term and recurring deposits, sweep accounts, money-market accounts, certificates of deposit, cash management
- **custody_settlement**: safekeeping and settlement: custody, depositories, clearing and CCPs, escrow, trustees, vaults
- **wealth**: investment exposure: mutual funds (money-market and liquid funds too), ETFs, equities, PMS/AIF, REIT/InvIT units bought as an investment, government savings schemes, and retirement products such as pensions, provident funds, 401(k)s and IRAs
- **insurance**: term/whole life, health, motor, home, travel, ULIPs, annuities
- **guarantees_trade**: bank guarantees, letters of credit, surety, credit and deposit guarantee schemes, factoring, supply-chain and export finance
- **exchange**: currency conversion, securities trading and execution, commodities and bullion trading, digital assets
- **derivatives**: forwards, swaps, futures, options
- **information**: credit bureaus, account aggregators, ratings, KYC registries, market data

A product that spans functions is a **composition** of primitives, not a line of its own. A cross-border transfer is an exchange primitive (the currency conversion) plus a payments primitive (moving the money). Retirement is wealth plus a statutory wrapper, and commodities are an underlying, not a line.

The **primitive is the line itself**. A product component is a line with an action, in a country. Collateral, customer segment and purpose aren't attributes of the primitive: they are the product's business context (collateral, for instance, is a source of value in underwriting). What a component falls under in a country, its **perimeter**, is every regulated product type there whose category is on that line and which allows the action. Who supervises it, which licences may provide it, and the law recorded against it all follow from that perimeter. Each regulated product type lists the **actions** that can be taken on it:

- **issuance**: creating it as the issuer
- **sale**: distributing it for its issuer
- **purchase**: buying it
- **secondary_sale**: selling it on after purchase
- **repackaging**: bundling it into something else
- **advice**: advising on it
- **servicing**: running it after the sale (collections, reconciliation, record-keeping)
- **underwriting**: taking on its risk or guaranteeing its placement
- **assessment**: producing an independent rating, valuation, index, actuarial certification, audit or accreditation of it

Two optional attributes describe the primitive itself:

- `underlying`: what it is made of: `cash`, `securities`, `commodities`, `real_assets`, `receivables`, `risk`, `data` or `digital_assets`
- `wrapper`: a statutory or tax structure around it: `statutory_pension`, `tax_advantaged` or `government_scheme`

### Legal entities: facts, parties and GRC folders

A legal entity is recorded as typed facts, never prose:
- **Legal form**, from a fixed list.
- **Incorporation**, as lowercase ISO 3166 codes such as `in` or `in-mh`.
- **Identifiers**, as `{ scheme, value }`, for example `in_cin`, `lei` or `us_ein`.
- **Status**, which admins set from the company registry.
- **Licences held**, which admins verify.

Each entity keeps a **party roster** (`add_party`, `end_party`):
- **Internal** parties are people, such as the compliance officer.
- **External** parties are other legal entities, such as the statutory auditor or a lending partner.

A party fills the mandatory stakeholders that the licence type of a held licence requires (`grc.mandatory_stakeholders` in the regulatory model). It may also be a counterparty, with a relationship code. Parties aren't edited: to change one, end it and add a new one.

`get_my_entity` reconciles each held licence against the roster. It reports:
- which mandated stakeholders are filled, and by whom;
- which are missing;
- which parties fail the stakeholder's qualification criteria;
- which parties have no stated facts for those criteria.

Each entity, and each party on its roster, has a **GRC folder** (`file_grc_record`, `get_grc_folder`) laid out like the GRC of the licences it holds. It has two parts:
- **Registers.** Obligations hold a compliance status and the owner party. Filings hold the period, status and when they were filed. Risks hold the inherent and residual rating. Controls and inspection events follow the licence's templates.
- **Repositories.** Communications, enforcement actions and press releases are simple records. Policies, risk models and inspection history follow the licence's templates.

Template records are checked against the template's field schema. Owners and approvers must be active parties on the roster. Mynt matches the folder against each licence's GRC and lists the gaps:
- an item with no record;
- an owner or approver who doesn't fill the stakeholder the regulator holds accountable;
- an obligation marked non-compliant.

A vendor's due diligence goes in the vendor's own folder and still counts towards the licence.

A product names who provides each component: the owner itself, under one of its licences, or an external party on the owner's roster. Products never name parties by free text. Publishing pins two things: the live composition, and a hash of the state of every entity, licence and party it rests on. Some changes mean the product has drifted:
- a licence lapses or is suspended;
- a party ends;
- an entity is struck off.

A drifted product pauses new enrollments and emits `product.drifted`. New enrollments resume when the state is restored (`product.drift_cleared`) or a new version is published. Changes made through Mynt are checked at once, and the HTTP server also re-checks every hour so expiries are caught.

### Product definitions (v2)

A product's full definition follows [`schemas/financial-product.v2.schema.json`](../schemas/financial-product.v2.schema.json).

**What it contains**
- **Components**, each a line × action, joined by typed composition links. The link types are:
  - `funds`, `settles_into`, `converts_into`, `repays_from`, `co_funds`;
  - `guarantees`, `secures`, `covers`, `wraps`;
  - `requires`, `excludes`, `feeds_data`, `services`;
  - `discovers_price_for`, which makes an exchange component a marketplace.
- **Business context around them:** customer segments, core algorithms, risk models, partner handoffs, terms, rates, fees, limits, servicing policies, lifecycle events and costs.
- **Connections:** every link between nodes is a typed connection with its own schema, and no node holds lists of other nodes' ids.
- **Upstream records by reference:** the register's personas and items, the owner's licences, roster parties and GRC records are connection targets, never copied in.

**How it's checked.** `check_product_definition` validates a definition, and `set_product_definition` validates it before saving. The checks:
- the JSON Schema;
- that every connection end resolves, including upstream records, which must be real and current;
- the composition rules:
  - the allowed primitive × action at each end of a link;
  - exactly one provider per component;
  - a partner handoff to every party that provides a component;
  - exactly one primary risk model per algorithm;
  - every risk model governed by a GRC record, owned by an internal party.

Every error comes back at once. A valid definition checked against a product (`product_id`) also lists `publish_blockers`: what its regime would refuse at publish, such as an uncovered component or a mandated stakeholder who isn't bound to the component it serves. Innovators and their agents read the schema itself over MCP as the resource `mynt://schemas/financial-product.v2`.

**What saving does**
- It sets the product's composition and parties, so the regime, the publish checks, pins and drift all keep working.
- It sets the catalogue record from the definition's projection, so existing tools, SDKs and apps keep reading the same fields.
- On a live product, it goes into the draft version.

**Handoffs to a vendor's standard service.** A `handoff_to_party` connection may name `attributes.vendor_subscription_id` (and, for readers, `service_type`): the firm's subscription to a vendor's offering. The party must be that subscription's vendor (subscribing adds it to the roster), `consent_purpose` the service type's, and the handoff's `sends.required` must include the service type's required inputs (so devices can collect them). The handoff's client action is then served by the vendor. Both attributes are optional; definitions without them are unchanged. See [Vendors](#vendors-standard-services-per-region).

**At publish.** The definition is checked again, since parties, licences and records may have changed. Its hash is then pinned as `pins.definition_hash`, and handoffs bound to vendor subscriptions as `pins.vendor_bindings`.

**Developer contract.** Publishing a defined product freezes its **developer contract**: exactly what developers build against. It comes from `get_developer_contract`, and it's also returned by `get_product_sdk`. Innovators preview it in `check_product_definition`.
- **Offers** per customer segment: eligibility, terms, rates, fees and customer-facing limits, with segment overrides applied.
- **Actions:**
  - `view_offers`;
  - each partner handoff, as the provider's hosted flow on the customer's device, with its consent purpose and typed inputs and outputs;
  - each customer-triggered lifecycle event, as an idempotent server call.
- **Lifecycle events** an app can listen to, the **consent purposes** it must hold and the **documents** it must show.
- **Never included:** algorithms, risk models, fraud and velocity controls, costs, revenue shares and the parties behind the product.

Each version's contract carries a `contract_hash`, which changes whenever the contract does.

**Product GRC folders.** Each product has its own GRC folder: `file_grc_record` and `get_grc_folder` with `product_id`. This is where, for example, the governance of the product's risk models lives.

**The reference catalogue's definitions.** Mynt's reference products have no firm, so their definitions name no providers, partner handoffs or risk models (those belong to the firm that offers the product, with its consent purposes and its model governance), but they carry everything else: components, segments, algorithms, terms, rates, fees, limits, servicing, lifecycle events and the register obligations each part satisfies. Admins save one with `set_product_definition`, then `test_product` and `publish_product` publish it as the product's next version, with a developer contract. [`schemas/examples/seed/`](../schemas/examples/seed/) holds definitions for `savings-account`, `fixed-deposit`, `recurring-deposit` and `personal-loan` (India), each with its sources and assumptions in `descriptions.long`. They point at the RBI in India's regulatory model: regulator `rbi` with the personas `rbi_resident_individual`, `rbi_senior_citizen` and `rbi_retail_borrower`, and the universal bank licence `rbi_universal_bank` with the thirteen `rbi_*` obligations they cite. [`schemas/regulatory/in.additions.json`](../schemas/regulatory/in.additions.json) adds exactly those to a server that already has the RBI and that licence, as production does, and only adds (see the regulatory model script below); apply it first. [`test/seed-regulatory-model.js`](../test/seed-regulatory-model.js) builds a slice shaped like production's and applies it. The catalogue cites the regulator whose licence types grant the lead component's product type, preferring the one whose licence the definition's register items cite, so these four cite RBI. To apply them to a server:

```sh
node scripts/apply-seed-definitions.mjs --url <the server's MCP URL> --login --dry-run   # sign in in the browser, check only
node scripts/apply-seed-definitions.mjs --url <the server's MCP URL> --login             # check, save, test, publish
```

`--login` signs you in through your browser the way an MCP client does: OAuth discovery from the MCP URL, dynamic client registration, the authorization code flow with PKCE and a state check, the callback at `http://localhost:<port>/callback`, listening on the loopback addresses (`127.0.0.1` and `::1`) only. The access token stays in memory: it is never printed or saved. Instead of `--login`, an admin token can be set in the shell as `MYNT_ADMIN_TOKEN`; a token is never accepted on the command line.

The script checks every file first (`check_product_definition` with the product id) and changes nothing if any is invalid or has publish blockers, printing the errors and blockers. Otherwise it saves, tests and publishes each one and prints one line per product. A product whose live definition already matches is skipped. Pass file paths to apply only some.

#### Run it yourself: check the seed definitions against a Mynt server

This checks the four definitions against the server and changes nothing. It takes about ten minutes the first time. You need an admin account on that Mynt server and its MCP address (it ends in `/mcp`).

1. Install Node.js version 22 or newer from [nodejs.org](https://nodejs.org/en/download) (the "LTS" download). Mynt needs 22.13 or later. To check it worked, open a terminal (Terminal on a Mac, PowerShell on Windows) and type `node --version`: it should print `v22.13` or higher.
2. Download Mynt's code. In the terminal, type:
   ```sh
   git clone https://github.com/never2average/mynt.git
   cd mynt
   ```
   If `git` isn't installed, download the ZIP from the repository's green **Code** button instead, unzip it, and `cd` into the folder.
3. Install what the script needs:
   ```sh
   npm ci
   ```
4. Run the check, putting the server's MCP address in place of `<Mynt MCP URL>`:
   ```sh
   node scripts/apply-seed-definitions.mjs --url <Mynt MCP URL> --login --dry-run
   ```
5. Your browser opens on Mynt's sign-in page. If it doesn't, copy the link the terminal printed into your browser. Sign in with your admin account. The browser then says you can close the tab.
6. Back in the terminal you'll see `Signed in.`, then one line per product. `valid, no publish blockers` means it's ready. `NOT READY` is followed by the reasons, such as a regulator or persona the server doesn't have yet. The last line is `Dry run: 4 definition(s) checked, nothing changed.` or `Stopped: nothing was changed.`
7. Copy everything the terminal printed and send it back. It contains no password or token. The only link in it is the sign-in link, which worked once and has already been used.

With `--dry-run`, the script only reads: it makes no change to the server's products, whatever it prints. The only thing it leaves behind is the sign-in itself: the sign-in service records it and the script's registration as a sign-in client.

Variants (a template plus a patch) can't be saved yet. Save the resolved product as `plane.role: "standalone"`.

#### Set up a region's regulatory model: the United States

A region's regulatory model can be kept as data and applied in one step. [`schemas/regulatory/us.json`](../schemas/regulatory/us.json) is the US slice for on-ramps, off-ramps and buy-and-hold stablecoin products, each instrument with its source:
- **FinCEN:** money services business registration (`fincen_msb`; it covers no state by itself and is the prerequisite of every state money transmitter licence), with its AML, suspicious-activity, currency-transaction, funds-transfer and Travel Rule obligations, plus the OFAC, Regulation E and Form 1099-DA obligations every ramp carries;
- **NYDFS** (`jurisdiction: "us-ny"`): the money transmitter licence (`nydfs_money_transmitter`), the BitLicense and the limited purpose trust charter;
- **California DFPI** (`jurisdiction: "us-ca"`): the money transmission licence (`ca_dfpi_money_transmitter`) and the Digital Financial Assets Law licence;
- **OCC:** the national trust bank charter and the GENIUS Act's federal payment stablecoin issuer.

It also defines the product categories and regulated product types they cover. Applying it loads the US service types too, including the Mynt Ramp's four. NYDFS and DFPI licences cover only their state, and the state money transmitter licences count only alongside the FinCEN registration (`requires`), which covers no state by itself (`covers: []`). The OCC charters cover every state (`covers: ["us"]`), each with a `coverage_note` saying that this is an assumption to verify. To add a state's money transmitter licence, follow the pattern in the file's `description`. See [Coverage per state](#coverage-per-state).

```sh
node scripts/apply-regulatory-model.mjs --url <the server's MCP URL> --login --dry-run   # check only: prints what would be added, updated or removed
node scripts/apply-regulatory-model.mjs --url <the server's MCP URL> --login             # apply
```

It merges the file into what the server has; it never replaces it. For each category, product type, instrument and regulator in the file it reads the server's version, merges the file into it by id (licence types, personas, product-type mappings, GRC registers and repositories, stakeholders) and sends the merged whole, so anything the file leaves out is kept. A file can hold only additions, like [`schemas/regulatory/in.additions.json`](../schemas/regulatory/in.additions.json). Items that end up unchanged aren't sent.

It checks every merged item against the server's own tool schemas first and changes nothing if any is wrong. The dry run prints, per item, what would be added (`+`), updated (`~`, with the fields) and removed. Merging removes something only when a plain list in the file lacks an entry the server has (an action, a covered state, a product line), or when a shipped service type would overwrite a different version on the server. Any removal stops the run, changing nothing, unless you add `--allow-removals`; the removals are listed either way. Even with `--allow-removals`, items the file doesn't mention are never deleted: use the `remove_*` admin tools for that. The region's regulator names are merged, not replaced. Sign-in works as for the seed definitions above. [`test/us-regulatory-model.test.js`](../test/us-regulatory-model.test.js) runs exactly what the script does.

**A US product to start from.** [`schemas/examples/us/usdc-account.v2.json`](../schemas/examples/us/usdc-account.v2.json) is a firm-less template for a **Dollar Holding Account** (`dollar-holding-account`): customers add, hold and cash out US dollars and see dollars only. (The **Dollar Account**, `dollar-account`, in [`dollar-account.v2.json`](../schemas/examples/us/dollar-account.v2.json), is the other route: it builds on the money-transmission product instead of composing the ramp itself; see [base products](#base-products).) Underneath, for the regulatory model, a ramp (`payments:sale`) funds a USDC purchase on Solana (`settlement_exchange`, `exchange:sale`, `digital_assets`), which settles into custody (`settlement_custody`, `custody_settlement:servicing`); cashing out settles back through the ramp. It has customer segments, KYC, sanctions screening and quoting algorithms, fees, limits, statements, lifecycle events (on-ramp and off-ramp acceptance become the customer actions in its developer contract) and the FinCEN register obligations each part satisfies. A firm takes it as is and adds:
- `owner_entity_id`;
- a `component_provided_by` for each component. A FinCEN registration covers the ramp and the exchange; custody needs a custodian's licence, such as an OCC national trust bank charter or a NYDFS trust charter;
- its AML compliance officer bound to the ramp and the exchange;
- its ramp handoffs bound to its Mynt Ramp subscriptions.

Stores created under the original four lines (credit, wealth, insurance and the old cash-and-markets line) are moved onto these lines once, when Mynt starts. Old cash-and-markets products go by category: deposits to account_operations, bonds and money-market instruments to credit, derivatives to derivatives, and funds to wealth. REIT and InvIT units go to securitization. Published products stay published, and their test reports are re-run so they match the migrated data.

`list_products` filters by `product_line`, `category`, `region` (`IN`, `US`, `global`), `risk_level` or free text, and `list_categories` returns counts for each.

Each product has: `id`, `name`, `product_line`, `category`, `region`, `risk_level`, `liquidity`, `typical_horizon`, `return_type`, `regulator`, `description`, `key_features`.

## Innovator workflow: create → test → publish

1. `create_product` saves a **draft**, visible only to its creator.
2. `test_product` runs the checks: required disclosures (description, regulator, at least 2 features), valid enums, product-line rules (credit uses `cost_of_credit` and risk `not_applicable`; insurance uses protection, guaranteed or market-linked returns), and a **misleading-claims** check that fails market-linked products promising "guaranteed", "assured" or "risk-free" returns.
3. `publish_product` lists it in the catalog. It is allowed only if the latest test passed **and** the product hasn't changed since. Editing a product means re-testing it.
4. `unpublish_product` hides it again. Existing enrollments are kept, new ones are blocked, and developers' apps flag it under `unavailable_product_ids`.

Bundled catalog products are read-only and pass the same checks.

## Install & build

You need Node.js 22.13+ and a Postgres database. [Supabase](https://supabase.com) (self-hosted or cloud) is the intended backend; any Postgres 15+ works.

```bash
git clone https://github.com/never2average/mynt.git
cd mynt
npm install
npm run build
```

## Users and tokens

Users, roles, products, enrollments and apps live in Postgres (Supabase), in a dedicated `financial_products` schema. Supabase's auto-generated REST API exposes only `public`, so none of this data is reachable through it. Set `DATABASE_URL` to the connection string; the schema is created on first start. If the schema already exists and is owned by the app's role (as the deploy script sets it up), the role needs no database-level privileges.

Create users with the CLI. Each command prints a token once; only its hash is stored.

```bash
export DATABASE_URL=postgres://user:password@host:5432/postgres
node dist/index.js users add --name "Asha" --role consumer
node dist/index.js users add --name "Dev"  --role developer
node dist/index.js users add --name "Ines" --role innovator
node dist/index.js users add --name "Max"  --role consumer --role innovator   # several roles
node dist/index.js users list
```

## Run it

### Locally over stdio (one user per client)

Pass the user's token in `FINANCIAL_PRODUCTS_TOKEN`. Without it, the server runs as a read-only guest.

Claude Code:

```bash
claude mcp add mynt -e DATABASE_URL=postgres://... -e FINANCIAL_PRODUCTS_TOKEN=fpm_... -- node /absolute/path/to/mynt/dist/index.js
```

Claude Desktop / other clients:

```json
{
  "mcpServers": {
    "mynt": {
      "command": "node",
      "args": ["/absolute/path/to/mynt/dist/index.js"],
      "env": { "DATABASE_URL": "postgres://...", "FINANCIAL_PRODUCTS_TOKEN": "fpm_..." }
    }
  }
}
```

Or run straight from GitHub: `npx -y github:never2average/mynt`.

### Shared server over HTTP (many users)

```bash
node dist/index.js serve-http --port 3000 --host 0.0.0.0
```

Clients connect to `http://host:3000/mcp` (Streamable HTTP) with `Authorization: Bearer fpm_...`. Requests without a token are served as a guest, and invalid tokens get `401`. Put it behind TLS (e.g. Caddy or nginx) before exposing it publicly.

Set `MYNT_PSEUDONYM_SECRET` to a long random string (e.g. `openssl rand -hex 32`) so innovators can see product requests: each requester appears to each innovator under a pseudonym keyed with it. Without it, `list_product_requests` refuses to list anything.

```bash
claude mcp add --transport http mynt https://your-host/mcp --header "Authorization: Bearer fpm_..."
```

## Whitelist sign-in with Clerk

Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and `PUBLIC_URL` (e.g. `https://mcp.example.com`) and the HTTP server accepts only whitelisted people signed in with [Clerk](https://clerk.com):

- The server is an OAuth-protected resource with Clerk as its authorization server. MCP clients (Claude, Claude Code and others) discover this from `/.well-known/oauth-protected-resource/mcp`, register themselves with Clerk and open Clerk's sign-in page.
- Each request's Clerk access token is verified, and must be issued for this server's `/mcp` resource. The caller's **verified** email must be on the whitelist. The whitelist entry also decides the caller's roles, and removing it cuts them off on their next request.
- Local `fpm_` tokens and guests are refused over HTTP. They still work over stdio.

```bash
node dist/index.js clerk setup                                          # once: allowlist, client registration, PKCE, audience claims
node dist/index.js users invite --email ines@example.com --role innovator
node dist/index.js users invite --email asha@example.com --role consumer --role developer
node dist/index.js users revoke --email asha@example.com
node dist/index.js users list
```

`users invite` and `users revoke` also update Clerk's allowlist, so people who aren't invited can't sign up at all.

**Public sign-up.** An admin can open sign-up with `set_public_signup` (`enabled: true`). It works like this:
- Anyone who signs in with a **verified** email then joins as a **consumer**. Mynt writes a consumer invite for them, so they show in `list_whitelist` and can be revoked like anyone else.
- Higher roles still come only from `invite_user`.
- `revoke_user` also blocks the email from signing up again, until an admin invites it once more.
- Turning it on turns Clerk's allowlist off, and turning it off turns the allowlist back on. Both are best effort; Mynt's invites decide access either way.
- Closing sign-up stops new people joining. People already in keep their invites.
- `clerk setup` follows the setting.

Connect a client with just the URL; it will open Clerk's sign-in page:

```bash
claude mcp add --transport http mynt https://mcp.example.com/mcp
```

## Deploying to a VM with self-hosted Supabase

[`deploy/setup-vm.sh`](../deploy/setup-vm.sh) sets up an Ubuntu VM end to end and is safe to re-run for updates:

```bash
# as root on the VM, with the domain's A record pointing at it
curl -fsSL https://raw.githubusercontent.com/never2average/mynt/main/deploy/setup-vm.sh -o setup-vm.sh
bash setup-vm.sh mcp.example.com [git-ref]
```

What it does:

- Installs Docker and opens only SSH, 80 and 443 in `ufw`.
- Runs Supabase's official Docker stack in `/opt/supabase` with freshly generated secrets. Studio, the API gateway and the pooler are bound to localhost; reach Studio with `ssh -L 8000:127.0.0.1:8000 root@<vm>`.
- Creates a least-privilege Postgres role `financial_products_app` that owns only the `financial_products` schema.
- Builds the MCP image and runs it with Caddy, which gets the TLS certificate automatically, serving `https://<domain>/mcp`.

Create users on the VM:

```bash
docker compose -f /opt/mynt/src/deploy/docker-compose.yml exec mcp \
  node dist/index.js users add --name "Ines" --role innovator
```

### Backups

On a host installed with [`deploy/host/install-host.sh`](../deploy/host/install-host.sh), Supabase is backed up every night and a backup is test-restored every week. The installer sets this up on every deploy; there's nothing to switch on.

- **What:** every database and role in Supabase's Postgres (`pg_dumpall`, so Mynt's `financial_products` schema, sign-ins and Storage's records all come along), plus Storage's files (`volumes/storage` in the Supabase directory).
- **When:** daily around 02:30 UTC (`mynt-backup.timer`); a restore test on Sundays around 04:30 UTC (`mynt-backup-verify.timer`), which restores the newest backup into a throwaway `postgres:17` container with no network, counts the tables in `financial_products`, `auth`, `storage` and `public`, and removes the container.
- **Where:** `/var/backups/mynt/<time>/` on the server, readable by root only, kept 7 days. Off-site, if you set it up: encrypted copies in your own bucket, 14 daily and 8 weekly (Sunday's). Nothing leaves the server unencrypted; without an encryption key the backups stay on the server.
- **Checking:** `ops_status` has a `backups` section and says when something needs attention: no backup in 26 hours, a failed run, a failed restore test, or "backups are on this server only; add an off-site bucket". The details are in `/var/log/mynt/backup.log`.

**Turning on off-site copies.** You need a bucket at any S3-compatible storage service (Cloudflare R2, Backblaze B2 and DigitalOcean Spaces all work) and an encryption key pair that you keep.

1. On your own computer (not the server), install [age](https://github.com/FiloSottile/age) and make a key pair:
   ```bash
   age-keygen -o mynt-backup-identity.txt
   ```
   It prints a public key starting `age1…`; that one goes on the server. The file `mynt-backup-identity.txt` is the only thing that can decrypt the backups: keep it in your password manager or another safe place, never on the server.
2. At your storage service, create a private bucket and an access key that can read, write and delete in that bucket only.
3. On the server, as root, open `/etc/mynt/backup.env` (the installer created it with these lines commented out; it is readable by root only and the installer never changes it once it exists) and fill it in:
   ```
   BACKUP_AGE_RECIPIENT=age1…your public key…
   BACKUP_REMOTE=myntbackup:your-bucket/mynt
   RCLONE_CONFIG_MYNTBACKUP_TYPE=s3
   RCLONE_CONFIG_MYNTBACKUP_PROVIDER=Cloudflare
   RCLONE_CONFIG_MYNTBACKUP_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
   RCLONE_CONFIG_MYNTBACKUP_ACCESS_KEY_ID=…
   RCLONE_CONFIG_MYNTBACKUP_SECRET_ACCESS_KEY=…
   ```
   For DigitalOcean Spaces use `PROVIDER=DigitalOcean` and `ENDPOINT=https://<region>.digitaloceanspaces.com`; for Backblaze B2 use `PROVIDER=Other` and `ENDPOINT=https://s3.<region>.backblazeb2.com`.
4. Run one backup now and check it: `systemctl start mynt-backup.service`, then `ops_status` should show `offsite: "uploaded"`.

**Restoring.** Try a test restore first; it never touches production:

```bash
bash /opt/mynt/current/deploy/host/restore.sh --test /var/backups/mynt/<time>
```

To use an off-site copy, download it on the server and copy your identity file over just for the restore:

```bash
set -a; . /etc/mynt/backup.env; set +a     # in a root shell: rclone reads the bucket settings from these
rclone --config /dev/null copy myntbackup:your-bucket/mynt/daily/<time> /root/restore-<time>
bash /opt/mynt/current/deploy/host/restore.sh --test /root/restore-<time> --identity /root/mynt-backup-identity.txt
```

To replace production with a backup, use `--yes-replace-production` instead of `--test`. It takes a safety backup of the current state first, stops Mynt and Supabase's other services, replaces every database and Storage's files (the old files are moved aside, not deleted), starts everything again and prints the table counts. Delete the identity file and the downloaded copy from the server afterwards (`shred -u /root/mynt-backup-identity.txt`).

Settings such as the Supabase directory (`SUPABASE_DIR`, default `/opt/supabase`) or Postgres container (`BACKUP_DB_CONTAINER`, default `supabase-db`) can be changed in the same file; they are listed at the top of [`deploy/host/backup.sh`](../deploy/host/backup.sh).

## Starting empty

A new deployment starts with no products, regions or categories: admins define regions, categories and the regulatory model, and innovators publish products. Mynt's reference catalogue (owner-less, read-only products open to every developer) is kept in the database; its products are composed of regulated primitives like any other (`admin_set_product_composition`, `get_product_regime`).

## Development

```bash
npm test   # builds, then tests roles, the innovator workflow, ownership and HTTP auth on in-process Postgres (PGlite)
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # also runs the CLI/stdio test against a real Postgres
```

## Disclaimer

Mynt ships no catalogue: every product comes from an innovator. Product information is for informational purposes, contains no live rates and is not financial advice; rules (tax treatment, limits, lock-ins) change, so verify with the relevant regulator or provider. Enrollments here are records in this server's database, not real accounts.

## License

MIT
