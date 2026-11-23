"use client";

// Licences: two tabs in the page header, each for the roles it serves (lib/licences-tabs.ts).
// - Licences (developers): the selected workspace's partner licences as one table, or the coverage
//   map in its place (components/licences-page-view.tsx). The view and map are kept in the address.
// - Agreements (licence providers): what apps' workspaces proposed to or made with their firm, with
//   Review agreement, Accept, Decline, Sign and End agreement on each row
//   (components/lp-agreements-view.tsx).
import { useState } from "react";

import type { MapRegion } from "@/components/coverage-view";
import { HeaderTabs } from "@/components/header-tabs";
import { LicencesPageView } from "@/components/licences-page-view";
import { LpAgreementsView, useLpAgreements } from "@/components/lp-agreements-view";
import { Tab, TabList } from "@/components/ui/tabs";
import type { Coverage, Licence } from "@/lib/compliance";
import { LICENCES_TAB_LABELS, licencesTabsFor, shownLicencesTab, type LicencesTab, type LicencesView } from "@/lib/licences-tabs";
import { useComplianceData } from "@/lib/use-compliance";
import { useStudioAccess } from "@/lib/use-liquidity-access";

const pickCoverage = (body: Record<string, unknown>) => body.coverage as Coverage | undefined;
const pickLicences = (body: Record<string, unknown>) => body.licences as Licence[] | undefined;

function LicencesTabPanel({ initialView, initialRegion }: { initialView: LicencesView; initialRegion: MapRegion }) {
  const [view, setView] = useState<LicencesView>(initialView);
  const [region, setRegion] = useState<MapRegion>(initialRegion);
  const { state: coverage } = useComplianceData("/api/coverage", pickCoverage);
  const { state: licences } = useComplianceData("/api/licences", pickLicences);
  const remember = (v: LicencesView, r: MapRegion) => window.history.replaceState(null, "", v === "map" ? `/licences?view=map&region=${r}` : "/licences");
  return (
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
  );
}

function AgreementsTabPanel() {
  const { state, reload } = useLpAgreements(true);
  if (state.kind === "loading") return <p className="text-sm text-muted-foreground">Loading agreements…</p>;
  if (state.kind === "error")
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    );
  return <LpAgreementsView rows={state.rows} onChanged={reload} />;
}

export function LicencesTabs({ tabs, tab, onTab }: { tabs: LicencesTab[]; tab: LicencesTab; onTab: (t: LicencesTab) => void }) {
  if (tabs.length < 2) return null;
  return (
    <TabList aria-label="Licences">
      {tabs.map((t) => (
        <Tab key={t} selected={tab === t} data-tab={t} onClick={() => onTab(t)}>
          {LICENCES_TAB_LABELS[t]}
        </Tab>
      ))}
    </TabList>
  );
}

export function LicencesPage({ initialTab = "licences", initialView, initialRegion }: { initialTab?: LicencesTab; initialView: LicencesView; initialRegion: MapRegion }) {
  const access = useStudioAccess();
  const [asked, setAsked] = useState<LicencesTab>(initialTab);
  const tabs = access ? licencesTabsFor(access) : [];
  const tab = shownLicencesTab(asked, tabs);
  const onTab = (t: LicencesTab) => {
    setAsked(t);
    window.history.replaceState(null, "", t === "agreements" ? "/licences?tab=agreements" : "/licences");
  };
  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      {tab && (
        <HeaderTabs>
          <LicencesTabs tabs={tabs} tab={tab} onTab={onTab} />
        </HeaderTabs>
      )}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6" data-tab-panel={tab ?? "loading"}>
        {/* Until the roles are read, nothing is fetched on a guess. */}
        {tab === null ? null : tab === "agreements" ? <AgreementsTabPanel /> : <LicencesTabPanel initialView={initialView} initialRegion={initialRegion} />}
      </div>
    </div>
  );
}
