// The endpoint's signature and schema rules, against this service's own contract and handleService. Run with
// `npm test` (after `npm run build`). Mynt runs its own conformance test from outside; this one is yours.
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { handleService, ServiceError } from "./handle-service.js";
import { createVendorService, loadContract, verifySignature, type Handler } from "./vendor-service.js";

const contract = loadContract();
const key = contract.service_type.key;
const secret = randomBytes(32).toString("base64url"); // made here, for this run only
const sign = (raw: string, t = Math.floor(Date.now() / 1000), s = secret) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${raw}`).digest("hex")}`;
const request = (input: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ request_id: "req-1", environment: "test", input, ...(contract.fixtures[0]?.params ? { params: contract.fixtures[0].params } : {}), consent: { purpose: "p", artefact_ref: "a", given_at: new Date().toISOString() }, ...extra });
// `configured`: the secret the service holds ("" for none set). By default, the one this run signs with.
const post = (raw: string, signature: string | undefined, typeKey = key, handle: Handler = handleService, configured: string = secret) =>
  createVendorService({ contract, secret: () => configured || undefined, handle })(typeKey, signature, Buffer.from(raw));

test("the contract is the service type's, with a fixture to answer", () => {
  assert.equal(contract.endpoint.app_path, `/mynt/services/${key}`);
  assert.equal(contract.signature.header, "Mynt-Signature");
  assert.equal(contract.signature.tolerance_seconds, 300);
  assert.ok(contract.fixtures.length >= 1, "the contract has a fixture request");
});

test("a request Mynt signed is answered, with an output that fits the output schema", async () => {
  for (const fixture of contract.fixtures) {
    const raw = request(fixture.input);
    const a = await post(raw, sign(raw));
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual([a.body.request_id, a.body.status, a.body.error], ["req-1", "ok", null]);
    assert.equal(typeof a.body.output, "object");
  }
});

test("only Mynt-Signature authenticates: unsigned, badly signed, stale and secret-less requests are refused with 401", async () => {
  const raw = request(contract.fixtures[0].input);
  assert.equal((await post(raw, undefined)).status, 401, "no signature");
  assert.equal((await post(raw, "t=1,v1=zz")).status, 401, "not a signature");
  assert.equal((await post(raw, sign(raw, undefined, "another-secret"))).status, 401, "signed with another secret");
  assert.equal((await post(raw, sign(`${raw} `))).status, 401, "signed over a different body");
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(raw, sign(raw, now - 310))).status, 401, "more than 300 seconds old");
  assert.equal((await post(raw, sign(raw, now + 310))).status, 401, "more than 300 seconds ahead");
  assert.equal((await post(raw, sign(raw, now - 280))).status, 200, "inside the tolerance");
  assert.equal((await post(raw, sign(raw), key, undefined, "")).status, 401, "no secret set: everything is refused");
  // An unsigned caller learns nothing, not even which types exist.
  assert.equal((await post(raw, undefined, "some_other_type")).status, 401);
  // A bearer token or an app key is not a signature.
  assert.equal(verifySignature("Bearer mynt_test_anything", raw, secret), false);
});

test("the signature is checked in constant time over the raw bytes", () => {
  const raw = Buffer.from(request(contract.fixtures[0].input));
  const t = Math.floor(Date.now() / 1000);
  assert.equal(verifySignature(sign(raw.toString()), raw, secret), true);
  assert.equal(verifySignature(`t=${t},v1=${"0".repeat(64)}`, raw, secret), false);
  assert.equal(verifySignature(`t=${t},v1=${"0".repeat(62)}`, raw, secret), false, "a short digest is refused, not compared");
});

test("the input is checked against the input schema before the service runs", async () => {
  let ran = false;
  const handle: Handler = async () => ((ran = true), {});
  const raw = request({ __not_in_the_schema__: true });
  const a = await post(raw, sign(raw), key, handle);
  assert.equal(a.status, 400);
  assert.equal((a.body.error as { code: string }).code, "invalid_input");
  assert.equal(ran, false, "handleService never saw it");
  const notJson = "{";
  assert.equal((await post(notJson, sign(notJson))).status, 400);
  const other = request(contract.fixtures[0].input);
  assert.equal((await post(other, sign(other), "some_other_type")).status, 404, "signed, but not this service's type");
});

test("an output that doesn't fit the output schema is never sent; a refusal the service chose is said as its code", async () => {
  const raw = request(contract.fixtures[0].input);
  const wrong = await post(raw, sign(raw), key, async () => ({ __not_in_the_schema__: 1 }));
  assert.equal(wrong.status, 500);
  assert.deepEqual([wrong.body.output, (wrong.body.error as { code: string }).code], [null, "invalid_output"]);
  const refused = await post(raw, sign(raw), key, async () => {
    throw new ServiceError("not_found", "No such record");
  });
  assert.deepEqual([refused.status, refused.body.status, (refused.body.error as { code: string }).code], [200, "error", "not_found"]);
  const crashed = await post(raw, sign(raw), key, async () => {
    throw new Error("a detail that must not leave");
  });
  assert.equal(crashed.status, 500);
  assert.ok(!JSON.stringify(crashed.body).includes("must not leave"));
});
