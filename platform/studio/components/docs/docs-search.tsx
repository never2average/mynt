"use client";

// The docs' search box: pages, their sections and every tool, searched in the browser. The index loads from
// /docs/search-index the first time the box is used; "/" focuses it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";

import { goTo } from "@/components/docs/on-this-page";
import { Input } from "@/components/ui/input";
import { searchDocs, type DocsSearchItem } from "@/lib/docs-search";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<DocsSearchItem["kind"], string> = { page: "Page", section: "Section", tool: "Tool" };

export function DocsSearch({ className, onNavigate, initialIndex }: { className?: string; onNavigate?: () => void; initialIndex?: DocsSearchItem[] }) {
  const [index, setIndex] = useState<DocsSearchItem[] | null>(initialIndex ?? null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const loading = useRef(false);
  const router = useRouter();

  const load = useCallback(() => {
    if (index || loading.current) return;
    loading.current = true;
    fetch("/docs/search-index")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items?: DocsSearchItem[] } | null) => setIndex(d?.items ?? []))
      .catch(() => setIndex([]))
      .finally(() => {
        loading.current = false;
      });
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "/" && !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = index ? searchDocs(index, query) : [];
  const go = (item: DocsSearchItem | undefined) => {
    if (!item) return;
    setOpen(false);
    setQuery("");
    onNavigate?.();
    const url = new URL(item.href, window.location.href);
    if (url.pathname === window.location.pathname && url.hash) goTo(decodeURIComponent(url.hash.slice(1)));
    else router.push(item.href);
  };

  return (
    <div className={cn("relative min-w-0", className)} data-docs-search>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        ref={input}
        type="search"
        value={query}
        placeholder="Search docs and tools"
        aria-label="Search docs and tools"
        className="h-8 pl-8"
        onFocus={() => {
          load();
          setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQuery(e.target.value);
          setAt(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(results[at]);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
        data-docs-search-input
      />
      {open && query.trim() && (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 max-h-96 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md" role="listbox" aria-label="Results" data-docs-search-results>
          {!index && <p className="px-2 py-1.5 text-sm text-muted-foreground">Searching…</p>}
          {index && results.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No results</p>}
          {results.map((r, i) => (
            <a
              key={`${r.kind}:${r.href}`}
              href={r.href}
              role="option"
              aria-selected={i === at}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                go(r);
              }}
              onMouseEnter={() => setAt(i)}
              className={cn("flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm", i === at && "bg-muted")}
              data-docs-result={r.href}
            >
              <span className="w-14 shrink-0 text-xs text-muted-foreground">{KIND_LABEL[r.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate", r.kind === "tool" && "font-mono text-xs")}>{r.title}</span>
                {r.subtitle && <span className="block truncate text-xs text-muted-foreground">{r.subtitle}</span>}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
