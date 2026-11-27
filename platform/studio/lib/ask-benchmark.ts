// Ask AI's benchmark, Studio's side. Mynt keeps the questions, what each expects and the scoring (core's
// benchmark-ask.ts); Ask AI is Studio's code, so Studio runs it. For one task, this answers the question with the
// assistant people use (lib/ask-server.ts writeAnswer over lib/ask-runs.ts: the same instructions, tools, read loop
// and answer cleaning as /api/ask and /api/admin/ask) and writes down what happened, for Mynt to score.
//
// Two things differ from a person's question, and only these:
//   - the reads. Each is answered from the one fixture scope Mynt handed out with the task (invented records, in the
//     repository). Nothing here holds a connection to Mynt: no real workspace can be read and no tool called.
//   - the model is metered. Each call's reported token usage is counted at Mynt's rates against the task's budget, and
//     a call that could pass it isn't made.
// Nothing here judges the answer. The record says what Ask AI's own code already says of an answer (covered, uncited,
// declined) and what the model was handed; Mynt compares it with what the task expects.
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { ADMIN_ASK_CONTEXT, ADMIN_ASK_SYSTEM_PROMPT, ADMIN_ASK_TOOLS, type AdminAskTool } from "./admin-ask";
import { ASK_SYSTEM_PROMPT, ASK_TOOLS, askToolDefs, CUT_SHORT, MAX_CALLS_PER_QUESTION, MAX_CALLS_PER_STEP, MAX_OUTPUT_TOKENS, MAX_STEPS, MAX_TOOL_RESULT, OVER_CAP, REFUSED, TOO_MANY_STEPS } from "./ask";
import { conversationFrom, questionFrom, type AskArea, type AskSource, type AskStreamEvent } from "./ask-answer";
import { adminAskRun, studioAskRun } from "./ask-runs";
import { writeAnswer } from "./ask-server";
import type { Llm } from "./llm";
import { scrubText } from "./scrub";
import { MyntRefusedError, ToolRefusedError } from "./studio-server";
import { parseStudioCall } from "./studio-tools";

type MyntTools = Parameters<typeof askToolDefs>[0];
type Message = Anthropic.Beta.Messages.BetaMessageParam;

/** How long one question may take: under the route's own limit, as a person's question is. */
export const TASK_MS = 100_000;
export const RUNNER = "mynt-studio";

// ---- what Mynt hands out (next_benchmark_task) ----

