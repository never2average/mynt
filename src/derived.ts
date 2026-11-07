import { blockingComponents, productRegime } from "./regime.js";
import { normalizeModel } from "./regulatory.js";
import type { ProductRecord, Store } from "./store.js";
import { productTakeRate } from "./take-rates.js";

// What Mynt's own code says about a product, stored on it so it's exact and cheap to read: the coverage of
// its regime (productRegime and blockingComponents, projected without registration numbers or who the
// parties are) and the take rate get_product_take_rate would show. It's recomputed when the product is
// composed, defined or published, when anything it rests on changes (the drift sweep: licences, roster,
// entity status, and hourly for everything), when the regulatory model or a take rate changes, and on boot
// for products that have none yet. Computing it never stops anything else: a failure is stored as a note.

type Regime = Awaited<ReturnType<typeof productRegime>>;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Mynt's reasons name roster parties and held licences by id; the stored summary says what, not who.
const redact = (reason: string) =>
  reason
    .replace(new RegExp(`\\bparty '?${UUID}'?`, "gi"), "a party")
    .replace(new RegExp(`\\bLicence '${UUID}'`, "g"), "The pinned licence")
    .replace(new RegExp(UUID, "gi"), "(id withheld)");

// The regime, as stored: per region and component, its coverage and by which regulator and licence type,
// who supervises it, the mandated stakeholders required against those filled and bound, and the publish blockers.
// A component offered in named jurisdictions (US states) also has a row per jurisdiction, and the region says
// which of them are covered.
export async function regimeSummary(store: Store, record: ProductRecord, regime?: Regime) {
  const live = record.status === "published" && Boolean(record.pins);
  regime ??= await productRegime(store, record, { live });
  const ref = await store.referenceData(true);
  const blockers = blockingComponents(regime, record.product.region);
  return {
    composition: regime.live ? ("live" as const) : ("working_copy" as const),
    composed: regime.composed,
    product_region: record.product.region,
    publishable: regime.composed && blockers.length === 0,
    regions: regime.regions.map((r) => {
      const model = normalizeModel(ref.regions.find((x) => x.code === r.region)?.regulatory);
      const regulator = (id: string) => ({ regulator_id: id, name: model.regulators.find((x) => x.id === id)?.name ?? id });
      const coverageOf = (cov: (typeof r.components)[number]["coverage"], c: (typeof r.components)[number]) =>
        cov.status === "covered"
          ? {
              status: cov.status,
              by: cov.by.map((b) => ({
                ...regulator(b.regulator_id),
                license_id: b.license_id,
                licence: c.licences.find((l) => l.regulator_id === b.regulator_id && l.license_id === b.license_id)?.name ?? b.license_id,
              })),
            }
          : { status: cov.status, reason: redact(cov.reason), by: [] };
      return {
        region: r.region,
        covered: r.covered,
        ...(r.jurisdictions ? { jurisdictions: r.jurisdictions } : {}),
        // The products it's built on, and where each covers it.
        ...(r.foundations
          ? {
              built_on: r.foundations.map((f) => ({
                product_id: f.product_id,
                name: f.name,
                covered: f.covered,
                ...(f.jurisdictions ? { jurisdictions: f.jurisdictions.map((j) => ({ jurisdiction: j.jurisdiction, covered: j.covered, ...(j.reason ? { reason: redact(j.reason) } : {}) })) } : {}),
              })),
            }
          : {}),
        regulators: r.regulators.map(regulator),
        components: r.components.map((c) => {
          const cov = c.coverage;
          const s = c.stakeholders;
          const blocking = blockers.find((b) => b.region === r.region && b.key === c.key);
          return {
            key: c.key,
            primitive: c.primitive,
            action: c.action,
            ...(c.underlying ? { underlying: c.underlying } : {}),
            ...(c.wrapper ? { wrapper: c.wrapper } : {}),
            provided_by: c.provider?.by === "self" ? ("self" as const) : c.provider?.by === "party" ? ("partner" as const) : null,
            coverage: coverageOf(cov, c),
            ...(c.jurisdictions
              ? {
                  jurisdictions: c.jurisdictions.map((j) => {
                    const b = blockers.find((x) => x.region === r.region && x.key === c.key && x.jurisdiction === j.jurisdiction);
                    return { jurisdiction: j.jurisdiction, coverage: coverageOf(j.coverage, c), blocking: b ? redact(b.reason) : null };
                  }),
                }
              : {}),
            supervised_by: c.supervised_by,
            licences_granting: c.licences,
            stakeholders: s
              ? {
                  regulator_id: s.regulator_id,
                  license_id: s.license_id,
                  known: s.known,
                  enforced: s.enforced,
                  complete: s.complete,
                  required: s.mandated,
                  filled: s.filled.map((f) => f.stakeholder),
                  // Bound to this component in the product: checked only where the owner provides it.
                  bound: s.enforced ? s.filled.length - s.unbound.length : null,
                  missing: s.missing.map((m) => ({ stakeholder: m.stakeholder, name: m.name, kind: m.kind })),
                  unqualified: s.unqualified.map((u) => ({ stakeholder: u.stakeholder, failed: u.failed })),
                  unbound: s.unbound.length,
                }
              : null,
            blocking: blocking ? redact(blocking.reason) : null,
          };
        }),
      };
    }),
    publish_blockers: blockers.map((b) => ({ ...b, reason: redact(b.reason) })),
  };
}

