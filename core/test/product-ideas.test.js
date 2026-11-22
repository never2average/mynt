// The Build page's financial product ideas: rows in Postgres (financial_products.product_ideas) that admins keep,
// seeded from the shipped JSON only when an admin asks, each an idea for a new product in a line and category Mynt
// runs products in, stated without promises, projections, advice or seller framing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { addProductIdeas, listProductIdeas, PRODUCT_IDEA_SCOPES, PRODUCT_IDEAS_SEED_PATH, productIdeaErrors, seedProductIdeas, updateProductIdea } from "../dist/product-ideas.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const SEED = JSON.parse(readFileSync(PRODUCT_IDEAS_SEED_PATH, "utf8"));

async function openStore() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  return Store.open(db, CATALOG);
}
async function connect(store, user) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user, {}).connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return client;
}
const call = async (client, name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError ?? false, body: JSON.parse(r.content[0].text) };
};

test("the scopes are exactly the lines and categories of the US products in the catalogue", () => {
  const live = new Set(CATALOG.filter((p) => p.region === "US").map((p) => `${p.product_line}/${p.category}`));
  const scoped = new Set(Object.entries(PRODUCT_IDEA_SCOPES.US).flatMap(([line, cats]) => cats.map((c) => `${line}/${c}`)));
  assert.deepEqual([...scoped].sort(), [...live].sort());
  assert.deepEqual(Object.keys(PRODUCT_IDEA_SCOPES), ["US"], "Mynt is US only");
});

test("the shipped product ideas validate, are US, spread across every scoped category, and are labelled by who needs them", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(new URL("../schemas/product-idea-seed.schema.json", import.meta.url), "utf8")));
  assert.ok(validate(SEED), JSON.stringify(validate.errors));
  const ideas = seedProductIdeas();
  assert.ok(ideas.length >= 10 && ideas.length <= 14, `10 to 14 ideas, not ${ideas.length}`);
  for (const i of ideas) {
    assert.deepEqual(productIdeaErrors(i), [], i.id);
    assert.equal(i.region, "US");
    assert.ok(i.label.length <= 80);
    assert.doesNotMatch(i.label, /^(A|An|The) /, `${i.id}: names who needs it, not the product`);
    for (const f of ["risk_level", "liquidity", "typical_horizon", "return_type"]) assert.ok(i[f], `${i.id}: ${f} for the Create product sheet`);
  }
  for (const [line, cats] of Object.entries(PRODUCT_IDEA_SCOPES.US))
    for (const c of cats) assert.ok(ideas.some((i) => i.product_line === line && i.category === c), `an idea in ${line}/${c}`);
  for (const key of ["id", "label", "product_name"]) assert.equal(new Set(ideas.map((i) => i[key])).size, ideas.length, `unique ${key}s`);
});