export type FixtureAnswer = { args?: Record<string, unknown>; reply?: unknown; refuse?: string };
export type FixtureScope = { area: AskArea; workspace_id: string | null; reads: Record<string, FixtureAnswer[]> };
export type Rates = { input: number; output: number; cache_read: number; cache_write: number };
export type NextTask = {
  run: { id: string };
  task: { id: string; question: string };
  fixture: FixtureScope;
  budget: { usd: number; rates: Record<string, Rates> };
  claim: string;
};
/** What next_benchmark_task answered when nothing is to be run: whether an Ask AI run is going, and why to wait. */
export type NoTask = { going: boolean; wait: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Mynt's answer to next_benchmark_task, read: a task to run, nothing to run, or null when it can't be read. */
export function nextTaskFrom(v: unknown): NextTask | NoTask | null {
  if (!isObj(v)) return null;
  if (v.task === null) return { going: isObj(v.run), wait: typeof v.wait === "string" ? v.wait : null };
  const { run, task, fixture, budget, claim } = v;
  if (!isObj(run) || typeof run.id !== "string" || !isObj(task) || typeof task.id !== "string" || typeof task.question !== "string" || typeof claim !== "string") return null;
  if (!isObj(fixture) || (fixture.area !== "studio" && fixture.area !== "admin") || !isObj(fixture.reads)) return null;
  const reads: Record<string, FixtureAnswer[]> = {};
  for (const [tool, answers] of Object.entries(fixture.reads)) {
    if (!Array.isArray(answers) || !answers.every((a) => isObj(a) && (a.args === undefined || isObj(a.args)) && (a.refuse === undefined || typeof a.refuse === "string"))) return null;
    reads[tool] = answers as FixtureAnswer[];
  }
  if (!isObj(budget) || num(budget.usd) === null || !isObj(budget.usd_per_million_tokens)) return null;
  const rates: Record<string, Rates> = {};
  for (const [model, r] of Object.entries(budget.usd_per_million_tokens)) {
    if (!isObj(r) || num(r.input) === null || num(r.output) === null || num(r.cache_read) === null || num(r.cache_write) === null) return null;
    rates[model] = { input: r.input as number, output: r.output as number, cache_read: r.cache_read as number, cache_write: r.cache_write as number };
  }
  return {
    run: { id: run.id },
    task: { id: task.id, question: task.question },
    fixture: { area: fixture.area, workspace_id: typeof fixture.workspace_id === "string" ? fixture.workspace_id : null, reads },
    budget: { usd: budget.usd as number, rates },
    claim,
  };
}

// ---- the fixture, as Ask AI's only source ----

export const NO_SUCH_READ = "This benchmark's dataset holds nothing for that read.";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A scope's reads, as the one way Ask AI's reads are answered: the first answer whose `args` the call's arguments
 * include (an answer without `args` takes every call), as Mynt's reply or its refusal. A read the scope doesn't hold
 * is refused. It reads nothing else: there is no connection to Mynt in it.
 */
export function fixtureRead(scope: FixtureScope) {
  return async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const answers = Object.prototype.hasOwnProperty.call(scope.reads, tool) ? scope.reads[tool] : [];
    const hit = answers.find((a) => Object.entries(a.args ?? {}).every(([k, v]) => same(args[k], v)));
    if (!hit) throw new MyntRefusedError(NO_SUCH_READ, NO_SUCH_READ);
    if (hit.refuse !== undefined) throw new MyntRefusedError(hit.refuse, hit.refuse);
    return structuredClone(hit.reply ?? null);
  };
}

// ---- the model, metered ----

export class BudgetSpent extends Error {}

type Usage = Record<string, unknown>;
const tokens = (u: Usage, k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
/** What a call's reported usage costs at these rates, in US dollars. */
export const usageUsd = (u: Usage, r: Rates) => (tokens(u, "input_tokens") * r.input + tokens(u, "output_tokens") * r.output + tokens(u, "cache_read_input_tokens") * r.cache_read + tokens(u, "cache_creation_input_tokens") * r.cache_write) / 1_000_000;
// A request's size in tokens, from above: under three characters a token is rare, even for JSON full of ids.
const tokensAtMost = (v: unknown) => Math.ceil(JSON.stringify(v ?? "").length / 2.5);

export type ToolCallRecord = { tool: string; args: Record<string, unknown>; ok: boolean; refused: "not_allowed" | "over_cap" | null; to_model: string };
export type Meter = {
  llm: Llm;
  calls: { model: string; usage: Usage }[];
  failed: number;
  spentUsd: number;
  stopped: boolean;
  error: string | null;
  /** The instructions and tool definitions of the first request, hashed: what Ask AI ran with on this task. */
  instructions: string | null;
  /** Every read the model asked for whose result it was handed, in order, with that result whole. */
  toolCalls(): ToolCallRecord[];
};

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (isObj(b) && typeof b.text === "string" ? b.text : "")).join("") : "";

/**
 * `inner`, counted against a task's budget. Before a call, its worst case (the whole request written to the cache,
 * every output token it may write) is added to what was spent: over the budget, the call isn't made, and the answer
 * ends there. After a call, what it reported using is what it cost. It also keeps what each request handed the model,
 * so the record of a task is what the model really saw.
 */
