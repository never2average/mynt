// The studio's pages and its search (the header's search field and its Cmd+K modal), as pure
// functions: the page title for a path, and what a query finds among the pages, the workspace's
// apps, members and audit actions.
import { STAGE_LABELS, type Stage } from "./workspaces";

export type StudioPage = { href: string; label: string; keywords?: string };

// Every fixed page, in the order search lists them.
export const STUDIO_PAGES: readonly StudioPage[] = [
  { href: "/", label: "Dashboard", keywords: "home money customers spend" },
  { href: "/licences", label: "Licences", keywords: "licenses agreements business program data sharing msa sla audit obligations sponsors partners sign" },
  { href: "/licences?tab=business-agreements", label: "Business agreements", keywords: "program agreement data sharing sponsor propose accept decline sign contract" },
  { href: "/licences?tab=msa", label: "MSA", keywords: "master services agreement msa template contract propose sign" },
  { href: "/licences?tab=sla", label: "SLA", keywords: "service level agreement sla commitments uptime breaches target" },
  { href: "/licences?tab=audit-obligations", label: "Audit obligations", keywords: "oversight audits obligations requirements overdue findings cadence" },
  { href: "/marketplace", label: "Marketplace", keywords: "vendors service providers services identity kyc bureau account data esign subscribe standard terms pricing" },
  { href: "/audits", label: "Audits", keywords: "audit trail history log" },
  { href: "/settings", label: "Settings", keywords: "workspace members team invite invitations people roles apps repositories general rename" },
  { href: "/earn", label: "Earn", keywords: "liquidity pools opportunities capital commit withdraw positions invest wallet" },
  { href: "/builds", label: "Builds", keywords: "coding agent" },
  { href: "/new", label: "Build", keywords: "new app create build start financial product" },
  { href: "/docs", label: "Docs", keywords: "documentation reference tools mcp guides help api roles" },
  { href: "/connect", label: "Connect your agent", keywords: "mcp agent claude cursor vscode chatgpt connect plug docs documentation help guide" },
];

// Old pages that now redirect elsewhere: still fixed pages, never an app's id.
const MOVED: readonly StudioPage[] = [
  { href: "/members", label: "Settings" },
  { href: "/workspace", label: "Settings" },
  { href: "/liquidity", label: "Earn" },
  { href: "/coverage", label: "Licences" },
];

// Pages only some accounts have (the platform admin, /platform, for Mynt admins, in its own layout; /admin was its old
// address and redirects there): fixed pages, never an app's id, and not offered in search.
const RESTRICTED: readonly StudioPage[] = [
  { href: "/platform", label: "Mynt platform admin" },
  // A service provider's own services (Mynt's vendor role), in its sidebar only.
  { href: "/vendor", label: "My services" },
  { href: "/admin", label: "Mynt platform admin" },
];

// A tab of a page (/licences?tab=msa) is that page.
const PAGE_BY_SEGMENT = new Map([...STUDIO_PAGES, ...MOVED, ...RESTRICTED].filter((p) => !p.href.includes("?")).map((p) => [p.href.split("/")[1] ?? "", p]));

/** Whether a path is a financial product's workspace (/products/<product id>). */
export function isProductPath(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "products" && parts.length >= 2;
}

/** Whether a path is inside an app (/<app id>, /<app id>/<build id>): every first segment that isn't a fixed page (or a product's workspace). */
export function isAppPath(pathname: string): boolean {
  const first = pathname.split("/").filter(Boolean)[0];
  return first !== undefined && first !== "products" && !PAGE_BY_SEGMENT.has(first);
}

/** The header's title for a fixed page: only the page's name. Null inside an app or a product (their own header names them). */
export function pageTitle(pathname: string): string | null {
  if (isAppPath(pathname) || isProductPath(pathname)) return null;
  const first = pathname.split("/").filter(Boolean)[0] ?? "";
  return PAGE_BY_SEGMENT.get(first)?.label ?? "Mynt Studio";
}

/**
 * Whether an answer's link may be followed: a same-origin relative path only ("/coverage",
 * "/<app id>"). Not "//host", "/\host" (browsers read both as another host), a scheme
 * ("https:", "javascript:"), a bare word, or anything with spaces or control characters.
 */
export function isStudioPath(href: unknown): href is string {
  if (typeof href !== "string" || href.length > 500) return false;
  if (!/^\/(?![/\\])/.test(href) || /[\s\\\u0000-\u001f\u007f]/.test(href)) return false;
  try {
    return new URL(href, "https://studio.invalid").origin === "https://studio.invalid";
  } catch {
    return false;
  }
}

