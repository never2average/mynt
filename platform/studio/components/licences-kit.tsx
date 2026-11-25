"use client"

// What the Licences page's four tabs share (Business agreements, MSA, SLA, Audit obligations), after the studio's
// list and detail conventions: a full-width search, then the toolbar's labelled buttons (Import, which these lists
// can't take yet and say why, Export CSV, and the tab's own call to action); a detail sheet with a metadata card on
// top, then a tab selector whose tabs are each a table. Labelled buttons only, never icon-only ones.
import { useState } from "react"
import { Search, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tab, TabList } from "@/components/ui/tabs"
import { TOOLBAR_SEARCH } from "@/components/list-layout"

/** The toolbar's search: it takes the room left. */
export function ListSearch({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <div className={TOOLBAR_SEARCH}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-8" aria-label={label} />
    </div>
  )
}

/** Import, disabled, with the reason as its title and description (these lists are kept in Mynt, not imported). */
export function ImportButton({ note }: { note: string }) {
  return (
    <Button variant="outline" disabled title={note} aria-description={note} data-import>
      <Upload />
      Import
    </Button>
  )
}

/** A detail's metadata card: label and value pairs, on top of the detail. */
export function MetaCard({ items, children }: { items: [string, React.ReactNode][]; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm" data-meta-card>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {items.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  )
}

export type DetailTable = { id: string; label: string; headers: string[]; rows: { key: string; cells: React.ReactNode[] }[]; empty: string }

/** A detail's tabs, each a table. */
export function DetailTabs({ tabs, label }: { tabs: DetailTable[]; label: string }) {
  const [shown, setShown] = useState(tabs[0]?.id ?? "")
  const tab = tabs.find((t) => t.id === shown) ?? tabs[0]
  if (!tab) return null
  return (
    <div className="flex flex-col gap-2">
      <TabList aria-label={label}>
        {tabs.map((t) => (
          <Tab key={t.id} selected={t.id === tab.id} data-detail-tab={t.id} onClick={() => setShown(t.id)}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <div className="overflow-x-auto rounded-lg border" data-detail-table={tab.id}>
        <Table>
          <TableHeader>
            <TableRow>
              {tab.headers.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {tab.rows.length ? (
              tab.rows.map((r) => (
                <TableRow key={r.key}>
                  {r.cells.map((c, i) => (
                    <TableCell key={i} className="whitespace-normal">
                      {c}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow data-empty-row>
                <TableCell colSpan={tab.headers.length} className="py-6 text-center text-muted-foreground">
                  {tab.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

/** A date or time as the lists show it: the day only. */
export const dayOf = (v: string | null | undefined) => (v ? v.slice(0, 10) : "—")

/** Whether a day (YYYY-MM-DD…) falls within a date range's from and to (either may be empty). */
export const withinRange = (at: string | null, from: string, to: string) => {
  if (!from && !to) return true
  if (!at) return false
  const d = at.slice(0, 10)
  return (!from || d >= from) && (!to || d <= to)
}
