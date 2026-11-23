// The docs site (/docs): its pages and tool reference, from the data core generates (docs/site/*.json, written by
// core/scripts/docs-data.mjs from the live tool registry and the repository's Markdown; core's
// test/tool-catalogue.test.js keeps them in step). Server-side only: the JSON is large, and pages render on the
// server. The browser gets the nav tree, a page's headings and, on demand, the search index.
import pagesData from "../../../docs/site/pages.json";
import toolsData from "../../../docs/site/tools.json";
import { searchText, type DocsSearchItem } from "@/lib/docs-search";
import type { JsonSchema } from "@/lib/docs-schema";

export type DocsRole = "consumer" | "developer" | "innovator" | "vendor" | "license_provider" | "liquidity_provider" | "admin";
export type DocsTool = {
  name: string;
  title: string | null;
  description: string;
  area: string;
  roles: DocsRole[];
  access: "read" | "write" | "destructive";
  access_from: "annotation" | "name";
  inputSchema: JsonSchema;
};
export type DocsArea = { id: string; title: string; summary: string; tools: number };
export type DocsRoleInfo = { role: DocsRole; summary: string; tools: number; get_started: { tool: string; why: string }[] };
export type DocsEndpoint = { method: string; path: string; auth: "app key" | "client session"; summary: string };
export type DocsMarkdownPage = { slug: string; title: string; summary: string | null; section: string; kind: string | null; markdown: string; sources: string[] };
export type Catalogue = { areas: DocsArea[]; roles: DocsRoleInfo[]; runtime_endpoints: DocsEndpoint[]; tools: DocsTool[] };

export const CATALOGUE = toolsData as unknown as Catalogue;
const PAGES = pagesData as unknown as { sections: { id: string; title: string }[]; pages: DocsMarkdownPage[] };

export const DOCS_HOME = "/docs";
export const ROLE_LABEL: Record<DocsRole, string> = {
  consumer: "Consumer",
  developer: "Developer",
  innovator: "Innovator",
  vendor: "Vendor",
  license_provider: "Licence provider",
  liquidity_provider: "Liquidity provider",
  admin: "Admin",
};
export const ACCESS_LABEL: Record<DocsTool["access"], string> = { read: "Read", write: "Changes data", destructive: "Removes data" };

// Connect your agent lives at /connect (served from the docs, next.config.ts; /docs/connect redirects there).
export const CONNECT_HREF = "/connect";
export const pageHref = (slug: string) => (slug === "connect" ? CONNECT_HREF : slug ? `${DOCS_HOME}/${slug}` : DOCS_HOME);
export const TOOLS_HREF = `${DOCS_HOME}/tools`;
export const areaHref = (id: string) => `${TOOLS_HREF}/${id}`;
export const toolHref = (t: Pick<DocsTool, "name" | "area">) => `${areaHref(t.area)}#${t.name}`;

const TOOL_BY_NAME = new Map(CATALOGUE.tools.map((t) => [t.name, t]));
export const toolByName = (name: string) => TOOL_BY_NAME.get(name);
export const areaById = (id: string) => CATALOGUE.areas.find((a) => a.id === id);
export const toolsInArea = (id: string) => CATALOGUE.tools.filter((t) => t.area === id);
// Every tool's page address, for linking tool names in text.
export const TOOL_LINKS: Record<string, string> = Object.fromEntries(CATALOGUE.tools.map((t) => [t.name, toolHref(t)]));

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

// A heading's text without its Markdown: links keep their text, code and emphasis lose their marks.
export const plainHeading = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").trim();

export type DocsHeading = { id: string; label: string };

// A Markdown page's own sections (## headings, outside code blocks), with the ids its renderer gives them.
export function markdownHeadings(markdown: string): DocsHeading[] {
  const out: DocsHeading[] = [];
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ id: uniqueId(slugify(plainHeading(m[1])), seen), label: plainHeading(m[1]) });
  }
  return out;
}

