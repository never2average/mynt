"use client"

// One section of the platform admin (/platform/<section>, /platform/<section>/<id>), for Mynt's own staff: across all
// workspaces and firms, never a workspace picked in the studio. Overview, Workspaces, Firms, Licences, Vendors, Audit
// trails, Risk models, Risk register and Platform settings, each its own page in the platform admin's sidebar
// (components/platform-shell.tsx). There is no Apps, People or Products section: people are each firm's and
// workspace's Members, and products each firm's Products tab. Each is a read view; its changes are labelled buttons
// opening sheets. A row's Open goes to /platform/<section>/<id>, and Back to the section. The pages themselves are
// served only to Mynt admins (app/(platform) answers 404 to anyone else).
import { useRouter, useSearchParams } from "next/navigation"

import { AuditTab } from "@/components/admin-audit"
import { FIRM_DETAIL_TABS, FirmsTab, type FirmDetailTab } from "@/components/admin-firms"
import { LicencesTab } from "@/components/admin-licences"
import { OverviewTab } from "@/components/admin-overview"
import { RiskModelsTab } from "@/components/admin-risk-models"
import { RiskRegisterTab } from "@/components/admin-risk-register"
import { SettingsTab } from "@/components/admin-settings"
import { VendorsTab } from "@/components/admin-vendors"
import { WorkspacesTab } from "@/components/admin-workspaces"
import { adminHref, type AdminTab } from "@/lib/admin"

export function PlatformSection({ tab, id }: { tab: AdminTab; id: string | null }) {
  const router = useRouter()
  const query = useSearchParams()
  const open = (t: AdminTab) => (next: string) => router.push(adminHref(t, next))
  const back = (t: AdminTab) => () => router.push(adminHref(t))
  // A firm's page opens on the tab its address names (/platform/firms/<id>?tab=products), Members otherwise.
  const firmTab = FIRM_DETAIL_TABS.find((t) => t === query?.get("tab")) as FirmDetailTab | undefined
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-admin-page data-platform-section={tab}>
      <div className="@container/main flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        {tab === "overview" && <OverviewTab />}
        {tab === "workspaces" && <WorkspacesTab id={id} onOpen={open("workspaces")} onBack={back("workspaces")} />}
        {tab === "firms" && <FirmsTab id={id} onOpen={open("firms")} onBack={back("firms")} initialTab={firmTab} />}
        {tab === "licences" && <LicencesTab />}
        {tab === "vendors" && <VendorsTab />}
        {tab === "audit" && <AuditTab id={id} onOpen={open("audit")} onBack={back("audit")} />}
        {tab === "risk-models" && <RiskModelsTab id={id} onOpen={open("risk-models")} onBack={back("risk-models")} />}
        {tab === "risk-register" && <RiskRegisterTab />}
        {tab === "settings" && <SettingsTab />}
      </div>
    </div>
  )
}
