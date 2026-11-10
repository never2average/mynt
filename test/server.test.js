import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer } from "../dist/server.js";
import { createMcpHttpServer } from "../dist/http.js";
import { Store } from "../dist/store.js";
import { runProductTests } from "../dist/product-tests.js";
import { PRODUCT_LINES } from "../dist/catalog.js";
import { CATALOG, licensed } from "./helpers.js";

const CATALOG_TOOLS = ["find_licenses", "get_product", "get_product_regime", "get_region", "get_regulator", "get_template", "list_apps", "list_categories", "list_legal_instruments", "list_product_categories", "list_products", "list_regions", "list_regulated_product_types", "list_template_defaults", "whoami"];
const CONSUMER_TOOLS = ["block_firm_recovery", "cancel_enrollment", "enroll_in_product", "list_firm_notices", "list_my_enrollments", "list_my_product_requests", "list_offers", "request_product", "upgrade_enrollment"];
const DEVELOPER_TOOLS = [
  "create_app", "list_my_apps", "preview_app", "publish_app", "update_app",
  // building on innovators' products
  "check_experience", "get_developer_contract", "get_product_sdk", "list_buildable_products", "list_my_requests", "request_product_access",
  // GTM engineering
  "create_campaign", "create_segment", "end_campaign", "get_campaign_metrics", "launch_campaign",
  "lint_campaign", "list_my_campaigns", "list_my_segments", "pause_campaign", "update_campaign",
  // runtime layer: keys, webhooks, sandbox, releases, metrics
  "create_api_key", "list_api_keys", "revoke_api_key", "rotate_api_key",
  "create_webhook", "delete_webhook", "list_webhook_deliveries", "list_webhooks", "rotate_webhook_secret",
  "create_test_consumer", "simulate_handoff", "list_app_releases", "release_app", "rollback_app", "get_app_metrics",
  // SDKs and experiences
  "create_sdk", "generate_sdk_release", "get_sdk_release", "list_sdk_releases", "list_sdks",
  "render_experience_preview", "set_experience",
  // journeys
  "check_journey", "get_data_dictionary", "get_default_journey", "list_journeys", "preview_journey", "save_journey",
];
const INNOVATOR_TOOLS = [
  "create_product", "list_my_products", "publish_product", "test_product", "unpublish_product", "update_product",
  // versioning
  "create_product_version", "diff_product_versions", "list_product_versions", "restore_product_version",
  "update_product_version", "upgrade_enrollments",
  // firm, licences, and who may build on its products
  "create_entity", "get_my_entity", "invite_developer", "list_experiences", "list_requests", "register_license",
  "review_request", "revoke_access", "set_product_access", "suspend_product_experiences",
  // the firm's party roster and GRC folder
  "add_party", "end_party", "file_grc_record", "get_grc_folder", "set_entity_facts",
  // runtime layer
  "get_product_distribution_metrics", "report_handoff_outcome",
  // product requests
  "list_product_requests", "respond_to_product_request", "set_product_composition",
  // take rates
  "get_product_take_rate",
  // v2 product definitions
  "check_product_definition", "get_product_definition", "set_product_definition",
  // vendors' standard services
  "list_my_vendor_subscriptions", "list_service_types", "list_vendor_offerings", "set_subscription_live", "subscribe_vendor_service", "unsubscribe_vendor_service",
  // the firm's webhooks for its vendor services' results
  "create_firm_webhook", "delete_firm_webhook", "list_firm_webhooks",
  // licence providers' sponsorship of its products
  "list_my_sponsorships", "request_sponsorship",
  // the ledger of money its products moved
  "list_money_movements",
  // liquidity pools on its products
  "create_pool", "list_pools", "list_withdrawals",
];

async function connect(store, user = null) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
};
const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();

// In-process Postgres, so tests exercise the same SQL as Supabase without a database server.
async function openStore() {
  const pg = new PGlite();
  return Store.open({ query: (sql, params) => pg.query(sql, params), exec: (sql) => pg.exec(sql), close: () => pg.close() }, CATALOG);
}

async function setup() {
  const store = await openStore();
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  return {
    store,
    as,
    consumer: await as("Asha", ["consumer"]),
    developer: await as("Dev", ["developer"]),
    innovator: await as("Ines", ["innovator"]),
    rival: await as("Ravi", ["innovator"]),
  };
}

