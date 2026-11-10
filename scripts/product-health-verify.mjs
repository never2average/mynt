#!/usr/bin/env node
// Checks a product-health snapshot without trusting Mynt. It uses nothing from this repository, only Node's standard
// library and a Solana RPC of your choosing, so a licence provider or liquidity provider can read it and run it alone.
//
//   node product-health-verify.mjs --file answer.json --rpc <solana rpc url> --program-id <address> \
//     [--partner-key <your firm's key, base58>] [--sequence N] [--epoch E]
//
// --file is the saved answer of get_product_health. Mynt wrote that file, so nothing it says about where to look is
// believed: --program-id must come from somewhere else (the operator gives it to you directly, in writing) and
// --partner-key is the key your own firm holds. The script checks:
//
//   - the report hashes to the fingerprint;
//   - the partner's Ed25519 signature verifies, under the key you named;
//   - the head account at the address derived from the program id and the subject is owned by that program, is an Anchor
//     Head account, is this subject, and, for the newest record, holds this fingerprint, period, source and commitment;
//   - for an older record, its transaction succeeded and holds a record_snapshot instruction of that program, on that
//     head, with this subject, sequence, fingerprint, period, source and commitment.
//
// One limit: the subject is a keyed hash Mynt computes, so you can't derive it from the product id yourself. The checks
// prove this report is the one recorded under that subject, not that Mynt filed it under the right product.
//
// Exit: 0 everything checked and passed (prints OVERALL PASS); 1 a check failed; 2 bad input; 3 no check failed but
// something wasn't independently checked (no OVERALL PASS).
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { file: { type: "string" }, rpc: { type: "string" }, "program-id": { type: "string" }, "partner-key": { type: "string" }, sequence: { type: "string" }, epoch: { type: "string" } } });
if (!values.file || !values.rpc || !values["program-id"]) {
  console.error("usage: product-health-verify.mjs --file <answer.json> --rpc <url> --program-id <address, NOT from the answer file> [--partner-key <base58>] [--sequence N] [--epoch E]");
  process.exit(2);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function fromBase58(text) {
  let n = 0n;
  for (const c of text) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("not base58");
    n = n * 58n + BigInt(v);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}
function toBase58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

// Sorted keys, no spaces, integers only: the same bytes Mynt hashed.
function canonical(v) {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  throw new Error("not canonical JSON");
}

const sha256 = (...parts) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
};
const edVerify = (key, message, signature) => {
  try {
    return verify(null, message, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" }), signature);
  } catch {
    return false;
  }
};

// A program-derived address: the first hash, counting the bump down from 255, that isn't a point on ed25519.
const P = 2n ** 255n - 19n;
const mod = (a) => ((a % P) + P) % P;
const power = (b, e) => {
  let r = 1n;
  b = mod(b);
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
};
const inverse = (a) => power(a, P - 2n);
const D = mod(-121665n * inverse(121666n));
function onCurve(bytes) {
  const b = Buffer.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  y = mod(y);
  const y2 = (y * y) % P;
  const x2 = mod(mod(y2 - 1n) * inverse(mod(D * y2 + 1n)));
  return x2 === 0n || power(x2, (P - 1n) / 2n) === 1n;
}
function programAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256(...seeds, Buffer.of(bump), programId, Buffer.from("ProgramDerivedAddress"));
    if (!onCurve(hash)) return hash;
  }
  throw new Error("no program address");
}

