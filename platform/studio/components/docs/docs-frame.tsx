// The docs' frame (/docs, and Connect your agent at /connect), laid out by Fumadocs UI as GitBook lays out docs: the
// nav tree from lib/docs-source.ts (core's generated pages and tool reference), search over /docs/search-index
// (Fumadocs' own index, served by this app) and the table of contents. next-themes is the root layout's (theme
// disabled here); app/globals.css maps Fumadocs' colours onto the studio's tokens.
//
// Signed out (DocsFrame): the standalone public layout, the tree in a collapsible sidebar (a drawer on a phone), the
// theme switch and a labelled Open Studio link; the window scrolls.
// Signed in (DocsInStudio): the same docs inside the studio's shell (its sidebar and header, app/(studio)/studio-shell.tsx).
// The studio's sidebar is the app's nav; Fumadocs' tree is the docs' own left column inside the content pane, which
// scrolls by itself (the tree and table of contents stick to the pane, sized to it in app/globals.css). The studio's
// header has the theme switch and Cmd+K, so Fumadocs' are left out here; its search opens from its own Search box.
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";

import { StudioShell } from "@/app/(studio)/studio-shell";
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

// Fumadocs' search without its Cmd+K (the studio's search has it): a key no keypress has (and a string, as a
// server component's props to a client component must be).
const NO_HOT_KEY = [{ key: "", display: null }];

export function DocsInStudio({ children }: { children: React.ReactNode }) {
  return (
    <StudioShell title="Docs">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-docs-in-shell>
        <RootProvider theme={{ enabled: false }} search={{ options: { api: DOCS_SEARCH_API }, hotKey: NO_HOT_KEY }}>
          <DocsLayout
            tree={source.pageTree}
            tabs={false}
            // No "Mynt Docs" title row inside the studio: the studio's header already says Docs.
            nav={{ enabled: false, title: null }}
            sidebar={{ collapsible: false }}
            themeSwitch={{ enabled: false }}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </div>
    </StudioShell>
  );
}

// The docs' layout for a visitor: inside the studio when signed in, the public layout otherwise.
export function DocsShell({ signedIn, children }: { signedIn: boolean; children: React.ReactNode }) {
  return signedIn ? <DocsInStudio>{children}</DocsInStudio> : <DocsFrame>{children}</DocsFrame>;
}
