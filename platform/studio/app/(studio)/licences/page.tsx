import { licencesViewOf, regionOf } from "@/lib/licences-tabs";
import { LicencesPage } from "./licences-page";

// Licences (/licences?view=table|map&region=us|world): the partner licences table, or the
// coverage map in its place. ?tab=coverage (the old Coverage tab) opens the map.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const p = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <LicencesPage initialView={licencesViewOf({ view: one(p.view), tab: one(p.tab) })} initialRegion={regionOf(one(p.region))} />;
}
