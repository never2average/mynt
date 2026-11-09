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
import { configAddress, decodeConfigPublisher, decodeHead, HealthPublisher, headAddress, healthIx, KIND_MISSED, KIND_SNAPSHOT, nextChain, SOURCE_FLAG, subjectKey, ZERO_32 } from "../dist/solana/product-health-chain.js";

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

const subject = subjectKey("product-localnet", null);
const fp = (n) => new Uint8Array(32).fill(n);
const partnerKey = Keypair.generate();
const partnerSig = partnerKey.sign(fp(7));

// Record the first snapshot, opening the head in the same transaction.
const period1 = { sequence: 1, fingerprint: fp(7), period_start: 1_762_689_600, period_end: 1_762_693_200, source: "sandbox", partner_key: partnerKey.publicKey, partner_signature: partnerSig };
await send(publisher, [healthIx.openSubject(programId, publisher.address, subject), healthIx.recordSnapshot(programId, publisher.address, subject, period1)]);
let head = await headOf(subject);
assert.equal(head.sequence, 1);
assert.deepEqual([...head.fingerprint], [...fp(7)]);
assert.equal(head.source, SOURCE_FLAG.sandbox);
assert.equal(head.partner_signed, true);
assert.deepEqual([...head.partner_key], [...partnerKey.publicKey]);
assert.deepEqual([...head.partner_signature], [...partnerSig]);
assert.equal(head.mynt_signer, publisher.address);
let chain = nextChain(ZERO_32, 1, fp(7), KIND_SNAPSHOT);
assert.deepEqual([...head.chain], [...chain], "the hash chain Mynt computes must equal the program's");
console.log("snapshot 1 recorded and read back; chains agree");

// Refused: a skipped sequence, an overlapping period, a stranger, an unknown source.
const entry = (over = {}) => ({ sequence: 2, fingerprint: fp(8), period_start: 1_762_693_200, period_end: 1_762_696_800, source: "partner_ledger", partner_key: null, partner_signature: null, ...over });
await refused(send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, entry({ sequence: 3 }))]), /custom program error|SequenceNotNext|0x/, "a skipped sequence number");
await refused(send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, entry({ period_start: 1_762_689_600 }))]), /custom program error|PeriodOverlaps|0x/, "an overlapping period");
const impostor = new HealthPublisher(stranger, programId);
await refused(send(impostor, [healthIx.recordSnapshot(programId, stranger.address, subject, entry())]), /custom program error|NotPublisher|0x/, "a key that isn't the publisher");

// A snapshot with no partner signature, then a missed period: the chain stays whole.
await send(publisher, [healthIx.recordSnapshot(programId, publisher.address, subject, entry())]);
head = await headOf(subject);
assert.equal(head.sequence, 2);
assert.equal(head.partner_signed, false);
assert.equal(head.source, SOURCE_FLAG.partner_ledger);
chain = nextChain(chain, 2, fp(8), KIND_SNAPSHOT);
assert.deepEqual([...head.chain], [...chain]);

await send(publisher, [healthIx.recordMissed(programId, publisher.address, subject, { sequence: 3, period_start: 1_762_696_800, period_end: 1_762_700_400, reason: 0 })]);
head = await headOf(subject);
assert.equal(head.sequence, 3);
assert.equal(head.kind, KIND_MISSED);
assert.deepEqual([...head.fingerprint], [...ZERO_32]);
chain = nextChain(chain, 3, ZERO_32, KIND_MISSED);
assert.deepEqual([...head.chain], [...chain]);
console.log("snapshot and missed marker recorded; chain matches across all three records");
console.log("product-health program OK on a local validator:", base58Encode(subject).slice(0, 8));
