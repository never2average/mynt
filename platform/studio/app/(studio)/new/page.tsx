"use client";

// New app: the chat workspace Earn uses, with Templates and Products on the right
// (components/new-app-workspace.tsx). Sending the message creates the app on the picked products and
// its first build, and opens its workspace (lib/new-app.ts).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { NewAppWorkspace, type NewAppProduct } from "@/components/new-app-workspace";
import { kindsFromRoute, submitNewApp, type AppKind } from "@/lib/new-app";

export default function NewAppPage() {
  const router = useRouter();
  const [products, setProducts] = useState<NewAppProduct[] | null>(null);
  const [kinds, setKinds] = useState<AppKind[] | null>(null);

  // The products the user may build on (and their own drafts), and Mynt's templates (none on a Mynt without them).
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/products", { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { products?: NewAppProduct[] } | null;
      if (live) setProducts(data?.products ?? []);
    })();
    void (async () => {
      const res = await fetch("/api/app-kinds", { cache: "no-store" }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (live) setKinds(kindsFromRoute(data));
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-new-app-page>
      <NewAppWorkspace
        products={products}
        kinds={kinds}
        onBuild={(request) => submitNewApp(request, { fetch, navigate: (path) => router.push(path) })}
        onProductsChange={(change) => setProducts((list) => change(list ?? []))}
      />
    </div>
  );
}
