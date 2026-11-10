import { after, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Liquidity providers: pools, their rails, the first-in-first-out withdrawal queue, the reserve gate that fails closed,
// and a position that comes only from settled movements. Health here is the real ProductHealthService over a fake chain
// (it enforces what the program does); the race runs on a real Postgres with a connection pool when CI gives one.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");

const { connectPostgres } = await import("../dist/db.js");
const { createServer } = await import("../dist/server.js");
const { normalizeModel } = await import("../dist/regulatory.js");
const { Store } = await import("../dist/store.js");
const { ProductHealthService } = await import("../dist/product-health.js");
const { exitedLiquidityProvider, LiquidityWorker, liquidityProvidersOf, openWithdrawalRequests, poolsOf, reserveGate, minimumReserve } = await import("../dist/liquidity.js");
const { sweepStaleMovements } = await import("../dist/money-rails.js");
const chainLib = await import("../dist/solana/product-health-chain.js");
const { base58Encode } = await import("../dist/solana/codec.js");
const { CATALOG } = await import("./helpers.js");

const DAY = 86_400_000;
const PROGRAM_ID = "GLi9SM8q1Q8S1k5SFHWpZ7v9uWK9M5ZDxhd6ESjuSfVz";
const closers = [];
after(() => closers.forEach((c) => c()));

class FakeChain {
  programId = PROGRAM_ID;
  publisher = "PublisherFake11111111111111111111111111111111";
  heads = new Map();
  async head(subject, programId = this.programId) {
    return this.heads.get(`${programId}:${Buffer.from(subject).toString("hex")}`) ?? null;
  }
  async latestRecordTx() {
    return "recovered";
  }
  async hasHeadHistory() {
    return false;
  }
  apply(subject, kind, e) {
    const k = `${this.programId}:${Buffer.from(subject).toString("hex")}`;
    const head = this.heads.get(k);
    assert.equal(e.sequence, (head?.sequence ?? 0) + 1);
    const fingerprint = e.fingerprint ?? chainLib.ZERO_32;
    const partner_commitment = e.partner_commitment ?? chainLib.ZERO_32;
    const source = chainLib.SOURCE_FLAG[e.source] ?? 0;
    const chain = chainLib.nextChain(head?.chain ?? chainLib.ZERO_32, { subject, sequence: e.sequence, fingerprint, period_start: e.period_start, period_end: e.period_end, kind, source, partner_commitment });
    this.heads.set(k, { subject, sequence: e.sequence, fingerprint, period_start: e.period_start, period_end: e.period_end, kind, source, partner_signed: !!e.partner_commitment, partner_commitment, chain });
    return `tx${e.sequence}`;
  }
  publishSnapshot(subject, entry) {
    return Promise.resolve().then(() => this.apply(subject, chainLib.KIND_SNAPSHOT, entry));
  }
  publishMissed(subject, entry) {
    return Promise.resolve().then(() => this.apply(subject, chainLib.KIND_MISSED, entry));
  }
}

const edKeyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const address = base58Encode(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"));
  return { address, sign: (fp) => edSign(null, Buffer.from(chainLib.cosignMessage(Buffer.from(fp, "hex"))), privateKey).toString("hex") };
};

const callTool = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  let data;
  try {
    data = JSON.parse(res.content[0].text);
  } catch {
    data = { error: res.content[0].text };
  }
  return { isError: res.isError ?? false, data };
};
const ok = async (client, name, args = {}) => {
  const r = await callTool(client, name, args);
  assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
  return r.data;
};

// A verified state money transmitter licence, as the US model has them: it grants us_money_transmission with a FinCEN
// registration behind it. The same shape as test/money-rails.test.js.
async function moneyTransmitter(store, user, covers) {
  const grants = "us_money_transmission";
  await store.upsertRegulatedProductType("US", { id: grants, name: grants, description: "", type_id: "deposits", actions: ["sale", "servicing"] });
  const grc = () => ({
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
    allowed_product_types: [{ id: grants, actions: ["sale", "servicing"] }],
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [], external: [] },
  });
  const scope = { product_types: [{ id: grants, name: grants, description: "", type_id: "deposits", action: ["sale", "servicing"] }], customer_personas: [] };
  const region = (await store.referenceData(true)).regions.find((r) => r.code === "US");
  const model = normalizeModel(region.regulatory);
  await store.setRegulatoryModel("US", {
    ...model,
    regulators: [
      ...model.regulators.filter((r) => !["t_fincen", "t_state"].includes(r.id)),
      { id: "t_fincen", name: "Test FinCEN", scope, license_types: [{ _id: "t_msb", name: "MSB", scope: "", application_procedure: [], covers: [], grc: grc() }] },
      { id: "t_state", name: "Test state", scope, license_types: [{ _id: "t_mt", name: "Money transmitter", scope: "", application_procedure: [], covers, requires: [["t_msb"]], grc: grc() }] },
    ],
  });
  const hold = async (regulator_id, license_id) => {
    const h = await store.registerLicense(user.id, { entity_id: user.entity_id, region: "US", regulator_id, license_id, registration_number: `T-${license_id}`, valid_from: null, valid_to: null });
    await store.reviewLicense(h.id, "verified", user.id, "test");
    return h;
  };
  await hold("t_fincen", "t_msb");
  return hold("t_state", "t_mt");
}

