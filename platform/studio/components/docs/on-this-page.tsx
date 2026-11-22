"use client";

// "On this page": a page's sections, the one being read highlighted (scroll-spy), for /connect and every /docs page.
// The studio's pages scroll in their own box, where a bare #link doesn't always move it, so a click scrolls the
// section into view and keeps the address's #section in step.
import { useEffect, useState, type RefObject } from "react";

import { cn } from "@/lib/utils";

export type OnThisPageItem = { id: string; label: string };

export function goTo(id: string, smooth = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: smooth && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto", block: "start" });
  if (window.location.hash !== `#${id}`) window.history.replaceState(null, "", `#${id}`);
}

// The section being read: the first one in view inside `scroller`. Opened at #section, it goes there once drawn.
export function useScrollSpy(items: readonly OnThisPageItem[], scroller: RefObject<HTMLElement | null>): string {
  const [active, setActive] = useState<string>(items[0]?.id ?? "");
  const key = items.map((s) => s.id).join(" ");
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (items.some((s) => s.id === id)) {
      setActive(id);
      requestAnimationFrame(() => goTo(id, false));
    } else setActive(items[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = items.find((s) => seen.get(s.id));
        if (first) setActive(first.id);
      },
      { root: scroller.current, rootMargin: "-24px 0px -60% 0px" },
    );
    for (const s of items) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scroller]);
  return active;
}

export function OnThisPage({ items, active, className, row = false }: { items: readonly OnThisPageItem[]; active: string; className: string; row?: boolean }) {
  return (
    <nav className={className} aria-label="On this page" data-on-this-page={row ? "row" : "side"}>
      {!row && <p className="mb-2 text-xs font-medium text-muted-foreground">On this page</p>}
      {items.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          onClick={(e) => {
            e.preventDefault();
            goTo(s.id);
          }}
          aria-current={active === s.id ? "location" : undefined}
          className={cn(
            "block rounded-md px-2 py-1 whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
            !row && "truncate",
            active === s.id && "bg-muted font-medium text-foreground",
          )}
          data-section-link={s.id}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}
