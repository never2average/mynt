"use client"

// The Licences page's Agreements tab, for licence providers: the agreements apps' workspaces proposed to or made
// with their firm (lib/lp-agreements.ts). The list layout: a full-width search, the Status filter and Export CSV on
// one row, then the table (app, developer workspace, products, kind, status, dates, document) paged 25 rows at a
// time. The tab shows; each row's labelled actions open a sheet that changes it: Review agreement (the terms in
// full), Accept and Decline (a proposal), Sign (accepted, their side not signed yet) and End agreement (with the
// reason). The app's workspace is told of each in its attention list. Add audit requirement (an open program
// agreement) opens the sheet that sets an oversight audit the firm runs on the app (components/agreement-audits-view.tsx).
// Server-renderable for the tests.
import { useCallback, useEffect, useMemo, useState } from "react"
import { ClipboardList, Download, FileSearch, Search } from "lucide-react"

import { SignedCopyLinks, SigningSheet } from "@/components/agreement-esign"
import { AddRequirementSheet } from "@/components/agreement-audits-view"
import { AgreementActionButtons, AgreementActionSheet, type AgreementSummary } from "@/components/app-agreement-sheets"
import { FilterSelect } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { ListPager, TOOLBAR_ROW, TOOLBAR_SEARCH, usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { AgreementAction } from "@/lib/app-panel"
import { toCsv } from "@/lib/compliance"
import { LP_STATUS_FILTERS, type LpAgreementRow } from "@/lib/lp-agreements"

const dates = (from: string | null, to: string | null) => (from || to ? `${from ?? "—"} to ${to ?? "open-ended"}` : "Not set")
const STATUS_WORD: Record<string, string> = { proposed: "Proposed", accepted: "Accepted", signed: "Signed", declined: "Declined", terminated: "Ended" }

export function lpAgreementsCsv(rows: LpAgreementRow[]): string {
  return toCsv(
    ["App", "Workspace", "Products", "Kind", "Status", "Effective from", "Until", "Document"],
    rows.map((r) => [r.appName, r.workspace, r.products.join(" "), r.kind, STATUS_WORD[r.statusKey] ?? r.statusKey, r.from ?? "", r.to ?? "", r.documentUrl ?? ""]),
  )
}

export function filterLpAgreements(rows: LpAgreementRow[], query: string, status: string): LpAgreementRow[] {
  const q = query.trim().toLowerCase()
  return rows.filter((r) => (!status || r.statusKey === status) && (!q || [r.appName, r.workspace, r.kind, ...r.products].some((v) => v.toLowerCase().includes(q))))
}

/** Whether the firm can add an oversight audit requirement to this agreement: a program agreement still open. */
export const takesAuditRequirements = (r: LpAgreementRow) => r.kindKey === "program" && ["proposed", "accepted", "signed"].includes(r.statusKey)

const summaryOf = (r: LpAgreementRow): AgreementSummary => ({
  id: r.id,
  title: `${r.kind} with ${r.workspace} for ${r.appName}`,
  lines: [`Covers: ${r.products.join(", ") || "no products named"}`, `Effective: ${dates(r.from, r.to)}`, r.status],
})

/** Review agreement: the terms in full, the document and where it stands, with the same labelled actions. */
export function ReviewAgreementView({ row, onAction }: { row: LpAgreementRow; onAction: (a: AgreementAction) => void }) {
  return (
    <div className="flex flex-col gap-3 text-sm" data-review-agreement={row.id}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">App</dt>
        <dd>{row.appName}</dd>
        <dt className="text-muted-foreground">Workspace</dt>
        <dd>{row.workspace}</dd>
        <dt className="text-muted-foreground">Kind</dt>
        <dd>{row.kind}</dd>
        <dt className="text-muted-foreground">Products</dt>
        <dd>{row.products.join(", ") || "—"}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          {row.status}
          {row.signatures && <div className="text-xs text-muted-foreground">{row.signatures}</div>}
        </dd>
        <dt className="text-muted-foreground">Effective</dt>
        <dd>{dates(row.from, row.to)}</dd>
        <dt className="text-muted-foreground">Document</dt>
        <dd>
          {row.documentUrl ? (
            <a href={row.documentUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
              Open the document
            </a>
          ) : (
            "None linked"
          )}
        </dd>
        {row.endedReason && (
          <>
            <dt className="text-muted-foreground">Ended because</dt>
            <dd>{row.endedReason}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Terms</p>
        <p className="whitespace-pre-wrap text-muted-foreground" data-agreement-terms>
          {row.terms ?? "No summary given."}
        </p>
      </div>
      <AgreementActionButtons id={row.id} actions={row.actions} onAction={onAction} />
    </div>
  )
}

export function LpAgreementsView({
  rows,
  onChanged = () => undefined,
  fetcher,
  auditRequirements = true,
}: {
  rows: LpAgreementRow[]
  onChanged?: () => void
  fetcher?: typeof fetch
  auditRequirements?: boolean
}) {
  const [requiring, setRequiring] = useState<LpAgreementRow | null>(null)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("")
  const [reviewing, setReviewing] = useState<LpAgreementRow | null>(null)
  const [acting, setActing] = useState<{ action: AgreementAction; row: LpAgreementRow } | null>(null)
  // Sign on a program agreement signed by e-signature: the signer's embedded signing page instead of the manual sheet.
  const [signing, setSigning] = useState<string | null>(null)
  const shown = useMemo(() => filterLpAgreements(rows, query, status), [rows, query, status])
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const waiting = rows.filter((r) => r.actions.includes("accept") || r.actions.includes("sign")).length
  const act = (row: LpAgreementRow) => (action: AgreementAction) => {
    setReviewing(null)
    if (action === "sign" && row.esign?.byEsign) setSigning(row.id)
    else setActing({ action, row })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-lp-agreements>
      {waiting > 0 && (
        <p className="text-sm" data-lp-waiting>
          {waiting} agreement{waiting === 1 ? "" : "s"} wait{waiting === 1 ? "s" : ""} for your firm: accept or decline a proposal, or sign one you accepted.
        </p>
      )}
      <div className={TOOLBAR_ROW} data-toolbar>
        <div className={TOOLBAR_SEARCH}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(1)
            }}
            placeholder="Search app, workspace, kind or product"
            className="pl-8"
            aria-label="Search agreements"
          />
        </div>
        <FilterSelect
          label="Status"
          value={status}
          onChange={(v) => {
            setStatus(v)
            setPage(1)
          }}
          options={LP_STATUS_FILTERS.map((s) => ({ value: s, label: STATUS_WORD[s] }))}
        />
        <Button variant="outline" onClick={() => downloadCsv("agreements.csv", lpAgreementsCsv(shown))} disabled={!shown.length} data-export>
          <Download />
          Export CSV
        </Button>
      </div>
      <div className="min-h-64 flex-1 overflow-auto rounded-lg border" data-table-view>
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Developer workspace</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Effective</TableHead>
              <TableHead>Document</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {onPage.length ? (
              onPage.map((r) => (
                <TableRow key={r.id} data-lp-agreement={r.id} data-status={r.statusKey}>
                  <TableCell className="font-medium whitespace-normal">{r.appName}</TableCell>
                  <TableCell className="whitespace-normal">{r.workspace}</TableCell>
                  <TableCell className="max-w-48 whitespace-normal">{r.products.join(", ") || "—"}</TableCell>
                  <TableCell>{r.kind}</TableCell>
                  <TableCell className="whitespace-normal">
                    {r.status}
                    {r.signatures && <div className="text-xs text-muted-foreground">{r.signatures}</div>}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap tabular-nums">{dates(r.from, r.to)}</TableCell>
                  <TableCell>
                    {r.documentUrl ? (
                      <a href={r.documentUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline-offset-4 hover:underline" data-lp-document={r.id}>
                        Document
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1.5">
                      <Button size="sm" variant="outline" className="h-7" onClick={() => setReviewing(r)} data-review={r.id}>
                        <FileSearch />
                        Review agreement
                      </Button>
                      <AgreementActionButtons id={r.id} actions={r.actions} onAction={act(r)} />
                      <SignedCopyLinks agreementId={r.id} esign={r.esign} />
                      {auditRequirements && takesAuditRequirements(r) && (
                        <Button size="sm" variant="outline" className="h-7" onClick={() => setRequiring(r)} data-add-audit-requirement={r.id}>
                          <ClipboardList />
                          Add audit requirement
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {rows.length ? "No agreements match these filters." : "No agreements yet. They appear here when an app built on a product your firm sponsors proposes one."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <ListPager page={page} pages={pages} total={shown.length} onPage={setPage} />
      <Sheet open={reviewing !== null} onOpenChange={(o) => !o && setReviewing(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-review-sheet>
          <SheetHeader>
            <SheetTitle>Review agreement</SheetTitle>
            <SheetDescription>{reviewing ? summaryOf(reviewing).title : ""}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">{reviewing && <ReviewAgreementView row={reviewing} onAction={act(reviewing)} />}</div>
        </SheetContent>
      </Sheet>
      <SigningSheet
        agreementId={signing ?? ""}
        open={signing !== null}
        onClose={() => {
          setSigning(null)
          onChanged()
        }}
        fetcher={fetcher}
      />
      <AddRequirementSheet
        agreements={requiring ? [{ id: requiring.id, label: `${requiring.appName} (${requiring.workspace})`, appName: requiring.appName, counterparty: requiring.workspace, canAddRequirements: true }] : []}
        open={requiring !== null}
        onClose={() => setRequiring(null)}
        onDone={onChanged}
        fetcher={fetcher}
      />
      <AgreementActionSheet
        url={acting ? `/api/agreements/${encodeURIComponent(acting.row.id)}` : ""}
        action={acting?.action ?? null}
        agreement={acting ? summaryOf(acting.row) : null}
        onClose={() => setActing(null)}
        onDone={onChanged}
        fetcher={fetcher}
      />
    </div>
  )
}

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; rows: LpAgreementRow[] }

/** The tab's data, from /api/agreements, read again after an action. */
export function useLpAgreements(enabled: boolean): { state: State; reload: () => void } {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    if (!enabled) return
    let live = true
    void (async () => {
      const res = await fetch("/api/agreements", { cache: "no-store" }).catch(() => null)
      if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
      const body = (await res?.json().catch(() => null)) as { agreements?: LpAgreementRow[]; message?: string } | null
      if (!live) return
      setState(res?.ok && body?.agreements ? { kind: "ready", rows: body.agreements } : { kind: "error", message: body?.message ?? "Couldn't reach Mynt. Please try again." })
    })()
    return () => {
      live = false
    }
  }, [enabled, tick])
  return { state, reload }
}

