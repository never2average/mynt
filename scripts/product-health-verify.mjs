#!/usr/bin/env node
// Checks a product-health snapshot without trusting Mynt. It uses nothing from this repository, only Node's standard
// library and a Solana RPC of your choosing, so a licence provider or liquidity provider can read it and run it alone.
//
//   1. Save the answer of get_product_health (entitled readers only) to a file.
//   2. node product-health-verify.mjs --file answer.json --rpc https://api.devnet.solana.com [--sequence N]
//
// It checks, for the latest snapshot or the one you name:
//   - the report hashes to the fingerprint;
//   - the partner's Ed25519 signature verifies (compare partner_key with the key your firm registered);
//   - the head account on chain is owned by the program, is this subject, and, for the newest record, holds this
//     fingerprint and this partner commitment; for an older one, its transaction carries the fingerprint.
//
// Prints one line per check; exits 0 if all pass, 1 if any fails, 2 on bad input.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { file: { type: "string" }, rpc: { type: "string" }, sequence: { type: "string" } } });
if (!values.file || !values.rpc) {
  console.error("usage: product-health-verify.mjs --file <get_product_health answer.json> --rpc <solana rpc url> [--sequence N]");
  process.exit(2);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(text) {
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
const edVerify = (key, message, signature) => verify(null, message, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }, format: "jwk" }), signature);

let failed = false;
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
const snap = values.sequence ? answer.history.find((h) => h.sequence === Number(values.sequence)) : answer.latest;
if (!snap || !answer.chain?.subject || !answer.chain?.head_address || !answer.chain?.program_id) {
  console.error("That file doesn't hold the snapshot, or the chain's subject and head address");
  process.exit(2);
}

if (!snap.report) check("report present", false, "Mynt withheld it (a missed period, or a report that failed its own check)");
else check("report hashes to the fingerprint", sha256(Buffer.from(canonical(snap.report), "utf8")).toString("hex") === snap.fingerprint);

const subject = Buffer.from(answer.chain.subject, "hex");
let commitment = Buffer.alloc(32);
if (snap.partner_signature) {
  const key = base58(snap.partner_key);
  const signature = Buffer.from(snap.partner_signature, "hex");
  check("partner signature verifies", edVerify(key, Buffer.concat([Buffer.from("mynt.product_health.cosign.v1\u0000", "utf8"), Buffer.from(snap.fingerprint, "hex")]), signature), `key ${snap.partner_key}`);
  commitment = sha256(Buffer.from("mynt.product_health.partner_commitment.v1\u0000", "utf8"), subject, key, signature);
} else console.log("NOTE  no partner signature: Mynt alone attests this snapshot");

const { value } = await rpc("getAccountInfo", [answer.chain.head_address, { encoding: "base64", commitment: "confirmed" }]);
check("head account exists", !!value);
if (value) {
  check("head account is owned by the program", value.owner === answer.chain.program_id);
  const data = Buffer.from(value.data[0], "base64");
  // Anchor's 8-byte discriminator, then: subject 32, sequence u64, fingerprint 32, start i64, end i64, kind, source,
  // partner_signed, partner_commitment 32, chain 32, mynt_signer 32, bump.
  check("head is this product's", data.subarray(8, 40).equals(subject));
  const sequence = Number(data.readBigUInt64LE(40));
  if (sequence === snap.sequence) {
    check("fingerprint matches the chain", data.subarray(48, 80).toString("hex") === snap.fingerprint);
    check("partner commitment matches the chain", data.subarray(99, 131).equals(commitment));
  } else if (snap.tx_signature) {
    const tx = await rpc("getTransaction", [snap.tx_signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    check("the snapshot's transaction carries the fingerprint", !!tx && tx.meta?.err === null && Buffer.from(tx.transaction[0], "base64").includes(Buffer.from(snap.fingerprint, "hex")), snap.tx_signature);
  } else check("older snapshot found on chain", false, `the head is at sequence ${sequence} and this snapshot has no transaction to look up`);
}
process.exit(failed ? 1 : 0);
