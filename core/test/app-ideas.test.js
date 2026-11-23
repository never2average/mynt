// New app's ideas: rows in Postgres (financial_products.app_ideas) that admins keep, seeded from the shipped JSON only
// when an admin asks, each labelled by the problem it solves and checked against its kind and what Mynt can build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { APP_IDEAS_SEED_PATH, APP_IDEAS_V2_SEED_PATH, appIdeaErrors, createAppIdea, fillAppIdeaChipLabels, ideaLines, listAppIdeas, PROMISE_WORDS, seedAppIdeas, seedIdeas, updateAppIdea } from "../dist/app-ideas.js";
import { appKinds } from "../dist/app-kinds.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default;
const SEED = JSON.parse(readFileSync(APP_IDEAS_SEED_PATH, "utf8"));

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

test("the shipped ideas validate, cover every kind, and each is labelled by a plain problem statement", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(new URL("../schemas/app-idea-seed.schema.json", import.meta.url), "utf8")));
  assert.ok(validate(SEED), JSON.stringify(validate.errors));
  const ideas = seedIdeas();
  assert.equal(ideas.length, 16);
  for (const i of ideas) {
    assert.deepEqual(appIdeaErrors(i), [], i.id);
    assert.ok(i.problem.length <= 70, `${i.id}: a short problem statement`);
    assert.doesNotMatch(i.problem, /^(A|An|The) /, `${i.id}: names who has the problem, not the app`);
  }
  for (const k of appKinds()) assert.ok(ideas.filter((i) => i.kind === k.id).length >= 3, `${k.id}: at least three ideas`);
  assert.equal(new Set(ideas.map((i) => i.id)).size, ideas.length);
});

// The products published for US developers today, by line and category: every shipped idea builds on some of them.
const LIVE = [
  { name: "Certificate of Deposit (CD)", line: "account_operations", category: "deposits" },
  { name: "Money Market Account", line: "account_operations", category: "deposits" },
  { name: "401(k) Plan", line: "wealth", category: "retirement" },
  { name: "Individual Retirement Account (IRA)", line: "wealth", category: "retirement" },
  { name: "Money Market Fund", line: "wealth", category: "mutual_funds" },
  { name: "Treasury Inflation-Protected Securities (TIPS)", line: "credit", category: "bonds" },
];

test("the kinds and ideas build on the lines that have live products, and every idea names some of them", () => {
  assert.deepEqual(ideaLines(), ["account_operations", "credit", "wealth"]);
  for (const i of seedIdeas()) {
    const matching = LIVE.filter(
      (p) =>
        i.product_lines.includes(p.line) &&
        (!i.categories.length || i.categories.includes(p.category)) &&
        (!i.product_names.length || i.product_names.some((n) => p.name.toLowerCase().includes(n.toLowerCase()))),
    );
    assert.ok(matching.length, `${i.id}: names a live product`);
    for (const n of i.product_names) assert.ok(matching.some((p) => p.name.toLowerCase().includes(n.toLowerCase())), `${i.id}: '${n}' is a live product's name`);
  }
});

test("facts about the products are fine; promises, projections and advice are not", () => {
  for (const ok of [
    "Shows the account's interest rate as the product states it",
    "Reminds the customer before each CD matures",
    "A retirement account with a yearly contribution limit",
    "Moves cash to a money market fund",
    "Explains how the product adjusts principal for inflation",
    "The app shows information, not advice.",
  ])
    assert.doesNotMatch(ok, PROMISE_WORDS, ok);
  for (const bad of [
    "Guaranteed growth for your savings",
    "Earn 5% on idle cash",
    "Get 4.5 % a year",
    "Returns of up to five times",
    "A fund that beats inflation",
    "Savings that outpace inflation",
    "Protects your savings from inflation",
    "Inflation-proof savings",
    "Risk-free savings",
    "High yield savings",
    "Expert advice on your retirement",
    "Advisors pick a fund for you",
    "We recommend the best fund for you",
    "Your projected balance at retirement",
  ])
    assert.match(bad, PROMISE_WORDS, bad);
});

