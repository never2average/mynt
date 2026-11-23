// An app's right-hand panel in the builder (beside its chat): besides Preview, the information
// tabs Products, Agreements, Customers, Security, P&L, SDK and Activity, each read live from Mynt
// and only for this app. There's no Licences tab: an app holds no licences, its products do.
// Tabs show information; anything that changes state (promoting, moving back, setting target
// states) is a labelled action elsewhere (the top bar's Promote button and its sheet). Pure: the
// route reads Mynt's replies into these shapes, and the tabs and the tests share them.
import { esignOf, esignStatusLine, type EsignInfo } from "./agreement-esign";
import type { AgreementAuditSummary } from "./agreement-audits";
import { CHECK_LABELS, coverageFrom, type AgreementCoverage, type PromotionCheck } from "./promotions";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const APP_TABS = ["preview", "products", "agreements", "customers", "security", "pnl", "sdk", "activity"] as const;
export type AppTab = (typeof APP_TABS)[number];
export const APP_TAB_LABELS: Record<AppTab, string> = {
  preview: "Preview",
  products: "Products",
  agreements: "Agreements",
  customers: "Customers",
  security: "Security",
  pnl: "P&L",
  sdk: "SDK",
  activity: "Activity",
};
export type InfoTab = Exclude<AppTab, "preview">;
// The builder chat's slash commands ask the workspace shell to show a tab: detail { projectId, tab }.
export const PANEL_TAB_EVENT = "adorable:panel-tab";
export const isAppTab = (v: unknown): v is AppTab => typeof v === "string" && (APP_TABS as readonly string[]).includes(v);
export const isInfoTab = (v: unknown): v is InfoTab => typeof v === "string" && v !== "preview" && (APP_TABS as readonly string[]).includes(v);

// What a tab shows when Mynt can't answer it yet: said so, never an empty table or zeros.
export type NotYet = { available: false; reason: string };
export const NOT_YET = (reason: string): NotYet => ({ available: false, reason });

// ---- P&L (get_workspace_pnl with app_id) ----

export type PnlColumn = { key: string; label: string };
export type PnlLine = { key: string; label: string; values: Record<string, number | null>; measured: boolean };
export type AppPnl = {
  available: true;
  series: { start: string; revenueCents: number | null; costsCents: number | null; netCents: number | null }[];
  columns: PnlColumn[];
  revenue: PnlLine[];
  costs: PnlLine[];
  totals: { revenue: Record<string, number | null>; costs: Record<string, number | null>; net: Record<string, number | null> };
  unmeasured: { label: string; reason: string }[];
};
const values = (v: unknown): Record<string, number | null> => (isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, num(x)])) : {});
const lines = (v: unknown): PnlLine[] =>
  arr(v)
    .filter(isObj)
    .map((l) => ({ key: str(l.key) ?? "", label: str(l.label) ?? "", values: values(l.values), measured: l.measured === true }))
    .filter((l) => l.label);

export function fromPnl(reply: unknown): AppPnl | null {
  if (!isObj(reply) || !isObj(reply.statement)) return null;
  const s = reply.statement;
  const totals = isObj(s.totals) ? s.totals : {};
  return {
    available: true,
    series: arr(reply.series)
      .filter(isObj)
      .map((p) => ({ start: str(p.start) ?? "", revenueCents: num(p.revenue_cents), costsCents: num(p.costs_cents), netCents: num(p.net_cents) })),
    columns: arr(s.columns)
      .filter(isObj)
      .map((c) => ({ key: str(c.key) ?? "", label: str(c.label) ?? str(c.key) ?? "" }))
      .filter((c) => c.key),
    revenue: lines(s.revenue),
    costs: lines(s.costs),
    totals: { revenue: values(totals.revenue), costs: values(totals.costs), net: values(totals["net"]) },
    unmeasured: arr(reply.unmeasured)
      .filter(isObj)
      .map((u) => ({ label: str(u.label) ?? str(u.key) ?? "", reason: str(u.reason) ?? "" }))
      .filter((u) => u.label),
  };
}

// ---- Products, Agreements and Customers (list_app_agreements and get_app_customers, for this app) ----
//
// An app is the distribution layer and holds no licences of its own: the products it uses are the
// regulated things, each with its stage and the licence providers sponsoring it in some states. The
// app's workspace holds agreements with those firms (and its vendors), and targets customer personas
// its products declare.

