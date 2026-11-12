import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BdService, bdConfigFromEnv, withinWorkingHours } from "../dist/bd.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const A = "/home/user/mynt-agent";
// A Monday, 11:00 in India.
const MONDAY_IST = new Date("2026-11-02T05:30:00Z");

function fakeSandboxHost() {
  const sandboxes = new Map();
  let n = 0;
  return {
    sandboxes,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), running: false, stopped: false });
      return { id, state: "provisioning" };
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
    async exec(id, command) {
      if (command.includes("runner.mjs")) sandboxes.get(id).running = true;
      return { processId: 99, exitCode: null, stdout: "", stderr: "" };
    },
    async commandStatus(id) {
      return { running: sandboxes.get(id).running, exitCode: 0 };
    },
    async costDollars() {
      return 0.01;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
  };
}

async function setup({ senders = {}, config = {}, sandboxes = fakeSandboxHost() } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const clock = { now: MONDAY_IST };
  const host = { agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, model: "claude-opus-5-5", publicUrl: "https://mynt.example.com" };
  const bd = await BdService.open(db, sandboxes, { ...bdConfigFromEnv(host, { BD_ENABLED: "1" }), ...config }, senders, () => clock.now);
  const connect = async (user, ctx = {}) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { bd, ...ctx }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: res.isError ?? false, data };
  };
  return { db, pg, store, bd, sandboxes, clock, connect, call };
}

const prospect = (bd, over = {}) =>
  bd.addProspect({
    kind: "innovator",
    name: "Asha Rao",
    org: "Sunrise Distributors",
    source: "regulator_register",
    source_url: "https://example.org/register",
    contacts: [{ channel: "email", address: "Asha@Sunrise.example", consent: "public_business" }],
    ...over,
  });

test("working hours are weekdays 09:00 to 19:00 where the person is", () => {
  assert.equal(withinWorkingHours("IN", MONDAY_IST), true);
  assert.equal(withinWorkingHours("IN", new Date("2026-11-02T14:00:00Z")), false, "19:30 IST");
  assert.equal(withinWorkingHours("IN", new Date("2026-11-01T05:30:00Z")), false, "Sunday");
  assert.equal(withinWorkingHours("US", MONDAY_IST), false, "00:30 in New York");
});

test("a first email needs a published business address or a referral, and says who's writing with an opt-out", async () => {
  const sent = [];
  const { bd } = await setup({ senders: { email: { send: async (m) => (sent.push(m), { id: "prov_1" }) } } });
  const { id } = await prospect(bd);
  const r = await bd.send(id, "email", { subject: "Mynt for distributors", body: "Hi Asha, a quick idea for Sunrise." });
  assert.equal(r.status, "sent");
  assert.equal(sent[0].to, "asha@sunrise.example", "addresses are normalised");
  assert.match(sent[0].text, /AI agent working for Mynt/);
  assert.match(sent[0].text, /https:\/\/mynt\.example\.com\/bd\/unsubscribe\?c=/);
  assert.match(sent[0].headers["List-Unsubscribe"], /^<https:\/\/mynt\.example\.com\/bd\/unsubscribe/);
  assert.equal((await bd.prospect(id)).stage, "contacted");

  const none = await bd.addProspect({ kind: "developer", name: "Dev", source: "github", contacts: [{ channel: "email", address: "dev@x.example", consent: "none" }] });
  await assert.rejects(bd.send(none.id, "email", { subject: "Hi", body: "Hello" }), /No basis to email/);
  await assert.rejects(bd.send(id, "email", { body: "No subject" }), /needs a subject/);
});

