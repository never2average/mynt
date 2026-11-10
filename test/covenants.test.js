import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Licence providers' covenants: each rule type, unknown never reading as pass or breach, the timer that fires with no
// snapshot at all, pauses that hold until released, sandbox figures that can't pause, cooldowns, and who may touch what.

process.env.MYNT_VAULT_KEY = randomBytes(32).toString("base64");
// These tests' licence-provider accounts are minutes old: the partner kit's member cool-off (tested on its own in
// partner-kit.test.js) is off here, so they can register keys straight away.
process.env.PARTNER_MEMBER_COOLOFF_HOURS ??= "0";

const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { opsStatus } = await import("../dist/ops.js");
const { deliverDueWebhooks } = await import("../dist/runtime.js");
const { ProductHealthService } = await import("../dist/product-health.js");
const { CovenantService, judgeFigure, reassertCovenantPause } = await import("../dist/covenants.js");
const { driftSweep } = await import("../dist/pins.js");
const { CATALOG } = await import("./helpers.js");
const { base58Encode } = await import("../dist/solana/codec.js");
const chainLib = await import("../dist/solana/product-health-chain.js");

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const flowsWith = (amounts = {}, unresolved = 0) => {
  const dir = { requested: { amount_cents: 0 }, submitted: { amount_cents: 0 }, settled: { amount_cents: amounts.settled ?? 9000 }, failed: { amount_cents: amounts.failed ?? 0 }, reversed: { amount_cents: amounts.reversed ?? 0 } };
  return { measured: true, flows: { on_ramp: dir, off_ramp: dir, payout: dir, deposit: dir }, unresolved: { on_ramp: { amount_cents: unresolved }, off_ramp: { amount_cents: 0 }, payout: { amount_cents: 0 }, deposit: { amount_cents: 0 } }, not_measured: {} };
};

async function setup({ kind = "live", books = { reserves: 150_00, owed: 100_00 }, flows, config = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  let clock = T0 + 5 * 60_000;
  const now = () => new Date(clock);
  const state = { books, flows, kind };
  const ledger = { id: "fake", name: "A fake ledger", get kind() { return state.kind; }, read: async (c) => (state.books ? { reserves_held_cents: state.books.reserves, customer_obligations_cents: state.books.owed, as_of: c.period_end } : { error: { code: "down", message: "down" } }) };
  const health = await ProductHealthService.open(db, store, { intervalMs: HOUR, cosignWindowMs: 10 * 60_000, pollMs: 60_000, programId: null, ...config }, { chain: null, ledgerFor: () => ledger, flowsFor: state.flows === undefined ? null : async () => state.flows, now });
  const covenants = await CovenantService.open(db, store, health, { pollMs: 1000 }, { now });
  const [published] = await store.publishedProducts();
  const productId = published.id;
  await pg.query("UPDATE financial_products.products SET published_at = $2 WHERE id = $1", [productId, new Date(T0 - 7 * 24 * HOUR)]);
  await store.setPins(productId, { version: 1, pinned_at: new Date().toISOString(), components: [], parties: [], entity_ids: [], state: { entities: {}, licences: {}, parties: {} } });
  const firm = async (name, roles) => {
    const entity = await store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });
    const { user } = await store.createUser(`${name} person`, roles);
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    return { entity, user };
  };
  const provider = await firm("Partner Bank", ["license_provider"]);
  const builder = await firm("Builder Co", ["innovator"]);
  const stranger = await firm("Other Bank", ["license_provider"]);
  const { user: admin } = await store.createUser("Ada", ["admin"]);
  let sponsorships = 0;
  const sponsor = async (who) => {
    const s = await store.requestSponsorship(builder.user.id, { product_id: productId, component_key: "core", builder_entity_id: builder.entity.id, provider_entity_id: who.entity.id, requested_jurisdictions: [], note: null });
    const approved = await store.decideSponsorship(s.id, { status: "approved", decided_by: who.user.id, note: null });
    // Before this test's clock, and in order: the earliest-approved sponsor supplies the books.
    await pg.query("UPDATE financial_products.sponsorships SET decided_at = $2 WHERE id = $1", [s.id, new Date(T0 - 7 * 24 * HOUR + 60_000 * sponsorships++)]);
    return approved;
  };
  const sponsorship = await sponsor(provider);
  const tool = async (user, name, args = {}) => {
    const [c, srv] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { productHealth: health, covenants }).connect(srv);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text }; // the tool's input schema refused it
    }
    return { isError: res.isError ?? false, data };
  };
  const set = (u, args) => tool(u, "set_covenant", { sponsorship_id: sponsorship.id, ...args });
  const ok = async (p) => {
    const r = await p;
    assert.equal(r.isError, false, JSON.stringify(r.data));
    return r.data;
  };
  const raw = async (sql, params) => (await pg.query(sql, params)).rows;
  // A health snapshot for the next hour, then whatever the covenants made of it.
  const tickHour = async (h) => {
    clock = T0 + h * HOUR + 5 * 60_000;
    await health.tick();
  };
  const webhooks = async (type) => (await raw("SELECT type, sandbox, payload FROM financial_products.webhook_deliveries ORDER BY created_at")).filter((d) => !type || d.type === type);
  const listen = () => store.createFirmWebhook(provider.user.id, { entity_id: provider.entity.id, url: "https://hooks.example.com/mynt", events: ["covenant.breached", "covenant.cleared"] });
  return { pg, db, store, health, covenants, productId, provider, builder, stranger, admin, firm, sponsor, sponsorship, tool, set, ok, raw, state, tickHour, webhooks, listen, setClock: (t) => (clock = t), now: () => clock };
}

const breaches = (t) => t.ok(t.tool(t.provider.user, "list_covenant_breaches", {}));
const covenantsOf = (t) => t.ok(t.tool(t.provider.user, "list_covenants", {}));
const drift = async (t) => (await t.store.getProduct(t.productId)).drift;

test("judging one figure: null is unknown with its reason, partial can't pass, and a partial total over the limit is real", () => {
  assert.deepEqual(judgeFigure("coverage_below", 10_000, { value: null, reason: "not measured" }), { status: "unknown", observed: null, reason: "not measured" });
  assert.equal(judgeFigure("coverage_below", 10_000, { value: 9_999, reason: null }).status, "fail");
  assert.equal(judgeFigure("coverage_below", 10_000, { value: 10_000, reason: null }).status, "pass");
  assert.equal(judgeFigure("failure_rate_above", 100, { value: 101, reason: null }).status, "fail");
  assert.equal(judgeFigure("failure_rate_above", 100, { value: 100, reason: null }).status, "pass");
  assert.equal(judgeFigure("failure_rate_above", 100, { value: 500, reason: "part", partial: true }).status, "unknown", "a partial rate proves nothing either way");
  assert.equal(judgeFigure("unresolved_above", 100, { value: 500, reason: "part", partial: true }).status, "fail", "a partial total only understates");
  assert.equal(judgeFigure("unresolved_above", 100, { value: 50, reason: "part", partial: true }).status, "unknown", "under the limit on part of the total isn't a pass");
  assert.equal(judgeFigure("complaints_above", 3, { value: null, reason: "Complaints aren't tracked on Mynt yet" }).status, "unknown");
});

