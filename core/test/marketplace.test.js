import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  // Users with emails, so invitations and membership by email work.
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, `${name.toLowerCase()}@example.com`]);
    return { ...user, email: `${name.toLowerCase()}@example.com` };
  };
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: res.isError ?? false, data };
  };
  return { pg, store, as, connect, call };
}

const product = (over = {}) => ({
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
  ...over,
});

// An innovator with a published, licensed product.
async function publishedBy(ctx, name, over = {}, licence = {}) {
  const user = await ctx.as(name, ["innovator"]);
  await licensed(ctx.store, user, { region: "IN", category: over.category ?? "deposits", action: over.action ?? "issuance", ...licence });
  const client = await ctx.connect(user);
  const created = await ctx.call(client, "create_product", product(over));
  assert.equal(created.isError, false, JSON.stringify(created.data));
  await ctx.call(client, "test_product", { id: over.id ?? "green-fd" });
  const published = await ctx.call(client, "publish_product", { id: over.id ?? "green-fd" });
  assert.equal(published.isError, false, JSON.stringify(published.data));
  return { user, client };
}

test("innovators publish only under a verified, in-force licence their firm holds", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));

  // A regulator with a deposit-taking licence, in the regulatory model.
  await call(admin, "define_regulated_product_type", {
    region: "IN",
    product_type: { id: "fd", name: "Fixed deposit", type_id: "deposits", actions: ["issuance"] },
  });
  await call(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "rbi",
      name: "Reserve Bank of India",
      short_name: "RBI",
      scope: { product_types: [{ id: "fd" }], customer_personas: [] },
      license_types: [{ _id: "rbi_bank", name: "Banking licence", grc: { allowed_product_types: ["fd"] } }],
    },
  });

  await call(inno, "create_product", product());
  await call(inno, "test_product", { id: "green-fd" });
  assert.match((await call(inno, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_bank", registration_number: "X" })).data.error, /create_entity/);

  await call(inno, "create_entity", { name: "Green Bank Ltd", regions: ["IN"] });
  assert.equal((await call(inno, "register_license", { region: "IN", regulator_id: "rbi", license_id: "nope", registration_number: "X" })).isError, true);
  const held = (await call(inno, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_bank", registration_number: "RBI-123" })).data;
  assert.equal(held.status, "pending");
  assert.match((await call(inno, "publish_product", { id: "green-fd" })).data.error, /verified licence/, "pending doesn't count");

  const reviews = (await call(admin, "list_license_reviews")).data;
  assert.equal(reviews[0].entity, "Green Bank Ltd");
  await call(admin, "review_license", { license_record_id: held.id, decision: "verified", note: "Checked the public register" });
  const published = (await call(inno, "publish_product", { id: "green-fd" })).data;
  assert.equal(published.status, "published");
  assert.deepEqual(published.licensed_under, [{ regulator: "rbi", license: "rbi_bank", registration_number: "RBI-123" }]);

  // Suspended or expired licences stop new products.
  await call(admin, "review_license", { license_record_id: held.id, decision: "suspended" });
  await call(inno, "create_product", product({ id: "green-fd-2" }));
  await call(inno, "test_product", { id: "green-fd-2" });
  assert.equal((await call(inno, "publish_product", { id: "green-fd-2" })).isError, true);
  await call(inno, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_bank", registration_number: "RBI-123", valid_to: "2001-01-01" });
  await call(admin, "review_license", { license_record_id: held.id, decision: "verified" });
  assert.equal((await call(inno, "publish_product", { id: "green-fd-2" })).isError, true, "expired");

  const firm = (await call(inno, "get_my_entity")).data;
  assert.equal(firm.name, "Green Bank Ltd");
  assert.equal(firm.licenses[0].valid_to, "2001-01-01");
});

test("a distributor is an innovator too: it sells another issuer's product under its own licence", async () => {
  const ctx = await setup();
  await publishedBy(ctx, "Amc", { id: "index-fund-x", product_line: "wealth", category: "mutual_funds", return_type: "market_linked", risk_level: "high", liquidity: "high", typical_horizon: "long", regulator: "SEBI", description: "Index fund tracking a broad market index with low costs.", key_features: ["Low cost", "Diversified"] });
  const mfd = await ctx.as("Mfd", ["innovator"]);
  const client = await ctx.connect(mfd);
  const resale = { id: "goal-saver", name: "Goal saver", product_line: "wealth", category: "mutual_funds", return_type: "market_linked", risk_level: "high", liquidity: "high", typical_horizon: "long", regulator: "SEBI", description: "Systematic investment into an index fund for a savings goal.", key_features: ["SIP", "Goal tracking"], region: "IN" };
  assert.match((await ctx.call(client, "create_product", { ...resale, action: "sale" })).data.error, /underlying_product_ids/);
  await ctx.call(client, "create_product", { ...resale, action: "sale", underlying_product_ids: ["index-fund-x"] });
  await ctx.call(client, "test_product", { id: "goal-saver" });
  // An issuance licence doesn't cover selling.
  await licensed(ctx.store, mfd, { region: "IN", category: "mutual_funds", action: "issuance" });
  assert.equal((await ctx.call(client, "publish_product", { id: "goal-saver" })).isError, true);
  await licensed(ctx.store, mfd, { region: "IN", category: "mutual_funds", action: "sale" });
  assert.equal((await ctx.call(client, "publish_product", { id: "goal-saver" })).data.status, "published");
});

test("open, approval and private products, and the innovator's inbox", async () => {
  const ctx = await setup();
  const { client: inno } = await publishedBy(ctx, "Ines");
  const devUser = await ctx.as("Dev", ["developer"]);
  const dev = await ctx.connect(devUser);
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["green-fd"] })).data;

  // Approval (default): rejected first, then approved.
  let req = (await ctx.call(dev, "request_product_access", { app_id: app.id, product_id: "green-fd", note: "Savings app" })).data;
  assert.equal((await ctx.call(dev, "request_product_access", { app_id: app.id, product_id: "green-fd" })).isError, true, "one pending request");
  await ctx.call(inno, "review_request", { request_id: req.id, decision: "reject", note: "Tell us more" });
  assert.equal((await ctx.call(dev, "list_my_requests")).data[0].decision_note, "Tell us more");
  req = (await ctx.call(dev, "request_product_access", { app_id: app.id, product_id: "green-fd", note: "Savings app for salaried users" })).data;
  await ctx.call(inno, "review_request", { request_id: req.id, decision: "approve" });
  assert.equal((await ctx.call(dev, "publish_app", { app_id: app.id })).data.status, "published");
  assert.equal((await ctx.call(inno, "list_experiences")).data[0].your_products[0].access, "approved");

  // Open: no request needed.
  await ctx.call(inno, "set_product_access", { id: "green-fd", access_mode: "open" });
  const app2 = (await ctx.call(dev, "create_app", { name: "Saver 2", description: "More", audience: "Savers", product_ids: ["green-fd"] })).data;
  assert.equal((await ctx.call(dev, "publish_app", { app_id: app2.id })).data.status, "published");

  // Private: hidden and closed until invited.
  await ctx.call(inno, "set_product_access", { id: "green-fd", access_mode: "private" });
  assert.ok(!(await ctx.call(dev, "list_buildable_products")).data.some((p) => p.id === "green-fd"));
  const other = await ctx.connect(await ctx.as("Other", ["developer"]));
  assert.equal((await ctx.call(other, "create_app", { name: "X", description: "X", audience: "X", product_ids: ["green-fd"] })).isError, true);
  await ctx.call(inno, "invite_developer", { product_id: "green-fd", developer_email: "other@example.com" });
  const app3 = (await ctx.call(other, "create_app", { name: "X", description: "X", audience: "X", product_ids: ["green-fd"] })).data;
  assert.equal((await ctx.call(other, "publish_app", { app_id: app3.id })).data.status, "published");
  assert.equal((await ctx.call(other, "get_product_sdk", { product_id: "green-fd" })).data.access.status, "invited");
});

test("experiences must meet the product's build terms", async () => {
  const ctx = await setup();
  const { client: inno } = await publishedBy(ctx, "Ines");
  await ctx.call(inno, "set_product_access", {
    id: "green-fd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link"], required_disclosures: ["Deposits are insured up to the statutory limit"], banned_phrases: ["risk-free"] },
  });
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const sdk = (await ctx.call(dev, "get_product_sdk", { product_id: "green-fd" })).data;
  assert.equal(sdk.integration.actions.initiate_onboarding, "not permitted");

  const app = (await ctx.call(dev, "create_app", { name: "Risk-free savings", description: "Save", audience: "Savers", product_ids: ["green-fd"], actions: ["display", "initiate_onboarding"] })).data;
  const refused = await ctx.call(dev, "publish_app", { app_id: app.id });
  assert.deepEqual(refused.data.failed_checks.map((c) => c.name).sort(), ["actions", "banned_phrases", "disclosures"]);

  await ctx.call(dev, "update_app", { app_id: app.id, name: "Green savings", actions: ["display", "deep_link"], disclosures: ["Deposits are insured up to the statutory limit."] });
  assert.equal((await ctx.call(dev, "check_experience", { app_id: app.id })).data.ready, true);
  assert.equal((await ctx.call(dev, "publish_app", { app_id: app.id })).data.status, "published");
});

