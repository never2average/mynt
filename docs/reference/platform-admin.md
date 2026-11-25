# Platform administration

This file covers what a Mynt admin does: the platform admin in Mynt Studio, invitations, firms and licence review, the regulatory model, take rates, oversight, the governance desk and the connector. It ends with two step-by-step guides. It is for Mynt admins.

See also: [Roles and tools](roles-and-tools.md), [Firms, licences and licence providers](licence-providers.md), [Risk](risk.md), [Agreements](agreements.md), [Running Mynt](operations.md).

Mynt admins own Mynt's reference data and its list of who may sign in. Every admin action lands in the audit log with the name of who did it.

## The platform admin in Studio

Mynt Studio has a platform admin at `/platform` for Mynt's own staff. It covers all workspaces and firms, and nothing in it is scoped to a workspace.

### Who sees it

- Only accounts Mynt says hold the `admin` role get a Platform admin badge above their name at the foot of Studio's sidebar. The role is read from `whoami`, never from a list in Studio's settings.
- `/platform` needs sign-in like every Studio page. It is a 404 for everyone else, as are its routes (`/api/admin/*`).

### Layout

The platform admin has its own layout, not Studio's.

- Its sidebar is titled "Mynt platform admin" and lists eight sections, each at its own address. There is no workspace switcher and there are no app folders.
- The labelled Back to Studio at the foot of the sidebar returns to Studio.
- The header has the section's name, a search field (Cmd+K) that searches the platform admin, a Docs button and the theme switcher. On the Overview it also has Invite person. There is no scope tag.

| Section | Address |
| --- | --- |
| Overview | `/platform` |
| Workspaces | `/platform/workspaces` |
| Regulated firms | `/platform/firms` |
| Vendors | `/platform/vendors` |
| Audit trails | `/platform/audit` |
| Risk models | `/platform/risk-models` |
| Risk register | `/platform/risk-register` |
| Platform settings | `/platform/settings` |

An opened workspace, firm, audit entry or risk model is `/platform/<section>/<id>`.

There are no Apps, People, Products or Licences sections. People are managed on each firm's and each workspace's Members tab, and a firm's products are its page's Products tab. `/platform/apps`, `/platform/people` and `/platform/products`, and anything under them, are 404s. Licences are reviewed on the Regulated firms section's Licences tab and on each firm's page.

### How it changes things

Each section only shows. Every change is a labelled button that opens a sheet, and each one calls an admin tool through a separate allow-list (`ADMIN_TOOLS` in `platform/studio/lib/studio-tools.ts`) that only an admin's session can use. The chat and every other page can't call these tools.

### Old addresses

| Old address | Goes to |
| --- | --- |
| `/admin?tab=<section>&id=<id>` | `/platform/<section>/<id>` |
| `/admin` with a section it no longer has (apps, people, products) | `/platform` |
| `/platform/risks` and `/admin?tab=risks` (the old Security & risk) | `/platform/risk-register` |
| `/platform/licences`, anything under it, and `/admin?tab=licences` (the old Licences section) | `/platform/firms?tab=licences` |
| `/settings?tab=esign` | `/platform/settings` |

### Overview

Overview shows `ops_status`:

- what needs attention first;
- this month's spend per agent, shown as "Not measured" where this server runs no such agent, never $0;
- failures and stuck runs;
- the hosting, vendors, Solana, product health, covenants, workspaces, agreements and backups readings.

Its header has Invite person: an email, then what they join (a regulated firm or a team workspace, found by typing its name), then their role there. It does exactly what that firm's or workspace's Invite member does.

### Workspaces section

Workspaces lists every workspace with its owner, members, apps, status and creation date (`list_all_workspaces`). The status is active, archived, or frozen because its organization is missing.

Open shows one workspace (`admin_get_workspace`) with Invite member on its card, then the tabs Members, Apps (read-only) and Activity.

Members lists its members ("Signed in") and its open invitations ("Invited, not yet signed in"). Each has its role (owner, admin or member) and labelled Change role and Remove. For an invitation, Remove withdraws it.

These run `admin_invite_workspace_member`, `admin_change_workspace_member_role`, `admin_remove_workspace_member` and `admin_revoke_workspace_invite`. They apply the workspace's own rules exactly as its owners' tools do:

- the identity provider's organization is invited, changed or left the same way;
- a workspace never loses its last owner;
- someone removed loses its apps and builds at once.

Renaming, archiving and relinking stay with the workspace's owners. See [Mynt admins on any workspace](workspaces-and-sign-in.md#mynt-admins-on-any-workspace).

### Regulated firms section

Regulated firms (`/platform/firms`) has two tabs in the page:

| Tab | Address | Shows |
| --- | --- | --- |
| **Regulated firms** | `/platform/firms` or `/platform/firms?tab=firms` | Every firm, with Register regulated firm |
| **Licences** | `/platform/firms?tab=licences` | Every licence firms registered, for review |