const greenFd = {
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

test("roles nest: innovator and developer are one builder role, builders are consumers", async () => {
  const { store, as, consumer, developer, innovator } = await setup();
  assert.deepEqual(await toolNames(await connect(store)), CATALOG_TOOLS);
  assert.deepEqual(await toolNames(await connect(store, consumer)), [...CATALOG_TOOLS, ...CONSUMER_TOOLS].sort());
  const all = [...CATALOG_TOOLS, ...CONSUMER_TOOLS, ...DEVELOPER_TOOLS, ...INNOVATOR_TOOLS].sort();
  assert.deepEqual(await toolNames(await connect(store, developer)), all);
  assert.deepEqual(await toolNames(await connect(store, innovator)), all);
  const multi = await as("Max", ["consumer", "innovator"]);
  assert.deepEqual(await toolNames(await connect(store, multi)), all);
  const me = (await (await connect(store, developer)).callTool({ name: "whoami", arguments: {} })).content[0].text;
  assert.deepEqual(JSON.parse(me).effective_roles, ["consumer", "developer", "innovator"]);
});

test("a developer can enroll and an innovator can build apps", async () => {
  const { store, developer, innovator } = await setup();
  const dev = await connect(store, developer);
  assert.equal((await call(dev, "enroll_in_product", { product_id: "ppf" })).data.status, "active");
  const inno = await connect(store, innovator);
  const app = (await call(inno, "create_app", { name: "A", description: "B", audience: "C", product_ids: ["ppf"] })).data;
  assert.equal(app.owner_id, innovator.id);
  // ...and a developer composes products: the two names are one role. Nobody gains admin.
  assert.equal((await dev.listTools()).tools.some((t) => t.name === "create_product"), true);
  assert.equal((await dev.listTools()).tools.some((t) => t.name === "invite_user"), false);
});

test("catalog counts every functional product line the fixture uses, with T-bills under credit", async () => {
  const client = await connect((await setup()).store);
  const { data } = await call(client, "list_categories");
  // Every line is listed, used or not.
  assert.deepEqual(Object.keys(data.product_lines).sort(), [...PRODUCT_LINES].sort());
  for (const line of new Set(CATALOG.map((p) => p.product_line))) {
    const listed = (await call(client, "list_products", { product_line: line, limit: 100 })).data;
    assert.equal(data.product_lines[line], CATALOG.filter((p) => p.product_line === line).length, line);
    assert.equal(listed.total, data.product_lines[line], line);
    assert.ok(listed.products.every((p) => p.product_line === line), line);
  }
  assert.equal(data.product_lines.payments, 0);
  const credit = (await call(client, "list_products", { product_line: "credit", limit: 100 })).data.products.map((p) => p.id);
  for (const id of ["treasury-bills", "commercial-paper", "government-bonds", "personal-loan"]) assert.ok(credit.includes(id), id);
  const units = (await call(client, "list_products", { product_line: "securitization" })).data.products.map((p) => p.id).sort();
  assert.deepEqual(units, ["invit", "reit"]);
});

test("every fixture product passes the product test suite, including the seeded regions and categories", async () => {
  const ref = await (await openStore()).referenceData();
  for (const p of CATALOG) {
    const failed = runProductTests(p, ref).checks.filter((c) => c.status === "fail");
    assert.deepEqual(failed, [], p.id);
  }
});

test("list_products filters and paginates", async () => {
  const client = await connect((await setup()).store);
  const us = (await call(client, "list_products", { region: "US" })).data;
  assert.ok(us.products.every((p) => p.region === "US" || p.region === "global"));
  const gold = (await call(client, "list_products", { query: "gold" })).data;
  assert.deepEqual(gold.products.map((p) => p.id).sort(), ["gold-loan", "sovereign-gold-bond"]);
  const page = (await call(client, "list_products", { limit: 5, offset: 5 })).data;
  assert.equal(page.products.length, 5);
});

test("innovator creates, tests and publishes; consumer and developer then use it", async () => {
  const { store, as, consumer, developer, innovator } = await setup();
  const inno = await connect(store, innovator);
  const guest = await connect(store);

  assert.equal((await call(inno, "create_product", greenFd)).data.status, "draft");
  assert.equal((await call(guest, "get_product", { id: "green-fd" })).isError, true, "drafts are private");

  const untested = await call(inno, "publish_product", { id: "green-fd" });
  assert.match(untested.data.error, /test_product/);

  const report = (await call(inno, "test_product", { id: "green-fd" })).data;
  assert.equal(report.passed, true);
  assert.equal(report.checks.find((c) => c.name === "licence_held").status, "warn");
  assert.match((await call(inno, "publish_product", { id: "green-fd" })).data.error, /verified licence/, "publishing needs a licence");
  await licensed(store, innovator, { region: "IN", category: "deposits", action: "issuance" });

  // Editing after a test invalidates it.
  await call(inno, "update_product", { id: "green-fd", name: "Green FD" });
  assert.equal((await call(inno, "publish_product", { id: "green-fd" })).isError, true);
  await call(inno, "test_product", { id: "green-fd" });
  assert.equal((await call(inno, "publish_product", { id: "green-fd" })).data.status, "published");
  assert.equal((await call(guest, "get_product", { id: "green-fd" })).data.name, "Green FD");

  const cons = await connect(store, consumer);
  const enrollment = (await call(cons, "enroll_in_product", { product_id: "green-fd", amount: 50000 })).data;
  assert.equal(enrollment.status, "active");
  assert.equal((await call(cons, "enroll_in_product", { product_id: "green-fd" })).isError, true, "no duplicate enrollment");
  assert.equal((await call(cons, "list_my_enrollments")).data[0].product.name, "Green FD");

  const dev = await connect(store, developer);
  const app = (await call(dev, "create_app", {
    name: "Climate Saver",
    description: "Save while funding renewables",
    audience: "Eco-conscious savers in India",
    product_ids: ["green-fd", "ppf"],
  })).data;
  // green-fd is approval-only (the default): the developer asks, the innovator approves.
  const blocked = await call(dev, "publish_app", { app_id: app.id });
  assert.deepEqual(blocked.data.access_needed.map((a) => a.product_id), ["green-fd"]);
  const request = (await call(dev, "request_product_access", { app_id: app.id, product_id: "green-fd", note: "Climate savings app" })).data;
  const [inbox] = (await call(inno, "list_requests")).data;
  assert.equal(inbox.id, request.id);
  assert.equal(inbox.app.name, "Climate Saver");
  await call(inno, "review_request", { request_id: request.id, decision: "approve" });
  assert.equal((await call(dev, "publish_app", { app_id: app.id })).data.status, "published");
  const [listed] = (await call(guest, "list_apps")).data;
  assert.deepEqual(listed.products.map((p) => p.id), ["green-fd", "ppf"]);

  // Unpublishing hides the product from new enrollments and flags it in apps.
  await call(inno, "unpublish_product", { id: "green-fd" });
  assert.equal((await call(cons, "enroll_in_product", { product_id: "green-fd" })).isError, true);
  assert.deepEqual((await call(dev, "preview_app", { app_id: app.id })).data.unavailable_product_ids, ["green-fd"]);

  assert.equal((await call(cons, "cancel_enrollment", { enrollment_id: enrollment.id })).data.status, "cancelled");
});

test("product tests enforce product-line rules and catch misleading claims", async () => {
  const { store, innovator } = await setup();
  const inno = await connect(store, innovator);
  await call(inno, "create_product", {
    ...greenFd,
    id: "sure-win-fund",
    product_line: "wealth",
    return_type: "market_linked",
    risk_level: "high",
    description: "Equity fund with guaranteed double-digit returns every single year.",
  });
  const report = (await call(inno, "test_product", { id: "sure-win-fund" })).data;
  assert.equal(report.passed, false);
  assert.equal(report.checks.find((c) => c.name === "misleading_claims").status, "fail");
  assert.equal((await call(inno, "publish_product", { id: "sure-win-fund" })).isError, true);

  // Credit covers debt bought as an investment: a bond paying fixed interest passes...
  await call(inno, "create_product", { ...greenFd, id: "green-bond", product_line: "credit", category: "bonds" });
  const bond = (await call(inno, "test_product", { id: "green-bond" })).data;
  assert.equal(bond.checks.find((c) => c.name === "credit_consistency").status, "pass");
  // ...but not a market-linked return, and cost_of_credit needs risk_level not_applicable.
  await call(inno, "create_product", { ...greenFd, id: "punt-loan", product_line: "credit", return_type: "market_linked" });
  assert.equal((await call(inno, "test_product", { id: "punt-loan" })).data.checks.find((c) => c.name === "credit_consistency").status, "fail");
  await call(inno, "create_product", { ...greenFd, id: "cheap-loan", product_line: "credit", return_type: "cost_of_credit" });
  const credit = (await call(inno, "test_product", { id: "cheap-loan" })).data;
  assert.equal(credit.checks.find((c) => c.name === "credit_consistency").status, "fail");
  // cost_of_credit is only for credit products.
  await call(inno, "create_product", { ...greenFd, id: "odd-fund", product_line: "wealth", category: "mutual_funds", return_type: "cost_of_credit", risk_level: "not_applicable" });
  const fund = (await call(inno, "test_product", { id: "odd-fund" })).data;
  assert.equal(fund.checks.find((c) => c.name === "credit_consistency").status, "fail");

  await call(inno, "create_product", { ...greenFd, id: "odd-cover", product_line: "insurance" });
  const insurance = (await call(inno, "test_product", { id: "odd-cover" })).data;
  assert.equal(insurance.checks.find((c) => c.name === "insurance_consistency").status, "fail");
});

test("users cannot touch other users' products, apps or enrollments", async () => {
  const { store, as, consumer, developer, innovator, rival } = await setup();
  await call(await connect(store, innovator), "create_product", greenFd);
  const rivalClient = await connect(store, rival);
  assert.equal((await call(rivalClient, "test_product", { id: "green-fd" })).isError, true);
  assert.equal((await call(rivalClient, "update_product", { id: "green-fd", name: "Mine" })).isError, true);
  assert.equal((await call(rivalClient, "create_product", greenFd)).isError, true, "ids are unique");
  assert.equal((await call(rivalClient, "update_product", { id: "ppf", name: "Mine" })).isError, true, "bundled products are read-only");

  const app = (await call(await connect(store, developer), "create_app", {
    name: "A", description: "B", audience: "C", product_ids: ["ppf"],
  })).data;
  const otherDev = await connect(store, await as("Dee", ["developer"]));
  assert.equal((await call(otherDev, "preview_app", { app_id: app.id })).isError, true);

  const e = (await call(await connect(store, consumer), "enroll_in_product", { product_id: "ppf" })).data;
  const otherConsumer = await connect(store, await as("Cy", ["consumer"]));
  assert.equal((await call(otherConsumer, "cancel_enrollment", { enrollment_id: e.id })).isError, true);
});

test("HTTP transport authenticates bearer tokens", async () => {
  const store = await openStore();
  const { token } = await store.createUser("Ines", ["innovator"]);
  const http = createMcpHttpServer(store).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const url = new URL(`http://127.0.0.1:${http.address().port}/mcp`);
  const clientFor = async (tok) => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const headers = tok ? { Authorization: `Bearer ${tok}` } : {};
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
    return client;
  };
  try {
    const inno = await clientFor(token);
    assert.ok((await toolNames(inno)).includes("create_product"));
    assert.equal((await call(inno, "whoami")).data.name, "Ines");
    assert.deepEqual(await toolNames(await clientFor()), CATALOG_TOOLS);
    await assert.rejects(clientFor("fpm_bogus"));
  } finally {
    http.close();
  }
});

