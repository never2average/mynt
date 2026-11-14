"use client"

// The Licences page's map view: a US map (react-simple-maps, MIT, over us-atlas's states, ISC)
// colouring each state by whether the workspace's products can serve it, with a legend, a hover
// tooltip and a side panel for the state clicked (its partners, licences, products and rails);
// or, with World picked, a world map (world-atlas's countries, ISC, from the same family as
// us-atlas) where the US is coloured by its coverage and every other country is Not available,
// since Mynt serves the US only. Server-renderable, so tests run without a browser.
//
// Colours (app/globals.css, light and dark): unlocked is the most prominent, a strong bright
// blue; available a muted blue of the same hue; unavailable neutral grey. The two blues pass the
// dataviz skill's ordinal checks on each surface, and all three pairs are told apart with normal
// and colour-blind vision. Status is never colour alone: the legend, tooltip and panel name it.
import { useMemo, useState } from "react"
import type { GeoJsonObject } from "geojson"
import { ComposableMap, Geographies, Geography } from "react-simple-maps"
import statesTopology from "us-atlas/states-10m.json"
import countriesTopology from "world-atlas/countries-110m.json"

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
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
import { cn } from "@/lib/utils"

export const COVERAGE_FILL: Record<CoverageStatus, string> = {
  unlocked: "var(--coverage-unlocked)",
  available: "var(--coverage-available)",
  unavailable: "var(--coverage-unavailable)",
}

const geography = statesTopology as unknown as GeoJsonObject
const world = countriesTopology as unknown as GeoJsonObject

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

export const MAP_REGIONS = ["us", "world"] as const
export type MapRegion = (typeof MAP_REGIONS)[number]
const REGION_LABELS: Record<MapRegion, string> = { us: "US", world: "World" }

/** The US on world-atlas (ISO 3166-1 numeric 840), coloured by the best status of its states. */
export const US_COUNTRY_ID = "840"
export const NOT_AVAILABLE = "Not available"
export function usStatus(states: CoverageState[]): CoverageStatus {
  if (states.some((s) => s.status === "unlocked")) return "unlocked"
  if (states.some((s) => s.status === "available")) return "available"
  return "unavailable"
}

export function RegionSelector({ region, onRegion }: { region: MapRegion; onRegion: (r: MapRegion) => void }) {
  return (
    <div className="inline-flex items-center rounded-md border p-0.5" role="group" aria-label="Map">
      {MAP_REGIONS.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={region === r}
          onClick={() => onRegion(r)}
          className={cn("rounded px-3 py-1 text-sm text-muted-foreground hover:text-foreground", region === r && "bg-muted font-medium text-foreground")}
          data-region={r}
        >
          {REGION_LABELS[r]}
        </button>
      ))}
    </div>
  )
}

function WorldLegend({ us }: { us: CoverageStatus }) {
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm" aria-label="Legend" data-world-legend>
      <li className="flex items-center gap-2" data-legend="us">
        <Swatch status={us} />
        <span>United States: {COVERAGE_LABELS[us]}</span>
      </li>
      <li className="flex items-center gap-2" data-legend="not-available">
        <Swatch status="unavailable" />
        <span>Every other country: {NOT_AVAILABLE} (Mynt serves the US only)</span>
      </li>
    </ul>
  )
}

function Tip({ at, children }: { at: { x: number; y: number }; children: React.ReactNode }) {
  return (
    <div role="tooltip" className="pointer-events-none absolute z-10 min-w-44 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" style={{ left: at.x + 14, top: at.y + 14 }}>
      {children}
    </div>
  )
}

const boxOf = (e: { currentTarget: EventTarget }) => (e.currentTarget as Element).closest("div.relative")!.getBoundingClientRect()

/**
 * The map in the Licences page's map view. `highlight`: the states the filtered licences cover,
 * when filters are on; the rest are dimmed (never recoloured: their status still shows).
 */
