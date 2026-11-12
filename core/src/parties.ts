import { z } from "zod";
import { licenseInForce } from "./access.js";
import { normalizeModel } from "./regulatory.js";
import { LEGAL_FORMS, type HeldLicense, type Party, type ReferenceData, type Store } from "./store.js";

// A legal entity is typed facts (form, incorporation, identifiers) plus the licences it holds and the parties
// on its roster: who fills the stakeholders each licence mandates (the licence type's
// grc.mandatory_stakeholders in the regulatory model) and its commercial counterparties. Products may only
// name parties on their owner's roster, so who stands behind a product is fixed by the entity first.

const today = () => new Date().toISOString().slice(0, 10);
const Code = z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase code like 'collection_agency_agreement'");

export const IdentifierSchema = z.object({
  scheme: z.string().regex(/^(lei|[a-z]{2}_[a-z0-9_]+)$/, "lei, or a country-prefixed scheme like in_cin, in_pan, us_ein"),
  value: z.string().min(1).max(100),
});

export const EntityFactsSchema = {
  legal_form: z.enum(LEGAL_FORMS).optional(),
  incorporation: z
    .object({
      country: z.string().regex(/^[a-z]{2}$/, "ISO 3166-1 alpha-2, lowercase, e.g. 'in'"),
      subdivision: z.string().regex(/^[a-z]{2}-[a-z0-9]{1,3}$/, "ISO 3166-2, lowercase, e.g. 'in-mh'").optional(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .optional(),
  identifiers: z.array(IdentifierSchema).max(20).optional(),
};

export const PartyInputSchema = {
  kind: z.enum(["internal", "external"]).describe("internal: a person in the firm (e.g. the compliance officer); external: another firm (e.g. the statutory auditor, a lending partner)"),
  person: z.object({ name: z.string().min(1).max(200), identifiers: z.array(IdentifierSchema).max(10).default([]) }).optional().describe("For internal parties"),
  legal_entity_id: z.string().uuid().optional().describe("For external parties: a legal entity already on Mynt"),
  new_legal_entity: z
    .object({ name: z.string().min(1).max(200), ...EntityFactsSchema })
    .optional()
    .describe("For external parties not on Mynt yet: registers the legal entity first (its licences then need registering and verifying)"),
  fills: z
    .array(z.object({ licence_id: z.string().uuid().describe("A licence your entity holds"), stakeholder: z.string().min(1).describe("A mandatory stakeholder id on that licence type") }))
    .max(20)
    .default([]),
  attributes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({})
    .describe("Facts checked against the stakeholders' qualification criteria, e.g. { years_experience: 12, resident: true }"),
  relationship: Code.optional().describe("For counterparties, what ties you, e.g. collection_agency_agreement"),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

export const partyActive = (p: Party, on = today()) => p.status === "active" && (!p.since || p.since <= on) && (!p.until || p.until >= on);

type Slot = { id: string; name: string; kind: "internal" | "external"; qualification: Record<string, string | number | boolean> };

// The stakeholders a held licence's type mandates, or null when the licence type isn't in the regulatory model.
export function mandatedStakeholders(ref: ReferenceData, held: HeldLicense): Slot[] | null {
  const model = normalizeModel(ref.regions.find((r) => r.code === held.region)?.regulatory);
  const type = model.regulators.find((r) => r.id === held.regulator_id)?.license_types.find((l) => l._id === held.license_id);
  if (!type) return null;
  const { internal, external } = type.grc.mandatory_stakeholders;
  return [
    ...internal.map((s) => ({ id: s.id, name: s.name, kind: "internal" as const, qualification: s.qualification })),
    ...external.map((s) => ({ id: s.id, name: s.name, kind: "external" as const, qualification: s.qualification })),
  ];
}

// Numbers are minimums; anything else must match. A criterion the party has no fact for is unconfirmed.
function qualify(slot: Slot, p: Party) {
  const failed: string[] = [];
  const unconfirmed: string[] = [];
  for (const [k, want] of Object.entries(slot.qualification)) {
    const have = p.attributes[k];
    if (have === undefined) unconfirmed.push(k);
    else if (typeof want === "number" ? !(typeof have === "number" && have >= want) : have !== want) failed.push(k);
  }
  return { failed, unconfirmed };
}

// One held licence against the roster: which mandated stakeholders are filled, by whom, and what's missing.
export function reconcileLicence(ref: ReferenceData, held: HeldLicense, roster: Party[]) {
  const slots = mandatedStakeholders(ref, held);
  const base = { licence_id: held.id, regulator_id: held.regulator_id, license_id: held.license_id, in_force: licenseInForce(held) };
  if (!slots) return { ...base, known: false, mandated: 0, filled: [], missing: [], unqualified: [], unconfirmed: [], complete: false };
  const filled: { stakeholder: string; party_ids: string[] }[] = [];
  const missing: { stakeholder: string; name: string; kind: "internal" | "external" }[] = [];
  const unqualified: { stakeholder: string; party_id: string; failed: string[] }[] = [];
  const unconfirmed: { stakeholder: string; party_id: string; criteria: string[] }[] = [];
  for (const slot of slots) {
    const holders = roster.filter((p) => partyActive(p) && p.kind === slot.kind && p.fills.some((f) => f.licence_id === held.id && f.stakeholder === slot.id));
    const ok: string[] = [];
    for (const p of holders) {
      const q = qualify(slot, p);
      if (q.failed.length) unqualified.push({ stakeholder: slot.id, party_id: p.id, failed: q.failed });
      else {
        ok.push(p.id);
        if (q.unconfirmed.length) unconfirmed.push({ stakeholder: slot.id, party_id: p.id, criteria: q.unconfirmed });
      }
    }
    if (ok.length) filled.push({ stakeholder: slot.id, party_ids: ok });
    else if (!holders.length) missing.push({ stakeholder: slot.id, name: slot.name, kind: slot.kind });
  }
  return { ...base, known: true, mandated: slots.length, filled, missing, unqualified, unconfirmed, complete: filled.length === slots.length };
}
export type LicenceReconciliation = ReturnType<typeof reconcileLicence>;

// Every licence an entity holds (verified or not) against its roster.
export async function reconcileEntity(store: Store, entityId: string, ref?: ReferenceData) {
  const [licences, roster, data] = await Promise.all([store.licensesOf(entityId), store.partiesOf(entityId), ref ?? store.referenceData(true)]);
  const out = licences.filter((l) => l.status !== "rejected").map((l) => reconcileLicence(data, l, roster));
  return { entity_id: entityId, licences: out, complete: out.every((r) => r.complete) };
}

// Checks a new party against the firm's licences and the regulatory model before it's added.
export async function validateParty(
  store: Store,
  entityId: string,
  p: { kind: "internal" | "external"; person?: unknown; legal_entity_id?: string; new_legal_entity?: unknown; fills: { licence_id: string; stakeholder: string }[] },
) {
  const errors: string[] = [];
  if (p.kind === "internal") {
    if (!p.person) errors.push("An internal party needs a person");
    if (p.legal_entity_id || p.new_legal_entity) errors.push("An internal party is a person, not a legal entity");
  } else {
    if (p.person) errors.push("An external party is a legal entity, not a person");
    if (Boolean(p.legal_entity_id) === Boolean(p.new_legal_entity)) errors.push("Name the external party with legal_entity_id or new_legal_entity (one of them)");
    if (p.legal_entity_id === entityId) errors.push("A firm can't be a party on its own roster");
    if (p.legal_entity_id && !(await store.getEntity(p.legal_entity_id))) errors.push(`No legal entity '${p.legal_entity_id}'`);
  }
  if (p.fills.length) {
    const [held, ref] = await Promise.all([store.licensesOf(entityId), store.referenceData(true)]);
    for (const f of p.fills) {
      const licence = held.find((h) => h.id === f.licence_id);
      if (!licence) {
        errors.push(`Your entity holds no licence '${f.licence_id}'`);
        continue;
      }
      const slot = mandatedStakeholders(ref, licence)?.find((s) => s.id === f.stakeholder);
      if (!slot) errors.push(`'${f.stakeholder}' isn't a mandatory stakeholder of ${licence.license_id} (${licence.regulator_id}); see get_regulator`);
      else if (slot.kind !== p.kind) errors.push(`'${f.stakeholder}' is an ${slot.kind} stakeholder; this party is ${p.kind}`);
    }
  }
  return errors;
}
