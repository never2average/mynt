import { test } from "node:test";
import assert from "node:assert/strict";

import { definitionFor, rd, setup, TEMPLATE } from "./v2-helpers.js";

test("a v2 definition is checked, sets the composition and catalogue record, and publishes with its hash pinned", async () => {
  const ctx = await setup();
  const { call, client, bank } = ctx;
  assert.equal((await call(client, "create_product", rd)).isError, false);
  // The model's governance lives in the product's own GRC folder.
  const record = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "rd_interest_model", record: { model: "RD interest model v1.2" } });
  assert.equal(record.isError, false, JSON.stringify(record.data));
  assert.equal((await call(client, "get_grc_folder", { product_id: "everyday-rd" })).data.repositories.risk_models.length, 1);
  assert.equal((await call(client, "get_grc_folder")).data.repositories.risk_models.length, 0, "not in the entity's own folder");

  const def = definitionFor(ctx, record.data.id);
  const checked = await call(client, "check_product_definition", { product_id: "everyday-rd", definition: def });
  assert.equal(checked.data.valid, true, JSON.stringify(checked.data.errors));
  assert.equal(checked.data.catalogue_record.product_line, "account_operations", "the lead component is the first: the deposit");
  assert.deepEqual(checked.data.publish_blockers, [], "nothing in its regime would stop it publishing");

  const saved = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def });
  assert.equal(saved.isError, false, JSON.stringify(saved.data));
  const p = await ctx.store.getProduct("everyday-rd");
  assert.deepEqual(Object.fromEntries(p.components.map((c) => [c.key, [c.primitive, c.action, c.provider.by]])), {
    mandate: ["payments", "sale", "party"],
    deposit: ["account_operations", "issuance", "self"],
  });
  assert.deepEqual(new Set(p.parties.map((b) => `${b.party_id}/${b.for}`)), new Set([`${ctx.partner.id}/mandate`]));
  assert.equal(p.product.description, TEMPLATE.descriptions.summary);
  assert.equal(p.product.regulator, "RBI");
  assert.equal(p.product.region, "IN");

  const regime = (await call(client, "get_product_regime", { product_id: "everyday-rd", working: true })).data;
  assert.equal(regime.regions[0].covered, true, JSON.stringify(regime.regions[0].components.map((c) => c.coverage)));

  const tested = await call(client, "test_product", { id: "everyday-rd" });
  assert.equal(tested.data.passed, true, JSON.stringify(tested.data.checks.filter((c) => c.status === "fail")));
  const published = await call(client, "publish_product", { id: "everyday-rd" });
  assert.equal(published.isError, false, JSON.stringify(published.data));
  const live = await ctx.store.getProduct("everyday-rd");
  assert.match(live.pins.definition_hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal((await call(client, "get_product_definition", { product_id: "everyday-rd" })).data.live_definition_hash, live.pins.definition_hash);
});

test("definitions are refused with every error: schema, references, ends and composition rules", async () => {
  const ctx = await setup();
  const { call, client, bank, partner } = ctx;
  await call(client, "create_product", rd);
  const governance = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "m", record: { model: "x" } });

  const schemaBroken = definitionFor(ctx, governance.data.id);
  delete schemaBroken.descriptions;
  const s = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: schemaBroken });
  assert.equal(s.isError, true);
  assert.match(s.data.errors.join("\n"), /descriptions/);

  const bad = definitionFor(ctx, governance.data.id);
  // The deposit funds the mandate (wrong way round), a link points nowhere, the mandate's handoff is gone,
  // the persona doesn't exist, the governance record doesn't, and the algorithm has two primaries.
  const funds = bad.connections.find((c) => c.type === "funds");
  [funds.from, funds.to] = [funds.to, funds.from];
  bad.connections.push({ _id: "dangling", type: "requires", from: { kind: "component", id: "deposit" }, to: { kind: "component", id: "nothing" }, attributes: { scope: "same_contract", stage: "origination" } });
  bad.connections = bad.connections.filter((c) => c._id !== "h_serves");
  bad.connections.find((c) => c._id === "retail_persona").to.id = "rbi_martian";
  bad.connections.find((c) => c._id === "governed").to.id = "00000000-0000-4000-8000-000000000000";
  bad.risk_models.push({ _id: "second", model_name: "Second", description: "x", purpose: "other", repository: "models/x" });
  bad.connections.push({ _id: "uses_second", type: "algorithm_uses_risk_model", from: { kind: "core_algorithm", id: "rd_interest" }, to: { kind: "risk_model", id: "second" }, attributes: { role: "primary", outputs_used: ["rate"] } });
  bad.connections.find((c) => c._id === "p_deposit").to.licence_id = "00000000-0000-4000-8000-000000000001";
  const r = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: bad });
  assert.equal(r.isError, true);
  const errors = r.data.errors.join("\n");
  assert.match(errors, /'mandate' \(payments:sale\) can't be the target/);
  assert.match(errors, /no component 'nothing'/);
  assert.match(errors, new RegExp(`provided by party ${partner.id}: add a partner handoff`));
  assert.match(errors, /defines no customer persona 'rbi_martian'/);
  assert.match(errors, /no current record '00000000-0000-4000-8000-000000000000'/);
  assert.match(errors, /algorithm 'rd_interest' needs exactly one primary risk model \(has 2\)/);
  assert.match(errors, /risk model 'second' needs a risk_model_governed_by/);
  assert.match(errors, /the owner holds no licence/);
  assert.equal((await ctx.store.getProduct("everyday-rd")).definition, null, "nothing was saved");

  // Variants aren't saved yet; someone else's product isn't theirs to define.
  const variant = { ...definitionFor(ctx, governance.data.id), plane: { role: "variant", extends: { product_id: "x", version: 1 }, patch: [] } };
  assert.match((await call(client, "set_product_definition", { product_id: "everyday-rd", definition: variant })).data.errors.join(), /Variants/);
  const { user: rival } = await ctx.store.createUser("Ravi", ["innovator"]);
  assert.equal((await call(await ctx.connect(rival), "set_product_definition", { product_id: "everyday-rd", definition: bad })).isError, true);
});

