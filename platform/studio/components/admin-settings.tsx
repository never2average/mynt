"use client"

// Platform admin → Platform settings (/platform/settings): Mynt's own settings, not a workspace's. Four tabs, the tab
// in the address (?tab=…), each ONE table filling the page under one toolbar, like every other /platform list:
// - Key vault: every key Mynt's own server uses (components/admin-key-vault.tsx); never a value,
// - Operational settings: the non-secret settings this server runs with (components/admin-operational-settings.tsx),
// - E-signature: the service, its key, mode and webhook, as rows (components/esign-settings-view.tsx),
// - Risk grading: how every risk is graded, as rows (components/admin-risk-grading.tsx).
// Tabs only show; every change is a labelled button opening a sheet.
import { KeyVaultTab } from "@/components/admin-key-vault"
import { OperationalSettingsTab } from "@/components/admin-operational-settings"
import { RiskGradingSection } from "@/components/admin-risk-grading"
import { EsignSettingsPanel } from "@/components/esign-settings-view"
import { Tab, TabList } from "@/components/ui/tabs"
import { SETTINGS_TAB_LABELS, SETTINGS_TABS, type SettingsTabId } from "@/lib/platform-settings"

export { OperationalSettingsView } from "@/components/admin-operational-settings"

/** The page's tab bar. */
export function SettingsTabs({ tab, onTab }: { tab: SettingsTabId; onTab: (t: SettingsTabId) => void }) {
  return (
    <TabList aria-label="Platform settings">
      {SETTINGS_TABS.map((t) => (
        <Tab key={t} selected={tab === t} onClick={() => onTab(t)} data-settings-tab={t}>
          {SETTINGS_TAB_LABELS[t]}
        </Tab>
      ))}
    </TabList>
  )
}

export function SettingsTab({ tab = "keys", onTab = () => undefined }: { tab?: SettingsTabId; onTab?: (t: SettingsTabId) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-admin-settings data-view={tab}>
      <SettingsTabs tab={tab} onTab={onTab} />
      {tab === "keys" && <KeyVaultTab />}
      {tab === "operational" && <OperationalSettingsTab />}
      {tab === "esign" && <EsignSettingsPanel />}
      {tab === "risk-grading" && <RiskGradingSection />}
    </div>
  )
}
