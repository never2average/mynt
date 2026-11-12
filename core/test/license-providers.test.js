import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { normalizeName } from "../dist/firm-checks.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { CATALOG } from "./helpers.js";

// Builders needn't be licensed: a licence provider (a firm an admin adds by hand) holds the licences and
// sponsors a builder's product component under them, in the jurisdictions it approves. Innovator and developer
// are one builder role. On the US model as data and the money transmission template, now owned by the builder
// and sponsored by the money-transmitter partner.

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const MODEL = read("../schemas/regulatory/us.json");
const BASE = read("../schemas/examples/us/money-transmission.v2.json");

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "license-providers", version: "0" });
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
  const adminClient = await connect(adminUser);
  const admin = (n, a) => call(adminClient, n, a);
  const applied = await applyRegulatoryModel({ call: admin, listTools: async () => (await adminClient.listTools()).tools, model: MODEL });
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));

  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    const client = await connect(user);
    return { user, client, call: (n, a) => call(client, n, a), tools: async () => (await client.listTools()).tools.map((t) => t.name) };
  };
  // A licence provider: its firm added by hand by an admin, its person a member of it.
  const provider = async (name) => {
    const firm = ok(await admin("register_firm", { name: `${name} Inc`, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-ny" } }));
    const p = await as(`${name} person`, ["license_provider"]);
    await store.setUserEntity(p.user.id, firm.id);
    p.user.entity_id = firm.id;
    p.entity = firm;
    // A licence provider sponsors only once Mynt's public checks show it's a real company (firm-checks.ts, tested
    // in firm-checks.test.js): here, a matching FinCEN MSB answer for its name, as run_firm_checks would record.
    await store.recordFirmCheck({
      entity_id: firm.id,
      source: "fincen_msb",
      subject: normalizeName(firm.name),
      url: "https://msb.fincen.gov/",
      status: "match",
      fields: { legal_name: firm.name },
      response_hash: null,
      note: null,
      run_by: null,
    });
    // Registers a licence (the provider's own tool) and an admin verifies it.
    p.hold = async (regulator_id, license_id) => {
      const held = ok(await p.call("register_license", { region: "US", regulator_id, license_id, registration_number: `${license_id}-test` }));
      ok(await admin("review_license", { license_record_id: held.id, decision: "verified", note: "checked on the register" }));
      return held;
    };
    // Fills the stakeholders a held licence mandates on the provider's roster.
    p.staff = async (held) => {
      const lt = MODEL.regulators.find((r) => r.id === held.regulator_id).license_types.find((l) => l._id === held.license_id);
      for (const s of lt.grc.mandatory_stakeholders.internal) ok(await p.call("add_party", { kind: "internal", person: { name: s.name }, fills: [{ licence_id: held.id, stakeholder: s.id }] }));
    };
    return p;
  };
  // A builder (either name) with a firm that holds no licence.
  const builder = async (name, role = "developer") => {
    const b = await as(name, [role]);
    b.entity = ok(await b.call("create_entity", { name: `${name} Inc`, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-ca" } }));
    return b;
  };
  return { store, admin, as, provider, builder };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};

const catalogue = (id) => ({
  id,
  name: BASE.product_name,
  product_line: "payments",
  category: "money_transmission",
  region: "US",
  risk_level: "not_applicable",
  liquidity: "high",
  typical_horizon: "short",
  return_type: "fixed_interest",
  regulator: "FinCEN",
  description: BASE.descriptions.summary,
  key_features: BASE.descriptions.key_features.slice(0, 3),
});

// The money transmission template, owned by the builder, its transmission provided by `to`: the sponsoring
// licence provider ({ kind: "sponsor", id }) or the owner itself.
const definition = (b, id, to, offered_in = ["us-ny", "us-ca"]) => {
  const d = structuredClone(BASE);
  d._id = id;
  d.owner_entity_id = b.entity.id;
  d.offered_in = offered_in;
  d.connections.push(
    { _id: "p_transmission", type: "component_provided_by", from: { kind: "component", id: "transmission" }, to, attributes: { business_role: "issuer" } },
    { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "transmission" } },
  );
  return d;
};

test("innovator and developer are one builder role; licence providers and vendors stand beside it", async () => {
  const ctx = await setup();
  const dev = await ctx.as("Dev", ["developer"]);
  const inno = await ctx.as("Ivy", ["innovator"]);
  const lp = await ctx.as("Lena", ["license_provider"]);
  const consumer = await ctx.as("Cam", ["consumer"]);
  for (const b of [dev, inno]) assert.deepEqual(ok(await b.call("whoami")).effective_roles, ["consumer", "developer", "innovator"]);
  const [devTools, innoTools, lpTools, consumerTools, adminTools] = await Promise.all([dev.tools(), inno.tools(), lp.tools(), consumer.tools(), (await ctx.as("Al", ["admin"])).tools()]);
  // The same tools under either name: products and apps alike.
  assert.deepEqual(devTools, innoTools);
  for (const t of ["create_product", "set_product_definition", "publish_product", "create_app", "create_api_key", "request_sponsorship", "list_my_sponsorships"]) assert.ok(devTools.includes(t), t);
  // Licence providers get their firm, its roster and licences, and the sponsorship tools; nothing a builder or consumer gets.
  for (const t of ["get_my_entity", "register_license", "add_party", "list_my_licenses", "list_sponsorship_requests", "approve_sponsorship", "decline_sponsorship", "revoke_sponsorship", "list_sponsored_products"])
    assert.ok(lpTools.includes(t), t);
  for (const t of ["create_product", "create_app", "enroll_in_product", "request_sponsorship", "create_entity"]) assert.ok(!lpTools.includes(t), t);
  for (const t of ["approve_sponsorship", "list_sponsorship_requests"]) assert.ok(!devTools.includes(t), t);
  for (const t of ["request_sponsorship", "approve_sponsorship"]) assert.ok(!consumerTools.includes(t), t);
  for (const t of ["request_sponsorship", "approve_sponsorship", "create_vendor_offering"]) assert.ok(adminTools.includes(t), t);

  // A developer composes and publishes a product; an innovator builds an app.
  const app = ok(await inno.call("create_app", { name: "Ivy's app", description: "Dollars", audience: "Everyone", product_ids: ["ppf"] }));
  assert.equal(app.owner_id, inno.user.id);
  ok(await dev.call("create_product", catalogue("dev-product")));
});

test("a sponsored product is covered only where the licence provider approved it, and drifts when it's revoked or the licence lapses", async () => {
  const ctx = await setup();
  const partner = await ctx.provider("Ramp Partner");
  const msb = await partner.hold("fincen", "fincen_msb");
  const ny = await partner.hold("nydfs", "nydfs_money_transmitter");
  const ca = await partner.hold("ca_dfpi", "ca_dfpi_money_transmitter");
  const licences = ok(await partner.call("list_my_licenses"));
  assert.deepEqual(licences.licences.map((l) => [l.license_id, l.in_force, l.covers]), [["fincen_msb", true, []], ["nydfs_money_transmitter", true, ["us-ny"]], ["ca_dfpi_money_transmitter", true, ["us-ca"]]]);

  // A builder with no licence of its own, providing transmission itself: blocked everywhere.
  const neo = await ctx.builder("Neo");
  ok(await neo.call("create_product", catalogue("money-transmission")));
  const own = ok(await neo.call("check_product_definition", { product_id: "money-transmission", definition: definition(neo, "money-transmission", { kind: "owner" }) }));
  assert.equal(own.valid, true, JSON.stringify(own.errors));
  assert.deepEqual(own.publish_blockers.map((b) => b.jurisdiction), ["us-ny", "us-ca"]);
  for (const b of own.publish_blockers) assert.match(b.reason, /Your entity holds no verified licence granting this/);

  // Naming the licence provider: still blocked until it approves.
  const sponsor = { kind: "sponsor", id: partner.entity.id };
  ok(await neo.call("set_product_definition", { product_id: "money-transmission", definition: definition(neo, "money-transmission", sponsor) }));
  const waiting = ok(await neo.call("check_product_definition", { product_id: "money-transmission", definition: definition(neo, "money-transmission", sponsor) }));
  assert.deepEqual(waiting.publish_blockers.map((b) => b.jurisdiction), ["us-ny", "us-ca"]);
  for (const b of waiting.publish_blockers) assert.match(b.reason, /Ramp Partner Inc \(licence provider\) hasn't approved a sponsorship of 'transmission'/);
  assert.equal((await neo.call("publish_product", { id: "money-transmission" })).isError, true);

  // The request, as each side sees it.
  const requested = ok(await neo.call("request_sponsorship", { product_id: "money-transmission", component_key: "transmission", provider_entity_id: partner.entity.id, note: "New York and California" }));
  assert.equal(requested.status, "pending");
  assert.deepEqual(requested.requested_jurisdictions, ["us-ny", "us-ca"]);
  assert.match((await neo.call("request_sponsorship", { product_id: "money-transmission", component_key: "transmission", provider_entity_id: partner.entity.id })).data.error, /already a pending request/);
  const [inbox] = ok(await partner.call("list_sponsorship_requests"));
  assert.equal(inbox.id, requested.id);
  assert.equal(inbox.builder.name, "Neo Inc");
  assert.deepEqual(inbox.component, { key: "transmission", country: "us", primitive: "payments", action: "sale", offered_in: ["us-ny", "us-ca"] });
  // The FinCEN registration grants it too, though it covers no state by itself.
  assert.deepEqual(inbox.your_licences_granting_it.map((l) => l.license_id).sort(), ["ca_dfpi_money_transmitter", "fincen_msb", "nydfs_money_transmitter"]);

  // Approval names licences that cover what's asked: not a registration that covers nowhere, not a state not asked for.
  const refused = await partner.call("approve_sponsorship", { sponsorship_id: requested.id, licence_ids: [msb.id] });
  assert.equal(refused.isError, true);
  assert.match(refused.data.errors.join("\n"), /fincen_msb\) covers nowhere by itself/);
  const texas = await partner.call("approve_sponsorship", { sponsorship_id: requested.id, licence_ids: [ny.id], jurisdictions: ["us-tx"] });
  assert.match(texas.data.errors.join("\n"), /'us-tx' wasn't asked for/);
  // Another licence provider can't decide it.
  const rival = await ctx.provider("Rival");
  assert.match((await rival.call("approve_sponsorship", { sponsorship_id: requested.id, licence_ids: [ny.id] })).data.error, /No sponsorship request/);

  // Approved under the New York licence only: New York is covered by it, California isn't.
  const approved = ok(await partner.call("approve_sponsorship", { sponsorship_id: requested.id, licence_ids: [ny.id] }));
  assert.equal(approved.status, "approved");
  assert.deepEqual(approved.jurisdictions, ["us-ny"]);
  // The licences' mandated stakeholders are the licensee's: until its roster fills them, they block.
  const unstaffed = ok(await neo.call("check_product_definition", { product_id: "money-transmission", definition: definition(neo, "money-transmission", sponsor) }));
  assert.match(unstaffed.publish_blockers.find((b) => b.jurisdiction === "us-ny").reason, /no internal party fills/);
  await partner.staff(msb);
  await partner.staff(ny);
  await partner.staff(ca);
  const nyOnly = ok(await neo.call("check_product_definition", { product_id: "money-transmission", definition: definition(neo, "money-transmission", sponsor) }));
  assert.deepEqual(nyOnly.publish_blockers.map((b) => b.jurisdiction), ["us-ca"]);
  assert.match(nyOnly.publish_blockers[0].reason, /Ramp Partner Inc \(sponsor\) doesn't sponsor this in us-ca: its approved sponsorship covers us-ny/);

  // Asking again for California, approved under the California licence: covered in both, and it publishes.
  const more = ok(await neo.call("request_sponsorship", { product_id: "money-transmission", component_key: "transmission", provider_entity_id: partner.entity.id, jurisdictions: ["us-ca"] }));
  const caSponsorship = ok(await partner.call("approve_sponsorship", { sponsorship_id: more.id, licence_ids: [ca.id] }));
  assert.deepEqual(caSponsorship.jurisdictions, ["us-ca"]);
  ok(await neo.call("set_product_definition", { product_id: "money-transmission", definition: definition(neo, "money-transmission", sponsor) }));
  const report = ok(await neo.call("test_product", { id: "money-transmission" }));
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => c.status === "fail")));
  ok(await neo.call("publish_product", { id: "money-transmission" }));
  const row = ok(await neo.call("get_product_regime", { product_id: "money-transmission" })).regions[0].components[0];
  assert.equal(row.provider_entity_id, partner.entity.id);
  assert.deepEqual(
    row.jurisdictions.map((j) => [j.jurisdiction, j.coverage.by[0].license_id, j.coverage.by[0].sponsorship_id, j.coverage.by[0].requires]),
    [
      ["us-ny", "nydfs_money_transmitter", requested.id, [msb.id]],
      ["us-ca", "ca_dfpi_money_transmitter", more.id, [msb.id]],
    ],
  );
  // The stored summary says who covers it, and that it's sponsored.
  const summary = (await ctx.store.productDerived("money-transmission")).regime_summary.regions[0].components[0];
  assert.equal(summary.provided_by, "sponsor");
  assert.equal(summary.sponsor, "Ramp Partner Inc");
  assert.match(summary.jurisdictions[0].coverage.note, /^Covered by Ramp Partner Inc's .+ \(sponsored\)$/);
  const pins = (await ctx.store.getProduct("money-transmission")).pins;
  assert.deepEqual(pins.sponsorship_jurisdictions, { [requested.id]: ["us-ny"], [more.id]: ["us-ca"] });
  assert.ok(pins.entity_ids.includes(partner.entity.id));
  const sponsoredList = ok(await partner.call("list_sponsored_products"));
  assert.deepEqual(sponsoredList.map((s) => [s.product.id, s.jurisdictions]), [["money-transmission", ["us-ny"]], ["money-transmission", ["us-ca"]]]);
  assert.deepEqual(ok(await neo.call("list_my_sponsorships", { product_id: "money-transmission" })).map((s) => s.status), ["approved", "approved"]);

  // The provider's New York licence lapsing drifts the product, naming New York; re-verifying clears it.
  const lapsed = ok(await ctx.admin("review_license", { license_record_id: ny.id, decision: "suspended", note: "regulator order" }));
  assert.deepEqual(lapsed.drifted_products, ["money-transmission"]);
  assert.deepEqual((await ctx.store.getProduct("money-transmission")).drift.changes.map((c) => [c.kind, c.id, c.jurisdictions]), [["licence", ny.id, ["us-ny"]]]);
  ok(await ctx.admin("review_license", { license_record_id: ny.id, decision: "verified", note: "order lifted" }));
  assert.equal((await ctx.store.getProduct("money-transmission")).drift, null);

  // Revoking the California sponsorship drifts it, naming California, and the next version can't publish there.
  const revoked = ok(await partner.call("revoke_sponsorship", { sponsorship_id: more.id, reason: "agreement ended in California" }));
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.drifted_products, ["money-transmission"]);
  assert.deepEqual((await ctx.store.getProduct("money-transmission")).drift.changes.map((c) => [c.kind, c.id, c.jurisdictions]), [["sponsorship", more.id, ["us-ca"]]]);
  const after = ok(await neo.call("check_product_definition", { product_id: "money-transmission", definition: definition(neo, "money-transmission", sponsor) }));
  assert.deepEqual(after.publish_blockers.map((b) => b.jurisdiction), ["us-ca"]);
});

test("a declined request leaves the product blocked; requests go only to licence providers", async () => {
  const ctx = await setup();
  const partner = await ctx.provider("Careful Partner");
  await partner.hold("fincen", "fincen_msb");
  await partner.hold("nydfs", "nydfs_money_transmitter");
  const ivy = await ctx.builder("Ivy", "innovator");
  ok(await ivy.call("create_product", catalogue("mt-ivy")));
  const sponsor = { kind: "sponsor", id: partner.entity.id };
  ok(await ivy.call("set_product_definition", { product_id: "mt-ivy", definition: definition(ivy, "mt-ivy", sponsor, ["us-ny"]) }));

  // Only a licence provider's firm can be asked, and only for a component it's named the provider of.
  const other = await ctx.builder("Other");
  assert.match((await ivy.call("request_sponsorship", { product_id: "mt-ivy", component_key: "transmission", provider_entity_id: other.entity.id })).data.error, /isn't provided by that licence provider/);
  assert.match((await other.call("request_sponsorship", { product_id: "mt-ivy", component_key: "transmission", provider_entity_id: partner.entity.id })).data.error, /No product of your firm/);

  const r = ok(await ivy.call("request_sponsorship", { product_id: "mt-ivy", component_key: "transmission", provider_entity_id: partner.entity.id }));
  const declined = ok(await partner.call("decline_sponsorship", { sponsorship_id: r.id, reason: "outside our risk appetite" }));
  assert.equal(declined.status, "declined");
  assert.equal((await partner.call("revoke_sponsorship", { sponsorship_id: r.id, reason: "again" })).isError, true);
  assert.deepEqual(ok(await ivy.call("list_my_sponsorships")).map((s) => [s.status, s.decision_note]), [["declined", "outside our risk appetite"]]);
  const blocked = ok(await ivy.call("check_product_definition", { product_id: "mt-ivy", definition: definition(ivy, "mt-ivy", sponsor, ["us-ny"]) }));
  assert.match(blocked.publish_blockers[0].reason, /hasn't approved a sponsorship/);

  // A firm whose people aren't licence providers can't be asked.
  ok(await ivy.call("set_product_definition", { product_id: "mt-ivy", definition: definition(ivy, "mt-ivy", { kind: "sponsor", id: other.entity.id }, ["us-ny"]) }));
  assert.match((await ivy.call("request_sponsorship", { product_id: "mt-ivy", component_key: "transmission", provider_entity_id: other.entity.id })).data.error, /isn't a licence provider/);
  // Nor can a firm sponsor its own product.
  const self = await ivy.call("check_product_definition", { product_id: "mt-ivy", definition: definition(ivy, "mt-ivy", { kind: "sponsor", id: ivy.entity.id }, ["us-ny"]) });
  assert.match(JSON.stringify(self.data), /the owner can't sponsor its own product/);
});

test("test_product doesn't warn an unlicensed builder about a licence once an approved sponsorship covers the composition", async () => {
  const ctx = await setup();
  const partner = await ctx.provider("Covering Partner");
  const msb = await partner.hold("fincen", "fincen_msb");
  const ny = await partner.hold("nydfs", "nydfs_money_transmitter");
  await partner.staff(msb);
  const neo = await ctx.builder("Neo");
  ok(await neo.call("create_product", catalogue("mt-covered")));
  const licenceCheck = async () => ok(await neo.call("test_product", { id: "mt-covered" })).checks.find((c) => c.name === "licence_held");

  // Provided by the builder itself, unlicensed: still warned, as before.
  ok(await neo.call("set_product_definition", { product_id: "mt-covered", definition: definition(neo, "mt-covered", { kind: "owner" }, ["us-ny"]) }));
  const own = await licenceCheck();
  assert.equal(own.status, "warn");
  assert.match(own.message, /holds no verified licence/);

  // Sponsored, not yet approved: the builder needn't hold a licence, but the composition isn't covered yet.
  const sponsor = { kind: "sponsor", id: partner.entity.id };
  ok(await neo.call("set_product_definition", { product_id: "mt-covered", definition: definition(neo, "mt-covered", sponsor, ["us-ny"]) }));
  const r = ok(await neo.call("request_sponsorship", { product_id: "mt-covered", component_key: "transmission", provider_entity_id: partner.entity.id }));
  const pending = await licenceCheck();
  assert.equal(pending.status, "warn");
  assert.doesNotMatch(pending.message, /holds no verified licence|register_license/);
  assert.match(pending.message, /needn't hold a licence.*composition_coverage/);

  // Approved: the sponsorship covers it, so there's nothing to warn about.
  ok(await partner.call("approve_sponsorship", { sponsorship_id: r.id, licence_ids: [ny.id] }));
  const covered = await licenceCheck();
  assert.equal(covered.status, "pass");
  assert.equal(covered.message, "Your firm needn't hold a licence: it provides no component itself; Covering Partner Inc sponsors 'transmission' in us-ny");
  const report = ok(await neo.call("test_product", { id: "mt-covered" }));
  assert.equal(report.passed, true);
  assert.deepEqual(report.checks.filter((c) => c.status === "warn").map((c) => c.name), ["launch_procedure"]);
});
