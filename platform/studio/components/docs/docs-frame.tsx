// The docs' frame (/docs, and Connect your agent at /connect), laid out by Fumadocs UI as GitBook lays out docs: the
// nav tree from lib/docs-source.ts (core's generated pages and tool reference) in a collapsible sidebar (a drawer on
// a phone), search over /docs/search-index (Fumadocs' own index, served by this app), the theme switch and a
// labelled Open Studio link. next-themes is the root layout's (theme disabled here), so Fumadocs' switch drives the
// studio's own light and dark; app/globals.css maps Fumadocs' colours onto the studio's tokens.
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";

import { BRAND } from "@/lib/brand";
import { source } from "@/lib/docs-source";

export const DOCS_SEARCH_API = "/docs/search-index";

function DocsTitleMark() {
  return (
    <span className="flex items-center gap-2 font-heading text-base font-semibold" data-docs-home>
      <span className="size-3 rounded-full" style={{ background: BRAND.mint }} aria-hidden />
      Mynt Docs
    </span>
  );
}

export function DocsFrame({ children }: { children: React.ReactNode }) {
  return (
    <RootProvider theme={{ enabled: false }} search={{ options: { api: DOCS_SEARCH_API } }}>
      <DocsLayout
        tree={source.pageTree}
        tabs={false}
        nav={{ title: <DocsTitleMark />, url: "/docs" }}
        links={[{ type: "main", text: "Open Studio", url: "/", active: "none" }]}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
