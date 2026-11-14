import { licencesTabOf } from "@/lib/licences-tabs";
import { LicencesPage } from "./licences-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Licences" };

// Licences (/licences?tab=coverage|licences): the coverage map and the partner licences.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  return <LicencesPage initialTab={licencesTabOf(Array.isArray(tab) ? tab[0] : tab)} />;
}
