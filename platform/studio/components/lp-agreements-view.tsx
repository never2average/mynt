"use client"

// The Licences page's agreement tables (lib/lp-agreements.ts): Business agreements (program and data-sharing), MSA
// and SLA each list their kinds of agreement with this one view, from whichever side the signed-in person is on. A
// licence provider sees the agreements made with its firm; a developer sees its workspace's; someone who is both sees
// both, each row saying which side they're on. Either side proposes; the other accepts or declines; both sign.
// The list layout: a full-width search, the Filters popover (status, kind, side), a Proposed date range, Import (not
// for agreements: they're made here), Export CSV and Propose agreement; then the table paged 25 rows at a time. A
// row opens its detail (Review agreement): a card with the terms and the document on top, the labelled actions for
// the row's side, then its tabs, each a table (Products and Signatures, and what the tab adds: an SLA's Commitments
// and Breaches). Actions open a sheet that changes it: Accept and Decline (a proposal the other side made), Withdraw
// (one's own proposal), Sign and End agreement. Sign on a program agreement signed by e-signature opens the signer's
// embedded signing page. Add audit requirement (a licence provider, an open program agreement) opens the sheet that
// sets an oversight audit (components/agreement-audits-view.tsx). Server-renderable for the tests.
import { useMemo, useState } from "react"
import { ClipboardList, Download, FilePlus2, FileSearch } from "lucide-react"

import { SignedCopyLinks, SigningSheet } from "@/components/agreement-esign"
import { AddRequirementSheet } from "@/components/agreement-audits-view"
import { AgreementActionButtons, AgreementActionSheet, type AgreementSummary } from "@/components/app-agreement-sheets"
import { DateRangeFilter, FiltersPopover, picksOf, type Facet, type Picks } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { DetailTabs, ImportButton, ListSearch, MetaCard, withinRange, type DetailTable } from "@/components/licences-kit"
import { ListPager, TOOLBAR_ROW, usePaged } from "@/components/list-layout"
import { ProposeSheet } from "@/components/propose-agreement-sheet"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { TemplateRow } from "@/lib/agreement-esign"
import { AGREEMENT_KIND_LABELS, type AgreementAction } from "@/lib/app-panel"
import { toCsv } from "@/lib/compliance"
import { LP_STATUS_FILTERS, rowKey, TAB_KINDS, type LpAgreementRow, type ProposeTarget } from "@/lib/lp-agreements"

const dates = (from: string | null, to: string | null) => (from || to ? `${from ?? "—"} to ${to ?? "open-ended"}` : "Not set")
const STATUS_WORD: Record<string, string> = { proposed: "Proposed", accepted: "Accepted", signed: "Signed", declined: "Declined", terminated: "Ended" }
const SIDE_WORD: Record<LpAgreementRow["side"], string> = { app: "Your workspace's side", counterparty: "Your firm's side" }
export const AGREEMENTS_IMPORT_NOTE = "Agreements are proposed, accepted and signed here, between the two parties; there's nothing to import."

/** The other party, from the row's side: the developer workspace for the licence provider, the firm for the app's side. */
export const otherParty = (r: LpAgreementRow) => (r.side === "app" ? r.counterparty : r.workspace)

export function lpAgreementsCsv(rows: LpAgreementRow[]): string {
  return toCsv(
    ["App", "Other party", "Your side", "Proposed by", "Products", "Kind", "Status", "Effective from", "Until", "Document"],
    rows.map((r) => [r.appName, otherParty(r), SIDE_WORD[r.side], r.proposedBy === r.side ? "You" : "Them", r.products.join(" "), r.kind, STATUS_WORD[r.statusKey] ?? r.statusKey, r.from ?? "", r.to ?? "", r.documentUrl ?? ""]),
  )
}

export type AgreementFilters = { query: string; status: Picks; kind: Picks; side: Picks; from: string; to: string }
export const NO_AGREEMENT_FILTERS: AgreementFilters = { query: "", status: [], kind: [], side: [], from: "", to: "" }

