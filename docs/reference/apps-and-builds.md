# Apps and builds

This file covers what a builder does to make an app: create it, get access to products, have Mynt's coding agents build it, keep its code in a repository, host it and promote products with campaigns. It is for builders making apps.

See also: [Products](products.md), [Runtime API](runtime-api.md), [Workspaces and sign-in](workspaces-and-sign-in.md), [Solana programs](solana-programs.md), [Mynt Studio](studio.md).

## Apps

An app is a builder's experience around one or more financial products: a retirement planner, say. It belongs to a workspace, and everyone in that workspace can work on it.

| Tool | What it does |
| --- | --- |
| `create_app` | Creates a draft app in one of your workspaces, on the products it names. It declares what the app does (`actions`) and the disclosures it shows |
| `update_app` | Changes an app. Only the fields you pass change |
| `list_my_apps` | Lists the apps of every workspace you belong to, or of one, each with its stage |
| `preview_app` | Renders an app with full product details and flags products it can't show |
| `check_experience` | Says whether you have access to each product and whether the app meets each product's build terms |
| `publish_app` | Makes an app visible to everyone through `list_apps`. Only an app in Production can be published |
| `get_developer_dashboard` | Figures across your workspaces' apps for the last 7, 30 or 90 days. See [Attention](workspaces-and-sign-in.md#attention) |

An app has a stage: idea, staging or production. A new app starts as an idea, and only its workspace's owners and admins move it. See [Stages and promotion](workspaces-and-sign-in.md#stages-and-promotion).

An app never holds funds or collects financial data itself. Onboarding, identity checks and payments hand off to the product's own flow (see [Hand-offs](runtime-api.md#hand-offs)).

## Building on a product

A product's builder decides who may build apps on it and what those apps may do.

### Access modes

Each product has an access mode, set with `set_product_access`.

| Mode | What other builders can do |
| --- | --- |
| `open` | Build and publish any app that meets the terms |
| `approval` (default) | Build now; go live once the product's builder approves their request |
| `private` | Build only when invited (`invite_developer`) |

Products in Mynt's reference catalogue have no owner and are always `open`.

### Build terms

Each product also has build terms:

- **Permitted actions:** `display`, `compare`, `prefill`, `deep_link`, `embed_widget`, `initiate_onboarding`
- **Required disclosures**
- **Banned phrases**
- **Allowed customer personas**
- **Branding**
- **Commercials:** none, referral fee or revenue share
- **`handoff_url`:** where runtime API hand-offs send the user (https)

### For the app's builder

- **Find products:** `list_buildable_products`, and `get_product_sdk` for the data shape, a sandbox sample, the permitted actions and the hand-offs.
- **Read the developer contract:** `get_developer_contract` returns exactly what an app can build against on a product's live version. See [The developer contract](products.md#the-developer-contract).
- **Ask for access:** `request_product_access` and `list_my_requests`.
- **Check and publish:** `check_experience`, then `publish_app`. Publishing needs access to every product and a passing check against each product's terms.

### For the product's builder

- **Inbox:** `list_requests` and `review_request` (approve or reject, with a note).
- **Visibility:** `list_experiences` shows every app that uses their products.
- **Control:** `revoke_access` withdraws an approval or invitation.
- **Kill switch:** `suspend_product_experiences` takes a product out of every app at once. The product goes private, every grant is revoked, and live campaigns using it are paused.

## Coding-agent builds

A builder can have Mynt build and ship one of their apps. `start_build` runs a coding agent in a fresh agent sandbox.

### How a build runs

