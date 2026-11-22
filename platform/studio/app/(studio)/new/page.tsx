"use client";

// New app: what to build, and the products it builds on. Submitting creates the app and its
// first build, and opens its workspace (lib/new-app.ts).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, Section } from "@/components/dashboard-panels";
import { FilterSelect } from "@/components/filter-controls";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CapField, useCapChoice } from "@/components/build-controls";
import { submitNewApp } from "@/lib/new-app";
import { cn } from "@/lib/utils";

type Product = { id: string; name: string; productLine: string; by: string; accessMode: string };

const lineLabel = (line: string) => line.replace(/_/g, " ");

export default function NewAppPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [line, setLine] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The first build's cap: up to the usual cap, or what's left of this month's budget.
  const capChoice = useCapChoice(null);
  const [cap, setCap] = useState<number | null>(null);
  const capUsd = capChoice && !capChoice.blocked ? (cap ?? capChoice.startUsd) : null;

  // The products the user may build on, searched as they type.
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const res = await fetch(`/api/products${query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`, { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { products?: Product[] } | null;
      if (live) setProducts(data?.products ?? []);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);

  // The product lines among the products found, for the Product line filter (picks survive filtering).
  const lines = useMemo(
    () => [...new Set((products ?? []).map((p) => p.productLine).filter(Boolean))].sort().map((l) => ({ value: l, label: lineLabel(l) })),
    [products],
  );
  const shown = useMemo(() => (products ?? []).filter((p) => !line || p.productLine === line), [products, line]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  // One request at a time: the button is disabled while it runs, and a second submit (a double
  // click before the re-render) is ignored.
  const inFlight = useRef(false);
  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const failed = await submitNewApp({ prompt, product_ids: picked, ...(capUsd !== null ? { cap_usd: capUsd } : {}) }, { fetch, navigate: (path) => router.push(path) });
    if (failed) {
      setError(failed);
      setBusy(false);
      inFlight.current = false;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <form
        className="flex flex-col gap-4 p-4 lg:gap-5 lg:p-6"
        data-new-app-page
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What do you want to build? A savings app that rounds up card purchases into a high-yield account…"
          rows={5}
          maxLength={4000}
          aria-label="What do you want to build?"
          className="w-full resize-y rounded-lg border border-input bg-background px-4 py-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
        />

        <Panel id="products">
          <Section
            id="products"
            title="Products it builds on"
            action={
              <span className="text-muted-foreground tabular-nums" data-picked-count>
                {picked.length ? `${picked.length} picked` : "Pick at least one"}
              </span>
            }
          >
            <div className="flex flex-wrap items-center gap-2" data-toolbar>
              <div className="relative min-w-64 flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products" className="pl-8" aria-label="Search products" />
              </div>
              <FilterSelect label="Product line" value={line} options={lines} onChange={setLine} />
            </div>
            <ul className="flex max-h-96 flex-col divide-y overflow-y-auto rounded-lg border" data-product-list>
              {products === null ? (
                [0, 1, 2].map((i) => (
                  <li key={i} className="flex items-center gap-3 px-3 py-2.5" data-loading>
                    <Skeleton className="size-4" />
                    <Skeleton className="h-4 flex-1" />
                  </li>
                ))
              ) : shown.length === 0 ? (
                <li className="p-3 text-sm text-muted-foreground">No products match.</li>
              ) : (
                shown.map((p) => {
                  const on = picked.includes(p.id);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => toggle(p.id)}
                        aria-pressed={on}
                        className={cn("flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/60", on && "bg-muted")}
                      >
                        <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>
                          {on && <Check className="size-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{p.name}</span>
                          {p.by && <span className="block truncate text-xs text-muted-foreground">{p.by}</span>}
                        </span>
                        {p.productLine && <Badge variant="outline">{lineLabel(p.productLine)}</Badge>}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </Section>
        </Panel>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {capChoice?.blocked && (
          <p className="text-sm text-muted-foreground" data-cap-blocked>
            {capChoice.blocked}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {capChoice && capUsd !== null && <CapField choice={capChoice} value={capUsd} onChange={setCap} />}
          <Button type="submit" disabled={busy || prompt.trim().length < 10 || picked.length === 0 || !!capChoice?.blocked}>
            {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            Build it
          </Button>
        </div>
      </form>
    </div>
  );
}
