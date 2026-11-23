"use client";

// Marketplace (/marketplace): service providers' standard services, each under the provider's standard terms, to
// subscribe to by accepting them (components/marketplace-view.tsx). ?app=<id> (an app's Agreements tab's Browse
// vendors) opens it for that app: filtered to its products' regions, with the app chosen in the Subscribe sheet.
// ?region=, ?category=, ?service= and ?offering= (a service's details) come from the address too.
import { useCallback, useMemo, useState } from "react";

import { MarketplaceView } from "@/components/marketplace-view";
import { NotReady } from "@/components/not-available";
import { filtersFromSearch, type ForApp, type MarketplaceApp, type Offering } from "@/lib/marketplace";
import { useComplianceData } from "@/lib/use-compliance";

type Loaded = { offerings: Offering[]; apps: MarketplaceApp[]; forApp: ForApp | null; canSubscribe: boolean };

export default function MarketplacePage() {
  const [from] = useState(() => filtersFromSearch(typeof window === "undefined" ? "" : window.location.search));
  const path = useMemo(() => (from.appId ? `/api/marketplace?app=${encodeURIComponent(from.appId)}` : "/api/marketplace"), [from.appId]);
  const pick = useCallback(
    (body: Record<string, unknown>) =>
      Array.isArray(body.offerings)
        ? ({ offerings: body.offerings as Offering[], apps: (body.apps as MarketplaceApp[]) ?? [], forApp: (body.forApp as ForApp | null) ?? null, canSubscribe: body.canSubscribe === true } as Loaded)
        : undefined,
    [],
  );
  const { state, reload } = useComplianceData(path, pick);
  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        {state.kind === "ready" ? (
          <MarketplaceView
            offerings={state.data.offerings}
            apps={state.data.apps}
            forApp={state.data.forApp}
            canSubscribe={state.data.canSubscribe}
            // Browse vendors: the app's products' regions, unless the address names its own.
            initial={{ ...from.filters, region: from.filters.region.length ? from.filters.region : (state.data.forApp?.regions ?? []) }}
            initialOfferingId={from.offeringId}
            onSubscribed={reload}
          />
        ) : (
          <NotReady state={state} what="The Marketplace" />
        )}
      </div>
    </div>
  );
}