// An app's tabs that search finds by name and by what they hold; each opens the app on that tab.
export const APP_SEARCH_TABS = [
  { tab: "products", label: "Products", keywords: "products sponsors sponsor licence provider states" },
  { tab: "agreements", label: "Agreements", keywords: "agreements program contract vendor data sharing introductions partners sign" },
  { tab: "customers", label: "Customers", keywords: "customers personas segments target audience" },
  { tab: "security", label: "Security & risk", keywords: "security risk risks register infosec fraud vendors conduct mitigation" },
] as const;

export type SearchGroup = "Pages" | "Apps" | "Financial products" | "Members" | "Audit actions" | PlatformSearchGroup;
export const SEARCH_GROUPS: readonly SearchGroup[] = ["Pages", "Apps", "Financial products", "Members", "Audit actions"];

// `requires`: an item found only when one of the words typed is among these (an app's tab isn't listed for its name alone).
export type SearchItem = { id: string; group: SearchGroup; label: string; hint?: string; href: string; text: string; requires?: string };

export type SearchSources = {
  apps?: { id: string; name: string; stage: Stage }[];
  // The user's own financial products: each opens its workspace (/products/<id>).
  products?: { id: string; name: string; stage?: Stage }[];
  members?: { userId: string; name: string | null; email: string | null; role: string }[];
  auditActions?: string[];
  // A Mynt admin: the platform admin's sections are pages too (/platform/…), for nobody else.
  admin?: boolean;
};

// The platform admin's sections, as search lists them for Mynt admins (lib/admin.ts has their addresses).
export const PLATFORM_SEARCH_PAGES: readonly StudioPage[] = [
  { href: "/platform", label: "Platform admin: Overview", keywords: "mynt platform admin attention operations status" },
  { href: "/platform/workspaces", label: "Platform admin: Workspaces", keywords: "all workspaces teams members people invite roles" },
  { href: "/platform/firms", label: "Platform admin: Firms", keywords: "firms licence providers vendors liquidity providers register members people invite roles products" },
  { href: "/platform/licences", label: "Platform admin: Licences", keywords: "licences licenses review verify approve reject" },
  { href: "/platform/vendors", label: "Platform admin: Vendors", keywords: "vendors service types offerings suspend" },
  { href: "/platform/audit", label: "Platform admin: Audit trails", keywords: "audit log trail history who changed what actions security financial obligations" },
  { href: "/platform/risks", label: "Platform admin: Security & risk", keywords: "security risk register platform risks signals attention backups conformance" },
  { href: "/platform/settings", label: "Platform admin: Platform settings", keywords: "platform settings esign e-signature pricing budget audit" },
];

const lower = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" ").toLowerCase();

/** Everything search can find, from what the studio has loaded for the selected workspace. */
export function searchIndex(sources: SearchSources): SearchItem[] {
  const pages = [...STUDIO_PAGES, ...(sources.admin ? PLATFORM_SEARCH_PAGES : [])];
  const items: SearchItem[] = pages.map((p) => ({ id: `page:${p.href}`, group: "Pages", label: p.label, href: p.href, text: lower(p.label, p.keywords) }));
  for (const a of sources.apps ?? []) {
    const stage = STAGE_LABELS[a.stage];
    items.push({ id: `app:${a.id}`, group: "Apps", label: a.name, hint: stage, href: `/${encodeURIComponent(a.id)}`, text: lower(a.name, stage, a.stage) });
    // Its business tabs, found by what they hold (an app holds no licences: its products' sponsors are on Products).
    for (const t of APP_SEARCH_TABS)
      items.push({ id: `apptab:${a.id}:${t.tab}`, group: "Apps", label: `${a.name}: ${t.label}`, hint: "App tab", href: `/${encodeURIComponent(a.id)}?tab=${t.tab}`, text: lower(a.name, t.label, t.keywords), requires: lower(t.label, t.keywords) });
  }
  for (const p of sources.products ?? []) {
    const stage = p.stage ? STAGE_LABELS[p.stage] : undefined;
    items.push({ id: `product:${p.id}`, group: "Financial products", label: p.name, hint: stage, href: `/products/${encodeURIComponent(p.id)}`, text: lower(p.name, p.id, stage, p.stage, "financial product") });
  }
  for (const m of sources.members ?? []) {
    const label = m.name ?? m.email ?? "Member";
    items.push({ id: `member:${m.userId}`, group: "Members", label, hint: m.role, href: "/settings?tab=members", text: lower(m.name, m.email, m.role) });
  }
  for (const action of [...new Set(sources.auditActions ?? [])].sort()) {
    items.push({ id: `audit:${action}`, group: "Audit actions", label: action, href: `/audits?action=${encodeURIComponent(action)}`, text: lower(action, action.replace(/[._]/g, " ")) });
  }
  return items;
}

