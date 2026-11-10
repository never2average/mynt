import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Every product's financial health: the canonical snapshot, its fingerprint, the numbers only entitled readers can
// open, the partner's co-signature, and the record on chain with its gaps. The chain here is a fake that enforces
// what the program enforces; CI runs the real program on a local validator.

process.env.MYNT_VAULT_KEY = randomBytes(32).toString("base64");

const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { opsStatus } = await import("../dist/ops.js");
const { adaptRailFlows, ProductHealthService, buildFigures, canonicalJson, findGaps, fingerprintOf, loadFlowsFor, openReport, productHealthConfigFromEnv, sealReport, snapshotStatus, SolanaHealthChain } = await import("../dist/product-health.js");
const chainLib = await import("../dist/solana/product-health-chain.js");
const { compileMessage, serializeTransaction } = await import("../dist/solana/tx.js");
const { Keypair, base58Encode, anchorDiscriminator, findProgramAddress, isWeakEd25519Key } = await import("../dist/solana/codec.js");
const { checkProgramRules } = await import("../dist/solana/program-rules.js");
const { SolanaService } = await import("../dist/solana/service.js");
const { GENESIS_HASH } = await import("../dist/solana/rpc.js");
const { CATALOG } = await import("./helpers.js");

const PROGRAM_ID = "GLi9SM8q1Q8S1k5SFHWpZ7v9uWK9M5ZDxhd6ESjuSfVz";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // on the hour

// The program's own rules, in memory: the next sequence only, contiguous periods, the hash chain over everything.
class FakeChain {
  programId = PROGRAM_ID;
  publisher = "PublisherFake11111111111111111111111111111111";
  heads = new Map();
  log = [];
  failing = false;
  async head(subject, programId = this.programId) {
    if (this.failing) throw new Error("the RPC was unreachable");
    return this.heads.get(`${programId}:${Buffer.from(subject).toString("hex")}`) ?? null;
  }
  historyExists = false;
  historyFails = false;
  async latestRecordTx() {
    return "recovered-transaction";
  }
  async hasHeadHistory() {
    if (this.historyFails) throw new Error("the RPC was unreachable");
    return this.historyExists;
  }
  apply(subject, kind, e, opening) {
    if (this.failing) throw new Error("the RPC was unreachable");
    const k = `${this.programId}:${Buffer.from(subject).toString("hex")}`;
    const head = this.heads.get(k);
    assert.equal(opening, head === undefined, "opening only when no head exists");
    const at = head?.sequence ?? 0;
    assert.equal(e.sequence, at + 1, "the program refuses anything but the next sequence");
    assert.ok(e.period_end > e.period_start, "a period must end after it starts");
    if (at > 0) assert.equal(e.period_start, head.period_end, "periods are contiguous");
    const fingerprint = e.fingerprint ?? chainLib.ZERO_32;
    const partner_commitment = e.partner_commitment ?? chainLib.ZERO_32;
    const source = chainLib.SOURCE_FLAG[e.source] ?? 0;
    const chain = chainLib.nextChain(head?.chain ?? chainLib.ZERO_32, { subject, sequence: e.sequence, fingerprint, period_start: e.period_start, period_end: e.period_end, kind, source, partner_commitment });
    const next = { subject, sequence: e.sequence, fingerprint, period_start: e.period_start, period_end: e.period_end, kind, source, partner_signed: !!e.partner_commitment, partner_commitment, chain };
    this.heads.set(k, next);
    this.log.push({ subject: k, ...next });
    return `tx${this.log.length}`;
  }
  publishSnapshot(subject, entry, opening) {
    return Promise.resolve().then(() => this.apply(subject, chainLib.KIND_SNAPSHOT, entry, opening));
  }
  publishMissed(subject, entry, opening) {
    return Promise.resolve().then(() => this.apply(subject, chainLib.KIND_MISSED, entry, opening));
  }
}

const SNAPSHOTS = "financial_products.product_health_snapshots";

async function setup({ ledger, flows, config = {}, liquidityProvidersOf } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  let clock = T0 + 5 * 60_000;
  const chain = new FakeChain();
  const fullConfig = { intervalMs: HOUR, cosignWindowMs: 10 * 60_000, pollMs: 60_000, programId: PROGRAM_ID, ...config };
  const make = (c) => ProductHealthService.open(db, store, c, { chain, flowsFor: flows ?? null, ledgerFor: ledger ? () => ledger : undefined, now: () => new Date(clock), liquidityProvidersOf });
  const health = await make(fullConfig);
  const [productPublished] = await store.publishedProducts();
  const productId = productPublished.id;
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
  const sponsor = async (who) => {
    const s = await store.requestSponsorship(builder.user.id, { product_id: productId, component_key: "core", builder_entity_id: builder.entity.id, provider_entity_id: who.entity.id, requested_jurisdictions: [], note: null });
    return store.decideSponsorship(s.id, { status: "approved", decided_by: who.user.id, note: null });
  };
  const sponsorship = await sponsor(provider);
  const raw = async (sql, params) => (await pg.query(sql, params)).rows;
  const set = (t) => (clock = t);
  const tool = async (user, name, args = {}) => {
    const [c, srv] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { productHealth: health }).connect(srv);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text), tools: (await client.listTools()).tools.map((t) => t.name) };
  };
  return { db, store, pg, health, make, fullConfig, chain, productId, provider, builder, stranger, admin, firm, sponsor, sponsorship, raw, set, tool, tickAt: async (t, h = health) => { set(t); await h.tick(); } };
}

const edKeyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const address = base58Encode(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"));
  return { privateKey, address, sign: (fp) => edSign(null, Buffer.from(chainLib.cosignMessage(Buffer.from(fp, "hex"))), privateKey).toString("hex"), signRaw: (fp) => edSign(null, Buffer.from(fp, "hex"), privateKey).toString("hex") };
};

const liveLedger = { id: "fake-live", name: "A fake live ledger", kind: "live", read: async (c) => ({ reserves_held_cents: 150_00, customer_obligations_cents: 100_00, as_of: c.period_end }) };
const firstHistoryWithTwo = async (health, user, productId) => {
  const out = await health.get(user, productId, null, 5);
  assert.equal(out.history.length, 2);
  return out;
};
const firstSnapshot = async (health, user, productId) => (await health.listFor(user, productId, 50))[0].snapshots.at(-1);
const tally = (amount_cents, count = 1) => ({ count, amount_cents });
const railDirection = (o = {}) => ({ requested: tally(0, 0), submitted: tally(0, 0), settled: tally(0, 0), failed: tally(0, 0), reversed: tally(0, 0), ...o });

// ---- the canonical encoding ----

test("the canonical encoding is stable: key order never changes the bytes or the fingerprint", () => {
  const a = canonicalJson({ b: 1, a: { d: null, c: [1, "x", true] } });
  const b = canonicalJson({ a: { c: [1, "x", true], d: null }, b: 1 });
  assert.equal(a, '{"a":{"c":[1,"x",true],"d":null},"b":1}');
  assert.equal(a, b);
  assert.equal(fingerprintOf(a), fingerprintOf(b));
  assert.throws(() => canonicalJson({ ratio: 1.5 }), /only safe integers/);
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: Number.MAX_SAFE_INTEGER + 2 }));
});

// ---- nulls stay null ----

test("a figure that can't be measured is null with a reason, never 0", () => {
  const f = buildFigures({ reading: { error: { code: "unreachable", message: "x" } }, flows: null });
  for (const [name, fig] of Object.entries(f)) {
    assert.equal(fig.value, null, name);
    assert.ok(fig.reason, `${name} says why`);
  }
  const noObligations = buildFigures({ reading: { reserves_held_cents: 500_00, customer_obligations_cents: 0, as_of: "2026-11-09T00:00:00Z" }, flows: null });
  assert.equal(noObligations.reserves_cents.value, 500_00);
  assert.equal(noObligations.obligations_cents.value, 0);
  assert.equal(noObligations.coverage_bps.value, null);
  assert.match(noObligations.coverage_bps.reason, /undefined/);
  const halfMeasured = buildFigures({ reading: { reserves_held_cents: null, customer_obligations_cents: 100_00, as_of: "2026-11-09T00:00:00Z", reason: "reserves are reconciling" }, flows: null });
  assert.equal(halfMeasured.reserves_cents.reason, "reserves are reconciling");
  assert.equal(halfMeasured.coverage_bps.value, null);
});

