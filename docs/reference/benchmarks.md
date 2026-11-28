# Agent benchmarks

[Back to the reference index](../reference.md)

This file covers how Mynt measures its own hosted agents: the task sets, what a run does, how a task is scored, what a run costs and how it is capped, and the regression gate to use before changing an agent's instructions, skills or model.

Mynt's other tests check the machinery around the agents with stand-in agents. A benchmark run is the only thing that measures how well the real agents do real work. It spends money, so it never starts on its own: a Mynt admin starts each run, with a cap.

## What is measured

Each hosted agent has a task set: a JSON file in `core/benchmarks/`, named `<agent>.v<version>.json` and checked against `core/schemas/benchmark-task-set.schema.json`. The tasks are fixed, so two runs of the same set are comparable. A run uses the latest version of its agent's set.

| Agent | Task set | Tasks | What a task is | A task passes when |
| --- | --- | --- | --- | --- |
| Coding agents (`coding-build`, with `build-audit`) | `coding.v1.json` | 8 | An app build, from one of the starter app ideas, on the products that idea names | Mynt's verification ships the build: the source is re-checked in a clean sandbox and none of the task's checks fails. Where the deployment runs the independent audit, that must pass too |
| Product desk (`product-desk`) | `product-desk.v1.json` | 6 | A starter product idea as a product record with a term sheet. The agent builds a feasibility model for it | Mynt itself runs the agent's model in a clean sandbox and gets a well-formed report with an expected verdict |
| Algorithm explorer (`algorithm-explorer`) | `algorithm-explorer.v1.json` | 4 | A decision algorithm to improve (knock-outs, pricing, eligibility, limits), from a baseline shipped in `core/benchmarks/fixtures/algorithms/`, on applicants Mynt generates. One explorer per task | Mynt scored the commit the explorer pushed on the holdout only Mynt sees, every constraint passes there, and it ranks above the baseline: the baseline is ineligible, or the objective is strictly higher. Pushing the baseline back unchanged fails |
| Governance desk (`governance-review`) | `governance-review.v2.json` | 15 | A review case with a known answer: six product cases, four firm cases and five licence cases; seven sound, eight with one planted problem | Bad sample: Mynt's recommendation is to reject, and the planted item is not met with a quote Mynt verified. Good sample: nothing is marked not met and the recommendation isn't to reject (an item the case says nothing about may stay silent) |
| Connector (`connector`) | `connector.v1.json` | 5 | A connector session against an invented pipeline. Dry run only | The pipeline the session left behind matches what the task expects: who has a draft, who has none, which replies are handled, which consent is recorded |
| Program audit (`program-audit`) | `program-audit.v1.json` | 6 | A Solana program's source: one sound, five with a planted flaw | Bad sample: the auditor reports a critical or high finding in the named file whose quote Mynt finds there. Good sample: no verified critical or high finding |
| Program red team (`program-red-team`) | `program-red-team.v1.json` | 3 | A Solana program's compiled bytes and interface: one sound, two an outsider can exploit | Bad sample: Mynt, re-running the red team's proof of concept on a fresh validator in a sandbox of its own, confirms an exploit. Good sample: none is confirmed |
| Ask AI (Studio's cited answers) | `ask-ai.v1.json` | 13 | A fixed question over a fixture dataset that ships in the set | Mynt's deterministic checks of what Ask AI did all pass. See [Ask AI](#ask-ai) |

Coding and product-desk tasks are taken from the starter ideas in `core/workspaces/coding-build/templates/` (`ideas.v2.seed.json` and `product-ideas.seed.json`), never from production data. The explorer's product records come from the same starter ideas, and its applicants from Mynt's own generator (`core/src/explore-data.ts`), which models them as credit applicants whatever the product line. The governance samples' firms and products are invented, and marked as invented in each case; the regulators, licence types and rules they are checked against are real United States ones. The connector's people are invented, with addresses on `example.com`. The Ask AI dataset is invented.

Changing a task changes what a score means. Add a new version of the file instead of editing a released one (`governance-review.v1.json` stays beside v2 for that reason). A run records the hash of the task set it used, and two runs of different sets can't be compared.

### Governance samples: firms and licences from a register copy in the case

A firm or licence review normally depends on what a public register answers on the day. A benchmark can't depend on that, so each firm and licence case carries a copy of the register entry inside the case (`subject.register_copy`), labelled as a fixture and stated not to be a live register's answer. The reviewer may quote the case (`mynt://case`), and Mynt checks each such quote against the case it handed over, exactly as it checks a quote against a fetched page. No live register is needed to pass, and no firm, licence or product record is created or read.

What only a real run can show: the reviewer has web access and its skills talk about live registers. Whether a real reviewer relies on the copy in the case, or goes silent because the invented firm isn't on any live register, hasn't been measured.

### Program samples

Program audit and program red team run through the mainnet program gate's own code (`MainnetGateService.openForSamples` and `requestSample`, `core/src/solana/mainnet-gate.ts`): the same sandboxes, scripts, agent workspaces, time limits and verdict logic as a real mainnet review. What differs, by construction:

- **No program exists.** A sample's review lives in tables of its own (`bench_solana_mainnet_reviews`, `bench_solana_mainnet_review_log`) with no link to the program registry. The sample gate has no registry at all: it refuses to request, approve, cancel, check or claim a review, no deploy ever asks it, and it touches no month's review budget. The real gate refuses samples.
- **Mynt makes the sample whole.** In a sandbox of its own, Mynt scaffolds the coding agents' starter program with their own scaffold script, as shipped, and lays the sample's files over it. For the audit it captures that workspace. For the red team it compiles it with Mynt's verifiable Solana build (`solana-verify.sh build`); the red team gets the bytes and the IDL Mynt checked against them, and never the source.
- **Mynt's hard rules are recorded, and stop nothing.** A real review ends at the hard rules or at a sure static-analysis finding, before any agent runs. A sample must reach the agent being measured, so both verdicts are recorded as checks (`mynt_hard_rules`, `static_analysis`) that count for nobody, and the auditor isn't shown the hard-rule results. The auditor still gets the static tools' report, as in a real review.

The audit's bad samples are the gate's three hard-rule fixtures (a token vault, a hard-coded admin, a close paying a non-signer) and two access-control flaws. The red team's bad samples are only the two access-control flaws: an outsider without the owner's keys can't exploit the hard-rule fixtures, so they would be unfair there. A sample Mynt can't prepare or build is recorded as the harness's failure, never the agent's.

`node scripts/benchmark-samples.mjs <dir>` prepares every audit sample on your machine exactly as a run would, and `--build` compiles every red-team sample (it needs docker). CI's `solana-program` job runs both on every change to `core/`, so a sample that stops compiling with the pinned toolchain is caught there and not in a paid run. Neither starts an agent.

### Ask AI

Ask AI is Studio code, so its runner lives in Studio and its scoring in Mynt:

1. An admin starts the run like any other (**Start run**, agent "Ask AI", a cap). It needs no sandbox host.
2. The admin keeps the run's page open. The page calls Studio's `POST /api/admin/benchmarks/ask` once per step. Each step takes the next task from Mynt (`next_benchmark_task`: the question and the fixture, never what is expected), answers it with the same code path as a real question (the same instructions, tool list, read loop, source numbering and answer cleaning), and hands the whole record in (`submit_benchmark_answer`). The only difference from a real question is where reads are answered from: the task set's fixture, with no connection to Mynt's data at all.
3. Mynt scores the record (`core/src/benchmark-ask.ts`) with named, deterministic checks: every citation is a source the run retrieved, the required sources are cited, Ask AI's own flag for an uncited statement isn't set, required facts are stated and forbidden ones absent, no planted secret-looking value is in what the model was handed or in the answer, only reads were attempted, a question the data can't answer is said not to be covered, and an out-of-scope request is declined. No model judges an answer.

If no record arrives within six minutes (the page was closed), the task fails as the harness's and the run stops with the reason.

Not scored, because it can't be checked without a judge: whether a cited source really supports the sentence it follows, answer quality and tone, a refusal in the model's own words (only Ask AI's two fixed forms count), and follow-up questions.

The benchmark calls the answer-writing code directly, so the per-person hourly question limit isn't exercised.

### What a run records

For the run: the agent, the task set with its version and hash, the model, a content hash of each agent workspace folder the set exercises (every file's path and text; for Ask AI, a hash of its instructions), the commit the server ran from when it runs from a git checkout, the cap, what the cap has counted (`charged_usd`, with its two parts: `measured_usd` and `reserved_usd`, see [The cap](#the-cap)), who started it, which tasks were chosen, and why it stopped if it did.

For each task:

| Field | What it holds |
| --- | --- |
| Outcome | `passed`, `failed` or `not_run` |
| Failed check | The check that failed: a build's (`secrets_scan`, `static_scan`, `tests`, `lint_typecheck`, `dependency_audit`, `sbom`, `disclosures`, `independent_audit`), `agent_exit`, `budget`, the desk's (`agent_finished`, `mynt_model_run`, `report_expectations`), the explorer's (`beats_baseline` and its constraints), the review's and the audit's (`planted_problem_caught`, `evidence_verified`, `nothing_falsely_flagged`, `audit_complete`), the red team's (`exploit_confirmed`, `red_team_complete`), the connector's and Ask AI's |
| Failure class | `agent`, `infrastructure` or `harness` |
| Checks | Each of Mynt's checks for the task, with its status and detail |
| Cost | US dollars: the agent's model spend and its sandboxes' time. For a build, the parts are recorded separately, with Mynt's audit |
| Duration | From when the job was queued to when Mynt decided it |

A figure nothing measured is recorded as empty with a note saying why. It is never shown as 0.

### Failure classes

Only failures that are the agent's count against it.

| Class | Means | Counted in the pass rate |
| --- | --- | --- |
| `agent` | The agent's work didn't pass, the agent exited with an error, it never pushed its branch, or it spent past its task's budget | Yes |
| `infrastructure` | The sandbox host ran out of allowance or capacity, a provider had an outage, a sandbox never came up, the agent's runner couldn't install or start, Mynt's own verification didn't report, or the agent's pushed branch couldn't be moved to Mynt's clean sandbox | No |
| `harness` | The benchmark itself failed: a task couldn't be started, a program sample couldn't be prepared or built, the Ask AI runner never handed in a record, or an admin stopped the run while it was in flight | No |

A task is `not_run` when the run's cap was reached before it, the run was stopped, or something it needs isn't on this Mynt (for example, no published product matches the name a coding task asks for). The reason is recorded with it.

The pass rate is passed tasks over tasks that passed or failed on the agent's own account. Infrastructure failures, harness failures and tasks not run are listed beside it and left out of it.

## How scoring works

Agents never grade their own work. The harness never reads what an agent says about its result. A task's outcome is read from the record Mynt's own checks left, outside the agent's sandbox:

- **Coding.** The build service's decision and its verification report: the source hash-checked and re-checked in a clean sandbox with no secrets, and the independent audit by a different agent in a different sandbox where the deployment runs one.
- **Product desk.** The report from Mynt's own run of the agent's branch in a clean sandbox with no agent in it.
- **Algorithm explorer.** Mynt's own scoring of the pushed commit and of the baseline on the holdout, in clean sandboxes.
- **Governance desk.** Mynt's recommendation, computed by Mynt from the agent's answers after Mynt re-checked every quote against its source.
- **Connector.** The benchmark pipeline's rows after the session: drafts, replies handled, consents, stages, introductions.
- **Program audit.** Mynt's pass over the auditor's findings: a finding counts only when its quote is in the file it names.
- **Program red team.** Mynt's own re-run of each proof of concept, judged from the chain.
- **Ask AI.** Mynt's deterministic checks of the record of what Ask AI did.

## The benchmark context

A run uses the same production code as real work. Each agent's service (`BuildService`, `DeskService`, `ExploreService`, `ReviewService`, `BdService`, `MainnetGateService`) runs a second time as the benchmark's own instance: the same class, queue, worker tick, budgets, sandboxes, agent launch through Mynt's agent proxy, and verification.

What keeps it apart from everything real:

- **Its own tables.** The benchmark's instances read and write a `bench_` twin of every table an agent service owns (`bench_build_runs`, `bench_desk_jobs`, `bench_explore_jobs`, `bench_review_cases`, `bench_bd_*`, `bench_solana_mainnet_reviews` and the rest). A benchmark's jobs are never in the real queues, lists, statistics or monthly budgets, and no real job is in a benchmark's.
- **Its own account, hidden everywhere else.** See [The benchmarks' own records](#the-benchmarks-own-records).
- **No monthly budget of anyone's.** A developer's, a workspace's, a firm's, the governance desk's and the mainnet gate's monthly budgets are untouched. The run's own cap governs.
- **Governance samples touch no record.** A sample's case is given whole to the governance desk's benchmark instance. No firm, licence or product is created or read.
- **No repository of anyone's.** The benchmark's desk and explorer are opened with no GitHub App at all, whatever the deployment has. See [No repository](#no-repository).
- **Tokens die with their task.** A benchmark agent's token resolves only through the benchmarks, for the budget of its own task, and is refused by the agent proxy and by `/mcp` once its task is scored, the run finishes or the run is stopped. It is no user's token: it can't read a workspace's data or call any tool but, for a connector session, the benchmark connector's own.
- **One run, one step at a time.** A unique index holds one queued or running run, so two starts at the same moment can't both begin; and the worker's step is taken under a database lock, so two servers on one database can't start a task twice or count its cost twice.

### The benchmarks' own records

A run needs a few rows in the shared records: an account named "Mynt benchmarks" that nobody can sign in as, with its workspace; one app per coding task; and, for the product desk and the explorer, a stand-in firm named "Mynt benchmarks (not a firm)" holding one draft product per task.

They carry one mark (`core/src/benchmark-marker.ts`). `users.benchmark` is set on the benchmark's account, by the benchmarks and nothing else, and every workspace, app, firm and product inherits the mark from the account that creates it, in the statement that creates it. Nothing matches on a name. Every list, count, search and directory over those tables leaves marked rows out:

- the platform admin's Workspaces, Apps and Products lists and their totals, and the People and Firms lists;
- the product and app catalogues, and so the Marketplace, the search and Ask AI, which read through them;
- the identity provider's organization sync, so no organization is ever made for the benchmark's workspace;
- the operations summary.

The one place that lists them is the platform admin's **Agent benchmarks → Records** tab (`list_benchmark_runs` returns them as `records`). Rows an earlier version made unmarked are marked the next time the benchmark's account is used.

Not hidden: the audit trail. A start and a stop are an admin's audited actions, and stay there.

### No repository

In production the desk agent and the explorers work in a firm's GitHub repository: they push a branch, and Mynt clones it in a clean sandbox. In a benchmark the repository is only the transport between the agent's sandbox and Mynt's clean one, so the benchmark replaces it (`core/src/scratch-repo.ts`):

- Before the agent starts, Mynt makes a bare repository with a first commit inside the agent's own sandbox, and points git's address for the repository at it. The agent follows its unchanged workspace instructions (clone, branch, push); they aren't special-cased for a benchmark. For the explorer, the first commit holds the task's baseline algorithm.
- After the agent exits, Mynt reads the branch's head itself, packs exactly that commit with its sha256, moves it to the clean sandbox, checks the hash there, and runs the same runner or scorer on it.
- A branch the agent never pushed is the agent's failure. A bundle that can't be moved is the infrastructure's.

No GitHub App is needed, no token is minted, no pull request is opened, and no repository is named when a run starts: `start_benchmark_run` has no `repository` argument and refuses one. (Its first version took any repository the App was installed on and approved it for itself, which could have pushed branches into a customer's repository.) The scratch switch is set only in code, by the benchmarks; no environment variable or operational setting reaches it.

### The connector can't contact anyone

A connector benchmark is a dry run by construction, not by a setting:

- The benchmark's connector is created with no channel senders, in code. There is no parameter, operational setting or environment variable through which a benchmark could be given a way to send email, WhatsApp or a call. Every message it writes is kept as a draft.
- Its pipeline is its own set of tables, emptied and filled with the task's invented people before each task. The real pipeline's people are never in it.
- A benchmark run's token reaches the benchmark's connector tools only, never the real connector's.
- If a message were ever recorded as sent, the task fails as a harness failure named `message_left_the_benchmark`.

## The cap

A run stops spending in two ways.

- **`cap_usd`, required when a run starts.** There is no default. Each task may spend at most what is left of the cap, and never more than the agent's own per-task cap. That clamp is inside each service, not only in the harness: the job's own record, the budget handed to the agent, and the agent proxy's limit for its token all hold the smaller figure. Room is kept for what Mynt may spend on top of a task. When what is left isn't enough for another task, the run ends as `stopped_at_cap`, the reason is recorded on the run, and the tasks left are recorded as not run.
- **`BENCHMARK_CAP_USD`, an operational setting.** The most any one run's cap may be. Default 25, a number from 1 to 2000. A Mynt admin changes it in the platform admin's [Platform settings](platform-admin.md#platform-settings).

Within a task, spend is held the way it is for any job: the agent proxy meters every model call against the task's budget and refuses calls once it is spent, and the service stops a job whose cost passes its cap. That stop is recorded as the agent's failure, with the check `budget`. What the cap counts for a task is one of three things, the same for every agent:

- **Its measured cost**, when Mynt measured one.
- **Nothing**, when the task never got a sandbox (the host refused the VM, or the task couldn't be started). Nothing ran, so there is nothing to spend. The task's cost is empty, with a note saying no sandbox started; it is never shown as 0 and never as the task's budget.
- **Its whole budget, reserved**, when work did run (a sandbox started, or Ask AI's runner took the task) and its cost couldn't be measured. This keeps the cap from under-counting. It is a reservation, not money known to be spent: the task's cost stays empty with its note, and the reservation is recorded apart as `reserved_usd`, with `reserved_note`.

A run reports `charged_usd` (what the cap has counted), `measured_usd` and `reserved_usd` (its two parts) and, when anything was reserved, `charged_note`, which says so in words. The scoreboard's cost is only ever what was measured. The run's page shows the cap the same way: what was counted, and how much of that was measured and how much reserved, not measured.

If the sandbox host runs out of allowance during a run, the run stops there with the reason, and no further task is tried. No run of any agent that needs the sandbox host starts after that, until a Mynt admin says the allowance is back or something gets a sandbox again (see [How to run](#how-to-run)).

### What a set could cost, against the cap

Nothing has been measured yet: no real run has been made. The ceiling is known, because a task can't spend more than its cap plus what Mynt keeps on top of it. With the default settings:

| Agent | Tasks | One task, at most | The whole set, at most | Under the default cap of US$25 |
| --- | --- | --- | --- | --- |
| Coding | 8 | US$10 (`BUILD_CAP_USD`); US$15 where Mynt's audit runs (`BUILD_AUDIT_CAP_USD` 5) | US$80; US$120 with the audit | 2 tasks in full; 1 with the audit |
| Product desk | 6 | US$5 (`DESK_JOB_CAP_USD`) | US$30 | 5 tasks in full |
| Algorithm explorer | 4 | US$6.66 (one explorer's third of `EXPLORE_CAP_USD` 20) | US$26.64 | 3 tasks in full |
| Governance desk | 15 | US$3.50 (`REVIEW_CASE_CAP_USD` 3, and 0.50 a case may overrun by) | US$52.50 | 7 tasks in full |
| Connector | 5 | US$3.50 (`BD_RUN_CAP_USD` 3, and 0.50 of overrun) | US$17.50 | The whole set |
| Program audit | 6 | US$6 (`PROGRAM_AUDIT_CAP_USD` 5, and 1 for Mynt's sandboxes around it) | US$36 | 4 tasks in full |
| Program red team | 3 | US$9 (`PROGRAM_RED_TEAM_CAP_USD` 8, and 1 for Mynt's sandboxes) | US$27 | 2 tasks in full |
| Ask AI | 13 | US$1 (fixed in `core/src/benchmark-ask.ts`) | US$13 | The whole set |

These are ceilings, not estimates. The first real run's recorded costs are the basis for an estimate.

`list_benchmark_runs` works this table out live, per agent, from the settings in effect (`budget` on each agent: the per-task and whole-set ceilings, the cap, how many tasks the cap is sure to cover in full, and a note in plain words). **Start run** shows it before anything is spent, and lets the admin run a chosen part of a set (`task_ids`): the sheet lists the set's tasks to tick, and says what the cap typed covers of the tasks picked. When a cap can't cover even one task in full, it says so, with the figure that would.

A run of more tasks than its cap covers isn't refused: it runs what it can and stops at the cap. A cap too small to start even one task is refused.

## How to run

A run is started by a Mynt admin, from the platform admin's **Agent benchmarks** page (**Start run**) or with the tool. One run goes at a time, and its tasks run one after another.

| Tool | What it does |
| --- | --- |
| `list_benchmark_runs` | The runs, newest first, each with its scoreboard. Also every agent with a task set (its tasks, what a run needs, whether one could start here now (`can_start`, with `why_not` when it couldn't), and its budget against the cap), and the benchmarks' own records |
| `get_benchmark_run` | One run: its scoreboard and every task with its outcome, failed check, failure class, checks, cost and duration |
| `compare_benchmark_runs` | A candidate run against a baseline: pass rate, cost and time deltas, per-task changes, regressions listed, and the gate's verdict |
| `start_benchmark_run` | Starts a run. Takes `agent` and `cap_usd`, and optionally `label`, `task_ids` and `host_restored`. Audited |
| `stop_benchmark_run` | Stops a run that is going. The task in flight is recorded as stopped by the harness; the rest as not run. Audited |
| `next_benchmark_task`, `submit_benchmark_answer` | Used by Studio's Ask AI runner: the next task of an Ask AI run without its expected answers, and the record of what Ask AI did. The submission is audited |

`start_benchmark_run` refuses, saying why, when:

- no cap is given, or the cap is over `BENCHMARK_CAP_USD` or too small to start one task;
- no sandbox host, no model backend or no `PUBLIC_URL` is configured (an Ask AI run needs none of them here);
- the sandbox host's allowance is used up, as far as Mynt knows: the last real build to end failed on it and none has run since, or the last benchmark run of any agent to ask the host for a sandbox stopped on it and no sandbox has started since. Once billing is added at the host, start the run with `host_restored: true`. A run that then gets a sandbox clears it for every agent. Until then `list_benchmark_runs` shows `can_start: false`, `host_allowance_used_up: true` and this reason for every agent that needs the sandbox host. Ask AI needs none, so it is never held back by this;
- another run is still going;
- something the agent's run needs is missing (below);
- a `repository`, or any other argument it doesn't have, is passed.

### What each agent's run needs

Every agent but Ask AI needs a sandbox host with allowance left, the agents' model backend and `PUBLIC_URL`. Beyond that:

| Agent | Needs |
| --- | --- |
| Coding | Published products named as the tasks name them. No repository: a benchmark build pushes nowhere and opens no pull request |
| Product desk | The task set's regions and categories defined on this Mynt. No GitHub App and no repository. The sandbox image needs `git`, `curl` and `sha256sum` |
| Algorithm explorer | The same as the product desk, and `python3` in the sandbox image for the baselines |
| Governance desk | Nothing more |
| Connector | Nothing more |
| Program audit | The mainnet program gate set up on this Mynt (it is wherever sandboxes and the model backend are). Sandboxes that can run the static analysis tools |
| Program red team | The same, and sandboxes that can run containers, for Mynt's verifiable Solana build. Where the red team is set to [a second model backend](solana-programs.md#the-red-teams-model-backend) (`RED_TEAM_BACKEND`), that backend's key, model and token prices: `list_benchmark_runs` says which is missing (`why_not`), and a run records the backend beside the model |
| Ask AI | Studio's own model key, and an admin keeping the run's page open. No sandbox host |

The **Task sets** tab shows each agent's needs and whether a run could start now, with the reason when it can't.

## The regression gate

Use it before changing an agent's instructions (`core/workspaces/<agent>/CLAUDE.md`), its skills, its scripts or its model.

1. Start a run of the agent on what is deployed now. This is the baseline. Label it.
2. Make the change and deploy it.
3. Start a second run of the same agent, with the same tasks. This is the candidate.
4. Compare them, in Studio (the candidate run's **Compare** tab), with `compare_benchmark_runs`, or with the script:

```
cd core && npm run build
node scripts/benchmark-gate.mjs --baseline <run> --candidate <run>
```

A `<run>` is a file holding what `get_benchmark_run` returned, or a run id when `DATABASE_URL` is set (the script only reads). The script never starts a run.

| Exit code | Verdict | Means |
| --- | --- | --- |
| 0 | pass | No regression beyond the thresholds |
| 1 | fail | A regression beyond them. Each reason is printed |
| 2 | inconclusive | The runs can't be compared, or too few of their tasks were scored in both |

A regression is a task that passed in the baseline and fails in the candidate on the agent's own account. A task that failed for infrastructure reasons or didn't run, in either run, is not compared: it is never a regression and never a pass.

| Threshold | Flag | Default |
| --- | --- | --- |
| Tasks that may regress | `--max-regressions` | 0 |
| How far the pass rate may fall, in percentage points | `--max-pass-rate-drop` | 0 |
| How far the run's cost may rise, in percent | `--max-cost-increase-pct` | Not checked |
| The share of tasks that must be scored in both runs | `--min-compared-share` | 0.8 |

The runs must be of the same agent and the same task set. The comparison says whether the model or the workspace folders changed between them. When neither did, any difference is run-to-run variation: one pair of runs doesn't show how large that is, so run the baseline twice before trusting a small difference.

`node scripts/benchmark-gate.mjs --validate` only checks the task sets and spends nothing.

## What the tests prove, and what they can't

Every test uses stand-in agents: no real agent, model or sandbox is started, and nothing is spent.

| Test file (`core/test/`) | What it proves |
| --- | --- |
| `benchmarks.test.js` | The task sets, the runner, scoring per agent, the cap, comparison and the gate script. With a host that refuses every VM: no task is charged on any agent's path (the program and scratch files cover their agents), the next start is refused until `host_restored` or a sandbox, and Ask AI is unaffected |
| `benchmarks-programs.test.js` | Program audit and red team through the gate's own code; no program, review or artifact row is ever made; the sample gate can approve nothing |
| `benchmarks-scratch.test.js` | The desk and the explorer with no GitHub App: zero calls to a repository host, the bundle transport against real `git`, and the per-task cap clamped inside the build, desk, connector and explorer services |
| `benchmarks-records.test.js` | A run's records change no list, count or search; the mark is inherited where a row is made |
| `benchmarks-cap.test.js` | Each set's ceiling against the cap, the task picker, the plain refusals |
| `benchmarks-http.test.js` | A real HTTP server: each kind of benchmark token on the agent proxy and on `/mcp`, metered, refused when spent, refused after the task and the run end, and unable to reach real data or the real connector |
| `benchmarks-postgres.test.js` | Startup and full stand-in runs on a real Postgres through a connection pool (skipped without `TEST_DATABASE_URL`; CI's core job sets it) |
| `benchmarks-governance.test.js` | The firm and licence cases end to end, and that no firm, licence or product is read |
| `benchmarks-ask.test.js` | Ask AI's scorer, check by check, and a full stand-in run through the two runner tools |

What no test can show, and only a real run will: that the sandbox image has what the scratch repository and the sample build need, that a real red team finishes its turn with a complete report (the first real runs ended theirs minutes in, without one; see [The red team's report](solana-programs.md#the-red-teams-report)) and can produce a proof Mynt confirms for the two exploitable samples, that the second model backend's provider accepts the red team's requests under the account's approval and its CLI finishes a long turn through Mynt's proxy (see [The red team's model backend](solana-programs.md#the-red-teams-model-backend)), that a real reviewer uses the register copy in a case, and what any of it costs.

## What isn't built yet

- **A dollar meter inside Ask AI itself.** The benchmark bounds Ask AI's spend from outside, by refusing a model call that could pass the task's budget. Ask AI in ordinary use has step and token limits, not a dollar budget.
- **A lending product for the explorer.** The starter ideas have none (Mynt is United States only for now), so the explorer's product records are deposit, bond and fund ideas that carry a decision algorithm.
- **No new CI job runs an agent.** CI validates the task sets, runs the harness on stand-ins, and compiles the program samples.
