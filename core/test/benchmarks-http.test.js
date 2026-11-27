import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { priceUsage } from "../dist/agent-meter.js";
import { ClerkAuth } from "../dist/auth.js";
import { createMcpHttpServer } from "../dist/http.js";
import { A, T, codingPlay, connectorPlay, deskPlay, drive, reviewPlay, start, step, world } from "./benchmark-standins.js";

// The HTTP path a live benchmark agent takes, on a real createMcpHttpServer: Mynt's agent proxy (/agent/...) and, for
// the connector, Mynt's MCP endpoint (/mcp). The agents are stand-ins (benchmark-standins.js) and so is the model
// backend: a local HTTP server that answers like the model provider and reports usage. Nothing real is ever called:
// any outbound request that isn't to this machine fails the test.

// ---- the stand-in model backend ----

const OUTPUT_TOKENS = 25_000;
const upstream = { calls: [] };
const model = createHttpServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    upstream.calls.push({ path: req.url, key: req.headers["x-api-key"], authorization: req.headers.authorization ?? null, model: body.model });
    res.writeHead(200, { "content-type": "application/json", "request-id": `req_${upstream.calls.length}` });
    res.end(JSON.stringify({ id: "msg_standin", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], usage: { input_tokens: 0, output_tokens: OUTPUT_TOKENS } }));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const MODEL_BASE = `http://127.0.0.1:${model.address().port}`;
const PROVIDER = "https://api.anthropic.com";
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${PROVIDER}/`)) return realFetch(url.replace(PROVIDER, MODEL_BASE), init);
  if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
  outbound.push(url);
  return Promise.reject(new Error(`a benchmark test tried to call ${url}`));
};
const closers = [() => model.close(), () => (globalThis.fetch = realFetch)];
after(() => closers.forEach((c) => c()));

// ---- the server ----

const PUBLISHABLE_KEY = `pk_test_${Buffer.from("bench-test.clerk.accounts.dev$").toString("base64")}`;
// A stand-in for Clerk that knows no token at all: whatever a benchmark token is, it isn't a person's.
const noClerkUsers = { idPOAuthAccessToken: { verify: async () => Promise.reject(new Error("invalid")) }, users: { getUser: async () => undefined } };

// Every per-job cap at US$1, so a task's budget is small enough to spend in two model calls.
const CAPS = { BUILD_CAP_USD: "1", DESK_JOB_CAP_USD: "1", REVIEW_CASE_CAP_USD: "1", BD_RUN_CAP_USD: "1" };
// A Monday, 11:00 in New York: the real connector's working hours.
const MONDAY = new Date("2026-11-02T16:00:00Z");

async function httpWorld(env = {}) {
  const w = await world({ env: { ...CAPS, ...env }, realNow: () => MONDAY });
  // What index.ts hands the HTTP server: the real services, and the benchmarks beside them.
  const ctx = { benchmarks: w.benchmarks, builds: w.real.builds, bd: w.real.bd, desk: w.real.desk, review: w.real.review };
  const listen = async (clerk) => {
    const http = createMcpHttpServer(w.store, clerk, ctx);
    await new Promise((r) => http.listen(0, "127.0.0.1", r));
    closers.push(() => http.close());
    return `http://127.0.0.1:${http.address().port}`;
  };
  w.base = await listen(null);
  // The same Mynt with Clerk as its sign-in: fpm_ tokens and guests are refused there.
  w.clerkBase = await listen(new ClerkAuth({ secretKey: "sk_test_x", publishableKey: PUBLISHABLE_KEY, publicUrl: "https://mynt.example.com", requireAudience: true }, w.store, noClerkUsers));
  w.model = w.deps.buildConfig.model;
  w.callUsd = priceUsage(w.model, { input_tokens: 0, output_tokens: OUTPUT_TOKENS });
  return w;
}

