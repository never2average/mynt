// New app's ideas: rows in Postgres (financial_products.app_ideas) that admins keep, seeded from the shipped JSON only
// when an admin asks, each labelled by the problem it solves and checked against its kind and what Mynt can build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { APP_IDEAS_SEED_PATH, appIdeaErrors, createAppIdea, listAppIdeas, seedAppIdeas, seedIdeas, updateAppIdea } from "../dist/app-ideas.js";
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

test("an idea is refused for a missing kind, someone else's lines, lines Mynt can't build on in the US, and promises it can't keep", () => {
  const good = seedIdeas().find((i) => i.id === "trip-kitty");
  const stable = seedIdeas().find((i) => i.id === "driver-cash-out");
  const errs = (patch, base = good) => appIdeaErrors({ ...base, ...patch }).join("; ");
  assert.equal(errs({}), "");
  assert.match(errs({ kind: "nope" }), /no app kind 'nope'/);
  assert.match(errs({ product_lines: ["custody_settlement"] }), /'custody_settlement' isn't one of the money-transfers kind's product lines/);
  assert.match(errs({ product_lines: ["credit"] }), /'credit' isn't a product line Mynt can build on in the US/);
  assert.match(errs({ product_lines: [] }), /at least one product line/);
  assert.match(errs({ product_lines: ["payments", "payments"] }), /listed twice/);
  assert.match(errs({ id: "Trip Kitty" }), /the id is/);
  assert.match(errs({ pitch: "x".repeat(121) }), /the pitch is 10 to 120 characters/);
  assert.match(errs({ problem: "x".repeat(81) }), /the problem is 10 to 80 characters/);
  assert.match(errs({ problem: "Two lines\nof problem" }), /the problem is one line/);
  assert.match(errs({ goal: "Too short." }), /the goal is 40 to 1200 characters/);
  assert.match(errs({ problem: "Friends want to earn interest on the kitty" }), /the problem says 'earn'/);
  assert.match(errs({ pitch: "Guaranteed to settle up every friend fast." }), /the pitch says 'Guaranteed'/);
  assert.match(errs({ pitch: "Lets sellers collect from their friends." }), /'sellers'/);
  assert.match(errs({ pitch: "Pay back friends with your debit card today." }), /'card'/);
  assert.match(errs({ goal: `${good.goal} Friends can borrow from the kitty.` }), /the goal says 'borrow'/);
  assert.match(errs({ goal: `${good.goal} Settle at kitty.example.com.` }), /web address/);
  assert.match(errs({ goal: `${good.goal} It calls mintTokens first.` }), /names mintTokens, which isn't one of the money-transfers kind's SDK calls/);
  assert.match(errs({ goal: stable.goal.replace("dollars only, never crypto", "dollars") }, stable), /dollars only, never crypto/);
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
  assert.deepEqual(Object.keys(all[0]).sort(), ["goal", "id", "kind", "pitch", "problem", "product_lines"]);
  const transfers = (await call(dev, "list_app_ideas", { kind: "money-transfers" })).body.ideas;
  assert.deepEqual(transfers.map((i) => i.id), ["trip-kitty", "creator-tip-jar", "shift-end-payouts", "closing-day-wire"]);
  assert.equal(transfers[0].problem, "Friends on a trip lose track of who owes whom");

  // An admin edits one and retires another; seeding again leaves both as they are.
  const edited = await call(admin, "update_app_idea", { id: "trip-kitty", problem: "Friends sharing a trip can't tell who still owes what" });
  assert.equal(edited.error, false, JSON.stringify(edited.body));
  assert.equal(edited.body.idea.problem, "Friends sharing a trip can't tell who still owes what");
  assert.equal(edited.body.idea.pitch, SEED.ideas.find((i) => i.id === "trip-kitty").pitch, "fields left out stay");
  assert.equal((await call(admin, "retire_app_idea", { id: "club-dues" })).body.idea.status, "retired");
  assert.deepEqual((await call(admin, "seed_app_ideas")).body.inserted, []);
  assert.equal((await call(dev, "list_app_ideas", { kind: "money-transfers" })).body.ideas[0].problem, "Friends sharing a trip can't tell who still owes what");
  assert.ok(!(await call(dev, "list_app_ideas")).body.ideas.some((i) => i.id === "club-dues"), "retired ideas aren't offered");
  assert.ok(!(await call(dev, "list_app_ideas", { include_retired: true })).body.ideas.some((i) => i.id === "club-dues"), "only admins see retired ones");
  // Admins may see retired ones, and bring one back.
  const withRetired = (await call(admin, "list_app_ideas", { include_retired: true })).body.ideas;
  assert.equal(withRetired.find((i) => i.id === "club-dues").status, "retired");
  assert.equal((await call(admin, "update_app_idea", { id: "club-dues", status: "active" })).body.idea.status, "active");

  // Create: checked, unique.
  const fresh = {
    id: "babysitter-pay",
    kind: "money-transfers",
    problem: "Parents scramble for cash to pay the babysitter at night",
    pitch: "Pays the sitter by bank transfer before they leave, with the fee shown first.",
    goal: "A babysitter pay app. A parent adds a sitter, enters the hours at the end of the night and pays them by bank transfer through the provider's hosted flow, seeing the amount, the fee and when it arrives before they confirm.",
    product_lines: ["payments"],
    sort: 5,
  };
  const created = await call(admin, "create_app_idea", fresh);
  assert.equal(created.error, false, JSON.stringify(created.body));
  assert.equal(created.body.idea.created_by, adminUser.id);
  assert.equal((await call(dev, "list_app_ideas", { kind: "money-transfers" })).body.ideas[0].id, "babysitter-pay", "sort orders a kind's ideas");
  assert.match((await call(admin, "create_app_idea", fresh)).body.error, /already an idea 'babysitter-pay'/);
  const bad = await call(admin, "create_app_idea", { ...fresh, id: "sitter-advance", pitch: "Advances the sitter a loan until payday arrives." });
  assert.equal(bad.error, true);
  assert.match(bad.body.error, /the pitch says 'loan'/);
  // Moving an idea to a kind whose lines it doesn't share is refused; the row stays as it was.
  assert.match((await call(admin, "update_app_idea", { id: "babysitter-pay", kind: "savings-goals" })).body.error, /'payments' isn't one of the savings-goals kind's product lines/);
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
  await updateAppIdea(store.db, "cool-off-cash", { pitch: "Every withdrawal waits a day and can be called off in the meantime." });
  const { inserted, kept } = await seedAppIdeas(store.db, null, ideas);
  assert.deepEqual(inserted, []);
  assert.equal(kept.length, 16);
  assert.equal((await listAppIdeas(store.db, { kind: "dollar-account" })).find((i) => i.id === "cool-off-cash").pitch, "Every withdrawal waits a day and can be called off in the meantime.");
  await assert.rejects(createAppIdea(store.db, { ...ideas[0] }, null), /already an idea/);
});
