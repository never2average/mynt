# Mynt Studio

A web app where developers build apps on Mynt by chatting with Mynt's coding agent, beside a live preview of what it builds. Developers sign in with their own Mynt account. The studio holds no hosting-provider keys: everything goes through Mynt's MCP server as the signed-in user, and Mynt checks every call. Its one optional model setting is for **Ask AI** (below), on the same model path as Mynt's sample chat; without it, Ask AI says it isn't configured.

Its home page is a dashboard of how your apps are doing: money moved through them, customers, hand-offs and conversion, and build spend, with a chart and a table per app. **New app** takes what you want to build and the products it builds on, creates the app and starts its first build. Open an app to chat with Mynt's coding agent beside its live preview: a message steers the app's running build, or starts a new one. Shipping, deploying and the Files, Diff and Run panels come in the next steps.

**Pages:** a left sidebar on every page, collapsible to icons. At the top is the workspace switcher: your workspaces, then Members and Create workspace. Below it are Dashboard, Coverage, Licences and Audits, then the workspace's apps in three folders by stage (Production, Staging, Ideas), then your account with a Log out button always in view. Everything is scoped to the selected workspace, which is remembered in a cookie. New app (`/new`) and Builds (`/builds`) still work, but aren't in the sidebar. A visit to any page while signed out goes straight to Mynt's sign-in and comes back to that page. The only pages that don't need sign-in are where a failed sign-in lands (`/signin-error`) and where signing out lands (`/signed-out`).

## Built on Adorable