const openDb = async () => {
  const pg = new PGlite();
  return { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
};

// One product of a builder, sponsored by a licensed firm with approved rails, and an approved pool on it.
async function world({ db, sandbox = false, notice = 0, clear = true, minBps = 10_000, floor = 0, makePool = true, healthStub = null } = {}) {
  db ??= await openDb();
  const store = await Store.open(db, CATALOG);
  let clock = Date.now();
  let lastBoundary = -Infinity;
  const chain = new FakeChain();
  const ledger = { id: "fake-live", name: "Fake live ledger", kind: "live", figures: {}, failing: false, async read(c) {
    if (this.failing) return { error: { code: "down", message: "The partner's ledger is down" } };
    return { reserves_held_cents: this.figures.reserves, customer_obligations_cents: this.figures.obligations, as_of: c.period_end, reason: this.figures.reason };
  } };
  const health = await ProductHealthService.open(db, store, { intervalMs: DAY, cosignWindowMs: 10 * 60_000, pollMs: 60_000, programId: PROGRAM_ID }, {
    chain,
    ledgerFor: () => ledger,
    now: () => new Date(clock),
    liquidityProvidersOf: (id) => liquidityProvidersOf(store, id),
    exitedLiquidityProvider: (id, firm) => exitedLiquidityProvider(store, id, firm),
    poolsOf: (id) => poolsOf(store, id),
    openWithdrawalRequests: (id, pool) => openWithdrawalRequests(store, id, pool),
  });
  const worker = new LiquidityWorker(store, healthStub ?? health, { maxHealthAgeMs: 30 * 3_600_000, pollMs: 60_000 }, { now: () => new Date(clock) });
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { productHealth: health }).connect(s);
    const client = new Client({ name: "liq", version: "0" });
    await client.connect(c);
    closers.push(() => client.close());
    return client;
  };
  const firm = async (name, roles) => {
    const entity = await store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });
    const { user } = await store.createUser(`${name} person`, roles);
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    return { entity, user, client: await connect(user) };
  };
  const provider = await firm("Partner Bank", ["license_provider"]);
  const builder = await firm("Builder Co", ["innovator"]);
  const fundA = await firm("Fund A", ["liquidity_provider"]);
  const fundB = await firm("Fund B", ["liquidity_provider"]);
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const admin = await connect(adminUser);
  const [seed] = await store.publishedProducts();
  const productId = seed.id;
  await db.query("UPDATE financial_products.products SET owner_id = $1, entity_id = $2 WHERE id = $3", [builder.user.id, builder.entity.id, productId]);
  const held = await moneyTransmitter(store, provider.user, ["us-ny", "us-ca"]);
  const requested = await store.requestSponsorship(builder.user.id, { product_id: productId, component_key: "account", builder_entity_id: builder.entity.id, provider_entity_id: provider.entity.id, requested_jurisdictions: ["us-ny", "us-ca"], note: null });
  await store.decideSponsorship(requested.id, { status: "approved", decided_by: provider.user.id, note: null, licence_ids: [held.id], jurisdictions: ["us-ny", "us-ca"] });
  const rail = async (direction, extra = {}) => {
    const r = await ok(provider.client, "propose_rail", { kind: "ramp_adapter", provider: "bridge", direction, states: ["us-ny", "us-ca"], per_transfer_limit_cents: 100_000_000, daily_limit_cents: 900_000_000, ...extra });
    return ok(admin, "approve_rail", { rail_id: r.id });
  };
  const depositRail = await rail("deposit");
  const payoutRail = await rail("payout");
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  let pool = null;
  const createPool = async (o = {}) => {
    const p = await ok(builder.client, "create_pool", { product_id: productId, component_key: "account", name: `Pool ${randomBytes(2).toString("hex")}`, sandbox, min_reserve_bps: minBps, min_reserve_floor_cents: floor, notice_period_days: notice, min_commitment_cents: 1, max_commitment_cents: 100_000_000, ...o });
    await ok(provider.client, "approve_pool", { pool_id: p.id, deposit_rail_id: depositRail.id, withdrawal_rail_id: payoutRail.id });
    if (!o.sandbox && !sandbox && clear) await ok(admin, "set_pool_offering_cleared", { pool_id: p.id, cleared: true, legal_basis: "Rule 506(b) offering, cleared by outside counsel" });
    return p;
  };
  if (makePool) pool = await createPool();

  // Publish a snapshot of `poolId`: a new period each time, co-signed and on chain unless asked otherwise.
  const snapshot = async ({ reserves, obligations, reason, unsigned = false, ledgerKind = "live" } = {}) => {
    const boundary = Math.floor(clock / DAY) * DAY;
    if (boundary <= lastBoundary) clock += DAY;
    lastBoundary = Math.floor(clock / DAY) * DAY;
    ledger.kind = ledgerKind;
    ledger.figures = { reserves, obligations, reason };
    await health.tick();
    if (!unsigned) {
      for (const view of await health.listFor(provider.user, productId, 200)) {
        for (const snap of view.snapshots.filter((x) => x.status === "pending_signature")) await health.submitSignature(provider.user, productId, view.pool_id, snap.sequence, key.sign(snap.fingerprint));
      }
    }
    // A later moment inside the same period: a co-signed snapshot goes on chain, an unsigned one when its window closes.
    clock += 11 * 60_000;
    await health.tick();
  };

  const commit = (who, amount, poolId = pool.id) => ok(who.client, "commit_to_pool", { pool_id: poolId, amount_cents: amount, state: "us-ny", idempotency_key: `commit-${randomUUID()}` });
  const settle = (movementId, extra = {}) => ok(provider.client, "report_pool_movement", { movement_id: movementId, outcome: "settled", ...extra });
  const position = async (who, poolId = pool.id) => (await ok(who.client, "list_my_positions", { pool_id: poolId, include_entries: true }))[0];
  const withdrawals = async (who, poolId = pool.id) => ok(who.client ?? who, "list_withdrawals", { pool_id: poolId });
  const claims = async () => (await db.query("SELECT s.* FROM financial_products.pool_movement_states s JOIN financial_products.pool_withdrawals w ON w.id = s.withdrawal_id WHERE s.kind = 'withdrawal' ORDER BY w.seq, s.claimed_at, s.id")).rows;
  const poolRow = async (id = pool.id) => (await ok(admin, "list_pools", {})).find((p) => p.id === id);
  // A settled deposit, ready to withdraw.
  const funded = async (who, amount, poolId = pool.id) => settle((await commit(who, amount, poolId)).movement_id);
  const requestOut = (who, amount, poolId = pool.id) => ok(who.client, "request_withdrawal", { pool_id: poolId, amount_cents: amount, idempotency_key: `out-${randomUUID()}` });
  return { db, store, health, worker, chain, ledger, provider, builder, fundA, fundB, admin, adminUser, connect, firm, productId, pool, createPool, snapshot, commit, settle, position, withdrawals, claims, poolRow, funded, requestOut, depositRail, payoutRail, setClock: (t) => (clock = t), getClock: () => clock, advance: (ms) => (clock += ms), tick: () => worker.tick(), held };
}