test("coverage_below breaches on the snapshot, with the observed value and the snapshot it came from", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  assert.equal(b.rule_type, "coverage_below");
  assert.equal(b.observed, 8_000);
  assert.equal(b.threshold, 10_000);
  assert.equal(b.unit, "bps");
  assert.equal(b.status, "open");
  assert.equal(b.action_taken, "alerted");
  assert.equal(b.snapshot.sequence, 1);
  assert.match(b.snapshot.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await covenantsOf(t))[0].status, "fail");
  assert.equal(await drift(t), null, "an alert doesn't pause");
});

test("reversal_rate_above, failure_rate_above and unresolved_above each breach on the flows", async () => {
  for (const [rule, amounts, unresolved, threshold] of [
    ["reversal_rate_above", { settled: 9000, reversed: 1000 }, 0, 500],
    ["failure_rate_above", { settled: 9000, failed: 1000 }, 0, 500],
    ["unresolved_above", {}, 2_500, 1_000],
  ]) {
    const t = await setup({ flows: flowsWith(amounts, unresolved) });
    await t.ok(t.set(t.provider.user, { rule_type: rule, threshold, action: "alert" }));
    await t.tickHour(0);
    const [b] = await breaches(t);
    assert.equal(b?.rule_type, rule);
    assert.equal(b.status, "open");
    assert.ok(b.observed > threshold, `${rule} observed ${b.observed}`);
  }
});

test("a null figure is unknown with its reason, never a pass or a breach, and unknown past its limit alerts", async () => {
  const t = await setup({ books: { reserves: 100_00, owed: 0 } }); // no obligations: coverage is undefined, not infinite
  await t.listen();
  const cov = await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause", unknown_limit_seconds: 3600 }));
  await t.tickHour(0);
  let [c] = await covenantsOf(t);
  assert.equal(c.status, "unknown");
  assert.match(c.status_reason, /obligations/);
  assert.deepEqual(await breaches(t), [], "unknown isn't a breach");
  assert.equal(await drift(t), null, "unknown doesn't pause");
  await t.tickHour(1);
  assert.deepEqual(await breaches(t), [], "still inside the limit");
  t.setClock(T0 + 2 * HOUR); // unknown for over an hour since it began, on the timer alone
  await t.covenants.tick();
  const [b] = await breaches(t);
  assert.equal(b.kind, "unknown_limit");
  assert.equal(b.status, "open");
  assert.equal(b.action, "pause");
  assert.equal(await drift(t), null, "unknown past its limit still alerts only: it never pauses");
  const [hook] = await t.webhooks("covenant.breached");
  assert.equal(hook.payload.data.kind, "unknown_limit");
  // Measurable again: the unknown is over, the alert record says so.
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(3);
  [c] = await covenantsOf(t);
  assert.equal(c.status, "pass");
  assert.equal(c.id, cov.id);
  assert.equal((await breaches(t))[0].status, "resolved");
});

test("complaints_above can be set and reads unknown, since Mynt doesn't track complaints yet", async () => {
  const t = await setup();
  const c = await t.ok(t.set(t.provider.user, { rule_type: "complaints_above", threshold: 5, action: "pause" }));
  assert.match(c.note, /doesn't track complaints/);
  await t.tickHour(0);
  assert.equal((await covenantsOf(t))[0].status, "unknown");
});

test("a sandbox or failed ledger read is unknown, and sandbox figures never pause a live product", async () => {
  // A published product whose sponsor's ledger is still the sandbox: its test figures can't speak for it, so the rule
  // is unknown (not a sandbox-labelled pass or fail), and the figures themselves pause nothing.
  const t = await setup({ kind: "sandbox", books: { reserves: 10_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [c] = await covenantsOf(t);
  assert.equal(c.status, "unknown");
  assert.equal(c.status_sandbox, false);
  assert.match(c.status_reason, /ledger isn't live/);
  assert.deepEqual(await breaches(t), []);
  assert.equal(await drift(t), null, "sandbox figures never pause");
  assert.deepEqual((await t.covenants.list(t.provider.user, {}))[0].pause_held_by_breach_ids, []);
  // A live ledger that fails has no figures at all: unknown, not a pass.
  const down = await setup({ books: null });
  await down.ok(down.set(down.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await down.tickHour(0);
  assert.equal((await covenantsOf(down))[0].status, "unknown");
  assert.equal(await drift(down), null);
});

test("snapshot_missed_for fires on the timer alone, with no snapshot and no health worker ever run", async () => {
  const t = await setup();
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "snapshot_missed_for", threshold: 3 * 3600, action: "pause" }));
  t.setClock(T0 + 5 * 60_000 + HOUR);
  await t.covenants.tick();
  assert.deepEqual(await breaches(t), [], "not late yet");
  assert.equal((await covenantsOf(t))[0].status, "pass");
  t.setClock(T0 + 5 * 60_000 + 4 * HOUR);
  await t.covenants.tick();
  const [b] = await breaches(t);
  assert.equal(b.rule_type, "snapshot_missed_for");
  assert.ok(b.observed > 3 * 3600);
  assert.equal(b.snapshot, null, "there is no snapshot to name");
  assert.equal(b.action_taken, "paused");
  assert.ok(await drift(t));
});

test("snapshot_missed_for fires after snapshots stop", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "snapshot_missed_for", threshold: 3 * 3600, action: "alert" }));
  await t.tickHour(0);
  assert.equal((await covenantsOf(t))[0].status, "pass");
  t.setClock(T0 + 5 * HOUR);
  await t.covenants.tick();
  assert.equal((await breaches(t))[0].rule_type, "snapshot_missed_for");
});

test("consecutive_gaps counts missed periods, including the stretch a stopped worker never wrote down", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "consecutive_gaps", threshold: 3, action: "alert" }));
  t.setClock(T0);
  await t.covenants.tick();
  assert.equal((await covenantsOf(t))[0].status, "unknown", "no record to count gaps in");
  await t.tickHour(0);
  assert.equal((await covenantsOf(t))[0].status, "pass");
  // Worker down: the next tick writes one long missed stretch, which is several periods, not one.
  t.setClock(T0 + 8 * HOUR + 5 * 60_000);
  await t.covenants.tick();
  const [b] = await breaches(t);
  assert.equal(b.rule_type, "consecutive_gaps");
  assert.ok(b.observed >= 3, `counted ${b.observed}`);
  assert.equal(b.unit, "periods");
});

