import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentMeter } from "../dist/agent-meter.js";
import { BdService, bdConfigFromEnv } from "../dist/bd.js";
import { BenchmarkService } from "../dist/benchmarks.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { DeskService, deskConfigFromEnv } from "../dist/desk.js";
import { ReviewService, reviewConfigFromEnv } from "../dist/review.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// The stand-ins the benchmark harness's tests share (benchmarks-http, benchmarks-postgres, benchmarks-governance):
// the same stand-in sandbox host and world as benchmarks.test.js, over any database. The "agent" is the test writing
// the files a real agent would; everything around it is the production code. No model and no sandbox is ever called.

export const T = "financial_products";
export const SHA = "a".repeat(64);
export const TREE = "b".repeat(64);
export const A = "/home/user/mynt-agent";
export const V = "/home/user/mynt-verify";
export const BUILD = "/home/user/workspaces/coding-build";
export const REVIEW = "/home/user/workspaces/governance-review";
export const DESK_JOB = "/home/user/mynt-desk/job";

export function standInHost() {
  const sandboxes = new Map();
  let n = 0;
  const host = {
    sandboxes,
    createError: null, // what the next createSandbox throws, if anything
    created: 0,
    async createSandbox(opts) {
      if (host.createError) throw new Error(host.createError);
      const id = `sbx_${++n}`;
      host.created++;
      sandboxes.set(id, { id, state: host.nextState ?? "ready", error: null, opts, files: new Map(), commands: [], stopped: false, cost: 0, procRunning: false, agentRunning: false, played: false });
      return { id, state: "ready" };
    },
    async getSandbox(id) {
      return sandboxes.get(id);
    },
    async writeFile(id, path, content) {
      sandboxes.get(id).files.set(path, content);
    },
    async readFile(id, path) {
      return sandboxes.get(id).files.get(path) ?? null;
    },
    async host(id, port) {
      return { url: `https://${id}-${port}.preview.example?_token=t` };
    },
    async costDollars(id) {
      return sandboxes.get(id).cost;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    async exec(id, command, opts = {}) {
      const s = sandboxes.get(id);
      s.commands.push({ command, ...opts });
      if (command.includes("tar --exclude")) return { exitCode: 0, stdout: `${SHA}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
      if (command.includes("verify.sh --audit-copy")) return { exitCode: 0, stdout: `audit-copy ${TREE}\n`, stderr: "" };
      if (command.includes("verify.sh --rehash")) {
        s.files.set(`${V}/changed.txt`, "");
        return { exitCode: 0, stdout: `rehash ${TREE}\n`, stderr: "" };
      }
      if (command.includes("[r]unner.mjs")) {
        s.agentRunning = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("scripts/dev_preview.sh")) return { exitCode: 0, stdout: "no-web\n", stderr: "" };
      if (command.includes("runner.mjs")) {
        s.agentRunning = true;
        return { processId: 99, exitCode: null, stdout: "", stderr: "" };
      }
      if (opts.detached) {
        s.procRunning = true;
        return { processId: 7, exitCode: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async commandStatus(id, processId) {
      const s = sandboxes.get(id);
      const running = processId === 99 ? s.agentRunning : s.procRunning;
      return { running, exitCode: running ? null : 0 };
    },
    async downloadUrl(id, path) {
      return `https://files.example/${id}${path}?sig=x`;
    },
    // What the runner records when Claude Code exits.
    finishAgent(id, subtype = "success", cost = 0, error = null) {
      const s = sandboxes.get(id);
      s.agentRunning = false;
      s.files.set(`${A}/state.json`, JSON.stringify({ session_id: "s1", cost_usd: cost, turns: 1, sent: 1, last_subtype: subtype, done: true, exit_code: subtype === "success" ? 0 : 1, error, summary: "Stand-in agent's summary" }));
    },
    write(id, path, value) {
      sandboxes.get(id).files.set(path, typeof value === "string" ? value : JSON.stringify(value));
    },
  };
  return host;
}

export const fakeRepos = () => ({
  prs: [],
  async installationFor(repo) {
    return repo === "mynt-bench/desk" ? 7 : null;
  },
  async tokenFor() {
    return { token: "ghs_short_lived", expires_at: new Date(Date.now() + 3600e3).toISOString() };
  },
  installUrl: () => "https://github.com/apps/mynt/installations/new",
  async openPullRequest(repo, installation, pr) {
    this.prs.push({ repo, installation, ...pr });
    return `https://github.com/${repo}/pull/3`;
  },
});

export const PASSING = ["source", "tests", "lint_typecheck", "secrets_scan", "secrets_history", "static_scan", "dependency_audit", "sbom", "disclosures"].map((name) => ({ name, status: "pass" }));
export const failing = (name, detail) => PASSING.map((c) => (c.name === name ? { name, status: "fail", detail } : c));
export const CLEAN_AUDIT = { complete: true, workflows_run: ["execute-scr", "probe-cicd-env"], skipped: [], counts: { critical: 0, high: 0, medium: 1, low: 2 }, findings: [], summary: "No blocking findings" };

export function pgliteDb() {
  const pg = new PGlite();
  return { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
}

// The real services and the benchmark service on one database, opened the way index.ts opens them (the real ones
// first, one meter for every agent's model calls, then the benchmarks). `db` is in-process Postgres unless given.
export async function world({ db = pgliteDb(), sandboxes = standInHost(), env = {}, senders = {}, realNow = () => new Date() } = {}) {
  const store = await Store.open(db, CATALOG);
  const repos = fakeRepos();
  const buildConfig = { ...buildConfigFromEnv(env), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } };
  const deskConfig = deskConfigFromEnv(buildConfig, env);
  const reviewConfig = reviewConfigFromEnv(buildConfig, env);
  const bdConfig = bdConfigFromEnv(buildConfig, { ...env, BD_ENABLED: "1" });
  // The real services, on the same database: what a benchmark must never touch.
  const real = {
    builds: await BuildService.open(db, store, sandboxes, repos, buildConfig),
    desk: await DeskService.open(db, store, sandboxes, repos, deskConfig),
    sent: [],
  };
  const recorder = { send: async (m) => (real.sent.push(m), { id: `msg_${real.sent.length}` }) };
  real.bd = await BdService.open(db, sandboxes, bdConfig, { email: recorder, whatsapp: recorder, phone: recorder, ...senders }, realNow);
  real.review = await ReviewService.open(db, store, sandboxes, reviewConfig, real.desk);
  const meter = await AgentMeter.open(db);
  for (const s of [real.builds, real.bd, real.desk, real.review]) s.meter = meter;
  const deps = { sandboxes, repos, buildConfig, deskConfig, reviewConfig, bdConfig, fetcher: async () => ({ ok: false, status: 404, contentType: "text/plain", text: "" }) };
  const benchmarks = await BenchmarkService.open(db, store, deps);
  benchmarks.meter = meter;
  const admin = (await store.createUser("Ada Admin", ["admin"])).user;
  const client = async (user, ctx = { benchmarks }) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, ctx).connect(s);
    const cl = new Client({ name: "test", version: "0" });
    await cl.connect(c);
    return {
      tools: async () => (await cl.listTools()).tools.map((t) => t.name),
      call: async (name, args = {}) => {
        const res = await cl.callTool({ name, arguments: args });
        let data;
        try {
          data = JSON.parse(res.content[0].text);
        } catch {
          data = { error: res.content[0].text };
        }
        return { isError: res.isError ?? false, data };
      },
    };
  };
  const rows = async (sql, params) => (await db.query(sql, params)).rows;
  const count = async (table, where = "TRUE") => (await rows(`SELECT count(*)::int AS n FROM ${T}.${table} WHERE ${where}`))[0].n;
  return { db, store, sandboxes, repos, benchmarks, deps, real, meter, admin, client, rows, count, as: await client(admin) };
}

