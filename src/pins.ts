import { createHash } from "node:crypto";
import { licenseInForce } from "./access.js";
import { legitimacyState } from "./firm-checks.js";
import { partyActive } from "./parties.js";
import type { productRegime } from "./regime.js";
import { emitProductEvent } from "./runtime.js";
import type { DriftChange, Entity, HeldLicense, Party, Pins, ProductRecord, Sponsorship, Store } from "./store.js";
import { recomputeDerived } from "./derived.js";
import { vendorStateOf } from "./vendors.js";

// Publishing pins a product's live composition and the state of everything it rests on: the owner, every
// provider entity, each providing licence, and every party standing behind a component. When any of them
// changes (a licence lapses or is suspended, a party leaves, an entity is struck off) the product has
// drifted: new sales pause until the state is restored or a new version is published.

const hash = (v: unknown) => "sha256:" + createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
const entityState = (e: Entity | undefined) => (e ? hash({ status: e.status, legal_form: e.legal_form, identifiers: e.identifiers }) : "missing");
const licenceState = (l: HeldLicense | undefined) =>
  l ? hash({ status: l.status, in_force: licenseInForce(l), registration_number: l.registration_number, valid_from: l.valid_from, valid_to: l.valid_to }) : "missing";
// A licence provider's sponsorship: approved, under which licences, where (see sponsorships.ts).
const sponsorshipState = (s: Sponsorship | undefined) =>
  s ? hash({ status: s.status, licence_ids: [...s.licence_ids].sort(), jurisdictions: [...s.jurisdictions].sort() }) : "missing";
const partyState = (p: Party | undefined) =>
  p ? hash({ active: partyActive(p), status: p.status, until: p.until, person: p.person, legal_entity_id: p.legal_entity_id, fills: p.fills, attributes: p.attributes }) : "missing";

// The pins for a product about to go live, from its (already checked) regime.
export async function buildPins(store: Store, record: ProductRecord, version: number, regime: Awaited<ReturnType<typeof productRegime>>): Promise<Pins> {
  const rows = regime.regions.flatMap((r) => r.components);
  const entityIds = new Set<string>(record.entity_id ? [record.entity_id] : []);
  const licenceIds = new Set<string>();
  const partyIds = new Set<string>(record.parties.map((b) => b.party_id));
  // The jurisdictions each pinned licence covers this product in, so a drift says which states it touches.
  const licenceJurisdictions: Record<string, string[]> = {};
  // The sponsorships covering a component, with the jurisdictions each covers this product in.
  const sponsorshipJurisdictions: Record<string, string[]> = {};
  for (const c of rows) {
    if (c.provider_entity_id) entityIds.add(c.provider_entity_id);
    if (c.provider?.by === "party") partyIds.add(c.provider.party_id);
    // The covering licence and the prerequisites it counts only with (a state licence's FinCEN registration).
    if (c.jurisdictions) {
      for (const j of c.jurisdictions) {
        if (j.coverage.status === "covered") {
          for (const id of [j.coverage.by[0].licence_id, ...(j.coverage.by[0].requires ?? [])]) {
            licenceIds.add(id);
            licenceJurisdictions[id] = [...new Set([...(licenceJurisdictions[id] ?? []), j.jurisdiction])];
          }
          const sponsorship = j.coverage.by[0].sponsorship_id;
          if (sponsorship) sponsorshipJurisdictions[sponsorship] = [...new Set([...(sponsorshipJurisdictions[sponsorship] ?? []), j.jurisdiction])];
        }
        for (const s of [j.stakeholders, ...(j.prerequisites ?? [])]) for (const f of s?.filled ?? []) for (const id of f.party_ids) partyIds.add(id);
      }
    } else if (c.coverage.status === "covered") {
      for (const id of [c.coverage.by[0].licence_id, ...(c.coverage.by[0].requires ?? [])]) licenceIds.add(id);
      const sponsorship = c.coverage.by[0].sponsorship_id;
      if (sponsorship) sponsorshipJurisdictions[sponsorship] ??= [];
    }
    for (const s of [c.stakeholders, ...(c.prerequisites ?? [])]) for (const f of s?.filled ?? []) for (const id of f.party_ids) partyIds.add(id);
  }
  // The products it's built on: their state, and the entities they rest on (so a sweep for the partner's
  // entity re-checks this product too).
  const products: Record<string, string> = {};
  for (const id of record.underlying_product_ids ?? []) {
    const base = await store.getProduct(id);
    if (!base?.pins) continue;
    for (const e of base.pins.entity_ids) entityIds.add(e);
    products[id] = (await baseState(store, base)).state;
  }
  const parties = new Map<string, Party>();
  for (const id of partyIds) {
    const p = await store.getParty(id);
    if (p) {
      parties.set(id, p);
      if (p.legal_entity_id) entityIds.add(p.legal_entity_id);
    }
  }
  // Self-provided components without a named licence are pinned to the one that covers them; one offered in
  // several jurisdictions only when a single licence covers all of them (else each state's licence is pinned
  // in the state above, and drift catches any of them changing).
  const components = record.components.map((c) => {
    const row = rows.find((r) => r.key === c.key);
    if (c.provider?.by !== "self" || c.provider.licence_id || row?.coverage.status !== "covered") return c;
    const used = row.jurisdictions ? [...new Set(row.jurisdictions.map((j) => (j.coverage.status === "covered" ? j.coverage.by[0].licence_id : "")))] : [row.coverage.by[0].licence_id];
    return used.length === 1 && used[0] ? { ...c, provider: { by: "self" as const, licence_id: used[0] } } : c;
  });
  const state: Pins["state"] = { entities: {}, licences: {}, parties: {} };
  for (const id of entityIds) state.entities[id] = entityState(await store.getEntity(id));
  for (const id of licenceIds) state.licences[id] = licenceState(await store.getHeldLicense(id));
  for (const [id, p] of parties) state.parties[id] = partyState(p);
  if (Object.keys(products).length) state.products = products;
  if (Object.keys(sponsorshipJurisdictions).length) {
    state.sponsorships = {};
    for (const id of Object.keys(sponsorshipJurisdictions)) state.sponsorships[id] = sponsorshipState(await store.getSponsorship(id));
  }
  return {
    version,
    pinned_at: new Date().toISOString(),
    components,
    parties: record.parties,
    entity_ids: [...entityIds],
    state,
    ...(Object.keys(licenceJurisdictions).length ? { licence_jurisdictions: licenceJurisdictions } : {}),
    ...(Object.values(sponsorshipJurisdictions).some((j) => j.length)
      ? { sponsorship_jurisdictions: Object.fromEntries(Object.entries(sponsorshipJurisdictions).filter(([, j]) => j.length)) }
      : {}),
  };
}

