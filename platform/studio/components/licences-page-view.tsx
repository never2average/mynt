"use client"

// The Licences page (/licences): only the licences table (components/licences-view.tsx), whose
// toolbar's view toggle swaps it for the coverage map in the same place. No summary card and no
// tabs. Server-renderable for the tests.
import type { MapRegion } from "@/components/coverage-view"
import { LicencesView } from "@/components/licences-view"
import { NotReady } from "@/components/not-available"
import type { Coverage, Licence } from "@/lib/compliance"
import type { LicencesView as View } from "@/lib/licences-tabs"
import type { Loaded } from "@/lib/use-compliance"

export function LicencesPageView({
  view,
  onView,
  region = "us",
  onRegion = () => undefined,
  coverage,
  licences,
  now,
}: {
  view: View
  onView: (v: View) => void
  region?: MapRegion
  onRegion?: (r: MapRegion) => void
  coverage: Loaded<Coverage>
  licences: Loaded<Licence[]>
  now?: number
}) {
  if (licences.kind !== "ready") return <NotReady state={licences} what="Licences" />
  return <LicencesView licences={licences.data} coverage={coverage} view={view} onView={onView} region={region} onRegion={onRegion} now={now} />
}
