// The docs site (/docs): its pages and tool reference, from the data core generates (docs/site/*.json, written by
// core/scripts/docs-data.mjs from the live tool registry and the repository's Markdown; core's
// test/tool-catalogue.test.js keeps them in step). Server-side only: the JSON is large, and pages render on the
// server. lib/docs-source.ts turns them into Fumadocs' source (the nav tree and the search index).
import pagesData from "../../../docs/site/pages.json";
import toolsData from "../../../docs/site/tools.json";
import { CONNECT_SECTIONS } from "@/lib/connect-sections";
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
export const PAGES = pagesData as unknown as { sections: { id: string; title: string }[]; pages: DocsMarkdownPage[] };

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

// A page's sections, in order, with the ids its headings get: its table of contents and its search entries.
export function docsSections(route: DocsRoute): DocsHeading[] {
  if (route.kind === "tools") return CATALOGUE.areas.map((a) => ({ id: a.id, label: a.title }));
  if (route.kind === "area") return toolsInArea(route.area.id).map((t) => ({ id: t.name, label: t.name }));
  const { page } = route;
  const headings = markdownHeadings(page.markdown);
  if (page.kind === "connect") return CONNECT_SECTIONS.map((s) => ({ ...s }));
  if (page.kind === "roles") return [{ id: "roles", label: "Roles" }, ...headings];
  if (page.kind === "first-app") return [{ id: "steps", label: "First steps" }, ...headings];
  if (page.kind === "runtime") return [{ id: "endpoints", label: "Endpoints" }, ...headings];
  return page.slug === "" ? [{ id: "start-here", label: "Start here" }, ...headings] : headings;
}

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
