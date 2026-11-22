// The docs' search index (components/docs/docs-search.tsx loads it once): pages, their sections and every tool.
// Public, as the docs are.
import { searchIndex } from "@/lib/docs";

export function GET() {
  return Response.json({ items: searchIndex() }, { headers: { "Cache-Control": "public, max-age=300" } });
}
