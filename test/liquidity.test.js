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
const { exitedLiquidityProvider, liquidityProviderBooks, LiquidityWorker, liquidityProvidersOf, openWithdrawalRequests, poolSponsorOf, poolsOf, reserveGate, minimumReserve } = await import("../dist/liquidity.js");
const { authorizeMovement, flowsFor, sweepStaleMovements } = await import("../dist/money-rails.js");
const chainLib = await import("../dist/solana/product-health-chain.js");
const { base58Encode } = await import("../dist/solana/codec.js");
const { opsStatus } = await import("../dist/ops.js");
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
    return { reserves_held_cents: this.figures.reserves, customer_obligations_cents: this.figures.obligations, as_of: new Date(new Date(c.period_end).getTime() - (this.figures.staleBy ?? 0)).toISOString(), reason: this.figures.reason };
  } };
  const health = await ProductHealthService.open(db, store, { intervalMs: DAY, cosignWindowMs: 10 * 60_000, pollMs: 60_000, programId: PROGRAM_ID }, {
    chain,
    ledgerFor: () => ledger,
    now: () => new Date(clock),
    liquidityProvidersOf: (id) => liquidityProvidersOf(store, id),
    exitedLiquidityProvider: (id, firm) => exitedLiquidityProvider(store, id, firm),
    liquidityProviderBooks: (id, firm) => liquidityProviderBooks(store, id, firm),
    poolsOf: (id) => poolsOf(store, id),
    poolSponsorOf: (id) => poolSponsorOf(store, id),
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
    // A live pool waits for its first health check before it can open.
    if (!o.sandbox && !sandbox) {
      await snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
      await worker.tick();
    }
    return p;
  };

  // Publish a snapshot of `poolId`: a new period each time, co-signed and on chain unless asked otherwise.
  const snapshot = async ({ reserves, obligations, reason, staleBy, unsigned = false, ledgerKind = "live" } = {}) => {
    const boundary = Math.floor(clock / DAY) * DAY;
    if (boundary <= lastBoundary) clock += DAY;
    lastBoundary = Math.floor(clock / DAY) * DAY;
    ledger.kind = ledgerKind;
    ledger.figures = { reserves, obligations, reason, staleBy };
    await health.tick();
    if (!unsigned) {
      for (const view of await health.listFor(provider.user, productId, 200)) {
        for (const snap of view.snapshots.filter((x) => x.status === "pending_signature")) await health.submitSignature(provider.user, productId, view.pool_id, snap.sequence, key.sign(snap.fingerprint)).catch((e) => assert.match(e.message, /Only the licence provider/));
      }
    }
    // A later moment inside the same period: a co-signed snapshot goes on chain, an unsigned one when its window closes.
    clock += 11 * 60_000;
    await health.tick();
  };

  if (makePool) pool = await createPool();

  const commit = (who, amount, poolId = pool.id) => ok(who.client, "commit_to_pool", { pool_id: poolId, amount_cents: amount, state: "us-ny", idempotency_key: `commit-${randomUUID()}` });
  const settle = (movementId, extra = {}) => ok(provider.client, "report_pool_movement", { movement_id: movementId, outcome: "settled", external_ref: `ref-${randomUUID()}`, ...extra });
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
  const approved = await s.poolRow(pool.id);
  assert.equal(approved.status, "paused", "a live pool waits for its first health check");
  assert.equal(approved.pause_kind, "health");
  // No snapshot yet: real money can't come in, even to a pool that's approved and cleared.
  await ok(s.admin, "set_pool_offering_cleared", { pool_id: pool.id, cleared: true, legal_basis: "Rule 506(b) offering, cleared by outside counsel" });
  const early = await callTool(s.fundA.client, "commit_to_pool", { pool_id: pool.id, amount_cents: 500, state: "us-ny", idempotency_key: "commit-no-snapshot" });
  assert.equal(early.data.code, "health_unconfirmed");
  assert.match(early.data.error, /No finished health snapshot/);
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
  // Settled after that snapshot's reading: it can't have seen that money go.
  await s.db.query("UPDATE financial_products.money_movements SET settled_at = $2 WHERE id = $1", [first.movement_id, new Date(s.getClock()).toISOString()]);
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
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.requestOut(s.fundA, 5_000);
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
  "the snapshot is stale": { args: { reserves: 2_000_000, obligations: 1_000_000, staleBy: 3 * DAY }, reason: /stale/ },
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
    if (want.nosnapshot) await s.db.query("DELETE FROM financial_products.product_health_snapshots WHERE pool_id = $1", [s.pool.id]);
    else await s.snapshot(want.args);
    await s.tick();
    const pool = await s.poolRow();
    assert.equal(pool.status, "paused");
    assert.equal(pool.pause_kind, "health");
    assert.match(pool.pause_reason, want.reason);
    assert.equal((await s.claims()).length, 0, "nothing paid");
    const [w] = await s.withdrawals(s.fundA);
    assert.equal(w.status, "queued");
    assert.match(w.waiting_reason, want.reason, "the reason is shown");
    // With no snapshot Mynt can trust showing a shortfall, there's no telling what it could pay back: no new capital.
    const again = await callTool(s.fundB.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 1000, state: "us-ny", idempotency_key: "commit-while-paused" });
    assert.equal(again.isError, true);
    assert.equal(again.data.code, "health_unconfirmed");
    assert.match(again.data.error, want.reason);
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
  s.advance(1000); // past each request's eligible time
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
  assert.equal(w.status, "returned", "a payment that came back whole has its own status, and isn't paid again by itself");
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
  await s.snapshot({ reserves: 1_003_000, obligations: 1_000_000 }); // only 3,000 of room now
  s.advance(10 * 60_000);
  await s.tick();
  const live = (await s.claims()).filter((c) => c.ledger_state !== "released");
  assert.equal(live.length, 1, "released, and claimed again");
  assert.notEqual(live[0].id, id, "a claim with no ledger row isn't honoured as it stood");
  assert.equal(Number(live[0].amount_cents), 3_000, "headroom as it is now");
  assert.ok(live[0].movement_id);
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
  assert.deepEqual(row.trend.coverage_series_bps, [20_000, 25_000, 20_000]);
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
  await s.tick();
  const sequencesAtExit = (await ok(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: other.id })).history.map((h) => h.sequence);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  const after = await ok(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: other.id });
  assert.deepEqual(after.history.map((h) => h.sequence), sequencesAtExit, "no new snapshots");
  assert.ok(after.access_ended_at);
  for (const view of await s.health.listFor(s.fundA.user, s.productId, 50)) assert.equal(view.gaps.some((g) => g.kind === "chain_ahead"), false, "a filtered view is never compared with the chain");
  // A refused commitment doesn't reopen anything, however many times it's tried.
  for (const i of [1, 2]) assert.equal((await callTool(s.fundA.client, "commit_to_pool", { pool_id: other.id, amount_cents: 100, state: "us-tx", idempotency_key: `commit-refused-${i}` })).isError, true);
  assert.ok((await s.health.entitlement(s.fundA.user, s.productId)).until instanceof Date, "still exited");
  assert.deepEqual((await ok(s.fundA.client, "get_product_health", { product_id: s.productId, pool_id: other.id })).history.map((h) => h.sequence), sequencesAtExit);

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

