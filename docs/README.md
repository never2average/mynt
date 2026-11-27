# Mynt documentation

This is a map of the `docs/` folder: which file to read for what. What Mynt is, and who it is for, is in the repository's [README](../README.md).

## By reader

| You are | Start with | Then |
|---|---|---|
| New to Mynt | [README](../README.md) | [Roles and tools](reference/roles-and-tools.md) |
| A builder making products and apps | [Products](reference/products.md) | [Apps and builds](reference/apps-and-builds.md), [Runtime API](reference/runtime-api.md), [Mynt Studio](reference/studio.md) |
| A licence provider | [Firms, licences and licence providers](reference/licence-providers.md) | [Agreements](reference/agreements.md), [Money rails](reference/money-rails.md) |
| A licence provider's engineer | [Connecting a licence provider to Mynt](partners.md) | [Confidential computing](reference/confidential-computing.md) |
| A vendor | [Vendors and the marketplace](reference/vendors-and-marketplace.md) | [Services](reference/services.md), [Agreements](reference/agreements.md) |
| A liquidity provider | [Liquidity pools and on-chain treasuries](reference/liquidity-and-treasury.md) | [Product health](reference/licence-providers.md#product-health) |
| A Mynt admin | [Platform administration](reference/platform-admin.md) | [Risk](reference/risk.md), [Solana programs](reference/solana-programs.md#mainnet-program-gate) |
| An operator running a server | [Running Mynt](reference/operations.md) | [Mynt's architecture](architecture.md) |
| An engineer or coding agent changing Mynt | [AGENTS.md](../AGENTS.md) | [Mynt's architecture](architecture.md), then the reference file for the area |
| Presenting Mynt to a licence provider | [The partner walkthrough](demo.md) | [Connecting a licence provider to Mynt](partners.md) |

The [reference index](reference.md) has a longer reading order for each role and a table of where every section of the old single-file reference went.

## Files

| File | What it is |
|---|---|
| [reference.md](reference.md) | The index to the technical reference: reading order by role, the 16 reference files, and the words the docs use |
| [reference/](reference/) | The technical reference, one file per area |
| [architecture.md](architecture.md) | How the parts fit together: the front door, roles, the domain core, agents, hosting, money, the chain, data and background work |
| [partners.md](partners.md) | The licence provider's engineering guide: the ledger feed, the daily file, conformance and going live |
| [demo.md](demo.md) | The partner walkthrough: a script that shows a licence provider the whole flow on a laptop |
| [turnkey-solana-policy.json](turnkey-solana-policy.json) | The Turnkey policy for the mainnet deploy authority, as [Turnkey custody](reference/solana-programs.md#turnkey-custody) quotes it. A test reads it at this path |
| [site/](site/) | The docs site's data: `manifest.json` (which headings make which page) and the generated `pages.json` and `tools.json` |
| [plans/](plans/) | Working papers: plans |
| [research/](research/) | Working papers: research |

### The reference files

| File | What it covers |
|---|---|
| [roles-and-tools.md](reference/roles-and-tools.md) | The seven roles and their tools |
| [products.md](reference/products.md) | Composing, defining, staging and archiving products |
| [apps-and-builds.md](reference/apps-and-builds.md) | Apps, coding-agent builds, repositories and hosting |
| [runtime-api.md](reference/runtime-api.md) | What an app calls at run time |
| [workspaces-and-sign-in.md](reference/workspaces-and-sign-in.md) | Workspaces, promotion, the audit trail and who may sign in |
| [vendors-and-marketplace.md](reference/vendors-and-marketplace.md) | Standard services, the marketplace and the Mynt Ramp |
| [services.md](reference/services.md) | Services: the third kind built on Mynt, beside apps and financial products |
| [platform-admin.md](reference/platform-admin.md) | What a Mynt admin does |
| [licence-providers.md](reference/licence-providers.md) | Firms, sponsorship, covenants, the partner kit and product health |
| [agreements.md](reference/agreements.md) | Agreements between apps and firms |
| [risk.md](reference/risk.md) | Risk registers and risk models |
| [money-rails.md](reference/money-rails.md) | How money is allowed to move |
| [liquidity-and-treasury.md](reference/liquidity-and-treasury.md) | Pools, the withdrawal queue and on-chain treasuries |
| [solana-programs.md](reference/solana-programs.md) | On-chain programs, the mainnet gate and custody |
| [confidential-computing.md](reference/confidential-computing.md) | The confidential service |
| [operations.md](reference/operations.md) | Running a Mynt server |
| [studio.md](reference/studio.md) | Mynt Studio, page by page |

### The docs site

Mynt Studio serves these docs at `/docs`. The site is built from this folder's Markdown and from the server's own tool list:

1. `site/manifest.json` names, for each page, the files and headings it is made of.
2. `cd core && npm run build && npm run docs-data` writes `site/pages.json` and `site/tools.json`.
3. Both generated files are committed. `core/test/tool-catalogue.test.js` fails when they are stale.

A heading named in the manifest must match the Markdown heading exactly, so renaming a heading here means updating the manifest and regenerating.

## Plans and research

The files in `plans/` and `research/` are working papers, not product documentation. They record what was planned or looked into at a point in time. They may describe things that were never built, were built differently, or are not in scope, and they are not kept in step with the code. For what Mynt does today, read the reference.

| File | What it is | Status |
|---|---|---|
| [plans/crypto-liquidity.md](plans/crypto-liquidity.md) | The plan for stablecoin ramps, liquidity pools and on-chain programs | A plan. Its status line says what has been built since and links to the reference for each part |
| [research/licence-gaps.md](research/licence-gaps.md) | Research on five Indian licence types | Research input. Not entered in the regulatory model and not launch scope: Mynt launches in the US only |
| [research/us-ramp-partners.md](research/us-ramp-partners.md) | Research on US ramp partners for the Mynt Ramp | Research gathered on 2026-11-07, with its own note on how far to trust it |
