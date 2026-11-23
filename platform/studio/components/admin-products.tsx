"use client"

// Admin → Products: every financial product across firms (list_all_products), archived ones included: the firm that
// owns it (none: one of Mynt's reference products), its line and region, stage, status and its sponsors (licence
// providers' sponsorships, approved or pending). Read-only: unpublishing a product stays with the MCP tool
// (admin_set_product_status). Server-renderable.
import { useCallback, useMemo, useState } from "react"

import { AdminList, AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StageMark } from "@/components/promotion-view"
import { csvOf, dateOf, words, type AdminProduct } from "@/lib/admin"
import { STAGE_LABELS, STAGES, type Stage } from "@/lib/workspaces"

const sponsorsOf = (p: AdminProduct) => p.sponsors.map((s) => (s.status === "pending" ? `${s.name} (pending)` : s.name)).join(", ")

export function ProductsListView({ products, total }: { products: AdminProduct[]; total: number }) {
  const [query, setQuery] = useState("")
  const [stage, setStage] = useState<string[]>([])
  const [status, setStatus] = useState<string[]>([])
  const [archived, setArchived] = useState<string[]>([])
  const shown = useMemo(
    () =>
      products.filter(
        (p) =>
          matches(query, p.name, p.id, p.firm?.name, p.productLine, p.region, sponsorsOf(p)) &&
          (!stage.length || stage.includes(p.stage)) &&
          (!status.length || status.includes(p.status)) &&
          (!archived.length || archived.includes(p.archived ? "archived" : "current")),
      ),
    [products, query, stage, status, archived],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const exportCsv = () =>
    downloadCsv(
      "products.csv",
      csvOf(
        ["Product", "Id", "Firm", "Line", "Region", "Stage", "Status", "Archived", "Sponsors", "Created"],
        shown.map((p) => [p.name, p.id, p.firm?.name ?? "Mynt reference", p.productLine ?? "", p.region ?? "", p.stage, p.status, p.archived ? "yes" : "no", sponsorsOf(p), dateOf(p.createdAt)]),
      ),
    )
  return (
    <AdminList
      id="products"
      search={query}
      onSearch={(q) => (setQuery(q), setPage(1))}
      searchLabel="Search products by name, id, firm, line, region or sponsor"
      facets={[
        { id: "stage", label: "Stage", options: STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] })), selected: stage, onChange: (v) => (setStage(v), setPage(1)) },
        { id: "status", label: "Status", options: ["draft", "published", "unpublished"].map((s) => ({ value: s, label: words(s) })), selected: status, onChange: (v) => (setStatus(v), setPage(1)) },
        { id: "archived", label: "Archived", options: [{ value: "current", label: "Not archived" }, { value: "archived", label: "Archived" }], selected: archived, onChange: (v) => (setArchived(v), setPage(1)) },
      ]}
      onClearFilters={() => (setStage([]), setStatus([]), setArchived([]))}
      onExport={exportCsv}
      exportDisabled={!shown.length}
      note={total > products.length ? `The newest ${products.length} of ${total} products are loaded.` : null}
      page={page}
      pages={pages}
      total={shown.length}
      onPage={setPage}
    >
      <AdminTable
        head={["Product", "Firm", "Line", "Region", "Stage", "Status", "Archived", "Sponsors", "Created"]}
        rowKeys={onPage.map((p) => p.id)}
        rows={onPage.map((p) => [
          <span key="n" className="flex flex-col">
            {p.name}
            <code className="text-xs text-muted-foreground">{p.id}</code>
          </span>,
          p.firm?.name ?? "Mynt reference",
          words(p.productLine),
          p.region ?? "—",
          <StageMark key="s" stage={p.stage as Stage} />,
          words(p.status),
          p.archived ? "Archived" : "—",
          sponsorsOf(p) || "None",
          dateOf(p.createdAt),
        ])}
        empty={products.length ? "No products match these filters." : "No financial products yet."}
      />
    </AdminList>
  )
}

export function ProductsTab() {
  const pick = useCallback((b: Record<string, unknown>) => (Array.isArray(b.products) ? { rows: b.products as AdminProduct[], total: Number(b.total ?? b.products.length) } : undefined), [])
  const { state } = useAdminData("/api/admin/products", pick)
  return state.kind === "ready" ? <ProductsListView products={state.data.rows} total={state.data.total} /> : <AdminNotReady state={state} what="Products" />
}