export const STAGE_TEXT: Record<string, string> = { idea: "Idea", staging: "Staging", production: "Production" };
export type Sponsor = { entityId: string; name: string; states: string[] };
export type AppProduct = { id: string; name: string; stage: string | null; sponsors: Sponsor[]; states: string[]; missing: boolean };
// Production needs a signed program agreement in force with each product's sponsor (Mynt's program_agreements
// check). `flagged`: the app is in production already and one ended or expired; it keeps running, its checks fail.
export type AgreementGate = { met: boolean; missing: string[]; flagged: boolean };
export type AppProducts = {
  available: true;
  products: AppProduct[];
  productionCheck: PromotionCheck | null; // the licences check, while the app's next stage is production
  agreementCheck?: PromotionCheck | null; // the program agreements check, likewise
  coverage?: AgreementCoverage[]; // each product and sponsor, and whether a signed agreement covers it
  gate?: AgreementGate | null;
  canManage?: boolean; // an owner or admin: offered Propose agreement for a missing one
};

export function gateFrom(v: unknown): AgreementGate | null {
  if (!isObj(v)) return null;
  return { met: v.met === true, missing: arr(v.missing).map(str).filter((s): s is string => Boolean(s)), flagged: v.flagged === true };
}

// What the Propose agreement sheet offers, from the coverage rows: each sponsor with the products it sponsors.
export function sponsorsFromCoverage(coverage: AgreementCoverage[]): { sponsors: AppAgreements["sponsors"]; products: AppAgreements["products"] } {
  const sponsors = new Map<string, { entityId: string; name: string; productIds: string[] }>();
  const products = new Map<string, string>();
  for (const c of coverage) {
    const s = sponsors.get(c.sponsorId) ?? { entityId: c.sponsorId, name: c.sponsorName, productIds: [] };
    if (!s.productIds.includes(c.productId)) s.productIds.push(c.productId);
    sponsors.set(c.sponsorId, s);
    products.set(c.productId, c.productName);
  }
  return { sponsors: [...sponsors.values()], products: [...products].map(([id, name]) => ({ id, name })) };
}

const sponsorsFrom = (v: unknown): Sponsor[] =>
  arr(v)
    .filter(isObj)
    .flatMap((s) => {
      const entityId = str(s.entity_id);
      return entityId ? [{ entityId, name: str(s.name) ?? "Unnamed firm", states: arr(s.jurisdictions).map(str).filter((j): j is string => Boolean(j)) }] : [];
    });

export function appProductsFrom(reply: unknown): AppProduct[] {
  return (isObj(reply) ? arr(reply.products) : [])
    .filter(isObj)
    .flatMap((p) => {
      const id = str(p.id);
      if (!id) return [];
      return [{ id, name: str(p.name) ?? id, stage: str(p.stage), sponsors: sponsorsFrom(p.sponsors), states: arr(p.states).map(str).filter((s): s is string => Boolean(s)), missing: p.missing === true }];
    });
}

/** A state code as people read it: "us-ny" is "NY", a country code stays as it is ("US"). */
export const stateLabel = (code: string) => (code.includes("-") ? code.split("-").slice(1).join("-") : code).toUpperCase();

export const AGREEMENT_KIND_LABELS: Record<string, string> = { program: "Program agreement", vendor: "Vendor contract", data_sharing: "Data sharing" };
export const AGREEMENT_STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed: waiting for them",
  accepted: "Accepted: waiting for signatures",
  signed: "Signed",
  declined: "Declined",
  terminated: "Ended",
};
export type AgreementRow = {
  id: string;
  counterparty: string;
  kind: string; // the label
  status: string; // the label, in words
  statusKey: string;
  products: string[];
  from: string | null;
  to: string | null;
  signatures: string | null;
  esign: EsignInfo | null; // a program agreement's e-signature (Sign, Download signed copy)
  kindKey: string;
  appSigned: boolean;
  counterpartySigned: boolean;
  documentUrl: string | null; // https only
  endedReason: string | null;
};
// termsVersion: the provider's standard terms accepted for this app (the Marketplace's click-through); noStandardTerms:
// subscribed with none on file (or before the provider had any).
export type VendorContractRow = { id: string; vendor: string; offering: string; environment: string; since: string | null; termsVersion: number | null; noStandardTerms: boolean };
export type IntroRow = { id: string; counterparty: string | null; status: string; since: string | null };
export type AppAgreements = {
  available: true;
  canManage: boolean;
  agreements: AgreementRow[];
  vendorContracts: VendorContractRow[];
  introductions: IntroRow[] | null; // null: the business-development agent isn't running on this Mynt
  // Each agreement's oversight audits (lib/agreement-audits.ts), by agreement id; null or absent when
  // this Mynt doesn't have them (then the tab doesn't show the column, never a 0).
  audits?: Record<string, AgreementAuditSummary> | null;
  // For the Propose agreement sheet: the sponsors of the app's products, and the products.
  sponsors: { entityId: string; name: string; productIds: string[] }[];
  products: { id: string; name: string }[];
  // What production needs: each product and sponsor, and whether a signed agreement covers it.
  coverage?: AgreementCoverage[];
  gate?: AgreementGate | null;
  stage?: string | null;
};

