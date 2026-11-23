// A financial product's own workspace (/products/<id>): its chat on the left and, on the right, the
// product's information tabs, each read live from Mynt for this product only: Terms, Customers, Risk,
// Compliance, Integrations, Apps and Activity. Tabs only show; moving the product between stages and
// archiving it are labelled actions in the header, each through its sheet. Each tab is a list of
// sections, and each section a table (or, where Mynt can't answer, why not: never an empty table or a 0).
// Pure: the route reads Mynt's replies into these shapes, and the tabs and the tests share them.
import { CHECK_LABELS, type PromotionCheck } from "./promotions";
import { productStageOf } from "./products";
import type { Stage } from "./workspaces";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const PRODUCT_TABS = ["terms", "customers", "risk", "compliance", "integrations", "apps", "activity"] as const;
export type ProductTab = (typeof PRODUCT_TABS)[number];
export const PRODUCT_TAB_LABELS: Record<ProductTab, string> = {
  terms: "Terms",
  customers: "Customers",
  risk: "Risk",
  compliance: "Compliance",
  integrations: "Integrations",
  apps: "Apps",
  activity: "Activity",
};
export const isProductTab = (v: unknown): v is ProductTab => typeof v === "string" && (PRODUCT_TABS as readonly string[]).includes(v);
// The product chat's slash commands ask the workspace to show a tab: detail { productId, tab }.
export const PRODUCT_TAB_EVENT = "mynt:product-tab";

// ---- the product, for the header ----

export type WorkspaceProduct = { id: string; name: string; stage: Stage; archived: boolean; productLine: string | null; category: string | null; region: string | null };

// The user's own product from list_my_products({ include_archived: true }), or null when it isn't theirs.
export function workspaceProductFrom(mine: unknown, id: string): WorkspaceProduct | null {
  const p = arr(mine)
    .filter(isObj)
    .find((x) => x.id === id);
  if (!p) return null;
  return {
    id,
    name: str(p.name) ?? id,
    stage: productStageOf(p),
    archived: p.archived === true,
    productLine: str(p.product_line),
    category: str(p.category),
    region: str(p.region),
  };
}

// ---- what a tab holds ----

export type NotYet = { available: false; reason: string };
export const NOT_YET = (reason: string): NotYet => ({ available: false, reason });

// One row of a table: its cells as text, and (Apps) a link for its first cell.
export type TableRowData = { key: string; cells: string[]; href?: string };
// A section: a table, or why Mynt can't fill it ("Not available: …"). `empty` is what an answered,
// empty list says (Mynt answered: there are none), never shown for a section Mynt couldn't answer.
export type TabSection = { id: string; title: string; columns: string[]; rows: TableRowData[] | null; reason?: string; empty?: string; note?: string };
export type ProductTabData = { available: true; sections: TabSection[] };

export const section = (id: string, title: string, columns: string[], rows: TableRowData[], empty: string, note?: string): TabSection => ({ id, title, columns, rows, empty, ...(note ? { note } : {}) });
export const unavailable = (id: string, title: string, columns: string[], reason: string): TabSection => ({ id, title, columns, rows: null, reason });

// ---- reading values ----

const words = (v: string) => v.replace(/_/g, " ");
// One value of a definition as text: money with its currency, a term reference by its term, a list
// joined, an object as its fields; nothing set is "—" (never 0).
export function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.length ? v.map(show).join(", ") : "—";
  if (isObj(v)) {
    if (typeof v.$term === "string") return `term ${v.$term}`;
    if ("amount" in v && typeof v.currency === "string") return `${show(v.amount)} ${v.currency}`;
    const parts = Object.entries(v)
      .filter(([, x]) => x !== null && x !== undefined)
      .map(([k, x]) => `${words(k)}: ${show(x)}`);
    return parts.length ? parts.join("; ") : "—";
  }
  return "—";
}
const pick = (o: Obj, ...keys: string[]) => {
  const parts = keys.map((k) => (o[k] === undefined || o[k] === null ? null : `${words(k)} ${show(o[k])}`)).filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
};
const items = (def: Obj, key: string) => arr(def[key]).filter(isObj);
const rowsOf = (list: Obj[], cells: (o: Obj) => string[]): TableRowData[] => list.map((o, i) => ({ key: str(o._id) ?? String(i), cells: cells(o) }));
const label = (v: unknown) => (typeof v === "string" ? words(v) : show(v));

