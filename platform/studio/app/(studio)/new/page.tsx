"use client";

// New app: the chat workspace Earn uses, with Templates and Products on the right
// (components/new-app-workspace.tsx). Sending the message creates the app on the picked products and
// its first build, and opens its workspace (lib/new-app.ts). Under the welcome, Recent: the user's apps
// and financial products (lib/threads.ts); ?thread=<id> reopens a product chat; ?product=<id> goes to that
// product's own workspace (/products/<id>), as does a product created here.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { NewAppWorkspace, type NewAppProduct } from "@/components/new-app-workspace";
import { useWorkspace } from "@/components/workspace-context";
import { kindsFromRoute, submitNewApp, type AppKind } from "@/lib/new-app";
import { productIdeasFromRoute, type ProductIdea } from "@/lib/product-ideas";
import type { ProjectItem } from "@/lib/project-types";
import { buildTypeFromSearch, rememberBuildType, rememberedBuildType, submitNewService, type BuildType, type ServiceTypeChoice, type ServiceTypeRequest } from "@/lib/services";
import { myProductsFrom, OPEN_THREAD, openFromSearch, productHref, type AppThreadSource, type MyProduct, type OpenThreadDetail } from "@/lib/threads";
import { withWorkspace } from "@/lib/workspaces";

export default function NewAppPage() {
  const router = useRouter();
  const { selected } = useWorkspace();
  const [products, setProducts] = useState<NewAppProduct[] | null>(null);
  const [kinds, setKinds] = useState<AppKind[] | null>(null);
  const [productIdeas, setProductIdeas] = useState<ProductIdea[] | null>(null);
  const [mine, setMine] = useState<MyProduct[] | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [apps, setApps] = useState<AppThreadSource[] | null>(null);
  const [openRequest, setOpenRequest] = useState<(OpenThreadDetail & { n: number }) | null>(null);
  // What's being built: an app, a financial product or a service. From the address (?type=), else the last one picked
  // in this browser, else an app; a link to a product chat (?thread=) is a financial product's.
  const [type, setType] = useState<BuildType>("app");
  useEffect(() => {
    const search = window.location.search;
    const linked = openFromSearch(search);
    setType(buildTypeFromSearch(search) ?? (linked?.thread ? "product" : null) ?? rememberedBuildType() ?? "app");
  }, []);
  const onType = useCallback((next: BuildType) => {
    setType(next);
    rememberBuildType(next);
    // The choice stays in the address, so a reload or a shared link opens on it.
    const url = new URL(window.location.href);
    url.searchParams.set("type", next);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
  }, []);
  // Service: Mynt's service types, whether this account may create one (Mynt's vendor role), and its requests. Read
  // when Service is first picked, and again after a request.
  const [serviceData, setServiceData] = useState<{ serviceTypes: ServiceTypeChoice[]; requests: ServiceTypeRequest[] | null; vendor: boolean } | null>(null);
  const loadServiceData = useCallback(async () => {
    const res = await fetch("/api/services/types", { cache: "no-store" }).catch(() => null);
    const data = res?.ok ? ((await res.json().catch(() => null)) as { serviceTypes?: ServiceTypeChoice[]; requests?: ServiceTypeRequest[] | null; vendor?: boolean } | null) : null;
    setServiceData({ serviceTypes: Array.isArray(data?.serviceTypes) ? data.serviceTypes : [], requests: Array.isArray(data?.requests) ? data.requests : null, vendor: data?.vendor === true });
  }, []);
  useEffect(() => {
    if (type === "service" && !serviceData) void loadServiceData();
  }, [type, serviceData, loadServiceData]);

  // The products the user may build on (and their own drafts), and Mynt's templates (none on a Mynt without them).
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch("/api/products", { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { products?: NewAppProduct[]; mine?: unknown; owner?: unknown } | null;
      if (!live) return;
      setProducts(data?.products ?? []);
      setMine(myProductsFrom(data?.mine));
      setOwner(typeof data?.owner === "string" && data.owner ? data.owner : null);
    })();
    void (async () => {
      const res = await fetch("/api/app-kinds", { cache: "no-store" }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (!live) return;
      setKinds(kindsFromRoute(data));
      setProductIdeas(productIdeasFromRoute(data));
    })();
    return () => {
      live = false;
    };
  }, []);

  // The user's apps, for Recent: read again when an app is made or changed.
  useEffect(() => {
    let live = true;
    const load = async () => {
      const res = await fetch(withWorkspace("/api/projects", selected), { cache: "no-store" }).catch(() => null);
      const data = res?.ok ? ((await res.json().catch(() => null)) as { projects?: ProjectItem[] } | null) : null;
      if (live) setApps((data?.projects ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage, lastActivityAt: p.lastActivityAt ?? null })));
    };
    void load();
    const again = () => void load();
    window.addEventListener("adorable:projects-updated", again);
    return () => {
      live = false;
      window.removeEventListener("adorable:projects-updated", again);
    };
  }, [selected]);

  // What to open: from the address once, then from the sidebar while this page is open. A product has its
  // own workspace now: ?product=<id> (older links) goes there.
  useEffect(() => {
    const first = openFromSearch(window.location.search);
    if (first?.product) {
      router.replace(productHref(first.product));
      return;
    }
    if (first) setOpenRequest({ ...first, n: 1 });
    const open = (e: Event) => {
      const detail = (e as CustomEvent<OpenThreadDetail>).detail;
      if (detail?.product) router.push(productHref(detail.product));
      else if (detail) setOpenRequest((r) => ({ ...detail, n: (r?.n ?? 1) + 1 }));
    };
    window.addEventListener(OPEN_THREAD, open);
    return () => window.removeEventListener(OPEN_THREAD, open);
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-new-app-page>
      <NewAppWorkspace
        products={products}
        kinds={kinds}
        productIdeas={productIdeas}
        onBuild={(request) => submitNewApp(request, { fetch, navigate: (path) => router.push(path) })}
        onProductsChange={(change) => setProducts((list) => change(list ?? []))}
        apps={apps}
        myProducts={mine}
        historyOwner={owner}
        openRequest={openRequest}
        onOpenApp={(href) => router.push(href)}
        onOpenProduct={(id) => router.push(productHref(id))}
        initialType={type}
        onType={onType}
        serviceTypes={serviceData?.serviceTypes ?? null}
        typeRequests={serviceData ? serviceData.requests : null}
        vendor={serviceData ? serviceData.vendor : null}
        onBuildService={(request) => submitNewService(request, { fetch, navigate: (path) => router.push(path) })}
        onTypeRequested={() => void loadServiceData()}
      />
    </div>
  );
}
