import { z } from "zod";
import { licenseInForce } from "./access.js";
import { PRODUCT_LINES, UNDERLYINGS, WRAPPERS } from "./catalog.js";
import { partyActive, reconcileLicence, type LicenceReconciliation } from "./parties.js";
import { licenseProducts, normalizeModel, PRODUCT_ACTIONS } from "./regulatory.js";
import type { HeldLicense, Party, ProductRecord, ReferenceData, Store } from "./store.js";

// Products are compositions of regulated primitives: a recurring deposit is a recurring payments mandate
// plus a term deposit; a cross-border transfer is an exchange plus a payment. The primitive is the product
// line itself (credit, payments, …): collateral, segment and purpose are the product's business context,
// not the primitive. What a component falls under in a country (its perimeter) is every regulated product
// type there whose category is on that line and which allows the action; who supervises it, which licences
// may provide it and the law recorded against it follow from that.
//
// Every component names who provides it: the owner itself, under one of its licences, or a party on the
// owner's roster. The stakeholders the providing licence mandates must be filled on the provider's roster,
// and, when the owner provides it, bound to the component in the product, so the product can't drift onto
// people or firms its entity never declared.

const Key = z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase key like 'loan' or 'collect'");

export const ProviderSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("self"),
    licence_id: z.string().uuid().optional().describe("One of your entity's held licences; omit to use whichever covers it (pinned at publish)"),
  }),
  z.object({ by: z.literal("party"), party_id: z.string().uuid().describe("An active external party on your entity's roster (see add_party)") }),
]);

export const ComponentSchema = z.object({
  key: Key.describe("Unique in the product; parties and business context refer to it"),
  country: z.string().regex(/^[a-z]{2}$/, "ISO 3166-1 alpha-2, lowercase, e.g. 'in'").describe("Where this component is regulated"),
  primitive: z.enum(PRODUCT_LINES).describe("The primitive is the line: credit, securitization, payments, account_operations, custody_settlement, wealth, insurance, guarantees_trade, exchange, derivatives or information"),
  action: z
    .enum(PRODUCT_ACTIONS)
    .describe(
      "What is done with it in this product: issuance, sale, purchase, secondary_sale, repackaging, advice, servicing, underwriting or assessment (an independent rating, valuation, index, actuarial certification, audit or accreditation)",
    ),
  underlying: z.enum(UNDERLYINGS).optional().describe("What it is made of, when the line alone doesn't say: cash, securities, commodities, real_assets, receivables, risk, data or digital_assets"),
  wrapper: z.enum(WRAPPERS).optional().describe("A statutory or tax structure around it: statutory_pension, tax_advantaged or government_scheme"),
  provider: ProviderSchema.optional().describe("Who provides it. Required on a firm's product; Mynt reference products (no firm) leave it out"),
});
export type Component = z.infer<typeof ComponentSchema>;

export const PartyBindingSchema = z.object({
  party_id: z.string().uuid().describe("A party on your entity's roster"),
  for: Key.describe("The component key it stands behind"),
});
export type PartyBinding = z.infer<typeof PartyBindingSchema>;

export const regionOf = (c: Pick<Component, "country">) => c.country.toUpperCase();
export const compositionOf = (record: ProductRecord, live = false) =>
  live && record.pins ? { components: record.pins.components, parties: record.pins.parties } : { components: record.components, parties: record.parties };

type Stakeholders = LicenceReconciliation & { enforced: boolean; unbound: string[] };
type Covering = { entity_id: string; licence_id: string; regulator_id: string; license_id: string; registration_number: string };
type Coverage =
  | { status: "covered"; by: Covering[] }
  | { status: "uncovered"; reason: string }
  | { status: "unmodelled"; reason: string }
  | { status: "unassigned"; reason: string }
  | { status: "reference"; reason: string };

// Regulated product types in a region that a component falls under.
function perimeter(c: Component, types: Awaited<ReturnType<Store["regulatedProductTypes"]>>, ref: ReferenceData) {
  const lines = new Map(ref.categories.map((k) => [k.id, k.product_lines]));
  return types.filter(
    (t) =>
      t.region === regionOf(c) &&
      (lines.get(t.type_id) ?? []).includes(c.primitive) &&
      t.actions.includes(c.action) &&
      (!c.underlying || !t.underlying || t.underlying === c.underlying) &&
      (t.wrapper ?? null) === (c.wrapper ?? null),
  );
}

