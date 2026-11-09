import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { normalizeName, parseMsbList, setFirmCheckSourcesForTests, validLei } from "../dist/firm-checks.js";
import { dueFirmChecks, firmChecksTick } from "../dist/firm-check-tools.js";
import { applyRegulatoryModel, shippedServiceTypes } from "../scripts/regulatory-model.mjs";
import { CATALOG } from "./helpers.js";

// A licence provider shows it's a real company through public sources Mynt asks itself (GLEIF's LEI record,
// FinCEN's MSB registrant list), never its own say-so. Sponsoring needs a match and no mismatch; a later
// mismatch or lapse drifts what it sponsors. Here GLEIF and FinCEN are fakes on 127.0.0.1.

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const MODEL = read("../schemas/regulatory/us.json");
const BASE = read("../schemas/examples/us/money-transmission.v2.json");

// Valid ISO 17442 LEIs (checked below): one GLEIF knows as our partner, one it doesn't know.
const LEI = "5493001KJTIIGC8Y1R12";
const UNKNOWN_LEI = "529900T8BM49AURSDO55";

// ---- the fakes ----
const gleif = { records: {}, down: false, hits: 0 };
const fincen = { rows: [], down: false, hits: 0 };
const leiRecord = (lei, { name, jurisdiction = "US-DE", status = "ACTIVE", registration = "ISSUED", hq = "US-NY" }) => ({
  data: {
    type: "lei-records",
    id: lei,
    attributes: {
      lei,
      entity: {
        legalName: { name, language: "en" },
        legalAddress: { addressLines: ["251 Little Falls Drive"], city: "Wilmington", region: "US-DE", country: "US", postalCode: "19808" },
        headquartersAddress: { addressLines: ["1 Main St"], city: "New York", region: hq, country: "US", postalCode: "10001" },
        registeredAt: { id: "RA000602", other: null },
        registeredAs: "1234567",
        jurisdiction,
        legalForm: { id: "XTIQ", other: null },
        status,
      },
      registration: { status: registration, nextRenewalDate: "2027-01-01T00:00:00Z", corroborationLevel: "FULLY_CORROBORATED" },
    },
  },
});
const HEADER = "LEGAL NAME\tDBA NAME\tSTREET ADDRESS\tCITY\tSTATE\tZIP\tMSB ACTIVITIES\tSTATES OF MSB ACTIVITIES\tALL STATES & TERRITORIES & FOREIGN FLAG**\tFOREIGN LOCATION\t# OF BRANCHES\tAUTH SIGN DATE\tRECEIVED DATE";
const msbRow = (name, state, received = "01/15/2026") => [name, "", "1 Main St", "New York", state, "10001", "409", "NY CA", "", "", "0", received, received].join("\t");
const msbFile = () => [HEADER, ...fincen.rows, "", "", "** ALL STATES & TERRITORIES FLAG", "A = All States/Territories", "401  \tIssuer of traveler's checks", ""].join("\r\n");

const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.startsWith("/gleif/")) {
      gleif.hits++;
      if (gleif.down) return res.writeHead(503, { "Content-Type": "application/vnd.api+json" }).end(JSON.stringify({ errors: [{ status: "503" }] }));
      const rec = gleif.records[decodeURIComponent(req.url.slice("/gleif/".length))];
      if (!rec) return res.writeHead(404, { "Content-Type": "application/vnd.api+json" }).end(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }));
      return res.writeHead(200, { "Content-Type": "application/vnd.api+json" }).end(JSON.stringify(rec));
    }
    if (req.url === "/fincen" && req.method === "POST") {
      fincen.hits++;
      assert.equal(body, "site=AA");
      if (fincen.down) return res.writeHead(502).end("bad gateway");
      return res.writeHead(200, { "Content-Type": "application/vnd.ms-excell" }).end(msbFile());
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;
// Each setFirmCheckSourcesForTests call also drops Mynt's cached FinCEN list, so a test sees the fake's latest.
const point = () => setFirmCheckSourcesForTests({ gleif: `${base}/gleif/`, fincen: `${base}/fincen` });
after(() => {
  setFirmCheckSourcesForTests(null);
  fake.close();
});

async function setup() {
  point();
  gleif.records = {};
  gleif.down = false;
  // FinCEN's list is never empty (Mynt reads an empty one as an outage): an unrelated registrant.
  fincen.rows = [msbRow("Unrelated Exchange LLC", "TX")];
  fincen.down = false;
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "firm-checks", version: "0" });
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
    return { user, client, call: (n, a) => call(client, n, a) };
  };
  return { store, admin, as };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};

