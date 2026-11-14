"use client";

// Licences: the selected workspace's partner licences as one table, or the coverage map in its
// place (components/licences-page-view.tsx). The view and map are kept in the address.
import { useState } from "react";

import type { MapRegion } from "@/components/coverage-view";
import { LicencesPageView } from "@/components/licences-page-view";
import type { Coverage, Licence } from "@/lib/compliance";
import type { LicencesView } from "@/lib/licences-tabs";
import { useComplianceData } from "@/lib/use-compliance";

const pickCoverage = (body: Record<string, unknown>) => body.coverage as Coverage | undefined;
const pickLicences = (body: Record<string, unknown>) => body.licences as Licence[] | undefined;

export function LicencesPage({ initialView, initialRegion }: { initialView: LicencesView; initialRegion: MapRegion }) {
  const [view, setView] = useState<LicencesView>(initialView);
  const [region, setRegion] = useState<MapRegion>(initialRegion);
  const { state: coverage } = useComplianceData("/api/coverage", pickCoverage);
  const { state: licences } = useComplianceData("/api/licences", pickLicences);
  const remember = (v: LicencesView, r: MapRegion) => window.history.replaceState(null, "", v === "map" ? `/licences?view=map&region=${r}` : "/licences");
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col p-4 lg:p-6">
        <LicencesPageView
          view={view}
          onView={(v) => {
            setView(v);
            remember(v, region);
          }}
          region={region}
          onRegion={(r) => {
            setRegion(r);
            remember(view, r);
          }}
          coverage={coverage}
          licences={licences}
        />
      </div>
    </div>
  );
}
