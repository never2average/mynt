// The docs as a Fumadocs source (fumadocs-core's loader over a virtual file list), built from the data core generates
// (lib/docs.ts): one folder per section of docs/site/manifest.json, holding its pages in order; the Tool reference
// folder holds All tools and one page per tool area. Fumadocs builds the nav tree, breadcrumbs, previous and next
// from it, and the search index from each page's structured data (its sections and their text). Nothing is written
// to disk: the pages stay generated from the repository's Markdown and the tool registry.
import { loader, type MetaData, type PageData, type VirtualFile } from "fumadocs-core/source";
import type { StructuredData } from "fumadocs-core/mdx-plugins/remark-structure";

import {
  CATALOGUE,
  CONNECT_HREF,
  DOCS_HOME,
  PAGES,
  docsRoute,
  docsSections,
  docsTitle,
  slugify,
  toolsInArea,
  uniqueId,
  type DocsRoute,
} from "@/lib/docs";

export type DocsPageData = PageData & { title: string; description?: string; structuredData: StructuredData };

// A page's address: /docs/<slug>, except Connect your agent, which is shown at /connect (lib/redirects.ts).
export const docsUrl = (slugs: string[]) => (slugs.join("/") === "connect" ? CONNECT_HREF : slugs.length ? `${DOCS_HOME}/${slugs.join("/")}` : DOCS_HOME);

// Markdown without its marks, for the search index.
const plain = (s: string) =>
  s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// A Markdown page's paragraphs, each under the ## section it sits in (ids as lib/docs.ts markdownHeadings gives them).
function markdownContents(markdown: string): StructuredData["contents"] {
  const out: StructuredData["contents"] = [];
  const seen = new Map<string, number>();
  let heading: string | undefined;
  let fence = false;
  let para: string[] = [];
  const flush = () => {
    const text = plain(para.join(" "));
    if (text) out.push({ heading, content: text.length > 600 ? `${text.slice(0, 597)}…` : text });
    para = [];
  };
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h2 = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h2) {
      flush();
      heading = uniqueId(slugify(plain(h2[1])), seen);
      continue;
    }
    if (/^#{1,6}\s/.test(line) || !line.trim()) flush();
    if (line.trim()) para.push(line);
  }
  flush();
  return out;
}

function structuredData(route: DocsRoute): StructuredData {
  const headings = docsSections(route).map((s) => ({ id: s.id, content: s.label }));
  if (route.kind === "tools") return { headings, contents: CATALOGUE.areas.map((a) => ({ heading: a.id, content: a.summary })) };
  if (route.kind === "area") {
    // A tool is found by its name (with its words apart too: define_region, "define region"), title and description.
    return {
      headings,
      contents: toolsInArea(route.area.id).map((t) => ({
        heading: t.name,
        content: [t.name.replace(/_/g, " "), t.title, t.description.slice(0, 400)].filter(Boolean).join(". "),
      })),
    };
  }
  const contents = markdownContents(route.page.markdown);
  if (route.page.kind === "roles") contents.unshift(...CATALOGUE.roles.map((r) => ({ heading: "roles", content: r.summary })));
  return { headings, contents };
}

function description(route: DocsRoute): string | undefined {
  if (route.kind === "markdown") return route.page.summary ?? undefined;
  if (route.kind === "area") return route.area.summary;
  return `Every one of Mynt's ${CATALOGUE.tools.length} tools, by area.`;
}

const page = (folder: string, name: string, slugs: string[]): VirtualFile => {
  const route = docsRoute(slugs)!;
  const data: DocsPageData = { title: docsTitle(route), description: description(route), structuredData: structuredData(route) };
  return { type: "page", path: `${folder}/${name}.md`, slugs, data };
};

// Each section's folder, its pages in the manifest's order (a page's file name is its slug with / as ~).
export function docsFiles(): VirtualFile[] {
  const files: VirtualFile[] = [{ type: "meta", path: "meta.json", data: { pages: PAGES.sections.map((s) => s.id) } satisfies MetaData }];
  for (const s of PAGES.sections) {
    const pages: VirtualFile[] =
      s.id === "tools"
        ? [page(s.id, "all-tools", ["tools"]), ...CATALOGUE.areas.map((a) => page(s.id, a.id, ["tools", a.id]))]
        : PAGES.pages.filter((p) => p.section === s.id).map((p) => page(s.id, p.slug.replace(/\//g, "~") || "home", p.slug ? p.slug.split("/") : []));
    const names = pages.map((f) => f.path.slice(s.id.length + 1, -".md".length));
    files.push({ type: "meta", path: `${s.id}/meta.json`, data: { title: s.title, pages: names, defaultOpen: true } satisfies MetaData }, ...pages);
  }
  return files;
}

export const source = loader({
  baseUrl: DOCS_HOME,
  url: docsUrl,
  source: { files: docsFiles() },
});

// Every page's slugs under /docs (Connect your agent's address is /connect, but its page is still /docs/connect).
export const allDocsSlugs = (): string[][] => source.getPages().map((p) => p.slugs);