test("an idea is refused for a missing kind, someone else's lines or categories, lines no kind builds on, and promises, projections or advice", () => {
  const good = seedIdeas().find((i) => i.id === "emergency-fund");
  const errs = (patch, base = good, kinds) => appIdeaErrors({ ...base, ...patch }, kinds).join("; ");
  assert.equal(errs({}), "");
  assert.match(errs({ kind: "nope" }), /no app kind 'nope'/);
  assert.match(errs({ product_lines: ["wealth"] }), /'wealth' isn't one of the savings-goals kind's product lines/);
  // A line is allowed only when some kind declares it.
  assert.match(errs({ product_lines: ["insurance"] }), /'insurance' isn't a product line any app kind builds on \(account_operations, credit, wealth\)/);
  assert.match(errs({ product_lines: ["payments"] }), /'payments' isn't a product line any app kind builds on/);
  assert.match(errs({ product_lines: [] }), /at least one product line/);
  assert.match(errs({ product_lines: ["account_operations", "account_operations"] }), /listed twice/);
  assert.match(errs({ categories: ["retirement"] }), /'retirement' isn't one of the savings-goals kind's categories \(deposits\)/);
  assert.match(errs({ categories: ["Deposits"] }), /isn't a category id/);
  assert.match(errs({ categories: ["deposits", "deposits"] }), /a category is listed twice/);
  assert.match(errs({ product_names: ["x"] }), /a product name is 2 to 60 characters/);
  assert.match(errs({ product_names: ["Guaranteed Savings"] }), /the product name says 'Guaranteed'/);
  assert.match(errs({ id: "Emergency Fund" }), /the id is/);
  assert.match(errs({ pitch: "x".repeat(121) }), /the pitch is 10 to 120 characters/);
  assert.match(errs({ problem: "x".repeat(81) }), /the problem is 10 to 80 characters/);
  assert.match(errs({ problem: "Two lines\nof problem" }), /the problem is one line/);
  assert.match(errs({ goal: "Too short." }), /the goal is 40 to 1200 characters/);
  // The chip label: required, at most 34 characters, one line, and checked like the rest.
  assert.match(errs({ chip_label: "" }), /the chip label is 1 to 34 characters, not 0/);
  assert.match(errs({ chip_label: undefined }), /the chip label is 1 to 34 characters, not 0/);
  assert.match(errs({ chip_label: "x".repeat(35) }), /the chip label is 1 to 34 characters, not 35/);
  assert.equal(errs({ chip_label: "x".repeat(34) }), "");
  assert.match(errs({ chip_label: "Two\nlines" }), /the chip label is one line/);
  assert.match(errs({ chip_label: "Guaranteed rainy-day pot" }), /the chip label says 'Guaranteed'/);
  assert.match(errs({ chip_label: "Rainy-day loan" }), /the chip label says 'loan'/);
  assert.match(errs({ chip_label: "Pot for sellers" }), /the chip label says 'sellers'/);
  assert.match(errs({ chip_label: "pot.example.com" }), /the chip label has a web address/);
  // Factual words about the products are fine.
  assert.equal(errs({ pitch: "Shows the interest rate and the date each CD matures, from the terms." }), "");
  assert.equal(errs({ problem: "Savers don't know their retirement fund's yearly limit" }), "");
  // Promises, projections and advice are not.
  assert.match(errs({ problem: "Families want to earn interest on a rainy-day pot" }), /the problem says 'earn'/);
  assert.match(errs({ pitch: "Earn 5% on every dollar you set aside." }), /the pitch says 'Earn'/);
  assert.match(errs({ pitch: "Guaranteed to keep your rainy-day pot growing." }), /the pitch says 'Guaranteed'/);
  assert.match(errs({ pitch: "Savings that beat inflation every single year." }), /the pitch says 'beat inflation'/);
  assert.match(errs({ pitch: "A risk-free place for your rainy-day cash." }), /'risk-free'/);
  assert.match(errs({ pitch: "Returns of up to twice a savings account." }), /'Returns'/);
  assert.match(errs({ goal: `${good.goal} It gives advice on where to keep cash.` }), /the goal says 'advice'/);
  assert.equal(errs({ goal: `${good.goal} The app shows information, not advice.` }), "");
  // What no kind builds on, and what a finance app mustn't call the people it serves.
  assert.match(errs({ pitch: "Lets sellers collect from their buyers." }), /'sellers'/);
  assert.match(errs({ pitch: "Tops up the pot from your debit card today." }), /'card'/);
  assert.match(errs({ goal: `${good.goal} Families can borrow from the fund.` }), /the goal says 'borrow'/);
  assert.match(errs({ goal: `${good.goal} Families can invest the fund in stocks.` }), /the goal says 'invest'/);
  assert.match(errs({ goal: `${good.goal} Settle at fund.example.com.` }), /web address/);
  assert.match(errs({ goal: `${good.goal} It calls mintTokens first.` }), /names mintTokens, which isn't one of the savings-goals kind's SDK calls/);
  // A stablecoin-settled kind (none ships today) still needs its goal to say it shows dollars only.
  const stableKind = { ...appKinds().find((k) => k.id === "savings-goals"), id: "usdc-balance", product_lines: ["exchange"], categories: undefined };
  const stable = { ...good, id: "usdc-pot", kind: "usdc-balance", product_lines: ["exchange"], categories: [] };
  assert.match(errs({}, stable, [stableKind]), /dollars only, never crypto/);
  assert.equal(errs({ goal: `${good.goal} Every screen shows dollars only, never crypto.` }, stable, [stableKind]), "");
});

test("ideas are in Postgres: not seeded on startup, added by seed_app_ideas without overwriting edits, kept by admins only", async () => {
  const store = await openStore();
  // Opening the store creates the table and writes nothing to it.
  assert.deepEqual(await listAppIdeas(store.db, { includeRetired: true }), []);
  const adminUser = (await store.createUser("Ada", ["admin"])).user;
  const admin = await connect(store, adminUser);
  const dev = await connect(store, (await store.createUser("Dev", ["developer"])).user);
  const devTools = (await dev.listTools()).tools.map((t) => t.name);
  assert.ok(devTools.includes("list_app_ideas"));
  for (const t of ["create_app_idea", "update_app_idea", "retire_app_idea", "seed_app_ideas"]) assert.ok(!devTools.includes(t), `${t} is admin only`);
  const guestTools = (await (await connect(store, null)).listTools()).tools.map((t) => t.name);
  assert.ok(!guestTools.includes("list_app_ideas"));

  // Nothing yet: the developer is told so.
  assert.deepEqual((await call(dev, "list_app_ideas")).body, { ideas: [], note: "No ideas yet: an admin adds them with seed_app_ideas or create_app_idea" });

  // Seeding adds all sixteen, once.
  const first = await call(admin, "seed_app_ideas");
  assert.equal(first.body.inserted.length, 16);
  assert.deepEqual(first.body.kept, []);
  const again = await call(admin, "seed_app_ideas");
  assert.deepEqual(again.body, { inserted: [], kept: SEED.ideas.map((i) => i.id) });

  // Developers see active ideas, optionally by kind, in each kind's order, with the fields they need only.
  const all = (await call(dev, "list_app_ideas")).body.ideas;
  assert.equal(all.length, 16);
  assert.deepEqual(Object.keys(all[0]).sort(), ["categories", "chip_label", "goal", "id", "kind", "pitch", "problem", "product_lines", "product_names"]);
  assert.equal(all.find((i) => i.id === "emergency-fund").chip_label, "Family emergency fund");
  const goals = (await call(dev, "list_app_ideas", { kind: "savings-goals" })).body.ideas;
  assert.deepEqual(goals.map((i) => i.id), ["emergency-fund", "rent-cushion", "gift-season", "shared-home-goal"]);
  assert.equal(goals[0].problem, "Families have nothing set aside when the car or the boiler breaks");
  assert.deepEqual(goals[0].categories, ["deposits"]);
  assert.deepEqual(goals[0].product_names, ["Money Market Account"]);

  // An admin edits one and retires another; seeding again leaves both as they are.
  const edited = await call(admin, "update_app_idea", { id: "emergency-fund", problem: "Families can't cover a surprise repair bill from savings" });
  assert.equal(edited.error, false, JSON.stringify(edited.body));
  assert.equal(edited.body.idea.problem, "Families can't cover a surprise repair bill from savings");
  assert.equal(edited.body.idea.pitch, SEED.ideas.find((i) => i.id === "emergency-fund").pitch, "fields left out stay");
  assert.deepEqual(edited.body.idea.categories, ["deposits"], "categories left out stay");
  assert.equal((await call(admin, "retire_app_idea", { id: "tips-calendar" })).body.idea.status, "retired");
  assert.deepEqual((await call(admin, "seed_app_ideas")).body.inserted, []);
  assert.equal((await call(dev, "list_app_ideas", { kind: "savings-goals" })).body.ideas[0].problem, "Families can't cover a surprise repair bill from savings");
  assert.ok(!(await call(dev, "list_app_ideas")).body.ideas.some((i) => i.id === "tips-calendar"), "retired ideas aren't offered");
  assert.ok(!(await call(dev, "list_app_ideas", { include_retired: true })).body.ideas.some((i) => i.id === "tips-calendar"), "only admins see retired ones");
  // Admins may see retired ones, and bring one back.
  const withRetired = (await call(admin, "list_app_ideas", { include_retired: true })).body.ideas;
  assert.equal(withRetired.find((i) => i.id === "tips-calendar").status, "retired");
  assert.equal((await call(admin, "update_app_idea", { id: "tips-calendar", status: "active" })).body.idea.status, "active");

  // Create: checked, unique.
  const fresh = {
    id: "school-trip-pot",
    kind: "savings-goals",
    chip_label: "School trip pot",
    problem: "Parents face one big bill for the school trip in spring",
    pitch: "A goal for the trip's cost, filled a little each week from the parent's bank account.",
    goal: "A school trip pot app on a money market account. A parent sets a goal for the trip's cost and its date and adds a weekly amount from their bank account through the provider's hosted flow, seeing the goal's progress and the account's terms as the product's offer states them.",
    product_lines: ["account_operations"],
    categories: ["deposits"],
    product_names: ["Money Market Account"],
    sort: 5,
  };
  const created = await call(admin, "create_app_idea", fresh);
  assert.equal(created.error, false, JSON.stringify(created.body));
  assert.equal(created.body.idea.created_by, adminUser.id);
  assert.deepEqual(created.body.idea.product_names, ["Money Market Account"]);
  assert.equal((await call(dev, "list_app_ideas", { kind: "savings-goals" })).body.ideas[0].id, "school-trip-pot", "sort orders a kind's ideas");
  assert.match((await call(admin, "create_app_idea", fresh)).body.error, /already an idea 'school-trip-pot'/);
  const bad = await call(admin, "create_app_idea", { ...fresh, id: "trip-advance", pitch: "Advances the parent a loan until payday arrives." });
  assert.equal(bad.error, true);
  assert.match(bad.body.error, /the pitch says 'loan'/);
  const promise = await call(admin, "create_app_idea", { ...fresh, id: "trip-promise", pitch: "Guaranteed to cover the whole trip by spring." });
  assert.match(promise.body.error, /the pitch says 'Guaranteed', which promises/);
  // Moving an idea to a kind whose lines it doesn't share is refused; the row stays as it was.
  assert.match((await call(admin, "update_app_idea", { id: "school-trip-pot", kind: "treasury-securities" })).body.error, /'account_operations' isn't one of the treasury-securities kind's product lines/);
  assert.equal((await call(admin, "update_app_idea", { id: "nope", problem: "Nobody has this problem at all" })).body.error, "No idea 'nope'; list_app_ideas lists them");
  assert.match((await call(admin, "retire_app_idea", { id: "nope" })).body.error, /No idea 'nope'/);

  // Every change is in the audit log.
  const actions = (await store.auditLog(50)).map((a) => a.action);
  for (const a of ["seed_app_ideas", "update_app_idea", "retire_app_idea", "create_app_idea"]) assert.ok(actions.includes(a), a);
});

test("the store functions: seeding is idempotent and leaves edited rows alone", async () => {
  const store = await openStore();
  const ideas = seedIdeas();
  assert.equal((await seedAppIdeas(store.db, null, ideas)).inserted.length, 16);
  await updateAppIdea(store.db, "cd-ladder-planner", { pitch: "Lays out each CD's maturity date on one timeline." });
  const { inserted, kept } = await seedAppIdeas(store.db, null, ideas);
  assert.deepEqual(inserted, []);
  assert.equal(kept.length, 16);
  assert.equal((await listAppIdeas(store.db, { kind: "certificates-of-deposit" })).find((i) => i.id === "cd-ladder-planner").pitch, "Lays out each CD's maturity date on one timeline.");
  await assert.rejects(createAppIdea(store.db, { ...ideas[0] }, null), /already an idea/);
});

// v2: sharper ideas on the same live products, with new ids, loaded by seed_app_ideas { seed: "v2" }.
const V2 = JSON.parse(readFileSync(APP_IDEAS_V2_SEED_PATH, "utf8"));

test("the v2 ideas validate, have new ids, cover every kind, and each names a live product", () => {
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(new URL("../schemas/app-idea-seed.schema.json", import.meta.url), "utf8")));
  assert.ok(validate(V2), JSON.stringify(validate.errors));
  const ideas = seedIdeas(APP_IDEAS_V2_SEED_PATH);
  assert.equal(ideas.length, 16);
  const v1 = new Set(SEED.ideas.map((i) => i.id));
  for (const i of ideas) {
    assert.deepEqual(appIdeaErrors(i), [], i.id);
    assert.ok(!v1.has(i.id), `${i.id}: a new id, so v1's rows aren't touched`);
    assert.ok(i.problem.length <= 80, `${i.id}: a short problem statement`);
    assert.doesNotMatch(i.problem, /^(A|An|The) /, `${i.id}: names who has the problem, not the app`);
    assert.match(i.goal, /The app shows information, not advice\.$/, `${i.id}: ends saying it shows information`);
    const matching = LIVE.filter(
      (p) => i.product_lines.includes(p.line) && i.categories.includes(p.category) && i.product_names.some((n) => p.name.toLowerCase().includes(n.toLowerCase())),
    );
    assert.ok(matching.length, `${i.id}: names a live product`);
  }
  for (const k of appKinds()) assert.ok(ideas.filter((i) => i.kind === k.id).length >= 3, `${k.id}: at least three v2 ideas`);
  assert.equal(new Set(ideas.map((i) => i.id)).size, ideas.length);
  assert.equal(new Set(ideas.map((i) => i.problem)).size, ideas.length, "no two share a label");
});

test("seed_app_ideas adds v2 alongside v1, and with replace retires what isn't in the set, never deleting", async () => {
  const store = await openStore();
  const admin = await connect(store, (await store.createUser("Ada", ["admin"])).user);
  const dev = await connect(store, (await store.createUser("Dev", ["developer"])).user);
  assert.equal((await call(admin, "seed_app_ideas")).body.inserted.length, 16, "v1 is still the default");
  // An admin's own idea, which replace retires too (it isn't in the set).
  const own = { ...SEED.ideas.find((i) => i.id === "emergency-fund"), id: "admins-own-idea" };
  assert.equal((await call(admin, "create_app_idea", own)).error, false);

  // v2 without replace: added beside v1, nothing retired, no retired key.
  const added = await call(admin, "seed_app_ideas", { seed: "v2" });
  assert.equal(added.error, false, JSON.stringify(added.body));
  assert.deepEqual(added.body, { inserted: V2.ideas.map((i) => i.id), kept: [] });
  assert.equal((await call(dev, "list_app_ideas")).body.ideas.length, 33);

  // v2 with replace: v2 is kept as it is, everything else active is retired, and every row is still there.
  const replaced = await call(admin, "seed_app_ideas", { seed: "v2", replace: true });
  assert.equal(replaced.error, false, JSON.stringify(replaced.body));
  assert.deepEqual(replaced.body.inserted, []);
  assert.equal(replaced.body.kept.length, 16);
  assert.deepEqual(replaced.body.retired, [...SEED.ideas.map((i) => i.id), "admins-own-idea"].sort());
  const active = (await call(dev, "list_app_ideas")).body.ideas.map((i) => i.id).sort();
  assert.deepEqual(active, V2.ideas.map((i) => i.id).sort());
  const everything = await listAppIdeas(store.db, { includeRetired: true });
  assert.equal(everything.length, 33, "replace never deletes");
  assert.equal(everything.filter((i) => i.status === "retired").length, 17);

  // Again: nothing more to retire. A retired one brought back stays until replace runs again.
  assert.deepEqual((await call(admin, "seed_app_ideas", { seed: "v2", replace: true })).body.retired, []);
  assert.equal((await call(admin, "update_app_idea", { id: "tips-calendar", status: "active" })).body.idea.status, "active");
  assert.ok((await call(dev, "list_app_ideas")).body.ideas.some((i) => i.id === "tips-calendar"));
  // Replace is audited with what it retired.
  // (newest first: the first replace is the older of the two)
  const replaces = (await store.auditLog(50)).filter((a) => a.action === "seed_app_ideas" && a.details?.replace);
  assert.equal(replaces.length, 2, "each replace is in the audit log");
  assert.deepEqual(replaces[0].details.retired, []);
  const entry = replaces[1];
  assert.equal(entry.details.seed, "v2");
  assert.equal(entry.details.retired.length, 17);
  // Only admins seed.
  assert.ok(!(await dev.listTools()).tools.some((t) => t.name === "seed_app_ideas"));
});

test("every shipped app idea, v1 and v2, has a plain chip label under 35 characters, unique in its set", () => {
  for (const path of [APP_IDEAS_SEED_PATH, APP_IDEAS_V2_SEED_PATH]) {
    const ideas = seedIdeas(path);
    for (const i of ideas) {
      assert.ok(i.chip_label.length > 0 && i.chip_label.length < 35, `${i.id}: '${i.chip_label}' is ${i.chip_label.length} characters`);
      assert.doesNotMatch(i.chip_label, /[\r\n]/);
      assert.notEqual(i.chip_label, i.problem, `${i.id}: the chip label is short, not the problem`);
    }
    assert.equal(new Set(ideas.map((i) => i.chip_label)).size, ideas.length, "no two chips share a label");
  }
});

test("labels only: seed_app_ideas fills in missing chip labels on rows already there, never overwrites one, adds nothing", async () => {
  const store = await openStore();
  const adminUser = (await store.createUser("Ada", ["admin"])).user;
  const admin = await connect(store, adminUser);
  const dev = await connect(store, (await store.createUser("Dev", ["developer"])).user);
  assert.equal((await call(admin, "seed_app_ideas", { seed: "v2" })).body.inserted.length, 16);
  // Rows added before chip labels have none; an admin set one of them by hand.
  await store.db.query(`UPDATE financial_products.app_ideas SET chip_label = NULL WHERE id IN ('wedding-cd-ladder', 'found-money-sweep', 'payroll-buffer')`);
  await store.db.query(`UPDATE financial_products.app_ideas SET chip_label = 'Payroll cash on hand' WHERE id = 'payroll-buffer'`);
  await store.db.query(`UPDATE financial_products.app_ideas SET chip_label = NULL WHERE id = 'tips-yearly-ladder'`);
  await call(admin, "retire_app_idea", { id: "tips-yearly-ladder" });
  // The developer sees null until it's filled; updating such a row needs a chip label.
  assert.equal((await call(dev, "list_app_ideas")).body.ideas.find((i) => i.id === "wedding-cd-ladder").chip_label, null);
  assert.match((await call(admin, "update_app_idea", { id: "wedding-cd-ladder", sort: 3 })).body.error, /the chip label is 1 to 34 characters, not 0/);
  const before = await listAppIdeas(store.db, { includeRetired: true });

  // replace and labels_only don't mix.
  assert.match((await call(admin, "seed_app_ideas", { seed: "v2", labels_only: true, replace: true })).body.error, /labels_only fills in chip labels only/);
  const filled = await call(admin, "seed_app_ideas", { seed: "v2", labels_only: true });
  assert.equal(filled.error, false, JSON.stringify(filled.body));
  assert.deepEqual(filled.body.filled.sort(), ["found-money-sweep", "tips-yearly-ladder", "wedding-cd-ladder"]);
  assert.equal(filled.body.kept.length, 13);
  assert.deepEqual(filled.body.missing, []);
  const after = await listAppIdeas(store.db, { includeRetired: true });
  const byId = Object.fromEntries(after.map((i) => [i.id, i]));
  assert.equal(byId["wedding-cd-ladder"].chip_label, "Wedding CD ladder");
  assert.equal(byId["found-money-sweep"].chip_label, "Found-money sweep");
  assert.equal(byId["payroll-buffer"].chip_label, "Payroll cash on hand", "an admin's label is never overwritten");
  assert.equal(byId["tips-yearly-ladder"].status, "retired", "a retired idea gets its label and stays retired");
  for (const b of before) {
    const a = byId[b.id];
    for (const k of ["kind", "problem", "pitch", "goal", "status", "sort"]) assert.deepEqual(a[k], b[k], `${b.id}: ${k} unchanged`);
  }
  // Again: nothing left to fill. Another set's ids aren't added, only listed as missing.
  assert.deepEqual((await call(admin, "seed_app_ideas", { seed: "v2", labels_only: true })).body.filled, []);
  const v1 = await call(admin, "seed_app_ideas", { labels_only: true });
  assert.deepEqual(v1.body, { filled: [], kept: [], missing: SEED.ideas.map((i) => i.id) });
  assert.equal((await listAppIdeas(store.db, { includeRetired: true })).length, 16, "labels_only adds nothing");
  // Audited, with what it filled.
  const entry = (await store.auditLog(50)).find((a) => a.action === "seed_app_ideas" && a.details?.labels_only && a.details.filled.length);
  assert.deepEqual(entry.details.filled.sort(), ["found-money-sweep", "tips-yearly-ladder", "wedding-cd-ladder"]);

  // The store function the same way, and it refuses a set with a bad label.
  await store.db.query(`UPDATE financial_products.app_ideas SET chip_label = NULL WHERE id = 'closing-date-cd'`);
  assert.deepEqual((await fillAppIdeaChipLabels(store.db, seedIdeas(APP_IDEAS_V2_SEED_PATH))).filled, ["closing-date-cd"]);
  await assert.rejects(fillAppIdeaChipLabels(store.db, [{ ...seedIdeas(APP_IDEAS_V2_SEED_PATH)[0], chip_label: "x".repeat(35) }]), /chip label is 1 to 34/);
});
