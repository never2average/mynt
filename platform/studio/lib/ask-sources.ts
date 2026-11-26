// Ask AI's reads, in words, and where each fact they return lives. One table for every tool on both allow-lists
// (lib/ask.ts ASK_TOOLS for Studio, lib/admin-ask.ts ADMIN_ASK_TOOLS for the platform admin): what the read is called
// in the steps ("Read apps and their stages"), what it counts ("4 apps"), and the sources it gives an answer: the page
// that holds the read, and each record it returned as its own page or filtered view where Studio has one (an app, a
// workspace, a firm, a risk, an audit action). test/ask-sources.test.ts runs every tool on both lists through it.
import type { AskArea } from "./ask-answer";

export type SourceRef = { title: string; href: string };
type Args = Record<string, unknown>;
type Row = Record<string, unknown>;

type Spec = {
  /** The read, in words, as a step: "Read apps and their stages". */
  label: string;
  /** What its rows are, one and many, for the step's one-line result ("1 app", "4 apps"). */
  noun?: [string, string];
  /** The page that holds the read. */
  page: (args: Args, result: unknown) => SourceRef;
  /** The records it returned. */
  rows?: (result: unknown) => unknown[];
  /** One record's own page or view; null when it has no name to show. */
  row?: (row: Row, args: Args) => SourceRef | null;
};

/** Records listed as sources per read; the rest are covered by the read's page. */
export const MAX_ROW_SOURCES = 12;

const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, 80) : typeof v === "number" ? String(v) : null);
/** The first of a record's fields that holds a name. */
const first = (row: Row, ...keys: string[]): string | null => {
  for (const k of keys) {
    const t = text(row[k]);
    if (t) return t;
  }
  return null;
};
/** An id that can sit in an address as it is; anything else is left out of the link. */
const seg = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(v) ? v : null);
/** The list in a reply: the reply itself, or the first of these keys that holds one. */
const list = (...keys: string[]) => (result: unknown): unknown[] => {
  if (Array.isArray(result)) return result;
  const o = obj(result);
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  return [];
};
const page = (title: string, href: string) => (): SourceRef => ({ title, href });
const named = (prefix: string, href: (row: Row, args: Args) => string, ...keys: string[]) => (row: Row, args: Args): SourceRef | null => {
  const name = first(row, ...keys);
  return name ? { title: `${prefix} › ${name}`, href: href(row, args) } : null;
};
const at = (base: string, ...idKeys: string[]) => (row: Row): string => {
  for (const k of idKeys) {
    const id = seg(row[k]);
    if (id) return `${base}/${id}`;
  }
  return base || "/";
};
const fixed = (href: string) => () => href;

const STUDIO: Record<string, Spec> = {
  whoami: { label: "Read your account", page: page("Settings › Your account", "/settings") },
  list_my_apps: {
    label: "Read apps and their stages",
    noun: ["app", "apps"],
    page: page("Dashboard › Apps", "/"),
    rows: list("apps"),
    row: named("Apps", at("", "id"), "name", "id"),
  },
  list_buildable_products: {
    label: "Read the products you can build on",
    noun: ["product", "products"],
    page: page("Build › Products to build on", "/new"),
    rows: list("products"),
    row: named("Build › Products", fixed("/new"), "name", "id"),
  },
  get_product: {
    label: "Read a product",
    page: (_a, r) => ({ title: `Build › Products › ${first(obj(r), "name", "id") ?? "Product"}`, href: "/new" }),
  },
  get_developer_dashboard: { label: "Read the dashboard's figures", page: page("Dashboard", "/") },
  get_linked_accounts: { label: "Read linked accounts", page: page("Settings › Linked accounts", "/settings") },
  list_workspaces: {
    label: "Read workspaces",
    noun: ["workspace", "workspaces"],
    page: page("Settings › Workspaces", "/settings"),
    rows: list("workspaces"),
    row: named("Settings › Workspaces", fixed("/settings"), "name", "id"),
  },
  list_workspace_members: {
    label: "Read a workspace's members",
    noun: ["member", "members"],
    page: page("Settings › Members", "/settings?tab=members"),
    rows: list("members"),
    row: named("Settings › Members", fixed("/settings?tab=members"), "name", "email"),
  },
  list_my_invitations: {
    label: "Read your invitations",
    noun: ["invitation", "invitations"],
    page: page("Settings › Invitations", "/settings"),
    rows: list("invitations"),
    row: named("Settings › Invitations", fixed("/settings"), "workspace_name", "workspace", "name", "email"),
  },
  get_compliance_coverage: { label: "Read where your products can serve customers", page: page("Licences › Coverage", "/licences") },
  list_workspace_licences: {
    label: "Read the partner licences behind your products",
    noun: ["licence", "licences"],
    page: page("Licences", "/licences"),
    rows: list("licences"),
    row: named("Licences", fixed("/licences"), "name", "license_type", "licence_type", "type", "holder", "entity", "regulator"),
  },
  list_workspace_audit: {
    label: "Read the workspace's audit trail",
    noun: ["entry", "entries"],
    page: page("Audits", "/audits"),
    rows: list("events", "entries"),
    row: (row) => {
      const action = first(row, "action");
      return action ? { title: `Audits › ${action}`, href: `/audits?action=${encodeURIComponent(action)}` } : null;
    },
  },
  list_builds: {
    label: "Read builds",
    noun: ["build", "builds"],
    page: page("Builds", "/builds"),
    rows: list("builds"),
    row: named("Builds", fixed("/builds"), "goal", "id"),
  },
  get_build: {
    label: "Read a build",
    page: (_a, r) => ({ title: `Builds › ${first(obj(r), "goal", "id") ?? "Build"}`, href: "/builds" }),
  },
};

