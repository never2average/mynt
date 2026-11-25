import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { setFirmCheckSourcesForTests } from "../dist/firm-checks.js";
import { joinPendingFirm } from "../dist/firm-notices.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { CATALOG } from "./helpers.js";

// get_regulated_firm_onboarding: a regulated firm's (licence provider's) onboarding as one ordered checklist, each step
// done, next, not_started or blocked, in plain words with the tool that does it. Only the firm's own licence providers
// read theirs; admins read any firm's, and every regulated firm's progress. GLEIF and FinCEN are fakes on 127.0.0.1.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const MODEL = read("../schemas/regulatory/us.json");
const BASE = read("../schemas/examples/us/money-transmission.v2.json");
const LEI = "5493001KJTIIGC8Y1R12"; // a valid ISO 17442 LEI
const FIRM = "Partner Money Transmitter Inc";
const DAY = /\d{4}-\d{2}-\d{2}/.source;

// ---- the fake registers ----
const gleif = { records: {}, down: false };
const fincen = { rows: [], down: false };
const leiRecord = (lei, name) => ({
  data: {
    type: "lei-records",
    id: lei,
    attributes: {
      lei,
      entity: {
        legalName: { name, language: "en" },
        legalAddress: { addressLines: ["251 Little Falls Drive"], city: "Wilmington", region: "US-DE", country: "US", postalCode: "19808" },
        headquartersAddress: { addressLines: ["1 Main St"], city: "New York", region: "US-NY", country: "US", postalCode: "10001" },
        registeredAt: { id: "RA000602", other: null },
        registeredAs: "1234567",
        jurisdiction: "US-DE",
        legalForm: { id: "XTIQ", other: null },
        status: "ACTIVE",
      },
      registration: { status: "ISSUED", nextRenewalDate: "2027-01-01T00:00:00Z", corroborationLevel: "FULLY_CORROBORATED" },
    },
  },
});
const HEADER = "LEGAL NAME\tDBA NAME\tSTREET ADDRESS\tCITY\tSTATE\tZIP\tMSB ACTIVITIES\tSTATES OF MSB ACTIVITIES\tALL STATES & TERRITORIES & FOREIGN FLAG**\tFOREIGN LOCATION\t# OF BRANCHES\tAUTH SIGN DATE\tRECEIVED DATE";
const msbRow = (name, state) => [name, "", "1 Main St", "New York", state, "10001", "409", "NY CA", "", "", "0", "01/15/2026", "01/15/2026"].join("\t");
const msbFile = () => [HEADER, ...fincen.rows, "", "", "** ALL STATES & TERRITORIES FLAG", "A = All States/Territories", "401  \tIssuer of traveler's checks", ""].join("\r\n");
const fake = http.createServer((req, res) => {
  req.on("data", () => undefined);
  req.on("end", () => {
    if (req.url.startsWith("/gleif/")) {
      if (gleif.down) return res.writeHead(503, { "Content-Type": "application/vnd.api+json" }).end(JSON.stringify({ errors: [{ status: "503" }] }));
      const rec = gleif.records[decodeURIComponent(req.url.slice("/gleif/".length))];
      if (!rec) return res.writeHead(404, { "Content-Type": "application/vnd.api+json" }).end(JSON.stringify({ errors: [{ status: "404", title: "Not Found" }] }));
      return res.writeHead(200, { "Content-Type": "application/vnd.api+json" }).end(JSON.stringify(rec));
    }
    if (req.url === "/fincen" && req.method === "POST") {
      if (fincen.down) return res.writeHead(502).end("bad gateway");
      return res.writeHead(200, { "Content-Type": "application/vnd.ms-excell" }).end(msbFile());
    }
    res.writeHead(404).end();
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;
// Each call also drops Mynt's cached FinCEN list, so a test sees the fake's latest.
const point = () => setFirmCheckSourcesForTests({ gleif: `${base}/gleif/`, fincen: `${base}/fincen` });
after(() => {
  setFirmCheckSourcesForTests(null);
  fake.close();
});

async function world() {
  point();
  gleif.records = {};
  gleif.down = false;
  fincen.rows = [msbRow("Unrelated Exchange LLC", "TX")];
  fincen.down = false;
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "regulated-firm-onboarding", version: "0" });
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
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const admin = await connect(adminUser);
  const applied = await applyRegulatoryModel({ call: (n, a) => call(admin, n, a), listTools: async () => (await admin.listTools()).tools, model: MODEL });
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));
  const firm = (name = FIRM, identifiers = []) => ok(admin, "register_firm", { name, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-de" }, identifiers });
  // A person Mynt whitelisted with roles, signed in, and (with a firm) added to it by an admin.
  const person = async (email, name, roles, firmId) => {
    await ok(admin, "invite_user", { email, roles });
    const user = await store.upsertClerkUser(`clerk_${name}`, email, name, (await store.getInvite(email)).roles);
    const added = firmId ? await ok(admin, "add_entity_member", { email, entity_id: firmId }) : null;
    const u = (await store.getUser(user.id)) ?? user;
    return { user: u, client: await connect(u), added };
  };
  const onboarding = (client, args = {}) => ok(client, "get_regulated_firm_onboarding", args);
  return { store, connect, call, ok, admin, adminUser, firm, person, onboarding };
}

// The tests that don't read the whole list of firms share one world: applying the US model to a fresh store is slow.
let sharedWorld;
const shared = () => (sharedWorld ??= world());

const statuses = (steps) => Object.fromEntries(steps.map((s) => [s.key, s.status]));
const stepOf = (o, key) => o.steps.find((s) => s.key === key);
const KEYS = ["firm_registered", "licence_provider_members", "firm_facts", "real_company_check", "licences_registered", "licences_verified", "roster_complete", "partner_ledger", "agreement_template", "first_sponsorship"];

test("each step's states, from a firm with nobody to one that sponsors", async () => {
  const w = await world();
  const { ok, admin, store, onboarding } = w;

  // ---- no regulated firms yet; an admin names the firm ----
  assert.deepEqual((await onboarding(admin, { all_firms: true })).firms, []);
  assert.match((await w.call(admin, "get_regulated_firm_onboarding")).data.error, /entity_id/);

  // ---- registered, nobody there: everything else waits on Mynt's invitation ----
  const firm = await w.firm();
  let o = await onboarding(admin, { entity_id: firm.id });
  assert.deepEqual(o.steps.map((s) => s.key), KEYS, "the steps, in order");
  assert.deepEqual(o.entity, { id: firm.id, name: FIRM, status: "active" });
  assert.equal(stepOf(o, "firm_registered").status, "done");
  assert.equal(stepOf(o, "firm_registered").detail, `${FIRM} is registered with Mynt and active.`);
  assert.equal(stepOf(o, "licence_provider_members").status, "blocked");
  assert.equal(stepOf(o, "licence_provider_members").detail, "Waiting for Mynt to invite your people with the licence-provider role.");
  assert.deepEqual(stepOf(o, "licence_provider_members").facts, { members: 0, waiting_to_be_accepted: 0, invited_not_signed_in: 0, licence_providers: [], waiting: [], invited: [] });
  for (const k of KEYS.slice(2)) {
    assert.equal(stepOf(o, k).status, "blocked", k);
    if (k !== "real_company_check") assert.match(stepOf(o, k).detail, /^Waits for your firm's people with the licence-provider role\./, k);
  }
  assert.deepEqual(o.progress, { done: 1, total: 7, next: { key: "licence_provider_members", title: "People with the licence-provider role", status: "blocked", tool: "invite_user" }, complete: false });
  assert.equal(o.ready_to_sponsor, false);
  assert.deepEqual(o.checks, [], "no register has answered: an empty list, not a made-up run");
  assert.deepEqual((await onboarding(admin, { all_firms: true })).firms, [], "a firm with no licence provider isn't a regulated firm yet");

  // ---- invited with the role, added to the firm, not signed in yet ----
  await ok(admin, "invite_user", { email: "lena@partner.example", roles: ["license_provider"] });
  assert.equal((await ok(admin, "add_entity_member", { email: "lena@partner.example", entity_id: firm.id })).status, "pending_sign_in");
  o = await onboarding(admin, { entity_id: firm.id });
  assert.equal(stepOf(o, "licence_provider_members").status, "blocked");
  assert.equal(stepOf(o, "licence_provider_members").detail, `Mynt invited 1 person with the licence-provider role. Waiting for them to sign in: they join ${FIRM} when they do.`);
  assert.equal(stepOf(o, "licence_provider_members").facts.invited_not_signed_in, 1);
  assert.deepEqual(stepOf(o, "licence_provider_members").facts.invited.map((p) => p.email), ["lena@partner.example"]);
  assert.deepEqual((await onboarding(admin, { all_firms: true })).firms.map((f) => [f.entity_id, f.licence_provider_members, f.progress.done]), [[firm.id, 0, 1]], "invited people make it a regulated firm");

  // ---- signed in and a member: the firm's own steps start, the first one next ----
  // Their first sign-in makes the account, and it joins the firm it was added to (as Mynt's sign-in does).
  const lenaUser = await joinPendingFirm(store, await store.upsertClerkUser("clerk_Lena", "lena@partner.example", "Lena", (await store.getInvite("lena@partner.example")).roles));
  assert.equal(lenaUser.entity_id, firm.id);
  const lena = { user: lenaUser, client: await w.connect(lenaUser) };
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "licence_provider_members").facts.invited_not_signed_in, 0, "no longer waiting to sign in");
  assert.equal(o.entity.id, firm.id, "a licence provider reads its own firm without naming it");
  assert.equal(stepOf(o, "licence_provider_members").detail, `1 person has the licence-provider role at ${FIRM}.`);
  assert.deepEqual(stepOf(o, "licence_provider_members").facts.licence_providers.map((p) => [p.name, p.email]), [["Lena", "lena@partner.example"]]);
  assert.deepEqual(statuses(o.steps), {
    firm_registered: "done",
    licence_provider_members: "done",
    firm_facts: "next",
    real_company_check: "blocked",
    licences_registered: "not_started",
    licences_verified: "not_started",
    roster_complete: "not_started",
    partner_ledger: "not_started",
    agreement_template: "not_started",
    first_sponsorship: "not_started",
  });
  const facts = stepOf(o, "firm_facts");
  assert.equal(facts.tool, "set_entity_facts");
  assert.equal(facts.by, "firm");
  assert.match(facts.detail, /^Mynt checks Partner Money Transmitter Inc against public registers by its LEI or its FinCEN MSB registration number\. Record its LEI \(set_entity_facts identifiers: \{ scheme: 'lei', value \}\), or its FinCEN MSB registration number/);
  assert.deepEqual(facts.facts.needs, { lei: true, fincen_msb: true, either: true });
  assert.equal(facts.facts.lei, null);
  assert.equal(facts.facts.rule, "lei_or_msb");
  assert.equal(stepOf(o, "real_company_check").by, "admin");
  assert.match(stepOf(o, "real_company_check").detail, /^Mynt hasn't run it yet\. It waits for your firm's facts first, then for Mynt to run it\. The rule: a matching GLEIF LEI record or a matching FinCEN MSB registration, and no mismatch or lapse\.$/);
  assert.equal(stepOf(o, "real_company_check").facts.passes, false);
  assert.equal(stepOf(o, "real_company_check").facts.last_run_at, null, "not run: no time, never a made-up one");
  assert.deepEqual(o.progress.next, { key: "firm_facts", title: "Firm facts for the real-company check", status: "next", tool: "set_entity_facts" });
  for (const k of ["partner_ledger", "agreement_template", "first_sponsorship"]) assert.equal(stepOf(o, k).informational, true, k);
  assert.match(stepOf(o, "partner_ledger").detail, /^Not needed before you sponsor: Mynt reads the sandbox ledger/);
  assert.match(stepOf(o, "agreement_template").detail, /^Optional:/);
  assert.equal(stepOf(o, "first_sponsorship").by, "builder");
  assert.deepEqual(stepOf(o, "first_sponsorship").facts, { approved: 0, pending: 0 });

  // ---- an LEI that isn't one, then the firm's own ----
  await ok(lena.client, "set_entity_facts", { identifiers: [{ scheme: "lei", value: "NOT-AN-LEI" }] });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "firm_facts").status, "next");
  assert.match(stepOf(o, "firm_facts").detail, /^The LEI on record \(NOT-AN-LEI\) isn't a valid LEI/);
  assert.equal(stepOf(o, "firm_facts").facts.lei_valid, false);
  await ok(lena.client, "set_entity_facts", { identifiers: [{ scheme: "lei", value: LEI }] });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "firm_facts").status, "done");
  assert.equal(stepOf(o, "firm_facts").detail, `On record: LEI ${LEI}. Mynt looks ${FIRM} up by that, and by its legal name.`);
  assert.equal(stepOf(o, "real_company_check").status, "blocked");
  assert.match(stepOf(o, "real_company_check").detail, /^Mynt hasn't run it yet\. Waiting for Mynt to check Partner Money Transmitter Inc against the public registers/);
  assert.equal(stepOf(o, "licences_registered").status, "next", "the firm's next step, while the check waits on Mynt");
  assert.equal(o.progress.next.key, "licences_registered");

  // ---- the registers can't be reached: unavailable, said as such with when, never a failure ----
  gleif.down = true;
  fincen.down = true;
  point();
  await ok(admin, "run_firm_checks", { entity_id: firm.id });
  o = await onboarding(lena.client);
  let check = stepOf(o, "real_company_check");
  assert.equal(check.status, "blocked");
  assert.match(check.detail, new RegExp(`^Not known yet\\. GLEIF's LEI record and FinCEN's MSB registrant list couldn't be reached on ${DAY}: unavailable, not a failure\\. Mynt tries again daily\\. Waiting for the register to answer\\.`));
  assert.equal(check.facts.sources.gleif_lei.status, "unavailable");
  assert.ok(check.facts.sources.gleif_lei.unavailable_at);
  assert.equal(check.facts.last_answer_at, null, "no register has answered yet");
  assert.ok(check.facts.last_run_at);
  assert.deepEqual(o.checks.map((c) => [c.source, c.status, c.status_words, c.scheduled]).sort(), [["fincen_msb", "unavailable", "couldn't be reached", false], ["gleif_lei", "unavailable", "couldn't be reached", false]]);

  // ---- the registers don't know the firm: not passed, and what it waits for ----
  gleif.down = false;
  fincen.down = false;
  point();
  await ok(admin, "run_firm_checks", { entity_id: firm.id });
  o = await onboarding(lena.client);
  check = stepOf(o, "real_company_check");
  assert.equal(check.status, "blocked");
  assert.match(check.detail, new RegExp(`^Not passed\\. GLEIF's LEI record: not found \\(${DAY}\\)`));
  assert.match(check.detail, /FinCEN's MSB registrant list: not found/);
  assert.match(check.detail, /Until it passes, Mynt refuses approve_sponsorship\.$/);
  assert.equal(o.ready_to_sponsor, false);
  assert.equal(o.legitimacy.passes, false);

  // ---- both registers match: passed ----
  gleif.records[LEI] = leiRecord(LEI, "PARTNER MONEY TRANSMITTER, INC.");
  fincen.rows.push(msbRow("Partner Money Transmitter, Inc.", "NY"));
  point();
  await ok(admin, "run_firm_checks", { entity_id: firm.id });
  o = await onboarding(lena.client);
  check = stepOf(o, "real_company_check");
  assert.equal(check.status, "done");
  assert.match(check.detail, new RegExp(`^Passed\\. GLEIF's LEI record: matches \\(${DAY}\\); FinCEN's MSB registrant list: matches \\(${DAY}\\)\\. Mynt checks again monthly\\.$`));
  assert.equal(check.facts.passes, true);
  assert.equal(o.checks.length, 6, "every answer so far, newest first");
  assert.equal(o.checks[0].status, "match");
  // A later outage keeps the answer: still passed, and the outage is said.
  gleif.down = true;
  point();
  await ok(admin, "run_firm_checks", { entity_id: firm.id });
  gleif.down = false;
  point();
  check = stepOf(await onboarding(lena.client), "real_company_check");
  assert.equal(check.status, "done");
  assert.match(check.detail, /GLEIF's LEI record couldn't be reached on \d{4}-\d{2}-\d{2}: unavailable, not a failure\. Mynt tries again daily\. The earlier answer stands\./);

  // ---- licences: registered, then waiting, not verified, suspended and verified ----
  const msb = await ok(lena.client, "register_license", { region: "US", regulator_id: "fincen", license_id: "fincen_msb", registration_number: "31000123456789" });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "licences_registered").status, "done");
  assert.equal(stepOf(o, "licences_registered").detail, "1 licence registered.");
  assert.equal(stepOf(o, "licences_verified").status, "blocked");
  assert.equal(stepOf(o, "licences_verified").detail, "Waiting for Mynt to verify your licence fincen_msb 31000123456789.");
  assert.equal(stepOf(o, "licences_verified").tool, "review_license");
  assert.equal(stepOf(o, "licences_verified").by, "admin");
  assert.equal(stepOf(o, "roster_complete").status, "next");
  assert.equal(stepOf(o, "roster_complete").detail, "0 of 1 required roles filled. Still needed: AML compliance officer (a person, for fincen_msb). Add each to your roster; a gap blocks publishing the products you sponsor.");
  assert.deepEqual(stepOf(o, "roster_complete").facts.missing.map((m) => m.stakeholder), ["fincen_aml_compliance_officer"]);

  await ok(admin, "review_license", { license_record_id: msb.id, decision: "rejected", note: "number not on the register" });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "licences_registered").status, "next");
  assert.match(stepOf(o, "licences_registered").detail, /^Mynt didn't verify the licence you registered\. Register it again/);
  assert.deepEqual(stepOf(o, "licences_registered").facts, { registered: 0, rejected: 1 });
  assert.equal(stepOf(o, "licences_verified").status, "not_started");
  assert.equal(stepOf(o, "licences_verified").detail, `Mynt didn't verify your licence fincen_msb 31000123456789 ("number not on the register"). Register it again with the right details.`);

  const again = await ok(lena.client, "register_license", { region: "US", regulator_id: "fincen", license_id: "fincen_msb", registration_number: "31000123456789" });
  await ok(admin, "review_license", { license_record_id: again.id, decision: "verified" });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "licences_verified").status, "done");
  assert.equal(stepOf(o, "licences_verified").detail, "1 licence is verified and in force.");
  await ok(admin, "review_license", { license_record_id: again.id, decision: "suspended", note: "under review" });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "licences_verified").status, "blocked");
  assert.equal(stepOf(o, "licences_verified").detail, `Mynt suspended your licence fincen_msb 31000123456789 ("under review"). Waiting for Mynt to restore it.`);
  assert.equal(o.ready_to_sponsor, false);
  await ok(admin, "review_license", { license_record_id: again.id, decision: "verified" });
  const ny = await ok(lena.client, "register_license", { region: "US", regulator_id: "nydfs", license_id: "nydfs_money_transmitter", registration_number: "MT-103456" });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "licences_verified").detail, "1 licence is verified and in force; 1 waiting for Mynt to verify.");
  assert.equal(o.ready_to_sponsor, true, "what approve_sponsorship needs of the firm: active, the check passed, a licence in force");
  await ok(admin, "review_license", { license_record_id: ny.id, decision: "verified" });

  // ---- the roster: the stakeholders the held licences mandate ----
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "roster_complete").status, "next");
  assert.deepEqual(o.progress, { done: 6, total: 7, next: { key: "roster_complete", title: "Roster filled for your licences", status: "next", tool: "add_party" }, complete: false });
  await ok(lena.client, "add_party", { kind: "internal", person: { name: "Priya Shah" }, fills: [{ licence_id: again.id, stakeholder: "fincen_aml_compliance_officer" }] });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "roster_complete").status, "done");
  assert.equal(stepOf(o, "roster_complete").detail, "All 1 required role is filled across 2 licences.");
  assert.deepEqual(o.progress, { done: 7, total: 7, next: null, complete: true });

  // ---- for information: a template, then the first request and its approval ----
  await ok(lena.client, "upload_agreement_template", { name: "Program agreement", source: "upload", file_name: "program.pdf", file_base64: Buffer.from("%PDF-1.4\n% program agreement\n%%EOF\n").toString("base64") });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "agreement_template").status, "done");
  assert.equal(stepOf(o, "agreement_template").detail, "1 template in use.");
  assert.deepEqual(o.progress, { done: 7, total: 7, next: null, complete: true }, "informational steps never count");

  const { user: builderUser } = await store.createUser("Bea", ["developer"]);
  const builder = await w.connect(builderUser);
  const builderFirm = await ok(builder, "create_entity", { name: "Dollar Send Inc", regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-ca" } });
  await ok(builder, "create_product", {
    id: "dollar-send",
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
  const d = structuredClone(BASE);
  d._id = "dollar-send";
  d.owner_entity_id = builderFirm.id;
  d.offered_in = ["us-ny"];
  d.connections.push(
    { _id: "p_transmission", type: "component_provided_by", from: { kind: "component", id: "transmission" }, to: { kind: "sponsor", id: firm.id }, attributes: { business_role: "issuer" } },
    { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "transmission" } },
  );
  await ok(builder, "set_product_definition", { product_id: "dollar-send", definition: d });
  const request = await ok(builder, "request_sponsorship", { product_id: "dollar-send", component_key: "transmission", provider_entity_id: firm.id });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "first_sponsorship").status, "not_started");
  assert.equal(stepOf(o, "first_sponsorship").detail, "1 request is waiting for your decision.");
  assert.equal(stepOf(o, "first_sponsorship").tool, "approve_sponsorship");
  await ok(lena.client, "approve_sponsorship", { sponsorship_id: request.id, licence_ids: [ny.id] });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "first_sponsorship").status, "done");
  assert.equal(stepOf(o, "first_sponsorship").detail, "1 sponsorship approved.");

  // ---- every regulated firm, for admins ----
  const { firms } = await onboarding(admin, { all_firms: true });
  assert.equal(firms.length, 1);
  assert.deepEqual(
    { ...firms[0], real_company_check: { ...firms[0].real_company_check, last_run_at: Boolean(firms[0].real_company_check.last_run_at) } },
    {
      entity_id: firm.id,
      name: FIRM,
      status: "active",
      licence_provider_members: 1,
      licences: 2,
      sponsorships_approved: 1,
      real_company_check: { rule: "lei_or_msb", passes: true, last_run_at: true },
      ready_to_sponsor: true,
      progress: { done: 7, total: 7, next: null, complete: true },
    },
  );

  // ---- the firm suspended: what isn't done waits for it to be active again ----
  await ok(admin, "set_entity_status", { entity_id: firm.id, status: "suspended" });
  o = await onboarding(lena.client);
  assert.equal(stepOf(o, "firm_registered").status, "blocked");
  assert.match(stepOf(o, "firm_registered").detail, /^Mynt has suspended Partner Money Transmitter Inc\. Waiting for Mynt to make it active again\.$/);
  assert.equal(stepOf(o, "firm_registered").tool, "set_entity_status");
  assert.match(stepOf(o, "partner_ledger").detail, /^Waits for your firm to be active again\./);
  assert.ok(!o.steps.some((s) => s.status === "next"), "nothing to do until the firm is active");
  assert.equal(o.ready_to_sponsor, false);
});

