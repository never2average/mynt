// An app's right-hand panel in the builder (beside its chat): besides Preview, the information
// tabs P&L, Licences, Security, SDK and Activity, each read live from Mynt and only for this app.
// Tabs show information; anything that changes state (promoting, moving back, setting target
// states) is a labelled action elsewhere (the top bar's Promote button and its sheet). Pure: the
// route reads Mynt's replies into these shapes, and the tabs and the tests share them.
import { CHECK_LABELS, type PromotionCheck } from "./promotions";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const APP_TABS = ["preview", "pnl", "licences", "security", "sdk", "activity"] as const;
export type AppTab = (typeof APP_TABS)[number];
export const APP_TAB_LABELS: Record<AppTab, string> = { preview: "Preview", pnl: "P&L", licences: "Licences", security: "Security", sdk: "SDK", activity: "Activity" };
export type InfoTab = Exclude<AppTab, "preview">;
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

// ---- Licences (get_compliance_coverage, for this app's products only) ----

export type StateLicence = { type: string | null; regulator: string | null; number: string | null; status: string | null; expiresAt: string | null };
export type AppStateCoverage = { code: string; name: string; covered: string[]; missing: string[]; licences: StateLicence[] };
export type AppLicences = {
  available: true;
  products: { id: string; name: string }[];
  states: AppStateCoverage[]; // every state where at least one of the app's products is covered
  fullyCovered: number; // states where every product is
  productionCheck: PromotionCheck | null; // the licences check for production, when the app is in staging
};

// The coverage Mynt answers for the workspace, narrowed to this app's products. A state counts as
// covered for a product only where Mynt lists that product there (by id).
export function appLicences(coverage: unknown, products: { id: string; name: string }[], productionCheck: PromotionCheck | null): AppLicences {
  const ids = new Set(products.map((p) => p.id));
  const name = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const states = (isObj(coverage) ? arr(coverage.states) : []).filter(isObj).flatMap((s): AppStateCoverage[] => {
    const code = str(s.code)?.toLowerCase();
    if (!code) return [];
    const here = arr(s.products)
      .filter(isObj)
      .map((p) => str(p.id))
      .filter((id): id is string => Boolean(id && ids.has(id)));
    if (!here.length) return [];
    return [
      {
        code,
        name: str(s.name) ?? code,
        covered: here.map(name),
        missing: products.filter((p) => !here.includes(p.id)).map((p) => p.name),
        licences: arr(s.licences)
          .filter(isObj)
          .map((l) => ({ type: str(l.type), regulator: str(l.regulator), number: str(l.number), status: str(l.status), expiresAt: str(l.expires_at) })),
      },
    ];
  });
  states.sort((a, b) => a.name.localeCompare(b.name));
  return { available: true, products, states, fullyCovered: states.filter((s) => !s.missing.length).length, productionCheck };
}

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

export type PanelData = { pnl: AppPnl | NotYet; licences: AppLicences | NotYet; security: AppSecurity | NotYet; sdk: AppSdk | NotYet; activity: AppActivity | NotYet };

export const checkLabel = (c: PromotionCheck) => `${c.label}: ${CHECK_LABELS[c.status]}`;

// "Updated 5s ago", for a live tab.
export function updatedAgo(at: number | null, now: number): string {
  if (at === null) return "Not loaded yet";
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 60 ? `Updated ${s}s ago` : `Updated ${Math.round(s / 60)}m ago`;
}
export const LIVE_INTERVAL_MS = 30_000;
