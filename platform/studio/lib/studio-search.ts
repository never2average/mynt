// The studio's pages and its search (the header's search field and its Cmd+K modal), as pure
// functions: the page title for a path, and what a query finds among the pages, the workspace's
// apps, members, licences and audit actions.
import { STAGE_LABELS, type Stage } from "./workspaces";

export type StudioPage = { href: string; label: string; keywords?: string };

// Every fixed page, in the order search lists them.
export const STUDIO_PAGES: readonly StudioPage[] = [
  { href: "/", label: "Dashboard", keywords: "home money customers spend" },
  { href: "/licences", label: "Licences", keywords: "licenses partners regulators coverage states map where serve" },
  { href: "/licences?tab=coverage", label: "Coverage", keywords: "states map where serve licences" },
  { href: "/audits", label: "Audits", keywords: "audit trail history log" },
  { href: "/workspace", label: "Workspace", keywords: "members team invite invitations people roles apps settings rename" },
  { href: "/builds", label: "Builds", keywords: "coding agent" },
  { href: "/new", label: "New app", keywords: "create build start" },
];

// Old pages that now redirect elsewhere: still fixed pages, never an app's id.
const MOVED: readonly StudioPage[] = [
  { href: "/members", label: "Workspace" },
  { href: "/coverage", label: "Licences" },
];

// A tab of a page (/licences?tab=coverage) is that page.
const PAGE_BY_SEGMENT = new Map([...STUDIO_PAGES, ...MOVED].filter((p) => !p.href.includes("?")).map((p) => [p.href.split("/")[1] ?? "", p]));

/** Whether a path is inside an app (/<app id>, /<app id>/<build id>): every first segment that isn't a fixed page. */
export function isAppPath(pathname: string): boolean {
  const first = pathname.split("/").filter(Boolean)[0];
  return first !== undefined && !PAGE_BY_SEGMENT.has(first);
}

/** The header's title for a fixed page: only the page's name. Null inside an app (its own top bar names it). */
export function pageTitle(pathname: string): string | null {
  if (isAppPath(pathname)) return null;
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

export type SearchGroup = "Pages" | "Apps" | "Members" | "Licences" | "Audit actions";
export const SEARCH_GROUPS: readonly SearchGroup[] = ["Pages", "Apps", "Members", "Licences", "Audit actions"];

export type SearchItem = { id: string; group: SearchGroup; label: string; hint?: string; href: string; text: string };

export type SearchSources = {
  apps?: { id: string; name: string; stage: Stage }[];
  members?: { userId: string; name: string | null; email: string | null; role: string }[];
  licences?: { partner: string | null; type: string | null; regulator: string | null; number: string | null; states: string[]; status: string | null }[];
  auditActions?: string[];
};

const lower = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" ").toLowerCase();

/** Everything search can find, from what the studio has loaded for the selected workspace. */
export function searchIndex(sources: SearchSources): SearchItem[] {
  const items: SearchItem[] = STUDIO_PAGES.map((p) => ({ id: `page:${p.href}`, group: "Pages", label: p.label, href: p.href, text: lower(p.label, p.keywords) }));
  for (const a of sources.apps ?? []) {
    const stage = STAGE_LABELS[a.stage];
    items.push({ id: `app:${a.id}`, group: "Apps", label: a.name, hint: stage, href: `/${encodeURIComponent(a.id)}`, text: lower(a.name, stage, a.stage) });
  }
  for (const m of sources.members ?? []) {
    const label = m.name ?? m.email ?? "Member";
    items.push({ id: `member:${m.userId}`, group: "Members", label, hint: m.role, href: "/workspace?tab=members", text: lower(m.name, m.email, m.role) });
  }
  (sources.licences ?? []).forEach((l, i) => {
    const label = [l.partner, l.type].filter(Boolean).join(" · ") || l.number || "Licence";
    const hint = [l.regulator, l.status].filter(Boolean).join(" · ") || undefined;
    items.push({ id: `licence:${i}`, group: "Licences", label, hint, href: "/licences", text: lower(l.partner, l.type, l.regulator, l.number, l.status, ...l.states) });
  });
  for (const action of [...new Set(sources.auditActions ?? [])].sort()) {
    items.push({ id: `audit:${action}`, group: "Audit actions", label: action, href: `/audits?action=${encodeURIComponent(action)}`, text: lower(action, action.replace(/[._]/g, " ")) });
  }
  return items;
}

export const PER_GROUP = 6;

/**
 * What a query finds: items whose text holds every word typed (any order, any case), best first
 * (label starts with the query, then label contains it), at most PER_GROUP per group, in group
 * order. An empty query lists the pages and the first apps.
 */
export function searchStudio(items: SearchItem[], query: string, perGroup = PER_GROUP): SearchItem[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hits = words.length
    ? items.filter((i) => words.every((w) => i.text.includes(w) || i.label.toLowerCase().includes(w)))
    : items.filter((i) => i.group === "Pages" || i.group === "Apps");
  const rank = (i: SearchItem) => {
    const label = i.label.toLowerCase();
    return !q ? 0 : label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2;
  };
  return SEARCH_GROUPS.flatMap((g) =>
    hits
      .filter((i) => i.group === g)
      .map((i, n) => ({ i, n }))
      .sort((a, b) => rank(a.i) - rank(b.i) || a.n - b.n)
      .slice(0, perGroup)
      .map(({ i }) => i),
  );
}
