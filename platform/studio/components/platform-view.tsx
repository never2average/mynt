"use client"

// One section of the platform admin (/platform/<section>, /platform/<section>/<id>), for Mynt's own staff: across all
// workspaces and firms, never a workspace picked in the studio. Overview, Workspaces, Apps, Products, Firms, Licences,
// Vendors and Platform settings, each its own page in the platform admin's sidebar (components/platform-shell.tsx).
// Each is a read view; its changes are labelled buttons opening sheets. A row's Open goes to /platform/<section>/<id>,
// and Back to the section. The pages themselves are served only to Mynt admins (app/(platform) answers 404 to anyone else).
import { useRouter } from "next/navigation"

import { AppsTab } from "@/components/admin-apps"
import { FirmsTab } from "@/components/admin-firms"
import { LicencesTab } from "@/components/admin-licences"
import { OverviewTab } from "@/components/admin-overview"
import { ProductsTab } from "@/components/admin-products"
import { SettingsTab } from "@/components/admin-settings"
import { VendorsTab } from "@/components/admin-vendors"
import { WorkspacesTab } from "@/components/admin-workspaces"
import { adminHref, type AdminTab } from "@/lib/admin"

export function PlatformSection({ tab, id }: { tab: AdminTab; id: string | null }) {
  const router = useRouter()
  const open = (t: AdminTab) => (next: string) => router.push(adminHref(t, next))
  const back = (t: AdminTab) => () => router.push(adminHref(t))
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-admin-page data-platform-section={tab}>
      <div className="@container/main flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
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