// What changed in a product's pinned state, if anything.
export async function pinChanges(store: Store, pins: Pins, depth = 0): Promise<DriftChange[]> {
  const changes: DriftChange[] = [];
  const check = async (kind: DriftChange["kind"], pinned: Record<string, string>, now: (id: string) => Promise<string>) => {
    for (const [id, was] of Object.entries(pinned)) {
      const current = await now(id);
      if (current !== was) changes.push({ kind, id, was, now: current });
    }
  };
  await check("entity", pins.state.entities, async (id) => entityState(await store.getEntity(id)));
  await check("licence", pins.state.licences, async (id) => licenceState(await store.getHeldLicense(id)));
  // A licence pinned for named jurisdictions (a state licence) says which ones lose coverage.
  for (const c of changes) if (c.kind === "licence" && pins.licence_jurisdictions?.[c.id]) c.jurisdictions = pins.licence_jurisdictions[c.id];
  await check("party", pins.state.parties, async (id) => partyState(await store.getParty(id)));
  // Licence providers' sponsorships (revoked: the states it covered lose coverage).
  const before = changes.length;
  await check("sponsorship", pins.state.sponsorships ?? {}, async (id) => sponsorshipState(await store.getSponsorship(id)));
  for (const c of changes.slice(before)) if (pins.sponsorship_jurisdictions?.[c.id]) c.jurisdictions = pins.sponsorship_jurisdictions[c.id];
  // The sponsoring firms must stay shown to be real: a mismatch or lapse in the public checks of a licence
  // provider (see firm-checks.ts) drifts the product as its licence lapsing would. Nothing is pinned for this:
  // the expected state is always "clear", so products published before these checks existed are covered too.
  const providers = new Map<string, string[]>();
  for (const id of Object.keys(pins.state.sponsorships ?? {})) {
    const s = await store.getSponsorship(id);
    if (s) providers.set(s.provider_entity_id, [...new Set([...(providers.get(s.provider_entity_id) ?? []), ...(pins.sponsorship_jurisdictions?.[id] ?? [])])]);
  }
  for (const [entityId, jurisdictions] of providers) {
    const now = await legitimacyState(store, entityId);
    if (now !== "clear") changes.push({ kind: "legitimacy", id: entityId, was: "clear", now, ...(jurisdictions.length ? { jurisdictions } : {}) });
  }
  // Vendor services the live version hands off through (see vendors.ts).
  await check("vendor", pins.state.vendors ?? {}, (id) => vendorStateOf(store, id));
  // Products it's built on: unpublished, offered somewhere else, or drifted themselves (checked afresh, so the
  // order products are swept in doesn't matter). Their drift's states are this product's too.
  const offered = new Set(pins.components.flatMap((c) => c.offered_in ?? []));
  for (const [id, was] of Object.entries(pins.state.products ?? {})) {
    const base = await store.getProduct(id);
    const now = base ? await baseState(store, base, depth) : { state: "missing", jurisdictions: [] };
    if (now.state === was) continue;
    const jurisdictions = offered.size ? now.jurisdictions.filter((j) => offered.has(j)) : now.jurisdictions;
    changes.push({ kind: "product", id, was, now: now.state, ...(jurisdictions.length ? { jurisdictions } : {}) });
  }
  return changes;
}

