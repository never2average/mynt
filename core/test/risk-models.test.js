import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { opsStatus } from "../dist/ops.js";
import { auditClass } from "../dist/audit-classes.js";
import { CATALOG } from "./helpers.js";

// Mynt's own risk models: kept and read by Mynt's admins only, one of the seven risk areas each, versioned (an edit
// adds a version, never changes one), validated (every validation kept; a passed next-validation date is overdue in
// ops_status), and retired with a reason. Every change is audited. Products' own risk models are read across firms.

const T = "financial_products";
const TOOLS = ["add_risk_model", "update_risk_model", "validate_risk_model", "retire_risk_model", "list_risk_models", "admin_list_product_risk_models"];

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    const fresh = await store.getUser(user.id);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, fresh).connect(s);
    const client = new Client({ name: "risk-models", version: "0" });
    await client.connect(c);
    return {
      user: fresh,
      tools: async () => (await client.listTools()).tools.map((t) => t.name),
      call: async (n, a = {}) => {
        const res = await client.callTool({ name: n, arguments: a });
        let data;
        try {
          data = JSON.parse(res.content[0].text);
        } catch {
          data = { error: res.content[0].text };
        }
        return { isError: res.isError ?? false, data };
      },
    };
  };
  return { store, as };
}
const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error ?? JSON.stringify(r.data), re);
};
const MODEL = {
  risk_area: "financial",
  name: "Pool liquidity coverage",
  purpose: "Whether pools can meet withdrawals",
  method: "Liquid assets over 30-day expected outflows",
  inputs: [{ name: "liquid_assets", source: "pool ledger" }, { name: "expected_outflows" }],
  outputs: [{ name: "coverage_ratio", description: "Liquid assets ÷ outflows" }],
  thresholds: [{ name: "minimum", value: 1.2, meaning: "Below it, new commitments pause" }],
  next_validation_due: "2099-01-01",
};

test("admin only: nobody else gets or may call the risk-model tools; every change is audited as obligations", async () => {
  const { as } = await setup();
  const admin = await as("Ada", ["admin"]);
  for (const t of TOOLS) assert.ok((await admin.tools()).includes(t), t);
  for (const roles of [["developer"], ["innovator"], ["license_provider"], ["vendor"], ["consumer"]]) {
    const who = await as(`Not ${roles[0]}`, roles);
    const tools = await who.tools();
    for (const t of TOOLS) assert.ok(!tools.includes(t), `${roles[0]} has ${t}`);
  }
  for (const a of ["add_risk_model", "update_risk_model", "validate_risk_model", "retire_risk_model"]) assert.equal(auditClass(a), "obligations", a);
});

test("add, then edit: each edit of what it is adds a version, the old one kept as it was", async () => {
  const { store, as } = await setup();
  const admin = await as("Ada", ["admin"]);
  const dev = await as("Dev", ["developer"]);
  refused(await admin.call("add_risk_model", { ...MODEL, risk_area: "elsewhere" }));
  refused(await admin.call("add_risk_model", { ...MODEL, owner_user_id: dev.user.id }), /owner must be a Mynt admin/);
  refused(await admin.call("add_risk_model", { ...MODEL, next_validation_due: "2020-01-01" }), /after today/);
  const { model } = ok(await admin.call("add_risk_model", MODEL));
  assert.equal(model.version, 1);
  assert.equal(model.status, "draft");
  assert.equal(model.owner.name, "Ada");
  assert.deepEqual(model.thresholds, MODEL.thresholds);
  assert.equal(model.validation.overdue, false);
  assert.equal(model.validation.last_validated_at, null);

  refused(await admin.call("update_risk_model", { model_id: model.id, name: MODEL.name }), /Nothing to change/);
  const edited = ok(await admin.call("update_risk_model", { model_id: model.id, thresholds: [{ name: "minimum", value: 1.5 }], status: "active", note: "Tighter after review" }));
  assert.equal(edited.new_version, true);
  assert.equal(edited.model.version, 2);
  assert.equal(edited.model.status, "active");
  assert.deepEqual(edited.model.inputs, MODEL.inputs, "what wasn't passed is carried over");
  // Owner or status alone: no new version.
  const admin2 = await as("Bo", ["admin"]);
  const owned = ok(await admin.call("update_risk_model", { model_id: model.id, owner_user_id: admin2.user.id }));
  assert.equal(owned.new_version, false);
  assert.equal(owned.model.version, 2);

  const detail = ok(await admin.call("list_risk_models", { model_id: model.id }));
  assert.deepEqual(detail.versions.map((v) => [v.version, v.thresholds[0].value, v.change_note]), [[1, 1.2, null], [2, 1.5, "Tighter after review"]]);
  const audit = (await store.db.query(`SELECT action FROM ${T}.audit_log WHERE target = $1`, [model.id])).rows.map((r) => r.action).sort();
  assert.deepEqual(audit, ["add_risk_model", "update_risk_model", "update_risk_model"]);

  // Listed by area and status, with counts.
  ok(await admin.call("add_risk_model", { ...MODEL, risk_area: "technology", name: "Key rotation age" }));
  const fin = ok(await admin.call("list_risk_models", { risk_area: "financial" }));
  assert.deepEqual(fin.models.map((m) => m.name), ["Pool liquidity coverage"]);
  assert.deepEqual(fin.counts, { draft: 0, active: 1, retired: 0, overdue: 0 });
  assert.equal(ok(await admin.call("list_risk_models", { status: "draft" })).models[0].name, "Key rotation age");
});