test("every pool of a product shares one headroom, less the product's other outflows and deposits reversed since", async () => {
  const s = await world();
  const second = await s.createPool({ name: "Second" });
  await s.funded(s.fundA, 40_000);
  await s.funded(s.fundB, 40_000, second.id);
  await s.requestOut(s.fundA, 30_000);
  await s.requestOut(s.fundB, 30_000, second.id);
  await s.snapshot({ reserves: 130_000, obligations: 100_000 }); // 30,000 of room across the product
  await s.tick();
  const claims = (await s.claims()).filter((c) => c.ledger_state !== "released");
  assert.equal(claims.reduce((n, c) => n + Number(c.amount_cents), 0), 30_000, "two pools can't spend the same reserves");

  const t = await world();
  await t.funded(t.fundA, 80_000);
  const reversed = await t.commit(t.fundB, 10_000);
  await t.settle(reversed.movement_id);
  await t.db.query("UPDATE financial_products.money_movements SET settled_at = $2 WHERE id = $1", [reversed.movement_id, new Date(t.getClock() - 3 * DAY).toISOString()]);
  await t.requestOut(t.fundA, 50_000);
  await t.snapshot({ reserves: 150_000, obligations: 100_000 }); // 50,000 of room
  await ok(t.provider.client, "report_pool_movement", { movement_id: reversed.movement_id, outcome: "returned" });
  await t.db.query("UPDATE financial_products.money_movements SET reversed_at = $2 WHERE id = $1", [reversed.movement_id, new Date(t.getClock()).toISOString()]);
  // Another sponsor's outflow isn't out of this sponsor's reserves.
  await t.db.query(`INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, action, sponsor_entity_id, rail_id, direction, amount_cents, state, status) VALUES ($1, $2, $3, 'customer_payout', $4, $5, 'payout', 90000, 'us-ny', 'requested')`, [randomUUID(), `other-${randomUUID()}`, t.productId, t.fundB.entity.id, t.payoutRail.id]);
  await t.db.query(
    `INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, action, sponsor_entity_id, rail_id, direction, amount_cents, state, status) VALUES ($1, $2, $3, 'customer_payout', $4, $5, 'payout', 20000, 'us-ny', 'requested')`,
    [randomUUID(), `customer-${randomUUID()}`, t.productId, t.provider.entity.id, t.payoutRail.id],
  );
  await t.tick();
  const [claim] = await t.claims();
  assert.equal(Number(claim.amount_cents), 20_000, "50,000 less 20,000 of customers' payouts and a 10,000 deposit reversed after the snapshot");
});