// get_product_definition's reply: the definition, or null with why.
export function definitionFrom(reply: unknown): { definition: Obj | null; valid: boolean | null } {
  if (!isObj(reply) || !isObj(reply.definition)) return { definition: null, valid: null };
  return { definition: reply.definition, valid: typeof reply.valid === "boolean" ? reply.valid : null };
}
export const NO_DEFINITION = "This product has no v2 definition yet. Describe its terms in the chat, or set one with set_product_definition.";

// ---- Terms ----

export function termsSections(def: Obj): TabSection[] {
  return [
    section(
      "terms",
      "Terms",
      ["Term", "Type", "Default", "Range or choices", "Negotiable", "After issue"],
      rowsOf(items(def, "terms"), (t) => [
        str(t.label) ?? str(t._id) ?? "—",
        [label(t.type), str(t.unit), str(t.currency)].filter((x) => x && x !== "—").join(" · ") || "—",
        show(t.default),
        t.range ? show(t.range) : t.allowed ? show(t.allowed) : t.derived ? `derived: ${show(t.derived)}` : "—",
        label(t.negotiable),
        isObj(t.post_issue) ? label(t.post_issue.rule) : "—",
      ]),
      "The definition declares no terms.",
    ),
    section(
      "rates",
      "Rates",
      ["Rate", "Kind", "Type", "Value", "Details"],
      rowsOf(items(def, "rates"), (r) => [str(r._id) ?? "—", label(r.kind), label(r.rate_type), show(r.value), pick(r, "index", "spread", "floor", "cap", "day_count", "application")]),
      "The definition declares no rates.",
    ),
    section(
      "fees",
      "Fees",
      ["Fee", "Type", "Method", "Amount or rate", "Payer", "Bounds"],
      rowsOf(items(def, "fees"), (f) => [str(f._id) ?? "—", label(f.type), label(f.method), f.amount !== undefined ? show(f.amount) : f.rate !== undefined ? `${show(f.rate)}${f.rate_base ? ` of ${label(f.rate_base)}` : ""}` : "—", label(f.payer), pick(f, "min", "max", "cap")]),
      "The definition declares no fees.",
    ),
    section(
      "limits",
      "Limits",
      ["Limit", "Kind", "What it limits", "Bounds", "Outcome"],
      rowsOf(items(def, "limits"), (l) => [str(l._id) ?? "—", label(l.kind), [label(l.constraint_type ?? l.rule_type), l.event_stream ? label(l.event_stream) : null].filter((x) => x && x !== "—").join(" · ") || "—", pick(l, "min", "max", "limit_amount", "limit_count", "window"), label(l.outcome)]),
      "The definition declares no limits.",
    ),
    section(
      "lifecycle",
      "Lifecycle events",
      ["Event", "Order", "Trigger", "What it does"],
      rowsOf(
        [...items(def, "lifecycle_events")].sort((a, b) => (typeof a.sequence === "number" ? a.sequence : 0) - (typeof b.sequence === "number" ? b.sequence : 0)),
        (e) => [str(e._id) ?? "—", show(e.sequence), label(e.trigger), show(arr(e.primitives).map(label))],
      ),
      "The definition declares no lifecycle events.",
    ),
    section(
      "servicing",
      "Servicing policies",
      ["Policy", "Kind", "Settings"],
      rowsOf(items(def, "servicing_policies"), (p) => [str(p._id) ?? "—", label(p.kind), show(p.config)]),
      "The definition declares no servicing policies.",
    ),
    section(
      "costs",
      "Costs",
      ["Cost", "Kind", "Estimate", "Basis"],
      rowsOf(items(def, "costs"), (c) => [str(c._id) ?? "—", label(c.kind), show(c.estimate), show(c.basis)]),
      "The definition declares no costs.",
    ),
  ];
}

// ---- Customers ----

