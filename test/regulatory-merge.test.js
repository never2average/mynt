import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { applyRegulatoryModel, diffItem, formatPlan, mergeItem } from "../scripts/regulatory-model.mjs";
import { CATALOG } from "./helpers.js";

// scripts/apply-regulatory-model.mjs merges a file into the server's model instead of replacing it: define_regulator
// replaces a whole regulator, so applying a file that holds part of one used to delete the rest (its other licence
// types, personas, product-type mappings and GRC). These tests apply partial files to a server that has more than
// they hold, and check nothing is dropped, and that anything merging would remove is refused unless allowed.

async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user } = await store.createUser("Ada", ["admin"]);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(s);
  const admin = new Client({ name: "merge", version: "0" });
  await admin.connect(c);
  const call = async (name, args = {}) => {
    const res = await admin.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  const listTools = async () => (await admin.listTools()).tools;
  return { call, listTools, apply: (model, opts = {}) => applyRegulatoryModel({ call, listTools, model, ...opts }) };
}

const licence = (_id, extra = {}) => ({
  _id,
  name: `Licence ${_id}`,
  application_procedure: ["Apply"],
  grc: {
    registers: { obligations: [{ id: `${_id}_kyc`, title: "Know your customer", criticality: "high" }] },
    repositories: { press_releases: [{ title: "Guidance", date: "2024-01-01", summary: "" }] },
    allowed_product_types: ["us_remit"],
    allowed_customer_segments: ["fin_retail"],
  },
  ...extra,
});

// A server with a regulator holding two licence types, two personas and a product-type mapping.
const BASE = {
  region: "US",
  region_definition: { name: "United States", regulators: ["FIN"] },
  product_categories: [{ id: "remittance", name: "Remittance", product_lines: ["payments"] }],
  regulated_product_types: [{ id: "us_remit", name: "Remittance", type_id: "remittance", actions: ["sale", "servicing"] }],
  regulators: [
    {
      id: "fin",
      name: "Financial regulator",
      short_name: "FIN",
      scope: {
        product_types: [{ id: "us_remit" }],
        customer_personas: [
          { id: "fin_retail", name: "Retail customer", qualification: {}, action: ["onboarding"] },
          { id: "fin_business", name: "Business customer", qualification: {}, action: ["onboarding"] },
        ],
      },
      license_types: [licence("fin_a", { covers: ["us-ny", "us-ca"] }), licence("fin_b")],
    },
  ],
};

test("merging keeps everything the file leaves out, and only lists what it adds and updates", () => {
  const current = { id: "r", list: [{ id: "a", n: 1 }, { id: "b", n: 2 }], tags: ["x"], nested: { keep: true } };
  const merged = mergeItem(current, { id: "r", list: [{ id: "b", n: 3 }, { id: "c", n: 4 }] });
  assert.deepEqual(merged, { id: "r", list: [{ id: "a", n: 1 }, { id: "b", n: 3 }, { id: "c", n: 4 }], tags: ["x"], nested: { keep: true } });
  const d = diffItem(current, merged);
  assert.deepEqual(d.added, ["list c"]);
  assert.deepEqual(d.updated, ["list b (n)"]);
  assert.deepEqual(d.removed, []);
  // A plain list in the file takes its value, and anything it lacks is listed as a removal.
  const narrowed = mergeItem(current, { tags: [] });
  assert.deepEqual(narrowed.tags, []);
  assert.deepEqual(diffItem(current, narrowed).removed, ["tags: x"]);
});

