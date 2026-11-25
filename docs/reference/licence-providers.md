# Firms, licences and licence providers

This file covers a firm's record on Mynt (its legal entity, parties and compliance folders), how a licence provider sponsors a builder's product, the public checks Mynt runs on a licence provider's firm, a regulated firm's onboarding checklist, covenants, the partner kit that connects a licence provider's ledger, and product health. It is for licence providers, for builders asking for sponsorship, and for Mynt admins reviewing firms.

See also: [Roles and tools](roles-and-tools.md), [Products](products.md), [Agreements](agreements.md), [Money rails](money-rails.md), [Liquidity pools and on-chain treasuries](liquidity-and-treasury.md), [Confidential computing](confidential-computing.md), [Connecting a licence provider to Mynt](../partners.md).

A licence provider is a firm that holds licences and sponsors builders' products under them (code: `license_provider`). In tool and setting names, "partner" means the licence provider: partner kit, partner ledger, `PARTNER_*`.

## Legal entities

Every firm on Mynt is a legal entity. Its record feeds the regime check on every product that rests on it.

### Facts

A legal entity is recorded as typed facts, never prose:

| Fact | How it is recorded |
| --- | --- |
| Legal form | From a fixed list |
| Incorporation | Lowercase ISO 3166 codes such as `in` or `in-mh` |
| Identifiers | `{ scheme, value }` pairs, for example `in_cin`, `lei` or `us_ein` |
| Status | Set by Mynt admins from the company registry |
| Licences held | Verified by Mynt admins |

### Parties

Each entity keeps a party roster (`add_party`, `end_party`):

- **Internal** parties are people, such as the compliance officer.
- **External** parties are other legal entities, such as the statutory auditor or a lending partner.

A party fills the mandatory stakeholders that the licence type of a held licence requires (`grc.mandatory_stakeholders` in the regulatory model). It may also be a counterparty, with a relationship code.

Parties aren't edited. To change one, end it and add a new one.

`get_my_entity` lists the roster, naming the firm behind each external party (`legal_entity_name`), and reconciles each held licence against it. It reports:

- which mandated stakeholders are filled, and by whom;
- which are missing;
- which parties fail the stakeholder's qualification criteria;
- which parties have no stated facts for those criteria.

### GRC folders

Each entity, and each party on its roster, has a governance, risk and compliance (GRC) folder (`file_grc_record`, `get_grc_folder`). It is laid out like the GRC of the licences the entity holds, in two parts:

| Part | What it holds |
| --- | --- |
| Registers | Obligations hold a compliance status and the owner party. Filings hold the period, status and when they were filed. Risks hold the inherent and residual rating. Controls and inspection events follow the licence's templates. |
| Repositories | Communications, enforcement actions and press releases are simple records. Policies, risk models and inspection history follow the licence's templates. |

Template records are checked against the template's field schema. Owners and approvers must be active parties on the roster.

Mynt matches the folder against each licence's GRC and lists the gaps:

- an item with no record;
- an owner or approver who doesn't fill the stakeholder the regulator holds accountable;
- an obligation marked non-compliant.

A vendor's due diligence goes in the vendor's own folder and still counts towards the licence.

### Who provides each component

A product names who provides each component: the owner itself, under one of its licences, or an external party on the owner's roster. Products never name parties by free text.

### Pins and drift on the entity

Publishing pins two things: the live composition, and a hash of the state of every entity, licence and party it rests on. Some changes mean the product has drifted:

- a licence lapses or is suspended;
- a party ends;
- an entity is struck off.

A drifted product pauses new enrolments and emits `product.drifted`. New enrolments resume when the state is restored (`product.drift_cleared`) or a new version is published.

Changes made through Mynt are checked at once. The HTTP server also re-checks every hour, so expiries are caught.

## Sponsorship

A builder needn't hold licences. A licence provider is a firm that does.

### Setting up a licence provider

1. A Mynt admin adds the firm by hand: `register_firm`, `invite_user` with the `license_provider` role, and `add_entity_member`. Someone who hasn't signed in yet joins the firm when they first do.
2. The firm registers its licences with `register_license`.
3. A Mynt admin verifies them with `review_license`, as for any firm.

The firm's people share its firm id with builders out of band. There is no directory of firms.

`get_regulated_firm_onboarding` shows the firm, and Mynt's admins, how far along it is: see [Onboarding a regulated firm](#onboarding-a-regulated-firm).

### Asking and deciding

1. **The builder names the licence provider** as a component's provider: `{ by: "sponsor", entity_id }` in `set_product_composition`, or `component_provided_by` set to `{ kind: "sponsor", id }` in a v2 product definition.
2. **The builder asks** with `request_sponsorship`: the product, the component, the licence provider's firm id and the jurisdictions (by default, where the component is offered). One request may be pending per component and licence provider. Asking again later adds jurisdictions.
3. **The licence provider decides.** `approve_sponsorship` names its held licences, which must be verified and in force, and the jurisdictions they cover. `decline_sponsorship` refuses. `revoke_sponsorship` withdraws an approved sponsorship.

A registration that covers nowhere by itself, like the FinCEN registration, isn't named in `approve_sponsorship`. It counts automatically as the named licences' prerequisite.

### Sponsorship tools

A sponsorship's status is `pending`, `approved`, `declined` or `revoked`.

| Tool | Who | What it does |
| --- | --- | --- |
| `request_sponsorship` | Builder | Asks a licence provider to sponsor one component |
| `list_my_sponsorships` | Builder | The firm's requests and their status, with `covenant_pauses` |
| `list_my_licenses` | Licence provider | The licences the firm holds, whether each is in force, where it covers, and the approved sponsorships under it |
| `list_sponsorship_requests` | Licence provider | Builders' requests (pending by default), with the firm's own `your_firm_legitimacy` |
| `approve_sponsorship`, `decline_sponsorship` | Licence provider | Decide a request |
| `revoke_sponsorship` | Licence provider | Withdraws an approved sponsorship; takes an optional `breach_id` |
| `list_sponsored_products` | Licence provider | Every approved sponsorship by the firm |

### The regime rule

A sponsored component is covered in a jurisdiction only by a licence of that licence provider which meets all of these:

- an approved sponsorship names it for that jurisdiction;
- it is verified and in force;
- it grants the component;
- it covers the jurisdiction;
- the licence provider's own prerequisites are held.

Anywhere else the component is blocked ("Ramp Partner Inc (sponsor) doesn't sponsor this in us-ca"). With no approved sponsorship at all it is blocked everywhere.

A builder with no licence and no sponsoring licence provider is blocked too ("Your entity holds no verified licence granting this").

### Mandated stakeholders

Mandated stakeholders are the licensee's. The regulatory model attaches them to the licence type, and the licence is the licence provider's, so they must be filled on the licence provider's roster. This is enforced: a gap blocks publishing, as it does for the owner's own licences.

They aren't bound to the builder's product, since they aren't on the builder's roster. The builder still names its own `product_owner`.

### Pins and drift

Publishing pins each covering sponsorship (with the jurisdictions it covers), the licence provider's licences and its stakeholder parties, and the licence provider's firm.

