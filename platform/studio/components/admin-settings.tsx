"use client"

// Admin → Platform settings: Mynt's own settings, not a workspace's. E-signature (moved here from workspace Settings:
// the key, the webhook and test mode, components/esign-settings-view.tsx), then the operational settings this server
// runs with (get_platform_settings), read-only: prices, budgets and the build audit are changed on the server, never
// from the studio, and no secret is ever listed. Server-renderable.
import { useCallback } from "react"

import { AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { Panel, Section } from "@/components/dashboard-panels"
import { EsignSettingsPanel } from "@/components/esign-settings-view"
import type { PlatformSetting } from "@/lib/admin"

export function OperationalSettingsView({ settings }: { settings: PlatformSetting[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border" data-operational-settings>
      <AdminTable
        head={["Setting", "Value", "Default", "Set by", "What it is"]}
        rowKeys={settings.map((s) => s.key)}
        rows={settings.map((s) => [<code key="k" className="text-xs">{s.key}</code>, s.value, s.default, s.source === "environment" ? "The server's environment" : "Mynt's default", s.description])}
        empty="No settings."
      />
    </div>
  )
}

export function SettingsTab() {
  const pick = useCallback((b: Record<string, unknown>) => (Array.isArray(b.settings) ? (b.settings as PlatformSetting[]) : undefined), [])
  const { state } = useAdminData("/api/admin/settings", pick)
  return (
    <div className="flex flex-col gap-4 lg:gap-5" data-admin-settings>
      <Panel id="admin-esign">
        <EsignSettingsPanel />
      </Panel>
      <Panel id="admin-operational">
        <Section id="operational" title="Operational settings" description="What this server runs with. Read-only here: they're changed on the server itself.">
          {state.kind === "ready" ? <OperationalSettingsView settings={state.data} /> : <AdminNotReady state={state} what="Operational settings" />}
        </Section>
      </Panel>
    </div>
  )
}
