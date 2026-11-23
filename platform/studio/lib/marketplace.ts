// The Marketplace page (/marketplace): standard services from service providers (Mynt's vendors), each under the
// provider's standard terms, which an app's workspace subscribes to by accepting them (no negotiation). Pure: Mynt's
// replies (list_vendor_offerings) into rows, the filters, and the CSV. Billing is between the provider and the
// subscriber directly; Mynt never bills or holds money for it.
import { toCsv } from "./compliance";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const CATEGORY_LABELS: Record<string, string> = {
  identity: "Identity",
  kyc: "KYC",
  account_data: "Account data",
  analytics: "Analytics",
  credit_bureau: "Credit bureau",
  documents: "Documents",
  esign: "E-signature",
  mandate: "Payment mandates",
  fraud: "Fraud",
  ramp: "Dollars in and out",
  other: "Other",
};
export const categoryLabel = (c: string) => CATEGORY_LABELS[c] ?? c;

export type StandardTerms = { version: number; documentUrl: string; documentSha256: string; summary: string; pricing: string; setAt: string | null };
export type Conformance = { passed: boolean; at: string | null } | null;
export type ProviderLicence = { type: string; number: string | null; inForce: boolean };

export type Offering = {
  id: string;
  name: string;
  provider: string;
  providerEntityId: string | null;
  region: string;
  serviceType: string; // its name
  serviceKey: string;
  category: string;
  consentPurpose: string | null;
  fills: string[];
  requiredLicences: string[]; // licence types your firm must hold (one of)
  terms: StandardTerms | null; // null: no standard terms on file
  pricing: string; // the terms' pricing in words, else the price per call
  slaNotes: string;
  liveAvailable: boolean;
  requiresCredential: boolean;
  providerLicences: ProviderLicence[];
  conformance: Conformance;
  canSubscribe: boolean;
  prerequisite: string | null;
  subscriptionId: string | null; // your firm's active subscription
};

const money = (p: unknown) => {
  if (!isObj(p) || typeof p.amount !== "number" || !str(p.currency)) return null;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: p.currency as string, maximumFractionDigits: 4 }).format(p.amount);
  return `${amount} per call`;
};

export function fromOfferings(reply: unknown): Offering[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((o): Offering[] => {
      const id = str(o.offering_id);
      if (!id) return [];
      const t = isObj(o.service_type) ? o.service_type : {};
      const st = isObj(o.standard_terms) ? o.standard_terms : null;
      const terms: StandardTerms | null =
        st && typeof st.version === "number" && str(st.document_url)
          ? { version: st.version, documentUrl: str(st.document_url)!, documentSha256: str(st.document_sha256) ?? "", summary: str(st.summary) ?? "", pricing: str(st.pricing_summary) ?? "", setAt: str(st.set_at) }
          : null;
      const conf = isObj(o.conformance) ? { passed: o.conformance.passed === true, at: str(o.conformance.at) } : null;
      return [
        {
          id,
          name: str(o.name) ?? "Unnamed service",
          provider: str(o.vendor) ?? "Unnamed provider",
          providerEntityId: str(o.vendor_entity_id),
          region: str(o.region) ?? "—",
          serviceType: str(t.name) ?? str(t.key) ?? "Service",
          serviceKey: str(t.key) ?? "",
          category: str(t.category) ?? "other",
          consentPurpose: str(t.consent_purpose),
          fills: arr(t.fills).map(str).filter((f): f is string => Boolean(f)),
          requiredLicences: arr(t.innovator_licences).map(str).filter((f): f is string => Boolean(f)),
          terms,
          pricing: terms?.pricing || money(o.price) || "Not stated",
          slaNotes: str(o.sla_notes) ?? "",
          liveAvailable: o.live_available === true,
          requiresCredential: o.requires_credential === true,
          providerLicences: arr(o.vendor_licences)
            .filter(isObj)
            .map((l) => ({ type: str(l.license_id) ?? "Licence", number: str(l.registration_number), inForce: l.in_force === true })),
          conformance: conf,
          canSubscribe: o.you_can_subscribe === true,
          prerequisite: str(o.prerequisite),
          subscriptionId: str(o.your_subscription_id),
        },
      ];
    });
}

