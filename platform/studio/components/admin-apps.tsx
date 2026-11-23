"use client"

// Admin → Apps: every app across all workspaces (list_all_apps). A row's Open shows the app (admin_get_app): its
// metadata card, then Builds, Hosting and Products, each a table. Remove test app (remove_app) is the one action: its
// sheet first asks Mynt what would go (a dry run, nothing removed), then removes it with a reason for the audit log.
// Mynt refuses anything published, hosted, holding live customer data or money movements, or on mainnet, and its
// reasons are shown as they are. Server-renderable.
import { useCallback, useEffect, useMemo, useState } from "react"
import { Trash2 } from "lucide-react"

import { AdminDetail, AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StageMark, StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { csvOf, dateOf, whenOf, words, type AdminApp, type AppDetail, type Removal } from "@/lib/admin"
import { money } from "@/lib/pnl"
import { STAGE_LABELS, STAGES, type Stage } from "@/lib/workspaces"

const hostedWords = (h: AdminApp["hosting"]) => (h ? words(h.status) : "Not hosted")
const buildWords = (b: AdminApp["latestBuild"]) => (b ? `${words(b.status)} · ${dateOf(b.createdAt)}` : "No builds")

export function AppsListView({ apps, total, onOpen }: { apps: AdminApp[]; total: number; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("")
  const [stage, setStage] = useState<string[]>([])
  const [hosted, setHosted] = useState<string[]>([])
  const shown = useMemo(
    () =>
      apps.filter(
        (a) =>
          matches(query, a.name, a.workspace?.name, a.owner?.email, a.owner?.name, a.id, ...a.productIds) &&
          (!stage.length || stage.includes(a.stage)) &&
          (!hosted.length || hosted.includes(a.hosting ? "hosted" : "not_hosted")),
      ),
    [apps, query, stage, hosted],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const exportCsv = () =>
    downloadCsv(
      "apps.csv",
      csvOf(
        ["App", "Workspace", "Owner", "Stage", "Status", "Latest build", "Hosted", "Products", "Created", "Id"],
        shown.map((a) => [a.name, a.workspace?.name ?? "", a.owner?.email ?? "", a.stage, a.status, a.latestBuild?.status ?? "", a.hosting?.status ?? "", a.productIds.join(" "), dateOf(a.createdAt), a.id]),
      ),
    )
  return (
    <AdminList
      id="apps"
      search={query}
      onSearch={(q) => (setQuery(q), setPage(1))}
      searchLabel="Search apps by name, workspace, owner, product or id"
      facets={[
        { id: "stage", label: "Stage", options: STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] })), selected: stage, onChange: (v) => (setStage(v), setPage(1)) },
        { id: "hosted", label: "Hosting", options: [{ value: "hosted", label: "Hosted on Mynt" }, { value: "not_hosted", label: "Not hosted" }], selected: hosted, onChange: (v) => (setHosted(v), setPage(1)) },
      ]}
      onClearFilters={() => (setStage([]), setHosted([]))}
      onExport={exportCsv}
      exportDisabled={!shown.length}
      note={total > apps.length ? `The newest ${apps.length} of ${total} apps are loaded.` : null}
      page={page}
      pages={pages}
      total={shown.length}
      onPage={setPage}
    >
      <AdminTable
        head={["App", "Workspace", "Owner", "Stage", "Latest build", "Hosting", "Products", "Created", ""]}
        rowKeys={onPage.map((a) => a.id)}
        rows={onPage.map((a) => [
          a.name,
          a.workspace?.name ?? "—",
          a.owner?.email ?? a.owner?.name ?? "—",
          <StageMark key="s" stage={a.stage as Stage} />,
          buildWords(a.latestBuild),
          hostedWords(a.hosting),
          String(a.productIds.length),
          dateOf(a.createdAt),
          <Button key="o" size="sm" variant="outline" onClick={() => onOpen(a.id)} data-open-app={a.id}>
            Open
          </Button>,
        ])}
        empty={apps.length ? "No apps match these filters." : "No apps yet."}
      />
    </AdminList>
  )
}