const P = "/platform";
const firmPage = (row: Row) => at(`${P}/firms`, "entity_id", "id")(row);

const ADMIN: Record<string, Spec> = {
  ops_status: { label: "Read what needs attention in production", page: page("Overview › What needs attention", P) },
  list_all_workspaces: {
    label: "Read every workspace",
    noun: ["workspace", "workspaces"],
    page: page("Workspaces", `${P}/workspaces`),
    rows: list("workspaces"),
    row: named("Workspaces", at(`${P}/workspaces`, "id"), "name", "id"),
  },
  admin_get_workspace: {
    label: "Read a workspace",
    page: (a, r) => {
      const w = obj(obj(r).workspace);
      const id = seg(a.workspace_id) ?? seg(w.id);
      return { title: `Workspaces › ${first(w, "name") ?? "Workspace"}`, href: id ? `${P}/workspaces/${id}` : `${P}/workspaces` };
    },
  },
  list_entities: {
    label: "Read regulated firms",
    noun: ["firm", "firms"],
    page: page("Regulated firms", `${P}/firms`),
    rows: list("entities", "firms"),
    row: named("Regulated firms", at(`${P}/firms`, "id"), "name", "legal_name", "id"),
  },
  list_whitelist: {
    label: "Read people and invitations",
    noun: ["person", "people"],
    page: page("Overview › People and invitations", P),
    rows: list("users"),
    row: named("Overview › People", fixed(P), "name", "email"),
  },
  list_license_reviews: {
    label: "Read licence reviews",
    noun: ["licence", "licences"],
    page: page("Regulated firms › Licences", `${P}/firms?tab=licences`),
    rows: list("licences", "reviews"),
    row: (row) => {
      const firm = first(row, "entity", "entity_name", "firm");
      if (!firm) return null;
      const what = first(row, "license_type", "licence_type", "license_type_id", "type", "status");
      const id = seg(row.entity_id);
      return { title: `Regulated firms › ${firm} › Licences${what ? ` › ${what}` : ""}`, href: id ? `${P}/firms/${id}` : `${P}/firms?tab=licences` };
    },
  },
  list_service_types: {
    label: "Read vendors' service types",
    noun: ["service type", "service types"],
    page: page("Vendors › Service types", `${P}/vendors`),
    rows: list("service_types", "types"),
    row: named("Vendors › Service types", fixed(`${P}/vendors`), "name", "id"),
  },
  list_vendor_offerings: {
    label: "Read vendors' services",
    noun: ["service", "services"],
    page: page("Vendors › Services", `${P}/vendors`),
    rows: list("offerings"),
    row: named("Vendors › Services", fixed(`${P}/vendors`), "name", "id"),
  },
  get_vendor_onboarding: {
    label: "Read vendors' onboarding",
    noun: ["vendor", "vendors"],
    page: page("Vendors › Onboarding", `${P}/vendors`),
    rows: list("firms"),
    row: (row) => {
      const name = first(row, "name");
      return name ? { title: `Vendors › ${name} › Onboarding`, href: firmPage(row) } : null;
    },
  },
  get_regulated_firm_onboarding: {
    label: "Read regulated firms' onboarding",
    noun: ["firm", "firms"],
    page: (a, r) => {
      const id = seg(a.entity_id);
      const o = obj(r);
      const name = first(o, "name") ?? first(obj(o.firm), "name") ?? first(obj(o.entity), "name");
      return id ? { title: `Regulated firms › ${name ?? "Firm"} › Onboarding`, href: `${P}/firms/${id}` } : { title: "Regulated firms › Onboarding", href: `${P}/firms` };
    },
    rows: list("firms"),
    row: (row) => {
      const name = first(row, "name");
      return name ? { title: `Regulated firms › ${name} › Onboarding`, href: firmPage(row) } : null;
    },
  },
  audit_log: {
    label: "Read the audit trail",
    noun: ["entry", "entries"],
    page: page("Audit trails", `${P}/audit`),
    rows: list("entries", "events"),
    row: named("Audit trails", fixed(`${P}/audit`), "action"),
  },
  admin_list_risks: {
    label: "Read every risk register",
    noun: ["risk", "risks"],
    page: page("Risk register › Every register", `${P}/risk-register`),
    rows: list("risks"),
    row: named("Risk register", at(`${P}/risk-register`, "id"), "title", "name", "id"),
  },
  list_risks: {
    label: "Read Mynt's own risks",
    noun: ["risk", "risks"],
    page: page("Risk register › Mynt's own risks", `${P}/risk-register`),
    rows: list("risks"),
    row: named("Risk register", at(`${P}/risk-register`, "id"), "title", "name", "id"),
  },
  get_risk: {
    label: "Read a risk",
    page: (a, r) => {
      const risk = obj(obj(r).risk);
      const id = seg(a.risk_id) ?? seg(risk.id);
      return { title: `Risk register › ${first(risk, "title", "name") ?? "Risk"}`, href: id ? `${P}/risk-register/${id}` : `${P}/risk-register` };
    },
  },
  list_risk_models: {
    label: "Read Mynt's risk models",
    noun: ["model", "models"],
    page: page("Risk models", `${P}/risk-models`),
    rows: list("models"),
    row: named("Risk models", fixed(`${P}/risk-models`), "name", "id"),
  },
  admin_list_product_risk_models: {
    label: "Read products' risk models",
    noun: ["model", "models"],
    page: page("Risk models › Products' models", `${P}/risk-models`),
    rows: list("models"),
    row: named("Risk models › Products' models", fixed(`${P}/risk-models`), "name", "product_name", "id"),
  },
  get_platform_settings: {
    label: "Read the platform's settings",
    noun: ["setting", "settings"],
    page: page("Platform settings", `${P}/settings`),
    rows: list("settings"),
    row: named("Platform settings", fixed(`${P}/settings`), "key", "name"),
  },
  get_risk_grading: { label: "Read how risks are graded", page: page("Platform settings › Risk grading", `${P}/settings`) },
  get_esign_settings: { label: "Read the e-signature set-up", page: page("Platform settings › E-signature", `${P}/settings`) },
  list_enclave_releases: {
    label: "Read the confidential service's releases",
    noun: ["release", "releases"],
    page: page("Platform settings › Confidential service releases", `${P}/settings`),
    rows: list("releases"),
    row: named("Platform settings › Confidential service releases", fixed(`${P}/settings`), "release", "version", "id"),
  },
};