test("a request waits while the real-company check hasn't passed: the checklist says an approval is refused, before anyone tries", async () => {
  const w = await shared();
  const { ok, admin, store, onboarding } = w;
  const firm = await w.firm("Shell Money Inc");
  const lp = await w.person("sam@shell.example", "Sam", ["license_provider"], firm.id);
  const { user: builderUser } = await store.createUser("Bea", ["developer"]);
  const builderFirm = await ok(await w.connect(builderUser), "create_entity", { name: "Dollar Send Inc", regions: ["US"], legal_form: "company_private", incorporation: { country: "us" } });
  await store.requestSponsorship(builderUser.id, { product_id: "dollar-send", component_key: "transmission", builder_entity_id: builderFirm.id, provider_entity_id: firm.id, requested_jurisdictions: ["us-ny"], note: null });
  const o = await onboarding(lp.client);
  assert.equal(stepOf(o, "first_sponsorship").detail, "1 request is waiting for your decision. Mynt refuses an approval until the real-company check passes; you can still decline.");
  assert.equal(o.ready_to_sponsor, false);
  assert.equal((await onboarding(admin, { all_firms: true })).firms.find((x) => x.entity_id === firm.id).real_company_check.passes, false);
});

test("the facts follow the server's rule; with the check off, neither step is asked for", async () => {
  const w = await shared();
  const { ok, admin, onboarding } = w;
  const firm = await w.firm("Rule Money Inc", [{ scheme: "lei", value: LEI }]);
  await w.person("rae@rule.example", "Rae", ["license_provider"], firm.id);
  const facts = async () => stepOf(await onboarding(admin, { entity_id: firm.id }), "firm_facts");
  const before = process.env.SPONSOR_LEGITIMACY_RULE;
  try {
    assert.equal((await facts()).status, "done", "an LEI is enough for lei_or_msb");
    process.env.SPONSOR_LEGITIMACY_RULE = "lei_and_msb";
    let f = await facts();
    assert.equal(f.status, "next");
    assert.match(f.detail, new RegExp(`by its LEI and its FinCEN MSB registration number \\(on record: LEI ${LEI}\\)\\. Record its FinCEN MSB registration number \\(set_entity_facts identifiers: \\{ scheme: 'us_fincen_msb', value \\}, or register the FinCEN registration with register_license\\)\\.$`));
    assert.deepEqual(f.facts.needs, { lei: true, fincen_msb: true, either: false });
    // The firm's registered FinCEN registration is its MSB number.
    const { rows } = await w.store.db.query(`SELECT id FROM financial_products.users WHERE entity_id = $1`, [firm.id]);
    const rae = await w.connect(await w.store.getUser(rows[0].id));
    await ok(rae, "register_license", { region: "US", regulator_id: "fincen", license_id: "fincen_msb", registration_number: "31000999" });
    f = await facts();
    assert.equal(f.status, "done");
    assert.equal(f.detail, `On record: LEI ${LEI} and FinCEN MSB registration 31000999. Mynt looks Rule Money Inc up by those, and by its legal name.`);
    process.env.SPONSOR_LEGITIMACY_RULE = "off";
    const o = await onboarding(admin, { entity_id: firm.id });
    assert.equal(stepOf(o, "firm_facts").status, "done");
    assert.equal(stepOf(o, "firm_facts").detail, "This server doesn't run the real-company check, so no facts are needed for it.");
    assert.equal(stepOf(o, "real_company_check").status, "done");
    assert.equal(stepOf(o, "real_company_check").detail, "This server doesn't require the real-company check before sponsoring.");
    assert.equal(stepOf(o, "real_company_check").facts.passes, null, "not measured with the check off: null, never a pass it didn't earn");
  } finally {
    if (before === undefined) delete process.env.SPONSOR_LEGITIMACY_RULE;
    else process.env.SPONSOR_LEGITIMACY_RULE = before;
  }
});