export function uniqueId(base: string, seen: Map<string, number>): string {
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

// ---- the nav tree, in reading order ----

export type DocsNavItem = { title: string; href: string };
export type DocsNavSection = { id: string; title: string; items: DocsNavItem[] };

export function docsNav(): DocsNavSection[] {
  return PAGES.sections.map((s) => ({
    id: s.id,
    title: s.title,
    items:
      s.id === "tools"
        ? [{ title: "All tools", href: TOOLS_HREF }, ...CATALOGUE.areas.map((a) => ({ title: a.title, href: areaHref(a.id) }))]
        : PAGES.pages.filter((p) => p.section === s.id).map((p) => ({ title: p.title, href: pageHref(p.slug) })),
  }));
}

const FLAT = () => docsNav().flatMap((s) => s.items.map((i) => ({ ...i, section: s })));

export function neighbours(href: string): { prev: DocsNavItem | null; next: DocsNavItem | null } {
  const flat = FLAT();
  const i = flat.findIndex((p) => p.href === href);
  if (i < 0) return { prev: null, next: null };
  const pick = (p: (typeof flat)[number] | undefined) => (p ? { title: p.title, href: p.href } : null);
  return { prev: pick(flat[i - 1]), next: pick(flat[i + 1]) };
}

export function breadcrumbs(href: string): DocsNavItem[] {
  const hit = FLAT().find((p) => p.href === href);
  const crumbs: DocsNavItem[] = [{ title: "Docs", href: DOCS_HOME }];
  if (!hit || href === DOCS_HOME) return crumbs;
  const first = hit.section.items[0];
  crumbs.push({ title: hit.section.title, href: first.href });
  if (first.href !== href) crumbs.push({ title: hit.title, href });
  return crumbs;
}

// ---- what a docs address shows ----

export type DocsRoute =
  | { kind: "markdown"; page: DocsMarkdownPage; href: string }
  | { kind: "tools"; href: string }
  | { kind: "area"; area: DocsArea; href: string };

export function docsRoute(slug: string[] = []): DocsRoute | null {
  const path = slug.join("/");
  if (path === "tools") return { kind: "tools", href: TOOLS_HREF };
  if (slug.length === 2 && slug[0] === "tools") {
    const area = areaById(slug[1]);
    return area ? { kind: "area", area, href: areaHref(area.id) } : null;
  }
  const page = PAGES.pages.find((p) => p.slug === path);
  return page ? { kind: "markdown", page, href: pageHref(page.slug) } : null;
}

export const docsTitle = (route: DocsRoute) => (route.kind === "tools" ? "All tools" : route.kind === "area" ? route.area.title : route.page.title);

// Every page's slug under /docs (Connect your agent's href is /connect, but its page is still /docs/connect).
export const allDocsSlugs = (): string[][] =>
  FLAT().map((p) => (p.href === CONNECT_HREF ? ["connect"] : p.href.slice(DOCS_HOME.length + 1).split("/").filter(Boolean)));

// ---- tools ----

// What a tool does, in a few words: its title, or its description's first sentence.
export function toolSummary(t: DocsTool): string {
  if (t.title) return t.title;
  const first = /^(.+?[.!?])(\s|$)/.exec(t.description)?.[1] ?? t.description;
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

// Tools a tool's description names, then the area's tools on the same thing (create_app, update_app, list_my_apps).
export function relatedTools(t: DocsTool, limit = 6): DocsTool[] {
  const out = new Map<string, DocsTool>();
  for (const m of t.description.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
    const hit = TOOL_BY_NAME.get(m[0]);
    if (hit && hit.name !== t.name) out.set(hit.name, hit);
  }
  const noun = (n: string) => n.replace(/^(list_my|list_all|list|get_my|get|create|update|delete|set|remove|revoke|rotate|define|register|approve|decline|request|run|start|stop|cancel|enable|disable|publish|unpublish|retire|seed|admin_set|admin_pause|reveal|suspend|resume|archive|unarchive)_/, "").replace(/s$/, "");
  const mine = noun(t.name);
  for (const o of toolsInArea(t.area)) if (o.name !== t.name && noun(o.name) === mine) out.set(o.name, o);
  return [...out.values()].slice(0, limit);
}

// ---- search ----

export function searchIndex(): DocsSearchItem[] {
  const items: DocsSearchItem[] = [];
  for (const s of docsNav()) for (const i of s.items) items.push({ kind: "page", title: i.title, subtitle: s.title, href: i.href, text: searchText(i.title, s.title) });
  for (const p of PAGES.pages) {
    for (const h of markdownHeadings(p.markdown)) items.push({ kind: "section", title: h.label, subtitle: p.title, href: `${pageHref(p.slug)}#${h.id}`, text: searchText(h.label, p.title) });
  }
  for (const a of CATALOGUE.areas) items.push({ kind: "section", title: a.title, subtitle: "Tool reference", href: areaHref(a.id), text: searchText(a.title, a.summary) });
  for (const t of CATALOGUE.tools) {
    items.push({ kind: "tool", title: t.name, subtitle: t.title, href: toolHref(t), text: searchText(t.name, t.title, t.description.slice(0, 240)) });
  }
  return items;
}
