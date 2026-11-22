// The studio's chats on Mynt: sessions with an append-only log of events, every kind in one shape, read and
// written only by the user who had them, and never logged with what was said.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MAX_EVENT_BYTES, MAX_SESSION_BYTES, MAX_SESSIONS_PER_KIND, createChatSession, listChatSessions } from "../dist/chat-sessions.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

async function openStore() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  return Store.open(db, CATALOG);
}
async function connect(store, user) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user, {}).connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  // Arguments the schema refuses come back as the SDK's own text, not JSON.
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  return { error: r.isError ?? false, body };
};
const message = (id, role, text, extra = []) => ({ type: "message", role, client_id: `m:${id}:1`, payload: { id, role, parts: [{ type: "text", text }, ...extra] } });

test("a session is created once, appended to in order with no gaps, and replayed as it was written", async () => {
  const store = await openStore();
  const dev = await connect(store, (await store.createUser("Dev", ["developer"])).user);
  const id = randomUUID();
  const made = await call(dev, "create_chat_session", { id, kind: "product", title: "A savings pot" });
  assert.equal(made.error, false);
  assert.equal(made.body.created, true);
  assert.equal(made.body.session.last_seq, 0);
  // Creating it again (a retry) answers the same session.
  const again = await call(dev, "create_chat_session", { id, kind: "product" });
  assert.equal(again.body.created, false);
  assert.equal(again.body.session.title, "A savings pot");

  const draft = { type: "data-product-draft", data: { id: "d1", name: "Pot" } };
  const first = await call(dev, "append_chat_events", { id, events: [message("u1", "user", "I want a savings pot"), message("a1", "assistant", "Here is a draft", [draft])] });
  assert.equal(first.error, false);
  assert.deepEqual(first.body.appended, [1, 2]);
  // A retried append adds nothing; the next numbers follow on.
  const retry = await call(dev, "append_chat_events", { id, events: [message("u1", "user", "I want a savings pot"), { type: "outcome", client_id: "o:d1:created", payload: { draft_id: "d1", product_id: "pot" } }] });
  assert.deepEqual(retry.body.appended, [3]);
  assert.equal(retry.body.duplicates, 1);
  assert.equal(retry.body.last_seq, 3);
  // A title event retitles it; a metadata event merges into its references.
  await call(dev, "append_chat_events", { id, events: [{ type: "title", payload: { title: "Savings pot" } }, { type: "metadata", payload: { product_id: "pot" } }] });
  // expect_seq refuses an append when the log has moved on.
  const stale = await call(dev, "append_chat_events", { id, expect_seq: 2, events: [message("u2", "user", "more")] });
  assert.equal(stale.error, true);
  assert.match(stale.body.error, /ends at event 5, not 2/);

  const got = await call(dev, "get_chat_session", { id });
  assert.equal(got.error, false);
  assert.deepEqual(got.body.events.map((e) => [e.seq, e.type]), [[1, "message"], [2, "message"], [3, "outcome"], [4, "title"], [5, "metadata"]]);
  assert.deepEqual(got.body.events[1].payload.parts[1], draft);
  assert.equal(got.body.session.title, "Savings pot");
  assert.deepEqual(got.body.session.metadata, { product_id: "pot" });
  const after = await call(dev, "get_chat_session", { id, after_seq: 3 });
  assert.deepEqual(after.body.events.map((e) => e.seq), [4, 5]);
  // JSONL: the session's line, then one line per event.
  const jsonl = (await call(dev, "get_chat_session", { id, format: "jsonl" })).body.jsonl.split("\n").map((l) => JSON.parse(l));
  assert.equal(jsonl.length, 6);
  assert.equal(jsonl[0].type, "session");
  assert.deepEqual(jsonl.slice(1).map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.ok(jsonl.slice(1).every((e) => e.session_id === id));

  // Unknown fields and event types are refused before anything runs.
  assert.equal((await call(dev, "append_chat_events", { id, events: [{ type: "nonsense", payload: {} }] })).error, true);
  assert.equal((await call(dev, "append_chat_events", { id, events: [{ type: "message", payload: {}, extra: 1 }] })).error, true);
});

test("only the user who had a chat reads, adds to or deletes it; admins included", async () => {
  const store = await openStore();
  const alice = await connect(store, (await store.createUser("Alice", ["developer"])).user);
  const bob = await connect(store, (await store.createUser("Bob", ["liquidity_provider"])).user);
  const admin = await connect(store, (await store.createUser("Ada", ["admin"])).user);
  const id = randomUUID();
  await call(alice, "create_chat_session", { id, kind: "earn" });
  await call(alice, "append_chat_events", { id, events: [message("u1", "user", "Park $500 for a month")] });
  for (const other of [bob, admin]) {
    for (const [tool, args] of [
      ["get_chat_session", { id }],
      ["append_chat_events", { id, events: [message("x", "user", "hi")] }],
      ["delete_chat_session", { id }],
      ["create_chat_session", { id, kind: "earn" }],
    ]) {
      const r = await call(other, tool, args);
      assert.equal(r.error, true, `${tool} refused`);
      assert.match(r.body.error, /No chat session of yours/);
    }
    assert.deepEqual((await call(other, "list_chat_sessions")).body.sessions, []);
  }
  // A workspace the user isn't in is refused.
  const ws = await call(alice, "create_chat_session", { id: randomUUID(), kind: "product", workspace_id: randomUUID() });
  assert.match(ws.body.error, /aren't a member/);
  assert.equal((await call(alice, "get_chat_session", { id })).body.events.length, 1);
  assert.equal((await call(alice, "delete_chat_session", { id })).error, false);
  assert.equal((await call(alice, "get_chat_session", { id })).error, true);
  const { rows } = await store.db.query("SELECT count(*)::int AS n FROM financial_products.chat_events WHERE session_id = $1", [id]);
  assert.equal(rows[0].n, 0, "its events go with it");
});

test("the list is the user's own, newest first, by kind, without events, and searches titles and messages", async () => {
  const store = await openStore();
  const dev = await connect(store, (await store.createUser("Dev", ["developer"])).user);
  const p1 = randomUUID(), p2 = randomUUID(), e1 = randomUUID();
  await call(dev, "create_chat_session", { id: p1, kind: "product", title: "Rent splitter" });
  await call(dev, "create_chat_session", { id: e1, kind: "earn", title: "Earn on $500" });
  await call(dev, "create_chat_session", { id: p2, kind: "product", title: "Trip kitty" });
  await call(dev, "append_chat_events", { id: p1, events: [message("u1", "user", "Roommates share the electricity bill every month")] });
  const all = (await call(dev, "list_chat_sessions")).body.sessions;
  assert.deepEqual(all.map((s) => s.id), [p1, p2, e1]);
  assert.ok(all.every((s) => !("events" in s) && !("messages" in s)));
  assert.deepEqual((await call(dev, "list_chat_sessions", { kind: "product" })).body.sessions.map((s) => s.id), [p1, p2]);
  assert.deepEqual((await call(dev, "list_chat_sessions", { kind: "earn" })).body.sessions.map((s) => s.id), [e1]);
  const found = (await call(dev, "list_chat_sessions", { kind: "product", query: "electricity BILL" })).body.sessions;
  assert.deepEqual(found.map((s) => s.id), [p1]);
  assert.match(found[0].snippet, /electricity bill/);
  assert.deepEqual((await call(dev, "list_chat_sessions", { query: "kitty" })).body.sessions.map((s) => s.id), [p2]);
  assert.equal((await call(dev, "list_chat_sessions", { kind: "other" })).error, true);
});

test("size limits: one event, one session; past the per-kind cap the oldest sessions go", async () => {
  const store = await openStore();
  const { user } = await store.createUser("Dev", ["developer"]);
  const dev = await connect(store, user);
  const id = randomUUID();
  await call(dev, "create_chat_session", { id, kind: "product" });
  const big = await call(dev, "append_chat_events", { id, events: [{ type: "message", role: "user", payload: { id: "u", parts: [{ type: "text", text: "x".repeat(MAX_EVENT_BYTES) }] } }] });
  assert.equal(big.error, true);
  assert.match(big.body.error, /at most 128 KB/);
  // Just under the per-event cap, until the session's cap is reached.
  const chunk = (i) => ({ type: "message", role: "user", payload: { id: `u${i}`, parts: [{ type: "text", text: "y".repeat(MAX_EVENT_BYTES - 200) }] } });
  let refused = null;
  for (let i = 0; i < 20 && !refused; i++) {
    const r = await call(dev, "append_chat_events", { id, events: [chunk(i)] });
    if (r.error) refused = r.body.error;
  }
  assert.match(refused, /too long to keep \(1 MB at most\)/);
  const s = (await call(dev, "get_chat_session", { id })).body.session;
  assert.ok(s.bytes <= MAX_SESSION_BYTES);

  // The cap per kind: the oldest go, another kind's are kept.
  const earn = randomUUID();
  await createChatSession(store.db, user.id, { id: earn, kind: "earn" });
  const ids = [];
  for (let i = 0; i < MAX_SESSIONS_PER_KIND + 2; i++) {
    const sid = randomUUID();
    ids.push(sid);
    await createChatSession(store.db, user.id, { id: sid, kind: "product" });
  }
  const left = await listChatSessions(store.db, user.id, { kind: "product", limit: 200 });
  assert.equal(left.length, MAX_SESSIONS_PER_KIND);
  assert.ok(!left.some((x) => x.id === id), "the oldest went first");
  assert.ok(left.some((x) => x.id === ids.at(-1)));
  assert.equal((await listChatSessions(store.db, user.id, { kind: "earn" })).length, 1);
});

test("the audit log says a session was created, added to and deleted, never what was said", async () => {
  const store = await openStore();
  const dev = await connect(store, (await store.createUser("Dev", ["developer"])).user);
  const id = randomUUID();
  await call(dev, "create_chat_session", { id, kind: "product", title: "Secret plan title" });
  await call(dev, "append_chat_events", { id, events: [message("u1", "user", "my very private words"), { type: "title", payload: { title: "Another secret title" } }] });
  await call(dev, "delete_chat_session", { id });
  const { rows } = await store.db.query("SELECT action, target, details FROM financial_products.audit_log WHERE target = $1 ORDER BY created_at", [id]);
  assert.deepEqual(rows.map((r) => r.action), ["create_chat_session", "append_chat_events", "delete_chat_session"]);
  const text = JSON.stringify(rows);
  for (const said of ["private words", "Secret plan", "Another secret"]) assert.ok(!text.includes(said), `no "${said}" in the audit log`);
  assert.equal(rows[1].details.events, 2);
});
