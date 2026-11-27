# Mynt Studio

This file is for anyone using Mynt Studio: builders, licence providers, vendors, liquidity providers and Mynt admins. It describes what each page shows, its tabs and its actions.

Mynt Studio is a web app on top of Mynt's MCP (Model Context Protocol) server. You sign in with your own Mynt account, and everything Studio does goes through Mynt as you: Mynt checks every call against your roles. How Studio is built and run is in [its README](../../platform/studio/README.md).

Two rules hold on every page:

- **Tabs show, actions change.** A tab only shows information. Anything that changes state (promoting, inviting, signing, archiving) is a labelled button that opens a sheet.
- **Nothing unmeasured is shown as 0.** A figure Mynt doesn't measure reads "Not measured", and a part whose tool this Mynt lacks says it isn't available yet, with the reason.

## Sidebar

Every Studio page has a left sidebar, collapsible to icons. From top to bottom it holds:

1. **The workspace switcher.** Your workspaces, then **Create workspace**.
2. **The fixed pages**, in this order: Dashboard, Licences, Marketplace, Audits, Settings. Then **Earn**, for builders and liquidity providers, **My services**, for vendors, and **My firm**, for licence providers.
3. **Apps and products.** The selected workspace's apps and your own financial products, in three folders by stage: Production, Staging and Ideas.
4. **Platform admin**, for Mynt admins only.
5. **Your account.** Your avatar, name and email, and Log out.

Everything is scoped to the selected workspace, which is remembered in a cookie. The cookie is not a credential: Mynt checks membership on every call.

### Who sees what

| Your roles | What the sidebar shows |
|---|---|
| Builder | Everything above except My services, My firm and Platform admin |
| Licence provider, without the builder role | Dashboard, Licences and My firm. Licences and My firm open |
| Liquidity provider, without the builder role | Dashboard (the investor view) and Earn |
| Vendor | My services is added |
| Mynt admin | Platform admin is added |

The sidebar always lists Dashboard, but a page opens only for a role that can use it. Without the builder role:

- a licence provider opens Licences and My firm;
- a liquidity provider opens the Dashboard's investor view and Earn;
- a vendor opens My services.

Every other page, the Dashboard included for a licence provider or a vendor who is not also a liquidity provider, shows one message: "Mynt Studio is for developers. Ask a Mynt admin for the developer role." For a vendor the message carries an **Open My services** button, and for a licence provider an **Open My firm** button. Someone with none of these roles gets that message on every page. Studio labels builders "developers" here, and vendors "service providers" on Marketplace and My services.

A builder with no workspace on Mynt yet is asked to **Create your workspace** first. Earn still opens.

Roles come from Mynt's `whoami` and are read again every five minutes, so a role that was revoked takes effect without signing out.

### The workspace switcher

The switcher picks the workspace that the dashboard, the folders and Settings show. Its menu also holds:

- **Rename workspace**, for owners and admins of the workspace;
- **Archive workspace** and **Unarchive workspace**, for owners (an archive can be undone for 7 days);
- **Give it a new organization**, for owners of a workspace whose organization was deleted;
- **Invitations (N)**, when you have pending invitations;
- **Create workspace**.

