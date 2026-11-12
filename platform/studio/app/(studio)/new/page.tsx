"use client";

// New app: what to build, and the products it builds on. Submitting creates the app and its
// first build, and opens its workspace (lib/new-app.ts).
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowUp, Check, Loader2, Search } from "lucide-react";

import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { submitNewApp } from "@/lib/new-app";
import { cn } from "@/lib/utils";

type Product = { id: string; name: string; productLine: string; by: string; accessMode: string };

export default function NewAppPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const known = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const failed = await submitNewApp({ prompt, product_ids: picked }, { fetch, navigate: (path) => router.push(path) });
    if (failed) {
      setError(failed);
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SiteHeader title="New app" />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 lg:p-6">
        <h2 className="text-2xl font-semibold tracking-tight">What do you want to build?</h2>
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A savings app that rounds up card purchases into a high-yield account…"
            rows={5}
            maxLength={4000}
            aria-label="What do you want to build?"
            className="w-full resize-y rounded-xl border border-input bg-background px-4 py-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"
          />

          <Card>
            <CardHeader>
              <CardTitle>Products it builds on</CardTitle>
              <CardDescription>
                {picked.length ? `${picked.length} picked: ${picked.map((id) => known.get(id)?.name ?? id).join(", ")}` : "Pick at least one."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products" className="pl-9" aria-label="Search products" />
              </div>
              <ul className="flex max-h-80 flex-col divide-y overflow-y-auto rounded-lg border">
                {products === null ? (
                  <li className="p-3 text-sm text-muted-foreground">Loading products…</li>
                ) : products.length === 0 ? (
                  <li className="p-3 text-sm text-muted-foreground">No products match.</li>
                ) : (
                  products.map((p) => {
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
                          {p.productLine && <Badge variant="outline">{p.productLine.replace(/_/g, " ")}</Badge>}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            </CardContent>
          </Card>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || prompt.trim().length < 10 || picked.length === 0}>
              {busy ? <Loader2 className="animate-spin" /> : <ArrowUp />}
              Build it
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
