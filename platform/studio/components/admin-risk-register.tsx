"use client"

// Admin → Risk register (/platform/risk-register; lib/admin-risks.ts, GET and POST /api/admin/risks), one tab per risk
// area (components/risk-area-tabs.tsx). Each tab: Mynt's own register in that area, with filter chips for the area's
// risks and the unassigned ones (no area yet), Add risk (starting on the tab's area) and Review risk, each a labelled
// button opening its sheet (components/risk-register.tsx, as an app's and a product's); then the open risks across
// apps and products in that area, read-only, each linked to its workspace's or firm's page; then that area's signals,
// each a table or "Not available." with why. Server-renderable.
import Link from "next/link"
import { useCallback, useState } from "react"

import { AdminNotReady, useAdminData } from "@/components/admin-kit"
import { RiskAreaTabs, useAreaInAddress } from "@/components/risk-area-tabs"
import { RiskRegisterSection, SignalSection } from "@/components/risk-register"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { levelWords, PLATFORM_SUBJECT, subjectWords, type CrossRisks, type RegisterAreaData } from "@/lib/admin-risks"
import { RISK_AREA_LABELS, RISK_STATUS_LABELS, type RiskArea, type RiskStatus } from "@/lib/risk-register"

export type RegisterFilter = "area" | "unassigned"

function FilterChips({ filter, onFilter, data }: { filter: RegisterFilter; onFilter: (f: RegisterFilter) => void; data: RegisterAreaData }) {
  const n = (r: RegisterAreaData["register"]) => (r.available ? String(r.risks.length) : "not available")
  const chip = (f: RegisterFilter, label: string) => (
    <button
      type="button"
      aria-pressed={filter === f}
      onClick={() => onFilter(f)}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${filter === f ? "border-foreground bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}
      data-register-filter={f}
    >
      {label}
    </button>
  )
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Which risks" data-register-filters>
      {chip("area", `${RISK_AREA_LABELS[data.area]} (${n(data.register)})`)}
      {chip("unassigned", `Unassigned (${n(data.unassigned)})`)}
    </div>
  )
}

function CrossRisksSection({ data, area }: { data: CrossRisks; area: RiskArea }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-signal="cross-risks" aria-labelledby="signal-cross-risks">
      <h2 id="signal-cross-risks" className="text-sm font-semibold">
        Across apps and products
      </h2>
      <p className="text-xs text-muted-foreground">Open risks in this area on apps&apos; and financial products&apos; own registers, highest score first. Read-only: their workspaces and firms keep them.</p>
      {!data.available ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-not-available>
          Not available. {data.reason}
        </p>
      ) : data.risks.length ? (
        <div className="min-w-0 overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Risk</TableHead>
                <TableHead>Where</TableHead>
                <TableHead>Score</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Review by</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.risks.map((r) => (
                <TableRow key={r.id} data-cross-risk={r.id}>
                  <TableCell className="font-medium whitespace-normal">{r.title}</TableCell>
                  <TableCell className="whitespace-normal">
                    {r.href ? (
                      <Link href={r.href} className="underline underline-offset-2" data-risk-link={r.href}>
                        {subjectWords(r)}
                      </Link>
                    ) : (
                      subjectWords(r)
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {r.score} ({levelWords(r.level)})
                  </TableCell>
                  <TableCell>{RISK_STATUS_LABELS[r.status as RiskStatus] ?? r.status}</TableCell>
                  <TableCell className="text-xs tabular-nums">{r.reviewBy ? `${r.reviewBy}${r.overdue ? " (overdue)" : ""}` : "Not set"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="rounded-lg border px-4 py-4 text-sm text-muted-foreground" data-none>
          No open {RISK_AREA_LABELS[area].toLowerCase()} on any app&apos;s or product&apos;s register.
        </p>
      )}
    </section>
  )
}

/** One area's tab body: the register (with its filter chips and sheets), the risks across apps and products, the signals. */
export function RiskRegisterAreaView({ data, onChanged, filter = "area", onFilter = () => undefined }: { data: RegisterAreaData; onChanged?: () => void; filter?: RegisterFilter; onFilter?: (f: RegisterFilter) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-6" data-risk-register-area={data.area}>
      <RiskRegisterSection
        subject={PLATFORM_SUBJECT}
        data={filter === "unassigned" ? data.unassigned : data.register}
        onChanged={onChanged}
        area={data.area}
        title={filter === "unassigned" ? "Mynt's own register: unassigned risks" : `Mynt's own register: ${RISK_AREA_LABELS[data.area].toLowerCase()}`}
        filters={<FilterChips filter={filter} onFilter={onFilter} data={data} />}
      />
      <CrossRisksSection data={data.cross} area={data.area} />
      {data.signals.map((s) => (
        <SignalSection key={s.id} id={s.id} title={s.title} description={s.description} columns={s.columns} signal={s.signal} empty={s.empty} />
      ))}
    </div>
  )
}

/** The page: the seven area tabs, then the tab's body (or why it isn't ready). Server-renderable with state given. */
export function RiskRegisterView({ area, onArea, body }: { area: RiskArea; onArea: (a: RiskArea) => void; body: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-platform-risk-register>
      <RiskAreaTabs area={area} onArea={onArea} label="Risk areas" />
      {body}
    </div>
  )
}

export function RiskRegisterTab() {
  const [area, setArea] = useAreaInAddress()
  const [filter, setFilter] = useState<RegisterFilter>("area")
  const pick = useCallback((b: Record<string, unknown>) => (b.register && b.unassigned && Array.isArray(b.signals) ? (b as unknown as RegisterAreaData) : undefined), [])
  const { state, reload } = useAdminData(`/api/admin/risks?area=${area}`, pick)
  return (
    <RiskRegisterView
      area={area}
      onArea={(a) => (setFilter("area"), setArea(a))}
      body={state.kind === "ready" && state.data.area === area ? <RiskRegisterAreaView data={state.data} onChanged={reload} filter={filter} onFilter={setFilter} /> : state.kind === "ready" ? null : <AdminNotReady state={state} what="The risk register" />}
    />
  )
}
