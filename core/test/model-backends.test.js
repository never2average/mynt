import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { AgentMeter } from "../dist/agent-meter.js";
import { agentProxy } from "../dist/agent-proxy.js";
import { AGENT_DIR, launchAgent, workspaceCwd, workspaceFiles } from "../dist/agent-host.js";
import { BACKEND_KEY, BACKEND_PROXY_PATH, MODEL_ROLES, ROLE_BACKEND_VALUES, priceTokens, roleBackend, roleBackendMissing } from "../dist/model-backends/index.js";
import { BACKEND_RUNNERS } from "../dist/model-backends/runners.js";
import { CODEX_CLI_PACKAGE, CODEX_CLI_VERSION, CODEX_RUNNER, PROJECT_DOC_MAX_BYTES, codexConfigToml, codexExecArgs, projectInstructions } from "../dist/model-backends/codex-cli.js";
import { ResponsesReader, UNMEASURED_CALL_LIMIT, refusalOf } from "../dist/model-backends/openai-api.js";
import { PLATFORM_KEY_TYPES } from "../dist/platform-keys.js";
import { PLATFORM_SETTINGS, checkSetting } from "../dist/platform-settings.js";

// A provider key that exists only in this file, to look for wherever it must never be.
const KEY = "sk-standin-provider-key-0123456789abcdef";
const SET = { RED_TEAM_BACKEND: "responses", RED_TEAM_MODEL: "standin-model-1", RED_TEAM_INPUT_USD_PER_MTOK: "2", RED_TEAM_OUTPUT_USD_PER_MTOK: "10", [BACKEND_KEY.responses]: KEY };
const FIXTURE = (name) => new URL(`./fixtures/agent-cli/${name}`, import.meta.url).pathname;

