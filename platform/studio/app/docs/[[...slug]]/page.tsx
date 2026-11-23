import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsPage } from "@/components/docs/docs-page";
import { docsRoute, docsTitle } from "@/lib/docs";
import { source } from "@/lib/docs-source";

// Every docs page: /docs, /docs/<page>, /docs/tools and /docs/tools/<area> (lib/docs-source.ts lists them; /connect
// is /docs/connect served at its own address, lib/redirects.ts).
type Params = { params: Promise<{ slug?: string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const slug = (await params).slug ?? [];
  const route = docsRoute(slug);
  if (!route) return {};
  const description = source.getPage(slug)?.data.description;
  return { title: slug.length ? docsTitle(route) : "What Mynt is", ...(description ? { description } : {}) };
}

export default async function DocsSlugPage({ params }: Params) {
  const route = docsRoute((await params).slug ?? []);
  if (!route) notFound();
  return <DocsPage route={route} />;
}
