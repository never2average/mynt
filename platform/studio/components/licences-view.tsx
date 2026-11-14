"use client"

// The Licences page: the partner licences behind the workspace's products, as one table. One
// toolbar row beside the full-width search: filters (partner, regulator, state, status, expiring
// within N days), Import, Export (the filtered rows, as CSV), Invite partner and the view toggle,
// which swaps the table for the coverage map in the same place, keeping the filters (US states,
// or the world; components/coverage-view.tsx). Expired licences and those expiring within 60
// days are marked with an icon and words, not colour alone. Import and Invite partner need Mynt
// tools that don't exist yet, so they say so instead of doing anything. Server-renderable.
import { useMemo, useState } from "react"
import { AlertTriangle, Download, Map as MapIcon, Search, Table2, Upload, UserPlus, XCircle } from "lucide-react"

import { CoverageMap, type MapRegion } from "@/components/coverage-view"
import { NotReady } from "@/components/not-available"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  distinct,
  EXPIRY_WINDOWS,
  expiryOf,
  filterLicences,
  licenceFiltersOn,
  NO_LICENCE_FILTERS,
  toCsv,
  type Coverage,
  type Licence,
  type LicenceFilters,
} from "@/lib/compliance"
import type { LicencesView as View } from "@/lib/licences-tabs"
import type { Loaded } from "@/lib/use-compliance"

export const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"

export const NEXT_UPDATE = "Coming with Mynt's next update"

const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "—")

export function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const a = Object.assign(document.createElement("a"), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
}

export function licencesCsv(rows: Licence[]): string {
  return toCsv(
    ["Partner", "Type", "Regulator", "Number", "States", "Status", "Expires"],
    rows.map((l) => [l.partner, l.type, l.regulator, l.number, l.states.join(" "), l.status, dateOf(l.expiresAt)]),
  )
}

export function ExpiryBadge({ licence, now }: { licence: Licence; now: number }) {
  const e = expiryOf(licence, now)
  if (e === "expired")
    return (
      <Badge variant="destructive" data-expiry="expired">
        <XCircle />
        Expired
      </Badge>
    )
  if (e === "expiring")
    return (
      <Badge variant="outline" className="border-amber-500/60 text-amber-300" data-expiry="expiring">
        <AlertTriangle />
        Expires soon
      </Badge>
    )
  return null
}

