# AGENTS.md

Instructions for any coding agent working in this repository, on any machine.

## What this is

Mynt's platform, not an app built on it. It's an MCP server (TypeScript, Node, Postgres) where licensed firms compose financial products from regulated primitives, admins keep the regulatory model, and developers build apps on those products with coding agents that Mynt verifies and hosts. Its hosted agents (the coding team, the product desk, the governance desk, the business-development agent) are steered by folders under `core/workspaces/`, not by prompts in code.

`core/` is the MCP server (its `src/`, `test/`, `schemas/`, `workspaces/`, `programs/`, `sdk-templates/`, `scripts/` and `Dockerfile`), installed on its own from its own lockfile, `core/package-lock.json`. `platform/` holds the apps built on it, which are the repository's npm workspaces (root `package.json` and `package-lock.json`): `platform/studio` (Mynt Studio), `platform/chat` (the sample chat and developer console) and `platform/packages/auth` (`@mynt/auth`, the sign-in code both import). `core/` is deliberately not a workspace, so the server's dependencies are locked in exactly one place. `deploy/`, `docs/` and `.github/` stay at the root. Paths below are from the root.

## Start here

1. If `AGENTS.local.md` exists next to this file, read it. It holds this machine's and this operator's own rules (git-ignored, never committed) and wins over this file where they differ.
2. For the server: `cd core && npm ci && npm run build` (core's own lockfile, as production installs it). For the apps: `npm ci` at the root, which installs the `platform/` workspaces and never touches `core/`. The build must be clean before anything else.
3. Read what the job needs: `README.md` explains the product, `docs/reference.md` the tools, the runtime API, hosting and deployment, and `docs/architecture.md` how the parts fit together.
4. Then do what was asked, using the map below.

## Where each job lives

| The person asks | Open | Check with |
|---|---|---|
| "Add or change a tool" | `core/src/server.ts` (which tools each role gets), then the module that owns it (`core/src/builds.ts`, `core/src/hosting-tools.ts`, `core/src/definition-tools.ts`, …) | `node --test test/<area>.test.js` in `core/` |
| "Change the runtime API" (apps, devices, hosting agents) | `core/src/runtime-api.ts` | `core/test/client-sessions.test.js`, `core/test/runtime.test.js` |
| "Change how products are defined or checked" | `core/schemas/financial-product.v2.schema.json`, `core/src/definition.ts` | `core/test/definition.test.js` |
| "Change the regulatory model" | `core/src/regulatory.ts`, `core/src/regime.ts` | `core/test/regulatory.test.js` |
| "Change what an agent does" | its folder, `core/workspaces/<agent>/` (`CLAUDE.md`, `.claude/agents`, `.claude/skills`, `scripts/`) | `core/test/vibecoder-workspace.test.js` and the agent's own test |
| "Change the generated SDKs" | `core/src/sdk.ts`, `core/src/sdk-clients.ts`, `core/sdk-templates/` | `core/test/client-sdks.test.js`; CI compiles every language |
| "Change the starter app the coding agents scaffold" | `core/workspaces/coding-build/templates/mynt-app/`, `core/workspaces/coding-build/scripts/scaffold_app.py` | CI's `starter-app` job builds and runs it |
| "Change how a licence provider connects its ledger" | `core/src/partner-kit.ts`, `core/src/partner-ledger/`, `core/schemas/partner-ledger/`, `docs/partners.md` | `core/test/partner-kit.test.js`, `core/test/product-health.test.js` |
| "Change hosting" | `core/src/hosting.ts`, `core/src/freestyle.ts`, `core/src/compose.ts` | `core/test/hosting.test.js` |
| "Change agent sandboxes" | `core/src/sandbox-host.ts`, `core/src/sandbox-providers/`, `core/src/agent-host.ts` | `core/test/sandbox-providers.test.js`, `core/test/builds.test.js` |
| "Change how Mynt is deployed" | `deploy/host/install-host.sh` (builds and runs the server from each release's `core/`), `deploy/host/mynt.service`, `core/Dockerfile`, `deploy/docker-compose.yml` | `core/test/site-caddy.test.js`; CI's `caddy-site` job |
| "Change the sample chat app or developer console" | `platform/chat/` | `cd platform/chat && npx vitest run && npx tsc --noEmit` |
| "Change Mynt Studio" (the chat-to-build web app, built on Adorable) | `platform/studio/` (its README lists what was changed from Adorable) | `cd platform/studio && npx vitest run && npx tsc --noEmit`; CI's `platform` job also builds it |
| "Change sign-in for Studio and the chat" | `platform/packages/auth/` (`@mynt/auth`; each app hands it its settings, cookie name and session store in `lib/session.ts`) | both apps' checks, and `npx tsc --noEmit -p platform/packages/auth` |
| "What needs attention in production?" | the `ops_status` admin tool | |

## How to check your work

- Run the test files for what you changed: in `core/`, `node --test test/<file>.test.js` after `npm run build`. The full suite (`npm test`) runs in CI on every push, with the client-SDK and starter-app jobs; run it locally only on a machine with memory to spare.
- Server dependencies change only in `core/` (`cd core && npm install …`, which updates `core/package-lock.json`); app dependencies at the root (`npm install -w platform/studio …`). `core/test/workspace-layout.test.js` fails if `core` becomes a root workspace or the root lockfile picks up anything of core's.
- Report what was measured, never what was hoped. Never edit a test to make it pass; fix the code, or say plainly that the test is wrong and why.
- A figure that can't be measured says so. Never show it as 0.

## Secrets

- Secrets are referenced by name only. Values live in the server's environment file, never in the repository, a test fixture, a command line, a log or the chat.
- **You never type, paste, pipe, store or repeat a secret value.** When a key is needed, the operator sets it themselves on the server, and you refer to it by name (`FREESTYLE_API_KEY`, `CLERK_SECRET_KEY`, …).
- If someone pastes a secret into the chat, don't repeat it or write it anywhere. Tell them it should be replaced, because it has been exposed.
- Code that handles secrets keeps them out of commands and output: pass them as a process's environment or a file only that user can read, and scrub them from anything shown to people (`core/src/boxes.ts`).

## What needs an explicit yes

Safe without asking: reading, building, running tests, and local edits that are part of the job you were given.

**Always ask first, naming what will happen, and wait for a plain yes** (unless `AGENTS.local.md` records a standing instruction for it):

- **Deploys** to any live server, and any change to a live server's settings.
- **Merging** a pull request, and any push to `main`. Never force-push or rewrite shared history.
- **Spending:** anything that starts a paid plan, a bigger server or a paid add-on.
- **Writing to a live database:** loading or changing production data.
- **Deletes and irreversible changes:** anything you didn't create.
- **Contacting people:** anything that emails or messages someone.

## Rules

- **This repository is public.** No server addresses, domain names, server configurations or notes about which apps share a server, in code, docs, commits or pull requests. Deployment scripts take those as arguments.
- **Regulatory obligations keep their own schema.** Regulators' registers and repositories follow the schema they were defined with; don't redesign them. Product definitions model the business: underwriting, segments, pricing, servicing.
- **Schemas and examples are JSON,** never YAML.
- **Agents are steered by their workspace folders.** Don't hard-code an agent's instructions in TypeScript. Its skills are human-written ones found on GitHub and vendored with their licence (`UPSTREAM.json`); don't hand-write new ones.
- **Agents never grade their own work.** Anything an agent produces is checked by Mynt itself, outside the agent's sandbox.
- **Keys stay out of reach.** Devices run on client sessions, never an app key. On Mynt's hosting, a hosted app's key is added on the way out and never stored on its VM, so apps must never forward callers' requests to Mynt's server-side routes.
- **Words:** Mynt is "Lovable for finance apps". Never frame its users as shopkeepers or sellers of goods, in any file, commit or pull request.
- **Stage explicit paths** (`git add <path>`); never commit `.env*`, `AGENTS.local.md`, `dist/` or `node_modules/`.

## Asking the operator for something

Assume the operator is not an engineer unless `AGENTS.local.md` says otherwise. Whenever a step needs them (a login only they hold, a value from a dashboard, a click in a console, a key on the server), ask the way a patient friend would:

- Open with what you need and why, in one plain sentence each. No acronyms without the words behind them.
- Give the steps as a numbered list, one action per line, starting from the web address to open and naming each button or field exactly as the screen shows it. Put anything they must paste or type on its own line in a code block.
- One thing at a time. If two things are needed, finish the first before mentioning the second, and say how long each takes.
- Say what happens next, and in one sentence why it's safe: what's hidden, what's never stored, what expires.
- Never scold or say "as I said". If they're stuck, ask what the screen shows and go from there.
