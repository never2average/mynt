# Mynt

**Lovable for finance apps.** Describe the financial product you want; Mynt's AI agents design it, price it, test it, clear compliance, build it and launch it.

**Get early access:** [open an access request](https://github.com/never2average/mynt/issues/new?title=Early%20access%20request) · **Run it yourself:** [Install & build](#install--build) · **Go deeper:** [Reference](#reference)

| If you are… | Mynt gives you |
| --- | --- |
| **A licensed firm** (bank, NBFC, insurer, AMC, distributor) | A product foundry: compose a product from regulated building blocks, price it, test it, see exactly which licences and obligations it carries, and publish it to developers |
| **A developer or vibecoder** | Ready-made regulated products to build on, and a team of coding agents that ships the whole app (server, web and mobile) as one Docker Compose project, audited and hosted |
| **A customer** | Products shaped around what you actually need, offered in the apps you already use |
| **A compliance team** | The regulator → licence → obligation → control map for every product, with evidence and an audit trail |

## The problem

The need for a better financial product is usually obvious from the data. Examples:
- pay-later for a shop's regular customers;
- cover for a slow season;
- six weeks of working capital before a festival, repaid a little every day, instead of a 12-month loan with fixed EMIs.

Building one still takes months:
- pricing and feasibility;
- finding a licensed partner;
- working out which regulations and licences apply;
- controls and disclosures;
- the app itself;
- distribution.

So products get built for the average customer, and nobody builds the one that fits.

## Describe it. Agents build it.

You chat with Mynt and describe the product or app. Its agents take it from there:

1. **The chat agent** works out what's needed, asking one clarifying question at a time.
2. **The product foundry** designs the terms and pricing and picks the licensed partner.
   - A product is composed from regulated building blocks: a recurring deposit is a recurring payment mandate plus a term deposit.
   - So its regulatory regime follows from what it's made of.
   - Its feasibility is worked out in code.
3. **Compliance, platform, acquisition and back office** are spun up for that one product:
   - its compliance is checked against the regulation and the licences behind it;
   - it runs in its own isolated environment;
   - experiences are built for it, and it reaches the right customers;
   - it's serviced and reconciled.
4. **It comes back to the same chat** as a product card: the terms, and a one-tap accept.

```
You:   I need ₹80,000 of stock for six weeks before Diwali.
Mynt:  Got it. Should repayments come from your daily settlements?
You:   Yes, a little every day.
Mynt:  ┌─────────────────────────────────────────────┐
       │ SIX-WEEK STOCK LOAN · READY                 │
       │ ₹80,000 · 6 weeks · 12% p.a. · partner bank │
       │ [ Accept ]  [ Look for more options ]       │
       └─────────────────────────────────────────────┘
```

**From months of launch work to one conversation.**

## How it fits together

```mermaid
flowchart LR
  subgraph People
    C[Customers]
    D[Developers]
    I[Innovators<br/>licensed firms]
    A[Admins]
  end

  subgraph Mynt["Mynt platform"]
    Chat[Chat agent]
    Foundry[Product foundry<br/>composition · pricing · feasibility]
    Reg[Regulatory model<br/>regulators · licences · law · GRC]
    Desk[Governance desk]
    Builds[Coding-agent builds<br/>lead + 7 specialists]
    Runtime[Runtime API<br/>contracts · client sessions · journeys]
    Vault[(Customer vault<br/>encrypted, consented)]
    Hosting[Hosted runtime<br/>isolated VM per developer]
  end

  subgraph Apps["A developer's app (one Compose project)"]
    API[api/]
    Web[web/]
    Mobile[mobile/]
  end

  Providers[Providers' hosted flows<br/>KYC · mandates · e-sign · payments]

  I --> Foundry --> Reg
  A --> Reg
  A --> Desk --> Foundry
  D --> Builds --> Apps
  Apps --> Hosting
  C --> Chat --> Foundry
  C --> Web & Mobile
  API -- app key --> Runtime
  Web & Mobile -- client session --> Runtime
  Runtime --> Vault
  Runtime --> Providers
```

### What a developer ships

Every app Mynt's coding agents build is one Docker Compose project. Only the server ever holds the app key; the web and mobile apps run on short-lived client sessions, and customer data goes straight to Mynt's vault.

```mermaid
flowchart TB
  subgraph Compose["compose.yaml"]
    direction LR
    API["api/<br/>Node · TypeScript<br/>holds the app key<br/>mints client sessions<br/>verifies webhooks"]
    Web["web/<br/>React · Vite<br/>offers · documents<br/>consents · journeys"]
    Mobile["mobile/<br/>Expo React Native<br/>(Kotlin · Swift · Flutter)"]
  end
  SDK["packages/mynt-sdk<br/>generated for the app's products,<br/>in TypeScript, React Native, Kotlin,<br/>Swift, Flutter and Python"]
  SDK -.-> API & Web & Mobile
  Web -- "POST /api/session" --> API
  Mobile -- "POST /api/session" --> API
  API -- "app key" --> M[Mynt runtime API]
  Web -- "client session" --> M
  Mobile -- "client session" --> M
  M -- "webhooks" --> API
```

```
my-app/
├── compose.yaml          api + web (+ mobile web export), hardened: read-only, no capabilities, no host network
├── .env.example          the app key and webhook secret, for api/ only
├── api/                  server: sessions, contracts, webhooks, server-side actions
├── web/                  web app: the journey runner, secure inputs, hosted flows
├── mobile/               Expo app (or Kotlin / Swift / Flutter), same journeys on a client session
└── packages/mynt-sdk/    the generated SDK
```

The coding agents that build it work as a team: an architect plans, server, web and mobile engineers build their parts, a read-only compliance reviewer checks every product's contract and build terms, QA runs every journey against the sandbox, and a release engineer ships the Compose project. Mynt then re-verifies the build itself in a clean sandbox before anything is merged.

## A self-improving compliance loop

Every product gets its own compliance workspace. That workspace links the regulations to:
- the business functions and people responsible;
- what each of them must do and how;
- the policies and controls that do it;
- the metrics and evidence that prove it;
- the disclosures and reports that go back to the regulator.

Each new product, review and inspection makes the loop better. Everything has an audit trail, version history, reporting and connectors to external data.

## Business model

A take rate on every product sold, with no fixed percentage per line: admins configure a take rate per line, proportional to each product's compliance and back-office workload. Each line's rate is a base percentage plus a percentage per workload point, kept between a floor and a cap, and applied to a stated basis (such as revenue or volume).

A product's workload score comes from its composition. Each regulated primitive it is made of scores 1 point. It adds a tenth of the average number of obligations, filings and controls carried by the licences that may provide it, and 1 more point if the product services it. A product that carries more regulation and more ongoing operations pays proportionally more.

## What's in this repository

This repository is Mynt's platform, published as an [MCP](https://modelcontextprotocol.io) server (MCP clients show it as `mynt`). It covers products in eleven lines, grouped by economic function: **credit, securitization, payments, account operations, custody and settlement, wealth, insurance, guarantees and trade, exchange, derivatives and information**. It serves the people and agents around a product:

| Who | What Mynt gives them |
| --- | --- |
| **Consumers** | Products and offers they can use, and a way to say what they need |
| **Innovators** (licensed firms) | The product foundry: composition from regulated primitives, term sheets and feasibility analysis in their own model repository, versioning, licensing checks, distribution |
| **Developers** | Apps and experiences on top of products: SDKs, APIs, webhooks, sandbox, GTM campaigns, and coding agents that build and ship them |
| **Admins** | The regulatory model (regulators, licences, law, GRC), the governance desk that reviews firms, licences and products, and oversight |

Hosted agents do the work: they build, audit, run the product desk, review governance and do business development. Each one is steered by its own folder under `workspaces/`, and Mynt checks whatever an agent produces itself.

The rest of this README is the technical reference.

---

## Reference

Mynt has four kinds of user:

| User type | Can | Tools (in addition to the catalog tools) |
| --- | --- | --- |
| **Consumer** | Use financial products, respond to offers and request products that don't exist yet | `enroll_in_product`, `list_my_enrollments`, `cancel_enrollment`, `list_offers`, `upgrade_enrollment`, `request_product`, `list_my_product_requests` (the last two for any signed-in user) |
| **Developer** | Build app experiences and do GTM engineering around financial products | Apps: `create_app`, `update_app`, `list_my_apps`, `preview_app`, `publish_app`. GTM: `create_segment`, `list_my_segments`, `create_campaign`, `update_campaign`, `lint_campaign`, `launch_campaign`, `pause_campaign`, `end_campaign`, `list_my_campaigns`, `get_campaign_metrics`. Runtime: `create_api_key`, `list_api_keys`, `rotate_api_key`, `revoke_api_key`, `create_webhook`, `list_webhooks`, `delete_webhook`, `rotate_webhook_secret`, `list_webhook_deliveries`, `create_test_consumer`, `simulate_handoff`, `release_app`, `list_app_releases`, `rollback_app`, `get_app_metrics` |
| **Innovator** | Create, test, publish, version and upgrade financial products | `create_product`, `update_product`, `test_product`, `publish_product`, `unpublish_product`, `list_my_products`, `create_product_version`, `update_product_version`, `list_product_versions`, `diff_product_versions`, `restore_product_version`, `upgrade_enrollments`, `get_product_distribution_metrics`, `report_handoff_outcome`, `get_product_take_rate`. Product requests: `list_product_requests` (requesters shown only by a pseudonymous id), `respond_to_product_request` (offer one of your published products; audited) |
| **Admin** | Run Mynt: geographies, product types, the whitelist, and oversight, all from Mynt itself | `define_region`, `define_product_category`, `list_whitelist`, `invite_user`, `revoke_user`, `list_all_campaigns`, `admin_pause_campaign`, `admin_set_product_status`, `define_take_rate`, `list_take_rates`, `audit_log` |

Everyone (including guests without a token) gets the catalog tools: `whoami`, `list_products`, `get_product`, `list_categories`, `list_regions`, `list_product_categories`, `list_apps`, plus the resource `mynt://catalog`.

### Administration

Admins own Mynt's reference data and access. **Every admin action is written to the audit log with who did it.**
- **Geographies** (`define_region`): where products may be offered. Each region records its regulators, its regulatory ecosystem (each regulator's remit, the key laws and bodies), the legal procedure to launch each product line there (licences, approvals, filings, timeline), and the official sources. Fields you leave out keep their values. Innovators read the full picture with `get_region`.
- **Regulated product types** (`define_regulated_product_type`, `list_regulated_product_types`): per region, a catalogue of the product types regulators supervise, kept apart from any one regulator. Each has a Mynt category, the actions that can be taken on it, and optionally its underlying and wrapper (see [Product lines, actions and primitives](#product-lines-actions-and-primitives)). Regulators map onto it **many to many**: one product type, such as a sovereign gold bond, can be supervised by several regulators, each for its own subset of actions. A product type can't be removed, or lose an action, while a regulator still supervises it.
- **Regulatory model** (`define_regulator`, `define_legislation`, `define_judgment`): per region, each regulator's **scope** (the regulated product types it supervises, by id, with the actions it covers; and the customer personas with their qualifications), and the **licence types** it grants. A licence **grants specific actions on specific product types** (a bare id grants everything its regulator supervises on it), so `find_licenses` returns only licences that actually permit the action. Persona and licence ids belong to one regulator: they must start with `<regulator id>_` and can't be reused by another regulator in the region. Each licence carries **GRC**: registers of obligations, reporting/disclosure filings, risks and controls; repositories of regulatory communications, enforcement actions, press releases, policies and risk models; the product types and customer segments it allows; mandatory internal and external stakeholders; and how to apply. **Legal** is recorded alongside in two branches. **Legislative** covers acts, ordinances, rules, regulations, master directions, circulars, guidelines, notifications and orders, each with its issuer, the instrument it's made under (`parent_id`), status and effective date. **Judiciary** covers court and tribunal decisions, each with court and level, bench, holding, the legislation it interprets, and whether it's still good law. Obligations and filings cite either kind by `legal_ref`. Broken links inside a regulator are refused; looser links come back as warnings. Innovators read it with `get_regulator` and `list_legal_instruments` (both branches, filterable), and ask `find_licenses` which licence covers a category, action and persona. `test_product` names the covering licence or warns when there is none.
- **GRC: data and templates.** Each licence's GRC holds two kinds of thing.
  - **Data the regulator requires or has identified:**
    - obligations: recurrence, criticality, how to comply, links to a risk, an owner and the law
    - reporting, disclosure and filings: category, frequency, due rule, form, channels, priority, the obligation it evidences
    - risks: impact, likelihood, how often controls over it must be tested
    - regulatory communications, enforcement actions and press releases

    Frequencies share one vocabulary: one_time, daily … annual, biennial, periodic, event_driven, continuous, on_demand. Free text is mapped to it, and any detail that doesn't fit is kept in `frequency_note`.
  - **Templates (schemas of schemas):** **controls**, **policies**, **risk models**, **inspection history** and **inspection events** aren't records. They teach licensees how to define their own. Each template carries:
    - `guidance` on what the regulator expects
    - the `legal_ref` behind it
    - kind-specific settings (a control's minimum test frequency, a policy's review cadence and approver)
    - a **field schema** licensees' records must follow

    Schemas start from Mynt's defaults (a control's type, test method, test frequency, test status and last test rating; a risk model's scoring methods, factors and thresholds; an inspection's type, outcome and findings by severity). The regulator adds or overrides fields by key, each with its own guidance, or opts out of the defaults. Innovators read a template's resolved schema with `get_template`, and the defaults with `list_template_defaults`.
- **Product types** (`define_product_category`): the categories products may have, and which product lines each may be used in (a category can sit in several, e.g. `exchange_traded` in wealth and securitization).
- **Take rates** (`define_take_rate`, `list_take_rates`): what Mynt takes on each product line, as a base percentage plus a percentage per workload point, with a floor, a cap and the basis it applies to. Every change is audited. A product's owner, its firm and admins see the rate and its full per-component breakdown with `get_product_take_rate`. If no rate is configured for the line, it says so.
- **How products are checked against them:** `test_product` fails a product whose region or category isn't defined and active, or whose category doesn't allow its product line. It warns when the regulator isn't one listed for the region, and when no launch procedure is documented for the product's line there. Retiring a region or category (`active: false`) stops new products from using it; live products stay. A new Mynt starts with neither: admins define them.
- **Whitelist** (`invite_user`, `revoke_user`, `list_whitelist`): kept in step with Clerk's allowlist. Mynt refuses any change that would remove the last admin.
- **Oversight:** see every campaign and pause any of them. Unpublish any product, or republish one; republishing re-runs the tests first.

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

**The developer side:**
- **Find products:** `list_buildable_products` and `get_product_sdk` (data shape, sandbox sample, permitted actions, hand-offs).
- **Ask for access:** `request_product_access` and `list_my_requests`.
- **Check and publish:** `check_experience`, then `publish_app`. Publishing needs access to every product **and** a passing check against each product's terms.

**The innovator side:**
- **Inbox:** `list_requests` and `review_request` (approve or reject, with a note).
- **Visibility:** `list_experiences` shows every app using their products.
- **Control:** `revoke_access`, and **`suspend_product_experiences`** as a kill switch (the product goes private, every grant is revoked, and live campaigns using it are paused).

**Campaigns.** Promoting a financial product is a regulated act:
- A campaign over the launcher's own (or their firm's) products, or the open reference catalogue, goes live once its copy passes the lint.
- A campaign over **another innovator's** products becomes `pending_approval` and lands in that innovator's inbox. It goes live when every product's innovator approves, and goes back to draft on any rejection.

### Coding-agent builds (developers)

A developer can have Mynt **build and ship** one of their experiences. `start_build` runs a coding agent in a fresh [boat.dev](https://boat.dev) sandbox. boat.dev only provides the machine: Mynt installs a pinned Claude Code there and runs it headless with a dollar budget (`--max-budget-usd`, from the build's cap). The agent reaches the model only through Mynt's agent proxy (`/agent`), using a token that works only while its build runs. Mynt calls Claude on Google Cloud Vertex AI with its own service account, or the Anthropic API with its own key, so no credentials ever enter a sandbox. Developers follow the agent's activity live and can steer it: Mynt interrupts the current turn and sends their message as the next one. The agent writes the code against the app's products and their build terms, using a freshly generated SDK and a Mynt **sandbox key** (simulated hand-offs) for end-to-end tests. It runs the [Maxwell](https://github.com/OnFinance/Maxwell) static probes to find and fix issues, starts a preview, and pushes a branch.

**What the agent builds is a whole app, not just a server:** one Docker Compose project with `api/` (holds the app key, mints client sessions, handles webhooks), `web/` and `mobile/` (Expo React Native by default; Kotlin, Swift or Flutter on request), started from `workspaces/coding-build/templates/mynt-app/` with the build's generated SDKs wired in. The lead agent works with a team of subagents in `workspaces/coding-build/.claude/agents/` (architect, server, web and mobile engineers, a read-only compliance reviewer, QA and release). Their skills are human-written skills found on GitHub by HyDE search (Mynt's own drafts used as the queries) and vendored with their upstream licence and source, plus a short Mynt layer.

**Agent sandboxes on Freestyle.** Builds, the product desk, governance review and the connector run in boat.dev sandboxes by default. With `SANDBOX_PROVIDER=freestyle` (and `FREESTYLE_API_KEY`), the same agents run in Freestyle VMs instead (`src/freestyle-sandboxes.ts`):
- each sandbox is a VM with the agents' own `user` account and the sandbox env in a 0600 file;
- previews and source downloads are served at unguessable `style.dev` names, so the link is the credential, as with boat's token-gated links;
- stopping a sandbox deletes the VM;
- machine spend counts toward the caps at `FREESTYLE_USD_PER_HOUR`.

**The developer works in the same box.** While a build runs, and after it ships for as long as its preview is up, `open_sandbox_editor` opens VS Code in the browser on the sandbox (a private, token-gated link plus a password), with a terminal next to the agents. `sandbox_run`, `sandbox_files` and `sandbox_diff` do the same from any MCP client. Output is capped and scrubbed of credentials, and everything the developer does is on the build's timeline. After a build ends, `reopen_sandbox` brings back a fresh sandbox on its pushed branch (with the coding team's workspace and a short-lived GitHub token to push with) for a few hours, so the same tools keep working; `close_sandbox` ends it.

**The agent doesn't grade its own work.** When it finishes, Mynt verifies the build itself, in a **fresh sandbox the agent never touched**, with no secrets:
1. **Package:** Mynt packages the workspace source (without dependencies), records its SHA-256, and the verifier downloads it and checks the checksum.
2. **Mynt's own checks** (`src/verify-script.ts`): tests; lint and types; a secrets scan with `gitleaks`; a dependency audit; a CycloneDX SBOM with `syft`; and every required disclosure present in the source. `gitleaks` and `syft` are pinned versions, checked against their releases' published checksums.
3. **Independent audit:** a separate, audit-only Claude Code run executes the Maxwell static workflows. Mynt then re-hashes the source tree to prove the audit changed nothing.
4. **Decision**, from Mynt's results only. The agent's own report is kept, as advice:
   - the source changed during the audit, no audit, or **critical or high** findings → `blocked`
   - a failing check → `failed`
   - with a repository, the pushed branch must be exactly the verified source, or the build is `blocked`
5. **Ship:** on success, Mynt exposes the token-gated **preview** and **opens the pull request itself**, through its GitHub App, with the verified results in the description. The agent never opens PRs.

**Tracking:** developers follow builds with `get_build` (phase, timeline, cost against the cap, Maxwell summary, readiness, links), see the agent's live activity with `get_build_activity`, `steer_build` it, or `stop_build` it. `list_builds` shows this month's spend. Admins see every build and total spend with `list_all_builds`.

**Spend** is capped per build (`BUILD_CAP_USD`, default 10) and per developer per month (`BUILD_MONTHLY_CAP_USD`, default 100). Mynt reads the sandbox's machine and model cost as it runs, and stops a build that passes its cap.

**Repositories:** developers install the Mynt GitHub App on a repository and run `connect_repository`. Each build gets an installation token limited to that one repository, with contents and pull-request write access for an hour. No long-lived credential enters the sandbox.

**Configuration:** `BOAT_API_KEY`, `PUBLIC_URL` and a model backend for the agent proxy (builds are disabled without them): either `GOOGLE_APPLICATION_CREDENTIALS` (a service account key file with Vertex AI User on a project where the Claude models are enabled; optional `VERTEX_PROJECT_ID`, `VERTEX_REGION`, default `global`) or `ANTHROPIC_API_KEY` (a dedicated key with a spend limit); `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` (pushing is disabled without them); optional `BUILD_AGENT_MODEL` (default `claude-opus-5-5`), `BUILD_SANDBOX_TYPE` and `BUILD_SANDBOX_TTL_SECONDS`.

### The product desk (innovators)

The desk works out whether a product makes sense, financially and legally. Each firm connects its own GitHub repository as its **workspace** (`connect_desk_repository`, after installing the Mynt GitHub App on it). Its computational logic accumulates there as models: `models/<name>/model.json` declares which products a model applies to, the inputs it needs, and how to run it. The code reads the product, its term sheet and the relevant regulation, and writes a report: a verdict (feasible, marginal or infeasible), metrics, checks that cite the law by `legal_ref`, and stress scenarios.

Work is split by what it needs:
- **Code runs (no AI).** `analyze_product` checks the workspace for a model that applies. If the product's term sheet (`set_product_terms`) has that model's inputs, Mynt clones the repository in a sandbox and executes the model. This is deterministic and re-runnable, costs cents, and never involves an agent. The clone token is removed before any model code runs. If inputs are missing, you get the list to fill in.
- **Agent tasks (intelligence).** If no model applies yet, or you ask for one with `desk_task` (e.g. "add an ALM liquidity ladder for our FD book"), the desk agent takes over. That's Claude Code in a sandbox, through Mynt's agent proxy. It designs the model, chooses and states the assumptions, interprets the regulation from the admins' model, and writes the code and tests on a branch. All arithmetic happens in code. **Mynt then runs that branch itself** in a clean sandbox with no credentials, saves that report, and opens a pull request on the workspace with Mynt's numbers. The agent's own numbers are never used.

`test_product` adds an advisory `feasibility` check from the latest report for the current term sheet. It reports stale when the terms changed. `get_product_terms` shows the term sheet and its analysis; `list_desk_jobs`, `get_desk_job` and `stop_desk_job` track the work.

**Configuration:** a boat.dev key and the GitHub App, plus a model backend for agent tasks. Optional: `DESK_JOB_CAP_USD` (per agent task, default 5), `DESK_RUN_CAP_USD` (per code run, default 1) and `DESK_MONTHLY_CAP_USD` (per firm, default 50; unfinished jobs count at their cap).

### Agent workspaces

Every hosted agent is steered by a folder in this repository, not by prompts in the code. When an agent starts, Mynt copies its folder into the sandbox and makes it the agent's working directory. Claude Code picks up its `CLAUDE.md` and skills from there, the skills call the folder's scripts, and the job's data arrives under `job/`. To improve an agent, change its folder.

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

Admins can have an agent review a firm, a licence it registered, or a product it offers, before they decide (`open_review_case`). With `REVIEW_AUTO_OPEN=1`, a case opens for every licence awaiting review. The agent only researches and judges; it can't change anything, and the admin makes every decision.

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
- **Its own items:** it decides the items it can from its own records (licence coverage, segments, product tests, feasibility, the licence type) and freezes the case.
- **Evidence:** after the agent finishes, Mynt re-fetches every cited source (public https pages only) and checks each quote is really there. An item backed only by quotes it can't find becomes **unverified**; a "silent" answer that doesn't say what was searched becomes **not reviewed**.
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

Mynt's **connector** is an AI agent that grows Mynt. It finds innovators (licensed firms that could offer products) and developers (who could build on them), talks with them, and introduces people who should work together. It runs on its own schedule on the same harness as builds: Claude Code in a sandbox, using the model through Mynt's agent proxy. Its only tools are Mynt's MCP server: the `bd_*` tools and the public catalogue. Prospects, conversations and introductions live only in Mynt's database.

Everything the connector does to a person goes through one path, and Mynt enforces the rules there, whatever the agent intends:
- **First contact is by email only.** It can go to an address the person or their firm published for business contact (the source is recorded), or to someone a Mynt user referred. WhatsApp and calls are only for people who asked for them.
- **Every message says who's writing** (an AI agent for Mynt) and carries an opt-out. Email gets a one-click unsubscribe link and `List-Unsubscribe` headers. Replying STOP, the link, or an admin's `bd_suppress` ends contact for good. Opted-out addresses are kept as hashes so they can't be re-added.
- **Caps:**
  - a few unanswered messages at most, days apart;
  - weekday working hours where the person is;
  - a daily message cap;
  - a spend cap per run and per month.
- **Introductions share each person's details only once both said yes.**
- **Consent is a per-purpose ledger:** contacting by email, by WhatsApp or by phone, introductions, and the
  profile itself.
  - Every grant and withdrawal is appended with its basis (consent, published business contact, referral, or
    publicly available information), its evidence and its actor.
  - Tools check the latest entry, and the agent can ask first with `bd_check_consent`.
- **Erasure:**
  - A person can have the connector forget them, with `connect_forget_me`, or by asking in a reply, which the
    agent handles with `bd_erase_on_request`. Admins use `bd_erase`.
  - Their profile, messages, introductions and consents are deleted. Only the suppression hashes and the
    reason remain.
- **Retention:** profiles built from public sources, for people who never replied, are erased after
  `BD_PROFILE_RETENTION_DAYS` (default 180), without suppressing them.
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
- **Attribution:** live campaigns show up in consumers' `list_offers`. Each consumer always sees the same variant, and `enroll_in_product` with the offer's `campaign_id` is attributed. `get_campaign_metrics` reports audience, enrollments, conversion, and results per variant and per product.

### Versioning (innovators)

A published product isn't edited in place:
- `create_product_version` drafts the next version with a changelog. `test_product` and `publish_product` then act on that draft, with the same gates as a new product. The live version keeps serving until the draft is published.
- `list_product_versions` and `diff_product_versions` show the history.
- `restore_product_version` drafts a rollback as a new version, so history stays linear.
- Enrollments remember the version they joined on. `upgrade_enrollments` moves all of them to the live version, and a consumer can `upgrade_enrollment` their own.

### Runtime API, webhooks and sandbox (developers)

The MCP tools are for building; a shipped app talks to Mynt's **runtime API** under `/v1`. It is separate from `/mcp`: requests authenticate with a per-app key, not a Clerk sign-in.

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

**Webhooks.** Each app can register webhooks:
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

**Generated SDKs.** A generated TypeScript SDK now has two entry points:
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

**Tools.** `get_default_journey` builds the minimum compliant journey from the product's contract, so developers start from something that works. `preview_journey` renders an HTML outline. `save_journey` stores a journey on an app, and `list_journeys` shows whether each saved journey is still current.

**Serving to devices.** Devices fetch a saved journey with `GET /v1/client/journeys/{journey}`. It's served only while it was checked against the product's live contract. Once a new contract is published, it returns `journey_outdated` until the developer checks and saves it again.

**The customer vault.** Data a customer gives once is kept per app and per customer reference, so the next journey can skip asking for it. It's encrypted at rest with AES-256-GCM, using `MYNT_VAULT_KEY`; the host installer generates that key once and keeps it across runs. Sandbox sessions use a key that exists only in that process.

The device routes need a client session that has a `customer_ref`:
- **`POST /v1/client/fields`** stores values. The server enforces the rules:
  - only fields one of the product's client actions needs;
  - only after an active consent;
  - sensitive fields only from a secure field;
  - every value validated against the data dictionary.
- **`GET /v1/client/fields`** shows what's held, masked.
- **`POST /v1/client/prefill`** fetches fields from Account Aggregator, DigiLocker or CKYC, with consent. Sandbox sessions get realistic fixture values. Live connectors return `501` until they're configured.
- **`DELETE /v1/client/fields`** erases everything held for the customer.

A hosted action refuses to start (`data_required`) until the personal data it sends is held for the customer.

**SDKs for every client.** `create_sdk` languages: `typescript` (server, plus `./browser`), `python` (server), `react_native`, `kotlin` (Android), `swift` (iOS and macOS) and `flutter` (Dart).

Every device SDK has the same client and journey runner as `./browser`, and each:
- runs on a client session, never an app key;
- carries the app's contract constants (client actions, consent purposes, documents), so misuse fails before any request is sent;
- hashes evidence with the platform's SHA-256: WebCrypto, `MessageDigest`, CryptoKit or swift-crypto, Dart's `crypto`, or plain TypeScript on React Native.

The device SDKs are generated from source templates in [`sdk-templates/`](sdk-templates). CI compiles a generated set on every change: Kotlin with `kotlinc`, Dart with `dart analyze`, Swift with `swift build`.

**Hosted runtime.** Developers can run their apps' financial part on Mynt: the server that holds the app key, calls contract actions and handles webhooks. Each developer gets their own VM (`request_hosting`, `hosting_status`). It's never reachable from the internet or from the platform's network:
- **First boot:** the VM installs Docker, gVisor and WireGuard, then generates its own WireGuard key, which never leaves it.
- **Registration:** it registers with a one-time token (`POST /v1/hosting/bootstrap`). Mynt then locks its cloud firewall down to WireGuard to the gateway, and nothing else in or out.
- **All traffic goes through the tunnel.** The gateway forwards nothing directly. Its egress proxy only reaches Mynt's API, GitHub, package registries and the hand-off hosts of the app's products.
- **Deploying:** `deploy_app(app_id, build_id)` takes only a build that passed Mynt's verification. The VM's agent then polls its policy (`GET /v1/hosting/policy`), which gives it the verified commit, a read-only, short-lived token to fetch it, and the app's dedicated key (stored sealed). The agent builds the image and runs it under gVisor: read-only, with no capabilities, and limited CPU and memory.
- **Serving:** customers reach the app at `<app>.<HOSTING_APPS_DOMAIN>`, through the edge and the tunnel.
- **The kill switch:** an admin's `suspend_tenant` takes the VM off the gateway at once (peers, routes and egress) and powers it off. `resume_tenant` brings it back, and `undeploy_app` stops a single app.

**Direct hosting on Freestyle** (set `FREESTYLE_API_KEY`; the default when present). Instead of a tunnel, Mynt drives each developer's [Freestyle](https://www.freestyle.sh) VM through Freestyle's API:
- **The VM starts with nothing in and nothing out.** Its egress is exactly the union of its apps' allowlists, as per-domain rules that pass TLS straight through, so nothing in between sees the traffic. The npm registries, which Freestyle's edge can't carry yet, are allowed by their own addresses instead.
- **Deploying** builds the verified commit on the VM. The source token and the app key travel as the command's environment, never its text. The container runs read-only, with no capabilities and limited CPU and memory. The VM itself is the developer's own isolated machine.
- **Serving:** each app gets a public HTTPS route, `https://mynt-<app>.style.dev` (or `<app>.<HOSTING_APPS_DOMAIN>`), straight to its port.
- **The developer logs in:** `vm_access` returns an SSH command for their own Linux user (in the docker group, no sudo), scoped to their VM and valid for a few hours. It works as a VS Code Remote-SSH host too, and each new login revokes the last. `app_status`, `app_logs`, `app_run` and `restart_app` run at once, with no queue.
- **The kill switch** pauses the VM.

**Working with a hosted app.** The hosting VM accepts no inbound connections, so developers reach it through Mynt: `app_status` (state, health, restarts, CPU and memory), `app_logs`, `app_run` (a command inside the app's container, under gVisor, never on the VM itself) and `restart_app`. Mynt queues the request; the VM's agent claims it over the tunnel within a few seconds, runs it against that developer's own app container only, and posts the result back, scrubbed of secrets. Every request is audited.

[`deploy/host/hosting-gateway.sh`](deploy/host/hosting-gateway.sh) sets up the gateway on the host that runs Mynt, and a timer re-syncs it every minute from `mynt hosting wg-peers`, `egress-allowlist` and `routes`. Hosting is enabled with `HOSTING_DO_TOKEN`, `HOSTING_GATEWAY_ENDPOINT`, `HOSTING_GATEWAY_PUBLIC_KEY` and `PUBLIC_URL`; DigitalOcean is the first provider.

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

Roles nest: **every admin is also an innovator, every innovator a developer, and every developer a consumer**. Each role gets its own tools plus everything below it. Tools are registered per user, so a client only *sees* the tools its roles allow. `whoami` shows both the granted and the effective roles.

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

A product that spans functions is a **composition** of primitives rather than a line of its own. A cross-border transfer is an exchange primitive (the currency conversion) plus a payments primitive (moving the money). Retirement is wealth plus a statutory wrapper, and commodities are an underlying, not a line.

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

- `underlying`: what it is made of: `cash`, `securities`, `commodities`, `real_assets`, `receivables`, `risk` or `data`
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

A product's full definition follows [`schemas/financial-product.v2.schema.json`](schemas/financial-product.v2.schema.json).

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

Every error comes back at once.

**What saving does**
- It sets the product's composition and parties, so the regime, the publish checks, pins and drift all work as before.
- It sets the catalogue record from the definition's projection, so existing tools, SDKs and apps keep reading the same fields.
- On a live product, it goes into the draft version.

**At publish.** The definition is checked again, since parties, licences and records may have changed. Its hash is then pinned as `pins.definition_hash`.

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

Variants (a template plus a patch) can't be saved yet. Save the resolved product as `plane.role: "standalone"`.

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

Requires Node.js 22.13+ and a Postgres database. [Supabase](https://supabase.com) (self-hosted or cloud) is the intended backend; any Postgres 15+ works.

```bash
git clone https://github.com/never2average/mynt.git
cd mynt
npm install
npm run build
```

## Users and tokens

Users, roles, products, enrollments and apps are stored in Postgres (Supabase), in a dedicated `financial_products` schema. Supabase's auto-generated REST API only exposes `public`, so this data isn't reachable through it. Set `DATABASE_URL` to the connection string; the schema is created on first start. If the schema already exists and is owned by the app's role (as the deploy script sets it up), the role needs no database-level privileges.

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

[`deploy/setup-vm.sh`](deploy/setup-vm.sh) sets up an Ubuntu VM end to end and is safe to re-run for updates:

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
