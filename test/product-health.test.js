import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
const {
  ProductHealthService,
  buildFigures,
  canonicalJson,
  findGaps,
  fingerprintOf,
  normalizeFlows,
  openReport,
  sealReport,
  snapshotStatus,
} = await import("../dist/product-health.js");
const chainLib = await import("../dist/solana/product-health-chain.js");
const { compileMessage } = await import("../dist/solana/tx.js");
const { Keypair, base58Encode, anchorDiscriminator } = await import("../dist/solana/codec.js");
const { checkProgramRules } = await import("../dist/solana/program-rules.js");
const { sandboxPartnerLedger } = await import("../dist/partner-ledger/sandbox.js");
const { CATALOG } = await import("./helpers.js");

const PROGRAM_ID = "GLi9SM8q1Q8S1k5SFHWpZ7v9uWK9M5ZDxhd6ESjuSfVz";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // on the hour

// The program's own rules, in memory: the next sequence only, periods forward, a hash chain.
class FakeChain {
  programId = PROGRAM_ID;
  publisher = "PublisherFake11111111111111111111111111111111";
  heads = new Map();
  log = [];
  failing = false;
  async head(subject) {
    if (this.failing) throw new Error("the RPC was unreachable");
    return this.heads.get(Buffer.from(subject).toString("hex")) ?? null;
  }
  apply(subject, kind, e, opening) {
    if (this.failing) throw new Error("the RPC was unreachable");
    const k = Buffer.from(subject).toString("hex");
    const head = this.heads.get(k);
    assert.equal(opening, head === undefined, "opening only when no head exists");
    const at = head?.sequence ?? 0;
    assert.equal(e.sequence, at + 1, "the program refuses anything but the next sequence");
    assert.ok(e.period_end > e.period_start, "a period must end after it starts");
    assert.ok(e.period_start >= (head?.period_end ?? 0), "periods go forward");
    const fingerprint = e.fingerprint ?? chainLib.ZERO_32;
    const chain = chainLib.nextChain(head?.chain ?? chainLib.ZERO_32, e.sequence, fingerprint, kind);
    const next = { subject, sequence: e.sequence, fingerprint, period_start: e.period_start, period_end: e.period_end, kind, source: chainLib.SOURCE_FLAG[e.source] ?? 0, partner_signed: !!e.partner_signature, partner_key: e.partner_key ?? chainLib.ZERO_32, partner_signature: e.partner_signature ?? chainLib.ZERO_64, chain };
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

async function setup({ ledger, flows, config = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  let clock = T0 + 5 * 60_000;
  const chain = new FakeChain();
  const health = await ProductHealthService.open(
    db,
    store,
    { intervalMs: HOUR, cosignWindowMs: 10 * 60_000, pollMs: 60_000, programId: PROGRAM_ID, ...config },
    { chain, flowsFor: flows ?? null, ledgerFor: ledger ? () => ledger : undefined, now: () => new Date(clock) },
  );
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
  const s = await store.requestSponsorship(builder.user.id, { product_id: productId, component_key: "core", builder_entity_id: builder.entity.id, provider_entity_id: provider.entity.id, requested_jurisdictions: [], note: null });
  await store.decideSponsorship(s.id, { status: "approved", decided_by: provider.user.id, note: null });
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
  return { store, pg, health, chain, productId, provider, builder, stranger, admin, raw, set, tool, tickAt: async (t) => { set(t); await health.tick(); } };
}

const edKeyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const address = base58Encode(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url"));
  return { privateKey, address, sign: (fp) => edSign(null, Buffer.from(fp, "hex"), privateKey).toString("hex") };
};

const liveLedger = { id: "fake-live", name: "A fake live ledger", kind: "live", read: async (c) => ({ reserves_held_cents: 150_00, customer_obligations_cents: 100_00, as_of: c.period_end }) };

// ---- 1. the canonical encoding ----

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

// ---- 2. nulls stay null ----

test("a figure that can't be measured is null with a reason, never 0", () => {
  const f = buildFigures({ reading: { error: { code: "unreachable", message: "x" } }, flows: null });
  for (const [name, fig] of Object.entries(f)) {
    assert.equal(fig.value, null, name);
    assert.ok(fig.reason, `${name} says why`);
  }
  assert.throws(() => assert.notEqual(f.reserves_cents.value, null));
  // Zero obligations: coverage is undefined, not infinite and not zero.
  const noObligations = buildFigures({ reading: { reserves_held_cents: 500_00, customer_obligations_cents: 0, as_of: "2026-11-09T00:00:00Z" }, flows: null });
  assert.equal(noObligations.reserves_cents.value, 500_00);
  assert.equal(noObligations.obligations_cents.value, 0);
  assert.equal(noObligations.coverage_bps.value, null);
  assert.match(noObligations.coverage_bps.reason, /undefined/);
  // A half-reported ledger keeps the other half null.
  const halfMeasured = buildFigures({ reading: { reserves_held_cents: null, customer_obligations_cents: 100_00, as_of: "2026-11-09T00:00:00Z", reason: "reserves are reconciling" }, flows: null });
  assert.equal(halfMeasured.reserves_cents.value, null);
  assert.equal(halfMeasured.reserves_cents.reason, "reserves are reconciling");
  assert.equal(halfMeasured.coverage_bps.value, null);
});

test("flows from the money rails are mapped by direction and status; anything else is null", () => {
  const f = buildFigures({
    reading: { reserves_held_cents: 150_00, customer_obligations_cents: 100_00, as_of: "2026-11-09T00:00:00Z" },
    flows: normalizeFlows({ in: { settled: 8_00, pending: 1_00, failed: 1_00, reversed: 1_00 }, out: { settled: 2_00, pending: 0, failed: 0, reversed: 0 } }),
  });
  assert.equal(f.coverage_bps.value, 15_000);
  assert.equal(f.flows_in_cents.value, 8_00);
  assert.equal(f.flows_out_cents.value, 2_00);
  assert.equal(f.pending_settlements_cents.value, 1_00);
  assert.equal(f.reversal_rate_bps.value, 909); // 1 of (8 + 2 + 1), floored
  assert.equal(f.failure_rate_bps.value, 833); // 1 of (8 + 2 + 1 + 1), floored
  assert.equal(normalizeFlows(null), null);
  assert.equal(normalizeFlows("bad"), null);
  // A total the rails didn't report is null, not 0.
  const partial = buildFigures({ reading: null, flows: normalizeFlows({ in: { settled: 1_00 }, out: {} }) });
  assert.equal(partial.flows_in_cents.value, 1_00);
  assert.equal(partial.flows_out_cents.value, null);
  assert.equal(partial.pending_settlements_cents.value, null);
  assert.equal(partial.reversal_rate_bps.value, null);
});

test("every snapshot is complete, in integer cents, with nulls and their reasons where nothing is measured", async () => {
  const { health, productId, provider, tickAt } = await setup({ flows: async () => null });
  await tickAt(T0 + 5 * 60_000);
  const out = await health.get(provider.user, productId, null, 10);
  const r = out.latest.report;
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

// ---- 3. entitlement ----

test("only the licence provider's own firm reads the numbers; builders, other firms and admins are refused", async () => {
  const { health, productId, provider, builder, stranger, admin, tool, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  assert.ok((await health.get(provider.user, productId, null, 5)).latest.report);
  for (const u of [builder.user, stranger.user, admin]) {
    await assert.rejects(health.get(u, productId, null, 5), /aren't entitled/);
  }

  const numbers = await tool(provider.user, "get_product_health", { product_id: productId });
  assert.equal(numbers.isError, false);
  assert.ok(numbers.data.latest.report.figures);
  const adminNumbers = await tool(admin, "get_product_health", { product_id: productId });
  assert.equal(adminNumbers.isError, true);
  assert.match(adminNumbers.data.error, /aren't entitled/);
  // Status, fingerprints and gaps are enough for admins and the product's own firm.
  const listed = await tool(admin, "list_product_health", { product_id: productId });
  assert.equal(listed.isError, false);
  assert.ok(listed.data[0].snapshots[0].fingerprint);
  // Status only: no report and no figure of any kind in what's listed.
  const listedText = JSON.stringify(listed.data);
  for (const key of ['"figures":', '"report":', "reserves_cents", "obligations_cents", "coverage_bps"]) assert.equal(listedText.includes(key), false, key);
  // A firm with nothing to do with the product can't list it either.
  const strangersList = await tool(stranger.user, "list_product_health", { product_id: productId });
  assert.deepEqual(strangersList.data, []);

  const toolNames = async (u) => (await tool(u, "list_product_health", {})).tools;
  assert.ok(!(await toolNames(builder.user)).includes("get_product_health"));
  assert.ok((await toolNames(provider.user)).includes("get_product_health"));
});

test("withdrawing a sponsorship ends access to the numbers at once", async () => {
  const { store, health, productId, provider, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  const [s] = await store.sponsorships({ product_id: productId, status: "approved" });
  await store.decideSponsorship(s.id, { status: "revoked", decided_by: provider.user.id, note: "bad behaviour" });
  await assert.rejects(health.get(provider.user, productId, null, 5), /aren't entitled/);
});

test("a reader added later as a liquidity provider gets the numbers; the list decides, not the code", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const { user: lp } = await store.createUser("LP person", ["license_provider"]);
  const entity = await store.createEntity(null, { name: "Liquidity Fund", registration_numbers: {}, regions: ["US"] });
  await store.setUserEntity(lp.id, entity.id);
  lp.entity_id = entity.id;
  const health = await ProductHealthService.open(db, store, { intervalMs: HOUR, cosignWindowMs: 0, pollMs: 60_000, programId: null }, { chain: null, liquidityProvidersOf: async () => [entity.id] });
  const firm = await health.entitlement(lp, "anything");
  assert.equal(firm.as, "liquidity_provider");
});

// ---- 4. tamper evidence ----

test("tampering with a stored report fails verification, however it's done", async () => {
  const { raw, pg, health, productId, provider, chain, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  const before = await health.get(provider.user, productId, null, 5);
  assert.equal(before.latest.verification.report_matches_fingerprint, true);
  assert.equal(before.latest.verification.on_chain, "matches");
  assert.equal(before.latest.verification.verified, true);

  const [row] = await raw("SELECT id, report_sealed, fingerprint, subject, sequence FROM financial_products.product_health_snapshots");
  // Flip a byte of the sealed report: the authenticated encryption refuses it.
  const parts = row.report_sealed.split(":");
  const ct = Buffer.from(parts[3], "base64");
  ct[0] ^= 1;
  await pg.query("UPDATE financial_products.product_health_snapshots SET report_sealed = $2 WHERE id = $1", [row.id, [...parts.slice(0, 3), ct.toString("base64")].join(":")]);
  const tampered = await health.get(provider.user, productId, null, 5);
  assert.equal(tampered.latest.report, null);
  assert.equal(tampered.latest.verification.report_matches_fingerprint, false);
  assert.equal(tampered.latest.verification.verified, false);
  assert.match(tampered.latest.verification.detail, /doesn't match/);

  // Rewrite the report and its fingerprint so they agree, as someone with Mynt's own keys could. Mynt's record is
  // self-consistent, but it no longer matches what the chain holds.
  await pg.query("UPDATE financial_products.product_health_snapshots SET report_sealed = $2 WHERE id = $1", [row.id, row.report_sealed]);
  const key = await health.dataKey(row.subject);
  const forged = canonicalJson({ forged: true });
  const newFp = fingerprintOf(forged);
  await pg.query("UPDATE financial_products.product_health_snapshots SET fingerprint = $2, report_sealed = $3 WHERE id = $1", [row.id, newFp, sealReport(key, forged, row.subject, row.sequence, newFp)]);
  const rewritten = await health.get(provider.user, productId, null, 5);
  assert.equal(rewritten.latest.verification.report_matches_fingerprint, true);
  assert.equal(rewritten.latest.verification.on_chain, "mismatch");
  assert.equal(rewritten.latest.verification.verified, false);

  // A sealed report can't be moved to another product or sequence either.
  assert.throws(() => openReport(key, row.report_sealed, row.subject, row.sequence + 1, row.fingerprint));
  assert.ok(chain.log.length);
});

test("an on-chain check that can't run says unavailable, never that it matched", async () => {
  const { health, chain, productId, provider, tickAt } = await setup();
  await tickAt(T0 + 5 * 60_000);
  chain.failing = true;
  const out = await health.get(provider.user, productId, null, 5);
  assert.equal(out.latest.verification.on_chain, "unavailable");
  assert.equal(out.latest.verification.verified, false);
  assert.match(out.chain.unavailable, /unreachable/);
});

// ---- 5. the partner's co-signature ----

test("a bad partner signature is refused; a good one makes the snapshot partner_signed", async () => {
  const { health, productId, provider, stranger, chain, tickAt, set } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const [{ snapshots: [snap] }] = await health.listFor(provider.user, productId, 5);
  assert.equal(snap.status, "pending_signature");
  assert.equal(chain.log.length, 0, "not published while waiting for the partner");

  // The wrong key, the wrong message, a stranger: none count.
  const other = edKeyPair();
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, other.sign(snap.fingerprint)), /doesn't verify/);
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, key.sign("00".repeat(32))), /doesn't verify/);
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, "ab".repeat(64)), /doesn't verify/);
  await assert.rejects(health.submitSignature(stranger.user, productId, null, 1, key.sign(snap.fingerprint)), /Only the licence provider/);
  assert.equal((await health.listFor(provider.user, productId, 5))[0].snapshots[0].status, "pending_signature");

  await health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint));
  set(T0 + 6 * 60_000);
  await health.tick();
  const [view] = await health.listFor(provider.user, productId, 5);
  assert.equal(view.snapshots[0].status, "published");
  assert.equal(view.snapshots[0].attestation, "partner_signed");
  assert.equal(view.snapshots[0].live, true);
  assert.equal(view.snapshots[0].verified, true);
  assert.equal(chain.log[0].partner_signed, true);
  assert.equal(Buffer.from(chain.log[0].fingerprint).toString("hex"), snap.fingerprint);
});

test("with no signature by the deadline the snapshot publishes as mynt_only and says so; a live product isn't verified", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ ledger: liveLedger });
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  assert.equal(chain.log.length, 0);
  await tickAt(T0 + 16 * 60_000); // past the 10-minute window
  const [view] = await health.listFor(provider.user, productId, 5);
  assert.equal(view.snapshots[0].status, "published");
  assert.equal(view.snapshots[0].attestation, "mynt_only");
  assert.equal(view.snapshots[0].live, true);
  assert.equal(view.snapshots[0].verified, false);
  assert.match(view.snapshots[0].notes.join(" "), /without the licence provider's co-signature/);
  assert.equal(chain.log[0].partner_signed, false);
  // Too late: a signature on a published snapshot can't change what's on chain.
  await assert.rejects(health.submitSignature(provider.user, productId, null, 1, key.sign(view.snapshots[0].fingerprint)), /it can only be co-signed/);
});

test("the signing key must be a real Ed25519 key of a licence provider firm", async () => {
  const { health, builder, provider } = await setup();
  await assert.rejects(health.registerSigningKey(builder.user, edKeyPair().address), /Only a licence provider/);
  await assert.rejects(health.registerSigningKey(provider.user, "not-a-key"), /Ed25519/);
  const [pda] = (await import("../dist/solana/codec.js")).findProgramAddress([Buffer.from("x")], PROGRAM_ID);
  await assert.rejects(health.registerSigningKey(provider.user, pda), /Ed25519/);
});

// ---- 6. sandbox can never read as live ----

test("a sandbox snapshot of a published product never reads as live or verified", async () => {
  const { health, productId, provider, chain, raw, pg, tickAt } = await setup();
  const key = edKeyPair();
  await health.registerSigningKey(provider.user, key.address);
  await tickAt(T0 + 5 * 60_000);
  const [{ snapshots: [snap] }] = await health.listFor(provider.user, productId, 5);
  await health.submitSignature(provider.user, productId, null, 1, key.sign(snap.fingerprint));
  await tickAt(T0 + 6 * 60_000);
  const [view] = await health.listFor(provider.user, productId, 5);
  assert.equal(view.snapshots[0].source, "sandbox");
  assert.equal(view.snapshots[0].attestation, "partner_signed");
  assert.equal(view.snapshots[0].live, false);
  assert.equal(view.snapshots[0].verified, false);
  assert.match(view.snapshots[0].notes.join(" "), /Sandbox/);
  assert.equal(chain.log[0].source, chainLib.SOURCE_FLAG.sandbox);
  const report = (await health.get(provider.user, productId, null, 5)).latest.report;
  assert.equal(report.live, false);
  assert.equal(report.source, "sandbox");

  // Even a row altered to say live can't read as live.
  const [row] = await raw("SELECT id FROM financial_products.product_health_snapshots");
  await pg.query("UPDATE financial_products.product_health_snapshots SET live = true WHERE id = $1", [row.id]);
  const after = (await health.listFor(provider.user, productId, 5))[0].snapshots[0];
  assert.equal(after.live, false);
  assert.equal(after.verified, false);
  assert.equal(sandboxPartnerLedger.kind, "sandbox");
});

test("snapshotStatus trusts nothing but the source for liveness", () => {
  const row = { live: true, source: "sandbox", attestation: "partner_signed", status: "published", period_start: "2026-11-09T00:00:00Z", period_end: "2026-11-09T01:00:00Z", on_chain: true };
  const out = snapshotStatus(row);
  assert.equal(out.live, false);
  assert.equal(out.verified, false);
});

// ---- 7. gaps ----

test("sequence numbers are gapless, and a stretch with no snapshot is recorded as missed", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  await tickAt(T0 + 5 * 60_000);
  await tickAt(T0 + HOUR + 5 * 60_000);
  // Mynt didn't run for 5 hours.
  await tickAt(T0 + 6 * HOUR + 5 * 60_000);
  const out = await health.get(provider.user, productId, null, 50);
  const seqs = out.history.map((h) => h.sequence).reverse();
  assert.deepEqual(seqs, [1, 2, 3, 4]);
  assert.deepEqual(chain.log.map((l) => l.sequence), [1, 2, 3, 4]);
  const missed = out.history.find((h) => h.status === "missed");
  assert.equal(missed.sequence, 3);
  assert.equal(missed.report, null);
  assert.equal(chain.log[2].kind, chainLib.KIND_MISSED);
  assert.ok(out.gaps.some((g) => g.kind === "missed" && g.sequence === 3));
  assert.equal(out.latest.verification.on_chain, "matches", "a recorded miss keeps the chain whole");
});

test("a snapshot that can't reach the chain before its deadline is recorded as missed, and the chain catches up", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  chain.failing = true;
  await tickAt(T0 + 5 * 60_000);
  let [view] = await health.listFor(provider.user, productId, 5);
  assert.equal(view.snapshots[0].status, "ready");
  await tickAt(T0 + 7 * 60_000); // backoff: not yet
  chain.failing = true;
  await tickAt(T0 + 2 * HOUR + 5 * 60_000); // past snapshot 1's deadline; the hour with no tick is itself a miss
  [view] = await health.listFor(provider.user, productId, 5);
  const bySeq = (n) => view.snapshots.find((s) => s.sequence === n);
  assert.equal(bySeq(1).status, "missed");
  assert.match(bySeq(1).notes.join(" "), /Couldn't publish before the deadline/);
  assert.equal(bySeq(2).status, "missed");
  assert.match(bySeq(2).notes.join(" "), /computed no snapshot/);
  assert.equal(chain.log.length, 0);
  chain.failing = false;
  await tickAt(T0 + 2 * HOUR + 10 * 60_000);
  [view] = await health.listFor(provider.user, productId, 5);
  // All in order: the markers for 1 and 2, then snapshot 3.
  assert.deepEqual(chain.log.map((l) => [l.sequence, l.kind]), [[1, chainLib.KIND_MISSED], [2, chainLib.KIND_MISSED], [3, chainLib.KIND_SNAPSHOT]]);
  assert.ok(view.gaps.some((g) => g.kind === "missed" && g.sequence === 1));
  assert.ok(view.gaps.some((g) => g.kind === "missed" && g.sequence === 2));
});

test("findGaps sees a missed record, a broken sequence, a stretch of nothing and a stale record", () => {
  const row = (sequence, start, end, status = "published", on_chain = true) => ({ sequence, period_start: new Date(start), period_end: new Date(end), status, on_chain, missed_reason: status === "missed" ? "no snapshot" : null });
  const gaps = findGaps([row(1, T0, T0 + HOUR), row(2, T0 + HOUR, T0 + 2 * HOUR, "missed", false), row(4, T0 + 3 * HOUR, T0 + 4 * HOUR)], { sequence: 6 }, new Date(T0 + 7 * HOUR), HOUR);
  assert.deepEqual(gaps.map((g) => g.kind).sort(), ["chain_ahead", "missed", "overdue", "period_gap", "sequence_gap"].sort());
});

test("the chain behind Mynt's own record is a gap too", () => {
  const gaps = findGaps([{ sequence: 3, period_start: new Date(T0), period_end: new Date(T0 + HOUR), status: "published", on_chain: true, missed_reason: null }], { sequence: 2 }, new Date(T0 + HOUR), HOUR);
  assert.ok(gaps.some((g) => g.kind === "chain_behind"));
});

test("a transaction that landed without Mynt seeing it is recognised instead of being sent twice", async () => {
  const { health, productId, provider, chain, tickAt } = await setup({ config: { cosignWindowMs: 0 } });
  const original = chain.publishSnapshot.bind(chain);
  chain.publishSnapshot = async (...a) => {
    await original(...a); // it lands, but Mynt hears a timeout
    throw new Error("Transaction wasn't confirmed in time");
  };
  await tickAt(T0 + 5 * 60_000);
  chain.publishSnapshot = original;
  await tickAt(T0 + 40 * 60_000);
  const [view] = await health.listFor(provider.user, productId, 5);
  assert.equal(view.snapshots[0].status, "published");
  assert.equal(view.snapshots[0].on_chain, true);
  assert.equal(chain.log.length, 1);
});

// ---- 8. the publisher key ----

const anySigner = Keypair.generate();

test("the publisher key signs the product-health program's instructions and nothing else", async () => {
  const { HealthPublisher, healthIx, subjectKey } = chainLib;
  const key = Keypair.generate();
  const publisher = new HealthPublisher(key, PROGRAM_ID);
  const blockhash = base58Encode(randomBytes(32));
  const subject = subjectKey("p1", null);
  const entry = { sequence: 1, fingerprint: new Uint8Array(32).fill(7), period_start: 1, period_end: 2, source: "sandbox", partner_key: null, partner_signature: null };
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

  // It doesn't pay for, or sign for, someone else's transaction.
  const notPayer = compileMessage(anySigner.address, [healthIx.recordSnapshot(PROGRAM_ID, key.address, subject, entry)], blockhash);
  await assert.rejects(publisher.sign(notPayer.bytes), /pays for/);

  await assert.rejects(publisher.sign(Uint8Array.of(1, 2, 3)), /can read/);
  // Keeps its secret to itself: no enumerable fields, no serialization.
  assert.equal(JSON.stringify(publisher).includes(Buffer.from(key.secret()).toString("hex")), false);
});

// ---- wire format and the program itself ----

test("instruction data and a head account match the program's layout", () => {
  const { healthIx, decodeHead, HEAD_SIZE, subjectKey, headAddress, configAddress } = chainLib;
  const subject = subjectKey("p1", null);
  const publisher = Keypair.generate().address;
  const entry = { sequence: 3, fingerprint: new Uint8Array(32).fill(9), period_start: 1_762_689_600, period_end: 1_762_693_200, source: "partner_ledger", partner_key: new Uint8Array(32).fill(1), partner_signature: new Uint8Array(64).fill(2) };
  const ix = healthIx.recordSnapshot(PROGRAM_ID, publisher, subject, entry);
  const data = Buffer.from(ix.data);
  assert.deepEqual([...data.subarray(0, 8)], [...anchorDiscriminator("global", "record_snapshot")]);
  assert.equal(data.length, 8 + 32 + 8 + 32 + 8 + 8 + 1 + 32 + 64);
  assert.equal(data.readBigUInt64LE(8 + 32), 3n);
  assert.equal(data[8 + 32 + 8 + 32 + 8 + 8], chainLib.SOURCE_FLAG.partner_ledger);
  assert.equal(ix.keys[1].pubkey, headAddress(PROGRAM_ID, subject));
  assert.equal(ix.keys[0].pubkey, configAddress(PROGRAM_ID));

  const buf = Buffer.alloc(HEAD_SIZE);
  Buffer.from(anchorDiscriminator("account", "Head")).copy(buf, 0);
  Buffer.from(subject).copy(buf, 8);
  buf.writeBigUInt64LE(5n, 40);
  buf.fill(4, 48, 80); // fingerprint
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
  // No hard-coded admin: the only literal key in the program is its own address.
  const literals = [...lib.matchAll(/"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(literals)], [PROGRAM_ID]);
});