test("only an admin clears an admin's pause, and approving never reopens a closed pool", async () => {
  const s = await world();
  await ok(s.admin, "pause_pool", { pool_id: s.pool.id, reason: "regulator asked" });
  for (const args of [{ reason: "my own pause" }, { reason: "closing it", close: true }]) {
    const r = await callTool(s.provider.client, "pause_pool", { pool_id: s.pool.id, ...args });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /admin must resume/);
  }
  const pool = await s.poolRow();
  assert.equal(pool.status, "paused");
  assert.equal(pool.paused_by_admin, true);
  await ok(s.admin, "resume_pool", { pool_id: s.pool.id });
  assert.equal((await s.poolRow()).paused_by_admin, false);

  const pending = await ok(s.builder.client, "create_pool", { product_id: s.productId, component_key: "account", name: "Never opened", sandbox: false, min_reserve_bps: 100, min_reserve_floor_cents: 0, notice_period_days: 0, max_commitment_cents: 1000 });
  await ok(s.provider.client, "pause_pool", { pool_id: pending.id, reason: "not going ahead", close: true });
  const refused = await callTool(s.provider.client, "approve_pool", { pool_id: pending.id, deposit_rail_id: s.depositRail.id, withdrawal_rail_id: s.payoutRail.id });
  assert.equal(refused.isError, true);
  assert.equal((await s.poolRow(pending.id)).status, "closed");
});

test("a claim with a ledger row is tied to it and never released", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  const w = await s.requestOut(s.fundA, 5_000);
  // The worker reached the chokepoint and died before tying the claim to the row it made.
  const id = randomUUID();
  const verdict = await authorizeMovement(s.store, { product_id: s.productId, sandbox: false, direction: "payout", amount_cents: 5_000, channel: { kind: "ramp_adapter", provider: "bridge" }, customer_state: "us-ny", customer_ref: "lp", idempotency_key: `pool-withdrawal:${id}`, action: "pool_withdrawal", component_key: "account", subscription_id: s.pool.id, request_id: id, sponsor_entity_id: s.provider.entity.id });
  assert.equal(verdict.allowed, true);
  await s.db.query(`INSERT INTO financial_products.pool_movements (id, idempotency_key, pool_id, lp_entity_id, kind, withdrawal_id, amount_cents, state, claimed_at) VALUES ($1, $2, $3, $4, 'withdrawal', $5, 5000, 'claimed', now() - interval '1 hour')`, [id, `pool-withdrawal:${id}`, s.pool.id, s.fundA.entity.id, w.id]);
  await s.db.query("UPDATE financial_products.pool_withdrawals SET status = 'paying' WHERE id = $1", [w.id]);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  // The rail's now suspended, so the chokepoint would refuse a fresh attempt.
  await ok(s.admin, "suspend_rail", { rail_id: s.payoutRail.id, reason: "partner incident" });
  s.advance(10 * 60_000);
  await s.tick();
  const [claim] = await s.claims();
  assert.equal(claim.movement_id, verdict.movement_id);
  assert.equal(claim.state, "authorized");
  assert.equal(claim.ledger_state, "in_flight", "the ledger row stands");
});

