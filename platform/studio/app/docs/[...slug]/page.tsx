import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DocsPage } from "@/components/docs/docs-page";
import { docsRoute, docsTitle } from "@/lib/docs";

type Params = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const route = docsRoute((await params).slug);
  if (!route) return {};
  const description = route.kind === "markdown" ? route.page.summary : route.kind === "area" ? route.area.summary : null;
  return { title: docsTitle(route), ...(description ? { description } : {}) };
}

export default async function DocsSlugPage({ params }: Params) {
  const route = docsRoute((await params).slug);
  if (!route) notFound();
  return <DocsPage route={route} />;
}
