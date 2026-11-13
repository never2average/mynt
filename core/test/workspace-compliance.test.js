import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { loadFixture, runSponsoredProduct } from "../scripts/sponsored-product.mjs";
import { CATALOG } from "./helpers.js";

// A real sponsored US product, built the way an admin builds one (scripts/sponsored-product.mjs with the placeholder
// fixture and the US model): a licence provider sponsors its money-transmission component in us-ny and us-ca under
// its New York and California licences. Coverage is then whatever Mynt's own rules (regime.ts) say.
process.env.SPONSOR_LEGITIMACY_RULE = "off";
const MODEL = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));
const PRODUCT = "example-dollar-transfer";

async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const caller = (client) => async (name, args = {}) => {
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
  const adminClient = await connect(adminUser);
  const admin = caller(adminClient);
  const applied = await applyRegulatoryModel({ call: admin, listTools: async () => (await adminClient.listTools()).tools, model: MODEL });
  assert.equal(applied.applied, true);
  const fixture = loadFixture();
  const lpUser = await store.upsertClerkUser("clerk_lp", fixture.licence_provider.member_email, "Lena", ["license_provider"]);
  const { user: builderUser } = await store.createUser("Neo", ["developer"]);
  const sessions = { admin, licence_provider: caller(await connect(lpUser)), builder: caller(await connect(builderUser)) };
  const run = await runSponsoredProduct({ call: (n, i, actor) => sessions[actor](n, i), staging: true });
  assert.equal(run.done, true, JSON.stringify(run));
  const dev = async (name) => {
    const { user } = await store.createUser(name, ["developer"]);
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, `${name.toLowerCase()}@example.com`]);
    return { user, call: caller(await connect({ ...user, email: `${name.toLowerCase()}@example.com` })) };
  };
  const ana = await dev("Ana");
  const eve = await dev("Eve");
  const ws = (await ana.call("create_workspace", { name: "Team" })).data;
  const app = (await ana.call("create_app", { name: "Dollar transfers", description: "Send dollars", audience: "US individuals", product_ids: [PRODUCT], workspace_id: ws.id })).data;
  const licence = async (id) => (await pg.query("SELECT id::text AS id, registration_number FROM financial_products.held_licenses WHERE entity_id = $1 AND license_id = $2", [run.provider_entity_id, id])).rows[0];
  return { pg, store, run, ana, eve, ws, app, dev, licence };
}

const byCode = (r) => Object.fromEntries(r.data.states.map((s) => [s.code, s]));

test("coverage follows Mynt's rules: unlocked where the product's every component is covered by a licence in force, available where only others' are", async () => {
  const w = await world();
  const ny = await w.licence("nydfs_money_transmitter");
  await w.pg.query(
    `INSERT INTO financial_products.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status)
     VALUES ($1, $2, 'ach', 'bank-co', 'deposit', '{us-ny}', 123456, 9999999, 'approved')`,
    [randomUUID(), w.run.provider_entity_id],
  );
  const r = await w.ana.call("get_compliance_coverage", { workspace_id: w.ws.id });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.states.length, 51);
  const s = byCode(r);
  assert.equal(s["us-ny"].status, "unlocked");
  assert.equal(s["us-ca"].status, "unlocked");
  assert.equal(s["us-tx"].status, "unavailable");
  assert.deepEqual(s["us-ny"].products, [{ id: PRODUCT, name: s["us-ny"].products[0].name }]);
  assert.ok(s["us-ny"].partners.some((p) => p.entity_id === w.run.provider_entity_id));
  assert.ok(s["us-ny"].licences.some((l) => l.id === ny.id && l.number === ny.registration_number));
  assert.ok(!s["us-ny"].licences.some((l) => l.type === "ca_dfpi_money_transmitter"), "only the licences that count in that state");
  assert.deepEqual(s["us-ny"].rails, [{ kind: "ach", direction: "deposit", provider: "bank-co", status: "approved" }]);
  assert.ok(!JSON.stringify(r.data).includes("123456"), "never a rail's limits");
  // Someone whose workspace uses no product: an empty workspace works, and sees the product's states as available.
  const empty = byCode(await w.eve.call("get_compliance_coverage", { workspace_id: (await w.eve.call("create_workspace", { name: "Empty" })).data.id }));
  assert.equal(empty["us-ny"].status, "available");
  assert.equal(empty["us-tx"].status, "unavailable");
  assert.deepEqual(empty["us-ny"].partners, [], "nothing of a product they don't use");
});

test("a licence suspended or expired, a state the sponsorship doesn't cover, or paused sales: not unlocked", async () => {
  const w = await world();
  const ny = await w.licence("nydfs_money_transmitter");
  const ca = await w.licence("ca_dfpi_money_transmitter");
  await w.pg.query("UPDATE financial_products.held_licenses SET status = 'suspended' WHERE id = $1", [ny.id]);
  await w.pg.query("UPDATE financial_products.held_licenses SET valid_to = '2020-01-01' WHERE id = $1", [ca.id]);
  let s = byCode(await w.ana.call("get_compliance_coverage", { workspace_id: w.ws.id }));
  assert.equal(s["us-ny"].status, "unavailable", "suspended");
  assert.equal(s["us-ca"].status, "unavailable", "expired");
  // Back in force, but the sponsorship covers New York only: California's component is uncovered.
  await w.pg.query("UPDATE financial_products.held_licenses SET status = 'verified', valid_to = NULL WHERE id = ANY($1)", [[ny.id, ca.id]]);
  await w.pg.query("UPDATE financial_products.sponsorships SET jurisdictions = '{us-ny}' WHERE product_id = $1 AND status = 'approved'", [PRODUCT]);
  s = byCode(await w.ana.call("get_compliance_coverage", { workspace_id: w.ws.id }));
  assert.equal(s["us-ny"].status, "unlocked");
  assert.equal(s["us-ca"].status, "unavailable");
  // Sales paused (a covenant breach or anything else that drifted it): nowhere.
  await w.store.setDrift(PRODUCT, { detected_at: new Date().toISOString(), changes: [], note: "covenant breach" });
  s = byCode(await w.ana.call("get_compliance_coverage", { workspace_id: w.ws.id }));
  assert.equal(s["us-ny"].status, "unavailable");
});