test("unverified_for fires when a live product goes unsigned too long, and a partner signature clears it", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "unverified_for", threshold: 3 * 3600, action: "alert" }));
  await t.tickHour(0);
  await t.tickHour(1);
  assert.equal((await covenantsOf(t))[0].status, "pass", "not long enough yet");
  await t.tickHour(5);
  const [b] = await breaches(t);
  assert.equal(b.rule_type, "unverified_for");
  assert.equal(b.sandbox, false);
  // The partner co-signs the next snapshot: a valid signature ends the breach.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await t.health.registerSigningKey(t.provider.user, base58Encode(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")));
  await t.tickHour(6);
  const [row] = await t.raw("SELECT sequence, fingerprint FROM financial_products.product_health_snapshots ORDER BY sequence DESC LIMIT 1");
  await t.health.submitSignature(t.provider.user, t.productId, null, row.sequence, edSign(null, Buffer.from(chainLib.cosignMessage(Buffer.from(row.fingerprint, "hex"))), privateKey).toString("hex"));
  await t.covenants.tick();
  assert.equal((await covenantsOf(t))[0].status, "pass");
  assert.equal((await breaches(t))[0].status, "resolved");
});

test("alert and pause: an alert leaves sales open; a pause drifts the product with kind covenant, naming the rule", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const alertRule = await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 9_000, action: "alert" }));
  await t.tickHour(0);
  assert.equal(await drift(t), null);
  const pauseRule = await t.ok(t.set(t.provider.user, { covenant_id: alertRule.id, rule_type: "coverage_below", threshold: 9_000, action: "pause" }));
  assert.equal(pauseRule.version, 2);
  assert.equal(await drift(t), null, "takes effect from the next evaluation, not on save");
  await t.tickHour(1);
  const d = await drift(t);
  assert.equal(d.changes[0].kind, "covenant");
  assert.equal(d.changes[0].rule_type, "coverage_below");
  assert.equal(d.changes[0].id, alertRule.id);
  assert.doesNotMatch(JSON.stringify(d), /threshold|:\s*9000\b/, "the threshold isn't on the drift record");
  const [b] = await breaches(t);
  assert.ok(b.events.some((e) => e.event === "paused"), "pausing a breach that was already open is on its record");
  assert.ok(b.pause.paused_at);
});

test("a pause holds until released, survives the drift sweep and a new version, and is released only when the rule passes", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  assert.equal(b.action_taken, "paused");
  assert.ok(await drift(t));

  // The hourly drift sweep doesn't clear it.
  await driftSweep(t.store);
  assert.ok(await drift(t));
  // A new version doesn't either: only the sponsor lifts it.
  await t.store.setPins(t.productId, { version: 2, pinned_at: new Date().toISOString(), components: [], parties: [], entity_ids: [], state: { entities: {}, licences: {}, parties: {} } });
  assert.equal(await drift(t), null, "setPins clears drift");
  await reassertCovenantPause(t.store, t.productId);
  assert.ok(await drift(t), "the covenant's pause is written back");

  // The rule still fails: release is refused, with the reason it's refused.
  const refused = await t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /still failing/);
  assert.ok(await drift(t), "still paused");

  // The figures recover: the breach resolves, but the pause is still the sponsor's to lift.
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(1);
  assert.equal((await breaches(t))[0].status, "resolved");
  assert.ok(await drift(t), "the rule passing doesn't lift the pause by itself");
  const cleared = await t.webhooks("covenant.cleared");
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0].payload.data.hold_active, true);

  const released = await t.ok(t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id }));
  assert.equal(released.override, false);
  assert.equal(released.sales_paused, false);
  assert.equal(await drift(t), null);
  const audit = await t.raw("SELECT action, details FROM financial_products.audit_log WHERE action = 'release_covenant_pause'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.override, false);
  assert.ok((await breaches(t))[0].pause.released_at);
  await assert.rejects(t.covenants.release(t.provider.user, { breach_id: b.id }), /already been released/);
});

test("a release while the rule fails needs an override with a reason, which is recorded, and doesn't re-pause next round", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  const short = await t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id, override_reason: "short" });
  assert.equal(short.isError, true, "an override needs a real reason");
  const done = await t.ok(t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id, override_reason: "the shortfall was cured off-platform; we confirmed it" }));
  assert.equal(done.override, true);
  assert.equal(done.rule_status, "fail");
  assert.equal(await drift(t), null);
  const [view] = await breaches(t);
  assert.equal(view.pause.override, true);
  assert.equal(view.status, "open", "the breach is still open");
  await t.tickHour(1);
  assert.equal(await drift(t), null, "the override stands while this same breach is open");
  // A later relapse is a new breach and pauses again.
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(2);
  t.state.books = { reserves: 80_00, owed: 100_00 };
  await t.tickHour(3);
  assert.ok(await drift(t), "a new breach pauses again");
});

test("an unknown rule can't be released without an override: not knowing isn't passing", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  t.state.books = { reserves: 100_00, owed: 0 }; // coverage undefined
  await t.tickHour(1);
  assert.equal((await covenantsOf(t))[0].status, "unknown");
  const refused = await t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /can't be evaluated/);
});

test("cooldown: a flapping rule records every breach but doesn't re-alert, and a pause never waits for it", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert", cooldown_seconds: 6 * 3600 }));
  await t.tickHour(0);
  assert.equal((await t.webhooks("covenant.breached")).length, 1);
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(1);
  t.state.books = { reserves: 80_00, owed: 100_00 };
  await t.tickHour(2);
  const list = await breaches(t);
  assert.equal(list.length, 2, "both breaches are on the record");
  assert.equal(list[0].action_taken, "alert_suppressed_by_cooldown");
  assert.equal((await t.webhooks("covenant.breached")).length, 1, "the second alert is held back by the cooldown");
  // Past the cooldown, still failing: reminded once.
  await t.tickHour(9);
  const hooks = await t.webhooks("covenant.breached");
  assert.equal(hooks.length, 2);
  assert.equal(hooks[1].payload.data.reminder, true);
});

test("a pause rule pauses inside its cooldown", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause", cooldown_seconds: 6 * 3600 }));
  await t.tickHour(0);
  const [first] = await breaches(t);
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(1);
  await t.ok(t.tool(t.provider.user, "release_covenant_pause", { breach_id: first.id }));
  assert.equal(await drift(t), null);
  t.state.books = { reserves: 80_00, owed: 100_00 };
  await t.tickHour(2);
  assert.ok(await drift(t), "paused again inside the cooldown");
  assert.equal((await breaches(t))[0].alerted, true, "a pause is always told to the sponsor");
  assert.equal((await t.webhooks("covenant.breached")).length, 2);
});