export function meteredLlm(inner: Llm, budget: NextTask["budget"]): Meter {
  // A model Mynt gave no rate for is priced as the dearest it did.
  const dearest = Object.values(budget.rates).reduce<Rates>((a, b) => ({ input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), cache_read: Math.max(a.cache_read, b.cache_read), cache_write: Math.max(a.cache_write, b.cache_write) }), { input: 0, output: 0, cache_read: 0, cache_write: 0 });
  const ratesOf = (model: string) => (Object.prototype.hasOwnProperty.call(budget.rates, model) ? budget.rates[model] : dearest);
  const requests: Message[][] = [];
  const meter: Meter = {
    calls: [],
    failed: 0,
    spentUsd: 0,
    stopped: false,
    error: null,
    instructions: null,
    llm: {
      stream(params, options) {
        const rates = ratesOf(params.model);
        const worst = (tokensAtMost([params.system, params.tools, params.messages]) * Math.max(rates.input, rates.cache_write) + params.max_tokens * rates.output) / 1_000_000;
        if (!Object.keys(budget.rates).length || meter.spentUsd + worst > budget.usd) {
          meter.stopped = true;
          throw new BudgetSpent("The task's budget doesn't cover another model call");
        }
        meter.instructions ??= createHash("sha256").update(JSON.stringify([params.system, params.tools])).digest("hex");
        // As it stands now: the read loop adds to this list after the call, and what it adds later wasn't in this request.
        requests.push([...params.messages]);
        const stream = inner.stream(params, options);
        const final = stream.finalMessage.bind(stream);
        stream.finalMessage = async () => {
          try {
            const message = await final();
            const usage = (isObj(message.usage) ? message.usage : {}) as Usage;
            const model = typeof message.model === "string" && message.model ? message.model : params.model;
            meter.calls.push({ model, usage: Object.fromEntries(Object.entries(usage).filter(([, v]) => typeof v === "number")) });
            meter.spentUsd += usageUsd(usage, ratesOf(model));
            return message;
          } catch (err) {
            meter.failed++;
            meter.error = scrubText(err instanceof Error ? `${err.name}: ${err.message}` : "The model call failed").slice(0, 300);
            throw err;
          }
        };
        return stream;
      },
    },
    toolCalls() {
      const out: ToolCallRecord[] = [];
      const seen = new Set<string>();
      for (const messages of requests) {
        const asked = new Map<string, { tool: string; args: Record<string, unknown> }>();
        for (const m of messages) {
          if (!Array.isArray(m.content)) continue;
          for (const block of m.content) {
            if (block.type === "tool_use") asked.set(block.id, { tool: block.name, args: isObj(block.input) ? block.input : {} });
            if (block.type !== "tool_result") continue;
            const call = asked.get(block.tool_use_id);
            const to_model = textOf(block.content);
            const key = `${block.tool_use_id}\n${to_model}`;
            if (!call || seen.has(key)) continue;
            seen.add(key);
            const failed = block.is_error === true;
            out.push({ ...call, ok: !failed, refused: !failed ? null : to_model === OVER_CAP ? "over_cap" : /isn't available to (Ask AI|this assistant): it can only read\.$/.test(to_model) ? "not_allowed" : null, to_model });
          }
        }
      }
      return out;
    },
  };
  return meter;
}

// ---- one task ----

/** The record Mynt scores (core's benchmark-ask.ts AskRecord). */
export type AskRecord = {
  answer: string | null;
  raw_answer: string | null;
  reason: string | null;
  model: string | null;
  flags: { covered: boolean | null; declined: boolean; incomplete: boolean; uncited: boolean | null };
  sources: { n: number; title: string; href: string; tool: string }[];
  tool_calls: ToolCallRecord[];
  model_calls: { model: string; usage: Usage }[];
  failed_model_calls: number;
  stopped: "budget" | "time" | null;
  error: string | null;
  runner: { name: string; instructions_sha256: string | null; area: AskArea; models: string[]; limits: Record<string, number> };
};

const LIMITS = { max_steps: MAX_STEPS, max_output_tokens: MAX_OUTPUT_TOKENS, max_calls_per_step: MAX_CALLS_PER_STEP, max_calls_per_question: MAX_CALLS_PER_QUESTION, max_tool_result: MAX_TOOL_RESULT };

/**
 * A hash of what Ask AI answers with in both areas: its instructions, the reads it may make and its limits. Recorded
 * on a benchmark run, so two runs are known to have had the same Ask AI or not.
 */
export const askInstructionsSha = () =>
  createHash("sha256")
    .update(JSON.stringify({ studio: [ASK_SYSTEM_PROMPT, ASK_TOOLS], admin: [ADMIN_ASK_SYSTEM_PROMPT, ADMIN_ASK_CONTEXT, ADMIN_ASK_TOOLS], limits: LIMITS }))
    .digest("hex");

/**
 * Answers one benchmark task with Ask AI and returns the record of it. `tools` are Mynt's tool definitions (what the
 * model is told each read does, as for a person's question); `llm` is the model, metered here against the task's
 * budget. Never throws for what Ask AI did or the model failed to do: that is the record.
 */
export async function runAskBenchmarkTask(next: NextTask, o: { tools: MyntTools; llm: Llm; models: string[]; timeoutMs?: number }): Promise<AskRecord> {
  const { fixture } = next;
  const read = fixtureRead(fixture);
  const run =
    fixture.area === "admin"
      ? adminAskRun(o.tools, (tool: AdminAskTool, args) => read(tool, args))
      : studioAskRun(o.tools, fixture.workspace_id, (tool, args) => {
          // The studio's allow-list and strict arguments first, as for a person's read (lib/studio-server.ts callStudioTool).
          const call = parseStudioCall(tool, args);
          if ("error" in call) throw new ToolRefusedError("The studio couldn't send that to Mynt.");
          return read(call.tool, call.args);
        });
  const meter = meteredLlm(o.llm, next.budget);
  let raw = "";
  let sources: AskSource[] = [];
  let done: Extract<AskStreamEvent, { type: "done" }> | null = null;
  const send = (e: AskStreamEvent) => {
    if (e.type === "delta") raw += e.text;
    else if (e.type === "reset") raw = "";
    else if (e.type === "sources") sources = e.sources;
    else if (e.type === "done") done = e;
  };
  const question = questionFrom(next.task.question) ?? next.task.question;
  const signal = AbortSignal.timeout(o.timeoutMs ?? TASK_MS);
  let error: string | null = null;
  try {
    await writeAnswer(fixture.area, "Ask AI's benchmark", conversationFrom([], question), run, send, signal, { llm: meter.llm, models: o.models });
  } catch (err) {
    // Nothing a fixture read throws ends an answer; this is the pipeline itself failing.
    error = scrubText(err instanceof Error ? `${err.name}: ${err.message}` : "Ask AI failed").slice(0, 300);
  }
  const ended = done as Extract<AskStreamEvent, { type: "done" }> | null;
  const answer = ended?.answer ?? null;
  return {
    answer,
    raw_answer: answer === null ? null : raw,
    reason: ended?.reason ?? null,
    model: ended?.model ?? null,
    flags: {
      covered: ended?.covered ?? null,
      declined: answer !== null && answer.endsWith(REFUSED),
      incomplete: answer !== null && (answer.endsWith(TOO_MANY_STEPS) || answer.endsWith(CUT_SHORT)),
      uncited: answer === null ? null : (ended?.uncited ?? null),
    },
    sources: sources.map((s) => ({ n: s.n, title: s.title, href: s.href, tool: s.tool })),
    tool_calls: meter.toolCalls(),
    model_calls: meter.calls,
    failed_model_calls: meter.failed,
    stopped: answer !== null ? null : meter.stopped ? "budget" : signal.aborted ? "time" : null,
    error: error ?? (answer === null ? meter.error : null),
    runner: { name: RUNNER, instructions_sha256: meter.instructions, area: fixture.area, models: o.models, limits: LIMITS },
  };
}