test("innovators can revoke access or pull a product from every experience at once", async () => {
  const ctx = await setup();
  const { client: inno } = await publishedBy(ctx, "Ines");
  const guest = await ctx.connect(null);
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["green-fd", "ppf"] })).data;
  const req = (await ctx.call(dev, "request_product_access", { app_id: app.id, product_id: "green-fd" })).data;
  await ctx.call(inno, "review_request", { request_id: req.id, decision: "approve" });
  await ctx.call(dev, "publish_app", { app_id: app.id });

  await ctx.call(inno, "revoke_access", { request_id: req.id, reason: "Breached our terms" });
  assert.deepEqual((await ctx.call(guest, "list_apps")).data[0].products.map((p) => p.id), ["ppf"]);

  // Kill switch: private, everything revoked, campaigns paused.
  await ctx.call(inno, "set_product_access", { id: "green-fd", access_mode: "open" });
  const own = (await ctx.call(inno, "create_campaign", {
    name: "FD week",
    product_ids: ["green-fd"],
    channels: ["email"],
    variants: [{ key: "a", headline: "Lock in your rate", body: "Fixed interest for the whole term", cta: "Open" }],
  })).data;
  assert.equal((await ctx.call(inno, "launch_campaign", { campaign_id: own.id })).data.status, "live", "own products need no approval");
  const killed = (await ctx.call(inno, "suspend_product_experiences", { product_id: "green-fd", reason: "Rate change" })).data;
  assert.equal(killed.campaigns_paused, 1);
  assert.equal((await ctx.store.getProduct("green-fd")).access_mode, "private");
});

