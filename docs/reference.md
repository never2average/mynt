# Mynt technical reference

This is the index to Mynt's technical reference. The reference is 17 files in [`docs/reference/`](reference/), one per area: every tool, the runtime API, hosting, deployment and operations.

For what Mynt is, see the [README](../README.md). For how the parts fit together, see [architecture.md](architecture.md). For a map of the whole `docs/` folder, see [docs/README.md](README.md).

## Start with your role

Pick the list for what you do and read it in order. Every list starts with [Roles and tools](reference/roles-and-tools.md), which says what each role can do.

### Builder

A builder composes financial products and builds apps on them. In code the role is named `developer` or `innovator`.

1. [Roles and tools](reference/roles-and-tools.md)
2. [Products](reference/products.md)
3. [Apps and builds](reference/apps-and-builds.md)
4. [Runtime API](reference/runtime-api.md)
5. [Workspaces and sign-in](reference/workspaces-and-sign-in.md)
6. [Agreements](reference/agreements.md)
7. [Risk](reference/risk.md)
8. [Vendors and the marketplace](reference/vendors-and-marketplace.md)
9. [Mynt Studio](reference/studio.md)
10. [Solana programs](reference/solana-programs.md), when the app has an on-chain program

### Licence provider

A licence provider is a firm holding licences that sponsors builders' products.