test("a published product's definition change goes into its draft version, and a lapsed party blocks the republish", async () => {
  const ctx = await setup();
  const { call, client, bank, partner } = ctx;
  await call(client, "create_product", rd);
  const governance = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "m", record: { model: "x" } });
  const def = definitionFor(ctx, governance.data.id);
  await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def });
  await call(client, "test_product", { id: "everyday-rd" });
  assert.equal((await call(client, "publish_product", { id: "everyday-rd" })).isError, false);

  def.descriptions.summary = "A daily recurring deposit, now with a senior-citizen bonus.";
  const saved = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def, changelog: "Senior bonus" });
  assert.equal(saved.data.applied_to, "draft_version");
  assert.notEqual((await ctx.store.getProduct("everyday-rd")).product.description, def.descriptions.summary, "the live record is unchanged");
  assert.equal((await ctx.store.draftVersion("everyday-rd")).data.description, def.descriptions.summary);

  // The partner leaves the roster: the saved definition no longer checks out, so the version can't go live.
  await call(client, "end_party", { party_id: partner.id });
  await call(client, "test_product", { id: "everyday-rd" });
  const refused = await call(client, "publish_product", { id: "everyday-rd" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.errors.join("\n"), new RegExp(`party '${partner.id}' isn't active`));
});

test("publishing freezes a developer contract: public offers and actions, nothing private", async () => {
  const ctx = await setup();
  const { call, client, bank, partner } = ctx;
  await call(client, "create_product", rd);
  const governance = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "m", record: { model: "x" } });
  const def = definitionFor(ctx, governance.data.id);
  const preview = await call(client, "check_product_definition", { product_id: "everyday-rd", definition: def });
  assert.ok(preview.data.developer_contract, "innovators see the contract before publishing");
  await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def });
  await call(client, "test_product", { id: "everyday-rd" });
  assert.equal((await call(client, "publish_product", { id: "everyday-rd" })).isError, false);

  const { user: dev } = await ctx.store.createUser("Dev", ["developer"]);
  const developer = await ctx.connect(dev);
  const contract = (await call(developer, "get_developer_contract", { product_id: "everyday-rd" })).data;
  assert.equal(contract.version, 1);
  assert.match(contract.contract_hash, /^sha256:/);
  assert.deepEqual(contract.offers.map((o) => o.segment_id).sort(), ["retail_saver", "senior_saver"]);
  const retail = contract.offers.find((o) => o.segment_id === "retail_saver");
  assert.ok(retail.terms.some((t) => t._id === "tenor_months"), "terms that apply to the product reach every segment");
  const mandate = contract.actions.find((a) => a.id === "mandate_setup");
  assert.deepEqual([mandate.surface, mandate.flow, mandate.host, mandate.component, mandate.consent_purpose], ["client", "hosted", "provider", "mandate", "mandate_setup"]);
  assert.ok(contract.actions.some((a) => a.id === "premature_closure" && a.surface === "server" && a.idempotent));
  assert.ok(contract.events.some((e) => e.type === "mandate_debit_failed"));
  assert.deepEqual(contract.consent_purposes, ["mandate_setup"]);
  // Nothing private leaks: no algorithms, risk models, fraud settings or parties.
  const text = JSON.stringify(contract);
  for (const secret of ["rd_interest_model", "core_algorithms", "risk_model", "fraud", partner.id, ctx.officer.id, ctx.entity.id]) assert.ok(!text.includes(secret), `contract leaks ${secret}`);
  assert.equal((await call(developer, "get_product_sdk", { product_id: "everyday-rd" })).data.contract.contract_hash, contract.contract_hash);

  // A catalogue product without a v2 definition has no contract yet.
  const plain = await call(developer, "get_developer_contract", { product_id: "ppf" });
  assert.equal(plain.isError, true);
  assert.match(plain.data.error, /without a v2 definition/);
});