test("a developer's campaign over an innovator's product waits for the innovator's approval", async () => {
  const ctx = await setup();
  const { client: inno } = await publishedBy(ctx, "Ines");
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const variants = [{ key: "a", headline: "Lock in your rate", body: "Fixed interest for the whole term", cta: "Open" }];
  const c = (await ctx.call(dev, "create_campaign", { name: "FD week", product_ids: ["green-fd"], channels: ["email"], variants })).data;
  const launched = (await ctx.call(dev, "launch_campaign", { campaign_id: c.id })).data;
  assert.equal(launched.status, "pending_approval");
  assert.deepEqual(launched.awaiting_approval_for, ["green-fd"]);
  assert.equal((await ctx.call(dev, "update_campaign", { campaign_id: c.id, name: "x" })).isError, true, "frozen while pending");

  const [inbox] = (await ctx.call(inno, "list_requests", { kind: "campaign_launch" })).data;
  assert.equal(inbox.campaign.name, "FD week");
  assert.equal((await ctx.call(inno, "review_request", { request_id: inbox.id, decision: "approve" })).data.campaign_status, "live");

  const c2 = (await ctx.call(dev, "create_campaign", { name: "FD week 2", product_ids: ["green-fd"], channels: ["email"], variants })).data;
  await ctx.call(dev, "launch_campaign", { campaign_id: c2.id });
  const [next] = (await ctx.call(inno, "list_requests", { kind: "campaign_launch" })).data;
  assert.equal((await ctx.call(inno, "review_request", { request_id: next.id, decision: "reject", note: "Not this month" })).data.campaign_status, "draft");
});

// Innovator and developer are one builder role (2026-11-08): a developer gets the financial-layer tools too,
// but never an admin's or a licence provider's.
test("developers are builders: the financial-layer tools as well as the software ones", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const tools = (await dev.listTools()).tools.map((t) => t.name);
  for (const t of ["create_product", "publish_product", "register_license", "create_entity", "set_product_access", "review_request", "list_requests"]) {
    assert.ok(tools.includes(t), t);
  }
  for (const t of ["review_license", "approve_sponsorship", "register_firm"]) assert.ok(!tools.includes(t), t);
  for (const t of ["list_buildable_products", "get_product_sdk", "request_product_access", "check_experience"]) assert.ok(tools.includes(t), t);
});

test("admins see firms and can add members", async () => {
  const ctx = await setup();
  const admin = await ctx.connect(await ctx.as("Ada", ["admin"]));
  const { user } = await publishedBy(ctx, "Ines");
  const colleague = await ctx.as("Colleague", ["innovator"]);
  const added = (await ctx.call(admin, "add_entity_member", { email: "colleague@example.com", entity_id: user.entity_id })).data;
  assert.equal(added.member, "colleague@example.com");
  const firms = (await ctx.call(admin, "list_entities")).data;
  assert.deepEqual(firms[0].members.map((m) => m.email).sort(), ["colleague@example.com", "ines@example.com"]);
  // A colleague answers for the firm's products.
  const c = await ctx.connect({ ...colleague, entity_id: user.entity_id });
  assert.equal((await ctx.call(c, "set_product_access", { id: "green-fd", access_mode: "open" })).data.access_mode, "open");
});