Revoking the sponsorship, or the licence provider's licence lapsing or being suspended, drifts the product, naming the jurisdictions.

The stored `regime_summary` shows `provided_by: "sponsor"`, the licence provider's name, and on each covered jurisdiction a note such as "Covered by Ramp Partner Inc's Money transmitter licence (New York Banking Law Article 13-B) (sponsored)".

### What test_product says about licences

`test_product` doesn't warn a builder that holds no licence when it needn't hold one:

- If the builder provides no component itself and every component is covered by a sponsoring licence provider (or a partner), `licence_held` passes and names who covers what ("Example Money Transmitter (placeholder) sponsors 'transmission' in us-ny, us-ca").
- While a sponsorship is still pending, it warns only that the composition isn't covered yet. The reason says the request is waiting for the licence provider's decision, not to ask again.
- A builder providing a component itself is still warned when it holds no licence.

## Firm checks

Is the licence provider a real company? Mynt checks it itself, against public sources, and never takes the firm's word for it.

### Running the checks

- A Mynt admin runs the checks with `run_firm_checks` (entity id).
- Every licence provider's firm is re-checked monthly (`FIRM_CHECKS_EVERY_DAYS`, default 30). A source that was down is retried daily.

Each answer is kept, newest first, with its source, URL, `retrieved_at`, the fields it matched, a status and a SHA-256 hash of the answer in a stable form, so a changed record shows as a changed hash. The status is `match`, `mismatch`, `not_found` or `unavailable`.

### Sources

**`gleif_lei`: GLEIF's LEI record**

