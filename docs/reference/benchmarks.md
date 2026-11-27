# Agent benchmarks

[Back to the reference index](../reference.md)

This file covers how Mynt measures its own hosted agents: the task sets, what a run does, how a task is scored, what a run costs and how it is capped, and the regression gate to use before changing an agent's instructions, skills or model.

Mynt's other tests check the machinery around the agents with stand-in agents. A benchmark run is the only thing that measures how well the real agents do real work. It spends money, so it never starts on its own: a Mynt admin starts each run, with a cap.

## What is measured

Each hosted agent has a task set: a JSON file in `core/benchmarks/`, named `<agent>.v<version>.json` and checked against `core/schemas/benchmark-task-set.schema.json`. The tasks are fixed, so two runs of the same set are comparable.

| Agent | Task set | Tasks | What a task is | A task passes when |
| --- | --- | --- | --- | --- |
| Coding agents (`coding-build`, with `build-audit`) | `coding.v1.json` | 8 | An app build, from one of the starter app ideas, on the products that idea names | Mynt's verification ships the build: the source is re-checked in a clean sandbox and none of the task's checks fails. Where the deployment runs the independent audit, that must pass too |
| Product desk (`product-desk`) | `product-desk.v1.json` | 6 | A starter product idea as a product record with a term sheet. The agent builds a feasibility model for it | Mynt itself runs the agent's model in a clean sandbox and gets a well-formed report with an expected verdict |
| Governance desk (`governance-review`) | `governance-review.v1.json` | 6 | A product review case with a known answer: three sound, three with one planted breach | Bad sample: Mynt's recommendation is to reject, and the planted item is not met with a quote Mynt verified. Good sample: nothing is marked not met and the recommendation isn't to reject |
| Connector (`connector`) | `connector.v1.json` | 5 | A connector session against an invented pipeline. Dry run only | The pipeline the session left behind matches what the task expects: who has a draft, who has none, which replies are handled, which consent is recorded |
| Program audit (`program-audit`) | `program-audit.v1.json` | 4 | A Solana program's source: one sound, three with a planted flaw | Not runnable yet. See [What isn't built yet](#what-isnt-built-yet) |
| Program red team (`program-red-team`) | `program-red-team.v1.json` | 4 | The same four programs, attacked from their bytes | Not runnable yet |

Coding and product-desk tasks are taken from the starter ideas in `core/workspaces/coding-build/templates/` (`ideas.v2.seed.json` and `product-ideas.seed.json`), never from production data. The governance samples' firms and products are invented; the regulations they are checked against are real United States rules, summarised in the case. The connector's people are invented, with addresses on `example.com`. The program samples are the mainnet gate's test fixtures and the coding agents' starter program.

Changing a task changes what a score means. Add a new version of the file instead of editing a released one. A run records the hash of the task set it used, and two runs of different sets can't be compared.

### What a run records

For the run: the agent, the task set with its version and hash, the model, a content hash of each agent workspace folder the set exercises (every file's path and text), the commit the server ran from when it runs from a git checkout, the cap, what the cap has counted, who started it, and why it stopped if it did.

For each task:

| Field | What it holds |
| --- | --- |
| Outcome | `passed`, `failed` or `not_run` |
| Failed check | The check that failed: `secrets_scan`, `static_scan` (the code scan), `tests`, `lint_typecheck`, `dependency_audit`, `sbom`, `disclosures`, `independent_audit`, `agent_exit`, `budget`, `mynt_model_run`, `report_expectations`, `planted_problem_caught`, `evidence_verified`, `nothing_falsely_flagged`, and the connector's checks |
| Failure class | `agent`, `infrastructure` or `harness` |
| Checks | Each of Mynt's checks for the task, with its status and detail |
| Cost | US dollars: the agent's model spend and its sandboxes' time. For a build, the parts are recorded separately, with Mynt's audit |
| Duration | From when the job was queued to when Mynt decided it |

A figure nothing measured is recorded as empty with a note saying why. It is never shown as 0.

### Failure classes

Only failures that are the agent's count against it.

| Class | Means | Counted in the pass rate |
| --- | --- | --- |
| `agent` | The agent's work didn't pass, the agent exited with an error, or it spent past its task's budget | Yes |
| `infrastructure` | The sandbox host ran out of allowance or capacity, a provider had an outage, a sandbox never came up, the agent's runner couldn't install or start, or Mynt's own verification didn't report | No |
| `harness` | The benchmark itself failed: a task couldn't be started, or an admin stopped the run while it was in flight | No |

A task is `not_run` when the run's cap was reached before it, the run was stopped, or something it needs isn't on this Mynt (for example, no published product matches the name a coding task asks for). The reason is recorded with it.

The pass rate is passed tasks over tasks that passed or failed on the agent's own account. Infrastructure failures, harness failures and tasks not run are listed beside it and left out of it.

## How scoring works

Agents never grade their own work. The harness never reads what an agent says about its result. A task's outcome is read from the record Mynt's own checks left, outside the agent's sandbox:

- **Coding.** The build service's decision and its verification report: the source hash-checked and re-checked in a clean sandbox with no secrets, and the independent audit by a different agent in a different sandbox where the deployment runs one.
- **Product desk.** The report from Mynt's own run of the agent's branch in a clean sandbox with no agent in it.
- **Governance desk.** Mynt's recommendation, computed by Mynt from the agent's answers after Mynt re-checked every quote against its source.
- **Connector.** The benchmark pipeline's rows after the session: drafts, replies handled, consents, stages, introductions.

## The benchmark context

A run uses the same production code as real work. Each agent's service (`BuildService`, `DeskService`, `ReviewService`, `BdService`) runs a second time as the benchmark's own instance: the same class, queue, worker tick, budgets, sandboxes, agent launch through Mynt's agent proxy, and verification.

What keeps it apart from everything real:

- **Its own tables.** The benchmark's instances read and write a `bench_` twin of every table an agent service owns (`bench_build_runs`, `bench_desk_jobs`, `bench_review_cases`, `bench_bd_*` and the rest). A benchmark's jobs are never in the real queues, lists, statistics or monthly budgets, and no real job is in a benchmark's.
- **Its own account.** What must exist in the shared records belongs to an account named "Mynt benchmarks" that nobody can sign in as: one app per coding task in that account's own workspace, and for the product desk a firm named "Mynt benchmarks (not a firm)" holding one draft product per task. These are visible to a Mynt admin in the platform admin's lists, under those names.
- **No monthly budget of anyone's.** A developer's, a workspace's, a firm's and the governance desk's monthly budgets are untouched. The run's own cap governs.
- **Governance samples touch no record.** A sample's case is given whole to the governance desk's benchmark instance. No firm, licence or product is created or read.

### The connector can't contact anyone

A connector benchmark is a dry run by construction, not by a setting:

- The benchmark's connector is created with no channel senders, in code. There is no parameter, operational setting or environment variable through which a benchmark could be given a way to send email, WhatsApp or a call. Every message it writes is kept as a draft.
- Its pipeline is its own set of tables, emptied and filled with the task's invented people before each task. The real pipeline's people are never in it.
- A benchmark run's token reaches the benchmark's connector tools only, never the real connector's.
- If a message were ever recorded as sent, the task fails as a harness failure named `message_left_the_benchmark`.

## The cap

A run stops spending in two ways.

- **`cap_usd`, required when a run starts.** There is no default. Each task may spend at most what is left of the cap, and never more than the agent's own per-job cap (`BUILD_CAP_USD`, `DESK_JOB_CAP_USD`, `REVIEW_CASE_CAP_USD`, `BD_RUN_CAP_USD`). Room is kept for what Mynt may spend on top of a task: the independent audit's cap, where the deployment runs it. When what is left isn't enough for another task, the run ends as `stopped_at_cap`, the reason is recorded on the run, and the tasks left are recorded as not run.
- **`BENCHMARK_CAP_USD`, an operational setting.** The most any one run's cap may be. Default 25, a number from 1 to 2000. A Mynt admin changes it in the platform admin's [Platform settings](platform-admin.md#platform-settings).

Within a task, spend is held the way it is for any job: the agent proxy meters every model call against the task's budget and refuses calls once it is spent, and the service stops a job whose cost passes its cap. That stop is recorded as the agent's failure, with the check `budget`. Where a task's cost wasn't measured, the cap counts the task's whole budget, so the cap never under-counts.

If the sandbox host runs out of allowance during a run, the run stops there with the reason, and no further task is tried.

## How to run

A run is started by a Mynt admin, from the platform admin's **Agent benchmarks** page (**Start run**) or with the tool. One run goes at a time, and its tasks run one after another.

| Tool | What it does |
| --- | --- |
| `list_benchmark_runs` | The runs, newest first, each with its scoreboard. Also every agent with a task set: what a run needs and whether one could start here now |
| `get_benchmark_run` | One run: its scoreboard and every task with its outcome, failed check, failure class, checks, cost and duration |
| `compare_benchmark_runs` | A candidate run against a baseline: pass rate, cost and time deltas, per-task changes, regressions listed, and the gate's verdict |
| `start_benchmark_run` | Starts a run. Takes `agent` and `cap_usd`, and optionally `label`, `task_ids`, `repository` (product desk only) and `host_restored`. Audited |
| `stop_benchmark_run` | Stops a run that is going. The task in flight is recorded as stopped by the harness; the rest as not run. Audited |

`start_benchmark_run` refuses, saying why, when:

- no cap is given, or the cap is over `BENCHMARK_CAP_USD` or too small for one task;
- no sandbox host, no model backend or no `PUBLIC_URL` is configured;
- the last real build to end failed because the sandbox host's allowance was used up, and none has run since. Once billing is added at the host, start the run with `host_restored: true`;
- another run is still going;
- something the agent's run needs is missing (below);
- the agent is `program-audit` or `program-red-team`.

### What each agent's run needs

| Agent | Needs |
| --- | --- |
| Coding | Published products named as the tasks name them. No repository: a benchmark build pushes nowhere and opens no pull request |
| Product desk | Mynt's GitHub App, and `repository`: a repository set aside for benchmarks with the App installed. The agent pushes a branch per task there and Mynt opens a pull request for each |
| Governance desk | Nothing more |
| Connector | Nothing more |

### What a run costs

Nothing has been measured yet: no real run has been made. The ceiling is known. A task can't spend more than the agent's per-job cap, so with the default settings a whole set costs at most:

| Agent | Tasks | Per-task cap | At most |
| --- | --- | --- | --- |
| Coding | 8 | `BUILD_CAP_USD` 10 (plus `BUILD_AUDIT_CAP_USD` 5 where the audit runs) | US$80, or US$120 with the audit |
| Product desk | 6 | `DESK_JOB_CAP_USD` 5 | US$30 |
| Governance desk | 6 | `REVIEW_CASE_CAP_USD` 3 | US$18 |
| Connector | 5 | `BD_RUN_CAP_USD` 3 | US$15 |

These are ceilings, not estimates. With `BENCHMARK_CAP_USD` at its default of 25, a full coding run doesn't fit under one cap: raise the setting, or run part of the set with `task_ids`. The first real run's recorded costs are the basis for an estimate.

## The regression gate

Use it before changing an agent's instructions (`core/workspaces/<agent>/CLAUDE.md`), its skills, its scripts or its model.

1. Start a run of the agent on what is deployed now. This is the baseline. Label it.
2. Make the change and deploy it.
3. Start a second run of the same agent. This is the candidate.
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

`node scripts/benchmark-gate.mjs --validate` only checks the task sets and spends nothing. Mynt's test suite does the same, and runs the whole harness on stand-in agents, on every push (`core/test/benchmarks.test.js`).

## What isn't built yet

- **Program audit and program red team runs.** Their task sets and samples are in place and checked. They can't run: the mainnet program gate reviews only a mainnet program's own verified build, and a benchmark must not register mainnet programs. The gate needs an entry point that takes a sample's source directly and, for the red team, compiles it.
- **The algorithm explorer and Ask AI** have no task set.
- **Entity and licence review samples.** The governance set holds product reviews only, because their answer is in the case. Firm and licence reviews depend on what public registers return on the day.
