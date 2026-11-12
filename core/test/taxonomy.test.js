import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { currentLine, PRODUCT_LINES } from "../dist/catalog.js";
import { PRODUCT_ACTIONS } from "../dist/regulatory.js";
import { fingerprint } from "../dist/product-tests.js";
import { applyTakeRate } from "../dist/take-rates.js";
import { CATALOG, licensed } from "./helpers.js";

// The functional product taxonomy: lines, actions, underlyings and wrappers, the startup migration
// from the four original lines, and take rates scaled by compliance workload.

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: async () => {} };
  const store = await Store.open(db, CATALOG);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
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
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  return { pg, db, store, connect, call, adminUser, admin: await connect(adminUser) };
}

const fd = {
  id: "green-fd",
  name: "Green Fixed Deposit",
  product_line: "account_operations",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "low",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "Fixed deposit whose proceeds fund certified renewable-energy projects.",
  key_features: ["Fixed rate", "Funds green projects"],
};

test("currentLine maps the four original lines onto the functional ones", () => {
  const line = (product_line, category = "x", id = "p") => currentLine({ id, category, product_line });
  assert.equal(line("credit"), "credit");
  assert.equal(line("insurance"), "insurance");
  assert.equal(line("wealth", "mutual_funds"), "wealth");
  assert.equal(line("wealth", "exchange_traded", "reit"), "securitization");
  assert.equal(line("wealth", "exchange_traded", "invit"), "securitization");
  assert.equal(line("wealth", "exchange_traded", "etf"), "wealth");
  assert.equal(line("retirement"), "wealth");
  assert.equal(line("treasury", "deposits"), "account_operations");
  assert.equal(line("treasury", "bonds"), "credit");
  assert.equal(line("treasury", "money_market"), "credit");
  assert.equal(line("treasury", "derivatives"), "derivatives");
  assert.equal(line("treasury", "mutual_funds"), "wealth");
  assert.equal(line("treasury", "cash_management"), "account_operations");
  // Lines already new are kept.
  for (const l of PRODUCT_LINES) assert.equal(line(l, "deposits"), l);
  assert.equal(PRODUCT_LINES.length, 11);
});

