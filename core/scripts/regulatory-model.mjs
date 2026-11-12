// Applies a region's regulatory model, kept as data in schemas/regulatory/<region>.json, through Mynt's own
// admin tools. Shared by scripts/apply-regulatory-model.mjs (against a live server, over MCP) and its tests (an
// in-process server), so what the tests check is exactly what the script does.
//
// The file holds, in the order they're applied:
//   region                    define_region (its name and the regulators' short names), when given
//   product_categories        define_product_category
//   regulated_product_types   define_regulated_product_type
//   legislation               define_legislation (acts, regulations, guidance the obligations cite)
//   regulators                define_regulator (scope, licence types and their GRC)
//   service_types             load_service_types for the region, with its licence_map
//
// Merge, never replace. The define_* tools replace a whole item (define_regulator replaces the whole regulator:
// every licence type, persona, product-type mapping and GRC register). So for each item in the file the server's
// current version is read first and the file is deep-merged into it, and the merged whole is what's sent:
//   - lists of items with an id (`_id`, `id`, a field's `key`, or a repository item's title and date) are merged
//     by id: the file's items update the matching ones, new ones are added after them, and items that aren't in
//     the file are always kept;
//   - objects are merged field by field: a field the file doesn't give keeps its value;
//   - plain lists (actions, covers, product lines, tags, application steps...) and plain values take the file's
//     value.
// The only way merging can lose anything is a plain list in the file that lacks an entry the server has (an
// action dropped, a state no longer covered). Every such entry is listed as "would remove", and the run is
// refused unless `allowRemovals` is set (the script's --allow-removals); even then they are listed. Service types
// work the same way: a shipped example that would overwrite a different version already on the server counts as
// a removal. Items that end up unchanged aren't sent at all.
//
// `call(name, input)` returns { isError, data }. Nothing is written when `dryRun` is set: every merged item is
// checked against the server's own input schema for its tool, and the plan (per item: added, updated, would
// remove) is returned.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// A list tool's answer, or nothing when it refused (e.g. the region isn't defined yet).
const listOf = (r) => (!r.isError && Array.isArray(r.data) ? r.data : []);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const stable = (v) => (Array.isArray(v) ? v.map(stable) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v);
export const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// The id an item in a list is merged by, or undefined when it has none.
const keyOf = (x) => {
  if (!isObject(x)) return undefined;
  for (const k of ["_id", "id", "key"]) if (typeof x[k] === "string") return x[k];
  if (typeof x.title === "string") return `${x.title}${x.date ? ` (${x.date})` : ""}`;
  return undefined;
};
const keyed = (list) => Array.isArray(list) && list.length > 0 && list.every((x) => keyOf(x) !== undefined);

// The server's version with the file's merged in (see the top of this file).
export function mergeItem(current, file) {
  if (file === undefined) return current;
  if (current === undefined || current === null) return file;
  if (Array.isArray(file) || Array.isArray(current)) {
    const cur = Array.isArray(current) ? current : [current];
    const next = Array.isArray(file) ? file : [file];
    if (keyed(cur) || keyed(next)) {
      if (!keyed(cur) && cur.length) return next; // a shape we can't merge by id: the file's, and the diff lists what goes
      const byKey = new Map(next.filter((x) => keyOf(x) !== undefined).map((x) => [keyOf(x), x]));
      const merged = cur.map((x) => (byKey.has(keyOf(x)) ? mergeItem(x, byKey.get(keyOf(x))) : x));
      const seen = new Set(cur.map(keyOf));
      return [...merged, ...next.filter((x) => !seen.has(keyOf(x)))];
    }
    return next;
  }
  if (isObject(current) && isObject(file)) {
    const out = { ...current };
    for (const [k, v] of Object.entries(file)) out[k] = mergeItem(current[k], v);
    return out;
  }
  return file;
}

// What merging changed, from the server's version to the merged one: items added and updated (by their path of
// ids), and entries of plain lists that would be removed.
const LABELS = {
  customer_personas: "persona",
  product_types: "product type",
  license_types: "licence",
  obligations: "obligation",
  reporting_disclosure_filings: "filing",
  risks: "risk",
  controls: "control",
  inspection_events: "inspection event",
  regulatory_communications: "communication",
  enforcement_actions: "enforcement action",
  press_releases: "press release",
  policies: "policy",
  risk_models: "risk model",
  inspection_history: "inspection record",
  allowed_product_types: "grant",
  internal: "internal stakeholder",
  external: "external stakeholder",
  fields: "field",
};
const show = (v) => (typeof v === "string" ? v : JSON.stringify(v));