**Regulated firms** lists every firm (`list_entities`), each typed in words by its members' roles: licence provider, vendor, liquidity provider, innovator. A firm that is only a vendor is listed here too, as Vendor; its onboarding is under Vendors, on the Vendor firms tab. The Awaiting review column counts the firm's licences waiting for review, and says "Not available" when Mynt's answer doesn't say, never 0. Register regulated firm runs `register_firm`. Firms are only ever added by hand.

**Licences** lists every licence firms registered, opening on the ones waiting for review (`list_license_reviews`), with the count in each review status, filters and Export CSV. The Firm column links to the firm's page. Its actions are Verify licence, Reject licence and Suspend licence (`review_license`). A rejection or suspension needs a reason.

A firm's page has Invite member and Set firm status (`set_entity_status`), then the tabs Members, Licences, Offerings and Products.

**Members** lists the firm's people (name, email, roles, status) with Change role and Remove on each.

- The roles offered are the firm's own: what its members are. Mynt's admin role is never one.
- Invite member runs `invite_user` with the role picked added to any roles the person already has (read with `list_whitelist`), then `add_entity_member`. Someone who hasn't signed in yet is allowed in, and the admin adds them to the firm once they have.
- Change role sets their roles for the firm to exactly the ones picked and keeps every other role they hold (Mynt admin, user). It says what it adds and removes.
- Remove (`remove_entity_member`, confirmed by typing their email) takes them out of the firm. A licence provider loses its standing there, the firm's members are told, and their sign-in and roles stay.

**Licences** lists the firm's licences with the same Verify licence, Reject licence and Suspend licence, so a licence can be reviewed beside the firm's members and products. `/platform/firms/<id>?tab=licences` opens on it.

**Products** lists the products the firm owns or sponsors (`list_all_products`): line, region, stage, status, whether it is archived, and its sponsors. It is read-only. `/platform/firms/<id>?tab=products` opens on it.

What a firm keeps to itself, such as its encrypted health books and its signatures, isn't shown. Mynt admins can't read or co-sign them.

### Vendors section

Vendors shows:

- the service types per region (`list_service_types`), with Add service type. That runs `define_service_type` for a new key only: Studio never replaces a service type, and the advanced fields stay with the Model Context Protocol (MCP) tool;
- every offering whatever its status, with its last conformance result (`list_vendor_offerings` with `include_unlisted`), and Suspend offering and Reinstate offering (`suspend_vendor_offering`);
- a Vendor firms tab with each firm's onboarding progress (`get_vendor_onboarding` with `all_firms`).

See [Vendors and the marketplace](vendors-and-marketplace.md).

### Audit trails section

Audit trails is Mynt's audit log across every workspace and firm: `audit_log`, its newest 500 entries, each with its class (`security`, `financial`, `obligations` or `workspace`).

`audit_log` takes no filters and no cursor. So the section searches, filters and pages those 500 in Studio, and says so when there may be more.

