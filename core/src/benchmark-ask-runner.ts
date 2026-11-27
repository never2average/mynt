import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { askFixture, askRates, ASK_TASK_CAP_USD, scoreAsk, type AskTask } from "./benchmark-ask.js";
import { taskSetFor, type BenchmarkTask } from "./benchmark-tasks.js";
import type { Adapter, Outcome } from "./benchmarks.js";
import type { Db } from "./db.js";
import type { Store, User } from "./store.js";

// Ask AI's benchmark adapter: an agent whose code runs outside this server.
//
// Every other benchmarked agent runs in one of Mynt's own services, so the harness starts its job and reads Mynt's
// verdict. Ask AI is Studio's code. So a task here is handed out and taken back: the harness marks the next task
// running (as for any agent: the run's cap, one run at a time, its tasks in order), a runner in Studio asks for it
// with next_benchmark_task (the question and the fixture scope it may read, never what the task expects), runs Ask
// AI's own pipeline on it, and hands back the raw record with submit_benchmark_answer. Mynt scores the record
// (benchmark-ask.ts) on its next tick. A task nobody answers in time is the harness's failure, and ends the run: no
// runner is there, so the tasks left would only time out one by one.
//
// Both tools are an admin's only, as starting a run is. A runner can't start a run, raise a cap, or answer for a run
// that has ended; one runner holds a task at a time.

const T = "financial_products";
const TABLE = `
  CREATE TABLE IF NOT EXISTS ${T}.benchmark_runner_tasks (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES ${T}.benchmark_runs(id),
    task_id text NOT NULL,
    cap_usd numeric NOT NULL,
    created_at timestamptz NOT NULL,
    -- the runner holding the task: a later claim (after the hold lapses) replaces it, and the older one can't submit
    claim uuid,
    claimed_at timestamptz,
    claimed_by uuid REFERENCES ${T}.users(id),
    -- the record as it arrived, kept whole; Mynt's reading of it is the task's result
    submission jsonb,
    submitted_at timestamptz,
    submitted_by uuid REFERENCES ${T}.users(id),
    closed_at timestamptz,
    closed_reason text
  );
  CREATE INDEX IF NOT EXISTS benchmark_runner_tasks_run_idx ON ${T}.benchmark_runner_tasks (run_id, task_id);
`;

type Row = Record<string, unknown>;
const ACTIVE = ["queued", "running"];
/** How long a task waits for a runner's record before it is the harness's failure, and how long one runner holds it. */
export const ASK_ANSWER_MS = 6 * 60_000;
export const ASK_HOLD_MS = 150_000;
/** The most a submitted record may weigh, as JSON. */
export const MAX_RECORD_BYTES = 600_000;
const AGENT = "ask-ai";

/** Why a runner's call is refused, in words for the admin. */
export class RunnerRefusal extends Error {}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export interface AskRunnerOptions {
  answerMs?: number;
  holdMs?: number;
  now?: () => number; // tests move the clock
}

export class AskBenchmarkRunner {
  private readonly answerMs: number;
  private readonly holdMs: number;
  private readonly now: () => number;

  private constructor(
    private readonly db: Db,
    o: AskRunnerOptions,
  ) {
    this.answerMs = o.answerMs ?? ASK_ANSWER_MS;
    this.holdMs = o.holdMs ?? ASK_HOLD_MS;
    this.now = o.now ?? Date.now;
  }

  /** Call after the benchmark's own tables exist. */
  static async open(db: Db, o: AskRunnerOptions = {}) {
    await db.exec(TABLE);
    return new AskBenchmarkRunner(db, o);
  }

  private async one(sql: string, params: unknown[] = []) {
    return ((await this.db.query(sql, params)).rows as Row[])[0];
  }
  private at() {
    return new Date(this.now()).toISOString();
  }

