"use client"

// The Coverage page's content: a US map (react-simple-maps, MIT, over us-atlas's states, ISC)
// colouring each state by whether the workspace's products can serve it, with a legend, a hover
// tooltip, a side panel for the state clicked (its partners, licences, products and rails) and a
// list view of the same data as a table. Server-renderable, so tests run without a browser.
//
// Colours (app/globals.css, light and dark): unlocked is the most prominent, a strong bright
// blue; available a muted blue of the same hue; unavailable neutral grey. The two blues pass the
// dataviz skill's ordinal checks on each surface, and all three pairs are told apart with normal
// and colour-blind vision. Status is never colour alone: the legend, tooltip, panel and list
// name it.
import { useMemo, useState } from "react"
import type { GeoJsonObject } from "geojson"
import { ComposableMap, Geographies, Geography } from "react-simple-maps"
import statesTopology from "us-atlas/states-10m.json"
import { List, Map as MapIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  allStates,
  countByStatus,
  COVERAGE_HELP,
  COVERAGE_LABELS,
  COVERAGE_STATUSES,
  FIPS_TO_CODE,
  type Coverage,
  type CoverageState,
  type CoverageStatus,
} from "@/lib/compliance"

export const COVERAGE_FILL: Record<CoverageStatus, string> = {
  unlocked: "var(--coverage-unlocked)",
  available: "var(--coverage-available)",
  unavailable: "var(--coverage-unavailable)",
}

const geography = statesTopology as unknown as GeoJsonObject

function Swatch({ status }: { status: CoverageStatus }) {
  return <span aria-hidden className="inline-block size-3 shrink-0 rounded-[3px]" style={{ background: COVERAGE_FILL[status] }} />
}

export function CoverageLegend({ states }: { states: CoverageState[] }) {
  const counts = countByStatus(states)
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Legend">
      {COVERAGE_STATUSES.map((s) => (
        <li key={s} className="flex items-center gap-2" title={COVERAGE_HELP[s]} data-legend={s}>
          <Swatch status={s} />
          <span>{COVERAGE_LABELS[s]}</span>
          <span className="tabular-nums text-muted-foreground">{counts[s]}</span>
        </li>
      ))}
    </ul>
  )
}