test("licences: the ones covering the workspace's products, where they cover them; filters; the dashboard counts the same", async () => {
  const w = await world();
  const all = (await w.ana.call("list_workspace_licences", { workspace_id: w.ws.id })).data.licences;
  const states = Object.fromEntries(all.map((l) => [l.type, l.states]));
  assert.deepEqual(states.nydfs_money_transmitter, ["us-ny"]);
  assert.deepEqual(states.ca_dfpi_money_transmitter, ["us-ca"]);
  assert.deepEqual((await w.ana.call("list_workspace_licences", { workspace_id: w.ws.id, state: "us-ca" })).data.licences.map((l) => l.type).includes("nydfs_money_transmitter"), false);
  assert.deepEqual((await w.ana.call("list_workspace_licences", { workspace_id: w.ws.id, status: "suspended" })).data.licences, []);
  const d = (await w.ana.call("get_developer_dashboard", { workspace_id: w.ws.id })).data;
  assert.equal(d.active_products, 1);
  assert.equal(d.licences, all.length);
  for (const [tool, args] of [
    ["get_compliance_coverage", { workspace_id: w.ws.id }],
    ["list_workspace_licences", { workspace_id: w.ws.id }],
    ["list_workspace_audit", { workspace_id: w.ws.id }],
  ])
    assert.match((await w.eve.call(tool, args)).data.error, /No workspace of yours/, tool);
});

test("audit: by what events are about (keys and webhooks by their app, repository approvals), full-precision paging, redaction, and invitees' addresses for owners and admins only", async () => {
  const w = await world();
  const { pg, ana, ws, app } = w;
  const mem = await w.dev("Mem");
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, mem.user.id]);
  // Real tool events: a key (its target is the key, its details name the app) and an invite.
  const key = (await ana.call("create_api_key", { app_id: app.id, environment: "sandbox", label: "k" })).data;
  await ana.call("invite_to_workspace", { workspace_id: ws.id, email: "newbie@example.com" });
  // A decision on a member's connection to the app's repository.
  await pg.exec("CREATE TABLE IF NOT EXISTS financial_products.app_repositories (app_id uuid PRIMARY KEY, repository text, managed boolean, managed_repository text)");
  await pg.query("INSERT INTO financial_products.app_repositories (app_id, repository, managed) VALUES ($1, 'acme/web', false)", [app.id]);
  const ev = (action, target, details, at) =>
    pg.query("INSERT INTO financial_products.audit_log (id, actor_id, action, target, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [randomUUID(), ana.user.id, action, target, JSON.stringify(details), at]);
  await ev("approve_repository_connection", randomUUID(), { kind: "developer", repository: "acme/web", user_id: mem.user.id }, "2026-01-01T00:00:00Z");
  await ev("approve_repository_connection", randomUUID(), { kind: "developer", repository: "other/repo", user_id: mem.user.id }, "2026-01-01T00:00:01Z");
  // Six events in the same microsecond, paged two at a time: all six come back.
  const same = "2026-01-02T00:00:00.123456Z";
  for (let i = 0; i < 6; i++) await ev("deploy_app", app.id, { n: i, authorization: "Bearer abc", api_key: "mynt_live_x", note: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, same);
  const seen = [];
  let cursor;
  do {
    const p = (await ana.call("list_workspace_audit", { workspace_id: ws.id, action: "deploy_app", limit: 2, ...(cursor ? { cursor } : {}) })).data;
    seen.push(...p.events);
    cursor = p.next_cursor;
  } while (cursor);
  assert.deepEqual(seen.map((e) => e.details.n).sort(), [0, 1, 2, 3, 4, 5]);
  const text = JSON.stringify(seen);
  assert.ok(!text.includes("Bearer abc") && !text.includes("mynt_live_x") && !text.includes("ghp_abcdef"), "redacted");

  const all = (await ana.call("list_workspace_audit", { workspace_id: ws.id, limit: 100 })).data.events;
  const k = all.find((e) => e.action === "create_api_key");
  assert.equal(k.target.id, key.id);
  assert.equal(k.target.type, "key");
  assert.equal(k.target.name, "Dollar transfers");
  assert.deepEqual(all.filter((e) => e.action === "approve_repository_connection").map((e) => e.details.repository), ["acme/web"], "its apps' repositories only");
  assert.ok((await ana.call("list_workspace_audit", { workspace_id: ws.id, app_id: app.id })).data.events.some((e) => e.action === "create_api_key"));
  // Whom an invite went to: owners and admins only.
  const invOwner = all.find((e) => e.action === "invite_to_workspace");
  assert.equal(invOwner.details.email, "newbie@example.com");
  const invMember = (await mem.call("list_workspace_audit", { workspace_id: ws.id, action: "invite_to_workspace" })).data.events[0];
  assert.equal(invMember.details.email, undefined);
  assert.equal(invMember.details.invite_id, undefined);
  // Dates are real calendar dates, and bad input never reaches the database.
  assert.equal((await ana.call("list_workspace_audit", { workspace_id: ws.id, from: "2026-02-30" })).isError, true);
  assert.match((await ana.call("list_workspace_audit", { workspace_id: ws.id, cursor: "nope" })).data.error, /cursor/);
});