- What Mynt asks: `GET https://api.gleif.org/api/v1/lei-records/<LEI>`, using the firm's `lei` identifier. A malformed LEI is never sent.
- Matched against the firm's legal name, its jurisdiction (GLEIF's `US-DE` against its incorporation), the entity's status (`ACTIVE`) and the LEI's status.
- LEI statuses that count: `ISSUED`, `PENDING_TRANSFER` or `PENDING_ARCHIVAL`. `LAPSED`, `RETIRED` and the rest are a lapse.
- The registration authority and number are recorded.
- Terms: free, no key. The data is CC0 ([LEI Data Terms of Use](https://www.gleif.org/en/meta/lei-data-terms-of-use)).

**`fincen_msb`: FinCEN's MSB Registrant Search list**

- What Mynt asks: the list's own "View/download … in Excel" export at [msb.fincen.gov](https://msb.fincen.gov/). It is tab-separated text, holds every current registrant and is updated weekly. One download serves six hours of checks.
- Matched against the firm's legal name, and the registrant's state against the states of the firm's legal and head-office addresses in its matching LEI record. Without an LEI record, a single registrant of that name matches; several are `not_found` rather than a guess.
- Terms: a US government record. FinCEN offers the export "for the benefit of the financial institutions … to integrate into their data processing systems". Mynt fetches only that file, never the search pages.

Requests go through Mynt's outbound helper (`core/src/vendor-call.ts`: HTTPS only, no private addresses, no redirects, a time limit and a size cap) to those two fixed hosts only.

### What is verified by hand

Two things are not fetched:

- The FinCEN list carries no registration numbers.
- NMLS Consumer Access has no API anyone may use, and its terms forbid downloading what it shows. NMLS's paid B2B Access is the sanctioned route.

So the firm's FinCEN registration number (identifier `us_fincen_msb`, or its registered FinCEN licence) and its NMLS ID (identifier `us_nmls`) are listed under `verify_by_hand` with the page to check them on. The firm's state licences stay verified by a Mynt admin with `review_license`.

### The rule

`approve_sponsorship` is refused until the licence provider's firm passes the rule set by `SPONSOR_LEGITIMACY_RULE` on the server:

| Value | A licence provider may sponsor when |
| --- | --- |
| `lei_or_msb` (default) | its latest LEI answer or its latest FinCEN answer is a `match`, and neither is a mismatch or a lapse |
| `lei_and_msb` | both are a `match`, with no mismatch or lapse |
| `lei` or `msb` | that one is a `match`, with no mismatch or lapse |
| `off` | always: no gate and no drift. For staging with the placeholder firm only, which isn't a real company |

How answers count:

- "Latest" skips `unavailable` answers. An outage keeps the last real answer and is never held against the firm.
- A lapse is a source that matched before and now finds nothing (the firm dropped off FinCEN's list), or an LEI whose status lapsed.
- Answers count only for the firm's current facts. A new LEI or legal name needs a fresh run.
- The refusal says which checks failed and what to do.

`get_regulated_firm_onboarding` says where the check stands before anyone tries to approve (see [Onboarding a regulated firm](#onboarding-a-regulated-firm)). `get_my_entity`, the admin's `list_entities` and each of `list_sponsorship_requests` show the result as `legitimacy` (`your_firm_legitimacy` in the requests): whether it passes, why not, each source's latest status, URL and time, and what to verify by hand.

### Drift from a failed check

A mismatch or lapse found later drifts every published product the firm sponsors, as its licence lapsing would. The change has `kind: "legitimacy"`, the firm's id, `now` naming the flags (`flagged:fincen_msb:lapsed`), and the jurisdictions its sponsorships covered. A later match clears it.

Nothing extra is pinned, so products published before these checks existed are covered too.

### Paid checks later

A state's Secretary of State good standing, officers and registered agent need a paid source. The US region has a `kyb_business_verification` service type for that (`core/schemas/service-types/us/`; vendors such as Middesk or Baselayer can offer it once it is wired in). It is data only for now: nothing calls it.

## Onboarding a regulated firm

`get_regulated_firm_onboarding` shows where a regulated firm (a licence provider's firm) stands on the way to sponsoring, as one ordered checklist. It only reads. Each step is done with the tools it names, which decide as before.

| Caller | Reads |
| --- | --- |
| A licence provider of the firm, with standing there | Their firm's: no arguments, or their own `entity_id` |
| A Mynt admin | Any firm's (`entity_id`), and every regulated firm's progress (`all_firms: true`: firms with a licence provider, with one invited who hasn't signed in yet, or with a sponsorship request) |

A licence provider reads only its own firm. An account still waiting to be accepted at its firm has no standing, so it doesn't have the tool. Builders, vendors, liquidity providers and consumers don't have it either.

### Steps and their statuses

Each step has a `key`, a `title`, a `status`, a `detail` in plain words, the `tool` that does it, `by` (`firm`, `admin` or `builder`), `informational` and `facts`.

| Status | Meaning |
| --- | --- |
| `done` | The step is complete |
| `next` | The first thing the firm's own people can do now. At most one |
| `not_started` | The firm's to do, after the next one |
| `blocked` | Waiting on Mynt, on a public register, or on an earlier step. The detail says which, for example "Waiting for Mynt to verify your licence fincen_msb 31000123456789" |

While the firm isn't `active`, and before it has a licence provider, nobody there can act: every step not yet done is `blocked`, and its detail starts with what it waits for.

### The regulated firm's checklist

Seven steps count towards progress, in this order:

| Step | Done when | Otherwise |
| --- | --- | --- |
| `firm_registered` | The firm is on Mynt and `active` | Blocked on an admin (`register_firm`, `set_entity_status`) |
| `licence_provider_members` | Someone at the firm has the licence-provider role, with standing (`facts.members`, and `facts.licence_providers` by name). The detail also counts those waiting to be accepted (`facts.waiting`, decided with `decide_firm_member`) and those invited who haven't signed in (`facts.invited`) | Blocked on an admin (`invite_user`, `add_entity_member`). "Mynt invited 1 person with the licence-provider role. Waiting for them to sign in" when they were added before signing in |
| `firm_facts` | The firm's record has what the rule looks it up by: its LEI (identifier `lei`), its FinCEN MSB registration number (identifier `us_fincen_msb`, or its registered FinCEN licence), or both, by `SPONSOR_LEGITIMACY_RULE`. Also done when the check already passed on the legal name alone, and when the rule is `off` | Next: `set_entity_facts`. An LEI that isn't a valid LEI is said as such |
| `real_company_check` | The firm passes [the rule](#the-rule): the detail names each register that matches, and when | Blocked, on Mynt or the register. Not run yet: waiting for an admin's `run_firm_checks` (it also runs monthly). A register that couldn't be reached is "unavailable, not a failure", with the date, and never counts against the firm. Not passed: each register's answer in words, and that `approve_sponsorship` is refused until it passes |
| `licences_registered` | The firm has a licence registered that Mynt hasn't rejected (`facts.registered`) | Next: `register_license` |
| `licences_verified` | A licence is verified and in force. The detail also counts those waiting, suspended, lapsed or not verified | Blocked while Mynt verifies (`review_license`) or has suspended one. Register again when one lapsed or wasn't verified, with Mynt's note |
| `roster_complete` | Every stakeholder the held licences mandate is filled on the roster by a party that meets its criteria (`facts.mandated`, `facts.filled`) | Next: `add_party`. The detail names what is still needed ("AML compliance officer (a person, for fincen_msb)"); `facts.missing` lists each with its licence and stakeholder id |

Three more are informational. They are shown, never counted, and never `next`:

| Step | Says |
| --- | --- |
| `partner_ledger` | Whether Mynt reads the firm's own ledger or the sandbox. Sponsoring doesn't wait for it: Mynt reads the sandbox until the ledger is connected (see [Partner kit](#partner-kit)) |
| `agreement_template` | How many program agreement templates are in use. Optional (see [E-signature](agreements.md#e-signature)) |
| `first_sponsorship` | How many sponsorships are approved and how many requests wait (`facts.approved`, `facts.pending`). While the real-company check hasn't passed, it says an approval would be refused, before anyone tries |

With `SPONSOR_LEGITIMACY_RULE` set to `off`, `firm_facts` and `real_company_check` are done, and `facts.passes` is `null`: not measured, never a pass.

### What comes with the checklist

- `progress` counts the steps done out of the seven counted, names the `next` one (the firm's own first, else what waits on Mynt) and says whether it is `complete`.
- `ready_to_sponsor` is true when the firm is active, has a licence provider, passes the real-company check and holds a licence in force: what `approve_sponsorship` needs of the firm itself.
- `legitimacy` is the same result `get_my_entity` shows.
- `checks` lists every answer the public registers gave about the firm, newest first, up to 50: the register, its status in words, when, any note, and whether it was Mynt's own monthly re-check.

With `all_firms`, each firm has its name and status, the number of licence providers, licences and approved sponsorships, whether the real-company check passes, `ready_to_sponsor` and `progress`.

A figure Mynt doesn't measure (a firm not yet registered, a check that is off) is `null`, never 0.

### My firm in Studio

Mynt Studio shows the checklist to licence providers as My firm (`/firm`, in the sidebar only for accounts granted the licence-provider role; an admin's roles only imply it):

- the firm's card, with the real-company check's latest result in words and **Set firm facts**;
- the checklist, titled "Getting ready to sponsor", each step's status in words with a labelled button where Studio can do it: Set firm facts, Register licence, Add party, Review request;
- the tabs Licences, Sponsorship requests, Sponsored products, Roster, People and Notices, each a table.

See [My firm](studio.md#my-firm). The platform admin's Regulated firms section shows each firm's progress and its real-company check, with Run checks (see [Regulated firms section](platform-admin.md#regulated-firms-section)).

## Covenants

A licence provider watches each product it sponsors and pulls its licence on bad behaviour it can see. It says what bad behaviour is: each covenant is a rule on one sponsorship, set by that firm alone. Each rule chooses whether a breach only **alerts** the firm or also **pauses** the product.

### Rules

| Rule (`rule_type`) | Threshold | Breached when |
| --- | --- | --- |
| `coverage_below` | basis points | coverage is under it |
| `reversal_rate_above`, `failure_rate_above` | basis points | the rate is over it |
| `unresolved_above` | cents | unresolved money is over it |
| `complaints_above` | a count | over it. Mynt doesn't track complaints yet, so this rule reads `unknown` until it does |
| `snapshot_missed_for` | seconds (at least two snapshot intervals) | no authenticated snapshot with real figures has arrived for longer than this. A missed period, a failed ledger read and a report that can't be authenticated don't count |
| `consecutive_gaps` | periods (at least 1) | this many periods in a row have no snapshot, counting a stretch the worker never wrote down |
| `unverified_for` | seconds (at least two snapshot intervals) | a live product has had no valid co-signature from this licence provider for longer than this |

Notes on `unverified_for`:

- Only time the product was live counts. A blip off sale of up to about one snapshot interval counts as live. So a relaunch doesn't breach at once, and publishing again doesn't restart the count.
- A licence provider whose books aren't the latest snapshot's reads `unknown` (only that firm can sign), and alerts through the unknown limit.

Each rule also has:

- a `severity`: `info`, `warning` or `critical`;
- a `cooldown_seconds`: the least time between alerts of that rule, default a day;
- an `unknown_limit_seconds`: default a day.

### When rules are evaluated

- On every new health snapshot.
- On their own timer (`COVENANT_POLL_MS`, default a minute). The timer runs whether or not the product-health worker is deployed, so a rule about missing snapshots fires even when the worker has never run.

A rule changed with `set_covenant` takes effect from the next evaluation, which re-judges the latest snapshot. A product that isn't live isn't evaluated and raises no alarms. Evaluation covers a product's own record, not a pool's.

### Unknown is not a pass and not a breach

These all read `unknown`, with the reason:

- a figure Mynt can't measure;
- a missed period;
- a report Mynt can't authenticate;
- another licence provider's books (a licence provider reads only its own).

Further rules:

- A figure marked `partial` can't be called a pass. A partial *total* that is already over the limit is a real breach, because it can only understate.
- A figure rule whose latest snapshot is more than two intervals old reads `unknown` and judges nothing, for or against, until a fresh snapshot arrives. A record that has stopped moving can't go on passing or start a pause.
- Snapshots too old to act on are audited with their count and range. If any would have breached, a breach of kind `historical` records it, already closed and pausing nothing.
- A rule that stays unknown past its `unknown_limit_seconds` opens a breach of kind `unknown_limit`, which alerts and **never pauses**: not knowing isn't evidence of bad behaviour.

### Sandbox figures

Sandbox figures never pause anything as figures.

- On a product that isn't published, a snapshot with `source: sandbox` is evaluated and its breach is labelled `sandbox`.
- On a published product it isn't judged at all. The rule reads `unknown` ("the sponsor's ledger isn't live"). Past a pause rule's unknown limit, that pauses the product. It is the one unknown that does, since only the licence provider can end it, by connecting its books with the [partner kit](#partner-kit).
- Without a snapshot (time-based rules, no record yet, a missed period), a published product's result is never labelled sandbox. An unpublished one goes by the ledger the firm is on now. A ledger Mynt can't tell is never taken for sandbox.
- A sandbox result can't close a breach opened on live figures, and a pass on sandbox figures doesn't count for a release.

A firm's own books count once it connects them with the partner kit.

### Breach record

The breach record is append-only, enforced in the database. Each breach keeps:

- the rule and its threshold;
- the snapshot's epoch, sequence and fingerprint;
- the observed value;
- the action taken, the severity and the cooldown outcome;
- when it opened.

A figure from the report is stored sealed, as the report is. Durations and period counts aren't the firm's books and are stored as they are.

Everything that follows (resolved, acknowledged, paused, released, reminders, a rule loosened, a revocation) is a separate append-only event on the breach, with who and when.

`list_covenant_breaches` gives the firm the whole record. `action_taken` is one of:

| Value | Meaning |
| --- | --- |
| `alerted` | The alert was sent |
| `alert_undelivered` | The alert reached no webhook, or was held back at send |
| `alert_suppressed_by_cooldown` | The breach is recorded; the cooldown held back the alert |
| `paused` | The product was paused and the alert sent |
| `paused_alert_undelivered` | The product was paused; the alert wasn't delivered |
| `pause_pending_publication` | A pause rule failed while the product wasn't published, so nothing was paused |
| `historical_not_acted_on` | A breach of kind `historical`: recorded, already closed, pausing nothing |
| `pause_failed_no_pins` | A live product with no pinned state, which drift can't hold |
| `sandbox_labelled` | A breach on sandbox figures |

### Alerts

`covenant.breached` and `covenant.cleared` go to the licence provider's own firm webhooks (`create_firm_webhook`), signed as every webhook is. See [Firm webhooks](vendors-and-marketplace.md#firm-webhooks).

- The numbers (`threshold`, `observed`, money in flight) travel sealed until sent and arrive as `data.result`.
- A rule still failing past its cooldown repeats `covenant.breached` with `reminder: true`.
- A cooldown holds back alerts only. A breach inside it is still recorded (`alert_suppressed_by_cooldown`), and a pause still happens and always alerts.
- After a relaunch, `snapshot_missed_for` and `consecutive_gaps` count only from the relaunch.

Who may receive them:

- A hook's `covenant.*` events need a named `license_provider` role and no admin role, on creating the hook and on deleting it.
- The creator's current roles are checked when a delivery is queued and again when it is sent, so a later role change takes effect.
- A default webhook created by anyone else doesn't include `covenant.*` events.
- When a hook's creator no longer qualifies, the hook shows `blocked` in `list_firm_webhooks` and is raised in `ops_status`.

An alert that reached no webhook, or was held back at send, says so and starts no cooldown: `alerted` is false, `action_taken` is `alert_undelivered` or `paused_alert_undelivered`, and the breach has an `alert_undelivered` event.

`ops_status` counts paused products, open breaches, rules unknown past their limit and a covenant timer that isn't running. It doesn't show anyone's figures.

### Pause

A `pause` rule that fails on live figures pauses the product, and anything built on it, through drift. The change has kind `covenant` and names the rule: `id` is the covenant and `rule_type` its type, with no threshold or figure.

- New sales stop, as with any drift.
- **It stops new sales only.** It cancels nothing. The money movements in flight when it took effect are reported in the breach (`in_flight_when_paused`: count and cents).
- New movements for customers already enrolled aren't blocked by a covenant pause, because drift never blocked them.

A paused product stays paused through the hourly drift sweep and through publishing a new version, until the licence provider calls `release_covenant_pause`:

- The release re-checks the rule first. It must pass, or the firm passes `override_reason`, which is audited and kept on the breach. Unknown counts as not passing.
- After an override, the same open breach doesn't pause again. A later relapse (a pass and then a new failure) is a new breach and pauses again.
- `release_covenant_pause` doesn't lift other reasons the product is paused.

Rules can be deleted, except one holding a pause.

### Revoking under a breach

`revoke_sponsorship` takes an optional `breach_id`. The breach keeps the revocation, who did it and why.

Revocation ends the sponsorship's rules, closes its open breaches and releases its holds. The product stays drifted by the revoked sponsorship itself.

### Who may do what with covenants

Only members of the sponsoring firm whose own roles name `license_provider` can set, change, delete, acknowledge or release, and the firm must be active.

An account with the admin role is refused even if it also holds that role or belongs to the firm, as for co-signing and reading a firm's books. There is deliberately no admin exception: a covenant is the licence provider's judgement of its own licence risk, and a Mynt admin who could change it could quietly stop a licence provider's pause. Mynt admins already have `admin_set_product_status` for pausing a product themselves.

What Mynt admins see:

- Every breach (`list_covenant_breaches`) with its rule type, status, severity, snapshot and timestamps.
- Not the rule's settings, the licence provider's reasons, the observed figure or the money in flight, for the same reason `get_product_health` refuses them. `audit_log` shows them the same way.

Put plainly: a Mynt admin can see that a firm's rule tripped, not how it is set or the number.

Other limits:

- The licence provider's own members see figures only while their firm is active and still sponsors the product.
- An admin account can't revoke a sponsorship either.
- A firm can't hold covenants over a product it owns.

### Changing a rule

Every change to a rule is audited with its old and new values.

A licence provider can't loosen a rule, or delete one, while a breach under it is open without giving a `reason`. The reason goes on the breach. Loosening means a looser threshold, alert in place of pause, lower severity, or a longer cooldown or unknown limit.

### What the builder sees

The product's own firm sees:

- `covenant_pauses` in `list_my_sponsorships`: the rule type and since when;
- the drift record on `get_product` and `get_product_regime`: kind `covenant`, the rule's id and type.

It doesn't see thresholds, observed values, severity, breach ids, alert-only breaches, or which other rules exist.

Anyone else looking at a published product, and apps' `product.drifted` webhooks, see only that a covenant paused it: `id` is shown as `redacted`, with no rule type. A run on a product can't be started from the rule name.

### Covenant tools

`set_covenant`, `list_covenants`, `delete_covenant`, `list_covenant_breaches`, `acknowledge_breach`, `release_covenant_pause`, and `revoke_sponsorship` with `breach_id`.

## Partner kit

A licence provider's engineers connect its systems themselves and see pass or fail, as vendors do. [Connecting a licence provider to Mynt](../partners.md) is their guide: it has the request and statement formats, the signing steps, a worked example and every conformance case. This section says what Mynt does on its side.

Mynt needs three things from a licence provider:

| | What | Where it is described |
| --- | --- | --- |
| (a) | Its ledger, per sponsor per product, signed | This section |
| (b) | Customers' verified home states | [Partner requirements](money-rails.md#partner-requirements) |
| (c) | Money rails | [Rails](money-rails.md#rails) |

The code is `core/src/partner-kit.ts` and `core/src/partner-ledger/contract.ts`. The schemas are in [`core/schemas/partner-ledger/`](../../core/schemas/partner-ledger).

### The HTTPS feed

Mynt is the client. It sends `POST <url>/v1/ledger`, signed with `Mynt-Signature` (HMAC-SHA256, as in [the wire contract](vendors-and-marketplace.md#the-wire-contract)) under a per-firm request secret.

Requests:

- They go through the vendor outbound rules (`core/src/vendor-call.ts`): HTTPS on 443, public addresses only, no redirects, a time limit, 1 MiB.
- The signed body names its `audience`, the exact URL it was sent to. The licence provider refuses any request whose audience isn't its own URL, or whose `environment` isn't the one that deployment serves. A request can't be relayed to the licence provider from an address someone else controls.
- Each round asks once per firm for every product it sponsors, with `PARTNER_LEDGER_TIMEOUT_MS` (default 10 s). Firms are read in parallel, so a slow licence provider holds up only its own products.

Endpoints:

- An endpoint is an origin and a path only, with no query string or fragment.
- A Mynt admin proposes them (`configure_partner_ledger`, audited).
- The firm is told on its webhooks (`partner_ledger.endpoint_change_pending`).
- They take effect only when the firm's own licence-provider member confirms them (`confirm_partner_ledger_endpoints`). `get_partner_kit` shows a pending change plainly.
- The firm takes the request secret once (`reveal_partner_ledger_secret`, `rotate_partner_ledger_secret`). Mynt admins never see it.

The answer is a statement (`mynt.partner_ledger.v1`):

- integer cents per product, null with a reason where the firm can't give a figure, and an `as_of` time;
- an Ed25519 signature over the text `mynt.partner_ledger.v1`, a zero byte and the statement's canonical JSON (RFC 8785, integers only).

Keys:

- Live statements are signed with the key from `register_partner_signing_key`.
- Test statements are signed with a separate test key (`register_partner_test_signing_key`), which is MACed under a key derived from the vault and is never the same key.
- A test-key signature is never valid for live, and the other way round.

`HttpPartnerLedger` uses a statement only when all of these pass; otherwise the snapshot is `unavailable`:

- the schema;
- the firm;
- the `live` environment;
- the echoed `request_id`;
- the live-key signature;
- the clock: at most 300 s ahead, and at most `PARTNER_LEDGER_MAX_AGE_HOURS` (default 24) old.

A product the statement leaves out is null: "didn't cover this product".

### The daily file

A firm without an API uploads the same statement, with `request_id: null`, using `upload_partner_ledger_file` (licence-provider members only, never Mynt admins).

The upload is refused unless it:

- passes the same checks with that environment's key;
- isn't older than `PARTNER_LEDGER_FILE_MAX_AGE_HOURS` (default 36);
- is newer than the firm's last file for that environment.

The file is stored sealed under `MYNT_VAULT_KEY`. Mynt admins see only its time and product count.

On every read it is checked again against the firm's current live key (a replaced key stops it counting at once) and its age. A `test` file is for conformance only.

### Conformance

`run_partner_conformance { source: "http" | "file" }` is run by the firm, or by a Mynt admin naming it. The firm must be active.

**(a) The ledger, for `http`.** Mynt calls the test endpoint for every product the firm sponsors plus one it made up. It checks:

- the schema, firm, environment, `request_id`, test-key signature, clock, null handling and coverage;
- that the made-up product comes back null with a reason;
- that each of these requests is refused with an error body: a badly signed one, a stale one (600 s), a malformed one, a wrong-environment one (`live` sent to the test endpoint) and a wrong-audience one.

It also probes the live endpoint once, without asking for figures. A live request whose audience is the test endpoint's URL, naming only a product Mynt made up, must be refused (`live_wrong_audience_refused`). Whatever comes back is dropped unread.

**(a) The ledger, for `file`.** The same statement checks, on the latest upload.

The endpoint version a run tested is the one read at its start.

**(b) Home states.** Mynt calls each identity provider the firm accepts (its own identity offerings, and those approved for its sponsorships) in its test environment. It passes when one answers a passed check with a valid `residential_state`.

**(c) Rails.** Reported from the firm's rails and their offerings' latest `run_conformance`.

Each run is kept with its time and `expires_at` (`PARTNER_CONFORMANCE_MAX_AGE_DAYS`, default 30). It is shown by `get_partner_kit` (the firm, or Mynt admins naming it) and in `get_my_entity` as `partner_kit`. No case or problem ever carries a figure.

### Going live

`set_partner_ledger_source { source }` switches the firm from `sandbox` to `http` or `file` only when that source's latest run passed its ledger part and hasn't run out.

- For `http`, it also reads the live endpoint once and checks the statement, which must carry the live key's signature. The figures are discarded.
- For `file`, it needs a fresh live file.

The choice is made again on every snapshot (`partnerLedgerFor`). A firm whose endpoints changed, or whose pass ran out, reads the sandbox until it passes again. If the choice can't be made (the database fails), the ledger is `unknown` (`ledgerState`), never taken for sandbox.

(b) and (c) don't hold up the switch, because each money movement already checks them.

Mynt admins can send a firm back to `sandbox`, never to live, and the firm is told (`partner_ledger.source_changed`).

Every change is audited. The kit's tools and `register_partner_signing_key` need the firm to be active.

### Who can change what Mynt reads as a firm's books

A licence provider's own member, and only after a **member cool-off**: `PARTNER_MEMBER_COOLOFF_HOURS` (default 72) from the later of the account's creation and its joining that firm.

Inside the cool-off a member can't:

- register or replace the live key;
- confirm endpoints;
- upload a live daily file;
- switch the ledger source to live.

Test keys, test files and conformance runs are fine: a test key can never sign live books.

### Standing goes with the role

What counts at a licence provider is an account's licence-provider *standing* there (`users.lp_since`), not its roles or its membership alone.

- A firm's first ever licence provider has standing at once, and that marks the firm established. `entities.lp_established_at` is set in the same transaction with the firm's row locked, and was backfilled for firms that already had a licence provider.
- After that, standing comes only through a request (`firm_member_requests`) that an existing licence provider accepts with `decide_firm_member`. Declining ends the request and removes the account from the firm.
- This holds even if every licence provider the firm had has since lost the role.
- It holds whichever way the account got there: added by a Mynt admin as a licence provider, or already a member (say as a consumer) whose roles later gain `license_provider` through an invite applied at its next sign-in.

Until it is accepted, the account has no licence-provider powers at all. Mynt resolves its roles without `license_provider` (`rolesWithStanding` in `core/src/store.ts`, applied to every account read from the store and to each session's tools). So the account:

- gets none of a licence provider's tools;
- can't open sealed product-health or pool figures;
- can't approve or decline sponsorships, set covenants, revoke under a breach, register a key or decide anything.

The services that re-read the account refuse it too.

More rules on standing:

- Losing the role ends the standing.
- The one deciding a request must have had standing since before the request was made and be past the cool-off.
- An account that has meanwhile joined another firm can't be accepted.
- The cool-off and the "joined before" order count from the latest of creation, joining and gaining standing.
- Licence providers from before standing existed were given it once, from when they joined.
- Losing standing (the role taken away, or leaving the firm) is recorded (`firm_standing_history`) and told to the firm (`firm.member_standing_lost`).

### When nobody can decide

If no licence provider of the firm has had standing since before a request and is past the cool-off (all of them were demoted, say), the request stays pending. Only a Mynt admin's recovery settles it.

1. The admin calls `recover_firm_member { request_id, reason }`. This tells every current and past licence provider of the firm (`firm.recovery_pending`, as a notice each and on the firm's webhooks) and starts a 7-day wait.
2. During the wait, any past licence provider of the firm, even one whose role has since been taken away, can block it with `block_firm_recovery` (which any signed-in account has). Blocking declines the request. The block is audited and told to the same people.
3. Calling `recover_firm_member` again after the wait completes the recovery.

A recovery, started or completed, is refused:

- while the firm has someone who can decide;
- while any past licence provider of the firm (other than the account the request is for) can't sign in: its whitelist entry is gone or its sign-up is blocked, as `revoke_user` does;
- for 30 days after any of them lost standing there through a Mynt admin's action.

An admin's action here means: moved to another firm by `add_entity_member` (whose result says so), roles rewritten by an invite (including being made an admin, `admin_promoted`), or revoked (`revoke_user` ends standing too).

Further rules:

- Completion re-checks the lock and the deciders, and makes the grant, in one transaction with the firm's row locked.
- A past licence provider can block even if it holds the admin role now, but not a recovery it started.
- The cause is kept in `firm_standing_history`. The refusal names the reason, never the person.
- A recovery takes one Mynt admin, not two. A second admin's sign-off would be stronger and is not built.

### What the firm is told

Each of those steps, every member added or asked for (`add_entity_member`) and every member a Mynt admin takes out is told to the whole firm: an event on its webhooks and a notice to each existing member (`list_firm_notices`).

`remove_entity_member({ entity_id, email })` takes a member out. They stop acting for the firm, a licence provider's standing there ends as `firm.member_standing_lost`, and their sign-in and roles stay. It is audited as `remove_entity_member`, in the workspace class.

The events:

- `firm.member_pending`, `firm.member_added`, `firm.member_removed`, `firm.member_standing_lost`, `firm.recovery_pending`
- `partner_ledger.endpoint_change_pending`, `partner_ledger.key_changed`, `partner_ledger.endpoints_confirmed`, `partner_ledger.source_changed`, `partner_ledger.approval_requested`, `partner_ledger.conformance_expiring`

### A second approval for live changes

A live key change or a switch to live waits for the approval (`approve_partner_kit_change`) of a licence-provider member who:

- is past the cool-off, and
- became a member before the requester did, by effective join time (the later of creation and joining).

So two accounts that joined together can't approve each other.

How requests behave:

- A request lasts 7 days. A newer request of the same kind, or a direct registration, supersedes older ones.
- Approving a live key change claims the request, changes the key and marks it approved in one transaction.
- Approving a switch claims it (`approving`, with `approving_at`), makes the switch with every check again, and puts it back to `pending` if that fails. A decline can't land under a change in flight.
- A request left `approving` for more than 10 minutes is put right from what is actually there: approved if the key or source it asked for is in place, otherwise back to `pending`.

The firm's earliest member, and a one-member firm's only member, need no approval. That is safe only because nobody joins a firm with members without one of them accepting it.

A key ever registered as a test key, by any firm, is never accepted as a live key, and the other way round. Each history is kept, MACed.

### What is left: the insider

These controls stop an account added to a firm, by a Mynt admin or anyone else, from quietly taking over its books. It waits out the cool-off in plain view of the firm's existing members and, where there are two, needs the other's approval.

They don't stop:

- a firm's earliest member, or a one-member firm's only member, past the cool-off;
- two long-standing members acting together;
- a Mynt admin who bootstraps a firm's first ever licence provider (an empty firm has nobody to ask);
- a Mynt admin's recovery that nobody who has been a licence provider at the firm blocks in its 7 days.

Such a person can register a key and serve figures the firm's real books don't support. Those figures read verified, which drives pools' reserve checks.

Mynt can't tell a firm's own people from its books. A firm that wants more should keep at least two members and act on its notices.

### Covenants on a sandbox ledger

A published product is never judged on sandbox figures. A sandbox-sourced snapshot reads `unknown` ("the sponsor's ledger isn't live"), not sandbox. Past a pause rule's unknown limit it pauses the product, because only the licence provider can end it, by connecting its books. Every other unknown still only alerts.

An unpublished product is judged sandbox-only by the snapshot's own `source`, and without a snapshot by the ledger the firm is on now. A ledger Mynt can't tell is never taken for sandbox.

### Running out

A firm on a live source is:

- warned once, `PARTNER_CONFORMANCE_WARN_DAYS` (default 7) before its pass runs out (`partner_ledger.conformance_expiring`);
- told once when it has run out and its snapshots went back to the sandbox (`partner_ledger.source_changed` with `reason: conformance_expired`).

## Product health

Licence providers and liquidity providers watch each product's financial health from a record that can't be rewritten, to pull a licence on bad behaviour or move capital. Mynt never holds funds and no customer data goes on chain. This feature only reports.

### What a snapshot is

On a schedule (`PRODUCT_HEALTH_INTERVAL_MINUTES`, default 60, at most 1440), Mynt computes one report for each product with an approved sponsorship, and for each of its liquidity pools. The report holds:

- reserves and customer obligations, and the coverage between them;
- flows in and out, and pending settlements;
- reversal and failure rates;
- open withdrawal requests;
- open complaints and incidents.

Money is integer cents. Ratios are integer basis points.

**A figure Mynt can't measure is null with its reason, never 0.** Coverage with no obligations is null, not infinite. Complaints and incidents are null until Mynt tracks them.

`open_withdrawal_requests` is measured from the queues of the product's real [liquidity pools](liquidity-and-treasury.md#liquidity-pools).

### Where the numbers come from

Reserves and obligations come only from the licence provider's own systems, through a `PartnerLedger` (`core/src/partner-ledger/`), never from the builder's app.

| Snapshot `source` | Meaning |
| --- | --- |
| `sandbox` | The licence provider hasn't connected its own ledger. The figures are made up and can never read as live, whatever the product's status or any stored row says |
| `partner_ledger` | A ledger that declares itself live. It only ever means that |
| `unavailable` | A ledger read failed. The snapshot is `source: unavailable`, with those figures null |

A licence provider connects its books with the [partner kit](#partner-kit): an HTTPS feed Mynt pulls, or a signed daily file. Its snapshots read them once it passes conformance and switches.

### Flows

Flows come from the money rails' `flowsFor(store, productId, from, to)` when that module is present:

- `on_ramp` and `deposit` are money in;
- `off_ramp` and `payout` are money out;
- `requested` and `submitted` are pending.

What the rails can't measure stays null with their reason, and a direction they can't see is listed in `flows_not_measured`.

What they measure is stated in every report as `flows_basis`. The rails total movements by when they were requested, so a period's figures are that period's requests by their status when the snapshot was computed:

- `requested_*` is everything requested.
- `flows_*` is the part already settled. A payment that takes days to settle shows as pending and isn't counted in a later period.
- Movements nobody ever answered for are `unresolved_cents`, counted in `requested_*` and no other total.
- A figure that totals only the directions the rails can see is marked `partial`, with a `reason` saying what it leaves out.
- Reversal and failure rates are by value among this period's completed requests, rounded up. Coverage is rounded down.

A sandbox report carries no flows at all. The rails exclude sandbox movements, and real money doesn't belong beside test figures.

### Fingerprint

Each report is encoded as canonical JSON (keys sorted, no spaces, integers only, so the same report always has the same bytes). Its sha256 is the fingerprint.

The report carries a random salt, so the numbers can't be guessed from the public fingerprint.

### Encryption and who can read a report

Each product has its own random AES-256-GCM data key, sealed under `MYNT_VAULT_KEY`. Each report is encrypted with it and bound to its product, sequence and fingerprint, so it can't be edited or moved.

The server opens a report only for entitled readers, through `get_product_health`:

- the members of the sponsoring licence provider's firm;
- the firms holding a settled position in one of the product's real [pools](liquidity-and-treasury.md#liquidity-pools). They need the `liquidity_provider` role and read only the books of those pools' sponsoring licence providers.

Rules on access:

- A liquidity provider that has fully exited loses access to new snapshots. It can still read those up to its exit, and a new settled commitment brings the rest back.
- A licence provider reads only the snapshots whose numbers came from its own books, so a second licence provider doesn't see the first's.
- A withdrawn sponsorship, or a firm that isn't active, ends access at once.
- Reading needs the named licence-provider role.

Mynt admins:

- An account with the admin role is refused even if it also holds the licence-provider role or belongs to the firm.
- An admin account gets status and fingerprints. It can't itself open a firm's books, replace its key or co-sign for it.
- An admin can still add a separate non-admin account to a firm, which is audited. So this is a control that leaves a trail, not an absolute bar on Mynt's staff.

Put plainly: Mynt's server computes the numbers and holds the vault key, so it could read them. The encryption keeps them from the database, its backups and everyone else. It doesn't keep them from a compromise of the server's vault key.

[Confidential computing](confidential-computing.md) moves the licence provider's books and the vault's root key out of the server's reach, and says exactly how far that goes.

### Partner co-signature

A licence provider registers its firm's Ed25519 public key with `register_partner_signing_key`. Small-order keys are refused. Every key it has registered is kept, so an old signature stays checkable after a rotation. Its private key never reaches Mynt.

1. A snapshot waits for the licence provider during a window (`PRODUCT_HEALTH_COSIGN_WINDOW_MINUTES`, default half the interval and never more).
2. The licence provider signs the UTF-8 text `mynt.product_health.cosign.v1`, one zero byte, then the 32 bytes of the fingerprint.
3. `submit_partner_signature` must verify with the firm's registered key while the firm still sponsors the product and before the window closes, or it is refused.

With no signature by the deadline the snapshot is published as `mynt_only` and says so.

### What verified means

`verified` is true only for a published snapshot from a real ledger on a live product, with a valid partner signature and a chain that matches. Sandbox, unsigned and missed snapshots never are.

It is worked out on every read from the authenticated report and the signature, not from stored flags.

- Someone who can only write the database can't forge it. Reports are authenticated, signing keys are MACed under a key derived from the vault, and a published row that is changed stops matching the chain.
- Someone holding `MYNT_VAULT_KEY` could still forge a snapshot before it is published.
- A snapshot that never reached the chain has only Mynt's word behind it.

`verification.integrity_ok` is a smaller claim: the report matches its fingerprint and the record matches the chain.

A missed period's report is withheld, since it never reached the chain.

### The program

`core/programs/product-health` is a Mynt-owned Anchor program that holds a head account per product. The head holds:

- the sequence number, the fingerprint, the period and the source flag;
- a per-product commitment to the partner's key and signature;
- Mynt's signing key;
- a sha256 hash chain over every field of every record, with an event for each.

Properties:

- A product appears on chain only as a keyed hash of its id (HMAC under a key derived from the vault). A guessed id can't be tested, and the commitment doesn't link a licence provider's products.
- The program moves no value and calls no token program.
- The publisher is set once at initialisation by the program's own upgrade authority. There is no hard-coded key.
- Periods must be contiguous and can't end in the future.
- It passes Mynt's own [mainnet gate hard rules](solana-programs.md#mainnet-program-gate), checked in CI on what the compiler read, with the bytes and IDL. It has one reviewed lead: that it reads the clock.
- It publishes to **devnet only**.

### What the chain does and does not prove

- The program can't check the co-signature. `partner_signed` on chain says only that the publisher supplied a commitment.
- A reader checks the signature against the partner's key and the commitment, as `get_product_health` does.
- An on-chain Ed25519 check would have to publish the partner's key, and needs deciding before mainnet.
- The publisher can't be rotated without a new deployment.
- The hash chain makes a changed record visible, but whoever holds the upgrade authority can replace the program until it is frozen or put behind a timelock.

### Publishing snapshots

Sequence numbers are gapless per product. The program accepts only the next one, and Mynt sends each in order.

- Sends go through Mynt's RPC client, with its retries and backoff.
- Mynt reads the head before it concludes anything. A record that landed unseen is adopted even past its deadline. While the chain can't be read, nothing is marked missed.
- A snapshot not on chain by its deadline, or a stretch Mynt never computed, is recorded as `missed` and gets a marker on chain.
- Every period starts where the last ended, so changing `PRODUCT_HEALTH_INTERVAL_MINUTES` can't overlap one.

`list_product_health` and `get_product_health` report gaps: `no_record`, `missed`, `stalled`, `sequence_gap`, `period_gap`, `overdue`, `re_anchored`, and the chain being `chain_behind` or `chain_ahead` of Mynt's record.

`ops_status` flags stalled records, snapshots past their deadline, and a worker that isn't running while products are sponsored.

### Checking it without Mynt

`get_product_health` gives entitled readers, and nobody else, each snapshot's `partner_key` and `partner_signature`, and the record's `subject` and `head_address`.

`core/scripts/product-health-verify.mjs` uses nothing but Node and an RPC of your choosing. Mynt wrote the answer it reads, so it believes nothing the answer says about where to look. Save the tool's answer to a file and run:

```sh
node product-health-verify.mjs --file answer.json --rpc <url> --program-id <address> --partner-key <your firm's key>
```

**Get `--program-id` from outside Mynt's answers.** The operator gives it to you directly, in writing, when the program is deployed (for example with your sponsorship paperwork). `--partner-key` is the key your own firm holds.

The script derives the head's address from the program id and subject. It checks that:

- the account is owned by that program and is a `Head` account;
- the report hashes to the fingerprint;
- the signature verifies under your key;
- the head holds that fingerprint, period, source and commitment.

For an older snapshot (`--sequence N`, with `--epoch E` for an earlier record) it decodes the `record_snapshot` instruction of its transaction instead.

It prints `OVERALL PASS` and exits 0 only when everything was checked. Without `--partner-key` it says the key wasn't independently checked and exits 3.

One limit it can't close: the subject is a keyed hash, so it proves this report was recorded under that subject, not that Mynt filed it under the right product.

### After a chain reset or a new program

A record the chain no longer holds stalls in the open. A Mynt admin calls `reanchor_product_health` (`product_id`, `reason`).

It works only when:

- the chain has no record for the product under the current program;
- there is no transaction history at that address (history without a head means it wasn't a reset, and a history that can't be read refuses too);
- something reached the old chain, or the program changed.

A head that disagrees with Mynt's record is refused, because that needs investigating. Anchor rows are MACed under a key derived from the vault, and one that fails reads as a mismatch. Refusals are audited.

After a re-anchor:

- The record restarts at sequence 1 in a new epoch. The old record's verdict, head sequence and chain hash are saved with it.
- Its snapshots stay readable and report `previous_chain_matched`, `previous_chain_mismatch` (it didn't match, or a row has changed since) or `previous_chain_unverifiable` (the old chain is gone).
- The re-anchor and every hole in the old record stay visible as gaps.

### The publisher key

The publisher key is its own devnet key in Mynt's vault, never the deploy authority.

`HealthPublisher` (`core/src/solana/product-health-chain.ts`) reads every message back before signing. It refuses anything but the product-health program's own instructions, paid for by the publisher.

### Product health tools

| Tool | Who | What it returns or does |
| --- | --- | --- |
| `list_product_health` | Licence providers, committed liquidity providers, the product's own firm, Mynt admins | Fingerprints and status only |
| `get_product_health` | Entitled readers | The decrypted report, whether it matches its fingerprint, whether the fingerprint matches what is on chain, and history |
| `register_partner_signing_key` | Licence provider | Registers the firm's Ed25519 public key |
| `submit_partner_signature` | Licence provider | Co-signs a snapshot |
| `reanchor_product_health` | Mynt admin | Restarts a record after a chain reset or a new program |

`get_product_health` reports `verification.on_chain` as `matches`, `mismatch`, `pending`, `not_on_chain`, one of the `previous_chain_*` verdicts or `unavailable`. When the chain can't be reached it says so, and is never reported as a match.

### Deploying the program

Deploying is an operator step, never CI.

1. From a checkout on the server, with its environment loaded, run `core/scripts/product-health-deploy.sh --program-keypair <new-program-keypair.json> --authority <upgrade-authority-keypair.json>`. It builds the program with the pinned toolchain, checks the hard rules, deploys to devnet, creates the publisher key in the vault and names it on chain (`mynt product-health publisher`, `mynt product-health init`).
2. Set `PRODUCT_HEALTH_PROGRAM_ID` on the server and restart.

Until `PRODUCT_HEALTH_PROGRAM_ID` is set, the worker doesn't run and `get_product_health` reports the chain check as unavailable.

## A sponsored US product, end to end

`core/scripts/sponsored-product.mjs` runs the whole path from an unlicensed builder to a developer-ready US product:

1. The licence provider's firm, registered by hand.
2. Its licences, registered and then verified by a Mynt admin, and the roster filling the stakeholders they mandate.
3. The builder's firm and its product: the money transmission template (`core/schemas/examples/us/money-transmission.v2.json`) with transmission provided by the sponsoring licence provider.
4. `request_sponsorship` and `approve_sponsorship` for every state the product is offered in.
5. `test_product`, then `publish_product`.
6. A check that `list_products` with `developer_ready` lists it.

`core/test/sponsored-product-e2e.test.js` runs the same function on an in-process server.

### The fixture

The script runs on a JSON fixture. The shipped one, `core/schemas/examples/us/sponsored-product.placeholder.json`, is a **placeholder for staging and tests only**:

- "Example Money Transmitter (placeholder)" isn't a real firm.
- Its registration numbers start `PLACEHOLDER-`.
- It has `"placeholder": true`, so the script refuses it unless told it is staging.
- It holds a FinCEN MSB registration and money transmitter licences for New York and California.

No public register can show the placeholder is a real company. Its sponsorship is approved only on a staging server running with `SPONSOR_LEGITIMACY_RULE=off`. The real licence provider passes the checks instead: a Mynt admin runs `run_firm_checks` once its LEI is recorded.

The US model (`core/schemas/regulatory/us.json`) has a money transmitter licence type for every state and the District of Columbia except Montana, which has no money transmitter licence (its regulator is kept with no licence types). To offer the placeholder product in another state, add that state's licence (its `_id` is `<regulator>_money_transmitter`) to the fixture's licences and the state to `offered_in`.

### Running it

Every step reads first and does only what is missing, so rerunning is safe and picks up where a run stopped.

Three people act, each in their own session: `MYNT_ADMIN_TOKEN`, `MYNT_LICENCE_PROVIDER_TOKEN` and `MYNT_BUILDER_TOKEN`, from the environment, never the command line. With only some of them set, the script does their steps and stops, naming who is needed next. The licence provider usually approves in its own session.

```sh
# in the repository's core/ folder
node scripts/apply-sponsored-product.mjs --url <a staging server's MCP URL> --staging --dry-run   # read only: what it would do
node scripts/apply-sponsored-product.mjs --url <a staging server's MCP URL> --staging             # run it with the placeholder
```

### When the real licence provider signs

A Mynt admin swaps the real firm in and reruns:

1. Copy the fixture (say `sponsored-product.partner.json`, kept out of the repository if it names the firm before that is public). Set `"placeholder": false` and delete `placeholder_note`.
2. Fill in `licence_provider`:
   - the firm's legal name, or `entity_id` if its firm is already on Mynt;
   - the email its person signs in with (`member_email`; invite them with the `license_provider` role first);
   - its legal form and incorporation;
   - each licence it holds as on the regulator's register: `regulator_id`, `license_id`, `registration_number`, and `valid_from` and `valid_to` when known;
   - the people who fill each stakeholder its licences mandate (`roster`).
3. Change `product.offered_in` to the states it will sponsor in.
4. Check every licence against the regulator's public register, then run with `--verify-licences`. Without it the run stops for `review_license`.

```sh
# in the repository's core/ folder
node scripts/apply-sponsored-product.mjs --url <the server's MCP URL> --fixture sponsored-product.partner.json --dry-run
node scripts/apply-sponsored-product.mjs --url <the server's MCP URL> --fixture sponsored-product.partner.json --verify-licences
```

A product already live under the placeholder gets a new version sponsored by the real firm: its definition changes, so it is saved as the draft version, sponsored, tested and published.

The placeholder firm's own sponsorship is then left over. Revoke it (`revoke_sponsorship`, as the placeholder's licence provider) and suspend its licences (`review_license`), so nothing can rest on it again.
