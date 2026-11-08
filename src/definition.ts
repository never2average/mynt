import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { partyActive } from "./parties.js";
import { normalizeModel } from "./regulatory.js";
import { checkVendorHandoffs } from "./vendors.js";
import type { Component, PartyBinding } from "./regime.js";
import type { FinancialProduct } from "./catalog.js";
import type { ProductRecord, Store } from "./store.js";

// A v2 product definition (schemas/financial-product.v2.schema.json): components (line × action) joined by
// typed composition links, with segments, algorithms, risk models, handoffs, terms, rates, fees, limits,
// servicing policies, lifecycle events and costs around them, every link a typed connection. Upstream
// contracts (register, legal entity, roster, GRC folders) are connection targets, never copied.
//
// Mynt checks a definition in three layers: the JSON Schema; references (every connection end resolves,
// upstream ids are real and current); and the composition rules the schema records but can't express
// (allowed primitive × action at each end, providers, handoffs, primary risk models, governance). It then
// bridges the definition onto the v1 shapes, so the regime, pins and drift checks run unchanged, and
// projects it onto the catalogue record every existing consumer reads.

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (opts: object) => { compile: (s: object) => AjvValidate };
const addFormats = require("ajv-formats").default as (ajv: unknown) => void;
type AjvValidate = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string; params?: Record<string, unknown> }[] | null };

