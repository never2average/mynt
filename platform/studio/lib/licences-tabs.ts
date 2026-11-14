// The Licences page's tabs (/licences?tab=...), shared by its server page and its view.
export const LICENCES_TABS = ["coverage", "licences"] as const;
export type LicencesTab = (typeof LICENCES_TABS)[number];
export const LICENCES_TAB_LABELS: Record<LicencesTab, string> = { coverage: "Coverage", licences: "Licences" };
export const licencesTabOf = (v: unknown): LicencesTab => (LICENCES_TABS.includes(v as LicencesTab) ? (v as LicencesTab) : "coverage");
