// Applies a region's regulatory model, kept as data in schemas/regulatory/<region>.json, through Mynt's own
// admin tools. Shared by scripts/apply-regulatory-model.mjs (against a live server, over MCP) and its test (an
// in-process server), so what the test checks is exactly what the script does.
//
// The file holds, in the order they're applied:
//   region                    define_region (its name and the regulators' short names), when given
//   product_categories        define_product_category, for each category not already there
//   regulated_product_types   define_regulated_product_type
//   legislation               define_legislation (acts, regulations, guidance the obligations cite)
//   regulators                define_regulator (scope, licence types and their GRC)
//   service_types             load_service_types for the region, with its licence_map
//
// `call(name, input)` returns { isError, data }. Nothing is written when `dryRun` is set: every item is checked
// against the server's own input schema for its tool, and the plan (what would be added or replaced) is returned.

import Ajv from "ajv";
import addFormats from "ajv-formats";

const STEPS = [
  { key: "product_categories", tool: "define_product_category", id: (x) => x.id, input: (x) => x },
  { key: "regulated_product_types", tool: "define_regulated_product_type", id: (x) => x.id, input: (x, region) => ({ region, product_type: x }) },
  { key: "legislation", tool: "define_legislation", id: (x) => x.id, input: (x, region) => ({ region, instrument: x }) },
  { key: "regulators", tool: "define_regulator", id: (x) => x.id, input: (x, region) => ({ region, regulator: x }) },
];

// A list tool's answer, or nothing when it refused (e.g. the region isn't defined yet).
const listOf = (r) => (!r.isError && Array.isArray(r.data) ? r.data : []);

export async function applyRegulatoryModel({ call, listTools, model, dryRun = false, say = () => {} }) {
  const region = model.region;
  if (!/^[A-Z]{2}$/.test(region ?? "")) throw new Error("The model needs a region, an ISO country code like US");

  // What's there already, so the plan can say what changes.
  const existing = {
    product_categories: new Set(listOf(await call("list_product_categories", {})).map((c) => c.id)),
    regulated_product_types: new Set(listOf(await call("list_regulated_product_types", { region })).map((t) => t.id)),
    legislation: new Set(),
    regulators: new Set(),
  };
  for (const r of model.regulators ?? []) if (!(await call("get_regulator", { region, regulator_id: r.id })).isError) existing.regulators.add(r.id);
  const legal = await call("list_legal_instruments", { region });
  for (const l of legal.isError ? [] : (legal.data.legislative ?? [])) existing.legislation.add(l.id);

  // Every item is checked against the input schema the server itself publishes for its tool.
  const schemas = Object.fromEntries((await listTools()).map((t) => [t.name, t.inputSchema]));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const problems = [];
  const plan = [];
  if (model.region_definition) {
    plan.push({ tool: "define_region", id: region, change: "update" });
    if (!schemas.define_region) problems.push("This server has no define_region tool: sign in as an admin");
  }
  for (const s of STEPS) {
    const schema = schemas[s.tool];
    if (!schema) {
      if ((model[s.key] ?? []).length) problems.push(`This server has no ${s.tool} tool: sign in as an admin`);
      continue;
    }
    const validate = ajv.compile(schema);
    for (const item of model[s.key] ?? []) {
      const input = s.input(item, region);
      if (!validate(input)) problems.push(`${s.key} '${s.id(item)}': ${ajv.errorsText(validate.errors)}`);
      plan.push({ tool: s.tool, id: s.id(item), change: existing[s.key].has(s.id(item)) ? "replace" : "add" });
    }
  }
  if (model.service_types) plan.push({ tool: "load_service_types", id: region, change: "load" });
  if (problems.length) return { applied: false, plan, problems };
  if (dryRun) return { applied: false, plan, problems: [] };

  const results = [];
  const step = async (tool, id, input) => {
    const r = await call(tool, input);
    if (r.isError) throw new Error(`${tool} '${id}' failed: ${JSON.stringify(r.data)}`);
    results.push({ tool, id, warnings: r.data?.warnings ?? [] });
    say(`${tool} ${id}: done${r.data?.warnings?.length ? `; warnings: ${r.data.warnings.join("; ")}` : ""}`);
    return r.data;
  };
  if (model.region_definition) await step("define_region", region, { code: region, ...model.region_definition });
  for (const s of STEPS) for (const item of model[s.key] ?? []) await step(s.tool, s.id(item), s.input(item, region));
  let services = null;
  if (model.service_types) {
    services = await step("load_service_types", region, { region, licence_map: model.service_types.licence_map ?? {} });
    for (const sk of services.skipped ?? []) say(`  service type ${sk.file} skipped: ${sk.errors.join("; ")}`);
  }
  return { applied: true, plan, problems: [], results, services };
}
