// The docs' search (the box in /docs' header): over pages' titles and section headings, and every tool's name,
// title and description. The index comes from /docs/search-index (lib/docs.ts searchIndex); this file is the part
// the browser runs.

export type DocsSearchItem = {
  kind: "page" | "section" | "tool";
  title: string; // a page's or section's title; a tool's name
  subtitle: string | null; // the page a section is in; a tool's title
  href: string;
  text: string; // lower-case words searched, title included
};

const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

// Every word of the query must match. Exact names and titles first, then starts, then anywhere.
export function searchDocs(index: readonly DocsSearchItem[], query: string, limit = 12): DocsSearchItem[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(" ");
  const scored: { item: DocsSearchItem; score: number }[] = [];
  for (const item of index) {
    const title = norm(item.title);
    const sub = norm(item.subtitle ?? "");
    const hay = `${title} ${sub} ${item.text}`;
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    if (title === q) score += 100;
    else if (title.startsWith(q)) score += 60;
    else if (title.includes(q)) score += 40;
    if (sub.includes(q)) score += 20;
    score += words.filter((w) => title.includes(w)).length * 5;
    if (item.kind === "page") score += 3;
    scored.push({ item, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
    .slice(0, limit)
    .map((s) => s.item);
}

export const searchText = (...parts: (string | null | undefined)[]) => norm(parts.filter(Boolean).join(" "));
