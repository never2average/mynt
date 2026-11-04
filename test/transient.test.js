import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransient } from "../dist/transient.js";

test("isTransient: rate limits and server errors in both clients' shapes, not client errors or quota", () => {
  // The sandbox clients: "<who>: <status> ...".
  assert.equal(isTransient(new Error("boat: 503 Service Unavailable")), true);
  assert.equal(isTransient(new Error("boat: 429 Too Many Requests")), true);
  // The GitHub App: "... (<status>)".
  assert.equal(isTransient(new Error("GitHub couldn't resolve mynt/explore-1 (502)")), true);
  assert.equal(isTransient(new Error("GitHub refused a token for acme/desk (503)")), true);
  assert.equal(isTransient(new Error("GitHub refused the pull request (429)")), true);
  // Not worth retrying.
  assert.equal(isTransient(new Error("GitHub refused the pull request (422)")), false);
  assert.equal(isTransient(new Error("GitHub refused a token for acme/desk (404)")), false);
  assert.equal(isTransient(new Error("boat: 400 Bad Request")), false);
  assert.equal(isTransient(new Error("boat: 503 LIMIT_EXCEEDED")), false, "an exhausted allowance isn't transient");
  assert.equal(isTransient(new Error("Explorer budget used (5000 tokens)")), false);
});