/** Invite partner: the form a request to Mynt's admins will be made from. Mynt never emails the partner from here. */
export function InvitePartner() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} data-invite-partner>
        <UserPlus />
        Invite partner
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite partner</DialogTitle>
            <DialogDescription>
              Asks Mynt&apos;s admins to bring a licensed partner onto Mynt. Mynt&apos;s admins reach out to them; nothing is sent to the partner from here.
            </DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
            <label className="flex flex-col gap-1 text-sm">
              Partner firm name
              <Input name="partner" maxLength={120} required />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Contact email
              <Input name="email" type="email" maxLength={320} required />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              What they license
              <Input name="licenses" maxLength={200} placeholder="e.g. money transmission in CA and NY" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Message to Mynt&apos;s admins
              <textarea name="message" maxLength={2000} rows={3} className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20" />
            </label>
            <p className="text-sm text-muted-foreground" data-not-yet>
              {NEXT_UPDATE}: sending this request needs a Mynt tool that isn&apos;t there yet.
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled title={NEXT_UPDATE}>
                Send request
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ViewToggle({ view, onView }: { view: View; onView: (v: View) => void }) {
  const next: View = view === "table" ? "map" : "table"
  const label = next === "map" ? "Map view" : "Table view"
  const Icon = next === "map" ? MapIcon : Table2
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" aria-label={label} onClick={() => onView(next)} data-view-toggle={next}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Select({ label, value, onChange, all, options }: { label: string; value: string; onChange: (v: string) => void; all: string; options: { value: string; label: string }[] }) {
  return (
    <select className={selectClass} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

const opts = (values: string[]) => values.map((v) => ({ value: v, label: v }))

export function LicencesView({
  licences,
  coverage = { kind: "loading" },
  view = "table",
  onView = () => undefined,
  region = "us",
  onRegion = () => undefined,
  now = Date.now(),
  initial = NO_LICENCE_FILTERS,
}: {
  licences: Licence[]
  coverage?: Loaded<Coverage>
  view?: View
  onView?: (v: View) => void
  region?: MapRegion
  onRegion?: (r: MapRegion) => void
  now?: number
  initial?: LicenceFilters
}) {
  const [f, setF] = useState<LicenceFilters>(initial)
  const shown = useMemo(() => filterLicences(licences, f, now), [licences, f, now])
  const highlight = useMemo(() => (licenceFiltersOn(f) ? new Set(shown.flatMap((l) => l.states)) : null), [f, shown])
  const set = (k: keyof LicenceFilters) => (v: string) => setF({ ...f, [k]: v })
  const statuses = distinct(licences.map((l) => l.status)).filter((s) => s !== "expired")

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-licences-page>
      <div className="flex flex-wrap items-center gap-2" data-toolbar>
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={f.query} onChange={(e) => set("query")(e.target.value)} placeholder="Search partner, type, regulator, number or state" className="pl-8" aria-label="Search licences" />
        </div>
        <Select label="Partner" value={f.partner} onChange={set("partner")} all="All partners" options={opts(distinct(licences.map((l) => l.partner)))} />
        <Select label="Regulator" value={f.regulator} onChange={set("regulator")} all="All regulators" options={opts(distinct(licences.map((l) => l.regulator)))} />
        <Select label="State" value={f.state} onChange={set("state")} all="All states" options={opts(distinct(licences.flatMap((l) => l.states)))} />
        <Select
          label="Status"
          value={f.status}
          onChange={set("status")}
          all="All statuses"
          options={[{ value: "expired", label: "Expired" }, ...statuses.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))]}
        />
        <Select label="Expiring within" value={f.within} onChange={set("within")} all="Any expiry" options={EXPIRY_WINDOWS.map((d) => ({ value: String(d), label: `Expiring within ${d} days` }))} />
        <Button variant="outline" disabled title={NEXT_UPDATE} data-import>
          <Upload />
          Import
        </Button>
        <Button variant="outline" onClick={() => downloadCsv("licences.csv", licencesCsv(shown))} disabled={!shown.length} data-export>
          <Download />
          Export
        </Button>
        <InvitePartner />
        <ViewToggle view={view} onView={onView} />
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="tabular-nums">
          {shown.length} of {licences.length}
        </span>{" "}
        licences · Import (a CSV of licences for Mynt&apos;s admins to verify): {NEXT_UPDATE.toLowerCase()}
      </p>
      {view === "map" ? (
        coverage.kind === "ready" ? (
          <CoverageMap coverage={coverage.data} region={region} onRegion={onRegion} highlight={highlight} />
        ) : (
          <NotReady state={coverage} what="Coverage" />
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border" data-table-view>
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead>Partner</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Regulator</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>States</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.length ? (
                shown.map((l, i) => {
                  const e = expiryOf(l, now)
                  return (
                    <TableRow
                      key={`${l.number ?? ""}-${i}`}
                      data-expiry={e ?? undefined}
                      className={e === "expired" ? "bg-destructive/10" : e === "expiring" ? "bg-amber-500/10" : undefined}
                    >
                      <TableCell className="font-medium">{l.partner ?? "—"}</TableCell>
                      <TableCell>{l.type ?? "—"}</TableCell>
                      <TableCell>{l.regulator ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{l.number ?? "—"}</TableCell>
                      <TableCell className="max-w-48 truncate" title={l.states.join(", ")}>
                        {l.states.join(", ") || "—"}
                      </TableCell>
                      <TableCell className="capitalize">{l.status ?? "—"}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-2 tabular-nums">
                          {dateOf(l.expiresAt)}
                          <ExpiryBadge licence={l} now={now} />
                        </span>
                      </TableCell>
                    </TableRow>
                  )
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                    {licences.length ? "No licences match these filters." : "No licences yet. They appear here once a partner sponsors one of your products."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