function Names({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {items.length ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {items.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  )
}

export function StatePanel({ state }: { state: CoverageState }) {
  return (
    <div className="space-y-5 px-4 pb-6">
      <p className="flex items-center gap-2 text-sm">
        <Swatch status={state.status} />
        <span className="font-medium">{COVERAGE_LABELS[state.status]}</span>
        <span className="text-muted-foreground">· {COVERAGE_HELP[state.status]}</span>
      </p>
      <Names title="Partners" items={state.partners.map((p) => p.name)} empty="No partner licensed here yet." />
      <Names title="Licences" items={state.licences} empty="None here yet." />
      <Names title="Products" items={state.products} empty="None of your products here yet." />
      <Names title="Money rails" items={state.rails} empty="None here yet." />
    </div>
  )
}

const joined = (items: string[]) => items.join(", ") || "—"

// The map's full equivalent as a table: every state's status, partners, licences, products and
// rails by name, and a button per state that opens the same side panel.
export function CoverageList({ states, onOpen }: { states: CoverageState[]; onOpen?: (code: string) => void }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>State</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Partners</TableHead>
          <TableHead>Licences</TableHead>
          <TableHead>Products</TableHead>
          <TableHead>Rails</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {states.map((s) => (
          <TableRow key={s.code} data-state={s.code}>
            <TableCell className="font-medium">
              {onOpen ? (
                <button type="button" className="rounded-sm text-left underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => onOpen(s.code)}>
                  {s.name}
                </button>
              ) : (
                s.name
              )}
            </TableCell>
            <TableCell>
              <span className="flex items-center gap-2">
                <Swatch status={s.status} />
                {COVERAGE_LABELS[s.status]}
              </span>
            </TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">{joined(s.partners.map((p) => p.name))}</TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">{joined(s.licences)}</TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">{joined(s.products)}</TableCell>
            <TableCell className="whitespace-normal text-muted-foreground">{joined(s.rails)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

export function CoverageView({ coverage, initialView = "map" }: { coverage: Coverage; initialView?: "map" | "list" }) {
  const states = useMemo(() => allStates(coverage), [coverage])
  const byCode = useMemo(() => new Map(states.map((s) => [s.code, s])), [states])
  const [view, setView] = useState<"map" | "list">(initialView)
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const hovered = hover ? byCode.get(hover.code) : undefined
  const opened = open ? byCode.get(open) : undefined

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>Where your products can serve customers</CardTitle>
          <CardDescription>Each state&apos;s status, from your partners&apos; licences. Click a state for its partners, licences, products and rails.</CardDescription>
        </div>
        <div className="flex gap-2" role="group" aria-label="View">
          <Button size="sm" variant={view === "map" ? "secondary" : "outline"} aria-pressed={view === "map"} onClick={() => setView("map")}>
            <MapIcon />
            Map view
          </Button>
          <Button size="sm" variant={view === "list" ? "secondary" : "outline"} aria-pressed={view === "list"} onClick={() => setView("list")}>
            <List />
            List view
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <CoverageLegend states={states} />
        {view === "map" ? (
          <div
            className="relative"
            onMouseMove={(e) => {
              if (!hover) return
              const box = e.currentTarget.getBoundingClientRect()
              setHover({ ...hover, x: e.clientX - box.left, y: e.clientY - box.top })
            }}
          >
            <ComposableMap projection="geoAlbersUsa" width={975} height={610} className="h-auto w-full" aria-label="Map of US states by coverage">
              <Geographies geography={geography}>
                {({ geographies }) =>
                  geographies.map((geo) => {
                    const code = FIPS_TO_CODE[String(geo.id)]
                    const state = code ? byCode.get(code) : undefined
                    if (!state) return null
                    const active = hover?.code === code || open === code
                    return (
                      <Geography
                        key={geo.rsmKey}
                        geography={geo}
                        data-state={code}
                        data-status={state.status}
                        role="button"
                        tabIndex={0}
                        aria-label={`${state.name}: ${COVERAGE_LABELS[state.status]}`}
                        fill={COVERAGE_FILL[state.status]}
                        stroke={active ? "var(--foreground)" : "var(--card)"}
                        strokeWidth={active ? 1.5 : 0.75}
                        className="cursor-pointer outline-none focus-visible:[stroke-width:2.5] focus-visible:[stroke:var(--ring)]"
                        onMouseEnter={(e: React.MouseEvent) => {
                          const box = (e.currentTarget as Element).closest("div.relative")!.getBoundingClientRect()
                          setHover({ code, x: e.clientX - box.left, y: e.clientY - box.top })
                        }}
                        onMouseLeave={() => setHover(null)}
                        // Keyboard users get the same tooltip, beside the state's centre.
                        onFocus={(e: React.FocusEvent) => {
                          const box = (e.currentTarget as Element).closest("div.relative")!.getBoundingClientRect()
                          const at = (e.currentTarget as Element).getBoundingClientRect()
                          setHover({ code, x: at.left + at.width / 2 - box.left, y: at.top + at.height / 2 - box.top })
                        }}
                        onBlur={() => setHover(null)}
                        onClick={() => setOpen(code)}
                        onKeyDown={(e: React.KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault()
                            setOpen(code)
                          }
                        }}
                      />
                    )
                  })
                }
              </Geographies>
            </ComposableMap>
            {hovered && hover && (
              <div
                role="tooltip"
                className="pointer-events-none absolute z-10 min-w-44 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                style={{ left: hover.x + 14, top: hover.y + 14 }}
              >
                <p className="font-medium">{hovered.name}</p>
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Swatch status={hovered.status} />
                  {COVERAGE_LABELS[hovered.status]}
                </p>
                <p className="text-muted-foreground">
                  {hovered.partners.length ? `${hovered.partners.length} partner${hovered.partners.length === 1 ? "" : "s"}` : "No partners yet"}
                </p>
              </div>
            )}
          </div>
        ) : (
          <CoverageList states={states} onOpen={setOpen} />
        )}
      </CardContent>
      <Sheet open={Boolean(opened)} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent>
          {opened && (
            <>
              <SheetHeader>
                <SheetTitle>{opened.name}</SheetTitle>
                <SheetDescription>What serves customers in {opened.name}.</SheetDescription>
              </SheetHeader>
              <StatePanel state={opened} />
            </>
          )}
        </SheetContent>
      </Sheet>
    </Card>
  )
}