  adapter(): Adapter {
    return {
      external: true,
      needs: [
        "Ask AI's model configured in Mynt Studio, and a Mynt admin with the run's page open in the platform admin's Agent benchmarks: Ask AI is Studio's code, so Studio runs each question and hands Mynt the record.",
        "Nothing from the sandbox host, and no repository.",
        "No real workspace: every read is answered from the invented dataset in the repository (core/benchmarks/fixtures/ask-ai), and nothing is written anywhere but the run's own record.",
      ],
      // Studio's setting, not this server's: recorded on the run when its runner takes the first task.
      model: () => null,
      unavailable: async () => null,
      maxTaskUsd: () => ASK_TASK_CAP_USD,
      reserveUsd: () => 0,
      start: async (run, task, capUsd) => {
        const id = randomUUID();
        await this.db.query(`INSERT INTO ${T}.benchmark_runner_tasks (id, run_id, task_id, cap_usd, created_at) VALUES ($1, $2, $3, $4, $5)`, [id, run.id, task.id, capUsd, this.at()]);
        return id;
      },
      tick: async () => undefined,
      stop: async (jobId, reason) => void (await this.db.query(`UPDATE ${T}.benchmark_runner_tasks SET closed_at = $2, closed_reason = $3 WHERE id::text = $1 AND closed_at IS NULL`, [jobId, this.at(), reason.slice(0, 500)])),
      poll: async (run, jobId, t) => this.poll(run, jobId, t),
    };
  }

  private async poll(run: Row, jobId: string, t: BenchmarkTask): Promise<Outcome | null> {
    const row = await this.one(`SELECT * FROM ${T}.benchmark_runner_tasks WHERE id::text = $1`, [jobId]);
    const none = { cost_usd: null, cost_parts: null, observed: null, checks: [] };
    if (!row) return { ...none, passed: false, failure_class: "harness", failed_check: "harness", detail: "The benchmark lost track of this task: its record is gone", cost_note: "Not measured: the task's record is gone", started_at: null, finished_at: null };
    if (row.submitted_at) {
      const set = taskSetFor(AGENT, Number(run.task_set_version));
      const score = scoreAsk(t as AskTask, askFixture(set!.fixture!), row.submission, Number(row.cap_usd));
      await this.db.query(`UPDATE ${T}.benchmark_runner_tasks SET closed_at = $2, closed_reason = 'scored' WHERE id = $1 AND closed_at IS NULL`, [row.id, this.at()]);
      return { ...score, cost_parts: null, started_at: iso(row.created_at), finished_at: iso(row.submitted_at) };
    }
    const waited = this.now() - Date.parse(iso(row.created_at)!);
    if (waited < this.answerMs) return null;
    const minutes = Math.max(1, Math.round(this.answerMs / 60_000));
    const why = row.claimed_at ? `A runner took this task and handed no record back within ${minutes} minute(s)` : `No runner asked for this task within ${minutes} minute(s)`;
    await this.db.query(`UPDATE ${T}.benchmark_runner_tasks SET closed_at = $2, closed_reason = 'timed out' WHERE id = $1 AND closed_at IS NULL`, [row.id, this.at()]);
    return {
      ...none,
      passed: false,
      failure_class: "harness",
      failed_check: "runner_never_answered",
      detail: `${why}. Nothing here is Ask AI's failure.`,
      checks: [{ name: "runner_answered", status: "fail", detail: why }],
      cost_note: "Not measured: no record was handed back",
      started_at: iso(row.created_at),
      finished_at: this.at(),
      stop_run: `${why}. Ask AI's tasks are run by Mynt Studio while the run's page is open in the platform admin's Agent benchmarks: keep it open, and check that Ask AI's model is configured in Studio`,
    };
  }

  // The Ask AI run in progress and its task in flight, if any.
  private async current() {
    const run = await this.one(`SELECT * FROM ${T}.benchmark_runs WHERE agent = $1 AND status = ANY($2) ORDER BY created_at LIMIT 1`, [AGENT, ACTIVE]);
    if (!run) return { run: null, row: null };
    const row = await this.one(
      `SELECT t.* FROM ${T}.benchmark_runner_tasks t JOIN ${T}.benchmark_results r ON r.run_id = t.run_id AND r.task_id = t.task_id AND r.job_id = t.id::text
        WHERE t.run_id = $1 AND r.status = 'running' AND t.closed_at IS NULL`,
      [run.id],
    );
    return { run, row: row ?? null };
  }