test("a licence provider reads only its own firm; admins read any, and every regulated firm; nobody else has the tool", async () => {
  const w = await shared();
  const { admin, onboarding } = w;
  const firmA = await w.firm("Alpha Trust Inc");
  const firmB = await w.firm("Beta Trust Inc");
  const ana = await w.person("ana@alpha.example", "Ana", ["license_provider"], firmA.id);
  const bo = await w.person("bo@beta.example", "Bo", ["license_provider"], firmB.id);

  assert.equal((await onboarding(ana.client)).entity.id, firmA.id);
  assert.equal((await onboarding(ana.client, { entity_id: firmA.id })).entity.id, firmA.id);
  assert.match((await w.call(bo.client, "get_regulated_firm_onboarding", { entity_id: firmA.id })).data.error, /only see your own firm/);
  assert.match((await w.call(bo.client, "get_regulated_firm_onboarding", { all_firms: true })).data.error, /Only Mynt admins/);
  assert.equal((await onboarding(bo.client)).entity.id, firmB.id);

  // A second licence provider at a firm that has one waits to be accepted: no tool until then, and the firm's step says so.
  const cy = await w.person("cy@alpha.example", "Cy", ["license_provider"], firmA.id);
  assert.equal(cy.added.status, "pending_acceptance", JSON.stringify(cy.added));
  assert.ok(!(await cy.client.listTools()).tools.some((t) => t.name === "get_regulated_firm_onboarding"), "no standing, no licence-provider tools");
  const members = stepOf(await onboarding(ana.client), "licence_provider_members");
  assert.equal(members.detail, "1 person has the licence-provider role at Alpha Trust Inc. 1 more is waiting to be accepted by one of them (decide_firm_member).");
  assert.equal(members.facts.waiting_to_be_accepted, 1);
  assert.deepEqual(members.facts.waiting.map((p) => [p.email, typeof p.request_id, p.admin_recovery]), [["cy@alpha.example", "string", false]]);

  // Builders, vendors and consumers don't have it.
  for (const roles of [["developer"], ["vendor"], ["consumer"], ["liquidity_provider"]]) {
    const { user } = await w.store.createUser(`Other ${roles[0]}`, roles);
    assert.ok(!(await (await w.connect(user)).listTools()).tools.some((t) => t.name === "get_regulated_firm_onboarding"), roles[0]);
  }

  // A licence provider with no firm yet: every step waits on Mynt, and nothing is counted that wasn't measured.
  const loose = await w.person("lou@nowhere.example", "Lou", ["license_provider"], null);
  const none = await onboarding(loose.client);
  assert.equal(none.entity, null);
  assert.ok(none.steps.every((s) => s.status === "blocked"));
  assert.equal(none.steps[0].detail, "Waiting for Mynt to add your firm and you to it.");
  assert.equal(stepOf(none, "licence_provider_members").facts.members, null, "not measured without a firm: null, never 0");
  assert.equal(stepOf(none, "first_sponsorship").facts.approved, null);
  assert.equal(none.legitimacy, null);

  // Admins: any firm, by its id; an unknown firm says so; every regulated firm, in name order.
  assert.equal((await onboarding(admin, { entity_id: firmB.id })).entity.id, firmB.id);
  assert.match((await w.call(admin, "get_regulated_firm_onboarding", { entity_id: "00000000-0000-4000-8000-000000000000" })).data.error, /No firm/);
  const names = (await onboarding(admin, { all_firms: true })).firms.map((f) => f.name);
  assert.deepEqual(names.filter((n) => /^(Alpha|Beta) Trust/.test(n)), ["Alpha Trust Inc", "Beta Trust Inc"]);
  assert.deepEqual(names, [...names].sort(), "in name order");
  const tool = (await admin.listTools()).tools.find((t) => t.name === "get_regulated_firm_onboarding");
  assert.equal(tool.annotations.readOnlyHint, true);
});