1. [Roles and tools](reference/roles-and-tools.md)
2. [Firms, licences and licence providers](reference/licence-providers.md)
3. [Agreements](reference/agreements.md)
4. [Money rails](reference/money-rails.md)
5. [Liquidity pools and on-chain treasuries](reference/liquidity-and-treasury.md)
6. [Connecting a licence provider to Mynt](partners.md), for the firm's engineers
7. [Confidential computing](reference/confidential-computing.md)
8. [Mynt Studio](reference/studio.md#licences)

### Vendor

A vendor is a firm offering standard services that builders plug into their products.

1. [Roles and tools](reference/roles-and-tools.md)
2. [Vendors and the marketplace](reference/vendors-and-marketplace.md)
3. [Agreements](reference/agreements.md)
4. [Mynt Studio](reference/studio.md#my-services)

### Liquidity provider

A liquidity provider is a firm or fund that puts capital into products' pools.

1. [Roles and tools](reference/roles-and-tools.md)
2. [Liquidity pools and on-chain treasuries](reference/liquidity-and-treasury.md)
3. [Product health](reference/licence-providers.md#product-health)
4. [Money rails](reference/money-rails.md)
5. [Mynt Studio](reference/studio.md#earn)

### Mynt admin

A Mynt admin is a person with the `admin` role, who runs the platform.

1. [Roles and tools](reference/roles-and-tools.md)
2. [Platform administration](reference/platform-admin.md)
3. [Agent benchmarks](reference/benchmarks.md), before changing an agent's instructions, skills or model
4. [Firms, licences and licence providers](reference/licence-providers.md)
5. [Risk](reference/risk.md)
6. [Agreements](reference/agreements.md#e-signature)
7. [Money rails](reference/money-rails.md)
8. [Solana programs](reference/solana-programs.md#mainnet-program-gate)
9. [Workspaces and sign-in](reference/workspaces-and-sign-in.md)

### Operator

An operator runs a Mynt server and holds its settings.

1. [Running Mynt](reference/operations.md)
2. [Workspaces and sign-in](reference/workspaces-and-sign-in.md#workspaces-are-the-identity-providers-organizations)
3. [Apps and builds](reference/apps-and-builds.md#build-settings), for the build and hosting settings
4. [Solana programs](reference/solana-programs.md#solana-settings), including [Turnkey custody](reference/solana-programs.md#turnkey-custody)
5. [Confidential computing](reference/confidential-computing.md)
6. [Mynt's architecture](architecture.md)

### Coding agent

A coding agent working in this repository reads [AGENTS.md](../AGENTS.md) first.

1. [AGENTS.md](../AGENTS.md)
2. [Mynt's architecture](architecture.md)
3. [Roles and tools](reference/roles-and-tools.md)
4. The reference file for the area being changed, from the table below

## Reference files

| File | What it covers |
|---|---|
| [roles-and-tools.md](reference/roles-and-tools.md) | The seven roles, how they nest, what each can do, and where its tools are documented |
| [products.md](reference/products.md) | Product lines, actions and primitives; product definitions; base products; coverage per state; the reference catalogue; stages, archiving and versioning; product requests and ideas; the product desk |
| [apps-and-builds.md](reference/apps-and-builds.md) | Apps, access to products, coding-agent builds, repositories, agent workspace folders, hosting and Put online, campaigns |
| [runtime-api.md](reference/runtime-api.md) | What an app calls at run time: keys, hand-offs, webhooks, sandbox mode and releases, client sessions, SDKs, journeys, the customer vault |
| [workspaces-and-sign-in.md](reference/workspaces-and-sign-in.md) | Workspaces, members, what a workspace owns, stages and promotion, the audit trail, profit and loss, invite-only sign-in, linked accounts, chat sessions |
| [vendors-and-marketplace.md](reference/vendors-and-marketplace.md) | Service types, offerings, conformance, subscriptions, the marketplace and standard terms, vendor onboarding, the Mynt Ramp, the wire contract |
| [services.md](reference/services.md) | Services, the third kind built on Mynt: creating one, the contract a build reads, the endpoint and signing secret, stages and promotion checks, conformance on each new build, reading a service |
| [platform-admin.md](reference/platform-admin.md) | The platform admin in Studio, invitations, firms and licence review, the regulatory model, take rates, oversight, the governance desk, the connector |
| [licence-providers.md](reference/licence-providers.md) | Legal entities, sponsorship, firm checks, covenants, the partner kit, product health, and a sponsored US product end to end |
| [agreements.md](reference/agreements.md) | App agreements and their scopes, the program agreements Production needs, e-signature, oversight audits, service levels |
| [risk.md](reference/risk.md) | Risk registers for apps and products, the seven risk areas, Mynt's risk models |
| [money-rails.md](reference/money-rails.md) | The pre-approved rails money moves on, the chokepoint that authorises every movement, partner requirements, the money ledger |
| [liquidity-and-treasury.md](reference/liquidity-and-treasury.md) | Liquidity pools, positions, the withdrawal queue, on-chain treasuries on Solana |
| [solana-programs.md](reference/solana-programs.md) | An app's Solana program from reserve to deploy, signers, the toolchain and lock pins, the mainnet program gate, Turnkey custody |
| [confidential-computing.md](reference/confidential-computing.md) | What the confidential service protects, its hosts, keys and attestation, releases, settings and operator steps |
| [benchmarks.md](reference/benchmarks.md) | Agent benchmarks: the task sets, how a run is scored and capped, starting a run, the regression gate |
| [operations.md](reference/operations.md) | Install, users and tokens, running the server, sign-in set-up, deploying, backups, every setting by name |
| [studio.md](reference/studio.md) | What people see and do in Mynt Studio, page by page |

Every tool with its inputs is listed by the generated tool reference on the docs site (`/docs/tools` in Mynt Studio) and by `/llms-full.txt` on a running server. See [Where every tool is listed](reference/roles-and-tools.md#where-every-tool-is-listed).

## Where the old sections went

This file used to hold the whole reference. Code comments, older links and installed files may still name one of its sections. Each old section, and each name used for one, is listed here with where it is now.

| Old section or name | Now in |
|---|---|
| Mynt technical reference (the role table and the tools everyone gets) | [Roles and tools](reference/roles-and-tools.md) |
| Administration | [Platform administration](reference/platform-admin.md) |
| The regulatory model, GRC data and templates, product types | [The regulatory model](reference/platform-admin.md#the-regulatory-model) |
| Coverage per state | [Coverage per state](reference/products.md#coverage-per-state) |
| Base products | [Base products](reference/products.md#base-products) |
| Take rates | [Take rates](reference/platform-admin.md#take-rates) |
| Whitelist; public sign-up | [Invite-only sign-in](reference/workspaces-and-sign-in.md#invite-only-sign-in) |
| Removing a test or demo app | [Removing a test app](reference/platform-admin.md#removing-a-test-app) |
| The Studio admin panel | [The platform admin in Studio](reference/platform-admin.md#the-platform-admin-in-studio) |
| Inviting from Clerk | [Inviting people](reference/operations.md#inviting-people) |
| Who does what: licensed innovators, software developers | [Who does what](reference/roles-and-tools.md#who-does-what) |
| Opening products to developers | [Building on a product](reference/apps-and-builds.md#building-on-a-product) |
| Vendors: standard services, per region | [Vendors and the marketplace](reference/vendors-and-marketplace.md) |
| Onboarding a vendor | [Onboarding a vendor](reference/vendors-and-marketplace.md#onboarding-a-vendor) |
| Building a service on Mynt and listing it | [Services](reference/services.md) |
| Onboarding a regulated firm (licence provider) | [Onboarding a regulated firm](reference/licence-providers.md#onboarding-a-regulated-firm) |
| The vendor wire contract | [The wire contract](reference/vendors-and-marketplace.md#the-wire-contract) |
| The Mynt Ramp | [The Mynt Ramp](reference/vendors-and-marketplace.md#the-mynt-ramp) |
| Coding-agent builds (developers) | [Coding-agent builds](reference/apps-and-builds.md#coding-agent-builds) |
| Repositories | [Repositories](reference/apps-and-builds.md#repositories) |
| Financial product ideas | [Product ideas](reference/products.md#product-ideas) |
| Solana programs (developers) | [Solana programs](reference/solana-programs.md) |
| Closing a program | [Closing a program](reference/solana-programs.md#closing-a-program) |
| RPC limits | [RPC limits](reference/solana-programs.md#rpc-limits) |
| Mainnet program gate | [Mainnet program gate](reference/solana-programs.md#mainnet-program-gate) |
| Vulnerability database | [Vulnerability database](reference/solana-programs.md#vulnerability-database) |
| Turnkey custody; Turnkey custody for the mainnet deploy authority | [Turnkey custody](reference/solana-programs.md#turnkey-custody) |
| Product health: an on-chain record licence providers can trust | [Product health](reference/licence-providers.md#product-health) |
| Partner kit: connecting a licence provider's ledger | [Partner kit](reference/licence-providers.md#partner-kit) |
| Confidential computing | [Confidential computing](reference/confidential-computing.md) |
| Covenants: a licence provider's rules on a product it sponsors | [Covenants](reference/licence-providers.md#covenants) |
| The product desk (innovators) | [The product desk](reference/products.md#the-product-desk) |
| Agent workspaces | [Agent workspaces](reference/apps-and-builds.md#agent-workspaces) |
| The governance desk (admins) | [The governance desk](reference/platform-admin.md#the-governance-desk) |
| The connector: business development by an agent | [The connector](reference/platform-admin.md#the-connector) |
| SDKs and experiences (developers) | [SDKs and experiences](reference/runtime-api.md#sdks-and-experiences) |
| GTM engineering (campaigns) | [Campaigns](reference/apps-and-builds.md#campaigns) |
| Versioning (innovators) | [Versioning](reference/products.md#versioning) |
| Runtime API, webhooks and sandbox (developers) | [Runtime API](reference/runtime-api.md) |
| Hosted runtime; direct hosting; working with a hosted app | [Hosting](reference/apps-and-builds.md#hosting) |
| Workspaces | [Workspaces](reference/workspaces-and-sign-in.md#workspaces) |
| Workspaces are the identity provider's organizations | [Workspaces are the identity provider's organizations](reference/workspaces-and-sign-in.md#workspaces-are-the-identity-providers-organizations) |
| Chat sessions (the studio's chats) | [Chat sessions](reference/workspaces-and-sign-in.md#chat-sessions) |
| Linked accounts | [Linked accounts](reference/workspaces-and-sign-in.md#linked-accounts) |
| Licence providers: sponsoring builders' products | [Sponsorship](reference/licence-providers.md#sponsorship) |
| "Is the licence provider a real company?" | [Firm checks](reference/licence-providers.md#firm-checks) |
| A sponsored US product; A sponsored US product, end to end | [A sponsored US product, end to end](reference/licence-providers.md#a-sponsored-us-product-end-to-end) |
| App agreements and target customers | [App agreements](reference/agreements.md#app-agreements) and [Target customers](reference/agreements.md#target-customers) |
| Production needs program agreements | [Production needs program agreements](reference/agreements.md#production-needs-program-agreements) |
| Risk registers for apps and products | [Risk registers](reference/risk.md#risk-registers) |
| Mynt's risk models | [Risk models](reference/risk.md#risk-models) |
| Program agreements signed by e-signature | [E-signature](reference/agreements.md#e-signature) |
| Oversight audits under app agreements | [Oversight audits](reference/agreements.md#oversight-audits) |
| Service levels under app agreements | [Service levels](reference/agreements.md#service-levels) |
| Approved money rails | [Money rails](reference/money-rails.md) |
| Partner requirements | [Partner requirements](reference/money-rails.md#partner-requirements) |
| Liquidity pools | [Liquidity pools](reference/liquidity-and-treasury.md#liquidity-pools) |
| The withdrawal queue | [The withdrawal queue](reference/liquidity-and-treasury.md#the-withdrawal-queue) |
| On-chain treasuries (devnet; mainnet behind an admin switch) | [On-chain treasuries](reference/liquidity-and-treasury.md#on-chain-treasuries) |
| Before mainnet (tracked) | [Before mainnet](reference/liquidity-and-treasury.md#before-mainnet) |
| Verified builds and upgrade locks | [Verified builds and upgrade locks](reference/liquidity-and-treasury.md#verified-builds-and-upgrade-locks) |
| Treasury mainnet | [Treasury mainnet](reference/liquidity-and-treasury.md#treasury-mainnet) |
| Product lines, actions and primitives | [Product lines, actions and primitives](reference/products.md#product-lines-actions-and-primitives) |
| Legal entities: facts, parties and GRC folders | [Legal entities](reference/licence-providers.md#legal-entities) |
| Product definitions (v2) | [Product definitions](reference/products.md#product-definitions) |
| Run it yourself: check the seed definitions against a Mynt server | [Check the seed definitions](reference/platform-admin.md#check-the-seed-definitions) |
| Set up a region's regulatory model: the United States | [Set up a region's regulatory model](reference/platform-admin.md#set-up-a-regions-regulatory-model) |
| Innovator workflow: idea, staging, production | [Product stages](reference/products.md#product-stages) |
| Archiving a product | [Archiving a product](reference/products.md#archiving-a-product) |
| Install & build | [Install and build](reference/operations.md#install-and-build) |
| Users and tokens | [Users and tokens](reference/operations.md#users-and-tokens) |
| Run it; Locally over stdio; Shared server over HTTP | [Run it](reference/operations.md#run-it) |
| Whitelist sign-in with Clerk | [Sign-in with Clerk](reference/operations.md#sign-in-with-clerk) |
| Mynt's own apps sign in without a consent screen | [Mynt's own apps sign in without a consent screen](reference/operations.md#mynts-own-apps-sign-in-without-a-consent-screen) |
| Deploying to a VM with self-hosted Supabase | [Deploying](reference/operations.md#deploying) |
| On a server that already runs Caddy | [On a server that already runs Caddy](reference/operations.md#on-a-server-that-already-runs-caddy) |
| Mynt Studio on Mynt's domain | [Mynt Studio on Mynt's domain](reference/operations.md#mynt-studio-on-mynts-domain) |
| Backups | [Backups](reference/operations.md#backups) |
| Starting empty | [Starting empty](reference/operations.md#starting-empty) |
| Development | [Development](reference/operations.md#development) |
| Disclaimer; License | [The README's Disclaimer](../README.md#disclaimer) and [License](../README.md#license) |

## Words used in these docs

The docs use one word for each thing. Code identifiers keep their own spelling (`license_provider`, `register_license`); prose uses British spelling (licence, catalogue). Amounts are US dollars.

| Word | What it means |
|---|---|
| builder | The one role that composes products and builds apps on them. In code it has two names, `developer` and `innovator`; each implies the other |
| licence provider | A firm holding licences that sponsors builders' products (`license_provider`). "Partner" appears only in fixed names: partner kit, partner ledger, `PARTNER_*` settings, ramp partner |
| vendor | A firm offering standard services (`vendor`). Mynt Studio labels vendors "service providers" |
| liquidity provider | A firm or fund putting capital into pools (`liquidity_provider`) |
| Mynt admin | A person with the `admin` role, who runs the platform. A workspace admin and a workspace owner are workspace roles, a different thing |
| platform admin | The `/platform` area of Mynt Studio. The person using it is a Mynt admin |
| consumer | The Mynt role of a person who enrols in products |
| customer | A person using a builder's app through the runtime API |
| operator | The person who runs a Mynt server and holds its settings |
| workspace | A team that owns apps; one organization at the identity provider |
| agent workspace | An agent's folder under `core/workspaces/<agent>/` |
| app workspace, product workspace | Pages in Mynt Studio: an app's, at `/<app id>`, and a product's, at `/products/<id>` |
| financial product, product | A composition of primitives |
| primitive | A product line joined to an action |
| product line | One of eleven lines of financial product |
| action | One of the nine regulated actions. `create_product`'s `action` is something else: the firm's role on the product |
| product definition | The v2 JSON document that describes a product |
| reference catalogue | The products with no owner that a Mynt admin publishes. The public read tools are the catalogue tools; the resource is `mynt://catalog` |
| stage | Idea, staging or production. Tools promote and demote; Studio's buttons read Move to staging, Move to production and Move back for products, and Promote to Staging, Promote to Production and Move back for apps |
| app agreement | An agreement between an app and a firm |
| program agreement | The kind of app agreement Production needs with every sponsoring licence provider |
| scope | What an agreement covers: `technology`, `manpower` or `financial_regulatory_operations` |
| oversight audit | An audit a licence provider runs on an app under a program agreement. Studio calls them Agreement audits and Audit Obligations |
| service level | A commitment attached to an agreement, under a service-level agreement (SLA) |
| MSA | Master services agreement |
| risk register | The list of risks kept for an app, a product or Mynt itself |
| risk model | One of Mynt's own models for measuring a risk |
| risk area | One of seven areas a risk belongs to |
| risk category | One of nine older categories, each mapped to an area. Not the same as an area |
| money rail, rail | A pre-approved way money moves |
| chokepoint | The one check every money movement passes (`authorizeMovement`) |
| liquidity pool, pool | Capital committed to a product by liquidity providers |
| on-chain treasury | A Solana program that holds a pool's USDC |
| product health, health snapshot | The periodic record of a product's financial figures |
| covenant | A licence provider's rule on a product it sponsors |
| confidential computing | The feature. The confidential service is the attested service (code name keyhouse); a confidential host is one of `local`, `aws-nitro` or `gcp-confidential-space`; a release is one announced build of the service |
| Mynt Studio, Studio | The web app. Build is its `/new` page; Put online is the action that hosts the newest verified build |
| invite-only sign-in | The rule that only invited people may sign in. "Whitelist" is used only for the tool `list_whitelist` and the list it returns |
| agent sandbox | Where agents build |
| sandbox mode | Test keys in the runtime API |
| Mynt Ramp sandbox | The test endpoint for the Mynt Ramp |
| GRC | Governance, risk and compliance |
| MCP | Model Context Protocol |
| SBOM | Software bill of materials |

## Disclaimer and licence

See the README's [Disclaimer](../README.md#disclaimer) and [License](../README.md#license).
