"use client";

// One docs page: breadcrumbs, its title, its content (rendered on the server), previous and next, and "On this page"
// on the right with the section being read highlighted. It scrolls in its own box, as studio pages do.
import Link from "next/link";
import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { OnThisPage, useScrollSpy, type OnThisPageItem } from "@/components/docs/on-this-page";
import type { DocsNavItem } from "@/lib/docs";

export function DocsArticle({
  title,
  crumbs,
  toc,
  prev,
  next,
  children,
}: {
  title: string;
  crumbs: DocsNavItem[];
  toc: OnThisPageItem[];
  prev: DocsNavItem | null;
  next: DocsNavItem | null;
  children: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const active = useScrollSpy(toc, scroller);
  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-docs-scroll>
      <div className="flex w-full gap-10 p-4 lg:p-8">
        <article className="mx-auto flex w-full max-w-3xl min-w-0 flex-1 flex-col" data-docs-article>
          <nav aria-label="Breadcrumbs" className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" data-breadcrumbs>
            {crumbs.map((c, i) => (
              <span key={c.href + i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3" aria-hidden />}
                {i < crumbs.length - 1 ? (
                  <Link href={c.href} className="hover:text-foreground">
                    {c.title}
                  </Link>
                ) : (
                  <span className="text-foreground">{c.title}</span>
                )}
              </span>
            ))}
          </nav>
          <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight" data-docs-title>
            {title}
          </h1>
          <div className="mt-6" data-docs-content>
            {children}
          </div>
          {(prev || next) && (
            <nav aria-label="Previous and next" className="mt-12 grid gap-3 border-t pt-6 sm:grid-cols-2" data-prev-next>
              {prev ? (
                <Link href={prev.href} className="flex flex-col rounded-lg border p-3 hover:bg-muted" data-prev>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ChevronLeft className="size-3" aria-hidden />
                    Previous
                  </span>
                  <span className="text-sm font-medium">{prev.title}</span>
                </Link>
              ) : (
                <span />
              )}
              {next && (
                <Link href={next.href} className="flex flex-col items-end rounded-lg border p-3 text-right hover:bg-muted" data-next>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    Next
                    <ChevronRight className="size-3" aria-hidden />
                  </span>
                  <span className="text-sm font-medium">{next.title}</span>
                </Link>
              )}
            </nav>
          )}
        </article>
        {toc.length > 0 && (
          <OnThisPage
            items={toc}
            active={active}
            className="sticky top-0 hidden max-h-[calc(100vh-7rem)] w-56 shrink-0 space-y-1 self-start overflow-y-auto border-l pl-6 text-sm xl:block"
          />
        )}
      </div>
    </div>
  );
}