export function CoverageMap({
  coverage,
  region,
  onRegion,
  highlight = null,
}: {
  coverage: Coverage
  region: MapRegion
  onRegion: (r: MapRegion) => void
  highlight?: Set<string> | null
}) {
  const states = useMemo(() => allStates(coverage), [coverage])
  const byCode = useMemo(() => new Map(states.map((s) => [s.code, s])), [states])
  const [hover, setHover] = useState<{ code: string; x: number; y: number } | null>(null)
  const [countryHover, setCountryHover] = useState<{ name: string; us: boolean; x: number; y: number } | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const hovered = hover ? byCode.get(hover.code) : undefined
  const opened = open ? byCode.get(open) : undefined
  const us = usStatus(states)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 rounded-lg border p-3" data-map-view data-region-shown={region}>
      <div className="flex flex-wrap items-center gap-3">
        <RegionSelector region={region} onRegion={onRegion} />
        {region === "us" ? <CoverageLegend states={states} /> : <WorldLegend us={us} />}
      </div>
      {region === "us" && highlight && (
        <p className="text-xs text-muted-foreground" data-map-filtered>
          Showing the {highlight.size} {highlight.size === 1 ? "state" : "states"} covered by the licences matching your filters; the rest are dimmed.
        </p>
      )}
      {region === "us" ? (
        <div
          className="relative"
          onMouseMove={(e) => {
            if (!hover) return
            const box = e.currentTarget.getBoundingClientRect()
            setHover({ ...hover, x: e.clientX - box.left, y: e.clientY - box.top })
          }}
        >
          <ComposableMap projection="geoAlbersUsa" width={975} height={610} className="h-auto max-h-[70vh] w-full" aria-label="Map of US states by coverage">
            <Geographies geography={geography}>
              {({ geographies }) =>
                geographies.map((geo) => {
                  const code = FIPS_TO_CODE[String(geo.id)]
                  const state = code ? byCode.get(code) : undefined
                  if (!state) return null
                  const active = hover?.code === code || open === code
                  const dimmed = highlight ? !highlight.has(code) : false
                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      data-state={code}
                      data-status={state.status}
                      data-dimmed={dimmed || undefined}
                      role="button"
                      tabIndex={0}
                      aria-label={`${state.name}: ${COVERAGE_LABELS[state.status]}`}
                      fill={COVERAGE_FILL[state.status]}
                      fillOpacity={dimmed ? 0.3 : 1}
                      stroke={active ? "var(--foreground)" : "var(--card)"}
                      strokeWidth={active ? 1.5 : 0.75}
                      className="cursor-pointer outline-none focus-visible:[stroke-width:2.5] focus-visible:[stroke:var(--ring)]"
                      onMouseEnter={(e: React.MouseEvent) => {
                        const box = boxOf(e)
                        setHover({ code, x: e.clientX - box.left, y: e.clientY - box.top })
                      }}
                      onMouseLeave={() => setHover(null)}
                      // Keyboard users get the same tooltip, beside the state's centre.
                      onFocus={(e: React.FocusEvent) => {
                        const box = boxOf(e)
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
            <Tip at={hover}>
              <p className="font-medium">{hovered.name}</p>
              <p className="flex items-center gap-2 text-muted-foreground">
                <Swatch status={hovered.status} />
                {COVERAGE_LABELS[hovered.status]}
              </p>
              <p className="text-muted-foreground">
                {hovered.partners.length ? `${hovered.partners.length} partner${hovered.partners.length === 1 ? "" : "s"}` : "No partners yet"}
              </p>
            </Tip>
          )}
        </div>
      ) : (
        <div
          className="relative"
          onMouseMove={(e) => {
            if (!countryHover) return
            const box = e.currentTarget.getBoundingClientRect()
            setCountryHover({ ...countryHover, x: e.clientX - box.left, y: e.clientY - box.top })
          }}
        >
          <ComposableMap projection="geoEqualEarth" width={975} height={480} className="h-auto max-h-[70vh] w-full" aria-label="World map: the US by coverage, every other country not available">
            <Geographies geography={world}>
              {({ geographies }) =>
                geographies.map((geo) => {
                  const isUs = String(geo.id) === US_COUNTRY_ID
                  const name = String((geo.properties as { name?: string } | undefined)?.name ?? "")
                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      data-country={isUs ? "us" : String(geo.id ?? "")}
                      data-status={isUs ? us : "not-available"}
                      aria-label={`${name}: ${isUs ? COVERAGE_LABELS[us] : NOT_AVAILABLE}`}
                      fill={isUs ? COVERAGE_FILL[us] : COVERAGE_FILL.unavailable}
                      stroke="var(--card)"
                      strokeWidth={0.5}
                      className={cn("outline-none", isUs && "cursor-pointer")}
                      onMouseEnter={(e: React.MouseEvent) => {
                        const box = boxOf(e)
                        setCountryHover({ name, us: isUs, x: e.clientX - box.left, y: e.clientY - box.top })
                      }}
                      onMouseLeave={() => setCountryHover(null)}
                      onClick={() => isUs && onRegion("us")}
                    />
                  )
                })
              }
            </Geographies>
          </ComposableMap>
          {countryHover && (
            <Tip at={countryHover}>
              <p className="font-medium">{countryHover.name}</p>
              <p className="text-muted-foreground">{countryHover.us ? `${COVERAGE_LABELS[us]} · click for the states` : NOT_AVAILABLE}</p>
            </Tip>
          )}
        </div>
      )}
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
    </div>
  )
}