/** A document link as the studio shows it: https only, without credentials; anything else isn't linked. */
export function documentLink(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

// What each side may do with an agreement now, by its status and signatures (Mynt decides again):
// the app's owners and admins sign an accepted one they haven't, withdraw their own proposal, and end an
// accepted or signed one; the other firm accepts or declines a proposal, signs an accepted one it hasn't, and
// ends an accepted or signed one.
export type AgreementAction = "sign" | "withdraw" | "end" | "accept" | "decline";
export function agreementActions(a: { statusKey: string; appSigned: boolean; counterpartySigned: boolean }, side: "app" | "counterparty"): AgreementAction[] {
  if (a.statusKey === "proposed") return side === "app" ? ["withdraw"] : ["accept", "decline"];
  if (a.statusKey === "accepted") return [...((side === "app" ? !a.appSigned : !a.counterpartySigned) ? (["sign"] as const) : []), "end"];
  if (a.statusKey === "signed") return ["end"];
  return [];
}
export const AGREEMENT_ACTION_LABELS: Record<AgreementAction, string> = { sign: "Sign", withdraw: "Withdraw", end: "End agreement", accept: "Accept", decline: "Decline" };

const INTRO_STATUS: Record<string, string> = { proposed: "Asked: waiting for both to say yes", agreed: "Both said yes", made: "Introduced" };

export function fromAgreements(reply: unknown): AppAgreements | null {
  if (!isObj(reply) || !Array.isArray(reply.agreements)) return null;
  const products = appProductsFrom(reply);
  const name = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const sponsors = new Map<string, { entityId: string; name: string; productIds: string[] }>();
  for (const p of products)
    for (const s of p.sponsors) {
      const e = sponsors.get(s.entityId) ?? { entityId: s.entityId, name: s.name, productIds: [] };
      e.productIds.push(p.id);
      sponsors.set(s.entityId, e);
    }
  return {
    available: true,
    canManage: reply.can_manage === true,
    agreements: arr(reply.agreements)
      .filter(isObj)
      .flatMap((a): AgreementRow[] => {
        const id = str(a.id);
        if (!id) return [];
        const statusKey = str(a.status) ?? "unknown";
        const sig = isObj(a.signatures) ? a.signatures : {};
        const esign = esignOf(a);
        const signatures = esign?.byEsign
          ? statusKey === "accepted" || statusKey === "signed"
            ? esignStatusLine(esign, "app")
            : null
          : statusKey === "accepted"
            ? `${sig.app_side === true ? "You signed" : "You haven't signed"}; ${sig.counterparty_side === true ? "they signed" : "they haven't signed"}`
            : null;
        return [
          {
            id,
            counterparty: (isObj(a.counterparty) ? str(a.counterparty.name) : null) ?? "Unnamed firm",
            kind: AGREEMENT_KIND_LABELS[str(a.kind) ?? ""] ?? str(a.kind) ?? "Agreement",
            status: AGREEMENT_STATUS_LABELS[statusKey] ?? statusKey,
            statusKey,
            products: arr(a.products).map((p) => (isObj(p) ? (str(p.name) ?? str(p.id)) : str(p) ? name(str(p)!) : null)).filter((p): p is string => Boolean(p)),
            from: str(a.effective_from),
            to: str(a.effective_to),
            signatures,
            esign,
            kindKey: str(a.kind) ?? "",
            // Each side's signature: the e-signature document's where Mynt signs by e-signature (the agreement's own
            // signatures are set only once both have signed there), else the manual ones.
            appSigned: esign?.byEsign ? esign.appSigned || sig.app_side === true : sig.app_side === true,
            counterpartySigned: esign?.byEsign ? esign.counterpartySigned || sig.counterparty_side === true : sig.counterparty_side === true,
            documentUrl: documentLink(a.document_url),
            endedReason: str(a.termination_reason),
          },
        ];
      }),
    coverage: coverageFrom(reply.program_coverage),
    gate: gateFrom(reply.production_gate),
    stage: isObj(reply["app"]) ? str(reply["app"].stage) : null,
    vendorContracts: arr(reply.vendor_contracts)
      .filter(isObj)
      .flatMap((v): VendorContractRow[] => {
        const id = str(v.subscription_id);
        if (!id) return [];
        return [
          {
            id,
            vendor: (isObj(v.vendor) ? str(v.vendor.name) : null) ?? "Unnamed vendor",
            offering: str(v.offering) ?? str(v.service_type) ?? "Service",
            environment: str(v.environment) === "live" ? "Live" : "Test",
            since: str(v.since),
            termsVersion: typeof v.terms_version === "number" ? v.terms_version : null,
            noStandardTerms: v.no_standard_terms === true,
          },
        ];
      }),
    introductions: Array.isArray(reply.introductions)
      ? reply.introductions.filter(isObj).flatMap((i): IntroRow[] => {
          const id = str(i.id);
          if (!id) return [];
          const st = str(i.status) ?? "";
          return [{ id, counterparty: isObj(i.counterparty) ? str(i.counterparty.name) : null, status: INTRO_STATUS[st] ?? (st || "Unknown"), since: str(i.since) }];
        })
      : null,
    sponsors: [...sponsors.values()],
    products: products.map((p) => ({ id: p.id, name: p.name })),
  };
}

export type Persona = { id: string; name: string; kind: string | null; targeted: boolean };
export type CustomerCount = { withSessions: number | null; inVault: number | null; reason: string | null };
export type AppCustomers = {
  available: true;
  canManage: boolean;
  products: { id: string; name: string; personas: Persona[] }[];
  live: CustomerCount;
  sandbox: CustomerCount;
};

const countFrom = (v: unknown): CustomerCount => {
  const c = isObj(v) ? v : {};
  return { withSessions: num(c.customers_with_sessions), inVault: num(c.customers_in_vault), reason: str(c.reason) };
};

export function fromCustomers(reply: unknown): AppCustomers | null {
  if (!isObj(reply) || !Array.isArray(reply.products)) return null;
  const customers = isObj(reply.customers) ? reply.customers : {};
  return {
    available: true,
    canManage: reply.can_manage === true,
    products: arr(reply.products)
      .filter(isObj)
      .flatMap((p) => {
        const id = str(p.id);
        if (!id) return [];
        const personas = arr(p.segments)
          .filter(isObj)
          .flatMap((s): Persona[] => {
            const sid = str(s.id);
            return sid ? [{ id: sid, name: str(s.name) ?? sid, kind: str(s.customer_kind), targeted: s.targeted === true }] : [];
          });
        return [{ id, name: str(p.name) ?? id, personas }];
      }),
    live: countFrom(customers.live),
    sandbox: countFrom(customers.sandbox),
  };
}

/** A count Mynt measured, or "Not measured": never 0 for want of data. */
export const countText = (n: number | null) => (n === null ? "Not measured" : String(n));

// ---- Security ----

export type PanelEvent = { at: string; action: string; actor: string | null; details: string | null };
export type AppSecurity = {
  available: true;
  // Security-class audit events about this app, when Mynt classifies its audit trail; else null with why.
  events: PanelEvent[] | null;
  eventsReason: string | null;
  // Mynt's own build checks for the app's next stage (verification, independent audit, findings, the program gate).
  checks: PromotionCheck[];
  checksReason: string | null;
};
export const SECURITY_CHECKS = ["build_verified", "audit_passed", "audit_findings", "program_gate"];

export function eventsFrom(reply: unknown, appId: string): PanelEvent[] {
  return (isObj(reply) ? arr(reply.events) : [])
    .filter(isObj)
    .filter((e) => {
      // Only this app's: Mynt filters by app_id; anything naming another app is dropped too.
      const target = isObj(e.target) ? e.target : {};
      const app = str(e.app_id) ?? (isObj(e.details) ? str(e.details.app_id) : null);
      return (app === null || app === appId) && (str(target.type) !== "app" || str(target.id) === appId);
    })
    .flatMap((e): PanelEvent[] => {
      const at = str(e.at);
      const action = str(e.action);
      if (!at || !action) return [];
      const actor = isObj(e.actor) ? (str(e.actor.name) ?? str(e.actor.id)) : null;
      return [{ at, action, actor, details: str(e.details) ?? (isObj(e.details) && Object.keys(e.details).length ? JSON.stringify(e.details) : null) }];
    });
}

// ---- SDK (get_product_sdk, per product of the app) ----

export type ProductSdk = {
  productId: string;
  name: string;
  version: string | null;
  action: string | null;
  access: string | null;
  permitted: string[];
  notPermitted: string[];
  fields: string[];
  handOff: string | null;
  generatedClients: string | null;
  hasContract: boolean;
  error: string | null;
};
export type AppSdk = { available: true; products: ProductSdk[] };

export function fromProductSdk(productId: string, reply: unknown): ProductSdk {
  const r = isObj(reply) ? reply : {};
  const product = isObj(r.product) ? r.product : {};
  const integration = isObj(r.integration) ? r.integration : {};
  const actions = isObj(integration.actions) ? integration.actions : {};
  const access = isObj(r.access) ? r.access : {};
  return {
    productId,
    name: str(product.name) ?? productId,
    version: str(r.version) ?? (num(r.version) !== null ? String(r.version) : null),
    action: str(r.action),
    access: str(access.status) ?? str(access.mode),
    permitted: Object.entries(actions).filter(([, v]) => v === "permitted").map(([k]) => k),
    notPermitted: Object.entries(actions).filter(([, v]) => v !== "permitted").map(([k]) => k),
    fields: isObj(integration.data_shape) ? Object.keys(integration.data_shape) : [],
    handOff: str(integration.hand_off),
    generatedClients: str(integration.generated_clients),
    hasContract: isObj(r.contract),
    error: null,
  };
}

// ---- Activity ----

export type BuildRow = { id: string; status: string; goal: string | null; at: string | null };
export type AppActivity = { available: true; builds: BuildRow[] | null; events: PanelEvent[] | null; eventsReason: string | null };

export function buildsFrom(reply: unknown, appId: string): BuildRow[] {
  return (isObj(reply) ? arr(reply.builds) : Array.isArray(reply) ? reply : [])
    .filter(isObj)
    .filter((b) => str(b.app_id) === null || str(b.app_id) === appId)
    .map((b) => ({ id: str(b.id) ?? "", status: str(b.status) ?? "unknown", goal: str(b.goal), at: str(b.updated_at) ?? str(b.created_at) }))
    .filter((b) => b.id)
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
    .slice(0, 25);
}

// A build's status as a dot and a word, as the dashboard shows status: done green, stopped short
// red, still going (or paused) amber; a status Mynt didn't send is just the word.
export function buildTone(status: string): "green" | "amber" | "red" | null {
  if (status === "succeeded") return "green";
  if (/fail|block|over_budget|error/.test(status)) return "red";
  return status === "unknown" || !status.trim() ? null : "amber";
}
export function buildStatusLabel(status: string): string {
  const t = status.replace(/_/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "Unknown";
}

export type PanelData = {
  products: AppProducts | NotYet;
  agreements: AppAgreements | NotYet;
  customers: AppCustomers | NotYet;
  pnl: AppPnl | NotYet;  security: AppSecurity | NotYet;
  sdk: AppSdk | NotYet;
  activity: AppActivity | NotYet;
};
export type TabData = AppProducts | AppAgreements | AppCustomers | AppPnl | AppSecurity | AppSdk | AppActivity | NotYet;

export const checkLabel = (c: PromotionCheck) => `${c.label}: ${CHECK_LABELS[c.status]}`;

// "Updated 5s ago", for a live tab.
export function updatedAgo(at: number | null, now: number): string {
  if (at === null) return "Not loaded yet";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `Updated ${s}s ago` : `Updated ${Math.round(s / 60)}m ago`;
}
export const LIVE_INTERVAL_MS = 30_000;
