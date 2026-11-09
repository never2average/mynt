import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { fixtureProblems, loadFixture, runSponsoredProduct } from "../scripts/sponsored-product.mjs";
import { CATALOG } from "./helpers.js";

// The whole path from an unlicensed builder to a developer-ready US product, sponsored by a licence provider,
// without the real partner: the placeholder fixture (schemas/examples/us/sponsored-product.placeholder.json)
// run through scripts/sponsored-product.mjs, the same function an admin runs against a server, on an
// in-process server with the US model as data (schemas/regulatory/us.json).

// The placeholder licence provider isn't a real company, so no public register can show it is one: staging runs
// it with the legitimacy gate off, as here (see docs/reference.md, "Is the licence provider a real company?").
process.env.SPONSOR_LEGITIMACY_RULE = "off";

const MODEL = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));
const FIXTURE = loadFixture();

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "sponsored-product", version: "0" });
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
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));
  // The licence provider's person has signed in (so an admin can add them to its firm by email); the builder holds no licence.
  const lpUser = await store.upsertClerkUser("clerk_lp", FIXTURE.licence_provider.member_email, "Lena", ["license_provider"]);
  const { user: builderUser } = await store.createUser("Neo", ["developer"]);
  const sessions = { admin, licence_provider: caller(await connect(lpUser)), builder: caller(await connect(builderUser)) };
  const call = (name, input, actor) => sessions[actor](name, input);
  const developer = caller(await connect((await store.createUser("Dev", ["developer"])).user));
  return { store, admin, sessions, call, developer, connect, caller };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};

test("the placeholder fixture is usable, clearly fake, and refused unless it's staging", async () => {
  assert.deepEqual(fixtureProblems(FIXTURE), []);
  assert.equal(FIXTURE.placeholder, true);
  assert.equal(FIXTURE.licence_provider.name, "Example Money Transmitter (placeholder)");
  assert.match(FIXTURE.placeholder_note, /staging and tests only/i);
  for (const l of FIXTURE.licence_provider.licences) assert.match(l.registration_number, /^PLACEHOLDER-/);
  // Every licence and stakeholder it names is in the US model.
  for (const l of FIXTURE.licence_provider.licences) {
    const lt = MODEL.regulators.find((r) => r.id === l.regulator_id)?.license_types.find((t) => t._id === l.license_id);
    assert.ok(lt, `${l.regulator_id}/${l.license_id}`);
    for (const s of lt.grc.mandatory_stakeholders.internal)
      assert.ok(FIXTURE.licence_provider.roster.some((r) => r.fills.some((f) => f.licence === l.key && f.stakeholder === s.id)), `${l.license_id} mandates ${s.id}`);
  }
  await assert.rejects(runSponsoredProduct({ call: async () => assert.fail("nothing is called") }), /placeholder .*staging and tests only/i);
});

test("an unlicensed builder's sponsored US product becomes developer-ready, end to end; a rerun changes nothing", async () => {
  const ctx = await setup();
  const lines = [];
  const say = (s) => lines.push(s);

  // A dry run reads only: on an empty server it stops at the firm it would register.
  const dry = await runSponsoredProduct({ call: ctx.call, staging: true, dryRun: true, say });
  assert.equal(dry.done, false);
  assert.deepEqual(dry.plan, ["admin: register_firm (register the licence provider's firm 'Example Money Transmitter (placeholder)')"]);
  assert.ok(!ok(await ctx.admin("list_entities")).some((e) => e.name === FIXTURE.licence_provider.name));

  const run = await runSponsoredProduct({ call: ctx.call, staging: true, say });
  assert.equal(run.done, true, JSON.stringify(run));
  assert.equal(run.developer_ready, true);
  assert.deepEqual(run.sponsorships.map((s) => [s.jurisdictions, s.licences.sort()]), [[["us-ny", "us-ca"], ["ca_dfpi_money_transmitter", "nydfs_money_transmitter"]]]);
  // The builder's firm holds no licence; test_product no longer warns it should (the sponsorship covers it).
  const firms = ok(await ctx.admin("list_entities"));
  const builderFirm = firms.find((e) => e.id === run.builder_entity_id);
  assert.deepEqual(builderFirm.licenses, []);
  const providerFirm = firms.find((e) => e.id === run.provider_entity_id);
  assert.equal(providerFirm.name, "Example Money Transmitter (placeholder)");
  assert.deepEqual(providerFirm.licenses.map((l) => [l.license_id, l.status]), [["fincen_msb", "verified"], ["nydfs_money_transmitter", "verified"], ["ca_dfpi_money_transmitter", "verified"]]);
  assert.ok(!run.test_warnings.some((w) => w.startsWith("licence_held")), run.test_warnings.join("\n"));

  // Developers see it among the products they can build on, sponsored in both states, and can build an app on it.
  const ready = ok(await ctx.developer("list_products", { developer_ready: true, limit: 100 }));
  assert.deepEqual(ready.products.map((p) => p.id), ["example-dollar-transfer"]);
  assert.equal(ready.products[0].regulator, "FinCEN");
  const contract = ok(await ctx.developer("get_developer_contract", { product_id: "example-dollar-transfer" }));
  assert.ok(contract.offers.length >= 1);
  const regime = ok(await ctx.sessions.builder("get_product_regime", { product_id: "example-dollar-transfer" })).regions[0].components[0];
  assert.deepEqual(regime.jurisdictions.map((j) => [j.jurisdiction, j.coverage.status, j.coverage.by[0].license_id]), [["us-ny", "covered", "nydfs_money_transmitter"], ["us-ca", "covered", "ca_dfpi_money_transmitter"]]);
  const app = ok(await ctx.developer("create_app", { name: "Dollar transfers", description: "Send dollars to your bank", audience: "US individuals", product_ids: ["example-dollar-transfer"] }));
  assert.deepEqual(app.product_ids, ["example-dollar-transfer"]);

  // Running it again finds everything in place: nothing registered twice, nothing republished.
  const version = (await ctx.store.getProduct("example-dollar-transfer")).version;
  const again = await runSponsoredProduct({ call: ctx.call, staging: true });
  assert.equal(again.done, true);
  assert.equal((await ctx.store.getProduct("example-dollar-transfer")).version, version);
  assert.equal(ok(await ctx.admin("list_entities")).filter((e) => e.name === FIXTURE.licence_provider.name).length, 1);
  assert.equal(ok(await ctx.sessions.licence_provider("list_my_licenses")).licences.length, 3);
  assert.equal(ok(await ctx.sessions.builder("list_my_sponsorships", { product_id: "example-dollar-transfer" })).length, 1);
});

