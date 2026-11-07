import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { CATALOG } from "./helpers.js";

// schemas/regulatory/us.json, applied exactly the way scripts/apply-regulatory-model.mjs applies it: a dry run
// changes nothing, the real run sets up the US model through admin tools only, and running it again is safe.

const MODEL = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));

test("the US regulatory model applies, and the Mynt Ramp's service types load against it", async () => {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user } = await store.createUser("Ada", ["admin"]);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(s);
  const admin = new Client({ name: "us-model", version: "0" });
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

  // Every obligation and filing cites an instrument the file defines, and every instrument has a source.
  const legal = new Set(MODEL.legislation.map((l) => l.id));
  for (const l of MODEL.legislation) assert.match(l.url, /^https:\/\//, `${l.id} has a source`);
  for (const r of MODEL.regulators)
    for (const lt of r.license_types)
      for (const item of [...lt.grc.registers.obligations, ...lt.grc.registers.reporting_disclosure_filings]) assert.ok(legal.has(item.legal_ref), `${lt._id}/${item.id} cites ${item.legal_ref}`);

  // ---- dry run: checked against the server's own tool schemas, nothing written ----
  const before = (await call("list_regulated_product_types", { region: "US" })).data;
  const dry = await applyRegulatoryModel({ call, listTools, model: MODEL, dryRun: true });
  assert.deepEqual(dry.problems, []);
  assert.equal(dry.applied, false);
  assert.ok(dry.plan.some((p) => p.tool === "define_regulator" && p.id === "fincen" && p.change === "add"));
  assert.deepEqual((await call("list_regulated_product_types", { region: "US" })).data, before, "a dry run writes nothing");

  // A broken item is caught before anything is written.
  const broken = structuredClone(MODEL);
  broken.regulated_product_types[0].actions = ["teleport"];
  const refused = await applyRegulatoryModel({ call, listTools, model: broken, dryRun: false });
  assert.equal(refused.applied, false);
  assert.match(refused.problems.join("\n"), /us_cvc_money_transmission/);
  assert.deepEqual((await call("list_regulated_product_types", { region: "US" })).data, before);

  // ---- the real run ----
  const lines = [];
  const done = await applyRegulatoryModel({ call, listTools, model: MODEL, say: (l) => lines.push(l) });
  assert.equal(done.applied, true, JSON.stringify(done.problems));
  for (const r of MODEL.regulators) {
    const got = await call("get_regulator", { region: "US", regulator_id: r.id });
    assert.equal(got.isError, false, r.id);
    assert.deepEqual(
      got.data.license_types.map((l) => l._id),
      r.license_types.map((l) => l._id),
    );
  }
  const fincen = (await call("get_regulator", { region: "US", regulator_id: "fincen" })).data;
  const msb = fincen.license_types.find((l) => l._id === "fincen_msb");
  assert.ok(msb.grc.registers.obligations.some((o) => o.id === "fincen_sar" && o.recurrence === "event_driven"));
  assert.ok(msb.grc.registers.obligations.some((o) => o.id === "fincen_msb_renew" && o.recurrence === "biennial"));
  const instruments = (await call("list_legal_instruments", { region: "US" })).data.legislative.map((l) => l.id);
  for (const id of legal) assert.ok(instruments.includes(id), id);
  const region = (await call("list_regions", {})).data.find((r) => r.code === "US");
  for (const r of ["FinCEN", "NYDFS", "DFPI", "OCC"]) assert.ok(region.regulators.includes(r), r);

  // Who may provide each part of a buy-and-hold USDC product follows from the model.
  const licences = async (category, action) => (await call("find_licenses", { region: "US", category, action })).data;
  const ids = (r) => JSON.stringify(r);
  assert.match(ids(await licences("virtual_currency", "sale")), /fincen_msb/);
  assert.match(ids(await licences("virtual_currency", "sale")), /nydfs_bitlicense/);
  assert.match(ids(await licences("digital_asset_custody", "servicing")), /occ_national_trust_bank/);
  assert.doesNotMatch(ids(await licences("payment_stablecoins", "issuance")), /fincen_msb/, "a money services business doesn't issue stablecoins");

  // The Mynt Ramp's four service types load, since their licence type now exists.
  for (const k of ["onramp_quote", "onramp_transfer", "offramp_quote", "offramp_transfer"]) assert.ok(done.services.loaded.includes(`US/${k}`), k);

  // ---- running it again is safe: categories are kept, the rest is replaced with the file's version ----
  const again = await applyRegulatoryModel({ call, listTools, model: MODEL });
  assert.equal(again.applied, true);
  assert.ok(again.plan.filter((p) => p.tool === "define_product_category").every((p) => p.change === "keep"));
  assert.ok(again.plan.filter((p) => p.tool === "define_regulator").every((p) => p.change === "replace"));
  const regionAgain = (await call("list_regions", {})).data.find((r) => r.code === "US");
  assert.deepEqual([...regionAgain.regulators].sort(), [...region.regulators].sort(), "the region's regulators are merged, not duplicated");
});
