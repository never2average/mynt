"use client";

// My services (/vendor): a service provider's onboarding checklist and its firm's services (components/vendor-area.tsx).
// ?offering=<id> opens a service's details. Its data is the firm's, never a workspace's (no workspace in the address).
import { useCallback, useEffect, useState } from "react";

import { AdminNotReady, useAdminData } from "@/components/admin-kit";
import { OfferingDetailView, VendorView, type OfferingDetailData, type VendorData } from "@/components/vendor-area";
import type { Onboarding } from "@/lib/vendor-area";

const offeringOf = (search: string) => {
  const id = new URLSearchParams(search).get("offering");
  return id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
};

export default function VendorPage() {
  const [openId, setOpenId] = useState<string | null>(() => (typeof window === "undefined" ? null : offeringOf(window.location.search)));
  const open = useCallback((id: string | null) => {
    setOpenId(id);
    window.history.replaceState(null, "", id ? `/vendor?offering=${encodeURIComponent(id)}` : "/vendor");
  }, []);
  useEffect(() => {
    const back = () => setOpenId(offeringOf(window.location.search));
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  const pick = useCallback(
    (b: Record<string, unknown>) =>
      b.onboarding && Array.isArray(b.offerings)
        ? ({ onboarding: b.onboarding as Onboarding, offerings: b.offerings, serviceTypes: (b.serviceTypes as VendorData["serviceTypes"]) ?? [], licences: (b.licences as VendorData["licences"]) ?? [], ...("requests" in b ? { requests: (b.requests as VendorData["requests"]) ?? null } : {}) } as VendorData)
        : undefined,
    [],
  );
  const pickDetail = useCallback((b: Record<string, unknown>) => (b.offering ? (b as unknown as OfferingDetailData) : undefined), []);
  const { state, reload } = useAdminData("/api/vendor", pick);
  const detail = useAdminData(openId ? `/api/vendor/offerings/${encodeURIComponent(openId)}` : null, pickDetail);
  const changed = () => {
    reload();
    detail.reload();
  };
  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        {state.kind !== "ready" ? (
          <AdminNotReady state={state} what="My services" />
        ) : openId ? (
          detail.state.kind === "ready" ? (
            <OfferingDetailView detail={detail.state.data} data={state.data} onBack={() => open(null)} onChanged={changed} />
          ) : (
            <AdminNotReady state={detail.state} what="This service" />
          )
        ) : (
          <VendorView data={state.data} onOpen={open} onChanged={reload} />
        )}
      </div>
    </div>
  );
}
