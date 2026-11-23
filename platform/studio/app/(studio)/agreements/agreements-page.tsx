"use client";

// A licence provider's Agreements page (components/agreement-esign.tsx): read live from Mynt through /api/agreements,
// and read again after each upload, retirement or signature.
import { useCallback, useEffect, useState } from "react";

import { FirmAgreementsView, type FirmAgreements } from "@/components/agreement-esign";

type State = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; data: FirmAgreements };

export function AgreementsPage() {
  const [s, setS] = useState<State>({ state: "loading" });
  const load = useCallback(async () => {
    const res = await fetch("/api/agreements", { cache: "no-store" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (FirmAgreements & { message?: string }) | null;
    if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"));
    if (res?.status === 403) return setS({ state: "error", message: "Agreements are for licence providers. Ask your firm's licence provider to add you." });
    if (!res?.ok || !body) return setS({ state: "error", message: body?.message ?? "Couldn't reach Mynt. Please try again." });
    setS({ state: "ready", data: body });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        {s.state === "loading" && <p className="text-sm text-muted-foreground">Loading agreements…</p>}
        {s.state === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {s.message}
          </p>
        )}
        {s.state === "ready" && <FirmAgreementsView data={s.data} onChanged={() => void load()} />}
      </div>
    </div>
  );
}