export function diffItem(current, merged, path = []) {
  const out = { added: [], updated: [], removed: [] };
  // Each returns the names of the fields that changed in this item (keyed sub-items are reported on their own).
  const walk = (cur, next, where, field) => {
    if (Array.isArray(cur) || Array.isArray(next)) {
      const a = cur === undefined ? [] : Array.isArray(cur) ? cur : [cur];
      const b = next === undefined ? [] : Array.isArray(next) ? next : [next];
      if (keyed(a) || keyed(b)) {
        const label = LABELS[field] ?? field;
        const before = new Map(a.map((x) => [keyOf(x), x]));
        const after = new Map(b.map((x) => [keyOf(x), x]));
        for (const [k, x] of after) {
          const p = [...where, `${label} ${k}`];
          if (!before.has(k)) out.added.push(p.join(" › "));
          else {
            const fields = walkObject(before.get(k), x, p);
            if (fields.length) out.updated.push(`${p.join(" › ")} (${fields.join(", ")})`);
          }
        }
        for (const k of before.keys()) if (!after.has(k)) out.removed.push([...where, `${label} ${k}`].join(" › "));
        return [];
      }
      const kept = b.map((x) => JSON.stringify(stable(x)));
      for (const x of a) if (!kept.includes(JSON.stringify(stable(x)))) out.removed.push(`${[...where, field].join(" › ")}: ${show(x)}`);
      return same(a, b) ? [] : [field];
    }
    if (isObject(cur) && isObject(next)) return walkObject(cur, next, [...where, field]).map((f) => `${field}.${f}`);
    return same(cur, next) ? [] : [field];
  };
  const walkObject = (cur, next, where) => [...new Set([...Object.keys(cur ?? {}), ...Object.keys(next ?? {})])].flatMap((k) => walk(cur?.[k], next?.[k], where, k));
  const fields = walkObject(current, merged, path);
  if (fields.length) out.updated.unshift(`fields: ${fields.join(", ")}`);
  return { ...out, changed: fields.length > 0 || out.added.length > 0 || out.updated.length > 0 };
}

// A regulator as get_regulator returns it, in the shape define_regulator takes.
function regulatorInput(r) {
  const { scope = {}, license_types = [], ...rest } = r;
  return {
    ...rest,
    scope: {
      ...scope,
      product_types: (scope.product_types ?? []).map((p) => ({ id: p.id, actions: p.actions ?? p.action })),
      customer_personas: scope.customer_personas ?? [],
    },
    license_types: license_types.map((l) => ({
      ...l,
      grc: {
        ...l.grc,
        // A grant the server couldn't resolve to any action goes back as the bare id it was stored as.
        allowed_product_types: (l.grc?.allowed_product_types ?? []).map((g) => (typeof g === "string" || !g.actions?.length ? (g.id ?? g) : g)),
      },
    })),
  };
}

// The file's regulator with the shorthand spelled out, so merging compares like with like: a supervised product
// type without actions takes all of the product type's, a licence grant that's a bare id takes everything the
// regulator supervises on it.
function resolveRegulator(r, catalogue, currentScope) {
  const scopeActions = new Map((currentScope ?? []).map((p) => [p.id, p.actions]));
  const product_types = r.scope?.product_types?.map((p) => {
    const actions = p.actions === undefined ? catalogue.get(p.id)?.actions : Array.isArray(p.actions) ? p.actions : [p.actions];
    if (actions) scopeActions.set(p.id, actions);
    return actions ? { id: p.id, actions } : { id: p.id };
  });
  const license_types = r.license_types?.map((l) => {
    const grants = l.grc?.allowed_product_types?.map((g) => {
      const id = typeof g === "string" ? g : g.id;
      const actions = typeof g === "string" || g.actions === undefined ? scopeActions.get(id) : Array.isArray(g.actions) ? g.actions : [g.actions];
      return actions ? { id, actions } : id;
    });
    return grants ? { ...l, grc: { ...l.grc, allowed_product_types: grants } } : l;
  });
  return {
    ...r,
    ...(r.scope ? { scope: { ...r.scope, ...(product_types ? { product_types } : {}) } } : {}),
    ...(license_types ? { license_types } : {}),
  };
}