/** Conformance in words: Mynt's own test of the provider's endpoint, never the provider's word. */
export function conformanceText(c: Conformance): string {
  if (!c) return "Not tested yet";
  return c.passed ? "Passed Mynt's test" : "Failed Mynt's last test";
}

/** Prerequisites in words. */
export const prerequisiteText = (o: Pick<Offering, "canSubscribe" | "prerequisite">) => (o.canSubscribe ? "You meet them" : (o.prerequisite ?? "Not met"));

/** Why Subscribe can't be used on this offering, or null when it can (subscribed already: for another app). */
export function subscribeBlocker(o: Offering): string | null {
  if (!o.terms) return "This provider has no standard terms on file yet, so there's nothing to accept.";
  if (!o.canSubscribe) return o.prerequisite ?? "Your firm doesn't meet the prerequisites.";
  return null;
}

export type MarketplaceApp = { id: string; name: string; productIds: string[]; canManage: boolean | null };
export type ForApp = { id: string; name: string; regions: string[] };

export function appsFrom(reply: unknown): MarketplaceApp[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((a): MarketplaceApp[] => {
      const id = str(a.id);
      if (!id) return [];
      return [{ id, name: str(a.name) ?? "Untitled app", productIds: arr(a.product_ids).map(str).filter((p): p is string => Boolean(p)).slice(0, 20), canManage: null }];
    });
}

// ---- filters ----

export type MarketplaceFilters = { query: string; region: string[]; category: string[]; service: string[] };
export const NO_MARKETPLACE_FILTERS: MarketplaceFilters = { query: "", region: [], category: [], service: [] };

export function filterOfferings(rows: Offering[], f: MarketplaceFilters): Offering[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((o) => {
    if (f.region.length && !f.region.includes(o.region)) return false;
    if (f.category.length && !f.category.includes(o.category)) return false;
    if (f.service.length && !f.service.includes(o.serviceKey)) return false;
    const text = [o.provider, o.name, o.serviceType, categoryLabel(o.category), o.region, o.pricing].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export const distinctSorted = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));

/** The address's filters: ?region=US&category=kyc&app=<id> (each may repeat, or be comma separated). */
export function filtersFromSearch(search: string | URLSearchParams): { filters: MarketplaceFilters; appId: string | null; offeringId: string | null } {
  const p = typeof search === "string" ? new URLSearchParams(search) : search;
  const list = (k: string) => p.getAll(k).flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => /^[A-Za-z0-9_-]{1,60}$/.test(v));
  const id = (k: string) => {
    const v = p.get(k);
    return v && /^[A-Za-z0-9_-]{1,200}$/.test(v) ? v : null;
  };
  return {
    filters: { query: (p.get("q") ?? "").slice(0, 200), region: list("region").map((r) => r.toUpperCase()), category: list("category"), service: list("service") },
    appId: id("app"),
    offeringId: id("offering"),
  };
}

/** The Marketplace for one app (its Agreements tab's Browse vendors). */
export const marketplaceHref = (appId?: string) => (appId ? `/marketplace?app=${encodeURIComponent(appId)}` : "/marketplace");

export function marketplaceCsv(rows: Offering[]): string {
  return toCsv(
    ["Provider", "Service", "Category", "Region", "Pricing", "Standard terms", "Conformance", "Prerequisites"],
    rows.map((o) => [o.provider, o.name, categoryLabel(o.category), o.region, o.pricing, o.terms ? `v${o.terms.version}` : "None on file", conformanceText(o.conformance), prerequisiteText(o)]),
  );
}

// ---- the Subscribe sheet ----

export type SubscribeRequest = {
  offering_id: string;
  accept_terms_version: number;
  app_ids: string[];
  products?: string[];
  test_credential?: string;
  credential_label?: string;
};