// Checks a composition against the reference data and the owner's licences and roster before it's saved.
export async function validateComposition(store: Store, product: ProductRecord, components: Component[], parties: PartyBinding[]) {
  const errors: string[] = [];
  const ref = await store.referenceData(true);
  const [held, roster] = product.entity_id ? await Promise.all([store.licensesOf(product.entity_id), store.partiesOf(product.entity_id)]) : [[], []];
  const keys = new Set<string>();
  for (const c of components) {
    const where = `component '${c.key}'`;
    if (keys.has(c.key)) errors.push(`${where}: the key is used twice`);
    keys.add(c.key);
    if (!ref.regions.some((r) => r.code === regionOf(c))) errors.push(`${where}: no region '${regionOf(c)}' on Mynt`);
    if (product.product.region !== "global" && regionOf(c) !== product.product.region) errors.push(`${where}: the product is offered in ${product.product.region}, not ${regionOf(c)}`);
    if (!product.entity_id) {
      if (c.provider) errors.push(`${where}: a reference product has no firm, so it names no provider`);
      continue;
    }
    if (!c.provider) errors.push(`${where}: name its provider (by: self, or by: party with a party on your roster)`);
    else if (c.provider.by === "self") {
      const licenceId = c.provider.licence_id;
      const licence = licenceId && held.find((h) => h.id === licenceId && h.region === regionOf(c));
      if (licenceId && !licence) errors.push(`${where}: your entity holds no licence '${c.provider.licence_id}' in ${regionOf(c)}`);
    } else {
      const party = roster.find((p) => p.id === (c.provider as { party_id: string }).party_id);
      if (!party) errors.push(`${where}: party '${c.provider.party_id}' isn't on your entity's roster (add_party)`);
      else if (party.kind !== "external") errors.push(`${where}: a provider is a firm, and party '${party.id}' is a person`);
      else if (!partyActive(party)) errors.push(`${where}: party '${party.id}' isn't active`);
    }
  }
  const seen = new Set<string>();
  for (const b of parties) {
    const party = roster.find((p) => p.id === b.party_id);
    if (!keys.has(b.for)) errors.push(`party '${b.party_id}': no component '${b.for}'`);
    if (!party) errors.push(`party '${b.party_id}' isn't on your entity's roster`);
    else if (!partyActive(party)) errors.push(`party '${b.party_id}' isn't active`);
    if (seen.has(`${b.party_id}/${b.for}`)) errors.push(`party '${b.party_id}' is bound to '${b.for}' twice`);
    seen.add(`${b.party_id}/${b.for}`);
  }
  return errors;
}