const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name);

test("a liquidity provider has its own tools: none of a builder's or a consumer's, and an admin isn't one", async () => {
  const s = await world({ makePool: false });
  const lpTools = await toolNames(s.fundA.client);
  for (const t of ["commit_to_pool", "request_withdrawal", "cancel_withdrawal", "list_my_positions", "list_withdrawals", "list_pools", "list_pools_with_health", "get_my_entity", "get_product_health", "list_product_health"]) assert.ok(lpTools.includes(t), t);
  for (const t of ["create_product", "create_app", "enroll_in_product", "request_sponsorship", "create_pool", "approve_pool", "pause_pool", "resume_pool", "register_partner_signing_key", "create_vendor_offering"]) assert.ok(!lpTools.includes(t), t);
  const adminTools = await toolNames(s.admin);
  assert.ok(adminTools.includes("pause_pool") && adminTools.includes("set_pool_offering_cleared"));
  assert.ok(!adminTools.includes("commit_to_pool") && !adminTools.includes("request_withdrawal"), "Mynt's staff don't commit capital");
  const builderTools = await toolNames(s.builder.client);
  assert.ok(builderTools.includes("create_pool") && !builderTools.includes("commit_to_pool") && !builderTools.includes("approve_pool"));
  const providerTools = await toolNames(s.provider.client);
  for (const t of ["approve_pool", "report_pool_movement", "pause_pool", "resume_pool", "list_pools", "list_withdrawals"]) assert.ok(providerTools.includes(t), t);
  assert.ok(!providerTools.includes("commit_to_pool") && !providerTools.includes("create_pool"));
  assert.deepEqual((await callTool(s.fundA.client, "whoami")).data.effective_roles, ["liquidity_provider"]);
});

test("a pool needs an approved sponsorship, the sponsor's approval and its approved rails", async () => {
  const s = await world({ makePool: false });
  const refused = await callTool(s.builder.client, "create_pool", { product_id: s.productId, component_key: "nothing", name: "No sponsor", sandbox: false, min_reserve_bps: 100, min_reserve_floor_cents: 0, notice_period_days: 0, max_commitment_cents: 1000 });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /no approved sponsorship/);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'create_pool_refused'")).rows[0].n, 1);

  const pool = await ok(s.builder.client, "create_pool", { product_id: s.productId, component_key: "account", name: "Good", sandbox: false, min_reserve_bps: 100, min_reserve_floor_cents: 0, notice_period_days: 0, max_commitment_cents: 1000 });
  assert.equal(pool.status, "paused");
  assert.equal(pool.pause_kind, "awaiting_approval");
  // Someone who doesn't sponsor it can't approve it; a rail that's only proposed can't carry capital.
  assert.equal((await callTool(s.fundA.client, "approve_pool", { pool_id: pool.id, deposit_rail_id: s.depositRail.id, withdrawal_rail_id: s.payoutRail.id })).isError, true);
  const proposed = await ok(s.provider.client, "propose_rail", { kind: "wire", provider: "bridge", direction: "deposit", states: ["us-ny"], per_transfer_limit_cents: 10_000, daily_limit_cents: 10_000 });
  const stale = await callTool(s.provider.client, "approve_pool", { pool_id: pool.id, deposit_rail_id: proposed.id, withdrawal_rail_id: s.payoutRail.id });
  assert.equal(stale.isError, true);
  assert.match(stale.data.error, /approved rail/);
  await ok(s.provider.client, "approve_pool", { pool_id: pool.id, deposit_rail_id: s.depositRail.id, withdrawal_rail_id: s.payoutRail.id });
  assert.equal((await s.poolRow(pool.id)).status, "open");
});

