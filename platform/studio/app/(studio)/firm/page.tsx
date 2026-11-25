"use client";

// My firm (/firm): a regulated firm's onboarding checklist, its real-company check and its own lists
// (components/firm-area.tsx). ?tab=<tab> opens a tab. Its data is the firm's, never a workspace's (no workspace in the
// address).
import { useCallback, useState } from "react";

import { AdminNotReady, useAdminData } from "@/components/admin-kit";
import { FirmView, type FirmData } from "@/components/firm-area";
import { firmTabOf, type Onboarding } from "@/lib/firm-area";

export default function FirmPage() {
  const [tab] = useState(() => firmTabOf(typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("tab")));
  const pick = useCallback(
    (b: Record<string, unknown>) =>
      b.onboarding
        ? ({
            onboarding: b.onboarding as Onboarding,
            firm: (b.firm as FirmData["firm"]) ?? null,
            licences: (b.licences as FirmData["licences"]) ?? null,
            requests: (b.requests as FirmData["requests"]) ?? null,
            sponsored: (b.sponsored as FirmData["sponsored"]) ?? null,
            licenceTypes: (b.licenceTypes as FirmData["licenceTypes"]) ?? [],
          } satisfies FirmData)
        : undefined,
    [],
  );
  const { state, reload } = useAdminData("/api/firm", pick);
  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        {state.kind !== "ready" ? <AdminNotReady state={state} what="My firm" /> : <FirmView data={state.data} initialTab={tab} onChanged={reload} />}
      </div>
    </div>
  );
}
