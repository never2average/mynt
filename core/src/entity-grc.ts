import { z } from "zod";
import { resolveFields, type FieldDef, type TemplateKind } from "./grc.js";
import { partyActive } from "./parties.js";
import { normalizeModel } from "./regulatory.js";
import type { GrcRecord, HeldLicense, Party, ReferenceData, Store } from "./store.js";

// A legal entity's GRC folder mirrors the GRC of each licence it holds: the same registers and
// repositories, filled with the entity's own records. Registers answer the regulator's data (each
// obligation's compliance status, each filing made, each risk assessed) or instantiate its templates
// (controls, inspection events); repositories hold the entity's communications and enforcement history
// and instantiate the policy, risk-model and inspection-history templates. Every party on the roster has a
// folder of the same shape for what it owns or what the relationship requires (a vendor's due diligence,
// the controls over it, its own enforcement history). Mynt matches the folder against each licence's GRC.

export const REGISTER_SECTIONS = ["obligations", "reporting_disclosure_filings", "risks", "controls", "inspection_events"] as const;
export const REPOSITORY_SECTIONS = ["regulatory_communications", "enforcement_actions", "press_releases", "policies", "risk_models", "inspection_history"] as const;
export const GRC_SECTIONS = [...REGISTER_SECTIONS, ...REPOSITORY_SECTIONS] as const;
export type GrcSection = (typeof GRC_SECTIONS)[number];
export const folderOf = (s: GrcSection) => ((REGISTER_SECTIONS as readonly string[]).includes(s) ? "registers" : "repositories");

// Sections whose records follow a licence template's field schema.
const TEMPLATE_SECTIONS: Partial<Record<GrcSection, TemplateKind>> = {
  controls: "control",
  inspection_events: "inspection_event",
  policies: "policy",
  risk_models: "risk_model",
  inspection_history: "inspection_record",
};

const Date_ = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Records answering the regulator's data registers, and the entity's own repository items.
const DATA_RECORDS: Partial<Record<GrcSection, z.ZodTypeAny>> = {
  obligations: z.object({
    status: z.enum(["compliant", "partially_compliant", "non_compliant", "not_applicable", "not_assessed"]),
    owner: z.string().uuid().optional().describe("The roster party accountable for it"),
    assessed_on: Date_.optional(),
    evidence: z.array(z.string().max(500)).max(20).default([]),
    note: z.string().max(2000).optional(),
  }),
  reporting_disclosure_filings: z.object({
    period: z.string().min(1).max(40).describe("e.g. 2026-Q2, FY2025-26"),
    status: z.enum(["filed", "due", "overdue", "not_applicable"]),
    filed_on: Date_.optional(),
    reference: z.string().max(200).optional().describe("Acknowledgement or submission number"),
    owner: z.string().uuid().optional(),
  }),
  risks: z.object({
    inherent: z.enum(["low", "medium", "high", "critical"]),
    residual: z.enum(["low", "medium", "high", "critical"]),
    owner: z.string().uuid().optional(),
    assessed_on: Date_.optional(),
    note: z.string().max(2000).optional(),
  }),
  ...Object.fromEntries(
    (["regulatory_communications", "enforcement_actions", "press_releases"] as const).map((s) => [
      s,
      z.object({ title: z.string().min(1).max(300), date: Date_.optional(), url: z.string().url().optional(), summary: z.string().max(4000).default("") }),
    ]),
  ),
};

export const GrcRecordInputSchema = {
  party_id: z.string().uuid().optional().describe("File it in a party's folder instead of the entity's"),
  product_id: z.string().optional().describe("File it in one of your products' folders (e.g. the governance of its risk models)"),
  licence_id: z.string().uuid().optional().describe("The held licence whose GRC item it answers"),
  section: z.enum(GRC_SECTIONS),
  ref: z.string().optional().describe("The item in that licence's GRC it answers: an obligation, filing or risk id, or a template id"),
  key: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/).optional().describe("Your id for the record (a template can have several records); defaults to ref"),
  record: z.record(z.string(), z.unknown()),
};

