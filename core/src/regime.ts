import { z } from "zod";
import { licenseInForce } from "./access.js";
import { PRODUCT_LINES, UNDERLYINGS, WRAPPERS } from "./catalog.js";
import { partyActive, reconcileLicence, type LicenceReconciliation } from "./parties.js";
import { coversJurisdiction, JURISDICTION, licenceJurisdictions, licenseProducts, normalizeModel, PRODUCT_ACTIONS, type Regulator } from "./regulatory.js";
import type { HeldLicense, Party, ProductRecord, ReferenceData, Sponsorship, Store } from "./store.js";

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
//
// Where a country licenses state by state (US money transmission, virtual-currency business), a component
// lists the jurisdictions it's offered in (offered_in: ISO 3166-2 codes like 'us-ny', or the country code for
// the whole country), and coverage is checked in each: a held licence counts there when it covers it (a state
// licence its state, a country-wide or pre-empting licence everywhere; see licenceJurisdictions). Without
// offered_in a component is checked for the country as before: any licence held in the region counts.
//
// A licence type may require others (requires: a state money transmitter licence counts only alongside the
// FinCEN registration), and a licence type may cover nowhere by itself (covers: [], that registration).
//
// A component may instead be provided by a licence provider sponsoring it (by: sponsor): a firm, added by hand,
// that holds the licences and approved this component of this product under some of them, for some
// jurisdictions (see sponsorships.ts). It's covered in a jurisdiction only by a licence of that provider which
// an approved sponsorship names for that jurisdiction, verified, in force, covering it, with the provider's own
// prerequisites (its FinCEN registration). The licence's mandated stakeholders are the licensee's: they must be
// filled on the provider's roster (enforced, as for the owner's own licences), but aren't bound to the
// builder's product, whose roster they aren't on. So a builder holding no licence publishes only where a
// provider sponsors it, and revoking the sponsorship or the provider's licence lapsing drifts the product.
//
// A product may be built on others (underlying_product_ids; a v2 definition's builds_on): a dollar account
// on the money transmission product, so it never re-declares transmission. It inherits their coverage: in
// each jurisdiction it's offered in, every product it's built on must be published, not drifted, and
// covered there (its live regime), or the composed product is blocked there too. Its pins record them (see
// pins.ts), so it drifts when one of them does.

const Key = z.string().regex(/^[a-z][a-z0-9_]*$/, "Use a lowercase key like 'loan' or 'collect'");

