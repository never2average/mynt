import { test } from "node:test";
import assert from "node:assert/strict";
import { developerReadiness } from "../dist/runtime.js";
import { CATALOG } from "./helpers.js";
import { publishDefined, setup } from "./v2-helpers.js";

// Every product offered to developers (list_products with developer_ready: true) must be complete:
// a developer contract, a real regulator, and rate data that agrees with itself. Everything else is hidden.
test("every product listed as developer-ready is complete, and the rest are hidden", async () => {
  const ctx = await setup();
  await publishDefined(ctx);
  const ready = (await ctx.call(ctx.client, "list_products", { developer_ready: true, limit: 100 })).data.products;
  assert.deepEqual(ready.map((p) => p.id), ["everyday-rd"]);
  for (const p of ready) {
    const r = developerReadiness(await ctx.store.getProduct(p.id));
    assert.deepEqual(r.reasons, [], p.id);
  }
  const hidden = (await ctx.call(ctx.client, "list_products", { developer_ready: false, limit: 100 })).data;
  assert.ok(hidden.products.some((p) => p.id === "savings-account"));
  assert.ok(!hidden.products.some((p) => p.id === "everyday-rd"));
  // Without the filter, the catalogue is unchanged.
  const all = (await ctx.call(ctx.client, "list_products", { limit: 100 })).data.total;
  assert.equal(all, ready.length + hidden.total);
});

test("readiness names what's missing", () => {
  const rec = (product, pins = { contract: {} }) => ({ status: "published", pins, product });
  const base = { id: "x", key_features: [], regulator: "RBI", return_type: "variable_interest" };
  assert.deepEqual(developerReadiness(rec(base)).reasons, []);
  assert.match(developerReadiness(rec(base, null)).reasons.join(), /no developer contract/);
  for (const regulator of ["Banking regulator", "Banking regulator (e.g. RBI, FDIC-insured in US)", "", "TBD"])
    assert.match(developerReadiness(rec({ ...base, regulator })).reasons.join(), /placeholder regulator/, regulator);
  assert.match(developerReadiness(rec({ ...base, return_type: "fixed_interest", key_features: ["Variable interest rate"] })).reasons.join(), /fixed_interest/);
  assert.match(developerReadiness(rec({ ...base, key_features: ["Rate locked for the tenure"] })).reasons.join(), /variable_interest/);
});

// The catalogue data itself: no product contradicts itself or names a placeholder regulator.
test("catalogue data is consistent; savings-account is a variable-rate RBI product", () => {
  const problems = CATALOG.flatMap((p) =>
    developerReadiness({ status: "published", pins: { contract: {} }, product: p }).reasons.map((r) => `${p.id}: ${r}`),
  );
  const savings = CATALOG.find((p) => p.id === "savings-account");
  assert.equal(savings.return_type, "variable_interest");
  assert.equal(savings.regulator, "RBI");
  assert.equal(savings.region, "IN");
  // Products whose regulator the repo can't settle stay hidden from developers rather than guessed.
  assert.deepEqual(problems, ["fixed-deposit: placeholder regulator 'Banking regulator'", "sweep-account: placeholder regulator 'Banking regulator'"]);
});
