// The Licences page's tabs (/licences?tab=business-agreements|msa|sla|audit-obligations), shared by its server page and
// its view. The tabs sit in the page body under the header, like every other page's (never in the header row):
// - Business agreements: apps' program (and data-sharing and vendor) agreements; a licence provider answers those
//   proposed to its firm, a developer proposes and signs its workspace's apps' ones.
// - MSA: master services agreements: the licence provider's agreement templates and who signed under each; the MSAs a
//   developer's apps signed.
// - SLA: service-level commitments attached to an agreement, with their breaches.
// - Audit obligations: the oversight audits licence providers run on apps under program agreements.
// Every tab is open to developers and licence providers alike; what each shows and lets them do depends on their side.
// The licence table and coverage map are no longer here (licence coverage is on each product's Compliance tab):
// /coverage, ?view=map and the old ?tab=coverage and ?tab=licences come back to /licences.
export const LICENCES_TABS = ["business-agreements", "msa", "sla", "audit-obligations"] as const;
export type LicencesTab = (typeof LICENCES_TABS)[number];
export const LICENCES_TAB_LABELS: Record<LicencesTab, string> = {
  "business-agreements": "Business Agreements",
  msa: "MSA",
  sla: "SLA",
  "audit-obligations": "Audit Obligations",
};
export const DEFAULT_LICENCES_TAB: LicencesTab = "business-agreements";

/** The tab a ?tab= value names: the old Agreements tab is Business agreements; anything else, the first tab. */
export function licencesTabOf(tab: unknown): LicencesTab {
  if (tab === "agreements") return "business-agreements";
  return LICENCES_TABS.includes(tab as LicencesTab) ? (tab as LicencesTab) : DEFAULT_LICENCES_TAB;
}

/** The page's address for a tab: the first tab is plain /licences. */
export const licencesHref = (tab: LicencesTab) => (tab === DEFAULT_LICENCES_TAB ? "/licences" : `/licences?tab=${tab}`);

/**
 * Where an old address of the page goes instead, or null when it's current: the map and table views (?view=,
 * ?region=, ?tab=coverage, ?tab=licences) are /licences; ?tab=agreements is Business agreements (/licences); an
 * unknown tab, the first one.
 */
export function licencesRedirectOf(params: { tab?: string; view?: string; region?: string }): string | null {
  const { tab, view, region } = params;
  if (view !== undefined || region !== undefined || tab === "coverage" || tab === "licences") return "/licences";
  if (tab === undefined || LICENCES_TABS.includes(tab as LicencesTab)) return null;
  return licencesHref(licencesTabOf(tab));
}

/** Whether someone sees the page: developers, and licence providers without the developer role. */
export const seesLicences = (access: { developer: boolean; licenceProvider?: boolean }) => access.developer || Boolean(access.licenceProvider);
