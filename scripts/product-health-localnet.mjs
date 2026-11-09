#!/usr/bin/env node
// Runs Mynt's own encoders against the real product-health program on a local validator: what the unit tests fake.
// CI starts the validator with the program loaded and calls this:
//
//   node scripts/product-health-localnet.mjs --rpc <url> --program-id <address> --authority <upgrade-authority.json>
//
// Proves initialisation is the upgrade authority's alone, a record lands and reads back, the program refuses a skipped
// sequence and a stranger, and the hash chain Mynt computes equals the one the program computes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { base58Decode, base58Encode, findProgramAddress, Keypair } from "../dist/solana/codec.js";
import { compileMessage, serializeTransaction } from "../dist/solana/tx.js";
import { configAddress, cosignMessage, decodeConfigPublisher, partnerCommitment, decodeHead, HealthPublisher, headAddress, healthIx, KIND_MISSED, KIND_SNAPSHOT, nextChain, SOURCE_FLAG, subjectKey, ZERO_32 } from "../dist/solana/product-health-chain.js";

const { values } = parseArgs({ options: { rpc: { type: "string" }, "program-id": { type: "string" }, authority: { type: "string" } } });
const programId = values["program-id"];
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const authority = Keypair.fromSecret(Uint8Array.from(JSON.parse(readFileSync(values.authority, "utf8"))));

