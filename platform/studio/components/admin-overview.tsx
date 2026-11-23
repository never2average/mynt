"use client"

// Admin → Overview (ops_status): what needs attention across Mynt first, in Mynt's own words; then this month's spend
// per agent (an agent this server doesn't run is "Not measured", never $0), the agents' failures and stuck runs in
// the window, and each area's readings (hosting, vendors, Solana, product health, covenants, workspaces, agreements,
// backups). Read-only: acting on a line happens in its tab, or with the MCP tool it names. Server-renderable.
import { AlertTriangle, CheckCircle2 } from "lucide-react"
import { useCallback } from "react"

import { AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { KpiRow } from "@/components/charts"
import { Panel, Section } from "@/components/dashboard-panels"
import { NOT_MEASURED, type Ops } from "@/lib/admin"
import type { Kpi } from "@/lib/dashboard-visual"
import { money } from "@/lib/pnl"

export function opsKpis(ops: Ops): Kpi[] {
  return ops.agents.map((a) => ({ key: a.name, label: a.label, value: a.spend === null ? null : Math.round(a.spend * 100), unit: "money", delta: null, spark: null, note: a.measured ? "Spend this month" : "Not run on this server" }))
}

export function OverviewView({ ops }: { ops: Ops }) {
  return (
    <div className="flex flex-col gap-4 lg:gap-5" data-admin-overview>
      <Panel id="admin-attention">
        <Section id="attention" title="What needs attention" description={`Across every workspace and firm, over the last ${ops.windowHours} hours.`}>
          {ops.quiet ? (
            <p className="flex items-center gap-2 py-2 text-sm" data-attention="none">
              <CheckCircle2 className="size-4 text-emerald-600" />
              Nothing needs attention
            </p>
          ) : (
            <ul className="flex flex-col gap-2 py-1" data-attention-list>
              {ops.attention.map((line, i) => (
                <li key={i} className="flex items-start gap-2 text-sm" data-attention-line>
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </Panel>
      <Panel id="admin-spend">
        <KpiRow kpis={opsKpis(ops)} />
      </Panel>
      <Panel id="admin-agents">
        <Section id="agents" title="Agents" description="Failed runs and runs going too long, in the window; spend this calendar month.">
          <div className="overflow-x-auto rounded-lg border">
            <AdminTable
              head={["Agent", "Failed", "Running too long", "Spend this month"]}
              rowKeys={ops.agents.map((a) => a.name)}
              rows={ops.agents.map((a) => [a.label, a.measured ? String(a.failed) : NOT_MEASURED, a.measured ? String(a.stuck) : NOT_MEASURED, money(a.spend === null ? null : Math.round(a.spend * 100))])}
              empty="No agents."
            />
          </div>
        </Section>
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-5">
        {ops.sections.map((s) => (
          <Panel id={`admin-${s.id}`} key={s.id}>
            <Section id={s.id} title={s.title}>
              <div className="overflow-x-auto rounded-lg border">
                <AdminTable head={["Reading", "Value"]} rows={s.rows.map((r) => [r.label, r.value])} empty={NOT_MEASURED} />
              </div>
            </Section>
          </Panel>
        ))}
      </div>
    </div>
  )
}

export function OverviewTab() {
  const pick = useCallback((b: Record<string, unknown>) => (b.ops as Ops | undefined) ?? undefined, [])
  const { state } = useAdminData("/api/admin/overview", pick)
  return state.kind === "ready" ? <OverviewView ops={state.data} /> : <AdminNotReady state={state} what="The overview" />
}