test("authorisation: only the sponsoring firm's explicit licence-provider members change rules; admins are refused", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const rule = await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  for (const who of [t.admin, t.stranger.user]) {
    assert.equal((await t.set(who, { rule_type: "coverage_below", threshold: 1, action: "alert" })).isError, true);
    assert.equal((await t.tool(who, "delete_covenant", { covenant_id: rule.id, reason: "because" })).isError, true);
    assert.equal((await t.tool(who, "acknowledge_breach", { breach_id: b.id })).isError, true);
    assert.equal((await t.tool(who, "release_covenant_pause", { breach_id: b.id, override_reason: "an administrator's decision" })).isError, true);
  }
  assert.match((await t.set(t.admin, { rule_type: "coverage_below", threshold: 1, action: "alert" })).data.error, /admins/);
  assert.ok(await drift(t), "still paused");
  // An admin who also holds the role by name, and belongs to the firm, is still an admin account.
  const { user: both } = await t.store.createUser("Both", ["admin", "license_provider"]);
  await t.store.setUserEntity(both.id, t.provider.entity.id);
  both.entity_id = t.provider.entity.id;
  assert.equal((await t.tool(both, "release_covenant_pause", { breach_id: b.id, override_reason: "an administrator's decision" })).isError, true);
  // Refusals are audited; admins see breaches, without the books.
  assert.ok((await t.raw("SELECT action FROM financial_products.audit_log WHERE action = 'release_covenant_pause_refused'")).length >= 1, "the refusal is audited");
  const seen = await t.ok(t.tool(t.admin, "list_covenant_breaches", {}));
  assert.equal(seen[0].id, b.id);
  assert.equal(seen[0].observed, null);
  assert.ok(seen[0].observed_withheld);
  const strangerView = await t.ok(t.tool(t.stranger.user, "list_covenant_breaches", {}));
  assert.deepEqual(strangerView, [], "another firm sees none of it");
});

test("weakening a rule with an open breach needs a stated reason, kept on the breach; tightening doesn't", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const rule = await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  const refused = await t.set(t.provider.user, { covenant_id: rule.id, rule_type: "coverage_below", threshold: 5_000, action: "alert" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /loosens/);
  await t.ok(t.set(t.provider.user, { covenant_id: rule.id, rule_type: "coverage_below", threshold: 12_000, action: "alert" }));
  const done = await t.ok(t.set(t.provider.user, { covenant_id: rule.id, rule_type: "coverage_below", threshold: 5_000, action: "alert", reason: "Agreed new floor with the builder" }));
  assert.equal(done.threshold, 5_000);
  const [b] = await breaches(t);
  const ev = b.events.find((e) => e.event === "rule_weakened");
  assert.equal(ev.reason, "Agreed new floor with the builder");
  assert.equal(ev.details.old.threshold, 12_000);
  assert.equal(ev.details.new.threshold, 5_000);
  const audits = await t.raw("SELECT details FROM financial_products.audit_log WHERE action = 'set_covenant' ORDER BY id");
  assert.ok(audits.some((a) => a.details.old?.threshold === 12_000 && a.details.new?.threshold === 5_000 && a.details.reason));
  // Deleting a rule with an open breach counts too; and a rule holding a pause can't be deleted at all.
  assert.equal((await t.tool(t.provider.user, "delete_covenant", { covenant_id: rule.id })).isError, true);
  const removed = await t.ok(t.tool(t.provider.user, "delete_covenant", { covenant_id: rule.id, reason: "Replaced by a different rule" }));
  assert.equal(removed.deleted, rule.id);
  assert.equal((await breaches(t))[0].status, "resolved");
  const pause = await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(1);
  const held = await t.tool(t.provider.user, "delete_covenant", { covenant_id: pause.id, reason: "No longer needed here" });
  assert.equal(held.isError, true);
  assert.match(held.data.error, /release it first/);
});

test("a rule change takes effect at the next evaluation, and re-judges the latest snapshot", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const rule = await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 5_000, action: "alert" }));
  await t.tickHour(0);
  assert.equal((await covenantsOf(t))[0].status, "pass");
  await t.ok(t.set(t.provider.user, { covenant_id: rule.id, rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  assert.equal((await breaches(t)).length, 0);
  await t.covenants.tick();
  assert.equal((await breaches(t))[0].rule_type, "coverage_below");
});

test("webhook events: covenant.breached and covenant.cleared reach the sponsor's firm with the numbers sealed until sent", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  const [breached] = await t.webhooks("covenant.breached");
  assert.equal(breached.sandbox, false);
  assert.equal(breached.payload.data.rule_type, "coverage_below");
  assert.equal(breached.payload.data.action_taken, "alerted");
  assert.ok(breached.payload.data.result_sealed, "the figures travel sealed");
  assert.doesNotMatch(JSON.stringify(breached.payload.data), /:\s*8000\b|"threshold"|"observed"/, "no figures in the clear");
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(1);
  const [cleared] = await t.webhooks("covenant.cleared");
  assert.equal(cleared.payload.data.hold_active, false);
  assert.equal((await t.webhooks()).length, 2);
});

test("a sponsor can't read another sponsor's books through a rule: it reads unknown", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const second = await t.sponsor(t.stranger);
  await t.ok(t.tool(t.stranger.user, "set_covenant", { sponsorship_id: second.id, rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [c] = await t.ok(t.tool(t.stranger.user, "list_covenants", {}));
  assert.equal(c.status, "unknown");
  assert.match(c.status_reason, /another licence provider/);
  assert.equal(await drift(t), null);
});

test("revoke_sponsorship can name the breach, and the record keeps it; the hold ends with the sponsorship", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  const bad = await t.tool(t.provider.user, "revoke_sponsorship", { sponsorship_id: t.sponsorship.id, reason: "no such breach", breach_id: "9d7f7f3a-8a0a-4e7e-9e7e-000000000000" });
  assert.equal(bad.isError, true);
  await t.ok(t.tool(t.provider.user, "revoke_sponsorship", { sponsorship_id: t.sponsorship.id, reason: "Reserves stayed short", breach_id: b.id }));
  const [after] = await breaches(t);
  assert.equal(after.revocation.reason, "Reserves stayed short");
  assert.equal(after.revocation.by, t.provider.user.id);
  assert.equal(after.pause.release_reason, "The sponsorship was revoked: Reserves stayed short");
  assert.equal((await t.store.getSponsorship(t.sponsorship.id)).status, "revoked");
});

test("the breach record is append-only", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  await assert.rejects(t.pg.query("UPDATE financial_products.covenant_breaches SET action_taken = 'nothing'"), /append-only/);
  await assert.rejects(t.pg.query("DELETE FROM financial_products.covenant_breaches"), /append-only/);
  await t.ok(t.tool(t.provider.user, "acknowledge_breach", { breach_id: (await breaches(t))[0].id, note: "seen" }));
  await assert.rejects(t.pg.query("DELETE FROM financial_products.covenant_breach_events"), /append-only/);
  const [b] = await breaches(t);
  assert.equal(b.acknowledged_by, t.provider.user.id);
  assert.ok(b.acknowledged_at);
});