test("old-line products, versions and categories move to the functional lines when Mynt starts, and stay published", async () => {
  const { pg, db, store, connect, call, adminUser } = await setup();
  // A published product with a passing test, as it stood under the old taxonomy.
  const { user } = await store.createUser("Ines", ["innovator"]);
  await licensed(store, user);
  const inno = await connect(user);
  await call(inno, "create_product", fd);
  assert.equal((await call(inno, "test_product", { id: "green-fd" })).data.passed, true);
  assert.equal((await call(inno, "publish_product", { id: "green-fd" })).isError, false);
  const old = { ...fd, product_line: "treasury" };
  const { rows } = await pg.query("SELECT last_test FROM financial_products.products WHERE id = 'green-fd'");
  const oldTest = JSON.stringify({ ...rows[0].last_test, fingerprint: fingerprint(old), ran_at: "2026-01-01T00:00:00.000Z" });
  await pg.query("UPDATE financial_products.products SET data = $1, last_test = $2 WHERE id = 'green-fd'", [JSON.stringify(old), oldTest]);
  await pg.query("UPDATE financial_products.product_versions SET data = $1, last_test = $2 WHERE product_id = 'green-fd'", [JSON.stringify(old), oldTest]);
  // Seeded products and categories put back on the old lines.
  const was = { "fixed-deposit": "treasury", "treasury-bills": "treasury", "liquid-fund": "treasury", "fx-forward": "treasury", reit: "wealth", etf: "wealth", nps: "retirement" };
  for (const [id, line] of Object.entries(was))
    await pg.query("UPDATE financial_products.products SET data = jsonb_set(data, '{product_line}', to_jsonb($2::text)) WHERE id = $1", [id, line]);
  const cats = { deposits: ["treasury"], money_market: ["treasury"], mutual_funds: ["treasury", "wealth"], derivatives: ["treasury"], exchange_traded: ["wealth"], retirement: ["retirement", "wealth"] };
  for (const [id, lines] of Object.entries(cats)) await pg.query("UPDATE financial_products.product_categories SET product_lines = $2 WHERE id = $1", [id, lines]);
  await pg.query(`UPDATE financial_products.regions SET procedures = '[{"product_line":"treasury","name":"Deposits","regulator":"RBI","steps":["Bank licence"]}]' WHERE code = 'IN'`);
  const request = await store.createProductRequest(adminUser.id, { need: "Somewhere to park cash", product_line: "treasury", amount: null, currency: "INR", tenor_days: null, region: "IN", context: null });

  await Store.open(db, CATALOG);
  const line = async (id) => (await store.getProduct(id)).product.product_line;
  assert.equal(await line("fixed-deposit"), "account_operations");
  assert.equal(await line("treasury-bills"), "credit");
  assert.equal(await line("liquid-fund"), "wealth");
  assert.equal(await line("fx-forward"), "derivatives");
  assert.equal(await line("reit"), "securitization");
  assert.equal(await line("etf"), "wealth");
  assert.equal(await line("nps"), "wealth");
  const categories = Object.fromEntries((await store.referenceData(true)).categories.map((c) => [c.id, c.product_lines]));
  assert.deepEqual(categories.deposits, ["account_operations"]);
  assert.deepEqual(categories.money_market, ["credit"]);
  assert.deepEqual(categories.mutual_funds, ["wealth"]);
  assert.deepEqual(categories.derivatives, ["derivatives"]);
  assert.deepEqual(categories.exchange_traded, ["wealth", "securitization"]);
  assert.deepEqual(categories.retirement, ["wealth"]);
  assert.equal((await store.referenceData()).regions.find((r) => r.code === "IN").procedures[0].product_line, "account_operations");
  assert.equal((await store.getProductRequest(request.id)).product_line, "account_operations");

  // The published product kept its status, and its re-run test report matches its new data.
  const record = await store.getProduct("green-fd");
  assert.equal(record.status, "published");
  assert.equal(record.product.product_line, "account_operations");
  assert.equal(record.last_test.fingerprint, fingerprint(record.product));
  assert.equal(record.last_test.passed, true);
  const [version] = await store.productVersions("green-fd");
  assert.equal(version.status, "published");
  assert.equal(version.data.product_line, "account_operations");
  assert.equal(version.last_test.fingerprint, fingerprint(version.data));
  // Its owner can draft the next version as usual.
  assert.equal((await call(inno, "create_product_version", { id: "green-fd", changelog: "Rate change", name: "Green FD Plus" })).isError, false);

  // Running again changes nothing.
  const before = (await pg.query("SELECT id, data, last_test FROM financial_products.products ORDER BY id")).rows;
  const categoriesBefore = (await pg.query("SELECT id, product_lines FROM financial_products.product_categories ORDER BY id")).rows;
  await Store.open(db, CATALOG);
  assert.deepEqual((await pg.query("SELECT id, data, last_test FROM financial_products.products ORDER BY id")).rows, before);
  assert.deepEqual((await pg.query("SELECT id, product_lines FROM financial_products.product_categories ORDER BY id")).rows, categoriesBefore);
});

test("the database accepts all nine actions, replacing the five-action check on stores created before them", async () => {
  const { pg, db, store } = await setup();
  const type = (id, actions) => ({ id, name: id, description: "", type_id: "deposits", actions });
  // A store created before the new actions carries the old check.
  await pg.exec(`
    ALTER TABLE financial_products.regulated_product_types DROP CONSTRAINT regulated_product_types_actions_check;
    ALTER TABLE financial_products.regulated_product_types ADD CONSTRAINT regulated_product_types_actions_check
      CHECK (cardinality(actions) > 0 AND actions <@ ARRAY['issuance', 'sale', 'purchase', 'secondary_sale', 'repackaging']::text[]);`);
  await assert.rejects(store.upsertRegulatedProductType("IN", type("in_rating", ["assessment"])));
  await Store.open(db, CATALOG);
  assert.equal(PRODUCT_ACTIONS.length, 9);
  await store.upsertRegulatedProductType("IN", type("in_everything", [...PRODUCT_ACTIONS]));
  assert.deepEqual((await store.regulatedProductTypes("IN")).find((t) => t.id === "in_everything").actions, [...PRODUCT_ACTIONS]);
  await assert.rejects(store.upsertRegulatedProductType("IN", type("in_bogus", ["lending"])));
  const { rows } = await pg.query(
    "SELECT conname FROM pg_constraint WHERE conrelid = 'financial_products.regulated_product_types'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%actions%'",
  );
  assert.deepEqual(rows.map((r) => r.conname), ["regulated_product_types_actions_check"]);
});