test("WhatsApp and calls only after the person opts in, recorded on the same person", async () => {
  const { bd } = await setup();
  const { id } = await prospect(bd, { contacts: [{ channel: "email", address: "asha@sunrise.example", consent: "public_business" }, { channel: "whatsapp", address: "+91 98765 43210", consent: "public_business" }] });
  await assert.rejects(bd.send(id, "whatsapp", { body: "Hi" }), /needs Asha Rao's opt-in/);
  await bd.send(id, "email", { subject: "Hello", body: "Would WhatsApp suit you?" });
  await bd.receive("email", "asha@sunrise.example", { body: "Sure, WhatsApp me on +91 98765 43210" });
  await bd.recordConsent(id, "whatsapp", "+919876543210", "opted_in", "message x");
  const r = await bd.send(id, "whatsapp", { body: "Hi Asha, it's Mynt's connector." });
  assert.equal(r.status, "draft", "no WhatsApp provider yet: kept as a draft");
  assert.match(r.note, /isn't connected yet/);
  assert.equal((await bd.prospect(id)).contacts.length, 2, "still one person, with two contacts");
});

test("follow-ups stop after a few unanswered messages, spaced days apart; replies reset that", async () => {
  const { bd, clock } = await setup();
  const { id } = await prospect(bd);
  await bd.send(id, "email", { subject: "1", body: "First" });
  await assert.rejects(bd.send(id, "email", { subject: "2", body: "Too soon" }), /Wait at least 3 days/);
  clock.now = new Date(MONDAY_IST.getTime() + 3 * 86400e3);
  await bd.send(id, "email", { subject: "2", body: "Second" });
  clock.now = new Date(MONDAY_IST.getTime() + 7 * 86400e3);
  await bd.send(id, "email", { subject: "3", body: "Third" });
  clock.now = new Date(MONDAY_IST.getTime() + 14 * 86400e3);
  await assert.rejects(bd.send(id, "email", { subject: "4", body: "Fourth" }), /hasn't replied to 3 messages/);
  await bd.receive("email", "asha@sunrise.example", { body: "Tell me more" });
  assert.equal((await bd.send(id, "email", { subject: "Re", body: "Gladly" })).status, "draft", "a reply can be answered");
  assert.equal((await bd.prospect(id)).stage, "engaged");
});

test("quiet hours and the daily cap hold", async () => {
  const { bd, clock } = await setup({ config: { dailyCap: 2 } });
  const ids = [];
  for (const i of [1, 2, 3]) ids.push((await prospect(bd, { name: `P${i}`, contacts: [{ channel: "email", address: `p${i}@firm.example`, consent: "public_business" }] })).id);
  clock.now = new Date("2026-11-02T15:00:00Z");
  await assert.rejects(bd.send(ids[0], "email", { subject: "Hi", body: "Late" }), /Outside working hours in IN/);
  clock.now = MONDAY_IST;
  await bd.send(ids[0], "email", { subject: "Hi", body: "One" });
  await bd.send(ids[1], "email", { subject: "Hi", body: "Two" });
  await assert.rejects(bd.send(ids[2], "email", { subject: "Hi", body: "Three" }), /cap of 2 messages/);
});

test("STOP, the unsubscribe link and suppression end contact for good", async () => {
  const { bd } = await setup();
  const { id } = await prospect(bd);
  const draft = (await bd.prospect(id)).contacts[0];
  const url = new URL(await bd.unsubscribeUrl(draft.id));
  assert.equal(await bd.unsubscribe(draft.id, "forged"), false);
  assert.equal(await bd.unsubscribe(url.searchParams.get("c"), url.searchParams.get("s")), true);
  assert.equal((await bd.prospect(id)).stage, "suppressed");
  await assert.rejects(bd.send(id, "email", { subject: "Hi", body: "Again?" }), /opted out/);
  await assert.rejects(prospect(bd, { name: "Asha again" }), /opted out of contact/, "can't be re-added under another name");

  const other = await prospect(bd, { name: "Ravi", contacts: [{ channel: "email", address: "ravi@firm.example", consent: "public_business" }] });
  await bd.send(other.id, "email", { subject: "Hi", body: "Hello" });
  await bd.receive("email", "RAVI@firm.example", { body: "STOP" });
  assert.equal((await bd.prospect(other.id)).stage, "suppressed");
  assert.equal(await bd.suppressed("email", "ravi@firm.example"), true);
});

test("an introduction is made only once both people said yes, and then shares each with the other", async () => {
  const { bd } = await setup();
  const a = await prospect(bd);
  const b = await prospect(bd, { kind: "developer", name: "Dev Kumar", org: "Buildco", source: "github", source_url: "https://github.com/dev", contacts: [{ channel: "email", address: "dev@buildco.example", consent: "public_business" }] });
  const intro = await bd.proposeIntro(a.id, b.id, "Sunrise wants a savings app; Dev builds them");
  await assert.rejects(bd.makeIntro(intro, "You two should talk about a savings app.", null), /Both people must agree/);
  assert.equal(await bd.introConsent(intro, a.id, true), "proposed");
  assert.equal(await bd.introConsent(intro, b.id, true), "agreed");
  await bd.makeIntro(intro, "You two should talk about a savings app.", null);
  const toA = (await bd.prospect(a.id)).messages.at(-1);
  assert.match(toA.body, /Meet Dev Kumar, Buildco <dev@buildco.example>/);
  assert.match((await bd.prospect(b.id)).messages.at(-1).body, /Meet Asha Rao, Sunrise Distributors <asha@sunrise.example>/);
  const declined = await bd.proposeIntro(a.id, b.id, "Another reason entirely");
  assert.equal(await bd.introConsent(declined, b.id, false), "declined");
});

test("an agent run sees only its own tools; people get connect tools; admins oversee and pause", async () => {
  const { store, bd, connect, call } = await setup();
  const agent = await connect(null, { bdRun: { id: "00000000-0000-0000-0000-000000000001" } });
  const agentTools = (await agent.listTools()).tools.map((t) => t.name);
  assert.ok(agentTools.includes("bd_send") && agentTools.includes("bd_add_prospect") && agentTools.includes("list_products"));
  assert.ok(!agentTools.some((t) => t.startsWith("connect_") || t === "bd_pause" || t === "define_region"), "no person's or admin's tools");

  const added = (await call(agent, "bd_add_prospect", { kind: "innovator", name: "Meera", source: "company_site", contacts: [{ channel: "email", address: "meera@amc.example", consent: "public_business" }] })).data;
  assert.match(added.error, /source_url/, "published contacts must say where");

  const { user } = await store.createUser("Ana", ["developer"]);
  user.email = "ana@builders.example";
  const person = await connect(user);
  const r = (await call(person, "connect_with_mynt", { kind: "developer", about: "I build fintech apps for savers", looking_for: "A deposits issuer to build on", whatsapp: "+91 90000 00000" })).data;
  assert.equal(r.received, true);
  const me = await bd.prospectForUser(user.id);
  const full = await bd.prospect(me.id);
  assert.deepEqual(full.contacts.map((c) => [c.channel, c.consent]).sort(), [["email", "opted_in"], ["whatsapp", "opted_in"]]);
  assert.equal((await bd.inbox()).length, 1, "their note waits for the agent");
  const ref = (await call(person, "connect_refer", { kind: "innovator", name: "Kiran", email: "kiran@nbfc.example", why: "Runs an NBFC with a great FD" })).data;
  assert.equal(ref.referred, true);
  assert.match((await bd.prospect(ref.prospect)).notes, /don't name them/);

  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const admin = await connect(adminUser);
  assert.equal((await call(admin, "bd_pause", { paused: true, reason: "Reviewing copy" })).data.paused, true);
  const sent = await call(agent, "bd_send", { prospect_id: me.id, channel: "email", subject: "Hi", body: "Hello" });
  assert.match(sent.data.error, /paused by an admin/);
  assert.equal((await call(admin, "bd_overview")).data.paused, true);
});

test("runs: the agent gets Mynt's MCP server and the proxy with one run token, which dies with the run", async () => {
  const { bd, sandboxes, clock } = await setup();
  await bd.tick();
  const [sbx] = [...sandboxes.sandboxes.keys()];
  sandboxes.sandboxes.get(sbx).state = "ready";
  await bd.tick();
  const files = sandboxes.sandboxes.get(sbx).files;
  const auth = JSON.parse(files.get(`${A}/auth.json`));
  assert.deepEqual(auth.mcp, { url: "https://mynt.example.com/mcp", token: auth.token });
  assert.match(auth.token, /^mynt_bd_/);
  assert.match(files.get("/home/user/workspaces/connector/CLAUDE.md"), /You are Mynt's connector/);
  assert.ok(files.has("/home/user/workspaces/connector/.claude/skills/replies-and-consent/SKILL.md"));
  assert.equal(JSON.parse(files.get(`${A}/config.json`)).cwd, "/home/user/workspaces/connector");
  assert.equal(await bd.agentTokenActive(auth.token), true);

  sandboxes.sandboxes.get(sbx).running = false;
  files.set(`${A}/state.json`, JSON.stringify({ done: true, last_subtype: "success", cost_usd: 1.2, summary: "Contacted 5 distributors" }));
  await bd.tick();
  const [run] = await bd.runs();
  assert.equal(run.status, "finished");
  assert.equal(run.summary, "Contacted 5 distributors");
  assert.ok(Number(run.cost_usd) > 1.2);
  assert.equal(await bd.agentTokenActive(auth.token), false);
  assert.ok(sandboxes.sandboxes.get(sbx).stopped);

  await bd.tick();
  assert.equal(sandboxes.sandboxes.size, 1, "not due again for hours");
  clock.now = new Date(MONDAY_IST.getTime() + 7 * 3600e3);
  await bd.requestRun();
  await bd.tick();
  assert.equal(sandboxes.sandboxes.size, 2, "an admin or a new reply can ask for a run sooner");
});

test("the connector stays off unless enabled", async () => {
  const { bd, sandboxes } = await setup({ config: { enabled: false } });
  await bd.tick();
  assert.equal(sandboxes.sandboxes.size, 0);
  assert.equal(bd.runnable, false);
});

test("over HTTP: a run token gets the agent's MCP tools, a dead one 401, and unsubscribe links work", async () => {
  const { createMcpHttpServer } = await import("../dist/http.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { store, bd, sandboxes } = await setup();
  await bd.tick();
  const [sbx] = [...sandboxes.sandboxes.keys()];
  sandboxes.sandboxes.get(sbx).state = "ready";
  await bd.tick();
  const { token } = JSON.parse(sandboxes.sandboxes.get(sbx).files.get(`${A}/auth.json`));
  const http = createMcpHttpServer(store, null, { bd });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  try {
    const client = new Client({ name: "agent", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("bd_brief") && !tools.includes("bd_pause"));
    await client.close();

    const dead = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer mynt_bd_nope", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(dead.status, 401);

    const { id } = await prospect(bd);
    const link = new URL(await bd.unsubscribeUrl((await bd.prospect(id)).contacts[0].id));
    const page = await fetch(`${base}${link.pathname}${link.search}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /won't hear from Mynt's connector again/);
    assert.equal((await fetch(`${base}/bd/unsubscribe?c=x&s=y`)).status, 400);
  } finally {
    http.close();
  }
});

test("consent is a per-purpose ledger: what's allowed, on what basis, and every grant and withdrawal", async () => {
  const { bd, pg } = await setup();
  const { id } = await prospect(bd);
  const c = await bd.consents(id);
  assert.equal(c.contact_email.basis, "public_business");
  assert.equal(c.profile.basis, "publicly_available");
  const row = (await pg.query("SELECT legal_basis, retain_until FROM financial_products.bd_prospects WHERE id = $1", [id])).rows[0];
  assert.equal(row.legal_basis, "publicly_available");
  assert.ok(row.retain_until, "a public-source profile has a retention limit");
  assert.deepEqual(await bd.checkConsent(id, "contact_email"), { allowed: true, basis: "public_business", reason: "Basis: public_business" });
  assert.equal((await bd.checkConsent(id, "contact_whatsapp")).allowed, false);
  assert.match((await bd.checkConsent(id, "introductions")).reason, /Ask them/);

  await bd.recordConsent(id, "whatsapp", "+91 98765 43210", "opted_in", "message m1");
  assert.deepEqual(await bd.checkConsent(id, "contact_whatsapp"), { allowed: true, basis: "consent", reason: "They agreed" });
  await bd.optOut(id, "replied STOP");
  for (const purpose of ["contact_email", "contact_whatsapp", "introductions"]) {
    assert.equal((await bd.checkConsent(id, purpose)).allowed, false, purpose);
  }
  const history = (await bd.prospect(id)).consents.filter((x) => x.purpose === "contact_whatsapp").map((x) => x.granted);
  assert.deepEqual(history, [true, false], "the ledger keeps the grant and the withdrawal");
});

test("an introduction answer is recorded as consent", async () => {
  const { bd } = await setup();
  const a = await prospect(bd);
  const b = await prospect(bd, { name: "Dev", kind: "developer", source: "github", source_url: "https://github.com/dev", contacts: [{ channel: "email", address: "dev@x.example", consent: "public_business" }] });
  const intro = await bd.proposeIntro(a.id, b.id, "They should build a savings app together");
  await bd.introConsent(intro, a.id, true);
  assert.equal((await bd.checkConsent(a.id, "introductions")).allowed, true);
  await bd.introConsent(intro, b.id, false);
  assert.match((await bd.checkConsent(b.id, "introductions")).reason, /withdrew/);
});

test("erasure deletes a person's data, keeps only hashes, and keeps them from being contacted again", async () => {
  const { bd, pg } = await setup();
  const { id } = await prospect(bd);
  await bd.send(id, "email", { subject: "Hi", body: "Hello there" });
  assert.equal(await bd.erase(id, "asked to be forgotten", "admin"), true);
  assert.equal(await bd.prospect(id), null);
  for (const t of ["bd_messages", "bd_contacts", "bd_consents"]) {
    assert.equal((await pg.query(`SELECT count(*)::int AS n FROM financial_products.${t} WHERE prospect_id = $1`, [id])).rows[0].n, 0, t);
  }
  const erasure = (await pg.query("SELECT * FROM financial_products.bd_erasures")).rows[0];
  assert.ok(erasure.suppressed && erasure.address_hashes.length === 1);
  assert.ok(!JSON.stringify(erasure).includes("sunrise"), "no personal data in the erasure record");
  await assert.rejects(prospect(bd), /opted out of contact/);
});

test("public-source profiles of people who never replied are erased after the retention period, without suppressing them", async () => {
  const { bd, clock } = await setup({ config: { profileRetentionDays: 30 } });
  const quiet = await prospect(bd, { name: "Quiet", contacts: [{ channel: "email", address: "quiet@firm.example", consent: "public_business" }] });
  const replied = await prospect(bd, { name: "Replied", contacts: [{ channel: "email", address: "replied@firm.example", consent: "public_business" }] });
  await bd.send(replied.id, "email", { subject: "Hi", body: "Hello" });
  await bd.receive("email", "replied@firm.example", { body: "Interested" });
  clock.now = new Date(MONDAY_IST.getTime() + 31 * 86400e3);
  assert.equal(await bd.sweepRetention(), 1);
  assert.equal(await bd.prospect(quiet.id), null);
  assert.ok(await bd.prospect(replied.id), "someone who replied is kept");
  assert.equal(await bd.suppressed("email", "quiet@firm.example"), false, "retention isn't an opt-out");
});

test("people can have the connector forget them; the agent erases on request only with their message as evidence", async () => {
  const { store, bd, connect, call } = await setup();
  const { user } = await store.createUser("Ana", ["consumer"]);
  user.email = "ana@builders.example";
  const person = await connect(user);
  await call(person, "connect_with_mynt", { kind: "developer", about: "I build fintech apps for savers", looking_for: "A deposits issuer" });
  assert.equal((await call(person, "connect_forget_me", { confirm: true })).data.erased, true);
  assert.equal(await bd.prospectForUser(user.id), undefined);
  assert.equal(await bd.suppressed("email", "ana@builders.example"), true);

  const agent = await connect(null, { bdRun: { id: "00000000-0000-0000-0000-000000000001" } });
  const { id } = await prospect(bd);
  await bd.send(id, "email", { subject: "Hi", body: "Hello" });
  const sent = (await bd.prospect(id)).messages[0].id;
  assert.match((await call(agent, "bd_erase_on_request", { prospect_id: id, evidence_message_id: sent })).data.error, /message this person sent/);
  const asked = await bd.receive("email", "asha@sunrise.example", { body: "Please delete my data" });
  assert.equal((await call(agent, "bd_erase_on_request", { prospect_id: id, evidence_message_id: asked })).data.erased, true);
  assert.equal((await call(agent, "bd_check_consent", { prospect_id: id, purpose: "contact_email" })).data.allowed, false);
});

test("a provider's passing 5xx doesn't fail a connector run; a persistent one, quota exhaustion or a real error does", async () => {
  const { bd, sandboxes, clock } = await setup();
  const real = sandboxes.getSandbox;
  const failWith = (msg) => {
    sandboxes.getSandbox = async () => {
      throw new Error(msg);
    };
  };
  const heal = () => {
    sandboxes.getSandbox = real;
  };
  const outage = 'sandboxes GET /sandboxes/sbx: 503 {"code":"INTERNAL_ERROR"}';
  const latest = async () => (await bd.runs())[0];
  const start = async () => {
    clock.now = new Date(clock.now.getTime() + 60e3); // runs are ordered by their start
    await bd.requestRun();
    await bd.tick(); // sandbox requested
    return latest();
  };

  // A passing outage: the run rides it out and carries on.
  const a = await start();
  failWith(outage);
  await bd.tick();
  await bd.tick();
  assert.equal((await latest()).status, a.status, "a passing outage is ridden out");
  heal();
  sandboxes.sandboxes.get([...sandboxes.sandboxes.keys()].at(-1)).state = "ready";
  await bd.tick();
  assert.notEqual((await latest()).status, "failed");
  assert.notEqual((await latest()).status, a.status, "the run carried on");
  await bd.stopRuns("done with it");

  // An outage that outlasts the grace period fails the run, with the provider's error.
  const grace = BdService.TRANSIENT_GRACE_MS;
  BdService.TRANSIENT_GRACE_MS = 30;
  const b = await start();
  failWith(outage);
  await bd.tick();
  assert.equal((await latest()).status, b.status);
  await new Promise((r) => setTimeout(r, 50));
  await bd.tick();
  BdService.TRANSIENT_GRACE_MS = grace;
  heal();
  assert.equal((await latest()).status, "failed", "an outage past the grace fails the run");
  assert.match((await latest()).error, /503/);

  // A provider out of allowance fails at once, saying what to do.
  await start();
  failWith("sandboxes: LIMIT_EXCEEDED: allowance for sandboxes has been used");
  await bd.tick();
  heal();
  assert.equal((await latest()).status, "failed", "quota exhaustion fails at once");
  assert.match((await latest()).error, /add billing/);

  // Any other error fails at once.
  await start();
  failWith("sandboxes GET /sandboxes/sbx: 400 bad request");
  await bd.tick();
  heal();
  assert.equal((await latest()).status, "failed", "a real error fails at once");
  assert.match((await latest()).error, /400/);
});