// Child processes need a real Postgres; CI provides one, locally set TEST_DATABASE_URL.
test("CLI issues tokens that work over stdio against Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
  // Mynt ships no catalogue: seed the product this test enrolls in.
  const { connectPostgres } = await import("../dist/db.js");
  const seeded = await Store.open(connectPostgres(process.env.TEST_DATABASE_URL), CATALOG.filter((p) => p.id === "etf"));
  await seeded.close();
  const out = execFileSync(process.execPath, ["dist/index.js", "users", "add", "--name", "Asha", "--role", "consumer"], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const { token, roles } = JSON.parse(out);
  assert.deepEqual(roles, ["consumer"]);

  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: { ...env, FINANCIAL_PRODUCTS_TOKEN: token } }),
  );
  try {
    const { data } = await call(client, "enroll_in_product", { product_id: "etf" });
    assert.equal(data.status, "active");
  } finally {
    // Always stop the stdio server, or a failure leaves the test run hanging.
    await client.close();
  }
});

test("Mynt ships no catalogue: a new database starts with no products or categories, and only the global region", async () => {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() });
  const client = await connect(store);
  assert.equal((await call(client, "list_products", {})).data.total, 0);
  const ref = await store.referenceData(true);
  assert.deepEqual(ref.regions.map((r) => r.code), ["global"], "only the built-in global region");
  assert.equal(ref.categories.length, 0);
});