test("capital moves only on an approved rail of the pool's sponsor, through the chokepoint", async () => {
  const s = await world();
  await ok(s.admin, "suspend_rail", { rail_id: s.depositRail.id, reason: "partner incident" });
  const refused = await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 1000, state: "us-ny", idempotency_key: "commit-suspended-rail" });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.code, "rail_suspended");
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.money_movements")).rows[0].n, 0, "nothing in the ledger");
  await ok(s.admin, "approve_rail", { rail_id: s.depositRail.id });
  const c = await s.commit(s.fundA, 1000);
  const { rows: [m] } = await s.db.query("SELECT * FROM financial_products.money_movements WHERE id = $1", [c.movement_id]);
  assert.equal(m.sponsor_entity_id, s.provider.entity.id);
  assert.equal(m.rail_id, s.depositRail.id);
  assert.equal(m.action, "pool_deposit");
  assert.equal(m.direction, "deposit");
  assert.equal(m.status, "requested");
  // A rail that stops afterwards holds the queue, and the reason is shown.
  await s.settle(c.movement_id);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.requestOut(s.fundA, 500);
  await ok(s.admin, "suspend_rail", { rail_id: s.payoutRail.id, reason: "partner incident" });
  await s.tick();
  assert.equal((await s.poolRow()).status, "open");
  assert.match((await s.poolRow()).hold_reason, /rail_suspended/);
  assert.equal((await s.claims()).filter((c2) => c2.ledger_state !== "released").length, 0, "the amount goes back to the queue");
});

test("withdrawals are paid first in, first out; nobody jumps the queue", async () => {
  const s = await world();
  await s.funded(s.fundA, 40_000);
  await s.funded(s.fundB, 40_000);
  await s.requestOut(s.fundA, 20_000);
  await s.requestOut(s.fundB, 30_000);
  await s.requestOut(s.fundA, 10_000);
  // Room for only the head of the queue.
  await s.snapshot({ reserves: 120_000, obligations: 100_000 });
  await s.tick();
  let queue = await s.withdrawals(s.admin);
  assert.deepEqual(queue.map((w) => [w.amount_cents, w.status]), [[20_000, "paying"], [30_000, "queued"], [10_000, "queued"]]);
  const first = (await s.claims())[0];
  await s.settle(first.movement_id);
  await s.tick();
  // A new period with room for what's left.
  await s.snapshot({ reserves: 140_000, obligations: 100_000 });
  await s.tick();
  queue = await s.withdrawals(s.admin);
  assert.deepEqual(queue.map((w) => [w.amount_cents, w.status]), [[20_000, "paid"], [30_000, "paying"], [10_000, "paying"]]);
  assert.deepEqual((await s.claims()).map((c) => c.amount_cents), [20_000, 30_000, 10_000].map(Number));
});

