# Mynt chat (sample)

Mynt is like Lovable for finance apps: you describe the financial product you need or want, in a chat, and Mynt finds it in its catalogue or, if nothing fits, files a product request for Mynt's product teams (innovators) to build.

This is a sample **consumer app** for that: a mobile-first chat where you say what you need, in your own words. The assistant asks one question at a time, finds matching products through Mynt's MCP server, and shows each one as a **product card** with its terms, **Accept** and **Look for more options**. When nothing fits, it proposes a product request; if you tap **Send request**, it goes to Mynt with `request_product`, so Mynt's product teams can build options for you.

It is a Next.js (App Router) app with plain CSS. It works from 320px wide up to desktop, follows light and dark mode, and can be installed as a PWA.

## How it works

```
browser ──cookie (session id only)──▶ Next.js server ──OAuth tokens──▶ Mynt MCP (/mcp)
                                          │
                                          └──▶ Claude (Vertex AI or the Claude API)
```

- **Sign-in.** The app is an MCP client of Mynt and signs in with the MCP TypeScript SDK's OAuth support. `/api/auth/login` lets the SDK read Mynt's OAuth metadata, find its authorization server, register this app (dynamic client registration), and start an authorization-code flow with PKCE. `/api/auth/callback` checks `state`, exchanges the code, and moves the tokens to a fresh session id with an empty chat. `/api/auth/logout` (POST, same origin only) ends the session. Someone already signed in who opens `/api/auth/login` just goes back to the chat.
- **Sessions.** The browser holds only a random session id in an `httpOnly`, `SameSite=Lax` cookie, which is `Secure` everywhere except plain-http localhost. OAuth tokens, the PKCE verifier and the conversation stay in a server-side store and are never sent to the browser. The store is an in-memory `Map` (`lib/session-store.ts`), so sessions are lost on restart and aren't shared between instances. Sessions that never finish signing in expire after 10 minutes, and the store holds at most 10,000 sessions. For production, back it with Redis or a database and encrypt the tokens at rest.
- **Chat.** `/api/chat` runs Claude server-side with adaptive thinking and streams the reply to the browser as server-sent events. Claude's tools are the signed-in user's Mynt tools, listed through the MCP client and called through it. The app offers only a consumer allow-list of those tools (`CHAT_TOOLS` in `lib/mynt.ts`), plus two local tools, `show_product_card` and `propose_product_request`. Tools that act for the user (enrolling, sending a request) are never offered to Claude. If the phone locks mid-reply, the turn still finishes on the server, and a reload shows it.
- **Cards.** Claude picks the product, a one-line summary and the terms to show. The server fetches the product with `get_product` and builds the card itself: the title and provider come from Mynt, the product must be published, and every term value must appear in Mynt's reply, or the card is refused. So text in a tool result (a product description, an innovator's note) can't put made-up terms on a real product.
- **Accept.** Claude can't enrol anyone. Enrolment happens only when the user taps **Accept**: `/api/accept` calls `enroll_in_product` through MCP, only for a product shown in this chat and only once, passing the card's headline amount when it is one amount to borrow or invest. Accepted cards stay accepted after a reload. **Look for more options** sends that text as the next message.
- **Requests.** Innovators read product requests, so Claude can only propose one. The user sees exactly what would be sent and taps **Send request** (`/api/request` then calls `request_product`) or **Not now**.
- **App events.** Accepting or sending a request is told to Claude with the user's next message, never written into the history while a reply is running.

## Developer console

`/developer` is a console for developers: their coding-agent builds and their hosting, through the same signed-in MCP session as the chat (no extra credentials). It shows to signed-in users whose Mynt roles (from `whoami`) include developer; Mynt checks every call again.

- **Builds.** A searchable table of `list_builds` (status, goal, cost against the cap, created) with this month's spend. A build opens with its facts on top (`get_build`), the actions **Open in VS Code**, **Steer** and **Stop build**, and tabs: **Activity** (`get_build_activity`), **Timeline**, **Files** (a folder browser over `sandbox_files`), **Diff** (`sandbox_diff`: changed files, then the full diff) and **Run** (a command box for `sandbox_run`, with each command's output).
- **Hosting.** Your VM from `hosting_status` (or **Request hosting**), **Deploy an app** from a succeeded build, **SSH login** (`vm_access`), and a table of hosted apps with their URL, status and error. An app opens with **Restart** and **Undeploy** and tabs **Logs** (`app_logs`), **Status** (`app_status`) and **Run** (`app_run`).
- **Credentials.** The editor password and the SSH login are shown once with a copy button and live only in the page's memory until you hide them or leave. The server passes them through with `Cache-Control: no-store` and never logs or stores them; failed calls are logged by tool name only.
- **Scope.** `/api/developer/tools` calls only the tools listed in `DEV_TOOLS` (`lib/developer.ts`), with their arguments checked. Starting builds and connecting repositories stay in Mynt's own clients.

