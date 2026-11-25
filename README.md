# Mynt

Lovable for finance apps: regulated financial products, composed from building blocks, and the apps on top of them, built by agents and verified by Mynt.

Mynt is a Model Context Protocol (MCP) server, and Mynt Studio, a web app on top of it. Builders use it to compose financial products and build apps on them; licence providers, vendors and liquidity providers stand beside them; Mynt admins keep the regulatory model.

[Get early access](https://github.com/never2average/mynt/issues/new?title=Early%20access%20request) · [Run it yourself](docs/reference/operations.md#install-and-build) · [Technical reference](docs/reference.md) · [Mynt Studio](docs/reference/studio.md) · [All docs](docs/README.md)

## The problem Mynt removes

Shipping a finance app means a long stretch of work before the first customer sees a screen. Which licence covers the product? Which regulator, which filings, which disclosures? Who integrates identity checks, e-signature, credit bureau and bank data, again? And once the app exists, who proves it shows every mandated document word for word and never leaks a key?

Mynt answers these from one place:

1. A builder composes a product out of regulated building blocks.
2. Mynt works out the regulation that follows, and which licences cover each part.
3. The builder asks for an app in plain words.
4. Coding agents build it, Mynt verifies it, and Mynt hosts it.

## Two ideas behind everything

### A financial product is a composition

Nobody designs a financial product from scratch on Mynt. You compose one from regulated building blocks called **primitives**. A primitive is a product line (credit, payments, insurance and eight others) joined to an action on it (issuance, sale, servicing and six others):

- a recurring deposit is a recurring payment mandate plus a term deposit;
- a foreign-currency transfer is a currency exchange plus a payment.

Because the product is made of primitives, its **regime** follows from them. The regime is the regulation that applies to a product: which regulators supervise it, which licences may provide each part, and which obligations, filings and controls apply. Mynt works this out from its regulatory model, which is data that Mynt admins keep: regulators, licence types, law, and governance, risk and compliance (GRC) registers.

Mynt then checks the product against its regime: the firm behind it, the parties to each part, and their GRC folders. A part must be covered by a verified licence, the firm's own or a sponsoring licence provider's, in each place the product is offered.

Each product also carries its own compliance records: who is responsible for what, the policies and controls, the evidence, and the disclosures that go back to the regulator. Changes are versioned and written to an audit trail.

Changing a product means composing it again, not rebuilding it. Add a part, change who provides it or tighten a term, and the new definition is checked against the regime before it goes live.

### Agents build; Mynt verifies

Agents do the work on Mynt: designing, pricing, building, reviewing, prospecting. Not one of them grades its own work.

- **Every build is verified in a clean sandbox the agent never touched.** Tests, lint and types, a secrets scan, a dependency audit, a software bill of materials (SBOM) and every required disclosure are checked before a pull request is opened. A failed check blocks the pull request.
- **An independent security audit runs when the operator turns it on** (`BUILD_AUDIT=maxwell`). It is off by default, and it is separate from the checks above, which always run.
- **Agents are steered by folders, not by prompts in code.** Each agent's instructions, skills and scripts live in `core/workspaces/<agent>/`, which becomes its working directory. Its skills are human-written ones found on GitHub and vendored with their licence and source.
- **Secrets never enter a sandbox or a hosted app.** Agents reach the model through Mynt's proxy with a token that dies with the run. A hosted app sends a placeholder, and the real key is added on the way out.
- **Every cost is counted.** Sandboxes, model spend and hosting are recorded from metered figures against per-build and monthly caps. A figure that can't be measured is never shown as $0.
- **CI builds and runs the starter app on every push.** It scaffolds the app from a freshly generated SDK, compiles `api/`, `web/` and the Expo app, builds the images and runs them hardened (read-only, no capabilities) before checking that they serve.

## How it works, end to end

| Stage | Who | What happens |
|---|---|---|
| Compose | A builder | Picks the primitives, writes the product definition (terms, pricing, customer segments, servicing) and tests it. The product starts as an idea |
| Cover | A licence provider, or the builder's own firm | Each part is covered by a verified licence. A builder without licences asks a licence provider to sponsor the product |
| Review | A Mynt admin | Reviews firms and their licences, with a governance desk of review agents that prepares each case |
| Promote | The builder | Moves the product through idea, staging and production. Mynt checks the regime at each step |
| Build | A team of coding agents | Plans the app, then builds `api/`, `web/` and `mobile/` as one Docker Compose project, on SDKs generated for exactly those products |
| Verify | Mynt | Runs its own checks in a clean sandbox the agents never touched, and only then opens the pull request |
| Host | Mynt | Gives the app a VM of its own, with containers under gVisor, outbound access only to the hosts it needs, and a public HTTPS address for each service. The app's key is added at the edge |
| Go live | The builder | Promotes the app through staging to production. Production needs a signed program agreement with every sponsoring licence provider |
| Use | A customer | Uses the app on the web, on a phone or in a chat |

**What the builder types.** In the MCP client they already use, or in Mynt Studio:

> Build a savings app on the recurring deposit, with a web app and an Expo mobile app.

**What the agents do.** The coding team has seven agents: an architect plans; server, web and mobile engineers build their parts; a read-only compliance reviewer checks every product's contract and build terms (documents shown word for word, consent before the action that needs it, no banned phrase, no open proxy to Mynt); QA runs every journey against the sandbox; a release engineer ships the Compose project.

While the agents work, the builder can open the sandbox in VS Code, run commands in it and watch the diff grow. Once the app is hosted, they can read its logs, run commands in it and SSH into its VM. Mynt hands back only when it must: connecting a repository, an approval, a credential.

**What a customer sees.** A customer says what they need and gets a product card back. This illustration is on a US product, the Dollar Holding Account that ships as an example definition:

```text
You:   I want to keep $500 in a dollar account that I can cash out any time.
App:   Got it. Should it come from your linked bank account?
You:   Yes.
App:   DOLLAR HOLDING ACCOUNT · READY
       Add $500.00 from your bank account
       [ Accept ]  [ Look for more options ]
```

Customers see US dollars only. The United States is the only region products run in today.

**The agents.** The hosted agents are steered by eight agent workspace folders under `core/workspaces/`:

| Folder | The agent |
|---|---|
| `coding-build` | The coding team that builds apps |
| `build-audit` | The optional independent security audit of a build |
| `product-desk` | The product desk: term sheets and feasibility analysis in a firm's own model repository |
| `algorithm-explorer` | The product desk's algorithm explorations |
| `governance-review` | The governance desk, which reviews firms, licences and products for Mynt admins |
| `connector` | The business-development agent |
| `program-audit` | The white-box audit of a Solana program before mainnet |
| `program-red-team` | The black-box red team of a Solana program before mainnet |

## What a developer ships

```text
my-app/
├── compose.yaml          api + web (+ mobile web export), hardened: read-only, no capabilities, no host network
├── .env.example          the app key and webhook secret, for api/ only
├── api/                  server: sessions, contracts, webhooks, server-side actions
├── web/                  web app: the journey runner, secure inputs, hosted flows
├── mobile/               Expo app (or Kotlin / Swift / Flutter), same journeys on a client session
├── solana/               optional: an Anchor program (smart contract) and its tests
└── packages/mynt-sdk/    the generated SDK
```

SDKs are generated for TypeScript, React Native, Kotlin, Swift, Flutter and Python.

**Solana programs.** When an app needs a program on Solana, the agents write it next to the app and Mynt takes it from there. It rebuilds the program itself with Anchor's verifiable build in a clean sandbox, tests it on a local validator, deploys exactly those bytes, upgrades it from later verified builds, and sends the program's events to the firm's webhooks.

Mynt signs on devnet. Mainnet stays off until a Mynt admin configures its signer (a key in Mynt's vault, a key-custody service, or a multisig), and every mainnet deploy passes the mainnet program gate first. Customers never see any of it: they see dollars. See [Solana programs](docs/reference/solana-programs.md).

## Who Mynt is for

Mynt covers eleven product lines, grouped by economic function: credit, securitization, payments, account operations, custody and settlement, wealth, insurance, guarantees and trade, exchange, derivatives and information.

There are six kinds of user. A **builder** is one role with two names in code, `developer` and `innovator`; these docs say builder.

| Who | What Mynt gives them |
|---|---|
| **Consumers** | Products and offers they can use, and a way to ask for what doesn't exist yet |
| **Builders** | Composition of products from regulated primitives, term sheets and feasibility analysis in their own model repository, versioning, licence checks and distribution. And apps on top of products: SDKs, APIs, webhooks, a sandbox mode, campaigns, and coding agents that build apps, which Mynt verifies and hosts. Builders needn't be licensed |
| **Licence providers** | Firms holding the licences. They sponsor builders' products under them, in the jurisdictions they cover, set covenants on them, and can revoke a sponsorship. Their engineers connect their ledger with the [partner kit](docs/partners.md) |
| **Vendors** | A marketplace for standard services (identity, KYC, account data, bureau, e-signature and others) that builders plug into their products, tested by Mynt before they are listed |
| **Liquidity providers** | Firms and funds that put capital into products' pools. They get a withdrawal queue with stated notice and reserve rules, and health readings for each product. Mynt never holds funds |
| **Mynt admins** | The regulatory model (regulators, licences, law, GRC), a governance desk that reviews firms, licences and products, the platform admin in Mynt Studio, and `ops_status` for what needs attention |

What each role can do, and how the roles nest, is in [Roles and tools](docs/reference/roles-and-tools.md).

## Ground rules Mynt enforces for you

- **Secrets by name only.** Keys live in the server's environment, are never printed, and never enter a sandbox, a hosted app or a pull request.
- **Keys stay out of reach.** An app's key lives only on a server Mynt hosts, and even there it is added on the way out, never stored on the VM. Web and mobile apps run on short-lived client sessions.
- **Products follow their contracts.** Only the actions a product lists, where they may run; every required document shown word for word; consent before the action that needs it.
- **Agents never grade their own work.** Verification runs in a clean sandbox, and only its result decides whether a build ships.
- **No open proxy to Mynt.** On Mynt's hosting, anything an app sends to Mynt's server-side routes carries its key, so apps forward only client-session routes.
- **Customer data in one vault.** It is encrypted (AES-256-GCM), collected only after consent, erasable on request, and never in the app's own database or logs.
- **Isolated by default.** Each hosted app has a VM of its own, its containers run under gVisor, and it can reach only the hosts it needs.
- **Dollars only for customers.** A builder's customers see and send US dollars: amounts, fees, totals, statuses, arrival times and references. Wallets, tokens, chain names, addresses and stablecoin symbols never reach an app. The USDC on Solana underneath is the licensed ramp partner's settlement rail, and Mynt refuses any service type that would show a device otherwise.
- **Money moves only on approved rails.** Every movement passes one check before it is recorded. Mynt authorises and records movements; licensed firms move the money. See [Money rails](docs/reference/money-rails.md).
- **Nothing is guessed.** A cost that can't be measured is never shown as $0.

## How Mynt earns

Mynt's model is a take rate on each product, with no fixed percentage per product line. A Mynt admin sets a rate per line with `define_take_rate`: a base percentage plus a percentage per workload point, between a floor and a cap, applied to a stated basis (such as revenue or volume).

A product's workload comes from its composition: 1 point per regulated primitive, plus a tenth of the average obligations, filings and controls carried by the licences that may provide it, plus 1 point if the product services it. More regulation and more ongoing operations carry a proportionally higher rate. Simpler products carry less.

Mynt has no billing yet. Rates can be set and read (`get_product_take_rate`), but nothing is charged, and a workspace's profit and loss shows Mynt's fees as $0 for that reason.

## Works with the MCP client you already have

Mynt is an [MCP](https://modelcontextprotocol.io) server; clients show it as `mynt`. Any MCP client can use it, so you are never tied to one tool. Claude Code is the reference client.

Two apps in this repository are built on the server:

- **Mynt Studio** (`platform/studio`) is the web app. A builder describes an app or a financial product on the Build page, chats with the coding agent beside the app's live preview, and puts a verified build online. Each product has its own workspace. Licences holds agreements with licence providers, Marketplace lists vendors' standard services, and Mynt admins have a platform admin. See [Mynt Studio](docs/reference/studio.md). It is built on the open-source Adorable.
- **The sample chat** (`platform/chat`) is a sample of an app of your own: a mobile-friendly chat for customers, and a developer console for builds, sandboxes and hosting.

Every Mynt server also answers these without sign-in:

| Address | What it is |
|---|---|
| `/llms.txt` (also `/.well-known/llms.txt`) | A short guide for AI assistants in the [llms.txt](https://llmstxt.org) format: what Mynt is, its MCP endpoint, how to sign in, the roles and the first tools each one should call |
| `/llms-full.txt` | Every tool each role gets, with its inputs, generated from the server's live tool registry, plus the runtime API and the vendor contract |

Mynt Studio serves the same reference for people at `/docs`, without sign-in: every tool by area with its roles, inputs and an example call, beside guides drawn from these docs.

## Read next

| You want to | Read |
|---|---|
| Get early access | [Open an access request](https://github.com/never2average/mynt/issues/new?title=Early%20access%20request) |
| Run Mynt yourself | [Install and build](docs/reference/operations.md#install-and-build) |
| Find the right doc for your role | [The docs map](docs/README.md) and the [reference index](docs/reference.md) |
| Compose a product or build an app | [Products](docs/reference/products.md), [Apps and builds](docs/reference/apps-and-builds.md) |
| Use Mynt Studio | [Mynt Studio](docs/reference/studio.md) |
| Sponsor products as a licence provider | [Firms, licences and licence providers](docs/reference/licence-providers.md), [the partner kit](docs/partners.md) |
| See the whole flow as a licence provider | [The partner walkthrough](docs/demo.md) |
| Understand how the parts fit together | [Architecture](docs/architecture.md) |
| Change this repository with a coding agent | [AGENTS.md](AGENTS.md) |

## Disclaimer

A new deployment starts empty. Products come from builders, or from the reference catalogue a Mynt admin publishes. Product information is for informational purposes, contains no live rates and is not financial advice; rules (tax treatment, limits, lock-ins) change, so verify with the relevant regulator or provider. Enrolments here are records in this server's database, not real accounts.

## License

MIT