test("a request waits out the notice period", async () => {
  const s = await world({ notice: 1 });
  await s.funded(s.fundA, 10_000);
  await s.requestOut(s.fundA, 5_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  const [w] = await s.withdrawals(s.fundA);
  assert.match(w.waiting_reason, /notice period/);
  assert.equal((await s.claims()).length, 0);
  s.advance(DAY + 60_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  assert.equal((await s.claims()).length, 1);
});

test("the reserve check blocks payment, pays partially what keeps the reserve, and resumes when health recovers", async () => {
  const s = await world({ floor: 5_000 });
  await s.funded(s.fundA, 80_000);
  const req = await s.requestOut(s.fundA, 50_000);
  // Below the minimum: 100,000 obligations at 100% plus a 5,000 floor.
  await s.snapshot({ reserves: 100_000, obligations: 100_000 });
  await s.tick();
  let pool = await s.poolRow();
  assert.equal(pool.status, "paused");
  assert.equal(pool.pause_kind, "health");
  assert.match(pool.pause_reason, /at or below its minimum reserve/);
  assert.equal((await s.claims()).length, 0);

  // Health recovers on its own: 30,000 of room over the minimum, so a partial payment of it.
  await s.snapshot({ reserves: 135_000, obligations: 100_000 });
  await s.tick();
  pool = await s.poolRow();
  assert.equal(pool.status, "open", "resumed by itself");
  assert.equal(pool.pause_kind, null);
  let claims = await s.claims();
  assert.equal(claims.length, 1);
  assert.equal(Number(claims[0].amount_cents), 30_000);
  await s.settle(claims[0].movement_id);
  // Settled after this snapshot's reading: it can't have seen that money go.
  await s.db.query("UPDATE financial_products.money_movements SET settled_at = $2 WHERE id = $1", [claims[0].movement_id, new Date(s.getClock()).toISOString()]);
  await s.tick();
  // Nothing more until a newer snapshot: 30,000 is already gone since that one.
  let [w] = await s.withdrawals(s.fundA);
  assert.equal(w.settled_cents, 30_000);
  assert.equal(w.status, "queued");
  assert.equal((await s.claims()).length, 1);

  await s.snapshot({ reserves: 125_000, obligations: 100_000 }); // 20,000 of room: the rest of the request
  await s.tick();
  claims = await s.claims();
  assert.equal(claims.length, 2);
  assert.equal(Number(claims[1].amount_cents), 20_000);
  await s.settle(claims[1].movement_id);
  await s.tick();
  [w] = await s.withdrawals(s.fundA);
  assert.equal(w.id, req.id);
  assert.equal(w.status, "paid");
  assert.equal(w.settled_cents, 50_000);
  assert.ok(minimumReserve({ min_reserve_bps: 10_000, min_reserve_floor_cents: 5_000 }, 100_000) === 105_000n);
});

// One failure at a time: a real snapshot record (or none) must stop payment, naming why.
const FAIL_CLOSED = {
  "there's no snapshot at all": { nosnapshot: true, reason: /No finished health snapshot/ },
  "the snapshot is stale": { args: { reserves: 2_000_000, obligations: 1_000_000 }, after: (s) => s.advance(2 * DAY), reason: /stale/ },
  "a figure needed is null": { args: { reserves: null, obligations: 1_000_000, reason: "the partner's reserves report is late" }, reason: /reserves can't be measured.*late/ },
  "obligations are null": { args: { reserves: 2_000_000, obligations: null, reason: "not reported" }, reason: /obligations can't be measured/ },
  "the snapshot is unverified": { args: { reserves: 2_000_000, obligations: 1_000_000, unsigned: true }, reason: /isn't verified/ },
  "the snapshot is sandbox-sourced for a live pool": { args: { reserves: 2_000_000, obligations: 1_000_000, ledgerKind: "sandbox" }, reason: /sandbox figures/ },
};

for (const [label, want] of Object.entries(FAIL_CLOSED))
  test(`payment stops when ${label}`, async () => {
    const s = await world();
    await s.funded(s.fundA, 10_000);
    await s.requestOut(s.fundA, 5_000);
    if (!want.nosnapshot) await s.snapshot(want.args);
    want.after?.(s);
    await s.tick();
    const pool = await s.poolRow();
    assert.equal(pool.status, "paused");
    assert.equal(pool.pause_kind, "health");
    assert.match(pool.pause_reason, want.reason);
    assert.equal((await s.claims()).length, 0, "nothing paid");
    const [w] = await s.withdrawals(s.fundA);
    assert.equal(w.status, "queued");
    assert.match(w.waiting_reason, want.reason, "the reason is shown");
    // New capital is still welcome: it's how a pool gets back above its reserve.
    const again = await callTool(s.fundB.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 1000, state: "us-ny", idempotency_key: "commit-while-paused" });
    assert.equal(again.isError, false, JSON.stringify(again.data));
  });

test("a missed snapshot is no snapshot, and a sandbox pool pays on sandbox figures", async () => {
  const missed = reserveGate({ sandbox: false, sponsor_entity_id: "x", min_reserve_bps: 0, min_reserve_floor_cents: 0 }, { sequence: 3, status: "missed", source: "unavailable", live: false, verified: false, notes: [], report: null }, new Date(), DAY);
  assert.equal(missed.ok, false);
  assert.match(missed.reason, /missed/);
  const s = await world({ sandbox: true });
  await s.funded(s.fundA, 10_000);
  await s.requestOut(s.fundA, 5_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000, ledgerKind: "sandbox" });
  await s.tick();
  assert.equal((await s.poolRow()).status, "open");
  assert.equal((await s.claims()).length, 1, "a sandbox pool doesn't need a verified snapshot, which a sandbox one never is");
});

test("a governance problem pauses a pool, and a manual pause stays until lifted", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  assert.equal((await s.poolRow()).status, "open");

  await s.store.setDrift(s.productId, { detected_at: new Date().toISOString(), changes: [] });
  await s.tick();
  let pool = await s.poolRow();
  assert.equal(pool.pause_kind, "governance");
  assert.match(pool.pause_reason, /drifted/);
  assert.equal((await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 1000, state: "us-ny", idempotency_key: "commit-while-drifted" })).data.code, "pool_not_open");
  await s.store.setDrift(s.productId, null);
  await s.tick();
  assert.equal((await s.poolRow()).status, "open", "resumes once it's gone");

  // A manual pause, by the sponsor: the worker leaves it alone, and only the sponsor (or an admin) lifts it.
  const paused = await ok(s.provider.client, "pause_pool", { pool_id: s.pool.id, reason: "investigating" });
  assert.equal(paused.pause_kind, "manual");
  await s.tick();
  assert.equal((await s.poolRow()).pause_kind, "manual");
  await ok(s.provider.client, "resume_pool", { pool_id: s.pool.id });
  assert.equal((await s.poolRow()).status, "open");
  // An admin's pause can't be lifted by the sponsor.
  await ok(s.admin, "pause_pool", { pool_id: s.pool.id, reason: "regulator asked" });
  assert.match((await callTool(s.provider.client, "resume_pool", { pool_id: s.pool.id })).data.error, /admin must resume/);
  await ok(s.admin, "resume_pool", { pool_id: s.pool.id });

  // The sponsor stops sponsoring: paused, with the reason.
  const [approved] = await s.store.sponsorships({ product_id: s.productId, status: "approved" });
  await ok(s.provider.client, "revoke_sponsorship", { sponsorship_id: approved.id, reason: "ended" });
  await s.tick();
  pool = await s.poolRow();
  assert.equal(pool.pause_kind, "governance");
  assert.match(pool.pause_reason, /sponsorship/);
  await ok(s.admin, "pause_pool", { pool_id: s.pool.id, reason: "closing", close: true });
  assert.equal((await s.poolRow()).status, "closed");
  assert.match((await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 100, state: "us-ny", idempotency_key: "commit-closed-pool" })).data.error, /isn't taking commitments/);
});

