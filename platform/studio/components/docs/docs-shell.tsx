"use client";

// The docs site's frame (/docs, public: no sign-in), laid out as GitBook lays out docs: a header (the docs' name,
// search, Open Studio and the theme), the nav tree on the left (collapsible sections; in a sheet on a phone), and
// the page (components/docs/docs-article.tsx) with its "On this page" on the right.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronRight, Menu } from "lucide-react";

import { DocsSearch } from "@/components/docs/docs-search";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { BRAND } from "@/lib/brand";
import type { DocsNavSection } from "@/lib/docs";
import { cn } from "@/lib/utils";

export function DocsNav({ nav, pathname, onNavigate }: { nav: DocsNavSection[]; pathname: string; onNavigate?: () => void }) {
  return (
    <nav aria-label="Docs" className="flex flex-col gap-1 text-sm" data-docs-nav>
      {nav.map((s) => (
        <NavSection key={s.id} section={s} pathname={pathname} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}

function NavSection({ section, pathname, onNavigate }: { section: DocsNavSection; pathname: string; onNavigate?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-nav-section={section.id}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground" data-nav-section-toggle>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} aria-hidden />
        {section.title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mb-2 flex flex-col gap-0.5 pl-3">
          {section.items.map((i) => (
            <li key={i.href}>
              <Link
                href={i.href}
                onClick={onNavigate}
                aria-current={pathname === i.href ? "page" : undefined}
                className={cn("block rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground", pathname === i.href && "bg-muted font-medium text-foreground")}
                data-nav-link={i.href}
              >
                {i.title}
              </Link>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function DocsShell({ nav, children }: { nav: DocsNavSection[]; children: React.ReactNode }) {
  const pathname = usePathname() ?? "/docs";
  const [menu, setMenu] = useState(false);
  return (
    <div className="flex h-full flex-col" data-docs-shell>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4 lg:gap-4 lg:px-6" data-docs-header>
        <Button variant="outline" size="sm" className="md:hidden" onClick={() => setMenu(true)} data-docs-menu>
          <Menu />
          Menu
        </Button>
        <Link href="/docs" className="flex shrink-0 items-center gap-2 font-heading text-base font-semibold" data-docs-home>
          <span className="size-3 rounded-full" style={{ background: BRAND.mint }} aria-hidden />
          Mynt Docs
        </Link>
        <DocsSearch className="mx-auto hidden w-full max-w-md sm:block" />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <a href="/" data-docs-studio-link>
              Open Studio
            </a>
          </Button>
          <ThemeSwitcher />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 overflow-y-auto border-r p-4 md:block" data-docs-sidebar>
          <DocsNav nav={nav} pathname={pathname} />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <Sheet open={menu} onOpenChange={setMenu}>
        <SheetContent side="left" className="w-72 overflow-y-auto p-0">
          <SheetHeader>
            <SheetTitle>Mynt Docs</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-4 px-4 pb-4">
            <DocsSearch onNavigate={() => setMenu(false)} />
            <DocsNav nav={nav} pathname={pathname} onNavigate={() => setMenu(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
