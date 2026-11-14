// The Licences page's views (/licences?view=table|map&region=us|world), shared by its server
// page and its view. The old Coverage tab (?tab=coverage) and /coverage open the map (US).
export const LICENCES_VIEWS = ["table", "map"] as const;
export type LicencesView = (typeof LICENCES_VIEWS)[number];

export function licencesViewOf(params: { view?: unknown; tab?: unknown }): LicencesView {
  if (LICENCES_VIEWS.includes(params.view as LicencesView)) return params.view as LicencesView;
  return params.tab === "coverage" ? "map" : "table";
}

export const regionOf = (v: unknown): "us" | "world" => (v === "world" ? "world" : "us");