test("a settlement can't report more than was asked, a live one needs its reference, and a short one shows what settled", async () => {
  const s = await world();
  const c = await s.commit(s.fundA, 10_000);
  const over = await callTool(s.provider.client, "report_pool_movement", { movement_id: c.movement_id, outcome: "settled", external_ref: "ref-1", settled_amount_cents: 10_001 });
  assert.equal(over.isError, true);
  assert.equal(over.data.code, "over_settlement");
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'pool_movement_over_settlement'")).rows[0].n, 1);
  assert.equal((await s.position(s.fundA)).contributed_cents, 0);
  const noRef = await callTool(s.provider.client, "report_pool_movement", { movement_id: c.movement_id, outcome: "settled" });
  assert.equal(noRef.data.code, "external_ref_required");
  await s.settle(c.movement_id);

  await s.requestOut(s.fundA, 10_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  const [claim] = await s.claims();
  await s.settle(claim.movement_id, { settled_amount_cents: 9_000 });
  await s.tick();
  const [w] = await s.withdrawals(s.fundA);
  assert.equal(w.status, "paid_short");
  assert.equal(w.settled_cents, 9_000);
  assert.equal((await s.position(s.fundA)).withdrawn_cents, 9_000);
});

test("one firm can't freeze the queue: its state is locked, and a persistent refusal parks only its request", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  await s.funded(s.fundB, 10_000);
  const locked = await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 100, state: "us-ca", idempotency_key: "commit-new-state" });
  assert.equal(locked.data.code, "state_locked");
  assert.equal((await s.position(s.fundA)).state, "us-ny");

  // Something changed under the firm: its state no longer gets served. Three tries, then it's parked; the next is paid.
  await s.requestOut(s.fundA, 5_000);
  await s.requestOut(s.fundB, 5_000);
  await s.db.query("UPDATE financial_products.pool_commitments SET state = 'us-tx' WHERE lp_entity_id = $1", [s.fundA.entity.id]);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  await s.tick();
  let [a, b] = await s.withdrawals(s.admin);
  assert.equal(a.status, "queued");
  assert.equal(b.status, "queued", "held for a tick or two: it could be a blip");
  await s.tick();
  [a, b] = await s.withdrawals(s.admin);
  assert.equal(a.status, "parked");
  assert.match(a.status_reason, /state_not_sponsored/);
  assert.equal(b.status, "paying", "the firm behind it is paid");
  const place = a.seq;

  // The sponsor corrects the firm's state: audited, and the request is back in its place.
  await ok(s.provider.client, "set_pool_firm_state", { pool_id: s.pool.id, lp_entity_id: s.fundA.entity.id, state: "us-ny", reason: "address corrected" });
  [a] = await s.withdrawals(s.admin);
  assert.equal(a.status, "queued");
  assert.equal(a.seq, place);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'set_pool_firm_state'")).rows[0].n, 1);
  await s.tick();
  [a] = await s.withdrawals(s.admin);
  assert.equal(a.status, "paying");

  // A deposit rail serving states the withdrawal rail doesn't can't be approved.
  const narrow = await ok(s.provider.client, "propose_rail", { kind: "wire", provider: "bridge", direction: "payout", states: ["us-ny"], per_transfer_limit_cents: 10_000, daily_limit_cents: 10_000 });
  await ok(s.admin, "approve_rail", { rail_id: narrow.id });
  const pending = await ok(s.builder.client, "create_pool", { product_id: s.productId, component_key: "account", name: "Narrow", sandbox: false, min_reserve_bps: 100, min_reserve_floor_cents: 0, notice_period_days: 0, max_commitment_cents: 1000 });
  const refused = await callTool(s.provider.client, "approve_pool", { pool_id: pending.id, deposit_rail_id: s.depositRail.id, withdrawal_rail_id: narrow.id });
  assert.match(refused.data.error, /us-ca/);
});