- **Filters:** action, class, actor, workspace, firm and target type (read from the action, as the log doesn't record it), plus a date range with quick choices: Today, Last 7 days, Last week, Last 30 days, Last month, This month, Year to date, This year, Last year.
- **Table:** When, Action (in words), Class, Actor ("Mynt" for the system), Workspace / Firm (by name), Target and a short line of details.
- **Export CSV** downloads what is shown. Import is disabled, with its reason.
- **A row** opens `/platform/audit/<id>`: its metadata card, then Details and Related.
  - Details shows every detail as a table. Secrets are never in the audit log, and any detail named like one is shown as "Hidden".
  - Related shows other entries about the same target, newest 50.

Its route is `GET /api/admin/audit`, which takes only `limit` (1 to 500).

### Risk models and Risk register sections

Risk models (`/platform/risk-models`) and Risk register (`/platform/risk-register`) share the same seven tabs, one per risk area, chosen with `?tab=<area>`.

| Tab | Area in the address |
| --- | --- |
| Financial risk | `financial` |
| Compliance risk | `compliance` |
| Third-party risk | `third_party` |
| Operations risk | `operations` |
| Business process risk | `business_process` |
| Technology risk | `technology` |
| Regulated product risk | `regulated_product` |

See [Risk areas](risk.md#risk-areas) for the areas and how the older categories map to them.

**Risk models** lists Mynt's own risk models in the tab's area (`list_risk_models`): name, status in words, owner, version, last validated and next validation due ("overdue" when it has passed).

- Add risk model runs `add_risk_model`. Inputs, outputs and thresholds are typed as JSON lists.
- A row opens `/platform/risk-models/<id>`: its metadata card, then the tabs Definition (four tables: the purpose and method, the inputs, the outputs and the thresholds), Validations and Versions, each a table.
- The card's actions are Edit model (`update_risk_model`: a change to what the model is makes a new version, and the old one is kept), Record validation (`validate_risk_model`) and Retire model (`retire_risk_model`, with a reason).
- The Regulated product risk tab also lists, read-only, Product risk models: a table, with its own search and pager, of the risk models financial products declare in their definitions (`admin_list_product_risk_models`: product, firm, model, its type and version), each linked to its firm's Products tab.
- What Mynt can't answer is one table row under the table's headers: "Not available." with why.
- Models overdue for validation count in `ops_status`.

**Risk register** shows, on each tab, three kinds of section, and every one is a table.

First is Mynt's own risk register in that area. These are risks on the `platform` subject, `subject_id` `mynt`, kept and read by Mynt admins only.

- It is one table under the list toolbar: search, Filters, Import (off until Mynt's next update), Export CSV and Add risk.
- Its columns are Risk, Category, Likelihood, Impact, Score (with its level in words), Owner, Status in words, Review by ("overdue" when it has passed) and Mitigation, which is cut short in the table and shown in full in the review sheet and the CSV.
- Filters narrow it by status and by level, and Unassigned shows the risks with no area yet instead of the tab's.
- Each row has a labelled Review risk, which can change the risk's area. Add risk starts on the tab's area; a platform risk always has one.
- Overdue reviews of platform risks count in `ops_status` with the apps' and products'.

Second, read-only, is Across apps and products: the open risks in that area on apps' and products' own registers (`admin_list_risks` with `risk_area`), highest score first, with its own search and pager.

- Its columns are Subject, Workspace / firm, Risk, Score (with its level), Status and Review by.
- The subject links to its app's workspace page or its product's firm page. `admin_list_risks` sends the workspace's or firm's id, not its name, so the Workspace / firm column says which of the two keeps the risk.

Then come the area's signals, each a table with its own columns. A signal Mynt doesn't measure is one row under those columns, "Not available." with why; one that is measured and clear is one row saying so in words. Neither is ever an empty table or a 0.

| Area | Signal tables and their columns |
| --- | --- |
| Financial | Liquidity and treasury pools: Area, What needs attention |
| Compliance | Apps missing a program agreement: App, Missing agreements. Overdue oversight audits: Overdue audits, Apps flagged |
| Third-party | Vendor conformance (runs that failed): Service, Last conformance, Result |
| Operations | Agents and hosting (failed and stuck runs, machines and apps): Area, Item, Since |
| Business process | Covenants (products paused, open breaches): Area, What needs attention. Drifted products: Product, Detail |
| Regulated product | Covenants and Product health: Area, What needs attention. Drifted products: Product, Detail |
| Technology | Security events in the last 30 days (`audit_log` entries of class security): When, Action, Actor, Target. Backups: Last run, Result, Off-site, Last success, Last restore test |

The signals come from `ops_status`, so they show what it reports and no more:

- It counts an app's missing program agreements and the overdue audits, without naming the sponsor, the product or the audit.
- It names a failed conformance run's service, not its vendor.
- Where it has only a line for an operations area, and no list of runs behind it, the row's Since is "Not recorded".

Drifted products are not available until `ops_status` counts them across firms.

The register's routes are `GET /api/admin/risks?area=<area>` and `POST /api/admin/risks`.

### What the platform admin reads

The reads the platform admin added to Mynt (`core/src/platform-admin.ts`) are admin-only, read-only and paged: `list_all_workspaces`, `admin_get_workspace`, `list_all_apps`, `admin_get_app`, `list_all_products` and `get_platform_settings`. None returns a preview link, key or token.

`audit_log` gives each entry its `class`, from `core/src/audit-classes.ts`, as `list_workspace_audit` does.

Studio doesn't use `list_all_apps`, `admin_get_app`, `remove_app` or `revoke_user`. They stay MCP admin tools.

Everything else Mynt admins do is done with the MCP tools: the regulatory model, mainnet program approvals, rails, the connector, ideas, take rates, opening public sign-up and removing a test app.

## Invitations

Mynt admins decide who may sign in. `invite_user` allows an email in with its roles, `revoke_user` takes it out, and `list_whitelist` lists everyone. `set_public_signup` opens or closes sign-up for consumers.

The list is kept in step with the identity provider's allowlist, and Mynt refuses any change that would remove the last admin.

See [Invite-only sign-in](workspaces-and-sign-in.md#invite-only-sign-in).

## Firms and licence review

The firms of licence providers, vendors and liquidity providers are added by hand by a Mynt admin, with `register_firm`. There is no firm directory. A builder registers the firm it acts for itself, with `create_entity`.

| Tool | Does |
| --- | --- |
| `register_firm` | Adds a legal entity, with no members yet |
| `add_entity_member`, `remove_entity_member` | Attach a person to a firm, or take them out |
| `set_entity_status` | Records the firm's status from its company registry: `active`, `suspended`, `under_liquidation`, `dissolved` or `struck_off`. Every published product resting on it is re-checked, and drifted ones pause new sales |
| `list_entities` | Lists every firm with its members, licences, roster and Mynt's public checks on it |
| `run_firm_checks` | Runs Mynt's public checks that a firm is a real company |
| `recover_firm_member` | The last resort when none of a firm's licence providers can accept a new one |
| `list_license_reviews` | Lists the licences firms registered, by review status (pending by default) |
| `review_license` | Verifies, rejects or suspends a licence, after checking it against the regulator's public register |

Only verified, in-date licences let a firm publish products or sponsor them.

See [Firms, licences and licence providers](licence-providers.md) for legal entities, [Firm checks](licence-providers.md#firm-checks) and how firm members are accepted and recovered.

## The regulatory model

The regulatory model is Mynt's record, per region, of who regulates what, which licences permit which actions, and the law behind them. Mynt admins keep it. Anyone, guests included, reads it with the catalogue tools (see [Tools everyone gets](roles-and-tools.md#tools-everyone-gets)).

### Regions

`define_region` says where products may be offered. Each region records:

- its regulators;
- its regulatory ecosystem: each regulator's remit, the key laws and bodies;
- the legal procedure for launching each product line there: licences, approvals, filings, timeline;
- the official sources.

Fields you leave out keep their values. `active: false` stops new products from using a region. Anyone reads the full picture with `get_region`.

### Regulated product types

`define_regulated_product_type` and `list_regulated_product_types` form, per region, a catalogue of the product types regulators supervise, kept apart from any single regulator.

- Each has a Mynt category, the actions that can be taken on it, and optionally its underlying and wrapper (see [Product lines, actions and primitives](products.md#product-lines-actions-and-primitives)).
- Regulators map onto it many to many. One product type, such as a sovereign gold bond, can be supervised by several regulators, each for its own subset of actions.
- A product type can't be removed, or lose an action, while a regulator still supervises it.

### Regulators and licence types

`define_regulator` records, per region, each regulator's scope and the licence types it grants.

- **Scope:** the regulated product types it supervises, by id, with the actions it covers; and the customer personas with their qualifications.
- **Licence types:** a licence grants specific actions on specific product types. A bare id grants everything its regulator supervises on it. So `find_licenses` returns only licences that permit the action.
- **Ids:** persona and licence ids belong to one regulator. They must start with `<regulator id>_` and can't be reused by another regulator in the region.

Each licence carries governance, risk and compliance (GRC) data:

- registers of obligations, reporting and disclosure filings, risks and controls;
- repositories of regulatory communications, enforcement actions, press releases, policies and risk models;
- the product types and customer segments it allows;
- mandatory internal and external stakeholders;
- how to apply.

Broken links inside a regulator are refused; looser links come back as warnings.

### Law

Law sits alongside in two branches.

| Branch | Tool | Covers |
| --- | --- | --- |
| Legislative | `define_legislation` | Acts, ordinances, rules, regulations, master directions, circulars, guidelines, notifications and orders, each with its issuer, the instrument it is made under (`parent_id`), status and effective date |
| Judiciary | `define_judgment` | Court and tribunal decisions, each with court and level, bench, holding, the legislation it interprets, and whether it is still good law |

Obligations and filings cite either kind by `legal_ref`.

`define_legal_instrument` is deprecated in favour of `define_legislation` and `define_judgment`. It files kind `judgment` under the judiciary and everything else under legislation.

### Reading the model

- `get_regulator` returns one regulator in full.
- `list_legal_instruments` returns both branches of law, filterable.
- `find_licenses` says which licence covers a category, action and persona.
- `test_product` names the covering licence, or warns when there is none.

### Removing entries

| Tool | Removes |
| --- | --- |
| `remove_regulator` | One regulator and its licences |
| `remove_legislation` | One legislative instrument |
| `remove_judgment` | One judgment |
| `remove_regulated_product_type` | One product type. Refused while any regulator still supervises it |
| `remove_legal_instrument` | Deprecated: use `remove_legislation` or `remove_judgment` |

### GRC data

Each licence's GRC holds two kinds of thing. The first is data the regulator requires or has identified:

- **obligations:** recurrence, criticality, how to comply, links to a risk, an owner and the law;
- **reporting, disclosure and filings:** category, frequency, due rule, form, channels, priority, the obligation it evidences;
- **risks:** impact, likelihood, how often controls over it must be tested;
- **regulatory communications, enforcement actions and press releases.**

Frequencies share one vocabulary: one_time, daily … annual, biennial, periodic, event_driven, continuous, on_demand. Free text is mapped onto it, and any detail that doesn't fit is kept in `frequency_note`.

Regulators' registers and repositories keep the schema they were defined with.

### GRC templates

The second kind is templates: schemas of schemas. Controls, policies, risk models, inspection history and inspection events aren't records. They teach licensees how to define their own.

Each template carries:

- `guidance` on what the regulator expects;
- the `legal_ref` behind it;
- kind-specific settings, such as a control's minimum test frequency, or a policy's review cadence and approver;
- a field schema licensees' records must follow.

Schemas start from Mynt's defaults:

- a control's type, test method, test frequency, test status and last test rating;
- a risk model's scoring methods, factors and thresholds;
- an inspection's type, outcome and findings by severity.

The regulator adds or overrides fields by key, each with its own guidance, or opts out of the defaults. Anyone reads a template's resolved schema with `get_template`, and the defaults with `list_template_defaults`.

### Product categories

`define_product_category` defines the categories products may carry, and the product lines each may be used in. A category can sit in several lines: `exchange_traded` sits in wealth and securitization. `active: false` retires a category for new products.

`recompute_product_derived` recomputes what Mynt stores on products after the model changes (see [What Mynt stores on each product](products.md#what-mynt-stores-on-each-product)).

## Take rates

Take rates are what Mynt earns on each product line. A Mynt admin sets them with `define_take_rate` and reads them with `list_take_rates`, which also names the lines that have none yet.

A rate is:

- a base percentage (`base_pct`);
- plus a percentage per workload point (`workload_pct`);
- kept between a floor (`min_pct`) and a cap (`max_pct`);
- applied to a `basis`, such as revenue or volume.

A product's workload score is a point per regulated component, plus a tenth of the average obligations, filings and controls of the licences that may provide it, plus a point for servicing.

Every change is audited. A product's owner, its firm and Mynt admins see the rate and its full per-component breakdown with `get_product_take_rate`. If no rate is configured for the line, it says so.

Mynt has no billing: a take rate is recorded and shown, and no fee is charged.

## Oversight

| Tool | Does |
| --- | --- |
| `audit_log` | Recent admin actions, newest first, with who did them and each action's `class`: `security`, `financial`, `obligations` or `workspace` |
| `list_all_campaigns` | Every builder's campaigns, newest first |
| `admin_pause_campaign` | Takes any live campaign down now. Its builder can fix and relaunch it |
| `admin_set_product_status` | Unpublishes any product, reference catalogue products included, or republishes one. Republishing re-runs the product tests first and refuses if they fail |
| `ops_status` | What needs attention across the server: failures, stuck runs and this month's spend per agent, with readings for hosting, vendors, Solana, product health, covenants, workspaces, agreements and backups |

Other oversight tools are documented with their topics: promotion sign-offs in [Production sign-off](workspaces-and-sign-in.md#production-sign-off), repository approvals in [Repositories](apps-and-builds.md#repositories), and the hosting kill switch in [Hosting](apps-and-builds.md#hosting).

## Removing a test app

`remove_app` removes an app that never went live (a test or demo), with everything that references it.

By default it is a dry run (`confirm: false`). It lists how many rows each table would lose, the app's programs (and which will be closed on chain) and its builds, and deletes nothing. `confirm: true` does it.

### When removal is refused

It is refused when:

- the app is published;
- it is hosted on Mynt (`undeploy_app` first);
- a build of it is still running or has a reopened sandbox open (`stop_build`, `close_sandbox`);
- it has live customer data;
- it has live money movements;
- it has any mainnet program, even one only reserved.

Live customer data means any non-sandbox row in `client_sessions`, `client_evidence`, `customer_vault`, `handoffs`, `app_events`, `ramp_link_requests`, `vendor_action_runs` or its webhooks' `webhook_deliveries`, or any row in `customer_verified_states` or `customer_state_erasures`.

It is also refused, naming the table, when a table can't be cleaned safely:

- `customer_state_history` is append-only;
- liquidity pools' records (`pool_movements`, `pool_flags`, `pool_movement_states`) or ramp partners' links name its money movements or link requests;
- a mainnet review, another program or another hosted app uses one of its programs or builds;
- any other table names the app or points at a row that would go. That covers tables added later.

### The order of removal

1. Each deployed devnet program is closed on chain first, as `close_program` does (see [Closing a program](solana-programs.md#closing-a-program)).
2. If a close fails, nothing is deleted, the stop is written to the audit log, and the answer says why. `proceed_without_closing: true` removes the app anyway and leaves that program on devnet, which the audit entry records.
3. Then, in one transaction with the app's row locked and every check run again, it deletes from the tables below, in this order.

Customer-facing and runtime tables:

`webhook_deliveries`, `webhooks`, `vendor_action_runs`, `ramp_link_requests`, `money_movements` (sandbox only), `client_evidence`, `handoffs`, `client_sessions`, `api_keys`, `app_events`, `customer_vault`, `test_consumers`, `app_journeys`, `app_releases`, `requests` (access requests), `hosting_commands`.

Solana tables:

`solana_program_events`, `solana_program_versions`, `solana_program_flags`, `solana_keys` (each program's own keys: its reserved keypair, and a leftover deploy buffer's), `solana_programs`, `solana_program_sources`, `solana_program_deps` and `solana_program_depinfo` (only what no other build's artifact still uses), `solana_program_artifacts`.

Build tables and the app itself:

`build_events`, `agent_spend` (the builds' model spend), `build_runs`, `apps`.

### The audit log is never deleted from

The removal adds one entry: the app, each table's count, the ids of the app, its builds, programs, API keys, webhooks and releases, and what was closed on chain.

## The governance desk

Mynt admins can have an agent review a firm, a licence it registered or a product it offers, before they decide. `open_review_case` starts one. With `REVIEW_AUTO_OPEN=1`, a case opens for every licence awaiting review.

The agent only researches and judges. It can't change anything, and the admin makes every decision.

### The review agent's folder

The agent is steered by an agent workspace folder in this repository, `core/workspaces/governance-review/`. It is copied into the sandbox and becomes the agent's working directory.

| In the folder | Purpose |
| --- | --- |
| `CLAUDE.md` | Standing instructions: evidence or nothing, silent is not failed, never guess |
| `.claude/skills/review-entity/SKILL.md` | Company registries and GLEIF |
| `.claude/skills/review-licence/SKILL.md` | The regulator's own register: entry, holder, type, in force, enforcement |
| `.claude/skills/review-product/SKILL.md` | Limits, misleading claims, disclosures against the recorded regulation |
| `.claude/skills/cite-evidence/SKILL.md` | How to quote so Mynt can verify it |
| `checklists/entity.json`, `checklists/license.json`, `checklists/product.json` | Every item: who checks it (Mynt or the agent), and whether it is material |
| `scripts/fetch_page.py` | Saves a page's text for verbatim quoting |
| `scripts/check_review.py` | The agent runs it until its review meets Mynt's rules |

### What Mynt does itself

- **Its own items.** Mynt decides the items it can from its own records (licence coverage, segments, product tests, feasibility, the licence type) and freezes the case.
- **Evidence.** After the agent finishes, Mynt re-fetches every cited source (public https pages only) and checks each quote is really there. An item backed only by quotes it can't find becomes unverified. A "silent" answer that doesn't say what was searched becomes not reviewed.
- **The recommendation** is Mynt's, not the agent's:
  - any material item that fails: reject;
  - any material item not confirmed: needs info;
  - otherwise: verify;
  - no recommendation at all if more than 20% of items weren't reviewed.

### Review tools

| Tool | Does |
| --- | --- |
| `open_review_case` | Opens a review of a firm (entity id), a licence it registered (licence record id) or a product (product id) |
| `list_review_cases` | Lists cases with their status, Mynt's recommendation and any decision |
| `get_review_case` | Shows the dossier: each item's status, verified and unverified evidence, what was searched, the agent's notes, and its suggestions for improving its folder |
| `decide_review_case` | Records the decision in the audit log next to Mynt's recommendation. For a licence, verify or reject sets its review status, as `review_license` does |
| `stop_review_case` | Stops a running review and its sandbox |

### Review settings

The desk needs a sandbox provider key, `PUBLIC_URL` and a model backend.

| Optional setting | Default |
| --- | --- |
| `REVIEW_AUTO_OPEN` | Off |
| `REVIEW_CASE_CAP_USD` | 3 |
| `REVIEW_MONTHLY_CAP_USD` | 60 |

## The connector

Mynt's connector is the AI agent that does Mynt's business development. It finds firms that could offer products and builders who could build on them, talks with them, and introduces people who should work together.

It runs on its own schedule on the same harness as builds: Claude Code in an agent sandbox, using the model through Mynt's agent proxy. Its only tools are Mynt's MCP server: the `bd_*` tools and the public catalogue. Prospects, conversations and introductions live only in Mynt's database.

### Rules Mynt enforces

Everything the connector does to a person goes through one path, and Mynt enforces the rules there, whatever the agent intends.

- **First contact is by email only.** It can go to an address the person or their firm published for business contact (the source is recorded), or to someone a Mynt user referred. WhatsApp and calls are only for people who asked for them.
- **Every message says who is writing** (an AI agent for Mynt) and carries an opt-out. Email gets a one-click unsubscribe link and `List-Unsubscribe` headers. Replying STOP, the link, or an admin's `bd_suppress` ends contact for good. Opted-out addresses are kept as hashes so they can't be re-added.
- **Caps:**
  - a few unanswered messages at most, days apart;
  - weekday working hours where the person is;
  - a daily message cap;
  - a spend cap per run and per month.
- **Introductions share each person's details only once both said yes.**
- Replies, web pages and emails are data to the agent, never instructions.

### Consent, erasure and retention

Consent is a per-purpose ledger: contacting by email, by WhatsApp or by phone, introductions, and the profile itself.

- Every grant and withdrawal is appended with its basis (consent, published business contact, referral, or publicly available information), its evidence and its actor.
- Tools check the latest entry, and the agent can ask first with `bd_check_consent`.

Erasure:

- A person can have the connector forget them with `connect_forget_me`, or by asking in a reply, which the agent handles with `bd_erase_on_request`. Mynt admins use `bd_erase`.
- Their profile, messages, introductions and consents are deleted. Only the suppression hashes and the reason remain.

Retention: profiles built from public sources, for people who never replied, are erased after `BD_PROFILE_RETENTION_DAYS` (default 180), without suppressing them.

### Connector tools

People talk to the connector from their MCP client:

- `connect_with_mynt`: what you do and who you would like to meet;
- `connect_refer`: point the connector to someone who should be on Mynt;
- `connect_my_intros` and `connect_answer_intro`: see and answer proposed introductions;
- `connect_forget_me`: erase everything the connector holds about you.

These go to signed-in accounts other than those holding only a firm role (see [Tools every signed-in account gets](roles-and-tools.md#tools-every-signed-in-account-gets)).

Mynt admins have `bd_overview`, `bd_prospects`, `bd_run_now`, `bd_suppress`, `bd_erase` and the kill switch `bd_pause`, which also stops a running agent.

### Connector settings

The connector runs with `BD_ENABLED=1`, on top of what builds need: a sandbox provider key, `PUBLIC_URL` and a model backend.

| Optional setting | Default |
| --- | --- |
| `BD_DAILY_CAP` | 40 |
| `BD_MAX_UNANSWERED` | 3 |
| `BD_FOLLOW_UP_GAP_DAYS` | 3 |
| `BD_RUN_CAP_USD` | 3 |
| `BD_MONTHLY_CAP_USD` | 60 |
| `BD_RUN_EVERY_HOURS` | 6 |
| `BD_PROFILE_RETENTION_DAYS` | 180 |
| `BD_SENDER_NAME` | `Mynt connector` |

Sending providers for email, WhatsApp and voice plug into `ChannelSender`. Until a channel has one, its messages are kept as drafts for admins to review.

## Platform settings

The Platform settings section of the platform admin holds two things.

**E-signature.** A Mynt admin sets up the e-signature service here: its key, its webhook and test mode. See [E-signature](agreements.md#e-signature).

**Operational settings**, read-only, from `get_platform_settings`:

- `BUILD_CAP_USD`
- `BUILD_MONTHLY_CAP_USD`
- `BUILD_AUDIT`
- `BUILD_AUDIT_MODEL`
- `BUILD_AUDIT_CAP_USD`
- `BUILD_AUDIT_MINUTES`
- `BUILD_AUDIT_WORKFLOWS`
- `EXPLORE_CAP_USD`
- `FREESTYLE_USD_PER_HOUR`

Each shows its value, its default, and whether the server's environment sets it. Only these keys are ever read. They are changed on the server by the operator, never from Studio. See [Settings by name](operations.md#settings-by-name).

## Set up a region's regulatory model

A region's regulatory model can be kept as data and applied in one step. This guide uses the United States.

### What the US file holds

[`core/schemas/regulatory/us.json`](../../core/schemas/regulatory/us.json) is the US slice for money transmission, digital-asset on-ramps and off-ramps, and buy-and-hold stablecoin products. Each instrument names its source.

| Regulator | What the file models |
| --- | --- |
| FinCEN | The money services business registration (`fincen_msb`), with its AML, suspicious-activity, currency-transaction, funds-transfer and Travel Rule obligations, plus the OFAC, Regulation E and Form 1099-DA obligations every ramp carries |
| Each state and the District of Columbia, except Montana | A money transmitter licence, under that state's regulator (`jurisdiction: "us-xx"`) |
| NYDFS (`jurisdiction: "us-ny"`) | The money transmitter licence (`nydfs_money_transmitter`), the BitLicense and the limited purpose trust charter |
| California DFPI (`jurisdiction: "us-ca"`) | The money transmission licence (`ca_dfpi_money_transmitter`) and the Digital Financial Assets Law licence |
| OCC | The national trust bank charter and the GENIUS Act's federal payment stablecoin issuer |

Montana is kept as a regulator with no licence type, because Montana has no money transmitter licence.

The file also defines the product categories and regulated product types these cover. Applying it loads the US service types too, including the Mynt Ramp's four.

How coverage works in the file:

- A state regulator's licences cover only its state.
- The state money transmitter licences count only alongside the FinCEN registration (`requires`), which covers no state by itself (`covers: []`).
- The OCC charters cover every state (`covers: ["us"]`), each with a `coverage_note` saying that this is an assumption to verify.
- Each state licence's `coverage_note` names its main source and what is still to verify.

The state entries were built by following the pattern in the file's `description`, which is also how to add or correct one. See [Coverage per state](products.md#coverage-per-state).

### Apply the file

```sh
# in the repository's core/ folder
node scripts/apply-regulatory-model.mjs --url <the server's MCP URL> --login --dry-run   # check only: prints what would be added, updated or removed
node scripts/apply-regulatory-model.mjs --url <the server's MCP URL> --login             # apply
```

Sign-in works as for the seed definitions (see [Applying the seed definitions](products.md#applying-the-seed-definitions)).

### How the script merges

The script merges the file into what the server has. It never replaces it.

- For each category, product type, instrument and regulator in the file, it reads the server's version, merges the file into it by id, and sends the merged whole. Merging by id covers licence types, personas, product-type mappings, GRC registers and repositories, and stakeholders.
- Anything the file leaves out is kept.
- A file can hold only additions, like [`core/schemas/regulatory/in.additions.json`](../../core/schemas/regulatory/in.additions.json).
- Items that end up unchanged aren't sent.
- The region's regulator names are merged, not replaced.

### Checks and removals

- The script checks every merged item against the server's own tool schemas first, and changes nothing if any is wrong.
- The dry run prints, per item, what would be added (`+`), updated (`~`, with the fields) and removed.
- Merging removes something only when a plain list in the file lacks an entry the server has (an action, a covered state, a product line), or when a shipped service type would overwrite a different version on the server.
- Any removal stops the run, changing nothing, unless you add `--allow-removals`. The removals are listed either way.
- Even with `--allow-removals`, items the file doesn't mention are never deleted. Use the `remove_*` admin tools for that.

[`core/test/us-regulatory-model.test.js`](../../core/test/us-regulatory-model.test.js) runs exactly what the script does.

### A US product to start from

[`core/schemas/examples/us/usdc-account.v2.json`](../../core/schemas/examples/us/usdc-account.v2.json) is a firm-less template for a Dollar Holding Account (`dollar-holding-account`). Customers add, hold and cash out US dollars and see dollars only.

Underneath, for the regulatory model:

- a ramp (`payments:sale`) funds a USDC purchase on Solana (`settlement_exchange`, `exchange:sale`, `digital_assets`);
- the purchase settles into custody (`settlement_custody`, `custody_settlement:servicing`);
- cashing out settles back through the ramp.

It has customer segments, KYC, sanctions screening and quoting algorithms, fees, limits, statements, lifecycle events and the FinCEN register obligations each part satisfies. On-ramp and off-ramp acceptance become the customer actions in its developer contract.

A firm takes it as is and adds:

- `owner_entity_id`;
- a `component_provided_by` for each component. A FinCEN registration covers the ramp and the exchange. Custody needs a custodian's licence, such as an OCC national trust bank charter or a NYDFS trust charter;
- its AML compliance officer, bound to the ramp and the exchange;
- its ramp handoffs, bound to its Mynt Ramp subscriptions.

The Dollar Account (`dollar-account`), in [`dollar-account.v2.json`](../../core/schemas/examples/us/dollar-account.v2.json), is the other route. It builds on the money-transmission product instead of composing the ramp itself; see [Base products](products.md#base-products).

## Check the seed definitions

This guide checks the four seed definitions against a Mynt server and changes nothing. It takes about ten minutes the first time. You need an admin account on that Mynt server and its MCP address, which ends in `/mcp`.

The seed definitions are described in [The reference catalogue](products.md#the-reference-catalogue).

1. Install Node.js from [nodejs.org](https://nodejs.org/en/download) (the "LTS" download). Mynt needs version 22.13 or later. To check it worked, open a terminal (Terminal on a Mac, PowerShell on Windows) and type `node --version`. It should print `v22.13` or higher.
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
6. Back in the terminal you see `Signed in.`, then one line per product.
   - `valid, no publish blockers` means the product is ready.
   - `NOT READY` is followed by the reasons, such as a regulator or persona the server doesn't have yet.
   - The last line is `Dry run: 4 definition(s) checked, nothing changed.` or `Stopped: nothing was changed.`
7. Copy everything the terminal printed and send it back to whoever asked you to run the check. It contains no password or token. The only link in it is the sign-in link, which worked once and has already been used.

With `--dry-run`, the script only reads. It makes no change to the server's products, whatever it prints. The only thing it leaves behind is the sign-in itself: the sign-in service records it, and the script's registration as a sign-in client.
