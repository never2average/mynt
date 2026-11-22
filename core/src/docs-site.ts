// The data behind Mynt Studio's docs (/docs): the tool catalogue from the live registry (tool-catalogue.ts) and the
// pages, cut from the repository's own Markdown (README.md, docs/*.md) by the headings a manifest names. One source
// of truth each: scripts/docs-data.mjs writes the files, and test/tool-catalogue.test.js fails when the committed
// ones differ from what this generates, so the docs never drift from the server or the Markdown.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { REPO_URL } from "./llms-txt.js";
import type { Store } from "./store.js";
import { toolCatalogue } from "./tool-catalogue.js";

// Where the docs' data lives, from the repository root. The manifest is hand-written; the rest is generated.
export const DOCS_DATA_DIR = "docs/site";
export const DOCS_MANIFEST = `${DOCS_DATA_DIR}/manifest.json`;
export const DOCS_TOOLS = `${DOCS_DATA_DIR}/tools.json`;
export const DOCS_PAGES = `${DOCS_DATA_DIR}/pages.json`;

type Source = { file: string; heading: string; title?: string; skip?: string[] };
type ManifestPage = { slug: string; title: string; summary?: string; sources?: Source[]; kind?: string };
type Manifest = { sections: { id: string; title: string; pages: ManifestPage[] }[] };

export type DocsPage = { slug: string; title: string; summary: string | null; section: string; kind: string | null; markdown: string; sources: string[] };

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

// Where the section a heading starts lies: from that heading to the next heading at its level or above, never
// mistaking a '#' line inside a code block for a heading.
function sectionRange(lines: string[], heading: string): { start: number; end: number; level: number } {
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    if (start < 0) {
      if (m[2] === heading) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) return { start, end: i, level };
  }
  if (start < 0) throw new Error(`no heading "${heading}"`);
  return { start, end: lines.length, level };
}

// A section's body (without its heading) and its heading's level, leaving out the subsections named in `skip`.
export function extractSection(markdown: string, heading: string, skip: string[] = []): { level: number; body: string } {
  const lines = markdown.split("\n");
  const { start, end, level } = sectionRange(lines, heading);
  let body = lines.slice(start + 1, end);
  for (const h of skip) {
    const r = sectionRange(body, h);
    body = [...body.slice(0, r.start), ...body.slice(r.end)];
  }
  return { level, body: body.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

// Headings move so the section's own subsections sit one level under the page's section heading (## ).
function shiftHeadings(body: string, from: number, to: number): string {
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) inFence = !inFence;
      if (inFence) return line;
      const m = HEADING.exec(line);
      if (!m) return line;
      const level = Math.min(6, Math.max(2, m[1].length - from + to));
      return `${"#".repeat(level)} ${m[2]}`;
    })
    .join("\n");
}

// Relative links point into the repository on GitHub (the docs site has no copy of the files they name).
function absoluteLinks(body: string, file: string): string {
  const dir = posix.dirname(file);
  return body.replace(/\]\((?!https?:|mailto:)([^)\s]*)\)/g, (_m, href: string) => {
    const [path, hash] = href.split("#");
    const target = path ? posix.normalize(posix.join(dir, path)) : file;
    return `](${REPO_URL}/blob/main/${target}${hash ? `#${hash}` : ""})`;
  });
}

export function buildPages(root: string, manifest: Manifest): DocsPage[] {
  const cache = new Map<string, string>();
  const read = (f: string) => cache.get(f) ?? cache.set(f, readFileSync(join(root, f), "utf8")).get(f)!;
  const pages: DocsPage[] = [];
  for (const section of manifest.sections) {
    for (const p of section.pages) {
      const parts = (p.sources ?? []).map((s) => {
        const { level, body } = extractSection(read(s.file), s.heading, s.skip);
        // One source fills the page by itself; several each get their own section heading.
        const many = p.sources!.length > 1;
        const text = absoluteLinks(shiftHeadings(body, level + 1, many ? 3 : 2), s.file);
        return (many ? `## ${s.title ?? s.heading}\n\n${text}` : text).trim();
      });
      pages.push({
        slug: p.slug,
        title: p.title,
        summary: p.summary ?? null,
        section: section.id,
        kind: p.kind ?? null,
        markdown: parts.join("\n\n"),
        sources: (p.sources ?? []).map((s) => `${s.file}#${s.heading}`),
      });
    }
  }
  return pages;
}

// The generated files' text, keyed by their path from the repository root.
export async function docsSiteFiles(store: Store, root: string): Promise<Record<string, string>> {
  const manifest = JSON.parse(readFileSync(join(root, DOCS_MANIFEST), "utf8")) as Manifest;
  const catalogue = await toolCatalogue(store);
  return {
    [DOCS_TOOLS]: `${JSON.stringify(catalogue, null, 2)}\n`,
    [DOCS_PAGES]: `${JSON.stringify({ sections: manifest.sections.map(({ id, title }) => ({ id, title })), pages: buildPages(root, manifest) }, null, 2)}\n`,
  };
}