test("a pause reports money already in flight and doesn't touch it", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const railId = "11111111-1111-4111-8111-111111111111";
  await t.pg.query(`INSERT INTO financial_products.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status) VALUES ($1, $2, 'ach', 'Fake', 'payout', '{us-ny}', 100000, 100000, 'approved')`, [railId, t.provider.entity.id]);
  await t.pg.query(`INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, sponsor_entity_id, rail_id, direction, amount_cents, status, sandbox) VALUES (gen_random_uuid(), 'k1', $1, $2, $3, 'payout', 12345, 'requested', false)`, [t.productId, t.provider.entity.id, railId]);
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  assert.equal(b.in_flight_when_paused.movements, 1);
  assert.equal(b.in_flight_when_paused.amount_cents, 12345);
  const [m] = await t.raw("SELECT status FROM financial_products.money_movements WHERE idempotency_key = 'k1'");
  assert.equal(m.status, "requested", "the pause cancelled nothing");
});

test("builder visibility: the builder sees a covenant paused it and the rule type, and nothing about thresholds or figures", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const mine = await t.ok(t.tool(t.builder.user, "list_my_sponsorships", {}));
  assert.deepEqual(Object.keys(mine[0].covenant_pauses[0]).sort(), ["paused_at", "rule_type"]);
  assert.equal(mine[0].covenant_pauses[0].rule_type, "coverage_below");
  const all = JSON.stringify(mine);
  assert.doesNotMatch(all, /[":]\s*(10000|8000)\b|threshold/);
  const regime = await t.ok(t.tool(t.builder.user, "get_product_regime", { product_id: t.productId }));
  assert.equal(regime.sales_paused, true);
  assert.equal(regime.drift.changes[0].kind, "covenant");
  assert.doesNotMatch(JSON.stringify(regime.drift), /threshold|:\s*(10000|8000)\b/);
});

test("builder visibility of the drift record: the owning firm sees the rule type; anyone else only that a covenant paused it", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.pg.query("UPDATE financial_products.products SET owner_id = $1, entity_id = $2 WHERE id = $3", [t.builder.user.id, t.builder.entity.id, t.productId]);
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const insider = await t.ok(t.tool(t.builder.user, "get_product", { id: t.productId }));
  assert.equal(insider.drift.changes[0].kind, "covenant");
  assert.equal(insider.drift.changes[0].rule_type, "coverage_below");
  const outsider = await t.ok(t.tool(t.stranger.user, "get_product", { id: t.productId }));
  assert.equal(outsider.sales_paused, true);
  assert.equal(outsider.drift.changes[0].kind, "covenant");
  assert.equal(outsider.drift.changes[0].rule_type, undefined, "a stranger doesn't learn which rule");
  assert.equal(outsider.drift.changes[0].id, "redacted");
});

test("ops_status: paused products, open breaches, and a covenant timer that isn't running", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  await t.covenants.tick();
  const s = await opsStatus(t.db, { backupStatusFile: "/nonexistent" });
  assert.equal(s.covenants.paused_products, 1);
  assert.equal(s.covenants.open_breaches, 1);
  const lines = s.attention.join("\n");
  assert.match(lines, /covenants: 1 product\(s\) paused/);
  assert.match(lines, /covenants: 1 open breach/);
  assert.match(lines, /covenant timer last ran/, "the clock in this test is days old, so the timer reads as stale");
});

// ---- what the review of #124 asked for ----

const HOOK_URL = "http://127.0.0.1:9/hook";
const memberOf = async (t, firm, roles, name) => {
  const { user } = await t.store.createUser(name, roles);
  await t.store.setUserEntity(user.id, firm.id);
  user.entity_id = firm.id;
  return user;
};

test("covenant webhooks: only a named licence-provider member creates or deletes them, and each delivery checks its creator now", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const innovator = await memberOf(t, t.provider.entity, ["innovator"], "Member");
  const admin = await memberOf(t, t.provider.entity, ["admin"], "Firm admin");
  for (const who of [innovator, admin]) {
    const refused = await t.tool(who, "create_firm_webhook", { url: HOOK_URL, events: ["covenant.breached"] });
    assert.equal(refused.isError, true);
    assert.match(refused.data.error, /covenant/);
  }
  const defaulted = await t.ok(t.tool(innovator, "create_firm_webhook", { url: HOOK_URL }));
  assert.ok(!defaulted.events.some((e) => e.startsWith("covenant.")), "someone else's default doesn't include them");
  const hook = await t.ok(t.tool(t.provider.user, "create_firm_webhook", { url: HOOK_URL }));
  assert.ok(hook.events.includes("covenant.breached"), "the sponsor's default does");
  for (const who of [innovator, admin]) assert.equal((await t.tool(who, "delete_firm_webhook", { webhook_id: hook.id })).isError, true);
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert", cooldown_seconds: 3600 }));
  await t.tickHour(0);
  assert.equal((await t.webhooks("covenant.breached")).length, 1);
  // The creator stops being entitled: the next delivery isn't queued.
  await t.pg.query("UPDATE financial_products.users SET roles = '{admin,license_provider}' WHERE id = $1", [t.provider.user.id]);
  await t.tickHour(2);
  assert.equal((await t.webhooks("covenant.breached")).length, 1, "a later role change takes effect");
  await t.pg.query("UPDATE financial_products.users SET roles = '{license_provider}' WHERE id = $1", [t.provider.user.id]);
  t.provider.user.roles = ["license_provider"];
  await t.ok(t.tool(t.provider.user, "delete_firm_webhook", { webhook_id: hook.id }));
});

test("a sandbox pass neither closes a live breach nor permits a release", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  t.state.kind = "sandbox";
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(1);
  const [c] = await covenantsOf(t);
  // On a published product, the sandbox's figures make the rule unknown: neither a pass nor a fail.
  assert.equal(c.status, "unknown");
  assert.equal(c.status_sandbox, false);
  assert.equal((await breaches(t))[0].status, "open", "sandbox figures don't close what live ones opened");
  const refused = await t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /sandbox/);
  assert.ok(await drift(t));
});

test("a stale figure reads unknown on the timer alone, starts the unknown clock, and can't be released on", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause", unknown_limit_seconds: 3600 }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  t.state.books = { reserves: 150_00, owed: 100_00 };
  await t.tickHour(1);
  assert.equal((await covenantsOf(t))[0].status, "pass");
  t.setClock(T0 + 4 * HOUR); // no health tick: the worker has stopped
  await t.covenants.tick();
  let [c] = await covenantsOf(t);
  assert.equal(c.status, "unknown");
  assert.match(c.status_reason, /two intervals/);
  const refused = await t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /can't be evaluated/);
  t.setClock(T0 + 6 * HOUR);
  await t.covenants.tick();
  const unknown = (await breaches(t)).find((x) => x.kind === "unknown_limit");
  assert.ok(unknown, "unknown past its limit alerts");
});