test("validation: recorded against the current version, every one kept; overdue in ops_status until validated again", async () => {
  const { store, as } = await setup();
  const admin = await as("Ada", ["admin"]);
  const { model } = ok(await admin.call("add_risk_model", MODEL));
  refused(await admin.call("validate_risk_model", { model_id: model.id, outcome: "passed", notes: "Back-tested", next_validation_due: "2020-01-01" }), /after today/);
  const v = ok(await admin.call("validate_risk_model", { model_id: model.id, outcome: "passed_with_findings", notes: "Back-tested on 2025 data; one gap", next_validation_due: "2099-06-01" }));
  assert.equal(v.validation.version, 1);
  assert.equal(v.model.validation.outcome, "passed_with_findings");
  assert.equal(v.model.validation.validated_by.name, "Ada");
  assert.equal(v.model.validation.next_validation_due, "2099-06-01");

  // Its due date passes: overdue on the model and in ops_status.
  await store.db.query(`UPDATE ${T}.risk_models SET next_validation_due = '2020-01-01' WHERE id = $1`, [model.id]);
  const listed = ok(await admin.call("list_risk_models", {}));
  assert.equal(listed.models[0].validation.overdue, true);
  assert.equal(listed.counts.overdue, 1);
  let ops = await opsStatus(store.db);
  assert.equal(ops.risk_models.overdue_validations, 1);
  assert.equal(ops.risk_models.overdue[0].name, "Pool liquidity coverage");
  assert.ok(ops.attention.some((l) => l.startsWith("risk models: 1")), ops.attention.join("\n"));

  ok(await admin.call("update_risk_model", { model_id: model.id, method: "Liquid assets over 45-day outflows" }));
  ok(await admin.call("validate_risk_model", { model_id: model.id, outcome: "passed", notes: "Re-run on version 2", next_validation_due: "2099-12-01" }));
  ops = await opsStatus(store.db);
  assert.equal(ops.risk_models.overdue_validations, 0);
  assert.ok(!ops.attention.some((l) => l.startsWith("risk models:")));
  const detail = ok(await admin.call("list_risk_models", { model_id: model.id }));
  assert.deepEqual(detail.validations.map((x) => [x.version, x.outcome]), [[2, "passed"], [1, "passed_with_findings"]]);
});

test("retire: with a reason; then it can't be changed or validated, and is never overdue", async () => {
  const { store, as } = await setup();
  const admin = await as("Ada", ["admin"]);
  const { model } = ok(await admin.call("add_risk_model", MODEL));
  refused(await admin.call("retire_risk_model", { model_id: model.id, reason: "" }));
  const r = ok(await admin.call("retire_risk_model", { model_id: model.id, reason: "Replaced by the treasury model" }));
  assert.equal(r.model.status, "retired");
  assert.equal(r.model.retired.reason, "Replaced by the treasury model");
  refused(await admin.call("retire_risk_model", { model_id: model.id, reason: "Again" }), /already retired/);
  refused(await admin.call("update_risk_model", { model_id: model.id, name: "New name" }), /retired/);
  refused(await admin.call("validate_risk_model", { model_id: model.id, outcome: "passed", notes: "Checked", next_validation_due: "2099-01-01" }), /retired/);
  await store.db.query(`UPDATE ${T}.risk_models SET next_validation_due = '2020-01-01' WHERE id = $1`, [model.id]);
  assert.equal(ok(await admin.call("list_risk_models", {})).models[0].validation.overdue, false);
  assert.equal((await opsStatus(store.db)).risk_models.overdue_validations, 0);
  refused(await admin.call("list_risk_models", { model_id: "00000000-0000-4000-8000-000000000000" }), /No risk model/);
});

test("a role taken away ends it at once; products' own risk models are read across firms", async () => {
  const { store, as } = await setup();
  const admin = await as("Ada", ["admin"]);
  const firm = await store.createEntity(null, { name: "Builder Inc", registration_numbers: {}, regions: ["US"] });
  await store.db.query(`UPDATE ${T}.products SET entity_id = $1, definition = $2::jsonb WHERE id = 'savings-account'`, [
    firm.id,
    JSON.stringify({ risk_models: [{ _id: "pd", model_name: "PD scorecard", description: "Default odds", purpose: "pd_scorecard", repository: "models/pd", version: "3" }] }),
  ]);
  const read = ok(await admin.call("admin_list_product_risk_models", {}));
  assert.equal(read.models.length, 1);
  assert.deepEqual(read.models[0].model, { id: "pd", name: "PD scorecard", purpose: "pd_scorecard", version: "3", description: "Default odds" });
  assert.deepEqual(read.models[0].firm, { id: firm.id, name: "Builder Inc" });
  assert.equal(read.models[0].product.id, "savings-account");
  assert.equal(ok(await admin.call("admin_list_product_risk_models", { query: "Builder" })).models.length, 1);
  assert.equal(ok(await admin.call("admin_list_product_risk_models", { query: "nothing like it" })).models.length, 0);

  await store.db.query(`UPDATE ${T}.users SET roles = ARRAY['developer'] WHERE id = $1`, [admin.user.id]);
  refused(await admin.call("list_risk_models", {}), /Only Mynt's admins/);
  refused(await admin.call("add_risk_model", MODEL), /Only Mynt's admins/);
});
