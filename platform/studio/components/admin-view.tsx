"use client"

// The Admin area (/admin?tab=…&id=…), for Mynt's own staff: across all workspaces and firms, never the workspace the
// sidebar has picked. A page-level tab bar (lib/admin.ts ADMIN_TABS): Overview, Workspaces, Apps, Products, Firms,
// Licences, Vendors and Platform settings. Each tab is a read view; its changes are labelled buttons opening sheets.
// A row's Open puts its id in the address (&id=), and Back takes it out. The page itself is served only to Mynt admins
// (app/(studio)/admin/page.tsx answers 404 to anyone else).
import { useCallback, useEffect, useState } from "react"

import { AppsTab } from "@/components/admin-apps"
import { FirmsTab } from "@/components/admin-firms"
import { LicencesTab } from "@/components/admin-licences"
import { OverviewTab } from "@/components/admin-overview"
import { ProductsTab } from "@/components/admin-products"
import { SettingsTab } from "@/components/admin-settings"
import { VendorsTab } from "@/components/admin-vendors"
import { WorkspacesTab } from "@/components/admin-workspaces"
import { Tab, TabList } from "@/components/ui/tabs"
import { ADMIN_TAB_CHANGED, ADMIN_TAB_LABELS, ADMIN_TABS, adminHref, adminTabOf, type AdminTab } from "@/lib/admin"

export function AdminTabs({ tab, onTab }: { tab: AdminTab; onTab: (t: AdminTab) => void }) {
  return (
    <TabList aria-label="Admin">
      {ADMIN_TABS.map((t) => (
        <Tab key={t} selected={tab === t} data-admin-tab={t} onClick={() => onTab(t)}>
          {ADMIN_TAB_LABELS[t]}
        </Tab>
      ))}
    </TabList>
  )
}

export function AdminView({ initialTab, initialId = null }: { initialTab: AdminTab; initialId?: string | null }) {
  const [tab, setTab] = useState<AdminTab>(initialTab)
  const [id, setId] = useState<string | null>(initialId)
  const go = useCallback((t: AdminTab, next: string | null = null) => {
    setTab(t)
    setId(next)
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", adminHref(t, next ?? undefined))
      window.dispatchEvent(new Event(ADMIN_TAB_CHANGED))
    }
  }, [])
  // Back and Forward in the browser move between the tabs and details visited.
  useEffect(() => {
    const read = () => {
      const q = new URLSearchParams(window.location.search)
      setTab(adminTabOf(q.get("tab")))
      setId(q.get("id"))
    }
    window.addEventListener("popstate", read)
    return () => window.removeEventListener("popstate", read)
  }, [])
  const open = (t: AdminTab) => (next: string) => go(t, next)
  const back = (t: AdminTab) => () => go(t)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-admin-page>
      <div className="@container/main flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        <AdminTabs tab={tab} onTab={(t) => go(t)} />
        {tab === "overview" && <OverviewTab />}
        {tab === "workspaces" && <WorkspacesTab id={id} onOpen={open("workspaces")} onBack={back("workspaces")} onOpenApp={open("apps")} />}
        {tab === "apps" && <AppsTab id={id} onOpen={open("apps")} onBack={back("apps")} />}
        {tab === "products" && <ProductsTab />}
        {tab === "firms" && <FirmsTab id={id} onOpen={open("firms")} onBack={back("firms")} />}
        {tab === "licences" && <LicencesTab />}
        {tab === "vendors" && <VendorsTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </div>
  )
}