async function raceClaims(db) {
  const reading = (headroom) => ({ sequence: 1, status: "published", source: "partner_ledger", live: true, verified: true, notes: [], report: { ledger_as_of: new Date(Date.now() - 1000).toISOString(), partner: { entity_id: null }, figures: { reserves_cents: { value: 1_000_000 + headroom, reason: null }, obligations_cents: { value: 1_000_000, reason: null } } } });
  let stubReading = reading(100_000);
  const healthStub = { latestFinished: async () => stubReading };
  const s = await world({ db, healthStub });
  stubReading.report.partner.entity_id = s.provider.entity.id;
  await s.funded(s.fundA, 80_000);
  await s.funded(s.fundB, 80_000);
  await s.requestOut(s.fundA, 70_000);
  await s.requestOut(s.fundB, 70_000);
  // Several requests at once can't over-ask: only 10,000 of Fund A's is left to ask for.
  const asked = await Promise.all(Array.from({ length: 5 }, (_, i) => callTool(s.fundA.client, "request_withdrawal", { pool_id: s.pool.id, amount_cents: 10_000, idempotency_key: `out-race-${i}` })));
  assert.equal(asked.filter((a) => !a.isError).length, 1, JSON.stringify(asked));
  s.setClock(Date.now() + 1000); // past each request's eligible time
  const pool = await s.poolRow();
  await Promise.all(Array.from({ length: 24 }, () => s.worker.processPool(pool)));
  const claims = (await s.claims()).filter((c) => c.ledger_state !== "released");
  const total = claims.reduce((n, c) => n + Number(c.amount_cents), 0);
  assert.equal(total, 100_000, "the reserve holds under concurrent workers");
  const byFund = (who) => claims.filter((c) => c.lp_entity_id === who.entity.id).reduce((n, c) => n + Number(c.amount_cents), 0);
  assert.equal(byFund(s.fundA), 70_000, "the head of the queue is paid in full once, not twice");
  assert.equal(byFund(s.fundB), 30_000, "the next only as far as what's left");
  assert.equal(new Set(claims.map((c) => c.movement_id)).size, claims.length, "one ledger row per claim");
  assert.equal(new Set(claims.map((c) => c.id)).size, claims.length);
  const [a, b, c] = await s.withdrawals(s.admin);
  assert.equal(a.status, "paying");
  assert.equal(b.status, "queued");
  assert.equal(c.status, "queued", "nobody passes the request in front, even with money to take");
}

test("two workers can't pay one request twice or overdraw (in-process Postgres)", async () => {
  await raceClaims(await openDb());
});

test("two workers can't pay one request twice or overdraw (a real Postgres with a connection pool)", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const name = `liq_${randomBytes(4).toString("hex")}`;
  const root = connectPostgres(process.env.TEST_DATABASE_URL);
  await root.exec(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = connectPostgres(url.href);
  try {
    await raceClaims(db);
  } finally {
    await db.close();
    await root.exec(`DROP DATABASE ${name}`).catch(() => {});
    await root.close();
  }
});

test("a position counts only settled movements; a reversal takes it back out", async () => {
  const s = await world();
  const c = await s.commit(s.fundA, 50_000);
  let p = await s.position(s.fundA);
  assert.deepEqual([p.contributed_cents, p.balance_cents, p.pending_in_cents], [0, 0, 50_000]);
  assert.equal(p.available_to_withdraw_cents, 0);
  // Unknown outcome: swept with no answer, it's unresolved and still not contributed.
  await sweepStaleMovements(s.store, { now: new Date(Date.now() + 3 * DAY), requestedHours: 1 });
  p = await s.position(s.fundA);
  assert.deepEqual([p.contributed_cents, p.pending_in_cents, p.unresolved_in_cents], [0, 0, 50_000]);
  // A settlement that turns up later still lands.
  await s.settle(c.movement_id);
  p = await s.position(s.fundA);
  assert.deepEqual([p.contributed_cents, p.balance_cents, p.available_to_withdraw_cents, p.unresolved_in_cents], [50_000, 50_000, 50_000, 0]);
  // A second deposit, partner reports less than asked: the position is what actually settled.
  const c2 = await s.commit(s.fundA, 30_000);
  await s.settle(c2.movement_id, { settled_amount_cents: 29_000 });
  p = await s.position(s.fundA);
  assert.equal(p.contributed_cents, 79_000);

  // A withdrawal, paid and then returned: withdrawn goes back down and the balance is whole again.
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.requestOut(s.fundA, 40_000);
  await s.tick();
  let [claim] = await s.claims();
  p = await s.position(s.fundA);
  assert.deepEqual([p.withdrawn_cents, p.pending_out_cents, p.available_to_withdraw_cents], [0, 40_000, 39_000]);
  await s.settle(claim.movement_id);
  p = await s.position(s.fundA);
  assert.deepEqual([p.withdrawn_cents, p.balance_cents], [40_000, 39_000]);
  await ok(s.provider.client, "report_pool_movement", { movement_id: claim.movement_id, outcome: "returned" });
  await s.tick();
  p = await s.position(s.fundA);
  assert.deepEqual([p.withdrawn_cents, p.balance_cents, p.reversed_out_cents], [0, 79_000, 40_000]);
  const [w] = await s.withdrawals(s.fundA);
  assert.equal(w.status, "paid", "a returned payment isn't paid again by itself");
  assert.equal(w.reversed_cents, 40_000);

  // A deposit returned after settling: contributed falls and it can't be withdrawn.
  await ok(s.provider.client, "report_pool_movement", { movement_id: c.movement_id, outcome: "returned" });
  p = await s.position(s.fundA);
  assert.deepEqual([p.contributed_cents, p.balance_cents, p.reversed_in_cents], [29_000, 29_000, 50_000]);
  assert.equal(p.entries.find((e) => e.movement_id === c.movement_id).ledger_state, "reversed");
});