export const ASK_READS: Record<AskArea, Record<string, Spec>> = { studio: STUDIO, admin: ADMIN };
const specOf = (area: AskArea, tool: string): Spec | null => (Object.prototype.hasOwnProperty.call(ASK_READS[area], tool) ? ASK_READS[area][tool] : null);
const HOME: Record<AskArea, SourceRef> = { studio: { title: "Dashboard", href: "/" }, admin: { title: "Overview", href: P } };

/** A read in words ("Read apps and their stages"); a read with no words of its own is named by its tool. */
export const readLabel = (area: AskArea, tool: string): string => specOf(area, tool)?.label ?? `Read ${tool.replace(/_/g, " ")}`;

/** A read's one-line result: how many records it returned ("4 apps"), or that it was read. */
export function readSummary(area: AskArea, tool: string, result: unknown): string {
  const spec = specOf(area, tool);
  if (!spec?.rows || !spec.noun) return "Read";
  const n = spec.rows(result).length;
  return `${n} ${n === 1 ? spec.noun[0] : spec.noun[1]}`;
}

/**
 * The sources a read gives an answer: the page that holds it first, then each record it returned (the first
 * MAX_ROW_SOURCES that have a name), as that record's own page or view. Never a link out of Studio.
 */
export function sourcesOf(area: AskArea, tool: string, args: Args, result: unknown): SourceRef[] {
  const spec = specOf(area, tool);
  if (!spec) return [HOME[area]];
  const out: SourceRef[] = [spec.page(args, result)];
  if (spec.rows && spec.row) {
    for (const r of spec.rows(result)) {
      if (out.length > MAX_ROW_SOURCES) break;
      const s = r && typeof r === "object" && !Array.isArray(r) ? spec.row(r as Row, args) : null;
      if (s && !out.some((x) => x.title === s.title && x.href === s.href)) out.push(s);
    }
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A read's arguments on one line: ids shortened, long text cut. The caller scrubs it (lib/scrub.ts). */
export function argsSummary(args: Args): string {
  const show = (v: unknown): string => {
    if (typeof v === "string") return UUID.test(v) ? `${v.slice(0, 8)}…` : v.length > 40 ? `${v.slice(0, 40)}…` : v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return Array.isArray(v) ? `${v.length} items` : "…";
  };
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${show(v)}`)
    .join(", ");
}