export function customerSections(def: Obj): TabSection[] {
  const segments = items(def, "customer_segments");
  return [
    section(
      "segments",
      "Customer segments",
      ["Segment", "Customer", "Qualification", "Channels"],
      rowsOf(segments, (s) => [str(s.name) ?? str(s._id) ?? "—", label(s.customer_kind), show(s.qualification), show(arr(s.channels).map(label))]),
      "The definition declares no customer segments.",
    ),
    section(
      "target-market",
      "Target market and eligibility",
      ["Segment", "Target market", "Identity checks", "Fraud risk"],
      rowsOf(segments, (s) => [
        str(s.name) ?? str(s._id) ?? "—",
        show(s.target_market),
        isObj(s.identity) ? show(arr(s.identity.verification_tiers).map((t) => (isObj(t) ? (str(t.name) ?? str(t._id) ?? show(t)) : show(t)))) : "—",
        isObj(s.fraud) ? pick(s.fraud, "product_risk", "channel_risk") : "—",
      ]),
      "The definition declares no customer segments, so no target market.",
    ),
  ];
}

// ---- Risk ----

export function riskModelSections(def: Obj): TabSection[] {
  return [
    section(
      "risk-models",
      "Risk models",
      ["Model", "Purpose", "Repository", "Version", "Description"],
      rowsOf(items(def, "risk_models"), (m) => [str(m.model_name) ?? str(m._id) ?? "—", label(m.purpose), show(m.repository), show(m.version), show(m.description)]),
      "The definition declares no risk models.",
    ),
    section(
      "algorithms",
      "Decisioning and underwriting",
      ["Algorithm", "Purpose", "Repository", "Version", "Description"],
      rowsOf(items(def, "core_algorithms"), (a) => [str(a.algorithm_name) ?? str(a._id) ?? "—", label(a.purpose), show(a.repository), show(a.version), show(a.description)]),
      "The definition declares no core algorithms.",
    ),
  ];
}

// list_my_sponsorships' covenant pauses: what the product's firm may see of its licence providers' covenants.
export function covenantPauseRows(sponsorships: unknown): TableRowData[] {
  return arr(sponsorships)
    .filter(isObj)
    .flatMap((s) =>
      arr(s.covenant_pauses)
        .filter(isObj)
        .map((p, i) => ({ key: `${str(s.id) ?? "s"}:${i}`, cells: [isObj(s.provider) ? (str(s.provider.name) ?? "Licence provider") : "Licence provider", label(p.rule_type), when(str(p.paused_at))] })),
    );
}

// list_covenants (a licence provider's own rules), for this product.
export function covenantRows(reply: unknown): TableRowData[] {
  return arr(isObj(reply) && Array.isArray(reply.covenants) ? reply.covenants : reply)
    .filter(isObj)
    .map((c, i) => ({ key: str(c.id) ?? String(i), cells: [label(c.rule_type), label(c.status ?? c.state), label(c.action), when(str(c.since) ?? str(c.status_since) ?? str(c.updated_at))] }));
}

// list_covenant_breaches(open_only), for this product.
export function breachRows(reply: unknown): TableRowData[] {
  return arr(isObj(reply) && Array.isArray(reply.breaches) ? reply.breaches : reply)
    .filter(isObj)
    .map((b, i) => ({ key: str(b.id) ?? String(i), cells: [label(b.rule_type), label(b.action ?? b.action_taken), b.sandbox === true ? "Sandbox" : b.sandbox === false ? "Live" : "—", when(str(b.created_at) ?? str(b.breached_at))] }));
}

// list_product_health: the status of each snapshot (never its numbers).
export function healthRows(reply: unknown, productId: string): TableRowData[] {
  return arr(reply)
    .filter(isObj)
    .filter((s) => str(s.product_id) === null || s.product_id === productId)
    .flatMap((s) =>
      arr(s.snapshots)
        .filter(isObj)
        .map((n, i) => ({
          key: `${str(s.pool_id) ?? "product"}:${show(n.sequence)}:${i}`,
          cells: [show(n.sequence), `${when(str(n.period_start))} to ${when(str(n.period_end))}`, label(n.status), label(n.source), n.verified === true ? "Verified" : "Not verified", str(n.fingerprint)?.slice(0, 12) ?? "—"],
        })),
    );
}
export const HEALTH_NUMBERS_ONLY = "Only the product's licence provider and its liquidity providers can read the health figures; you see each snapshot's status and fingerprint.";

// ---- Compliance ----