/** Remove test app: Check what would go (a dry run), then Remove app with a reason. */
export function RemoveAppSheet({ app, open, onClose, onRemoved, fetcher = (...a) => fetch(...a) }: { app: AdminApp; open: boolean; onClose: () => void; onRemoved: () => void; fetcher?: typeof fetch }) {
  const [plan, setPlan] = useState<Removal | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setPlan(null)
    setReason("")
    setError(null)
    setResult(null)
  }, [open])
  const send = async (confirm: boolean) => {
    setBusy(true)
    setError(null)
    const res = await fetcher(`/api/admin/apps/${encodeURIComponent(app.id)}/remove`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirm ? { confirm, reason: reason.trim() } : { confirm }) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { removal?: Removal; message?: string } | null
    setBusy(false)
    if (body?.removal) {
      setPlan(body.removal)
      if (body.removal.kind === "removed") {
        setResult(`${app.name} is removed. The removal is in the audit log.`)
        onRemoved()
      }
      return
    }
    setError(body?.message ?? "Couldn't reach Mynt. Please try again.")
  }
  return (
    <AdminSheet id="remove-app" open={open} onClose={onClose} title="Remove test app" description={`Removes ${app.name} and everything that references it, for an app that never went live. Nothing is removed until you confirm.`} error={error} result={result}>
      {!plan && (
        <div>
          <Button variant="outline" disabled={busy} onClick={() => void send(false)} data-remove-check>
            {busy ? "Checking…" : "Check what would go"}
          </Button>
        </div>
      )}
      {plan?.kind === "refused" && (
        <div className="flex flex-col gap-2" data-remove-refused>
          <p className="text-sm font-medium">Mynt won&apos;t remove this app:</p>
          <ul className="list-disc pl-5 text-sm">
            {plan.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {plan?.kind === "plan" && (
        <form
          className="flex flex-col gap-3"
          data-remove-plan
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim().length >= 3) void send(true)
          }}
        >
          <p className="text-sm">
            What would go: {plan.builds} build(s), {plan.programs} Solana program(s), and these rows:
          </p>
          <div className="rounded-lg border">
            <AdminTable head={["Table", "Rows"]} rows={plan.rows.map(([t, n]) => [<code key="t" className="text-xs">{t}</code>, String(n)])} empty="Only the app itself." />
          </div>
          <Field label="Reason, for the audit log">
            <textarea className={`${fieldClass} min-h-20`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required data-remove-reason />
          </Field>
          <div>
            <Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 3} data-remove-confirm>
              {busy ? "Removing…" : "Remove app"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

type DetailTab = "builds" | "hosting" | "products"
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "builds", label: "Builds" },
  { id: "hosting", label: "Hosting" },
  { id: "products", label: "Products" },
]

export function AppDetailView({ detail, onBack, onRemoved, initialTab = "builds", sheetOpen = false }: { detail: AppDetail; onBack: () => void; onRemoved: () => void; initialTab?: DetailTab; sheetOpen?: boolean }) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [removing, setRemoving] = useState(sheetOpen)
  const [removed, setRemoved] = useState(false)
  const a = detail["app"]
  return (
    <>
      <AdminDetail
        backLabel="Back to apps"
        onBack={onBack}
        title={a.name}
        subtitle={a.workspace?.name ? `In ${a.workspace.name}` : null}
        fields={[
          ["Stage", <StageMark key="s" stage={a.stage as Stage} />],
          ["Status", words(a.status)],
          ["Owner", a.owner?.email ?? a.owner?.name ?? "—"],
          ["Hosting", hostedWords(a.hosting)],
          ["Builds", a.builds === null ? "Not measured" : String(a.builds)],
          ["Created", dateOf(a.createdAt)],
          ["Id", <code key="i" className="text-xs">{a.id}</code>],
        ]}
        actions={
          <Button variant="destructive" size="sm" onClick={() => setRemoving(true)} data-remove-app>
            <Trash2 />
            Remove test app
          </Button>
        }
        tabs={DETAIL_TABS}
        tab={tab}
        onTab={setTab}
      >
        {tab === "builds" &&
          (detail.builds === null ? (
            <p className="p-4 text-sm text-muted-foreground">This Mynt runs no coding agents, so there are no builds to show.</p>
          ) : (
            <AdminTable
              head={["Started", "Status", "Goal", "Cost", "Finished", "Error"]}
              rowKeys={detail.builds.map((b) => b.id)}
              rows={detail.builds.map((b) => [whenOf(b.createdAt), words(b.status), b.goal, money(b.costUsd === null ? null : Math.round(b.costUsd * 100)), whenOf(b.finishedAt), b.error ?? "—"])}
              empty="No builds yet."
            />
          ))}
        {tab === "hosting" && (
          <AdminTable
            head={["Status", "Runtime", "Last error", "Updated"]}
            rows={detail.hosting ? [[<StatusDot key="h" tone={detail.hosting.status === "running" ? "green" : detail.hosting.status === "stopped" ? "red" : "amber"} label={words(detail.hosting.status)} />, detail.hosting.runtime ?? "—", detail.hosting.error ?? "—", whenOf(detail.hosting.updatedAt)]] : []}
            empty="Not hosted on Mynt."
          />
        )}
        {tab === "products" && <AdminTable head={["Product", "Id"]} rowKeys={detail.products.map((p) => p.id)} rows={detail.products.map((p) => [p.name ?? p.id, <code key="i" className="text-xs">{p.id}</code>])} empty="No products." />}
      </AdminDetail>
      <RemoveAppSheet
        app={a}
        open={removing}
        onClose={() => {
          setRemoving(false)
          // Removed: back to the list once its answer has been read.
          if (removed) onRemoved()
        }}
        onRemoved={() => setRemoved(true)}
      />
    </>
  )
}

export function AppsTab({ id, onOpen, onBack }: { id: string | null; onOpen: (id: string) => void; onBack: () => void }) {
  const pickList = useCallback((b: Record<string, unknown>) => (Array.isArray(b.apps) ? { rows: b.apps as AdminApp[], total: Number(b.total ?? b.apps.length) } : undefined), [])
  const pickOne = useCallback((b: Record<string, unknown>) => (b.detail as AppDetail | undefined) ?? undefined, [])
  const list = useAdminData(id ? null : "/api/admin/apps", pickList)
  const one = useAdminData(id ? `/api/admin/apps/${encodeURIComponent(id)}` : null, pickOne)
  if (id) return one.state.kind === "ready" ? <AppDetailView detail={one.state.data} onBack={onBack} onRemoved={onBack} /> : <AdminNotReady state={one.state} what="This app" />
  return list.state.kind === "ready" ? <AppsListView apps={list.state.data.rows} total={list.state.data.total} onOpen={onOpen} /> : <AdminNotReady state={list.state} what="Apps" />
}