test("crash recovery waits for the gate, and a recovered deposit is held to the offering flag", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  const k = "commit-crashed";
  const key = `pool-deposit:${s.pool.id}:${s.fundA.entity.id}:${k}`;
  const id = randomUUID();
  const pm = "financial_products.pool_movements";
  await s.db.query(`INSERT INTO ${pm} (id, idempotency_key, pool_id, lp_entity_id, kind, amount_cents, customer_state, state, claimed_at) VALUES ($1, $2, $3, $4, 'deposit', 500, 'us-ny', 'claimed', now() - interval '1 hour')`, [id, key, s.pool.id, s.fundA.entity.id]);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  s.advance(10 * 60_000);
  await ok(s.provider.client, "pause_pool", { pool_id: s.pool.id, reason: "looking" });
  await s.tick();
  assert.equal((await s.db.query(`SELECT state FROM ${pm} WHERE id = $1`, [id])).rows[0].state, "claimed", "nothing happens under a pause");
  await ok(s.provider.client, "resume_pool", { pool_id: s.pool.id });
  await ok(s.admin, "set_pool_offering_cleared", { pool_id: s.pool.id, cleared: false, legal_basis: "Counsel withdrew the opinion" });
  // A replay of that commitment is held to the flag too.
  const replay = await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 500, state: "us-ny", idempotency_key: k });
  assert.equal(replay.data.code, "offering_not_cleared");
  await s.tick();
  const [row] = (await s.db.query(`SELECT state, refusal, movement_id FROM ${pm} WHERE id = $1`, [id])).rows;
  assert.equal(row.state, "refused");
  assert.equal(row.refusal, "offering_not_cleared");
  assert.equal(row.movement_id, null);
});

test("sandbox money is marked as such wherever it appears", async () => {
  const s = await world({ sandbox: true });
  const c = await s.commit(s.fundA, 10_000);
  assert.equal(c.sandbox, true);
  const report = await s.settle(c.movement_id);
  assert.equal(report.sandbox, true);
  const p = await s.position(s.fundA);
  assert.equal(p.sandbox, true);
  assert.ok(p.entries.every((e) => e.sandbox === true));
  const w = await s.requestOut(s.fundA, 2_000);
  assert.equal(w.sandbox, true);
  const [listed] = await s.withdrawals(s.fundA);
  assert.equal(listed.sandbox, true);
  assert.equal((await ok(s.fundA.client, "cancel_withdrawal", { withdrawal_id: w.id })).sandbox, true);
});