// One model call through Mynt's agent proxy, as Claude Code in a sandbox makes it.
const proxy = (w, token, base = w.base) =>
  fetch(`${base}/agent/v1/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: w.model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
const proxyRefusal = async (w, token, base) => {
  const r = await proxy(w, token, base);
  return [r.status, (await r.json()).error?.message];
};
// A raw MCP request with a bearer token.
const mcpPost = (base, token) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
// An MCP client signed in with a bearer token.
async function mcp(base, token) {
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return {
    tools: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    // { isError, data }; a tool that isn't there is an error either way the SDK reports it.
    call: async (name, args = {}) => {
      try {
        const res = await client.callTool({ name, arguments: args });
        let data;
        try {
          data = JSON.parse(res.content[0].text);
        } catch {
          data = { error: res.content[0].text };
        }
        return { isError: res.isError ?? false, data };
      } catch (e) {
        return { isError: true, data: { error: e.message } };
      }
    },
    close: () => client.close(),
  };
}

// Ticks until `taskId`'s agent is running in its sandbox, and returns that sandbox and the token Mynt minted for it.
async function agentInFlight(w, runId, taskId, prefix) {
  for (let i = 0; i < 60; i++) {
    const state = await step(w, runId);
    assert.ok(["queued", "running"].includes(state.run.status), `the run ended (${state.run.status}: ${state.run.stop_reason}) before ${taskId}'s agent started`);
    const s = [...w.sandboxes.sandboxes.values()].find((x) => x.task === taskId && x.opts.name.startsWith(prefix) && x.agentRunning && !x.played);
    if (s) return { s, token: JSON.parse(s.files.get(`${A}/auth.json`)).token, task: state.tasks.find((t) => t.task_id === taskId) };
  }
  throw new Error(`${taskId}'s agent never started`);
}
// Ticks, with the stand-in agent playing, until `taskId` has been scored.
async function untilScored(w, runId, taskId, play) {
  for (let i = 0; i < 200; i++) {
    const state = await step(w, runId, play);
    const task = state.tasks.find((t) => t.task_id === taskId);
    if (!["pending", "running"].includes(task.status)) return { ...state, task };
  }
  throw new Error(`${taskId} was never scored`);
}
const eventually = async (f, what) => {
  for (let i = 0; i < 200; i++) {
    if (await f()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never happened: ${what}`);
};

// A stand-in reviewer that answers every item "silent", saying where it looked.
const silentReview = (kase) => ({ items: kase.items.map((i) => ({ id: i.id, status: "silent", evidence: [], searched_for: "The case, which is all a stand-in reads", note: "Nothing either way" })) });

const KINDS = {
  coding: { agent: "coding", prefix: "mynt-build-", token: /^mynt_agent_/, key: /^build:/, tasks: ["two-key-household-fund", "tax-refund-split"], play: () => codingPlay({}, { cost: 0, sandbox_cost: 0 }) },
  "product-desk": { agent: "product-desk", prefix: "mynt-desk-agent-", token: /^mynt_desk_/, key: /^desk:/, tasks: ["gig-worker-no-penalty-cd", "rate-reset-cd"], args: { repository: "mynt-bench/desk" }, play: () => deskPlay({ cost: 0, sandbox_cost: 0 }) },
  "governance-review": { agent: "governance-review", prefix: "mynt-review-", token: /^mynt_review_/, key: /^review:/, tasks: ["good-twelve-month-cd", "bad-free-savings-with-fee"], play: () => reviewPlay(silentReview, { cost: 0 }) },
  connector: { agent: "connector", prefix: "mynt-bd-", token: /^mynt_bd_/, key: /^bd:/, tasks: ["email-only-with-a-basis", "stop-means-stop"], play: () => connectorPlay(undefined, { cost: 0 }) },
};

// ---- the agent proxy, for each kind of token the harness mints ----

for (const [kind, k] of Object.entries(KINDS)) {
  test(`${kind}: the agent proxy serves a live benchmark task's token, meters it against that task's budget, and refuses it when the budget is spent or the task, the run or a stopped run is over`, async () => {
    const w = await httpWorld();
    const play = k.play();
    const [first, second] = k.tasks;
    const dead = async (token, when) => {
      for (const base of [w.base, w.clerkBase]) {
        assert.deepEqual(await proxyRefusal(w, token, base), [401, "This agent token isn't active"], `the proxy, ${when}`);
        assert.equal((await mcpPost(base, token)).status, 401, `/mcp, ${when}`);
      }
      assert.equal(await w.benchmarks.agentRun(token), null, when);
      assert.equal(await w.benchmarks.connectorRun(token), null, when);
    };

    const runId = await start(w, { agent: k.agent, cap_usd: 5, task_ids: k.tasks, ...(k.args ?? {}) });
    const a = await agentInFlight(w, runId, first, k.prefix);
    assert.match(a.token, k.token);
    // The token is the benchmark task's, and nobody's else: no real service knows it, and it is no person's token.
    for (const real of [w.real.builds, w.real.desk, w.real.review, w.real.bd]) assert.equal(await real.agentRun(a.token), null);
    assert.equal(await w.store.userByToken(a.token), undefined);
    const live = await w.benchmarks.agentRun(a.token);
    assert.match(live.key, k.key);
    assert.equal(a.task.cap_usd, 1, "the task's budget: what is left of the run's cap, and never more than the agent's per-job cap");
    assert.equal(live.capUsd, a.task.cap_usd, "the proxy's budget for the token is the task's");

    // Model calls go through, with Mynt's own key added on the way out (the sandbox's token never reaches the provider),
    // and each is metered against the task's budget; once that is spent the proxy refuses the token.
    const before = upstream.calls.length;
    const needed = Math.ceil(live.capUsd / w.callUsd);
    assert.ok(needed >= 2 && needed <= 20, `a US$${live.capUsd} budget takes ${needed} stand-in calls`);
    for (let n = 1; n <= needed; n++) {
      const r = await proxy(w, a.token, n % 2 ? w.base : w.clerkBase);
      assert.equal(r.status, 200, `call ${n} of ${needed}`);
      assert.equal((await r.json()).id, "msg_standin");
      await eventually(async () => Math.abs((await w.meter.spent(live.key)) - n * w.callUsd) < 1e-6, `call ${n} metered`);
    }
    const mine = upstream.calls.slice(before);
    assert.equal(mine.length, needed);
    for (const c of mine) assert.deepEqual([c.path, c.key, c.authorization, c.model], ["/v1/messages", "sk-ant-test", null, w.model]);
    assert.deepEqual(await proxyRefusal(w, a.token), [402, `This run's model budget (US$${live.capUsd}) is spent`]);
    assert.equal(upstream.calls.length, before + needed, "a refused call never reaches the model");
    assert.equal(await w.meter.spent(live.key), needed * w.callUsd);

    // On /mcp the token is nobody: only a connector run has tools there (tested below), and no person has this token.
    if (kind !== "connector") {
      const [plain, clerk] = [await mcpPost(w.base, a.token), await mcpPost(w.clerkBase, a.token)];
      assert.deepEqual([plain.status, (await plain.json()).error], [401, "Invalid token"]);
      assert.equal(clerk.status, 401);
      assert.match(clerk.headers.get("www-authenticate"), /error="invalid_token"/);
    }
    // Nor is it an app key for the runtime API.
    assert.equal((await fetch(`${w.base}/v1/products`, { headers: { Authorization: `Bearer ${a.token}` } })).status, 401);

    // The task ends (the run is still going): its token is dead, and what the proxy metered is in the task's cost.
    const scored = await untilScored(w, runId, first, play);
    assert.equal(scored.run.status, "running");
    assert.ok(scored.task.cost_usd >= needed * w.callUsd, `the task's cost (${scored.task.cost_usd}) counts what the proxy metered`);
    await dead(a.token, "after its task ended");

    // The next task has its own token and its own budget.
    const b = await agentInFlight(w, runId, second, k.prefix);
    assert.notEqual(b.token, a.token);
    const liveB = await w.benchmarks.agentRun(b.token);
    assert.notEqual(liveB.key, live.key);
    assert.equal((await proxy(w, b.token)).status, 200);
    await dead(a.token, "while the next task runs");
    const done = await drive(w, runId, play);
    assert.equal(done.run.status, "finished");
    await dead(b.token, "after the run ended");
    assert.ok(done.run.charged_usd >= needed * w.callUsd && done.run.charged_usd <= done.run.cap_usd);

    // A run an admin stops: the task in flight is stopped with it, and its token with the task.
    const stopped = await start(w, { agent: k.agent, cap_usd: 5, task_ids: [first], ...(k.args ?? {}) });
    const c = await agentInFlight(w, stopped, first, k.prefix);
    assert.equal((await proxy(w, c.token)).status, 200);
    const end = await w.as.call("stop_benchmark_run", { run_id: stopped, reason: "Stopping the stand-in run" });
    assert.equal(end.isError, false, JSON.stringify(end.data));
    assert.equal(end.data.run.status, "stopped");
    await dead(c.token, "after the run was stopped");
    assert.equal(c.s.stopped, true, "and its sandbox is gone");

    // Nothing of this is in the real services' tables.
    for (const table of ["build_runs", "desk_jobs", "review_cases", "bd_runs"]) assert.equal(await w.count(table), 0, table);
    assert.deepEqual(outbound, [], "nothing but this machine was ever called");
  });
}