// A product another is built on, as that one pins it: whether it's live, where it's offered, and whether it
// has drifted (with the states its drift touches).
async function baseState(store: Store, base: ProductRecord, depth = 0): Promise<{ state: string; jurisdictions: string[] }> {
  const changes = base.status === "published" && base.pins && depth < 5 ? await pinChanges(store, base.pins, depth + 1) : [];
  const offered = [...new Set((base.pins?.components ?? base.components).flatMap((c) => c.offered_in ?? []))].sort();
  return {
    state: hash({ published: base.status === "published", offered, drifted: changes.length > 0 }),
    jurisdictions: [...new Set(changes.flatMap((c) => c.jurisdictions ?? []))],
  };
}

// Re-checks the published products built on this one, after it's unpublished or a new version goes live.
export async function driftDependents(store: Store, productId: string) {
  const drifted: string[] = [];
  for (const record of await store.productsBuiltOn(productId)) if (await checkDrift(store, record)) drifted.push(record.product.id);
  return drifted;
}

// Re-checks one product: records drift (pausing new sales) or clears it once the pinned state is back.
export async function checkDrift(store: Store, record: ProductRecord) {
  if (!record.pins || record.status !== "published") return null;
  const changes = await pinChanges(store, record.pins);
  const key = (c: DriftChange[]) => JSON.stringify(c.map((x) => [x.kind, x.id, x.now]));
  if (changes.length) {
    if (record.drift && key(record.drift.changes) === key(changes)) return record.drift;
    // Mynt's runtime doesn't reliably know a customer's state (a session may carry no customer, and the vault
    // no address), so a state losing coverage pauses the whole product, and the drift note says which states.
    const states = [...new Set(changes.flatMap((c) => c.jurisdictions ?? []))];
    const drift = {
      detected_at: record.drift?.detected_at ?? new Date().toISOString(),
      changes,
      ...(states.length
        ? { note: `Coverage changed in ${states.join(", ")}. New sales pause for the whole product, not only there: Mynt can't tell which state a customer is in when a sale starts` }
        : {}),
    };
    await store.setDrift(record.product.id, drift);
    if (!record.drift) {
      await store.audit(null, "product_drifted", record.product.id, { changes });
      await emitProductEvent(store, record.product.id, "product.drifted", { changes });
    }
    return drift;
  }
  if (record.drift) {
    await store.setDrift(record.product.id, null);
    await store.audit(null, "product_drift_cleared", record.product.id, {});
    await emitProductEvent(store, record.product.id, "product.drift_cleared", {});
  }
  return null;
}

// Re-checks every published product resting on this entity (all of them without one), and recomputes the
// stored regime summary and take rate of every product resting on it (see derived.ts).
export async function driftSweep(store: Store, entityId?: string) {
  const drifted: string[] = [];
  for (const record of await store.pinnedProducts(entityId)) if (await checkDrift(store, record)) drifted.push(record.product.id);
  await recomputeDerived(store, entityId ? { entity_id: entityId } : {});
  return drifted;
}
