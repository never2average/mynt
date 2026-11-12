import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "../dist/server.js";
import { lintCampaign } from "../dist/gtm.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  return { store, as, connect, call };
}

const product = {
  id: "flexi-fd",
  name: "Flexi Fixed Deposit",
  product_line: "account_operations",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "moderate",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "Fixed deposit that allows partial withdrawals without breaking the whole deposit.",
  key_features: ["Fixed rate", "Partial withdrawals"],
};

test("the server identifies itself as mynt", async () => {
  const { connect } = await setup();
  const client = await connect(null);
  assert.equal(SERVER_NAME, "mynt");
  assert.equal(client.getServerVersion().name, "mynt");
  assert.ok((await client.listResources()).resources.some((r) => r.uri === "mynt://catalog"));
});

test("innovators version products: draft, test, publish, history, diff, upgrade, restore", async () => {
  const { store, as, connect, call } = await setup();
  const ines = await as("Ines", ["innovator"]);
  await licensed(store, ines, { region: "IN", category: "deposits", action: "issuance" });
  const inno = await connect(ines);
  await call(inno, "create_product", product);
  await call(inno, "test_product", { id: "flexi-fd" });
  assert.equal((await call(inno, "publish_product", { id: "flexi-fd" })).data.version, 1);

  const consumerUser = await as("Asha", ["consumer"]);
  const cons = await connect(consumerUser);
  const enrollment = (await call(cons, "enroll_in_product", { product_id: "flexi-fd", amount: 1000 })).data;
  assert.equal(enrollment.product_version, 1);

  // A live product isn't edited in place; its next version is drafted.
  assert.match((await call(inno, "update_product", { id: "flexi-fd", name: "x" })).data.error, /create_product_version/);
  const draft = (await call(inno, "create_product_version", { id: "flexi-fd", changelog: "Monthly payouts", key_features: ["Fixed rate", "Partial withdrawals", "Monthly payouts"] })).data;
  assert.equal(draft.version, 2);
  assert.deepEqual(draft.changes.map((c) => c.field), ["key_features"]);
  assert.equal((await call(inno, "create_product_version", { id: "flexi-fd", changelog: "again" })).isError, true, "one draft at a time");

  // The live version keeps serving until the draft is tested and published.
  assert.equal((await call(cons, "get_product", { id: "flexi-fd" })).data.key_features.length, 2);
  assert.match((await call(inno, "publish_product", { id: "flexi-fd" })).data.error, /test_product/);
  assert.equal((await call(inno, "test_product", { id: "flexi-fd" })).data.version, 2);
  await call(inno, "update_product_version", { id: "flexi-fd", liquidity: "high" });
  assert.equal((await call(inno, "publish_product", { id: "flexi-fd" })).isError, true, "edits after the test need a new test");
  await call(inno, "test_product", { id: "flexi-fd" });
  const live = (await call(inno, "publish_product", { id: "flexi-fd" })).data;
  assert.equal(live.version, 2);
  assert.equal((await call(cons, "get_product", { id: "flexi-fd" })).data.key_features.length, 3);

  const history = (await call(inno, "list_product_versions", { id: "flexi-fd" })).data;
  assert.equal(history.live_version, 2);
  assert.deepEqual(history.versions.map((v) => [v.version, v.status]), [[1, "superseded"], [2, "published"]]);
  const diff = (await call(inno, "diff_product_versions", { id: "flexi-fd", from_version: 1, to_version: 2 })).data;
  assert.deepEqual(diff.changes.map((c) => c.field).sort(), ["key_features", "liquidity"]);

  // Existing customers stay on v1 until upgraded.
  const [mine] = (await call(cons, "list_my_enrollments")).data;
  assert.equal(mine.product_version, 1);
  assert.equal(mine.upgrade_available, true);
  assert.equal((await call(cons, "upgrade_enrollment", { enrollment_id: enrollment.id })).data.product_version, 2);
  assert.equal((await call(cons, "upgrade_enrollment", { enrollment_id: enrollment.id })).isError, true);

  const other = await connect(await as("Bo", ["consumer"]));
  await call(other, "enroll_in_product", { product_id: "flexi-fd" });
  await call(inno, "restore_product_version", { id: "flexi-fd", version: 1 });
  await call(inno, "test_product", { id: "flexi-fd" });
  assert.equal((await call(inno, "publish_product", { id: "flexi-fd" })).data.version, 3);
  assert.equal((await call(cons, "get_product", { id: "flexi-fd" })).data.key_features.length, 2, "v3 restores v1's terms");
  assert.equal((await call(inno, "upgrade_enrollments", { id: "flexi-fd" })).data.upgraded, 2);
});

test("versioning is owner-only and bundled products can't be versioned", async () => {
  const { as, connect, call } = await setup();
  const inno = await connect(await as("Ines", ["innovator"]));
  const rival = await connect(await as("Ravi", ["innovator"]));
  await call(inno, "create_product", product);
  await call(inno, "test_product", { id: "flexi-fd" });
  await call(inno, "publish_product", { id: "flexi-fd" });
  assert.equal((await call(rival, "create_product_version", { id: "flexi-fd", changelog: "mine now" })).isError, true);
  assert.equal((await call(rival, "upgrade_enrollments", { id: "flexi-fd" })).isError, true);
  assert.equal((await call(inno, "create_product_version", { id: "ppf", changelog: "nope" })).isError, true);
});