test("a partial regulator is merged into the server's: other licence types, personas, mappings and GRC are kept", async () => {
  const w = await world();
  assert.equal((await w.apply(BASE)).applied, true);
  const before = (await w.call("get_regulator", { region: "US", regulator_id: "fin" })).data;

  // A file holding one new licence type, one new persona and one new obligation on fin_a, and nothing else.
  const partial = {
    region: "US",
    regulators: [
      {
        id: "fin",
        scope: { customer_personas: [{ id: "fin_senior", name: "Senior customer", qualification: { min_age: 60 }, action: ["onboarding"] }] },
        license_types: [
          { _id: "fin_a", grc: { registers: { obligations: [{ id: "fin_a_complaints", title: "Complaints handling" }] } } },
          licence("fin_c"),
        ],
      },
    ],
  };
  const dry = await w.apply(partial, { dryRun: true });
  assert.deepEqual(dry.problems, []);
  assert.deepEqual(dry.removals, []);
  assert.deepEqual(dry.plan.map((p) => [p.tool, p.id, p.change]), [["define_regulator", "fin", "update"]]);
  assert.deepEqual(dry.plan[0].added, ["scope › persona fin_senior", "licence fin_a › grc › registers › obligation fin_a_complaints", "licence fin_c"]);
  assert.deepEqual(dry.plan[0].updated, []);
  assert.deepEqual((await w.call("get_regulator", { region: "US", regulator_id: "fin" })).data, before, "a dry run writes nothing");

  const done = await w.apply(partial);
  assert.equal(done.applied, true, JSON.stringify(done.problems));
  const after = (await w.call("get_regulator", { region: "US", regulator_id: "fin" })).data;
  assert.deepEqual(after.license_types.map((l) => l._id), ["fin_a", "fin_b", "fin_c"]);
  assert.deepEqual(after.scope.customer_personas.map((p) => p.id), ["fin_retail", "fin_business", "fin_senior"]);
  assert.deepEqual(after.scope.product_types, before.scope.product_types, "the product-type mapping is kept");
  const a = after.license_types[0];
  const aBefore = before.license_types[0];
  assert.deepEqual(a.grc.registers.obligations.map((o) => o.id), ["fin_a_kyc", "fin_a_complaints"]);
  for (const k of ["name", "covers", "application_procedure"]) assert.deepEqual(a[k], aBefore[k], k);
  for (const k of ["repositories", "allowed_product_types", "allowed_customer_segments", "mandatory_stakeholders"]) assert.deepEqual(a.grc[k], aBefore.grc[k], k);
  assert.deepEqual(after.license_types[1], before.license_types[1], "a licence type the file doesn't mention is untouched");

  // Applying the full original file again drops nothing either: what was added stays.
  const again = await w.apply(BASE);
  assert.equal(again.applied, true);
  assert.deepEqual((await w.call("get_regulator", { region: "US", regulator_id: "fin" })).data.license_types.map((l) => l._id), ["fin_a", "fin_b", "fin_c"]);
  assert.ok(again.plan.every((p) => p.change === "keep"), formatPlan(again.plan).join("\n"));
});

test("anything merging would remove refuses the run, unless --allow-removals, and is listed either way", async () => {
  const w = await world();
  assert.equal((await w.apply(BASE)).applied, true);
  const narrowing = {
    region: "US",
    product_categories: [{ id: "remittance", name: "Remittance", product_lines: ["credit"] }],
    regulators: [{ id: "fin", license_types: [{ _id: "fin_a", covers: ["us-ny"] }] }],
  };
  const expected = [
    "define_product_category remittance: product_lines: payments",
    "define_regulator fin: licence fin_a › covers: us-ca",
  ];

  const refused = await w.apply(narrowing);
  assert.equal(refused.applied, false);
  assert.deepEqual(refused.removals, expected);
  assert.match(refused.problems.join("\n"), /2 item\(s\) on the server would be removed.*--allow-removals/);
  assert.ok(formatPlan(refused.plan).includes("           - would remove: licence fin_a › covers: us-ca"), formatPlan(refused.plan).join("\n"));
  const fin = async () => (await w.call("get_regulator", { region: "US", regulator_id: "fin" })).data;
  assert.deepEqual((await fin()).license_types[0].covers, ["us-ny", "us-ca"], "nothing was changed");

  const allowed = await w.apply(narrowing, { allowRemovals: true });
  assert.equal(allowed.applied, true, JSON.stringify(allowed.problems));
  assert.deepEqual(allowed.removals, expected, "still listed");
  assert.deepEqual((await fin()).license_types[0].covers, ["us-ny"]);
  assert.deepEqual((await fin()).license_types.map((l) => l._id), ["fin_a", "fin_b"], "--allow-removals never drops items the file leaves out");
});

test("a service type the shipped examples would overwrite counts as a removal", async () => {
  const w = await world();
  const example = { region: "US", key: "kyc_check", name: "KYC check", innovator_licences: ["x_licence"] };
  const model = { region: "US", region_definition: { name: "United States" }, service_types: { licence_map: { x_licence: "fin_a" } } };
  const fresh = await w.apply(model, { dryRun: true, serviceTypeExamples: [example] });
  assert.deepEqual(fresh.plan.find((p) => p.tool === "load_service_types").added, ["service type kyc_check"]);
  // The server has its own version (here, as list_service_types would show it, with other licences).
  const call = async (name, args) => (name === "list_service_types" ? { isError: false, data: [{ ...example, innovator_licences: ["other"] }] } : w.call(name, args));
  const differs = await applyRegulatoryModel({ call, listTools: w.listTools, model, dryRun: true, serviceTypeExamples: [example] });
  assert.match(differs.removals.join("\n"), /service type kyc_check: the server's version would be overwritten/);
  assert.equal(differs.problems.length, 1);
  const unchanged = async (name, args) => (name === "list_service_types" ? { isError: false, data: [{ ...example, innovator_licences: ["fin_a"], fixtures: [] }] } : w.call(name, args));
  const same = await applyRegulatoryModel({ call: unchanged, listTools: w.listTools, model, dryRun: true, serviceTypeExamples: [example] });
  assert.equal(same.plan.find((p) => p.tool === "load_service_types").change, "keep");
});