type LicenceGrc = ReturnType<typeof licenceGrc>;
function licenceGrc(ref: ReferenceData, held: HeldLicense) {
  const model = normalizeModel(ref.regions.find((r) => r.code === held.region)?.regulatory);
  return model.regulators.find((r) => r.id === held.regulator_id)?.license_types.find((l) => l._id === held.license_id)?.grc ?? null;
}
function grcItems(grc: NonNullable<LicenceGrc>, section: GrcSection): { id: string; mandatory?: boolean; owner?: string; approved_by?: string }[] {
  if ((REGISTER_SECTIONS as readonly string[]).includes(section)) return (grc.registers as Record<string, { id: string }[]>)[section] ?? [];
  const items = (grc.repositories as Record<string, unknown[]>)[section] ?? [];
  return items.filter((i): i is { id: string } => typeof (i as { id?: unknown }).id === "string");
}

// A record against a template's field schema. Stakeholder references must be parties on the roster.
function checkFields(fields: FieldDef[], value: Record<string, unknown>, roster: Party[], at = ""): string[] {
  const errors: string[] = [];
  const known = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(value)) if (!known.has(k)) errors.push(`${at}${k}: not a field of this template`);
  for (const f of fields) {
    const v = value[f.key];
    const where = `${at}${f.key}`;
    if (v === undefined || v === null || v === "") {
      if (f.required) errors.push(`${where}: required`);
      continue;
    }
    errors.push(...checkValue(f, f.type, v, roster, where));
  }
  return errors;
}
function checkValue(f: FieldDef, type: FieldDef["type"], v: unknown, roster: Party[], where: string): string[] {
  switch (type) {
    case "string":
    case "text":
    case "file":
      return typeof v === "string" ? [] : [`${where}: expected text`];
    case "url":
      return typeof v === "string" && /^https?:\/\//.test(v) ? [] : [`${where}: expected a URL`];
    case "date":
      return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? [] : [`${where}: expected YYYY-MM-DD`];
    case "datetime":
      return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? [] : [`${where}: expected a date-time`];
    case "number":
      return typeof v === "number" ? [] : [`${where}: expected a number`];
    case "integer":
      return Number.isInteger(v) ? [] : [`${where}: expected an integer`];
    case "boolean":
      return typeof v === "boolean" ? [] : [`${where}: expected true or false`];
    case "enum":
      return f.enum_values?.includes(v as string) ? [] : [`${where}: expected one of ${f.enum_values?.join(", ")}`];
    case "multi_enum":
      return Array.isArray(v) && v.every((x) => f.enum_values?.includes(x)) ? [] : [`${where}: expected a list of ${f.enum_values?.join(", ")}`];
    case "reference":
      if (typeof v !== "string") return [`${where}: expected a reference id`];
      if (f.reference_to === "stakeholder" && !roster.some((p) => p.id === v && partyActive(p))) return [`${where}: '${v}' isn't an active party on the roster`];
      return [];
    case "object":
      return v && typeof v === "object" && !Array.isArray(v) ? checkFields(f.fields ?? [], v as Record<string, unknown>, roster, `${where}.`) : [`${where}: expected an object`];
    case "array":
      if (!Array.isArray(v)) return [`${where}: expected a list`];
      return v.flatMap((x, i) =>
        f.fields?.length
          ? x && typeof x === "object" ? checkFields(f.fields, x as Record<string, unknown>, roster, `${where}[${i}].`) : [`${where}[${i}]: expected an object`]
          : f.item_type ? checkValue(f, f.item_type, x, roster, `${where}[${i}]`) : [],
      );
  }
}