export const ProviderSchema = z.discriminatedUnion("by", [
  z.object({
    by: z.literal("self"),
    licence_id: z.string().uuid().optional().describe("One of your entity's held licences; omit to use whichever covers it (pinned at publish)"),
  }),
  z.object({ by: z.literal("party"), party_id: z.string().uuid().describe("An active external party on your entity's roster (see add_party)") }),
  z.object({
    by: z.literal("sponsor"),
    entity_id: z.string().uuid().describe("A licence provider's firm id (shared out of band); it covers the component once it approves your request_sponsorship"),
  }),
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
  offered_in: z
    .array(z.string().regex(JURISDICTION, "An ISO 3166-2 code, lowercase, e.g. 'us-ny', or the country code ('us') for the whole country"))
    .min(1)
    .optional()
    .describe(
      "Where it's offered, when its country licenses state by state: ISO 3166-2 codes in its country (e.g. ['us-ny', 'us-ca']), or the country code (['us']) for the whole country, which needs a licence covering all of it. Coverage is checked in each. Omit to check the country as a whole, as before",
    ),
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
type JurisdictionRow = { jurisdiction: string; coverage: Coverage; stakeholders: Stakeholders | null; prerequisites?: Stakeholders[] };
// requires: the held licences the covering one counts only with (its type's prerequisites, e.g. the FinCEN
// registration behind a state money transmitter licence); pinned with it at publish.
// sponsorship_id: the approved sponsorship it counts under, when a licence provider sponsors the component.
type Covering = { entity_id: string; licence_id: string; regulator_id: string; license_id: string; registration_number: string; requires?: string[]; sponsorship_id?: string };
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
    for (const j of c.offered_in ?? [])
      if (j !== c.country && !j.startsWith(`${c.country}-`)) errors.push(`${where}: offered_in '${j}' isn't in ${regionOf(c)} (use ISO 3166-2 codes like '${c.country}-xx', or '${c.country}' for the whole country)`);
    if (!product.entity_id) {
      if (c.provider) errors.push(`${where}: a reference product has no firm, so it names no provider`);
      continue;
    }
    if (!c.provider) errors.push(`${where}: name its provider (by: self, by: party with a party on your roster, or by: sponsor with a licence provider's firm id)`);
    else if (c.provider.by === "sponsor") {
      if (c.provider.entity_id === product.entity_id) errors.push(`${where}: your own firm can't sponsor your product; use by: self`);
      else if (!(await store.getEntity(c.provider.entity_id))) errors.push(`${where}: no firm '${c.provider.entity_id}' on Mynt to sponsor it`);
    }
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
export async function productRegime(store: Store, product: ProductRecord, opts: { live?: boolean; seen?: string[] } = {}) {
  const { components, parties } = compositionOf(product, opts.live);
  const bases = await basesOf(store, product, opts.seen ?? []);
  const ref = await store.referenceData(true);
  const types = await store.regulatedProductTypes();
  const mappings = await store.productMappings();
  const cache = new Map<string, Promise<[HeldLicense[], Party[]]>>();
  const entityData = (id: string) => {
    if (!cache.has(id)) cache.set(id, Promise.all([store.licensesOf(id), store.partiesOf(id)]));
    return cache.get(id)!;
  };
  const owner = product.entity_id ? await entityData(product.entity_id) : null;
  // Licence providers' approved sponsorships of this product's components (by: sponsor).
  const sponsored: Sponsorship[] =
    product.entity_id && components.some((c) => c.provider?.by === "sponsor") ? await store.sponsorships({ product_id: product.product.id, status: "approved" }) : [];

  const out = [];
  for (const region of [...new Set(components.map(regionOf))]) {
    const model = normalizeModel(ref.regions.find((r) => r.code === region)?.regulatory);
    const country = region.toLowerCase();
    const label = (j: string) => (j === "*" || j === country ? `the whole of ${region}` : j);
    const regulators = new Map<string, Regulator>(model.regulators.map((r) => [r.id, r]));
    const typeJurisdictions = (regulatorId: string, licenseId: string) => {
      const r = regulators.get(regulatorId);
      const l = r?.license_types.find((x) => x._id === licenseId);
      return l?.issued_per_jurisdiction ? (l.covers ?? []) : licenceJurisdictions(r, l, {});
    };
    const whereHeld = (h: HeldLicense) => {
      const r = regulators.get(h.regulator_id);
      return licenceJurisdictions(r, r?.license_types.find((x) => x._id === h.license_id), h);
    };
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
      let sponsor: { entity_id: string; name: string; sponsorships: Sponsorship[] } | null = null;
      if (c.provider?.by === "self") providerEntity = product.entity_id;
      else if (c.provider?.by === "party") {
        providerParty = owner?.[1].find((p) => p.id === (c.provider as { party_id: string }).party_id) ?? null;
        providerEntity = providerParty?.legal_entity_id ?? null;
      } else if (c.provider?.by === "sponsor") {
        providerEntity = c.provider.entity_id;
        const entity = await store.getEntity(providerEntity);
        sponsor = {
          entity_id: providerEntity,
          name: entity?.name ?? providerEntity,
          sponsorships: sponsored.filter((x) => x.component_key === c.key && x.provider_entity_id === providerEntity && x.builder_entity_id === product.entity_id),
        };
      }
      const grants = new Set(licences.map((l) => `${l.regulator_id}/${l.license_id}`));
      // A reason that holds wherever it's offered: no firm, not modelled, no provider, an inactive partner.
      let pre: Coverage | null = null;
      let held: HeldLicense[] = [];
      let roster: Party[] = [];
      if (!product.entity_id) pre = product.owner_id ? { status: "unassigned", reason: "The product isn't attached to a firm" } : { status: "reference", reason: "A Mynt reference product: no firm offers it yet" };
      else if (!inPerimeter.length) pre = { status: "unmodelled", reason: `No regulated product type in ${region} covers ${c.action} of ${c.primitive}${c.underlying ? ` (${c.underlying})` : ""}${c.wrapper ? ` in a ${c.wrapper} wrapper` : ""} yet` };
      else if (!c.provider) pre = { status: "unassigned", reason: "No provider named" };
      else if (!providerEntity || (providerParty && !partyActive(providerParty))) pre = { status: "uncovered", reason: "The providing party isn't active on your roster" };
      else if (sponsor && !sponsor.sponsorships.length)
        pre = { status: "uncovered", reason: `${sponsor.name} (licence provider) hasn't approved a sponsorship of '${c.key}' in this product; ask with request_sponsorship` };
      else [held, roster] = await entityData(providerEntity);
      const pinnedLicence = c.provider?.by === "self" ? c.provider.licence_id : undefined;
      const who = c.provider?.by === "self" ? "Your entity" : sponsor ? `${sponsor.name} (sponsor)` : "The partner";
      const whoLower = sponsor ? who : who.toLowerCase();
      // A sponsor's licences count only as its approved sponsorships name them, and only where they're approved.
      const sponsoredLicences = new Set(sponsor?.sponsorships.flatMap((x) => x.licence_ids) ?? []);
      const sponsoringIn = (h: HeldLicense, j: string | null) =>
        sponsor?.sponsorships.find((x) => x.licence_ids.includes(h.id) && (j === null || coversJurisdiction(x.jurisdictions.map((w) => (w === country ? "*" : w)), j)));
      const granting = held.filter(
        (h) =>
          h.region === region &&
          licenseInForce(h) &&
          grants.has(`${h.regulator_id}/${h.license_id}`) &&
          (!pinnedLicence || h.id === pinnedLicence) &&
          (!sponsor || sponsoredLicences.has(h.id)),
      );
      // A held licence counts only with its type's prerequisites held by the same provider, verified and in force.
      const typeOf = (h: HeldLicense) => regulators.get(h.regulator_id)?.license_types.find((x) => x._id === h.license_id);
      const prerequisites = (h: HeldLicense) => {
        // Each entry is one licence type, or several any one of which will do.
        const required = (typeOf(h)?.requires ?? []).map((e) => (typeof e === "string" ? [e] : e));
        const met = required.map((ids) => held.find((p) => p.region === region && ids.includes(p.license_id) && licenseInForce(p)));
        return { missing: required.filter((_, i) => !met[i]).map((ids) => ids.join(" or ")), held: met.filter((p): p is HeldLicense => Boolean(p)) };
      };
      // Licences whose type covers nowhere by itself (a registration others require) never cover a component.
      const nowhere = granting.filter((h) => !typeOf(h)?.issued_per_jurisdiction && whereHeld(h).length === 0);
      const counting = granting.filter((h) => !nowhere.includes(h));

      // Covered in one jurisdiction (null: the country as a whole, any licence in the region counting).
      const coverIn = (j: string | null): Coverage => {
        if (pre) return pre;
        const geographic = counting.filter((h) => j === null || coversJurisdiction(whereHeld(h), j));
        const there = sponsor ? geographic.filter((h) => sponsoringIn(h, j)) : geographic;
        // The sponsor holds a licence that could cover it here, but hasn't sponsored the component under it here.
        const couldSponsor =
          sponsor &&
          held.some(
            (h) =>
              h.region === region &&
              licenseInForce(h) &&
              grants.has(`${h.regulator_id}/${h.license_id}`) &&
              whereHeld(h).length > 0 &&
              (j === null || coversJurisdiction(whereHeld(h), j)),
          );
        if (sponsor && couldSponsor && !there.length) {
          const approvedIn = [...new Set(sponsor.sponsorships.flatMap((x) => x.jurisdictions))].map(label);
          return { status: "uncovered", reason: `${who} doesn't sponsor this in ${j === null ? region : label(j)}: its approved sponsorship covers ${approvedIn.join(", ") || "nowhere yet"}; ask it to extend with request_sponsorship` };
        }
        const by = there
          .filter((h) => prerequisites(h).missing.length === 0)
          .map((h) => {
            const requires = prerequisites(h).held.map((p) => p.id);
            const through = sponsor ? sponsoringIn(h, j) : undefined;
            return {
              entity_id: providerEntity!,
              licence_id: h.id,
              regulator_id: h.regulator_id,
              license_id: h.license_id,
              registration_number: h.registration_number,
              ...(requires.length ? { requires } : {}),
              ...(through ? { sponsorship_id: through.id } : {}),
            };
          });
        if (by.length) return { status: "covered", by };
        const notes = nowhere.length ? `; ${nowhere.map((h) => h.license_id).join(", ")} ${nowhere.length > 1 ? "cover" : "covers"} nowhere by itself: other licences require it` : "";
        const lacking = there.map((h) => `${h.license_id} (${whereHeld(h).map(label).join(", ") || "no jurisdiction recorded"}) counts only alongside ${prerequisites(h).missing.join(", ")}, verified and in force, which ${whoLower} doesn't hold`);
        if (lacking.length) return { status: "uncovered", reason: `${who}'s ${lacking.join("; ")}${notes}` };
        if (pinnedLicence) return { status: "uncovered", reason: `Licence '${pinnedLicence}' isn't verified and in force, or doesn't grant this${j ? ` in ${label(j)}` : ""}${notes}` };
        if (!licences.length) return { status: "uncovered", reason: "No licence in the regulatory model grants this yet" };
        if (j === null) return { status: "uncovered", reason: `${who} holds no verified licence granting this; needs one of: ${licences.filter((l) => typeJurisdictions(l.regulator_id, l.license_id).length).map((l) => l.license_id).join(", ")}${notes}` };
        const could = licences.filter((l) => coversJurisdiction(typeJurisdictions(l.regulator_id, l.license_id), j)).map((l) => l.license_id);
        const elsewhere = counting.map((h) => `${h.license_id} (${whereHeld(h).map(label).join(", ") || "no jurisdiction recorded"})`);
        return {
          status: "uncovered",
          reason:
            (elsewhere.length ? `${who}'s licences granting this cover ${elsewhere.join("; ")}, not ${label(j)}` : `${who} holds no verified licence granting this in ${label(j)}`) +
            (could.length ? `; needs one covering ${label(j)}: ${could.join(", ")}` : `; no licence in the regulatory model covers ${label(j)} for this yet`) +
            notes,
        };
      };
      // A held licence's mandated stakeholders on the provider's roster; the owner's must also be bound here.
      const reconcile = (licenceId: string): Stakeholders => {
        const licence = held.find((h) => h.id === licenceId)!;
        const r = reconcileLicence(ref, licence, roster);
        // The owner's and a sponsor's licences are enforced (filled on the licensee's roster); only the owner's
        // stakeholders are also bound to the component, since only they are on the owner's roster.
        const enforced = c.provider?.by === "self" || c.provider?.by === "sponsor";
        const bound = new Set(parties.filter((b) => b.for === c.key).map((b) => b.party_id));
        const unbound = c.provider?.by === "self" ? r.filled.map((f) => f.party_ids.find((id) => bound.has(id)) ?? f.party_ids[0]).filter((id) => !bound.has(id)) : [];
        return { ...r, enforced, unbound };
      };
      // The covering licence's, and its prerequisites' (the FinCEN registration's AML officer behind a state licence).
      const stakeholdersFor = (coverage: Coverage): Stakeholders | null => (coverage.status === "covered" ? reconcile(coverage.by[0].licence_id) : null);
      const prerequisitesFor = (coverage: Coverage): Stakeholders[] => (coverage.status === "covered" ? (coverage.by[0].requires ?? []).map(reconcile) : []);

      let coverage: Coverage;
      let stakeholders: Stakeholders | null;
      let prerequisiteStakeholders: Stakeholders[];
      let jurisdictions: JurisdictionRow[] | undefined;
      const offered = c.offered_in?.length ? [...new Set(c.offered_in)] : null;
      if (!offered) {
        coverage = coverIn(null);
        stakeholders = stakeholdersFor(coverage);
        prerequisiteStakeholders = prerequisitesFor(coverage);
      } else {
        jurisdictions = offered.map((j) => {
          const cov = coverIn(j);
          const prerequisites = prerequisitesFor(cov);
          return { jurisdiction: j, coverage: cov, stakeholders: stakeholdersFor(cov), ...(prerequisites.length ? { prerequisites } : {}) };
        });
        const gaps = jurisdictions.filter((x) => x.coverage.status !== "covered");
        const covering = new Map(jurisdictions.flatMap((x) => (x.coverage.status === "covered" ? x.coverage.by : [])).map((b) => [b.licence_id, b]));
        coverage = pre ?? (gaps.length ? { status: "uncovered", reason: gaps.map((x) => `in ${label(x.jurisdiction)}: ${(x.coverage as { reason: string }).reason}`).join("; ") } : { status: "covered", by: [...covering.values()] });
        stakeholders = jurisdictions.find((x) => x.stakeholders)?.stakeholders ?? null;
        prerequisiteStakeholders = jurisdictions.find((x) => x.prerequisites)?.prerequisites ?? [];
      }
      rows.push({
        ...c,
        region,
        provider_entity_id: providerEntity,
        ...(sponsor ? { sponsor: { entity_id: sponsor.entity_id, name: sponsor.name, sponsorship_ids: sponsor.sponsorships.map((x) => x.id) } } : {}),
        perimeter: inPerimeter.map((t) => ({ id: t.id, name: t.name, category: t.type_id })),
        supervised_by,
        licences,
        law,
        coverage,
        stakeholders,
        ...(prerequisiteStakeholders.length ? { prerequisites: prerequisiteStakeholders } : {}),
        ...(jurisdictions ? { jurisdictions } : {}),
        parties: parties.filter((b) => b.for === c.key).map((b) => b.party_id),
      });
    }
    // Per jurisdiction offered (when any component lists them): covered when nothing blocks there.
    const offeredIn = [...new Set(rows.flatMap((x) => x.jurisdictions?.map((j) => j.jurisdiction) ?? []))];
    // The products it's built on, checked wherever it's offered (the country as a whole without offered_in).
    const foundations = bases.map((b) => foundationIn(b, region, offeredIn));
    const gaps = [...rows.flatMap((x) => rowBlockers(x)), ...foundations.flatMap((f) => f.blockers)];
    out.push({
      region,
      components: rows,
      regulators: [...new Set(rows.flatMap((x) => x.supervised_by.map((s) => s.regulator_id)))],
      covered: gaps.length === 0,
      ...(offeredIn.length ? { jurisdictions: offeredIn.map((j) => ({ jurisdiction: j, covered: !gaps.some((b) => b.jurisdiction === j || b.jurisdiction === undefined) })) } : {}),
      ...(foundations.length ? { foundations } : {}),
    });
  }
  return { product_id: product.product.id, composed: components.length > 0, live: Boolean(opts.live && product.pins), built_on: bases.map((b) => b.product_id), regions: out };
}

// A product another is built on, as the composed product's regime needs it: per region, whether it's covered,
// in which jurisdictions, and why not.
type Base = {
  product_id: string;
  name?: string;
  problem?: string;
  published?: boolean;
  drifted?: boolean;
  lead?: { primitive: string; action: string };
  regions?: { region: string; covered: boolean; jurisdictions?: { jurisdiction: string; covered: boolean }[]; blockers: { jurisdiction?: string; reason: string }[] }[];
};

async function basesOf(store: Store, product: ProductRecord, seen: string[]): Promise<Base[]> {
  const path = [...seen, product.product.id];
  const out: Base[] = [];
  for (const id of [...new Set(product.underlying_product_ids ?? [])]) {
    if (path.includes(id)) {
      out.push({ product_id: id, problem: "is built on this one in turn (a cycle)" });
      continue;
    }
    const base = await store.getProduct(id);
    if (!base) {
      out.push({ product_id: id, problem: "doesn't exist" });
      continue;
    }
    const live = base.status === "published" && Boolean(base.pins);
    const composition = compositionOf(base, live);
    // Nothing to inherit from a product with no composition (e.g. a fund a distributor sells).
    if (!composition.components.length) continue;
    const regime = await productRegime(store, base, { live, seen: path });
    out.push({
      product_id: id,
      name: base.product.name,
      published: base.status === "published",
      drifted: Boolean(base.drift),
      lead: { primitive: composition.components[0].primitive, action: composition.components[0].action },
      regions: regime.regions.map((r) => ({
        region: r.region,
        covered: r.covered,
        ...(r.jurisdictions ? { jurisdictions: r.jurisdictions } : {}),
        blockers: blockingComponents(regime, r.region).map((b) => ({ ...(b.jurisdiction ? { jurisdiction: b.jurisdiction } : {}), reason: b.reason })),
      })),
    });
  }
  return out;
}

// Whether a base covers the composed product in one region: in each jurisdiction it's offered in, or the
// country as a whole when it lists none.
function foundationIn(b: Base, region: string, offeredIn: string[]) {
  const country = region.toLowerCase();
  const label = (j: string) => (j === country ? `the whole of ${region}` : j);
  const name = `Built on '${b.product_id}'`;
  const gapIn = (j: string | null): string | null => {
    if (b.problem) return `${name}, which ${b.problem}`;
    if (!b.published) return `${name}, which isn't published`;
    if (b.drifted) return `${name}, whose sales are paused: something it rests on changed (drift)`;
    const r = b.regions?.find((x) => x.region === region);
    if (!r) return `${name}, which isn't offered in ${region}`;
    const why = (where: string | null) =>
      r.blockers
        .filter((x) => where === null || x.jurisdiction === where || x.jurisdiction === undefined)
        .map((x) => x.reason)
        .join("; ");
    if (j === null || !r.jurisdictions) return r.covered ? null : `${name}, which isn't covered in ${j === null ? region : label(j)}: ${why(null)}`;
    const row = r.jurisdictions.find((x) => x.jurisdiction === j) ?? r.jurisdictions.find((x) => x.jurisdiction === country);
    if (!row) return `${name}, which isn't offered in ${label(j)} (it's offered in ${r.jurisdictions.map((x) => label(x.jurisdiction)).join(", ")})`;
    return row.covered ? null : `${name}, which isn't covered in ${label(row.jurisdiction)}: ${why(row.jurisdiction)}`;
  };
  const where = (offeredIn.length ? offeredIn : [null]).map((j) => ({ jurisdiction: j, reason: gapIn(j) }));
  return {
    product_id: b.product_id,
    name: b.name ?? null,
    primitive: b.lead?.primitive ?? null,
    action: b.lead?.action ?? null,
    covered: where.every((w) => !w.reason),
    ...(offeredIn.length ? { jurisdictions: where.map((w) => ({ jurisdiction: w.jurisdiction!, covered: !w.reason, ...(w.reason ? { reason: w.reason } : {}) })) } : {}),
    blockers: where
      .filter((w) => w.reason)
      .map((w) => (w.jurisdiction ? { jurisdiction: w.jurisdiction, reason: `In ${w.jurisdiction.includes("-") ? w.jurisdiction : `the whole of ${region}`}: ${w.reason}` } : { reason: w.reason! })),
  };
}
// Why a component stops publishing, if it does.
function blockingReason(c: { key: string; coverage: Coverage; stakeholders: Stakeholders | null; prerequisites?: Stakeholders[] }): string | null {
  if (c.coverage.status === "uncovered" || c.coverage.status === "unmodelled" || c.coverage.status === "unassigned") return c.coverage.reason;
  // The covering licence's mandated stakeholders, then its prerequisites' (e.g. the FinCEN registration's).
  const reasons = [c.stakeholders, ...(c.prerequisites ?? [])].flatMap((s) => {
    if (!s?.enforced) return [];
    if (!s.known) return [`${s.license_id} isn't in the regulatory model any more, so its mandated stakeholders can't be checked`];
    const gaps = [
      ...s.missing.map((m) => `no ${m.kind} party fills ${m.stakeholder}`),
      ...s.unqualified.map((u) => `party ${u.party_id} doesn't meet ${u.stakeholder}'s criteria (${u.failed.join(", ")})`),
      ...s.unbound.map((id) => `bind party ${id} to '${c.key}'`),
    ];
    return gaps.length ? [`${s.license_id}: ${gaps.join("; ")}`] : [];
  });
  return reasons.length ? reasons.join("; ") : null;
}

// What blocks one component: once, or once per jurisdiction it's offered in.
function rowBlockers(c: { key: string; coverage: Coverage; stakeholders: Stakeholders | null; prerequisites?: Stakeholders[]; jurisdictions?: JurisdictionRow[] }): { jurisdiction?: string; reason: string }[] {
  if (!c.jurisdictions) {
    const reason = blockingReason(c);
    return reason ? [{ reason }] : [];
  }
  return c.jurisdictions.flatMap((j) => {
    const reason = blockingReason({ key: c.key, coverage: j.coverage, stakeholders: j.stakeholders, prerequisites: j.prerequisites });
    return reason ? [{ jurisdiction: j.jurisdiction, reason: `In ${j.jurisdiction.includes("-") ? j.jurisdiction : `the whole of ${j.jurisdiction.toUpperCase()}`}: ${reason}` }] : [];
  });
}

// Components that stop publishing: not covered, not modelled, no provider, or the providing licence's
// mandated stakeholders not filled on the roster and bound. A component offered in several jurisdictions
// is listed once per jurisdiction it's blocked in (component × state). A product it's built on that doesn't
// cover it somewhere is listed as 'builds_on:<product id>', once per jurisdiction too.
export function blockingComponents(regime: Awaited<ReturnType<typeof productRegime>>, region: string): Blocker[] {
  return regime.regions
    .filter((r) => region === "global" || r.region === region)
    .flatMap((r) => [
      ...r.components.flatMap((c) =>
        rowBlockers(c).map((b) => ({ region: r.region, ...(b.jurisdiction ? { jurisdiction: b.jurisdiction } : {}), key: c.key, primitive: c.primitive, action: c.action, reason: b.reason })),
      ),
      ...(r.foundations ?? []).flatMap((f) =>
        f.blockers.map((b) => ({ region: r.region, ...(b.jurisdiction ? { jurisdiction: b.jurisdiction } : {}), key: `builds_on:${f.product_id}`, primitive: f.primitive ?? "", action: f.action ?? "", reason: b.reason })),
      ),
    ]);
}
export type Blocker = { region: string; jurisdiction?: string; key: string; primitive: string; action: string; reason: string };

// Partner-provided components whose providing licence has stakeholder gaps on the partner's roster (advisory).
export function partnerGaps(regime: Awaited<ReturnType<typeof productRegime>>) {
  return regime.regions.flatMap((r) => r.components.filter((c) => c.stakeholders && !c.stakeholders.enforced && !c.stakeholders.complete).map((c) => ({ region: r.region, key: c.key })));
}
