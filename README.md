<div align="center">

# Mynt

### Lovable for finance apps. Regulated products, composed. The apps on top, built by agents and verified by Mynt.

Describe the finance app you want. Mynt composes the regulated product underneath it, works out the regulation, builds the app with a team of coding agents, verifies every line in a sandbox the agents never touched, and hosts it on a VM of its own.

**Products are compositions, not one-offs · Regulation is computed, not remembered · Agents build, Mynt verifies · Keys never touch a developer's machine · MIT licensed**

[Get early access](https://github.com/never2average/mynt/issues/new?title=Early%20access%20request) · [Run it yourself](docs/reference.md#install--build) · [Read the reference](docs/reference.md)

</div>

---

## The problem Mynt removes

Shipping a finance app today means a year of work before the first customer sees a screen. Which licence covers the product? Which regulator, which filings, which disclosures? Who integrates KYC, e-sign, bureau and bank data, again? And once the app exists, who proves it shows every mandated document word for word and never leaks a key?

Mynt answers all of that from one place. A licensed firm composes a product out of regulated building blocks. Mynt computes the regulation that follows. A developer asks for an app in plain words, and a verified, hosted app comes back.

## Two ideas behind everything

### 1. A financial product is a composition

Nobody designs a financial product from scratch on Mynt. You compose one from regulated building blocks called **primitives**. Each primitive is a line of business (credit, payments, insurance, …) joined to an action on it (issuance, sale, servicing, …):

- a recurring deposit is a recurring payment mandate plus a term deposit;
- a foreign-currency transfer is a currency exchange plus a payment.

Because the product is made of primitives, its regulatory regime follows from them: which regulators supervise it, which licences may provide each part, and which obligations, filings and controls apply. Mynt works all of this out from its regulatory model, so nobody has to remember it, and then checks the product's legal entity, its parties and their GRC folders against the result.

Changing a product means re-composing it, not rebuilding it. Add a part, change who provides it or tighten a term, and the new definition is checked against the regime before it goes live.

### 2. Agents build; Mynt verifies

Agents do the work on Mynt: designing, pricing, building, reviewing, prospecting. Not one of them grades its own work.

- **Every build is verified in a clean sandbox the agent never touched.** Tests, lint and types, a secrets scan, a dependency audit, an SBOM, every required disclosure, and an independent security audit all run before a pull request is opened.
- **Agents are steered by folders, not by prompts in code.** Each agent's instructions, skills and scripts live in `workspaces/<agent>/`, which becomes its working directory. Its skills are human-written ones found on GitHub and vendored with their licence and source.
- **Secrets never enter a sandbox or a hosted app.** Agents reach the model through Mynt's proxy with a token that dies with the run. A hosted app sends a placeholder, and the real key is added on the way out.
- **Every cost is counted.** Sandboxes, model spend and hosting are billed from metered records against per-build and monthly caps. A figure that can't be measured is never shown as $0.

## What it feels like

A developer types, in the MCP client they already use:

> Build a savings app on the recurring deposit, with a web app and an Expo mobile app.

Mynt takes it from there:

- **Plans.** An architect agent picks the products, actions and journeys, and decides which parts the app needs.
- **Builds.** `api/`, `web/` and `mobile/` arrive as one Docker Compose project, on SDKs generated for exactly those products (TypeScript, React Native, Kotlin, Swift, Flutter and Python).
- **Reviews.** Every product's contract and build terms are enforced: documents shown word for word, consent before the action that needs it, no banned phrase, no open proxy to Mynt.
- **Verifies.** A clean sandbox re-runs everything, and only then does the pull request open.
- **Hosts.** The app gets a VM of its own, egress only to the hosts it needs, containers under gVisor, and a public HTTPS address for each service.
- **Hands back only when it must.** Connecting a repository, an approval, a credential.

While the agents work, the developer can open the sandbox in VS Code, run commands in it and watch the diff grow. Once the app is hosted, they can read its logs, run commands in it and SSH into its VM.

A licensed firm uses the same platform to **compose** a product, **price** and **test** it in its own model repository, **see** exactly which licences and obligations it carries, and **publish** it to developers. A customer simply says what they need and gets a product card back:

```
You:   I want to put ₹5,000 aside every month for the next two years.
Mynt:  Got it. Should it come out of your account on payday?
You:   Yes, the 1st works.
Mynt:  ┌─────────────────────────────────────────────┐
       │ TWO-YEAR RECURRING DEPOSIT · READY          │
       │ ₹5,000 / month · 24 months · partner bank   │
       │ [ Accept ]  [ Look for more options ]       │
       └─────────────────────────────────────────────┘
```

## Why Mynt is different

| | |
|---|---|
| **Composed, not hand-built** | A product is a definition over regulated primitives, so it stays small, reviewable and checkable against its regime. |
| **Regulation is computed** | Regulators, licences, law and GRC registers are data. A product's regime, and what its entity holds or is missing, follow from its composition. |
| **Agents never grade their own work** | A build ships only when Mynt's own checks pass in a sandbox the agent never touched. A failed check blocks the pull request. |
| **Keys stay out of reach** | The app key lives only in a server Mynt hosts, and even there it's added on the way out, never stored on the VM. Web and mobile apps run on short-lived client sessions. |
| **Customer data in one vault** | Encrypted (AES-256-GCM), collected only after consent, erasable on request, and never in the app's own database or logs. |
| **Isolated by default** | Each hosted app has its own Firecracker microVM, its containers run under gVisor, and it can reach only the hosts it needs. |

## Measured, not promised

- **The live regulatory model holds 62 regulators, about 766 licence types, 712 product types and about 2,030 items of law.**
- **A hosted app's VM boots in about a second,** and a two-service Compose app was built and started in 16 seconds, measured on Freestyle.
- **Every push builds and runs the starter app.** CI scaffolds it from a freshly generated SDK, compiles `api/`, `web/` and the Expo app, builds the three images and runs them hardened (read-only, no capabilities) before checking that they serve.

## How it works, end to end

```
 idea ──► compose ──► review ──► publish ──► build ──► verify ──► host ──► customers
 innovator  primitives,  admins:    offered to    agent team    clean sandbox,  own VM,     web, mobile,
            pricing,     firm,      developers    in a sandbox, independent     gVisor,     chat
            feasibility  licences,                SDKs          audit           key at the
                         product                                  ▲             edge
                                                                  └── a failed check blocks the pull request
```

- **Primitives** are the regulated building blocks: a line of business and an action on it.
- **Products** are compositions of primitives, versioned, each with a definition, a developer contract and build terms.
- **Workspaces** (`workspaces/<agent>/`) steer the hosted agents: the coding team, the product desk and its algorithm explorers, the governance desk and the business-development agent.

## What a developer ships

```
my-app/
├── compose.yaml          api + web (+ mobile web export), hardened: read-only, no capabilities, no host network
├── .env.example          the app key and webhook secret, for api/ only
├── api/                  server: sessions, contracts, webhooks, server-side actions
├── web/                  web app: the journey runner, secure inputs, hosted flows
├── mobile/               Expo app (or Kotlin / Swift / Flutter), same journeys on a client session
└── packages/mynt-sdk/    the generated SDK
```

Behind it is a whole coding team. An **architect** plans. **Server**, **web** and **mobile engineers** build their parts. A read-only **compliance reviewer** checks every product's contract and build terms. **QA** runs every journey against the sandbox. A **release engineer** ships the Compose project.

## Works with the MCP client you already have

Mynt is an [MCP](https://modelcontextprotocol.io) server; clients show it as `mynt`. Any MCP client can use it, so you're never tied to one tool. Claude Code is the reference client. `examples/mynt-chat` is a sample of your own: a mobile-friendly chat for customers, and a developer console for builds, sandboxes and hosting.

## Ground rules Mynt enforces for you

- **Secrets by name only.** Keys live in the server's environment, are never printed, and never enter a sandbox, a hosted app or a pull request.
- **Products follow their contracts.** Only the actions a product lists, where they may run; every required document shown word for word; consent before the action that needs it.
- **Agents never grade their own work.** Verification runs in a clean sandbox, and only its result decides whether a build ships.
- **No open proxy to Mynt.** On Mynt's hosting, anything an app sends to Mynt's server-side routes carries its key, so apps forward only client-session routes.
- **Nothing is guessed.** A cost that can't be measured is never shown as $0. Freestyle machine time counts the larger of Freestyle's own figure and wall-clock time.

## A compliance loop that gets better with every product

Every product gets its own compliance workspace, linking the regulations to:

- the business functions and people responsible, and what each must do;
- the policies and controls that do it;
- the metrics and evidence that prove it;
- the disclosures and reports that go back to the regulator.

Each new product, review and inspection sharpens the loop. Everything carries an audit trail, version history, reporting and connectors to external data.

## How Mynt earns

A take rate on every product sold, with no fixed percentage per line. Admins set a rate per line in proportion to each product's compliance and back-office workload: a base percentage plus a percentage per workload point, between a floor and a cap, applied to a stated basis (such as revenue or volume).

A product's workload comes straight from its composition: 1 point per regulated primitive, plus a tenth of the average obligations, filings and controls carried by the licences that may provide it, plus 1 point if the product services it. More regulation and more ongoing operations pay proportionally more. Simpler products pay less.

## Who Mynt is for

Mynt's platform ships as an MCP server covering eleven lines, grouped by economic function: **credit, securitization, payments, account operations, custody and settlement, wealth, insurance, guarantees and trade, exchange, derivatives and information**.

| Who | What Mynt gives them |
| --- | --- |
| **Consumers** | Products and offers they can actually use, and a way to ask for what doesn't exist yet |
| **Innovators** (licensed firms) | A product foundry: composition from regulated primitives, term sheets and feasibility analysis in their own model repository, versioning, licensing checks and distribution |
| **Developers** | Apps on top of products: SDKs, APIs, webhooks, a sandbox, GTM campaigns, and coding agents that build, verify and host them |
| **Vendors** | A marketplace for standard services (identity, KYC, account data, bureau, e-sign, e-mandate) that innovators plug into their products, tested by Mynt before they're listed |
| **Admins** | The regulatory model (regulators, licences, law, GRC), a governance desk that reviews firms, licences and products, and `ops_status` for what needs attention |

**Get early access:** [open an access request](https://github.com/never2average/mynt/issues/new?title=Early%20access%20request) · **Run it yourself:** [Install & build](docs/reference.md#install--build) · **Technical reference:** [`docs/reference.md`](docs/reference.md) · **Architecture:** [`docs/architecture.md`](docs/architecture.md) · **Rules for coding agents:** [`AGENTS.md`](AGENTS.md)

## Disclaimer

Mynt ships no catalogue: every product comes from an innovator. Product information is for informational purposes, contains no live rates and is not financial advice; rules (tax treatment, limits, lock-ins) change, so verify with the relevant regulator or provider. Enrollments here are records in this server's database, not real accounts.

## License

MIT