export function filterLpAgreements(rows: LpAgreementRow[], f: Partial<AgreementFilters>): LpAgreementRow[] {
  const q = (f.query ?? "").trim().toLowerCase()
  const [status, kind, side] = [picksOf(f.status), picksOf(f.kind), picksOf(f.side)]
  return rows.filter(
    (r) =>
      (!status.length || status.includes(r.statusKey)) &&
      (!kind.length || kind.includes(r.kindKey)) &&
      (!side.length || side.includes(r.side)) &&
      withinRange(r.proposedAt, f.from ?? "", f.to ?? "") &&
      (!q || [r.appName, r.workspace, r.counterparty, r.kind, ...r.products].some((v) => v.toLowerCase().includes(q))),
  )
}

/** Whether the firm can add an oversight audit requirement to this agreement: its own side of a program agreement still open. */
export const takesAuditRequirements = (r: LpAgreementRow) => r.side === "counterparty" && r.kindKey === "program" && ["proposed", "accepted", "signed"].includes(r.statusKey)

const summaryOf = (r: LpAgreementRow): AgreementSummary => ({
  id: r.id,
  title: `${r.kind} with ${otherParty(r)} for ${r.appName}`,
  lines: [`Covers: ${r.products.join(", ") || "no products named"}`, `Effective: ${dates(r.from, r.to)}`, r.status],
})

/** Where a row's actions go, from either side (Mynt works out the side again). */
export const actionUrl = (r: Pick<LpAgreementRow, "id">) => `/api/agreements/${encodeURIComponent(r.id)}`