  /**
   * The task waiting for a runner, with what the runner needs and nothing the task expects: the question, the one
   * fixture scope its reads are answered from, and the task's budget at Mynt's rates for the models the runner names.
   * Taking it holds it for a while, so two runners don't spend on the same question.
   */
  async next(admin: User, o: { models: string[]; instructions_sha256?: string }) {
    const { run, row } = await this.current();
    if (!run) return { task: null, run: null, wait: null, note: "No Ask AI benchmark run is going. A Mynt admin starts one with start_benchmark_run (agent ask-ai), with its cap." };
    const view = { id: run.id as string, status: run.status as string, label: (run.label as string | null) ?? null };
    if (!row) return { task: null, run: view, wait: "Mynt hasn't handed the next task out yet. Ask again in a few seconds." };
    if (row.submitted_at) return { task: null, run: view, wait: "Mynt is scoring the last record. Ask again in a few seconds." };
    if (row.claimed_at && this.now() - Date.parse(iso(row.claimed_at)!) < this.holdMs) return { task: null, run: view, wait: "Another runner is answering this task." };
    const set = taskSetFor(AGENT, Number(run.task_set_version));
    const task = set?.tasks.find((x) => x.id === row.task_id) as AskTask | undefined;
    const scope = task && set?.fixture ? askFixture(set.fixture).scopes[task.scope] : undefined;
    if (!task || !scope) throw new RunnerRefusal("The task set this run started on is no longer on this server");
    const claim = randomUUID();
    await this.db.query(`UPDATE ${T}.benchmark_runner_tasks SET claim = $2, claimed_at = $3, claimed_by = $4 WHERE id = $1`, [row.id, claim, this.at(), admin.id]);
    // What ran: the model the runner will ask first, and a hash of the instructions it runs, on the run's own record.
    await this.db.query(`UPDATE ${T}.benchmark_runs SET model = COALESCE(model, $2), workspace_revisions = workspace_revisions || $3::jsonb WHERE id = $1`, [
      run.id,
      o.models[0],
      JSON.stringify(o.instructions_sha256 ? { "studio-ask-ai": o.instructions_sha256 } : {}),
    ]);
    const capUsd = Number(row.cap_usd);
    return {
      run: view,
      task: { id: task.id, question: task.question, area: scope.area, workspace_id: scope.workspace_id },
      fixture: { scope: task.scope, area: scope.area, asker: scope.asker, workspace_id: scope.workspace_id, reads: scope.reads },
      budget: {
        usd: capUsd,
        usd_per_million_tokens: Object.fromEntries(o.models.map((m) => [m, askRates(m)])),
        note: "The most this question's model calls may cost, at the rates Mynt meters its agents with. Stop before a call that could pass it, and say so in the record (stopped: 'budget').",
      },
      claim,
      answer_by: new Date(Date.parse(iso(row.created_at)!) + this.answerMs).toISOString(),
      wait: null,
    };
  }