test("a deposit under a health pause needs a trusted shortfall, and a second sponsor's pool reads its own books", async () => {
  const s = await world();
  await s.funded(s.fundA, 1_000);
  await s.snapshot({ reserves: 500_000, obligations: 1_000_000 });
  await s.tick();
  assert.equal((await s.poolRow()).pause_kind, "health");
  const allowed = await callTool(s.fundB.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 1000, state: "us-ny", idempotency_key: "commit-into-shortfall" });
  assert.equal(allowed.isError, false, JSON.stringify(allowed.data));

  // A second sponsor of another component, with its own pool.
  const bank = await s.firm("Bank Two", ["license_provider"]);
  const held = await moneyTransmitter(s.store, bank.user, ["us-ny"]);
  const asked = await s.store.requestSponsorship(s.builder.user.id, { product_id: s.productId, component_key: "second", builder_entity_id: s.builder.entity.id, provider_entity_id: bank.entity.id, requested_jurisdictions: ["us-ny"], note: null });
  await s.store.decideSponsorship(asked.id, { status: "approved", decided_by: bank.user.id, note: null, licence_ids: [held.id], jurisdictions: ["us-ny"] });
  const makeRail = async (direction) => {
    const r = await ok(bank.client, "propose_rail", { kind: "ramp_adapter", provider: "bridge", direction, states: ["us-ny"], per_transfer_limit_cents: 100_000, daily_limit_cents: 1_000_000 });
    return ok(s.admin, "approve_rail", { rail_id: r.id });
  };
  const [dep, pay] = [await makeRail("deposit"), await makeRail("payout")];
  const second = await ok(s.builder.client, "create_pool", { product_id: s.productId, component_key: "second", name: "Bank Two pool", sandbox: false, min_reserve_bps: 100, min_reserve_floor_cents: 0, notice_period_days: 0, max_commitment_cents: 100_000 });
  await ok(bank.client, "approve_pool", { pool_id: second.id, deposit_rail_id: dep.id, withdrawal_rail_id: pay.id });
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000, unsigned: true });
  const { rows } = await s.db.query("SELECT DISTINCT partner_entity_id FROM financial_products.product_health_snapshots WHERE pool_id = $1", [second.id]);
  assert.deepEqual(rows.map((r) => r.partner_entity_id), [bank.entity.id]);

  // Fund A holds money only in the first sponsor's pool: it doesn't read the second's books.
  assert.equal((await s.health.get(s.fundA.user, s.productId, second.id, 5)).history.length, 0);
  assert.deepEqual(await liquidityProviderBooks(s.store, s.productId, s.fundA.entity.id), [s.provider.entity.id]);
  // And only a member with the liquidity_provider role reads for the firm.
  const { user: colleague } = await s.store.createUser("Fund A analyst", ["innovator"]);
  await s.store.setUserEntity(colleague.id, s.fundA.entity.id);
  colleague.entity_id = s.fundA.entity.id;
  assert.equal(await s.health.entitlement(colleague, s.productId), null);
});

test("health access needs a settled position, and pool money stays out of the product's own figures", async () => {
  const s = await world();
  const c = await s.commit(s.fundA, 1);
  assert.equal(await s.health.entitlement(s.fundA.user, s.productId), null, "an unsettled commitment opens nothing");
  assert.deepEqual(await liquidityProviderBooks(s.store, s.productId, s.fundA.entity.id), [], "and no books");
  await s.settle(c.movement_id);
  assert.equal((await s.health.entitlement(s.fundA.user, s.productId)).as, "liquidity_provider");

  const started = await s.store.getSetting("money_ledger_started_at");
  const flows = await flowsFor(s.store, s.productId, started, new Date(Date.now() + 60_000));
  assert.equal(flows.flows.deposit, null, "a pool's capital isn't a customer flow, and null stays null");
  assert.ok(flows.not_measured.deposit);

  const sandbox = await s.createPool({ sandbox: true });
  await s.funded(s.fundB, 1_000, sandbox.id);
  await s.requestOut(s.fundB, 500, sandbox.id);
  assert.equal(await openWithdrawalRequests(s.store, s.productId, null), 0, "sandbox pools aren't in the product's figures");
  assert.equal(await openWithdrawalRequests(s.store, s.productId, sandbox.id), 1);
});

test("a settlement that would pay a re-paid withdrawal twice is refused and flagged", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  await s.requestOut(s.fundA, 10_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  const [first] = await s.claims();
  await ok(s.provider.client, "report_pool_movement", { movement_id: first.movement_id, outcome: "failed" });
  await s.tick();
  const claims = await s.claims();
  assert.equal(claims.filter((c) => c.ledger_state === "in_flight").length, 1, "the amount was claimed again");
  const late = await callTool(s.provider.client, "report_pool_movement", { movement_id: first.movement_id, outcome: "settled", external_ref: "ref-late" });
  assert.equal(late.isError, true);
  assert.equal(late.data.code, "reclaimed");
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'pool_late_settlement_refused'")).rows[0].n, 1);
  assert.equal((await s.position(s.fundA)).balance_cents, 10_000, "no negative balance");
});