test("when the real partner signs, an admin swaps in its firm and licences and reruns: a new version sponsored by it", async () => {
  const ctx = await setup();
  const first = await runSponsoredProduct({ call: ctx.call, staging: true });
  assert.equal(first.done, true, JSON.stringify(first));

  // The real partner's fixture: not a placeholder, its own firm (registered by hand) and licences.
  const real = structuredClone(FIXTURE);
  real.placeholder = false;
  delete real.placeholder_note;
  real.licence_provider = { ...real.licence_provider, name: "Partner Money Transmitter Inc", member_email: "compliance@partner.example" };
  real.licence_provider.licences = real.licence_provider.licences.map((l) => ({ ...l, registration_number: `TEST-${l.key.toUpperCase()}-1` }));
  real.licence_provider.roster = [{ person: { name: "Partner AML officer" }, fills: [{ licence: "msb", stakeholder: "fincen_aml_compliance_officer" }] }];
  const partnerUser = await ctx.store.upsertClerkUser("clerk_partner", "compliance@partner.example", "Pat", ["license_provider"]);
  const call = (name, input, actor) => (actor === "licence_provider" ? ctx.caller(partnerSession) : ctx.sessions[actor])(name, input);
  const partnerSession = await ctx.connect(partnerUser);

  // Not a placeholder: its licences wait for an admin's check against the regulators' registers.
  const waiting = await runSponsoredProduct({ call, fixture: real });
  assert.equal(waiting.done, false);
  assert.equal(waiting.stopped_at, "licence review");
  assert.equal(waiting.waiting_on, "admin");
  // The live product is untouched meanwhile.
  assert.equal((await ctx.store.getProduct("example-dollar-transfer")).version, 1);

  // Checked: rerun with verifyLicences. The product's next version is sponsored by the real partner.
  const swapped = await runSponsoredProduct({ call, fixture: real, verifyLicences: true });
  assert.equal(swapped.done, true, JSON.stringify(swapped));
  assert.notEqual(swapped.provider_entity_id, first.provider_entity_id);
  const record = await ctx.store.getProduct("example-dollar-transfer");
  assert.equal(record.version, 2);
  const row = ok(await ctx.sessions.builder("get_product_regime", { product_id: "example-dollar-transfer" })).regions[0].components[0];
  assert.equal(row.provider_entity_id, swapped.provider_entity_id);
  assert.equal(row.sponsor.name, "Partner Money Transmitter Inc");
  assert.ok(ok(await ctx.developer("list_products", { developer_ready: true })).products.some((p) => p.id === "example-dollar-transfer"));
  // The placeholder's leftover sponsorship is revoked; the live version doesn't rest on it, so nothing drifts.
  const [leftover] = first.sponsorships;
  const revoked = ok(await ctx.sessions.licence_provider("revoke_sponsorship", { sponsorship_id: leftover.id, reason: "Replaced by the real partner" }));
  assert.deepEqual(revoked.drifted_products, []);
  assert.equal((await ctx.store.getProduct("example-dollar-transfer")).drift, null);
  assert.ok(ok(await ctx.developer("list_products", { developer_ready: true })).products.some((p) => p.id === "example-dollar-transfer"));
});

test("without the licence provider's session, the builder's side runs and it stops at the partner's approval", async () => {
  const ctx = await setup();
  // The partner set up its own side (firm, licences, roster) in an earlier run.
  const setupRun = await runSponsoredProduct({ call: ctx.call, staging: true, actors: ["admin", "licence_provider"] });
  assert.equal(setupRun.stopped_at, "builder's product");
  const r = await runSponsoredProduct({ call: ctx.call, staging: true, actors: ["admin", "builder"] });
  assert.equal(r.done, false);
  assert.equal(r.stopped_at, "sponsorship approval");
  assert.equal(r.waiting_on, "licence_provider");
  assert.deepEqual(ok(await ctx.sessions.licence_provider("list_sponsorship_requests")).map((s) => [s.product.id, s.requested_jurisdictions]), [["example-dollar-transfer", ["us-ny", "us-ca"]]]);
  // The partner approves in its own session; the builder's rerun publishes.
  const done = await runSponsoredProduct({ call: ctx.call, staging: true });
  assert.equal(done.done, true, JSON.stringify(done));
});