test("unverified_for: publishing again doesn't restart the clock; a product not live is never released on", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "unverified_for", threshold: 3 * 3600, action: "pause" }));
  await t.tickHour(0);
  await t.pg.query("UPDATE financial_products.products SET published_at = $2 WHERE id = $1", [t.productId, new Date(T0 + 4 * HOUR)]);
  await t.tickHour(1);
  await t.tickHour(5);
  const [b] = await breaches(t);
  assert.equal(b?.rule_type, "unverified_for", "the new published_at doesn't reset it");
  await t.pg.query("UPDATE financial_products.products SET status = 'unpublished' WHERE id = $1", [t.productId]);
  const refused = await t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /isn't live/);
});

test("unverified_for counts only time live, so a relaunch doesn't breach at once", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "unverified_for", threshold: 3 * 3600, action: "alert" }));
  await t.tickHour(0);
  await t.pg.query("UPDATE financial_products.products SET status = 'unpublished' WHERE id = $1", [t.productId]);
  await t.covenants.tick();
  t.setClock(T0 + 30 * 24 * HOUR);
  await t.covenants.tick();
  await t.pg.query("UPDATE financial_products.products SET status = 'published' WHERE id = $1", [t.productId]);
  await t.tickHour(30 * 24 + 1);
  assert.equal((await covenantsOf(t))[0].status, "pass");
  assert.deepEqual(await breaches(t), []);
});

test("a draft product raises no false alarm: its rules aren't evaluated", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "unverified_for", threshold: 3 * 3600, action: "alert", unknown_limit_seconds: 3600 }));
  await t.pg.query("UPDATE financial_products.products SET status = 'draft' WHERE id = $1", [t.productId]);
  await t.tickHour(1);
  t.setClock(T0 + 10 * HOUR);
  await t.covenants.tick();
  assert.equal((await covenantsOf(t))[0].status, "unevaluated");
  assert.deepEqual(await breaches(t), []);
});

test("a stale snapshot isn't judged: a new rule over it doesn't pause, and editing one doesn't resolve a live breach", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.tickHour(0);
  t.setClock(T0 + 30 * 24 * HOUR);
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.covenants.tick();
  assert.equal((await covenantsOf(t))[0].status, "unknown");
  assert.deepEqual(await breaches(t), [], "the old failing figure opens nothing");
  assert.equal(await drift(t), null);

  const u = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const rule = await u.ok(u.set(u.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await u.tickHour(0);
  assert.equal((await breaches(u))[0].status, "open");
  u.setClock(T0 + 30 * 24 * HOUR);
  await u.ok(u.set(u.provider.user, { covenant_id: rule.id, rule_type: "coverage_below", threshold: 5_000, action: "alert", reason: "A looser floor agreed with the builder" }));
  await u.covenants.tick();
  assert.equal((await covenantsOf(u))[0].status, "unknown");
  assert.equal((await breaches(u))[0].status, "open", "a stale pass doesn't resolve it");
  // A fresh snapshot judges it under the new rule; rows older than the staleness window stay unjudged.
  await u.tickHour(30 * 24);
  assert.equal((await covenantsOf(u))[0].status, "pass");
  assert.equal((await breaches(u))[0].status, "resolved");
});

test("a hold drifts what's built on the product, and a release clears it", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const other = (await t.store.publishedProducts()).find((p) => p.id !== t.productId);
  const was = "sha256:" + createHash("sha256").update(JSON.stringify({ published: true, offered: [], drifted: false })).digest("hex").slice(0, 32);
  await t.store.setPins(other.id, { version: 1, pinned_at: new Date().toISOString(), components: [], parties: [], entity_ids: [], state: { entities: {}, licences: {}, parties: {}, products: { [t.productId]: was } } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  assert.equal((await t.store.getProduct(other.id)).drift.changes[0].kind, "product");
  const [b] = await breaches(t);
  await t.ok(t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id, override_reason: "cured off-platform, confirmed by us" }));
  assert.equal((await t.store.getProduct(other.id)).drift, null);
});

test("unverified_for reads unknown for a sponsor whose books aren't the record's, and never pauses for it", async () => {
  const t = await setup();
  const second = await t.sponsor(t.stranger);
  await t.ok(t.tool(t.stranger.user, "set_covenant", { sponsorship_id: second.id, rule_type: "unverified_for", threshold: 3 * 3600, action: "pause", unknown_limit_seconds: 3600 }));
  await t.tickHour(0);
  let [c] = await t.ok(t.tool(t.stranger.user, "list_covenants", {}));
  assert.equal(c.status, "unknown");
  assert.match(c.status_reason, /your firm's books/);
  await t.tickHour(5);
  const list = await t.ok(t.tool(t.stranger.user, "list_covenant_breaches", {}));
  assert.equal(list[0]?.kind, "unknown_limit", "unknown too long alerts");
  assert.equal(await drift(t), null, "and never pauses");
});

test("an alert that reached no webhook says so; a blocked hook shows in list_firm_webhooks and ops_status", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  let [b] = await breaches(t);
  assert.equal(b.alerted, false);
  assert.equal(b.action_taken, "alert_undelivered");
  assert.ok(b.events.some((e) => e.event === "alert_undelivered"));

  const p = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await p.ok(p.set(p.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await p.tickHour(0);
  [b] = await breaches(p);
  assert.equal(b.action_taken, "paused_alert_undelivered");
  assert.ok(await drift(p), "the pause doesn't depend on the alert");

  const u = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const member = await memberOf(u, u.provider.entity, ["license_provider"], "Second member");
  const hook = await u.ok(u.tool(member, "create_firm_webhook", { url: HOOK_URL }));
  await u.pg.query("UPDATE financial_products.users SET roles = '{innovator}' WHERE id = $1", [member.id]);
  const hooks = await u.ok(u.tool(u.provider.user, "list_firm_webhooks", {}));
  assert.equal(hooks.find((h) => h.id === hook.id).blocked, true);
  assert.match(hooks.find((h) => h.id === hook.id).blocked_reason, /create it again/);
  const s = await opsStatus(u.db, { backupStatusFile: "/nonexistent" });
  assert.equal(s.covenants.blocked_webhooks, 1);
  assert.match(s.attention.join("\n"), /firm webhook\(s\) blocked/);
});

test("a queued covenant delivery is held back if its creator stopped qualifying before it's sent", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  await t.pg.query("UPDATE financial_products.users SET roles = '{admin,license_provider}' WHERE id = $1", [t.provider.user.id]);
  const out = await deliverDueWebhooks(t.store, { now: new Date(Date.now() + 3600_000) });
  assert.equal(out.delivered, 0);
  const [d] = await t.raw("SELECT status, last_error, attempts FROM financial_products.webhook_deliveries WHERE type = 'covenant.breached'");
  assert.equal(d.status, "failed");
  assert.match(d.last_error, /Held back/);
});

test("a hold isn't repaired while the rule can't be judged or passes only on sandbox figures", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  await t.pg.query("DELETE FROM financial_products.covenant_holds");
  await t.store.setDrift(t.productId, null);
  t.setClock(T0 + 10 * HOUR);
  await t.covenants.tick();
  assert.equal((await t.raw("SELECT count(*)::int AS n FROM financial_products.covenant_holds"))[0].n, 0, "stale: unknown, so nothing to repair");
  assert.equal(await drift(t), null);
});

