import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const connect = async (name) => {
    const { user } = await store.createUser(name, ["developer"]);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, {}).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return { user, client };
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
  const entity = async (name) => (await store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] })).id;
  const licence = async (entityId, { type = "money_transmitter", regulator = "us-ny-dfs", number = "MT-1", jurisdiction = null, status = "verified", valid_to = "2027-12-31" } = {}) => {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO financial_products.held_licenses (id, entity_id, region, regulator_id, license_id, registration_number, valid_to, status, jurisdiction)
       VALUES ($1, $2, 'US', $3, $4, $5, $6, $7, $8)`,
      [id, entityId, regulator, type, number, valid_to, status, jurisdiction],
    );
    return id;
  };
  const sponsor = async (productId, builder, provider, licenceIds, jurisdictions, status = "approved") =>
    pg.query(
      `INSERT INTO financial_products.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, licence_ids, jurisdictions, status)
       VALUES ($1, $2, 'c1', $3, $4, $5, $6, $7)`,
      [randomUUID(), productId, builder, provider, licenceIds, jurisdictions, status],
    );
  const rail = async (entityId, states, { kind = "ach", direction = "deposit", status = "approved" } = {}) =>
    pg.query(
      `INSERT INTO financial_products.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status)
       VALUES ($1, $2, $3, 'bank-co', $4, $5, 123456, 9999999, $6)`,
      [randomUUID(), entityId, kind, direction, states, status],
    );
  return { pg, store, connect, call, entity, licence, sponsor, rail };
}

const appOn = (name, products) => ({ name, description: `${name} app`, audience: "Savers", product_ids: products });

// Two published products: the workspace uses one; another workspace uses the other.
async function world() {
  const w = await setup();
  const ana = await w.connect("Ana");
  const eve = await w.connect("Eve");
  const products = CATALOG.map((p) => p.id);
  const [ours, theirs] = products;
  const ws = (await w.call(ana.client, "create_workspace", { name: "Team" })).data;
  const a = (await w.call(ana.client, "create_app", { ...appOn("Saver", [ours]), workspace_id: ws.id })).data;
  const e = (await w.call(eve.client, "create_app", appOn("Theirs", [theirs]))).data;
  const builder = await w.entity("Builder Inc");
  const partner = await w.entity("Partner Bank");
  const stranger = await w.entity("Stranger Trust");
  const nyLicence = await w.licence(partner, { number: "MT-NY-1", jurisdiction: "us-ny" });
  const caLicence = await w.licence(partner, { number: "MT-CA-9", jurisdiction: "us-ca", regulator: "us-ca-dfpi", valid_to: "2026-12-31" });
  const strangerLicence = await w.licence(stranger, { number: "SECRET-NO-1", jurisdiction: "us-tx", regulator: "us-tx-dob" });
  await w.sponsor(ours, builder, partner, [nyLicence, caLicence], ["us-ny", "us-ca"]);
  await w.sponsor(ours, builder, partner, [nyLicence], ["us-nj"], "pending"); // not approved: counts for nothing
  await w.sponsor(theirs, builder, stranger, [strangerLicence], ["us-tx"]);
  await w.rail(partner, ["us-ny"]);
  await w.rail(partner, ["us-ca"], { kind: "wire", status: "proposed" }); // not approved
  await w.rail(stranger, ["us-tx"]);
  return { ...w, ana, eve, ws, a, e, ours, theirs, partner, stranger, nyLicence, caLicence };
}

test("coverage: unlocked where the workspace's products are sponsored, available where only others' are, unavailable elsewhere; nothing of others shown", async () => {
  const w = await world();
  const r = await w.call(w.ana.client, "get_compliance_coverage", { workspace_id: w.ws.id });
  assert.equal(r.isError, false);
  const states = r.data.states;
  assert.equal(states.length, 51, "the 50 states and DC");
  assert.ok(states.some((s) => s.code === "us-dc" && s.name === "District of Columbia"));
  const by = Object.fromEntries(states.map((s) => [s.code, s]));
  assert.equal(by["us-ny"].status, "unlocked");
  assert.equal(by["us-ca"].status, "unlocked");
  assert.equal(by["us-tx"].status, "available", "another workspace's product is sponsored there");
  assert.equal(by["us-nj"].status, "unavailable", "a pending sponsorship counts for nothing");
  assert.equal(by["us-fl"].status, "unavailable");

  assert.deepEqual(by["us-ny"].partners, [{ entity_id: w.partner, name: "Partner Bank" }]);
  assert.deepEqual(by["us-ny"].licences.map((l) => l.number), ["MT-NY-1"], "only the licence that counts in that state");
  assert.deepEqual(by["us-ny"].products.map((p) => p.id), [w.ours]);
  assert.deepEqual(by["us-ny"].rails, [{ kind: "ach", direction: "deposit", provider: "bank-co", status: "approved" }]);
  assert.deepEqual(by["us-ca"].rails, [], "a proposed rail isn't approved");
  assert.deepEqual(by["us-tx"].partners, []);
  assert.deepEqual(by["us-tx"].licences, []);
  const text = JSON.stringify(r.data);
  for (const leak of ["Stranger Trust", "SECRET-NO-1", w.theirs, "123456", "9999999"]) assert.ok(!text.includes(leak), `never shows ${leak}`);

  // A whole-country sponsorship unlocks every state.
  await w.sponsor(w.ours, await w.entity("B2"), w.partner, [w.nyLicence], ["us"]);
  const all = (await w.call(w.ana.client, "get_compliance_coverage", { workspace_id: w.ws.id })).data.states;
  assert.ok(all.every((s) => s.status === "unlocked"));
});

test("licences: those behind the workspace's products' sponsorships, filtered by status, regulator and state", async () => {
  const w = await world();
  const all = (await w.call(w.ana.client, "list_workspace_licences", { workspace_id: w.ws.id })).data.licences;
  assert.deepEqual(
    all.map((l) => [l.partner.name, l.number, l.regulator, l.states, l.status, l.expires_at]).sort(),
    [
      ["Partner Bank", "MT-CA-9", "us-ca-dfpi", ["us-ca"], "verified", "2026-12-31"],
      ["Partner Bank", "MT-NY-1", "us-ny-dfs", ["us-ny"], "verified", "2027-12-31"],
    ],
  );
  assert.deepEqual((await w.call(w.ana.client, "list_workspace_licences", { workspace_id: w.ws.id, state: "us-ca" })).data.licences.map((l) => l.number), ["MT-CA-9"]);
  assert.deepEqual((await w.call(w.ana.client, "list_workspace_licences", { workspace_id: w.ws.id, regulator: "us-ny-dfs" })).data.licences.map((l) => l.number), ["MT-NY-1"]);
  assert.deepEqual((await w.call(w.ana.client, "list_workspace_licences", { workspace_id: w.ws.id, status: "suspended" })).data.licences, []);
  // The dashboard counts the same licences and the published products in use.
  const d = (await w.call(w.ana.client, "get_developer_dashboard", { workspace_id: w.ws.id })).data;
  assert.equal(d.active_products, 1);
  assert.equal(d.licences, 2);
});

test("members only: someone outside the workspace gets nothing from any of the three tools", async () => {
  const w = await world();
  for (const [tool, args] of [
    ["get_compliance_coverage", { workspace_id: w.ws.id }],
    ["list_workspace_licences", { workspace_id: w.ws.id }],
    ["list_workspace_audit", { workspace_id: w.ws.id }],
  ]) {
    const r = await w.call(w.eve.client, tool, args);
    assert.equal(r.isError, true, tool);
    assert.match(r.data.error, /No workspace of yours/, tool);
  }
});

test("audit: the workspace's own events, by what they're about, redacted, newest first and paged; never another workspace's", async () => {
  const w = await world();
  const { pg, store, ana, eve, ws, a, e } = w;
  const ev = (actor, action, target, details = {}, at) =>
    pg.query("INSERT INTO financial_products.audit_log (id, actor_id, action, target, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      randomUUID(),
      actor,
      action,
      target,
      JSON.stringify(details),
      at,
    ]);
  const buildId = randomUUID();
  await pg.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd) VALUES ($1, $2, $3, 'Add a calculator', 'queued', 5)", [buildId, ana.user.id, a.id]).catch(async () => {
    // No builds service in this harness: make its table the way the service would.
    await pg.exec("CREATE TABLE financial_products.build_runs (id uuid PRIMARY KEY, developer_id uuid, app_id uuid, goal text, status text, cap_usd numeric)");
    await pg.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd) VALUES ($1, $2, $3, 'Add a calculator', 'queued', 5)", [buildId, ana.user.id, a.id]);
  });
  await ev(ana.user.id, "start_build", buildId, { app_id: a.id }, "2026-11-01T10:00:00Z");
  await ev(ana.user.id, "create_api_key", a.id, { key: "mynt_live_abcdefghijklmnop", label: "prod", secret: "s3cr3t-value-here" }, "2026-11-01T11:00:00Z");
  await ev(ana.user.id, "deploy_app", a.id, { note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 deployed" }, "2026-11-01T12:00:00Z");
  await ev(eve.user.id, "deploy_app", e.id, { note: "eve's app" }, "2026-11-01T12:30:00Z"); // another workspace
  await ev(eve.user.id, "note", `mentions ${ws.id} and ${a.id} in text only`, {}, "2026-11-01T12:40:00Z"); // free text: never matched
  const page1 = (await w.call(ana.client, "list_workspace_audit", { workspace_id: ws.id, limit: 3 })).data;
  const all = [];
  all.push(...page1.events);
  let cursor = page1.next_cursor;
  while (cursor) {
    const p = (await w.call(ana.client, "list_workspace_audit", { workspace_id: ws.id, limit: 3, cursor })).data;
    all.push(...p.events);
    cursor = p.next_cursor;
  }
  const actions = all.map((x) => [x.action, x.target.type]);
  // create_workspace and create_app come from the tools themselves, just now: newest first.
  assert.deepEqual(actions, [
    ["create_app", "app"],
    ["create_workspace", "workspace"],
    ["deploy_app", "app"],
    ["create_api_key", "app"],
    ["start_build", "build"],
  ]);
  const text = JSON.stringify(all);
  assert.ok(!text.includes("eve's app") && !text.includes("mentions"), "nothing of another workspace, nothing matched by text");
  for (const secret of ["s3cr3t-value-here", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) assert.ok(!text.includes(secret), `redacts ${secret}`);
  const deploy = all.find((x) => x.action === "deploy_app");
  assert.equal(deploy.target.name, "Saver");
  assert.deepEqual(deploy.actor, { id: ana.user.id, name: "Ana" });
  assert.equal(all.find((x) => x.action === "start_build").target.name, "Add a calculator");

  // Filters.
  const byApp = (await w.call(ana.client, "list_workspace_audit", { workspace_id: ws.id, app_id: a.id })).data.events.map((x) => x.action);
  assert.deepEqual(byApp, ["create_app", "deploy_app", "create_api_key", "start_build"], "the app's own events and its builds'");
  assert.deepEqual((await w.call(ana.client, "list_workspace_audit", { workspace_id: ws.id, action: "deploy_app" })).data.events.length, 1);
  assert.deepEqual(
    (await w.call(ana.client, "list_workspace_audit", { workspace_id: ws.id, from: "2026-11-01T10:30:00Z", to: "2026-11-01T11:30:00Z" })).data.events.map((x) => x.action),
    ["create_api_key"],
  );
  assert.equal((await w.call(ana.client, "list_workspace_audit", { workspace_id: ws.id, user_id: eve.user.id })).data.events.length, 0);
  assert.match((await w.call(ana.client, "list_workspace_audit", { workspace_id: ws.id, cursor: "not-a-cursor" })).data.error, /cursor/);
  // A member who joins sees the workspace's history too; leaving ends it.
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, eve.user.id]);
  assert.ok((await w.call(eve.client, "list_workspace_audit", { workspace_id: ws.id })).data.events.length > 0);
  void store;
});