export function sponsorshipRows(reply: unknown, productId: string): TableRowData[] {
  return arr(reply)
    .filter(isObj)
    .filter((s) => str(s.product_id) === null || s.product_id === productId)
    .map((s, i) => {
      const licences = arr(s.licences)
        .filter(isObj)
        .map((l) => [str(l.regulator_id), str(l.license_id), str(l.jurisdiction)].filter(Boolean).join(" · ") + (l.in_force === false ? " (not in force)" : ""))
        .filter(Boolean);
      const where = arr(s.jurisdictions).length ? arr(s.jurisdictions) : arr(s.requested_jurisdictions);
      return {
        key: str(s.id) ?? String(i),
        cells: [isObj(s.provider) ? (str(s.provider.name) ?? "—") : "—", isObj(s.component) ? (str(s.component.key) ?? "—") : (str(s.component_key) ?? "—"), label(s.status), licences.join(", ") || "—", where.length ? where.map((j) => String(j).toUpperCase()).join(", ") : "—"],
      };
    });
}

// get_workspace_obligations, kept to the obligations whose products include this one (each once).
export function obligationRows(replies: unknown[], productId: string): TableRowData[] {
  const seen = new Set<string>();
  const out: TableRowData[] = [];
  for (const reply of replies)
    for (const o of arr(reply).filter(isObj)) {
      if (!arr(o.products).some((p) => isObj(p) && p.id === productId)) continue;
      const key = `${str(o.licence_id) ?? ""}:${str(o.obligation_id) ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, cells: [str(o.title) ?? str(o.obligation_id) ?? "—", isObj(o.partner) ? (str(o.partner.name) ?? "—") : "—", [str(o.regulator), str(o.licence_type)].filter(Boolean).join(" · ") || "—", label(o.status), str(o.evidence) ?? str(o.reason) ?? "—"] });
    }
  return out;
}

export function documentRows(def: Obj | null): TableRowData[] {
  const docs = def && isObj(def.descriptions) && isObj(def.descriptions.documents) ? def.descriptions.documents : {};
  return Object.entries(docs)
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => ({ key: k, cells: [words(k), v as string] }));
}

export const checkRows = (checks: PromotionCheck[]): TableRowData[] =>
  checks.map((c) => ({ key: c.id, cells: [c.label, CHECK_LABELS[c.status], c.detail ?? "—", c.fix?.label ?? "—"] }));

// ---- Integrations ----

type Subscription = { id: string; vendor: string; service: string; offering: string; live: boolean | null; status: string };
export function subscriptionsFrom(reply: unknown): Subscription[] {
  return arr(reply)
    .filter(isObj)
    .map((s) => ({ id: str(s.subscription_id) ?? str(s.id) ?? "", vendor: str(s.vendor) ?? "—", service: str(s.service_type) ?? "—", offering: str(s.offering) ?? "—", live: typeof s.live === "boolean" ? s.live : null, status: str(s.status) ?? "—" }))
    .filter((s) => s.id);
}

// The definition's hand-offs, each with the vendor subscription its handoff_to_party connection runs through.
export function handoffRows(def: Obj, subs: Subscription[] | null): TableRowData[] {
  const connections = items(def, "connections").filter((c) => c.type === "handoff_to_party");
  return items(def, "partner_handoffs").map((h, i) => {
    const id = str(h._id) ?? String(i);
    const conn = connections.find((c) => isObj(c.from) && c.from.id === id);
    const attrs = conn && isObj(conn.attributes) ? conn.attributes : {};
    const subId = str(attrs.vendor_subscription_id);
    const sub = subId ? subs?.find((s) => s.id === subId) : undefined;
    return {
      key: id,
      cells: [str(h.name) ?? id, show(h.trigger), label(attrs.channel), subId ? (sub ? `${sub.vendor} · ${label(sub.service)}` : subs === null ? "Bound (vendor not readable)" : "Bound to an ended subscription") : "No vendor service bound", label(h.on_failure)],
    };
  });
}
export function subscriptionRows(subs: Subscription[], def: Obj | null): TableRowData[] {
  const bound = new Set(
    (def ? items(def, "connections") : [])
      .filter((c) => c.type === "handoff_to_party" && isObj(c.attributes))
      .map((c) => str((c.attributes as Obj).vendor_subscription_id))
      .filter(Boolean),
  );
  return subs.map((s) => ({ key: s.id, cells: [s.vendor, label(s.service), s.offering, s.live === null ? "—" : s.live ? "Live" : "Sandbox only", bound.has(s.id) ? "Used by this product" : "Not used by this product"] }));
}
export function connectionRows(def: Obj): TableRowData[] {
  return items(def, "connections")
    .filter((c) => c.type !== "handoff_to_party")
    .map((c, i) => ({ key: str(c._id) ?? String(i), cells: [label(c.type), isObj(c.from) ? `${label(c.from.kind)} ${show(c.from.id)}` : show(c.from), isObj(c.to) ? `${label(c.to.kind)} ${show(c.to.id)}` : show(c.to)] }));
}
// Where the product's health figures come from: the licence provider's ledger, the sandbox, or not readable.
export function ledgerRows(reply: unknown, productId: string): TableRowData[] {
  return arr(reply)
    .filter(isObj)
    .filter((s) => str(s.product_id) === null || s.product_id === productId)
    .map((s, i) => {
      const latest = arr(s.snapshots).filter(isObj)[0];
      const chain = isObj(s.chain) ? label(s.chain.status) : "—";
      return { key: `${str(s.pool_id) ?? "product"}:${i}`, cells: [str(s.pool_id) ? "Pool" : "Product", latest ? label(latest.source) : "No snapshot yet", latest ? when(str(latest.period_end)) : "—", chain, String(arr(s.gaps).length)] };
    });
}

// ---- Apps ----

export function appRows(apps: unknown, productId: string, stageLabel: (s: Stage) => string, href: (id: string) => string): TableRowData[] {
  return arr(apps)
    .filter(isObj)
    .filter((a) => arr(a.product_ids).includes(productId) && typeof a.id === "string")
    .map((a) => {
      const stage = productStageOf({ stage: a.stage, status: a.status === "published" ? "published" : "draft" });
      return { key: a.id as string, href: href(a.id as string), cells: [str(a.name) ?? "Untitled app", stageLabel(stage), when(str(a.updated_at) ?? str(a.created_at))] };
    });
}

// ---- Activity ----

export function versionRows(reply: unknown): TableRowData[] {
  const live = isObj(reply) && typeof reply.live_version === "number" ? reply.live_version : null;
  return arr(isObj(reply) ? reply.versions : [])
    .filter(isObj)
    .sort((a, b) => (typeof b.version === "number" ? b.version : 0) - (typeof a.version === "number" ? a.version : 0))
    .map((v, i) => ({
      key: `v${show(v.version)}:${i}`,
      cells: [`v${show(v.version)}${v.version === live ? " (live)" : ""}`, label(v.status), show(v.changelog), v.test_passed === true ? "Passed" : v.test_passed === false ? "Failed" : "Not tested", when(str(v.published_at))],
    }));
}
const ACTION_LABELS: Record<string, string> = {
  product_promoted: "Moved up a stage",
  product_demoted: "Moved back a stage",
  product_archived: "Archived",
  product_unarchived: "Unarchived",
  product_drifted: "Drifted from its published composition",
  product_drift_cleared: "Drift cleared",
  set_product_definition: "Definition changed",
  set_product_composition: "Composition changed",
  set_product_access: "Access changed",
  admin_set_product_composition: "Composition changed by an admin",
  admin_set_product_status: "Status changed by an admin",
  covenant_paused_product: "Sales paused by a covenant",
  covenant_cleared: "Covenant pause cleared",
};
const ACTORS: Record<string, string> = { you: "You", mynt: "Mynt", admin: "A Mynt admin", another_user: "Another user" };
export function activityRows(reply: unknown): TableRowData[] {
  return arr(isObj(reply) ? reply.events : [])
    .filter(isObj)
    .map((e, i) => {
      const action = str(e.action) ?? "";
      const d = isObj(e.details) ? e.details : {};
      const detail = [d.from_stage && d.to_stage ? `${label(d.from_stage)} to ${label(d.to_stage)}` : null, d.reason ? `“${show(d.reason)}”` : null, d.rule_type ? label(d.rule_type) : null, d.status ? label(d.status) : null].filter(Boolean).join(" · ");
      return { key: `${str(e.at) ?? ""}:${i}`, cells: [when(str(e.at)), ACTION_LABELS[action] ?? label(action), detail || "—", ACTORS[str(e.actor) ?? ""] ?? "—"] };
    });
}

// ---- time ----

export function when(iso: string | null): string {
  return iso ? iso.replace("T", " ").slice(0, 16) : "—";
}