test("a suspended firm isn't paid and doesn't hold up the firm behind it, and the sponsor sees a pool's hold", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  await s.funded(s.fundB, 10_000);
  await s.requestOut(s.fundA, 5_000);
  await s.requestOut(s.fundB, 5_000);
  await s.store.setEntityStatus(s.fundA.entity.id, "suspended");
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  const [a, b] = await s.withdrawals(s.admin);
  assert.equal(a.status, "queued");
  assert.equal(b.status, "paying");

  await ok(s.admin, "pause_pool", { pool_id: s.pool.id, reason: "regulator asked" });
  const [, held] = await s.withdrawals(s.provider.client);
  assert.equal(held.movements[0].movement_status, "requested");
  assert.match(held.movements[0].pool_hold, /regulator asked/);
});

test("a pool doesn't follow a replacement rail, a firm can't fund its own pool, and a replay says what really happened", async () => {
  const s = await world();
  const c = await s.commit(s.fundA, 10_000);
  await s.settle(c.movement_id);
  const replay = await ok(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 10_000, state: "us-ny", idempotency_key: "commit-replayed" });
  await s.settle(replay.movement_id);
  const again = await ok(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 10_000, state: "us-ny", idempotency_key: "commit-replayed" });
  assert.equal(again.replay, true);
  assert.equal(again.movement_status, "settled");

  await s.requestOut(s.fundA, 1_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await ok(s.admin, "revoke_rail", { rail_id: s.payoutRail.id, reason: "agreement ended" });
  const replacement = await ok(s.provider.client, "propose_rail", { kind: "ramp_adapter", provider: "bridge", direction: "payout", states: ["us-ny", "us-ca"], per_transfer_limit_cents: 100_000_000, daily_limit_cents: 900_000_000 });
  await ok(s.admin, "approve_rail", { rail_id: replacement.id });
  await s.tick();
  assert.match((await s.poolRow()).hold_reason, /rail_revoked/);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.money_movements WHERE rail_id = $1", [replacement.id])).rows[0].n, 0);

  const { user: insider } = await s.store.createUser("Builder's fund desk", ["liquidity_provider"]);
  await s.store.setUserEntity(insider.id, s.builder.entity.id);
  const insiderClient = await s.connect({ ...insider, entity_id: s.builder.entity.id });
  const refused = await callTool(insiderClient, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 100, state: "us-ny", idempotency_key: "commit-own-pool" });
  assert.equal(refused.data.code, "own_pool");
});

test("a parked request keeps its place and resumes by itself; many of one firm's requests can't stall the queue", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  await s.funded(s.fundB, 10_000);
  await s.requestOut(s.fundA, 1_000);
  await s.requestOut(s.fundA, 1_000);
  await s.requestOut(s.fundA, 1_000);
  await s.requestOut(s.fundB, 1_000);
  await s.db.query("UPDATE financial_products.pool_commitments SET state = 'us-tx' WHERE lp_entity_id = $1", [s.fundA.entity.id]);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  for (const _ of [1, 2, 3]) await s.tick();
  let queue = await s.withdrawals(s.admin);
  assert.deepEqual(queue.map((w) => w.status), ["parked", "queued", "queued", "paying"], "one parked, the firm's others passed over, the next firm paid");
  assert.equal((await s.position(s.fundA)).queued_withdrawal_cents, 3_000, "a parked request still holds its money");

  await s.db.query("UPDATE financial_products.pool_commitments SET state = 'us-ny' WHERE lp_entity_id = $1", [s.fundA.entity.id]);
  s.advance(16 * 60_000);
  await s.tick();
  queue = await s.withdrawals(s.admin);
  assert.deepEqual(queue.map((w) => w.status), ["paying", "paying", "paying", "paying"], "what was wrong has cleared: it keeps its place");
  assert.equal((await ok(s.fundA.client, "request_withdrawal", { pool_id: s.pool.id, amount_cents: 1_000, idempotency_key: "out-after-resume" })).status, "queued");
});