test("a role runs on the default backend until it is set to another, and says what is missing before a run could use it", () => {
  assert.equal(roleBackend("program-red-team", {}), null, "not set: the backend every agent uses");
  assert.equal(roleBackend("program-red-team", { RED_TEAM_BACKEND: "default" }), null);
  assert.equal(roleBackendMissing("program-red-team", {}), null);
  assert.equal(roleBackend("program-red-team", { RED_TEAM_BACKEND: "something-else" }), null, "an unknown backend is never guessed at");

  const bare = roleBackend("program-red-team", { RED_TEAM_BACKEND: "responses" });
  assert.deepEqual({ kind: bare.kind, model: bare.model, price: bare.price, keySet: bare.keySet, accessProgram: bare.accessProgram }, { kind: "responses", model: null, price: null, keySet: false, accessProgram: null });
  assert.equal(bare.missing.length, 3);
  assert.equal(
    roleBackendMissing("program-red-team", { RED_TEAM_BACKEND: "responses" }),
    "the red team is set to run on a second model backend (RED_TEAM_BACKEND is responses), and the backend's API key isn't set (RESPONSES_BACKEND_API_KEY, in Platform settings → Key vault); RED_TEAM_MODEL isn't set (the model the red team runs on; Operational settings); RED_TEAM_INPUT_USD_PER_MTOK and RED_TEAM_OUTPUT_USD_PER_MTOK aren't set (what a million tokens cost on that model: without both, the run's spend couldn't be measured)",
  );
  // One price of the two is not a price.
  assert.match(roleBackendMissing("program-red-team", { ...SET, RED_TEAM_OUTPUT_USD_PER_MTOK: "" }), /and RED_TEAM_OUTPUT_USD_PER_MTOK isn't set/);
  assert.match(roleBackendMissing("program-red-team", { ...SET, RED_TEAM_INPUT_USD_PER_MTOK: "0" }), /RED_TEAM_INPUT_USD_PER_MTOK isn't set/, "a price of 0 is no price");

  const ready = roleBackend("program-red-team", { ...SET, RED_TEAM_CACHED_INPUT_USD_PER_MTOK: "0.5", RED_TEAM_ACCESS_PROGRAM: "standin_program" });
  assert.deepEqual(ready.missing, []);
  assert.deepEqual(ready.price, { inputUsdPerMtok: 2, outputUsdPerMtok: 10, cachedInputUsdPerMtok: 0.5 });
  assert.equal(ready.model, "standin-model-1");
  assert.equal(ready.accessProgram, "standin_program");
  assert.equal(JSON.stringify(ready).includes(KEY), false, "what a role runs on never carries the key");
  assert.equal(roleBackendMissing("program-red-team", SET), null);
});

test("tokens are priced only with the prices an admin set; cached input costs the input price unless it has its own", () => {
  const price = { inputUsdPerMtok: 2, outputUsdPerMtok: 10, cachedInputUsdPerMtok: null };
  assert.equal(priceTokens(price, { input: 1_000_000, cachedInput: 0, output: 100_000 }), 3);
  assert.equal(priceTokens(price, { input: 1_000_000, cachedInput: 400_000, output: 0 }), 2, "no cached price: never lower than input");
  assert.equal(priceTokens({ ...price, cachedInputUsdPerMtok: 0.5 }, { input: 1_000_000, cachedInput: 400_000, output: 0 }), 1.2 + 0.2);
});

test("the settings and the key type exist, take what an operator would set, and name no model", () => {
  const settings = Object.fromEntries(PLATFORM_SETTINGS.map((s) => [s.key, s]));
  const role = MODEL_ROLES["program-red-team"];
  for (const key of [role.backend, role.model, role.inputPrice, role.outputPrice, role.cachedInputPrice, role.accessProgram]) assert.ok(settings[key], key);
  assert.deepEqual(settings.RED_TEAM_BACKEND.check.values, [...ROLE_BACKEND_VALUES], "the setting's values are the backends a role can run on");
  assert.equal(settings.RED_TEAM_BACKEND.default, "default");
  // No model and no price is built in: the operator's account decides both.
  for (const key of [role.model, role.inputPrice, role.outputPrice, role.cachedInputPrice, role.accessProgram]) assert.equal(settings[key].default, "", key);
  assert.deepEqual(checkSetting("RED_TEAM_MODEL", "Provider-Model.5-x"), { ok: true, value: "Provider-Model.5-x" });
  assert.equal(checkSetting("RED_TEAM_MODEL", "a model").ok, false);
  assert.deepEqual(checkSetting("RED_TEAM_INPUT_USD_PER_MTOK", "1.25"), { ok: true, value: "1.25" });
  assert.equal(checkSetting("RED_TEAM_INPUT_USD_PER_MTOK", "0").ok, false, "a price is never 0");
  assert.equal(checkSetting("RED_TEAM_BACKEND", "anything").ok, false);
  assert.deepEqual(checkSetting("RED_TEAM_ACCESS_PROGRAM", "standin_program"), { ok: true, value: "standin_program" });
  const type = PLATFORM_KEY_TYPES.find((t) => t.key === BACKEND_KEY.responses);
  assert.ok(type, "the backend's key is a platform key type");
  assert.equal(type.needs_restart, false, "read where it is used: a new key applies to the next call");
  assert.equal(type.check(KEY), null);
  assert.match(type.purpose, /Never sent to a sandbox/);
});

test("usage and refusals are read from the provider's answers, streamed or whole", () => {
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":120,"input_tokens_details":{"cached_tokens":20},"output_tokens":30,"output_tokens_details":{"reasoning_tokens":10},"total_tokens":150}}}\n\n',
  ].join("");
  const sse = new ResponsesReader(true);
  for (let i = 0; i < events.length; i += 41) sse.push(Buffer.from(events.slice(i, i + 41)));
  assert.deepEqual(sse.result(), { usage: { input: 120, cachedInput: 20, output: 30 }, refusal: null });

  const plain = new ResponsesReader(false);
  plain.push(Buffer.from('{"id":"resp_2","usage":{"input_tokens":7,'));
  plain.push(Buffer.from('"output_tokens":3}}'));
  assert.deepEqual(plain.result(), { usage: { input: 7, cachedInput: 0, output: 3 }, refusal: null });

  // A stream cut before its last event has no usage: said as that, never 0 tokens.
  const cut = new ResponsesReader(true);
  cut.push(Buffer.from(events.slice(0, 200)));
  assert.equal(cut.result().usage, null);

  // Refusals: a failed response with a policy code, one cut by the content filter, a message that is only a refusal.
  const failed = new ResponsesReader(true);
  failed.push(Buffer.from('data: {"type":"response.failed","response":{"error":{"code":"standin_policy_violation","message":"declined"},"usage":{"input_tokens":50,"output_tokens":0}}}\n\n'));
  assert.deepEqual(failed.result(), { usage: { input: 50, cachedInput: 0, output: 0 }, refusal: "standin_policy_violation" });
  const filtered = new ResponsesReader(false);
  filtered.push(Buffer.from('{"status":"incomplete","incomplete_details":{"reason":"content_filter"},"usage":{"input_tokens":5,"output_tokens":1}}'));
  assert.equal(filtered.result().refusal, "content_filter");
  const refused = new ResponsesReader(false);
  refused.push(Buffer.from('{"output":[{"type":"message","content":[{"type":"refusal","refusal":"I can\'t help with that."}]}],"usage":{"input_tokens":5,"output_tokens":9}}'));
  assert.equal(refused.result().refusal, "refusal");

  // What is not a refusal is never recorded as one.
  assert.equal(refusalOf({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }), null);
  assert.equal(refusalOf({ error: { code: "server_error", message: "The server had an error" } }), null);
  assert.equal(refusalOf({ error: { type: "invalid_request_error", message: "Unknown parameter: 'foo'" } }), null);
  assert.equal(refusalOf({ incompleteReason: "max_output_tokens" }), null);
  assert.equal(refusalOf({ error: { code: "invalid_prompt", message: "flagged" } }), "invalid_prompt");
  assert.equal(refusalOf({ error: { type: "invalid_request_error", message: "This request violates our usage policies." } }), "invalid_request_error");
});

// Mynt's proxy in front of a stand-in provider (fetch is swapped for it; nothing leaves this process).
async function proxyWorld(provider) {
  const pg = new PGlite();
  await pg.exec("CREATE SCHEMA IF NOT EXISTS financial_products");
  const meter = await AgentMeter.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() });
  const price = { inputUsdPerMtok: 2, outputUsdPerMtok: 10, cachedInputUsdPerMtok: null };
  const runs = {
    tok_red: { key: "program-red-team:r1", capUsd: 1, model: "standin-model-1", backend: { kind: "responses", price, accessProgram: "standin_program" } },
    tok_unpriced: { key: "program-red-team:r2", capUsd: 1, model: "standin-model-1", backend: { kind: "responses", price: null, accessProgram: null } },
    tok_quiet: { key: "program-red-team:r3", capUsd: 1, model: "standin-model-1", backend: { kind: "responses", price, accessProgram: null } },
    tok_build: { key: "build:b1", capUsd: 1 },
  };
  const seen = [];
  const keys = { value: KEY };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    if (String(target).startsWith("http://127.0.0.1")) return realFetch(target, init);
    seen.push({ url: String(target), headers: { ...init.headers }, body: JSON.parse(Buffer.from(init.body).toString("utf8")) });
    return provider(seen[seen.length - 1], seen.length);
  };
  const server = createServer((req, res) =>
    void agentProxy({ kind: "anthropic", apiKey: "sk-ant-default-backend-key" }, async (t) => runs[t] ?? null, req, res, new URL(req.url, "http://x"), { meter, model: "claude-opus-5-5", backendKey: () => keys.value }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (token, body, path = `${BACKEND_PROXY_PATH.responses}/responses`, method = "POST") =>
    realFetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-codex-turn-metadata": '{"installation_id":"abc"}' }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}) });
  const close = async () => {
    globalThis.fetch = realFetch;
    await new Promise((r) => server.close(r));
    await pg.close();
  };
  return { meter, runs, seen, keys, post, close };
}
const answer = (usage, extra = {}) => new Response(JSON.stringify({ id: "resp_1", output: [], ...(usage ? { usage } : {}), ...extra }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_standin_1" } });
const settled = () => new Promise((r) => setTimeout(r, 40));

test("the proxy adds the key, pins the model, names only the admin's access programme, and a sandbox's token reaches nothing else", async () => {
  const w = await proxyWorld(() => answer({ input_tokens: 100_000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10_000 }));
  try {
    const res = await w.post("tok_red", {
      model: "some-other-model",
      service_tier: "priority",
      access_programs: { cyber: "one_the_sandbox_chose" },
      stream: false,
      input: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", name: "exec_command" }, { type: "web_search" }, { type: "namespace", name: "multi_agent_v1" }, { type: "code_interpreter" }, { type: "mcp", server_url: "https://elsewhere.invalid" }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-request-id"), "req_standin_1");
    assert.equal(w.seen.length, 1);
    const sent = w.seen[0];
    assert.equal(sent.url, "https://api.openai.com/v1/responses");
    assert.equal(sent.headers.authorization, `Bearer ${KEY}`, "Mynt's key, not the sandbox's token");
    assert.deepEqual(Object.keys(sent.headers).sort(), ["accept", "authorization", "content-type"], "nothing of the sandbox's own headers is passed on");
    assert.equal(sent.body.model, "standin-model-1", "the run's model, whatever was asked for");
    assert.equal(sent.body.service_tier, undefined);
    assert.deepEqual(sent.body.access_programs, { cyber: "standin_program" }, "the programme an admin set, never the sandbox's");
    assert.deepEqual(sent.body.tools.map((t) => t.type), ["function", "namespace"], "only tools the sandbox runs itself");
    assert.equal(JSON.stringify(sent.body).includes("tok_red"), false);
    await settled();
    assert.equal((await w.meter.spent("program-red-team:r1")).toFixed(4), (0.2 + 0.1).toFixed(4), "metered at the admin's prices");

    // No programme set: none is named, whatever the sandbox asks for.
    await w.post("tok_quiet", { model: "x", access_programs: { cyber: "one_the_sandbox_chose" }, input: [] });
    assert.equal(w.seen[1].body.access_programs, undefined);

    // Another path, another method, another backend's token, a dead token: nothing is sent.
    const before = w.seen.length;
    assert.equal((await w.post("tok_red", {}, `${BACKEND_PROXY_PATH.responses}/models`)).status, 404);
    assert.equal((await w.post("tok_red", {}, `${BACKEND_PROXY_PATH.responses}/responses/resp_1/cancel`)).status, 404);
    assert.equal((await w.post("tok_red", {}, `${BACKEND_PROXY_PATH.responses}/responses`, "GET")).status, 404);
    assert.equal((await w.post("tok_gone", { input: [] })).status, 401);
    const wrong = await w.post("tok_build", { input: [] });
    assert.equal(wrong.status, 403, "a token of a run on the default backend doesn't work here");
    assert.match((await wrong.json()).error.message, /isn't for this model backend/);
    // And a second-backend token doesn't work on the default backend's path: it can't pick that backend's models.
    const other = await w.post("tok_red", { model: "claude-opus-5-5", max_tokens: 1, messages: [] }, "/agent/v1/messages");
    assert.equal(other.status, 403);
    assert.match((await other.json()).error.message, /isn't for this model backend/);
    assert.equal((await w.post("tok_red", "not an object")).status, 400);
    assert.equal(w.seen.length, before, "none of those reached the provider");

    // The key was removed since: nothing is sent, and the answer names no key.
    w.keys.value = null;
    const unset = await w.post("tok_red", { input: [] });
    assert.equal(unset.status, 503);
    assert.equal(w.seen.length, before);
  } finally {
    await w.close();
  }
});

test("the proxy meters each answer against the run's cap and stops at it; with no price it sends nothing; an answer without usage is counted as not measured, never as 0", async () => {
  const w = await proxyWorld((_req, n) => (n <= 2 ? answer({ input_tokens: 200_000, output_tokens: 20_000 }) : answer(null)));
  try {
    // US$0.60 a call at $2 / $10 per million: the second call takes the run to US$1.20, over its US$1 cap.
    assert.equal((await w.post("tok_red", { input: [] })).status, 200);
    await settled();
    assert.equal((await w.post("tok_red", { input: [] })).status, 200);
    await settled();
    assert.equal((await w.meter.spent("program-red-team:r1")).toFixed(2), "1.20");
    const over = await w.post("tok_red", { input: [] });
    assert.equal(over.status, 402);
    assert.equal((await over.json()).error.message, "This run's model budget (US$1) is spent");
    assert.equal(w.seen.length, 2, "the third call never reached the provider");

    // No price set for the run's backend: nothing is forwarded, so nothing is spent that couldn't be measured.
    const unpriced = await w.post("tok_unpriced", { input: [] });
    assert.equal(unpriced.status, 503);
    assert.match((await unpriced.json()).error.message, /No token price is set .* nothing was sent/);
    assert.equal(w.seen.length, 2);
    assert.equal(await w.meter.unmeasured("program-red-team:r2"), null);

    // Answered, but with no usage to price: the call is counted as not measured (the run's cost is then unknown, and
    // whoever budgets it reserves its whole cap); after a few of them the run gets no more calls.
    for (let i = 0; i < UNMEASURED_CALL_LIMIT; i++) {
      assert.equal((await w.post("tok_quiet", { input: [] })).status, 200);
      await settled();
    }
    assert.deepEqual(await w.meter.unmeasured("program-red-team:r3"), { calls: UNMEASURED_CALL_LIMIT, input_tokens: 0, output_tokens: 0 });
    assert.equal(await w.meter.spent("program-red-team:r3"), 0, "no dollars were invented for them");
    const stopped = await w.post("tok_quiet", { input: [] });
    assert.equal(stopped.status, 402);
    assert.match((await stopped.json()).error.message, /couldn't be measured/);
  } finally {
    await w.close();
  }
});

test("a provider's refusal is recorded against the run with its request id, and the provider's key is scrubbed from any error", async () => {
  const w = await proxyWorld((_req, n) => {
    if (n === 1) return new Response(JSON.stringify({ error: { message: "This request was declined by the provider's safety policy.", type: "invalid_request_error", code: "standin_policy" } }), { status: 400, headers: { "content-type": "application/json", "x-request-id": "req_standin_refused_1" } });
    if (n === 2)
      return new Response('event: response.incomplete\ndata: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"content_filter"},"usage":{"input_tokens":1000,"output_tokens":10}}}\n\n', { status: 200, headers: { "content-type": "text/event-stream", "x-request-id": "req_standin_refused_2" } });
    if (n === 3) return new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}.`, type: "invalid_request_error", code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json", "x-request-id": "req_standin_3" } });
    return new Response(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } });
  });
  try {
    const refused = await w.post("tok_red", { input: [] });
    assert.equal(refused.status, 400, "the provider's own status and words go back to the agent");
    assert.equal((await refused.json()).error.code, "standin_policy");
    const streamed = await w.post("tok_red", { stream: true, input: [] });
    assert.equal(streamed.status, 200);
    await streamed.text();
    await settled();
    const badKey = await w.post("tok_red", { input: [] });
    const text = await badKey.text();
    assert.equal(badKey.status, 401);
    assert.equal(text.includes(KEY), false, "the key never comes back in an error");
    assert.match(text, /Incorrect API key provided: \[/);
    const limited = await w.post("tok_red", { input: [] });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "2");
    const refusals = await w.meter.refusals("program-red-team:r1");
    assert.deepEqual(
      refusals.map((r) => [r.category, r.request_id]),
      [["standin_policy", "req_standin_refused_1"], ["content_filter", "req_standin_refused_2"]],
      "the two refusals, and neither the bad key nor the rate limit",
    );
    assert.equal((await w.meter.spent("program-red-team:r1")).toFixed(4), (0.002 + 0.0001).toFixed(4), "a refused answer's tokens are still metered");
  } finally {
    await w.close();
  }
});

test("AGENTS.md is made from the workspace's CLAUDE.md when the job is prepared: one set of instructions, with the skills by path", () => {
  const files = workspaceFiles("program-red-team");
  assert.equal(files["AGENTS.md"], undefined, "the workspace keeps one set of instructions, CLAUDE.md");
  const made = projectInstructions(files);
  assert.deepEqual(Object.keys(made), ["AGENTS.md"]);
  const text = made["AGENTS.md"];
  assert.ok(text.endsWith(files["CLAUDE.md"]), "CLAUDE.md, word for word");
  assert.ok(text.indexOf("---") < text.indexOf(files["CLAUDE.md"].slice(0, 40)));
  for (const skill of ["account-validation", "pda-security", "verification-protocol"]) {
    assert.ok(text.includes(`- \`${skill}\`: \`.claude/skills/${skill}/SKILL.md\``), skill);
    assert.ok(files[`.claude/skills/${skill}/SKILL.md`], `${skill} is a file the agent can read`);
  }
  assert.ok(Buffer.byteLength(text) < PROJECT_DOC_MAX_BYTES);
  // A workspace that brings its own AGENTS.md keeps it; one with no CLAUDE.md, or too long for the CLI, is refused.
  assert.deepEqual(projectInstructions({ "CLAUDE.md": "x", "AGENTS.md": "mine" }), {});
  assert.throws(() => projectInstructions({ "README.md": "x" }), /no CLAUDE\.md/);
  assert.throws(() => projectInstructions({ "CLAUDE.md": "x".repeat(PROJECT_DOC_MAX_BYTES) }), /more than the agent CLI reads/);
  assert.deepEqual(Object.keys(projectInstructions({ "CLAUDE.md": "No skills here." })), ["AGENTS.md"]);
});

test("the CLI's launch line and config are the ones checked against the CLI itself", () => {
  assert.equal(CODEX_CLI_PACKAGE, "@openai/codex");
  assert.match(CODEX_CLI_VERSION, /^\d+\.\d+\.\d+$/, "an exact version, never a range or a tag");
  assert.deepEqual(codexExecArgs({ cwd: "/home/user/workspaces/program-red-team", model: "standin-model-1", lastMessageFile: "/home/user/mynt-agent/last-message.txt", prompt: "Attack the program." }), [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/home/user/workspaces/program-red-team",
    "-m",
    "standin-model-1",
    "-o",
    "/home/user/mynt-agent/last-message.txt",
    "Attack the program.",
  ]);
  const toml = codexConfigToml({ model: "standin-model-1", baseUrl: "https://mynt.example/agent/r/v1" });
  for (const line of ['model = "standin-model-1"', 'model_provider = "mynt"', "[model_providers.mynt]", 'base_url = "https://mynt.example/agent/r/v1"', 'env_key = "MYNT_AGENT_TOKEN"', 'wire_api = "responses"', "[analytics]\nenabled = false", "[feedback]\nenabled = false", '[history]\npersistence = "none"', '[shell_environment_policy]\nexclude = ["MYNT_AGENT_TOKEN"]', `project_doc_max_bytes = ${PROJECT_DOC_MAX_BYTES}`])
    assert.ok(toml.includes(line), line);
  assert.equal(/api\.openai\.com|sk-/.test(toml), false, "the CLI is given Mynt's proxy and no key");
  assert.equal(BACKEND_RUNNERS.responses.version, CODEX_CLI_VERSION);
});

// A stand-in for the CLI: it records how it was launched and prints output recorded from the real one.
function fakeCli(dir) {
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const pick = (k) => process.env[k] ?? null;
writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdinIsTty: !!process.stdin.isTTY,
  env: Object.fromEntries(["CODEX_HOME", "MYNT_AGENT_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY"].map((k) => [k, pick(k)])),
  config: readFileSync(process.env.CODEX_HOME + "/config.toml", "utf8") }));
const o = process.argv.indexOf("-o");
if (process.env.FAKE_LAST && o > 0) writeFileSync(process.argv[o + 1], process.env.FAKE_LAST);
process.stdout.write(readFileSync(process.env.FAKE_FIXTURE, "utf8"));
process.exit(Number(process.env.FAKE_EXIT || 0));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}
function runRunner(fixture, exit, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mynt-cli-runner-"));
  const agent = join(dir, "agent");
  const cwd = join(dir, "workspace");
  mkdirSync(agent);
  writeFileSync(join(agent, "runner.mjs"), CODEX_RUNNER);
  writeFileSync(join(agent, "config.json"), JSON.stringify({ prompt: "Attack the program in job/target.json.", cwd, model: "standin-model-1", budgetUsd: 8, version: CODEX_CLI_VERSION }));
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ token: "mynt_predteam_standin", baseUrl: "https://mynt.example/agent/r/v1" }));
  const out = join(dir, "launch.json");
  const run = spawnSync(process.execPath, [join(agent, "runner.mjs"), agent], {
    encoding: "utf8",
    timeout: 30_000,
    // Keys a sandbox should never hold, set here to see that the runner still keeps them from the CLI.
    env: { PATH: process.env.PATH, HOME: dir, MYNT_AGENT_CLI_BIN: fakeCli(dir), FAKE_OUT: out, FAKE_FIXTURE: FIXTURE(fixture), FAKE_EXIT: String(exit), OPENAI_API_KEY: "leftover-key", CODEX_API_KEY: "leftover-key", ANTHROPIC_API_KEY: "leftover-key", OPENAI_BASE_URL: "https://elsewhere.invalid", ...extraEnv },
  });
  const read = (f) => (existsSync(join(agent, f)) ? readFileSync(join(agent, f), "utf8") : null);
  const result = { run, agent, cwd, launch: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null, state: JSON.parse(read("state.json")), jsonl: read("agent.jsonl"), files: readdirSync(agent) };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("the runner launches the CLI headless at Mynt's proxy with the run's token, keeps other keys from it, and reads its recorded output", () => {
  const r = runRunner("exec-completed.jsonl", 0);
  assert.equal(r.run.status, 0, r.run.stderr);
  assert.deepEqual(r.launch.argv, codexExecArgs({ cwd: r.cwd, model: "standin-model-1", lastMessageFile: join(r.agent, "last-message.txt"), prompt: "Attack the program in job/target.json." }));
  assert.equal(r.launch.cwd, r.cwd);
  assert.equal(r.launch.stdinIsTty, false);
  assert.deepEqual(r.launch.env, { CODEX_HOME: join(r.agent, "cli-home"), MYNT_AGENT_TOKEN: "mynt_predteam_standin", OPENAI_API_KEY: null, CODEX_API_KEY: null, OPENAI_BASE_URL: null, ANTHROPIC_API_KEY: null });
  assert.equal(r.launch.config, codexConfigToml({ model: "standin-model-1", baseUrl: "https://mynt.example/agent/r/v1" }), "the runner writes the config the server-side builder makes");
  assert.equal(r.files.includes("auth.json"), false, "the token's file is read once and deleted");
  // The recorded run: one command, a final message, usage.
  assert.deepEqual(r.state, {
    session_id: "01a221b1-1afe-7ab0-9bf8-e0d4e0c5e667",
    cost_usd: 0,
    turns: 1,
    sent: 1,
    last_subtype: "success",
    done: true,
    exit_code: 0,
    error: null,
    summary: "Report written.",
    usage: { input_tokens: 240, cached_input_tokens: 40, output_tokens: 60 },
  });
  assert.equal(r.jsonl, readFileSync(FIXTURE("exec-completed.jsonl"), "utf8"), "the CLI's events are kept as they came");
});

test("the runner records a failed turn: a refusal as the CLI words it, and the proxy's spent budget as a spent budget", () => {
  const refused = runRunner("exec-refused.jsonl", 1);
  assert.deepEqual(
    { turns: refused.state.turns, last: refused.state.last_subtype, done: refused.state.done, exit: refused.state.exit_code, summary: refused.state.summary },
    { turns: 1, last: "error_during_execution", done: true, exit: 1, summary: "This request was declined by the provider's safety policy." },
  );
  const spent = runRunner("exec-budget-spent.jsonl", 1);
  assert.equal(spent.state.last_subtype, "error_max_budget_usd", "what the gate reads as out of budget, and never retries");
  assert.match(spent.state.summary, /This run's model budget \(US\$8\) is spent/);
  assert.equal(spent.state.exit_code, 1);
});

test("an agent launched on the second backend gets that backend's runner, AGENTS.md and Mynt's proxy; the provider's key is in nothing the sandbox is given", async () => {
  const files = new Map();
  const commands = [];
  const sandboxes = {
    writeFiles: async (_id, f) => void Object.entries(f).forEach(([p, c]) => files.set(p, c)),
    writeFile: async (_id, p, c) => void files.set(p, c),
    exec: async (_id, command) => (commands.push(command), { processId: 7 }),
  };
  const saved = process.env[BACKEND_KEY.responses];
  process.env[BACKEND_KEY.responses] = KEY;
  try {
    const config = { agentBackend: null, model: "claude-opus-5-5", publicUrl: "https://mynt.example" };
    const pid = await launchAgent(sandboxes, config, "sb1", { prompt: "Attack.", budgetUsd: 8, token: "mynt_predteam_tok", model: "standin-model-1", workspace: "program-red-team", jobFiles: { "job/target.json": "{}" }, backend: "responses" });
    assert.equal(pid, "7");
    const cwd = workspaceCwd("program-red-team");
    assert.equal(files.get(`${AGENT_DIR}/runner.mjs`), CODEX_RUNNER);
    assert.deepEqual(JSON.parse(files.get(`${AGENT_DIR}/auth.json`)), { token: "mynt_predteam_tok", baseUrl: "https://mynt.example/agent/r/v1" });
    assert.deepEqual(JSON.parse(files.get(`${AGENT_DIR}/config.json`)), { prompt: "Attack.", cwd, model: "standin-model-1", budgetUsd: 8, version: CODEX_CLI_VERSION });
    assert.equal(files.get(`${cwd}/AGENTS.md`), projectInstructions(workspaceFiles("program-red-team"))["AGENTS.md"]);
    assert.equal(files.get(`${cwd}/CLAUDE.md`), workspaceFiles("program-red-team")["CLAUDE.md"]);
    assert.equal(commands.length, 1);
    assert.equal(commands[0], `node ${AGENT_DIR}/runner.mjs ${AGENT_DIR} >${AGENT_DIR}/runner.log 2>&1`);
    for (const [path, content] of files) assert.equal(String(content).includes(KEY), false, `${path} holds the provider's key`);
    assert.equal(commands.join("\n").includes(KEY), false);
    await assert.rejects(launchAgent(sandboxes, config, "sb1", { prompt: "x", budgetUsd: 1, token: "t", backend: "responses", mcp: true }), /runs one turn/);

    // Without a second backend nothing changes: the other runner, and no AGENTS.md.
    files.clear();
    await launchAgent(sandboxes, { ...config, agentBackend: { kind: "anthropic", apiKey: "sk-ant-x" } }, "sb1", { prompt: "Attack.", budgetUsd: 8, token: "tok", workspace: "program-red-team" });
    assert.notEqual(files.get(`${AGENT_DIR}/runner.mjs`), CODEX_RUNNER);
    assert.equal(files.has(`${cwd}/AGENTS.md`), false);
  } finally {
    if (saved === undefined) delete process.env[BACKEND_KEY.responses];
    else process.env[BACKEND_KEY.responses] = saved;
  }
});
