import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { ATTESTATIONS_PER_SECOND, createMcpHttpServer } from "../dist/http.js";
import { callerAddress } from "../dist/rate-limit.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// The public attestation relay (GET /confidential/attestation): each answer asks the confidential host (and, behind
// it, a cloud attestation service) for a fresh token, so it's limited. The limit is per caller address, so one caller
// asking in a loop can't keep everyone else from checking, with a ceiling across all callers.

const NONCE = "abcdefghijklmnop";
const HEADER = "x-test-client-address";

async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  let asked = 0;
  const confidential = { attest: async (nonce) => ({ host: "fake", attested: false, nonce, asked: ++asked }) };
  const http = createMcpHttpServer(store, null, { confidential }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const get = async (address) => {
    const res = await fetch(`${base}/confidential/attestation?nonce=${NONCE}`, { headers: address ? { [HEADER]: address } : {} });
    return { status: res.status, retry: res.headers.get("retry-after"), body: await res.json() };
  };
  return {
    get,
    asked: () => asked,
    close: () => {
      http.closeAllConnections();
      http.close();
    },
  };
}

test("the caller's address: the proxy's header only when the operator names it, its last value; otherwise the connection's", () => {
  const req = (headers) => ({ headers, socket: { remoteAddress: "10.0.0.9" } });
  assert.equal(callerAddress(req({ "x-forwarded-for": "198.51.100.7" }), {}), "10.0.0.9", "a header nobody vouched for is never believed");
  assert.equal(callerAddress(req({ [HEADER]: "198.51.100.7" }), { TRUSTED_PROXY_HEADER: HEADER }), "198.51.100.7");
  assert.equal(callerAddress(req({ [HEADER]: "203.0.113.5, 198.51.100.7" }), { TRUSTED_PROXY_HEADER: "X-Test-Client-Address" }), "198.51.100.7", "what the proxy appended, not what the caller sent");
  assert.equal(callerAddress(req({}), { TRUSTED_PROXY_HEADER: HEADER }), "10.0.0.9");
  assert.equal(callerAddress(req({ [HEADER]: "x".repeat(200) }), { TRUSTED_PROXY_HEADER: HEADER }), "10.0.0.9", "an over-long value isn't an address");
});

test("attestations: one caller asking in a loop is limited without keeping another caller out; a ceiling holds across all callers", async () => {
  const before = process.env.TRUSTED_PROXY_HEADER;
  process.env.TRUSTED_PROXY_HEADER = HEADER;
  const w = await world();
  try {
    // One caller: the first is answered, the rest of the burst are told to wait.
    assert.equal((await w.get("198.51.100.1")).status, 200);
    for (let i = 0; i < 5; i++) {
      const again = await w.get("198.51.100.1");
      assert.equal(again.status, 429);
      assert.equal(again.body.error, "rate_limited");
      assert.ok(Number(again.retry) >= 1);
    }
    assert.equal(w.asked(), 1, "the refused ones never reached the confidential host");
    // Another caller is answered straight away (before, the first caller's request would have shut it out).
    const other = await w.get("198.51.100.2");
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.equal(other.body.nonce, NONCE);

    // Many callers at once: only so many reach the host within the second.
    const burst = await Promise.all(Array.from({ length: ATTESTATIONS_PER_SECOND * 4 }, (_, i) => w.get(`203.0.113.${i + 1}`)));
    const served = burst.filter((r) => r.status === 200).length;
    assert.ok(served >= 1 && served <= ATTESTATIONS_PER_SECOND, `${served} served`);
    assert.ok(burst.filter((r) => r.status === 429).every((r) => /Too many attestations/.test(r.body.message)));
    assert.ok(w.asked() <= 2 + ATTESTATIONS_PER_SECOND);
  } finally {
    w.close();
    if (before === undefined) delete process.env.TRUSTED_PROXY_HEADER;
    else process.env.TRUSTED_PROXY_HEADER = before;
  }
});

test("attestations without a trusted header: callers behind one connection address share its limit, as before", async () => {
  const before = process.env.TRUSTED_PROXY_HEADER;
  delete process.env.TRUSTED_PROXY_HEADER;
  const w = await world();
  try {
    // The limits are the process's: let the ceiling the last test used up refill.
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await w.get("198.51.100.1")).status, 200);
    assert.equal((await w.get("198.51.100.2")).status, 429, "the header isn't believed, so both are the same caller");
  } finally {
    w.close();
    if (before !== undefined) process.env.TRUSTED_PROXY_HEADER = before;
  }
});