test("sandbox figures don't keep a live breach's alarm ringing", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert", cooldown_seconds: 60 }));
  await t.tickHour(0);
  assert.equal((await t.webhooks("covenant.breached")).length, 1);
  t.state.kind = "sandbox";
  await t.tickHour(1);
  assert.equal((await t.webhooks("covenant.breached")).length, 1, "no reminder off sandbox figures");
});

test("admins see that a rule tripped, not its settings or the sponsor's reasons, in breaches and the audit log", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  const rule = await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  await t.ok(t.set(t.provider.user, { covenant_id: rule.id, rule_type: "coverage_below", threshold: 12_345, action: "pause" }));
  const [b] = await breaches(t);
  await t.ok(t.tool(t.provider.user, "release_covenant_pause", { breach_id: b.id, override_reason: "secret commercial reasoning here" }));
  await t.ok(t.tool(t.provider.user, "revoke_sponsorship", { sponsorship_id: t.sponsorship.id, reason: "secret revocation grounds", breach_id: b.id }));
  const [seen] = await t.ok(t.tool(t.admin, "list_covenant_breaches", {}));
  assert.equal(seen.threshold, undefined);
  assert.equal(seen.unit, undefined);
  assert.ok(seen.rule_config_withheld);
  assert.equal(seen.pause.release_reason, null);
  assert.equal(seen.revocation.reason, null);
  assert.equal(seen.resolved_reason, null);
  const log = JSON.stringify(await t.ok(t.tool(t.admin, "audit_log", { limit: 500 })));
  assert.match(log, /"set_covenant"/);
  assert.doesNotMatch(log, /12345|"threshold"|secret commercial/);
});

test("figures are withheld once the firm isn't active or the sponsorship has ended", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  assert.equal((await breaches(t))[0].observed, 8_000);
  await t.pg.query("UPDATE financial_products.entities SET status = 'suspended' WHERE id = $1", [t.provider.entity.id]);
  let [b] = await breaches(t);
  assert.equal(b.observed, null);
  assert.equal(b.in_flight_when_paused, null);
  assert.ok(b.observed_withheld);
  await t.pg.query("UPDATE financial_products.entities SET status = 'active' WHERE id = $1", [t.provider.entity.id]);
  assert.equal((await breaches(t))[0].observed, 8_000);
  await t.ok(t.tool(t.provider.user, "revoke_sponsorship", { sponsorship_id: t.sponsorship.id, reason: "ended" }));
  [b] = await breaches(t);
  assert.equal(b.observed, null);
  assert.equal(b.in_flight_when_paused, null);
});

test("an admin account can't revoke, with or without a breach id", async () => {
  const t = await setup();
  const both = await memberOf(t, t.provider.entity, ["admin", "license_provider"], "Both");
  const refused = await t.tool(both, "revoke_sponsorship", { sponsorship_id: t.sponsorship.id, reason: "an admin's decision" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /admin/);
  assert.equal((await t.store.getSponsorship(t.sponsorship.id)).status, "approved");
});

test("two evaluators claim one reminder", async () => {
  const t = await setup();
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "snapshot_missed_for", threshold: 3 * 3600, action: "alert", cooldown_seconds: 3600 }));
  t.setClock(T0 + 5 * HOUR);
  await t.covenants.tick();
  assert.equal((await t.webhooks("covenant.breached")).length, 1);
  t.setClock(T0 + 7 * HOUR);
  await Promise.all([t.covenants.tick(), t.covenants.tick()]);
  const hooks = await t.webhooks("covenant.breached");
  assert.equal(hooks.length, 2, "one reminder, whoever got there first");
  assert.equal(hooks[1].payload.data.reminder, true);
});

test("a live product with no pinned state records a failed pause rather than claiming it paused", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.store.setPins(t.productId, null);
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  const [b] = await breaches(t);
  assert.equal(b.action_taken, "pause_failed_no_pins");
  assert.ok(b.events.some((e) => e.event === "pause_failed"));
  assert.equal(b.pause, null);
  assert.equal((await t.webhooks("covenant.breached")).length, 1, "the sponsor is told");
});

test("a missing hold is repaired for a pause rule with an open breach", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  await t.pg.query("DELETE FROM financial_products.covenant_holds");
  await t.store.setDrift(t.productId, null);
  await t.covenants.tick();
  assert.equal((await t.raw("SELECT count(*)::int AS n FROM financial_products.covenant_holds"))[0].n, 1);
  assert.ok(await drift(t));
});

test("a firm can't hold covenants over a product it owns", async () => {
  const t = await setup();
  await t.pg.query("UPDATE financial_products.products SET entity_id = $1 WHERE id = $2", [t.provider.entity.id, t.productId]);
  const refused = await t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /own product/);
});

test("snapshot_missed_for doesn't count a failed ledger read or a report that can't be authenticated", async () => {
  const t = await setup({ books: null });
  await t.ok(t.set(t.provider.user, { rule_type: "snapshot_missed_for", threshold: 3 * 3600, action: "alert" }));
  await t.tickHour(1);
  await t.tickHour(5);
  assert.equal((await breaches(t))[0]?.rule_type, "snapshot_missed_for", "ledger-down rows aren't snapshots");
  const u = await setup();
  await u.ok(u.set(u.provider.user, { rule_type: "snapshot_missed_for", threshold: 3 * 3600, action: "alert" }));
  await u.tickHour(1);
  await u.pg.query("UPDATE financial_products.product_health_snapshots SET report_sealed = 'v1:AAAA:AAAA:AAAA'");
  await u.setClock(T0 + 5 * HOUR);
  await u.covenants.tick();
  assert.equal((await breaches(u))[0]?.rule_type, "snapshot_missed_for", "a report that can't be opened isn't a snapshot");
});

// ---- follow-ups after #124 ----

const setStatus = (t, status) => t.pg.query("UPDATE financial_products.products SET status = $2 WHERE id = $1", [t.productId, status]);

test("unpublishing at alternate ticks can't stop the unverified_for clock: a blip counts as live", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "unverified_for", threshold: 3 * 3600, action: "alert" }));
  await t.tickHour(0);
  for (let step = 1; step <= 14; step++) {
    await setStatus(t, step % 2 ? "unpublished" : "published");
    t.setClock(T0 + 5 * 60_000 + step * 30 * 60_000);
    await t.covenants.tick();
  }
  await setStatus(t, "published");
  await t.covenants.tick();
  assert.equal((await breaches(t))[0]?.rule_type, "unverified_for");
});