let id = 0;
async function rpc(method, params = []) {
  const res = await fetch(values.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 800)}`);
  return body.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function confirm(signature) {
  for (let i = 0; i < 80; i++) {
    const { value } = await rpc("getSignatureStatuses", [[signature]]);
    if (value[0]?.err) throw new Error(`transaction failed: ${JSON.stringify(value[0].err)}`);
    if (["confirmed", "finalized"].includes(value[0]?.confirmationStatus)) return;
    await sleep(250);
  }
  throw new Error("not confirmed");
}

const airdrop = async (address) => confirm(await rpc("requestAirdrop", [address, 2_000_000_000]));
// Signs with the keys it's given; `publisher` signs through the guard, exactly as production does.
async function send(payer, ixs, keys = []) {
  const { value } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const message = compileMessage(payer.address, ixs, value.blockhash);
  const signatures = new Map();
  for (const s of message.signers) {
    const signer = [payer, ...keys].find((k) => k.address === s);
    assert.ok(signer, `no signature for ${s}`);
    signatures.set(s, await signer.sign(message.bytes));
  }
  const wire = serializeTransaction(message, signatures);
  const signature = await rpc("sendTransaction", [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
  await confirm(signature);
  return signature;
}
const refused = async (promise, pattern, what) => {
  let error = null;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  assert.ok(error, `${what}: the program accepted it`);
  assert.match(error.message, pattern, what);
  console.log(`refused as expected: ${what}`);
};
const headOf = async (subject) => {
  const { value } = await rpc("getAccountInfo", [headAddress(programId, subject), { encoding: "base64", commitment: "confirmed" }]);
  return value ? decodeHead(Buffer.from(value.data[0], "base64")) : null;
};

const key = Keypair.generate();
const publisher = new HealthPublisher(key, programId);
await airdrop(publisher.address);
await airdrop(authority.address);
const programData = findProgramAddress([base58Decode(programId)], LOADER)[0];

// Only the upgrade authority can name the publisher.
const stranger = Keypair.generate();
await airdrop(stranger.address);
await refused(send(publisher, [healthIx.initialize(programId, publisher.address, stranger.address, programData)], [stranger]), /NotUpgradeAuthority|custom program error|0x/, "initialising without the upgrade authority");
await send(publisher, [healthIx.initialize(programId, publisher.address, authority.address, programData)], [authority]);
const { value: config } = await rpc("getAccountInfo", [configAddress(programId), { encoding: "base64", commitment: "confirmed" }]);
assert.equal(decodeConfigPublisher(Buffer.from(config.data[0], "base64")), publisher.address);
console.log("initialised; publisher on chain:", publisher.address);
await refused(send(publisher, [healthIx.initialize(programId, publisher.address, authority.address, programData)], [authority]), /already in use|custom program error|0x/, "initialising twice");

const subject = subjectKey(Keypair.generate().publicKey, "product-localnet", null);
const fp = (n) => new Uint8Array(32).fill(n);
const partnerKey = Keypair.generate();
const partnerSig = partnerKey.sign(cosignMessage(fp(7)));
const commitment = partnerCommitment(subject, partnerKey.publicKey, partnerSig);
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;
const P0 = NOW - 10 * HOUR;

// Record the first snapshot, opening the head in the same transaction.
const period1 = { sequence: 1, fingerprint: fp(7), period_start: P0, period_end: P0 + HOUR, source: "sandbox", partner_commitment: commitment };
await send(publisher, [healthIx.openSubject(programId, publisher.address, subject), healthIx.recordSnapshot(programId, publisher.address, subject, period1)]);
let head = await headOf(subject);
assert.equal(head.sequence, 1);
assert.deepEqual([...head.fingerprint], [...fp(7)]);
assert.equal(head.source, SOURCE_FLAG.sandbox);
assert.equal(head.partner_signed, true);
assert.deepEqual([...head.partner_commitment], [...commitment]);
assert.equal(head.mynt_signer, publisher.address);
const link = (e, kind) => ({ subject, sequence: e.sequence, fingerprint: e.fingerprint ?? ZERO_32, period_start: e.period_start, period_end: e.period_end, kind, source: SOURCE_FLAG[e.source] ?? 0, partner_commitment: e.partner_commitment ?? ZERO_32 });
let chain = nextChain(ZERO_32, link(period1, KIND_SNAPSHOT));
assert.deepEqual([...head.chain], [...chain], "the hash chain Mynt computes must equal the program's");
console.log("snapshot 1 recorded and read back; chains agree");

// Refused: a skipped sequence, an overlapping period, a gap in time, a future period, a stranger.
const entry = (over = {}) => ({ sequence: 2, fingerprint: fp(8), period_start: P0 + HOUR, period_end: P0 + 2 * HOUR, source: "partner_ledger", partner_commitment: null, ...over });
await refused(send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, entry({ sequence: 3 }))]), /custom program error|SequenceNotNext|0x/, "a skipped sequence number");
await refused(send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, entry({ period_start: P0 }))]), /custom program error|PeriodNotContiguous|0x/, "an overlapping period");
await refused(send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, entry({ period_start: P0 + 2 * HOUR, period_end: P0 + 3 * HOUR }))]), /custom program error|PeriodNotContiguous|0x/, "a gap between periods");
await refused(send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, entry({ period_end: NOW + 2 * HOUR }))]), /custom program error|PeriodInFuture|0x/, "a period ending in the future");
const impostor = new HealthPublisher(stranger, programId);
await refused(send(impostor, [healthIx.recordSnapshot(programId, stranger.address, subject, entry())]), /custom program error|NotPublisher|0x/, "a key that isn't the publisher");

// A snapshot with no partner signature, then a missed period: the chain stays whole.
const second = entry();
await send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, second)]);
head = await headOf(subject);
assert.equal(head.sequence, 2);
assert.equal(head.partner_signed, false);
assert.equal(head.source, SOURCE_FLAG.partner_ledger);
chain = nextChain(chain, link(second, KIND_SNAPSHOT));
assert.deepEqual([...head.chain], [...chain]);

const third = { sequence: 3, period_start: P0 + 2 * HOUR, period_end: P0 + 3 * HOUR, reason: 0 };
await send(publisher, [healthIx.recordMissed(programId, publisher.address, subject, third)]);
head = await headOf(subject);
assert.equal(head.sequence, 3);
assert.equal(head.kind, KIND_MISSED);
assert.deepEqual([...head.fingerprint], [...ZERO_32]);
chain = nextChain(chain, link(third, KIND_MISSED));
assert.deepEqual([...head.chain], [...chain]);
console.log("snapshot and missed marker recorded; chain matches across all three records");
console.log("product-health program OK on a local validator:", base58Encode(subject).slice(0, 8));