// ---- the connector on /mcp ----

const REAL_PEOPLE = [
  { kind: "developer", name: "Imani Brooks", org: "Lakefront Apps", title: "Founder", region: "US", source: "inbound", contacts: [{ channel: "email", address: "imani.brooks@lakefront.example.org", consent: "opted_in" }, { channel: "whatsapp", address: "+1 202 555 0171", consent: "opted_in" }] },
  { kind: "innovator", name: "Daniel Whitford", org: "Whitford Trust Company", title: "Head of Partnerships", region: "US", source: "company_site", source_url: "https://whitfordtrust.example.org/partners", contacts: [{ channel: "email", address: "partners@whitfordtrust.example.org", consent: "public_business", consent_source: "https://whitfordtrust.example.org/partners" }] },
  { kind: "developer", name: "Sofia Marchetti", org: "Marchetti Studio", region: "US", source: "referral", contacts: [{ channel: "email", address: "sofia@marchetti.example.org", consent: "referred" }, { channel: "phone", address: "+1 202 555 0188", consent: "opted_in" }] },
];

// Every row of every table the real connector owns, as text: what "unchanged" is measured on.
async function realPipeline(w) {
  const tables = (await w.rows(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'bd\\_%' ORDER BY table_name`, [T])).map((r) => r.table_name);
  const out = {};
  for (const table of tables) out[table] = (await w.rows(`SELECT to_jsonb(t)::text AS row FROM ${T}.${table} t ORDER BY 1`)).map((r) => r.row);
  return out;
}

test("on /mcp a benchmark connector token gets the benchmark's own connector: its pipeline only, the real one untouched, nothing sent, and no other tool", async () => {
  const w = await httpWorld();
  // The real connector: every channel connected, real-looking people in its pipeline, a conversation, and a run of
  // its own in flight.
  const real = {};
  for (const p of REAL_PEOPLE) real[p.name] = (await w.real.bd.addProspect(p)).id;
  assert.equal((await w.real.bd.send(real["Imani Brooks"], "email", { subject: "Mynt", body: "Thanks for asking about Mynt. Here is how builds are verified." })).status, "sent");
  assert.equal((await w.real.bd.send(real["Sofia Marchetti"], "phone", { body: "A short call about Mynt, as you asked." })).status, "sent");
  await w.real.bd.receive("email", "imani.brooks@lakefront.example.org", { subject: "Re: Mynt", body: "Thanks. Could you send the docs?" });
  assert.deepEqual(w.real.bd.channels(), { email: true, whatsapp: true, phone: true });
  assert.equal(w.real.sent.length, 2);
  await w.real.bd.tick();
  await w.real.bd.tick();
  const realBox = [...w.sandboxes.sandboxes.values()].find((s) => s.opts.name.startsWith("mynt-bd-"));
  realBox.task = "the real connector's run"; // never the benchmark's to play
  const realToken = JSON.parse(realBox.files.get(`${A}/auth.json`)).token;
  assert.equal((await w.real.bd.runForToken(realToken)).status, "running");
  const guestTools = await (await w.client(null, {})).tools();
  const realAgent = await mcp(w.base, realToken);
  const realTools = await realAgent.tools();
  const realBefore = await realPipeline(w);
  assert.deepEqual([realBefore.bd_prospects.length, realBefore.bd_contacts.length, realBefore.bd_messages.length, realBefore.bd_runs.length], [3, 5, 3, 1]);

  // A benchmark connector task in flight.
  const runId = await start(w, { agent: "connector", cap_usd: 5, task_ids: ["email-only-with-a-basis", "stop-means-stop"] });
  const a = await agentInFlight(w, runId, "email-only-with-a-basis", "mynt-bd-");
  assert.notEqual(a.token, realToken);
  assert.equal(await w.real.bd.runForToken(a.token), undefined, "the real connector doesn't know the benchmark's token");

  for (const base of [w.base, w.clerkBase]) {
    const agent = await mcp(base, a.token);
    // The same tools a real connector run gets, and no more: the public catalogue and the connector's run tools.
    const tools = await agent.tools();
    assert.deepEqual(tools, realTools);
    assert.deepEqual(tools.filter((t) => !guestTools.includes(t)).filter((t) => !t.startsWith("bd_")), []);
    assert.ok(tools.includes("bd_brief") && tools.includes("bd_send"));
    for (const [name, args] of [
      ["start_benchmark_run", { agent: "connector", cap_usd: 1 }],
      ["list_benchmark_runs", {}],
      ["bd_pause", { paused: true, reason: "A benchmark agent trying an admin's tool" }],
      ["bd_pipeline", {}],
      ["bd_run_now", {}],
      ["open_review_case", { subject_kind: "entity", subject_id: "x" }],
      ["start_build", { goal: "anything" }],
      ["list_users", {}],
    ]) {
      assert.ok(!tools.includes(name), name);
      assert.equal((await agent.call(name, args)).isError, true, `${name} isn't the benchmark connector's to call`);
    }

    // What it reads is the benchmark's pipeline: the task's invented people, and no channel to send on.
    const brief = (await agent.call("bd_brief")).data;
    assert.deepEqual(brief.channels, { email: false, whatsapp: false, phone: false });
    const found = (await agent.call("bd_find", { limit: 200 })).data;
    assert.deepEqual(found.map((p) => p.name).sort(), ["Maria Santos", "Priya Raman", "Tom Albright"]);
    for (const text of ["Imani", "Whitford", "Marchetti", "example.org"]) assert.deepEqual((await agent.call("bd_find", { text })).data, [], text);
    // A real person's id opens nothing here.
    for (const id of Object.values(real)) {
      assert.equal((await agent.call("bd_get_prospect", { id })).isError, true);
      assert.match((await agent.call("bd_send", { prospect_id: id, channel: "email", subject: "Mynt", body: "Hello from a benchmark that must never reach you." })).data.error, /No such prospect/);
      // An update by a real id finds no row in the benchmark's pipeline; the real one is compared below.
      await agent.call("bd_update_prospect", { id, stage: "declined", notes: "A benchmark agent was here" });
    }
    await agent.close();
  }

  // What it writes lands in the benchmark's pipeline, as drafts: there is nothing to send on.
  const agent = await mcp(w.base, a.token);
  const byName = Object.fromEntries((await agent.call("bd_find", { limit: 200 })).data.map((p) => [p.name, p.id]));
  const added = await agent.call("bd_add_prospect", { kind: "developer", name: "Nadia Petrov", org: "Petrov Labs", region: "US", source: "company_site", source_url: "https://petrovlabs.example.com/contact", contacts: [{ channel: "email", address: "hello@petrovlabs.example.com", consent: "public_business" }] });
  assert.equal(added.isError, false, JSON.stringify(added.data));
  const tried = [];
  for (const id of [...Object.values(byName), added.data.id]) for (const channel of ["email", "whatsapp", "phone"]) tried.push((await agent.call("bd_send", { prospect_id: id, channel, subject: "Mynt", body: "Hello from Mynt's connector, an AI agent. A short note on how Mynt verifies builds." })).data);
  assert.equal(tried.length, 12);
  assert.deepEqual(tried.filter((t) => t.status).map((t) => t.status), ["draft", "draft"], "only the two with a published business address, and only as drafts");
  assert.equal(tried.filter((t) => t.error).length, 10);
  const drafts = await w.rows(`SELECT body, status, provider_id, run_id::text AS run_id FROM ${T}.bench_bd_messages WHERE direction = 'out'`);
  assert.deepEqual(drafts.map((d) => [d.status, d.provider_id]), [["draft", null], ["draft", null]]);
  assert.equal(await w.count("bench_bd_messages", "status = 'sent'"), 0);
  assert.equal(await w.count("bench_bd_prospects", "name = 'Nadia Petrov'"), 1);
  assert.equal(await w.count("bd_prospects", "name = 'Nadia Petrov'"), 0);
  // A draft's opt-out link is the benchmark connector's own: Mynt's public opt-out page, which is the real
  // connector's, doesn't accept it.
  const link = new URL(/https:\/\/\S+\/bd\/unsubscribe\?\S+/.exec(drafts[0].body)[0]);
  assert.equal((await fetch(`${w.base}${link.pathname}${link.search}`)).status, 400);
  await agent.close();

  // The real connector, its people, its conversation, its run and its senders: byte for byte as they were.
  assert.deepEqual(await realPipeline(w), realBefore);
  assert.equal(w.real.sent.length, 2, "no sender was called");

  // The task and the run end: the token is refused on /mcp too.
  const play = connectorPlay(undefined, { cost: 0 });
  await untilScored(w, runId, "email-only-with-a-basis", play);
  for (const base of [w.base, w.clerkBase]) {
    const r = await mcpPost(base, a.token);
    assert.deepEqual([r.status, (await r.json()).message], [401, "This connector run isn't active"], "after its task ended");
  }
  const b = await agentInFlight(w, runId, "stop-means-stop", "mynt-bd-");
  const second = await mcp(w.base, b.token);
  // Each task starts on a clean pipeline: the last task's people and drafts are gone, and this task's are there.
  assert.deepEqual((await second.call("bd_find", { limit: 200 })).data.map((p) => p.name).sort(), ["Aiko Tanaka", "Greg Mills"]);
  await second.close();
  const stopped = await w.as.call("stop_benchmark_run", { run_id: runId, reason: "Stopping the stand-in run" });
  assert.equal(stopped.data.run.status, "stopped");
  assert.equal((await mcpPost(w.base, b.token)).status, 401, "after the run was stopped");
  assert.equal((await mcpPost(w.clerkBase, b.token)).status, 401);

  // No regression for the real connector: its run's token still gets the real connector, its pipeline and channels;
  // a made-up token gets nothing.
  assert.deepEqual(await realAgent.tools(), realTools);
  const realBrief = (await realAgent.call("bd_brief")).data;
  assert.deepEqual(realBrief.channels, { email: true, whatsapp: true, phone: true });
  assert.deepEqual((await realAgent.call("bd_find", { limit: 200 })).data.map((p) => p.name).sort(), ["Daniel Whitford", "Imani Brooks", "Sofia Marchetti"]);
  assert.equal(realBrief.inbox.length, 1);
  await realAgent.close();
  for (const base of [w.base, w.clerkBase]) {
    const r = await mcpPost(base, "mynt_bd_made_up_token_that_no_run_ever_had");
    assert.deepEqual([r.status, (await r.json()).error], [401, "invalid_token"]);
  }
  assert.deepEqual(await proxyRefusal(w, "mynt_bd_made_up_token_that_no_run_ever_had"), [401, "This agent token isn't active"]);
  assert.deepEqual(await realPipeline(w), realBefore);
  assert.deepEqual(outbound, []);
});

// ---- the fifth token: Mynt's own auditor, where the deployment runs the independent audit ----

test("build audit: the auditor's token is metered against the audit's own budget, on the audit's model, and dies with the audit", async () => {
  const w = await httpWorld({ BUILD_AUDIT: "maxwell", BUILD_AUDIT_CAP_USD: "1" });
  const audit = w.deps.buildConfig.audit;
  assert.deepEqual([audit.mode, audit.capUsd], ["maxwell", 1]);
  const base = codingPlay({}, { cost: 0, sandbox_cost: 0 });
  let auditor = null;
  let hold = true;
  // The stand-in coding agent and verifier play as usual; the auditor is held in flight until the test lets it finish.
  const play = async (taskId, s, world_) => {
    if (s.opts.name.startsWith("mynt-verify-") && s.agentRunning && hold) return void (auditor ??= s);
    await base(taskId, s, world_);
  };
  const runId = await start(w, { agent: "coding", cap_usd: 5, task_ids: ["two-key-household-fund"] });
  const coder = await agentInFlight(w, runId, "two-key-household-fund", "mynt-build-");
  for (let i = 0; i < 200 && !auditor; i++) await step(w, runId, play);
  assert.ok(auditor, "the audit started");
  const token = JSON.parse(auditor.files.get(`${A}/auth.json`)).token;
  assert.notEqual(token, coder.token);
  // The coding agent's token was retired before its work was audited: it can't spend, or answer, while it is graded.
  assert.deepEqual(await proxyRefusal(w, coder.token), [401, "This agent token isn't active"]);
  const live = await w.benchmarks.agentRun(token);
  assert.match(live.key, /^audit:/);
  assert.deepEqual([live.capUsd, live.model], [1, audit.model]);
  assert.equal(await w.real.builds.agentRun(token), null);

  const callUsd = priceUsage(audit.model, { input_tokens: 0, output_tokens: OUTPUT_TOKENS });
  const needed = Math.ceil(live.capUsd / callUsd);
  const before = upstream.calls.length;
  for (let n = 1; n <= needed; n++) {
    assert.equal((await proxy(w, token)).status, 200, `call ${n} of ${needed}`);
    await eventually(async () => Math.abs((await w.meter.spent(live.key)) - n * callUsd) < 1e-6, `call ${n} metered`);
  }
  // Whatever model the sandbox asks for, the auditor's calls go to the audit's model, with Mynt's key.
  for (const c of upstream.calls.slice(before)) assert.deepEqual([c.key, c.authorization, c.model], ["sk-ant-test", null, audit.model]);
  assert.deepEqual(await proxyRefusal(w, token), [402, `This run's model budget (US$${live.capUsd}) is spent`]);
  assert.equal((await mcpPost(w.base, token)).status, 401);
  assert.equal((await mcpPost(w.clerkBase, token)).status, 401);

  hold = false;
  const done = await drive(w, runId, play);
  assert.equal(done.run.status, "finished");
  assert.deepEqual(await proxyRefusal(w, token), [401, "This agent token isn't active"]);
  assert.equal(await w.benchmarks.agentRun(token), null);
  // What the proxy metered for the auditor is Mynt's audit spend in the task's cost, and counts against the run's cap.
  assert.ok(done.tasks[0].cost_parts.mynt_audit >= needed * callUsd, JSON.stringify(done.tasks[0].cost_parts));
  assert.ok(done.run.charged_usd >= needed * callUsd);
  assert.equal(await w.count("build_runs"), 0);
  assert.deepEqual(outbound, []);
});
