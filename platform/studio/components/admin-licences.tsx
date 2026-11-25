"use client"

// Admin → Firms → Licences (/platform/firms?tab=licences; it was a section of its own): every licence firms
// registered (list_license_reviews), opening on the ones waiting for review, each with its firm (a link to the firm's
// page). Each row's labelled action opens a sheet: Verify licence, Reject licence or Suspend licence (review_license),
// after checking it against the regulator's public register; a rejection or suspension says why. Only verified,
// in-date licences let a firm publish products. The same actions and sheet are on each firm's own Licences tab
// (components/admin-firms.tsx). Server-renderable.
import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"

import { AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { KpiRow } from "@/components/charts"
import { Panel } from "@/components/dashboard-panels"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { adminHref, adminIdOk, csvOf, dateOf, words, type AdminLicence } from "@/lib/admin"
import type { Kpi } from "@/lib/dashboard-visual"

export type Decision = "verified" | "rejected" | "suspended"
export const DECISION_LABELS: Record<Decision, string> = { verified: "Verify licence", rejected: "Reject licence", suspended: "Suspend licence" }
// What a licence in each review status can be moved to.
export const decisionsFor = (status: string): Decision[] => (status === "pending" ? ["verified", "rejected"] : status === "verified" ? ["suspended"] : status === "suspended" ? ["verified"] : [])
const STATUSES = ["pending", "verified", "rejected", "suspended"] as const

export function LicenceStatus({ status }: { status: string }) {
  const tone = status === "verified" ? "green" : status === "pending" ? "amber" : status === "rejected" ? "red" : "gray"
  return <StatusDot tone={tone} label={status === "pending" ? "Waiting for review" : words(status)} data-licence-status={status} />
}

/** A licence's review actions, each a labelled button that opens the review sheet; none when its status has no next step. */
export function LicenceActions({ licence, onAct }: { licence: AdminLicence; onAct: (decision: Decision) => void }) {
  return (
    <span className="flex justify-end gap-2" data-licence-actions={licence.id}>
      {decisionsFor(licence.status).map((d) => (
        <Button key={d} size="sm" variant={d === "verified" ? "default" : "outline"} onClick={() => onAct(d)} data-review={d}>
          {DECISION_LABELS[d]}
        </Button>
      ))}
    </span>
  )
}

/** The firm a licence belongs to, as a link to its page in Firms (on its Licences tab); its name alone when Mynt gave no id. */
export function LicenceFirm({ licence }: { licence: AdminLicence }) {
  const name = licence.firm ?? "—"
  if (!adminIdOk("firms", licence.entityId)) return <>{name}</>
  return (
    <Link href={`${adminHref("firms", licence.entityId)}?tab=licences`} className="underline-offset-4 hover:underline" data-licence-firm={licence.entityId}>
      {name}
    </Link>
  )
}

export function ReviewLicenceSheet({ licence, decision, onClose, onDone, fetcher }: { licence: AdminLicence | null; decision: Decision | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [note, setNote] = useState("")
  useEffect(() => {
    reset()
    setNote("")
  }, [licence, decision, reset])
  const needsNote = decision !== "verified"
  return (
    <AdminSheet
      id="review-licence"
      open={licence !== null && decision !== null}
      onClose={onClose}
      title={decision ? DECISION_LABELS[decision] : "Review licence"}
      description="Check it against the regulator's public register first. The firm sees your decision and note."
      error={error}
      result={result}
    >
      {licence && decision && (
        <form
          className="flex flex-col gap-3"
          data-review-licence-form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(`/api/admin/licences/${encodeURIComponent(licence.id)}`, { decision, ...(note.trim() ? { note: note.trim() } : {}) })
            if (r?.ok) onDone()
          }}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Firm</dt>
            <dd>{licence.firm ?? "—"}</dd>
            <dt className="text-muted-foreground">Licence</dt>
            <dd>{licence.licenceType}</dd>
            <dt className="text-muted-foreground">Regulator</dt>
            <dd>{licence.regulator}</dd>
            <dt className="text-muted-foreground">Number</dt>
            <dd>{licence.number ?? "—"}</dd>
            <dt className="text-muted-foreground">Valid</dt>
            <dd>
              {dateOf(licence.validFrom)} to {dateOf(licence.validTo)}
            </dd>
          </dl>
          <Field label={needsNote ? "Why" : "Note (optional)"}>
            <textarea className={`${fieldClass} min-h-20`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required={needsNote} data-review-note />
          </Field>
          <div>
            <Button type="submit" variant={decision === "verified" ? "default" : "destructive"} disabled={busy || (needsNote && note.trim().length < 3) || result !== null} data-review-submit={decision}>
              {busy ? "Saving…" : DECISION_LABELS[decision]}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

export function licenceKpis(licences: AdminLicence[]): Kpi[] {
  const k = (key: string, label: string, value: number, note: string): Kpi => ({ key, label, value, unit: "count", delta: null, spark: null, note })
  return [
    k("pending", "Waiting for review", licences.filter((l) => l.status === "pending").length, "Check against the register"),
    k("verified", "Verified", licences.filter((l) => l.status === "verified").length, "Firms may rely on them"),
    k("rejected", "Rejected", licences.filter((l) => l.status === "rejected").length, "Not accepted"),
    k("suspended", "Suspended", licences.filter((l) => l.status === "suspended").length, "Products re-checked"),
  ]
}

export function LicencesAdminView({ licences, onChanged = () => undefined }: { licences: AdminLicence[]; onChanged?: () => void }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<string[]>(() => (licences.some((l) => l.status === "pending") ? ["pending"] : []))
  const [region, setRegion] = useState<string[]>([])
  const [acting, setActing] = useState<{ licence: AdminLicence; decision: Decision } | null>(null)
  // The list is read again once the sheet closes, so its answer stays on screen until then.
  const [dirty, setDirty] = useState(false)
  const regions = useMemo(() => [...new Set(licences.map((l) => l.region).filter(Boolean))].sort(), [licences])
  const shown = useMemo(
    () => licences.filter((l) => matches(query, l.firm, l.licenceType, l.regulator, l.number, l.jurisdiction) && (!status.length || status.includes(l.status)) && (!region.length || region.includes(l.region))),
    [licences, query, status, region],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const exportCsv = () =>
    downloadCsv(
      "licences.csv",
      csvOf(["Firm", "Licence", "Regulator", "Region", "Jurisdiction", "Number", "Valid from", "Valid to", "Review", "Note"], shown.map((l) => [l.firm ?? "", l.licenceType, l.regulator, l.region, l.jurisdiction ?? "", l.number ?? "", dateOf(l.validFrom), dateOf(l.validTo), l.status, l.reviewNote ?? ""])),
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:gap-5" data-admin-licences>
      <Panel id="admin-licence-figures">
        <KpiRow kpis={licenceKpis(licences)} />
      </Panel>
      <AdminList
        id="licences"
        search={query}
        onSearch={(q) => (setQuery(q), setPage(1))}
        searchLabel="Search licences by firm, type, regulator, number or jurisdiction"
        facets={[
          { id: "status", label: "Review", options: STATUSES.map((s) => ({ value: s, label: s === "pending" ? "Waiting for review" : words(s) })), selected: status, onChange: (v) => (setStatus(v), setPage(1)) },
          { id: "region", label: "Region", options: regions.map((r) => ({ value: r, label: r })), selected: region, onChange: (v) => (setRegion(v), setPage(1)) },
        ]}
        onClearFilters={() => (setStatus([]), setRegion([]))}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        page={page}
        pages={pages}
        total={shown.length}
        onPage={setPage}
      >
        <AdminTable
          head={["Firm", "Licence", "Regulator", "Region", "Number", "Valid to", "Review", ""]}
          rowKeys={onPage.map((l) => l.id)}
          rows={onPage.map((l) => [
            <LicenceFirm key="f" licence={l} />,
            l.licenceType,
            l.regulator,
            `${l.region}${l.jurisdiction ? ` · ${l.jurisdiction.toUpperCase()}` : ""}`,
            l.number ?? "—",
            dateOf(l.validTo),
            <LicenceStatus key="s" status={l.status} />,
            <LicenceActions key="a" licence={l} onAct={(decision) => setActing({ licence: l, decision })} />,
          ])}
          empty={licences.length ? "No licences match these filters." : "No licences registered yet."}
        />
      </AdminList>
      <ReviewLicenceSheet
        licence={acting?.licence ?? null}
        decision={acting?.decision ?? null}
        onClose={() => {
          setActing(null)
          if (dirty) onChanged()
        }}
        onDone={() => setDirty(true)}
      />
    </div>
  )
}

export function LicencesTab() {
  const pick = useCallback((b: Record<string, unknown>) => (Array.isArray(b.licences) ? (b.licences as AdminLicence[]) : undefined), [])
  const { state, reload } = useAdminData("/api/admin/licences", pick)
  return state.kind === "ready" ? <LicencesAdminView licences={state.data} onChanged={reload} /> : <AdminNotReady state={state} what="Licences" />
}