// A licence provider's firm, added by hand, with a verified New York money transmitter licence and its roster.
async function partner(ctx, { name = "Partner Money Transmitter Inc", lei = LEI } = {}) {
  const firm = ok(
    await ctx.admin("register_firm", {
      name,
      regions: ["US"],
      legal_form: "company_private",
      incorporation: { country: "us", subdivision: "us-de" },
      identifiers: [...(lei ? [{ scheme: "lei", value: lei }] : []), { scheme: "us_nmls", value: "123456" }],
    }),
  );
  const p = await ctx.as(`${name} person`, ["license_provider"]);
  await ctx.store.setUserEntity(p.user.id, firm.id);
  p.user.entity_id = firm.id;
  p.entity = firm;
  const held = {};
  for (const [regulator_id, license_id] of [
    ["fincen", "fincen_msb"],
    ["nydfs", "nydfs_money_transmitter"],
  ]) {
    const h = ok(await p.call("register_license", { region: "US", regulator_id, license_id, registration_number: `${license_id}-31000123456789` }));
    ok(await ctx.admin("review_license", { license_record_id: h.id, decision: "verified", note: "checked on the register" }));
    held[license_id] = h;
    const lt = MODEL.regulators.find((r) => r.id === regulator_id).license_types.find((l) => l._id === license_id);
    for (const s of lt.grc.mandatory_stakeholders.internal) ok(await p.call("add_party", { kind: "internal", person: { name: s.name }, fills: [{ licence_id: h.id, stakeholder: s.id }] }));
  }
  p.held = held;
  return p;
}

