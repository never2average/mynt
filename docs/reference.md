# Mynt technical reference

Every tool, the runtime API, hosting, deployment and operations. For what Mynt is, see the [README](../README.md); for how the parts fit together, see [`architecture.md`](architecture.md).

Mynt knows five kinds of user, and each one sees only the tools its roles allow. **Innovator and developer are one role, the builder**: the two names are aliases (each implies the other), so whoever holds either composes and publishes products and builds apps on them. Builders needn't be licensed: a licence provider can sponsor a product under its licences.

| User type | Can | Tools (in addition to the catalog tools) |
| --- | --- | --- |
| **Consumer** | Use financial products, respond to offers and ask for products that don't exist yet | `enroll_in_product`, `list_my_enrollments`, `cancel_enrollment`, `list_offers`, `upgrade_enrollment`, `request_product`, `list_my_product_requests` (the last two for any signed-in user); and for any signed-in account, `list_firm_notices` and `block_firm_recovery` (see "Partner kit") |
| **Builder** (`innovator` or `developer`): apps | Build app experiences and run GTM engineering around financial products | Apps: `create_app`, `update_app`, `list_my_apps`, `preview_app`, `publish_app`. Stages (see [Workspaces](#workspaces)): `get_promotion_checks`, `promote_app`, `demote_app`, `set_app_target_states`, `request_promotion_signoff`, `get_workspace_attention`. Workspaces (see [Workspaces](#workspaces)): `list_workspaces`, `create_workspace`, `rename_workspace`, `list_workspace_members`, `invite_to_workspace`, `revoke_workspace_invite`, `change_member_role`, `remove_workspace_member`, `leave_workspace`, `relink_workspace_org`, `archive_workspace`, `unarchive_workspace`. GTM: `create_segment`, `list_my_segments`, `create_campaign`, `update_campaign`, `lint_campaign`, `launch_campaign`, `pause_campaign`, `end_campaign`, `list_my_campaigns`, `get_campaign_metrics`. Runtime: `create_api_key`, `list_api_keys`, `rotate_api_key`, `revoke_api_key`, `create_webhook`, `list_webhooks`, `delete_webhook`, `rotate_webhook_secret`, `list_webhook_deliveries`, `create_test_consumer`, `simulate_handoff`, `release_app`, `list_app_releases`, `rollback_app`, `get_app_metrics` |
| **Builder** (`innovator` or `developer`): products | Create, test, publish, version and upgrade financial products, covered by their own licences or a licence provider's sponsorship | `create_product`, `update_product`, `test_product`, `publish_product`, `unpublish_product`, `list_my_products`, `create_product_version`, `update_product_version`, `list_product_versions`, `diff_product_versions`, `restore_product_version`, `upgrade_enrollments`, `get_product_distribution_metrics`, `report_handoff_outcome`, `get_product_take_rate`. Product requests: `list_product_requests` (requesters appear only under a pseudonymous id), `respond_to_product_request` (offer one of your published products; audited). Sponsorship: `request_sponsorship`, `list_my_sponsorships` |
| **Licence provider** (`license_provider`) | Hold the licences (verified by admins) and sponsor builders' products under them: approve, decline or revoke sponsorship of a product's component under a held licence, in the jurisdictions it covers; a peer of builders. Its firm is added by hand by an admin | `list_my_licenses`, `list_sponsorship_requests`, `approve_sponsorship`, `decline_sponsorship`, `revoke_sponsorship`, `list_sponsored_products`, covenants (`set_covenant`, `list_covenants`, `delete_covenant`, `list_covenant_breaches`, `acknowledge_breach`, `release_covenant_pause`) and `create_firm_webhook`, `list_firm_webhooks`, `delete_firm_webhook` for their alerts, plus their firm's `get_my_entity`, `register_license`, `set_entity_facts`, `add_party` and `end_party` (its roster fills the stakeholders its licences mandate). See [Licence providers](#licence-providers-sponsoring-builders-products) |
| **Vendor** | Offer standard services (identity, KYC, account data, bureau, e-sign, e-mandate, the Mynt Ramp…) that builders plug into their products; a peer of builders, neither above nor below them | `list_service_types`, `create_vendor_offering`, `update_vendor_offering`, `run_conformance`, `list_my_offerings`, `list_my_subscribers`, `reveal_subscription_secret`, `rotate_subscription_secret`, plus their firm's `get_my_entity` and `register_license`. Innovators get `list_vendor_offerings`, `subscribe_vendor_service`, `list_my_vendor_subscriptions`, `set_subscription_live` and `unsubscribe_vendor_service`, and `create_firm_webhook`, `list_firm_webhooks` and `delete_firm_webhook` for their vendor services' results. See [Vendors](#vendors-standard-services-per-region) |
| **Admin** | Run Mynt itself: geographies, product types, the whitelist and oversight, all from inside Mynt | `define_region`, `define_product_category`, `list_whitelist`, `invite_user`, `revoke_user`, `recover_firm_member`, `list_all_campaigns`, `admin_pause_campaign`, `admin_set_product_status`, `define_take_rate`, `list_take_rates`, `recompute_product_derived`, `audit_log`; vendors: `define_service_type`, `load_service_types`, `suspend_vendor_offering`, `register_firm`, `set_mynt_ramp`, `set_ramp_adapter`, `link_ramp_partner_customer` (also the Mynt Ramp firm's); licence providers: `run_firm_checks` |

Everyone, including guests without a token, gets the catalog tools: `whoami`, `list_products`, `get_product`, `list_categories`, `list_regions`, `list_product_categories`, `list_apps`, plus the resource `mynt://catalog`.

### Administration

Admins own Mynt's reference data and its access list. **Every admin action lands in the audit log with the name of who did it.**
- **Geographies** (`define_region`) say where products may be offered. Each region records its regulators, its regulatory ecosystem (each regulator's remit, the key laws and bodies), the legal procedure for launching each product line there (licences, approvals, filings, timeline), and the official sources. Fields you leave out keep their values. Innovators read the full picture with `get_region`.
- **Regulated product types** (`define_regulated_product_type`, `list_regulated_product_types`) form, per region, a catalogue of the product types regulators supervise, kept apart from any single regulator. Each has a Mynt category, the actions that can be taken on it, and optionally its underlying and wrapper (see [Product lines, actions and primitives](#product-lines-actions-and-primitives)). Regulators map onto it **many to many**: one product type, such as a sovereign gold bond, can be supervised by several regulators, each for its own subset of actions. A product type can't be removed, or lose an action, while a regulator still supervises it.
- **The regulatory model** (`define_regulator`, `define_legislation`, `define_judgment`) records, per region, each regulator's **scope** (the regulated product types it supervises, by id, with the actions it covers; and the customer personas with their qualifications) and the **licence types** it grants. A licence **grants specific actions on specific product types** (a bare id grants everything its regulator supervises on it), so `find_licenses` returns only licences that genuinely permit the action. Persona and licence ids belong to one regulator: they must start with `<regulator id>_` and can't be reused by another regulator in the region. Each licence carries **GRC**: registers of obligations, reporting/disclosure filings, risks and controls; repositories of regulatory communications, enforcement actions, press releases, policies and risk models; the product types and customer segments it allows; mandatory internal and external stakeholders; and how to apply. **Legal** sits alongside in two branches. **Legislative** covers acts, ordinances, rules, regulations, master directions, circulars, guidelines, notifications and orders, each with its issuer, the instrument it's made under (`parent_id`), status and effective date. **Judiciary** covers court and tribunal decisions, each with court and level, bench, holding, the legislation it interprets, and whether it's still good law. Obligations and filings cite either kind by `legal_ref`. Broken links inside a regulator are refused; looser links come back as warnings. Innovators read all of it with `get_regulator` and `list_legal_instruments` (both branches, filterable), and ask `find_licenses` which licence covers a category, action and persona. `test_product` names the covering licence, or warns when there is none.
- <a id="coverage-per-state"></a>**Coverage per state.** Where a country licenses state by state (US money transmission and virtual-currency business), the model says where each licence counts, with ISO 3166-2 codes written lowercase like entities' incorporation (`us-ny`, `us-ca`; the country code `us` is the whole country). A state regulator carries `jurisdiction`, and its licence types cover only that state. A national regulator's licences cover the whole country. A licence type may set `covers` (a list of codes, or `["us"]`, e.g. for a federal charter that pre-empts state licensing for what it grants) with a `coverage_note` giving the basis. A type issued separately in many states sets `issued_per_jurisdiction: true`, and the firm registers one held licence per state (`register_license … jurisdiction`). A product lists where it's offered with `offered_in` (on its v2 definition, or on a component in `set_product_composition`): `["us-ny", "us-ca"]`, or `["us"]` for the whole country, which needs a licence covering all of it. Each component is then checked in each state. It's covered there when its provider (the firm itself, or a partner on its roster) holds a verified, in-force licence that grants it and covers that state, and publishing is blocked for every component × state with none (`publish_blockers` carry `jurisdiction`). Without `offered_in`, the country is checked as a whole, exactly as before, so regions without states are unchanged. A licence type may also `require` others: a held licence counts only when its holder also holds each prerequisite verified and in force (an entry may list several ids, any one of which will do), and the prerequisite is pinned with it. A licence type with `covers: []` covers nowhere by itself: the FinCEN money services business registration, which each state's money transmitter licence requires.
- <a id="base-products"></a>**Base products: money transmission first.** A product can be built on others instead of declaring what they already provide: a v2 definition lists them in `builds_on` (`product_id`, and optionally the components the base `funds` and those that `settles_from` back through it), and saving it sets the product's `underlying_product_ids`. The composed product inherits the base's coverage: in each state it's offered in, every base must be published, not drifted, and covered there, or publishing is blocked there with a `builds_on:<product id>` blocker naming the base's reason. Its live version pins each base, so it drifts when a base drifts (naming the base's states), is offered somewhere else, or is unpublished. The first base product is US money transmission ([`core/schemas/examples/us/money-transmission.v2.json`](../core/schemas/examples/us/money-transmission.v2.json)), owned by the licensed ramp partner's firm and offered in the states it holds a money transmitter licence in; dollar products such as [`dollar-account.v2.json`](../core/schemas/examples/us/dollar-account.v2.json) are built on it.
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
- <a id="remove-app"></a>**Removing a test or demo app** (`remove_app`). It removes an app that never went live, with everything that references it. By default it's a dry run (`confirm: false`): it lists how many rows each table would lose, the app's programs (and which will be closed on chain) and its builds, and deletes nothing. `confirm: true` does it.
  - **Refused when** the app is published; it is hosted on Mynt (`undeploy_app` first); a build of it is still running or has a reopened sandbox open (`stop_build`, `close_sandbox`); it has live customer data (any non-sandbox row in `client_sessions`, `client_evidence`, `customer_vault`, `handoffs`, `app_events`, `ramp_link_requests`, `vendor_action_runs` or its webhooks' `webhook_deliveries`, or any row in `customer_verified_states` or `customer_state_erasures`) or live money movements; or it has any mainnet program, even one only reserved. It is also refused, naming the table, when a table can't be cleaned safely: `customer_state_history` is append-only; liquidity pools' records (`pool_movements`, `pool_flags`, `pool_movement_states`) or ramp partners' links name its money movements or link requests; a mainnet review, another program or another hosted app uses one of its programs or builds; or any other table names the app or points at a row that would go, which covers tables added later.
  - **Order.** Each deployed devnet program is closed on chain first (see `close_program` under [Solana programs](#solana-programs-developers)). If a close fails, nothing is deleted, the stop is written to the audit log, and the answer says why. `proceed_without_closing: true` removes the app anyway and leaves that program on devnet, which the audit entry records. Then, in one transaction with the app's row locked and every check run again, it deletes from these tables in this order: `webhook_deliveries`, `webhooks`, `vendor_action_runs`, `ramp_link_requests`, `money_movements` (sandbox only), `client_evidence`, `handoffs`, `client_sessions`, `api_keys`, `app_events`, `customer_vault`, `test_consumers`, `app_journeys`, `app_releases`, `requests` (access requests), `hosting_commands`, `solana_program_events`, `solana_program_versions`, `solana_program_flags`, `solana_keys` (each program's own keys: its reserved keypair, a leftover deploy buffer's), `solana_programs`, `solana_program_sources`, `solana_program_deps` and `solana_program_depinfo` (only what no other build's artifact still uses), `solana_program_artifacts`, `build_events`, `agent_spend` (the builds' model spend), `build_runs`, `apps`.
  - **The audit log is never deleted from.** The removal adds one entry: the app, each table's count, the ids of the app, its builds, programs, API keys, webhooks and releases, and what was closed on chain.

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
- **Liquidity providers** are firms or funds, added by an admin, that put capital into products' pools and take it out, watching each product's health to decide where capital goes. They get their own tools and none of a builder's or a consumer's; an admin isn't one. See [Liquidity pools](#liquidity-pools).

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

**Service types (admins).** Like regulators, service types are defined per region (`define_service_type`, `list_service_types`). Each has a `key`, `region`, `name`, `category` (identity, kyc, account_data, analytics, credit_bureau, documents, esign, mandate, fraud, ramp, other), an `input_schema` and `output_schema` (JSON Schema: the one contract every vendor in that region implements), the `consent_purpose` the customer must give, the data dictionary fields its output `fills`, and the licence types, from the region's regulatory model, of which the **subscribing firm** (`innovator_licences`) and the **vendor** (`vendor_licences`) must each hold one. Required inputs are data dictionary fields, because Mynt sends them from the customer's vault. Examples ship as JSON in [`core/schemas/service-types/`](../core/schemas/service-types) (India: PAN verification, CKYC search and download, Account Aggregator data fetch, bank statement analytics, credit bureau report, DigiLocker documents, eSign, e-mandate; US: identity and SSN verification, bank account verification, credit bureau report, and the Mynt Ramp's `onramp_quote`, `onramp_transfer`, `offramp_quote` and `offramp_transfer`). `load_service_types` loads them; an example naming a licence type your regulatory model calls something else is skipped with the reason until you pass `licence_map`.

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

**Declaring what moves money.** Every service type sets `moves_money`; `true` when it instructs a money movement, which sends it through approved money rails (see "Approved money rails"). `ops_status` reports a stored type whose name says it moves money but which is declared `false`. A service type can't fill `residence_state`; a partner-verified state comes as `residential_state` in an identity service's output (see "Partner requirements"). A ramp offering's `test_base_url` and `live_base_url` must be different endpoints, however they're written.

**The Mynt Ramp.** All dollars in and out of digital-asset liquidity go through one ramp. Its service types have the category `ramp`, and only the firm an admin designates with `set_mynt_ramp` (audited) may offer or list them: today the licensed ramp partner, which holds funds in transit and transmits money under its own licences (Mynt never holds funds or keys). Mynt calls only that firm's ramp offerings, in sandbox and live, so re-designating the ramp stops calls to the old firm's at once. Innovators subscribe to the ramp and bind handoffs to it like any vendor service. The shipped US types come in two pairs, each with its own consent purpose: **add dollars** (`onramp_quote`, accepted by `onramp_transfer`, consent `fiat_onramp`) and **cash out** (`offramp_quote`, accepted by `offramp_transfer`, consent `fiat_offramp`). A quote takes params `direction` (`in` or `out`) and `amount_usd`, and the customer's name and bank account from the vault; the device is shown `amount_usd`, `fee_usd`, `total_usd` (in: added to the balance; out: taken from it), `currency` (`USD`), `estimated_arrival` and `expires_at`. A transfer usually answers pending until the bank transfer settles (`submitted`, then `settled`, `failed` or `returned`); when the customer pushes the payment, an add-dollars transfer also shows the US bank account to pay (`pay_to_bank_name`, `pay_to_account_number`, `pay_to_routing_number`, `pay_to_reference`). The settlement leg (`settlement_asset` USDC, `settlement_network` solana, `settlement_amount`, `settlement_ref`, `settlement_tx`) is in the output, sealed to the innovator, and never reaches a device. All four name the licence type `fincen_msb`; map it to yours with `licence_map`.

**Dollars only for customers.** A developer's customers never see or touch crypto: every customer-facing value is a US dollar amount, a fee, a total, a status, an arrival time or a reference. Mynt enforces it in code (`core/src/dollars-only.ts`): `define_service_type` refuses a `client_result` field or a `params_schema` property whose name carries a crypto concept (asset, chain, network, wallet, address, tx, hash, token, coin, memo, a token symbol or chain name) or whose enum, const or default is a token symbol or chain name, a ramp currency field that isn't `USD`, and a name that names one (it reaches devices in error messages). Publishing refuses a binding to a service type stored before the rule; the developer contract drops such fields; and the device's outcome drops any field, or any value that looks like a token, a chain, an address or a transaction hash, whatever the service type says. Keep the settlement asset in the output, where it goes sealed to the innovator.

**How the ramp partner plugs in.** Either way, Mynt's quote → accept, conformance, callbacks and the dollars-only rule are the same:
1. **The wire contract.** The partner serves Mynt's vendor wire contract (below) at its offerings' base URLs.
2. **An adapter in front of its own API** (`core/src/ramp-adapters/`). The ramp firm (or an admin) runs `set_ramp_adapter { offering_id, adapter, config, test_credential, live_credential }` on each ramp offering. Its base URLs are then the partner's API; the credentials go sealed into the ramp firm's key vault (key types `ramp_partner_test_credential`, `ramp_partner_live_credential`) and are never shown, logged or put in the audit log. Mynt answers its own signed requests in-process: the adapter (a small typed interface: `probe`, `price`, `transfer`, `status`, `webhook`) translates each to the partner's API and the partner's states and webhooks back to Mynt's. Partner webhooks go to `<PUBLIC_URL>/v1/ramp-adapters/<offering_id>/webhook/<test|live>`, verified with the partner's own scheme; transfers whose webhook hasn't come are read back every minute. Conformance probes the partner with the credential and moves no money. Test and live stay apart: a URL or key that looks like the partner's other environment (by its documented hosts and key prefixes) is refused, and conformance probes both credentials when both are set.

**Linking a customer to the partner.** The customer starts it, from their own session and after giving the ramp's consent there: `POST /v1/client/ramp_links { product_id }` answers a `link_reference`, and the ramp firm gets `ramp_link.requested` with only that reference, never the developer's customer reference. Once the partner has onboarded the customer, the ramp firm completes it with `link_ramp_partner_customer { link_reference, partner_customer_id, partner_payout_account_id }`: Mynt reads the partner's identity for that customer through the adapter and links only if the name matches what the customer gave Mynt (compared in any script, after Unicode normalisation; an empty name never matches) and, in live, the date of birth too (in test, when both have one); the payout account must be that partner customer's own; and one partner customer is linked to one Mynt customer only. Otherwise the request is refused. A session may ask five times an hour (a customer ten a day), and a request expires after seven days (`RAMP_LINK_EXPIRY_HOURS`). Transfers and payouts use only a verified link, filed under a pseudonymous key.

**A transfer's life.** Statuses only move forward: `submitted` → `settled`, `failed` or `returned`; an earlier state arriving late is ignored, and each partner event is applied once (by its event id). An add-dollars transfer waits for the customer's payment for business days, not the 24 hours other vendor actions get (`pending_business_days`, default 7, or `RAMP_ADAPTER_PENDING_BUSINESS_DAYS`). Past that, Mynt voids it at the partner when the partner can, and the run fails; `pay_to_status` (`active` while the account can be paid into) becomes `void` when the partner confirmed the void and `unknown` when it couldn't, and either way the app tells the customer not to pay into that account; a transfer the partner won't void (its money is already moving) keeps waiting, up to 30 business days. Money that settles after the run ended is never dropped: it's kept sealed on the run and the innovator gets `vendor_action.late_settlement` to handle by hand. A settled transfer the bank later sends back (returned or refunded) is the one change after the end: the run becomes `reversed`, the device sees `failed` with `reversed: true`, the innovator gets `vendor_action.reversed` (sealed details) and the app a data-free `handoff.reversed`. A transfer's amounts are what the partner reports, never an assumed 1:1: `total_usd` means what it means in that leg's quote (in: added to the balance; out: what the customer is charged, amount plus fees), and a cash-out's `paid_out_usd` is what reached the bank. A run ends before its transfer's record moves on, so a failure part-way is finished by the partner's retry or the poller, never lost.

**The Bridge adapter** (`adapter: "bridge"`, [apidocs.bridge.xyz](https://apidocs.bridge.xyz)) is the reference: base URLs `https://api.sandbox.bridge.xyz` and `https://api.bridge.xyz`, `Api-Key` auth, `Idempotency-Key` on every transfer (one per quote, so a retry never moves money twice). Bridge has no quote that locks a price, so Mynt issues it: the fee (`fee_percent`, default 0.5, at least `fee_min_usd`, default 0.50) is charged as Bridge's `developer_fee`, and Mynt sets the validity (`quote_seconds`, default 60). Add dollars is `POST /v0/transfers` from `ach_push` USD to USDC on `solana` at the ramp's `settlement_address`, and the customer is shown Bridge's deposit account and deposit message; cash out is USDC on `solana` from that address to `ach` USD at the customer's payout account. Bridge's states map to Mynt's: `payment_processed` is `settled`; `returned`, `refund_in_flight` and `refunded` are `returned`; `undeliverable`, `canceled` and `refund_failed` are `failed`; the rest stay `submitted`. Webhooks are verified with the endpoint's public key (`test_webhook_public_key`, `live_webhook_public_key`: `X-Webhook-Signature`, at most 10 minutes old). An unpaid add-dollars transfer is voided with `DELETE /v0/transfers/{id}` (Bridge cancels only while `awaiting_funds`); a customer's identity is read with `GET /v0/customers/{id}`. Each transfer is between `min_usd` (default 1.00) and `max_usd` (default 10000.00). **Cash-out through Bridge isn't built yet:** it needs the USDC leg from the ramp's settlement address into Bridge, so `offramp_quote` and `offramp_transfer` are refused on a Bridge offering, always in live; `test_offramp: "true"` lets them run in the test environment only.

**The Mynt Ramp sandbox.** Mynt serves a test ramp itself at `<PUBLIC_URL>/ramp-sandbox` (`core/src/ramp-sandbox.ts`), so apps can be built and tested on both ramps before the partner's live endpoint exists: the ramp firm sets its offerings' `test_base_url` to it (`set_mynt_ramp` shows the address) and its `live_base_url` to the partner's. It speaks the same wire contract, answers only requests Mynt signed for a ramp offering pointed at it, refuses live requests, and never moves money. Prices are in dollars with a 0.5% fee (at least $0.50); the settlement leg is 1:1. Transfers settle a few seconds later (`RAMP_SANDBOX_SETTLE_MS`, default 3000) through Mynt's own signed callback; an amount ending in `.13` comes back `returned` and one ending in `.66` `failed`.

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

A developer can have Mynt **build and ship** one of their experiences. `start_build` runs a coding agent in a fresh sandbox (boat.dev by default, or Freestyle; see below). The sandbox only provides the machine: Mynt installs a pinned Claude Code there and runs it headless with a dollar budget (`--max-budget-usd`, from the build's cap). The agent reaches the model only through Mynt's agent proxy (`/agent`), using a token that works only while its build runs. Mynt calls Claude on Google Cloud Vertex AI with its own service account, or the Anthropic API with its own key, so no credentials ever enter a sandbox. Developers follow the agent's activity live and can steer it: Mynt interrupts the current turn and sends their message as the next one. The agent writes the code against the app's products and their build terms, using a freshly generated SDK and a Mynt **sandbox key** (simulated hand-offs) for end-to-end tests. It reviews its own code for security issues and fixes them, starts a preview, and pushes a branch. The [Maxwell](https://github.com/OnFinance/Maxwell) security audit runs once, in Mynt's independent verification below, never in the agent's sandbox.

**What the agent builds is a whole app, not just a server:** one Docker Compose project with `api/` (holds the app key, mints client sessions, handles webhooks), `web/` and `mobile/` (Expo React Native by default; Kotlin, Swift or Flutter on request), started from `core/workspaces/coding-build/templates/mynt-app/` with the build's generated SDKs wired in. The lead agent works with a team of subagents in `core/workspaces/coding-build/.claude/agents/` (architect, server, web and mobile engineers, a read-only compliance reviewer, QA and release). Their skills are human-written skills found on GitHub by HyDE search (Mynt's own drafts used as the queries) and vendored with their upstream licence and source, plus a short Mynt layer.

**Agent sandboxes on Freestyle.** Builds, the product desk, governance review and the connector run in boat.dev sandboxes by default. With `SANDBOX_PROVIDER=freestyle` (and `FREESTYLE_API_KEY`), the same agents run in Freestyle VMs instead (`core/src/sandbox-providers/freestyle.ts`, behind the `SandboxHost` interface in `core/src/sandbox-host.ts`):
- each sandbox is a VM with the agents' own `user` account and the sandbox env in a 0600 file;
- previews and source downloads are served at unguessable `style.dev` names, so the link is the credential, as with boat.dev's token-gated links;
- stopping a sandbox deletes the VM;
- machine spend counts toward the caps at `FREESTYLE_USD_PER_HOUR`.

**The developer works in the same box.** While a build runs, and after it ships for as long as its preview is up, `open_sandbox_editor` opens VS Code in the browser on the sandbox (a private, token-gated link plus a password), with a terminal next to the agents. `sandbox_run`, `sandbox_files` and `sandbox_diff` do the same from any MCP client. Output is capped and scrubbed of credentials, and everything the developer does is on the build's timeline. After a build ends, `reopen_sandbox` brings back a fresh sandbox on its pushed branch (with the coding team's workspace and a short-lived GitHub token to push with) for a few hours, so the same tools keep working; `close_sandbox` ends it.

**Live preview while the agents code.** Once the agents' install has finished and the SDK is built, Mynt itself starts the app's dev servers with `core/workspaces/coding-build/scripts/dev_preview.sh`:
- Vite (`npm run dev` in `web/`) on 127.0.0.1:5173, with hot reload;
- the api (`npm run dev` in `api/`, the template's `tsx watch` from the app's own dev dependencies) on port 3000, on the build's sandbox key.

"Finished" means the package manager's own record is in `node_modules` and no install is running:
- the record is npm's `.package-lock.json`, pnpm's `.modules.yaml`, or yarn's `.yarn-integrity` or `.yarn-state.yml`;
- a running install is a process whose command line starts with `npm`, `pnpm` or `yarn` followed by `install`, `i`, `ci` or `add`.

The script never installs anything itself, so it never races the agents. How the link works:
- Once Vite answers with any HTTP response, Mynt serves port 5173 at a private link, `live_preview_url` on `get_build`, shown while the build is `coding`. On boat.dev the link forwards to the sandbox's 127.0.0.1 (`localhost: true`), as the editor's does.
- The link is a credential: it's never written to the timeline, and admins' listing leaves it out.
- While waiting for the install, Mynt retries every tick. Once the preview is up, while its dev server is up but not answering yet, or while the app has no `web/` yet, it retries every 6th tick. A retry also restarts a dev server that died, behind the same link.
- The script bounds its own waits by the clock (about 27 seconds at most, even when a server accepts connections but never answers), well under the 45 seconds Mynt gives it.
- The preview never fails a build.

When coding ends, Mynt stops both dev servers before it packages the source, and dependencies at any depth (`node_modules`) stay out of the package. The template's `web/vite.config.ts` accepts the forwarder's host name, sends hot reload over port 443 and keeps Vite's cache outside the app, but only when the script starts it (`MYNT_LIVE_PREVIEW=1`); a developer's own `npm run dev` keeps Vite's localhost-only defaults. After the build ships, `preview_url` is the verified Compose preview.

**The agent doesn't grade its own work.** When it finishes, Mynt verifies the build itself, in a **fresh sandbox the agent never touched**, with no secrets:
1. **Package.** Mynt packages the workspace source (without dependencies), records its SHA-256, and the verifier downloads it and checks the checksum.
2. **Mynt's own checks** (`core/src/verify-script.ts`): tests; lint and types; a secrets scan with `gitleaks`; a dependency audit; a CycloneDX SBOM with `syft`; and every required disclosure present in the source. `gitleaks` and `syft` are pinned versions, checked against their releases' published checksums.
3. **Independent audit.** A separate, audit-only Claude Code run executes the Maxwell static workflows. Mynt then re-hashes the source tree to prove the audit changed nothing.
4. **Decision**, from Mynt's results only. The agent's own report is kept, as advice:
   - the source changed during the audit, no audit, or **critical or high** findings → `blocked`
   - a failing check → `failed`
   - with a repository, the pushed branch must be exactly the verified source, or the build is `blocked`
5. **Ship.** On success, Mynt exposes the token-gated **preview** and **opens the pull request itself**, through its GitHub App, with the verified results in the description. The agent never opens PRs.

**Tracking.** Developers follow builds with `get_build` (phase, timeline, cost against the cap, Maxwell summary, readiness, links), see the agent's activity with `get_build_activity`, `steer_build` it, or `stop_build` it. `list_builds` shows this month's spend, optionally for one app (`app_id`). Admins see every build and total spend with `list_all_builds`.

**Activity.** As a build runs, Mynt reads the agent's output from the sandbox on every tick and stores it, summarised, in `build_activity`: the agent's messages, the commands it runs and the files it edits, each with a `seq` and a time. The history stays after the sandbox stops, and each build keeps its latest 5,000 entries. `get_build_activity` without `after` returns the latest entries, newest first. To follow a build, pass the `cursor` from the last call as `after`: the result holds only newer entries, oldest first, and a new `cursor`, which stays the same while nothing new has arrived. `first_seq` is the oldest entry still kept: a follower whose cursor is below it has missed entries trimmed by the limit. Summaries are scrubbed of credentials (as `sandbox_run` output is) before they're cut to length, and control characters are dropped. Activity is the agent's own account, shown to the developer and never used to decide anything.

**Session builds.** `start_build` with `mode: "session"` works like a chat with the coding agent:
- The agent does the first request (`goal`), reports `coding` "Waiting for your next message", and stays open, keeping its context.
- Each `steer_build` message is the next request. Sent while a request is still running, it interrupts that request and becomes the next one.
- `finish_build` ends the session. Once its current request is done, the agent reviews, checks, previews and pushes the work, then exits. Mynt then verifies the build in a clean sandbox exactly as any other; the agent never grades its own work.
- Finishing never interrupts the current request, and once a session is finishing it takes no more steers. A message that slips in as it starts finishing isn't delivered, and the build's timeline says so.
- A session that has been idle (nothing running, nothing waiting) for `BUILD_SESSION_IDLE_MS` (default 15 minutes; from 1 minute to 24 hours) finishes the same way, so its work is shipped, not lost.
- Mynt also finishes a session itself, so neither the time limit nor the cap ends it with the work unshipped:
  - 30 minutes before its sandbox's time limit (`BUILD_SANDBOX_TTL_SECONDS`, default 4 hours, counted from when Mynt asked for the sandbox);
  - once it has spent 70% of its cap, or earlier on a small cap, so that at least US$2 is left for the finish turn. That US$2 is an estimate of one finish turn, not a measured figure. A session build therefore needs a cap above US$2; `start_build` refuses a smaller one.
- A finish is recorded first and then put in the agent's inbox. If the sandbox can't be reached at that moment, the finish still stands and Mynt delivers it on its next ticks.
- `steer_build`'s `steered: true` means Mynt queued the message, not that the agent read it. A message held back because the session was finishing shows on the timeline as not delivered.
- The sandbox is billed while it waits, so idle time counts against the build's cap.
- Mynt runs the agent's runner with `MYNT_AGENT_HOLD=1` and `MYNT_AGENT_IDLE_MS`, and writes its inbox items whole (a temporary name, then a rename).

**Continuing a build.** `start_build` with `continue_from: <build_id>` starts from the branch an earlier finished build of yours pushed, on the same app and repository. Mynt must have confirmed that push: the build has a verified commit, or Mynt opened its pull request. If it shipped, it starts at its verified commit. Use it after a session ends, or to change a shipped app.

**Spend** is capped per build (`BUILD_CAP_USD`, default 10) and per developer per month (`BUILD_MONTHLY_CAP_USD`, default 100). A workspace can have its own monthly budget too, shared by everyone building its apps (`BUILD_WORKSPACE_MONTHLY_CAP_USD`, unset by default: no workspace budget); a build must fit both. Mynt reads the sandbox's machine and model cost as it runs, and stops a build that passes its cap.

**Repositories.** Developers install the Mynt GitHub App on a repository and run `connect_repository`. Each build gets an installation token limited to that one repository, with contents and pull-request write access for an hour. No long-lived credential enters the sandbox.

**Who may connect a repository.** The App being installed on a repository only says Mynt can reach it, not that the person asking may use it. So a connection is approved only when the person can push to it, checked with GitHub, or when an admin approves it (`core/src/repo-ownership.ts`, `core/src/repo-approvals.ts`).
- **Checked with GitHub.** On `connect_repository`, Mynt takes the GitHub account linked to the developer's sign-in, verified, as the identity provider reports it to Mynt's server (`get_linked_accounts`; never anything the client sends, and no GitHub sign-in of Mynt's own). It finds that account's current login from its stable GitHub id, then asks GitHub, through the App installation covering the repository, for that login's permission there (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`). `admin`, `maintain` or `write` approves the connection at once (audited as `auto_approve_repository_connection`) and records the repository's stable id.
- **Pinned by id.** The repository is read before and after the permission check. If another repository answers to the name meanwhile (a rename or transfer), or the name now leads to a different full name, or it isn't the repository recorded for an earlier connection of theirs, it isn't approved on its name: an earlier approval of theirs goes back to an admin too.
- **Otherwise an admin decides, and the developer is told why** (`why`): no verified GitHub account linked to their sign-in (with `manage_url`, where to link one), an account that can't push (its permission), or GitHub unreachable or erring.
- **An admin's rejection stays.** Reconnecting, any number of times, leaves a rejected connection rejected whatever GitHub says; only an admin lifts it (by approving it). An admin rejecting while GitHub is being asked wins.
- **Checked again before builds use it.** A connection approved on the developer's own push permission is checked with GitHub again before Mynt gives out a token for it (a build starting, a sandbox pushing, the pull request a verified build opens), once GitHub's last answer is over 10 minutes old; withdrawn by then, the build opens no pull request and its verified work stays on its branch. If they can't push any more, their account is no longer linked, or the name leads to a different repository, it goes back to an admin (audited as `repository_access_withdrawn`). If GitHub, or the identity provider that says which GitHub account is theirs, can't be reached then, the approval stands: an answer that recently said yes isn't overturned by an outage, so builds don't stop when GitHub has a bad minute (the next check after it recovers decides). Connections an admin approved, and Mynt's managed repositories, aren't re-checked.
- **Asked sparingly.** Reconnecting an approved connection through the same installation within 10 minutes of GitHub's last answer asks nothing; one check reuses one short-lived token; and each developer may run 10 checks a minute (`connect_repository` says when to try again).
- **What waits for approval.** A developer's `connect_repository` (per developer and repository), and a firm's desk workspace (`connect_desk_repository`, per firm and repository), start `pending_approval`. Approving one never covers another developer's or firm's connection to the same repository. `set_app_repository` uses the developer's connection, so it needs that connection approved too.
- **Exempt.** Mynt's managed repositories (each app's own) are approved as Mynt creates them.
- **Refused until approved**, with "Waiting for an admin to approve access to `<repo>`" (or "An admin rejected access to `<repo>`"):
  - `start_build` with a repository, `continue_from` and `reopen_sandbox`;
  - the build worker, right before the push token, and again before Mynt opens a build's pull request;
  - desk jobs, explorations and their adoption. A desk job is pinned to the workspace repository it started on: if the firm reconnects its workspace to another repository mid-job, the job fails, even when that one is approved too;
  - `deploy_app`, and hosting's source fetch.
- **Admins** use `list_repository_requests` (pending by default). Each request shows who asked, their firm, the repository, the installation id, and the account the App's installation is on (login, and user or organization). They decide with `approve_repository_connection` (with a note) or `reject_repository_connection` (with a reason).
  - Each decision names the request exactly as listed: its id, repository and installation id. A connection that changed in between (a firm reconnecting its workspace keeps the same id) gets no decision.
  - Approving needs the request still pending. Rejecting also withdraws an earlier approval.
- **Notices and audit.** Every decision is audited, and the person who asked sees it with `repository_access_notices`.
- **Reconnecting.** An approval is kept only when the same repository (same id) is connected again through the same installation. A new repository, a reinstalled App (a new installation), or a request still pending is a new request, checked with GitHub again; a rejected one stays rejected. An admin's approval doesn't expire; one GitHub gave is checked again as above.
- **Existing connections.** Those made before this check became `pending_approval` (fail closed). Builds without a repository, and Mynt's managed repositories, keep working.
- **Operational impact, right after deploying.**
  - Every existing developer connection and desk workspace needs an admin's approval before its next build, desk job or exploration.
  - Apps hosted from those repositories lose their source token, so they can't be redeployed or rebuilt on the VM, until their connection is approved.
  - Builds and desk jobs already queued fail at their next step if their connection isn't approved by then.
  - Plan to go through `list_repository_requests` straight after the deploy.

**Managed repositories (the default).** A developer needs no repository of their own. When a build names no `repository`, its app's builds push to the app's repository:
- **Created by Mynt.** On the app's first build, Mynt creates a private repository on its git host (`core/src/git-host.ts`), named by the app's id only (`mynt-app-<app_id>`), with a first commit so pull requests have a base.
- **Works like a connected repository.** Builds push their branch there, Mynt opens the verified pull request there, `deploy_app` fetches the verified commit from it, and `continue_from` carries on in it.
- **Reachable only through its app.** One guard covers every path that connects a repository by name: `connect_repository`, `set_app_repository`, a firm's desk workspace (`connect_desk_repository`, and so the desk's explorations), and a build naming a repository. It refuses any managed repository, except the caller's own app's in a build of that app.
  - A repository counts as managed if it's in the managed organization by name, or if Mynt ever created one under that name. Mynt keeps every name it creates in `managed_repository_names`: the name only, kept after the app is removed. That covers a name the host still redirects after the organization was renamed.
  - The check fails closed: a database error refuses the connection. Only a table that doesn't exist yet counts as "none recorded".
  - `list_repositories` marks a managed repository `managed`.
- **Cloning.** `get_app_repository` says where an app's code lives and, for a managed repository, gives a read-only token (one hour) to clone it.

`set_app_repository` switches an app's next builds to one of the developer's own connected repositories. It also switches back to the app's own managed repository: that's the only managed repository it accepts. It works whether or not managed repositories are on: with them off, it's how an app gets a default repository.
- Builds already made stay in the managed repository. `get_app_repository` still gives its clone credential, and `continue_from` on one of those builds says to push its branch to your own repository first.
- `remove_app` drops the app's repository record and the developer's access to its managed repository. The repository itself is left on the host.

Setup, on the host's side (the GitHub adapter, `GitHubRepoHost` in `core/src/github.ts`):
1. Create a GitHub organization for managed repositories.
2. Install Mynt's GitHub App on it for all repositories, with Administration (write) as well as contents and pull requests (write).
3. Set `BUILD_MANAGED_REPO_OWNER` to the organization's name.

Without `BUILD_MANAGED_REPO_OWNER`, builds without a repository work as before: a preview, and no push.

**Configuration:** `BOAT_API_KEY`, `PUBLIC_URL` and a model backend for the agent proxy (builds are disabled without them): either `GOOGLE_APPLICATION_CREDENTIALS` (a service account key file with Vertex AI User on a project where the Claude models are enabled; optional `VERTEX_PROJECT_ID`, `VERTEX_REGION`, default `global`) or `ANTHROPIC_API_KEY` (a dedicated key with a spend limit); `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` (pushing is disabled without them); optional `BUILD_AGENT_MODEL` (default `claude-opus-5-5`), `BUILD_SANDBOX_TYPE` and `BUILD_SANDBOX_TTL_SECONDS`.

### Solana programs (developers)

Some apps need a program on Solana (a smart contract) beside them. Developers, and innovators (who are developers too), build them with the coding agents and deploy them through Mynt (`core/src/solana/`). Programs are developer- and firm-side only: customers never see crypto, only dollars.

**1. Reserve the address.** `reserve_program_id` (`name`, `cluster`: `devnet` or `mainnet`, and the `app_id` or `product_id` it belongs to) gives the program its address before any code exists. Mynt generates the address's keypair and seals it in its vault (`MYNT_VAULT_KEY`); it is used once, at the first deploy, then deleted. The program declares the address in `declare_id!` and `Anchor.toml`, and Mynt deploys only a program that does.

**2. Build it.** `start_build` gives the coding agents the Solana toolchain (`solana: true`, on by default when the app has reserved programs) and the app's reserved addresses in the build spec. They scaffold an Anchor workspace in `solana/` from `core/workspaces/coding-build/templates/solana-program/` (a minimal ledger that emits an event per entry, with its tests) and test it with `anchor test` on a local validator. They never deploy anything.

**3. Mynt builds it again, itself.** Mynt never deploys the agent's artifact, and none of the developer's code runs on the verify machine before Mynt has the program.
- **Fetch.** Mynt fetches the source into its clean verify sandbox, checks its hash, and reads the answer itself: does the archive have an Anchor workspace?
- **Build, in a container only.** If it does, a run of its own (`verify.sh --solana-build`, with `solana-verify.sh build` from `core/src/solana/toolchain.ts`) compiles each program crate with `cargo build-sbf` inside Anchor's verifiable-build image, pinned by digest. This is the same command `anchor build --verifiable` runs there, so the program is reproducible. First, a throwaway container with a network fetches the crates. It gets only a skeleton of the source: the `Cargo.toml` files, `Cargo.lock` and empty stub files. No `.cargo/` config, no `rust-toolchain.toml`, no build script or code, and the compiler and every rustc wrapper are pinned by environment, so nothing of the developer's runs while there is a network. Then a fresh container, created with no network at all and no mount of the host, gets the full source as a copy plus the crate caches and lock from the fetch container (streamed container to container; the fetch container is removed before the build starts), and compiles offline as its own main process. When the build ends the container stops, so nothing the developer's build scripts, macros or wrappers left running can touch the program afterwards. Mynt pins the image's own Rust for cargo itself and resolves dependencies to versions the platform tools can build; a workspace's own cargo config applies only inside the offline build. The program comes out with `docker cp -L`, which resolves a link inside the container instead of copying it out as a link to a host path, and is kept only if it is a regular ELF file. Program crate names must be plain identifiers (`^[a-z0-9_]+$`). `anchor build --verifiable` itself isn't used, because after its container it builds the IDL on the host, compiling and running the developer's build scripts and macros there.
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
- **The RPC is rate-limiting** (see [RPC limits](#solana-rpc-limits) below): each call waits and tries again, and a batch of writes whose blockhash expired meanwhile, or that wasn't confirmed in time, is signed again on a fresh blockhash and only its unlanded writes are sent again (a write puts the same bytes at the same offset, so sending it twice is harmless). A deploy that still gives up keeps the program retryable: nothing at the program's address is created before its buffer is written, and the buffer it couldn't close is closed by the next deploy or upgrade of that program before it writes a new one.

The registry records, per program: its address, the app or product it belongs to, cluster, version, verifiable-build hash, deployer, upgrade authority, signer backend, deploy transaction and status (`reserved`, `deploying`, `deployed`, `failed`).

**5. Call it.** `simulate_program_call` runs an instruction without sending it (logs, compute used, error). `call_program` simulates first and sends only if the simulation succeeds. An instruction is an Anchor `method` (snake_case; Mynt adds the discriminator) with `args_base64` (Borsh-encoded arguments), or raw `data_base64`, plus its accounts. Each developer has two keys per cluster in Mynt's vault. A **fee payer** pays every call's fees and is never passed to a program, so no program can spend it. A **caller key** (`"$caller"` in the accounts) signs only when the call lists it as a signer, and it is the only signer a call may have. A call may never include Mynt's deploy authority or the fee payer, so one firm's program can never act with a key that controls another's.

**Funding call keys.** On devnet, Mynt funds a developer's keys before it simulates (a fee payer that doesn't exist on chain yet fails a simulation with `AccountNotFound`): the fee payer to 0.005 SOL, and the caller, when the call lists `$caller` as a signer or writable, to 0.02 SOL, enough for the rent of a typical small account an Anchor `initialize` creates with `payer = caller`. A bigger account's shortfall is read from the simulation's own log and sent before simulating once more. Mynt asks the devnet faucet first. When the faucet refuses (it rate-limits servers), Mynt's devnet deploy authority sends just the shortfall in a separate system transfer to the developer's own key, never more than `SOLANA_DEVNET_TOPUP_MAX_SOL` at once (default 0.05) or `SOLANA_DEVNET_TOPUP_DAILY_SOL` per developer in any 24 hours (default 0.25), and never what would leave the authority with less than `SOLANA_DEVNET_AUTHORITY_KEEP_SOL` (default 0.1). Every top-up is in the audit log (`solana_devnet_topup`, with its source, amount and signature). That transfer is not a call: the deploy authority still never signs, pays for or appears in a developer's transaction. On mainnet nothing is funded automatically: a simulation or call with an unfunded fee payer is refused with the fee payer's address to fund.

**6. Events.** Mynt's indexer polls every deployed program's new transactions (`SOLANA_INDEX_POLL_MS`, default 30 s; up to 1,000 per program per poll, oldest first, the rest on the next poll, none skipped) and forwards each Anchor event the program itself logged (`emit!`) to the owning firm's webhooks as `program.event` (with the event's name from the build's IDL and its data, base64), once each. Deploys and upgrades go out as `program.deployed` and `program.upgraded`. Devnet events are sandbox deliveries; mainnet's are live.

**Signers.** Every deploy, upgrade and call goes through one signer interface (`core/src/solana/signer.ts`):

| Backend | Cluster | How it signs |
|---|---|---|
| `devnet-vault` | devnet | A Mynt-generated key sealed in the vault. Mynt asks the devnet faucet for rent; when the faucet's limit is reached, the error names the address to fund. The same key tops up developers' devnet call keys when the faucet refuses them, within the limits above. |
| `mainnet-vault` | mainnet | A key in Mynt's vault, generated by `configure_solana_signer` (only its address is ever shown) or imported by the operator on the server with `mynt solana import-key --cluster mainnet --file <keypair.json>`. Needs `SOLANA_MAINNET_VAULT_SIGNER=enabled` on the server. |
| `custody-service` | mainnet | [Turnkey](#turnkey-custody-for-the-mainnet-deploy-authority) holds the deploy authority, an Ed25519 Solana account in a Turnkey wallet, and signs each transaction without Mynt seeing the key. Needs the three `TURNKEY_*` variables on the server. |
| `multisig` | mainnet | A multisig (Squads style) holds the upgrade authority and its members approve each change as a proposal. The interface is in place; until a multisig client is connected it refuses. |

<a id="close-program"></a>**Closing a devnet program** (`close_program`, admins). It closes a deployed devnet program for good with the upgradeable loader's Close instruction on its program data (accounts: the program data, the recipient, the upgrade authority as signer, and the program), signed by Mynt's devnet deploy authority, so the program data's rent comes back to that authority. Closing is refused unless the chain shows Mynt's devnet authority as the program's upgrade authority. A leftover deploy buffer is closed too. The program can't run or be deployed again; its record is marked `closed` and the close is audited with the signature and the lamports returned. Mainnet programs are refused: Mynt never closes one. `remove_app` closes each deployed devnet program of the app this way before deleting anything.

**Mainnet is off until an admin turns it on.** Every mainnet deploy, upgrade, simulation and call is refused with "Mainnet signer not configured: …", naming everything still missing, until all of these hold: `SOLANA_RPC_URL_MAINNET` is set; an admin has chosen a backend with `configure_solana_signer` and that backend is ready (for `mainnet-vault`: the server flag and a key in the vault; for `custody-service`: Turnkey's variables set, its API key pair matching, and a custody address configured); and the admin has set `enabled: true`. Program calls on mainnet sign with per-developer vault keys, so they need the `mainnet-vault` backend. Every mainnet deploy and upgrade also needs an approved review from the [mainnet program gate](#mainnet-program-gate). `configure_solana_signer` with no arguments shows the current state; `list_all_programs` shows every program on both clusters.

**Toolchain** (pinned in `core/schemas/solana-toolchain.json`, each download checked against its sha256 before use): Agave (Solana CLI, `solana-test-validator`, `cargo-build-sbf`), the Anchor CLI (built from its tagged commit where the release binary's glibc is too new), Rust through rustup, Anchor's verifiable-build image by digest, and the `@coral-xyz/anchor` client the template's tests use. It installs under `~/.mynt-solana` in the background when a Solana build's sandbox starts: about 2 GB, a few minutes. Agave publishes Linux binaries for x86_64 only. CI's `solana-program` job installs the same toolchain with the same script and builds and tests the template program the same way Mynt's verify sandbox does. Every program Mynt builds, every deployed version and `get_program` record the exact toolchain (`toolchain`: versions, image digest and the pins' sha256), so an old version can be rebuilt with the same tools.

**Keeping the toolchain current.** `.github/workflows/solana-toolchain-watch.yml` runs `core/scripts/solana-toolchain-watch.mjs` every Monday (and on demand). It finds new stable releases that have been public for at least `TOOLCHAIN_MIN_RELEASE_AGE_DAYS` (default 3): Anchor's patch releases by default, or its newest release with `anchor_line: latest`, with its verifiable-build image (the Solana Foundation's registry preferred); Agave on the line that Anchor release builds its image with; Rust stable; rustup; the client. It computes their sha256s and the image digest itself, checks RustSec (through OSV) and GitHub's advisory database for the pinned and proposed versions, and opens a pull request that rewrites the pins, the template program, the version-matched docs the coding agents read (`core/workspaces/coding-build/docs/solana`, Anchor's and Agave's docs at the pinned tags) and the vendored `solana-dev` skill (at its latest tagged release, or a commit at least as old as the minimum age, with a link to the upstream diff). The title says **URGENT** when an advisory affects a pinned tool and **BREAKING** for a new Anchor or Agave major or minor. The watcher runs with read-only access and hands a patch to a second job that only commits it and opens the pull request; a failure to open it fails the run and opens an issue. Its CI is the `solana-program` job. **A person reviews every toolchain-watch pull request before it is merged: they are excluded from any standing instruction to merge green pull requests.** The repository must allow GitHub Actions to create pull requests (Settings, Actions, General, "Allow GitHub Actions to create and approve pull requests"), or hold a GitHub App installation token scoped to this repository as the `TOOLCHAIN_WATCH_TOKEN` secret.

**Pre-built environment.** Where the sandbox host can snapshot a machine (Freestyle can; boat.dev can't), Mynt installs the toolchain and pulls the image once, in a machine that runs only Mynt's scripts, hashes what it holds (every file, mode and link of the toolchain, the SBF platform tools, `~/.docker`, `~/.cargo` and `/etc/docker/daemon.json`, and the image's id, digests and layers), keeps that hash in its database and snapshots the machine. Solana build and verify sandboxes then boot from the snapshot and re-hash it with Mynt's own script before anything else runs (the toolchain's env file, which agents wait for, is held back until it passes). It is used only when the hash matches; on a mismatch, or any check that doesn't finish cleanly, the toolchain and image are wiped (by Mynt itself when the check didn't) and installed from the pinned, checksum-verified downloads, or the verify sandbox is replaced by a plain one. This is drift detection, not tamper-proofing: it runs with the snapshot's own tools, and the supply chain is protected by the pinned checksums and digest, as without a snapshot. A booted VM's randomness is reseeded with a per-VM nonce from Mynt. The snapshot is keyed by the pins, the scripts, the host's machine setup and the sandbox type, and rebuilt when older than `SOLANA_BUILD_SNAPSHOT_MAX_AGE_DAYS` (default 7); another key's snapshot is deleted only after nothing has booted from it for six hours. Admins see it, build it ahead of time or replace it with `solana_build_environment`; `SOLANA_BUILD_SNAPSHOT=off` turns it off.

**Configuration:** `MYNT_VAULT_KEY` (required: programs' and signers' keys are sealed with it); `SOLANA_RPC_URL_DEVNET` (default the public devnet endpoint); `SOLANA_RPC_URL_MAINNET` (no default; may carry a provider key, so it is treated as a secret and never shown); `SOLANA_MAINNET_VAULT_SIGNER=enabled` (only for the `mainnet-vault` backend); `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_API_PRIVATE_KEY` (only for the `custody-service` backend; the private key is a secret) and optional `TURNKEY_APPROVAL_TIMEOUT_SECONDS`; optional `SOLANA_INDEX_POLL_MS`, `SOLANA_CONFIRM_TIMEOUT_MS`, `SOLANA_RPC_MAX_RPS` and `SOLANA_RPC_MAX_RETRY_SECONDS` (see below); optional `SOLANA_DEVNET_TOPUP_MAX_SOL`, `SOLANA_DEVNET_TOPUP_DAILY_SOL` and `SOLANA_DEVNET_AUTHORITY_KEEP_SOL` (devnet call-key top-ups, above). RPC calls follow Mynt's outbound rules (HTTPS, no private or loopback addresses, no redirects, time and size limits).

<a id="solana-rpc-limits"></a>**RPC limits.** The public devnet endpoint Mynt uses by default is rate-limited per address (Solana documents 100 requests per 10 seconds in all and 40 per 10 seconds for any one method), and a deploy sends one write transaction per kilobyte or so of program: about 450 for a 450 KB program. Mynt copes in two ways:
- **Pacing.** A deploy's buffer writes go out at `SOLANA_RPC_MAX_RPS` requests a second, shared by every deploy on that cluster. By default that is 4 a second on the public devnet endpoint (about two minutes for 450 writes), and 25 a second when `SOLANA_RPC_URL_DEVNET` names another RPC, and on mainnet. Setting `SOLANA_RPC_MAX_RPS` sets both clusters' pace.
- **Retrying.** A call answered with HTTP 429 or 503, or with a JSON-RPC error that means rate limiting (code -32005, or wording such as "Too many requests"), is retried with exponential backoff and jitter, waiting what a `Retry-After` header asks for (seconds or a date, at most 60 s a time). HTTP 502 and 504, which can come back after the node took the request, are retried only for calls that are safe to repeat: reads, and `sendTransaction`, because a signed transaction lands once by its signature however often it is sent. An airdrop isn't sent twice, and a rate-limited airdrop fails at once instead of waiting: the faucet's limit lasts hours, so Mynt funds another way. One call waits at most `SOLANA_RPC_MAX_RETRY_SECONDS` in all (default 120) and then fails with a message that says the RPC was still rate-limiting; it never includes the RPC's URL or host, which may carry a provider's key.

For faster devnet deploys, the operator sets `SOLANA_RPC_URL_DEVNET` on the server to a devnet URL from an RPC provider. Like the mainnet URL, it may carry the provider's key, so it is set by the operator in the server's environment and never shown.

**For mainnet, the operator provides:** a mainnet RPC provider's URL as `SOLANA_RPC_URL_MAINNET`; a signer choice; and SOL (about 0.021 SOL per KB of program: the program data reserves twice its size, and the upload buffer holds a copy until the deploy) for whoever pays deploys: the deploy authority's address with `mainnet-vault`, or the **deploy payer** (`deploy_payer` in `configure_solana_signer`) with `custody-service`, whose custody address needs none; plus each developer's fee-payer address for calls (and their caller address when their programs make the caller pay rent).

<a id="mainnet-program-gate"></a>
#### Mainnet program gate

Every mainnet deploy and every mainnet upgrade passes a review first (`core/src/solana/mainnet-gate.ts`). `deploy_program` and `upgrade_program` on mainnet are refused unless an **approved** review covers exactly the build's program (its verifiable-build hash). Devnet is unchanged and has no gate. Without the gate (no sandboxes, no agent backend, or no `PUBLIC_URL`), mainnet deploys are refused: it fails closed.

**Tools.** Developers: `request_mainnet_review` (`program_id` of a mainnet program, `build_id` of a succeeded build), `get_mainnet_review` (status, step, every check's result, the findings, cost, decision, an upgrade's timelock, and the review's own audit log), `cancel_mainnet_review`. Admins also get `list_mainnet_reviews`, `approve_mainnet_program` (its answer shows the whole report again; `allow_exceptions` must name every exception the review lists) and `reject_mainnet_program`. A program has one open review at a time (a partial unique index enforces it, whatever races). Reviews are stored in `solana_mainnet_reviews` with an append-only `solana_mainnet_review_log`, and every request, approval, rejection and cancellation is also in Mynt's audit log.

**What it reviews.** Mynt's verify build keeps, next to the bytes, read back and hashed by Mynt:
- **The workspace exactly as it went into the build container.** The build archives the workspace once (every file type, dot-folders such as `.cargo/` included, nested `target/` or `node_modules/` folders included; only the top-level `target/`, `node_modules/` and `.anchor/` left out, as the container copy always did), feeds that very archive to the build container, and keeps it: text files as text, others as base64, links as links (`solana_program_sources`). A workspace over 16 MB fails the build; nothing is ever silently left out. A workspace that ships build output fails the build too, with the paths named: a cargo target folder at any depth below the top level (a folder named `target` that holds cargo's `.rustc_info.json` or `CACHEDIR.TAG`; a source module folder that happens to be called `target` is fine), a folder named `docker-target` or `.anchor`, cargo's `.fingerprint/` folders, `*.rlib`, `*.rmeta`, `*.d` or `*.so` files, or a file name with control characters. Cargo's target dir in the build and IDL containers is `/mynt-target`, outside the source and empty when the build starts, so nothing shipped can pass for a "fresh" artifact cargo would reuse instead of compiling. The programs, dep-info and IDL are read only from there. This holds for every build, devnet included: Mynt compiles every program itself.
- **Every dependency the build used** (`solana_program_deps`): each crate of the `Cargo.lock` the build compiled with, its source, its checksum, and the sha256 of the `.crate` cargo downloaded in the fetch container (before any of the developer's code ran), compared with that checksum; plus the full source of every crate not on the crate allowlist (up to 16 MB) and the `Cargo.lock` itself.
- **The IDL, built in Mynt's own offline container**, a third one with no network that gets a fresh copy of the same source and crates after the programs are out, so `anchor idl build` (which runs the workspace's code) can't touch them. The test run's IDL, built on the host by the workspace's own code, is kept only to name events and never replaces it.

A build made before this change has none of these and can't pass: build it again.

**1. Hard rules** (`core/src/solana/program-rules.ts`), driven by the [vulnerability database](#solana-vulnerability-database): deterministic, run by Mynt in-process when the review is requested, no model. Entries whose gate is `block` refuse the program; `flag` entries are recorded as leads the audit agent must confirm or dismiss. A finding names the entry's id, what was found, where, and by which signal. The rug-pull entries:
- **No value-moving programs, for now.** Refused: references to `anchor_spl::token`, `token_2022`, `token_interface`, `associated_token`, `spl_token`, `spl_token_2022` or `spl_associated_token_account`; token CPIs (`transfer`, `transfer_checked`, `mint_to`, `burn`, `approve`, `set_authority`, `close_account`); system-program transfers and assigns (`system_program::transfer`, `system_instruction::transfer`/`assign`, `SystemInstruction::Transfer`), with a note when the file signs CPIs with the program's own PDAs; and lamports moved by hand (`sub_lamports`, `add_lamports`, `lamports.borrow_mut()`).
- **No hidden admin.** Refused: an `#[account(address = …)]`, `constraint` or `owner` constraint, a `require!`/`require_keys_eq!`, or an `==`/`!=` comparison against a hard-coded key (`pubkey!`, `Pubkey::from_str`, `Pubkey::new_from_array`, or a `const` holding one; well-known program and sysvar ids aside); an authority, admin or owner field set to anything but the key of an account that signs that instruction (an argument, a non-signer account; `Pubkey::default()` to renounce is fine); and an Anchor `close = target` whose target doesn't sign. A hard-coded key equal to Mynt's own mainnet signer is noted, not refused (no program should need it).
- **The upgrade authority stays Mynt's mainnet signer**: the `mainnet-vault` key or Turnkey custody (`custody-service`); for an upgrade, the program's recorded authority must be that signer. While mainnet's signer isn't configured this is `pending`, and it is asserted again at approval and when the deploy or upgrade starts (the deployer also refuses any other backend on mainnet).

Each rule looks three ways, because each alone can be fooled. **Source**: the captured Rust with comments stripped (a comment can neither hide code nor create a finding). **IDL**: instructions taking a token program (by its fixed address or name) or a token account, and accounts pinned to a fixed address that must sign. **Bytes**: the SPL Token, Token-2022 and Associated Token program ids embedded in the sBPF program, raw or as base58 text, plus the 32 bytes of any hard-coded key the source checks against, as corroboration. Limits, returned with every result: the source scan is pattern-based, not a compiler (macro-generated code, hand-built CPI bytes or an authority passed through more than one variable can be missed); the IDL is built by the workspace's own code and shows only what Anchor records; the bytes show only ids the program embeds, and the System Program's id is all zeros, so system transfers are invisible there. Without captured source a program is refused.

**What the rules read: what the compiler read.** The authority is rustc's own dep-info. After the build, Mynt streams the stopped build container's `/workdir` and unpacked crates out as tar (hashed, never unpacked) and keeps every dep-info file cargo wrote (`/mynt-target/**/*.d`, outside build scripts' `out/` folders) with the sha256 of the container's copy of every workspace and registry file, and of every file in each downloaded `.crate` (`solana_program_depinfo`). The review refuses a build when any file the compiler read is missing from the captured workspace, differs from it (something rewrote it during the build), isn't in its crate's `.crate` (or differs), belongs to a crate not in the `Cargo.lock`, or lies outside the workspace and the crates.io registry cache; a file in the target dir other than a build script's `out/` folder of a crate in the `Cargo.lock` or of a workspace crate whose build script is an exception; a dep-info line that isn't a rule, or a path with control characters; and a build with no dep-info record. The rules then read exactly the workspace files listed, wherever they are (a real module under `tests/` or a nested `target/` included). Files generated by a workspace crate's build script are listed as exceptions. When any build-time code ran (a workspace build script or proc macro, or a dependency's build script, which is nearly always), the rules also read every captured `.rs` file, not only dep-info's list. A hit that would block in a file dep-info doesn't list (an integration test under `tests/`, say) doesn't refuse the review; it becomes an exception, `uncompiled-hit:<file>`, that the approving admin must name, and the deploy-time re-check refuses any such hit the approval didn't name. Residual risk: dep-info is written in the same container where build scripts and proc macros run, so such code could rewrite a `.d` file. Any compiled file whose contents changed is still refused, and reading every captured `.rs` file covers what a rewritten `.d` could hide from the workspace; a dependency's build script is trusted by being on the allowlist or named by an admin. Manifest patterns (such as `overflow-checks`) read every captured `Cargo.toml`.

Mynt's own module resolution (crate roots from the manifests, read with a real TOML parser, `smol-toml` 1.9.1, so dotted keys and inline tables mean what they mean to cargo; then `mod`, `#[path]` and `include!`) is only a cross-check: wherever it disagrees with dep-info, in either direction, that's an exception (`module-tree-mismatch:<file>`) the admin must name, and the review's caveats say so. A module path chosen by `cfg_attr(..., path = ...)` is always an exception, and the resolver follows every candidate; a manifest that isn't valid TOML is one too.

**What can change the build beyond the reviewed source** is listed as **exceptions**, each with an id, and an admin must name every one in `allow_exceptions` to approve (the review still runs every gate, so the admin decides with the full report): a `.cargo/config` or `.cargo/config.toml` anywhere in the workspace with any setting beyond the template's `[resolver] incompatible-rust-versions = "fallback"` (which Mynt's build sets by environment anyway); a build script in any package; a procedural-macro crate in the workspace; `[patch]` or `[replace]`; `include!`, `include_str!` or `include_bytes!` of a file that isn't Rust text, or of a path that isn't a plain string (`concat!(env!("OUT_DIR"), ...)`); `#[path]` to a non-`.rs` file; a `mod` whose file isn't in the workspace (generated at build time); and links. A `rust-toolchain.toml` isn't an exception: the build pins `RUSTUP_TOOLCHAIN` by environment, which outranks it, and `cargo build-sbf` compiles with the platform tools' own Rust.

**Dependencies.** Every crate must come from crates.io (a git or other-registry source, or a path dependency outside the captured workspace, is refused), and the crate the build used must match `Cargo.lock`'s checksum. A crate on **`core/schemas/solana-crate-allowlist.json`** passes: exact names only (crates.io has no namespaces), generated from the template's `Cargo.lock` (CI fails if the template resolves a crate that isn't on it) and changed only by a reviewed pull request. Allowing a crate by name trusts whoever owns it on crates.io: a new release they publish is accepted once a `Cargo.lock` resolves it (checksum-verified, cargo-audited, but not reviewed line by line), so the list stays short and an Anchor or Solana upgrade means reviewing it again. It also lists crates that are never allowed (`anchor-spl`, `spl-token`, `spl-token-2022`, `spl-associated-token-account`: value-moving). Any other crate is an exception (`crate:<name>@<version>`) an admin must name, and the hard rules run over its source too: a blocking finding there refuses the program. The auditor gets those crates' source beside the program's.

**The IDL** is used only if every instruction it lists is in the program's bytes (its 8-byte discriminator, as stored data, a 64-bit load, or two 32-bit immediates); an IDL naming an instruction the program doesn't have refuses the review. The agents and Mynt's PoC re-run get it with the developer's free text neutralised: no doc strings, error messages or constant values, and names cut to 64 characters. An instruction the IDL leaves out can't be found this way, which every review says.

<a id="solana-vulnerability-database"></a>
**Vulnerability database** (`core/schemas/solana-vulnerabilities.json`, version 1; `core/src/solana/vuln-db.ts`). One entry per vulnerability class: id, title, severity, category, gate (`block` or `flag`), description, detections (`source_pattern`: a regular expression over the comment-stripped Rust, with an optional `unless` that clears a file, an `absent` pattern, or a named built-in analysis; `idl_shape`; `bytecode_program_ref`: program ids in the bytes; `dependency_advisory`: cargo-audit's RustSec findings; `red_team_scenario`: how to attack it, for the agents), public references (incident write-ups, the Sealevel attacks, Trail of Bits' not-so-smart-contracts, Neodyme, Helius, the crates' docs), and a bad and a good fixture under `core/test/fixtures/`. `core/test/mainnet-gate.test.js` checks every entry against both fixtures: its detections must catch the bad one and pass the good one, and the template program must trigger none. The audit and red-team agents get the whole database in their sandboxes (`job/vulnerabilities.json`) as their checklist.

| Entry | Category | Severity | Gate | Class |
|---|---|---|---|---|
| `RUG-TOKEN-CPI` | rug_pull | critical | block | Value moved through the token programs |
| `RUG-SYSTEM-TRANSFER` | rug_pull | critical | block | SOL moved by system-program transfers or assigns |
| `RUG-LAMPORT-DRAIN` | rug_pull | critical | block | Lamports moved by hand between accounts |
| `RUG-HARDCODED-ADMIN` | rug_pull | critical | block | Hard-coded admin key |
| `RUG-AUTHORITY-ARBITRARY` | rug_pull | critical | block | Authority handed to an account that doesn't sign |
| `RUG-CLOSE-NON-SIGNER` | rug_pull | critical | block | Account close pays a non-signer |
| `RUG-MINT-FREEZE-AUTHORITY` | rug_pull | critical | block | Retained mint or freeze authority |
| `RUG-TOKEN2022-EXTENSIONS` | rug_pull | critical | block | Token-2022 permanent delegate or transfer hook |
| `AC-MISSING-SIGNER` | access_control | critical | flag | Authority account that isn't required to sign |
| `AC-MISSING-OWNER` | access_control | high | flag | Account data read without an owner check |
| `AC-HAS-ONE` | access_control | critical | flag | Stored authority not matched to the signer |
| `AC-REMAINING-ACCOUNTS` | access_control | high | flag | remaining_accounts used without checks |
| `AV-TYPE-COSPLAY` | account_validation | high | flag | Account type not checked (type cosplay) |
| `AV-BUMP-CANONICAL` | account_validation | high | flag | PDA without the canonical bump |
| `AV-SEED-COLLISION` | account_validation | medium | flag | PDA seeds without a fixed prefix (seed collision, PDA sharing) |
| `AV-DUPLICATE-MUT` | account_validation | high | flag | Duplicate mutable accounts |
| `AV-SYSVAR-UNCHECKED` | account_validation | high | flag | Sysvar account address not checked |
| `AV-INIT-FRONTRUN` | account_validation | medium | flag | Re-initialization or front-run initialization (init_if_needed) |
| `AV-CLOSE-REVIVE` | account_validation | high | flag | Closed account that can be revived |
| `CPI-ARBITRARY` | cpi | critical | flag | Arbitrary CPI: the called program isn't checked |
| `CPI-SIGNER-PRIVILEGE` | cpi | critical | flag | Signer privileges passed to an unchecked program |
| `CPI-STALE-RELOAD` | cpi | medium | flag | Account data used after a CPI without reload |
| `SIG-UNCHECKED-SYSVAR-LOAD` | signatures | critical | block | Instructions sysvar read without checking it (Wormhole) |
| `SIG-INTROSPECTION-PROGRAM-ID` | signatures | high | flag | Instruction introspection that checks only the index |
| `SIG-REPLAY-NONCE` | signatures | high | flag | Signed message without a nonce or expiry (signature replay) |
| `SIG-DOMAIN-SEPARATION` | signatures | high | flag | Signed message not bound to this program or cluster (cross-program / cross-cluster replay) |
| `AR-OVERFLOW` | arithmetic | high | flag | Integer overflow or underflow |
| `AR-PRECISION` | arithmetic | medium | flag | Precision loss and rounding direction |
| `AR-DIV-ZERO` | arithmetic | medium | flag | Division by a value that can be zero |
| `AR-CAST-TRUNCATION` | arithmetic | medium | flag | Casting truncation |
| `EC-SLIPPAGE` | economic | high | flag | Swap or trade without slippage bounds (front-running, sandwich) |
| `EC-ORACLE` | economic | high | flag | Oracle price used unchecked (stale, low confidence, manipulable) |
| `EC-TIMESTAMP` | economic | low | flag | Timestamp or slot dependence |
| `EC-RANDOMNESS` | economic | high | flag | Insecure randomness |
| `DOS-UNBOUNDED` | resource | medium | flag | Unbounded vectors or loops |
| `DOS-REALLOC` | resource | medium | flag | Account growth or realloc abuse |
| `DOS-COMPUTE` | resource | low | flag | Compute exhaustion |
| `DOS-RENT` | resource | medium | flag | Account created without rent exemption |
| `DEP-RUSTSEC` | dependencies | high | block | Dependency with a RustSec advisory |

Merged rather than separate: a one-step authority transfer is `RUG-AUTHORITY-ARBITRARY` (the new holder never signs); uninitialized accounts are `AV-INIT-FRONTRUN`; cross-program and cross-cluster replay and missing replay protection on off-chain messages are `SIG-DOMAIN-SEPARATION` and `SIG-REPLAY-NONCE`; rounding direction is `AR-PRECISION`; front-running and sandwiching are `EC-SLIPPAGE`. Most non-rug-pull detections are heuristics (a file-level `unless`, names like `*_program` or `swap`), which is why they flag rather than block: the auditor confirms them against the source, and its verified critical or high findings block.

- **Changes are reviewed.** Admins see the database with `list_vulnerability_rules` and suggest entries with `propose_vulnerability_rule`, which checks the entry's shape and stores it as a proposal (`solana_vuln_rule_proposals`). Only a pull request that adds the entry with its fixtures changes the database. `core/scripts/vuln-db-suggest.mjs [--since YYYY-MM-DD]` turns new RustSec advisories (through OSV) against Solana, Anchor, SPL, crypto and serialization crates into suggested entries for that review; it never edits the file.
- **A new version re-checks what's deployed.** When the server starts on a higher database version, the gate's worker runs the new hard rules on every deployed mainnet program (its stored bytes, IDL and captured source). A program that fails is flagged (`solana_program_flags`): its firm gets `program.review_flagged`, admins see it in `list_program_flags` and `ops_status`, and its upgrades (requests, approved and scheduled ones) wait until an admin records a review with `resolve_program_flag`. The program keeps running; Mynt never takes one down.

**2. White-box audit**, in a fresh sandbox of Mynt's that gets only the captured source:
- **Static analysis**, each tool pinned by sha256: [cargo-audit](https://github.com/rustsec/rustsec) 0.22.2 (the release binary) against the RustSec advisory database, fetched fresh each run, for the `Cargo.lock` the build compiled with; and [Radar](https://github.com/Auditware/radar) (Auditware; GPL-3.0, run, not vendored) at commit `3439053`, its source tarball by sha256 and its four images by digest. Radar honours `radar-disable` comments in what it scans, so Mynt removes them from its copy first. A tool that couldn't run blocks; so does a cargo-audit vulnerability or a Radar critical or high finding of medium or high certainty. Radar's low-certainty findings go to the audit agent as leads. `PROGRAM_GATE_CARGO_AUDIT_IGNORE` (comma-separated `RUSTSEC-YYYY-NNNN` ids) lets the operator accept an advisory that can't reach an on-chain program; it is shown in every report.
- **The program-audit agent** (`core/workspaces/program-audit/`), in the same sandbox after Mynt has read the tools' results: it reads the source, Mynt's hard-rule results and the static findings, and writes JSON findings with a severity and a quote. Mynt checks each quote against the named file; a finding whose quote isn't there is kept, marked unverified, and never blocks. A verified critical or high finding blocks, and so does an audit that didn't finish. It never sees the builder agent's conversation.

**3. Black-box red team** (`core/workspaces/program-red-team/`), in a sandbox of its own that gets only the exact bytes Mynt stored and the IDL, never the source. It runs the pinned toolchain's `solana-test-validator` with the program at its address and writes attacks (wrong signer, account substitution, PDA spoofing, authority takeover, draining, re-initialization, arithmetic edges). A finding counts only with a proof of concept: a folder with `run.sh`, run in two phases. `setup` creates a victim with keys of its own and writes `claim.json` (the victim's signer keys and accounts); `attack` writes `attack.json` (its transactions' signatures). Mynt reads the PoCs back as text and re-runs each in a third, fresh sandbox, on a fresh validator of its own, never the agent's. It snapshots the victim's accounts itself between the phases and after. An exploit is **confirmed** only when every attack transaction succeeded on Mynt's validator, invoked the program, and was signed by none of the victim's keys, and a victim account the program owns, which held a victim key or had lamports, changed or lost lamports. A confirmed exploit blocks. Findings without a PoC, or whose PoC doesn't confirm (a failed transaction, a denial of service), are reported and don't block. A red team that didn't finish blocks. If Mynt can't complete its re-run, the review fails and can be requested again.

Trident (Ackee's Anchor fuzzer) isn't run: it fuzzes a program from its source through a hand-written harness, which would put source in front of the black-box red team and make the harness agent-written; the red team's PoCs cover the same ground against the real bytes.

**4. Sign-off and timelock.** When every automated gate passes, the review waits for an admin (`awaiting_approval`). `get_mainnet_review` and the approval itself say plainly what the gate can't promise (`caveats`): that a clean audit or red-team result isn't proof; that the local validator can't show behaviour depending on time or slot, on live mainnet state (oracles, other programs), on the cluster (feature gates, compute, fees), on transaction ordering under load, or on later upgrades; that IDL-omitted instructions aren't checked; and every exception, with what was allowed. A **first deploy** then goes ahead with `deploy_program` for exactly that build, within `MAINNET_APPROVAL_TTL_DAYS` (default 14) of the approval; an approved upgrade must start within the same number of days after its timelock ends. An **upgrade** is also announced at once to the firm's webhooks (`program.upgrade_scheduled`, with the hash and when it can run) and runs only after `MAINNET_UPGRADE_TIMELOCK_HOURS` (default 48) and an admin's approval; Mynt starts it itself when both hold, as the developer who asked. Upgrades need an admin too because an upgrade can turn a reviewed program into anything, and the timelock only helps users who are watching. The developer or an admin can cancel until the upgrade starts; a cancelled or rejected upgrade goes out as `program.upgrade_cancelled`. A review becomes `executed` once the program holds exactly the reviewed bytes.

**An approval is used once.** `deploy_program`/`upgrade_program` (and Mynt's own start of a timelocked upgrade) check the approval first, then claim it atomically, last, just before the deploy starts (`started`); two deploys at once can't both use it, and a cancel can't race it. The claim re-runs the current vulnerability database's hard rules over exactly those bytes and refuses if a newer version blocks them. It is given back only if the deploy couldn't start, or if the attempt ended with the program unchanged; if the program ended up holding another build, the review fails. So going A, then B, then A again needs a fresh review (and, for an upgrade, a fresh announcement and timelock). If a first deploy finds an earlier build of the program already on mainnet (a lost confirmation), Mynt records that build and stops: the new one needs a review as an upgrade.

**Statuses:** `running` (step `analysis_provisioning`, `analysis`, `audit`, `red_provisioning`, `red_team`, `confirm_provisioning`, `confirming`), `awaiting_approval`, `approved`, `started`, `executed`, `blocked`, `rejected`, `cancelled`, `failed`.

**Budget.** Both agents reach the model only through Mynt's agent proxy, which meters every call against their own caps: `PROGRAM_AUDIT_CAP_USD` (default 5) and `PROGRAM_RED_TEAM_CAP_USD` (default 8), on `PROGRAM_GATE_MODEL` (default the builds' model). Time limits: `PROGRAM_ANALYSIS_MINUTES` (45), `PROGRAM_AUDIT_MINUTES` (45), `PROGRAM_RED_TEAM_MINUTES` (60). `PROGRAM_GATE_MONTHLY_CAP_USD` (default 100) caps all reviews in a month: each review reserves its two caps from a per-month counter, updated atomically only while it stays under the cap, and gives back what it didn't spend once its agents are done. A review's cost is its sandboxes' machine time plus both agents' metered spend; Mynt pays it, like the build audit.

**Retention.** What a build captures for this gate (its source, its dependencies, and what the compiler read) is kept for any build a mainnet review names or a program version was deployed from. The rest, such as devnet builds nobody took further, is deleted once older than `PROGRAM_SOURCE_RETENTION_DAYS` (default 30); such a build must be built again before a mainnet review.

**Skills**, vendored verbatim from GitHub with their licences (`UPSTREAM.json`): the program-audit agent follows [exvulsec/exvul-solana-skill](https://github.com/exvulsec/exvul-solana-skill) (MIT), with the account-validation, CPI, PDA, account-lifecycle, instruction-introspection and centralization-risk skills from [PlamenTSV/plamen](https://github.com/PlamenTSV/plamen) (MIT); the red team uses Plamen's verification-protocol, account-validation and PDA skills.

**An outside audit** is available too: `smart_contract_audit` is a US service type, so audit firms can offer it as vendors (`create_vendor_offering`). The builder engages and pays the auditor directly; Mynt only lists it, and it doesn't replace the gate.

CI's `solana-program` job runs the hard rules and the static analysis on the template program as Mynt captured it (they pass) and the hard rules on a token-vault fixture (refused).

#### Turnkey custody for the mainnet deploy authority

With the `custody-service` backend the mainnet deploy authority (the key that deploys and upgrades every program, and the upgrade authority on chain) lives in Turnkey, not on Mynt's server. For the authority, Mynt holds only a Turnkey API key, which can ask Turnkey to sign and nothing else, and Turnkey's policy decides what it will sign (`core/src/solana/custody/turnkey.ts`). Mynt also holds a deploy payer (SOL for fees and rent, no control over any program) and, during each deploy, a temporary buffer key, both sealed in its vault.

How a deploy or upgrade runs, with **one Turnkey activity each** (so a person can approve every deploy):

1. Mynt's **deploy payer**, a Mynt-held key sealed in the vault that holds SOL only and controls no program, funds a fresh **buffer key** made for this deploy (also sealed in the vault, with the address of the buffer it writes) with the buffer's rent, its fees and its own rent-exempt minimum.
2. The buffer key creates the upload buffer and writes the program into it, signed by Mynt, each batch of writes on a fresh blockhash. Turnkey isn't involved.
3. Mynt asks Turnkey to sign **one transaction**: AdvanceNonceAccount on the program's **durable nonce** (system program, tag 4, authorised by the deploy payer), then the buffer key hands the buffer to the custody address (the loader's SetAuthority, tag 4, signed by the buffer's current authority; the loader deploys or upgrades only from a buffer whose authority is the upgrade authority), then Deploy (tag 2) or Upgrade (tag 3), signed by the custody address. The deploy payer is its fee payer and pays the program's rent; the custody address pays nothing and needs no SOL. Because the handover is in the same transaction, a failed or refused signature leaves the buffer with the buffer key, which closes it.
4. Whatever the buffer key has left goes back to the deploy payer, and the buffer key is deleted. An upgrade's leftover buffer rent goes to the deploy payer too, as the Upgrade's spill account. If Mynt stops mid-deploy (a crash, a restart), the next deploy of the program closes any buffer the old buffer key still controls (the address stored with it, and any the loader lists under it with `getProgramAccounts`), returns the rent to the deploy payer, then deletes the key. If that cleanup can't be finished (the RPC doesn't answer), the new deploy refuses to start and says so, rather than reuse the old key; each deploy gets a fresh buffer key and buffer.

**The durable nonce.** That one transaction uses the program's nonce instead of a recent blockhash, so it stays valid however long the approval takes, up to `TURNKEY_APPROVAL_TIMEOUT_SECONDS` (default 60, at most 1800). A blockhash would expire in about a minute. Each program gets its own nonce account (80 bytes, about 0.0015 SOL of rent from the deploy payer), made by its first custody deploy and kept for its upgrades, so two deploys at once never compete for one nonce.

The request is the whole unsigned transaction (`POST /public/v1/submit/sign_transaction`, activity `ACTIVITY_TYPE_SIGN_TRANSACTION_V2`, type `TRANSACTION_TYPE_SOLANA`, `signWith` the custody address), so Turnkey's policy can read its instructions. Each request carries Turnkey's API-key stamp (`X-Stamp`: an ECDSA P-256 signature over the exact body, made with `node:crypto`; no Turnkey SDK). Mynt polls `/public/v1/query/get_activity` while it waits for approval. Mynt checks every signature Turnkey returns, before it is used, against the custody address and the exact message it sent; one that doesn't verify, or a transaction Turnkey changed, is refused and nothing is sent to the cluster. Requests go only to Turnkey's API host, under Mynt's outbound rules.

**When anything goes wrong after Turnkey has been asked:** an approval that timed out, a refusal, a signature that didn't verify, a send that failed or wasn't confirmed. Mynt then sends one transaction from the deploy payer that advances the nonce and closes the buffer (signed by the buffer key, still its authority). Advancing the nonce makes every message signed on the old nonce permanently invalid. That includes a signature Turnkey produces later because someone approved the activity after Mynt stopped waiting, and a fully signed transaction Mynt sent that might still be in flight. If the deploy did land after all, its buffer is gone, so only the nonce is advanced, and the retry records the deploy from the chain. If even that transaction can't be sent, the program's next custody deploy advances the nonce anyway. A late signature was never usable on its own in any case: the transaction also needs the deploy payer's and the buffer key's signatures (and, for a first deploy, the program's own keypair), which only Mynt holds. Start the deploy again and approve the new activity.

What stays the same: mainnet is still refused until the RPC is set, the backend is ready and an admin sets `enabled: true`. The custody key never pays for or signs a developer's call: calls pay with each developer's own fee payer and sign with their caller key, no call may name the deploy authority, and mainnet calls need those per-developer keys in Mynt's vault (the `mainnet-vault` backend). Recovering an interrupted deploy only compares the program's on-chain authority with the custody address; it signs nothing.

**What the operator sets up in Turnkey**, step by step (values are referred to by name; nothing secret goes in a chat, a ticket or the repository):

1. **Organization.** Sign in to Turnkey's dashboard and create an organization for Mynt's mainnet deploys (or use an existing one). Copy its organization ID: this is `TURNKEY_ORGANIZATION_ID`.
2. **Solana wallet account.** Under Wallets, create a wallet for Mynt and give it one Solana account (curve Ed25519, address format Solana, path `m/44'/501'/0'/0'`). Copy the account's address: this is the custody address. Back up the wallet the way Turnkey's dashboard offers; Mynt can't recover it.
3. **A user for Mynt.** Under Users, add a user for Mynt (for example "Mynt deployer") with API-key access only. Keep it out of the root quorum: root users skip policies, and this user must be bound by one.
4. **Its API key, made on the server.** On Mynt's server, generate a P-256 API key pair with Turnkey's CLI (`turnkey generate api-key --organization <organization ID> --key-name mynt-deployer`). The private key stays in a file on the server, readable only by Mynt's user. In the dashboard, add the public key to the Mynt user as a new API key. The public key (66 hex characters, compressed) is `TURNKEY_API_PUBLIC_KEY`; the private key (64 hex characters) is `TURNKEY_API_PRIVATE_KEY`.
5. **A policy that limits the key.** Turnkey's policy language reads a Solana transaction: its account keys (the fee payer first), programs, system transfers, and each instruction's program, accounts in order (`accounts[1].account_key`), and data as hex, which can be sliced (`instruction_data_hex[0..8]`, the 4-byte tag). It has the list functions `all`, `any`, `filter` and `count`. `&&` and `||` don't short-circuit, and an allow policy whose condition can't be evaluated (an index out of range) doesn't allow. Sources: Turnkey's [policy language](https://docs.turnkey.com/concepts/policies/language) (the Solana fields, string slicing, list functions, keywords such as `wallet_account.address`) and its [Solana policy examples](https://docs.turnkey.com/concepts/policies/examples/solana) (`instructions[0].accounts[0].account_key`, `instruction_data_hex`). The policy below checks positions, not signer flags. The custody address signs the whole transaction, so Turnkey may show it as a signer wherever it appears, including as the buffer's new authority. The docs don't say, so the policy doesn't depend on it. It's also in [`turnkey-solana-policy.json`](turnkey-solana-policy.json), which Mynt's tests evaluate against every transaction Mynt asks Turnkey to sign and against transactions it must refuse (`core/test/turnkey-policy.js`), so the policy and the transactions can't drift apart. Under Policies, add this allow policy, with the custody address, the Mynt user's ID and the approvers' IDs filled in:

   ```json
   {
     "policyName": "Mynt deploys: the custody address signs one Deploy or Upgrade, nothing else",
     "effect": "EFFECT_ALLOW",
     "consensus": "approvers.any(user, user.id == '<Mynt user ID>') && approvers.any(user, user.id in ['<approver 1 ID>', '<approver 2 ID>'])",
     "condition": "activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && activity.params.type == 'TRANSACTION_TYPE_SOLANA' && wallet_account.address == '<custody address>' && solana.tx.address_table_lookups.count() == 0 && solana.tx.account_keys[0] != '<custody address>' && solana.tx.transfers.all(t, t.from != '<custody address>') && solana.tx.program_keys.all(p, p in ['11111111111111111111111111111111', 'BPFLoaderUpgradeab1e11111111111111111111111']) && solana.tx.instructions.all(i, (i.program_key == '11111111111111111111111111111111' && i.accounts.all(a, a.account_key != '<custody address>')) || (i.program_key == 'BPFLoaderUpgradeab1e11111111111111111111111' && i.instruction_data_hex[0..8] in ['02000000', '03000000', '04000000'])) && solana.tx.instructions.filter(i, i.program_key == 'BPFLoaderUpgradeab1e11111111111111111111111' && i.instruction_data_hex[0..8] in ['02000000', '03000000']).count() == 1 && solana.tx.instructions.filter(i, i.program_key == 'BPFLoaderUpgradeab1e11111111111111111111111' && i.instruction_data_hex[0..8] == '04000000').all(i, i.accounts.count() == 3 && i.accounts[1].account_key != '<custody address>' && i.accounts[2].account_key == '<custody address>')"
   }
   ```

   **What it allows:**
   - The custody address signs, but it doesn't pay: it isn't the fee payer (`account_keys[0]`) and no transfer comes from it.
   - No address lookup tables.
   - Only two programs:
     - the system program, with the custody address in none of its instructions (so the nonce advance and the program account's creation pass);
     - the upgradeable loader, whose instructions are exactly one Deploy (tag 2) or Upgrade (tag 3), plus SetAuthority (tag 4) handing a buffer to the custody address. That means the custody address in position 2 (the new authority) and not in position 1 (the current authority, who signs).

   **Everything else is refused:**
   - transfers of the custody address's SOL;
   - SetAuthority signed by it (giving a program away) and SetAuthorityChecked (tag 7);
   - Close (tag 5) and buffer writes;
   - other programs;
   - raw payloads and key exports.

   The filters are written so the position checks only run on SetAuthority instructions. Since `&&` and `||` don't short-circuit, indexing the accounts of every instruction would fail on system instructions with fewer than three accounts, and the policy would refuse Mynt's own deploys. Turnkey gives `&&` and `||` the same precedence, grouped left to right, so every clause that mixes them is in parentheses; the tests check the policy means the same under either grouping. Nothing else is allowed for the Mynt user.

   **Try it once against real Turnkey before mainnet.** Mynt's tests evaluate this policy with an interpreter written from Turnkey's documentation, not with Turnkey's own engine. Before enabling mainnet, run one custody deploy of a small test program with this policy in place (an approver approving), and check in Turnkey's activity log that it was allowed by this policy. Also check that a transfer from the custody address, asked for with the same API key, is denied. If Turnkey reads a field differently from these docs, this is where it shows. One assumption in particular: the policy reads each instruction's 4-byte tag as `instruction_data_hex[0..8]`, assuming the slice's end is exclusive (`'abc'[0..2]` is `'ab'`), which Turnkey's reference doesn't state. If Turnkey's end were inclusive, no tag would match and Turnkey would refuse the test deploy (the policy fails closed, never open); then change each `[0..8]` to `[0..7]`.

   **What a looser policy would allow.** `solana.tx.program_keys.all(p, p in [system, loader])` on its own (an earlier version of these steps) still lets the API key move all of the custody address's SOL with a system transfer, give away any program with SetAuthority or SetAuthorityChecked (tags 4 and 7), close a buffer or program (tag 5), and Upgrade (tag 3) any program the custody address controls. Use the policy above instead.

   **What the tight policy still allows.** Whoever holds the API key can still hand a buffer of their own to the custody address and Upgrade any of its programs to that code: the policy can't tell Mynt's buffer from anyone else's. So **require a person's approval for every activity** (the second clause of the consensus above), which now means one approval per deploy or upgrade. Approvers should check the program in Mynt (`get_program`, `list_all_programs`) before approving. To narrow it further, add `&& solana.tx.instructions.all(i, i.program_key != 'BPFLoaderUpgradeab1e11111111111111111111111' || i.instruction_data_hex[0..8] != '03000000' || i.accounts.any(a, a.account_key in ['<program IDs>']))` to restrict upgrades to programs you list, at the cost of updating the list for each new program.
6. **The server.** The operator sets `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_API_PRIVATE_KEY` in Mynt's environment file on the server, optionally `TURNKEY_APPROVAL_TIMEOUT_SECONDS` (how long Mynt waits for an approval: default 60, at most 1800), and restarts Mynt. Mynt checks that the private key belongs to the public key; if any is missing or wrong, `configure_solana_signer` says which, without showing it.
7. **Mynt.** An admin calls `configure_solana_signer` with `backend: "custody-service"`, `custody_provider: "turnkey"` and `custody_address` set to the custody address, then calls it with no arguments: `missing` lists anything still to do, and `deploy_payer` is the address Mynt pays deploys from. The operator funds **the deploy payer** with SOL (as above: the program's rent, the buffer's while it's written, and fees). The custody address needs no SOL. Then the admin sets `enabled: true`.

To rotate the API key, add the new public key to the Mynt user, replace the two `TURNKEY_API_*` variables, restart Mynt and delete the old key in Turnkey. To move the deploy authority itself, transfer each program's upgrade authority on chain first; the custody address is the upgrade authority of everything deployed through it.

### Product health: an on-chain record licence providers can trust

Licence providers and liquidity providers watch each product's financial health from a record that can't be rewritten, to pull a licence on bad behaviour or move capital. Mynt never holds funds and no customer data goes on chain; this feature only reports.

**What a snapshot is.** On a schedule (`PRODUCT_HEALTH_INTERVAL_MINUTES`, default 60, at most 1440), for each product with an approved sponsorship (and each pool, when pools exist), Mynt computes one report: reserves and customer obligations, the coverage between them, flows in and out, pending settlements, reversal and failure rates, open withdrawal requests, open complaints and incidents. Money is integer cents; ratios are integer basis points. **A figure Mynt can't measure is null with its reason, never 0**: coverage with no obligations is null, not infinite, and complaints and incidents are null until Mynt tracks them. `open_withdrawal_requests` is measured from the queues of the product's real [liquidity pools](#liquidity-pools).

**Where the numbers come from.** Reserves and obligations come only from the licence provider's own systems, through a `PartnerLedger` (`core/src/partner-ledger/`), never from the developer's app. Until a sponsor connects its own, its snapshots read the **sandbox** ledger: made-up figures marked `source: sandbox` that can never read as live, whatever the product's status or any stored row says. A sponsor connects its books with the [partner kit](#partner-kit-connecting-a-licence-providers-ledger) (an HTTPS feed Mynt pulls, or a signed daily file), and its snapshots read them once it passes conformance and switches. A ledger read that fails makes the snapshot `source: unavailable`, with those figures null. `partner_ledger` only ever means a ledger that declares itself live.

**Flows** come from the money rails' `flowsFor(store, productId, from, to)` when that module is present: `on_ramp` and `deposit` are money in, `off_ramp` and `payout` are money out, `requested` and `submitted` are pending. What the rails can't measure stays null with their reason, and a direction they can't see is listed in `flows_not_measured`. **What they measure, stated in every report as `flows_basis`:** the rails total movements by when they were requested, so a period's figures are that period's requests by their status when the snapshot was computed. `requested_*` is everything requested; `flows_*` is the part already settled, so a payment that takes days to settle shows as pending and isn't counted in a later period. Movements nobody ever answered for are `unresolved_cents`, counted in `requested_*` and no other total. A figure that totals only the directions the rails can see is marked `partial`, with a `reason` saying what it leaves out. Reversal and failure rates are by value among this period's completed requests, rounded up; coverage is rounded down. A sandbox report carries no flows at all: the rails exclude sandbox movements, and real money doesn't belong beside test figures.

**Fingerprint.** Each report is encoded as canonical JSON (keys sorted, no spaces, integers only, so the same report always has the same bytes) and its sha256 is the fingerprint. The report carries a random salt, so the numbers can't be guessed from the public fingerprint.

**Encryption.** Each product has its own random AES-256-GCM data key, sealed under `MYNT_VAULT_KEY`, and each report is encrypted with it, bound to its product, sequence and fingerprint so it can't be edited or moved. The server opens a report only for entitled readers, through `get_product_health`: the members of the sponsoring licence provider's firm, and the firms holding a settled position in one of the product's real [pools](#liquidity-pools), who need the `liquidity_provider` role and read only the books of those pools' sponsors. A liquidity provider that has fully exited loses access to new snapshots: it can still read those up to its exit, and a new settled commitment brings the rest back. A sponsor reads only the snapshots whose numbers came from its own books, so a second sponsor doesn't see the first's. A withdrawn sponsorship, or a firm that isn't active, ends access at once. Reading needs the named licence-provider role, and an account with the admin role is refused even if it also holds that role or belongs to the firm: an admin account gets status and fingerprints, and can't itself open a firm's books, replace its key or co-sign for it. An admin can still add a separate non-admin account to a firm, which is audited, so this is a control that leaves a trail and not an absolute bar on Mynt's staff. What this means plainly: Mynt's server computes the numbers and holds the vault key, so it could read them. The encryption keeps them from the database, its backups and everyone else; it doesn't keep them from a compromise of the server's vault key.

**Partner co-signature.** A licence provider registers its firm's Ed25519 public key (`register_partner_signing_key`; small-order keys are refused, and every key it has registered is kept, so an old signature stays checkable after a rotation); its private key never reaches Mynt. A snapshot waits for the partner during a window (`PRODUCT_HEALTH_COSIGN_WINDOW_MINUTES`, default half the interval and never more). The partner signs the UTF-8 text `mynt.product_health.cosign.v1`, one zero byte, then the 32 bytes of the fingerprint. `submit_partner_signature` must verify with the firm's registered key while the firm still sponsors the product and before the window closes, or it's refused. With no signature by the deadline the snapshot is published as `mynt_only` and says so.

**What `verified` means.** `verified` is true only for a published snapshot from a real ledger on a live product, with a valid partner signature and a chain that matches. Sandbox, unsigned and missed snapshots never are. It's worked out on every read from the authenticated report and the signature, not from stored flags. Someone who can only write the database can't forge it: reports are authenticated, signing keys are MACed under a key derived from the vault, and a published row that's changed stops matching the chain. Someone holding `MYNT_VAULT_KEY` could still forge a snapshot before it's published, and a snapshot that never reached the chain has only Mynt's word behind it. `verification.integrity_ok` is a smaller claim: the report matches its fingerprint and the record matches the chain. A missed period's report is withheld, since it never reached the chain.

**The program.** `core/programs/product-health` is a Mynt-owned Anchor program that holds a head account per product: the sequence number, the fingerprint, the period, the source flag, a per-product commitment to the partner's key and signature, Mynt's signing key, and a sha256 hash chain over every field of every record, with an event for each. A product appears on chain only as a keyed hash of its id (HMAC under a key derived from the vault), so a guessed id can't be tested, and the commitment doesn't link a partner's products. It moves no value and calls no token program; the publisher is set once at initialisation by the program's own upgrade authority, and there's no hard-coded key. Periods must be contiguous and can't end in the future. It passes Mynt's own [mainnet gate hard rules](#mainnet-program-gate) (checked in CI on what the compiler read, with the bytes and IDL), with one reviewed lead, that it reads the clock. It publishes to **devnet only**.

**What the chain does and doesn't prove.** The program can't check the co-signature: `partner_signed` on chain says only that the publisher supplied a commitment. A reader checks the signature against the partner's key and the commitment, as `get_product_health` does; an on-chain Ed25519 check would have to publish the partner's key, and needs deciding before mainnet. The publisher can't be rotated without a new deployment. The hash chain makes a changed record visible, but whoever holds the upgrade authority can replace the program until it's frozen or put behind a timelock.

**Publishing.** Sequence numbers are gapless per product: the program accepts only the next one, and Mynt sends each in order. Sends go through Mynt's RPC client (its retries and backoff), and Mynt reads the head before it concludes anything: a record that landed unseen is adopted even past its deadline, and while the chain can't be read nothing is marked missed. A snapshot not on chain by its deadline, or a stretch Mynt never computed, is recorded as `missed` and gets a marker on chain. Every period starts where the last ended, so changing `PRODUCT_HEALTH_INTERVAL_MINUTES` can't overlap one. `list_product_health` and `get_product_health` report gaps: `no_record`, `missed`, `stalled`, `sequence_gap`, `period_gap`, `overdue`, `re_anchored`, and the chain being `chain_behind` or `chain_ahead` of Mynt's record. `ops_status` flags stalled records, snapshots past their deadline, and a worker that isn't running while products are sponsored.

**Checking it without Mynt.** `get_product_health` gives entitled readers, and nobody else, each snapshot's `partner_key` and `partner_signature`, and the record's `subject` and `head_address`. `core/scripts/product-health-verify.mjs` uses nothing but Node and an RPC of your choosing. Mynt wrote the answer it reads, so it believes nothing the answer says about where to look. Save the tool's answer to a file and run:

```
node product-health-verify.mjs --file answer.json --rpc <url> --program-id <address> --partner-key <your firm's key>
```

**Get `--program-id` from outside Mynt's answers:** the operator gives it to you directly, in writing, when the program is deployed (for example with your sponsorship paperwork), and `--partner-key` is the key your own firm holds. The script derives the head's address from the program id and subject, and checks that the account is owned by that program and is a `Head` account, that the report hashes to the fingerprint, that the signature verifies under your key, and that the head holds that fingerprint, period, source and commitment. For an older snapshot (`--sequence N`, with `--epoch E` for an earlier record) it decodes the `record_snapshot` instruction of its transaction instead. It prints `OVERALL PASS` and exits 0 only when everything was checked; without `--partner-key` it says the key wasn't independently checked and exits 3. One limit it can't close: the subject is a keyed hash, so it proves this report was recorded under that subject, not that Mynt filed it under the right product.

**After a chain reset or a new program,** a record the chain no longer holds stalls in the open. An admin calls `reanchor_product_health` (`product_id`, `reason`). It works only when the chain has no record for the product under the current program and no transaction history at that address (history without a head means it wasn't a reset, and a history that can't be read refuses too), and only after something reached the old chain or the program changed. A head that disagrees with Mynt's record is refused, because that needs investigating. Anchor rows are MACed under a key derived from the vault, and one that fails reads as a mismatch. Refusals are audited. The record restarts at sequence 1 in a new epoch, and the old record's verdict, head sequence and chain hash are saved with it. Its snapshots stay readable and report `previous_chain_matched`, `previous_chain_mismatch` (it didn't match, or a row has changed since) or `previous_chain_unverifiable` (the old chain is gone). The re-anchor and every hole in the old record stay visible as gaps.

**The publisher key** is its own devnet key in Mynt's vault (never the deploy authority). `HealthPublisher` (`core/src/solana/product-health-chain.ts`) reads every message back before signing and refuses anything but the product-health program's own instructions, paid for by the publisher.

**Tools.** `list_product_health` (licence providers, committed liquidity providers, the product's own firm, admins: fingerprints and status only), `get_product_health` (entitled readers: the decrypted report, whether it matches its fingerprint, whether the fingerprint matches what's on chain, and history), `register_partner_signing_key`, `submit_partner_signature`, and for admins `reanchor_product_health`. `get_product_health` reports `verification.on_chain` as `matches`, `mismatch`, `pending`, `not_on_chain`, one of the `previous_chain_*` verdicts or `unavailable`: when the chain can't be reached it says so, and is never reported as a match.

**Deploying it** is an operator step, never CI. From a checkout on the server, with its environment loaded: `core/scripts/product-health-deploy.sh --program-keypair <new-program-keypair.json> --authority <upgrade-authority-keypair.json>` builds the program with the pinned toolchain, checks the hard rules, deploys to devnet, creates the publisher key in the vault and names it on chain (`mynt product-health publisher`, `mynt product-health init`). Then the operator sets `PRODUCT_HEALTH_PROGRAM_ID` on the server and restarts. Until it's set, the worker doesn't run and `get_product_health` reports the chain check as unavailable.

### Partner kit: connecting a licence provider's ledger

A licence provider's engineers connect its systems themselves and see pass or fail, as vendors do; [docs/partners.md](partners.md) is their guide. Mynt needs three things: (a) its ledger, per sponsor per product, signed; (b) customers' verified home states (see "Partner requirements"); (c) money rails (see "Approved money rails"). The code is `core/src/partner-kit.ts` and `core/src/partner-ledger/contract.ts`; the schemas are in [`core/schemas/partner-ledger/`](../core/schemas/partner-ledger).

**The HTTPS feed.** Mynt is the client: `POST <url>/v1/ledger`, signed with `Mynt-Signature` (HMAC-SHA256, as the vendor wire contract) under a per-firm request secret, through the vendor outbound rules (`core/src/vendor-call.ts`: HTTPS on 443, public addresses only, no redirects, a time limit, 1 MiB). The signed body names its `audience`, the exact URL it was sent to, and the partner refuses any request whose audience isn't its own URL, or whose `environment` isn't the one that deployment serves: a request can't be relayed to the partner from an address someone else controls. Endpoints are an origin and a path only (no query string or fragment). An admin proposes them (`configure_partner_ledger`, audited), the firm is told on its webhooks (`partner_ledger.endpoint_change_pending`), and they take effect only when the firm's own licence-provider member confirms them (`confirm_partner_ledger_endpoints`); `get_partner_kit` shows a pending change plainly. The firm takes the request secret once (`reveal_partner_ledger_secret`, `rotate_partner_ledger_secret`), which admins never see. The partner answers with a statement (`mynt.partner_ledger.v1`): integer cents per product, null with a reason where it can't give a figure, an `as_of` time, and an Ed25519 signature over the text `mynt.partner_ledger.v1`, a zero byte and the statement's canonical JSON (RFC 8785, integers only). Live statements are signed with the key from `register_partner_signing_key`; test statements with a separate test key (`register_partner_test_signing_key`, MACed under a key derived from the vault, and never the same key), so a test-key signature is never valid for live and the other way round. `HttpPartnerLedger` uses a statement only when the schema, the firm, the `live` environment, the echoed `request_id`, the live-key signature and the clock (at most 300 s ahead, at most `PARTNER_LEDGER_MAX_AGE_HOURS`, default 24, old) all pass; otherwise the snapshot is `unavailable`. A product the statement leaves out is null, "didn't cover this product". Each round asks once per firm for every product it sponsors, with `PARTNER_LEDGER_TIMEOUT_MS` (default 10 s), and firms are read in parallel, so a slow partner holds up only its own products.

**The daily file.** A firm without an API uploads the same statement, with `request_id: null`, using `upload_partner_ledger_file` (licence-provider members only, never admins). It's refused unless it passes the same checks with that environment's key, isn't older than `PARTNER_LEDGER_FILE_MAX_AGE_HOURS` (default 36) and is newer than the firm's last file for that environment. It's stored sealed under `MYNT_VAULT_KEY`; admins see only its time and product count. On every read it's checked again against the firm's current live key (a replaced key stops it counting at once) and its age. A `test` file is for conformance only.

**Conformance.** `run_partner_conformance { source: "http" | "file" }` (the firm, or an admin naming it; the firm must be active) checks (a): for `http`, Mynt calls the test endpoint for every product the firm sponsors plus one it made up, and checks the schema, firm, environment, `request_id`, test-key signature, clock, null handling, coverage, that the made-up product comes back null with a reason, and that a badly signed, a stale (600 s), a malformed, a wrong-environment (`live` sent to the test endpoint) and a wrong-audience request are each refused with an error body. It probes the live endpoint once, without asking for figures: a live request whose audience is the test endpoint's URL, naming only a product Mynt made up, must be refused (`live_wrong_audience_refused`; whatever comes back is dropped unread); for `file`, the same statement checks on the latest upload. The endpoint version a run tested is the one read at its start. It checks (b) by calling each identity provider the firm accepts (its own identity offerings, and those approved for its sponsorships) in its test environment, and passes when one answers a passed check with a valid `residential_state`. It reports (c) from the firm's rails and their offerings' latest `run_conformance`. Each run is kept with its time and `expires_at` (`PARTNER_CONFORMANCE_MAX_AGE_DAYS`, default 30) and shown by `get_partner_kit` (the firm, or admins naming it) and in `get_my_entity` as `partner_kit`. No case or problem ever carries a figure.

**Going live.** `set_partner_ledger_source { source }` switches the firm from `sandbox` to `http` or `file` only when that source's latest run passed its ledger part and hasn't run out; for `http` it also reads the live endpoint once and checks the statement, which must carry the live key's signature (the figures are discarded), and for `file` it needs a fresh live file. The choice is made again on every snapshot (`partnerLedgerFor`): a firm whose endpoints changed, or whose pass ran out, reads the sandbox until it passes again. If the choice can't be made (the database fails), the ledger is `unknown` (`ledgerState`), never taken for sandbox. (b) and (c) don't hold up the switch, because each money movement already checks them. Admins can send a firm back to `sandbox`, never to live, and the firm is told (`partner_ledger.source_changed`). Every change is audited, and the kit's tools and `register_partner_signing_key` need the firm to be active.

**Who can change what Mynt reads as a firm's books.** A licence provider's own member, and only after a **member cool-off**: `PARTNER_MEMBER_COOLOFF_HOURS` (default 72) from the later of the account's creation and its joining that firm. Inside it a member can't register or replace the live key, confirm endpoints, upload a live daily file or switch the ledger source to live (test keys, test files and conformance runs are fine: a test key can never sign live books). **Standing goes with the role.** What counts at a licence provider is an account's licence-provider *standing* there (`users.lp_since`), not its roles or its membership alone. A firm's first ever licence provider has standing at once, and that marks the firm established (`entities.lp_established_at`, set in the same transaction with the firm's row locked, and backfilled for firms that already had one). After that, standing comes only through a request (`firm_member_requests`) an existing licence provider accepts with `decide_firm_member` (declining ends it and removes the account from the firm), even if every licence provider the firm had has since lost the role, whichever way the account got there: added by an admin as a licence provider, or already a member (say as a consumer) whose roles later gain `license_provider` through an invite applied at its next sign-in. Until it's accepted it has no licence-provider powers at all: Mynt resolves its roles without `license_provider` (`rolesWithStanding` in `core/src/store.ts`, applied to every account read from the store and to each session's tools), so it gets none of a licence provider's tools, can't open sealed product-health or pool figures, approve or decline sponsorships, set covenants, revoke under a breach, register a key or decide anything, and the services that re-read the account refuse it too. Losing the role ends the standing. The one deciding must have had standing since before the request was made and be past the cool-off, and an account that has meanwhile joined another firm can't be accepted. The cool-off and the "joined before" order count from the latest of creation, joining and gaining standing. Licence providers from before standing existed were given it once, from when they joined. Losing standing (the role taken away, or leaving the firm) is recorded (`firm_standing_history`) and told to the firm (`firm.member_standing_lost`).

**When nobody can decide.** If no licence provider of the firm has had standing since before a request and is past the cool-off (all of them were demoted, say), the request stays pending, and only an admin's recovery settles it: `recover_firm_member { request_id, reason }` tells every current and past licence provider of the firm (`firm.recovery_pending`, as a notice each and on the firm's webhooks) and starts a 7-day wait; calling it again after the wait completes it. During the wait any past licence provider of the firm, even one whose role has since been taken away, can block it with `block_firm_recovery` (which any signed-in account has), declining the request; the block is audited and told to the same people. A recovery, started or completed, is refused while the firm has someone who can decide, while any past licence provider of the firm (other than the account the request is for) can't sign in (its whitelist entry gone or sign-up blocked, as `revoke_user` does), and for 30 days after any of them lost standing there through an admin's action: moved to another firm by `add_entity_member` (whose result says so), roles rewritten by an invite (including being made an admin, `admin_promoted`), or revoked (`revoke_user` now ends standing too). Completion re-checks the lock and the deciders, and makes the grant, in one transaction with the firm's row locked. A past licence provider can block even if it holds the admin role now, but not a recovery it started. The cause is kept in `firm_standing_history`, and the refusal names the reason, never the person. It takes one admin, not two, because production has one; a second admin's sign-off would be stronger, and is left for when there are two. Each of those, and every member added or asked for (`add_entity_member`), is told to the whole firm: an event on its webhooks (`firm.member_pending`, `firm.member_added`, `firm.member_standing_lost`, `firm.recovery_pending`, `partner_ledger.endpoint_change_pending`, `partner_ledger.key_changed`, `partner_ledger.endpoints_confirmed`, `partner_ledger.source_changed`, `partner_ledger.approval_requested`, `partner_ledger.conformance_expiring`) and a notice to each existing member (`list_firm_notices`). A live key change or a switch to live waits for the approval (`approve_partner_kit_change`) of a licence-provider member past the cool-off who became a member before the requester did (by effective join time, the later of creation and joining), so two accounts that joined together can't approve each other. Requests last 7 days; a newer request of the same kind, or a direct registration, supersedes older ones. Approving a live key change claims the request, changes the key and marks it approved in one transaction; approving a switch claims it (`approving`, with `approving_at`), makes the switch with every check again, and puts it back to `pending` if that fails, so a decline can't land under a change in flight. A request left `approving` for more than 10 minutes is put right from what's actually there: approved if the key or source it asked for is in place, otherwise back to `pending`. The firm's earliest member, and a one-member firm's only member, need no approval: safe only because nobody joins a firm with members without one of them accepting it. Keys: a key ever registered as a test key, by any firm, is never accepted as a live key, and the other way round (each history is kept, MACed).

**What's left: the insider.** These controls stop an account added to a firm, by an admin or anyone else, from quietly taking over its books: it waits out the cool-off in plain view of the firm's existing members, and, where there are two, needs the other's approval. They don't stop a firm's earliest member, or a one-member firm's only member, past the cool-off, or two long-standing members acting together, or an admin who bootstraps a firm's first ever licence provider (an empty firm has nobody to ask), or an admin's recovery that nobody who has been a licence provider at the firm blocks in its 7 days. Such a person can register a key and serve figures the firm's real books don't support, and those figures read verified, which drives pools' reserve checks. Mynt can't tell a firm's own people from its books; a firm that wants more should keep at least two members and act on its notices.

**Covenants on a sandbox ledger.** A published product is never judged on sandbox figures: a sandbox-sourced snapshot reads `unknown` ("the sponsor's ledger isn't live"), not sandbox, and past a pause rule's unknown limit it pauses the product, because only the sponsor can end it, by connecting its books. Every other unknown still only alerts. An unpublished product is judged sandbox-only by the snapshot's own `source`, and without a snapshot by the ledger the firm is on now; a ledger Mynt can't tell is never taken for sandbox.

**Running out.** A firm on a live source is warned once, `PARTNER_CONFORMANCE_WARN_DAYS` (default 7) before its pass runs out (`partner_ledger.conformance_expiring`), and told once when it has and its snapshots went back to the sandbox (`partner_ledger.source_changed` with `reason: conformance_expired`).

### Covenants: a licence provider's rules on a product it sponsors

A licence provider watches each product it sponsors and pulls its licence on bad behaviour it can see. It says what bad behaviour is: each **covenant** is a rule on one sponsorship, set by that firm alone, and each rule chooses whether a breach only **alerts** the firm or also **pauses** the product.

| Rule (`rule_type`) | Threshold | Breached when |
|---|---|---|
| `coverage_below` | basis points | coverage is under it |
| `reversal_rate_above`, `failure_rate_above` | basis points | the rate is over it |
| `unresolved_above` | cents | unresolved money is over it |
| `complaints_above` | a count | over it. Mynt doesn't track complaints yet, so this rule reads `unknown` until it does |
| `snapshot_missed_for` | seconds (at least two snapshot intervals) | no authenticated snapshot with real figures has arrived for longer than this (a missed period, a failed ledger read and a report that can't be authenticated don't count) |
| `consecutive_gaps` | periods (at least 1) | this many periods in a row have no snapshot, counting a stretch the worker never wrote down |
| `unverified_for` | seconds (at least two snapshot intervals) | a live product has had no valid co-signature from this sponsor for longer than this. Only time the product was live counts (a blip off sale of up to about one snapshot interval counts as live), so a relaunch doesn't breach at once and publishing again doesn't restart it. A sponsor whose books aren't the latest snapshot's reads `unknown` (only that firm can sign), and alerts through the unknown limit |

Each rule also has a `severity` (`info`, `warning`, `critical`), a `cooldown_seconds` (the least time between alerts of that rule, default a day) and an `unknown_limit_seconds` (default a day).

**When it's evaluated.** On every new health snapshot, and on its own timer (`COVENANT_POLL_MS`, default a minute), which runs whether or not the product-health worker is deployed, so a rule about missing snapshots fires even when the worker has never run. A rule changed with `set_covenant` takes effect from the next evaluation, which re-judges the latest snapshot. A product that isn't live isn't evaluated and raises no alarms. Evaluation covers a product's own record, not a pool's.

**`unknown` is not `pass`, and not a breach.** A figure Mynt can't measure, a missed period, a report it can't authenticate, and another sponsor's books (a sponsor reads only its own) all read `unknown` with the reason. A figure marked `partial` can't be called a pass; a partial *total* that is already over the limit is a real breach, because it can only understate. A figure rule whose latest snapshot is more than two intervals old reads `unknown` and judges nothing, for or against, until a fresh snapshot arrives (snapshots too old to act on are audited with their count and range, and if any would have breached, a breach of kind `historical` records it, already closed and pausing nothing), so a record that has stopped moving can't go on passing or start a pause. A rule that stays unknown past its `unknown_limit_seconds` opens a breach of kind `unknown_limit`, which alerts and **never pauses**: not knowing isn't evidence of bad behaviour.

**Sandbox.** Sandbox figures never pause anything as figures. On a product that isn't published, a snapshot with `source: sandbox` is evaluated and its breach is labelled `sandbox`. On a published product it isn't judged at all: the rule reads `unknown` ("the sponsor's ledger isn't live"), and past a pause rule's unknown limit that pauses the product (the one unknown that does, since only the sponsor can end it by connecting its books with the [partner kit](#partner-kit-connecting-a-licence-providers-ledger)). Without a snapshot (time-based rules, no record yet, a missed period), a published product's result is never labelled sandbox, and an unpublished one goes by the ledger the firm is on now; a ledger Mynt can't tell is never taken for sandbox. A sandbox result can't close a breach opened on live figures, and a pass on sandbox figures doesn't count for a release. A firm's own books count once it connects them with the [partner kit](#partner-kit-connecting-a-licence-providers-ledger).

**Breach record.** Append-only, enforced in the database: each breach keeps the rule and its threshold, the snapshot's epoch, sequence and fingerprint, the observed value, the action taken, the severity, the cooldown outcome, and when it opened. A figure from the report is stored sealed, as the report is; durations and period counts aren't the firm's books and are stored as they are. Everything that follows (resolved, acknowledged, paused, released, reminders, a rule loosened, a revocation) is a separate append-only event on the breach, with who and when. `list_covenant_breaches` gives the firm the whole record; `action_taken` is one of `alerted`, `alert_undelivered`, `alert_suppressed_by_cooldown`, `paused`, `paused_alert_undelivered`, `pause_pending_publication`, `historical_not_acted_on`, `pause_failed_no_pins` (a live product with no pinned state, which drift can't hold) or `sandbox_labelled`.

**Alert.** `covenant.breached` and `covenant.cleared` go to the licence provider's own firm webhooks (`create_firm_webhook`), signed as every webhook is, and the firm can create them. The numbers (`threshold`, `observed`, money in flight) travel sealed until sent and arrive as `data.result`. A rule still failing past its cooldown repeats `covenant.breached` with `reminder: true`. A cooldown holds back alerts only: a breach inside it is still recorded (`alert_suppressed_by_cooldown`), and a pause still happens and always alerts. A hook's `covenant.*` events need a named `license_provider` role and no admin role, on creating it and deleting it, and the creator's current roles are checked when a delivery is queued and again when it's sent, so a later role change takes effect; a default webhook created by anyone else doesn't include them. When a hook's creator no longer qualifies the hook shows `blocked` in `list_firm_webhooks` and is raised in `ops_status`. After a relaunch, `snapshot_missed_for` and `consecutive_gaps` count only from the relaunch. An alert that reached no webhook, or was held back at send, says so, and starts no cooldown: `alerted` is false, `action_taken` is `alert_undelivered` or `paused_alert_undelivered`, and the breach has an `alert_undelivered` event. `ops_status` counts paused products, open breaches, rules unknown past their limit and a covenant timer that isn't running; it doesn't show anyone's figures.

**Pause.** A `pause` rule that fails on live figures pauses the product, and anything built on it, through drift, with a change of kind `covenant` naming the rule (`id` is the covenant, `rule_type` its type; no threshold or figure). New sales stop, as with any drift. **It stops new sales only**: it cancels nothing, and the money movements in flight when it took effect are reported in the breach (`in_flight_when_paused`: count and cents). New movements for customers already enrolled aren't blocked by a covenant pause, because drift never blocked them. A paused product stays paused through the hourly drift sweep and through publishing a new version, until the licence provider calls `release_covenant_pause`, which re-checks the rule first: it must pass, or the firm passes `override_reason`, which is audited and kept on the breach. Unknown counts as not passing. After an override the same open breach doesn't pause again; a later relapse (a pass and then a new failure) is a new breach and pauses again. `release_covenant_pause` doesn't lift other reasons the product is paused. Rules can be deleted, except one holding a pause.

**Revoking under a breach.** `revoke_sponsorship` takes an optional `breach_id`; the breach keeps the revocation, who did it and why. Revocation ends the sponsorship's rules, closes its open breaches and releases its holds; the product stays drifted by the revoked sponsorship itself.

**Who may do what.** Only members of the sponsoring firm whose own roles name `license_provider` can set, change, delete, acknowledge or release, and the firm must be active. An account with the admin role is refused even if it also holds that role or belongs to the firm, as for co-signing and reading a firm's books. There's deliberately no admin exception: a covenant is the sponsor's judgement of its own licence risk, and a Mynt admin who could change it could quietly stop a sponsor's pause. Admins already have `admin_set_product_status` for pausing a product themselves. Admins can see every breach (`list_covenant_breaches`) with its rule type, status, severity, snapshot and timestamps, but not the rule's settings, the sponsor's reasons, the observed figure or the money in flight, for the same reason `get_product_health` refuses them, and `audit_log` shows them the same way. What this means plainly: an admin can see that a firm's rule tripped, not how it's set or the number. The sponsor's own members see figures only while their firm is active and still sponsors the product. An admin account can't revoke a sponsorship either, and a firm can't hold covenants over a product it owns.

**Changing a rule.** Every change to a rule is audited with its old and new values. A sponsor can't loosen a rule (a looser threshold, alert in place of pause, lower severity, a longer cooldown or unknown limit) or delete one while a breach under it is open without giving a `reason`; the reason goes on the breach.

**What the builder sees.** The product's own firm sees `covenant_pauses` in `list_my_sponsorships` (rule type and since when) and the drift record on `get_product` and `get_product_regime` (kind `covenant`, the rule's id and type). It doesn't see thresholds, observed values, severity, breach ids, alert-only breaches, or which other rules exist. Anyone else looking at a published product, and apps' `product.drifted` webhooks, see only that a covenant paused it (`id` shown as `redacted`, no rule type), so a run on a product can't be started from the rule name.

**Tools.** `set_covenant`, `list_covenants`, `delete_covenant`, `list_covenant_breaches`, `acknowledge_breach`, `release_covenant_pause`, and `revoke_sponsorship` with `breach_id`.

### The product desk (innovators)

The desk answers one question for a firm: does this product make sense, financially and legally? Each firm connects its own GitHub repository as its **workspace** (`connect_desk_repository`, after installing the Mynt GitHub App on it). Its computational logic accumulates there as models: `models/<name>/model.json` declares which products a model applies to, the inputs it needs, and how to run it. The code reads the product, its term sheet and the relevant regulation, and writes a report: a verdict (feasible, marginal or infeasible), metrics, checks that cite the law by `legal_ref`, and stress scenarios.

Work is split by what it needs:
- **Code runs (no AI).** `analyze_product` checks the workspace for a model that applies. If the product's term sheet (`set_product_terms`) has that model's inputs, Mynt clones the repository in a sandbox and executes the model. This is deterministic and re-runnable, costs cents, and never involves an agent. The clone token is removed before any model code runs. If inputs are missing, you get the list to fill in.
- **Agent tasks (intelligence).** If no model applies yet, or you ask for one with `desk_task` (e.g. "add an ALM liquidity ladder for our FD book"), the desk agent takes over. That's Claude Code in a sandbox, through Mynt's agent proxy. It designs the model, chooses and states the assumptions, interprets the regulation from the admins' model, and writes the code and tests on a branch. All arithmetic happens in code. **Mynt then runs that branch itself** in a clean sandbox with no credentials, saves that report, and opens a pull request on the workspace with Mynt's numbers. The agent's own numbers are never used.

`test_product` adds an advisory `feasibility` check from the latest report for the current term sheet, and reports stale when the terms changed. `get_product_terms` shows the term sheet and its analysis; `list_desk_jobs`, `get_desk_job` and `stop_desk_job` track the work.

**Configuration:** a sandbox provider key and the GitHub App, plus a model backend for agent tasks. Optional: `DESK_JOB_CAP_USD` (per agent task, default 5), `DESK_RUN_CAP_USD` (per code run, default 1) and `DESK_MONTHLY_CAP_USD` (per firm, default 50; unfinished jobs count at their cap).

**Algorithm explorations.** A product's decision algorithms (the eligibility, underwriting, limit, pricing and fraud-screening entries in its `core_algorithms`) can be improved by experiment. `start_exploration` names one algorithm, an objective to maximise (`net_margin`, `approved_volume`, …) and its constraints: a loss-rate ceiling, an APR cap, a minimum adverse-impact ratio (default 0.8), and reason codes on every decline.
- **Synthetic data.** Mynt generates applicants from the product, deterministically and from a seed (`core/src/explore-data.ts`). It makes a dev set with outcomes for the explorers, and a holdout only Mynt sees. Its assumptions are saved on the job.
- **The explorers.** Up to five run, each taking a different angle (`core/workspaces/algorithm-explorer/angles.json`). They loop in the autoresearch style: one change to the algorithm's folder, a short experiment with Mynt's scorer on the dev set, then keep the change or revert it, logged in `explore-log.tsv`. Each pushes every kept state to its own branch. Its push token is a file that Mynt refreshes, never an environment variable.
- **Mynt's ranking.** Mynt runs each branch's `decide`, and the pinned version as a baseline, on the holdout in clean sandboxes. It runs exactly the commits it pinned: the baseline when the job starts, and each branch's head when its explorer finishes. The holdout comes from a random secret per job that only Mynt holds, so it can't be rebuilt from the job's id or data. Mynt scores the decisions itself (`core/src/explore-score.ts`): the objective, the constraints, and stability over three time slices. Variants that fail a constraint rank below those that pass.
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

**The agent is steered by a workspace folder in this repository**, `core/workspaces/governance-review/`. It's copied into the sandbox and becomes the agent's working directory:

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

**Configuration:** a sandbox provider key, `PUBLIC_URL` and a model backend. Optional: `REVIEW_AUTO_OPEN`, `REVIEW_CASE_CAP_USD` (default 3) and `REVIEW_MONTHLY_CAP_USD` (default 60).

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

**Configuration:** `BD_ENABLED=1`, on top of what builds need (a sandbox provider key, `PUBLIC_URL` and a model backend). Optional: `BD_DAILY_CAP` (default 40), `BD_MAX_UNANSWERED` (3), `BD_FOLLOW_UP_GAP_DAYS` (3), `BD_RUN_CAP_USD` (3), `BD_MONTHLY_CAP_USD` (60), `BD_RUN_EVERY_HOURS` (6) and `BD_SENDER_NAME`. Sending providers for email, WhatsApp and voice plug into `ChannelSender`. Until a channel has one, its messages are kept as drafts for admins to review.

### SDKs and experiences (developers)

**SDKs.** `create_sdk(name, languages, product_ids)` defines an SDK over products you can build on: open or approval products, or private ones you were invited to. `generate_sdk_release(sdk_id, version, changelog)` then writes an immutable, semver-versioned bundle:
- `openapi.json`: an OpenAPI 3.1 document for the app API (`GET /v1/products`, `GET /v1/products/{id}`, `POST /v1/handoffs`, `POST /v1/events`, signed webhooks), with a schema per product built from its fields.
- `typescript/`: `src/schema.d.ts` generated from the document by [openapi-typescript](https://openapi-ts.dev), an [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) client for every operation, and a thin `core/src/index.ts` of Mynt helpers: `createMyntClient`, `startHandoff` (typed to each product's permitted hand-offs), `trackEvent`, `verifyWebhook`, and constants for every product's required disclosures, branding and banned phrases (`disclosuresFor(id)`).
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

The device SDKs are generated from source templates in [`core/sdk-templates/`](../core/sdk-templates). CI compiles a generated set on every change: Kotlin with `kotlinc`, Dart with `dart analyze`, Swift with `swift build`.

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

## Workspaces

Developers build apps in **workspaces**: teams. Every app belongs to one workspace, and everyone in it may see and work on its apps and their builds: edit, check and publish them, start, steer, finish and stop builds, use their sandboxes, deploy and run them, and manage their keys, webhooks, releases, journeys and metrics. Nobody else can, and to them the app and its builds don't exist ("No app of yours with id …"). `owner_id` still names the app's creator; it no longer decides who may touch it. Workspaces are not firms: a firm (entity) is a regulated legal party; a workspace is only who works on which apps.

- **Roles.** `owner`, `admin` or `member`. Members build and invite members. Owners and admins also invite admins, rename the workspace, change roles, remove people, create live API keys and rotate keys; only owners make, unmake or remove owners, or invite one. A workspace always keeps an owner: its last owner can't leave, be demoted or be removed. Every change is in the audit log.
- **Invitations are answered by the invitee.** A `user` invite can only be for a member. A workspace always keeps an owner who can manage it (one with a builder's role on Mynt).
- **Inviting.** Any member invites an email address into a workspace they're in (`invite_to_workspace`), with a workspace `role` (members invite members only) and a `mynt_role`, `developer` or `user`. Each person may send 20 a day. Mynt doesn't email anyone. The person signed in with that verified address sees it (`list_my_invitations`, with what accepting would let them do) and answers it (`accept_workspace_invite`, `decline_workspace_invite`); nobody joins a workspace by signing in. An unanswered invite lapses after 30 days. Its sender, or an owner or admin, can withdraw it (`revoke_workspace_invite`).
- **Getting onto Mynt.** An open workspace invite lets someone new sign in to Mynt, as a user (Mynt's consumer role) and nothing more; it's recorded as Mynt's own invite, from the workspace's inviter, and the identity provider's allowlist is kept in step as for an admin's invite. Accepting a `developer` invite then adds `developer`, but only to an account that is a user's alone (or has no roles yet): never to a firm's account (vendor, licence or liquidity provider) or an admin's, and never past roles an admin set after the invite was sent. A `user` invite adds nothing; such a member can't build until they're a developer. Someone a Mynt admin revoked stays out, and admins can revoke anyone let in this way. Withdrawing or letting an invite lapse withdraws the Mynt invite it made, only if its person never signed in and nobody changed that invite since (each change counts up its revision). Someone who signed in only to decline it, and belongs to no workspace, is taken back off Mynt the same way.
- **New apps.** `create_app` takes a `workspace_id` the caller belongs to. Without one, the app goes in the workspace the caller created (their own, made for them if there is none; at most one each), never in one they were invited into; with several of their own, they must say which.
- **Builds.** A build for an app is the workspace's: every member sees it (`get_build`, activity, files, diff), can stop or finish it, and can start their own from it (`continue_from`); someone who leaves loses it at once. Steering it or reopening its sandbox stays with whoever started it, since it spends their budget. Running commands in its sandbox or opening its editor needs the caller's own approved connection to the build's repository (the sandbox holds a credential for it), unless that's the app's Mynt-managed repository or there is none. A build for no app stays its starter's. Spend counts against the starter's monthly budget and, when set, the workspace's, where a running build counts at its whole cap.
- **Repositories.** Connections and their admin approvals stay per developer. Mynt's managed repositories need none: a teammate building or deploying the app gets access as its builders do. The app's own repository (`set_app_repository`) needs each teammate who builds or deploys from it to connect it themselves (`connect_repository`), approved like any connection.
- **Hosting.** Hosting is the workspace's: an owner or admin turns it on (`request_hosting` with `workspace_id`), and every app of the workspace runs on it whoever deploys it, fetched through the deployer's own approved connection (or the managed repository). Any member can deploy, check, log, run commands in, restart and undeploy its apps. Only owners and admins get VM logins (`vm_access`). A developer's own hosting from before workspaces keeps the apps it runs until they're deployed again (`hosting_status` lists them with `legacy: true`), and logging in to it needs owner or admin standing in every workspace whose apps it runs.
- **Leaving cuts access at once.** When someone leaves or is removed:
  - API keys they created for the workspace's apps, or whose current secret they were handed by rotating it, are revoked. A hosted app's runtime key belongs to the workspace (it's sealed and never shown), so a deployer leaving never stops the app.
  - Webhooks they made stop getting deliveries (an owner or admin can turn one back on with `enable_webhook`, confirming its URL or giving a new one, and getting a new secret); webhooks whose secret they were handed get a new one nobody holds yet, and the workspace's audit trail and `ops_status` say so, so an owner or admin rotates it and gives the receiver the new secret.
  - Mynt's automatic access to the apps' managed repositories (their approved connections) goes.
  - Invites they sent that nobody has answered are void, so nobody comes back through one; an invite is also void at acceptance if its sender is no longer in the workspace or no longer may invite to that role.
  - Their running builds stop and the sandboxes they reopened close; Solana programs they reserved for its apps pass to its longest-standing owner; their VM logins to the workspace's hosting are revoked (also when an owner or admin is made a member, recorded and retried the same way).
  - It's recorded first, with the VM logins that were theirs at that moment; each step is idempotent and, once done, isn't run again. A step that fails (a provider down) is retried with backoff (attempts first, then due time, so one that keeps failing holds up nothing), up to 10 times, after which it's marked failed and `ops_status` names it; an admin can retry any at once with `retry_offboard`. If they're back in the workspace as an owner or admin before it finishes, it's superseded: nothing granted to them since is revoked. Back only as a member, the rest is superseded but the VM logins of their admin days are still revoked (a member holds none). Only the logins recorded as theirs are revoked, each once the provider confirms; if which logins are theirs can't be read when they leave, the VM step reads it again on each retry rather than taking that for none. A new VM login is never given while the last one can't be ended (the provider not confirming), so no login is left behind unrecorded. A login the provider no longer has (deleted in its dashboard, or by a revoke whose answer was lost) counts as already ended, so it never locks anyone out or holds up an offboarding. A build started while its developer was being removed is stopped as soon as it exists, and a build stopped while its sandbox was being made never comes back to life (the sandbox is torn down).
  - All of it is in the audit log (`workspace_offboard`).
- **Rotating secrets** of API keys and webhooks, and creating live keys, is for owners and admins; Mynt records who received each current secret.
- **Sandbox files** are read only inside the app's directory (no absolute paths, no `..`).
- **Product access.** It's judged for the app: the newest product-access request for that product and app decides, whoever in the workspace made it; an invitation (for no app) counts only for the person invited.
- **Stage.** `list_my_apps` gives each app a `stage`, `idea`, `staging` or `production`, for grouping apps. A new app starts as an `idea`, and its stage changes only by promotion and demotion (below), never by its builds or hosting on their own. Apps that existed before promotions kept the stage Mynt derived for them then: `production` if published and running on Mynt's hosting, `staging` if it had a build Mynt verified or a deployment that wasn't live, else `idea`.
- **Promotion.** One step at a time, `idea` → `staging` → `production`, after checks Mynt computes itself from its own records (the builds it verified, the audit it ran, its hosting's state, licences and sponsorships, keys, webhooks, the mainnet program gate, admins' sign-offs), never from anything the app or an agent reports.
  - `get_promotion_checks({ app_id, to_stage })` (any member) returns `{ app_id, from_stage, to_stage, checks: [{ id, label, status, detail, fix? }], can_promote, needs_admin_signoff, signoff? }`. `status` is `pass`, `fail`, `warn` or `pending` (Mynt can't tell yet: it blocks like a fail, and is never shown as a pass). `fix` is `{ label, href?, tool? }`, `href` a studio path. `can_promote` is true when every check passes, or warns where the warning is advisory: every staging check's, and in production only `build_verified`'s, `audit_passed`'s and `audit_findings`'s (`ADVISORY_PRODUCTION_CHECKS`); any other production warning blocks. `to_stage` must be the next stage up.
  - To `staging`: `build_verified` (the latest build passed Mynt's verification in a clean sandbox; pending while one runs, a warning when a newer build failed), `audit_passed` (no critical or high findings in Mynt's independent audit, or none ran on that build), `app_runs` (healthy on Mynt's hosting if deployed there: pending while deploying, a failure when stopped or its hosting isn't running, a warning when not deployed or running an older build).
  - To `production`: those, with `hosting_healthy` in place of `app_runs` (it must be running on Mynt's hosting, and the build it runs must be the latest verified build every other check and the sign-off are about: anything else fails), `audit_passed` a warning when no independent audit ran (a failure when the app needs sign-off), and `licences` (target states must be set: none fails; every product the app uses is published, its sales not paused, and covered by a licence in force for its action, under an approved sponsorship where a licence provider provides it, in each of them), `webhooks` (each on, its secret held by a current member, its last delivery not failed; pending until a delivery has reached it, e.g. from a sandbox hand-off), `audit_findings` (no critical or high findings in the newest audited build, even one newer than the verified build; with no independent audit there are none to read: a warning, or a failure when the app needs sign-off), `program_gate` (when the app has Solana programs or its verified build carries some: each on mainnet, deployed through the program gate, with no open vulnerability flag; pending while a review runs), and, when `needs_admin_signoff`, `admin_signoff`.
  - `set_app_target_states({ app_id, states })` (owners and admins) sets the US states the app serves (`us-ny`, …, `us-dc`).
  - In a frozen or archiving workspace, `promote_app`, `demote_app` and `request_promotion_signoff` are refused until an owner relinks or unarchives it.
  - `promote_app({ app_id, to_stage })` (owners and admins) runs every check again inside one transaction holding the app's lock and refuses unless `can_promote`; a change since someone looked is caught then. The audit trail records `app_promoted` with the build, its source hash, the build its hosting ran and the checks it passed (also kept on the app's stage record). Members don't promote: they see the same checks and ask an owner or admin.
  - `demote_app({ app_id, to_stage, reason })` (owners and admins) moves it one step down, recorded as `app_demoted` with the reason. Demoting a production app is refused while it has active live API keys: the caller revokes them first (`revoke_api_key`, the hosted runtime key too); demotion never revokes them itself, so nobody loses live access by accident. It then unpublishes the app (`unpublished: true`). Hosting and webhooks stay as they are.
- **Production gates real money.** Only an app whose stage is `production` may hold a live API key (`create_api_key` and `rotate_api_key` for a live key), make a live runtime API call (a live key, or a client session minted with one: `403 app_not_in_production`), or publish (`publish_app`, `release_app`). Ideas and staging apps run on sandbox keys; each refusal says "Promote this app to Production first". `deploy_app` gives a hosted app a live runtime key only when it is in production and published, else a sandbox one. So a production promotion doesn't ask for a live key: live keys come after it. Live webhook events (hand-offs completing, failing, reversing) can only follow live calls, so they come from production apps; one that follows after a demotion (a reversal of an earlier live transfer) is still delivered, never dropped. When this arrived, apps were placed once, each move recorded in the audit trail as `app_stage_grandfathered` with why: an app live right then (published, with an active live key or an unexpired real customer session) went to production, so nothing live broke; an app live before but not then (a live key, even revoked; published; real customers' sessions or hand-offs) went to staging if it was an idea, so it reaches production only through `promote_app`'s checks; the rest stayed as they were. Live keys are issued and rotated under the app's stage lock, the same one promotion and demotion take, so a new live key and a demotion can't interleave.
- **Production sign-off.** A production promotion needs a Mynt admin's sign-off when the app moves value: it has Solana programs beyond devnet (or its verified build carries programs), or a product it uses is covered by a firm with an approved money rail. An owner or admin asks with `request_promotion_signoff({ app_id })`, for the latest verified build only once it's the one running on Mynt's hosting (asking again for the same build returns the open request); Mynt admins see requests with `list_promotion_signoffs` and decide with `decide_promotion_signoff({ id, approve, note })`, never one they asked for themselves and never for an app in a workspace they're a member of, in any role. A sign-off is for one verified build (its id and source hash) and the basis that made it necessary (`basis`: the app's programs beyond devnet, whether its build carries programs, and the ids of the approved money rails behind its products), all recorded with it. A newer verified build, or a change to that basis without one, makes `signoff.status` `none` again and needs a new one; a request whose build or basis changed before it was decided can't be decided (it's marked superseded). `signoff` is `{ status: none | requested | approved | rejected, by?, at? }`.
- **Attention.** `get_workspace_attention({ workspace_id })` (members only, that workspace only) lists what needs attention for the caller's role there, most severe first: `{ items: [{ id, kind, severity: high | medium | low, title, detail, href, at }] }`. Everyone sees `workspace_frozen` (its organization was deleted in Clerk) or `workspace_archiving` (both high), `build_failed` and `build_blocked` (an app's latest build in the last 14 days ended that way, e.g. its repository access was withdrawn), `promotion_checks_failing` (a production app's production checks fail now), `licence_expiring` (a licence behind its products lapses within 30 days) and their own `repository_approval_pending`. Owners and admins also see `join_request` (someone not on Mynt joined its organization), `offboard_failed`, `webhook_secret_rotation` (a webhook's secret was rotated out of a leaver's reach, so its receiver needs the new one), `webhook_disabled`, `signoff_requested` (waiting for a Mynt admin outside the workspace), `signoff_decided` (last 14 days) and `signoff_stale` (an approval for an app not yet in production whose programs or money rails changed since). A production app with no target states, or whose products lost licence coverage, is a `promotion_checks_failing` item like any other failing production check. Nobody in a workspace decides its sign-offs, so none is listed as waiting for the caller.
- **The dashboard.** `get_developer_dashboard` covers every workspace's apps, or one workspace's with `workspace_id`; then `build_spend.workspace` gives that workspace's spend this month against its budget.
- **Compliance, for members.** Three read-only tools show what a workspace's apps rest on, to its members only:
  - `get_compliance_coverage` gives each of the 50 US states and DC a status, by Mynt's own product rules (the same ones `get_product_regime` and publishing apply). `unlocked`: a published product one of the workspace's apps uses may be sold there: every regulated component of it is covered in the state by a licence that is verified and in force (its validity window), counting where the regulatory model says that licence counts, under an approved sponsorship where a licence provider provides the component; and its sales aren't paused (a covenant breach, or anything else that drifted it, pauses them everywhere). `available`: some other published product may be sold there. `unavailable`: none may. An unlocked state lists the firms whose licences cover it, those licences, the products, and those firms' approved money rails there (kind, direction, provider, status; never limits). A workspace whose apps use no product sees only `available` and `unavailable`.
  - `list_workspace_licences` lists the licences covering those products, as the coverage counts them: firm, type, regulator, number, the states they cover them in, status and expiry; filter by `status`, `regulator` or `state`.
  - `list_workspace_audit` is the workspace's audit trail, newest first, paged with `next_cursor` (up to 100 at a time; filter by `action`, `user_id`, `app_id`, `from`, `to`, each a real calendar date or ISO time). It holds what happened to the workspace itself (members, invites, renames, offboarding), to its apps (and events that name one of them, like its keys and webhooks, deploys, hosting commands, releases) and their builds, and admins' decisions on its members' connections to its apps' repositories. Events are chosen by what they're about, never by searching text. Details pass through Mynt's secret scrubber, and fields named like secrets, tokens, passwords, API or private keys, authorization or cookies are hidden. Whom an invite went to (its email and id) is shown to owners and admins only. The cursor keeps the database's full timestamp precision, so events in the same instant all come back.
  - **Audit classes.** Each event is `{ id, at, class, kind, actor, app_id?, target, summary, severity?, status?, details }` (`action` is kept, the same as `kind`). `class` comes from one table, `core/src/audit-classes.ts`, keyed by action:
    - `security`: application security. Mynt's independent build audits, repository access and its checks, the mainnet program gate and its vulnerability flags, secrets revealed or rotated (including out of a leaver's reach), VM logins and container exec, the hosting kill switch, and account recovery.
    - `obligations`: financial licence obligations. Licences and the firm's GRC records against them, firm checks, sponsorships, covenants and their breaches, product composition and drift, target states, production sign-offs (tied to licences and money rails), governance review, and the regulatory model.
    - `financial`: financial activity. Money movements and their refusals, live hand-offs, liquidity commitments, withdrawals and pool state, money rails and ramps, partner ledgers, program calls and take rates.
    - `workspace`: running the workspace. Members, roles and invites, apps, builds, promotions, hosting, keys and webhooks, and settings.
  - An action in no list is `workspace`. `core/test/audit-classes.test.js` reads every audit action in the source and fails on one that isn't in the table.
  - `class` filters by it. Without `class` you get every event, as before.
  - Three kinds of row come from Mynt's own records rather than the audit log:
    - `build_audit` (security): each build of the workspace's apps that Mynt's independent audit ran on, at the time the build finished. `severity` is its worst finding (`critical`, `high`, `medium`, `low` or `none`) and `status` the build's.
    - `money_movement` and `handoff` (financial): live ones only, never sandbox, with what moved and how it ended (`status`). Never a customer or rail reference.
  - `severity` is also set where the action itself says it: `high` for a covenant breach, a paused product, a program review flag or withdrawn repository access; `medium` for a pool flag or a refused, stale or differing money movement. Otherwise it's absent.
  - `get_workspace_obligations({ workspace_id })` lists the obligations in the regulator's own register (`grc.registers.obligations` of the licence type, as the regulatory model defines it) for each licence covering a product the workspace's apps use, as `list_workspace_licences` counts them. Each is `{ licence_id, licence_type, partner: { entity_id, name }, regulator, obligation_id, title, products: [{ id, name }], status, evidence?, reason? }`. `status` comes only from what the licence holder recorded in Mynt:
    - `overdue`: a filing the register ties to the obligation (`obligation_ref`) was recorded overdue.
    - `met`: its obligation record says compliant.
    - `at_risk`: its obligation record says partially or non-compliant.
    - `unknown`, with a `reason`: nothing recorded, not assessed, or marked not applicable (the firm's say-so, which Mynt can't confirm).
  - `evidence` says what the record says and when, and how many evidence items it has, never their text. Mynt records no due dates, so `due_at` isn't given.
  - Nothing about other workspaces appears: only "available" says that someone else's product may be sold in a state.
- **Profit and loss.** `get_workspace_pnl({ workspace_id, granularity?: "month" | "week", periods?: 1..24, app_id? })` (members only, that workspace's apps only; readable while it's frozen or archiving) sets what its apps bring in against what building and running them costs, in US cents. Periods are UTC calendar months (default) or Monday-to-Sunday weeks; `periods` (default 6) counts back from the current one, which is still running. It returns `{ currency: "USD", series: [{ start, end, revenue_cents, costs_cents, net_cents }], statement: { columns, revenue, costs, totals: { revenue, costs, net } }, unmeasured: [{ key, label, reason }] }`: `series` is oldest first; `columns` are `this_period`, `last_period` and `year_to_date` (1 January UTC to the end of this period), each `{ key, label, start, end }` with `end` exclusive; every line is `{ key, label, app_id?, product_id?, values: { this_period, last_period, year_to_date }, measured, source }`.
  - **Revenue**, one line per app and product: the money Mynt saw settle through the app, at the settled amount, dated when it settled. It's the same record and rule as the dashboard's money moved, so the two agree. Live only: sandbox money is left out entirely, not shown as a line. It's money moved through the app, not what the app keeps from it.
  - **Costs**, positive numbers:
    - `build_agents`: each build's metered cost (the coding agents' model use through the agent proxy plus its sandboxes' machine time while it runs, what the build caps count), dated when the build started, as the monthly caps count it.
    - `audits`: 0, because Mynt pays for its independent audits on their own meter.
    - `hosting`: each hosted app's own VM, its run time sampled from the provider and priced at `FREESTYLE_USD_PER_HOUR` when sampled. 0 if Mynt hosts none of the apps. Unmeasured when the hosting provider runs no VM per app, because only a VM per app reports its run time.
    - `sandboxes`: what a build's sandboxes cost after it ends (its preview, up until the sandboxes' time limit) and sandboxes reopened on a finished build (`reopen_sandbox`), from the provider's own cost.
    - `mynt_fees`: unmeasured. Take rates are set per product line, but Mynt has no billing, so it never charges or records a fee.
  - **How machines are recorded** (`core/src/usage-meter.ts`, table `usage_samples`):
    - Every `USAGE_SAMPLE_MS` (default 5 minutes), Mynt samples each machine's running total from its provider and records the increase since the last sample, against the app.
    - A machine Mynt has just made (a new app VM, a reopened sandbox) counts from zero. One first seen already running is only a baseline: earlier time isn't guessed. A lower reading never subtracts.
    - A build's sandboxes get their baseline when the build ends, because while it runs their time is in the build's own cost. An app VM is sampled once more before undeploy deletes it, and a reopened sandbox before it's closed.
    - A machine the provider deletes on its own (at its time limit) can lose up to one sampling interval from the record, on a provider that forgets a deleted machine's usage.
  - **When recording started.** Each recorded line counts from when Mynt started recording it:
    - revenue from the money ledger's start (`money_ledger_started_at`);
    - hosting and sandboxes from their meters' first run (`usage_recording_started_at:hosting` and `usage_recording_started_at:sandbox` in settings).
    - A period or column that began before then is null, never a partial figure, and `unmeasured` gives `Recording started <date>` for that line.
  - **What the apps keep** (`app_earnings` in `unmeasured`) isn't recorded. Apps don't charge their customers through Mynt, and a product's fees (in its definition) are the provider's, so Mynt has no record of an app's own cut.
  - An unmeasured line's values are null, never 0, with its reason in `unmeasured`. A total is null unless every line under it is measured, and `net` (revenue minus costs) is null unless both totals are. Sums run in SQL by day over the periods asked for (indexes on money movements by app and settlement time, on builds by app and start, and on usage samples by app). Until Mynt charges fees, total costs and net stay null.
- **The dashboard's product figures.** `get_developer_dashboard` also gives `active_products`, the published products its apps use, and `licences`, the licences behind them (as `list_workspace_licences` counts them).
- **Existing apps.** When Mynt first starts with workspaces, each developer with apps gets one workspace, "<their name>'s workspace", which they own and which holds all their apps. Nothing else changes for them.

### Workspaces are the identity provider's organizations

When Clerk is the sign-in provider (`CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` set), each workspace is one Clerk organization. **Clerk decides who is in a workspace's organization; Mynt alone decides platform roles (developer, user, ...) and who owns a workspace.** Syncing never grants a platform role, never raises a workspace role, and never removes anyone or anything on inference. The core is provider-neutral (`OrgDirectory` in `org-directory.ts`, `WorkspaceSync` in `workspace-sync.ts`); the Clerk adapter is `clerk-orgs.ts`. A workspace's organization is `workspaces.external_org_id`, null until backfilled.

- **Making one.** `create_workspace` (and the studio's Create workspace) first writes the workspace as being made. Then it creates the organization, with the caller as its creator and the workspace's id in its private metadata (`mynt_workspace_id`), and then links the two. Clerk's own event about the new organization finds that workspace rather than making another. If the organization can't be made or linked, neither is kept. The first workspace someone makes is their default one, and personal workspaces are organizations too. Renaming a workspace renames its organization.
- **Every personal workspace is a Clerk organization.** Check the Clerk plan's organization limits and pricing before turning this on for many people. Calls to Clerk that are rate-limited (429) are waited out and retried, up to 4 times.
- **Roles.**
  - Clerk's `org:admin` is a workspace `admin` and `org:member` a `member`. Clerk has no owner: owners are Mynt's, shown in Clerk as `org:admin`.
  - Changing a role, removing someone or leaving in Mynt changes Clerk first; if Clerk refuses, nothing changes in Mynt.
  - In the other direction, an admin made a member in Clerk becomes a member in Mynt, with Mynt's demotion offboarding. Someone made an admin only in Clerk is put back to `org:member` (`workspace_role_restored`): workspace roles are raised in Mynt (`change_member_role`).
  - An owner removed or demoted in Clerk is put back there (`workspace_owner_restored`). An owner leaves with `leave_workspace`, or another owner removes them. Syncing never makes anyone an owner, except that whoever creates a new organization in Clerk owns that new workspace.
- **Invitations** are Clerk organization invitations, sent with the same rules for who may invite whom, so Clerk emails the invitee. Their public metadata carries Mynt's invite id (`mynt_invite_id`), the Mynt role (`mynt_role`: `developer` or `user`) and the workspace role. They link back to the studio (`STUDIO_URL`).
  - An invite accepted in Mynt (`accept_workspace_invite`) adds the Clerk membership and spends the invitation.
  - An invite accepted with Clerk counts only when Clerk's invitation id and Mynt's invite id match each other. Then Mynt's own acceptance rules apply: the invite is still open (30 days), its sender may still invite to that role, the developer role goes only to a user's account, and never past roles an admin set since.
  - An invite that stops standing (withdrawn, declined, lapsed or void) withdraws Clerk's invitation too.
- **What Clerk changes, Mynt follows,** by a signed webhook and a reconcile worker. Each event is read back from Clerk before it's applied, so a late, repeated or out-of-order delivery can't undo a newer change.
  - Someone on Mynt who joins an organization in Clerk, not through a Mynt invite, is a member and nothing more.
  - Someone not on Mynt who joins an organization in Clerk isn't let onto Mynt. It's a **join request** that the workspace's owners and admins see in `list_workspace_members` (`join_requests`); an invite from Mynt lets them in. Until then they're kept an `org:member` in Clerk.
  - So Clerk's `org:admin`s are only ever Mynt's owners and admins, and any removal or role change made in Clerk is one a Mynt owner or admin could have made (an owner's is undone anyway). Clerk's webhooks don't say who made a change, so the audit records the event id and the request's address and client (`via`, `event`).
  - A new organization made in Clerk (Clerk's "create your first organization" step at sign-in) becomes its creator's workspace, if they're on Mynt. Their platform roles don't change.
  - Someone a Mynt admin revoked is removed from the organization again (`workspace_member_refused`). That covers their Mynt address and every address Clerk verified as theirs.
  - A membership Clerk confirms is gone runs Mynt's offboarding. This applies only to someone Mynt has seen in the organization. A member who is in Mynt only so far (from before organizations, or not yet signed in through Clerk) is added to the organization instead, never taken out.
  - An organization Clerk confirms deleted (404) freezes its workspace. Nobody is removed and nobody new joins, `list_workspaces` and `ops_status` say so, and an owner either relinks it (`relink_workspace_org`: a new organization with its members) or archives it.
- **Archiving** (`archive_workspace`, owners only) freezes the workspace.
  - It's refused while any of the workspace's apps is published or hosted: unpublish and undeploy them first.
  - 7 days later, everyone is removed and offboarded (in one transaction with the archive's end) and its organization is deleted. Until then, any owner can undo it with `unarchive_workspace`. If an app has gone live meanwhile, the archive waits a day at a time and the audit says so.
  - With `now: true` it happens at once, but only for a workspace's sole owner.
- **The webhook,** `POST /webhooks/clerk`:
  - It takes `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted` and `organizationInvitation.accepted`.
  - It's verified with Clerk's own library (`verifyWebhook`), which also refuses an old or replayed signature.
  - Each event id is handled once (ids are kept 30 days). An event that fails isn't recorded, so Clerk delivers it again.
  - It's off (404) while `CLERK_WEBHOOK_SECRET` isn't set.
- **The reconcile worker** runs every 15 minutes, backing off up to 2 hours while Clerk fails. Each person's own memberships are also reconciled when they sign in, at most every 5 minutes.
  - It reads everything before changing anything, and confirms each removal and each missing organization with Clerk one by one.
  - Its circuit breaker stops it and changes nothing when Clerk lists no organizations while workspaces are linked, or when more than a tenth of the linked organizations, or of the members Mynt has seen in them, would go in one run. `ops_status` then says why. One at a time always proceeds.
  - It leaves alone workspaces still being made or backfilled.
  - A workspace whose making crashed more than an hour ago, with no apps, is cleared away. An organization this installation made for a workspace that doesn't exist (tagged with its id and this installation's `mynt_instance`) is deleted once it's an hour old. Another installation's organizations are never touched.
- **Writes to Clerk** made by syncing happen only after Mynt's transaction commits, so a rate-limit wait never holds a workspace's row.
- **Workspaces from before organizations** get theirs with `mynt clerk sync-workspaces`. It's a dry run unless `--apply` is given, and it prints counts only.
  - The organization is made for the workspace's owner, and its members are added (owners and admins as `org:admin`).
  - Each workspace stays marked as being backfilled until all its members are in, so a run that failed part-way is resumed by running it again, and the reconcile worker leaves it alone meanwhile.
  - Members who never signed in through Clerk stay in Mynt and are added to the organization at their first sign-in.
  - Open invites become Clerk invitations, which email the invitees, only with `--send-invites`. The dry run reports how many emails that would send (`invitation_emails_would_send`). Without it, those invites still work in Mynt.
- **The studio's Members page** keeps working. `list_workspace_members` gives `manage_url`, the organization's own page in Clerk's account portal.

**Turning it on (operator steps).** Clerk's Organizations setting stays on with "membership required": its "create your first organization" step becomes "create your first workspace".

1. In the Clerk dashboard, open **Webhooks**, choose **Add Endpoint**, and give it `<Mynt's public URL>/webhooks/clerk`. Subscribe it to `organization.created`, `organization.updated`, `organization.deleted`, `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted` and `organizationInvitation.accepted`, then create it.
2. Copy the endpoint's **Signing Secret** and set it yourself on the server as `CLERK_WEBHOOK_SECRET`, then restart Mynt. Never paste it into a chat or a command.
3. Optionally, set `STUDIO_URL` to the studio's address so that invitations link back to it.
4. On the server, run `node dist/index.js clerk sync-workspaces` and read the counts (nothing changes). Then run `node dist/index.js clerk sync-workspaces --apply`. If `failed` isn't 0, run it again: it resumes.
5. Only if you want the open invites emailed by Clerk (the dry run's `invitation_emails_would_send` says how many), run `node dist/index.js clerk sync-workspaces --apply --send-invites`. That emails people, so decide it explicitly.

## Linked accounts

`get_linked_accounts` (anyone signed in through the identity provider) shows the GitHub account and crypto wallets linked to the caller's sign-in, as the identity provider knows them: `{ git: { provider: "github", username, verified } | null, wallets: [{ chain: "solana" | "ethereum", address, verified }], manage_url }`. `manage_url` is where they link or unlink them: Clerk's Account Portal user page (`https://accounts.<domain>/user` for a production instance, `https://<slug>.accounts.dev/user` for a development one; `CLERK_ACCOUNT_PORTAL_URL` overrides it for a custom domain, and must be a valid https URL or Mynt won't start).
- Read-only, verified links only (the verified GitHub account when there are several; an unverified one proves nothing about who holds it), and never a token: only the account name and the wallet address. A wallet's chain is told from its address (0x and 40 hex digits: Ethereum; base58 of 32 to 44 characters: Solana); any other address isn't shown.
- Cached for a minute per person (a failure for 15 seconds). If the identity provider can't be reached, `git` and `wallets` are null and `unavailable` says so, never with the provider's own error text; if it no longer has the person's account (deleted), `unavailable` says that.
- The core is provider-neutral (`IdentityProvider` in `linked-accounts.ts`); the Clerk adapter is `ClerkIdentityProvider` in `auth.ts`, which maps a Mynt user to their Clerk id and reads that user's `external_accounts` and `web3_wallets`.
- Later, acting on a person's GitHub repositories with their own token will need custom GitHub OAuth credentials configured in Clerk: with Clerk's shared development credentials, `getUserOauthAccessToken` returns no token. Showing the username works now.

## Licence providers: sponsoring builders' products

A builder needn't hold licences. A **licence provider** is a firm that does: an admin adds it by hand (`register_firm`, `invite_user` with the `license_provider` role, `add_entity_member`), it registers its licences (`register_license`) and an admin verifies them (`review_license`), as for any firm. Its people share its firm id with builders out of band; there is no directory of firms.

1. **The builder names the provider** as a component's provider: `{ by: "sponsor", entity_id }` in `set_product_composition`, or `component_provided_by` to `{ kind: "sponsor", id }` in a v2 definition.
2. **The builder asks** with `request_sponsorship` (product, component, provider firm id, and the jurisdictions, by default where the component is offered). One request may be pending per component and provider; asking again later adds jurisdictions.
3. **The provider decides**: `approve_sponsorship` names its held licences (verified and in force; a registration that covers nowhere by itself, like the FinCEN registration, isn't named: it counts automatically as the named licences' prerequisite) and the jurisdictions they cover; or `decline_sponsorship`. `revoke_sponsorship` withdraws an approved one.

**The regime rule.** A sponsored component is covered in a jurisdiction only by a licence of that provider which an approved sponsorship names for that jurisdiction, verified, in force, granting the component, covering the jurisdiction, and with the provider's own prerequisites held. Anywhere else it's blocked ("Ramp Partner Inc (sponsor) doesn't sponsor this in us-ca"), and with no approved sponsorship at all it's blocked everywhere. A builder with no licence and no sponsor is blocked as before ("Your entity holds no verified licence granting this").

**Mandated stakeholders** are the licensee's. The regulatory model attaches them to the licence type, and the licence is the provider's, so they must be filled on the **provider's** roster (enforced: a gap blocks publishing, as for the owner's own licences), but they aren't bound to the builder's product, since they aren't on the builder's roster. The builder still names its own `product_owner`.

**Pins and drift.** Publishing pins each covering sponsorship (with the jurisdictions it covers), the provider's licences and its stakeholder parties, and the provider's firm. Revoking the sponsorship, or the provider's licence lapsing or being suspended, drifts the product, naming the jurisdictions. The stored `regime_summary` shows `provided_by: "sponsor"`, the provider's name, and on each covered jurisdiction a note such as "Covered by Ramp Partner Inc's Money transmitter licence (New York Banking Law Article 13-B) (sponsored)".

**Is the licence provider a real company?** Mynt checks it itself, against public sources, and never takes the firm's word for it. An admin runs the checks with `run_firm_checks` (entity id), and every licence provider's firm is re-checked monthly (`FIRM_CHECKS_EVERY_DAYS`, default 30; a source that was down is retried daily). Each answer is kept, newest first, with its source, URL, `retrieved_at`, the fields it matched, a status (`match`, `mismatch`, `not_found` or `unavailable`) and a SHA-256 hash of the answer in a stable form, so a changed record shows as a changed hash.

| Source | What Mynt asks | Matched against the firm's | Terms |
|---|---|---|---|
| `gleif_lei`: GLEIF's LEI record | `GET https://api.gleif.org/api/v1/lei-records/<LEI>` (the firm's `lei` identifier; a malformed LEI is never sent) | legal name; jurisdiction (GLEIF's `US-DE` against its incorporation); the entity's status (`ACTIVE`) and the LEI's (`ISSUED`, `PENDING_TRANSFER` or `PENDING_ARCHIVAL`; `LAPSED`, `RETIRED` and the rest are a lapse). The registration authority and number are recorded | Free, no key; the data is CC0 ([LEI Data Terms of Use](https://www.gleif.org/en/meta/lei-data-terms-of-use)) |
| `fincen_msb`: FinCEN's MSB Registrant Search list | The list's own "View/download … in Excel" export at [msb.fincen.gov](https://msb.fincen.gov/) (tab-separated text, every current registrant, updated weekly; one download serves six hours of checks) | legal name, and the registrant's state against the states of the firm's legal and head-office addresses in its matching LEI record. Without one, a single registrant of that name matches; several are `not_found` rather than a guess | A US government record; FinCEN offers the export "for the benefit of the financial institutions … to integrate into their data processing systems". Mynt fetches only that file, never the search pages |

The FinCEN list carries no registration numbers, and NMLS Consumer Access has no API anyone may use while its terms forbid downloading what it shows (NMLS's paid B2B Access is the sanctioned route), so neither is fetched: the firm's FinCEN registration number (identifier `us_fincen_msb`, or its registered FinCEN licence) and its NMLS ID (identifier `us_nmls`) are listed under `verify_by_hand` with the page to check them on, and its state licences stay verified by an admin with `review_license`. Requests go through Mynt's outbound helper (`core/src/vendor-call.ts`: HTTPS only, no private addresses, no redirects, a time limit and a size cap) to those two fixed hosts only.

**The rule.** `approve_sponsorship` is refused until the provider's firm passes the rule set by `SPONSOR_LEGITIMACY_RULE` on the server:

| Value | A licence provider may sponsor when |
|---|---|
| `lei_or_msb` (default) | its latest LEI answer or its latest FinCEN answer is a `match`, and neither is a mismatch or a lapse |
| `lei_and_msb` | both are a `match`, with no mismatch or lapse |
| `lei` / `msb` | that one is a `match`, with no mismatch or lapse |
| `off` | always: no gate and no drift. For staging with the placeholder firm only, which isn't a real company |

"Latest" skips `unavailable` answers: an outage keeps the last real answer, and is never held against the firm. A lapse is a source that matched before and now finds nothing (the firm dropped off FinCEN's list), or an LEI whose status lapsed. Answers count only for the firm's current facts: a new LEI or legal name needs a fresh run. The refusal says which checks failed and what to do. `get_my_entity`, the admin's `list_entities` and each of `list_sponsorship_requests` show the result as `legitimacy` (`your_firm_legitimacy` in the requests): whether it passes, why not, each source's latest status, URL and time, and what to verify by hand.

**Drift.** A mismatch or lapse found later drifts every published product the firm sponsors, as its licence lapsing would: the change has `kind: "legitimacy"`, the firm's id, `now` naming the flags (`flagged:fincen_msb:lapsed`), and the jurisdictions its sponsorships covered. A later match clears it. Nothing extra is pinned, so products published before these checks existed are covered too.

**Paid checks, later.** A state's Secretary of State good standing, officers and registered agent need a paid source. The US region has a `kyb_business_verification` service type for that (`core/schemas/service-types/us/`; vendors such as Middesk or Baselayer can offer it once it's wired in). It's data only for now: nothing calls it.

**`test_product`** doesn't warn a builder that holds no licence when it needn't hold one: if it provides no component itself and every component is covered by a sponsor (or a partner), `licence_held` passes and names who covers what ("Example Money Transmitter (placeholder) sponsors 'transmission' in us-ny, us-ca"); while a sponsorship is still pending it warns only that the composition isn't covered yet. A builder providing a component itself is still warned when it holds no licence.

### A sponsored US product, end to end

`core/scripts/sponsored-product.mjs` runs the whole path from an unlicensed builder to a developer-ready US product: the licence provider's firm (registered by hand), its licences (registered, then verified by an admin) and the roster filling the stakeholders they mandate; the builder's firm and its product, the money transmission template (`core/schemas/examples/us/money-transmission.v2.json`) with transmission provided by the sponsor; `request_sponsorship` and `approve_sponsorship` for every state it's offered in; `test_product`, `publish_product`; and a check that `list_products` with `developer_ready` lists it. `core/test/sponsored-product-e2e.test.js` runs the same function on an in-process server.

What it runs on is a JSON fixture. The shipped one, `core/schemas/examples/us/sponsored-product.placeholder.json`, is a **placeholder for staging and tests only**: "Example Money Transmitter (placeholder)" isn't a real firm, its registration numbers start `PLACEHOLDER-`, and it has `"placeholder": true`, so the script refuses it unless told it's staging. Since no public register can show it's a real company, its sponsorship is approved only on a staging server running with `SPONSOR_LEGITIMACY_RULE=off`; the real partner passes the checks instead (an admin runs `run_firm_checks` once its LEI is recorded). It holds a FinCEN MSB registration and money transmitter licences for New York and California. The US model (`core/schemas/regulatory/us.json`) has a money transmitter licence type for every state and the District of Columbia except Montana, which has no money transmitter licence (its regulator is kept with no licence types); to offer the placeholder product in another state, add that state's licence (its `_id` is `<regulator>_money_transmitter`) to the fixture's licences and the state to `offered_in`.

Every step reads first and does only what's missing, so rerunning is safe and picks up where a run stopped. Three people act, each in their own session (`MYNT_ADMIN_TOKEN`, `MYNT_LICENCE_PROVIDER_TOKEN`, `MYNT_BUILDER_TOKEN`, from the environment, never the command line); with only some of them set, it does their steps and stops naming who's needed next (the partner usually approves in its own session).

```bash
# in the repository's core/ folder
node scripts/apply-sponsored-product.mjs --url <a staging server's MCP URL> --staging --dry-run   # read only: what it would do
node scripts/apply-sponsored-product.mjs --url <a staging server's MCP URL> --staging             # run it with the placeholder
```

**When the real partner signs**, an admin swaps it in and reruns:

1. Copy the fixture (say `sponsored-product.partner.json`, kept out of the repository if it names the partner before that's public) and set `"placeholder": false`; delete `placeholder_note`.
2. In `licence_provider`: the partner's legal name (or `entity_id`, if its firm is already on Mynt), the email its person signs in with (`member_email`; invite them with the `license_provider` role first), its legal form and incorporation, each licence it holds as on the regulator's register (`regulator_id`, `license_id`, `registration_number`, and `valid_from`/`valid_to` when known), and the people who fill each stakeholder its licences mandate (`roster`).
3. Change `product.offered_in` to the states it will sponsor in.
4. Check every licence against the regulator's public register, then run with `--verify-licences` (without it the run stops for `review_license`):

```bash
# in the repository's core/ folder
node scripts/apply-sponsored-product.mjs --url <the server's MCP URL> --fixture sponsored-product.partner.json --dry-run
node scripts/apply-sponsored-product.mjs --url <the server's MCP URL> --fixture sponsored-product.partner.json --verify-licences
```

A product already live under the placeholder gets a new version sponsored by the partner (its definition changes, so it's saved as the draft version, sponsored, tested and published). The placeholder firm's own sponsorship is then left over: revoke it (`revoke_sponsorship`, as the placeholder's licence provider) and suspend its licences (`review_license`) so nothing can rest on it again.

## Approved money rails

Money moves off-chain only, through rails an admin has approved. Solana programs never move money, and Mynt never holds customer funds: it instructs the licence provider's rail. Rails, the chokepoint and the ledger are in `core/src/money-rails.ts`.

**A rail** belongs to a licence-provider firm and has a `kind` (`ramp_adapter`, `ach`, `wire`, `rtp`, `fednow`, `push_to_card`), a `provider`, a `direction` (`on_ramp`, `off_ramp`, `payout`, `deposit`), the US states it may be used in (ISO 3166-2, e.g. `us-ny`), a per-transfer and a daily limit in integer US cents (the day is the UTC day), a `status` (`proposed`, `approved`, `suspended`, `revoked`), and who approved it and when. A rail's states must each be covered by a verified, in-force licence of the firm that grants `us_money_transmission` in the regulatory model and has its prerequisites held (the FinCEN registration): one whose type names that state, or a federal charter whose type covers `us`. A licence that reaches a state or the country without that grant counts for nothing, and a federal regulator's licence type that doesn't set `covers` isn't counted anywhere: `approve_rail` says so, and the fix is to set it in the regulatory model. Valid states are the 50 states and DC; the territories aren't, until the model has licence types for them. Montana is valid, but has no state money transmitter licence, so a rail there can't be approved at present. For a `ramp_adapter` rail the `provider` is a ramp adapter id (`bridge`), or, for a partner speaking Mynt's wire contract itself, the id of its transfer offering. No current path instructs `ach`, `wire`, `rtp`, `fednow` or `push_to_card` directly, so those can be proposed and approved but don't yet carry a transfer.

| Tool | Who | What |
|---|---|---|
| `propose_rail` | Licence provider | Proposes a rail for its firm. One live rail per firm, kind, provider and direction; to change one, revoke it and propose again. The result lists any `outside_licence_coverage`. |
| `list_rails` | Licence provider, admin | Its own firm's; an admin sees all. |
| `approve_rail` | Admin | Approves a proposed rail, or puts a suspended one back. Refused, naming the states, if the firm holds no licence to transmit money in any of them (above). Whoever proposed the rail, or belongs to its firm, can't approve it. |
| `suspend_rail`, `revoke_rail` | Admin | Stop new movements at once. Movements in flight aren't cancelled: the result lists them as `in_flight`. |
| `list_money_movements` | Admin, licence provider, builder | The ledger, scoped: an admin all, a licence provider what it sponsors, a builder its firm's products. |

Every rail change, and every refused approval, is in the audit log.

**The chokepoint.** Every money movement goes through `authorizeMovement`. That means every service type an admin declared `moves_money: true` (`onramp_transfer`, `offramp_transfer`), whether its partner runs through an adapter or the wire contract. `define_service_type` makes every non-quote `ramp` type declare it, and any type whose key or name says it moves money; a quote can't declare it or be named as a transfer. In live, a movement is refused unless all of these hold:

1. A licensed partner has verified the customer's home state in an identity check (see "Partner requirements"). `resolveCustomerState` is the one place that decides it, afresh for every attempt: for live, only that verified state, recorded on the movement with `state_source: partner_verified`, the verifying partner and when. What a customer types (`residence_state`, through `POST /v1/client/fields`) is for sandbox and pre-filling forms only, marked `self_reported`, and never satisfies a live check. A movement already in flight keeps the state it was reserved under. The one exception to all this is a liquidity pool's own deposit or withdrawal, a firm's money rather than a customer's: it goes by the state the firm named or a sponsor or admin corrected (`liquidity_provider_stated`, `sponsor_corrected`, `admin_corrected`). Those sources are accepted only with a `pool_*` action and a firm's `lp:` reference, so a customer's movement can't claim them. Erasing a customer's data takes their verified state and their ramp link with it. Every change is appended to `customer_state_history` (who, when, old, new), which can't be updated, deleted or truncated and never holds up the change it records (an old value that can't be decrypted is marked `old_state_unreadable`), and each movement keeps the state it used and where it came from.
2. A licence provider has an approved sponsorship covering that state, of the component the action serves. An action that names no component is refused: a product's `moves_money` actions each need a `handoff_serves_component` connection in its definition.
3. An approved rail of that sponsor fits the direction, the kind, the provider and the state, and a licence named on that sponsorship still lets the firm transmit money in the state today.
4. The amount is within the rail's per-transfer limit and what's left of its daily limit.

| Refusal (`error` in the API's answer) | Status | Means |
|---|---|---|
| `state_unverified` | 403 | Live only: no partner has verified this customer's home state. Nothing else stands in for it. |
| `customer_state_required` | 409 | Sandbox only (recorded as `would_refuse`): no `residence_state` on file, or not a US state. |
| `no_sponsor`, `state_not_sponsored` | 403 | Nobody sponsors the product, or not in that state. |
| `component_required`, `component_not_sponsored` | 403 | The action names no component, or nobody sponsors what it serves. |
| `no_approved_rail`, `state_not_on_rail` | 403 | No approved rail fits, or none for that state. |
| `rail_suspended`, `rail_revoked` | 403 | The rail stopped taking new transfers. |
| `licence_not_in_force` | 403 | The sponsorship's licences don't let the firm transmit money in the state today. |
| `over_transfer_limit`, `over_daily_limit` | 403 | Over a limit. The daily limit is checked atomically: a Postgres function locks the rail and adds up the day's ledger inside one transaction. |
| `amount_unknown`, `movement_unknown` | 403 | Mynt can't tell how much it moves, or which way. |
| `idempotency_conflict` | 409 | The key was used for a different movement. |
| `too_many_attempts` | 409 | This movement has been tried as often as it may be. |

Each refusal is audited (`money_movement_refused`) and its quote stays usable. **Sandbox** movements never move real money, so they go through the same check but aren't refused and use no limit: they're in the ledger with `sandbox: true` and `would_refuse` naming what live would have said.

**Partner requirements.** A live movement needs a home state verified by an identity provider its sponsor accepts: the sponsor itself, or an offering the licence provider (or an admin) approved for that sponsorship with `approve_identity_provider` (`revoke_identity_provider` and `list_identity_providers` go with it). A builder's own firm, or the firm of the person who owns the product, can never be approved for it, and nobody approves a provider from their own firm. Approval only looks forward: checks made before it don't count. For a ramp, approving any of its firm's adapter offerings approves the firm's one verification record. Each provider's result is kept separately, and the latest from a provider the sponsor accepts is the one that counts, checked per movement, so another provider can't overwrite it and a check for one sponsor doesn't satisfy another. It's refused with `state_unverified` and the reason when:

- that provider's latest check didn't pass (`not_verified`, `no_match` or `deceased`);
- the customer's vault no longer matches what was checked (a keyed hash of the identity details is kept with the verification, so rotating `MYNT_VAULT_KEY` means verifying again);
- it's older than `VERIFIED_STATE_MAX_AGE_DAYS` (default 365).

A `verified_at` in the future is refused. A check that began before a customer erased their data can't write a state back. Mynt takes the state from whichever of these says so:

| Source | Supplies a verified state? | What's needed |
|---|---|---|
| An identity service (category `identity` or `kyc`, e.g. the US `identity_verification` type), with the customer's consent | Yes, if the vendor returns it | The vendor returns `residential_state` (ISO 3166-2, e.g. `us-ny`) in its output, only when its check verified the address and passed (the device status `verified`). A plain name, date of birth and SSN check doesn't verify an address, so it shouldn't send one. Running the check again is how a state is re-verified. |
| A ramp adapter's partner record (`customerIdentity`), read when the customer is linked and before each live transfer | Only if the adapter's partner exposes it | The adapter returns `residential_state` from the partner's verified record. If it can't be read at that moment, what's on file stands. |
| Bridge | **No** | Bridge's documented `GET /v0/customers/{id}` response has no address: the address is on the create request only, and the response names `address_of_residence` just as a completed requirement. Until Bridge confirms a field carrying the verified residential state (a documented response field, or a report or webhook with it) and it's added to the adapter, customers on Bridge need a separate identity service that returns `residential_state`, or live movements are refused with `state_unverified`. |
| A ramp partner speaking Mynt's wire contract | Not through the ramp | It offers an identity service as above. |
| What the customer typed (`residence_state`) | Never, for live | |

**The ledger** (`money_movements`) has a row for every movement: product, sponsor, rail, direction, `amount_cents`, state, a pseudonymous customer key (never the developer's reference or a name; an HMAC under a key derived from `MYNT_VAULT_KEY`, so rotating that key splits each customer's ledger and state-history rows into before and after, and nothing links the two), `status`, `external_ref`, timestamps and an idempotency key (one quote is one movement). Statuses only move forward: `requested` → `submitted` → `settled` → `reversed`, or `failed`. `failed` frees the amount for the day; everything else keeps it. A retry of a failed movement is the same row. Only an explicit list of partner refusals (a customer not onboarded, an unknown quote, a refused credential and the like, never behind a 5xx) marks it `failed`. Anything else, including a code Mynt doesn't know, leaves it `requested` with `status_detail: outcome_unknown:…`, still counted, because the money may have moved. From then on only the partner's own final answer to the current attempt can fail it: a retry being refused, or an earlier attempt failing, says nothing about the attempt in hand. Every attempt's request id is kept, so a settlement or reversal reported against any of them lands. One movement can be tried at most 10 times (`MAX_MOVEMENT_ATTEMPTS`); after that, `too_many_attempts`. Partners' terminal answers are recorded whatever state the run is in, and a settlement arriving after Mynt gave up moves `failed` on to `settled`, flagged `late_settlement`. A partner's reported total is kept in `settled_amount_cents`, and `settled_amount_differs` flags a difference from what was quoted (null when the partner doesn't say). Movements nobody answers for (48 hours `requested`, 45 days `submitted`) are swept to `failed` with `status_detail: stale_no_answer`. A transfer the poller stops waiting for without a void from the partner is `failed` with `status_detail: mynt_gave_up`.

**Reading it.** `flowsFor(productId, from, to)` returns, for live movements requested in `[from, to)`, `flows[direction][status] = { count, amount_cents }`. A figure that can't be measured is `null`, never 0, with the reason in `not_measured`: a period starting before the ledger did, an unknown product, or a direction Mynt doesn't instruct for that product (money in an innovator's own hosted flow is invisible to Mynt). Swept movements and ones Mynt gave up on are in `unresolved[direction]`, in none of the status totals, because Mynt doesn't know what happened to them.

## Liquidity pools

Liquidity providers are firms or funds that put capital into a product's pools and take it out. **Mynt never holds funds:** it records and instructs, the money stays at the licensed partner, and every deposit and withdrawal goes only through the [money-rails chokepoint](#approved-money-rails) on an approved rail of the pool's sponsor. Customers only ever see dollars; every figure here is integer US cents. A figure that can't be measured is null with a reason, never 0. The code is `core/src/liquidity.ts`, `core/src/liquidity-tools.ts` and `core/src/liquidity-schema.ts`.

**Pooled investor capital with withdrawal rights may be a securities offering.** Mynt builds the mechanics only and takes no view on whether a given pool is one. Real (non-sandbox) commitments are refused, by a hard gate on the deposit path, until an admin sets the pool's `offering_cleared` flag with `set_pool_offering_cleared`, recording who cleared it and the legal basis (`offering_cleared_by`, `offering_legal_basis`); the refusal (`offering_not_cleared`) says why. Sandbox pools move no real money and aren't subject to it. Someone at the pool's product firm or sponsor can't set it, even with the admin role. An uncleared real pool isn't listed to liquidity providers.

**A pool** belongs to one product component and is created by the product's builder (`create_pool`), for a component with an approved sponsorship. It's USD, with a status of `open`, `paused` or `closed`, a minimum reserve (`min_reserve_bps` of obligations, 10000 = 100%, rounded up, plus `min_reserve_floor_cents`), a notice period in days (0 is allowed) and per-firm commitment limits (`min_commitment_cents`, `max_commitment_cents`, counted against the firm's settled net position plus what's still on its way in). It's paused until the component's sponsor approves it (`approve_pool`) and names its rails: an approved `deposit` or `on_ramp` rail and an approved `payout` or `off_ramp` rail, both its own, with every state the deposit rail serves also served by the payout rail, so capital that came in can get out. A pool uses the rails named at approval and no other: it doesn't follow a replacement if one is revoked. Sandbox pools (`sandbox: true`) run the same mechanics on sandbox ledger rows, and a sandbox commitment gives no access to the product's health figures, so it can't be a way into a real product's books.

**Commitments and capital.** `commit_to_pool` takes an amount and the US state the capital moves from (as the firm states it, as with a customer's `residence_state`; the rail must serve it). That state can't change while the firm holds a position, and only takes effect once a deposit is authorised. A pool's sponsor or its product's firm can't be a liquidity provider in it. It reserves a deposit under the pool's lock, checks the limits, and asks the chokepoint. Every movement is a row in the ledger tied to its pool and firm in `pool_movements`, with its own idempotency key, so a retried call is the same movement. A real commitment also needs the product published.

**Positions.** `list_my_positions` shows `contributed_cents`, `withdrawn_cents` and `balance_cents`, worked out from the movement ledger, from **settled movements only**: nothing stored can disagree with it. A movement still on its way (`pending_*`) or that Mynt swept with no answer (`unresolved_*`) doesn't count as settled. A deposit or withdrawal returned after settling leaves the position by itself, so a reversal reduces contributed or restores what was withdrawn. `available_to_withdraw_cents` is the balance less what's on its way out, unresolved, or already queued. What settled is the partner's reported amount when it's less than what was asked; a report of more is refused and flagged to admins (`ops_status`), and a short settlement shows the amount that settled and ends the request as `paid_short`.

**How money actually moves.** Mynt has no direct path that instructs a pool's rail (see money rails: `ach`, `wire`, `rtp`, `fednow` and `push_to_card` carry no instruction, and pool movements aren't ramp customer transfers). A deposit or withdrawal is a `requested` row in the ledger; the sponsor sees it (`list_money_movements`, `list_withdrawals`), moves the money on its rail, and says what happened with `report_pool_movement` (`submitted`, `settled`, `failed`, `returned`). That report is what settles a position, so the sponsor's word on its own rail is the source of truth for these movements; a live settlement needs its `external_ref`. A sponsor should check a movement's `pool_hold` in `list_withdrawals` before moving money on a requested row. A settlement is a fact, so it's recorded even if it takes the firm's position below zero (for example a deposit returned before a payout landed); that raises an open `negative_balance` flag with the partner's `external_ref`, which stays in `ops_status` and `list_pool_flags` until an admin closes it (`resolve_pool_flag`). The one settlement refused is a double claim: a withdrawal written off for certain whose amount has since gone out another way. That's flagged too (`double_claim`), and an admin can accept or reject it.

**The withdrawal queue** is first in, first out per pool (`request_withdrawal`, `cancel_withdrawal`, `list_withdrawals`). A request becomes eligible after the pool's notice period. A worker (`LiquidityWorker`, a `serialLoop` like the others, `LIQUIDITY_POLL_MS`, default 60 seconds) pays the queue in order:

- **The latest snapshot** of the pool is the newest finished one (published or missed); a period still waiting for its co-signature or the chain doesn't count yet. Payment stops, with the reason shown in `pause_reason` and each request's `waiting_reason`, if there's none, if it's a missed period, if a live pool's snapshot is sandbox-sourced or not from the partner's live ledger or isn't verified, if it's older than `POOL_HEALTH_MAX_AGE_MINUTES` (default twice the health interval), or if reserves or obligations are null, naming the reason the figure carries. A snapshot from a sponsor other than the pool's also stops it. Sandbox pools use sandbox figures and don't need `verified`, which a sandbox snapshot never is. A pool's snapshots read its own sponsor's books, so a second sponsor's pool is judged on its own firm's figures. **Only a sandbox ledger ships today, and a live pool needs a verified live-ledger snapshot, so no live pool can pay out until a licence provider's real ledger is connected.**
- **The reserve.** A request is paid only as far as the pool's reserves, less whatever may have left since that snapshot was read, stay at or above the minimum. A sponsor's reserves for a product are one figure (per sponsor per product: see `core/src/partner-ledger/types.ts`), so that sponsor's pools on the product share one headroom, locked together in id order: what's subtracted is every withdrawal of its real pools on its way, unresolved, or settled after that reading, its other outflows on the product since then, and any deposit reversed since. Money leaving those reserves in a way Mynt can't see (outside its movement ledger) is treated as none until the next reading shows it. That can be a partial payment, and the rest stays at the same place in the queue, with nothing behind it passing. A payment is also capped at the rail's per-transfer limit; the rail's daily limit and status are checked at the chokepoint, where a refusal sends the amount back to the queue and shows in `hold_reason`. The worker waits 15 minutes before asking again after a refusal about the rail. A refusal about one firm (a state the rail doesn't serve) parks that request after three (`status: parked`, `status_reason`), so the queue moves on. A parked request keeps its place: the worker checks it again, and the sponsor or an admin can correct the firm's state (`set_pool_firm_state`). A correction must pass the money rails' own sponsorship and licence checks. A sponsor's changes nothing until the firm accepts it (`respond_to_state_correction`, listed in `list_my_positions`), so it can't be used to park or pass over a firm; an admin's applies at once and the firm can dispute it for `POOL_CORRECTION_DISPUTE_DAYS` days (14 by default), which restores the old state and who set it. A sponsor's proposal never replaces an admin's applied correction, so it can't take that right away: only a newer admin correction or the firm's own acceptance of a pending one does. Only the latest correction can be answered: a new one replaces any the firm hasn't answered. The state's source is kept on the commitment and each movement (`sponsor_corrected`, `admin_corrected`), so a sponsorship change doesn't cost a firm its place. Those checks ask the rails without making a movement, and back off (15 minutes doubling to 6 hours), so a request that stays refused leaves no new rows or audit entries. A suspended firm, one with a parked request, or one whose own payment outcome isn't known yet is passed over and doesn't stop the firms behind it.
- **Pausing and resuming are automatic.** When health drops, the worker sets the pool to `paused` (`pause_kind: health`), and when a snapshot shows it above its minimum again, back to `open`. A revoked sponsorship, an inactive sponsor or a drifted product pauses it the same way (`pause_kind: governance`), and that clears itself once the cause is gone. A [covenant](#covenants-a-licence-providers-rules-on-a-product-it-sponsors) pause doesn't: it stops new sign-ups and never money movements, so on its own it stops neither a pool's deposits nor its withdrawals (health gates still apply), and pool capital isn't in the money in flight a covenant reports. A real deposit is checked against the pool's latest health every time, open or paused: it's let in only if a snapshot Mynt trusts shows the pool healthy, or short of its reserve, because new capital is how a pool gets back above it. If the snapshot is missing, stale or unverified, there's no telling what the pool could pay back, so it's refused with the reason (`health_unconfirmed`). A newly approved live pool stays paused until the worker's first check. Every other pause stops commitments too.
- **Manual pauses.** An admin or the pool's sponsor can `pause_pool` (and `resume_pool`); the worker never lifts one. A sponsor can't lift, change or close over an admin's pause: only an admin's resume clears it. Approving never reopens a closed pool. With `close: true` a pool stops taking commitments for good but keeps paying its queue, subject to the same checks.
- **Nobody gets paid twice.** The claim is one Postgres function that locks the pool's row (as `reserve_money_movement` locks the rail) and takes the amount from the request before the chokepoint is asked, so concurrent workers can't both have it and can't overdraw the reserve between them. A worker that dies between the claim and the chokepoint is picked up on a later tick. A claim that already has a ledger row is tied to it first, under any pause, since that moves no money, and is never released. A withdrawal claim with no ledger row is released, so it's claimed again against headroom as it is now, once the pool has passed its gate; a deposit is re-checked against the pool's status and `offering_cleared`. A payment that failed for certain goes back to the same place in the queue; a payment whose outcome isn't known counts as gone until the sponsor says, and holds the firm's request; one returned after settling isn't paid again by itself, so the firm asks again (a request whose whole amount came back is `returned`).

| Tool | Who | What |
|---|---|---|
| `create_pool` | Builder | Proposes a pool on its firm's sponsored component. |
| `approve_pool` | Licence provider | Approves a pool it sponsors and names its approved rails. |
| `set_pool_offering_cleared` | Admin | Records who cleared a pool's offering and the legal basis; the gate on real commitments. |
| `report_pool_movement` | Licence provider | What became of a movement of a pool it sponsors. |
| `list_pool_flags` | Admin, licence provider | Items open until someone deals with them: `negative_balance`, `double_claim`, `link_conflict`. |
| `resolve_pool_flag` | Admin | Closes one, with a reason, together with its effect on the ledger: accepts or rejects a double claim, or links or closes a `link_conflict` (counted against the pool's headroom until then). Not by anyone at the pool's sponsor, the product's firm or the firm it concerns. |
| `set_pool_firm_state` | Admin, the pool's sponsor | Corrects a firm's state. |
| `respond_to_state_correction` | Liquidity provider | Accepts or disputes a correction. |
| `commit_to_pool` | Liquidity provider | Commits capital: a deposit on the pool's rail. |
| `request_withdrawal`, `cancel_withdrawal` | Liquidity provider | Joins or leaves the queue. |
| `list_my_positions` | Liquidity provider | Contributed, withdrawn, balance, and what's pending, unresolved or reversed. |
| `list_pools` | All of the above, admin | Scoped: an admin all; a builder its products'; a licence provider what it sponsors; a liquidity provider those it's in, or that are approved and sandbox or cleared. |
| `list_withdrawals` | All of the above, admin | The queue, in order, with why each request is waiting. |
| `pause_pool`, `resume_pool` | Admin, the pool's sponsor | Stops or restarts a pool; with `close: true`, closes it. |
| `list_pools_with_health` | Liquidity provider | The pools it may see, side by side: coverage, trend, gaps, verified status and reserve headroom. Numbers only for pools of products it's committed to, through product health's own entitlement, so an admin account is still refused them; otherwise each is null with its reason. |

Every one of these, and every refusal that matters, is in the audit log, including the read-only ones. The worker's own actions are `pool_auto_paused`, `pool_auto_resumed`, `pool_withdrawal_claimed` and `pool_withdrawal_refused`. Pool deposits and payouts are in the ledger but left out of the product's health flows and failure rates (`flowsFor`), which describe its customers, and sandbox pools are left out of its open withdrawal count. Everything a position, request or movement shows carries `sandbox`, so test money can't be read as real.

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

A product's full definition follows [`core/schemas/financial-product.v2.schema.json`](../core/schemas/financial-product.v2.schema.json).

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

**The reference catalogue's definitions.** Mynt's reference products have no firm, so their definitions name no providers, partner handoffs or risk models (those belong to the firm that offers the product, with its consent purposes and its model governance), but they carry everything else: components, segments, algorithms, terms, rates, fees, limits, servicing, lifecycle events and the register obligations each part satisfies. Admins save one with `set_product_definition`, then `test_product` and `publish_product` publish it as the product's next version, with a developer contract. [`core/schemas/examples/seed/`](../core/schemas/examples/seed/) holds definitions for `savings-account`, `fixed-deposit`, `recurring-deposit` and `personal-loan` (India), each with its sources and assumptions in `descriptions.long`. They point at the RBI in India's regulatory model: regulator `rbi` with the personas `rbi_resident_individual`, `rbi_senior_citizen` and `rbi_retail_borrower`, and the universal bank licence `rbi_universal_bank` with the thirteen `rbi_*` obligations they cite. [`core/schemas/regulatory/in.additions.json`](../core/schemas/regulatory/in.additions.json) adds exactly those to a server that already has the RBI and that licence, as production does, and only adds (see the regulatory model script below); apply it first. [`core/test/seed-regulatory-model.js`](../core/test/seed-regulatory-model.js) builds a slice shaped like production's and applies it. The catalogue cites the regulator whose licence types grant the lead component's product type, preferring the one whose licence the definition's register items cite, so these four cite RBI. To apply them to a server:

```sh
# in the repository's core/ folder
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
   cd mynt/core
   ```
   If `git` isn't installed, download the ZIP from the repository's green **Code** button instead, unzip it, and `cd` into its `core` folder.
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

A region's regulatory model can be kept as data and applied in one step. [`core/schemas/regulatory/us.json`](../core/schemas/regulatory/us.json) is the US slice for on-ramps, off-ramps and buy-and-hold stablecoin products, each instrument with its source:
- **FinCEN:** money services business registration (`fincen_msb`; it covers no state by itself and is the prerequisite of every state money transmitter licence), with its AML, suspicious-activity, currency-transaction, funds-transfer and Travel Rule obligations, plus the OFAC, Regulation E and Form 1099-DA obligations every ramp carries;
- **NYDFS** (`jurisdiction: "us-ny"`): the money transmitter licence (`nydfs_money_transmitter`), the BitLicense and the limited purpose trust charter;
- **California DFPI** (`jurisdiction: "us-ca"`): the money transmission licence (`ca_dfpi_money_transmitter`) and the Digital Financial Assets Law licence;
- **OCC:** the national trust bank charter and the GENIUS Act's federal payment stablecoin issuer.

It also defines the product categories and regulated product types they cover. Applying it loads the US service types too, including the Mynt Ramp's four. NYDFS and DFPI licences cover only their state, and the state money transmitter licences count only alongside the FinCEN registration (`requires`), which covers no state by itself (`covers: []`). The OCC charters cover every state (`covers: ["us"]`), each with a `coverage_note` saying that this is an assumption to verify. To add a state's money transmitter licence, follow the pattern in the file's `description`. See [Coverage per state](#coverage-per-state).

```sh
# in the repository's core/ folder
node scripts/apply-regulatory-model.mjs --url <the server's MCP URL> --login --dry-run   # check only: prints what would be added, updated or removed
node scripts/apply-regulatory-model.mjs --url <the server's MCP URL> --login             # apply
```

It merges the file into what the server has; it never replaces it. For each category, product type, instrument and regulator in the file it reads the server's version, merges the file into it by id (licence types, personas, product-type mappings, GRC registers and repositories, stakeholders) and sends the merged whole, so anything the file leaves out is kept. A file can hold only additions, like [`core/schemas/regulatory/in.additions.json`](../core/schemas/regulatory/in.additions.json). Items that end up unchanged aren't sent.

It checks every merged item against the server's own tool schemas first and changes nothing if any is wrong. The dry run prints, per item, what would be added (`+`), updated (`~`, with the fields) and removed. Merging removes something only when a plain list in the file lacks an entry the server has (an action, a covered state, a product line), or when a shipped service type would overwrite a different version on the server. Any removal stops the run, changing nothing, unless you add `--allow-removals`; the removals are listed either way. Even with `--allow-removals`, items the file doesn't mention are never deleted: use the `remove_*` admin tools for that. The region's regulator names are merged, not replaced. Sign-in works as for the seed definitions above. [`core/test/us-regulatory-model.test.js`](../core/test/us-regulatory-model.test.js) runs exactly what the script does.

**A US product to start from.** [`core/schemas/examples/us/usdc-account.v2.json`](../core/schemas/examples/us/usdc-account.v2.json) is a firm-less template for a **Dollar Holding Account** (`dollar-holding-account`): customers add, hold and cash out US dollars and see dollars only. (The **Dollar Account**, `dollar-account`, in [`dollar-account.v2.json`](../core/schemas/examples/us/dollar-account.v2.json), is the other route: it builds on the money-transmission product instead of composing the ramp itself; see [base products](#base-products).) Underneath, for the regulatory model, a ramp (`payments:sale`) funds a USDC purchase on Solana (`settlement_exchange`, `exchange:sale`, `digital_assets`), which settles into custody (`settlement_custody`, `custody_settlement:servicing`); cashing out settles back through the ramp. It has customer segments, KYC, sanctions screening and quoting algorithms, fees, limits, statements, lifecycle events (on-ramp and off-ramp acceptance become the customer actions in its developer contract) and the FinCEN register obligations each part satisfies. A firm takes it as is and adds:
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

The server is the repository's `core/` folder, installed on its own from its own lockfile. The apps built on it (Mynt Studio, the sample chat, and the sign-in code they share) are under `platform/` and are the repository's npm workspaces: `npm ci` at the root installs them, never the server.

```bash
git clone https://github.com/never2average/mynt.git
cd mynt/core
npm ci
npm run build
```

The commands below run in `core/`.

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
claude mcp add mynt -e DATABASE_URL=postgres://... -e FINANCIAL_PRODUCTS_TOKEN=fpm_... -- node /absolute/path/to/mynt/core/dist/index.js
```

Claude Desktop / other clients:

```json
{
  "mcpServers": {
    "mynt": {
      "command": "node",
      "args": ["/absolute/path/to/mynt/core/dist/index.js"],
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

**Mynt's own apps sign in without a consent screen.** People signing in to the studio or the chat app (Mynt's own apps) aren't asked to "allow Mynt to access Mynt". How it works:
- Each first-party app is a pre-registered Clerk OAuth application. It's a confidential client (its secret stays on that app's server), with PKCE required and its consent screen off.
- Only an operator creates one, naming the app's exact redirect URI: https (http only for localhost), no wildcard (`*`) anywhere, host or path, no user name or password, no query or fragment (not even a bare `?` or `#`), written in its normal form (lower-case host, no default port). Anything else is refused before Clerk is asked.
- Every client that registers itself (MCP clients such as Claude, and any third party) still gets Clerk's consent screen. Clerk doesn't let a dynamically registered application turn it off, and Mynt never changes that.

Operator steps, once per app (the domain is a placeholder for that app's own):
1. On the server, run:
   ```bash
   node dist/index.js clerk first-party mynt-studio https://<studio-domain>/api/auth/callback
   ```
2. It prints the client id. The client id and its secret go to `~/.mynt/oauth-mynt-studio.json`, a file only you can read (or the path you give with `--file`); `~/.mynt` itself is kept at 700. The secret is never printed. If the file can't be written, the Clerk application is deleted again (its secret would otherwise be lost), and the error says whether that worked or which application to delete by hand.
3. Give the client id and secret to that app's server as its OAuth client, in place of registering itself: `MYNT_OAUTH_CLIENT_ID` and `MYNT_OAUTH_CLIENT_SECRET` for Mynt Studio and mynt-chat (see their READMEs). Then delete the file.
4. Registering the same name again is refused, because the secret can't be read back. To replace the secret, rotate it in Clerk's dashboard.
5. Each one allows the scopes Mynt's apps ask for: `openid profile email` (the same list Mynt's protected-resource metadata publishes). An app registered before `openid` was included makes every sign-in fail with `invalid_scope`; repair it in place, keeping its secret, with:
   ```bash
   node dist/index.js clerk first-party --update-scopes mynt-studio
   ```
   (by name or client id; it says whether anything changed, and prints only the name and client id).

When the authorization server refuses a sign-in, the apps tell the person why only as far as they can act on it: declining (`access_denied`) shows "Sign-in was cancelled"; any other refusal (`invalid_scope`, `invalid_client`, `invalid_request`, `server_error`...) shows "Sign-in isn't set up correctly on Mynt's side. Please tell your admin." and logs the error code and a short, cleaned description on the app's server (never the state or code).

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
- Builds the MCP image (from `core/`) and runs it with Caddy, which gets the TLS certificate automatically, serving `https://<domain>/mcp`.

Create users on the VM:

```bash
docker compose -f /opt/mynt/src/deploy/docker-compose.yml exec mcp \
  node dist/index.js users add --name "Ines" --role innovator
```

### On a server that already runs Caddy

[`deploy/host/install-host.sh`](../deploy/host/install-host.sh) installs Mynt without Docker for Mynt itself (Supabase still runs in Docker): `bash install-host.sh <domain> [git-ref] [--studio-upstream <studio host> | --no-studio]`. Each deploy unpacks the commit into `/opt/mynt/releases/<commit>`, installs and builds the server in that release's `core/` folder from core's own lockfile, points `/opt/mynt/current` at it and restarts `mynt.service`, which runs `node dist/index.js serve-http` in `/opt/mynt/current/core`. Releases from before the repository was split into `core/` and `platform/` ran from the release's root; deploying one of them again (a rollback) runs that commit's own installer, which puts back its own unit file. Each new release also links `dist` to `core/dist`, so `/opt/mynt/current/dist/index.js` still works for anything that runs it.

The installer refuses a commit from before `core/` existed ("uses the old layout; run that commit's own installer") before it deletes or changes anything, and never deletes the live release. To go back to such a commit, run that commit's own `deploy/host/install-host.sh`. Where the hosting gateway is set up (`hosting-gateway.sh`, legacy gateway mode), every deploy now also replaces its installed sync script (`/usr/local/sbin/mynt-gateway-sync`) with this release's `hosting-gateway.sh`, which its timer runs within a minute: a change to that script goes live with the deploy, not only when the gateway is set up again.

### Mynt Studio on Mynt's domain

On a host installed with [`deploy/host/install-host.sh`](../deploy/host/install-host.sh), Mynt Studio can be served on the same domain as Mynt, with no studio subdomain:

```bash
bash install-host.sh <domain> [git-ref] --studio-upstream <studio host>
```

`<studio host>` is where the studio actually runs, for example its Vercel deployment's address (a host name only: no scheme, port or path).
- **What stays with Mynt:** every path Mynt serves goes to it exactly as before: `/mcp`, `/healthz`, `/v1` and `/v1/*`, `/agent/*`, `/bd/*`, `/.well-known/*`, `/llms.txt`, `/llms-full.txt` and `/ramp-sandbox/*`.
- **What goes to the studio:** everything else, `/` included, is proxied to the studio host. Streaming isn't buffered.
- **Mynt's `/` pointer:** the one-line text Mynt used to answer at `/` is now the studio's home page, but `/llms.txt` still tells MCP clients and AI assistants where the endpoint is.
- **Persistence:** the setting is kept in `/etc/mynt/edge.env`, which is root-only and holds no secrets, so later deploys without the flag keep it. `--no-studio` turns it off. Without it, Caddy's site for Mynt is exactly what it was. `deploy/host/render-site.sh` renders the site, and CI checks its routes with Caddy itself.

**The caller's address.** This server removes any `X-Mynt-Client-IP` a caller sends, on every path, and then sets it to the caller's real address on requests it passes to the studio. The studio trusts the header only when the request comes from an address in its `TRUSTED_EDGE_IPS` setting. Every response also gets `X-Content-Type-Options: nosniff`.

**Going live, in this order:**
1. **Deploy the edge first:** run `install-host.sh <domain> --studio-upstream <studio host>`. The studio keeps working at its own address meanwhile.
2. **Then set the studio's settings and redeploy it:**
   - `APP_URL`: `https://<domain>`. Sign-in then returns to Mynt's domain, and everyone signs in once more.
   - `TRUSTED_EDGE_IPS`: every public outbound address of this server, IPv4 and IPv6. A missing one doesn't break the studio. Requests from it are still served, because they carry `X-Mynt-Client-IP`, but every user coming through it shares one sign-in rate-limit bucket (429 after 20 starts in 10 minutes). The studio logs a warning naming the address to add.

From then on, people reach the studio only through Mynt's domain. A request to its own deployment address from anywhere but this server, without `X-Mynt-Client-IP` (a browser, for any path), gets a 308 to the same path on `APP_URL`.

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
# in core/ (from the repository root, npm test runs the same)
npm test   # builds, then tests roles, the innovator workflow, ownership and HTTP auth on in-process Postgres (PGlite)
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # also runs the CLI/stdio test against a real Postgres
```

## Disclaimer

Mynt ships no catalogue: every product comes from an innovator. Product information is for informational purposes, contains no live rates and is not financial advice; rules (tax treatment, limits, lock-ins) change, so verify with the relevant regulator or provider. Enrollments here are records in this server's database, not real accounts.

## License

MIT