function Document({ row }: { row: LpAgreementRow }) {
  return row.documentUrl ? (
    <a href={row.documentUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
      Open the document
    </a>
  ) : (
    <>None linked</>
  )
}

/** Review agreement: the detail of one agreement. A card with its terms and document, its labelled actions, then its tabs. */
export function ReviewAgreementView({ row, onAction, extraTabs = [], extraActions = null }: { row: LpAgreementRow; onAction: (a: AgreementAction) => void; extraTabs?: DetailTable[]; extraActions?: React.ReactNode }) {
  const signer = (signed: boolean) => (signed ? "Signed" : row.statusKey === "accepted" ? "Not signed yet" : "Not signed")
  const template = row.template ? `${row.template.name}${row.template.version ? `, version ${row.template.version}` : ""}` : row.esign?.template
  return (
    <div className="flex flex-col gap-4 text-sm" data-review-agreement={row.id} data-side={row.side}>
      <MetaCard
        items={[
          ["App", row.appName],
          [row.side === "app" ? "With" : "Workspace", otherParty(row)],
          ["Your side", SIDE_WORD[row.side]],
          ["Proposed by", row.proposedBy === row.side ? "You" : row.side === "app" ? row.counterparty : row.workspace],
          ["Kind", row.kind],
          [
            "Status",
            <>
              {row.status}
              {row.signatures && <div className="text-xs text-muted-foreground">{row.signatures}</div>}
            </>,
          ],
          ["Effective", dates(row.from, row.to)],
          ["Document", <Document key="d" row={row} />],
          ...(template ? ([["Starting document", template]] as [string, string][]) : []),
          ...(row.endedReason ? ([["Ended because", row.endedReason]] as [string, string][]) : []),
        ]}
      >
        <div className="flex flex-col gap-1">
          <p className="font-medium">Terms</p>
          <p className="whitespace-pre-wrap text-muted-foreground" data-agreement-terms>
            {row.terms ?? "No summary given."}
          </p>
        </div>
      </MetaCard>
      <div className="flex flex-wrap gap-1.5">
        <AgreementActionButtons id={row.id} actions={row.actions} onAction={onAction} />
        <SignedCopyLinks agreementId={row.id} esign={row.esign} />
        {extraActions}
      </div>
      <DetailTabs
        label="Agreement details"
        tabs={[
          ...extraTabs,
          { id: "products", label: "Products", headers: ["Product"], rows: row.products.map((p) => ({ key: p, cells: [p] })), empty: "No products named." },
          {
            id: "signatures",
            label: "Signatures",
            headers: ["Side", "Party", "Signature"],
            rows: [
              { key: "app", cells: ["The app's side", row.side === "app" ? "Your workspace" : row.workspace, signer(row.appSigned)] },
              { key: "counterparty", cells: ["The other firm", row.side === "counterparty" ? "Your firm" : row.counterparty, signer(row.counterpartySigned)] },
            ],
            empty: "",
          },
        ]}
      />
    </div>
  )
}

export type AgreementsViewProps = {
  rows: LpAgreementRow[]
  kinds?: readonly string[] // the tab's kinds: the rows shown, and what Propose agreement offers
  targets?: ProposeTarget[]
  templates?: TemplateRow[] // a licence provider's templates, as starting documents
  onChanged?: () => void
  fetcher?: typeof fetch
  auditRequirements?: boolean
  csvName?: string
  empty?: string
  // What a tab adds to an agreement's detail (an SLA's Commitments and Breaches) and its actions.
  detailTabs?: (row: LpAgreementRow) => DetailTable[]
  detailActions?: (row: LpAgreementRow) => React.ReactNode
  toolbarExtra?: React.ReactNode
  ctaLabel?: string // the tab's own: Propose agreement, Propose MSA, Propose SLA
}

export function LpAgreementsView({
  rows,
  kinds = TAB_KINDS.business,
  targets = [],
  templates = [],
  onChanged = () => undefined,
  fetcher,
  auditRequirements = true,
  csvName = "business-agreements.csv",
  empty = "No agreements yet. They appear here once either side proposes one: a developer to a firm sponsoring its apps' products, or a licence provider to a workspace building on them.",
  detailTabs,
  detailActions,
  toolbarExtra = null,
  ctaLabel = "Propose agreement",
}: AgreementsViewProps) {
  const [requiring, setRequiring] = useState<LpAgreementRow | null>(null)
  const [f, setF] = useState<AgreementFilters>(NO_AGREEMENT_FILTERS)
  const [reviewing, setReviewing] = useState<LpAgreementRow | null>(null)
  const [acting, setActing] = useState<{ action: AgreementAction; row: LpAgreementRow } | null>(null)
  const [proposing, setProposing] = useState(false)
  // Sign on a program agreement signed by e-signature: the signer's embedded signing page instead of the manual sheet.
  const [signing, setSigning] = useState<string | null>(null)
  const mine = useMemo(() => rows.filter((r) => kinds.includes(r.kindKey)), [rows, kinds])
  const shown = useMemo(() => filterLpAgreements(mine, f), [mine, f])
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const waiting = mine.filter((r) => r.actions.includes("accept") || r.actions.includes("sign")).length
  const bothSides = new Set(mine.map((r) => r.side)).size > 1
  const set = (patch: Partial<AgreementFilters>) => {
    setF({ ...f, ...patch })
    setPage(1)
  }
  const act = (row: LpAgreementRow) => (action: AgreementAction) => {
    setReviewing(null)
    if (action === "sign" && row.esign?.byEsign) setSigning(row.id)
    else setActing({ action, row })
  }
  const facets: Facet[] = [
    { id: "status", label: "Status", options: LP_STATUS_FILTERS.map((s) => ({ value: s, label: STATUS_WORD[s] })), selected: picksOf(f.status), onChange: (v) => set({ status: v }) },
    ...(kinds.length > 1 ? [{ id: "kind", label: "Kind", options: kinds.map((k) => ({ value: k, label: AGREEMENT_KIND_LABELS[k] ?? k })), selected: picksOf(f.kind), onChange: (v: string[]) => set({ kind: v }) }] : []),
    ...(bothSides ? [{ id: "side", label: "Your side", options: (["counterparty", "app"] as const).map((s) => ({ value: s, label: SIDE_WORD[s] })), selected: picksOf(f.side), onChange: (v: string[]) => set({ side: v }) }] : []),
  ]
  const live = reviewing ? (mine.find((r) => rowKey(r) === rowKey(reviewing)) ?? reviewing) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-lp-agreements data-agreement-kinds={kinds.join(" ")}>
      {waiting > 0 && (
        <p className="text-sm" data-lp-waiting>
          {waiting} agreement{waiting === 1 ? "" : "s"} wait{waiting === 1 ? "s" : ""} for you: accept or decline a proposal the other side made, or sign one that was accepted.
        </p>
      )}
      <div className={TOOLBAR_ROW} data-toolbar>
        <ListSearch value={f.query} onChange={(v) => set({ query: v })} placeholder="Search app, party, kind or product" label="Search agreements" />
        <FiltersPopover facets={facets} onClear={() => set({ status: [], kind: [], side: [] })} />
        <DateRangeFilter label="Proposed" from={f.from} to={f.to} onChange={(from, to) => set({ from, to })} />
        <ImportButton note={AGREEMENTS_IMPORT_NOTE} />
        <Button variant="outline" onClick={() => downloadCsv(csvName, lpAgreementsCsv(shown))} disabled={!shown.length} data-export>
          <Download />
          Export CSV
        </Button>
        {toolbarExtra}
        {targets.length > 0 && (
          <Button onClick={() => setProposing(true)} data-propose-agreement>
            <FilePlus2 />
            {ctaLabel}
          </Button>
        )}
      </div>
      <div className="min-h-64 flex-1 overflow-auto rounded-lg border" data-table-view>
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Other party</TableHead>
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
                <TableRow key={rowKey(r)} data-lp-agreement={r.id} data-side={r.side} data-status={r.statusKey} className="cursor-pointer" onClick={() => setReviewing(r)}>
                  <TableCell className="font-medium whitespace-normal">{r.appName}</TableCell>
                  <TableCell className="whitespace-normal">
                    {otherParty(r)}
                    {bothSides && <div className="text-xs text-muted-foreground">{SIDE_WORD[r.side]}</div>}
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal">{r.products.join(", ") || "—"}</TableCell>
                  <TableCell>{r.kind}</TableCell>
                  <TableCell className="whitespace-normal">
                    {r.status}
                    {r.signatures && <div className="text-xs text-muted-foreground">{r.signatures}</div>}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap tabular-nums">{dates(r.from, r.to)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    {r.documentUrl ? (
                      <a href={r.documentUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline-offset-4 hover:underline" data-lp-document={r.id}>
                        Document
                      </a>
                    ) : (
                      <span className="text-xs text-muted-foreground">None</span>
                    )}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
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
                  {mine.length ? "No agreements match these filters." : empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <ListPager page={page} pages={pages} total={shown.length} onPage={setPage} />
      <Sheet open={live !== null} onOpenChange={(o) => !o && setReviewing(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" data-review-sheet>
          <SheetHeader>
            <SheetTitle>Review agreement</SheetTitle>
            <SheetDescription>{live ? summaryOf(live).title : ""}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">{live && <ReviewAgreementView row={live} onAction={act(live)} extraTabs={detailTabs?.(live)} extraActions={detailActions?.(live)} />}</div>
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
        url={acting ? actionUrl(acting.row) : ""}
        action={acting?.action ?? null}
        agreement={acting ? summaryOf(acting.row) : null}
        onClose={() => setActing(null)}
        onDone={onChanged}
        fetcher={fetcher}
      />
      {targets.length > 0 && <ProposeSheet targets={targets} kinds={kinds} templates={templates} open={proposing} onClose={() => setProposing(false)} onDone={onChanged} fetcher={fetcher} />}
    </div>
  )
}

/** The agreement tabs' data (/api/agreements). */
export type AgreementsData = { agreements: LpAgreementRow[]; targets: ProposeTarget[] }
export const pickAgreements = (body: Record<string, unknown>): AgreementsData | undefined =>
  Array.isArray(body.agreements) ? { agreements: body.agreements as LpAgreementRow[], targets: Array.isArray(body.targets) ? (body.targets as ProposeTarget[]) : [] } : undefined