export const DEFINITION_SCHEMA_PATH = fileURLToPath(new URL("../schemas/financial-product.v2.schema.json", import.meta.url));
let compiled: { validate: AjvValidate; schema: Record<string, unknown> } | null = null;
function schemaValidator() {
  if (!compiled) {
    const schema = JSON.parse(readFileSync(DEFINITION_SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = { validate: ajv.compile(schema), schema };
  }
  return compiled;
}

type Node = { _id?: string; key?: string; [k: string]: unknown };
type End = { kind: string; id?: string; licence_id?: string; section?: string; party_id?: string; product_id?: string; regulator_id?: string; license_type_id?: string };
type Connection = { _id: string; type: string; from: End; to: End; attributes?: Record<string, unknown> };
export interface Definition {
  _id: string;
  product_name: string;
  product_type: string;
  descriptions: { summary: string; key_features: string[] };
  owner_entity_id: string | null;
  version: number;
  access_mode?: "open" | "approval" | "private";
  offered_in?: string[];
  builds_on?: { product_id: string; funds?: string[]; settles_from?: string[]; note?: string }[];
  components?: (Node & { key: string; country: string; primitive: Component["primitive"]; action: Component["action"]; underlying?: Component["underlying"]; wrapper?: Component["wrapper"] })[];
  connections?: Connection[];
  projection?: { lead_component?: string; risk_level?: string; liquidity?: string; typical_horizon?: string; return_type?: string };
  terms?: Node[];
  rates?: Node[];
  [k: string]: unknown;
}

// Node collections and the id each is keyed by.
const COLLECTIONS: Record<string, { field: string; key: "_id" | "key" }> = {
  component: { field: "components", key: "key" },
  customer_segment: { field: "customer_segments", key: "_id" },
  core_algorithm: { field: "core_algorithms", key: "_id" },
  risk_model: { field: "risk_models", key: "_id" },
  partner_handoff: { field: "partner_handoffs", key: "_id" },
  term: { field: "terms", key: "_id" },
  rate: { field: "rates", key: "_id" },
  fee: { field: "fees", key: "_id" },
  limit: { field: "limits", key: "_id" },
  servicing_policy: { field: "servicing_policies", key: "_id" },
  lifecycle_event: { field: "lifecycle_events", key: "_id" },
  cost: { field: "costs", key: "_id" },
};

const list = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
const conns = (def: Definition) => list<Connection>(def.connections);
const components = (def: Definition) => list<NonNullable<Definition["components"]>[number]>(def.components);

// "credit:issuance|sale", "any", "any:assessment", "core_algorithm", "exchange:issuance (underlying cash)"
function endAllows(spec: string, c: { primitive: string; action: string; underlying?: string } | null, kind: string) {
  const s = spec.trim();
  if (s === "any") return true;
  if (!s.includes(":")) return s === kind;
  if (!c) return false;
  const m = s.match(/^([a-z_]+):([a-z_|]+)(?:\s*\(([^)]*)\))?$/);
  if (!m) return true;
  const [, primitive, actions, note] = m;
  if (primitive !== "any" && primitive !== c.primitive) return false;
  if (!actions.split("|").includes(c.action)) return false;
  const underlying = note?.match(/underlying (\w+)/)?.[1];
  return !(underlying && c.underlying && c.underlying !== underlying);
}

export interface DefinitionCheck {
  errors: string[];
  warnings: string[];
}

// The three layers of checks. `record` is the product the definition is for (null for a dry run).
export async function checkDefinition(store: Store, record: ProductRecord | null, def: Definition): Promise<DefinitionCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { validate, schema } = schemaValidator();
  if (!validate(def)) {
    for (const e of validate.errors ?? []) errors.push(`${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? ` (${(e.params.allowedValues as string[]).join(", ")})` : ""}`);
    // Structural errors make the deeper checks noise.
    return { errors: [...new Set(errors)].slice(0, 50), warnings };
  }

  if ((def.plane as { role?: string } | undefined)?.role === "variant")
    return { errors: ["Variants (a template plus a patch) can't be saved yet: save the resolved product as plane.role 'standalone'"], warnings };

  // Nodes: unique ids per collection.
  const nodes = new Map<string, Map<string, Node>>();
  for (const [kind, { field, key }] of Object.entries(COLLECTIONS)) {
    const m = new Map<string, Node>();
    for (const n of list<Node>(def[field])) {
      const id = n[key] as string;
      if (m.has(id)) errors.push(`${field}: '${id}' is used twice`);
      m.set(id, n);
    }
    nodes.set(kind, m);
  }
  const connIds = new Set<string>();
  for (const c of conns(def)) {
    if (connIds.has(c._id)) errors.push(`connections: '${c._id}' is used twice`);
    connIds.add(c._id);
  }

  // Upstream context.
  const entityId = record?.entity_id ?? null;
  if (record && def.owner_entity_id !== entityId) errors.push(`owner_entity_id must be the product's firm (${entityId ?? "none: a Mynt reference product"})`);
  if (record && def._id !== record.product.id) errors.push(`_id must be the product id '${record.product.id}'`);
  const [held, roster, grc, ref] = await Promise.all([
    entityId ? store.licensesOf(entityId) : Promise.resolve([]),
    entityId ? store.partiesOf(entityId) : Promise.resolve([]),
    entityId ? store.grcRecords(entityId) : Promise.resolve([]),
    store.referenceData(true),
  ]);
  const regions = [...new Set(components(def).map((c) => c.country.toUpperCase()))];
  for (const j of def.offered_in ?? [])
    if (!components(def).some((c) => j === c.country || j.startsWith(`${c.country}-`))) errors.push(`offered_in: '${j}' isn't in any component's country`);
  const models = regions.map((r) => normalizeModel(ref.regions.find((x) => x.code === r)?.regulatory));

  const comp = nodes.get("component")!;
  const sponsorIds = [...new Set(conns(def).flatMap((c) => [c.from, c.to]).filter((e) => e.kind === "sponsor" && e.id).map((e) => e.id!))];
  const sponsors = new Set((await Promise.all(sponsorIds.map((id) => store.getEntity(id)))).filter((e) => e).map((e) => e!.id));
  const resolve = (end: End, at: string): boolean => {
    if (COLLECTIONS[end.kind]) {
      if (!nodes.get(end.kind)!.has(end.id ?? "")) {
        errors.push(`${at}: no ${end.kind} '${end.id}'`);
        return false;
      }
      return true;
    }
    switch (end.kind) {
      case "product":
        return true;
      case "owner":
        if (!entityId) errors.push(`${at}: a reference product has no owner`);
        else if (end.licence_id && !held.some((h) => h.id === end.licence_id)) errors.push(`${at}: the owner holds no licence '${end.licence_id}'`);
        return true;
      // A licence provider sponsoring a component: a firm on Mynt other than the owner's (see sponsorships.ts).
      case "sponsor":
        if (!entityId) errors.push(`${at}: a reference product names no sponsor`);
        else if (end.id === entityId) errors.push(`${at}: the owner can't sponsor its own product; provide it as the owner`);
        else if (!sponsors.has(end.id ?? "")) errors.push(`${at}: no firm '${end.id}' on Mynt to sponsor it`);
        return true;
      case "party": {
        const p = roster.find((x) => x.id === end.id);
        if (!p) errors.push(`${at}: party '${end.id}' isn't on the owner's roster`);
        else if (!partyActive(p)) errors.push(`${at}: party '${end.id}' isn't active`);
        return Boolean(p);
      }
      case "grc_record": {
        const r = grc.find((x) => x.id === end.id && x.status === "current");
        if (!r) errors.push(`${at}: no current record '${end.id}' in the owner's GRC folders`);
        else {
          if (end.section && r.section !== end.section) errors.push(`${at}: record '${end.id}' is in ${r.section}, not ${end.section}`);
          if ((end.party_id ?? null) !== r.party_id) errors.push(`${at}: record '${end.id}' isn't in ${end.party_id ? `party ${end.party_id}'s` : "the entity's"} folder`);
          if (end.product_id && r.product_id !== end.product_id) errors.push(`${at}: record '${end.id}' isn't in product '${end.product_id}''s folder`);
        }
        return Boolean(r);
      }
      case "register_persona": {
        const reg = models.flatMap((m) => m.regulators).find((r) => r.id === end.regulator_id);
        if (!reg) errors.push(`${at}: no regulator '${end.regulator_id}' where this product's components are regulated`);
        else if (!reg.scope.customer_personas.some((p) => p.id === end.id)) errors.push(`${at}: ${end.regulator_id} defines no customer persona '${end.id}'`);
        return Boolean(reg);
      }
      case "register_item": {
        const lic = models.flatMap((m) => m.regulators).find((r) => r.id === end.regulator_id)?.license_types.find((l) => l._id === end.license_type_id);
        const section = end.section ?? "";
        const items = lic ? [...((lic.grc.registers as Record<string, { id: string }[]>)[section] ?? []), ...((lic.grc.repositories as Record<string, { id?: string }[]>)[section] ?? [])] : [];
        if (!lic) errors.push(`${at}: no licence type '${end.license_type_id}' under '${end.regulator_id}'`);
        else if (!items.some((i) => i.id === end.id)) errors.push(`${at}: ${end.license_type_id} has no ${section} item '${end.id}'`);
        return Boolean(lic);
      }
      default:
        errors.push(`${at}: unknown end kind '${end.kind}'`);
        return false;
    }
  };

  // References and allowed ends.
  const defs = schema.$defs as Record<string, { "x-from"?: string[]; "x-to"?: string[]; "x-composition"?: boolean }>;
  for (const c of conns(def)) {
    const at = `connection '${c._id}' (${c.type})`;
    const okFrom = resolve(c.from, `${at} from`);
    const okTo = resolve(c.to, `${at} to`);
    const spec = defs[`conn_${c.type}`];
    if (!spec?.["x-composition"] || !okFrom || !okTo) continue;
    const f = c.from.kind === "component" ? (comp.get(c.from.id!) as { primitive: string; action: string; underlying?: string }) : null;
    const t = c.to.kind === "component" ? (comp.get(c.to.id!) as { primitive: string; action: string; underlying?: string }) : null;
    if (spec["x-from"] && !spec["x-from"].some((s) => endAllows(s, f, c.from.kind)))
      errors.push(`${at}: '${c.from.id}' (${f ? `${f.primitive}:${f.action}` : c.from.kind}) can't be the source; allowed: ${spec["x-from"].join(", ")}`);
    if (spec["x-to"] && !spec["x-to"].some((s) => endAllows(s, t, c.to.kind)))
      errors.push(`${at}: '${c.to.id}' (${t ? `${t.primitive}:${t.action}` : c.to.kind}) can't be the target; allowed: ${spec["x-to"].join(", ")}`);
    if (c.from.kind === "component" && c.from.id === c.to.id) errors.push(`${at}: a component can't link to itself`);
  }

  // Composition rules the schema records as x-cardinality.
  const of = (type: string) => conns(def).filter((c) => c.type === type);
  const provided = of("component_provided_by");
  for (const key of comp.keys()) {
    const p = provided.filter((c) => c.from.id === key);
    if (entityId && p.length !== 1) errors.push(`component '${key}' needs exactly one component_provided_by (has ${p.length})`);
    if (!entityId && p.length) errors.push(`component '${key}': a Mynt reference product names no providers`);
    const party = p[0]?.to.kind === "party" ? p[0].to.id : null;
    if (party) {
      const served = of("handoff_serves_component").filter((h) => h.to.id === key).map((h) => h.from.id);
      if (!of("handoff_to_party").some((h) => h.to.id === party && served.includes(h.from.id)))
        errors.push(`component '${key}' is provided by party ${party}: add a partner handoff to that party that serves '${key}'`);
    }
  }
  for (const h of nodes.get("partner_handoff")!.keys()) {
    const n = of("handoff_to_party").filter((c) => c.from.id === h).length;
    if (n !== 1) errors.push(`partner handoff '${h}' needs exactly one handoff_to_party (has ${n})`);
  }
  // Handoffs bound to a vendor's standard service (see vendors.ts).
  errors.push(...(await checkVendorHandoffs(store, entityId ?? def.owner_entity_id, of("handoff_to_party"), [...nodes.get("partner_handoff")!.values()] as never)));
  for (const a of nodes.get("core_algorithm")!.keys()) {
    const uses = of("algorithm_uses_risk_model").filter((c) => c.from.id === a);
    const primary = uses.filter((c) => c.attributes?.role === "primary").length;
    if (uses.length && primary !== 1) errors.push(`algorithm '${a}' needs exactly one primary risk model (has ${primary})`);
  }
  // Whoever is accountable for a model's governance is an internal party on the roster.
  for (const c of of("risk_model_governed_by")) {
    const owner = roster.find((p) => p.id === c.attributes?.owner_party_id);
    if (!owner) errors.push(`connection '${c._id}': owner_party_id isn't on the owner's roster`);
    else if (owner.kind !== "internal" || !partyActive(owner)) errors.push(`connection '${c._id}': owner_party_id must be an active internal party (a person at the firm)`);
  }
  for (const m of nodes.get("risk_model")!.keys()) {
    const gov = of("risk_model_governed_by").filter((c) => c.from.id === m);
    if (!gov.length) errors.push(`risk model '${m}' needs a risk_model_governed_by link to a GRC record`);
    else if (!gov.some((c) => ["controls", "risk_models"].includes(c.to.section ?? ""))) errors.push(`risk model '${m}': at least one governance link must target a controls or risk_models record`);
  }
  if (entityId && of("party_plays_role").filter((c) => c.attributes?.role === "product_owner").length !== 1)
    errors.push("an owned product needs exactly one party_plays_role with role product_owner");
  const priced = new Set<string>();
  for (const c of of("discovers_price_for")) {
    for (const term of list<string>(c.attributes?.discovers)) {
      const k = `${c.to.id}/${term}`;
      if (priced.has(k)) errors.push(`'${term}' on '${c.to.id}' is discovered by more than one marketplace`);
      priced.add(k);
    }
  }
  // Products it's built on: real, not itself, linked to real components, and not re-declared here.
  for (const b of def.builds_on ?? []) {
    const at = `builds_on '${b.product_id}'`;
    if (b.product_id === def._id) {
      errors.push(`${at}: a product can't be built on itself`);
      continue;
    }
    const base = await store.getProduct(b.product_id);
    if (!base) {
      errors.push(`${at}: no product '${b.product_id}'`);
      continue;
    }
    if (base.status !== "published") warnings.push(`${at} isn't published yet: publishing this product needs it live`);
    for (const key of [...(b.funds ?? []), ...(b.settles_from ?? [])]) if (!comp.has(key)) errors.push(`${at}: no component '${key}'`);
    const baseComponents = base.status === "published" && base.pins ? base.pins.components : base.components;
    if (!baseComponents.length) warnings.push(`${at} has no composition, so there's no coverage to inherit from it`);
    for (const c of components(def))
      if (baseComponents.some((x) => x.country === c.country && x.primitive === c.primitive && x.action === c.action && (x.underlying ?? null) === (c.underlying ?? null)))
        warnings.push(`component '${c.key}' re-declares ${c.primitive}:${c.action}, which '${b.product_id}' already provides; build on it instead`);
  }
  const lead = def.projection?.lead_component;
  if (lead && !comp.has(lead)) errors.push(`projection.lead_component '${lead}' isn't a component`);
  if (def.descriptions.key_features.length < 2) warnings.push("the catalogue's tests want at least 2 key features");
  return { errors, warnings };
}

// The products a definition is built on: its builds_on when it declares one, else what the product records.
export const underlyingOf = (def: Definition, record: Pick<ProductRecord, "underlying_product_ids">) =>
  def.builds_on ? def.builds_on.map((b) => b.product_id) : record.underlying_product_ids;

// The v1 composition the regime, pins and drift checks read.
export function toV1Composition(def: Definition): { components: Component[]; parties: PartyBinding[] } {
  const provided = conns(def).filter((c) => c.type === "component_provided_by");
  const out: Component[] = components(def).map((c) => {
    const p = provided.find((x) => x.from.id === c.key)?.to;
    const provider: Component["provider"] =
      p?.kind === "owner"
        ? { by: "self", ...(p.licence_id ? { licence_id: p.licence_id } : {}) }
        : p?.kind === "party"
          ? { by: "party", party_id: p.id! }
          : p?.kind === "sponsor"
            ? { by: "sponsor", entity_id: p.id! }
            : undefined;
    const offered = (def.offered_in ?? []).filter((j) => j === c.country || j.startsWith(`${c.country}-`));
    return {
      key: c.key,
      country: c.country,
      primitive: c.primitive,
      action: c.action,
      ...(c.underlying ? { underlying: c.underlying } : {}),
      ...(c.wrapper ? { wrapper: c.wrapper } : {}),
      ...(provider ? { provider } : {}),
      ...(offered.length ? { offered_in: offered } : {}),
    };
  });
  const seen = new Set<string>();
  const parties: PartyBinding[] = [];
  const bind = (party_id: string | undefined, forKey: string | undefined) => {
    if (!party_id || !forKey || seen.has(`${party_id}/${forKey}`)) return;
    seen.add(`${party_id}/${forKey}`);
    parties.push({ party_id, for: forKey });
  };
  for (const c of conns(def)) if (c.type === "party_plays_role" && c.to.kind === "party") bind(c.to.id, c.attributes?.bound_component as string);
  const served = conns(def).filter((c) => c.type === "handoff_serves_component");
  for (const h of conns(def).filter((c) => c.type === "handoff_to_party")) for (const s of served.filter((x) => x.from.id === h.from.id)) bind(h.to.id, s.to.id);
  return { components: out, parties };
}

const NOT_APPLICABLE_LEADS = ["credit", "payments", "exchange", "information"];
const RATE_TO_RETURN: Record<string, FinancialProduct["return_type"]> = {
  fixed: "fixed_interest",
  floating: "variable_interest",
  variable: "variable_interest",
  index_linked: "inflation_linked",
  inflation_linked: "inflation_linked",
  market_linked: "market_linked",
};

// The catalogue record, by the schema's x-projection rules; projection.* pins the judgement fields.
export function projectCatalogue(def: Definition, regulator: string): FinancialProduct {
  const comps = components(def);
  const lead = comps.find((c) => c.key === def.projection?.lead_component) ?? comps[0];
  const countries = [...new Set(comps.map((c) => c.country))];
  const na = NOT_APPLICABLE_LEADS.includes(lead.primitive);
  const tenor = list<Node>(def.terms).find((t) => /tenor|term_months|maturity/.test(String(t._id)) && typeof t.default === "number");
  const months = tenor ? (String(tenor.unit ?? "months").startsWith("year") ? Number(tenor.default) * 12 : Number(tenor.default)) : null;
  const horizon = months == null ? "medium" : months < 12 ? "short" : months <= 36 ? "short_to_medium" : months <= 60 ? "medium" : months <= 120 ? "medium_to_long" : "long";
  const rateType = String(list<Node>(def.rates)[0]?.rate_type ?? "");
  const p = def.projection ?? {};
  return {
    id: def._id,
    name: def.product_name,
    product_line: lead.primitive,
    category: def.product_type,
    region: countries.length === 1 ? countries[0].toUpperCase() : "global",
    risk_level: p.risk_level ?? (na ? "not_applicable" : "moderate"),
    liquidity: p.liquidity ?? (na ? "not_applicable" : "moderate"),
    typical_horizon: p.typical_horizon ?? horizon,
    return_type: p.return_type ?? (lead.primitive === "credit" || na ? "cost_of_credit" : (RATE_TO_RETURN[rateType] ?? "fixed_interest")),
    regulator,
    description: def.descriptions.summary,
    key_features: def.descriptions.key_features,
  };
}

// A stable hash over every node and connection, pinned at publish.
export function definitionHash(def: Definition): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  const { pins: _pins, drift: _drift, ...rest } = def as Record<string, unknown>;
  return "sha256:" + createHash("sha256").update(JSON.stringify(stable(rest))).digest("hex");
}