// The take rate, as stored: what get_product_take_rate shows, with a reason when no rate applies.
export async function takeRateSummary(store: Store, record: ProductRecord) {
  const t = await productTakeRate(store, record);
  if (!t.configured) return { line: t.line, configured: false as const, rate_pct: null, reason: t.message, workload: t.workload };
  return t;
}

const note = (what: string, e: unknown) => ({ error: `Mynt couldn't compute ${what}: ${redact((e as Error)?.message ?? String(e))}` });

// Recomputes and stores one product's derived values. Never throws.
export async function deriveProduct(store: Store, record: ProductRecord, regime?: Regime) {
  const [summary, rate] = await Promise.all([
    regimeSummary(store, record, regime).catch((e) => note("the regime", e)),
    takeRateSummary(store, record).catch((e) => note("the take rate", e)),
  ]);
  try {
    await store.setProductDerived(record.product.id, summary, rate);
    return { product_id: record.product.id, ok: !("error" in summary) && !("error" in rate) };
  } catch (e) {
    console.error(`deriving ${record.product.id}:`, (e as Error).message);
    return { product_id: record.product.id, ok: false };
  }
}

export interface DeriveScope {
  product_ids?: string[];
  entity_id?: string; // products resting on this legal entity
  line?: string; // products on this product line
  region?: string; // products with a component (or offered) in this region
  missing_only?: boolean; // only products not derived yet
}

// Recomputes the derived values of every product in scope (all of them without one). Never throws.
export async function recomputeDerived(store: Store, scope: DeriveScope = {}) {
  try {
    let products = scope.entity_id ? await store.productsRestingOn(scope.entity_id) : await store.allProducts();
    if (scope.product_ids) products = products.filter((p) => scope.product_ids!.includes(p.product.id));
    if (scope.line) products = products.filter((p) => p.product.product_line === scope.line);
    if (scope.region) {
      const region = scope.region.toUpperCase();
      products = products.filter((p) => p.product.region === region || p.product.region === "global" || p.components.some((c) => c.country.toUpperCase() === region));
    }
    if (scope.missing_only) {
      const missing = new Set(await store.productsNotDerived());
      products = products.filter((p) => missing.has(p.product.id));
    }
    const results = [];
    for (const p of products) results.push(await deriveProduct(store, p));
    return { recomputed: results.length, failed: results.filter((r) => !r.ok).map((r) => r.product_id) };
  } catch (e) {
    console.error("recomputing derived product values:", (e as Error).message);
    return { recomputed: 0, failed: [], error: (e as Error).message };
  }
}

// Recomputes one product by id, after it's been changed. Never throws.
export async function rederiveProduct(store: Store, productId: string) {
  try {
    const record = await store.getProduct(productId);
    if (record) await deriveProduct(store, record);
  } catch (e) {
    console.error(`deriving ${productId}:`, (e as Error).message);
  }
}