// An unlicensed builder whose money transmission product asks the partner to sponsor transmission in New York.
async function builderAsking(ctx, p, id = "dollar-send") {
  const b = await ctx.as(`Builder ${id}`, ["developer"]);
  b.entity = ok(await b.call("create_entity", { name: `Builder ${id} Inc`, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-ca" } }));
  ok(
    await b.call("create_product", {
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
    }),
  );
  const d = structuredClone(BASE);
  d._id = id;
  d.owner_entity_id = b.entity.id;
  d.offered_in = ["us-ny"];
  d.connections.push(
    { _id: "p_transmission", type: "component_provided_by", from: { kind: "component", id: "transmission" }, to: { kind: "sponsor", id: p.entity.id }, attributes: { business_role: "issuer" } },
    { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "transmission" } },
  );
  ok(await b.call("set_product_definition", { product_id: id, definition: d }));
  b.request = ok(await b.call("request_sponsorship", { product_id: id, component_key: "transmission", provider_entity_id: p.entity.id }));
  return b;
}

test("names and LEIs are read as registers write them", () => {
  assert.equal(validLei(LEI), true);
  assert.equal(validLei(UNKNOWN_LEI), true);
  assert.equal(validLei("5493001KJTIIGC8Y1R13"), false, "the check digits must hold");
  assert.equal(validLei("not-an-lei"), false);
  assert.equal(normalizeName("PayPal, Inc."), normalizeName("PAYPAL INCORPORATED"));
  assert.equal(normalizeName("Smith & Sons Limited Liability Company"), normalizeName("SMITH AND SONS L.L.C."));
  assert.notEqual(normalizeName("Partner Money Transmitter Inc"), normalizeName("Partner Money Transfer Inc"));
  assert.equal(typeof parseMsbList("NAME\tSTATE\nX\tNY"), "string", "a changed format is refused, not misread");
  assert.equal(typeof parseMsbList(HEADER), "string", "an empty list is an outage, never 'nobody is registered'");
  const rows = parseMsbList([HEADER, msbRow("A Inc", "NY"), "", "401  \tIssuer of traveler's checks"].join("\r\n"));
  assert.deepEqual(rows.map((r) => [r.legal_name, r.state, r.msb_activities]), [["A Inc", "NY", "409"]]);
});

test("match: GLEIF's record and FinCEN's list agree with the firm, so it may sponsor; results show everywhere", async () => {
  const ctx = await setup();
  const p = await partner(ctx);
  const b = await builderAsking(ctx, p);

  // Not checked yet: sponsoring is refused, saying why and what to do.
  const before = await p.call("approve_sponsorship", { sponsorship_id: b.request.id, licence_ids: [p.held.nydfs_money_transmitter.id] });
  assert.equal(before.isError, true);
  assert.match(before.data.error, /real company/);
  assert.match(before.data.rule, /matching GLEIF LEI record or a matching FinCEN MSB registration/);
  assert.match(before.data.reasons.join("\n"), /gleif_lei: not checked yet/);
  assert.match(before.data.next, /run_firm_checks/);

  gleif.records[LEI] = leiRecord(LEI, { name: "PARTNER MONEY TRANSMITTER, INC." });
  fincen.rows = [msbRow("Unrelated Exchange LLC", "TX"), msbRow("Partner Money Transmitter, Inc.", "NY")];
  point();
  // Only admins run the checks; the firm can't vouch for itself.
  assert.ok(!(await p.client.listTools()).tools.some((t) => t.name === "run_firm_checks"));
  const run = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.deepEqual(run.results.map((r) => [r.source, r.status]), [["gleif_lei", "match"], ["fincen_msb", "match"]]);
  const [lei, msb] = run.results;
  assert.equal(lei.url, `${base}/gleif/${LEI}`);
  assert.equal(lei.fields.legal_name, "PARTNER MONEY TRANSMITTER, INC.");
  assert.equal(lei.fields.registration_authority, "RA000602");
  assert.equal(lei.fields.jurisdiction, "US-DE");
  assert.equal(lei.fields.registration_status, "ISSUED");
  assert.match(lei.response_hash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(lei.retrieved_at);
  // FinCEN's list gives the registrant's address state: compared with where GLEIF puts the firm (DE, NY).
  assert.equal(msb.fields.state, "NY");
  assert.deepEqual(msb.fields.state_compared_with.sort(), ["DE", "NY"]);
  assert.equal(msb.fields.registration_number, "fincen_msb-31000123456789", "the number it registered is shown");
  assert.equal(msb.fields.registration_number_checked, false, "FinCEN's list carries no numbers: checked by hand");
  assert.equal(run.legitimacy.passes, true);

  // The same answer hashes the same.
  const again = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.equal(again.results[0].response_hash, lei.response_hash);
  assert.equal(again.results[1].response_hash, msb.response_hash);
  assert.equal(fincen.hits, 1, "one download of FinCEN's list serves later checks for a while");

  // Shown on the firm, to the admin and in the requests.
  const mine = ok(await p.call("get_my_entity")).legitimacy;
  assert.equal(mine.passes, true);
  assert.equal(mine.checks.gleif_lei.status, "match");
  assert.equal(mine.checks.fincen_msb.status, "match");
  assert.deepEqual(
    mine.verify_by_hand.map((v) => [v.what, v.url]),
    [
      ["NMLS ID", "https://www.nmlsconsumeraccess.org/EntityDetails.aspx/COMPANY/123456"],
      ["FinCEN MSB registration number", "https://msb.fincen.gov/"],
    ],
  );
  const firm = ok(await ctx.admin("list_entities")).find((e) => e.id === p.entity.id);
  assert.equal(firm.legitimacy.passes, true);
  const requests = ok(await p.call("list_sponsorship_requests"));
  assert.equal(requests[0].your_firm_legitimacy.passes, true);

  const approved = ok(await p.call("approve_sponsorship", { sponsorship_id: b.request.id, licence_ids: [p.held.nydfs_money_transmitter.id] }));
  assert.equal(approved.status, "approved");
  const audit = ok(await ctx.admin("audit_log", { limit: 50 }));
  assert.ok(JSON.stringify(audit).includes("run_firm_checks"));
});

test("mismatch, not found and unavailable: each refuses sponsoring, and an outage keeps the last answer", async () => {
  const ctx = await setup();
  const p = await partner(ctx);
  const b = await builderAsking(ctx, p);
  const approve = () => p.call("approve_sponsorship", { sponsorship_id: b.request.id, licence_ids: [p.held.nydfs_money_transmitter.id] });

  // Not found: GLEIF doesn't know the LEI and no registrant has the name.
  ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  let l = ok(await p.call("get_my_entity")).legitimacy;
  assert.deepEqual([l.checks.gleif_lei.status, l.checks.fincen_msb.status, l.passes], ["not_found", "not_found", false]);
  assert.match((await approve()).data.reasons.join("\n"), /gleif_lei: not_found \(GLEIF has no record of this LEI\)/);

  // Unavailable: both sources down. Nothing passes, and nothing is said to be wrong with the firm.
  gleif.down = true;
  fincen.down = true;
  point();
  const down = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.deepEqual(down.results.map((r) => r.status), ["unavailable", "unavailable"]);
  assert.equal(down.results[0].response_hash, null);
  l = down.legitimacy;
  assert.equal(l.checks.gleif_lei.status, "not_found", "an outage keeps the last answer");
  assert.equal(l.checks.gleif_lei.latest.status, "unavailable");
  assert.deepEqual(l.flags, []);
  assert.equal((await approve()).isError, true);

  // Mismatch: GLEIF's record is another company's name, and FinCEN's registrant of that name is elsewhere.
  gleif.down = false;
  fincen.down = false;
  gleif.records[LEI] = leiRecord(LEI, { name: "Somebody Else Holdings LLC" });
  fincen.rows = [msbRow("Partner Money Transmitter Inc", "NY")];
  point();
  const mis = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.equal(mis.results[0].status, "mismatch");
  assert.match(mis.results[0].note, /legal name: GLEIF has 'Somebody Else Holdings LLC'/);
  // GLEIF didn't match, so FinCEN matches by name alone (one registrant of that name).
  assert.equal(mis.results[1].status, "match");
  assert.equal(mis.legitimacy.passes, false, "a passing FinCEN match doesn't outweigh a mismatch");
  assert.deepEqual(mis.legitimacy.flags, ["gleif_lei:mismatch"]);
  assert.match((await approve()).data.reasons.join("\n"), /gleif_lei mismatch/);

  // A lapsed LEI, and an LEI from another state of incorporation, are mismatches too.
  gleif.records[LEI] = leiRecord(LEI, { name: "Partner Money Transmitter Inc", registration: "LAPSED", jurisdiction: "US-NV" });
  const lapsed = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.match(lapsed.results[0].note, /jurisdiction: GLEIF has US-NV, the firm is incorporated in US-DE/);
  assert.match(lapsed.results[0].note, /LEI status: LAPSED/);

  // FinCEN's registrant in another state than GLEIF's addresses is a mismatch.
  gleif.records[LEI] = leiRecord(LEI, { name: "Partner Money Transmitter Inc" });
  fincen.rows = [msbRow("Partner Money Transmitter Inc", "TX")];
  point();
  const elsewhere = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.deepEqual(elsewhere.results.map((r) => r.status), ["match", "mismatch"]);
  assert.match(elsewhere.results[1].note, /is in TX, not/);
  assert.equal(elsewhere.legitimacy.passes, false);

  // Two registrants sharing the name with no LEI to tell them apart: not found, never a guess.
  const twin = await partner(ctx, { name: "Common Name Payments LLC", lei: null });
  fincen.rows = [msbRow("Common Name Payments LLC", "TX"), msbRow("COMMON NAME PAYMENTS, L.L.C.", "FL")];
  point();
  const ambiguous = ok(await ctx.admin("run_firm_checks", { entity_id: twin.entity.id }));
  assert.deepEqual(ambiguous.results.map((r) => [r.source, r.status]), [["fincen_msb", "not_found"]]);
  assert.match(ambiguous.results[0].note, /2 MSB registrants share the name/);
  assert.match(ambiguous.legitimacy.reasons.join("\n"), /no LEI on record/);

  // A malformed LEI is never sent to GLEIF.
  const hits = gleif.hits;
  await ctx.store.setEntityFacts(twin.entity.id, { identifiers: [{ scheme: "lei", value: "5493001KJTIIGC8Y1R13" }] });
  const bad = ok(await ctx.admin("run_firm_checks", { entity_id: twin.entity.id }));
  assert.match(bad.results[0].note, /isn't a well-formed LEI/);
  assert.equal(gleif.hits, hits);
});

test("a later mismatch or lapse drifts the products a firm sponsors; a match again clears it", async () => {
  const ctx = await setup();
  const p = await partner(ctx);
  const b = await builderAsking(ctx, p);
  gleif.records[LEI] = leiRecord(LEI, { name: "Partner Money Transmitter Inc" });
  fincen.rows = [msbRow("Partner Money Transmitter Inc", "NY")];
  point();
  ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  ok(await p.call("approve_sponsorship", { sponsorship_id: b.request.id, licence_ids: [p.held.nydfs_money_transmitter.id] }));
  const tested = ok(await b.call("test_product", { id: "dollar-send" }));
  assert.equal(tested.passed, true, JSON.stringify(tested.checks.filter((c) => c.status === "fail")));
  ok(await b.call("publish_product", { id: "dollar-send" }));
  assert.equal((await ctx.store.getProduct("dollar-send")).drift, null);

  // FinCEN's list no longer has the firm (its registration lapsed): the product drifts, naming New York.
  fincen.rows = [msbRow("Unrelated Exchange LLC", "TX")];
  point();
  const lapsed = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.deepEqual(lapsed.legitimacy.flags, ["fincen_msb:lapsed"]);
  assert.deepEqual(lapsed.drifted_products, ["dollar-send"]);
  const drift = (await ctx.store.getProduct("dollar-send")).drift;
  assert.deepEqual(drift.changes.map((c) => [c.kind, c.id, c.now, c.jurisdictions]), [["legitimacy", p.entity.id, "flagged:fincen_msb:lapsed", ["us-ny"]]]);
  // While flagged, the firm can't sponsor anything new either, though its LEI still matches.
  assert.equal(lapsed.legitimacy.passes, false);

  // Registered again: cleared.
  fincen.rows = [msbRow("Partner Money Transmitter Inc", "NY")];
  point();
  const back = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.deepEqual(back.legitimacy.flags, []);
  assert.equal((await ctx.store.getProduct("dollar-send")).drift, null);

  // Then GLEIF's record changes to another state of incorporation: a mismatch drifts it again.
  gleif.records[LEI] = leiRecord(LEI, { name: "Partner Money Transmitter Inc", jurisdiction: "US-NV" });
  const mis = ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.deepEqual(mis.drifted_products, ["dollar-send"]);
  assert.equal((await ctx.store.getProduct("dollar-send")).drift.changes[0].now, "flagged:gleif_lei:mismatch");

  // An outage changes nothing: the last answer stands.
  gleif.down = true;
  ok(await ctx.admin("run_firm_checks", { entity_id: p.entity.id }));
  assert.equal((await ctx.store.getProduct("dollar-send")).drift.changes[0].now, "flagged:gleif_lei:mismatch");
});

test("the monthly worker re-checks licence providers' firms when due, and retries an outage daily", async () => {
  const ctx = await setup();
  const p = await partner(ctx);
  const b = await ctx.as("Bea", ["developer"]);
  ok(await b.call("create_entity", { name: "Bea Inc", regions: ["US"] }));
  gleif.records[LEI] = leiRecord(LEI, { name: "Partner Money Transmitter Inc" });
  point();
  assert.deepEqual(await dueFirmChecks(ctx.store), [p.entity.id], "only licence providers' firms, never checked yet");
  assert.deepEqual(await firmChecksTick(ctx.store), [p.entity.id]);
  assert.deepEqual(await dueFirmChecks(ctx.store), [], "answered just now");
  const day = 24 * 60 * 60 * 1000;
  assert.deepEqual(await dueFirmChecks(ctx.store, Date.now() + 29 * day), []);
  assert.deepEqual(await dueFirmChecks(ctx.store, Date.now() + 31 * day), [p.entity.id], "monthly");
  const audit = await ctx.store.db.query("SELECT actor_id, details FROM financial_products.audit_log WHERE action = 'run_firm_checks'");
  assert.equal(audit.rows[0].actor_id, null);
  assert.equal(audit.rows[0].details.scheduled, true);
});

test("the paid business verification is a US service type, data only, and merging the US model only adds it", async () => {
  const kyb = shippedServiceTypes("US").find((t) => t.key === "kyb_business_verification");
  assert.ok(kyb);
  assert.deepEqual([kyb.vendor_licences, kyb.innovator_licences, kyb.fills], [[], [], []]);
  for (const f of ["good_standing", "officers", "registered_agent", "formation_state"]) assert.ok(f in kyb.output_schema.properties, f);

  // A server that loaded the US model before this type existed: applying the model again only adds it.
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user } = await store.createUser("Ada", ["admin"]);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(s);
  const client = new Client({ name: "kyb", version: "0" });
  await client.connect(c);
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  const listTools = async () => (await client.listTools()).tools;
  // (load_service_types loads every shipped file, so the older server is made by removing the new type's row.)
  const first = await applyRegulatoryModel({ call, listTools, model: MODEL });
  assert.equal(first.applied, true, JSON.stringify(first.problems));
  await store.db.query("DELETE FROM financial_products.service_types WHERE region = 'US' AND key = 'kyb_business_verification'");
  assert.ok(!(await call("list_service_types", { region: "US" })).data.some((t) => t.key === "kyb_business_verification"));

  const plan = await applyRegulatoryModel({ call, listTools, model: MODEL, dryRun: true });
  assert.deepEqual(plan.removals, []);
  const services = plan.plan.find((p) => p.tool === "load_service_types");
  assert.deepEqual([services.change, services.added, services.removed], ["load", ["service type kyb_business_verification"], []]);
  assert.ok(plan.plan.filter((p) => p.tool !== "load_service_types").every((p) => p.change === "keep"));
  const applied = await applyRegulatoryModel({ call, listTools, model: MODEL });
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));
  assert.ok(applied.services.loaded.includes("US/kyb_business_verification"), JSON.stringify(applied.services));
  const listed = (await call("list_service_types", { region: "US" })).data.find((t) => t.key === "kyb_business_verification");
  assert.equal(listed.category, "kyc");
});
