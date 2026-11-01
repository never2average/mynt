import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { AgentMeter, priceUsage, UsageReader } from "../dist/agent-meter.js";
import { agentProxy } from "../dist/agent-proxy.js";

test("usage is priced per model, cache writes and reads included, and an unknown model errs high", () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache reads; writes 1.25x (5m) / 2x (1h).
  const u = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 100_000, ephemeral_1h_input_tokens: 100_000 } };
  assert.equal(priceUsage("claude-opus-5-5", u).toFixed(4), (4 + 2 + 0.4 + 0.5 + 0.8).toFixed(4));
  assert.equal(priceUsage("claude-haiku-5-5", { input_tokens: 1_000_000 }), 0.1);
  assert.equal(priceUsage("claude-sonnet-4-5@20250929", { output_tokens: 1_000_000 }), 15);
  assert.equal(priceUsage("some-new-model", { output_tokens: 1_000_000 }), 50, "priced as the dearest known");
  assert.equal(priceUsage("claude-opus-5-5", { cache_creation_input_tokens: 1_000_000 }), 5, "without a breakdown, writes count as 5-minute");
});

test("usage is read from plain responses and from streamed events split across chunks", () => {
  const plain = new UsageReader(false);
  plain.push(Buffer.from('{"id":"m","usage":{"input_tokens":10,'));
  plain.push(Buffer.from('"output_tokens":5}}'));
  assert.deepEqual(plain.result(), { input_tokens: 10, output_tokens: 5 });
  const sse = new UsageReader(true);
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":50,"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":75}}\n\nevent: message_stop\ndata: {}\n\n',
  ].join("");
  for (let i = 0; i < events.length; i += 37) sse.push(Buffer.from(events.slice(i, i + 37)));
  assert.deepEqual(sse.result(), { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 75 });
});

test("the proxy meters every call against its run, refuses once the budget is spent, and maps models the deployment doesn't serve", async () => {
  const pg = new PGlite();
  await pg.exec("CREATE SCHEMA IF NOT EXISTS financial_products");
  const meter = await AgentMeter.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() });
  const runs = { tok_live: { key: "build:b1", capUsd: 1 } };
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(Buffer.from(init.body).toString());
    seen.push({ url, model: body.model });
    // Each call: 100k output tokens on Opus 5.5 = $2 (over the $1 budget after one call).
    const usage = { input_tokens: 0, output_tokens: 100_000 };
    if (body.stream)
      return new Response(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":${JSON.stringify({ output_tokens: usage.output_tokens })}}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    return new Response(JSON.stringify({ id: "m", usage }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const backend = { kind: "anthropic", apiKey: "sk-ant-test" };
  const server = createServer((req, res) =>
    void agentProxy(backend, async (t) => runs[t] ?? null, req, res, new URL(req.url, "http://x"), { meter, model: "claude-opus-5-5", models: ["claude-haiku-5-5"] }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const post = (body, token = "tok_live") =>
    realFetch(`http://127.0.0.1:${server.address().port}/agent/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    // A pinned model the deployment doesn't serve goes to the configured one; an allowed one is left alone.
    const first = await post({ model: "claude-sonnet-4-5@20250929", stream: true, messages: [] });
    assert.equal(first.status, 200);
    await first.text();
    assert.equal(seen[0].model, "claude-opus-5-5");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await meter.spent("build:b1"), 2, "the streamed call's output was metered at Opus 5.5 prices");
    // Over budget now: refused before reaching the provider.
    const refused = await post({ model: "claude-haiku-5-5", messages: [] });
    assert.equal(refused.status, 402);
    assert.match((await refused.json()).error.message, /budget \(US\$1\) is spent/);
    assert.equal(seen.length, 1);
    // Another run's budget is its own; an allowed model passes unchanged; plain JSON responses are metered too.
    runs.tok_other = { key: "desk:d1", capUsd: 10 };
    const other = await post({ model: "claude-haiku-5-5", messages: [] }, "tok_other");
    await other.text();
    assert.equal(seen[1].model, "claude-haiku-5-5");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await meter.spent("desk:d1"), 0.05, "100k output tokens of Haiku 5.5");
    assert.equal((await post({ model: "x" }, "tok_dead")).status, 401);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});