test("snapshots too old to act on leave a trace: an audit entry, and a historical breach that pauses nothing", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause" }));
  await t.tickHour(0);
  assert.equal((await covenantsOf(t))[0].status, "pass");
  t.health.afterAdvance = null; // the evaluator isn't watching while the record moves on
  t.state.books = { reserves: 80_00, owed: 100_00 };
  for (const h of [1, 2, 3]) await t.tickHour(h);
  t.state.books = { reserves: 150_00, owed: 100_00 };
  for (const h of [4, 5, 6]) await t.tickHour(h);
  await t.covenants.tick();
  const [b] = await breaches(t);
  assert.equal(b.kind, "historical");
  assert.equal(b.status, "resolved");
  assert.equal(b.action_taken, "historical_not_acted_on");
  assert.equal(b.pause, null);
  assert.equal(b.observed, 8_000);
  assert.equal(await drift(t), null, "too old to pause anything");
  const [audit] = await t.raw("SELECT details FROM financial_products.audit_log WHERE action = 'covenant_rows_unjudged'");
  assert.equal(audit.details.count, 4);
  assert.equal(audit.details.from_sequence, 2);
  assert.equal(audit.details.to_sequence, 5);
  assert.equal((await covenantsOf(t))[0].status, "pass", "the recent snapshots were judged as usual");
  await t.covenants.tick();
  assert.equal((await breaches(t)).length, 1, "and it's recorded once");
});

test("a delivery held back at send marks the breach's first alert as undelivered", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.listen();
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  assert.equal((await breaches(t))[0].alerted, true);
  await t.pg.query("UPDATE financial_products.users SET roles = '{admin,license_provider}' WHERE id = $1", [t.provider.user.id]);
  await deliverDueWebhooks(t.store, { now: new Date(Date.now() + 3600_000) });
  await t.pg.query("UPDATE financial_products.users SET roles = '{license_provider}' WHERE id = $1", [t.provider.user.id]);
  const [b] = await breaches(t);
  assert.equal(b.alerted, false, "the record no longer says it was sent");
  const ev = b.events.find((e) => e.event === "alert_undelivered");
  assert.equal(ev.details.first, true);
  assert.match(ev.reason, /Held back/);
  const [d] = await t.raw("SELECT last_error FROM financial_products.webhook_deliveries WHERE type = 'covenant.breached'");
  assert.match(d.last_error, /Held back/);
});

test("unverified_for reads unknown when the latest real snapshot isn't this sponsor's books, even with older ones of its own", async () => {
  const t = await setup();
  const other = await t.sponsor(t.stranger);
  assert.ok(other.id);
  await t.ok(t.set(t.provider.user, { rule_type: "unverified_for", threshold: 3 * 3600, action: "pause" }));
  await t.tickHour(0);
  await t.tickHour(1);
  await t.pg.query("UPDATE financial_products.product_health_snapshots SET partner_entity_id = $1 WHERE sequence = (SELECT max(sequence) FROM financial_products.product_health_snapshots)", [t.stranger.entity.id]);
  await t.covenants.tick();
  const [c] = await covenantsOf(t);
  assert.equal(c.status, "unknown");
  assert.match(c.status_reason, /latest snapshot/);
  assert.equal(await drift(t), null);
});

test("a relaunch doesn't fire snapshot_missed_for at once, and a real outage after it still does", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "snapshot_missed_for", threshold: 3 * 3600, action: "pause" }));
  await t.tickHour(0);
  await setStatus(t, "unpublished");
  await t.covenants.tick();
  t.setClock(T0 + 30 * 24 * HOUR);
  await t.covenants.tick();
  await setStatus(t, "published");
  await t.covenants.tick();
  assert.equal((await covenantsOf(t))[0].status, "pass", "time off sale doesn't count");
  assert.deepEqual(await breaches(t), []);
  assert.equal(await drift(t), null);
  t.setClock(T0 + 30 * 24 * HOUR + 4 * HOUR);
  await t.covenants.tick();
  assert.equal((await breaches(t))[0]?.rule_type, "snapshot_missed_for", "four hours after the relaunch is a real outage");
});

test("a relaunch doesn't fire consecutive_gaps, and gaps after it count", async () => {
  const t = await setup();
  await t.ok(t.set(t.provider.user, { rule_type: "consecutive_gaps", threshold: 3, action: "pause" }));
  await t.tickHour(0);
  await setStatus(t, "unpublished");
  await t.covenants.tick();
  t.setClock(T0 + 30 * 24 * HOUR);
  await t.covenants.tick();
  await setStatus(t, "published");
  await t.covenants.tick();
  assert.equal((await covenantsOf(t))[0].status, "pass");
  assert.deepEqual(await breaches(t), []);
  t.setClock(T0 + 30 * 24 * HOUR + 5 * HOUR);
  await t.covenants.tick();
  assert.equal((await breaches(t))[0]?.rule_type, "consecutive_gaps");
});

test("an alert nothing could receive starts no cooldown, and ops_status raises it", async () => {
  const t = await setup({ books: { reserves: 80_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.tickHour(0);
  assert.equal((await breaches(t))[0].action_taken, "alert_undelivered");
  const s = await opsStatus(t.db, { backupStatusFile: "/nonexistent" });
  assert.equal(s.covenants.open_breaches_alert_undelivered, 1);
  assert.match(s.attention.join("\n"), /reached no webhook/);
  await t.listen();
  await t.tickHour(1);
  const hooks = await t.webhooks("covenant.breached");
  assert.equal(hooks.length, 1, "goes out as soon as there's a webhook, inside the default cooldown");
  assert.equal(hooks[0].payload.data.reminder, true);
});

test("with no snapshot to judge, a published product on a sandbox ledger reads unknown, not sandbox", async () => {
  const t = await setup({ kind: "sandbox" });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "alert" }));
  await t.covenants.tick();
  const [c] = await covenantsOf(t);
  assert.equal(c.status, "unknown");
  assert.equal(c.status_sandbox, false, "not knowing is never excused as test data on a live product");
});

test("a published product left on test figures past a pause rule's unknown limit is paused; other unknowns only alert", async () => {
  const t = await setup({ kind: "sandbox", books: { reserves: 150_00, owed: 100_00 } });
  await t.ok(t.set(t.provider.user, { rule_type: "coverage_below", threshold: 10_000, action: "pause", unknown_limit_seconds: 3600 }));
  await t.tickHour(0);
  assert.equal(await drift(t), null, "inside the limit: unknown, nothing paused");
  t.setClock(T0 + 2 * HOUR);
  await t.covenants.tick();
  const b = (await breaches(t)).find((x) => x.kind === "unknown_limit");
  assert.ok(b);
  assert.equal(b.sandbox, false);
  assert.match(b.action_taken, /^paused/);
  assert.ok(await drift(t), "the sponsor never connected its books: a pause rule holds the product");
});