test("compliance lint blocks misleading copy and missing disclosures", () => {
  const fund = { id: "fund", product_line: "wealth", return_type: "market_linked" };
  const loan = { id: "loan", product_line: "credit", return_type: "cost_of_credit" };
  const fd = { id: "fd", product_line: "account_operations", return_type: "fixed_interest" };
  const bad = lintCampaign([{ key: "a", headline: "Guaranteed 15% returns!", body: "Invest now", cta: "Start" }], [fund]);
  assert.equal(bad.passed, false);
  assert.deepEqual(bad.checks.filter((c) => c.status === "fail").map((c) => c.name).sort(), ["no_guarantee_claims", "risk_disclosure"]);
  const good = lintCampaign([{ key: "a", headline: "Grow with the index", body: "Mutual fund investments are subject to market risks.", cta: "Start" }], [fund]);
  assert.equal(good.passed, true);
  assert.equal(lintCampaign([{ key: "a", headline: "Cash fast", body: "Apply in minutes", cta: "Apply" }], [loan]).passed, false);
  assert.equal(lintCampaign([{ key: "a", headline: "Cash fast", body: "From 11% interest p.a., no hidden fees", cta: "Apply" }], [loan]).passed, true);
  assert.equal(lintCampaign([{ key: "a", headline: "Guaranteed rate", body: "Lock in today", cta: "Open" }], [fd]).passed, true, "fixed-interest products may state a guaranteed rate");
});

test("developers run GTM: segment, campaign, lint, launch, offers, attribution, metrics", async () => {
  const { as, connect, call } = await setup();
  const devUser = await as("Dev", ["developer"]);
  const dev = await connect(devUser);
  const saver = await connect(await as("Saver", ["consumer"]));
  const insured = await connect(await as("Insured", ["consumer"]));
  await call(saver, "enroll_in_product", { product_id: "savings-account" });
  await call(insured, "enroll_in_product", { product_id: "savings-account" });
  await call(insured, "enroll_in_product", { product_id: "term-life-insurance" });

  // Cross-sell term cover to savers who don't have it.
  const segment = (await call(dev, "create_segment", { name: "Savers without cover", enrolled_in: ["savings-account"], not_enrolled_in: ["term-life-insurance"] })).data;
  assert.equal(segment.audience_size, 1);

  const campaign = (await call(dev, "create_campaign", {
    name: "Protect your savings",
    product_ids: ["term-life-insurance"],
    segment_id: segment.id,
    channels: ["email", "in_app"],
    variants: [
      { key: "a", headline: "Guaranteed peace of mind", body: "Risk-free cover for your family", cta: "Get a quote" },
      { key: "b", headline: "Cover your family", body: "Term cover from a few hundred a month", cta: "Get a quote" },
    ],
  })).data;
  assert.equal(campaign.status, "draft");
  // Term insurance is a protection product, so "guaranteed" copy is allowed here.
  assert.equal((await call(dev, "lint_campaign", { campaign_id: campaign.id })).data.passed, true);
  assert.equal((await call(dev, "launch_campaign", { campaign_id: campaign.id })).data.status, "live");
  assert.equal((await call(dev, "update_campaign", { campaign_id: campaign.id, name: "x" })).isError, true, "live campaigns are frozen");

  // Only the segment sees the offer, and enrolling through it is attributed.
  assert.deepEqual((await call(insured, "list_offers")).data, []);
  const [offer] = (await call(saver, "list_offers")).data;
  assert.equal(offer.campaign_id, campaign.id);
  assert.ok(["Guaranteed peace of mind", "Cover your family"].includes(offer.headline));
  assert.equal((await call(insured, "enroll_in_product", { product_id: "term-life-insurance", campaign_id: campaign.id })).isError, true);
  const e = (await call(saver, "enroll_in_product", { product_id: "term-life-insurance", campaign_id: campaign.id })).data;
  assert.equal(e.campaign_id, campaign.id);
  assert.ok(["a", "b"].includes(e.variant));

  const m = (await call(dev, "get_campaign_metrics", { campaign_id: campaign.id })).data;
  assert.equal(m.enrollments, 1);
  assert.equal(m.by_variant.find((v) => v.variant === e.variant).enrollments, 1);

  // A market-linked campaign with no risk disclosure can't launch.
  const fundCampaign = (await call(dev, "create_campaign", {
    name: "Index",
    product_ids: ["index-fund"],
    channels: ["web"],
    variants: [{ key: "a", headline: "Beat inflation", body: "Low-cost index investing", cta: "Invest" }],
  })).data;
  const refused = await call(dev, "launch_campaign", { campaign_id: fundCampaign.id });
  assert.equal(refused.isError, true);
  assert.ok(refused.data.checks.some((c) => c.name === "risk_disclosure" && c.status === "fail"));

  // Other developers can't see or touch it.
  const otherDev = await connect(await as("Other", ["developer"]));
  assert.equal((await call(otherDev, "get_campaign_metrics", { campaign_id: campaign.id })).isError, true);
  assert.equal((await call(dev, "pause_campaign", { campaign_id: campaign.id })).data.status, "paused");
  assert.deepEqual((await call(saver, "list_offers")).data, []);
});
