// The reference flow for a sponsored US product: an unlicensed builder's product, composed on money transmission,
// sponsored by a licence provider under its FinCEN registration and state money transmitter licences, through to
// Mynt's developer-ready catalogue. Shared by scripts/apply-sponsored-product.mjs (against a server, over MCP)
// and test/sponsored-product-e2e.test.js (an in-process server), so what the test checks is exactly what the
// script does.
//
// The fixture (schemas/examples/us/sponsored-product.placeholder.json) names the licence provider's firm, its
// licences and roster, the builder's firm and the product. The shipped one is a placeholder, for staging and
// tests only, and is refused unless `staging` is set; for the real partner, copy it, set placeholder to false
// and put in the real firm and licences (docs/reference.md, "A sponsored US product").
//
// Three people act, each over their own session: `call(name, input, actor)` with actor "admin", "licence_provider"
// or "builder" returns { isError, data }. `actors` lists the sessions there are; the run stops where it needs one
// that isn't (say, the partner's own approval) and says so, and running it again picks up where it stopped: every
// step reads first and only does what's still missing. `dryRun` reads only and lists what it would do.
// Licences are verified (review_license) only for a placeholder fixture, or when `verifyLicences` says the admin
// running it has checked each one against the regulator's public register.

import { readFileSync } from "node:fs";

const ACTORS = ["admin", "licence_provider", "builder"];
const stable = (v) =>
  Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

export const DEFAULT_FIXTURE = new URL("../schemas/examples/us/sponsored-product.placeholder.json", import.meta.url);
export const loadFixture = (path = DEFAULT_FIXTURE) => JSON.parse(readFileSync(path, "utf8"));
export const loadTemplate = (name) => JSON.parse(readFileSync(new URL(`../schemas/examples/us/${name}`, import.meta.url), "utf8"));

// What's wrong with a fixture, before anything is called.
export function fixtureProblems(f) {
  const p = [];
  const lp = f?.licence_provider;
  if (!lp?.name && !lp?.entity_id) p.push("licence_provider needs a name or an entity_id");
  if (!Array.isArray(lp?.licences) || !lp.licences.length) p.push("licence_provider.licences is empty");
  for (const l of lp?.licences ?? []) if (!l.key || !l.regulator_id || !l.license_id || !l.registration_number) p.push(`licence ${JSON.stringify(l)} needs key, regulator_id, license_id and registration_number`);
  const keys = new Set((lp?.licences ?? []).map((l) => l.key));
  for (const r of lp?.roster ?? []) for (const fill of r.fills ?? []) if (!keys.has(fill.licence)) p.push(`roster fill names licence '${fill.licence}', not one of ${[...keys].join(", ")}`);
  if (!f?.builder?.name) p.push("builder.name is missing");
  if (!f?.product?.id || !f?.product?.template || !f?.product?.sponsored_component) p.push("product needs id, template and sponsored_component");
  if (!Array.isArray(f?.product?.offered_in) || !f.product.offered_in.length) p.push("product.offered_in is empty");
  if (typeof f?.placeholder !== "boolean") p.push("placeholder must be true or false");
  return p;
}

// The product's v2 definition: the template, owned by the builder's firm, its sponsored component provided by the
// licence provider ({ kind: "sponsor", id }), offered where the fixture says.
export function sponsoredDefinition(fixture, template, builderEntityId, providerEntityId) {
  const { id, product_name, sponsored_component: key, offered_in } = fixture.product;
  const d = structuredClone(template);
  d._id = id;
  if (product_name) d.product_name = product_name;
  d.owner_entity_id = builderEntityId;
  d.offered_in = offered_in;
  d.connections = (d.connections ?? []).filter((c) => !(c.type === "component_provided_by" && c.from?.id === key) && c._id !== "owner_role");
  d.connections.push(
    { _id: `p_${key}`, type: "component_provided_by", from: { kind: "component", id: key }, to: { kind: "sponsor", id: providerEntityId }, attributes: { business_role: "issuer" } },
    { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: key } },
  );
  return d;
}