- The sandbox only provides the machine. Mynt installs a pinned Claude Code there and runs it headless with a dollar budget (`--max-budget-usd`, from the build's cap).
- The agent reaches the model only through Mynt's agent proxy (`/agent`), using a token that works only while its build runs.
- Mynt calls Claude on Google Cloud Vertex AI with its own service account, or the Anthropic API with its own key. No credentials ever enter a sandbox.
- Builders follow the agent's activity live and can steer it: Mynt interrupts the current turn and sends their message as the next one.
- The agent writes the code against the app's products and their build terms. It uses a freshly generated SDK and a Mynt sandbox key (simulated hand-offs) for end-to-end tests.
- It reviews its own code for security issues and fixes them, starts a preview, and pushes a branch.

The agent's review is advice. Mynt verifies every build itself afterwards, in a sandbox the agent never touched (see [Verification](#verification)). When the server sets `BUILD_AUDIT=maxwell`, that verification also runs the [Maxwell](https://github.com/OnFinance/Maxwell) security audit, once, never in the agent's sandbox. The default is no audit.

### What the agent builds

The agent builds a whole app, not just a server: one Docker Compose project with

- `api/`, which holds the app key, mints client sessions and handles webhooks;
- `web/`;
- `mobile/`, Expo React Native by default, or Kotlin, Swift or Flutter on request.

It starts from `core/workspaces/coding-build/templates/mynt-app/` with the build's generated SDKs wired in.

The lead agent works with a team of subagents in `core/workspaces/coding-build/.claude/agents/`: an architect, server, web and mobile engineers, a read-only compliance reviewer, QA and release. Their skills are human-written skills found on GitHub by HyDE search (Mynt's own drafts used as the queries) and vendored with their upstream licence and source, plus a short Mynt layer.

### Agent sandbox providers

Builds, the product desk, governance review and the connector run in agent sandboxes from one of two providers.

| Provider | Used when |
| --- | --- |
| boat.dev | `BOAT_API_KEY` is set and `SANDBOX_PROVIDER` is not `freestyle` |
| Freestyle | `FREESTYLE_API_KEY` is set, and either `SANDBOX_PROVIDER=freestyle` or no `BOAT_API_KEY` is set |

The Freestyle adapter is `core/src/sandbox-providers/freestyle.ts`, behind the `SandboxHost` interface in `core/src/sandbox-host.ts`. On Freestyle:

- each sandbox is a VM with the agents' own `user` account and the sandbox env in a 0600 file;
- previews and source downloads are served at unguessable `style.dev` names, so the link is the credential, as with boat.dev's token-gated links;
- stopping a sandbox deletes the VM;
- machine spend counts toward the caps at `FREESTYLE_USD_PER_HOUR`.

### Working in the build's sandbox

The builder works in the same sandbox as the agents.

- `open_sandbox_editor` opens VS Code in the browser on the sandbox, through a private, token-gated link plus a password, with a terminal next to the agents. It works while a build runs, and after it ships for as long as its preview is up.
- `sandbox_run`, `sandbox_files` and `sandbox_diff` do the same from any MCP client.
- Output is capped and scrubbed of credentials, and everything the builder does is on the build's timeline.
- After a build ends, `reopen_sandbox` brings back a fresh sandbox on its pushed branch for a few hours, with the coding team's agent workspace and a short-lived GitHub token to push with. The same tools keep working.
- `close_sandbox` ends it.

### Live preview while the agents code

Once the agents' install has finished and the SDK is built, Mynt itself starts the app's dev servers with `core/workspaces/coding-build/scripts/dev_preview.sh`:

- Vite (`npm run dev` in `web/`) on 127.0.0.1:5173, with hot reload;
- the api (`npm run dev` in `api/`, the template's `tsx watch` from the app's own dev dependencies) on port 3000, on the build's sandbox key.

"Finished" means the package manager's own record is in `node_modules` and no install is running:

- the record is npm's `.package-lock.json`, pnpm's `.modules.yaml`, or yarn's `.yarn-integrity` or `.yarn-state.yml`;
- a running install is a process whose command line starts with `npm`, `pnpm` or `yarn` followed by `install`, `i`, `ci` or `add`.

The script never installs anything itself, so it never races the agents.

How the link works:

- Once Vite answers with any HTTP response, Mynt serves port 5173 at a private link, `live_preview_url` on `get_build`. It is shown while the agent runs (`coding` through `pushing`): the dev servers keep serving through the agent's own review, checks and push.
- On boat.dev the link forwards to the sandbox's 127.0.0.1 (`localhost: true`), as the editor's does.
- The link is a credential. It is never written to the timeline, and admins' listing leaves it out.
- While waiting for the install, Mynt retries every tick. Once the preview is up, while its dev server is up but not answering yet, or while the app has no `web/` yet, it retries every 6th tick. A retry also restarts a dev server that died, behind the same link.
- The script bounds its own waits by the clock: about 27 seconds at most, even when a server accepts connections but never answers. That is well under the 45 seconds Mynt gives it.
- The preview never fails a build.

When coding ends, Mynt stops both dev servers before it packages the source. Dependencies at any depth (`node_modules`) stay out of the package.

The template's `web/vite.config.ts` accepts the forwarder's host name, sends hot reload over port 443 and keeps Vite's cache outside the app, but only when the script starts it (`MYNT_LIVE_PREVIEW=1`). A builder's own `npm run dev` keeps Vite's localhost-only defaults.

After the build ships, `preview_url` is the verified Compose preview.

### Verification

The agent doesn't grade its own work. When it finishes, Mynt verifies the build itself, in a fresh sandbox the agent never touched, with no secrets.

1. **Package.** Mynt packages the source (without dependencies) and records its SHA-256. The verifier downloads it and checks the checksum.
2. **Mynt's own checks** (`core/src/verify-script.ts`):
   - tests;
   - lint and types;
   - a secrets scan with `gitleaks`;
   - a dependency audit;
   - a CycloneDX software bill of materials (SBOM) with `syft`;
   - every required disclosure present in the source.

   `gitleaks` and `syft` are pinned versions, checked against their releases' published checksums.
3. **Independent audit**, only with `BUILD_AUDIT=maxwell`. See [The independent audit](#the-independent-audit).
4. **Decision**, from Mynt's results only. The agent's own report is kept, as advice.
   - The build is `blocked` when the source changed during the audit, when an audit didn't finish or is incomplete, or on critical or high findings (the first few are named).
   - The build is `failed` on a failing check. Its `error` names each failed check with the start of what it found, such as `Not production-ready: secrets_scan (1 secret(s): …)`.
   - With a repository, the pushed branch must be exactly the verified source, or the build is `blocked`.
5. **Ship.** On success, Mynt exposes the token-gated preview and opens the pull request itself, through its GitHub App, with the verified results in the description. The agent never opens pull requests.

While Mynt verifies, the build's `phase_message` is the step it is on: the checks, the audit and its time limit. Once a build ends, `phase_message` is the reason it ended (as `error`), so whoever shows the phase shows why.

A build that didn't ship also has `next_step`: what to do about it. That is either to fix the named findings or checks and continue from the build, or to verify again. It also names the `BUILD_AUDIT_*` setting a Mynt admin can change when audits keep running out of time or budget.

### The independent audit

With `BUILD_AUDIT=maxwell`, a separate, audit-only Claude Code run (`core/workspaces/build-audit/`) executes the Maxwell static workflows (`BUILD_AUDIT_WORKFLOWS`) on its own copy of the source.

- **Its copy.** The copy is a fresh extraction of the hash-checked archive, made read-only, that Mynt's checks never touched. Mynt hashes every file of that copy before the audit and again after it, keeping the first hash itself. Git's own `.git` folders and `node_modules` aren't source and are left out. A file changed, added or deleted blocks the build and is named.
- **The report.** The auditor writes its report as it goes and marks it `complete` in its last write. It counts only when it exists, says `complete: true`, has counts, and lists every configured workflow under `workflows_run`. A missing or partial report never counts as a pass.
- **Time.** The audit has `BUILD_AUDIT_MINUTES` per attempt.
- **Budget.** It has `BUILD_AUDIT_CAP_USD` of model spend over all its attempts, on `BUILD_AUDIT_MODEL`, paid by Mynt. Its token has its own meter key, which the proxy refuses once the budget is spent.
- **Machine time.** From the audit's start the sandboxes' machine time is the audit's too. The build's cap counts machine time only up to then, so an audit can't push a build over its cap.
- **Out of time or budget.** An auditor out of time or budget is ended, and the build is `blocked` saying which.
- **One more attempt.** An auditor that ends without a complete report for any other reason (it ended its turn early, or its run broke off) runs once more, with what's left of the budget, if the source is untouched. Two such ends block the build.

### Tracking a build

| Tool | Shows |
| --- | --- |
| `get_build` | Phase, timeline, cost against the cap, Maxwell summary, readiness and links |
| `get_build_activity` | The agent's activity |
| `steer_build` | Sends the agent a message |
| `stop_build` | Stops the build |
| `list_builds` | This month's spend, optionally for one app (`app_id`), and `budget` |
| `list_all_builds` | Mynt admins: every build and total spend |

`budget` says what a new build's cap may be:

| Field | Meaning |
| --- | --- |
| `default_cap_usd` | The default cap |
| `month_left_usd` | What is left of the builder's month |
| `workspace_left_usd` | What is left of the workspace's budget, with `app_id`, for an app in a workspace with its own budget; otherwise null |
| `min_cap_usd` | Below this much left, no build starts |
| `session_cap_above_usd` | A session build's cap must be above this |

Mynt Studio's cap pickers start from it. `start_build` still checks every limit.

### Cost and time

`get_build` and every build in `list_builds` also report what the build cost and how long it took, as measured. The older fields (`cost_usd`, `cap_usd`, `created_at`, `finished_at`) are unchanged.

A figure Mynt didn't measure is `null`, never 0, with its reason in `not_measured`, keyed by the field's path, such as `"durations_seconds.coding"`.

| Field | What it is | Measured from |
| --- | --- | --- |
| `cost_cents` | Spend against the cap so far | `cost_usd`, which Mynt reads on every tick while the agent works and Mynt verifies. A build that never got a sandbox spent nothing (0). A build whose sandbox was up but whose cost was never read (one that ended while provisioning) is `null` |
| `cap_cents` | The build's cap | `cap_usd` |
| `cost_parts_cents.coding_agents` | The coding agents' model spend | The larger of what the runner reports and what Mynt's agent proxy metered for the build, recorded with each cost reading (`agent_cost_usd`) |
| `cost_parts_cents.sandboxes` | Machine time of the build sandbox and the verification sandbox, up to the start of Mynt's audit when one runs | The sandbox provider's own dollars (`sandbox_cost_usd`). Time a sandbox stays up after the build ends (its preview, a reopened sandbox) is metered as hosting usage, not here |
| `audit_cost_cents` | Mynt's agent audit, paid by Mynt, outside the cap and not in `cost_cents` | Its model spend over all its attempts (the larger of the auditors' own reports and the proxy's meter) plus the sandboxes' machine time while it ran (`audit_cost_usd`); `null` when no agent audit ran |
| `timing` | `queued_at`, `started_at` (Mynt asked for the sandbox), `coding_started_at`, `verify_started_at`, `finished_at` | The build's own timestamps and its timeline's first `provisioning`, `coding` and `verifying` entries |
| `durations_seconds` | `queued` (to `started_at`), `coding` (to `verify_started_at`, or the end), `verify` (to the end), `total` | `timing`; a running build's count up to `measured_at` |

Builds measured before the parts were kept keep their total; their parts are `null`. The columns `agent_cost_usd`, `sandbox_cost_usd` and `audit_cost_usd` are nullable and filled going forward.

### Activity

As a build runs, Mynt reads the agent's output from the sandbox on every tick and stores it, summarised, in `build_activity`: the agent's messages, the commands it runs and the files it edits, each with a `seq` and a time.

- The history stays after the sandbox stops. Each build keeps its latest 5,000 entries.
- `get_build_activity` without `after` returns the latest entries, newest first.
- To follow a build, pass the `cursor` from the last call as `after`. The result holds only newer entries, oldest first, and a new `cursor`, which stays the same while nothing new has arrived.
- `first_seq` is the oldest entry still kept. A follower whose cursor is below it has missed entries trimmed by the limit.
- Summaries are scrubbed of credentials (as `sandbox_run` output is) before they're cut to length, and control characters are dropped.

Activity is the agent's own account. It is shown to the builder and never used to decide anything.

### Following the agent's words

The agent runs with `--include-partial-messages`, so Mynt also sees a message while it is being written. Pass `text_deltas: true` to `get_build_activity` to get those words too.

- They arrive as `text_delta` entries. Each holds the next piece of one text block, oldest first, and carries a `stream`: the model's message id and the block's index.
- When the block is whole, its `message` entry follows with the same `stream`. A follower that showed the pieces closes that part and doesn't print the message again. A `message` without a `stream` wasn't streamed, and is shown on its own.
- Without `text_deltas` (the default), `text_delta` entries are left out, and `stream` is an extra field older callers can ignore.

How fresh it is:

- A follower (a call with `after`, or with `text_deltas`) gets the agent's log read there and then when the last read is over a second old. Polling about every 700 ms shows the agent's words within a second or two of their being written.
- Reads stay at most one a second per build, however often it's asked.

How pieces are scrubbed:

- Never one by one. Each block's text is accumulated and scrubbed whole, and only its settled part (up to its last space or line break) goes out. A token split across two pieces, or still being written, is held back until it's complete and can be recognised.
- If scrubbing more of the text would change what was already sent (a private key block, recognised once its content follows its BEGIN line), the block stops streaming and only its `message` is added.
- A block streams up to 16,000 characters. Past that, only its `message` is added.

### Following the agent's reasoning

Mynt also keeps the agent's thinking, as far as the model returns it to Claude Code. A thinking block with no text adds nothing, and signatures are never kept.

- Pass `reasoning: true` to `get_build_activity` to get a `thinking` entry for each whole thinking block.
- With `text_deltas: true` as well, `thinking_delta` entries arrive while it's written, tied to their `thinking` entry by `stream` exactly as `text_delta` entries are tied to their `message`.
- Thinking is scrubbed of secrets exactly as messages are.
- Without `reasoning` (the default) neither kind is returned, so existing callers (the sample chat, the SDKs) see what they always did.

Mynt Studio's chat asks for it and shows it as a collapsible Reasoning block above the agent's words.

The runner passes Claude Code a settings file with `showThinkingSummaries: true`, Claude Code's documented setting for thinking summaries in place of redacted blocks. Its documentation describes the setting for interactive sessions and says nothing about `-p` runs. Whether a given model's thinking arrives with text in a headless run hasn't been confirmed on a live build.

### Session builds

`start_build` with `mode: "session"` works like a chat with the coding agent.

- The agent does the first request (`goal`), reports `coding` "Waiting for your next message", and stays open, keeping its context.
- Each `steer_build` message is the next request. Sent while a request is still running, it interrupts that request and becomes the next one.
- `finish_build` ends the session. Once its current request is done, the agent reviews, checks, previews and pushes the work, then exits. Mynt then verifies the build in a clean sandbox exactly as any other.
- Finishing never interrupts the current request. Once a session is finishing it takes no more steers. A message that slips in as it starts finishing isn't delivered, and the build's timeline says so.
- `steer_build`'s `steered: true` means Mynt queued the message, not that the agent read it.
- The sandbox is billed while it waits, so idle time counts against the build's cap.

Mynt also finishes a session itself, so that neither idleness, the time limit nor the cap ends it with the work unshipped:

- after it has been idle (nothing running, nothing waiting) for `BUILD_SESSION_IDLE_MS`, which defaults to 15 minutes and can be from 1 minute to 24 hours;
- 30 minutes before its sandbox's time limit (`BUILD_SANDBOX_TTL_SECONDS`, default 4 hours, counted from when Mynt asked for the sandbox);
- once it has spent 70% of its cap, or earlier on a small cap, so that at least US$2 is left for the finish turn.

That US$2 is an estimate of one finish turn, not a measured figure. A session build therefore needs a cap above US$2, and `start_build` refuses a smaller one.

A finish is recorded first and then put in the agent's inbox. If the sandbox can't be reached at that moment, the finish still stands and Mynt delivers it on its next ticks.

Mynt runs the agent's runner with `MYNT_AGENT_HOLD=1` and `MYNT_AGENT_IDLE_MS`, and writes its inbox items whole (a temporary name, then a rename).

### Continuing a build

`start_build` with `continue_from: <build_id>` starts from the branch an earlier finished build of yours pushed, on the same app and repository.

- Mynt must have confirmed that push: the build has a verified commit, or Mynt opened its pull request.
- If the earlier build shipped, the new one starts at its verified commit.

Use it after a session ends, or to change a shipped app.

### App kinds

A new app can start from a working base for its kind instead of a blank prompt. `list_app_kinds` lists the kinds, and `start_build` takes one as `kind`.

Each kind is a JSON file in the coding agent's workspace folder, `core/workspaces/coding-build/templates/kinds/<kind>.json`, checked against `core/schemas/app-kind.schema.json`. It holds:

- a title and a one-line description;
- the product lines it builds on;
- a goal to start from and edit;
- the screens and flows to build first;
- the SDK calls it relies on.

Mynt refuses a kind that isn't there, stores the kind with the build (`kind` on `get_build`) and puts it in the agent's build spec.

The agent reads that file and scaffolds with `scripts/scaffold_app.py --kind <kind>`. This lays the kind's screens over the starter app as placeholders that compile: `web/src/screens/` with a shell that switches between them, and `mobile/app/<screen>.tsx` for Expo. The kind's journey screen is the starter's journey runner. A copy of the kind is kept as `mynt-kind.json`.

The kinds follow the products published for US builders to build on: deposit accounts (a certificate of deposit, a money market account), retirement accounts (an IRA, a 401(k) plan), a money market fund, and Treasury Inflation-Protected Securities. A kind may also name the product categories in its lines it is for (`categories`), so a retirement kind doesn't pick a money market fund.

| Kind | Product lines | Categories |
| --- | --- | --- |
| `savings-goals` (Savings goals) | `account_operations` | `deposits` |
| `certificates-of-deposit` (Certificates of deposit) | `account_operations` | `deposits` |
| `cash-reserve` (Cash reserve) | `account_operations`, `wealth` | `deposits`, `mutual_funds` |
| `retirement-account` (Retirement account) | `wealth` | `retirement` |
| `treasury-securities` (Treasury securities) | `credit` | `bonds` |

Continuous integration scaffolds every kind and compiles its api, web and mobile.

### App ideas

Specific apps someone could build on a kind are rows in Postgres (`financial_products.app_ideas`), not part of the kind's file. Each has:

- an id (a slug, unique across every idea) and the kind it builds on;
- a chip label (`chip_label`): what the Build page's chip says, 1 to 34 characters on one line, plain words saying what the app is, such as "Two-key household fund";
- a problem statement: who has the problem and what it is, in plain words, such as "Roommates chase each other for their share of rent and bills". At most 80 characters, one line, shown as the chip's tooltip;
- a pitch: what the app does about it, in one line of at most 120 characters;
- a goal to start the build from and edit (40 to 1200 characters);
- the product lines it builds on: some or all of the kind's (a line is allowed only when some kind declares it);
- optionally, the product categories in those lines it is for (`categories`, within the kind's own), and words from the names of the products it is for (`product_names`, such as "Money Market Account") when a category is still too wide;
- a status (`active` or `retired`) and a sort order within its kind.

Builders read the active ones with `list_app_ideas`, optionally for one `kind`.

Mynt admins keep them:

- `create_app_idea` adds one.
- `update_app_idea` changes some fields; the fields left out stay, and `status: "active"` brings back a retired one.
- `retire_app_idea` retires one.
- `list_app_ideas` with `include_retired` shows retired ones.

Each change is audited.

### What Mynt refuses in an app idea

Mynt checks every idea it stores. It refuses:

- an idea whose kind isn't there or whose lines aren't the kind's;
- text about what no kind builds on: lending, insurance, investing, trading or cards;
- text that frames the people an app serves as sellers of goods;
- promises, projections and advice: earnings, yields, returns, a percentage, guarantees, "risk-free", beating or outpacing inflation, recommendations and advice ("the app shows information, not advice" is the one way the word may appear);
- a web address;
- an SDK call the kind doesn't rely on;
- for a stablecoin-settled kind, a goal that doesn't say it shows dollars only, never crypto.

Factual words about the products, such as interest, rate, matures, retirement and fund, are fine.

### The app ideas Mynt ships

The ideas Mynt ships come in two sets, each checked against `core/schemas/app-idea-seed.schema.json`:

- v1: `core/workspaces/coding-build/templates/ideas.seed.json`, the first sixteen.
- v2: `ideas.v2.seed.json`, sixteen sharper ideas on the same live products with new ids, each with its own angle and core loop. Examples are a two-key household emergency fund, a wedding CD ladder with one rung per payment, a found-money sweep, a 401(k) step inside a new job's onboarding checklist and a TIPS tuition calendar.

Mynt never adds either by itself, on startup or on deploy. A Mynt admin adds one with `seed_app_ideas` (`seed: "v1"`, the default, or `"v2"`), or from `core/` with:

```sh
node scripts/seed-app-ideas.mjs --url <mynt MCP URL> --login [--seed v2] [--replace] [--products]
```

- It adds the ideas that aren't there yet. It never overwrites an idea already there, edited or retired, so it is safe to run again.
- With `replace: true` it then retires every active idea that isn't in the set (v1's and any an admin added), returns their ids as `retired`, and audits them. It never deletes a row, and `update_app_idea` with `status: "active"` brings one back.
- To move a Mynt server from v1 to v2, call `seed_app_ideas` with the arguments below.

```json
{ "seed": "v2", "replace": true }
```

### Chip labels on older ideas

Chip labels came after the first ideas were stored, so a row added before them has `chip_label: null`. `list_app_ideas` returns it as null, and Studio cuts the problem to 34 characters instead. Every shipped idea has one.

`seed_app_ideas` with `labels_only: true` (and the set's `seed`) adds and retires nothing. For each of the set's ideas already in the database it:

- fills in the set's chip label on one that has none (`filled`);
- leaves one that has a label, an admin's or the seed's, as it is (`kept`);
- lists the set's ids that aren't in the database (`missing`).

It is audited like any seed. `seed_product_ideas` takes `labels_only: true` the same way. The seed script does both with `--labels-only` (`--seed v2 --labels-only --products`).

On the server, the same functions are `fillAppIdeaChipLabels(db, seedIdeas(APP_IDEAS_V2_SEED_PATH))` (`core/src/app-ideas.ts`) and `fillProductIdeaChipLabels(db)` (`core/src/product-ideas.ts`).

Because `update_app_idea` and `update_product_idea` check the idea whole, an idea without a chip label needs one before any other field of it can change.

### Kinds and ideas on the Build page

In its App mode, the Build page in Mynt Studio shows up to six app ideas as chips, picked once per page load with at least one per kind when it can.

- Each chip shows its chip label on one line, never wrapping, with the problem as its tooltip.
- The Templates tab shows every idea as a row: the problem, what the app does, the kind, its product lines and a Use button.
- Using an idea fills the prompt with its goal. It picks every published product in the idea's lines that is in its categories and, when the idea names some, whose name contains one of its product names. The composer's Products button then names the one product, or says how many.
- A chip is shown only for an idea that has a published product to pick. One with none stays on the Templates tab, marked "No product yet", with Create product.
- A kind with no ideas is offered as an idea itself: its title, description and goal. So a Mynt server with no ideas yet offers the kinds themselves, as chips and as Templates rows. Using a kind fills the prompt with its goal and picks the published products in its lines and categories.

Financial product mode shows product ideas instead (see [Product ideas](products.md#product-ideas)).

### Spend

| Setting | Caps | Default |
| --- | --- | --- |
| `BUILD_CAP_USD` | One build | 10 |
| `BUILD_MONTHLY_CAP_USD` | One builder per month | 100 |
| `BUILD_WORKSPACE_MONTHLY_CAP_USD` | One workspace per month, shared by everyone building its apps | Unset: no workspace budget |

A build must fit both the builder's and the workspace's budget. Mynt reads the sandbox's machine and model cost as it runs, and stops a build that passes its cap.

### Build settings

Builds are disabled unless the server has all three of these:

- a sandbox provider key: `BOAT_API_KEY` or `FREESTYLE_API_KEY` (see [Agent sandbox providers](#agent-sandbox-providers));
- `PUBLIC_URL`;
- a model backend for the agent proxy, one of:
  - `GOOGLE_APPLICATION_CREDENTIALS`: a service account key file with Vertex AI User on a project where the Claude models are enabled, with optional `VERTEX_PROJECT_ID` and `VERTEX_REGION` (default `global`);
  - `ANTHROPIC_API_KEY`: a dedicated key with a spend limit.

Pushing to repositories is disabled without `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG`.

| Optional setting | Default |
| --- | --- |
| `BUILD_AGENT_MODEL` | `claude-opus-5-5` |
| `BUILD_SANDBOX_TYPE` | `default` |
| `BUILD_SANDBOX_TTL_SECONDS` | 4 hours |
| `BUILD_SESSION_IDLE_MS` | 15 minutes |
| `BUILD_AUDIT` | `none`; `maxwell` turns the independent audit on |
| `BUILD_AUDIT_MODEL` | `claude-sonnet-5-5` |
| `BUILD_AUDIT_CAP_USD` | 5 |
| `BUILD_AUDIT_MINUTES` | 20 |
| `BUILD_AUDIT_WORKFLOWS` | `execute-scr,probe-cicd-env` |
| `FREESTYLE_USD_PER_HOUR` | 0.2 |

## Repositories

Builders install the Mynt GitHub App on a repository and run `connect_repository`. Each build gets an installation token limited to that one repository, with contents and pull-request write access for an hour. No long-lived credential enters the sandbox.

A builder needs no repository of their own: see [Managed repositories](#managed-repositories).

### Who may connect a repository

The App being installed on a repository only says Mynt can reach it, not that the person asking may use it. So a connection is approved only when the person can push to it, checked with GitHub, or when a Mynt admin approves it (`core/src/repo-ownership.ts`, `core/src/repo-approvals.ts`).

### The check with GitHub

On `connect_repository`:

1. Mynt takes the GitHub account linked to the builder's sign-in, verified, as the identity provider reports it to Mynt's server (`get_linked_accounts`). It never uses anything the client sends, and has no GitHub sign-in of its own.
2. It finds that account's current login from its stable GitHub id.
3. It asks GitHub, through the App installation covering the repository, for that login's permission there (`GET /repos/{owner}/{repo}/collaborators/{login}/permission`).
4. `admin`, `maintain` or `write` approves the connection at once (audited as `auto_approve_repository_connection`) and records the repository's stable id.

The repository is pinned by id. It is read before and after the permission check. It isn't approved on its name when:

- another repository answers to the name meanwhile (a rename or transfer);
- the name now leads to a different full name;
- it isn't the repository recorded for an earlier connection of theirs.

In those cases an earlier approval of theirs goes back to an admin too.

### When an admin decides

Otherwise a Mynt admin decides, and the builder is told why (`why`):

- no verified GitHub account is linked to their sign-in (with `manage_url`, where to link one);
- the account can't push (its permission);
- GitHub is unreachable or erring.

An admin's rejection stays. Reconnecting, any number of times, leaves a rejected connection rejected whatever GitHub says; only an admin lifts it, by approving it. An admin rejecting while GitHub is being asked wins.

Admins use `list_repository_requests` (pending by default). Each request shows who asked, their firm, the repository, the installation id, and the account the App's installation is on (login, and user or organization). They decide with `approve_repository_connection` (with a note) or `reject_repository_connection` (with a reason).

- Each decision names the request exactly as listed: its id, repository and installation id. A connection that changed in between gets no decision (a firm reconnecting its desk repository keeps the same id).
- Approving needs the request still pending. Rejecting also withdraws an earlier approval.

Every decision is audited, and the person who asked sees it with `repository_access_notices`.

### Checked again before builds use it

A connection approved on the builder's own push permission is checked with GitHub again before Mynt gives out a token for it, once GitHub's last answer is over 10 minutes old. That happens when a build starts, when a sandbox pushes, and when a verified build's pull request is opened.

- If the permission is withdrawn by then, the build opens no pull request and its verified work stays on its branch.
- If they can't push any more, their account is no longer linked, or the name leads to a different repository, the connection goes back to an admin (audited as `repository_access_withdrawn`).
- If GitHub, or the identity provider that says which GitHub account is theirs, can't be reached then, the approval stands. An answer that recently said yes isn't overturned by an outage, so builds don't stop when GitHub has a bad minute. The next check after it recovers decides.
- Connections an admin approved, and Mynt's managed repositories, aren't re-checked.

GitHub is asked sparingly:

- reconnecting an approved connection through the same installation within 10 minutes of GitHub's last answer asks nothing;
- one check reuses one short-lived token;
- each builder may run 10 checks a minute (`connect_repository` says when to try again).

### What waits for approval

- A builder's `connect_repository` (per builder and repository) and a firm's desk repository (`connect_desk_repository`, per firm and repository) start `pending_approval`.
- Approving one never covers another builder's or firm's connection to the same repository.
- `set_app_repository` uses the builder's connection, so it needs that connection approved too.
- Mynt's managed repositories (each app's own) are exempt: they are approved as Mynt creates them.

Until a connection is approved, these are refused with "Waiting for an admin to approve access to `<repo>`" (or "An admin rejected access to `<repo>`"):

- `start_build` with a repository, `continue_from` and `reopen_sandbox`;
- the build worker, right before the push token, and again before Mynt opens a build's pull request;
- desk jobs, explorations and their adoption;
- `deploy_app`, and hosting's source fetch.

A desk job is pinned to the desk repository it started on. If the firm reconnects its desk to another repository mid-job, the job fails, even when that one is approved too.

### Reconnecting

- An approval is kept only when the same repository (same id) is connected again through the same installation.
- A new repository, a reinstalled App (a new installation), or a request still pending is a new request, checked with GitHub again.
- A rejected one stays rejected.
- An admin's approval doesn't expire. One GitHub gave is checked again as above.

### Connections made before the check

Connections made before this check existed became `pending_approval`: the check fails closed. Builds without a repository, and Mynt's managed repositories, keep working.

On a server upgraded across that change:

- every existing builder connection and desk repository needs an admin's approval before its next build, desk job or exploration;
- apps hosted from those repositories lose their source token, so they can't be redeployed or rebuilt on the VM until their connection is approved;
- builds and desk jobs already queued fail at their next step if their connection isn't approved by then.

Go through `list_repository_requests` straight after such a deploy.

### Managed repositories

Managed repositories are the default. When a build names no `repository`, its app's builds push to the app's own repository.

- **Created by Mynt.** On the app's first build, Mynt creates a private repository on its git host (`core/src/git-host.ts`), named by the app's id only (`mynt-app-<app_id>`), with a first commit so pull requests have a base.
- **Works like a connected repository.** Builds push their branch there, Mynt opens the verified pull request there, `deploy_app` fetches the verified commit from it, and `continue_from` carries on in it.
- **Cloning.** `get_app_repository` says where an app's code lives and, for a managed repository, gives a read-only token (one hour) to clone it.
- **Listed.** `list_repositories` marks a managed repository `managed`.

A managed repository is reachable only through its app. One guard covers every path that connects a repository by name: `connect_repository`, `set_app_repository`, a firm's desk repository (`connect_desk_repository`, and so the desk's explorations), and a build naming a repository. It refuses any managed repository, except the caller's own app's in a build of that app.

- A repository counts as managed if it's in the managed organization by name, or if Mynt ever created one under that name.
- Mynt keeps every name it creates in `managed_repository_names`: the name only, kept after the app is removed. That covers a name the host still redirects after the organization was renamed.
- The check fails closed: a database error refuses the connection. Only a table that doesn't exist yet counts as "none recorded".

### Switching an app's repository

`set_app_repository` switches an app's next builds to one of the builder's own connected repositories. It also switches back to the app's own managed repository, which is the only managed repository it accepts. It works whether or not managed repositories are on: with them off, it is how an app gets a default repository.

- Builds already made stay in the managed repository. `get_app_repository` still gives its clone credential, and `continue_from` on one of those builds says to push its branch to your own repository first.
- `remove_app` drops the app's repository record and the builder's access to its managed repository. The repository itself is left on the host.

### Setting up managed repositories

On the host's side (the GitHub adapter, `GitHubRepoHost` in `core/src/github.ts`), the operator:

1. Creates a GitHub organization for managed repositories.
2. Installs Mynt's GitHub App on it for all repositories, with Administration (write) as well as contents and pull requests (write).
3. Sets `BUILD_MANAGED_REPO_OWNER` to the organization's name.

Without `BUILD_MANAGED_REPO_OWNER`, a build without a repository gives a preview and no push.

## Agent workspaces

Every hosted agent is steered by a folder in this repository, never by prompts in the code. An agent's folder is its agent workspace.

When an agent starts, Mynt copies its folder into the sandbox and makes it the agent's working directory. Claude Code picks up its `CLAUDE.md` and skills from there, the skills call the folder's scripts, and the job's data arrives under `job/`. To improve an agent, change its folder.

| Folder under `core/workspaces/` | Agent |
| --- | --- |
| `coding-build/` | The builders' coding agent: `CLAUDE.md`, `.claude/agents/` (its team), skills, `templates/mynt-app` (the Compose app) and scripts |
| `build-audit/` | The audit-only agent in a build's clean verification sandbox (`maxwell-static-audit`) |
| `product-desk/` | The product desk agent, which designs models in the firm's repository (`model-contract`, `financial-modelling`) |
| `algorithm-explorer/` | The explorers that try to improve one decision algorithm of a product, with their angles in `angles.json` |
| `governance-review/` | The Mynt admins' review agent: checklists, register skills and evidence scripts |
| `connector/` | The business-development agent: prospecting, outreach, replies and consent, introductions |
| `program-audit/` | The independent auditor of a Solana program a firm wants on mainnet |
| `program-red-team/` | The agent that attacks that program from outside, with only its bytes and its interface description |

Whatever an agent produces, Mynt checks it itself afterwards:

- **builds:** a clean-sandbox verification;
- **the desk:** running the agent's code;
- **reviews:** re-verifying quotes and computing the recommendation;
- **the connector:** the rules in `send()`.

The two program agents are part of the [mainnet program gate](solana-programs.md#mainnet-program-gate).

## Hosting

Builders can run their apps' financial part on Mynt: the server that holds the app key, calls contract actions and handles webhooks.

There are two modes:

- **Direct hosting on Freestyle** is the default whenever `FREESTYLE_API_KEY` is set.
- The legacy **gateway mode** (`HOSTING_GATEWAY_*`) is used only without Freestyle.

A workspace's owners and admins turn hosting on with `request_hosting`, and `hosting_status` shows the workspace's hosting, the apps it hosts and each one's public address. `deploy_app(app_id, build_id)` takes only a build that passed Mynt's verification.

### Put online

In Mynt Studio, the app's top bar shows where the app stands: Online at its address, Deploying or Not online. Beside it is the Put online button.

1. Put online opens a sheet. It shows the app's newest verified build, the repository and commit it deploys, and what happens.
2. Confirming turns the workspace's hosting on if needed (`request_hosting`, for owners and admins), then hosts the build with `deploy_app`.
3. The sheet follows the deploy until the app answers at its address.

When the app already runs an older build, the confirm button reads "Put the new build online".

A build that pushed nowhere can't be hosted, because Mynt has no commit to fetch. The sheet says so and offers Choose repository for the app's next build.

The builder chat shows the same Put online action after a build ships. The app uses a sandbox key until it is in Production and published.

### Direct hosting on Freestyle

With `FREESTYLE_API_KEY` set, Mynt drives [Freestyle](https://www.freestyle.sh) VMs through Freestyle's API, one VM per hosted app, instead of a tunnel.

**The app's key is never on its VM.**

- Calls to Mynt's API get the app's key added on the way out by Freestyle's edge as `X-Mynt-App-Key`, from a rule only Mynt can write. The rule reads back masked.
- Mynt honours that header only next to the placeholder bearer of the same environment, and never on `/v1/client/*`. A customer's client session is therefore never swapped for the app's key.
- Anything the app sends to Mynt's other routes carries the key, so an app must never forward callers' requests there. The starter app's web server forwards only `/v1/client/*`, and the compliance reviewer and readiness checks hold every build to that.
- The app holds a placeholder of the right shape (`mynt_<env>_injected_at_edge`). It trusts the edge's CA through the VM's bundle, mounted read-only (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`).
- A VM per app is what lets each app's calls carry its own key.

**The VM starts with nothing in and nothing out.**

- Its first boot may reach only gVisor's release host, to install its pinned, checksummed release.
- After that its egress is exactly the app's allowlist, as per-domain rules that pass TLS straight through. Only Mynt's host is terminated, to add the key.
- The npm registries, which Freestyle's edge can't carry yet, are allowed by their own addresses instead.

**Deploying** builds the verified commit on the app's VM as a detached job. The source token travels as the job's environment, never its text. Containers run under gVisor, read-only, with no capabilities and limited CPU and memory, and the VM is a Firecracker microVM of its own.

**Serving.** Each app (each labelled Compose service) gets a public HTTPS route, `https://mynt-<app>.style.dev` or `<app>.<HOSTING_APPS_DOMAIN>`, straight to its port.

**The builder logs in.** `vm_access` returns SSH commands for their own Linux user (in the docker group, no sudo) on each of their apps' VMs, valid for a few hours. They work as VS Code Remote-SSH hosts too, and new logins revoke the last.

**The kill switch** pauses every app VM. `undeploy_app` deletes the app's VM, which takes its rules and key with it.

### Gateway mode

Gateway mode gives each builder one VM that is never reachable from the internet or from the platform's network.

- **First boot.** The VM installs Docker, gVisor and WireGuard, then generates its own WireGuard key, which never leaves it.
- **Registration.** It registers with a one-time token (`POST /v1/hosting/bootstrap`). Mynt then locks its cloud firewall down to WireGuard to the gateway, and nothing else in or out.
- **All traffic goes through the tunnel.** The gateway forwards nothing directly. Its egress proxy reaches only Mynt's API, GitHub, package registries and the hand-off hosts of the app's products.
- **Deploying.** The VM's agent polls its policy (`GET /v1/hosting/policy`), which gives it the verified commit, a read-only, short-lived token to fetch it, and the app's dedicated key (stored sealed). The agent builds the image and runs it under gVisor: read-only, with no capabilities, and limited CPU and memory.
- **Serving.** Customers reach the app at `<app>.<HOSTING_APPS_DOMAIN>`, through the edge and the tunnel.
- **The kill switch.** A Mynt admin's `suspend_tenant` takes the VM off the gateway at once (peers, routes and egress) and powers it off. `resume_tenant` brings it back, and `undeploy_app` stops a single app. `list_tenants` lists every hosting VM with its status, its tunnel address and the apps it runs.

[`deploy/host/hosting-gateway.sh`](../../deploy/host/hosting-gateway.sh) sets up the gateway on the host that runs Mynt. A timer re-syncs it every minute from `mynt hosting wg-peers`, `egress-allowlist` and `routes`.

Gateway mode is enabled with `HOSTING_DO_TOKEN`, `HOSTING_GATEWAY_ENDPOINT`, `HOSTING_GATEWAY_PUBLIC_KEY` and `PUBLIC_URL`. DigitalOcean is the first provider.

### Working with a hosted app

Builders reach their app's container through Mynt.

| Tool | Does |
| --- | --- |
| `app_status` | State, health, restarts, CPU and memory |
| `app_logs` | The app's logs |
| `app_run` | A command inside the app's container, under gVisor, never on the VM itself |
| `restart_app` | Restarts the app |

Mynt runs each one on the app's VM, only against that builder's own app container, and posts the result back, scrubbed of secrets. Under direct hosting they run at once. In gateway mode, the VM's agent claims the request over the tunnel within a few seconds. Every request is audited.

## Campaigns

Promoting a financial product is a regulated act, and Mynt treats it as one.

### Segments and campaigns

- **Segments** pick consumers by what they currently hold: `enrolled_in`, `enrolled_in_lines`, and `not_enrolled_in` for cross-sell. Tools: `create_segment`, `list_my_segments`.
- **Campaigns** target a segment (or everyone) on chosen channels, with up to 5 copy variants for A/B tests. Tools: `create_campaign`, `update_campaign`, `list_my_campaigns`.

### The lint

`lint_campaign` checks every variant against its products.

- It blocks guaranteed or risk-free claims for products that can lose value.
- It requires a market-risk disclosure for market-linked products.
- It requires interest and fee disclosure for credit.

`launch_campaign` refuses copy that fails.

### Going live

- A campaign over the launcher's own (or their firm's) products, or the open reference catalogue, goes live once its copy passes the lint.
- A campaign over another builder's products becomes `pending_approval` and lands in that builder's inbox (`list_requests`, `review_request`). It goes live when every product's builder approves, and drops back to draft on any rejection.
- `pause_campaign` and `end_campaign` stop one. Mynt admins can list and pause any campaign (see [Oversight](platform-admin.md#oversight)).

### Attribution

Live campaigns show up in consumers' `list_offers`. Each consumer always sees the same variant, and `enroll_in_product` with the offer's `campaign_id` is attributed.

`get_campaign_metrics` reports audience, enrolments, conversion, and results per variant and per product.