test("regulated product types carry an optional underlying and wrapper", async () => {
  const { store, call, admin } = await setup();
  const sgb = { id: "in_sgb", name: "Sovereign gold bond", description: "", type_id: "bonds", actions: ["issuance", "sale", "servicing"], underlying: "commodities", wrapper: "government_scheme" };
  const saved = await call(admin, "define_regulated_product_type", { region: "IN", product_type: sgb });
  assert.equal(saved.isError, false, JSON.stringify(saved.data));
  const listed = (await call(admin, "list_regulated_product_types", { region: "IN" })).data.find((t) => t.id === "in_sgb");
  assert.equal(listed.underlying, "commodities");
  assert.equal(listed.wrapper, "government_scheme");
  // Both are optional, and replacing a type without them clears them.
  await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...sgb, underlying: undefined, wrapper: undefined } });
  const cleared = (await store.regulatedProductTypes("IN")).find((t) => t.id === "in_sgb");
  assert.equal(cleared.underlying, undefined);
  assert.equal(cleared.wrapper, undefined);
  // Only the listed values are accepted.
  assert.equal((await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...sgb, underlying: "gold" } })).isError, true);
  assert.equal((await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...sgb, wrapper: "isa" } })).isError, true);
  // And the regime shows them on the component's primitive.
  await call(admin, "define_regulated_product_type", { region: "IN", product_type: sgb });
  await call(admin, "admin_set_product_composition", {
    product_id: "sovereign-gold-bond",
    components: [{ key: "bond", country: "in", primitive: "credit", action: "issuance", underlying: "commodities", wrapper: "government_scheme" }],
  });
  const regime = (await call(admin, "get_product_regime", { product_id: "sovereign-gold-bond" })).data;
  assert.deepEqual(regime.regions[0].components[0].perimeter.map((t) => t.id), ["in_sgb"]);
  // Without the wrapper, the same credit issuance falls outside the scheme's perimeter.
  await call(admin, "admin_set_product_composition", { product_id: "sovereign-gold-bond", components: [{ key: "bond", country: "in", primitive: "credit", action: "issuance" }] });
  const plain = (await call(admin, "get_product_regime", { product_id: "sovereign-gold-bond" })).data;
  assert.equal(plain.regions[0].components[0].perimeter.some((t) => t.id === "in_sgb"), false);
});