test("a late settlement can't take a firm's position below zero, even after its request was cancelled and asked again", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  const first = await s.requestOut(s.fundA, 10_000);
  await s.tick();
  const [claim] = await s.claims();
  await ok(s.provider.client, "report_pool_movement", { movement_id: claim.movement_id, outcome: "failed" });
  await ok(s.fundA.client, "cancel_withdrawal", { withdrawal_id: first.id });
  await s.requestOut(s.fundA, 10_000);
  await s.snapshot({ reserves: 2_000_000, obligations: 1_000_000 });
  await s.tick();
  const repaid = (await s.claims()).find((c) => c.ledger_state === "in_flight");
  await s.settle(repaid.movement_id);
  const late = await callTool(s.provider.client, "report_pool_movement", { movement_id: claim.movement_id, outcome: "settled", external_ref: "ref-late" });
  assert.equal(late.isError, true);
  assert.equal(late.data.code, "overdrawn");
  const p = await s.position(s.fundA);
  assert.equal(p.withdrawn_cents, 10_000);
  assert.equal(p.balance_cents, 0, "not -10,000");
  assert.equal((await s.db.query("SELECT details FROM financial_products.audit_log WHERE action = 'pool_late_settlement_refused'")).rows[0].details.code, "overdrawn");
  assert.ok((await opsStatus(s.db)).attention.some((a) => /liquidity pools/.test(a)), "flagged to admins");
});

test("an in-flight deposit locks a firm's state; a firm that has left may come back from another", async () => {
  const s = await world();
  const c = await s.commit(s.fundA, 10_000);
  const locked = await callTool(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 100, state: "us-ca", idempotency_key: "commit-locked-in-flight" });
  assert.equal(locked.data.code, "state_locked");
  await s.settle(c.movement_id);
  await s.requestOut(s.fundA, 10_000);
  await s.tick();
  await s.settle((await s.claims())[0].movement_id);
  await s.tick();
  assert.ok((await s.position(s.fundA)).exited);
  const back = await ok(s.fundA.client, "commit_to_pool", { pool_id: s.pool.id, amount_cents: 500, state: "us-ca", idempotency_key: "commit-back-from-ca" });
  assert.equal(back.movement_status, "requested");
  assert.equal((await s.position(s.fundA)).state, "us-ca", "the new state counts once the deposit is authorised");
});

test("a crashed claim with a ledger row is tied to it under any pause, and sandbox over-settlements raise no live flag", async () => {
  const s = await world();
  await s.funded(s.fundA, 10_000);
  const w = await s.requestOut(s.fundA, 5_000);
  const id = randomUUID();
  const verdict = await authorizeMovement(s.store, { product_id: s.productId, sandbox: false, direction: "payout", amount_cents: 5_000, channel: { kind: "ramp_adapter", provider: "bridge" }, customer_state: "us-ny", customer_ref: "lp", idempotency_key: `pool-withdrawal:${id}`, action: "pool_withdrawal", component_key: "account", subscription_id: s.pool.id, request_id: id, sponsor_entity_id: s.provider.entity.id });
  await s.db.query(`INSERT INTO financial_products.pool_movements (id, idempotency_key, pool_id, lp_entity_id, kind, withdrawal_id, amount_cents, state, claimed_at) VALUES ($1, $2, $3, $4, 'withdrawal', $5, 5000, 'claimed', now() - interval '1 hour')`, [id, `pool-withdrawal:${id}`, s.pool.id, s.fundA.entity.id, w.id]);
  await ok(s.admin, "pause_pool", { pool_id: s.pool.id, reason: "looking" });
  s.advance(10 * 60_000);
  await s.tick();
  const [claim] = await s.claims();
  assert.equal(claim.movement_id, verdict.movement_id, "linking moves no money");

  const sandbox = await s.createPool({ sandbox: true });
  const c = await s.commit(s.fundB, 1_000, sandbox.id);
  assert.equal((await callTool(s.provider.client, "report_pool_movement", { movement_id: c.movement_id, outcome: "settled", settled_amount_cents: 2_000 })).data.code, "over_settlement");
  assert.equal((await opsStatus(s.db)).attention.some((a) => /liquidity pools/.test(a)), false);
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