let failed = false;
let incomplete = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};
async function rpc(method, params) {
  const res = await fetch(values.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error).slice(0, 300)}`);
  return body.result;
}

const answer = JSON.parse(readFileSync(values.file, "utf8"));
const epoch = values.epoch !== undefined ? Number(values.epoch) : answer.chain?.epoch;
const snap = values.sequence ? answer.history.find((h) => h.sequence === Number(values.sequence) && h.epoch === epoch) : answer.latest;
if (!snap || !/^[0-9a-f]{64}$/.test(answer.chain?.subject ?? "")) {
  console.error("That file doesn't hold that snapshot, or the record's subject");
  process.exit(2);
}

const programId = fromBase58(values["program-id"]);
const subject = Buffer.from(answer.chain.subject, "hex");
const fingerprint = Buffer.from(snap.fingerprint ?? "", "hex");
const headAddress = programAddress([Buffer.from("head"), subject], programId);
const SOURCE_FLAG = { unavailable: 0, sandbox: 1, partner_ledger: 2 };

if (!snap.report) check("report present", false, "Mynt withheld it (a missed period, or a report that failed its own check)");
else check("report hashes to the fingerprint", sha256(Buffer.from(canonical(snap.report), "utf8")).equals(fingerprint));

let commitment = Buffer.alloc(32);
if (snap.partner_signature) {
  const key = fromBase58(snap.partner_key);
  const signature = Buffer.from(snap.partner_signature, "hex");
  commitment = sha256(Buffer.from("mynt.product_health.partner_commitment.v1\u0000", "utf8"), subject, key, signature);
  const message = Buffer.concat([Buffer.from("mynt.product_health.cosign.v1\u0000", "utf8"), fingerprint]);
  if (values["partner-key"]) {
    check("the signature is under the key you named", snap.partner_key === values["partner-key"], snap.partner_key);
    check("partner signature verifies", edVerify(fromBase58(values["partner-key"]), message, signature));
  } else {
    incomplete = true;
    check("partner signature verifies under the key in the file", edVerify(key, message, signature), snap.partner_key);
    console.log("WARN  the partner key was NOT independently checked: Mynt's file named it. Pass --partner-key with your firm's key");
  }
} else if (values["partner-key"]) check("partner signature present", false, "this snapshot has none");
else {
  incomplete = true;
  console.log("WARN  no partner signature: Mynt alone attests this snapshot");
}

const period = (iso) => BigInt(Math.floor(new Date(iso).getTime() / 1000));
const startSecs = period(snap.period_start);
const endSecs = period(snap.period_end);
const sourceFlag = snap.report ? SOURCE_FLAG[snap.report.source] : undefined;

const headBase58 = toBase58(headAddress);
if (answer.chain.head_address && answer.chain.head_address !== headBase58) check("the file's head address is the derived one", false, `${answer.chain.head_address}, derived ${headBase58}`);
const { value } = await rpc("getAccountInfo", [headBase58, { encoding: "base64", commitment: "confirmed" }]);
check("head account exists", !!value, headBase58);
if (value) {
  check("head account is owned by the program", value.owner === values["program-id"], value.owner);
  const data = Buffer.from(value.data[0], "base64");
  // Anchor's 8-byte discriminator, then: subject 32, sequence u64, fingerprint 32, start i64, end i64, kind, source,
  // partner_signed, partner_commitment 32, chain 32, mynt_signer 32, bump.
  check("it's a Head account", data.length >= 196 && data.subarray(0, 8).equals(sha256(Buffer.from("account:Head")).subarray(0, 8)));
  check("head is this product's", data.subarray(8, 40).equals(subject));
  const sequence = Number(data.readBigUInt64LE(40));
  if (sequence === snap.sequence && snap.epoch === answer.chain.epoch) {
    check("fingerprint matches the chain", data.subarray(48, 80).equals(fingerprint));
    check("period matches the chain", data.readBigInt64LE(80) === startSecs && data.readBigInt64LE(88) === endSecs);
    check("it's a snapshot record", data[96] === 0);
    check("source matches the chain", data[97] === sourceFlag);
    check("partner commitment matches the chain", data.subarray(99, 131).equals(commitment));
  } else if (snap.tx_signature) {
    checkTransaction(await rpc("getTransaction", [snap.tx_signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]));
  } else check("older snapshot found on chain", false, `the head is at sequence ${sequence} and this snapshot has no transaction to look up`);
}

// The record_snapshot instruction itself, not just the fingerprint's bytes somewhere in a transaction.
function checkTransaction(tx) {
  check("the snapshot's transaction succeeded", !!tx && tx.meta?.err === null, snap.tx_signature);
  if (!tx) return;
  const wire = Buffer.from(tx.transaction[0], "base64");
  const shortVec = (o) => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const x = wire[o++];
      n |= (x & 0x7f) << shift;
      if (!(x & 0x80)) return [n, o];
      shift += 7;
    }
  };
  let [nsig, o] = shortVec(0);
  o += 64 * nsig + 3; // the signatures, and the message's header
  let nkeys;
  [nkeys, o] = shortVec(o);
  const keys = [];
  for (let i = 0; i < nkeys; i++, o += 32) keys.push(wire.subarray(o, o + 32));
  o += 32; // the blockhash
  let nix;
  [nix, o] = shortVec(o);
  const discriminator = sha256(Buffer.from("global:record_snapshot")).subarray(0, 8);
  let found = null;
  for (let i = 0; i < nix; i++) {
    const program = keys[wire[o++]];
    let na;
    [na, o] = shortVec(o);
    const accounts = [...wire.subarray(o, o + na)].map((k) => keys[k]);
    o += na;
    let nd;
    [nd, o] = shortVec(o);
    const data = wire.subarray(o, o + nd);
    o += nd;
    if (program?.equals(programId) && data.length === 8 + 32 + 8 + 32 + 8 + 8 + 1 + 32 && data.subarray(0, 8).equals(discriminator)) found = { accounts, data };
  }
  check("the transaction has a record_snapshot of this program", !!found);
  if (!found) return;
  const d = found.data;
  check("it's on this head", !!found.accounts[1]?.equals(headAddress));
  check("it's this subject", d.subarray(8, 40).equals(subject));
  check("it's this sequence", Number(d.readBigUInt64LE(40)) === snap.sequence);
  check("it's this fingerprint", d.subarray(48, 80).equals(fingerprint));
  check("it's this period", d.readBigInt64LE(80) === startSecs && d.readBigInt64LE(88) === endSecs);
  check("it's this source", d[96] === sourceFlag);
  check("it's this partner commitment", d.subarray(97, 129).equals(commitment));
}

if (failed) process.exit(1);
if (incomplete) {
  console.log("INCOMPLETE  nothing failed, but not everything was independently checked; this isn't a pass");
  process.exit(3);
}
console.log("OVERALL PASS");
process.exit(0);
