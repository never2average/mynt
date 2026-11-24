import { redirect } from "next/navigation";
import { licencesRedirectOf, licencesTabOf } from "@/lib/licences-tabs";
import { LicencesPage } from "./licences-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Licences" };

// Licences (/licences?tab=business-agreements|msa|sla|audit-obligations): four tabs in the page body
// (lib/licences-tabs.ts). Old addresses come back here: the licence table and coverage map views (?view=, ?region=,
// ?tab=coverage, ?tab=licences) are /licences, and ?tab=agreements is Business agreements.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const to = licencesRedirectOf({ tab: one(p.tab), view: one(p.view), region: one(p.region) });
  if (to) redirect(to);
  return <LicencesPage initialTab={licencesTabOf(one(p.tab))} />;
}