Each opens a sheet or a dialog. The rules behind them are in [Workspaces and sign-in](workspaces-and-sign-in.md#workspaces).

### Invitations

Joining a workspace is always explicit, never automatic. Pending invitations show as a banner on the dashboard and as **Invitations (N)** in the switcher's menu. Each one names the workspace, who invited you, the role, and what accepting grants on Mynt, with **Accept** and **Decline**. After accepting, Studio switches to the joined workspace.

### The stage folders

The three folders hold apps and financial products together, because both move through the same stages. Each item says which it is: an icon, and "App" or "Financial product" to screen readers.

- Exactly one folder is open at a time. Opening one closes the others, and the open one can't be closed.
- It starts at the stage of the app or product on screen, else the folder last picked (remembered in this browser), else Production.
- Collapsed, the sidebar shows the three folder icons with the open one marked. Clicking one picks it and expands the sidebar.

A product chat that hasn't made a product yet has no stage, so it isn't in the folders. Mynt keeps the chat, and it reopens at `/new?thread=<id>`. Studio has no list of these chats, so nothing in Studio links to that address.

An app or product moves between folders only through Mynt's checks, never by dragging it. See [Stages and promotion](workspaces-and-sign-in.md#stages-and-promotion) for apps and [Product stages](products.md#product-stages) for products.

### The page header

On every page outside an app or a product, a sticky header shows the page's name and, at the right, in this order:

| Control | What it does |
|---|---|
| **Search...** | Opens search (also Cmd+K or Ctrl+K). See [Docs and search](#docs-and-search) |
| The GitHub control | Your linked GitHub username, or **Link GitHub** |
| The wallet control | Your linked wallet, or **Link wallet** |
| **Build** | Opens the Build page |
| **Docs** | Opens the docs |
| The theme switcher | Light, Dark or System |

The GitHub control, the wallet control and Build are shown to builders only.

**The GitHub control.** Clicking your username opens a menu: up to five connected repositories with their approval in words (Approved, Waiting for an admin, Rejected), **View all** (Settings, Repositories), **Connect repository** and **Manage linked accounts**.

**The wallet control.** A linked wallet shows the wallet app's own icon and name once a browser wallet has connected it, else a wallet icon and the short address. Its menu names the network once, shows the full address with **Copy address**, offers **Connect wallet** while the wallet app isn't known, links to Earn for your roles (**Manage pools** for builders, **Provide liquidity** for liquidity providers), and **Manage linked accounts**.

The network is shown only when the address fits it; anything else says "Unknown network". Linking itself happens on the identity provider's account page; Studio never embeds a sign-in.

### Signing in and out

A visit to any page while signed out goes straight to Mynt's sign-in and comes back to that page. The only pages that don't need sign-in are the docs (`/docs` and `/connect`), where a failed sign-in lands (`/signin-error`) and where signing out lands (`/signed-out`, with **Sign in again**).

## Dashboard

The home page (`/`) has two views. A builder sees the builder view. A liquidity provider sees the investor view. Someone with both roles picks one from the header's breadcrumb ("Dashboard / Builder"); the choice is remembered in this browser.

### The builder view

| Part | What it shows |
|---|---|
| Needs attention | A strip at the top: what needs you, most severe first, each with a severity, a title, a detail and a link to the Studio page that fixes it. With nothing to show, the strip isn't shown |
| Key figures | Money moved, Build spend, Hosting and Apps live, each with its change on the last period, then Average build cost and Average build time |
| Money moved and Costs | Two charts, one above the other, under one toolbar row: a search of apps by name, App, App stage and Date range. The toolbar narrows the charts only |
| Recent activity | The newest entries of the workspace's audit trail, linking to Audits |

Money moved is the gross of settled live movements through your apps. It is not earnings, which Mynt doesn't measure yet. A period Mynt has no figure for is a gap in the chart, never 0.

With no apps yet, the page says so and points to Build. Where the figures come from is in [Profit and loss](workspaces-and-sign-in.md#profit-and-loss) and [Attention](workspaces-and-sign-in.md#attention).

### The investor view

For liquidity providers, in the same style:

| Part | What it shows |
|---|---|
| Needs attention | Only the items about investing (pools, positions, deposits, withdrawals, the treasury), and only when there are any |
| Key figures | Committed, Settled, Pending in, Available to withdraw, Queued for withdrawal, Paid out, Pools held and Returns. Committed and Paid out carry their history. Returns is the wind-down surplus claimed on chain; pools on rails pay none. With both sources, a line under the figures splits them into Devnet and Rails |
| Toolbar | A search of pools by name, Pool, Source (Devnet or Rails) and Date range (the last six months to start). It narrows the two charts only |
| Capital in | A chart of on-chain deposits by when they settled |
| Paid out | A chart, under Capital in, of withdrawal requests' paid amounts by when they became payable |
| Recent financial activity | The ten newest entries of the financial class of the audit trail (when, kind, summary, status). **View all** opens `/audits?tab=financial` |

Positions, pools, withdrawals and wallets in detail are on [Earn](#earn). A builder also has the wallet control in the page header.

A figure Mynt can't measure is a gap, never 0. Positions on rails carry no dated history, so with only those every period of both charts is a gap.

## Build

Build is the `/new` page and the **Build** button in every header. It has two modes, switched by a toggle in the composer: **App** and **Financial product**.

### Building an app

1. Describe what you want to build in the composer.
2. Pick the products it builds on, from the composer's Products picker or the **Products** tab. Both share one selection.
3. Send. Studio creates the app on the picked products in the selected workspace, starts its first build with your message as the goal, and opens the app's workspace on that build.

The first build runs on Mynt's own spend cap; Studio has no cap control. Until the message can be sent, the reason is the disabled Send button's tooltip. The same request sent twice creates one app.

The right side has two tabs:

| Tab | What it shows |
|---|---|
| **Templates** | App ideas for each of Mynt's app kinds. **Use** fills the composer and picks the idea's products. An idea with no published product to build on says so |
| **Products** | The products you may build on, and your own products with their stage |

A few ideas also show as chips under the composer. How app kinds and ideas work is in [Kinds and ideas on the Build page](apps-and-builds.md#kinds-and-ideas-on-the-build-page).

### The Products tab

Each product shows a flag for each country it is offered in and its stage (Idea, Staging or Production). A product can be picked for an app once it is in Staging (for sandbox builds) or Production.

On your own products, the row has the labelled actions for its stage:

| Action | What it does |
|---|---|
| **Create product** | Opens one sheet with the product's fields. The new product is listed as an Idea |
| **Move to staging**, **Move to production** | Opens the approval sheet with Mynt's checks for the next stage |
| **Move back** | Moves the product to an earlier stage |
| **Archive**, **Unarchive** | Opens the archive sheet. The **Archived** filter lists your archived products |

Mynt's refusals, such as a licence or sponsorship that is needed, are shown in Mynt's words.

### Creating a financial product by chatting

In Financial product mode the chat is an assistant that drafts a product with you:

- It asks for what is missing, choosing only from Mynt's regions, regulators, categories and published products.
- Its draft shows in the chat as a card. **Review and create** opens the Create product sheet filled with the draft, every field editable. Confirming creates the product once.
- The Templates tab and the chips show product ideas here. A chip starts the chat with the idea; a row's **Use** opens the sheet filled with it.

`/create-product` in the composer switches to this mode, and `/build-app` switches back. `/create-product <description>` sent from App mode goes there with its description. A message in App mode that clearly asks for a product only offers **Create product instead**: what is sent in App mode is always a build.

A product created here opens its own [product workspace](#the-product-workspace). Product chats are kept on Mynt for you, so they reopen in any browser you sign in from. See [Product ideas on the Build page](products.md#product-ideas-on-the-build-page).

### Builds

`/builds` lists every coding-agent build across your apps, newest first: key figures, then a table with search, filters for app and status, a date range and **Export CSV**. Cost and time are shown as measured, or "Not measured" with Mynt's reason. The page isn't in the sidebar; search finds it.

## The app workspace

Opening an app (`/<app id>`) shows the chat with Mynt's coding agent on the left and the app's tabs on the right. On a phone one side shows at a time.

### The chat

- A message steers the app's running build, or starts a new build with the message as its goal.
- The reply streams what the agent does: its words as it writes them, its commands and file edits as cards, and its reasoning as a collapsible block.
- While a session build is open, the composer has **Ship**, which finishes the build so Mynt can verify it.
- A message sent while the build is being verified is held ("Queued — sent when verification finishes.") and sent afterwards. It can be removed while it waits.
- Opening a past build rebuilds its conversation: its goal, the messages steered into it, its activity and how it ended.
- Only one build starts at a time per app, whoever starts it.

Typing `/` in the composer lists commands: one per tab (`/preview`, `/products`, `/agreements`, `/customers`, `/security`, `/pnl`, `/sdk`, `/activity`), `/risk` (the risk register, on Security & risk), `/ship`, `/fix` and `/add`.

How builds work is in [Coding-agent builds](apps-and-builds.md#coding-agent-builds).

### The app's tabs

Each tab is read live from Mynt for this app only: when it is opened, when the page comes back into view, and every 30 seconds while it is visible. It shows when it was last read and has **Refresh**.

| Tab | What it shows |
|---|---|
| **Preview** | The app running: a build's live preview while it is being coded, else the preview Mynt made when it verified the build |
| **Products** | The products this app uses, each with its stage and the licence providers sponsoring it, by state. An app holds no licences of its own; its products do |
| **Agreements** | The program agreements Production needs, the app's agreements with firms, and its vendor contracts, with **Propose agreement** for owners and admins |
| **Customers** | The customer personas this app targets, from its products, and introductions in progress |
| **Security & risk** | The app's risk register (**Add risk**, **Review risk**; each risk with its inherent, control and residual scores, and a row opening [the risk's detail](risk.md#a-risks-detail)), Mynt's build checks and security events, and the signals Mynt measures around the app: fraud, its vendors, conduct and its products |
| **P&L** | Money moved and costs for this app, with the statement |
| **SDK** | Each product's integration kit: action, access, permitted actions, fields, contract and hand-off |
| **Activity** | The app's builds and its audit events |

There is no Licences tab on an app. Licence coverage is on each product's Compliance tab, and agreements are on the app's Agreements tab and the [Licences](#licences) page.

What the Agreements tab holds is described in [The app's Agreements tab](agreements.md#the-apps-agreements-tab), and the risk register in [Risk in Studio](risk.md#risk-in-studio).

### The app's top bar

Inside an app, the page header is replaced by the app's own bar:

- **Back**, then the app's name and stage.
- The stage control: **Promote to Staging** or **Promote to Production** (the next stage only) and, for owners and admins of the workspace, **Move back**.
- The app's hosting state and **Put online**.
- The preview's controls: back, forward, reload, the path, its width (desktop, tablet or phone) and open in a new tab.
- The build's measured cost and time.
- Search, the GitHub and wallet controls, Build, Docs and the theme switcher, as in the page header.

### Promoting an app

**Promote to Staging** and **Promote to Production** open a side sheet with Mynt's checks for the next stage. Each check has a status in words (and a red, amber or green mark), its detail and its fix: a link to a Studio page, or the tool that does it.

- **Promote** is enabled only when Mynt says the app can be promoted and you are an owner or admin of the app's workspace. Members see the checks, and that an owner or admin promotes.
- When Mynt asks for a Mynt admin's sign-off, the sheet shows its status, with **Request admin sign-off** until it has been asked for.
- **Move back** goes only to an earlier stage, with a reason.

The checks themselves are in [Stages and promotion](workspaces-and-sign-in.md#stages-and-promotion). Production needs a signed program agreement with every sponsoring licence provider; see [Production needs program agreements](agreements.md#production-needs-program-agreements).

### Put online in the top bar

The top bar shows where the app stands on Mynt's hosting: **Online at** its address (a link), **Deploying**, or **Not online**. Once the app has a build Mynt verified, it also has a labelled button:

| Button | When |
|---|---|
| **Put online** | The app isn't hosted yet |
| **Put the new build online** | The app runs an older build |
| **Hosting details** | The app already runs this build |

The sheet shows the build, the repository and commit it deploys, and what happens: Mynt's hosting builds exactly that commit on the app's own machine, the app gets its own public address, and its Mynt key is added at Mynt's edge, never stored on the app's machine.

A build that pushed to no repository can't be hosted. The sheet says so and offers **Choose repository**; the app's next build pushes there. The chat's composer offers the same **Put online** once a build has shipped. The full behaviour is in [Put online](apps-and-builds.md#put-online).

## The product workspace

A financial product has its own workspace at `/products/<id>`, laid out like an app's: the product's chat on the left and its tabs on the right. It opens from the stage folders, from the Build page, and right after a product is created.

### The product's header

The header shows the product's name and stage, then the labelled actions, each opening its sheet:

| Action | What it does |
|---|---|
| **Move to staging** | Opens the approval sheet with what Staging needs |
| **Move to production** | Opens the approval sheet with what Production needs |
| **Move back** | Moves the product to an earlier stage |
| **Archive** | Archives the product |
| **Unarchive** | Brings an archived product back |

What each stage needs and allows is in [Product stages](products.md#product-stages), and archiving in [Archiving a product](products.md#archiving-a-product).

### The product's tabs

Each tab is a list of sections, and each section a table. A section Mynt can't fill says why. Tabs are read live, as an app's are.

| Tab | Sections |
|---|---|
| **Terms** | From the product definition: Terms, Rates, Fees, Limits, Lifecycle events, Servicing policies and Costs |
| **Customers** | Customer segments, and Target market and eligibility |
| **Risk** | The product's risk register first (**Add risk**, **Review risk**; each risk with its inherent, control and residual scores, and a row opening [the risk's detail](risk.md#a-risks-detail)), then Risk models, Decisioning and underwriting, Covenants, Open breaches, Sales paused by a covenant, and Product health |
| **Compliance** | Sponsorship, Regulatory obligations, Disclosures and documents, and What the next stage needs |
| **Integrations** | Partner hand-offs, Vendor services, Connections and Partner ledger |
| **Apps** | Apps built on this product, each linking to its app workspace |
| **Activity** | Versions, and Stage moves, drift and archiving |

### The product's chat

The chat is the product chat whose draft created the product. A product made without a chat gets a new one. It is kept on Mynt, as the Build page's product chats are. Its slash commands show the tabs (`/terms`, `/customers`, `/risk`, `/compliance`, `/integrations`, `/apps`, `/activity`).

## Licences

Licences (`/licences`) is where builders and licence providers work on their agreements with each other. It has four tabs:

| Tab | Address | What it shows |
|---|---|---|
| **Business Agreements** | `/licences` | Program and data-sharing agreements |
| **MSA** | `/licences?tab=msa` | Master services agreements (MSAs), and a licence provider's agreement templates |
| **SLA** | `/licences?tab=sla` | Service-level agreements (SLAs), with their commitments and breaches |
| **Audit Obligations** | `/licences?tab=audit-obligations` | The oversight audits licence providers run on apps, read-only |

Every tab is open to both roles and shows your side: a licence provider sees its firm's agreements, a builder the selected workspace's, and someone with both roles sees both, each row saying its side.

### Agreements on the first three tabs

Business Agreements, MSA and SLA are one list over their kinds of agreement:

- A full-width search, **Filters** (status, kind where the tab has more than one, scope, and your side when you are on both), a Proposed date range, **Import** (disabled, saying why) and **Export CSV**.
- Columns for the app, the other party, products, kind, scope, status, effective dates, document and actions.
- The tab's own action: **Propose agreement**, **Propose MSA** or **Propose SLA**. Either side proposes. A licence provider may start from one of its templates.
- The other side accepts or declines, and both sign, by e-signature where it is set up. While your own proposal is still proposed, **Change scope** changes what it covers.

A row opens **Review agreement**: a card of the agreement's details, the labelled actions for your side (Accept, Decline, Withdraw, Change scope, Sign, End agreement, Download signed copy), then tabs, each a table: Products and Signatures, and on an SLA, **Commitments** and **Breaches** (with Add commitment, Record breach, Retire commitment and Resolve breach).

Under the MSA table, a licence provider has **Agreement templates**, with **Upload agreement template** and **Retire**.

### Where licence coverage went

The licence table and coverage map are no longer on this page. Licence coverage is on each product's Compliance tab. The old addresses (`/coverage`, `?view=`, `?tab=coverage`, `?tab=licences`) come back to `/licences`, and `?tab=agreements` opens Business Agreements.

The rules behind agreements are in [Agreements](agreements.md), and this page is described from the agreements side in [The Licences page](agreements.md#the-licences-page).

## Marketplace

Marketplace (`/marketplace`) lists standard services from vendors, which Studio calls service providers. Each service is offered under the vendor's standard terms. A workspace subscribes by accepting them: there is no negotiation, the vendor bills directly, and Mynt never bills or holds money for it.

- The list has a full-width search, one **Filters** popover (region, category and service type), **Import** and **Export CSV**, over a table paged 25 rows at a time.
- A row opens its details in a side panel: a card of the key facts, then the tabs Overview, Standard terms, Pricing, Prerequisites, Conformance and Regions, each a table.
- **Subscribe** opens the Subscribe sheet: you pick the apps the service is for, tick that you accept the standard terms, and confirm. Mynt checks again that the terms are the current version and that you are an owner or admin of each app's workspace.

See [The marketplace and standard terms](vendors-and-marketplace.md#the-marketplace-and-standard-terms).

## My services

My services (`/vendor`) is a vendor's own area, shown only to accounts with the vendor role.

- **The onboarding checklist** is a card at the top: the firm's steps, then each service's. Every step has its status in words, what it waits on, and a labelled button where Studio can do it: **Create service**, **Edit service**, **Run conformance**, **Set standard terms** or **List service**. Steps only Mynt can do say what they wait for.
- **The firm's services** are a list below it: a full-width search, **Import**, **Export CSV** and **Create service**, over a paged table.
- A service opens its details: a card with its labelled actions, then the tabs Conformance runs, Terms versions and Subscribers, each a table.

See [Onboarding a vendor](vendors-and-marketplace.md#onboarding-a-vendor).

## My firm

My firm (`/firm`) is a regulated firm's own area. It is shown only to accounts Mynt granted the licence-provider role, with standing at their firm. A Mynt admin's roles imply the role without a firm, so an admin sees My firm only when the role was also granted.

From top to bottom:

- **The firm's card**: its status, regions, LEI, FinCEN MSB registration number, NMLS ID, whether it can sponsor now, and its firm id to share with builders. One line says where the real-company check stands, in words with a mark, and when the registers were last asked. **Set firm facts** opens a sheet for the three identifiers. The firm's other identifiers are kept as they are, and its legal name is Mynt's to correct.
- **The onboarding checklist**, "Getting ready to sponsor": every step has its status in words, what it waits on, and a labelled button where Studio can do it (**Set firm facts**, **Register licence**, **Add party**, **Review request**). Steps only Mynt can do say what they wait for.
- **Six tabs**, each a list: a full-width search, **Import** (disabled, saying why), **Export CSV** and the tab's own action, over a paged table.

| Tab | Address | Shows | Actions |
|---|---|---|---|
| **Licences** | `/firm` | The firm's licences: type, regulator, where it was issued, number, dates, status in words, where it covers, sponsorships under it | **Register licence**: the licence type from the regulatory model for the firm's regions, its number, the state where the type is issued per state, and its dates |
| **Sponsorship requests** | `/firm?tab=requests` | Requests waiting for a decision, then approved sponsorships: product, component, builder, where asked and approved | **Review request** on a waiting one (Approve sponsorship or Decline request, with a note); **Revoke sponsorship** on an approved one, with a reason |
| **Sponsored products** | `/firm?tab=sponsored` | Every approved sponsorship: the product and whether it is live or drifted, the component, the builder, the licences and where. Read-only | |
| **Roster** | `/firm?tab=roster` | Required roles nobody fills, then the parties and what each fills | **Add party**, also on each unfilled role's row; **End party** |
| **People** | `/firm?tab=people` | Licence providers, other members, accounts waiting to be accepted, and people invited who haven't signed in | **Decide** on a waiting account (Accept member or Decline member) |
| **Notices** | `/firm?tab=notices` | What changed at the firm, newest first. Read-only. Opening the tab marks them read | |

Review request says so when the real-company check hasn't passed: Approve sponsorship is off, with the reason, and Decline request still works.

Mynt acts for the caller's own firm in every one of these, and Studio's routes check that a sponsorship, licence, party or member request belongs to that firm before they send anything. Mynt's refusals are shown in its own words: an admin account can't revoke a sponsorship or decide who joins, even one that belongs to the firm.

Still done with the Model Context Protocol (MCP) tools: a party's qualification facts, a covenant breach on a revocation, the partner kit and the firm's webhooks. Agreement templates are on [Licences](#licences).

See [Onboarding a regulated firm](licence-providers.md#onboarding-a-regulated-firm).

## Audits

Audits (`/audits`) sorts the workspace's records into five tabs. Each is its own table with one toolbar row: a full-width search, the tab's filters as compact controls, and **Export CSV**. A filter that is on shows on its control ("Status · overdue").

| Tab | Address | What it shows |
|---|---|---|
| **App security** | `/audits` | Build audits and their findings, program gate results and vulnerability flags, with severity and status |
| **Licence obligations** | `/audits?tab=obligations` | Each licence's regulatory obligations for the products it covers: met, at risk or overdue, with evidence |
| **Agreement audits** | `/audits?tab=agreements` | The oversight audits licence providers run on the workspace's apps under program agreements |
| **Financial activity** | `/audits?tab=financial` | Money movements, live transactions, liquidity commitments and withdrawals, rail use and refusals |
| **Workspace activity** | `/audits?tab=workspace` | Membership, roles, keys and settings |

App security, Financial activity and Workspace activity are the workspace's audit trail by class. Mynt filters them by kind, member, app and date range, a page at a time.

### Licence obligations

Each row is one obligation in the regulator's own terms: the licence provider by name, the regulator and licence type, a status (met, at risk, overdue or unknown, as a dot and the word), the reason an unknown one is unknown, a due date and a summary of the evidence. It filters by licence provider, regulator, status and product. When any agreement audits are overdue it shows a line with **Show overdue agreement audits**.

### Agreement audits

Agreement audits are a tab of their own so that the regulator's obligations keep their register's schema.

- Rows: the agreement, the app, the audit with its cadence, its kind, due date, status in words (with "Overdue" beside it when it is past due and not closed) and findings ("1 open of 2").
- Filters: agreement, counterparty, app, kind and status. The date range is the due date. `?agreement=<id>` opens the tab filtered to one agreement.
- A row opens a sheet: a card of the audit's details, your actions as labelled buttons, then the tabs Findings, Evidence and History.

| Who | Actions |
|---|---|
| A licence provider | **Open audit**, **Record finding**, **Resolve finding**, **Pass**, **Fail**, **Waive**, and **Add audit requirement** in the toolbar |
| The app's owners and admins | **Submit evidence** (an `https` link with its SHA-256) and **Respond to finding** |

The rules are in [Oversight audits](agreements.md#oversight-audits) and [Compliance and the audit trail](workspaces-and-sign-in.md#compliance-and-the-audit-trail).

## Earn

Earn (`/earn`) is for liquidity pools. Builders and liquidity providers see it. It is laid out like an app's workspace: an assistant on the left and tables on the right.

One line sits under the composer: "Not investment advice · Mynt never holds your funds". Amounts are US dollars.

### The assistant

The assistant starts as "What do you want to earn?" with example chips. It reads only what you may see (pools, their health, your positions and withdrawals) and is never able to move anything.

- It can show matching pools in the Pools tab.
- It can draft a commitment or a withdrawal. A draft is only a card. Nothing is sent until you click **Review** and then **Approve**.
- **Past conversations**, the round button at the chat's top right, lists your earlier Earn conversations, newest first, with **New conversation** at the top. They are kept on Mynt for you (at most 200), so they reopen in any browser.
- Its slash commands are `/pools`, `/strategies`, `/history` and `/new` for everyone; `/invested`, `/commit` and `/withdraw` for liquidity providers; `/my-pools` and `/propose` for builders.

Without a model configured, the assistant says "AI is not configured" and the tables still work.

### The tabs in Earn

| Tab | Address | Who | What it shows |
|---|---|---|---|
| **Pools** | `/earn?tab=pools` | Everyone on Earn | Every pool open to you, with a **Matched · All · Invested** switch |
| **My pools** | `/earn?tab=my-pools` | Builders | Your firm's products' pools |
| **My strategies** | `/earn?tab=my-strategies` | Everyone on Earn | What the assistant drafted, each with its approval status, **Review** and **Decline** |

Each tab has one toolbar row: search, one **Filters** button counting what is picked ("Filters · 2", with **Clear all** in its popover), **Export CSV** and the tab's action.

**Pools.** Each row shows the pool's product line, state, lock-in or notice period, minimum reserve, verified health, whether it is sandbox or cleared for real money, and its commitment limits. Yield reads "Not available yet", because Mynt doesn't measure it. A liquidity provider never sees its own firm's pools here.

- **Commit capital** takes dollars and the US state the capital moves from. It is disabled, with the reason, outside the pool's limits, before approval, while the pool is paused or closed, and for a real pool that isn't cleared ("Sandbox only — not yet cleared for real commitments").
- A row where you hold a position shows **Your position** (settled), queued and paid amounts, and any withdrawal requests still waiting. **Invested** lists only those pools.
- **Details** opens a sheet with the position's committed, settled, queued, paid and available amounts, and your firm's withdrawal requests with their place in the queue, earliest payment date and why each waits.
- **Withdraw** opens **Request withdrawal**, which shows the notice period, and that payment is first in, first out and only as far as the latest verified health snapshot keeps the pool above its minimum reserve.

**My pools.** Each pool shows its state (proposed and awaiting the licence provider's approval, sandbox, sandbox only until cleared, or cleared), status, rails, minimum reserve, notice period, commitment limits, latest health snapshot and withdrawal queue length. The **Approval** column shows its steps: Proposed, Sponsor approved, Admin approved (skipped for sandbox), Open. Mynt doesn't show a pool's capital to its builder, so that column says so. **Propose pool** is offered only on a component an approved licence provider sponsors.

### Approvals

Approvals look the same everywhere: a status as a dot and its words ("Needs your approval", "Sign in wallet", "Sending…", "Sent", "Declined", "Failed"), and steps. **Review** opens the approval sheet: the steps, a summary of what will happen (amount, pool, terms, the wallet, and the reserve and notice effects), then **Approve**, which sends it once, and **Decline**.

### The wallet picker

The wallet picker sits in the composer's toolbar. It lists your verified linked wallets with their devnet USDC and SOL balances, or "Not measured". **Connect wallet** lists the wallets found in this browser; connecting signs nothing. **Link wallet** goes to your account page. The choice is remembered in this browser.

### On-chain deposits and withdrawals

A pool with an on-chain treasury shows "On-chain treasury" and **Devnet**. Studio offers on-chain deposits on devnet only.

1. A draft for the pool names your wallet and shows **Deposit from** that wallet (or, for a withdrawal, **Withdraw to** it).
2. Clicking it asks Mynt to prepare the transaction. The card shows Mynt's own summary: pool, amount, wallet, lock-in, notice and expiry.
3. **Sign in** your wallet hands the unsigned transaction to your own browser wallet, which must be connected to exactly the chosen linked wallet. Your wallet signs and sends it. Nothing in Studio signs.
4. The card shows the signature and follows the transaction until it is confirmed, then reads positions and balances again.

Other things the card says:

- **Unverified build**, when the pool's treasury program isn't a build Mynt verified.
- **Deposits paused: approvers changed**, when Mynt flagged that the treasury's approvers changed on chain. Deposits to it are refused.
- "Refreshing…", when the transaction was prepared more than 45 seconds before signing and is prepared again. It is signed only if Mynt's new summary is the same; otherwise the new summary is shown to confirm.
- Mynt's refusals in plain words, with the date Mynt names for a deposit in review or locked in.

An on-chain position shows what is held, queued and available, then each deposit on its own line with when it unlocks. **Withdraw** on an available deposit opens an amount in USDC and the same flow, for that deposit only.

How pools, the queue and treasuries work is in [Liquidity pools and on-chain treasuries](liquidity-and-treasury.md).

## Settings

Settings (`/settings`) is the selected workspace's page. It has four tabs, each a table with one toolbar row (a full-width search, labelled actions and the tab's own action), paged 25 rows at a time.

| Tab | Address | What it shows and does |
|---|---|---|
| **Members** | `/settings` | The workspace's members. Owners and admins invite by email (**Invite member**, as admin or member), change roles and remove members. Everyone else sees the list only. Ownership isn't changed from here |
| **Invitations** | `/settings?tab=invitations` | Pending invitations, which owners and admins withdraw (**Withdraw**). Mynt shows them only to owners and admins |
| **Apps** | `/settings?tab=apps` | Every app in the workspace with its stage, owner, last build and links |
| **Repositories** | `/settings?tab=repositories` | Your own connected GitHub repositories, each with its approval and note, and **Connect repository** |

There is no General tab. Renaming and archiving a workspace are in [the workspace switcher's menu](#the-workspace-switcher). An unknown tab in the address, or the old General tab (`?tab=settings`), opens Members. The old addresses `/workspace` and `/members` open Settings.

E-signature is not set up here. It is in the platform admin, under Platform settings; `/settings?tab=esign` redirects there.

The rules are in [Members and invitations](workspaces-and-sign-in.md#members-and-invitations) and [Repositories](apps-and-builds.md#repositories).

## Platform admin

The platform admin (`/platform`) is for Mynt admins only. It has its own layout, not Studio's: its own sidebar with nine sections (Overview, Workspaces, Regulated firms, Vendors, Audit trails, Risk models, Risk register, Agent benchmarks and Platform settings) and **Back to Studio** at its foot. Licences are reviewed inside Regulated firms, on its Licences tab (`/platform/firms?tab=licences`).

In Studio, only accounts Mynt says hold the `admin` role get the **Platform admin** entry above their name in the sidebar. For everyone else `/platform` is a 404.

Each section is described in [The platform admin in Studio](platform-admin.md#the-platform-admin-in-studio). Three of its pages are about risk:

| Page | What it is |
| --- | --- |
| `/platform/risk-register/<id>` | One risk in full: Mynt's own, or an app's or a product's opened from the register's table (read-only). See [A risk's detail](risk.md#a-risks-detail) |
| `/platform/risk-models/<id>` | One of Mynt's risk models, with its health in words and the risks linked to it |
| `/platform/benchmarks` | [Agent benchmarks](platform-admin.md#agent-benchmarks-section): the runs as one table, with **Start run**; a run opens at `/platform/benchmarks/<id>` with four tabs, Tasks, Failures, Cost and Compare |
| `/platform/settings` | [Platform settings](platform-admin.md#platform-settings), four tabs that are each one table: Key vault, Operational settings, E-signature and Risk grading |

## Docs and search

### Docs

The **Docs** button in every header opens `/docs`: Mynt's documentation, built from this repository's Markdown and from the server's own tool list. It is public, so it opens without signing in. Signed in, it shows inside Studio's sidebar and header.

`/connect` is the docs' page for connecting your own MCP client to Mynt, with a picker for the client you use.

### Search

The header's search box ("Search...", with its ⌘K key; an icon button named Search on a phone) opens the command bar. So does Cmd+K, or Ctrl+K.

- With nothing typed it lists Studio's pages, the workspace's apps and your financial products, each under its section's heading, and a **Members** and an **Audit actions** entry that open their own lists.
- Typing finds any of them, and also what sits under them: an app's tabs (shown as "the app › the tab"), members and audit actions.
- Arrow keys move, Enter opens, Esc closes (or steps back out of a list). The bar's foot says so.
- Mynt admins also find the platform admin's sections there.

### Ask AI

Type a question in the command bar and **Ask AI** is the first result: a few words, or one word ending in a question mark, of at least 6 characters. Enter closes the bar and opens the Ask AI panel with that question already asked.

**The panel** is a fixed size: 60% of the screen's height and a third of its width, centred, and never narrower than 22rem. Below the `sm` breakpoint (640px) it fills the screen. It has a header (**New chat**, close), the conversation, which scrolls, and the question field pinned at the foot.

- **Asking.** Enter sends and Shift+Enter starts a new line. The field grows to five lines and takes 400 characters, with a count near the limit. While an answer is coming, **Send** is **Stop**.
- **Follow-ups.** Each new question is answered with the conversation so far (the last 20 turns, as text). **New chat** clears it. The conversation is kept in memory for the visit: close the panel and the bar offers "Ask AI: back to the conversation". Nothing is kept after you leave the page.
- **Steps.** Above each answer, one line says what Ask AI is doing ("Reading apps and their stages…") and then what it took ("Used 3 reads · Thought for 6s"). It opens into the steps in order: the model's thinking as it wrote it (nothing is shown when the model returned none), and each read with its name in words, the tool's name, its arguments, whether it is running, done or failed (with Mynt's message), how long it took and what it returned ("4 apps"). **Show result** opens the read's reply as JSON, cut to 4,000 characters, with anything that looks like a secret replaced.
- **Citations.** Every statement of fact cites a numbered source. A source is the record the fact came from where Studio has a page for it (an app, an audit action's filtered trail), and otherwise the page that holds the read. Each answer numbers its own sources. A citation is a small chip: hover or focus shows the source's title and when it was read, and a click opens it and closes the panel. The sources are listed under the answer. A citation with no source is dropped, and an answer with a statement that cites nothing says "Some statements have no source." Nothing is added to the answer for it.
- **Copy answer** copies the answer's text. **Ask again** re-asks the last question in its place.
- The answer follows the stream as it is written. Scroll up and it stops following; **Jump to latest** brings it back.
- Ask AI reads through Mynt's tools as you, never with an app key, and only with read tools.
- Questions and answers are never logged, and the conversation is never stored: the browser sends it again with each follow-up.
- You may ask 20 questions an hour, one at a time; a follow-up is a question. Past that it says so.
- The answer comes from the first model that answers: the configured model, then the fallback model.
- With no model configured the bar has no Ask AI entry, and search keeps working.

The platform admin's search has its own Ask AI, for Mynt admins. See [Search and Ask AI](platform-admin.md#search-and-ask-ai).