Mynt Studio is built on [Adorable](https://github.com/freestyle-sh/Adorable) by Freestyle, an open-source chat-to-app builder, used under the MIT licence ([LICENSE](LICENSE)). The files we kept are from commit `1102a75e1d71b2aa6e74ad43c6096c736122fff3`, `adorable/` folder ([UPSTREAM.json](UPSTREAM.json)). Thank you to the Adorable authors.

**What we changed.** Only the files we use were copied; the rest of Adorable was never added to this repository.

- **Removed:** every direct call to Freestyle (`lib/freestyle.ts`, `project-vm.ts`, `identity-session.ts`, the base-snapshot script and the `freestyle` package); Adorable's own agent and model keys (`/api/chat`, `create-tools.ts`, `system-prompt.ts`, `llm-provider.ts`, `suggestions.ts`, the AI SDK and Mastra packages); the API-key paste flow (`api/api-key`, `components/api-key-gate.tsx`); its project storage (`lib/project-storage.ts`, `project-access.ts` and the `/api/projects/*` routes); the in-browser terminal (`vm-terminal.tsx`, `terminal-bridge.ts`); publishing, rollback and custom domains (`publish.ts`, `publish-dialog.tsx`); its deploy workflow; and its logo.
- **Sign-in:** Adorable's API-key gate is replaced by signing in with a Mynt account (`proxy.ts`, `lib/page-gate.ts`, `app/api/auth/*`), the same OAuth flow as mynt-chat (`platform/chat`). There's no sign-in page of the studio's own: a signed-out visit goes straight to Mynt's.
- **Projects** are your Mynt apps (`list_my_apps`), and a project's conversations are its coding-agent builds (`list_builds`), read from Mynt on each load (`app/api/projects`, `lib/projects.ts`, `lib/project-types.ts`). The studio stores nothing but the session.
- **Workspace shell** (`app/[projectId]/project-workspace-shell.tsx`): the preview is a build's live preview while it's being coded (`live_preview_url`), else the preview Mynt made when it verified the build (`preview_url`). The terminal pane and the publish button are gone. The project page (`project-welcome.tsx`) lists the app's builds instead of Adorable's chats. Adorable's home page (its "What do you want to build?" over past projects) is replaced by the dashboard and New app.
- **Chat panel** (`app/assistant.tsx`, `components/assistant-ui/thread.tsx`): Adorable's assistant-ui thread and its AI SDK `useChat` wiring, kept. Messages go to the studio's `/api/chat`, which has no model of its own (below). It appears only in an app's workspace. The attachment button is gone, since the coding agent takes text. Adorable's tool cards draw the agent's commands and file edits.
- **Config:** Next 16.4 and React 19.3 to match mynt-chat; exact dependency versions, with the `@assistant-ui/*` packages pinned to the versions in Adorable's lockfile; a TypeScript target of ES2022; security headers (below).

## Built on shadcn/ui

The sidebar, the dashboard and its cards, chart and table are [shadcn/ui](https://github.com/shadcn-ui/ui) components and blocks (MIT): `sidebar-07` and `dashboard-01`, added with the shadcn CLI 4.23.0 and adapted to the studio's data. [`UPSTREAM.shadcn.json`](UPSTREAM.shadcn.json) lists each file and what changed. They use `radix-ui` and `recharts`; the dashboard block's Tabler icons were swapped for the `lucide-react` icons the studio already uses.

## How it fits together

- **Sign-in** is real Mynt user authentication: OAuth with PKCE, as a client an operator registered once (below) or else with dynamic client registration, run on the server by the MCP SDK. Tokens never reach the browser. Only people whose Mynt roles include developer (or innovator, or admin) get past the project list.
- **Shared with mynt-chat:** the sign-in code (session cookie, OAuth provider, Mynt client and the `app/api/auth/{login,callback,logout}` handlers) is the `@mynt/auth` package in `platform/packages/auth`, which both apps import. `lib/session.ts`, `lib/mynt-client.ts` and the route files only hand it this app's settings, cookie name and session store. Each app has its own `lib/config.ts`, `lib/app-session.ts` and `lib/session-store.ts`.
- **Mynt tools** are called only through the `STUDIO_TOOLS` allow-list (`lib/studio-tools.ts`), which checks each tool's arguments with zod. Besides read-only tools it holds `start_build` and `steer_build` (the chat), `create_app` (New app), `get_developer_dashboard` and `get_linked_accounts` (the dashboard), the compliance pages' reads (`get_compliance_coverage`, `list_workspace_licences`, `list_workspace_audit`), the invitation tools (`list_my_invitations`, `accept_workspace_invite`, `decline_workspace_invite`), and the workspace tools (`list_workspaces`, `create_workspace`, `rename_workspace`, `list_workspace_members`, `invite_to_workspace`, `revoke_workspace_invite`, `change_member_role`, `remove_workspace_member`, `leave_workspace`). `vm_access`, `app_run` and admin tools are never on it.
- **The chat** (`app/api/chat/route.ts`, `lib/chat.ts`). A message steers the app's running build (the one on screen, else its newest), or starts a build for the app with the message as its goal. Where this Mynt offers session builds (its tool list has `finish_build`, and `start_build` takes `mode` and `continue_from`), the build starts in session mode and carries on from the app's last pushed build; otherwise it's a plain build. The reply streams the agent's activity (`get_build_activity`) as AI SDK UI message parts until it has answered, the build finishes, or about 3.5 minutes pass; the build carries on regardless. A message is claimed per Mynt user and app before it's sent (by its id for 10 minutes, by its text for 30 seconds), and given back only when Mynt refused it before changing anything (a permission, state, argument or budget check); after any other error, a timeout or a lost reply it may have arrived, so the claim stays. Starting a build takes a lock per user and app (130 seconds, longer than listing builds and starting one together can take), then lists the app's builds again and decides again (another device may just have started one); the lock is released once the start is done, when the new build is listed. Claims and locks are released only by their holder. When a steer may have arrived just as the agent finished its turn (no session builds), the chat says so. Activity is followed by Mynt's cursor where it has one, and otherwise by comparing each poll with the last. Opening a past build rebuilds its conversation from its goal, the messages steered into it, and its stored activity.
- **Workspaces** (`lib/workspaces.ts`, `lib/workspace-server.ts`, `components/workspace-context.tsx`).
  - The switcher (shadcn's `sidebar-07` team switcher) picks the workspace that the dashboard, the sidebar's apps and Members show. The choice is kept in the `__Host-mynt_workspace` cookie, which the API routes read too. It isn't a credential: Mynt checks membership on every call. A remembered cookie naming a workspace the user has left falls back quietly to Personal; a page that asks for that workspace by name says the user is no longer a member, never showing Personal data under its name.
  - Each part waits for Mynt to offer it: `list_workspaces`, and `workspace_id` on `list_my_apps`, `get_developer_dashboard`, `list_builds` and `create_app`. Until Mynt has workspaces there's one implicit Personal workspace.
  - A shared workspace never shows the user's unscoped data: where a tool can't be scoped to it yet, its apps and dashboard say they're not available yet, and New app is refused there rather than creating the app somewhere else.
  - Only one build starts at a time per app, whoever starts it, so two teammates can't start two paid builds on one app.
  - An app's folder is Mynt's `stage` (production, staging or idea). Until Mynt gives one, it's derived: published apps are Production; an app whose last build succeeded or has a preview is Staging; anything else is an Idea.
- **Members** (`/members`, `app/api/workspaces/[workspaceId]/members`) lists the workspace's members and pending invites.
  - Owners and admins can invite by email (admin or member), change roles, remove members and revoke invites. The studio checks the user's role before anything reaches Mynt, and Mynt checks again.
  - Everyone else sees the list only.
  - Ownership isn't changed from here.
- **Invitations** (`app/api/invitations`, `components/invitations.tsx`): joining a workspace is always explicit, never automatic.
  - Pending invitations (`list_my_invitations`) show as a banner on the dashboard and as **Invitations (N)** in the switcher's menu.
  - Each one names the workspace, who invited the user, the role and what accepting grants on Mynt, with **Accept** and **Decline** (`accept_workspace_invite`, `decline_workspace_invite`). These are sent by POST from the studio's own origin, and only for an invitation Mynt lists as the user's.
  - After accepting, the studio switches to the joined workspace.
- **New app** always names the workspace for `create_app`: the selected one, or in Personal the user's own workspace (the one `list_workspaces` marks personal). Mynt doesn't default into workspaces the user was invited to. If there's no workspace to name, or Mynt asks for one, the user is asked to choose a workspace in the switcher.
- **Coverage** (`/coverage`, `components/coverage-view.tsx`) is a map of US states (react-simple-maps, MIT, over us-atlas, ISC), each coloured unlocked, available or unavailable for the workspace from `get_compliance_coverage`.
  - Hovering a state shows its name, status and partner count. Clicking it opens a side panel with its partners, licences, products and rails.
  - A legend counts the states by status, and **List view** shows the same data as a table.
  - Colours (`app/globals.css`): Unlocked is the most prominent, a strong bright blue; Available is a muted blue of the same hue; Unavailable is neutral grey. They were checked with the dataviz validator on both the light and dark surfaces. Status is always named in words too.
- **Licences** (`/licences`) lists the partner licences behind the workspace's products (`list_workspace_licences`), with a search, filters by status, regulator and state, and **Export CSV**.
  - Expired licences, and those expiring within 60 days, are marked with an icon and words as well as a tinted row.
- **Audits** (`/audits`) is the workspace's audit trail (`list_workspace_audit`), a page at a time by Mynt's cursor.
  - Mynt filters it by action, member, app and date range. The search box searches the page shown, and **Export CSV** exports it.
- Each compliance page says "not available yet" until Mynt has its tool, and for a shared workspace the tool can't be scoped to yet. It never shows an empty map or table in that case.
- **Header** (`components/site-header.tsx`): sticky on every page outside an app, with only the page's name (the switcher shows the workspace), **Search or ask AI** and **New app** (the `/new` flow). Inside an app, the app's own top bar takes its place (`components/app-top-bar.tsx`): back, the app's name and stage, the preview's back, forward, reload and path, its width (desktop, tablet, phone), open in a new tab, and search and New app as icon buttons.
- **Search and Ask AI** (`components/studio-search.tsx`, `components/ask-ai.tsx`, `app/api/ask`): the header's search field (or Cmd+K / Ctrl+K) opens a modal that searches the studio's pages, the workspace's apps by name or stage, members, licences and audit actions, with the arrow keys and Enter (shadcn's Command, cmdk). **Ask AI** switches the modal to a streamed conversation (follow-ups, Stop, New chat) that reads the user's Mynt data through Mynt's tools as the signed-in user, never an app key, and only the read tools listed in `lib/ask.ts`. Questions and answers are never logged. Limits per question: 4,000 output tokens per step, 8 steps, 8 reads per step and 24 per question (4 at a time), 8,000 characters of each reply to the model, a 64 KB request body, and 20 questions per user per hour. Only links to studio pages in an answer are clickable. With no model configured it says "AI is not configured" and search keeps working.
- **Dashboard tiles** beside the money cards: active products, licences (linking to `/licences`), GitHub and crypto wallet.
  - GitHub and the wallet come from `get_linked_accounts`.
  - The wallet's network is shown only when its address fits: an EVM address (`0x` and 40 hex digits) on an EVM chain, or a Solana address (base58, 32 to 44 characters) on Solana. Anything else says "Unknown network".
  - **Link GitHub** and **Link wallet** open the identity provider's account page (its `manage_url`, `https` only) in the same tab. The studio never embeds a sign-in, and the dashboard reads the accounts again when the user comes back.
  - Before Mynt has the tool, the buttons show but are disabled.
- **The dashboard** (`app/api/dashboard`, `lib/dashboard.ts`) reads Mynt's `get_developer_dashboard` where Mynt offers it. Until then it's built from `list_my_apps` and `list_builds`: apps, their last builds and build spend. A figure Mynt doesn't measure is shown as "Not measured" (earnings: "Not tracked yet"), never as 0.
- **New app** (`app/api/apps`, `lib/new-app.ts`) calls `create_app` with the products picked (its name is the prompt's first sentence, its description the whole prompt), then `start_build` with the prompt as the goal, in session mode where Mynt offers it, and opens the app's workspace on that build. The same request twice creates one app.
- **Sign-in, page by page.** `proxy.ts` sends a signed-out visit to any page straight to `/api/auth/login?next=<that page>`. The login route keeps `next` only if it's a relative path on the studio (`safeReturnPath` in `@mynt/auth`), and the callback goes back there. A failed sign-in lands on `/signin-error` and signing out on `/signed-out`. Neither needs a sign-in, so a failure can't loop, and signing out doesn't sign straight back in while the authorization server still has a session.
- **Sessions** (`lib/session-store.ts`). The browser holds only a random session id, in an `httpOnly`, `SameSite=Lax` cookie that is `Secure` and `__Host-`-prefixed everywhere except plain-http localhost. The session itself (OAuth tokens, the PKCE verifier, the user's roles) lives on the server, in a hosted Redis database when one is configured, and in memory otherwise (local development and tests). Every stored value is encrypted with AES-256-GCM (full 16-byte tags only) using `SESSION_ENCRYPTION_KEY`, names the key that sealed it, and is stored under a hash of the session id. Lifetimes match mynt-chat: a session that never finishes signing in expires after 10 minutes, a signed-in one after 7 days without use; the cookie's expiry moves with the server's.
- **Several requests at once.** Each request works on its own copy of the session, so the store guards against them undoing each other:
  - A request that finishes after sign-out can't bring the session back: saving only replaces a stored session (Redis `SET XX`), and only sign-in creates one (`SET NX`).
  - A request never writes older tokens over newer ones.
  - Tokens are refreshed ahead of expiry, before calling Mynt, by one request at a time per session (a short lock in Redis, released only by its holder, `lib/tokens.ts`); the others wait and pick up the new tokens. Refresh tokens are single-use, so two refreshes at once would otherwise sign the user out.
  - Only the authorization server rejecting the refresh token or the client (`invalid_grant`, `invalid_client`) signs the user out. A timeout (10 s for the whole refresh, discovery included), a 5xx or a network error keeps the tokens and answers 502.
  - Tokens and the client registration are bound to the authorization server that issued them. If discovery ever names a different one, the refresh token isn't sent there and the user signs in again.
  - A request clears tokens Mynt refused only if they're still the stored ones; if another request has refreshed them meanwhile, it picks those up instead.
  - The app's client registration doesn't expire while it's used, and is re-sealed with the current key when read after a rotation. One refused sign-in doesn't drop it (every user's refresh token depends on it); three refusals of the same client within an hour do, and the next sign-in registers again.
  - The workspace never has two project loads in flight.
- **Roles** come from Mynt's `whoami` and are read again every 5 minutes, so a revoked developer role takes effect without signing out. Mynt checks every call itself regardless. When Mynt stops accepting a session's sign-in mid-request, the studio answers 401 and signs the session out.
- **Sign-in rate limit.** Starting sign-in creates a session before anyone is signed in, so each address may start it 20 times per 10 minutes (counted atomically in Redis, in `proxy.ts`); after that it gets a 429. IPv6 addresses count per /64. The address comes only from a header callers can't forge: on Vercel its `x-vercel-forwarded-for`; elsewhere the header named in `TRUSTED_PROXY_HEADER`. Without one, all callers share a bucket of 200.
- **Previews** are framed straight from their own origins, never proxied through the studio, in an iframe with `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"` (no top-level navigation) and `referrerpolicy="no-referrer"`. Only `https` URLs are framed. Preview URLs are capabilities: they're sent only to their owner's browser and never logged.
- **Security headers:** a Content-Security-Policy set per request by `proxy.ts`. Scripts run only with that request's nonce (`'strict-dynamic'`, no `'unsafe-inline'` for scripts), so pages are rendered per request. `frame-src` is exactly `PREVIEW_FRAME_SRC`, and `frame-ancestors 'none'`. Also `X-Frame-Options: DENY` and `nosniff`. Serve the studio on its own host, not on a parent domain that hosted apps share.

## Settings

| Variable | What it is |
|---|---|
| `MYNT_MCP_URL` | Mynt's MCP endpoint, like `https://mynt.example.com/mcp`. |
| `APP_URL` | The studio's public URL. Sign-in returns to `$APP_URL/api/auth/callback`. Served on Mynt's domain, it's that domain. Changing it registers the studio with Mynt's sign-in again (the registration is kept per callback address). |
| `TRUSTED_EDGE_IPS` | Served on Mynt's domain only: every public outbound address of Mynt's server, IPv4 and IPv6, comma-separated. Requests from these addresses are served, and the caller's address is taken from their `X-Mynt-Client-IP`. Browsers coming from anywhere else are sent to `APP_URL`. A missing address puts every user coming through it in one sign-in rate-limit bucket, and the studio logs a warning naming it. |
| `PREVIEW_FRAME_SRC` | The origins previews are served from, space-separated `https` origins with optional wildcards, like `https://*.preview.example`. Unset, no preview can be shown. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | The Redis database for sessions. Vercel sets these when you connect a Redis database to the project. Upstash's own names, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, work too. |
| `SESSION_ENCRYPTION_KEY` | 32 random bytes, base64-encoded, that encrypt the stored sessions. Required with Redis. |
| `SESSION_ENCRYPTION_KEYS_OLD` | Optional: earlier keys, comma-separated, that still decrypt sessions sealed before a rotation (below). |
| `TRUSTED_PROXY_HEADER` | Off Vercel only: the header your proxy sets to the caller's address (for example `x-real-ip`), for the sign-in rate limit. Its last value is used (what the proxy appended), so it must be a header the proxy sets or appends to. |
| `SESSION_STORE` | Optional: `memory` allows the in-memory store with `NODE_ENV=production` (one local process only, never on Vercel). |
| `MYNT_OAUTH_SCOPE` | Optional: the scopes to ask for. |
| `MYNT_OAUTH_CLIENT_ID`, `MYNT_OAUTH_CLIENT_SECRET` | Optional, both or neither: the OAuth client registered for the studio with `mynt clerk first-party`, so users see no consent screen (see *Sign in without a consent screen*). Unset, the studio registers itself. Server-only. |
| `MYNT_OAUTH_ISSUER` | Optional, with the client above: the only authorization server its secret may be sent to. |
| `ANTHROPIC_API_KEY`, or `VERTEX_PROJECT_ID` and `VERTEX_REGION` | Optional: the model for **Ask AI**, set the same way as for Mynt's sample chat (`platform/chat`): Claude through the Claude API, or through Google Vertex AI. `CHAT_MODEL` picks the model. Unset, Ask AI says "AI is not configured" and search still works. Server-only. |

The Redis client is [`@upstash/redis`](https://github.com/upstash/redis-js), Upstash's official client, which talks to Redis over HTTPS and so works from serverless functions. Without Redis settings, sessions stay in the server's memory, which is fine for `npm run dev`. On Vercel the studio refuses to start that way, because its function instances share no memory, and in production it refuses too unless `SESSION_STORE=memory` says it's wanted.

**Release note: everyone signs in again once.** Sessions are now sealed in a format that names their key (`v2`). Sessions and the client registration sealed before it can't be read, so after this version is deployed, everyone signs in once more. No data is lost; nothing else is kept in the store.

**Rotating the encryption key.** Make a new key with `openssl rand -base64 32`. Set it as `SESSION_ENCRYPTION_KEY`, put the old one in `SESSION_ENCRYPTION_KEYS_OLD`, and redeploy. Existing sessions keep working and are re-sealed with the new key as they're used. After 7 days, every session sealed with the old key has expired, and the old key can be removed. Removing it sooner signs out whoever it still covers.

## Sign in without a consent screen

Out of the box the studio registers itself with Mynt's sign-in the first time someone signs in, and Clerk then shows each user a consent screen asking them to allow it access. Clerk doesn't let a self-registered app turn that screen off. An operator can instead register the studio once, ahead of time, as one of Mynt's own apps; then nobody sees the screen. It still signs in with PKCE, and Mynt still checks every call against the user's roles.

**1. Register it, on Mynt's server** (a minute). In Mynt's folder there, run (the address is a placeholder for the studio's own):

```bash
node dist/index.js clerk first-party mynt-studio https://<studio address>/api/auth/callback --file ~/.mynt/oauth-mynt-studio.json
```

It prints the client id. The id and its secret are written to that file, which only you can read; the secret is never printed. The callback address must be exactly `$APP_URL/api/auth/callback`.

**2. Give them to the studio** (a few minutes). Open the file (`cat ~/.mynt/oauth-mynt-studio.json`) and copy the two values yourself:

1. Open your Vercel dashboard, then the studio's project.
2. Go to **Settings**, then **Environment Variables**.
3. Add a variable named `MYNT_OAUTH_CLIENT_ID` and paste the `client_id` value.
4. Add a variable named `MYNT_OAUTH_CLIENT_SECRET`, paste the `client_secret` value, and mark it **Sensitive**.
5. Click **Save**.

**3. Redeploy the studio.** In Vercel, open **Deployments**, then the latest one's menu, then **Redeploy**. Sign out and in again to check: there's no consent screen. Then delete the registration file: `rm ~/.mynt/oauth-mynt-studio.json`.

The secret stays on the studio's server. It's sent only to the authorization server's token endpoint (HTTP Basic, or the form body if that's all the server accepts), and never to a browser or a log. Set both settings or neither: one without the other stops the studio from starting a sign-in. Without them, it registers itself as before. Also set `MYNT_OAUTH_ISSUER` to Clerk's address, exactly as Mynt's `/.well-known/oauth-protected-resource` lists it under `authorization_servers` (open that address on Mynt's domain to see it). The secret is then only ever sent there: if Mynt's settings ever named another sign-in server, sign-in and token refresh would stop rather than hand the secret to it. If `APP_URL` changes, register again under a new name with the new callback address, and replace both values. To replace the secret, rotate it in Clerk's dashboard.

## Run it locally

```bash
cd platform/studio
cp .env.example .env.local   # then fill in MYNT_MCP_URL
npm ci -w .                  # the studio and @mynt/auth, from the repository's root lockfile
npm run dev
```

Open http://localhost:3000 and sign in with your Mynt developer account.

Checks: `npx vitest run`, `npx tsc --noEmit` and `npx next build`. CI runs them and fails on wording Mynt doesn't use or on a hostname or IP address in this folder.

## Host it on Vercel

No `vercel.json` is needed: Vercel builds it as a standard Next.js app.

1. Import the repository into Vercel and set the project's **Root Directory** to `platform/studio`, and leave "Include files outside the root directory" on. `vercel.json` sets the install command to `npm ci -w .`: from the repository's root lockfile it installs only the studio and the sign-in package it imports (`@mynt/auth`, `platform/packages/auth`), not the chat app and never the server in `core/`.
2. In the project's **Storage** tab, connect a Redis database. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. In **Settings → Environment Variables**, add `MYNT_MCP_URL`, `APP_URL` (the studio's own URL), `PREVIEW_FRAME_SRC` and `SESSION_ENCRYPTION_KEY`.
4. Deploy.

**On Mynt's domain.** To serve the studio at Mynt's own address instead of its own, go live in this order:
1. **Deploy the edge first.** On Mynt's server, run its host installer (`deploy/host/install-host` in this repository) with `<domain> --studio-upstream <the studio's deployment host>`. Mynt keeps its paths (`/mcp`, `/v1`, `/.well-known/*`, `/llms.txt` and the rest), and everything else on the domain is proxied to the studio. See *Mynt Studio on Mynt's domain* in `docs/reference.md`.
2. **Then point the studio at the domain.** In the studio's settings, set `APP_URL` to `https://<Mynt's domain>`, and `TRUSTED_EDGE_IPS` to every public outbound address of Mynt's server, both IPv4 and IPv6.
3. **Redeploy the studio.** Everyone signs in once more, because the new callback address gets its own client registration. With a pre-registered client, register one for the new callback address first and replace `MYNT_OAUTH_CLIENT_ID` and `MYNT_OAUTH_CLIENT_SECRET`.

Once `TRUSTED_EDGE_IPS` is set, people reach the studio only through Mynt's server. A request from any other address without an `X-Mynt-Client-IP` header, for any path (pages, API routes and Next's own assets), gets a 308 to the same path on `APP_URL`. That's what a browser on the deployment address looks like. Requests from the listed addresses are served.

`TRUSTED_EDGE_IPS` must list all of the server's outbound addresses. If one is missing, the requests Mynt's server sends from it still arrive with `X-Mynt-Client-IP`, so they're served rather than redirected: no redirect loop, and the studio keeps working. But the header is ignored, so every user coming through that address shares one sign-in rate-limit bucket (429 for everyone after 20 starts in 10 minutes). The studio logs a warning once per instance naming the address; add it to `TRUSTED_EDGE_IPS` and redeploy. A caller who adds the header themselves gains nothing: sign-in, its callback and the session cookie only work on `APP_URL`, and the rate limit counts them by their own address.
