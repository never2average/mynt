import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const ADMIN_TOOLS = [
  "admin_pause_campaign", "admin_set_product_status", "audit_log", "define_product_category", "define_region",
  "define_judgment", "define_legal_instrument", "define_legislation", "define_regulated_product_type", "define_regulator", "invite_user", "list_all_campaigns",
  "list_whitelist", "remove_judgment", "remove_legal_instrument", "remove_legislation",
  "remove_regulated_product_type", "remove_regulator", "revoke_user", "define_take_rate", "list_take_rates", "recompute_product_derived",
  "decide_promotion_signoff", "list_promotion_signoffs",
];

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const allowed = [];
  const disallowed = [];
  const clerkAdmin = { allow: async (e) => (allowed.push(e), null), disallow: async (e) => void disallowed.push(e) };
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { clerkAdmin }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  const tools = async (client) => (await client.listTools()).tools.map((t) => t.name);
  return { store, as, connect, call, tools, allowed, disallowed };
}

const product = (over = {}) => ({
  id: "uk-isa",
  name: "Cash ISA",
  product_line: "account_operations",
  category: "deposits",
  region: "GB",
  risk_level: "low",
  liquidity: "high",
  typical_horizon: "medium",
  return_type: "variable_interest",
  regulator: "FCA",
  description: "Tax-free savings account for UK residents with an annual allowance.",
  key_features: ["Tax-free interest", "Annual allowance"],
  ...over,
});

test("admins sit above innovators and alone see the admin tools", async () => {
  const { as, connect, call, tools } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const adminTools = await tools(admin);
  for (const t of [...ADMIN_TOOLS, "create_product", "create_campaign", "enroll_in_product"]) assert.ok(adminTools.includes(t), t);
  assert.deepEqual((await call(admin, "whoami")).data.effective_roles, ["consumer", "developer", "innovator", "vendor", "license_provider", "admin"]);
  const innoTools = await tools(await connect(await as("Ines", ["innovator"])));
  assert.ok(ADMIN_TOOLS.every((t) => !innoTools.includes(t)));
});

test("regions and categories come from admins; products must use them", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));
  const guest = await connect(null);

  // Seeded from the catalog, visible to everyone.
  assert.ok((await call(guest, "list_regions")).data.some((r) => r.code === "IN" && r.regulators.includes("RBI")));
  assert.ok((await call(guest, "list_product_categories", { product_line: "credit" })).data.every((c) => c.product_lines.includes("credit")));

  await call(inno, "create_product", product());
  let report = (await call(inno, "test_product", { id: "uk-isa" })).data;
  assert.equal(report.passed, false);
  assert.match(report.checks.find((c) => c.name === "region").message, /isn't offered/);

  await call(admin, "define_region", { code: "GB", name: "United Kingdom", regulators: ["FCA", "PRA"] });
  report = (await call(inno, "test_product", { id: "uk-isa" })).data;
  assert.equal(report.passed, true);
  assert.equal(report.checks.find((c) => c.name === "regulator_for_region").status, "pass");

  // A category must exist and allow the product line.
  await call(inno, "update_product", { id: "uk-isa", category: "isa" });
  assert.match((await call(inno, "test_product", { id: "uk-isa" })).data.checks.find((c) => c.name === "category").message, /isn't defined/);
  await call(admin, "define_product_category", { id: "isa", name: "Individual Savings Account", product_lines: ["wealth"] });
  assert.match((await call(inno, "test_product", { id: "uk-isa" })).data.checks.find((c) => c.name === "category").message, /it is for: wealth/);
  await call(admin, "define_product_category", { id: "isa", name: "Individual Savings Account", product_lines: ["wealth", "account_operations"] });
  assert.equal((await call(inno, "test_product", { id: "uk-isa" })).data.passed, true);

  // Retiring a region stops new products using it; only admins can list retired ones.
  await call(admin, "define_region", { code: "GB", name: "United Kingdom", regulators: ["FCA"], active: false });
  assert.equal((await call(inno, "test_product", { id: "uk-isa" })).data.passed, false);
  assert.ok(!(await call(inno, "list_regions", { include_inactive: true })).data.some((r) => r.code === "GB"));
  assert.ok((await call(admin, "list_regions", { include_inactive: true })).data.some((r) => r.code === "GB" && !r.active));
});