// The catalogue record create_product needs before the definition replaces it with its projection.
function catalogueRecord(fixture, template) {
  const lead = template.components.find((c) => c.key === fixture.product.sponsored_component) ?? template.components[0];
  return {
    id: fixture.product.id,
    name: fixture.product.product_name ?? template.product_name,
    product_line: lead.primitive,
    category: template.product_type,
    region: fixture.region ?? "US",
    risk_level: template.projection?.risk_level ?? "not_applicable",
    liquidity: template.projection?.liquidity ?? "high",
    typical_horizon: template.projection?.typical_horizon ?? "short",
    return_type: template.projection?.return_type ?? "fixed_interest",
    regulator: "FinCEN",
    description: template.descriptions.summary,
    key_features: template.descriptions.key_features.slice(0, 3),
  };
}

// Runs the flow. Returns { done, stopped_at?, waiting_on?, plan (dry run), entity ids, sponsorships, developer_ready }.
export async function runSponsoredProduct({ call, fixture = loadFixture(), template, actors = ACTORS, dryRun = false, staging = false, verifyLicences = false, say = () => {} }) {
  const problems = fixtureProblems(fixture);
  if (problems.length) throw new Error(`The fixture isn't usable: ${problems.join("; ")}`);
  if (fixture.placeholder && !staging) throw new Error(`The fixture is a placeholder (${fixture.licence_provider.name}): ${fixture.placeholder_note ?? "staging and tests only"}. Pass staging to run it on a staging server; for production, use the real partner's fixture.`);
  template ??= loadTemplate(fixture.product.template);
  const lp = fixture.licence_provider;
  const productId = fixture.product.id;
  const key = fixture.product.sponsored_component;
  const offered = fixture.product.offered_in;
  const out = { done: false, dry_run: dryRun, plan: [], provider_entity_id: lp.entity_id ?? null, builder_entity_id: null, licences: {}, sponsorships: [], developer_ready: false };
  const can = (actor) => actors.includes(actor);
  const stop = (step, waiting_on, why) => {
    say(`Stopped at ${step}: ${why}`);
    return { ...out, stopped_at: step, ...(waiting_on ? { waiting_on } : {}), reason: why };
  };
  const read = async (actor, name, input = {}) => call(name, input, actor);
  // A change: done, or in a dry run only listed.
  const write = async (actor, name, input, what) => {
    if (dryRun) {
      out.plan.push(`${actor}: ${name} (${what})`);
      say(`would ${what}`);
      return null;
    }
    const r = await call(name, input, actor);
    if (r.isError) throw new Error(`${name} (${what}) failed: ${JSON.stringify(r.data)}`);
    say(what);
    return r.data;
  };

  // 1. The licence provider's firm: the one named by id, or found (admins: list_entities) or registered by name.
  if (!out.provider_entity_id) {
    if (!can("admin")) return stop("licence provider's firm", "admin", "no entity_id in the fixture, and finding or registering the firm needs an admin");
    const firms = await read("admin", "list_entities");
    if (firms.isError) throw new Error(`list_entities failed: ${JSON.stringify(firms.data)}`);
    const found = firms.data.find((e) => e.name === lp.name);
    if (found) out.provider_entity_id = found.id;
    else {
      const firm = await write("admin", "register_firm", { name: lp.name, regions: lp.regions ?? [fixture.region ?? "US"], ...(lp.legal_form ? { legal_form: lp.legal_form } : {}), ...(lp.incorporation ? { incorporation: lp.incorporation } : {}) }, `register the licence provider's firm '${lp.name}'`);
      if (!firm) return { ...out, stopped_at: "licence provider's firm", reason: "dry run: the firm isn't registered yet, so nothing after it can be read" };
      out.provider_entity_id = firm.id;
    }
  }
  const providerId = out.provider_entity_id;

  // 2. Its person a member of it (admins: add_entity_member), then its licences registered and verified.
  // Without the licence provider's session (the real partner acts in its own), its side is left to it: the
  // builder's steps still run, and the run stops at its approval.
  if (can("licence_provider")) {
    let mine = await read("licence_provider", "get_my_entity");
    if (mine.isError || mine.data.id !== providerId) {
      if (!mine.isError) throw new Error(`The licence provider's session belongs to another firm ('${mine.data.name}', ${mine.data.id}), not ${providerId}`);
      if (!lp.member_email || !can("admin")) return stop("licence provider's membership", "admin", `its person isn't a member of the firm yet: an admin runs add_entity_member with their email and entity_id ${providerId}`);
      await write("admin", "add_entity_member", { email: lp.member_email, entity_id: providerId }, `add ${lp.member_email} to '${lp.name}'`);
      if (dryRun) return { ...out, stopped_at: "licence provider's membership", reason: "dry run: its person isn't a member yet" };
      mine = await read("licence_provider", "get_my_entity");
      if (mine.isError) throw new Error(`get_my_entity failed after add_entity_member: ${JSON.stringify(mine.data)}`);
    }
    const awaitingReview = [];
    for (const l of lp.licences) {
      let held = mine.data.licenses.find((h) => h.regulator_id === l.regulator_id && h.license_id === l.license_id && (h.jurisdiction ?? null) === (l.jurisdiction ?? null) && h.registration_number === l.registration_number);
      if (!held) {
        held = await write(
          "licence_provider",
          "register_license",
          { region: fixture.region ?? "US", regulator_id: l.regulator_id, license_id: l.license_id, registration_number: l.registration_number, ...(l.jurisdiction ? { jurisdiction: l.jurisdiction } : {}), ...(l.valid_from ? { valid_from: l.valid_from } : {}), ...(l.valid_to ? { valid_to: l.valid_to } : {}) },
          `register ${l.license_id} (${l.registration_number})`,
        );
        if (!held) continue;
      }
      out.licences[l.key] = held.id;
      if (held.status === "verified") continue;
      if (!(fixture.placeholder || verifyLicences) || !can("admin")) {
        awaitingReview.push(`${l.license_id} (${held.id})`);
        continue;
      }
      await write("admin", "review_license", { license_record_id: held.id, decision: "verified", note: fixture.placeholder ? "Placeholder licence for staging and tests" : "Checked against the regulator's public register" }, `verify ${l.license_id}`);
    }
    if (awaitingReview.length) return stop("licence review", "admin", `an admin checks each against the regulator's public register and verifies it (review_license): ${awaitingReview.join(", ")}`);
    if (dryRun && Object.keys(out.licences).length < lp.licences.length) return { ...out, stopped_at: "licences", reason: "dry run: licences aren't registered yet" };

    // 3. The roster fills the stakeholders its licences mandate.
    const parties = (await read("licence_provider", "get_my_entity")).data.parties ?? [];
    for (const r of lp.roster ?? []) {
      const fills = r.fills.map((f) => ({ licence_id: out.licences[f.licence], stakeholder: f.stakeholder }));
      const missing = fills.filter((f) => !parties.some((p) => p.status === "active" && p.fills.some((x) => x.licence_id === f.licence_id && x.stakeholder === f.stakeholder)));
      if (!missing.length) continue;
      await write("licence_provider", "add_party", { kind: r.kind ?? "internal", ...(r.person ? { person: r.person } : {}), ...(r.legal_entity_id ? { legal_entity_id: r.legal_entity_id } : {}), ...(r.attributes ? { attributes: r.attributes } : {}), fills: missing }, `put ${r.person?.name ?? r.legal_entity_id} on the roster, filling ${missing.map((m) => m.stakeholder).join(", ")}`);
    }
  } else say(`The licence provider's side (its licences, roster and approval) is left to it; its firm id is ${providerId}`);

  // 4. The builder's firm (holding no licence) and its product, the sponsored component provided by the licence provider.
  if (!can("builder")) return stop("builder's product", "builder", "the builder creates its firm and product and asks for the sponsorship");
  const firm = await read("builder", "get_my_entity");
  if (!firm.isError) out.builder_entity_id = firm.data.id;
  else {
    const b = fixture.builder;
    const created = await write("builder", "create_entity", { name: b.name, regions: b.regions ?? [fixture.region ?? "US"], ...(b.legal_form ? { legal_form: b.legal_form } : {}), ...(b.incorporation ? { incorporation: b.incorporation } : {}) }, `create the builder's firm '${b.name}'`);
    if (!created) return { ...out, stopped_at: "builder's firm", reason: "dry run: the builder has no firm yet" };
    out.builder_entity_id = created.id;
  }
  const def = sponsoredDefinition(fixture, template, out.builder_entity_id, providerId);
  const existing = await read("builder", "get_product", { id: productId });
  if (existing.isError) {
    const made = await write("builder", "create_product", catalogueRecord(fixture, template), `create the product '${productId}'`);
    if (!made) return { ...out, stopped_at: "product", reason: "dry run: the product doesn't exist yet" };
  }
  const current = await read("builder", "get_product_definition", { product_id: productId });
  const live = !current.isError && current.data.live_definition_hash && same(current.data.definition, def);
  if (!live && !(!current.isError && same(current.data.definition, def)))
    await write("builder", "set_product_definition", { product_id: productId, definition: def, changelog: fixture.product.changelog ?? "Sponsored by a licence provider" }, `save the v2 definition of '${productId}', ${key} provided by the licence provider`);

  // 5. The sponsorship: asked for wherever it's offered and not yet approved, then approved under the licences covering it there.
  const sponsorships = async () => ((await read("builder", "list_my_sponsorships", { product_id: productId })).data ?? []).filter((s) => s.component?.key === key && s.provider?.entity_id === providerId);
  let ours = await sponsorships();
  const approvedIn = () => new Set(ours.filter((s) => s.status === "approved").flatMap((s) => s.jurisdictions ?? []));
  let missing = offered.filter((j) => !approvedIn().has(j));
  if (missing.length && !ours.some((s) => s.status === "pending")) {
    const asked = await write("builder", "request_sponsorship", { product_id: productId, component_key: key, provider_entity_id: providerId, jurisdictions: missing, note: `Sponsor ${key} in ${missing.join(", ")}` }, `ask '${lp.name}' to sponsor ${key} in ${missing.join(", ")}`);
    if (asked) ours = await sponsorships();
  }
  if (missing.length) {
    if (!can("licence_provider")) return stop("sponsorship approval", "licence_provider", `'${lp.name}' approves the request for ${missing.join(", ")} (list_sponsorship_requests, approve_sponsorship)`);
    const inbox = (await read("licence_provider", "list_sponsorship_requests", { status: "pending" })).data ?? [];
    const pending = inbox.find((s) => s.product?.id === productId && s.component?.key === key);
    if (pending) {
      // The licences that grant it and cover a jurisdiction asked for (a registration that covers nowhere by itself counts automatically).
      const held = (await read("licence_provider", "list_my_licenses")).data.licences;
      const granting = new Set(pending.your_licences_granting_it.filter((l) => l.in_force).map((l) => l.id));
      const under = held.filter((h) => granting.has(h.id) && h.covers.some((c) => pending.requested_jurisdictions.includes(c)));
      if (!under.length) return stop("sponsorship approval", null, `none of the licence provider's verified licences covers ${pending.requested_jurisdictions.join(", ")}`);
      const decided = await write("licence_provider", "approve_sponsorship", { sponsorship_id: pending.id, licence_ids: under.map((h) => h.id) }, `approve the sponsorship under ${under.map((h) => h.license_id).join(", ")}`);
      if (decided) ours = await sponsorships();
    }
    missing = offered.filter((j) => !approvedIn().has(j));
    if (missing.length && !dryRun) return stop("sponsorship approval", null, `not sponsored in ${missing.join(", ")}`);
  }
  out.sponsorships = ours.filter((s) => s.status === "approved").map((s) => ({ id: s.id, jurisdictions: s.jurisdictions, licences: s.licences.map((l) => l.license_id) }));
  if (dryRun) {
    const check = await read("builder", "check_product_definition", { product_id: productId, definition: def });
    out.publish_blockers = check.data.publish_blockers ?? [];
    for (const b of out.publish_blockers) say(`publish blocker now: ${b.key} in ${b.jurisdiction ?? b.region}: ${b.reason}`);
  }

  // 6. Tested, published (unless its live definition already matches), and in the developer-ready catalogue.
  if (!live) {
    const report = await write("builder", "test_product", { id: productId }, `test '${productId}'`);
    if (report && !report.passed) throw new Error(`test_product failed: ${JSON.stringify(report.checks.filter((c) => c.status === "fail"))}`);
    if (report) out.test_warnings = report.checks.filter((c) => c.status === "warn").map((c) => `${c.name}: ${c.message}`);
    await write("builder", "publish_product", { id: productId }, `publish '${productId}'`);
  } else say(`'${productId}': live definition already matches, not republished`);
  if (dryRun) return { ...out, stopped_at: "publish", reason: "dry run: nothing was changed" };
  for (let offset = 0; ; offset += 100) {
    const page = (await read("builder", "list_products", { developer_ready: true, region: fixture.region ?? "US", limit: 100, offset })).data;
    if (page.products.some((p) => p.id === productId)) out.developer_ready = true;
    if (out.developer_ready || offset + 100 >= page.total) break;
  }
  if (!out.developer_ready) return stop("developer-ready", null, `'${productId}' is published but not in list_products with developer_ready`);
  say(`'${productId}' is developer-ready, sponsored by '${lp.name}' in ${offered.join(", ")}`);
  return { ...out, done: true };
}