const strip = (x, ...fields) => Object.fromEntries(Object.entries(x).filter(([k]) => !fields.includes(k)));

// Service-type examples as load_service_types would store them, for comparing with what the server has.
function exampleAsLoaded(example, licenceMap) {
  const t = { ...example };
  for (const k of ["innovator_licences", "vendor_licences"]) if (Array.isArray(t[k])) t[k] = t[k].map((id) => licenceMap[id] ?? id);
  return t;
}
const subsetOf = (part, whole) =>
  isObject(part) ? isObject(whole) && Object.entries(part).every(([k, v]) => subsetOf(v, whole[k])) : same(part, whole);

// The service types load_service_types ships for a region (schemas/service-types/<region>/), as the server has them.
export function shippedServiceTypes(region) {
  const dir = new URL(`../schemas/service-types/${String(region).toLowerCase()}/`, import.meta.url);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
}

export async function applyRegulatoryModel({ call, listTools, model, dryRun = false, allowRemovals = false, serviceTypeExamples, say = () => {} }) {
  const region = model.region;
  if (!/^[A-Z]{2}$/.test(region ?? "")) throw new Error("The model needs a region, an ISO country code like US");
  serviceTypeExamples ??= shippedServiceTypes(region);

  // What's there already: each item's current version, by id.
  const current = {
    product_categories: new Map(listOf(await call("list_product_categories", {})).map((c) => [c.id, strip(c, "updated_at")])),
    regulated_product_types: new Map(
      listOf(await call("list_regulated_product_types", { region })).map((t) => [t.id, strip(t, "supervised_by", "region", "updated_at")]),
    ),
    legislation: new Map(),
    regulators: new Map(),
  };
  const legal = await call("list_legal_instruments", { region });
  for (const l of legal.isError ? [] : (legal.data.legislative ?? [])) current.legislation.set(l.id, l);
  for (const r of model.regulators ?? []) {
    const got = await call("get_regulator", { region, regulator_id: r.id });
    if (!got.isError) current.regulators.set(r.id, regulatorInput(got.data));
  }

  // The product types regulators' scopes resolve against: the server's, with the file's merged in.
  const catalogue = new Map(current.regulated_product_types);
  for (const t of model.regulated_product_types ?? []) catalogue.set(t.id, mergeItem(catalogue.get(t.id), t));

  const STEPS = [
    { key: "product_categories", tool: "define_product_category", id: (x) => x.id, input: (x) => x },
    { key: "regulated_product_types", tool: "define_regulated_product_type", id: (x) => x.id, input: (x) => ({ region, product_type: x }) },
    { key: "legislation", tool: "define_legislation", id: (x) => x.id, input: (x) => ({ region, instrument: x }) },
    {
      key: "regulators",
      tool: "define_regulator",
      id: (x) => x.id,
      input: (x) => ({ region, regulator: x }),
      prepare: (x) => resolveRegulator(x, catalogue, current.regulators.get(x.id)?.scope?.product_types),
    },
  ];

  // Every merged item is checked against the input schema the server itself publishes for its tool.
  const schemas = Object.fromEntries((await listTools()).map((t) => [t.name, t.inputSchema]));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const problems = [];
  const plan = [];
  const writes = [];
  const regionNow = listOf(await call("list_regions", { include_inactive: true })).find((r) => r.code === region);
  if (model.region_definition) {
    const rd = model.region_definition;
    const added = (rd.regulators ?? []).filter((n) => !(regionNow?.regulators ?? []).includes(n)).map((n) => `regulator name ${n}`);
    const updated = regionNow ? Object.keys(rd).filter((k) => k !== "regulators" && !same(rd[k], regionNow[k])).map((k) => `fields: ${k}`) : [];
    const change = !regionNow ? "add" : added.length || updated.length ? "update" : "keep";
    plan.push({ tool: "define_region", id: region, change, added, updated, removed: [] });
    if (!schemas.define_region) problems.push("This server has no define_region tool: sign in as an admin");
  }
  for (const s of STEPS) {
    const schema = schemas[s.tool];
    if (!schema) {
      if ((model[s.key] ?? []).length) problems.push(`This server has no ${s.tool} tool: sign in as an admin`);
      continue;
    }
    const validate = ajv.compile(schema);
    for (const raw of model[s.key] ?? []) {
      const item = s.prepare ? s.prepare(raw) : raw;
      const id = s.id(item);
      const there = current[s.key].get(id);
      const merged = mergeItem(there, item);
      const input = s.input(merged);
      if (!validate(input)) problems.push(`${s.key} '${id}': ${ajv.errorsText(validate.errors)}`);
      if (!there) {
        plan.push({ tool: s.tool, id, change: "add", added: [], updated: [], removed: [] });
        writes.push({ tool: s.tool, id, input });
        continue;
      }
      const d = diffItem(there, merged);
      plan.push({ tool: s.tool, id, change: d.changed || d.removed.length ? "update" : "keep", added: d.added, updated: d.updated, removed: d.removed });
      if (d.changed || d.removed.length) writes.push({ tool: s.tool, id, input });
    }
  }

  // Service types: load_service_types stores every shipped example for the region, replacing any with the same key.
  let loadServices = false;
  if (model.service_types) {
    const licenceMap = model.service_types.licence_map ?? {};
    const there = new Map(listOf(await call("list_service_types", { region })).map((t) => [t.key, t]));
    const step = { tool: "load_service_types", id: region, change: "keep", added: [], updated: [], removed: [] };
    for (const ex of serviceTypeExamples.filter((e) => e.region === region)) {
      const t = exampleAsLoaded(ex, licenceMap);
      const old = there.get(t.key);
      if (!old) step.added.push(`service type ${t.key}`);
      else if (!subsetOf(t, old)) step.removed.push(`service type ${t.key}: the server's version would be overwritten by the shipped example`);
    }
    if (step.added.length || step.removed.length) {
      step.change = "load";
      loadServices = true;
    }
    plan.push(step);
  }

  const removals = plan.flatMap((p) => p.removed.map((r) => `${p.tool} ${p.id}: ${r}`));
  if (removals.length && !allowRemovals)
    problems.push(`${removals.length} item(s) on the server would be removed or overwritten (listed under "would remove"); nothing was changed. Fix the file, or run again with --allow-removals if that's intended`);
  if (problems.length) return { applied: false, plan, problems, removals };
  if (dryRun) return { applied: false, plan, problems: [], removals };

  const results = [];
  const step = async (tool, id, input) => {
    const r = await call(tool, input);
    if (r.isError) throw new Error(`${tool} '${id}' failed: ${JSON.stringify(r.data)}`);
    results.push({ tool, id, warnings: r.data?.warnings ?? [] });
    say(`${tool} ${id}: done${r.data?.warnings?.length ? `; warnings: ${r.data.warnings.join("; ")}` : ""}`);
    return r.data;
  };
  if (model.region_definition && plan[0].change !== "keep") {
    // The region's regulator short names are merged with any already listed, never replaced.
    const regulators = [...new Set([...(regionNow?.regulators ?? []), ...(model.region_definition.regulators ?? [])])];
    await step("define_region", region, { code: region, ...model.region_definition, regulators });
  }
  for (const w of writes) await step(w.tool, w.id, w.input);
  let services = null;
  if (loadServices) {
    services = await step("load_service_types", region, { region, licence_map: model.service_types.licence_map ?? {} });
    for (const sk of services.skipped ?? []) say(`  service type ${sk.file} skipped: ${sk.errors.join("; ")}`);
  }
  return { applied: true, plan, problems: [], removals, results, services };
}

// The plan as the script prints it: one line per item, then what merging adds, updates and would remove.
export function formatPlan(plan) {
  const lines = [];
  for (const p of plan) {
    const counts = p.change === "update" || p.change === "load" ? ` (${p.added.length} added, ${p.updated.length} updated, ${p.removed.length} would remove)` : "";
    lines.push(`${p.change.padEnd(8)} ${p.tool} ${p.id}${counts}`);
    for (const a of p.added) lines.push(`           + ${a}`);
    for (const u of p.updated) lines.push(`           ~ ${u}`);
    for (const r of p.removed) lines.push(`           - would remove: ${r}`);
  }
  return lines;
}