test("admins manage the whitelist in Mynt, synced to Clerk, and can't remove the last admin", async () => {
  const { as, connect, call, allowed, disallowed } = await setup();
  const adminUser = await as("Ada", ["admin"]);
  const admin = await connect(adminUser);

  await call(admin, "invite_user", { email: "Ada@Example.com", roles: ["admin"] });
  await call(admin, "invite_user", { email: "dev@example.com", roles: ["developer"] });
  assert.deepEqual(allowed, ["ada@example.com", "dev@example.com"]);
  assert.equal((await call(admin, "invite_user", { email: "dev@example.com", roles: ["innovator"] })).data.roles[0], "innovator");

  assert.match((await call(admin, "revoke_user", { email: "ada@example.com" })).data.error, /last admin/);
  assert.match((await call(admin, "invite_user", { email: "ada@example.com", roles: ["innovator"] })).data.error, /last admin/);
  await call(admin, "invite_user", { email: "dev@example.com", roles: ["admin"] });
  assert.equal((await call(admin, "revoke_user", { email: "ada@example.com" })).data.revoked, "ada@example.com");
  assert.deepEqual(disallowed, ["ada@example.com"]);

  const wl = (await call(admin, "list_whitelist")).data.whitelist;
  assert.deepEqual(wl.map((i) => [i.email, i.roles]), [["dev@example.com", ["admin"]]]);
  const log = (await call(admin, "audit_log")).data;
  assert.equal(log[0].action, "revoke_user");
  assert.equal(log[0].actor_id, adminUser.id);
});

test("admins oversee campaigns and products", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const dev = await connect(await as("Dev", ["developer"]));
  const consumer = await connect(await as("Asha", ["consumer"]));

  const c = (await call(dev, "create_campaign", {
    name: "FD week",
    product_ids: ["fixed-deposit"],
    channels: ["email"],
    variants: [{ key: "a", headline: "Lock in your rate", body: "Fixed interest for the whole term", cta: "Open" }],
  })).data;
  await call(dev, "launch_campaign", { campaign_id: c.id });
  assert.equal((await call(admin, "list_all_campaigns", { status: "live" })).data.length, 1);
  assert.equal((await call(admin, "admin_pause_campaign", { campaign_id: c.id, reason: "Rate sheet under review" })).data.status, "paused");
  assert.deepEqual((await call(consumer, "list_offers")).data, []);

  assert.equal((await call(admin, "admin_set_product_status", { id: "ppf", status: "unpublished", reason: "Scheme rules changing" })).data.status, "unpublished");
  assert.equal((await call(consumer, "get_product", { id: "ppf" })).isError, true);
  assert.equal((await call(admin, "admin_set_product_status", { id: "ppf", status: "published", reason: "Rules confirmed" })).data.status, "published");
  const actions = (await call(admin, "audit_log")).data.map((e) => e.action);
  assert.deepEqual(actions.slice(0, 3), ["admin_set_product_status", "admin_set_product_status", "admin_pause_campaign"]);
});

test("admins record a region's regulatory ecosystem and launch procedures; innovators read them", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));

  await call(admin, "define_region", {
    code: "GB",
    name: "United Kingdom",
    regulators: ["FCA", "PRA"],
    ecosystem: "The FCA regulates conduct; the PRA supervises deposit-takers and insurers.",
    procedures: [
      {
        product_line: "account_operations",
        name: "Deposit-taking",
        regulator: "PRA",
        steps: ["Apply for Part 4A permission to accept deposits", "Join the FSCS"],
        typical_timeline: "6-12 months",
      },
    ],
    sources: ["https://www.fca.org.uk/firms/authorisation"],
  });

  // A partial update (e.g. retiring and restoring) keeps the researched content.
  await call(admin, "define_region", { code: "GB", active: false });
  await call(admin, "define_region", { code: "GB", active: true });
  const gb = (await call(inno, "get_region", { code: "GB" })).data;
  assert.match(gb.ecosystem, /FCA regulates conduct/);
  assert.deepEqual(gb.sources, ["https://www.fca.org.uk/firms/authorisation"]);
  assert.equal(gb.procedures[0].regulator, "PRA");
  assert.deepEqual((await call(inno, "get_region", { code: "GB", product_line: "credit" })).data.procedures, []);

  // The list stays short: it says which lines have a documented procedure.
  const listed = (await call(inno, "list_regions")).data.find((r) => r.code === "GB");
  assert.deepEqual(listed.procedures_for, ["account_operations"]);
  assert.equal(listed.ecosystem, undefined);

  // Innovators are warned (not blocked) when no procedure covers their product's line.
  await call(inno, "create_product", product());
  const ok = (await call(inno, "test_product", { id: "uk-isa" })).data;
  assert.equal(ok.checks.find((c) => c.name === "launch_procedure").status, "pass");
  await call(inno, "update_product", { id: "uk-isa", product_line: "wealth", category: "mutual_funds", return_type: "market_linked", risk_level: "high" });
  const warned = (await call(inno, "test_product", { id: "uk-isa" })).data;
  assert.equal(warned.checks.find((c) => c.name === "launch_procedure").status, "warn");
  assert.equal(warned.passed, true);
});
