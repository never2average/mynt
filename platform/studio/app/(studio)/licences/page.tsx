"use client";

// Licences: the partner licences behind the selected workspace's products (components/licences-view.tsx).
import { LicencesView } from "@/components/licences-view";
import { NotReady } from "@/components/not-available";
import type { Licence } from "@/lib/compliance";
import { useComplianceData } from "@/lib/use-compliance";

const pick = (body: Record<string, unknown>) => body.licences as Licence[] | undefined;

export default function LicencesPage() {
  const { state } = useComplianceData("/api/licences", pick);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 w-full flex-1 flex-col p-4 lg:p-6">
        {state.kind === "ready" ? <LicencesView licences={state.data} /> : <NotReady state={state} what="Licences" />}
      </div>
    </div>
  );
}