  /** Takes a runner's record for the task it holds. Mynt scores it on the benchmark's next tick; nothing is scored here. */
  async submit(admin: User, o: { run_id: string; task_id: string; claim: string; record: Record<string, unknown> }) {
    const run = await this.one(`SELECT id, agent, status FROM ${T}.benchmark_runs WHERE id::text = $1`, [o.run_id]);
    if (!run || run.agent !== AGENT) throw new RunnerRefusal(`No Ask AI benchmark run '${o.run_id}'`);
    if (!ACTIVE.includes(run.status as string)) throw new RunnerRefusal(`The run already ended (${run.status}), so no record is taken for it`);
    const row = await this.one(`SELECT * FROM ${T}.benchmark_runner_tasks WHERE run_id = $1 AND task_id = $2 ORDER BY created_at DESC LIMIT 1`, [run.id, o.task_id]);
    if (!row) throw new RunnerRefusal(`The run hasn't handed out a task '${o.task_id}'`);
    if (row.submitted_at) throw new RunnerRefusal("A record for this task was already handed in");
    if (row.closed_at) throw new RunnerRefusal(`This task is closed (${row.closed_reason}), so no record is taken for it`);
    if (!row.claim || row.claim !== o.claim) throw new RunnerRefusal("This runner doesn't hold the task: another took it after its hold lapsed, or it was never taken");
    if (JSON.stringify(o.record).length > MAX_RECORD_BYTES) throw new RunnerRefusal(`The record is over ${MAX_RECORD_BYTES} bytes`);
    await this.db.query(`UPDATE ${T}.benchmark_runner_tasks SET submission = $2, submitted_at = $3, submitted_by = $4 WHERE id = $1`, [row.id, JSON.stringify(o.record), this.at(), admin.id]);
    return { accepted: true, run_id: run.id as string, task_id: o.task_id, note: "Mynt scores the record on its next tick. Read the outcome with get_benchmark_run." };
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

/** The two tools a runner outside this server uses. Called from registerBenchmarkTools, so admins only. */
export function addBenchmarkRunnerTools(server: McpServer, store: Store, admin: User, runner: AskBenchmarkRunner | null) {
  const attempt = async (f: (r: AskBenchmarkRunner) => Promise<unknown>) => {
    if (!runner) return fail("Agent benchmarks aren't running on this Mynt (the server was started without them)");
    try {
      return json(await f(runner));
    } catch (e) {
      if (e instanceof RunnerRefusal) return fail(e.message);
      throw e;
    }
  };

  server.registerTool(
    "next_benchmark_task",
    {
      title: "Take a benchmark task to run",
      description:
        "Admin: for the runner of an agent whose code runs outside this server (Ask AI, which is Mynt Studio's): the task waiting in the Ask AI benchmark run that is going, if any. It answers with the question, the one scope of the invented fixture dataset its reads are to be answered from, the task's budget in US dollars with Mynt's rates for the models named, a claim to hand back with the record, and when the record is due. It never says what the task expects. Taking a task holds it for a while, so two runners don't spend on one question. It starts nothing: a run exists only once an admin has started it with start_benchmark_run and a cap.",
      inputSchema: z
        .object({
          models: z.array(z.string().trim().min(1).max(120)).min(1).max(4).describe("The models the runner will ask, in order; the first is recorded as the run's model"),
          instructions_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional().describe("A hash of the instructions and limits the runner's agent runs with, recorded on the run so two runs can be told apart"),
        })
        .strict(),
    },
    async (o) => attempt((r) => r.next(admin, o)),
  );

  server.registerTool(
    "submit_benchmark_answer",
    {
      title: "Hand in a benchmark task's record",
      description:
        "Admin: for the runner that took a task with next_benchmark_task: the raw record of what the agent did on it (for Ask AI: the answer as shown and as written, its flags, the sources it numbered, every read it attempted with what the model was handed, each model call's token usage, and whether it was stopped at its budget). The record is kept as it arrives and scored by Mynt on the benchmark's next tick, against expectations the runner was never given; a record Mynt can't read is the benchmark's failure, not the agent's. Refused when the run has ended, the task is closed or already answered, or the claim isn't the one holding the task. Audited.",
      inputSchema: z.object({ run_id: z.string().min(1), task_id: z.string().min(1).max(64), claim: z.string().uuid(), record: z.record(z.string(), z.unknown()) }).strict(),
    },
    async (o) =>
      attempt(async (r) => {
        const taken = await r.submit(admin, o);
        await store.audit(admin.id, "submit_benchmark_answer", taken.run_id, { task_id: o.task_id });
        return taken;
      }),
  );
}