// One tick of the benchmark worker, then `play` standing in for the agent: it's told the task in flight and each
// sandbox of it. A sandbox belongs to the task that was in flight when it first appeared.
export async function step(w, runId, play = async () => undefined) {
  // `w.alongside`: other work sharing the database while the worker ticks (benchmarks-postgres.test.js).
  await Promise.all([w.benchmarks.tick(), ...(w.alongside?.() ?? [])]);
  const state = await w.benchmarks.run(runId);
  const current = ["queued", "running"].includes(state.run.status) ? state.tasks.find((t) => t.status === "running") : null;
  if (current) {
    for (const s of w.sandboxes.sandboxes.values()) {
      s.task ??= current.task_id;
      if (s.task === current.task_id) await play(current.task_id, s, w);
    }
  }
  return { ...state, current: current ?? null };
}

// Runs the benchmark worker until the run ends.
export async function drive(w, runId, play, { ticks = 600 } = {}) {
  for (let i = 0; i < ticks; i++) {
    const state = await step(w, runId, play);
    if (!["queued", "running"].includes(state.run.status)) return w.benchmarks.run(runId);
  }
  throw new Error("the run didn't end");
}

export const start = async (w, args) => {
  const r = await w.as.call("start_benchmark_run", args);
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data.run.id;
};