test("a request can't ask for more than is settled, and a retry is the same request", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  const refused = await callTool(s.fundA.client, "request_withdrawal", { pool_id: s.pool.id, amount_cents: 10_001, idempotency_key: "out-too-much" });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.available_cents, 10_000);
  const first = await ok(s.fundA.client, "request_withdrawal", { pool_id: s.pool.id, amount_cents: 6_000, idempotency_key: "out-retried" });
  const again = await ok(s.fundA.client, "request_withdrawal", { pool_id: s.pool.id, amount_cents: 6_000, idempotency_key: "out-retried" });
  assert.equal(again.id, first.id);
  assert.equal(again.replay, true);
  // Only 4,000 is left to ask for while 6,000 is queued.
  assert.equal((await callTool(s.fundA.client, "request_withdrawal", { pool_id: s.pool.id, amount_cents: 4_001, idempotency_key: "out-one-too-many" })).isError, true);
  await ok(s.fundA.client, "cancel_withdrawal", { withdrawal_id: first.id });
  const [cancelled] = await s.withdrawals(s.fundA);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await callTool(s.fundB.client, "cancel_withdrawal", { withdrawal_id: first.id })).isError, true, "only its own");

  // Commitment limits are per firm, and a retry of a commitment is one deposit.
  const small = await s.createPool({ max_commitment_cents: 1000 });
  const over = await callTool(s.fundA.client, "commit_to_pool", { pool_id: small.id, amount_cents: 1001, state: "us-ny", idempotency_key: "commit-over-limit" });
  assert.equal(over.data.code, "over_limit");
  const key = "commit-retried";
  const c1 = await ok(s.fundA.client, "commit_to_pool", { pool_id: small.id, amount_cents: 400, state: "us-ny", idempotency_key: key });
  const c2 = await ok(s.fundA.client, "commit_to_pool", { pool_id: small.id, amount_cents: 400, state: "us-ny", idempotency_key: key });
  assert.equal(c2.movement_id, c1.movement_id);
  assert.equal(c2.replay, true);
});

test("a claim a crash left behind is finished, not lost", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  const w = await s.requestOut(s.fundA, 5_000);
  // A claim with no movement: the worker died between the two steps.
  const id = randomUUID();
  await s.db.query(`INSERT INTO financial_products.pool_movements (id, idempotency_key, pool_id, lp_entity_id, kind, withdrawal_id, amount_cents, state, claimed_at) VALUES ($1, $2, $3, $4, 'withdrawal', $5, 5000, 'claimed', now() - interval '1 hour')`, [id, `pool-withdrawal:${id}`, s.pool.id, s.fundA.entity.id, w.id]);
  await s.db.query(`UPDATE financial_products.pool_withdrawals SET status = 'paying' WHERE id = $1`, [w.id]);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  s.advance(10 * 60_000);
  await s.tick();
  const claims = await s.claims();
  assert.equal(claims.length, 1, "it wasn't claimed again");
  assert.ok(claims[0].movement_id, "the chokepoint was asked, with the same key");
});

test("a pool's committed liquidity providers can read its product's health; an admin can't; a full exit ends access to new snapshots", async () => {
  const s = await world();
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  assert.equal(await s.health.entitlement(s.fundA.user, s.productId), null, "not committed yet");
  const before = await callTool(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: s.pool.id });
  assert.equal(before.isError, true);
  await s.funded(s.fundA, 5_000);
  const hit = await s.health.entitlement(s.fundA.user, s.productId);
  assert.equal(hit.as, "liquidity_provider");
  assert.equal(hit.until, undefined);
  const read = await ok(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: s.pool.id });
  assert.equal(read.latest.report.figures.reserves_cents.value, 2_000_000);
  const adminRead = await callTool(s.admin, "get_product_health", { product_id: s.productId, pool_id: s.pool.id });
  assert.equal(adminRead.isError, true, "an admin account is refused the numbers");

  // Side by side.
  const other = await s.createPool({ name: "Second" });
  await s.funded(s.fundA, 1_000, other.id);
  await s.snapshot({ reserves: 2_500_000, obligations: 1_000_000 });
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  const compared = await ok(s.fundA.client, "list_pools_with_health");
  assert.equal(compared.length, 2);
  const row = compared.find((c) => c.pool_id === other.id);
  assert.equal(row.coverage_bps, 20_000);
  assert.equal(row.verified, true);
  assert.equal(row.trend.direction, "down");
  assert.deepEqual(row.trend.coverage_series_bps, [25_000, 20_000]);
  assert.ok(Array.isArray(row.gaps));
  // Fund B has committed to nothing: it sees the terms, not the numbers.
  const stranger = await ok(s.fundB.client, "list_pools_with_health");
  assert.equal(stranger.length, 2);
  assert.equal(stranger[0].coverage_bps, null);
  assert.match(stranger[0].coverage_reason, /Commit to a pool/);

  // Fund A takes everything out of both pools: it's gone, and keeps only what was already recorded.
  const fundPools = await ok(s.fundA.client, "list_my_positions");
  for (const pos of fundPools) await s.requestOut(s.fundA, pos.balance_cents, pos.pool_id);
  await s.tick();
  for (const c of await s.claims()) await s.settle(c.movement_id);
  await s.tick();
  const exited = await s.health.entitlement(s.fundA.user, s.productId);
  assert.ok(exited.until instanceof Date, "only what it could already read");
  const sequencesAtExit = (await ok(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: other.id })).history.map((h) => h.sequence);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  const after = await ok(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: other.id });
  assert.deepEqual(after.history.map((h) => h.sequence), sequencesAtExit, "no new snapshots");
  assert.ok(after.access_ended_at);

  // Coming back restores it.
  await s.funded(s.fundA, 1_000, other.id);
  await s.tick();
  const back = await ok(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: other.id });
  assert.ok(back.history.length > sequencesAtExit.length, "it reads the new ones again");
  const figures = await s.health.get(s.provider.user, s.productId, null, 1);
  assert.equal(figures.latest.report.figures.open_withdrawal_requests.value, 0, "the queue's size is measured, where it was once null");
});

