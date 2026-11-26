# Mynt Studio

This file is for engineers working on `platform/studio`: how to run it, its settings, where each page's code lives, how it works inside, and what was changed from the projects it is built on.

What people see and do in Mynt Studio, page by page, is in [docs/reference/studio.md](../../docs/reference/studio.md).

## What it is

Mynt Studio is a Next.js web app where builders make apps and financial products on Mynt by chatting with Mynt's agents, beside a live preview of what is built. Licence providers, vendors, liquidity providers and Mynt admins use it too, each for their own pages.

- People sign in with their own Mynt account.
- Studio holds no hosting-provider keys. Everything goes through Mynt's MCP (Model Context Protocol) server as the signed-in user, and Mynt checks every call.
- Studio stores nothing but the session. Apps, builds, products, agreements and chats are read from Mynt on each load.
- Its one optional model setting is for Ask AI and the assistants built on it (Earn's, and the financial-product chat). Without it they say AI isn't configured and everything else works.

## Run it locally

```sh
cd platform/studio
cp .env.example .env.local   # then fill in MYNT_MCP_URL
npm ci -w .                  # Studio and @mynt/auth, from the repository's root lockfile
npm run dev
```

Open the address `npm run dev` prints and sign in with your Mynt account.

Checks:

```sh
npx vitest run
npx tsc --noEmit
npx next build
```

CI runs all three, and fails on wording Mynt doesn't use or on a host name or IP address in this folder. On a machine short of memory, run one test file at a time: `npx vitest run test/<file>`.

## Settings

| Variable | What it is |
|---|---|
| `MYNT_MCP_URL` | Mynt's MCP endpoint, like `https://mynt.example.com/mcp`. |
| `APP_URL` | Studio's public URL. Sign-in returns to `$APP_URL/api/auth/callback`. Served on Mynt's domain, it is that domain. Changing it registers Studio with Mynt's sign-in again (the registration is kept per callback address). |
| `TRUSTED_EDGE_IPS` | Served on Mynt's domain only: every public outbound address of Mynt's server, IPv4 and IPv6, comma-separated. Requests from these addresses are served, and the caller's address is taken from their `X-Mynt-Client-IP`. Browsers coming from anywhere else are sent to `APP_URL`. |
| `PREVIEW_FRAME_SRC` | The origins previews are served from: space-separated `https` origins with optional wildcards, like `https://*.preview.example`. Unset, no preview can be shown. |
| `ESIGN_FRAME_SRC` | Optional. Extra origins agreements' signing pages may be framed from, in the same form. Not needed normally: Studio learns the e-signature service's signing origins from Mynt. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | The Redis database for sessions. Vercel sets these when you connect a Redis database to the project. Upstash's own names, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, work too. |
| `SESSION_ENCRYPTION_KEY` | 32 random bytes, base64-encoded, that encrypt the stored sessions. Required with Redis. |
| `SESSION_ENCRYPTION_KEYS_OLD` | Optional: earlier keys, comma-separated, that still decrypt sessions sealed before a rotation. |
| `TRUSTED_PROXY_HEADER` | Off Vercel only: the header your proxy sets to the caller's address (for example `x-real-ip`), for the sign-in rate limit. Its last value is used (what the proxy appended), so it must be a header the proxy sets or appends to. |
| `SESSION_STORE` | Optional: `memory` allows the in-memory store with `NODE_ENV=production` (one local process only, never on Vercel). |
| `MYNT_OAUTH_SCOPE` | Optional: the scopes to ask for. |
| `MYNT_OAUTH_CLIENT_ID`, `MYNT_OAUTH_CLIENT_SECRET` | Optional, both or neither: the OAuth client registered for Studio with `mynt clerk first-party`, so users see no consent screen. Unset, Studio registers itself. Server-only. |
| `MYNT_OAUTH_ISSUER` | Optional, with the client above: the only authorization server its secret may be sent to. |
| `NEXT_PUBLIC_SOLANA_EXPLORER_TX_URL` | Optional: a block explorer's transaction page with `{signature}` in it, like `https://explorer.example/tx/{signature}`, to link an on-chain deposit's signature (`?cluster=devnet` is added). Unset, the signature is shown as text. |
| `ANTHROPIC_API_KEY`, or `VERTEX_PROJECT_ID` and `VERTEX_REGION` | Optional: the model for Ask AI, set the same way as for the sample chat (`platform/chat`): Claude through the Claude API, or through Google Vertex AI. `CHAT_MODEL` picks the model. Server-only. |

Secrets are set by the operator on the host, by name. Never put a value in the repository, a command line or a log.

### The session store

The Redis client is [`@upstash/redis`](https://github.com/upstash/redis-js), which talks to Redis over HTTPS and so works from serverless functions. Without Redis settings, sessions stay in the server's memory, which is fine for `npm run dev`. On Vercel, Studio refuses to start that way, because its function instances share no memory. In production elsewhere it refuses too, unless `SESSION_STORE=memory` says it is wanted.

### Rotating the encryption key

1. Make a new key with `openssl rand -base64 32`.
2. Set it as `SESSION_ENCRYPTION_KEY`, and put the old one in `SESSION_ENCRYPTION_KEYS_OLD`.
3. Redeploy. Existing sessions keep working and are re-sealed with the new key as they are used.
4. After 7 days, every session sealed with the old key has expired, and the old key can be removed. Removing it sooner signs out whoever it still covers.

Stored values name the key that sealed them (format `v2`). A session sealed in the older format can't be read, and that person signs in once more.

## Routes and files

Pages are under `app/(studio)` (Studio's shell: sidebar and header) and `app/(platform)` (the platform admin's own layout). Each page's data comes through an API route under `app/api`, which calls Mynt through `lib/`.

| Page | Route | Main files | API routes |
|---|---|---|---|
| Shell, sidebar, header | every page | `app/(studio)/studio-shell.tsx`, `components/app-sidebar.tsx`, `components/nav-folders.tsx`, `components/team-switcher.tsx`, `components/invitations.tsx`, `components/site-header.tsx`, `components/github-control.tsx`, `components/wallet-control.tsx`, `lib/use-linked-accounts.ts`, `components/studio-gates.tsx` | `app/api/session`, `app/api/projects`, `app/api/workspaces`, `app/api/invitations`, `app/api/linked-accounts` |
| Dashboard | `/` | `app/(studio)/page.tsx`, `components/dashboard-view.tsx`, `components/dashboard-panels.tsx`, `components/investor-view.tsx`, `components/mode-switch.tsx`, `components/charts.tsx`, `components/pnl.tsx`, `lib/dashboard-visual.ts`, `lib/pnl.ts`, `lib/investor.ts` | `app/api/dashboard`, `app/api/pnl`, `app/api/attention`, `app/api/stages`, `app/api/audit` |
| Build | `/new` | `components/new-app-workspace.tsx`, `components/product-chat.tsx`, `components/create-product-sheet.tsx`, `lib/new-app.ts`, `lib/product-chat.ts`, `lib/product-ideas.ts`, `lib/products.ts` | `app/api/apps`, `app/api/products`, `app/api/products/options`, `app/api/product-chat`, `app/api/app-kinds` |
| Builds | `/builds` | `components/builds-view.tsx`, `lib/build-metrics.ts` | `app/api/projects` |
| App workspace | `/<app id>`, `/<app id>/<build id>` | `app/(studio)/[projectId]/project-workspace-shell.tsx`, `app/(studio)/[projectId]/assistant.tsx`, `components/chat-workspace-shell.tsx`, `components/app-panel-tabs.tsx`, `components/app-top-bar.tsx`, `lib/app-panel.ts`, `lib/chat.ts` | `app/api/chat`, `app/api/apps/[appId]/*`, `app/api/builds/[buildId]/finish` |
| Promotion | the app's top bar | `components/promotion-view.tsx`, `lib/promotions.ts` | `app/api/apps/[appId]/promotion` |
| Put online | the app's top bar | `components/hosting-control.tsx`, `lib/hosting.ts` | `app/api/apps/[appId]/hosting` |
| Product workspace | `/products/<id>` | `components/product-workspace.tsx`, `components/product-stage-sheet.tsx`, `components/product-archive-sheet.tsx`, `lib/product-panel.ts`, `lib/product-panel-server.ts` | `app/api/products/[productId]/*` |
| Licences | `/licences` | `app/(studio)/licences/`, `components/lp-agreements-view.tsx`, `components/propose-agreement-sheet.tsx`, `components/agreement-slas-view.tsx`, `components/agreement-audits-panel.tsx`, `lib/licences-tabs.ts` | `app/api/agreements`, `app/api/agreement-slas` |
| Marketplace | `/marketplace` | `components/marketplace-view.tsx`, `components/marketplace-subscribe-sheet.tsx`, `lib/marketplace.ts` | `app/api/marketplace` |
| My services | `/vendor` | `components/vendor-area.tsx`, `components/vendor-sheets.tsx`, `lib/vendor-area.ts` | `app/api/vendor` |
| Audits | `/audits` | `components/audits-view.tsx`, `components/agreement-audits-view.tsx`, `lib/audit-classes.ts`, `lib/agreement-audits.ts` | `app/api/audit`, `app/api/obligations`, `app/api/agreement-audits` |
| Earn | `/earn` | `components/earn-view.tsx`, `components/earn-assistant.tsx`, `components/earn-wallet.tsx`, `components/approval.tsx`, `lib/earn.ts`, `lib/liquidity.ts`, `lib/liquidity-server.ts`, `lib/wallets.ts`, `lib/browser-wallet.ts` | `app/api/earn`, `app/api/earn/wallets`, `app/api/earn/treasury/*`, `app/api/liquidity/*`, `app/api/threads` |
| Settings | `/settings` | `components/workspace-view.tsx`, `components/members-view.tsx`, `components/repositories.tsx`, `components/workspace-settings.tsx`, `lib/workspace-tabs.ts`, `lib/workspaces.ts` | `app/api/workspaces/[workspaceId]`, `app/api/invitations`, `app/api/repositories` |
| Platform admin | `/platform`, `/platform/<section>`, `/platform/<section>/<id>` | `app/(platform)/layout.tsx`, `components/platform-shell.tsx`, `components/platform-view.tsx`, `components/admin-*.tsx`, `lib/admin.ts`, `lib/admin-members.ts`, `lib/admin-audit.ts`, `lib/admin-risks.ts`, `lib/admin-server.ts` | `app/api/admin/*` |
| Docs | `/docs`, `/connect` | `app/docs/`, `components/docs/`, `components/connect-guide.tsx`, `lib/docs.ts`, `lib/docs-source.ts` | `app/docs/search-index` |
| Search and Ask AI | the header | `components/studio-search.tsx`, `components/ask-ai.tsx`, `lib/studio-search.ts`, `lib/ask.ts` | `app/api/ask` |
| Sign-in | `/api/auth/*`, `/signin-error`, `/signed-out` | `proxy.ts`, `lib/page-gate.ts`, `lib/session.ts`, `lib/session-store.ts`, `lib/tokens.ts` | `app/api/auth/{login,callback,logout}` |

Old addresses and where they go are in `lib/redirects.ts` (applied by `proxy.ts` and `next.config.ts`), `lib/licences-tabs.ts` and `lib/studio-search.ts`:

| Old address | Goes to |
|---|---|
| `/admin?tab=<section>&id=<id>` | `/platform/<section>/<id>`; a section the platform admin no longer has (apps, people, products) goes to `/platform` |
| `/platform/risks`, `/admin?tab=risks` | `/platform/risk-register` |
| `/platform/licences` and anything under it, `/admin?tab=licences` | `/platform/firms?tab=licences` |
| `/settings?tab=esign` | `/platform/settings` |
| `/docs/connect` | `/connect` |
| `/workspace`, `/members` | `/settings` |
| `/liquidity` | `/earn`, on the matching tab |
| `/earn?tab=opportunities`, `?tab=open-pools` | Pools, on All |
| `/earn?tab=my-positions`, `?tab=positions` | Pools, on Invested |
| `/earn?tab=drafts` | My strategies |
| `/coverage`, `/licences?view=`, `?tab=coverage`, `?tab=licences` | `/licences` |

### The platform admin

The platform admin is for Mynt admins, across all workspaces and firms. What its eight sections show and do is described once, in [docs/reference/platform-admin.md](../../docs/reference/platform-admin.md#the-platform-admin-in-studio). For the code:

| Section | Address | Component | API routes |
|---|---|---|---|
| Overview | `/platform` | `components/admin-overview.tsx`, `components/admin-members.tsx` (Invite person) | `GET /api/admin/overview` |
| Workspaces | `/platform/workspaces` | `components/admin-workspaces.tsx` | `/api/admin/workspaces`, `/api/admin/workspaces/<id>`, `POST /api/admin/workspaces/<id>/members` |
| Regulated firms | `/platform/firms` (tabs `?tab=firms`, `?tab=licences`) | `components/admin-firms.tsx`, `components/admin-licences.tsx` (the Licences tab, and each firm's licence review) | `/api/admin/firms`, `/api/admin/firms/<id>`, `/api/admin/firms/<id>/status`, `POST /api/admin/firms/<id>/members`, `/api/admin/licences`, `/api/admin/licences/<id>` |
| Vendors | `/platform/vendors` | `components/admin-vendors.tsx` | `/api/admin/vendors`, `/api/admin/vendors/service-types`, `/api/admin/vendors/offerings/<id>` |
| Audit trails | `/platform/audit` | `components/admin-audit.tsx`, `lib/admin-audit.ts` | `GET /api/admin/audit?limit=` (1 to 500) |
| Risk models | `/platform/risk-models` | `components/admin-risk-models.tsx`, `lib/risk-models.ts` | `GET` and `POST /api/admin/risk-models`, `GET` and `POST /api/admin/risk-models/<id>` |
| Risk register | `/platform/risk-register` | `components/admin-risk-register.tsx`, `components/risk-register.tsx`, `lib/admin-risks.ts` | `GET /api/admin/risks?area=<area>`, `POST /api/admin/risks` |
| Platform settings | `/platform/settings` | `components/admin-settings.tsx`, `components/esign-settings-view.tsx` | `/api/admin/settings`, `/api/admin/esign` |

Engineering notes that hold for every section:

- `/platform` needs sign-in like every page. It and every `/api/admin/*` route answer 404 to anyone Mynt doesn't say is an admin (the `admin` role from `whoami`, never a list in Studio's settings).
- Nothing is sent with the workspace cookie.
- Each change calls an admin tool through its own allow-list, `ADMIN_TOOLS` in `lib/studio-tools.ts`, called only through `callAdminTool` for an admin's session.
- The members tables are `WorkspaceMembersTable` and `FirmMembersTable` in `components/admin-members.tsx`. The members routes take an `action`. For a workspace: `invite`, `change_role`, `remove` (with `confirm: true`) or `revoke_invite`. For a firm: `invite`, `change_role` (`firmRoleChange` in `lib/admin-members.ts`) or `remove` (with the email typed again).
- The seven risk-area tabs are `components/risk-area-tabs.tsx`, from `RISK_AREAS` in `lib/risk-register.ts`; the tab is `?tab=<area>`.
- A Risk register tab is one table filling the page: `AdminList` over one `AdminTable`. `registerItemsFrom` in `lib/admin-risks.ts` turns Mynt's register, the apps' and products' risks and the area's signals (`areaSignalsFrom`) into its rows, each with its source in words. A part Mynt can't answer, or a signal it doesn't measure, is one row with the status "Not available" and the reason in Detail.
- A Risk models tab is one table too. On the Regulated product risk tab it also holds the products' own models, with Source and Type columns.
- `AdminTable`'s `opens` says which rows a click opens, for a table whose rows come from several sources. Its `unavailable` gives a whole table the one row "Not available." with why.
- `audit_log` takes no filters and no cursor, so the Audit trails section searches, filters and pages its newest 500 entries in the browser.
- A Mynt without a section's tool makes the section say it "isn't available yet" instead of failing.

## How it works

### Sign-in and sessions

**Sign-in** is real Mynt user authentication: OAuth with PKCE (Proof Key for Code Exchange), as a client an operator registered once (see [Sign in without a consent screen](#sign-in-without-a-consent-screen)) or else with dynamic client registration, run on the server by the MCP SDK. Tokens never reach the browser.

**Shared with the sample chat.** The sign-in code (session cookie, OAuth provider, Mynt client and the `app/api/auth/{login,callback,logout}` handlers) is the `@mynt/auth` package in `platform/packages/auth`, which both apps import. `lib/session.ts`, `lib/mynt-client.ts` and the route files only hand it this app's settings, cookie name and session store. Each app has its own `lib/config.ts`, `lib/app-session.ts` and `lib/session-store.ts`.

**Page by page.** `proxy.ts` sends a signed-out visit to any page straight to `/api/auth/login?next=<that page>`. The login route keeps `next` only if it is a relative path on Studio (`safeReturnPath` in `@mynt/auth`), and the callback goes back there. A failed sign-in lands on `/signin-error` and signing out on `/signed-out`. Neither needs a sign-in, so a failure can't loop, and signing out doesn't sign straight back in while the authorization server still has a session. The docs (`/docs`, `/connect`) are public (`lib/page-gate.ts`).

**Sessions** (`lib/session-store.ts`):

- The browser holds only a random session id, in an `httpOnly`, `SameSite=Lax` cookie that is `Secure` and `__Host-`-prefixed everywhere except plain-http localhost.
- The session itself (OAuth tokens, the PKCE verifier, the user's roles) lives on the server: in a hosted Redis database when one is configured, and in memory otherwise.
- Every stored value is encrypted with AES-256-GCM (full 16-byte tags only) using `SESSION_ENCRYPTION_KEY`, names the key that sealed it, and is stored under a hash of the session id.
- A session that never finishes signing in expires after 10 minutes, a signed-in one after 7 days without use. The cookie's expiry moves with the server's. The sample chat uses the same lifetimes.

**Several requests at once.** Each request works on its own copy of the session, so the store guards against them undoing each other:

- A request that finishes after sign-out can't bring the session back: saving only replaces a stored session (Redis `SET XX`), and only sign-in creates one (`SET NX`).
- A request never writes older tokens over newer ones.
- Tokens are refreshed ahead of expiry, before calling Mynt, by one request at a time per session (a short lock in Redis, released only by its holder, `lib/tokens.ts`). The others wait and pick up the new tokens. Refresh tokens are single-use, so two refreshes at once would otherwise sign the user out.
- Only the authorization server rejecting the refresh token or the client (`invalid_grant`, `invalid_client`) signs the user out. A timeout (10 seconds for the whole refresh, discovery included), a 5xx or a network error keeps the tokens and answers 502.
- Tokens and the client registration are bound to the authorization server that issued them. If discovery ever names a different one, the refresh token isn't sent there and the user signs in again.
- A request clears tokens Mynt refused only if they are still the stored ones. If another request has refreshed them meanwhile, it picks those up instead.
- The app's client registration doesn't expire while it is used, and is re-sealed with the current key when read after a rotation. One refused sign-in doesn't drop it (every user's refresh token depends on it); three refusals of the same client within an hour do, and the next sign-in registers again.
- The app workspace never has two project loads in flight.

**Roles** come from Mynt's `whoami` and are read again every 5 minutes, so a revoked role takes effect without signing out. Mynt checks every call itself regardless. When Mynt stops accepting a session's sign-in mid-request, Studio answers 401 and signs the session out.

**Who sees what** (`app/(studio)/studio-shell.tsx`, `components/studio-gates.tsx`). The page waits until the user's roles are known (`/api/liquidity/access`), so nothing builder-only is fetched for anyone else. A builder route asked by someone whose freshly read roles don't allow it is refused at once (403), without connecting to Mynt. What each role sees is in [the reference](../../docs/reference/studio.md#who-sees-what).

**Sign-in rate limit.** Starting sign-in creates a session before anyone is signed in, so each address may start it 20 times per 10 minutes (counted atomically in Redis, in `proxy.ts`); after that it gets a 429. IPv6 addresses count per /64. The address comes only from a header callers can't forge: on Vercel its `x-vercel-forwarded-for`; elsewhere the header named in `TRUSTED_PROXY_HEADER`. Without one, all callers share a bucket of 200.

### The tools allow-list

Mynt's tools are called only through the `STUDIO_TOOLS` allow-list in `lib/studio-tools.ts`, which checks each tool's arguments with zod. Mynt checks everything again; the list keeps junk off the wire and keeps Studio to its job.

- A writing tool joins the list with the screen that uses it: the chat starts, steers and ships builds (`start_build`, `steer_build`, `finish_build`); Build creates apps and products (`create_app`, `create_product`); the stage controls promote and move back (`promote_app`, `demote_app`, `promote_product`, `demote_product`); Put online hosts a verified build (`request_hosting` with the app's `workspace_id`, then `deploy_app`) and chooses the repository (`set_app_repository`).
- `undeploy_app`, `vm_access`, `app_run` and admin tools are never on it.
- Builds start without `cap_usd`: the allow-list refuses it, and Mynt applies its own caps. Studio has no spending-cap control anywhere. Costs are shown as measured, never against a cap.
- The platform admin has a separate list, `ADMIN_TOOLS`. The only names on both lists are the vendor reads and the risk tools, whose admin entries take nothing but Mynt's own register.
- Ask AI and the assistants built on it are offered only the read tools listed in `lib/ask.ts`.

**Refusals.** Mynt's refusals reach the page in Mynt's own words, cleaned and capped. Only an empty message, or one that looks like a stack trace or names server files, becomes a generic line. Ask AI and Earn's assistant show a sentence for a failed request, never raw JSON.

**Writes.** Each write is a POST that checks Studio's own origin, takes a small JSON body, and names only something Mynt lists as the user's (this app, this build, this invitation).

**Tools this Mynt lacks.** Each part waits for Mynt to offer its tool and says "not available yet" until then. It never shows an empty table or a 0 in that case.

### Workspaces

`lib/workspaces.ts`, `lib/workspace-server.ts`, `components/workspace-context.tsx`.

- The switcher's choice is kept in the `__Host-mynt_workspace` cookie, which the API routes read too. It isn't a credential: Mynt checks membership on every call.
- A remembered cookie naming a workspace the user has left falls back quietly to Personal. A page that asks for that workspace by name says the user is no longer a member, never showing Personal data under its name.
- Until Mynt has workspaces there is one implicit Personal workspace. Studio never sends its synthetic `personal` id to Mynt: routes omit it for the implicit workspace, `/api/workspaces/personal` is a 404 that never reaches Mynt, and with no workspace at all a read answers "You don't have a workspace yet" instead of asking Mynt.
- A shared workspace never shows the user's unscoped data. Where a tool can't be scoped to it yet, its apps and dashboard say they are not available yet, and Build is refused there rather than creating the app somewhere else.
- Build always names the workspace for `create_app`: the selected one, or in Personal the user's own (the one `list_workspaces` marks personal). Mynt doesn't default into workspaces the user was invited to.
- An app's folder is Mynt's `stage` (`production`, `staging` or `idea`). Until Mynt gives one, it is derived: published apps are Production; an app whose last build succeeded or has a preview is Staging; anything else is an Idea.
- Studio checks the user's workspace role before anything reaches Mynt, and Mynt checks again.

### Chat and builds

`app/api/chat/route.ts`, `lib/chat.ts`, `app/(studio)/[projectId]/assistant.tsx`, `components/assistant-ui/thread.tsx`, `components/build-controls.tsx`.

**Steer or start.** A message steers the app's running build (the one on screen, else its newest), or starts a build for the app with the message as its goal. Where this Mynt offers session builds (its tool list has `finish_build`, and `start_build` takes `mode` and `continue_from`), the build starts in session mode and carries on from the app's last pushed build; otherwise it is a plain build.

**Streaming.** The reply streams the agent's activity (`get_build_activity`) as AI SDK UI message parts until it has answered, the build finishes, or about 3.5 minutes pass; the build carries on regardless.

- Where Mynt offers them (`get_build_activity` takes `text_deltas`), the agent's words show as it writes them: each message's pieces go into one text part that its whole message closes (`LiveText` in `lib/chat.ts`).
- Where it also takes `reasoning`, the agent's thinking, scrubbed by Mynt as its words are, goes into one reasoning part per thinking block, shown as a collapsible Reasoning block.
- Activity is read every 700 ms while the agent is active, every 2 seconds otherwise. It is followed by Mynt's cursor where it has one, and otherwise by comparing each poll with the last.
- Streamed replies (the chat, Ask AI, Earn) are sent `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`, so no proxy or compression holds them back.

**Claims and locks.** A message is claimed per Mynt user and app before it is sent (by its id for 10 minutes, by its text for 30 seconds). The claim is given back only when Mynt refused the message before changing anything (a permission, state, argument or budget check). After any other error, a timeout or a lost reply it may have arrived, so the claim stays.

Starting a build takes a lock per user and app (130 seconds, longer than listing builds and starting one together can take), then lists the app's builds again and decides again, because another device may just have started one. The lock is released once the new build is listed. Claims and locks are released only by their holder. Only one build starts at a time per app, whoever starts it.

**Following a build.** A build that is still going is followed live as its page opens (after Build, a reload, or coming back), from the cursor its history was read up to: `GET /api/chat?projectId=…&buildId=…&after=…`, which the AI SDK's `resumeStream` calls. When a reply's watch runs out of time, or a one-off build's agent hands over to Mynt's verification, the reply ends with a `data-follow` part and the page follows on by itself. Opening a past build rebuilds its conversation from its goal, the messages steered into it and its stored activity, ending with how it ended.

**Ship.** The composer offers Ship while the conversation's session build is open and not already shipping. It calls `finish_build` through `POST /api/builds/[buildId]/finish` (the build must be the app's), never interrupting the request under way, and the chat then follows the build to its end (`GET /api/chat?…&shipping=1`). The 15-minute idle finish stays as the fallback.

**Held messages.** A message sent while the app's build is being verified, or its session is shipping, is held, never a build beside it. The reply says "Queued — sent when verification finishes." and carries a `data-hold` part. The page keeps it (in this browser, per app, so a reload doesn't lose it), follows the build, and sends it as the next request once verification ends (`data-state` says the status as it moves; a follow answered 204 means the build is over).

**Build.** `app/api/apps` (`lib/new-app.ts`) calls `create_app` with the products picked (its name is the prompt's first sentence, its description the whole prompt), then `start_build` with the prompt as the goal, in session mode where Mynt offers it. The same request twice creates one app.

**The financial-product chat** (`components/product-chat.tsx`, `lib/product-chat.ts`, `app/api/product-chat`) is Ask AI's stack (`runAsk`, streamed with its reasoning) with its own instructions and one tool, `draft_product`, which carries `create_product`'s fields and is checked with the Create product sheet's own rules. Confirming the sheet sends `POST /api/products` once. Mynt's product desk isn't used here.

**The app's tabs** (`components/app-panel-tabs.tsx`, `lib/app-panel.ts`, `app/api/apps/[appId]/panel`). Every read names this app, its products or its workspace, for an app Mynt lists as the user's.

| Tab | Reads |
|---|---|
| Products, Agreements, Customers | `list_app_agreements` and `get_app_customers` for this app, and the production check from `get_promotion_checks` |
| Security & risk | `list_risks` for the app, Mynt's build checks for the next stage, and `list_workspace_audit` with `class: "security"` |
| P&L | `get_workspace_pnl` with the app's id |
| SDK | `get_product_sdk`, for each product of the app |
| Activity | `list_builds` and the app's audit events |

**The chat workspace** (`components/chat-workspace-shell.tsx`, with the centred welcome in `components/chat-welcome.tsx`) is shared by the app workspace, the product workspace, Build and Earn: the chat on the left, alone and centred until the page has something for the right, then a right panel in a 2fr / 3fr split with a tab strip. Every tab stays mounted while another is shown. Tabs are live: read when opened or when the page comes back into view, and every 30 seconds while the tab and the page are visible, never while hidden.

**Slash commands** (`lib/slash-commands.ts`, `components/assistant-ui/slash-command-menu.tsx`) work in every chat composer. Typing `/` at the start of the input, or the composer's `/` button, opens a list filtered by what is typed. A command either runs something the chat already does or fills the input with a prompt to finish. Each chat passes its own commands.

**Chats kept on Mynt** (`lib/chat-sessions.ts`, `app/api/threads`). Earn's conversations and the financial-product chats are sessions of append-only events on Mynt, saved at the first question, when a reply settles and when a draft's outcome changes, and retried when a save fails. Only the user reads their own; at most 200 per user. Chats an older Studio kept in this browser's `localStorage` are uploaded once and cleared there.

### Ask AI and Earn's assistant

`components/ask-ai.tsx`, `lib/ask.ts`, `app/api/ask`, `components/earn-assistant.tsx`, `app/api/earn`.

- Ask AI reads the user's Mynt data through Mynt's tools as the signed-in user, never an app key.
- Limits per question: 4,000 output tokens per step, 8 steps, 8 reads per step and 24 per question (4 at a time), 8,000 characters of each reply to the model, a 64 KB request body, and 20 questions per user per hour.
- Questions and answers are never logged. The model's summarized thinking is streamed as reasoning parts and never logged or kept.
- Earn's assistant is the same stack with its own hourly count (20) and instructions (`EARN_SYSTEM_PROMPT`). It reads only `list_pools`, `list_pools_with_health`, `list_product_health`, `list_my_positions`, `list_withdrawals` and `get_product`, and is never offered a write tool.
- Earn's panel tools are answered by Studio, not Mynt: `show_pools` puts matching pools in the panel (only pools the user can see), and `draft_commitment` and `draft_withdrawal` put a draft there, checked on the server against the pool's current terms and the user's position. A draft is only a card; the user's click sends it, with an idempotency key.

### Earn, wallets and the treasury

`lib/wallets.ts`, `lib/wallets-server.ts`, `lib/browser-wallet.ts`, `app/api/earn/treasury/*`.

- Amounts on rails are integer cents from Mynt, shown as US dollars. USDC amounts are base units (6 decimals), a number or, above 2^53, a decimal string; they are read with `BigInt`, never through a float.
- The wallet picker sends the chosen wallet with every Earn message as an address only. The server checks it is one of the user's verified wallets (`get_linked_accounts`) and reads its balances itself (`get_wallet_balances`).
- On-chain deposits and withdrawals are devnet only. Mynt prepares an unsigned transaction (`prepare_treasury_deposit`, `prepare_treasury_withdrawal`); Studio hands it, untouched, to the user's own browser wallet through the Wallet Standard (`@wallet-standard/app`, `@solana/wallet-standard-features`). Nothing in Studio signs.
- The prepare route checks Studio's own origin, a liquidity provider, a verified linked Solana wallet, a devnet treasury (and for a withdrawal, an on-chain deposit Mynt lists as the user's), takes one prepare per idempotency key, and refuses any reply that isn't devnet or isn't a signable transaction for that wallet. Mainnet is never offered.
- A blockhash lasts about a minute, so a transaction prepared more than 45 seconds before signing is prepared again first, and signed only if Mynt's new summary is the same.
- The status follows Mynt's `not_found`, `processed`, `confirmed`, `finalized` and `failed` (`get_treasury_tx_status`): it waits on the first two and stops on the rest. Mynt indexes a confirmed transaction in the background, so positions are read again 2, 5 and 10 seconds after confirming.
- Mynt's coded refusals are shown in plain words (`TREASURY_REFUSALS` in `lib/wallets.ts`): `offering_not_cleared`, `under_minimum`, `terms_changed`, `insufficient_usdc`, `attester_removed`, `rpc_unavailable`, `deposit_not_found`, `deposit_rejected`, `in_review`, `deposit_locked`, `below_min_request`, `attesters_changed`, `rate_limited`, `wrong_cluster` and the rest.
- A pool whose treasury program isn't a verified build (`verified_build: false`) is shown as an unverified build on its card, its positions and the summary. A pool whose treasury Mynt flagged (`attesters_flag`) refuses deposits on the card, in the assistant's drafts and in the prepare route.
- The investor view reads on-chain deposits from `list_my_positions` rows' `deposits[]` (their `unlock_at` and `review_until`), withdrawal requests' `payable_at`, and rails withdrawals' `eligible_at`.
- Earn's data loads per section: one section Mynt's reply breaks is left out and logged, not a 502 for the page.

### Previews

Previews are framed straight from their own origins, never proxied through Studio, in an iframe with `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"` (no top-level navigation) and `referrerpolicy="no-referrer"`. Only `https` URLs are framed. Preview URLs are capabilities: they are sent only to their owner's browser and never logged.

The preview is a build's live preview while it is being coded (`live_preview_url`), else the preview Mynt made when it verified the build (`preview_url`). Studio has no code view.

### Security headers

`proxy.ts` sets a Content-Security-Policy per request:

- Scripts run only with that request's nonce (`'strict-dynamic'`, no `'unsafe-inline'` for scripts), so pages are rendered per request.
- `frame-src` is exactly `PREVIEW_FRAME_SRC`, the e-signature signing origins Mynt publishes (`/esign/frame-origins`, read every few minutes; `lib/esign-frame.ts`) and `ESIGN_FRAME_SRC`.
- `frame-ancestors 'none'`, with `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.

Serve Studio on its own host, not on a parent domain that hosted apps share.

## Design rules

- **Tabs show, actions change.** A tab is a read view. Every change is a labelled button that opens a sheet.
- **Lists** are one toolbar row (a full-width search, one Filters popover, labelled Import and Export CSV, then the tab's own call to action, named for what it adds) over a table paged 25 rows at a time. No icon-only buttons.
- **Details** have a metadata card on top, then a tab selector, and each tab is a table.
- **Unmeasured is never 0.** A figure Mynt doesn't measure reads "Not measured"; a chart shows a gap.
- **Statuses** are a coloured dot and their words, never colour alone.
- **Tab bars** are shadcn's line tabs (`components/ui/tabs.tsx`): left-aligned labels, muted until active, the active one with a 2px underline, no pill and no accent colour; arrow keys move between tabs.
- **Branding.** The app icon, a mint circle, is Studio's only brand mark: there is no logo or wordmark in the UI. The theme (`app/globals.css`) is shadcn's neutral palette, with the icon's mint (`lib/brand.ts`) only as the accent: primary buttons, focus rings, links (`--link`, a deeper green on light for contrast) and the first chart colour. The active sidebar row is neutral.
- **Theme.** Light, dark or the system's theme is picked in the header (`components/theme-switcher.tsx`, next-themes). The `dark` class is set before the page paints by an inline script carrying the request's CSP nonce.
- **Contrast.** Text pairs are checked for WCAG AA in both themes in `test/branding.test.tsx`.
- **Type.** Headings are in Space Grotesk and body text in DM Sans, which Next downloads when it builds and serves itself.
- **Metadata.** The tab icon (`app/icon.tsx`), the home-screen icon (`app/apple-icon.tsx`), the share image (`app/opengraph-image.tsx`) and the manifest (`app/manifest.ts`) are Next's file-based metadata, served without sign-in. Each page's tab title is "<page> · Mynt Studio"; inside an app it is the app's name.
- **Brand icons.** GitHub shows the GitHub mark (Simple Icons, CC0, `components/brand-icons.tsx`, `UPSTREAM.simple-icons.json`), drawn in the text colour. A wallet shows its own app's icon and name as the Wallet Standard reports them.
- **Words.** Mynt is "Lovable for finance apps". CI fails on wording Mynt doesn't use.

Mynt's hosted sign-in page is branded in the sign-in provider's dashboard, not here.

## Built on Adorable

Mynt Studio is built on [Adorable](https://github.com/freestyle-sh/Adorable) by Freestyle, an open-source chat-to-app builder, used under the MIT licence ([LICENSE](LICENSE)). The files we kept are from commit `1102a75e1d71b2aa6e74ad43c6096c736122fff3`, `adorable/` folder ([UPSTREAM.json](UPSTREAM.json)). Thank you to the Adorable authors.

Only the files we use were copied; the rest of Adorable was never added to this repository. What we changed:

| Area | Change |
|---|---|
| Removed | Every direct call to Freestyle (`lib/freestyle.ts`, `project-vm.ts`, `identity-session.ts`, the base-snapshot script and the `freestyle` package); Adorable's own agent and model keys (`create-tools.ts`, `system-prompt.ts`, `llm-provider.ts`, `suggestions.ts`, the Mastra packages); the API-key paste flow (`api/api-key`, `components/api-key-gate.tsx`); its project storage (`lib/project-storage.ts`, `project-access.ts` and the `/api/projects/*` routes); the in-browser terminal (`vm-terminal.tsx`, `terminal-bridge.ts`); publishing, rollback and custom domains (`publish.ts`, `publish-dialog.tsx`); its deploy workflow; and its logo |
| Sign-in | Adorable's API-key gate is replaced by signing in with a Mynt account (`proxy.ts`, `lib/page-gate.ts`, `app/api/auth/*`), the same OAuth flow as the sample chat. There is no sign-in page of Studio's own |
| Projects | Projects are your Mynt apps (`list_my_apps`), and a project's conversations are its coding-agent builds (`list_builds`), read from Mynt on each load (`app/api/projects`, `lib/projects.ts`, `lib/project-types.ts`) |
| Workspace shell | `app/(studio)/[projectId]/project-workspace-shell.tsx` is the chat workspace with the app's right-hand tabs. The terminal pane and the publish button are gone. The project page lists the app's builds instead of Adorable's chats. Adorable's home page is replaced by the dashboard and Build |
| Chat panel | Adorable's assistant-ui thread and its AI SDK `useChat` wiring are kept. Messages go to Studio's `/api/chat`, which has no model of its own. The attachment button is gone, since the coding agent takes text. Adorable's tool cards draw the agent's commands and file edits |
| Config | Next 16.4 and React 19.3 to match the sample chat; exact dependency versions, with the `@assistant-ui/*` packages pinned to the versions in Adorable's lockfile; a TypeScript target of ES2022; the security headers above |

## Built on shadcn/ui

The sidebar, the dashboard's chart and tables, and the header are [shadcn/ui](https://github.com/shadcn-ui/ui) components and blocks (MIT): `sidebar-07` and `dashboard-01`, added with the shadcn CLI 4.23.0 and adapted to Studio's data. [`UPSTREAM.shadcn.json`](UPSTREAM.shadcn.json) lists each file and what changed. They use `radix-ui` and `recharts`; the dashboard block's Tabler icons were swapped for the `lucide-react` icons Studio already uses. Search is shadcn's Command (cmdk).

## Sign in without a consent screen

Out of the box Studio registers itself with Mynt's sign-in the first time someone signs in, and the sign-in provider then shows each user a consent screen. An operator can instead register Studio once, ahead of time, as one of Mynt's own apps; then nobody sees the screen. Why, and what the server-side command does, is explained once in [Sign-in with Clerk](../../docs/reference/operations.md#sign-in-with-clerk). This section holds Studio's own settings and steps.

1. **Register it, on Mynt's server** (a minute). In the server's `core/` folder, run (the address is a placeholder for Studio's own):

   ```sh
   node dist/index.js clerk first-party mynt-studio https://<studio address>/api/auth/callback --file ~/.mynt/oauth-mynt-studio.json
   ```

   It prints the client id. The id and its secret are written to that file, which only you can read; the secret is never printed. The callback address must be exactly `$APP_URL/api/auth/callback`.
2. **Give them to Studio** (a few minutes). Open the file yourself (`cat ~/.mynt/oauth-mynt-studio.json`) and copy the two values into Studio's host settings:
   1. Open your Vercel dashboard, then Studio's project.
   2. Go to **Settings**, then **Environment Variables**.
   3. Add a variable named `MYNT_OAUTH_CLIENT_ID` and paste the `client_id` value.
   4. Add a variable named `MYNT_OAUTH_CLIENT_SECRET`, paste the `client_secret` value, and mark it **Sensitive**.
   5. Click **Save**.
3. **Redeploy Studio.** In Vercel, open **Deployments**, then the latest one's menu, then **Redeploy**. Sign out and in again to check: there is no consent screen. Then delete the registration file: `rm ~/.mynt/oauth-mynt-studio.json`.

What Studio does with them:

- The secret stays on Studio's server. It is sent only to the authorization server's token endpoint (HTTP Basic, or the form body if that is all the server accepts), and never to a browser or a log.
- Set both settings or neither. One without the other stops Studio from starting a sign-in. Without them, it registers itself.
- Also set `MYNT_OAUTH_ISSUER` to the sign-in provider's address, exactly as Mynt's `/.well-known/oauth-protected-resource` lists it under `authorization_servers`. The secret is then only ever sent there: if Mynt's settings ever named another sign-in server, sign-in and token refresh would stop rather than hand the secret to it.
- If `APP_URL` changes, register again under a new name with the new callback address, and replace both values. To replace the secret, rotate it in the sign-in provider's dashboard.

## Host it on Vercel

Vercel builds Studio as a standard Next.js app. `vercel.json` only sets the install command.

1. Import the repository into Vercel, set the project's **Root Directory** to `platform/studio`, and leave "Include files outside the root directory" on. `vercel.json` sets the install command to `npm ci -w .`: from the repository's root lockfile it installs only Studio and the sign-in package it imports (`@mynt/auth`, `platform/packages/auth`), not the chat app and never the server in `core/`.
2. In the project's **Storage** tab, connect a Redis database. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. In **Settings**, then **Environment Variables**, add `MYNT_MCP_URL`, `APP_URL` (Studio's own URL), `PREVIEW_FRAME_SRC` and `SESSION_ENCRYPTION_KEY`.
4. Deploy.

### On Mynt's domain

To serve Studio at Mynt's own address instead of its own, go live in this order. The server side is in [Mynt Studio on Mynt's domain](../../docs/reference/operations.md#mynt-studio-on-mynts-domain).

1. **Deploy the edge first.** On Mynt's server, run its host installer (the `install-host` script in `deploy/host/` in this repository) with `<domain> --studio-upstream <Studio's deployment host>`. Mynt keeps its paths (`/mcp`, `/v1`, `/.well-known/*`, `/llms.txt` and the rest), and everything else on the domain is proxied to Studio.
2. **Then point Studio at the domain.** Set `APP_URL` to `https://<Mynt's domain>`, and `TRUSTED_EDGE_IPS` to every public outbound address of Mynt's server, both IPv4 and IPv6.
3. **Redeploy Studio.** Everyone signs in once more, because the new callback address gets its own client registration. With a pre-registered client, register one for the new callback address first and replace `MYNT_OAUTH_CLIENT_ID` and `MYNT_OAUTH_CLIENT_SECRET`.

Once `TRUSTED_EDGE_IPS` is set, people reach Studio only through Mynt's server. A request from any other address without an `X-Mynt-Client-IP` header, for any path (pages, API routes and Next's own assets), gets a 308 to the same path on `APP_URL`. That is what a browser on the deployment address looks like. Requests from the listed addresses are served.

`TRUSTED_EDGE_IPS` must list all of the server's outbound addresses. If one is missing:

- The requests Mynt's server sends from it still arrive with `X-Mynt-Client-IP`, so they are served rather than redirected. There is no redirect loop, and Studio keeps working.
- The header is ignored for them, so every user coming through that address shares one sign-in rate-limit bucket (429 for everyone after 20 starts in 10 minutes).
- Studio logs a warning once per instance naming the address. Add it to `TRUSTED_EDGE_IPS` and redeploy.

A caller who adds the header themselves gains nothing: sign-in, its callback and the session cookie only work on `APP_URL`, and the rate limit counts them by their own address.