// The regime of a product's composition (its working copy, or the pinned live one), per jurisdiction.
export async function productRegime(store: Store, product: ProductRecord, opts: { live?: boolean } = {}) {
  const { components, parties } = compositionOf(product, opts.live);
  const ref = await store.referenceData(true);
  const types = await store.regulatedProductTypes();
  const mappings = await store.productMappings();
  const cache = new Map<string, Promise<[HeldLicense[], Party[]]>>();
  const entityData = (id: string) => {
    if (!cache.has(id)) cache.set(id, Promise.all([store.licensesOf(id), store.partiesOf(id)]));
    return cache.get(id)!;
  };
  const owner = product.entity_id ? await entityData(product.entity_id) : null;

  const out = [];
  for (const region of [...new Set(components.map(regionOf))]) {
    const model = normalizeModel(ref.regions.find((r) => r.code === region)?.regulatory);
    const rows = [];
    for (const c of components.filter((x) => regionOf(x) === region)) {
      const inPerimeter = perimeter(c, types, ref);
      const typeIds = new Set(inPerimeter.map((t) => t.id));
      const supervised_by = [
        ...new Map(
          mappings
            .filter((m) => m.region === region && typeIds.has(m.product_type_id) && m.actions.includes(c.action))
            .map((m) => [m.regulator_id, { regulator_id: m.regulator_id, name: model.regulators.find((r) => r.id === m.regulator_id)?.name ?? m.regulator_id }]),
        ).values(),
      ];
      const licences = model.regulators.flatMap((r) =>
        r.license_types
          .filter((l) => licenseProducts(r, l).some((p) => typeIds.has(p.id) && (p.action as string[]).includes(c.action)))
          .map((l) => ({ regulator_id: r.id, license_id: l._id, name: l.name })),
      );
      const regulatorIds = new Set(supervised_by.map((s) => s.regulator_id));
      const law = model.legal.legislative
        .filter((l) => (l.applies_to?.product_types ?? []).some((t) => typeIds.has(t)) || (l.applies_to?.regulators ?? []).some((r) => regulatorIds.has(r)) || regulatorIds.has(l.issued_by ?? ""))
        .slice(0, 25)
        .map((l) => ({ legal_ref: l.id, title: l.title, kind: l.kind, status: l.status }));

      // Who provides it, and which of their in-force licences grant it.
      let providerEntity: string | null = null;
      let providerParty: Party | null = null;
      if (c.provider?.by === "self") providerEntity = product.entity_id;
      else if (c.provider?.by === "party") {
        providerParty = owner?.[1].find((p) => p.id === (c.provider as { party_id: string }).party_id) ?? null;
        providerEntity = providerParty?.legal_entity_id ?? null;
      }
      const grants = new Set(licences.map((l) => `${l.regulator_id}/${l.license_id}`));
      let coverage: Coverage;
      let held: HeldLicense[] = [];
      let roster: Party[] = [];
      if (!product.entity_id) coverage = product.owner_id ? { status: "unassigned", reason: "The product isn't attached to a firm" } : { status: "reference", reason: "A Mynt reference product: no firm offers it yet" };
      else if (!inPerimeter.length) coverage = { status: "unmodelled", reason: `No regulated product type in ${region} covers ${c.action} of ${c.primitive}${c.underlying ? ` (${c.underlying})` : ""}${c.wrapper ? ` in a ${c.wrapper} wrapper` : ""} yet` };
      else if (!c.provider) coverage = { status: "unassigned", reason: "No provider named" };
      else if (!providerEntity || (providerParty && !partyActive(providerParty))) coverage = { status: "uncovered", reason: "The providing party isn't active on your roster" };
      else {
        [held, roster] = await entityData(providerEntity);
        const pinnedLicence = c.provider.by === "self" ? c.provider.licence_id : undefined;
        const by = held
          .filter((h) => h.region === region && licenseInForce(h) && grants.has(`${h.regulator_id}/${h.license_id}`) && (!pinnedLicence || h.id === pinnedLicence))
          .map((h) => ({ entity_id: providerEntity!, licence_id: h.id, regulator_id: h.regulator_id, license_id: h.license_id, registration_number: h.registration_number }));
        coverage = by.length
          ? { status: "covered", by }
          : {
              status: "uncovered",
              reason: pinnedLicence
                ? `Licence '${pinnedLicence}' isn't verified and in force, or doesn't grant this`
                : licences.length
                  ? `${c.provider.by === "self" ? "Your entity" : "The partner"} holds no verified licence granting this; needs one of: ${licences.map((l) => l.license_id).join(", ")}`
                  : "No licence in the regulatory model grants this yet",
            };
      }

      // The providing licence's mandated stakeholders on the provider's roster; the owner's must also be bound here.
      let stakeholders: Stakeholders | null = null;
      if (coverage.status === "covered") {
        const licence = held.find((h) => h.id === (coverage as { by: Covering[] }).by[0].licence_id)!;
        const r = reconcileLicence(ref, licence, roster);
        const enforced = c.provider?.by === "self";
        const bound = new Set(parties.filter((b) => b.for === c.key).map((b) => b.party_id));
        const unbound = enforced ? r.filled.map((f) => f.party_ids.find((id) => bound.has(id)) ?? f.party_ids[0]).filter((id) => !bound.has(id)) : [];
        stakeholders = { ...r, enforced, unbound };
      }
      rows.push({
        ...c,
        region,
        provider_entity_id: providerEntity,
        perimeter: inPerimeter.map((t) => ({ id: t.id, name: t.name, category: t.type_id })),
        supervised_by,
        licences,
        law,
        coverage,
        stakeholders,
        parties: parties.filter((b) => b.for === c.key).map((b) => b.party_id),
      });
    }
    out.push({
      region,
      components: rows,
      regulators: [...new Set(rows.flatMap((x) => x.supervised_by.map((s) => s.regulator_id)))],
      covered: !rows.some((x) => blockingReason(x)),
    });
  }
  return { product_id: product.product.id, composed: components.length > 0, live: Boolean(opts.live && product.pins), regions: out };
}
// Why a component stops publishing, if it does.
function blockingReason(c: { key: string; coverage: Coverage; stakeholders: Stakeholders | null }): string | null {
  if (c.coverage.status === "uncovered" || c.coverage.status === "unmodelled" || c.coverage.status === "unassigned") return c.coverage.reason;
  const s = c.stakeholders;
  if (!s?.enforced) return null;
  if (!s.known) return `${s.license_id} isn't in the regulatory model any more, so its mandated stakeholders can't be checked`;
  const gaps = [
    ...s.missing.map((m) => `no ${m.kind} party fills ${m.stakeholder}`),
    ...s.unqualified.map((u) => `party ${u.party_id} doesn't meet ${u.stakeholder}'s criteria (${u.failed.join(", ")})`),
    ...s.unbound.map((id) => `bind party ${id} to '${c.key}'`),
  ];
  return gaps.length ? `${s.license_id}: ${gaps.join("; ")}` : null;
}

// Components that stop publishing: not covered, not modelled, no provider, or the providing licence's
// mandated stakeholders not filled on the roster and bound.
export function blockingComponents(regime: Awaited<ReturnType<typeof productRegime>>, region: string) {
  return regime.regions
    .filter((r) => region === "global" || r.region === region)
    .flatMap((r) => r.components.map((c) => ({ c, reason: blockingReason(c) })).filter((x) => x.reason).map(({ c, reason }) => ({ region: r.region, key: c.key, primitive: c.primitive, action: c.action, reason: reason! })));
}

// Partner-provided components whose providing licence has stakeholder gaps on the partner's roster (advisory).
export function partnerGaps(regime: Awaited<ReturnType<typeof productRegime>>) {
  return regime.regions.flatMap((r) => r.components.filter((c) => c.stakeholders && !c.stakeholders.enforced && !c.stakeholders.complete).map((c) => ({ region: r.region, key: c.key })));
}
