"use client"

// The Licences page's content: the partner licences behind the workspace's products, in one
// table with a full-width search, filters (status, regulator, state) and a labelled Export.
// Expired licences and those expiring within 60 days are marked with an icon and words, not
// colour alone. Server-renderable for the tests.
import { useMemo, useState } from "react"
import { AlertTriangle, Download, Search, XCircle } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  distinct,
  EXPIRING_DAYS,
  expiryOf,
  filterLicences,
  NO_LICENCE_FILTERS,
  toCsv,
  type Licence,
  type LicenceFilters,
} from "@/lib/compliance"

export const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"

const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "—")

export function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }))
  const a = Object.assign(document.createElement("a"), { href: url, download: name })
  a.click()
  URL.revokeObjectURL(url)
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

export function LicencesView({ licences, now = Date.now(), initial = NO_LICENCE_FILTERS }: { licences: Licence[]; now?: number; initial?: LicenceFilters }) {
  const [f, setF] = useState<LicenceFilters>(initial)
  const shown = useMemo(() => filterLicences(licences, f, now), [licences, f, now])
  const statuses = distinct(licences.map((l) => l.status))
  const regulators = distinct(licences.map((l) => l.regulator))
  const states = distinct(licences.flatMap((l) => l.states))
  const set = (k: keyof LicenceFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })

  const exportCsv = () =>
    downloadCsv(
      "licences.csv",
      toCsv(
        ["Partner", "Type", "Regulator", "Number", "States", "Status", "Expires"],
        shown.map((l) => [l.partner, l.type, l.regulator, l.number, l.states.join(" "), l.status, dateOf(l.expiresAt)]),
      ),
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={f.query} onChange={set("query")} placeholder="Search partner, type, regulator, number or state" className="pl-8" aria-label="Search licences" />
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!shown.length}>
          <Download />
          Export CSV
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className={selectClass} value={f.status} onChange={set("status")} aria-label="Status">
          <option value="">All statuses</option>
          <option value="expired">Expired</option>
          <option value="expiring">Expiring within {EXPIRING_DAYS} days</option>
          {statuses
            .filter((s) => s !== "expired")
            .map((s) => (
              <option key={s} value={s} className="capitalize">
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
        </select>
        <select className={selectClass} value={f.regulator} onChange={set("regulator")} aria-label="Regulator">
          <option value="">All regulators</option>
          {regulators.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select className={selectClass} value={f.state} onChange={set("state")} aria-label="State">
          <option value="">All states</option>
          {states.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {shown.length} of {licences.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
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
    </div>
  )
}