// ---- stand-in agents, one per kind. Each plays a sandbox once. ----

// A stand-in coding agent and Mynt's verifier's outputs, per task: { agent, cost, checks, maxwell }.
export const codingPlay = (byTask = {}, defaults = {}) => async (taskId, s, w) => {
  const o = { ...defaults, ...(byTask[taskId] ?? {}) };
  const name = s.opts.name;
  if (name.startsWith("mynt-build-") && s.agentRunning && !s.played) {
    s.played = true;
    s.cost = o.sandbox_cost ?? 0.1;
    w.sandboxes.write(s.id, `${BUILD}/job/result.json`, { readiness: [], preview: { port: 8080 }, notes: "I pass every check (the agent's own word, which nobody reads)" });
    w.sandboxes.finishAgent(s.id, o.agent ?? "success", o.cost ?? 0.5, o.agent_error ?? null);
  }
  if (name.startsWith("mynt-verify-")) {
    if (s.procRunning) {
      s.procRunning = false;
      if (o.checks !== null) w.sandboxes.write(s.id, `${V}/report.json`, { checks: o.checks ?? PASSING });
    }
    if (s.agentRunning) {
      w.sandboxes.write(s.id, `${V}/maxwell.json`, o.maxwell ?? CLEAN_AUDIT);
      w.sandboxes.finishAgent(s.id, "success", 0.2);
    }
  }
};

// A stand-in desk agent, and what Mynt's own run of its model reports.
export const deskPlay = ({ cost = 1.2, sandbox_cost = 0.05 } = {}) => async (_taskId, s, w) => {
  const name = s.opts.name;
  if (name.startsWith("mynt-desk-agent-") && s.agentRunning && !s.played) {
    s.played = true;
    s.cost = sandbox_cost;
    w.sandboxes.finishAgent(s.id, "success", cost);
  }
  if (name.startsWith("mynt-desk-verify-") && s.procRunning) {
    s.procRunning = false;
    s.cost = sandbox_cost ? 0.02 : 0;
    w.sandboxes.write(s.id, `${DESK_JOB}/outcome.json`, {
      outcome: "ran",
      model: "economics",
      commit: "c".repeat(40),
      report: { verdict: "feasible", summary: "Margin 0.55% per account", metrics: { margin_pct: 0.55, breakeven_balance_usd: 2100 }, checks: [{ name: "reg_dd_disclosures", status: "pass", detail: "ok" }] },
      log: "",
    });
  }
};

// A stand-in reviewer: `answer(kase, taskId)` returns the review.json it writes for the case it was handed.
export const reviewPlay = (answer, { cost = 0.4 } = {}) => async (taskId, s, w) => {
  if (!s.opts.name.startsWith("mynt-review-") || !s.agentRunning || s.played) return;
  s.played = true;
  s.cost = 0.05;
  const kase = JSON.parse(s.files.get(`${REVIEW}/job/case.json`));
  w.sandboxes.write(s.id, `${REVIEW}/job/review.json`, await answer(kase, taskId, s));
  w.sandboxes.finishAgent(s.id, "success", cost);
};

