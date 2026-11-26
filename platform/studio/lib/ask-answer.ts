// Ask AI's answer, as the browser and the server share it: one question, one short answer from Mynt's own data with
// numbered citations and the sources under it. The sources are the reads the answer was made from, each shown as the
// page that holds that data (a studio page, or a platform admin section). Pure functions only: the dialog
// (components/ask-ai.tsx) and the routes (app/api/ask, app/api/admin/ask through lib/ask-server.ts) both import this.

export type AskArea = "studio" | "admin";
export interface AskSource { n: number; title: string; heading: string | null; href: string }
/** Why there is no answer: the hourly limit, the sign-in ended, or no model answered. */
export type AskReason = "rate_limited" | "signed_out" | "unavailable" | null;
export interface AskAnswer { answer: string | null; covered: boolean | null; sources: AskSource[]; model: string | null; reason: AskReason }

/** What the stream sends, in order: the sources as they're read, the answer's text as it is written (reset: drop what
 *  came so far), then the final answer, cleaned, or none with the reason. */
export type AskStreamEvent =
  | { type: "sources"; sources: AskSource[] }
  | { type: "delta"; text: string }
  | { type: "reset" }
  | { type: "done"; answer: string | null; covered: boolean | null; model: string | null; reason: AskReason };

export const ASK_URL: Record<AskArea, string> = { studio: "/api/ask", admin: "/api/admin/ask" };

export const MIN_QUESTION = 3;
export const MAX_ASK_QUESTION = 400;

/** A question worth asking: two words or more (or one ending in "?"), at least 6 characters. */
export const askable = (q: string) => q.trim().length >= 6 && (q.trim().split(/\s+/).length >= 2 || q.trim().endsWith("?"));

/** The question as it's asked: whitespace folded; null when it's too short or too long to ask. */
export function questionFrom(value: unknown): string | null {
  const q = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return q.length >= MIN_QUESTION && q.length <= MAX_ASK_QUESTION ? q : null;
}

/** An answer made safe to show: links and images become their text, HTML tags and headings go, citations of numbers
 *  outside 1..n are dropped, at most 1500 characters. */
export function cleanAnswer(text: string, n: number): string {
  let a = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[(\d{1,2})\]/g, (m, d) => (Number(d) >= 1 && Number(d) <= n ? m : ""))
    .trim();
  if (a.length > 1500) a = `${a.slice(0, a.lastIndexOf(" ", 1497))}…`;
  return a;
}

/** How an answer that the data doesn't cover starts (the instructions ask for it). */
export const NOT_COVERED = /^mynt.s data doesn.t cover this/i;

/** The answer's [n] citations as links to the cited sources. */
export const linked = (md: string, sources: AskSource[]) =>
  md.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => {
    const s = sources.find((x) => x.n === Number(n));
    return s ? `[\\[${n}\\]](${s.href})` : m;
  });

export const UNAVAILABLE: Record<Exclude<AskReason, null>, string> = {
  unavailable: "AI summary unavailable. Search still finds your pages.",
  rate_limited: "AI summary unavailable: that was a lot of questions in an hour, try again shortly. Search still finds your pages.",
  signed_out: "Your session ended. Sign in again to ask.",
};

// ---------- sources ----------

type SourceOf = (args: Record<string, unknown>) => { title: string; heading?: string; href: string };
const page = (title: string, href: string, heading?: string): SourceOf => () => ({ title, href, ...(heading ? { heading } : {}) });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidOf = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v : null);

/** The studio page that shows what each of Ask AI's reads returns (lib/ask.ts ASK_TOOLS). */
export const STUDIO_ASK_SOURCES: Record<string, SourceOf> = {
  whoami: page("Settings", "/settings", "Your account"),
  list_my_apps: page("Dashboard", "/", "Apps"),
  list_buildable_products: page("Build", "/new", "Products to build on"),
  get_product: page("Build", "/new", "Product"),
  get_developer_dashboard: page("Dashboard", "/"),
  get_linked_accounts: page("Settings", "/settings", "Linked accounts"),
  list_workspaces: page("Settings", "/settings", "Workspaces"),
  list_workspace_members: page("Settings", "/settings?tab=members", "Members"),
  list_my_invitations: page("Settings", "/settings", "Invitations"),
  get_compliance_coverage: page("Licences", "/licences", "Coverage"),
  list_workspace_licences: page("Licences", "/licences"),
  list_workspace_audit: page("Audits", "/audits"),
  list_builds: page("Builds", "/builds"),
  get_build: page("Builds", "/builds", "Build"),
};

/** The platform admin section that shows what each of its Ask AI's reads returns (lib/admin-ask.ts ADMIN_ASK_TOOLS). */
export const ADMIN_ASK_SOURCES: Record<string, SourceOf> = {
  ops_status: page("Overview", "/platform", "What needs attention"),
  list_all_workspaces: page("Workspaces", "/platform/workspaces"),
  admin_get_workspace: (a) => {
    const id = uuidOf(a.workspace_id);
    return { title: "Workspaces", heading: "Workspace", href: id ? `/platform/workspaces/${id}` : "/platform/workspaces" };
  },
  list_entities: page("Regulated firms", "/platform/firms"),
  list_whitelist: page("Overview", "/platform", "People and invitations"),
  list_license_reviews: page("Regulated firms", "/platform/firms?tab=licences", "Licences"),
  list_service_types: page("Vendors", "/platform/vendors", "Service types"),
  list_vendor_offerings: page("Vendors", "/platform/vendors", "Offerings"),
  get_vendor_onboarding: page("Vendors", "/platform/vendors", "Onboarding"),
  get_regulated_firm_onboarding: (a) => {
    const id = uuidOf(a.entity_id);
    return { title: "Regulated firms", heading: "Onboarding", href: id ? `/platform/firms/${id}` : "/platform/firms" };
  },
  audit_log: page("Audit trails", "/platform/audit"),
  admin_list_risks: page("Risk register", "/platform/risk-register", "Every register"),
  list_risks: page("Risk register", "/platform/risk-register", "Mynt's own risks"),
  list_risk_models: page("Risk models", "/platform/risk-models"),
  admin_list_product_risk_models: page("Risk models", "/platform/risk-models", "Products' models"),
  get_platform_settings: page("Platform settings", "/platform/settings"),
  get_esign_settings: page("Platform settings", "/platform/settings", "E-signature"),
  list_enclave_releases: page("Platform settings", "/platform/settings", "Confidential service releases"),
};

/** The source a read is shown as; a read with no page of its own is the area's first page. */
export function sourceOf(area: AskArea, tool: string, args: Record<string, unknown>): Omit<AskSource, "n"> {
  const map = area === "admin" ? ADMIN_ASK_SOURCES : STUDIO_ASK_SOURCES;
  const s = Object.prototype.hasOwnProperty.call(map, tool) ? map[tool](args) : area === "admin" ? { title: "Overview", href: "/platform" } : { title: "Dashboard", href: "/" };
  return { title: s.title, heading: s.heading ?? null, href: s.href };
}
