import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { checkSeedDefinitions } from "../scripts/seed-definitions.mjs";
import { ADDITIONS, productionLikeModel, toolsOf } from "./seed-regulatory-model.js";

// Mynt's reference catalogue gets v2 definitions: the seed records (published, no firm) were published
// without one, so they had no developer contract. This test builds, through admin tools only, a slice of India's
// model shaped like production's (test/seed-regulatory-model.js), shows the definitions are refused on it, applies
// schemas/regulatory/in.additions.json in merge mode (only additions), then checks, saves, tests and publishes each
// schemas/examples/seed/*.v2.json the way scripts/apply-seed-definitions.mjs does, and reads the developer
// contract each one now has.

const SEED_DIR = new URL("../schemas/examples/seed/", import.meta.url);
const SEEDS = readdirSync(SEED_DIR)
  .filter((f) => f.endsWith(".v2.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, SEED_DIR), "utf8")));

async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "seed", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
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
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const admin = await connect(adminUser);
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const developer = await connect(devUser);
  return { store, connect, call, ok, admin, developer };
}

test("the reference catalogue's seed definitions check, publish, and give each product a developer contract", async () => {
  const w = await world();
  const { ok, call, admin, developer, store } = w;
  assert.deepEqual(SEEDS.map((d) => d._id), ["fixed-deposit", "personal-loan", "recurring-deposit", "savings-account"]);

  // Before: seed records with no definition, hidden from developers.
  const before = (await ok(developer, "list_products", { developer_ready: true, limit: 100 })).products.map((p) => p.id);
  for (const d of SEEDS) assert.ok(!before.includes(d._id), `${d._id} isn't developer-ready yet`);
  for (const d of SEEDS) assert.equal((await store.getProduct(d._id)).owner_id, null, `${d._id} is a Mynt reference product`);

  await productionLikeModel(w);
  const tools = toolsOf(admin);
  const defs = SEEDS.map((def) => ({ file: `${def._id}.v2.json`, def }));

  // On production's model as it is, every definition is refused: it cites personas and obligations it lacks.
  const refused = await checkSeedDefinitions({ call: tools.call, defs });
  assert.equal(refused.ready, false);
  assert.ok(refused.results.every((r) => !r.ready));
  const rbiBefore = (await call(admin, "get_regulator", { region: "IN", regulator_id: "rbi" })).data;

  // The additions file only adds: three personas and thirteen obligations on rbi_universal_bank.
  const dry = await applyRegulatoryModel({ ...tools, model: ADDITIONS, dryRun: true });
  assert.deepEqual(dry.problems, []);
  assert.deepEqual(dry.removals, []);
  assert.deepEqual(dry.plan.map((p) => [p.tool, p.id, p.change]), [["define_regulator", "rbi", "update"]]);
  assert.equal(dry.plan[0].added.length, 16, dry.plan[0].added.join("\n"));
  assert.deepEqual(dry.plan[0].updated, []);
  assert.ok(
    dry.plan[0].added.every((a) => /^scope › persona rbi_(resident_individual|senior_citizen|retail_borrower)$|^licence rbi_universal_bank › grc › registers › obligation rbi_/.test(a)),
    dry.plan[0].added.join("\n"),
  );
  assert.deepEqual((await call(admin, "get_regulator", { region: "IN", regulator_id: "rbi" })).data, rbiBefore, "a dry run writes nothing");
  const applied = await applyRegulatoryModel({ ...tools, model: ADDITIONS });
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));

  // Everything production had is still there, unchanged; the additions sit beside it.
  const rbi = (await call(admin, "get_regulator", { region: "IN", regulator_id: "rbi" })).data;
  const bank = rbi.license_types.find((l) => l._id === "rbi_universal_bank");
  const bankBefore = rbiBefore.license_types.find((l) => l._id === "rbi_universal_bank");
  assert.deepEqual(bank.grc.registers.obligations.slice(0, 3), bankBefore.grc.registers.obligations);
  assert.equal(bank.grc.registers.obligations.length, 3 + 13);
  for (const k of ["reporting_disclosure_filings", "risks"]) assert.deepEqual(bank.grc.registers[k], bankBefore.grc.registers[k], k);
  for (const k of ["repositories", "allowed_product_types", "allowed_customer_segments", "mandatory_stakeholders"]) assert.deepEqual(bank.grc[k], bankBefore.grc[k], k);
  assert.deepEqual(rbi.scope.product_types, rbiBefore.scope.product_types);
  assert.deepEqual(rbi.scope.customer_personas.slice(0, 2), rbiBefore.scope.customer_personas);
  assert.equal(rbi.scope.customer_personas.length, 5);
  const again = await applyRegulatoryModel({ ...tools, model: ADDITIONS, dryRun: true });
  assert.deepEqual(again.plan.map((p) => p.change), ["keep"], "applied twice, nothing more to do");

  // Every definition is now ready, and the catalogue cites RBI, the regulator whose licence the definition's
  // register items cite, not IFSCA or BSE, though their ids sort first and they have more licence types granting it.
  const readyNow = await checkSeedDefinitions({ call: tools.call, defs });
  assert.equal(readyNow.ready, true, JSON.stringify(readyNow.results.filter((r) => !r.ready).map((r) => r.data)));
  assert.deepEqual(readyNow.results.map((r) => r.regulator), ["RBI", "RBI", "RBI", "RBI"]);

  for (const def of SEEDS) {
    // What scripts/apply-seed-definitions.mjs does: check, refuse on errors or blockers, save, publish.
    const checked = await ok(admin, "check_product_definition", { product_id: def._id, definition: def });
    assert.equal(checked.valid, true, `${def._id}: ${JSON.stringify(checked.errors)}`);
    assert.deepEqual(checked.warnings, [], def._id);
    assert.deepEqual(checked.publish_blockers, [], def._id);
    assert.equal(checked.catalogue_record.regulator, "RBI", def._id);
    assert.equal(checked.catalogue_record.region, "IN", def._id);

    const saved = await ok(admin, "set_product_definition", { product_id: def._id, definition: def, changelog: "v2 definition for the reference catalogue" });
    assert.equal(saved.applied_to, "draft_version", `${def._id}: the live seed record stays live until the new version publishes`);
    const tested = await ok(admin, "test_product", { id: def._id });
    assert.equal(tested.passed, true, `${def._id}: ${JSON.stringify(tested.checks.filter((c) => c.status === "fail"))}`);
    await ok(admin, "publish_product", { id: def._id });
  }

  // After: every one is developer-ready, with a contract an app can build on.
  const ready = (await ok(developer, "list_products", { developer_ready: true, limit: 100 })).products.map((p) => p.id);
  for (const d of SEEDS) assert.ok(ready.includes(d._id), `${d._id} is developer-ready: ${ready.join(", ")}`);

  const contracts = {};
  for (const def of SEEDS) {
    const c = await ok(developer, "get_developer_contract", { product_id: def._id });
    contracts[def._id] = c;
    assert.match(c.contract_hash, /^sha256:/);
    assert.equal(c.version, 2, `${def._id}: the seed record was version 1`);
    assert.deepEqual(c.offers.map((o) => o.segment_id), def.customer_segments.map((s) => s._id));
    for (const o of c.offers) {
      assert.ok(o.terms.length >= 3, `${def._id}/${o.segment_id} offers its terms`);
      assert.ok(o.rates.length >= 1, `${def._id}/${o.segment_id} offers a rate`);
    }
    assert.ok(c.actions.some((a) => a.id === "view_offers"), def._id);
    assert.ok(c.actions.filter((a) => a.surface === "server").length >= 2, `${def._id}: customer actions an app can ask for`);
    assert.ok(Object.keys(c.documents).length >= 1, def._id);
    // The public side only: no algorithms, risk models or controls.
    const text = JSON.stringify(c);
    for (const a of def.core_algorithms) assert.ok(!text.includes(a.repository), `${def._id}: ${a._id} stays private`);
    for (const l of def.limits ?? []) if (l.kind === "control") assert.ok(!text.includes(`"${l._id}"`), `${def._id}: control ${l._id} stays private`);
  }

  const actions = (id) => contracts[id].actions.map((a) => a.id);
  assert.ok(["account_opened", "transfer_out", "account_closed"].every((a) => actions("savings-account").includes(a)), actions("savings-account").join());
  assert.ok(["deposit_booked", "premature_closure"].every((a) => actions("fixed-deposit").includes(a)), actions("fixed-deposit").join());
  assert.ok(["account_opened", "premature_closure"].every((a) => actions("recurring-deposit").includes(a)), actions("recurring-deposit").join());
  assert.ok(["application_submitted", "loan_accepted", "foreclosed"].every((a) => actions("personal-loan").includes(a)), actions("personal-loan").join());

  // Senior citizens get the 50 bps term-deposit bonus; the loan's rate is set by the decision engine.
  const fdSenior = contracts["fixed-deposit"].offers.find((o) => o.segment_id === "senior_citizen");
  assert.equal(fdSenior.terms.find((t) => t._id === "senior_spread_bps").default, 50);
  const plRate = contracts["personal-loan"].offers[0].terms.find((t) => t._id === "interest_rate");
  assert.equal(plRate.negotiable, "decision_engine");

  // The catalogue now cites RBI and India for every one of them (fixed-deposit was 'Banking regulator', global).
  for (const def of SEEDS) {
    const p = await ok(developer, "get_product", { id: def._id });
    assert.equal(p.regulator, "RBI", def._id);
    assert.equal(p.region, "IN", def._id);
    assert.deepEqual(p.key_features, def.descriptions.key_features, def._id);
  }

  // Only admins test and publish the reference catalogue: an innovator can't touch it.
  const { user: innovatorUser } = await store.createUser("Ines", ["innovator"]);
  const innovator = await w.connect(innovatorUser);
  for (const tool of ["test_product", "publish_product"])
    assert.match((await call(innovator, tool, { id: "savings-account" })).data.error, /No product of yours/, tool);
});