test("every snapshot is complete, in integer cents, with nulls and their reasons where nothing is measured", async () => {
  const { health, productId, provider, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  const r = (await health.get(provider.user, productId, null, 10)).latest.report;
  assert.equal(r.schema, "mynt.product_health.v1");
  assert.equal(r.source, "sandbox");
  assert.ok(Number.isInteger(r.figures.reserves_cents.value));
  assert.ok(Number.isInteger(r.figures.coverage_bps.value));
  assert.equal(r.figures.flows_in_cents.value, null);
  assert.ok(r.figures.flows_in_cents.reason);
  assert.equal(r.figures.open_withdrawal_requests.value, null);
  assert.ok(r.figures.open_complaints.reason);
  assert.equal(r.salt.length, 64);
});

// ---- the money rails (B1) ----

test("the rails' real shape: on_ramp and deposit are in, off_ramp and payout are out, requested and submitted are pending", () => {
  const { flows, reason } = adaptRailFlows({
    product_id: "p",
    measured: true,
    flows: { on_ramp: railDirection({ settled: tally(8_00), requested: tally(50), submitted: tally(50), reversed: tally(1_00) }), deposit: railDirection({ settled: tally(1_00), failed: tally(1_00) }), off_ramp: railDirection({ settled: tally(2_00) }), payout: null },
    unresolved: { on_ramp: tally(0, 0), deposit: tally(3_00), off_ramp: tally(0, 0), payout: null },
    not_measured: { payout: "Mynt doesn't instruct payout for this product, so it can't see any" },
  });
  assert.deepEqual(flows.in, { settled: 9_00, pending: 1_00, failed: 1_00, reversed: 1_00, unresolved: 3_00 });
  assert.deepEqual(flows.out, { settled: 2_00, pending: 0, failed: 0, reversed: 0, unresolved: 0 });
  assert.match(reason, /payout/);
  const adapted = adaptRailFlows({
    measured: true,
    flows: { on_ramp: railDirection({ settled: tally(8_00) }), deposit: railDirection(), off_ramp: railDirection({ settled: tally(2_00) }), payout: null },
    unresolved: { on_ramp: tally(0, 0), deposit: tally(0, 0), off_ramp: tally(0, 0), payout: null },
    not_measured: { payout: "no payouts here" },
  });
  // A total that leaves a direction out says so.
  assert.equal(adapted.partial.in, null);
  assert.match(adapted.partial.out, /payout: no payouts here/);
  const p = buildFigures({ reading: null, flows: adapted.flows, flowsReason: adapted.reason, partial: adapted.partial });
  assert.equal(p.flows_in_cents.partial, undefined);
  assert.equal(p.flows_in_cents.reason, null);
  assert.equal(p.flows_out_cents.value, 2_00);
  assert.equal(p.flows_out_cents.partial, true);
  assert.match(p.flows_out_cents.reason, /Partial: leaves out payout/);
  assert.equal(p.pending_settlements_cents.partial, true);

  const f = buildFigures({ reading: { reserves_held_cents: 150_00, customer_obligations_cents: 100_00, as_of: "2026-11-09T00:00:00Z" }, flows, flowsReason: reason });
  assert.equal(f.coverage_bps.value, 15_000);
  assert.equal(f.flows_in_cents.value, 9_00);
  assert.equal(f.flows_out_cents.value, 2_00);
  assert.equal(f.requested_in_cents.value, 15_00, "requested counts what nobody answered for");
  assert.equal(f.unresolved_cents.value, 3_00);
  assert.equal(f.pending_settlements_cents.value, 1_00);
  // Failure and reversal rates round up, never down.
  assert.equal(f.reversal_rate_bps.value, 834); // 1 of (9 + 2 + 1) = 8.33...%
  assert.equal(f.failure_rate_bps.value, 770); // 1 of (9 + 2 + 1 + 1) = 7.69...%
});

test("what the rails can't measure stays null, carrying their own reason; a bad answer is logged and null", () => {
  const notStarted = adaptRailFlows({ measured: false, flows: { on_ramp: null, off_ramp: null, payout: null, deposit: null }, not_measured: { on_ramp: "the period starts before Mynt's money ledger did", deposit: "the period starts before Mynt's money ledger did" } });
  assert.equal(notStarted.flows, null);
  assert.equal(notStarted.reason, "the period starts before Mynt's money ledger did");
  const f = buildFigures({ reading: null, flows: notStarted.flows, flowsReason: notStarted.reason });
  assert.equal(f.flows_in_cents.value, null);
  assert.match(f.flows_in_cents.reason, /money ledger/);

  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.equal(adaptRailFlows({ in: { settled: 1 } }).flows, null);
    assert.equal(adaptRailFlows(null).flows, null);
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
  // A direction the rails can't see is null, not 0, and an unknown total stays null too.
  const partial = adaptRailFlows({ measured: true, flows: { on_ramp: railDirection({ settled: tally(null) }), off_ramp: null, payout: null, deposit: null }, not_measured: { off_ramp: "no" } });
  assert.equal(partial.flows.in.settled, null);
  assert.equal(partial.flows.out.settled, null);
});

test("flows reach a real report with what they measure stated; a failure is logged and never read as zero", async () => {
  const calls = [];
  const { health, productId, provider, tickAt } = await setup({
    ledger: liveLedger,
    flows: async (...a) => {
      calls.push(a);
      return { measured: true, flows: { on_ramp: railDirection({ settled: tally(3_00) }), off_ramp: railDirection(), payout: null, deposit: null }, not_measured: { payout: "no payouts" } };
    },
  });
  await tickAt(T0 + 5 * 60_000);
  assert.equal(calls[0][0], productId);
  assert.ok(calls[0][1] instanceof Date);
  const r = (await health.get(provider.user, productId, null, 1)).latest.report;
  assert.equal(r.figures.flows_in_cents.value, 3_00);
  assert.match(r.flows_basis, /requested in this period/);
  assert.equal(r.flows_not_measured.payout, "no payouts");

  const original = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  try {
    const failing = await setup({ ledger: liveLedger, flows: async () => { throw new RangeError("flowsFor needs a valid from before to"); } });
    await failing.tickAt(T0 + 5 * 60_000);
    const report = (await failing.health.get(failing.provider.user, failing.productId, null, 1)).latest.report;
    assert.equal(report.figures.flows_in_cents.value, null);
    assert.match(report.figures.flows_in_cents.reason, /failed to answer/);
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((l) => /money rails failed/.test(l)));
});

test("a sandbox report never carries real flows", async () => {
  let called = 0;
  const { health, productId, provider, tickAt } = await setup({ flows: async () => { called++; return { measured: true, flows: { on_ramp: railDirection({ settled: tally(9_00) }), off_ramp: null, payout: null, deposit: null }, not_measured: {} }; } });
  await tickAt(T0 + 5 * 60_000);
  const r = (await health.get(provider.user, productId, null, 1)).latest.report;
  assert.equal(called, 0);
  assert.equal(r.source, "sandbox");
  assert.equal(r.figures.flows_in_cents.value, null);
  assert.match(r.figures.flows_in_cents.reason, /Sandbox/);
});

test("against the real money-rails module", async () => {
  const { store, pg, health, productId, provider, tickAt } = await setup({ ledger: liveLedger });
  const bound = await loadFlowsFor(store);
  assert.ok(bound, "flowsFor(store, productId, from, to) is what the module exports");
  const before = adaptRailFlows(await bound(productId, new Date(T0 - HOUR), new Date(T0)));
  assert.equal(before.flows, null);
  assert.match(before.reason, /ledger/);
  await store.setSetting("money_ledger_started_at", new Date(T0 - 2 * HOUR).toISOString(), null);
  await pg.query("ALTER TABLE financial_products.money_movements DROP CONSTRAINT IF EXISTS money_movements_rail_id_fkey");
  const insert = (status, direction, cents, sandbox = false) =>
    pg.query("INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, sponsor_entity_id, rail_id, direction, amount_cents, status, sandbox, created_at) VALUES (gen_random_uuid(), gen_random_uuid()::text, $1, $2, gen_random_uuid(), $3, $4, $5, $6, $7)", [productId, provider.entity.id, direction, cents, status, sandbox, new Date(T0 - 30 * 60_000)]);
  await insert("settled", "on_ramp", 10_00);
  await insert("requested", "on_ramp", 2_00);
  await insert("failed", "off_ramp", 50);
  await insert("settled", "on_ramp", 99_00, true); // sandbox: the rails leave it out
  await pg.query("INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, sponsor_entity_id, rail_id, direction, amount_cents, status, status_detail, created_at) VALUES (gen_random_uuid(), gen_random_uuid()::text, $1, $2, gen_random_uuid(), 'on_ramp', 700, 'failed', 'stale_no_answer', $3)", [productId, provider.entity.id, new Date(T0 - 30 * 60_000)]);
  const adapted = adaptRailFlows(await bound(productId, new Date(T0 - HOUR), new Date(T0)));
  assert.equal(adapted.flows.in.settled, 10_00);
  assert.equal(adapted.flows.in.pending, 2_00);
  assert.equal(adapted.flows.in.unresolved, 7_00);
  assert.equal(adapted.flows.in.failed, 0, "nobody answered: it isn't known to have failed");
  assert.equal(adapted.flows.out.failed, 50);
  const live = await ProductHealthService.open(health.db ?? { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, store, health.config, { chain: health.chain, flowsFor: bound, ledgerFor: () => liveLedger, now: () => new Date(T0 + 5 * 60_000) });
  await tickAt(T0 + 5 * 60_000, live);
  const figures = (await live.get(provider.user, productId, null, 1)).latest.report.figures;
  assert.equal(figures.flows_in_cents.value, 10_00);
  assert.equal(figures.requested_in_cents.value, 19_00);
  assert.equal(figures.unresolved_cents.value, 7_00);
});

// ---- entitlement (H1, H2, H3) ----

test("only the licence provider's own firm reads the numbers; builders, other firms and admins are refused", async () => {
  const { health, productId, provider, builder, stranger, admin, tool, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  assert.ok((await health.get(provider.user, productId, null, 5)).latest.report);
  for (const u of [builder.user, stranger.user, admin]) await assert.rejects(health.get(u, productId, null, 5), /aren't entitled/);

  const numbers = await tool(provider.user, "get_product_health", { product_id: productId });
  assert.equal(numbers.isError, false);
  assert.ok(numbers.data.latest.report.figures);
  assert.equal((await tool(admin, "get_product_health", { product_id: productId })).isError, true);
  const listed = await tool(admin, "list_product_health", { product_id: productId });
  assert.ok(listed.data[0].snapshots[0].fingerprint);
  const listedText = JSON.stringify(listed.data);
  for (const key of ['"figures":', '"report":', "reserves_cents", "obligations_cents", "coverage_bps"]) assert.equal(listedText.includes(key), false, key);
  assert.deepEqual((await tool(stranger.user, "list_product_health", { product_id: productId })).data, []);
  const toolNames = async (u) => (await tool(u, "list_product_health", {})).tools;
  assert.ok(!(await toolNames(builder.user)).includes("get_product_health"));
  assert.ok((await toolNames(provider.user)).includes("get_product_health"));
  assert.ok((await toolNames(admin)).includes("reanchor_product_health"));
  assert.ok(!(await toolNames(provider.user)).includes("reanchor_product_health"));
});

test("an admin who adds itself to a firm reaches neither the numbers, nor the firm's key, nor its signature", async () => {
  const { store, health, productId, provider, admin, tickAt } = await setup();
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  await store.setUserEntity(admin.id, provider.entity.id);
  admin.entity_id = provider.entity.id;
  await assert.rejects(health.get(admin, productId, null, 5), /aren't entitled/);
  await assert.rejects(health.registerSigningKey(admin, edKeyPair().address), /own member/);
  await assert.rejects(health.submitSignature(admin, productId, null, 1, key.sign(snap.fingerprint)), /Only the licence provider/);
  assert.equal(await health.signingKey(provider.entity.id), key.address);
});

test("withdrawing a sponsorship ends both reading and co-signing at once", async () => {
  const { store, health, productId, provider, sponsorship, tickAt } = await setup();
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  await store.decideSponsorship(sponsorship.id, { status: "revoked", decided_by: provider.user.id, note: "bad behaviour" });
  await assert.rejects(health.get(provider.user, productId, null, 5), /aren't entitled/);
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint)), /still sponsors/);
});

test("a second sponsor doesn't read the first sponsor's books, and a suspended firm reads nothing", async () => {
  const { store, health, productId, provider, stranger, sponsor, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  await sponsor(stranger);
  const seen = await health.get(stranger.user, productId, null, 5);
  assert.equal(seen.latest, null);
  assert.deepEqual(seen.history, []);
  assert.ok((await health.get(provider.user, productId, null, 5)).latest.report);
  await store.setEntityStatus(provider.entity.id, "suspended");
  await assert.rejects(health.get(provider.user, productId, null, 5), /aren't entitled/);
});

test("a liquidity provider on the list reads the numbers; the list decides, not the code", async () => {
  let lp;
  const s = await setup({ liquidityProvidersOf: async () => (lp ? [lp.entity.id] : []) });
  lp = await s.firm("Liquidity Fund", ["license_provider"]);
  await s.tickAt(T0 + 5 * 60_000);
  assert.equal((await s.health.entitlement(lp.user, s.productId)).as, "liquidity_provider");
  assert.ok((await s.health.get(lp.user, s.productId, null, 5)).latest.report);
});

// ---- verified means verified (B2), and stored flags can't forge it (B3) ----

test("verified is never true for a sandbox, unsigned or missed snapshot; integrity_ok is a separate claim", async () => {
  const sandbox = await setup({ config: { cosignWindowMs: 0 } });
  await sandbox.tickAt(T0 + 5 * 60_000);
  const s = (await sandbox.health.get(sandbox.provider.user, sandbox.productId, null, 1)).latest;
  assert.equal(s.verification.integrity_ok, true);
  assert.equal(s.verified, false);

  const unsigned = await setup({ ledger: liveLedger, config: { cosignWindowMs: 0 } });
  await unsigned.tickAt(T0 + 5 * 60_000);
  const u = (await unsigned.health.get(unsigned.provider.user, unsigned.productId, null, 1)).latest;
  assert.equal(u.live, true);
  assert.equal(u.attestation, "mynt_only");
  assert.equal(u.verified, false);

  await unsigned.tickAt(T0 + 3 * HOUR + 5 * 60_000); // an hour Mynt didn't compute
  const out = await unsigned.health.get(unsigned.provider.user, unsigned.productId, null, 10);
  const missed = out.history.find((h) => h.status === "missed");
  assert.equal(missed.verified, false);
  assert.equal(missed.report, null);
});

test("a co-signed live snapshot is verified, and only then", async () => {
  const { health, productId, provider, tickAt } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  await health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint));
  await tickAt(T0 + 6 * 60_000);
  const latest = (await health.get(provider.user, productId, null, 1)).latest;
  assert.equal(latest.verified, true);
  assert.equal(latest.verification.partner_signature_valid, true);
  // The key can be replaced later without unmaking what it signed.
  await health.registerSigningKey(provider.user, edKeyPair().address);
  assert.equal((await health.get(provider.user, productId, null, 1)).latest.verified, true);
});

test("a row altered to claim source, live or a co-signature gets nowhere", async () => {
  const { health, productId, provider, raw, pg, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  const [row] = await raw(`SELECT id, fingerprint FROM ${SNAPSHOTS}`);
  await pg.query(`UPDATE ${SNAPSHOTS} SET source = 'partner_ledger', live = true, attestation = 'partner_signed' WHERE id = $1`, [row.id]);
  let latest = (await health.get(provider.user, productId, null, 1)).latest;
  assert.equal(latest.source, "sandbox", "from the authenticated report");
  assert.equal(latest.live, false);
  assert.equal(latest.attestation, "mynt_only", "there's no signature behind the claim");
  assert.equal(latest.verified, false);
  assert.equal(latest.verification.on_chain, "mismatch", "the chain covers the source");

  // A signature from a key the firm never registered is reported as such.
  const forger = edKeyPair();
  await pg.query(`UPDATE ${SNAPSHOTS} SET source = 'sandbox', live = false, partner_key = $2, partner_signature = $3 WHERE id = $1`, [row.id, forger.address, forger.sign(row.fingerprint)]);
  latest = (await health.get(provider.user, productId, null, 1)).latest;
  assert.equal(latest.attestation, "invalid_signature");
  assert.equal(latest.verification.partner_signature_valid, false);
  assert.equal(latest.verification.integrity_ok, false);
  assert.equal(latest.verification.on_chain, "mismatch", "the chain covers the commitment");
  assert.equal(latest.verified, false);
});

test("snapshotStatus reads the assessment, not the row", () => {
  const row = { live: true, source: "partner_ledger", attestation: "partner_signed", status: "published", period_start: "2026-11-09T00:00:00Z", period_end: "2026-11-09T01:00:00Z", on_chain: true };
  const out = snapshotStatus(row, { report: null, report_matches: true, source: "sandbox", live: false, attestation: "partner_signed", signature_ok: true, on_chain: "matches" });
  assert.equal(out.live, false);
  assert.equal(out.verified, false);
});

test("tampering with a stored report fails verification, however it's done", async () => {
  const { raw, pg, health, productId, provider, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  const before = await health.get(provider.user, productId, null, 5);
  assert.equal(before.latest.verification.report_matches_fingerprint, true);
  assert.equal(before.latest.verification.on_chain, "matches");
  assert.equal(before.latest.verification.integrity_ok, true);

  const [row] = await raw(`SELECT id, report_sealed, fingerprint, subject, sequence FROM ${SNAPSHOTS}`);
  const parts = row.report_sealed.split(":");
  const ct = Buffer.from(parts[3], "base64");
  ct[0] ^= 1;
  await pg.query(`UPDATE ${SNAPSHOTS} SET report_sealed = $2 WHERE id = $1`, [row.id, [...parts.slice(0, 3), ct.toString("base64")].join(":")]);
  const tampered = await health.get(provider.user, productId, null, 5);
  assert.equal(tampered.latest.report, null);
  assert.equal(tampered.latest.verification.report_matches_fingerprint, false);
  assert.equal(tampered.latest.verification.integrity_ok, false);
  assert.equal(tampered.latest.source, "unknown");
  assert.match(tampered.latest.verification.detail, /doesn't match/);

  // Rewrite the report and its fingerprint so they agree, as someone with Mynt's own keys could. Mynt's record is
  // self-consistent, but it no longer matches what the chain holds.
  await pg.query(`UPDATE ${SNAPSHOTS} SET report_sealed = $2 WHERE id = $1`, [row.id, row.report_sealed]);
  const key = await health.dataKey(row.subject);
  const forged = canonicalJson({ forged: true });
  const newFp = fingerprintOf(forged);
  await pg.query(`UPDATE ${SNAPSHOTS} SET fingerprint = $2, report_sealed = $3 WHERE id = $1`, [row.id, newFp, sealReport(key, forged, row.subject, row.sequence, newFp)]);
  const rewritten = await health.get(provider.user, productId, null, 5);
  assert.equal(rewritten.latest.verification.report_matches_fingerprint, true);
  assert.equal(rewritten.latest.verification.on_chain, "mismatch");
  assert.equal(rewritten.latest.verification.integrity_ok, false);
  assert.throws(() => openReport(key, row.report_sealed, row.subject, row.sequence + 1, row.fingerprint));
});

test("a moved period is caught by the chain", async () => {
  const { raw, pg, health, productId, provider, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  const [row] = await raw(`SELECT id, period_start FROM ${SNAPSHOTS}`);
  await pg.query(`UPDATE ${SNAPSHOTS} SET period_start = $2 WHERE id = $1`, [row.id, new Date(new Date(row.period_start).getTime() - 60_000)]);
  assert.equal((await health.get(provider.user, productId, null, 5)).latest.verification.on_chain, "mismatch");
});

test("an on-chain check that can't run says unavailable, never that it matched", async () => {
  const { health, chain, productId, provider, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  chain.failing = true;
  const out = await health.get(provider.user, productId, null, 5);
  assert.equal(out.latest.verification.on_chain, "unavailable");
  assert.equal(out.latest.verification.integrity_ok, false);
  assert.match(out.chain.unavailable, /unreachable/);
});

// ---- the partner's co-signature (B5) ----

test("a bad partner signature is refused; a good one makes the snapshot partner_signed", async () => {
  const { health, productId, provider, stranger, chain, tickAt, set } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  assert.equal(snap.status, "pending_signature");
  assert.equal(chain.log.length, 0, "not published while waiting for the partner");

  const other = edKeyPair();
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, other.sign(snap.fingerprint)), /doesn't verify/);
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, key.sign("00".repeat(32))), /doesn't verify/);
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, "ab".repeat(64)), /doesn't verify/);
  // The fingerprint alone, without the domain, isn't what's signed.
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, key.signRaw(snap.fingerprint)), /doesn't verify/);
  await assert.rejects(health.submitSignature(stranger.user, productId, null, 1, key.sign(snap.fingerprint)), /Only the licence provider/);
  assert.equal((await firstSnapshot(health, provider.user, productId)).status, "pending_signature");

  await health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint));
  set(T0 + 6 * 60_000);
  await health.tick();
  const view = await firstSnapshot(health, provider.user, productId);
  assert.equal(view.status, "published");
  assert.equal(view.attestation, "partner_signed");
  assert.equal(view.verified, true);
  assert.equal(chain.log[0].partner_signed, true);
  assert.equal(Buffer.from(chain.log[0].fingerprint).toString("hex"), snap.fingerprint);
});

test("with no signature by the deadline it publishes as mynt_only and says so; a late signature is refused", async () => {
  const { health, productId, provider, chain, tickAt, set } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  assert.equal(chain.log.length, 0);
  const pending = await firstSnapshot(health, provider.user, productId);
  // Past the window but before any tick: the signature would land in Mynt's record and miss the chain.
  set(T0 + 16 * 60_000);
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, key.sign(pending.fingerprint)), /window .* has closed/);
  await health.tick();
  const view = await firstSnapshot(health, provider.user, productId);
  assert.equal(view.status, "published");
  assert.equal(view.attestation, "mynt_only");
  assert.equal(view.live, true);
  assert.equal(view.verified, false);
  assert.match(view.notes.join(" "), /co-signature/);
  assert.equal(chain.log[0].partner_signed, false);
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, key.sign(view.fingerprint)), /it can only be co-signed/);
});