## Configuration

All configuration is through environment variables. Copy `.env.example` to `.env.local` and fill it in.

| Variable | Required | Meaning |
| --- | --- | --- |
| `MYNT_MCP_URL` | yes | Mynt's MCP endpoint, e.g. `https://<mynt host>/mcp` |
| `APP_URL` | in production | This app's public URL. OAuth redirects go to `$APP_URL/api/auth/callback`. Defaults to `http://localhost:3000`. |
| `VERTEX_PROJECT_ID` | for Vertex | Google Cloud project with Claude enabled in Vertex AI |
| `VERTEX_REGION` | no | Vertex region, default `global` |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | Path to a service-account key; otherwise the machine's default Google credentials are used |
| `ANTHROPIC_API_KEY` | instead of Vertex | Use the Claude API directly. When set, it takes precedence over Vertex. |
| `CHAT_MODEL` | no | Default `claude-opus-5-5` |
| `CHAT_FALLBACK_MODEL` | no | Vertex only: the model to retry on if a request is declined by Claude's safety classifiers. Default `claude-opus-4-8`. (On the Claude API the fallback happens server side.) |
| `MYNT_OAUTH_SCOPE` | no | Scopes to request. Default `openid profile email`. |
| `CHAT_DAILY_MESSAGES` | no | Messages each Mynt user may send per day (UTC). Default `50`; `0` turns the cap off. Counted in memory, so run a single instance. |

On Mynt's side, the authorization server (Clerk) must allow dynamic client registration. Mynt itself needs no change: the user signs in as an ordinary Mynt user, and what they can do follows their Mynt roles.

**Public use.** Open the chat to anyone by turning on Mynt's public sign-up (an admin runs `set_public_signup` with `enabled: true`). New people who sign in with a verified email become consumers. While sign-up is invite-only, someone Mynt doesn't let in sees Mynt's reason in the chat, not a generic error. The daily message cap keeps an open chat's model costs bounded.

## Run locally

```bash
cd examples/mynt-chat
npm ci
cp .env.example .env.local   # then edit
npm run dev                  # http://localhost:3000
```

To try it on a phone on the same network, set `APP_URL` to the address the phone uses, and register that callback URL.

Checks:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: card/event parsing, transcript, the session store and OAuth provider, the agent loop, the developer console
npm run build
```

`node scripts/make-icons.mjs` regenerates the PWA icons in `public/`.

## Deploy behind a reverse proxy

Build once and run the Node server:

```bash
npm ci && npm run build
APP_URL=https://chat.example.com MYNT_MCP_URL=https://mynt.example.com/mcp VERTEX_PROJECT_ID=... \
  npm start -- -p 3000
```

Put any TLS-terminating reverse proxy in front of it, forwarding to `127.0.0.1:3000`. Requirements:

- **HTTPS.** The session cookie is `Secure`, and the OAuth callback must be HTTPS.
- **Don't buffer `/api/chat`.** It is a long-lived `text/event-stream` response. The app sends `X-Accel-Buffering: no`; also turn off response buffering and allow reads of a few minutes on that path.
- **One instance**, while sessions are in memory (or switch to a shared store first).

For example, with Caddy (placeholders):

```
chat.example.com {
  reverse_proxy 127.0.0.1:3000 {
    flush_interval -1
  }
}
```

or nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_read_timeout 300s;
}
```

## Mobile details

- `100dvh`, plus `visualViewport` tracking for iOS Safari, keep the composer just above the on-screen keyboard. `interactive-widget=resizes-content` does the same on Chrome for Android.
- Safe-area insets pad the header, the composer and the sides (`viewport-fit=cover`).
- Tap targets are at least 44px, and inputs use 16px text so iOS doesn't zoom on focus.
- Light and dark mode follow `prefers-color-scheme`. Hover styles apply only on devices with a real pointer, so nothing stays highlighted after a tap.
- The chat stays pinned to the latest message when the keyboard opens.
- The web manifest (`app/manifest.ts`) and its icons make the app installable. It has no service worker, so it needs a connection to work.

Mynt shows products and their terms; it isn't financial advice.