test("the catalogue cites the licensing regulator, in a documented order, never the first id alphabetically", async () => {
  const w = await world();
  const { ok, admin } = w;
  await productionLikeModel(w);
  assert.equal((await applyRegulatoryModel({ ...toolsOf(admin), model: ADDITIONS })).applied, true);
  const savings = SEEDS.find((d) => d._id === "savings-account");
  const cites = async (def) => (await ok(admin, "check_product_definition", { product_id: def._id, definition: def })).catalogue_record.regulator;

  // Its register items cite rbi_universal_bank, which grants its lead component: RBI.
  assert.equal(await cites(savings), "RBI");

  // Without register items, the licensing regulator with the most licence types granting it: IFSCA's two here
  // against RBI's one. Deterministic, and documented in leadRegulator.
  const bare = structuredClone(savings);
  bare.connections = bare.connections.filter((c) => c.to?.kind !== "register_item");
  assert.equal(await cites(bare), "IFSCA");

  // A tie goes to the regulator listed first in the region (define_region): RBI before IFSCA.
  await ok(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "ifsca",
      name: "International Financial Services Centres Authority",
      short_name: "IFSCA",
      scope: { product_types: [{ id: "in_savings_deposit" }] },
      license_types: [{ _id: "ifsca_ifsc_banking_unit", name: "IFSC banking unit", grc: { allowed_product_types: ["in_savings_deposit"] } }],
    },
  });
  assert.equal(await cites(bare), "RBI");
});