test("a co-signature that lands while the worker holds a stale row still goes on chain", async () => {
  const { health, productId, provider, chain, raw, tickAt, set } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const [stale] = await raw(`SELECT * FROM ${SNAPSHOTS}`);
  const snap = await firstSnapshot(health, provider.user, productId);
  await health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint));
  set(T0 + 16 * 60_000);
  assert.equal(stale.status, "pending_signature");
  assert.equal(await health.publishRow(stale, new Date(T0 + 16 * 60_000)), true);
  assert.equal(chain.log[0].partner_signed, true);
  assert.ok(Buffer.from(chain.log[0].partner_commitment).some((b) => b !== 0));
});

test("an account that's an admin is refused even with the licence-provider role and a seat at the firm", async () => {
  const { store, health, productId, provider, tickAt } = await setup();
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  const { user: both } = await store.createUser("Both", ["admin", "license_provider"]);
  await store.setUserEntity(both.id, provider.entity.id);
  both.entity_id = provider.entity.id;
  await assert.rejects(health.get(both, productId, null, 5), /aren't entitled/);
  await assert.rejects(health.registerSigningKey(both, edKeyPair().address), /own member/);
  await assert.rejects(health.submitSignature(both, productId, null, 1, key.sign(snap.fingerprint)), /Only the licence provider/);
});

test("a key written straight into the history table counts for nothing", async () => {
  const { health, pg, productId, provider, raw, tickAt } = await setup({ ledger: liveLedger });
  const real = edKeyPair();
  await health.registerSigningKey(provider.user, real.address);
  await tickAt(T0 + 5 * 60_000);
  const [row] = await raw(`SELECT id, fingerprint FROM ${SNAPSHOTS}`);
  const planted = edKeyPair();
  await pg.query("INSERT INTO financial_products.product_health_signing_key_history (entity_id, public_key, mac) VALUES ($1, $2, $3)", [provider.entity.id, planted.address, "00".repeat(32)]);
  await pg.query(`UPDATE ${SNAPSHOTS} SET partner_key = $2, partner_signature = $3 WHERE id = $1`, [row.id, planted.address, planted.sign(row.fingerprint)]);
  const latest = (await health.get(provider.user, productId, null, 1)).latest;
  assert.equal(latest.attestation, "invalid_signature");
  assert.equal(latest.verification.partner_signature_valid, false);
  // Nor can the current key be swapped under the firm.
  await pg.query("UPDATE financial_products.product_health_signing_keys SET public_key = $2 WHERE entity_id = $1", [provider.entity.id, planted.address]);
  assert.equal(await health.signingKey(provider.entity.id), null);
});

test("readers get what they need to check the signature and find the head; the list never carries it", async () => {
  const { health, productId, provider, chain, tickAt, tool } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  const signature = key.sign(snap.fingerprint);
  await health.submitSignature(provider.user, productId, null, 1, signature);
  await tickAt(T0 + 6 * 60_000);
  const out = await health.get(provider.user, productId, null, 1);
  assert.equal(out.latest.partner_key, key.address);
  assert.equal(out.latest.partner_signature, signature);
  assert.equal(out.chain.subject, Buffer.from(health.subjectOf(productId, null)).toString("hex"));
  assert.equal(out.chain.head_address, chainLib.headAddress(chain.programId, health.subjectOf(productId, null)));
  const listed = JSON.stringify((await tool(provider.user, "list_product_health", { product_id: productId })).data);
  for (const field of ['"subject"', "head_address", "partner_key", "partner_signature", key.address, signature]) assert.equal(listed.includes(field), false, field);
});

test("an entitled reader can verify a snapshot with the standalone script, and a forgery fails it", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  await health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint));
  await tickAt(T0 + 6 * 60_000);
  const first = await health.get(provider.user, productId, null, 5);
  await tickAt(T0 + HOUR + 5 * 60_000); // a second record, so the first is an older one
  await tickAt(T0 + HOUR + 20 * 60_000); // past its co-signing window, so it's on chain
  const later = await firstHistoryWithTwo(health, provider.user, productId);
  const headOf = (h) => {
    const data = Buffer.alloc(chainLib.HEAD_SIZE);
    Buffer.from(anchorDiscriminator("account", "Head")).copy(data, 0);
    Buffer.from(h.subject).copy(data, 8);
    data.writeBigUInt64LE(BigInt(h.sequence), 40);
    Buffer.from(h.fingerprint).copy(data, 48);
    data.writeBigInt64LE(BigInt(h.period_start), 80);
    data.writeBigInt64LE(BigInt(h.period_end), 88);
    data[96] = h.kind;
    data[97] = h.source;
    data[98] = h.partner_signed ? 1 : 0;
    Buffer.from(h.partner_commitment).copy(data, 99);
    return data;
  };
  const SOURCE = Object.fromEntries(Object.entries(chainLib.SOURCE_FLAG).map(([k, v]) => [v, k]));
  const wireOf = (ixs) => {
    const payer = Keypair.generate();
    const message = compileMessage(payer.address, ixs(payer.address), base58Encode(randomBytes(32)));
    return Buffer.from(serializeTransaction(message, new Map())).toString("base64");
  };
  const record = (h) => (payer) => [chainLib.healthIx.recordSnapshot(PROGRAM_ID, payer, h.subject, { sequence: h.sequence, fingerprint: h.fingerprint, period_start: h.period_start, period_end: h.period_end, source: SOURCE[h.source], partner_commitment: h.partner_signed ? h.partner_commitment : null })];
  // A stand-in RPC serving whatever the case needs.
  const world = { head: chain.log[0], owner: PROGRAM_ID, account: null, tx: null };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, id, params } = JSON.parse(body);
      let result;
      if (method === "getAccountInfo") {
        const expected = chainLib.headAddress(PROGRAM_ID, world.head.subject);
        const data = world.account ?? headOf(world.head);
        result = { value: params[0] === expected ? { owner: world.owner, data: [data.toString("base64"), "base64"] } : null };
      } else if (method === "getTransaction") result = { meta: { err: null }, transaction: [world.tx, "base64"] };
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "health-verify-"));
  const run = async (doc, flags) => {
    const file = join(dir, "answer.json");
    writeFileSync(file, JSON.stringify(doc, null, 2));
    const script = new URL("../scripts/product-health-verify.mjs", import.meta.url).pathname;
    return new Promise((resolve) => execFile(process.execPath, [script, "--file", file, "--rpc", `http://127.0.0.1:${server.address().port}`, ...flags], (error, stdout) => resolve({ code: error ? error.code : 0, stdout })));
  };
  const full = ["--program-id", PROGRAM_ID, "--partner-key", key.address];
  try {
    const good = await run(first, full);
    assert.equal(good.code, 0, good.stdout);
    assert.match(good.stdout, /OVERALL PASS/);
    for (const line of [/PASS {2}report hashes/, /PASS {2}partner signature/, /PASS {2}fingerprint matches/, /PASS {2}partner commitment/, /PASS {2}it's a Head account/]) assert.match(good.stdout, line);

    // The program id has to come from outside the file.
    assert.equal((await run(first, [])).code, 2);

    const forged = JSON.parse(JSON.stringify(first));
    forged.latest.report.figures.reserves_cents.value += 1;
    const bad = await run(forged, full);
    assert.equal(bad.code, 1);
    assert.match(bad.stdout, /FAIL {2}report hashes/);

    // Without the reader's own key nothing counts as a pass.
    const noKey = await run(first, ["--program-id", PROGRAM_ID]);
    assert.equal(noKey.code, 3, noKey.stdout);
    assert.match(noKey.stdout, /NOT independently checked/);
    assert.doesNotMatch(noKey.stdout, /OVERALL PASS/);

    const wrongKey = await run(first, ["--program-id", PROGRAM_ID, "--partner-key", edKeyPair().address]);
    assert.equal(wrongKey.code, 1);
    assert.match(wrongKey.stdout, /FAIL {2}the signature is under the key you named/);

    // A made-up program: the file agrees with itself, the reader's program id doesn't agree with the chain.
    const fabricated = JSON.parse(JSON.stringify(first));
    fabricated.chain.program_id = "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME";
    world.owner = fabricated.chain.program_id;
    const madeUp = await run(fabricated, full);
    assert.equal(madeUp.code, 1);
    assert.match(madeUp.stdout, /FAIL {2}head account is owned by the program/);
    world.owner = PROGRAM_ID;

    const pointedElsewhere = JSON.parse(JSON.stringify(first));
    pointedElsewhere.chain.head_address = PROGRAM_ID;
    assert.equal((await run(pointedElsewhere, full)).code, 1);

    world.account = Buffer.from(headOf(world.head));
    world.account[0] ^= 1;
    const notAHead = await run(first, full);
    assert.equal(notAHead.code, 1);
    assert.match(notAHead.stdout, /FAIL {2}it's a Head account/);
    world.account = null;

    // An older record, looked up by its transaction.
    world.head = chain.log[1];
    world.tx = wireOf(record(chain.log[0]));
    const older = await run(later, [...full, "--sequence", "1"]);
    assert.equal(older.code, 0, older.stdout);
    assert.match(older.stdout, /PASS {2}it's this fingerprint/);

    // A memo carrying the fingerprint's bytes isn't a record of it.
    world.tx = wireOf(() => [{ programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", keys: [], data: chain.log[0].fingerprint }]);
    const memo = await run(later, [...full, "--sequence", "1"]);
    assert.equal(memo.code, 1);
    assert.match(memo.stdout, /FAIL {2}the transaction has a record_snapshot/);

    // A versioned message is refused, never read one byte off as if it were legacy.
    const legacy = Buffer.from(wireOf(record(chain.log[0])), "base64");
    const messageAt = 1 + 64 * legacy[0];
    world.tx = Buffer.concat([legacy.subarray(0, messageAt), Buffer.from([0x80]), legacy.subarray(messageAt)]).toString("base64");
    const versioned = await run(later, [...full, "--sequence", "1"]);
    assert.equal(versioned.code, 1, versioned.stdout);
    assert.match(versioned.stdout, /FAIL {2}the snapshot's transaction is a legacy transaction/);
    assert.doesNotMatch(versioned.stdout, /PASS {2}it's this fingerprint/);

    // A record_snapshot of another record, or a head other than this one, doesn't count either.
    world.tx = wireOf(record(chain.log[1]));
    const another = await run(later, [...full, "--sequence", "1"]);
    assert.equal(another.code, 1);
    assert.match(another.stdout, /FAIL {2}it's this sequence/);

    assert.equal((await run(later, [...full, "--sequence", "1", "--epoch", "9"])).code, 2, "an epoch this file doesn't hold");
  } finally {
    server.close();
  }
});

test("the signing key must be a usable Ed25519 key of a licence provider firm", async () => {
  const { health, builder, provider } = await setup();
  await assert.rejects(health.registerSigningKey(builder.user, edKeyPair().address), /Only a licence provider/);
  await assert.rejects(health.registerSigningKey(provider.user, "not-a-key"), /Ed25519/);
  const [pda] = findProgramAddress([Buffer.from("x")], PROGRAM_ID);
  await assert.rejects(health.registerSigningKey(provider.user, pda), /Ed25519/);
  for (const hex of [
    "0100000000000000000000000000000000000000000000000000000000000000", // the identity
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", // order 2
    "0000000000000000000000000000000000000000000000000000000000000000", // order 4
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05", // order 8
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a", // order 8
  ]) {
    const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
    assert.equal(isWeakEd25519Key(bytes), true, hex);
    await assert.rejects(health.registerSigningKey(provider.user, base58Encode(bytes)), /Ed25519/, hex);
  }
  assert.equal(isWeakEd25519Key(Keypair.generate().publicKey), false);
});

// ---- sandbox ----

test("a sandbox snapshot of a published product never reads as live or verified, even when co-signed", async () => {
  const { health, productId, provider, chain, tickAt } = await setup();
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  await health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint));
  await tickAt(T0 + 6 * 60_000);
  const view = await firstSnapshot(health, provider.user, productId);
  assert.equal(view.source, "sandbox");
  assert.equal(view.attestation, "partner_signed");
  assert.equal(view.live, false);
  assert.equal(view.verified, false);
  assert.match(view.notes.join(" "), /Sandbox/);
  assert.equal(chain.log[0].source, chainLib.SOURCE_FLAG.sandbox);
});

test("partner_ledger means a ledger that says it's live; anything else counts as sandbox", async () => {
  const { health, productId, provider, tickAt } = await setup({ ledger: { ...liveLedger, kind: "experimental" } });
  await tickAt(T0 + 5 * 60_000);
  assert.equal((await health.get(provider.user, productId, null, 1)).latest.report.source, "sandbox");
});

// ---- gaps and stalls (B4, H4) ----

test("sequence numbers are gapless, and a stretch with no snapshot is recorded as missed", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  await tickAt(T0 + HOUR + 5 * 60_000);
  await tickAt(T0 + 6 * HOUR + 5 * 60_000);
  const out = await health.get(provider.user, productId, null, 50);
  assert.deepEqual(out.history.map((h) => h.sequence).reverse(), [1, 2, 3, 4]);
  assert.deepEqual(chain.log.map((l) => l.sequence), [1, 2, 3, 4]);
  const missed = out.history.find((h) => h.status === "missed");
  assert.equal(missed.sequence, 3);
  assert.equal(chain.log[2].kind, chainLib.KIND_MISSED);
  assert.ok(out.gaps.some((g) => g.kind === "missed" && g.sequence === 3));
  assert.equal(out.latest.verification.on_chain, "matches", "a recorded miss keeps the chain whole");
});

test("while the chain can't be read nothing is marked missed; once it can, the record catches up in order", async () => {
  const { health, productId, provider, chain, tickAt, db } = await setup({ config: { cosignWindowMs: 0 } });
  chain.failing = true;
  await tickAt(T0 + 5 * 60_000);
  let [view] = await health.listFor(provider.user, productId, 5);
  assert.equal(view.snapshots[0].status, "ready");
  await tickAt(T0 + 2 * HOUR + 5 * 60_000); // past snapshot 1's deadline; the hour with no tick is itself a miss
  [view] = await health.listFor(provider.user, productId, 5);
  assert.equal(view.snapshots.find((s) => s.sequence === 1).status, "ready", "the chain wasn't readable, so it can't be called missed");
  assert.equal(chain.log.length, 0);
  assert.match((await opsStatus(db, { backupStatusFile: "/nonexistent" })).attention.join("\n"), /past their deadline/);
  chain.failing = false;
  await tickAt(T0 + 2 * HOUR + 10 * 60_000);
  [view] = await health.listFor(provider.user, productId, 5);
  assert.deepEqual(chain.log.map((l) => [l.sequence, l.kind]), [[1, chainLib.KIND_MISSED], [2, chainLib.KIND_MISSED], [3, chainLib.KIND_SNAPSHOT]]);
  assert.match(view.snapshots.find((s) => s.sequence === 1).notes.join(" "), /Couldn't publish before the deadline/);
  assert.ok(view.gaps.some((g) => g.kind === "missed" && g.sequence === 2));
});

test("a snapshot that landed unseen is adopted, even past its deadline after the RPC went down", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  const original = chain.publishSnapshot.bind(chain);
  chain.publishSnapshot = async (...a) => {
    await original(...a); // it lands, but Mynt hears a timeout
    throw new Error("Transaction wasn't confirmed in time");
  };
  await tickAt(T0 + 5 * 60_000);
  chain.publishSnapshot = original;
  chain.failing = true;
  await tickAt(T0 + 90 * 60_000); // down, and past the deadline
  chain.failing = false;
  await tickAt(T0 + 2 * HOUR + 5 * 60_000);
  const view = await firstSnapshot(health, provider.user, productId);
  assert.equal(view.status, "published");
  assert.equal(view.on_chain, true);
  assert.equal(view.tx_signature, "recovered-transaction", "the transaction is recovered, so a reader can look it up");
  assert.equal(chain.log.filter((l) => l.sequence === 1).length, 1);
});

test("a transaction that landed but isn't recorded yet is pending, not a tamper alarm", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  const original = chain.publishSnapshot.bind(chain);
  chain.publishSnapshot = async (...a) => {
    await original(...a);
    throw new Error("Transaction wasn't confirmed in time");
  };
  await tickAt(T0 + HOUR + 5 * 60_000);
  const out = await health.get(provider.user, productId, null, 5);
  assert.equal(out.history.find((h) => h.sequence === 2).verification.on_chain, "pending");
  assert.equal(out.history.find((h) => h.sequence === 1).verification.on_chain, "matches");
  assert.ok(!out.gaps.some((g) => g.kind === "chain_ahead"));
});

test("changing the interval never produces an overlapping period", async () => {
  const s = await setup({ config: { cosignWindowMs: 0 } });
  await s.tickAt(T0 + 5 * 60_000); // an hour-long period ending at T0
  const quarterly = await s.make({ ...s.fullConfig, intervalMs: 15 * 60_000 });
  await s.tickAt(T0 + 17 * 60_000, quarterly); // now periods end on the quarter hour
  const threeHourly = await s.make({ ...s.fullConfig, intervalMs: 3 * HOUR });
  await s.tickAt(T0 + 3 * HOUR + 5 * 60_000, threeHourly);
  const out = await s.health.get(s.provider.user, s.productId, null, 10);
  const rows = out.history.slice().reverse();
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].period_start, rows[i - 1].period_end);
  assert.ok(s.chain.log.length >= 3);
  assert.equal(out.latest.verification.on_chain, "matches");
});

test("after a chain reset the record stalls in the open, and an admin re-anchors it", async () => {
  const { health, productId, provider, admin, builder, chain, db, tool, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  await assert.rejects(health.reanchor(admin, productId, null, "the chain looks fine"), /still holds/);
  chain.heads.clear(); // devnet was reset
  let [view] = await health.listFor(admin, productId, 5);
  assert.ok(view.gaps.some((g) => g.kind === "chain_behind"), "a missing head is chain_behind");
  await tickAt(T0 + HOUR + 5 * 60_000);
  [view] = await health.listFor(admin, productId, 5);
  assert.ok(view.gaps.some((g) => g.kind === "stalled"));
  assert.equal(chain.log.length, 1);
  assert.match((await opsStatus(db, { backupStatusFile: "/nonexistent" })).attention.join("\n"), /stalled/);

  await assert.rejects(health.reanchor(builder.user, productId, null, "not an admin here"), /Only an admin/);
  const done = await tool(admin, "reanchor_product_health", { product_id: productId, reason: "devnet was reset" });
  assert.equal(done.isError, false);
  assert.equal(done.data.next_sequence, 1);
  await tickAt(T0 + 2 * HOUR + 5 * 60_000);
  const out = await health.get(provider.user, productId, null, 10);
  assert.equal(out.latest.sequence, 1);
  assert.equal(out.latest.epoch, 1);
  assert.equal(out.latest.verification.on_chain, "matches");
  assert.equal(out.history.find((h) => h.epoch === 0 && h.sequence === 1).verification.on_chain, "previous_chain_unverifiable", "the old chain is gone, so nothing vouches for it");
  assert.ok(out.gaps.some((g) => g.kind === "re_anchored" && /gone/.test(g.detail)));
  assert.doesNotMatch((await opsStatus(db, { backupStatusFile: "/nonexistent" })).attention.join("\n"), /stalled/);
});

test("a tampered record can't be re-anchored away, and a disagreeing head isn't advertised as re-anchorable", async () => {
  const { store, health, productId, provider, admin, chain, raw, pg, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  const [row] = await raw(`SELECT id, fingerprint FROM ${SNAPSHOTS}`);
  await pg.query(`UPDATE ${SNAPSHOTS} SET fingerprint = $2 WHERE id = $1`, [row.id, "ab".repeat(32)]);
  assert.equal((await health.get(provider.user, productId, null, 5)).latest.verification.on_chain, "mismatch");
  await assert.rejects(health.reanchor(admin, productId, null, "hide what happened"), /still holds/);
  const refusals = await raw("SELECT action FROM financial_products.audit_log WHERE action = 'reanchor_product_health_refused'");
  assert.equal(refusals.length, 1);
  assert.equal((await health.get(provider.user, productId, null, 5)).latest.epoch, 0);
  // Next period, the row disagrees with the head: stalled, with no advice to re-anchor.
  await pg.query(`UPDATE ${SNAPSHOTS} SET on_chain = false, status = 'ready', publish_deadline = NULL WHERE id = $1`, [row.id]);
  await tickAt(T0 + HOUR + 5 * 60_000);
  const [view] = await health.listFor(admin, productId, 5);
  const stall = view.gaps.find((g) => g.kind === "stalled");
  assert.ok(stall);
  assert.match(stall.detail, /needs investigating/);
  assert.doesNotMatch(stall.detail, /can re-anchor/);
  assert.ok(chain.log.length >= 1);
  await assert.rejects(health.reanchor(admin, productId, null, "x".repeat(501)), /10 to 500/);
  assert.ok(store);
});

test("a missing head with transaction history wasn't a reset, and a history that can't be read refuses too", async () => {
  const { health, productId, admin, chain, raw, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  chain.heads.clear();
  chain.historyExists = true;
  await assert.rejects(health.reanchor(admin, productId, null, "claims a chain reset"), /wasn't reset/);
  chain.historyExists = false;
  chain.historyFails = true;
  await assert.rejects(health.reanchor(admin, productId, null, "claims a chain reset"), /history can't be read/);
  chain.historyFails = false;
  assert.equal((await raw("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'reanchor_product_health_refused'"))[0].n, 2);
  await health.reanchor(admin, productId, null, "devnet was reset");
});

test("a row added under a stale epoch is refused, so a re-anchor can't be raced", async () => {
  const { health, productId, admin, chain, raw, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  chain.heads.clear();
  await health.reanchor(admin, productId, null, "devnet was reset");
  // The worker read the epoch just before the re-anchor.
  health.currentEpoch = async () => 0;
  await tickAt(T0 + HOUR + 5 * 60_000);
  assert.equal((await raw(`SELECT count(*)::int AS n FROM ${SNAPSHOTS}`))[0].n, 1, "nothing was written under the old epoch");
  assert.ok(productId);
});

test("an anchor changed outside Mynt reads as a mismatch, is shown, and blocks re-anchoring", async () => {
  const { health, productId, provider, admin, chain, pg, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  chain.programId = "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME";
  await health.reanchor(admin, productId, null, "moved to a new program");
  await tickAt(T0 + HOUR + 5 * 60_000);
  await pg.query("UPDATE financial_products.product_health_anchors SET prev_verdict = 'gone' WHERE epoch = 1");
  const out = await health.get(provider.user, productId, null, 5);
  const old = out.history.find((h) => h.epoch === 0 && h.sequence === 1);
  assert.equal(old.verification.on_chain, "previous_chain_mismatch");
  assert.ok(out.gaps.some((g) => g.kind === "stalled" && /integrity check/.test(g.detail)));
  chain.heads.clear();
  await assert.rejects(health.reanchor(admin, productId, null, "another try"), /integrity check/);
});

test("a head one ahead when the old program is retired is saved as of Mynt's last record, not as tampering", async () => {
  const { health, productId, provider, admin, chain, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  const original = chain.publishSnapshot.bind(chain);
  chain.publishSnapshot = async (...a) => {
    await original(...a); // lands, unseen
    throw new Error("Transaction wasn't confirmed in time");
  };
  await tickAt(T0 + HOUR + 5 * 60_000);
  chain.publishSnapshot = original;
  chain.programId = "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME";
  assert.equal((await health.reanchor(admin, productId, null, "moved to a new program")).previous_record, "matches");
  await tickAt(T0 + 2 * HOUR + 5 * 60_000);
  const out = await health.get(provider.user, productId, null, 10);
  assert.equal(out.history.find((h) => h.epoch === 0 && h.sequence === 1).verification.on_chain, "previous_chain_matched");
});

test("moving to a new program keeps the old record's verdict, and tampering with it afterwards shows", async () => {
  const { health, productId, provider, admin, chain, raw, pg, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  chain.programId = "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME";
  const done = await health.reanchor(admin, productId, null, "moved to a new program");
  assert.equal(done.previous_record, "matches");
  await tickAt(T0 + HOUR + 5 * 60_000);
  let out = await health.get(provider.user, productId, null, 5);
  const old = () => out.history.find((h) => h.epoch === 0 && h.sequence === 1);
  assert.equal(old().verification.on_chain, "previous_chain_matched");
  assert.equal(old().verification.integrity_ok, false, "only the current chain can vouch for integrity");
  const [{ program_id, prev_head_sequence, prev_head_chain }] = await raw("SELECT program_id, prev_head_sequence, prev_head_chain FROM financial_products.product_health_anchors WHERE epoch = 1");
  assert.equal(program_id, chain.programId);
  assert.equal(prev_head_sequence, 1);
  assert.equal(prev_head_chain.length, 64);
  await pg.query(`UPDATE ${SNAPSHOTS} SET fingerprint = $1 WHERE epoch = 0`, ["cd".repeat(32)]);
  out = await health.get(provider.user, productId, null, 5);
  assert.equal(old().verification.on_chain, "previous_chain_mismatch");
});

test("holes in an earlier record stay visible after a re-anchor, and the overdue count is the current record's", async () => {
  const { health, productId, admin, chain, db, raw, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  await tickAt(T0 + 4 * HOUR + 5 * 60_000); // a stretch Mynt missed
  chain.heads.clear();
  await health.reanchor(admin, productId, null, "devnet was reset");
  await tickAt(T0 + 5 * HOUR + 5 * 60_000);
  const [view] = await health.listFor(admin, productId, 10);
  assert.ok(view.gaps.some((g) => g.kind === "missed" && g.sequence === 2));
  const old = await raw(`SELECT count(*)::int AS n FROM ${SNAPSHOTS} WHERE epoch = 0 AND NOT on_chain`);
  assert.equal(old[0].n, 0, "this history was on chain");
  const report = await opsStatus(db, { backupStatusFile: "/nonexistent" });
  assert.equal(report.product_health.overdue, 0);
});

test("a stale old-epoch row doesn't count as overdue", async () => {
  const { health, productId, admin, chain, db, pg, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  chain.failing = true;
  await tickAt(T0 + 5 * 60_000);
  chain.failing = false;
  await tickAt(T0 + HOUR + 5 * 60_000);
  chain.heads.clear();
  await health.reanchor(admin, productId, null, "devnet was reset");
  await pg.query(`INSERT INTO ${SNAPSHOTS} (id, subject, epoch, product_id, sequence, period_start, period_end, status, source, publish_deadline) SELECT gen_random_uuid(), subject, 0, product_id, 99, now() - interval '2 hours', now() - interval '1 hour', 'ready', 'sandbox', now() - interval '1 minute' FROM ${SNAPSHOTS} LIMIT 1`);
  assert.equal((await opsStatus(db, { backupStatusFile: "/nonexistent" })).product_health.overdue, 0);
  assert.ok(productId);
});

test("a record with a sponsored product and no rows shows no_record to its reader too; a landing marker is pending", async () => {
  const { health, productId, provider } = await setup();
  assert.ok((await health.get(provider.user, productId, null, 5)).gaps.some((g) => g.kind === "no_record"));
  const row = { sequence: 2, period_start: new Date(T0), period_end: new Date(T0 + HOUR), status: "missed", on_chain: false, missed_reason: "x", fingerprint: null };
  const earlier = { sequence: 1, period_start: new Date(T0 - HOUR), period_end: new Date(T0), status: "published", on_chain: true, missed_reason: null };
  const gaps = findGaps([earlier, row], { sequence: 2, kind: chainLib.KIND_MISSED, fingerprint: new Uint8Array(32) }, new Date(T0 + HOUR), HOUR);
  assert.ok(!gaps.some((g) => g.kind === "chain_ahead"));
});

test("the interval is capped", () => {
  assert.equal(productHealthConfigFromEnv({ PRODUCT_HEALTH_INTERVAL_MINUTES: "999999" }).intervalMs, 24 * HOUR);
  assert.equal(productHealthConfigFromEnv({}).intervalMs, HOUR);
});

test("findGaps sees a missed record, a broken sequence, a stretch of nothing and a stale record", () => {
  const row = (sequence, start, end, status = "published", on_chain = true) => ({ sequence, period_start: new Date(start), period_end: new Date(end), status, on_chain, missed_reason: status === "missed" ? "no snapshot" : null });
  const gaps = findGaps([row(1, T0, T0 + HOUR), row(2, T0 + HOUR, T0 + 2 * HOUR, "missed", false), row(4, T0 + 3 * HOUR, T0 + 4 * HOUR)], { sequence: 6, fingerprint: new Uint8Array(32) }, new Date(T0 + 7 * HOUR), HOUR);
  assert.deepEqual(gaps.map((g) => g.kind).sort(), ["chain_ahead", "missed", "overdue", "period_gap", "sequence_gap"].sort());
});

test("the chain behind Mynt's own record is a gap, a missing head too, and an unreadable chain claims nothing", () => {
  const row = { sequence: 3, period_start: new Date(T0), period_end: new Date(T0 + HOUR), status: "published", on_chain: true, missed_reason: null };
  assert.ok(findGaps([row], { sequence: 2, fingerprint: new Uint8Array(32) }, new Date(T0 + HOUR), HOUR).some((g) => g.kind === "chain_behind"));
  assert.ok(findGaps([row], null, new Date(T0 + HOUR), HOUR).some((g) => g.kind === "chain_behind"));
  assert.ok(!findGaps([row], null, new Date(T0 + HOUR), HOUR, false).some((g) => g.kind === "chain_behind"));
});

test("a sponsored product with no record shows as a gap, and a worker that never runs is flagged", async () => {
  const { health, productId, admin, db, tickAt } = await setup();
  const [view] = await health.listFor(admin, productId, 5);
  assert.deepEqual(view.snapshots, []);
  assert.ok(view.gaps.some((g) => g.kind === "no_record"));
  assert.match((await opsStatus(db, { backupStatusFile: "/nonexistent" })).attention.join("\n"), /has never run/);
  await tickAt(Date.now());
  assert.doesNotMatch((await opsStatus(db, { backupStatusFile: "/nonexistent" })).attention.join("\n"), /has never run/);
});

// ---- the publisher ----

const anySigner = Keypair.generate();

test("the publisher key signs the product-health program's instructions and nothing else", async () => {
  const { HealthPublisher, healthIx, subjectKey } = chainLib;
  const key = Keypair.generate();
  const publisher = new HealthPublisher(key, PROGRAM_ID);
  const blockhash = base58Encode(randomBytes(32));
  const subject = subjectKey(randomBytes(32), "p1", null);
  const entry = { sequence: 1, fingerprint: new Uint8Array(32).fill(7), period_start: 1, period_end: 2, source: "sandbox", partner_commitment: null };
  const legal = compileMessage(key.address, [healthIx.openSubject(PROGRAM_ID, key.address, subject), healthIx.recordSnapshot(PROGRAM_ID, key.address, subject, entry)], blockhash);
  assert.equal((await publisher.sign(legal.bytes)).length, 64);
  const init = compileMessage(key.address, [healthIx.initialize(PROGRAM_ID, key.address, anySigner.address, base58Encode(randomBytes(32)))], blockhash);
  assert.equal((await publisher.sign(init.bytes)).length, 64);

  const { system } = await import("../dist/solana/tx.js");
  const transfer = compileMessage(key.address, [system.transfer(key.address, anySigner.address, 1)], blockhash);
  await assert.rejects(publisher.sign(transfer.bytes), /won't sign an instruction to/);
  const mixed = compileMessage(key.address, [healthIx.recordSnapshot(PROGRAM_ID, key.address, subject, entry), system.transfer(key.address, anySigner.address, 1)], blockhash);
  await assert.rejects(publisher.sign(mixed.bytes), /won't sign an instruction to/);
  const otherProgram = compileMessage(key.address, [healthIx.recordSnapshot("EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME", key.address, subject, entry)], blockhash);
  await assert.rejects(publisher.sign(otherProgram.bytes), /won't sign an instruction to/);
  const wrongDiscriminator = compileMessage(key.address, [{ programId: PROGRAM_ID, keys: [{ pubkey: key.address, isSigner: true, isWritable: true }], data: anchorDiscriminator("global", "close_everything") }], blockhash);
  await assert.rejects(publisher.sign(wrongDiscriminator.bytes), /own instructions/);
  const notPayer = compileMessage(anySigner.address, [healthIx.recordSnapshot(PROGRAM_ID, key.address, subject, entry)], blockhash);
  await assert.rejects(publisher.sign(notPayer.bytes), /pays for/);
  await assert.rejects(publisher.sign(Uint8Array.of(1, 2, 3)), /can read/);
  assert.equal(JSON.stringify(publisher).includes(Buffer.from(key.secret()).toString("hex")), false);
});

test("the faucet is asked only below the low-water mark, and then for enough to last", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  let balance = 6_000_000;
  const airdrops = [];
  const rpc = {
    async call(method, params) {
      if (method === "getGenesisHash") return GENESIS_HASH.devnet;
      if (method === "getBalance") return { value: balance };
      if (method === "requestAirdrop") {
        airdrops.push(params[1]);
        balance += params[1];
        return "sig";
      }
      if (method === "getSignatureStatuses") return { value: [{ err: null, confirmationStatus: "confirmed" }] };
      if (method === "getSignaturesForAddress") return [{ signature: "failed", err: { x: 1 } }, { signature: "someone-elses", err: null }, { signature: "ours", err: null }];
      if (method === "getTransaction") return { meta: { err: null }, transaction: [Buffer.from(params[0] === "ours" ? "...record-bytes..." : "something else").toString("base64"), "base64"] };
      throw new Error(`unexpected ${method}`);
    },
  };
  const solana = await SolanaService.open(db, store, { rpcUrls: { devnet: "https://example.invalid", mainnet: null }, confirmTimeoutMs: 1000, pollMs: 1 }, { rpc: () => rpc, custody: null });
  await solana.topUpHealthPublisher(anySigner.address, 5_000_000, 20_000_000);
  assert.deepEqual(airdrops, []);
  balance = 1_000_000;
  await solana.topUpHealthPublisher(anySigner.address, 5_000_000, 20_000_000);
  assert.deepEqual(airdrops, [19_000_000]);
  // A recovered transaction must carry this record's own bytes, not just be the newest on the head.
  const chain = new SolanaHealthChain(solana, PROGRAM_ID);
  assert.equal(await chain.latestRecordTx(new Uint8Array(32), Buffer.from("record-bytes")), "ours");
  assert.equal(await chain.latestRecordTx(new Uint8Array(32), Buffer.from("not there")), null);
  assert.equal(await chain.hasHeadHistory(new Uint8Array(32)), true);
});

// ---- what's public ----

test("nothing public links a product's id or a partner across products", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const snap = await firstSnapshot(health, provider.user, productId);
  const signature = key.sign(snap.fingerprint);
  await health.submitSignature(provider.user, productId, null, 1, signature);
  await tickAt(T0 + 6 * 60_000);
  const subject = Buffer.from(health.subjectOf(productId, null)).toString("hex");
  assert.equal(Buffer.from(chain.log[0].subject).toString("hex"), subject);
  assert.notEqual(subject, createHash("sha256").update(`${productId}\u0000`).digest("hex"), "an unkeyed hash of a guessable id could be tested");
  const onChain = Buffer.from(chain.log[0].partner_commitment).toString("hex");
  assert.notEqual(onChain, "00".repeat(32));
  assert.notEqual(onChain, Buffer.from(key.address).toString("hex"));
  // The same key and signature on another product commit to something else.
  const { base58Decode } = await import("../dist/solana/codec.js");
  const sameHere = chainLib.partnerCommitment(health.subjectOf(productId, null), base58Decode(key.address), Buffer.from(signature, "hex"));
  assert.equal(Buffer.from(sameHere).toString("hex"), onChain, "the commitment is what the test says it is");
  const other = chainLib.partnerCommitment(health.subjectOf("another-product", null), base58Decode(key.address), Buffer.from(signature, "hex"));
  assert.notEqual(Buffer.from(other).toString("hex"), onChain);
});

// ---- wire format and the program itself ----

test("instruction data and a head account match the program's layout", () => {
  const { healthIx, decodeHead, HEAD_SIZE, subjectKey, headAddress, configAddress } = chainLib;
  const subject = subjectKey(randomBytes(32), "p1", null);
  const publisher = Keypair.generate().address;
  const entry = { sequence: 3, fingerprint: new Uint8Array(32).fill(9), period_start: 1_762_689_600, period_end: 1_762_693_200, source: "partner_ledger", partner_commitment: new Uint8Array(32).fill(1) };
  const ix = healthIx.recordSnapshot(PROGRAM_ID, publisher, subject, entry);
  const data = Buffer.from(ix.data);
  assert.deepEqual([...data.subarray(0, 8)], [...anchorDiscriminator("global", "record_snapshot")]);
  assert.equal(data.length, 8 + 32 + 8 + 32 + 8 + 8 + 1 + 32);
  assert.equal(data.readBigUInt64LE(8 + 32), 3n);
  assert.equal(data[8 + 32 + 8 + 32 + 8 + 8], chainLib.SOURCE_FLAG.partner_ledger);
  assert.equal(ix.keys[1].pubkey, headAddress(PROGRAM_ID, subject));
  assert.equal(ix.keys[0].pubkey, configAddress(PROGRAM_ID));

  const buf = Buffer.alloc(HEAD_SIZE);
  Buffer.from(anchorDiscriminator("account", "Head")).copy(buf, 0);
  Buffer.from(subject).copy(buf, 8);
  buf.writeBigUInt64LE(5n, 40);
  buf.fill(4, 48, 80);
  buf.writeBigInt64LE(100n, 80);
  buf.writeBigInt64LE(200n, 88);
  buf[96] = chainLib.KIND_MISSED;
  buf[97] = 1;
  buf[98] = 0;
  const head = decodeHead(buf);
  assert.equal(head.sequence, 5);
  assert.equal(head.fingerprint[0], 4);
  assert.equal(head.period_end, 200);
  assert.equal(head.kind, chainLib.KIND_MISSED);
  assert.equal(head.partner_signed, false);
  assert.equal(decodeHead(Buffer.alloc(HEAD_SIZE)), null);
});

const programFiles = () => {
  const root = new URL("../programs/product-health/", import.meta.url).pathname;
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return files;
};

test("the product-health program passes Mynt's own mainnet gate rules on its source, and moves no value", () => {
  const files = programFiles();
  const lib = files["programs/product_health/src/lib.rs"];
  const result = checkProgramRules({ name: "product_health", program_id: PROGRAM_ID, program: null, idl: null, sources: files });
  assert.deepEqual(result.findings.filter((f) => f.blocks), []);
  assert.equal(result.passed, true);
  assert.doesNotMatch(lib, /anchor_spl|token::|transfer\(|invoke_signed|\.lamports|system_program::/);
  assert.match(lib, /has_one = publisher/);
  assert.match(lib, /upgrade_authority_address == Some\(upgrade_authority\.key\(\)\)/);
  assert.match(lib, /e\.period_start == head\.period_end/);
  assert.match(lib, /Clock::get\(\)/);
  const literals = [...lib.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(literals)], [PROGRAM_ID]);
});