test("a refused or sandbox commitment is no way into a product's books", async () => {
  const s = await world();
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  // Refused at the chokepoint (the rail doesn't serve this state): no commitment, no access, not even to what's past.
  const refused = await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 1000, state: "us-tx", idempotency_key: "commit-wrong-state" });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.code, "state_not_sponsored");
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.pool_commitments")).rows[0].n, 0);
  assert.equal(await s.health.entitlement(s.fundA.user, s.productId), null);
  assert.equal(await exitedLiquidityProvider(s.store, s.productId, s.fundA.entity.id), null);

  // A sandbox commitment moves no real money, so it doesn't open a real product's numbers.
  const sandbox = await s.createPool({ sandbox: true });
  await s.funded(s.fundB, 1000, sandbox.id);
  assert.equal(await s.health.entitlement(s.fundB.user, s.productId), null);
  const row = (await ok(s.fundB.client, "list_pools_with_health")).find((p) => p.pool_id === sandbox.id);
  assert.equal(row.coverage_bps, null);
});

test("real commitments are refused until an admin records the offering was cleared, and why", async () => {
  const s = await world({ clear: false });
  const refused = await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 1000, state: "us-ny", idempotency_key: "commit-uncleared" });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.code, "offering_not_cleared");
  assert.match(refused.data.error, /securities offering/);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.money_movements")).rows[0].n, 0);
  // A liquidity provider doesn't see it listed until it's cleared.
  assert.equal((await ok(s.fundA.client, "list_pools")).length, 0);

  // A sandbox pool isn't subject to the gate: nothing real moves.
  const sandbox = await s.createPool({ sandbox: true });
  await s.commit(s.fundB, 1000, sandbox.id);

  // Someone at the product's firm can't clear it, even with admin's role; another admin can.
  const firmAdmin = await s.firm("Builder Co staff", ["admin"]);
  await s.db.query("UPDATE financial_products.users SET entity_id = $1 WHERE id = $2", [s.builder.entity.id, firmAdmin.user.id]);
  const firmAdminClient = await s.connect({ ...firmAdmin.user, entity_id: s.builder.entity.id });
  assert.equal((await callTool(firmAdminClient, "set_pool_offering_cleared", { pool_id: s.pool.id, cleared: true, legal_basis: "Own firm's say-so" })).isError, true);

  const cleared = await ok(s.admin, "set_pool_offering_cleared", { pool_id: s.pool.id, cleared: true, legal_basis: "Rule 506(b), counsel memo of 2026-11-09" });
  assert.equal(cleared.offering_cleared, true);
  assert.equal(cleared.offering_cleared_by, s.adminUser.id);
  assert.match(cleared.offering_legal_basis, /506\(b\)/);
  assert.equal((await callTool(s.builder.client, "set_pool_offering_cleared", { pool_id: s.pool.id, cleared: true, legal_basis: "Own say-so, not an admin" })).isError, true, "builders don't have it");

  await s.commit(s.fundA, 1000);
  assert.equal((await ok(s.fundA.client, "list_pools")).length, 2);
  const audit = (await s.db.query("SELECT details FROM financial_products.audit_log WHERE action = 'set_pool_offering_cleared'")).rows;
  assert.ok(audit[0].details.legal_basis);
});

test("pool actions are audited", async () => {
  const s = await world();
  await s.funded(s.fundA, 5_000);
  const w = await s.requestOut(s.fundA, 1_000);
  await ok(s.fundA.client, "cancel_withdrawal", { withdrawal_id: w.id });
  await ok(s.fundA.client, "list_my_positions");
  await ok(s.fundA.client, "list_withdrawals");
  await ok(s.fundA.client, "list_pools");
  await ok(s.fundA.client, "list_pools_with_health");
  await ok(s.provider.client, "pause_pool", { pool_id: s.pool.id, reason: "looking" });
  await ok(s.provider.client, "resume_pool", { pool_id: s.pool.id });
  const actions = new Set((await s.db.query("SELECT action FROM financial_products.audit_log")).rows.map((r) => r.action));
  for (const a of ["create_pool", "approve_pool", "commit_to_pool", "report_pool_movement", "request_withdrawal", "cancel_withdrawal", "list_my_positions", "list_withdrawals", "list_pools", "list_pools_with_health", "pause_pool", "resume_pool", "set_pool_offering_cleared"]) assert.ok(actions.has(a), a);
});
