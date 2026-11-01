# AGENTS.md

Instructions for any coding agent working in this repository, on any machine.

## What this is

Mynt's platform, not an app built on it. It's an MCP server (TypeScript, Node, Postgres) where licensed firms compose financial products from regulated primitives, admins keep the regulatory model, and developers build apps on those products with coding agents that Mynt verifies and hosts. Its hosted agents (the coding team, the product desk, the governance desk, the business-development agent) are steered by folders under `workspaces/`, not by prompts in code.

## Start here

1. If `AGENTS.local.md` exists next to this file, read it. It holds this machine's and this operator's own rules (git-ignored, never committed) and wins over this file where they differ.
2. `npm ci && npm run build`. The build must be clean before anything else.
3. Read the part of `README.md` for the job: the top explains the product, `## Reference` the tools, the runtime API, hosting and deployment.
4. Then do what was asked, using the map below.

## Where each job lives

| The person asks | Open | Check with |
|---|---|---|
| "Add or change a tool" | `src/server.ts` (which tools each role gets), then the module that owns it (`src/builds.ts`, `src/hosting-tools.ts`, `src/definition-tools.ts`, …) | `node --test test/<area>.test.js` |
| "Change the runtime API" (apps, devices, hosting agents) | `src/runtime-api.ts` | `test/client-sessions.test.js`, `test/runtime.test.js` |
| "Change how products are defined or checked" | `schemas/financial-product.v2.schema.json`, `src/definition.ts` | `test/definition.test.js` |
| "Change the regulatory model" | `src/regulatory.ts`, `src/regime.ts` | `test/regulatory.test.js` |
| "Change what an agent does" | its folder, `workspaces/<agent>/` (`CLAUDE.md`, `.claude/agents`, `.claude/skills`, `scripts/`) | `test/vibecoder-workspace.test.js` and the agent's own test |
| "Change the generated SDKs" | `src/sdk.ts`, `src/sdk-clients.ts`, `sdk-templates/` | `test/client-sdks.test.js`; CI compiles every language |
| "Change the starter app the coding agents scaffold" | `workspaces/coding-build/templates/mynt-app/`, `scripts/scaffold_app.py` | CI's `starter-app` job builds and runs it |
| "Change hosting" | `src/hosting.ts`, `src/freestyle.ts`, `src/compose.ts` | `test/hosting.test.js` |
| "Change agent sandboxes" | `src/boat.ts`, `src/freestyle-sandboxes.ts`, `src/agent-host.ts` | `test/freestyle-sandboxes.test.js`, `test/builds.test.js` |
| "Change the sample chat app or developer console" | `examples/mynt-chat/` | `cd examples/mynt-chat && npx vitest run && npx tsc --noEmit` |
| "What needs attention in production?" | the `ops_status` admin tool | |

## How to check your work

- Run the test files for what you changed: `node --test test/<file>.test.js` after `npm run build`. The full suite (`npm test`) runs in CI on every push, with the client-SDK and starter-app jobs; run it locally only on a machine with memory to spare.
- Report what was measured, never what was hoped. Never edit a test to make it pass; fix the code, or say plainly that the test is wrong and why.
- A figure that can't be measured says so. Never show it as 0.

## Secrets

- Secrets are referenced by name only. Values live in the server's environment file, never in the repository, a test fixture, a command line, a log or the chat.
- **You never type, paste, pipe, store or repeat a secret value.** When a key is needed, the operator sets it themselves on the server, and you refer to it by name (`FREESTYLE_API_KEY`, `CLERK_SECRET_KEY`, …).
- If someone pastes a secret into the chat, don't repeat it or write it anywhere. Tell them it should be replaced, because it has been exposed.
- Code that handles secrets keeps them out of commands and output: pass them as a process's environment or a file only that user can read, and scrub them from anything shown to people (`src/boxes.ts`).

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