// The platform admin's own search (its header, /platform): its sections first, then workspaces and firms by name, then
// the studio's pages as a secondary group. Across Mynt, never a workspace picked in the studio.
export type PlatformSearchGroup = "Platform admin" | "Workspaces" | "Firms" | "Studio";
export const PLATFORM_SEARCH_GROUPS: readonly PlatformSearchGroup[] = ["Platform admin", "Workspaces", "Firms", "Studio"];

export type PlatformSearchSources = {
  workspaces?: { id: string; name: string; personal?: boolean; status?: string | null }[];
  firms?: { id: string; name: string; status?: string | null; country?: string | null }[];
};

const PLATFORM_PREFIX = "Platform admin: ";
const platformItemHref = (section: "workspaces" | "firms", id: string) => `/platform/${section}/${encodeURIComponent(id)}`;

/** Everything the platform admin's search can find: its sections, every workspace and firm loaded, and the studio's pages. */
export function platformSearchIndex(sources: PlatformSearchSources): SearchItem[] {
  const items: SearchItem[] = PLATFORM_SEARCH_PAGES.map((p) => {
    const label = p.label.startsWith(PLATFORM_PREFIX) ? p.label.slice(PLATFORM_PREFIX.length) : p.label;
    return { id: `platform:${p.href}`, group: "Platform admin", label, href: p.href, text: lower(label, "platform admin", p.keywords) };
  });
  for (const w of sources.workspaces ?? []) {
    const hint = w.personal ? "Personal" : w.status || undefined;
    items.push({ id: `workspace:${w.id}`, group: "Workspaces", label: w.name, hint, href: platformItemHref("workspaces", w.id), text: lower(w.name, w.id, "workspace", hint) });
  }
  for (const f of sources.firms ?? []) {
    const hint = [f.country, f.status].filter(Boolean).join(" · ") || undefined;
    items.push({ id: `firm:${f.id}`, group: "Firms", label: f.name, hint, href: platformItemHref("firms", f.id), text: lower(f.name, f.id, "firm", f.country, f.status) });
  }
  for (const p of STUDIO_PAGES)
    items.push({ id: `studio:${p.href}`, group: "Studio", label: `Studio: ${p.label}`, href: p.href, text: lower("studio", p.label, p.keywords) });
  return items;
}

/** What a query finds in the platform admin's search: as searchStudio, in its groups; an empty query lists the sections and the studio's pages. */
export function searchPlatform(items: SearchItem[], query: string, perGroup = PLATFORM_SEARCH_PAGES.length): SearchItem[] {
  return searchStudio(items, query, perGroup, { groups: PLATFORM_SEARCH_GROUPS, browse: ["Platform admin", "Studio"] });
}

export const PER_GROUP = 6;

/**
 * What a query finds: items whose text holds every word typed (any order, any case), best first
 * (label starts with the query, then label contains it), at most PER_GROUP per group, in group
 * order. An empty query lists the pages and the first apps.
 */
export function searchStudio(
  items: SearchItem[],
  query: string,
  perGroup = PER_GROUP,
  // Which groups, in order, and which an empty query lists (the platform admin's search has its own).
  { groups = SEARCH_GROUPS, browse }: { groups?: readonly SearchGroup[]; browse?: readonly SearchGroup[] } = {},
): SearchItem[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hits = words.length
    ? items.filter((i) => words.every((w) => i.text.includes(w) || i.label.toLowerCase().includes(w)) && (!i.requires || words.some((w) => i.requires!.includes(w))))
    : browse
      ? items.filter((i) => browse.includes(i.group) && !i.requires)
      : items.filter((i) => i.group === "Pages" || (i.group === "Apps" && !i.requires) || i.group === "Financial products");
  const rank = (i: SearchItem) => {
    const label = i.label.toLowerCase();
    return !q ? 0 : label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
  };
  return groups.flatMap((g) =>
    hits
      .filter((i) => i.group === g)
      .map((i, n) => ({ i, n }))
      .sort((a, b) => rank(a.i) - rank(b.i) || a.n - b.n)
      .slice(0, perGroup)
      .map(({ i }) => i),
  );
}