// Checks a record before it's filed; returns errors and the parsed record.
export async function validateGrcRecord(
  store: Store,
  entityId: string,
  input: { party_id?: string; product_id?: string; licence_id?: string; section: GrcSection; ref?: string; key?: string; record: Record<string, unknown> },
) {
  const errors: string[] = [];
  const [held, roster, ref] = await Promise.all([store.licensesOf(entityId), store.partiesOf(entityId), store.referenceData(true)]);
  if (input.party_id && !roster.some((p) => p.id === input.party_id)) errors.push(`No party '${input.party_id}' on your entity's roster`);
  if (input.product_id && (await store.getProduct(input.product_id))?.entity_id !== entityId) errors.push(`No product '${input.product_id}' of your entity`);
  if (input.party_id && input.product_id) errors.push("A record goes in a party's folder or a product's folder, not both");
  const licence = input.licence_id ? held.find((h) => h.id === input.licence_id) : undefined;
  if (input.licence_id && !licence) errors.push(`Your entity holds no licence '${input.licence_id}'`);
  const kind = TEMPLATE_SECTIONS[input.section];
  const answersRegulator = kind || ["obligations", "reporting_disclosure_filings", "risks"].includes(input.section);
  let item: { id: string } | undefined;
  if (answersRegulator) {
    if (!licence || !input.ref) errors.push(`A ${input.section} record answers an item of a licence you hold: give licence_id and ref`);
    else {
      const grc = licenceGrc(ref, licence);
      item = grc ? grcItems(grc, input.section).find((i) => i.id === input.ref) : undefined;
      if (!item) errors.push(`${licence.license_id} (${licence.regulator_id}) has no ${input.section} item '${input.ref}'; see get_regulator`);
    }
  }
  let record: Record<string, unknown> = input.record;
  if (kind && item) errors.push(...checkFields(resolveFields(kind, item as never), record, roster));
  const data = DATA_RECORDS[input.section];
  if (data) {
    const parsed = data.safeParse(input.record);
    if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join(".") || "record"}: ${i.message}`));
    else {
      record = parsed.data as Record<string, unknown>;
      const owner = record.owner as string | undefined;
      if (owner && !roster.some((p) => p.id === owner && partyActive(p))) errors.push(`owner: '${owner}' isn't an active party on your roster`);
    }
  }
  const key = input.key ?? input.ref;
  if (!key) errors.push("Give the record a key (or a ref)");
  return { errors, record, key: key ?? "" };
}

// A held licence's GRC against the entity's folder (and its parties' folders): what's answered and what isn't.
export function reconcileLicenceGrc(ref: ReferenceData, held: HeldLicense, records: GrcRecord[], roster: Party[]) {
  const grc = licenceGrc(ref, held);
  const base = { licence_id: held.id, regulator_id: held.regulator_id, license_id: held.license_id };
  if (!grc) return { ...base, known: false, sections: {}, gaps: [], complete: false };
  const mine = records.filter((r) => r.licence_id === held.id && r.status === "current");
  const fillers = (stakeholder?: string) => (stakeholder ? roster.filter((p) => partyActive(p) && p.fills.some((f) => f.licence_id === held.id && f.stakeholder === stakeholder)).map((p) => p.id) : []);
  const gaps: { section: GrcSection; ref: string; gap: string }[] = [];
  const sections: Record<string, { required: number; answered: number }> = {};
  const required: GrcSection[] = ["obligations", "reporting_disclosure_filings", "risks", "controls", "policies", "risk_models"];
  for (const section of required) {
    const items = grcItems(grc, section).filter((i) => i.mandatory !== false);
    let answered = 0;
    for (const i of items) {
      const recs = mine.filter((r) => r.section === section && r.ref === i.id);
      if (!recs.length || (section === "obligations" && recs.every((r) => r.record.status === "not_assessed"))) {
        gaps.push({ section, ref: i.id, gap: "no record" });
        continue;
      }
      answered++;
      // Whoever the regulator makes accountable must be a party filling that stakeholder.
      for (const field of ["owner", "approved_by"] as const) {
        const accountable = i[field];
        const named = recs.map((r) => r.record[field] as string | undefined).filter(Boolean) as string[];
        if (accountable && fillers(accountable).length && named.length && !named.some((n) => fillers(accountable).includes(n)))
          gaps.push({ section, ref: i.id, gap: `${field === "owner" ? "owned" : "approved"} by a party that doesn't fill ${accountable}` });
      }
      if (section === "obligations" && recs.some((r) => r.record.status === "non_compliant")) gaps.push({ section, ref: i.id, gap: "non_compliant" });
    }
    sections[section] = { required: items.length, answered };
  }
  return { ...base, known: true, sections, gaps, complete: gaps.length === 0 };
}

export async function reconcileEntityGrc(store: Store, entityId: string, ref?: ReferenceData) {
  const [licences, roster, records, data] = await Promise.all([store.licensesOf(entityId), store.partiesOf(entityId), store.grcRecords(entityId), ref ?? store.referenceData(true)]);
  const out = licences.filter((l) => l.status !== "rejected").map((l) => reconcileLicenceGrc(data, l, records, roster));
  return { entity_id: entityId, licences: out, complete: out.every((r) => r.complete) };
}

// The folder as the licence GRC lays it out: registers and repositories, each section's current records.
export function folder(records: GrcRecord[]) {
  const out = { registers: {} as Record<string, GrcRecord[]>, repositories: {} as Record<string, GrcRecord[]> };
  for (const s of GRC_SECTIONS) out[folderOf(s)][s] = records.filter((r) => r.section === s && r.status === "current");
  return out;
}
