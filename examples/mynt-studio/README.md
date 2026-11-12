# Mynt Studio

A web app where developers build apps on Mynt by chatting with Mynt's coding agent, beside a live preview of what it builds. Developers sign in with their own Mynt account. The studio holds no model keys and no hosting-provider keys: everything goes through Mynt's MCP server as the signed-in user, and Mynt checks every call.

**This first version is read-only.** It shows your Mynt apps, and opening one shows its builds and the preview of the newest one (or of the build you pick). The chat panel is there but disabled; chatting with the coding agent, shipping and deploying come in the next steps.

## Built on Adorable

Mynt Studio is built on [Adorable](https://github.com/freestyle-sh/Adorable) by Freestyle, an open-source chat-to-app builder, used under the MIT licence ([LICENSE](LICENSE)). The files we kept are from commit `1102a75e1d71b2aa6e74ad43c6096c736122fff3`, `adorable/` folder ([UPSTREAM.json](UPSTREAM.json)). Thank you to the Adorable authors.

**What we changed.** Only the files we use were copied; the rest of Adorable was never added to this repository.

- **Removed:** every direct call to Freestyle (`lib/freestyle.ts`, `project-vm.ts`, `identity-session.ts`, the base-snapshot script and the `freestyle` package); Adorable's own agent and model keys (`/api/chat`, `create-tools.ts`, `system-prompt.ts`, `llm-provider.ts`, `suggestions.ts`, the AI SDK and Mastra packages); the API-key paste flow (`api/api-key`, `components/api-key-gate.tsx`); its project storage (`lib/project-storage.ts`, `project-access.ts` and the `/api/projects/*` routes); the in-browser terminal (`vm-terminal.tsx`, `terminal-bridge.ts`); publishing, rollback and custom domains (`publish.ts`, `publish-dialog.tsx`); its deploy workflow; and its logo.
- **Sign-in:** Adorable's API-key gate is replaced by signing in with a Mynt account (`components/sign-in-gate.tsx`, `app/api/auth/*`), the same OAuth flow as `examples/mynt-chat`.
- **Projects** are your Mynt apps (`list_my_apps`), and a project's conversations are its coding-agent builds (`list_builds`), read from Mynt on each load (`app/api/projects`, `lib/projects.ts`, `lib/project-types.ts`). The studio stores nothing but the session.
- **Workspace shell** (`app/[projectId]/project-workspace-shell.tsx`): the preview is a build's live preview while it's being coded (`live_preview_url`), else the preview Mynt made when it verified the build (`preview_url`). The terminal pane and the publish button are gone. Home and project pages (`home-welcome.tsx`, `project-welcome.tsx`) list apps and builds instead of Adorable's projects and chats.
- **Chat panel** (`app/assistant.tsx`, `components/assistant-ui/thread.tsx`): Adorable's assistant-ui thread, kept, with a read-only runtime and its composer disabled ("coming in the next step").
- **Config:** Next 16.4 and React 19.3 to match mynt-chat; exact dependency versions, with the `@assistant-ui/*` packages pinned to the versions in Adorable's lockfile; a TypeScript target of ES2022; security headers (below).

## How it fits together

- **Sign-in** is real Mynt user authentication: OAuth with dynamic client registration and PKCE, run on the server by the MCP SDK. Tokens never reach the browser. Only people whose Mynt roles include developer (or innovator, or admin) get past the project list.
- **Shared with mynt-chat, byte for byte:** `lib/oauth-provider.ts`, `lib/session.ts`, `lib/mynt-client.ts` and `app/api/auth/{login,callback,logout}/route.ts`. CI fails if they drift apart. Each app has its own `lib/config.ts`, `lib/app-session.ts` and `lib/session-store.ts`.
- **Mynt tools** are called only through the `STUDIO_TOOLS` allow-list (`lib/studio-tools.ts`), which checks each tool's arguments with zod. For now it holds read-only tools only. `vm_access`, `app_run` and admin tools are never on it.
- **Sessions** (`lib/session-store.ts`). The browser holds only a random session id, in an `httpOnly`, `SameSite=Lax` cookie that is `Secure` and `__Host-`-prefixed everywhere except plain-http localhost. The session itself (OAuth tokens, the PKCE verifier, the user's roles) lives on the server, in a hosted Redis database when one is configured, and in memory otherwise (local development and tests). Every stored value is encrypted with AES-256-GCM using `SESSION_ENCRYPTION_KEY`, and stored under a hash of the session id. Lifetimes match mynt-chat: a session that never finishes signing in expires after 10 minutes, a signed-in one after 7 days without use.
- **Previews** are framed straight from their own origins, never proxied through the studio, in an iframe with `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"` (no top-level navigation) and `referrerpolicy="no-referrer"`. Only `https` URLs are framed. Preview URLs are capabilities: they're sent only to their owner's browser and never logged.
- **Security headers:** a Content-Security-Policy whose `frame-src` is exactly `PREVIEW_FRAME_SRC` (set per request by `proxy.ts`), with `frame-ancestors 'none'`; `X-Frame-Options: DENY`; `nosniff`. Serve the studio on its own host, not on a parent domain that hosted apps share.

## Settings

| Variable | What it is |
|---|---|
| `MYNT_MCP_URL` | Mynt's MCP endpoint, like `https://mynt.example.com/mcp`. |
| `APP_URL` | The studio's public URL. Sign-in returns to `$APP_URL/api/auth/callback`. |
| `PREVIEW_FRAME_SRC` | The origins previews are served from, space-separated `https` origins with optional wildcards, like `https://*.preview.example`. Unset, no preview can be shown. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | The Redis database for sessions. Vercel sets these when you connect a Redis database to the project. Upstash's own names, `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, work too. |
| `SESSION_ENCRYPTION_KEY` | 32 random bytes, base64-encoded, that encrypt the stored sessions. Required with Redis. Changing it signs everyone out. |
| `MYNT_OAUTH_SCOPE` | Optional: the scopes to ask for. |

The Redis client is [`@upstash/redis`](https://github.com/upstash/redis-js), Upstash's official client, which talks to Redis over HTTPS and so works from serverless functions. Without Redis settings, sessions stay in the server's memory, which is fine for one local process; on Vercel the studio refuses to start that way, because its function instances share no memory.

## Run it locally

```bash
cp .env.example .env.local   # then fill in MYNT_MCP_URL
npm ci
npm run dev
```

Open http://localhost:3000 and sign in with your Mynt developer account.

Checks: `npx vitest run`, `npx tsc --noEmit` and `npx next build`. CI runs them, diffs the files shared with mynt-chat, and fails on wording Mynt doesn't use or on a hostname or IP address in this folder.

## Host it on Vercel

No `vercel.json` is needed: Vercel builds it as a standard Next.js app.

1. Import the repository into Vercel and set the project's **Root Directory** to `examples/mynt-studio`.
2. In the project's **Storage** tab, connect a Redis database. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. In **Settings → Environment Variables**, add `MYNT_MCP_URL`, `APP_URL` (the studio's own URL), `PREVIEW_FRAME_SRC` and `SESSION_ENCRYPTION_KEY`.
4. Deploy.