// A stand-in connector agent: `session(taskId, s, w)` does what it does through the connector, then it exits.
export const connectorPlay = (session = async () => undefined, { cost = 0.3 } = {}) => async (taskId, s, w) => {
  if (!s.opts.name.startsWith("mynt-bd-") || !s.agentRunning || s.played) return;
  s.played = true;
  s.cost = 0.03;
  await session(taskId, s, w);
  w.sandboxes.finishAgent(s.id, "success", cost);
};

// ---- stand-in reviewers ----

export const caseQuote = (quote) => [{ source_url: "mynt://case", quote }];
export const met = (quote) => ({ status: "met", evidence: caseQuote(quote), note: "The register copy held in the case shows it" });
export const notMet = (quote) => ({ status: "not_met", evidence: caseQuote(quote), note: "The register copy held in the case shows otherwise" });
export const silent = (searched_for) => ({ status: "silent", evidence: [], searched_for, note: "Nothing either way" });
export const review = (kase, answers) => ({ items: kase.items.map((i) => ({ id: i.id, ...(answers[i.id] ?? silent("The case; it holds nothing on this item")) })) });

// A careful reviewer that reads only the case it was handed, as CLAUDE.md and the review skills say to: it finds the
// register's lines in the case, compares them with what the firm recorded, and quotes them word for word. It never
// sees what the sample expects.
export const line = (copy, label) => (copy?.record ?? []).find((l) => l.startsWith(`${label}: `)) ?? null;
export const value = (l) => l.slice(l.indexOf(": ") + 2);
export const sameName = (a, b) => {
  const plain = (s) => s.toLowerCase().replace(/[.,]/g, "").replace(/\bincorporated\b/, "inc").replace(/\bcorporation\b/, "corp").replace(/\blimited\b/, "ltd").replace(/\s+/g, " ").trim();
  return plain(a) === plain(b);
};
export const ADVERSE = /dissolved|struck off|liquidation|inactive|revoked|cancelled|surrendered|suspended|expired/i;
export function carefulReview(kase) {
  const copy = kase.subject.register_copy;
  const status = line(copy, "Status");
  const standing = !status ? silent("The register copy in the case: it has no status line") : ADVERSE.test(status) ? notMet(status) : met(status);
  if (kase.subject_kind === "entity") {
    const firm = kase.subject.entity;
    const [number, name] = [line(copy, "File number"), line(copy, "Entity name")];
    const listed = number && name && Object.values(firm.registration_numbers).includes(value(number));
    return review(kase, {
      registry_match: !listed ? silent("The register copy in the case, by file number") : sameName(value(name), firm.name) ? { ...met(number), evidence: [...caseQuote(number), ...caseQuote(name)] } : notMet(name),
      active_status: standing,
      lei_consistent: silent("The firm's identifiers in the case: it gave no LEI"),
    });
  }
  const { licence, entity, enforcement_copy: enforcement } = kase.subject;
  const [number, holder, type] = [line(copy, "Licence number"), line(copy, "Licence holder"), line(copy, "Licence type")];
  const listed = number && value(number) === licence.registration_number;
  const kind = (s) => (/money transmi/i.test(s) ? "money transmission" : /currency exchange/i.test(s) ? "currency exchange" : s.toLowerCase());
  return review(kase, {
    register_entry: listed ? met(number) : silent("The register copy in the case, by licence number"),
    holder_matches: !listed || !holder ? silent("The register copy in the case") : sameName(value(holder), entity.name) ? met(holder) : notMet(holder),
    type_matches: !listed || !type ? silent("The register copy in the case") : kind(value(type)) === kind(kase.regulatory.licence_type.name) ? met(type) : notMet(type),
    in_force: listed ? standing : silent("The register copy in the case"),
    no_enforcement: enforcement?.record?.length ? met(enforcement.record[0]) : silent("The case: it holds no copy of the regulator's enforcement pages"),
  });
}