test("take rates scale with a product's compliance and servicing workload, within the admin's floor and cap", async () => {
  const { store, connect, call, admin, adminUser } = await setup();
  // A term deposit the bank issues and a mandate it services, under a licence carrying five GRC items.
  for (const t of [
    { id: "in_term_deposit", name: "Term deposit", type_id: "deposits", actions: ["issuance", "servicing"], underlying: "cash" },
    { id: "in_mandate", name: "Recurring payment mandate", type_id: "deposits", actions: ["issuance", "servicing"] },
  ])
    assert.equal((await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } })).isError, false);
  const registers = {
    obligations: [
      { id: "kyc", title: "KYC" },
      { id: "dicgc", title: "Deposit insurance premium" },
    ],
    reporting_disclosure_filings: [{ id: "form_a", name: "Form A" }],
    risks: [],
    controls: [
      { id: "recon", name: "Daily reconciliation" },
      { id: "maker_checker", name: "Maker-checker" },
    ],
    inspection_events: [],
  };
  const regulator = {
    id: "rbi",
    name: "Reserve Bank of India",
    scope: { product_types: [{ id: "in_term_deposit" }, { id: "in_mandate" }], customer_personas: [] },
    license_types: [
      {
        _id: "rbi_bank",
        name: "Bank",
        grc: { registers, allowed_product_types: ["in_term_deposit", "in_mandate"] },
      },
    ],
  };
  const defined = await call(admin, "define_regulator", { region: "IN", regulator });
  assert.equal(defined.isError, false, JSON.stringify(defined.data));

  const firm = await store.createEntity(adminUser.id, { name: "Green Bank", registration_numbers: {}, regions: ["IN"] });
  const member = async (name) => {
    const { user } = await store.createUser(name, ["innovator"]);
    await store.setUserEntity(user.id, firm.id);
    user.entity_id = firm.id;
    return connect(user);
  };
  const owner = await member("Ines");
  const colleague = await member("Cole");
  const { user: rivalUser } = await store.createUser("Ravi", ["innovator"]);
  const rival = await connect(rivalUser);
  const { user: consumerUser } = await store.createUser("Asha", ["consumer"]);
  const consumer = await connect(consumerUser);

  await call(owner, "create_product", fd);
  // Not configured yet, and not composed yet: both are said plainly.
  const bare = (await call(owner, "get_product_take_rate", { product_id: "green-fd" })).data;
  assert.equal(bare.configured, false);
  assert.match(bare.message, /No take rate is configured for account_operations/);
  assert.equal(bare.workload.score, 0);
  assert.match(bare.workload.note, /no composition/);

  const composed = await call(owner, "set_product_composition", {
    product_id: "green-fd",
    components: [
      { key: "deposit", country: "in", primitive: "account_operations", action: "issuance", underlying: "cash", provider: { by: "self" } },
      { key: "mandate", country: "in", primitive: "account_operations", action: "servicing", provider: { by: "self" } },
    ],
  });
  assert.equal(composed.isError, false, JSON.stringify(composed.data));

  // Only admins set rates.
  const rate = { line: "account_operations", base_pct: 1, workload_pct: 0.25, min_pct: 0.5, max_pct: 5, basis: "revenue" };
  assert.equal((await owner.listTools()).tools.some((t) => t.name === "define_take_rate"), false);
  assert.equal((await call(admin, "define_take_rate", { ...rate, min_pct: 6 })).isError, true);
  assert.equal((await call(admin, "define_take_rate", rate)).data.basis, "revenue");
  assert.equal((await store.auditLog(5)).find((a) => a.action === "define_take_rate").target, "account_operations");
  const listed = (await call(admin, "list_take_rates")).data;
  assert.deepEqual(listed.rates.map((r) => r.line), ["account_operations"]);
  assert.equal(listed.unconfigured.length, PRODUCT_LINES.length - 1);

  // Each component: 1 point + (2 obligations + 1 filing + 2 controls) / 10, and servicing adds 1.
  const got = (await call(owner, "get_product_take_rate", { product_id: "green-fd" })).data;
  assert.equal(got.configured, true);
  assert.deepEqual(
    got.workload.components.map((c) => [c.primitive, c.action, c.base_points, c.grc_points, c.servicing_points, c.points]),
    [
      ["account_operations", "issuance", 1, 0.5, 0, 1.5],
      ["account_operations", "servicing", 1, 0.5, 1, 2.5],
    ],
  );
  assert.deepEqual(got.workload.components[0].licences, [{ regulator_id: "rbi", license_id: "rbi_bank", obligations: 2, filings: 1, controls: 2 }]);
  assert.equal(got.workload.score, 4);
  assert.equal(got.rate_pct, 2); // 1 + 0.25 × 4
  assert.equal(got.clamped, null);
  assert.equal(got.basis, "revenue");
  // Defining the rate stored it on the product: exactly what get_product_take_rate says, obligation points included.
  const { product_id: _, ...exact } = got;
  const stored = await store.productDerived("green-fd");
  assert.deepEqual(stored.take_rate, exact);
  assert.equal(stored.take_rate.workload.components[0].grc_points, 0.5);

  // The cap and the floor hold.
  await call(admin, "define_take_rate", { ...rate, max_pct: 1.5 });
  const capped = (await call(owner, "get_product_take_rate", { product_id: "green-fd" })).data;
  assert.equal(capped.rate_pct, 1.5);
  assert.equal(capped.unclamped_pct, 2);
  assert.equal(capped.clamped, "max");
  await call(admin, "define_take_rate", { ...rate, base_pct: 0, workload_pct: 0, min_pct: 0.75 });
  const floored = (await call(admin, "get_product_take_rate", { product_id: "green-fd" })).data;
  assert.equal(floored.rate_pct, 0.75);
  assert.equal(floored.clamped, "min");
  assert.deepEqual(applyTakeRate({ base_pct: 1, workload_pct: 0.5, min_pct: 0, max_pct: 10 }, 3), { rate_pct: 2.5, unclamped_pct: 2.5, clamped: null });

  // The firm and admins can see it; other innovators and consumers can't.
  assert.equal((await call(colleague, "get_product_take_rate", { product_id: "green-fd" })).isError, false);
  assert.equal((await call(admin, "get_product_take_rate", { product_id: "green-fd" })).isError, false);
  assert.equal((await call(rival, "get_product_take_rate", { product_id: "green-fd" })).isError, true);
  assert.equal((await consumer.listTools()).tools.some((t) => t.name === "get_product_take_rate"), false);
});
