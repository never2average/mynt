import { test } from "node:test";
import assert from "node:assert/strict";
import { StreamState, STREAM_TEXT_MAX } from "../dist/activity.js";
import { redact } from "../dist/boxes.js";

// Claude Code's stream-json lines with --include-partial-messages, as the runner keeps them.
const start = (id, lane = null) => ({ type: "stream_event", parent_tool_use_id: lane, event: { type: "message_start", message: { id } } });
const block = (index, id, lane = null) => ({ type: "stream_event", parent_tool_use_id: lane, api_message_id: id, event: { type: "content_block_start", index, content_block: { type: "text" } } });
const delta = (index, text, id, lane = null) => ({ type: "stream_event", parent_tool_use_id: lane, api_message_id: id, event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } });
const said = (id, text, lane = null) => ({ type: "assistant", parent_tool_use_id: lane, message: { id, content: [{ type: "text", text }] } });
const ran = (id, command) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

// Feeds lines in reads (each an array of lines), flushing after each read as the collector does.
function collect(reads, state = new StreamState()) {
  const out = [];
  for (const lines of reads) {
    for (const l of lines) out.push(...state.entries(l));
    out.push(...state.flush());
  }
  return out;
}
const streamed = (entries, stream) => entries.filter((e) => e.type === "text_delta" && e.stream === stream).map((e) => e.summary).join("");

test("a message's words stream as text_delta entries, coalesced per read, and its full message closes the stream", () => {
  const out = collect([
    [start("msg_1"), block(0, "msg_1"), delta(0, "Reading ", "msg_1"), delta(0, "the sp", "msg_1")],
    [delta(0, "ec now.\n\nNext I", "msg_1"), delta(0, " will test.", "msg_1")],
    [said("msg_1", "Reading the spec now.\n\nNext I will test."), ran("msg_1", "npm test")],
  ]);
  assert.deepEqual(out, [
    { type: "text_delta", summary: "Reading the ", stream: "msg_1:0" }, // "sp" is held back: a word still being written
    { type: "text_delta", summary: "spec now.\n\nNext I will ", stream: "msg_1:0" },
    { type: "text_delta", summary: "test.", stream: "msg_1:0" }, // the rest, when the message is whole
    { type: "message", summary: "Reading the spec now. Next I will test.", stream: "msg_1:0" },
    { type: "tool_use", summary: 'Bash {"command":"npm test"}' },
  ]);
});

test("without partial messages (or an older log) messages are stored as before, with no stream", () => {
  assert.deepEqual(collect([[{ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }, { type: "result", subtype: "success", total_cost_usd: 0.5 }]]), [
    { type: "message", summary: "Hello" },
    { type: "turn_finished", summary: "success, US$0.50" },
  ]);
  // Deltas for a block whose start this reader never saw (Mynt restarted mid-message) aren't streamed.
  assert.deepEqual(collect([[delta(0, "half a message ", "msg_9"), said("msg_9", "half a message whole")]]), [{ type: "message", summary: "half a message whole" }]);
});

test("a secret split across deltas never streams, in any split", () => {
  const secrets = [
    "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "mynt_agent_abcdefghijklmnop",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
  ];
  const texts = [
    ...secrets.map((s) => `Found the token ${s} in the env file, removing it.`),
    "Set GITHUB_TOKEN=supersecretvalue123 then push.",
    'Config has "password": "correct horse battery staple" and more.',
    "Connect with postgres://admin:hunter2pass@db.internal:5432/app please.",
    "Header Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 was sent.",
    "The key:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n-----END PRIVATE KEY-----\nthat was it.",
  ];
  const leaks = ["abcdefghij", "supersecret", "correct horse", "horse battery", "hunter2", "MIIEvQ", "AAAAAAAAAA"];
  for (const text of texts) {
    // Every two-way split, and every three-way split on a stride.
    const splits = [];
    for (let i = 1; i < text.length; i++) splits.push([text.slice(0, i), text.slice(i)]);
    for (let i = 1; i < text.length; i += 3) for (let j = i + 1; j < text.length; j += 5) splits.push([text.slice(0, i), text.slice(i, j), text.slice(j)]);
    for (const pieces of splits) {
      // Each piece in its own read, so each is flushed (and so could leak) on its own.
      const reads = [[start("m"), block(0, "m")], ...pieces.map((p) => [delta(0, p, "m")]), [said("m", text)]];
      const out = collect(reads);
      const shown = streamed(out, "m:0");
      for (const leak of leaks) assert.ok(!shown.includes(leak), `${JSON.stringify(pieces)} streamed ${JSON.stringify(shown)}`);
      for (const e of out) for (const leak of leaks) assert.ok(!e.summary.includes(leak), `${JSON.stringify(pieces)} stored ${JSON.stringify(e)}`);
      // Held back, not lost: apart from a key block (which stops its stream), the whole scrubbed text streams.
      if (!text.includes("BEGIN")) {
        assert.equal(shown, redact(text), JSON.stringify(pieces));
        assert.equal(out[out.length - 1].stream, "m:0");
      }
    }
  }
});

test("streamed text only ever extends what was sent; a block whose scrubbed text changes stops streaming and its message stands alone", () => {
  const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
  const out = collect([
    [start("m"), block(0, "m"), delta(0, "Here: ", "m")],
    [delta(0, "-----BEGIN PRIVATE KEY-----\n", "m")],
    [delta(0, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY----- done", "m")],
    [said("m", `Here: ${key} done`)],
  ]);
  assert.ok(out.every((e) => !e.summary.includes("MIIEvQ")), JSON.stringify(out));
  const last = out[out.length - 1];
  assert.deepEqual(last.type, "message");
  assert.equal(last.stream, undefined, "not tied to the stream: the follower shows it whole");
});

test("lanes and blocks stay apart: a sub-agent's words, a second text block, and a very long block", () => {
  const out = collect([
    [start("a"), block(0, "a"), delta(0, "Lead says ", "a"), start("b", "toolu_1"), block(0, "b", "toolu_1"), delta(0, "Sub says ", "b", "toolu_1")],
    [said("a", "Lead says hi"), block(1, "a"), delta(1, "Second block ", "a"), said("b", "Sub says hi", "toolu_1")],
    [said("a", "Second block end")],
  ]);
  assert.equal(streamed(out, "a:0"), "Lead says hi");
  assert.equal(streamed(out, "b:0"), "Sub says hi");
  assert.equal(streamed(out, "a:1"), "Second block end");
  assert.deepEqual(out.filter((e) => e.type === "message").map((e) => [e.summary, e.stream]), [["Lead says hi", "a:0"], ["Sub says hi", "b:0"], ["Second block end", "a:1"]]);

  const long = "word ".repeat(STREAM_TEXT_MAX / 5 + 10);
  const big = collect([[start("c"), block(0, "c"), delta(0, long, "c"), said("c", long)]]);
  assert.deepEqual(big.map((e) => e.type), ["message"], "past the limit a block isn't streamed");
});

test("a state is carried between reads by copy: a read that isn't kept leaves it as it was", () => {
  const s = new StreamState();
  collect([[start("m"), block(0, "m"), delta(0, "one ", "m")]], s);
  const copy = s.clone();
  collect([[delta(0, "two ", "m")]], copy);
  const out = collect([[delta(0, "three ", "m"), said("m", "one three ")]], s);
  assert.equal(out.filter((e) => e.type === "text_delta").map((e) => e.summary).join(""), "three ");
});
