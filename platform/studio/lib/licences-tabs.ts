// The Licences page's views (/licences?view=table|map&region=us|world), shared by its server
// page and its view. The old Coverage tab (?tab=coverage) and /coverage open the map (US).
export const LICENCES_VIEWS = ["table", "map"] as const;
export type LicencesView = (typeof LICENCES_VIEWS)[number];

export function licencesViewOf(params: { view?: unknown; tab?: unknown }): LicencesView {
  if (LICENCES_VIEWS.includes(params.view as LicencesView)) return params.view as LicencesView;
  return params.tab === "coverage" ? "map" : "table";
}

export const regionOf = (v: unknown): "us" | "world" => (v === "world" ? "world" : "us");

// The page's tabs (/licences?tab=agreements): Licences (the workspace's partner licences, for developers) and
// Agreements (licence providers: what apps' workspaces proposed to or made with their firm). Each person sees the
// tabs their roles open; one without the developer role sees Agreements only.
export const LICENCES_TABS = ["licences", "agreements"] as const;
export type LicencesTab = (typeof LICENCES_TABS)[number];
export const LICENCES_TAB_LABELS: Record<LicencesTab, string> = { licences: "Licences", agreements: "Agreements" };

export const licencesTabOf = (tab: unknown): LicencesTab => (tab === "agreements" ? "agreements" : "licences");

export function licencesTabsFor(access: { developer: boolean; licenceProvider?: boolean }): LicencesTab[] {
  return [...(access.developer ? (["licences"] as const) : []), ...(access.licenceProvider ? (["agreements"] as const) : [])];
}

/** The tab shown: the one asked for when it's open to them, else the first that is. */
export function shownLicencesTab(asked: LicencesTab, tabs: LicencesTab[]): LicencesTab | null {
  return tabs.includes(asked) ? asked : (tabs[0] ?? null);
}