test("a product idea is refused outside the US scopes, and for promises, projections, advice, seller framing or off-line words", () => {
  const good = seedProductIdeas().find((i) => i.id === "gig-worker-no-penalty-cd");
  const errs = (patch) => productIdeaErrors({ ...good, ...patch }).join("; ");
  assert.equal(errs({}), "");
  assert.match(errs({ region: "IN" }), /region 'IN' isn't one Mynt launches products in \(US\)/);
  assert.match(errs({ product_line: "insurance" }), /'insurance' isn't a product line with products in US/);
  assert.match(errs({ category: "retirement" }), /'retirement' isn't a account_operations category with products in US \(deposits\)/);
  assert.match(errs({ product_line: "wealth", category: "mutual_funds" }), /^$/);
  assert.match(errs({ id: "Bad Id" }), /the id is/);
  assert.match(errs({ label: "x".repeat(81) }), /the label is 10 to 80 characters/);
  assert.match(errs({ summary: "Two lines\nof summary for the product" }), /the summary is one line/);
  assert.match(errs({ key_features: ["Only one feature"] }), /2 to 6 key features, not 1/);
  assert.match(errs({ key_features: ["Same feature", "same feature"] }), /listed twice/);
  assert.match(errs({ risk_level: "none" }), /the risk level is one of/);
  // Facts are fine; promises, projections and advice are not.
  assert.equal(errs({ summary: "A 6-month CD with a fixed rate the firm sets, and no early withdrawal penalty after a week." }), "");
  assert.match(errs({ summary: "A 6-month CD that earns more than a savings account does." }), /the summary says 'earns'/);
  assert.match(errs({ key_features: ["Guaranteed growth every month", "Fixed term"] }), /key feature 1 says 'Guaranteed'/);
  assert.match(errs({ key_features: ["Pays 5% a year", "Fixed term"] }), /'5%'/);
  assert.match(errs({ summary: "A CD with the highest yield in the market for savers." }), /'yield'/);
  assert.match(errs({ label: "Savers want a CD that beats inflation every year" }), /'beats inflation'/);
  assert.match(errs({ summary: "A CD we recommend for gig workers with uneven pay." }), /'recommend'/);
  assert.match(errs({ summary: "A CD whose returns are projected to rise over the term." }), /'returns'/);
  // Seller framing, what no scoped line covers, and web addresses.
  assert.match(errs({ label: "Merchants want somewhere to park their takings" }), /'Merchants', which frames the people it serves as sellers of goods/);
  assert.match(errs({ key_features: ["Lets sellers park their sales cash", "Fixed term"] }), /'sellers'/);
  assert.match(errs({ summary: "A CD that can be used as security for a loan from the firm." }), /'loan'/);
  assert.match(errs({ key_features: ["Includes deposit insurance top-ups", "Fixed term"] }), /'insurance'/);
  assert.match(errs({ summary: "A CD whose terms are listed at rates.example.com for everyone." }), /web address/);
});

test("product ideas are in Postgres: not seeded on startup, added by seed_product_ideas without overwriting edits, kept by admins only", async () => {
  const store = await openStore();
  assert.deepEqual(await listProductIdeas(store.db, { includeRetired: true }), []);
  const adminUser = (await store.createUser("Ada", ["admin"])).user;
  const admin = await connect(store, adminUser);
  const dev = await connect(store, (await store.createUser("Dev", ["developer"])).user);
  const inno = await connect(store, (await store.createUser("Ivy", ["innovator"])).user);
  const devTools = (await dev.listTools()).tools.map((t) => t.name);
  assert.ok(devTools.includes("list_product_ideas"), "builders read them");
  assert.ok((await inno.listTools()).tools.some((t) => t.name === "list_product_ideas"), "innovators read them");
  for (const t of ["create_product_idea", "update_product_idea", "retire_product_idea", "seed_product_ideas"]) assert.ok(!devTools.includes(t), `${t} is admin only`);
  const guestTools = (await (await connect(store, null)).listTools()).tools.map((t) => t.name);
  assert.ok(!guestTools.includes("list_product_ideas"));
  const consumerTools = (await (await connect(store, (await store.createUser("Cy", ["consumer"])).user)).listTools()).tools.map((t) => t.name);
  assert.ok(!consumerTools.includes("list_product_ideas"));

  assert.deepEqual((await call(dev, "list_product_ideas")).body, { ideas: [], note: "No product ideas yet: an admin adds them with seed_product_ideas or create_product_idea" });

  const first = await call(admin, "seed_product_ideas");
  assert.equal(first.body.inserted.length, SEED.ideas.length);
  assert.deepEqual((await call(admin, "seed_product_ideas")).body, { inserted: [], kept: SEED.ideas.map((i) => i.id) });

  const all = (await call(dev, "list_product_ideas")).body.ideas;
  assert.equal(all.length, SEED.ideas.length);
  assert.deepEqual(Object.keys(all[0]).sort(), ["category", "id", "key_features", "label", "liquidity", "product_line", "product_name", "region", "return_type", "risk_level", "summary", "typical_horizon"]);
  const deposits = (await call(dev, "list_product_ideas", { product_line: "account_operations" })).body.ideas;
  assert.ok(deposits.length >= 3 && deposits.every((i) => i.category === "deposits"));
  assert.equal(deposits[0].id, "gig-worker-no-penalty-cd", "sort orders a line's ideas");

  // Edit one, retire another; seeding again leaves both.
  const edited = await call(admin, "update_product_idea", { id: "rate-reset-cd", product_name: "Two-Year CD with One Rate Reset" });
  assert.equal(edited.error, false, JSON.stringify(edited.body));
  assert.equal(edited.body.idea.product_name, "Two-Year CD with One Rate Reset");
  assert.equal(edited.body.idea.summary, SEED.ideas.find((i) => i.id === "rate-reset-cd").summary, "fields left out stay");
  assert.equal((await call(admin, "retire_product_idea", { id: "milestone-tips-gift" })).body.idea.status, "retired");
  assert.deepEqual((await call(admin, "seed_product_ideas")).body.inserted, []);
  assert.ok(!(await call(dev, "list_product_ideas")).body.ideas.some((i) => i.id === "milestone-tips-gift"), "retired ideas aren't offered");
  assert.ok(!(await call(dev, "list_product_ideas", { include_retired: true })).body.ideas.some((i) => i.id === "milestone-tips-gift"), "only admins see retired ones");
  assert.equal((await call(admin, "list_product_ideas", { include_retired: true })).body.ideas.find((i) => i.id === "milestone-tips-gift").status, "retired");
  assert.equal((await call(admin, "update_product_idea", { id: "milestone-tips-gift", status: "active" })).body.idea.status, "active");

  // Create: checked, unique.
  const fresh = {
    id: "joint-household-mma",
    label: "Couples want one savings account they both see and both fund",
    product_name: "Joint Household Money Market Account",
    summary: "A joint money market account where each holder sees every move and can add money from their own bank account.",
    product_line: "account_operations",
    category: "deposits",
    region: "US",
    key_features: ["Two holders with equal access", "Every deposit and withdrawal shown to both holders"],
    risk_level: "low",
    sort: 5,
  };
  const created = await call(admin, "create_product_idea", fresh);
  assert.equal(created.error, false, JSON.stringify(created.body));
  assert.equal(created.body.idea.created_by, adminUser.id);
  assert.equal(created.body.idea.liquidity, null, "an unset classification stays empty");
  assert.match((await call(admin, "create_product_idea", fresh)).body.error, /already a product idea 'joint-household-mma'/);
  const promise = await call(admin, "create_product_idea", { ...fresh, id: "joint-promise", summary: "A joint account guaranteed to grow your household's savings." });
  assert.equal(promise.error, true);
  assert.match(promise.body.error, /the summary says 'guaranteed'/);
  // The zod schema refuses a region outside the list before the checks do.
  assert.equal((await admin.callTool({ name: "create_product_idea", arguments: { ...fresh, id: "joint-in", region: "IN" } })).isError, true);
  assert.match((await call(admin, "update_product_idea", { id: "joint-household-mma", category: "bonds" })).body.error, /'bonds' isn't a account_operations category/);
  assert.match((await call(admin, "update_product_idea", { id: "nope", label: "Nobody needs this product at all" })).body.error, /No product idea 'nope'/);
  assert.match((await call(admin, "retire_product_idea", { id: "nope" })).body.error, /No product idea 'nope'/);
  // Builders can't change them.
  assert.equal((await dev.callTool({ name: "create_product_idea", arguments: fresh })).isError, true);

  const actions = (await store.auditLog(50)).map((a) => a.action);
  for (const a of ["seed_product_ideas", "update_product_idea", "retire_product_idea", "create_product_idea"]) assert.ok(actions.includes(a), a);
});

test("the store functions: seeding is idempotent and leaves edited rows alone", async () => {
  const store = await openStore();
  const ideas = seedProductIdeas();
  assert.equal((await addProductIdeas(store.db, null, ideas)).inserted.length, ideas.length);
  await updateProductIdea(store.db, "tips-ladder-bundle", { summary: "One purchase of TIPS with one rung maturing each year over a span the holder picks." });
  const { inserted, kept } = await addProductIdeas(store.db, null, ideas);
  assert.deepEqual(inserted, []);
  assert.equal(kept.length, ideas.length);
  assert.equal((await listProductIdeas(store.db, { productLine: "credit" })).find((i) => i.id === "tips-ladder-bundle").summary, "One purchase of TIPS with one rung maturing each year over a span the holder picks.");
});
