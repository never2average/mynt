"use client";

// Licences: the selected workspace's coverage map and the partner licences behind its products,
// as two tabs (components/licences-page-view.tsx).
import { useState } from "react";

import { LicencesPageView } from "@/components/licences-page-view";
import type { Coverage, Licence } from "@/lib/compliance";
import type { LicencesTab } from "@/lib/licences-tabs";
import { useComplianceData } from "@/lib/use-compliance";

const pickCoverage = (body: Record<string, unknown>) => body.coverage as Coverage | undefined;
const pickLicences = (body: Record<string, unknown>) => body.licences as Licence[] | undefined;

export function LicencesPage({ initialTab }: { initialTab: LicencesTab }) {
  const [tab, setTab] = useState<LicencesTab>(initialTab);
  const { state: coverage } = useComplianceData("/api/coverage", pickCoverage);
  const { state: licences } = useComplianceData("/api/licences", pickLicences);
  const onTab = (t: LicencesTab) => {
    setTab(t);
    window.history.replaceState(null, "", `/licences?tab=${t}`);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col p-4 lg:p-6">
        <LicencesPageView tab={tab} onTab={onTab} coverage={coverage} licences={licences} />
      </div>
    </div>
  );
}
