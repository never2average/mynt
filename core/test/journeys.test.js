import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpHttpServer } from "../dist/http.js";
import { publishDefined, setup } from "./v2-helpers.js";

// The recurring deposit with a key fact statement, whose mandate handoff needs PAN and bank details.
const withData = (d) => {
  d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
  d.partner_handoffs[0].sends = { type: "object", required: ["pan", "bank_account_number", "ifsc", "amount"] };
  return d;
};

async function world() {
  const ctx = await setup();
  const def = await publishDefined(ctx, withData);
  await ctx.call(ctx.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  const { user } = await ctx.store.createUser("Dev", ["developer"]);
  const dev = await ctx.connect(user);
  return { ...ctx, def, dev };
}

const clone = (o) => JSON.parse(JSON.stringify(o));

test("a product's default journey is built from its contract and passes its own checks", async () => {
  const w = await world();
  const dictionary = (await w.call(w.dev, "get_data_dictionary")).data;
  assert.equal(dictionary.pan.sensitivity, "sensitive");
  const { journey, check } = (await w.call(w.dev, "get_default_journey", { product_id: "everyday-rd" })).data;
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.deepEqual(journey.steps.map((s) => s.id), ["intro", "consent_mandate_setup", "details_mandate_setup", "mandate_setup", "done", "failed"]);
  assert.deepEqual(journey.steps[0].screen.map((e) => e.type), ["offer_card", "disclosure"]);
  const fields = Object.fromEntries(journey.steps[2].screen.map((e) => [e.field, e.capture]));
  assert.deepEqual(fields, { pan: "secure_field", bank_account_number: "secure_field", ifsc: "typed" }, "public fields like amount aren't asked for; sensitive ones go in secure inputs");
  assert.deepEqual(journey.steps[3].on, { completed: "done", failed: "failed" });
  assert.deepEqual(check.paths, [
    ["intro", "consent_mandate_setup", "details_mandate_setup", "mandate_setup", "done"],
    ["intro", "consent_mandate_setup", "details_mandate_setup", "mandate_setup", "failed"],
  ]);
  const preview = await w.dev.callTool({ name: "preview_journey", arguments: { journey } });
  assert.match(preview.content[0].text, /^<!doctype html>/);
  assert.match(preview.content[0].text, /PAN <small>\(secure_field\)/);
});

test("journeys are checked on every path, and each problem names the step and the fix", async () => {
  const w = await world();
  const base = (await w.call(w.dev, "get_default_journey", { product_id: "everyday-rd" })).data.journey;
  const errors = async (j) => (await w.call(w.dev, "check_journey", { journey: j })).data.errors.join("\n");

  // Personal data before consent, and the hosted action before consent.
  const early = clone(base);
  [early.steps[1], early.steps[2]] = [early.steps[2], early.steps[1]];
  early.steps[0].next = "details_mandate_setup";
  early.steps[1].next = "consent_mandate_setup";
  early.steps[2].next = "mandate_setup";
  assert.match(await errors(early), /step 'details_mandate_setup' collects pan before any consent: move a consent step before it/);

  // A sensitive field in a plain input, a field nobody needs, a required field never collected.
  const fields = clone(base);
  fields.steps[2].screen = [
    { type: "field", field: "pan", capture: "typed" },
    { type: "field", field: "bank_account_number", capture: "secure_field" },
    { type: "field", field: "email", capture: "typed" },
  ];
  const f = await errors(fields);
  assert.match(f, /pan is sensitive: capture it with a secure field/);
  assert.match(f, /collects email, which no action in this journey needs: drop it/);
  assert.match(f, /starts mandate_setup, which needs ifsc, before it's collected on every path/);

  // A branch that skips the document; an unreachable step; a loop with no way out; a stale contract.
  const branchy = clone(base);
  branchy.steps.unshift({ id: "start", screen: [{ type: "text", text: "Hi" }], on: { returning: "consent_mandate_setup", new: "intro" } });
  branchy.steps.push({ id: "orphan", screen: [{ type: "text", text: "Nobody gets here" }] });
  branchy.steps.push({ id: "spin_a", screen: [{ type: "text", text: "a" }], next: "spin_b" }, { id: "spin_b", screen: [{ type: "text", text: "b" }], next: "spin_a" });
  branchy.steps.find((s) => s.id === "done").next = undefined;
  branchy.steps.find((s) => s.id === "failed").next = "spin_a";
  branchy.built_on.contract_version = 9;
  const b = await errors(branchy);
  assert.match(b, /starts mandate_setup before the 'kfs' document is shown on every path/);
  assert.match(b, /step 'orphan' can't be reached/);
  assert.match(b, /from step 'spin_a' the journey can never end/);
  assert.match(b, /built on contract version 9, but the live version is 1/);

  // Unknown contract references.
  const unknown = clone(base);
  unknown.steps[0].screen.push({ type: "disclosure", document: "brochure" });
  unknown.steps[1].capture_consent = "marketing";
  unknown.steps[3].action = "premature_closure";
  const u = await errors(unknown);
  assert.match(u, /'brochure' isn't one of the product's documents/);
  assert.match(u, /'marketing' isn't a consent purpose/);
  assert.match(u, /'premature_closure' isn't a hosted client action/);
});

test("saved journeys are served to devices while their contract is live, and stop when it changes", async () => {
  const w = await world();
  const app = (await w.call(w.dev, "create_app", { name: "Saver", description: "Daily saving", audience: "Savers", product_ids: ["everyday-rd"] })).data;
  const key = (await w.call(w.dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).data.key;
  const { journey } = (await w.call(w.dev, "get_default_journey", { product_id: "everyday-rd" })).data;
  const bad = clone(journey);
  bad.steps[2].screen[0].capture = "typed";
  assert.equal((await w.call(w.dev, "save_journey", { app_id: app.id, journey: bad })).isError, true, "failing journeys aren't saved");
  const saved = await w.call(w.dev, "save_journey", { app_id: app.id, journey });
  assert.equal(saved.isError, false, JSON.stringify(saved.data));
  assert.deepEqual((await w.call(w.dev, "list_journeys", { app_id: app.id })).data.map((j) => [j.journey_id, j.current]), [["everyday_rd_default", true]]);

  const http = createMcpHttpServer(w.store, null, {}, { publicUrl: "https://mynt.test" }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const api = async (method, path, secret, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    const secret = (await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: ["mandate_setup"] })).body.client_secret;
    const served = await api("GET", "/v1/client/journeys/everyday_rd_default", secret);
    assert.equal(served.status, 200);
    assert.equal(served.body.steps.length, 6);
    assert.equal((await api("GET", "/v1/client/journeys/nope", secret)).status, 404);

    // The innovator publishes version 2: the journey is outdated until it's checked and saved again.
    const def = withData(clone(w.def));
    def.descriptions.summary = "A daily recurring deposit, now with a higher rate.";
    assert.equal((await w.call(w.client, "set_product_definition", { product_id: "everyday-rd", definition: def, changelog: "Higher rate" })).isError, false);
    await w.call(w.client, "test_product", { id: "everyday-rd" });
    assert.equal((await w.call(w.client, "publish_product", { id: "everyday-rd" })).isError, false);
    const stale = await api("GET", "/v1/client/journeys/everyday_rd_default", secret);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "journey_outdated");
    assert.equal((await w.call(w.dev, "list_journeys", { app_id: app.id })).data[0].current, false);
    const updated = (await w.call(w.dev, "get_default_journey", { product_id: "everyday-rd" })).data.journey;
    assert.equal(updated.built_on.contract_version, 2);
    assert.equal((await w.call(w.dev, "save_journey", { app_id: app.id, journey: updated })).isError, false);
    assert.equal((await api("GET", "/v1/client/journeys/everyday_rd_default", secret)).status, 200);
  } finally {
    http.closeAllConnections();
    http.close();
  }
});
