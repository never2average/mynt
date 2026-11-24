"use client"

// Admin → Security & risk (/platform/risks), lib/admin-risks.ts: Mynt's own risk register (Add risk and Review risk,
// each a labelled button opening its sheet: components/risk-register.tsx, as an app's and a product's), then the
// platform's signals, each a table or "Not available." with why: what needs attention, security events in the last
// 30 days, open risks across apps and products (counts by level, the 20 highest scored, each linked to its
// workspace's or firm's page), agreements, vendors' failed conformance runs and backups. Server-renderable.
import Link from "next/link"
import { useCallback } from "react"

import { AdminNotReady, useAdminData } from "@/components/admin-kit"
import { RiskRegisterSection, SignalSection } from "@/components/risk-register"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AGREEMENT_COLUMNS,
  ATTENTION_COLUMNS,
  BACKUP_COLUMNS,
  levelWords,
  PLATFORM_SUBJECT,
  RISK_LEVELS,
  SECURITY_COLUMNS,
  SECURITY_DAYS,
  subjectWords,
  VENDOR_COLUMNS,
  type CrossRisks,
  type RisksData,
} from "@/lib/admin-risks"
import { RISK_STATUS_LABELS, type RiskStatus } from "@/lib/risk-register"

function CrossRisksSection({ data }: { data: CrossRisks }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-signal="cross-risks" aria-labelledby="signal-cross-risks">
      <h2 id="signal-cross-risks" className="text-sm font-semibold">
        Open risks on every register (apps, products and Mynt&apos;s own)
      </h2>
      {!data.available ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-not-available>
          Not available. {data.reason}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-6" data-risk-counts>
            {RISK_LEVELS.map((l) => (
              <div key={l} className="rounded-lg border p-3" data-risk-level={l}>
                <dt className="text-xs text-muted-foreground">{levelWords(l)}</dt>
                <dd className="text-lg font-semibold tabular-nums">{data.counts[l]}</dd>
              </div>
            ))}
            <div className="rounded-lg border p-3" data-risk-level="overdue">
              <dt className="text-xs text-muted-foreground">Overdue for review</dt>
              <dd className="text-lg font-semibold tabular-nums">{data.overdue}</dd>
            </div>
            <div className="rounded-lg border p-3" data-risk-level="total">
              <dt className="text-xs text-muted-foreground">Open in all</dt>
              <dd className="text-lg font-semibold tabular-nums">{data.total}</dd>
            </div>
          </dl>
          {data.risks.length ? (
            <div className="min-w-0 overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Risk</TableHead>
                    <TableHead>Where</TableHead>
                    <TableHead>Score</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Review by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.risks.map((r) => (
                    <TableRow key={r.id} data-cross-risk={r.id}>
                      <TableCell className="font-medium whitespace-normal">{r.title}</TableCell>
                      <TableCell className="whitespace-normal">
                        {r.href ? (
                          <Link href={r.href} className="underline underline-offset-2" data-risk-link={r.href}>
                            {subjectWords(r)}
                          </Link>
                        ) : (
                          subjectWords(r)
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {r.score} ({levelWords(r.level)})
                      </TableCell>
                      <TableCell>{RISK_STATUS_LABELS[r.status as RiskStatus] ?? r.status}</TableCell>
                      <TableCell className="text-xs tabular-nums">{r.reviewBy ? `${r.reviewBy}${r.overdue ? " (overdue)" : ""}` : "Not set"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="rounded-lg border px-4 py-4 text-sm text-muted-foreground" data-none>
              No open risks on any app's or product's register.
            </p>
          )}
        </>
      )}
    </section>
  )
}

export function RisksView({ data, onChanged }: { data: RisksData; onChanged?: () => void }) {
  const span = data.signals.windowHours ? `in the last ${data.signals.windowHours} hours` : "recently"
  return (
    <div className="flex min-w-0 flex-col gap-6" data-platform-risks>
      <RiskRegisterSection subject={PLATFORM_SUBJECT} data={data.register} onChanged={onChanged} />
      <SignalSection id="attention" title="What needs attention" description="Mynt's operations status, as the Overview shows it." columns={ATTENTION_COLUMNS} signal={data.signals.attention} empty="Nothing needs attention." />
      <SignalSection id="security" title={`Security events in the last ${SECURITY_DAYS} days`} description="Audit trail entries of the security class: build audits, the mainnet gate, secrets revealed or rotated, machine access, people cut off." columns={SECURITY_COLUMNS} signal={data.security} empty={`No security events in the last ${SECURITY_DAYS} days among the newest audit entries.`} />
      <CrossRisksSection data={data.cross} />
      <SignalSection id="agreements" title="Agreements" description="Production apps without a signed program agreement with a product's sponsor, and overdue oversight audits." columns={AGREEMENT_COLUMNS} signal={data.signals.agreements} empty="Every production app has its program agreements, and no oversight audit is overdue." />
      <SignalSection id="vendors" title="Vendor conformance" description={`Vendors' conformance runs that failed ${span}.`} columns={VENDOR_COLUMNS} signal={data.signals.vendors} empty={`No conformance run failed ${span}.`} />
      <SignalSection id="backups" title="Backups" description="The server's backups: the last run, the off-site copy and the last restore test." columns={BACKUP_COLUMNS} signal={data.signals.backups} empty="Nothing recorded." />
    </div>
  )
}

export function RisksTab() {
  const pick = useCallback((b: Record<string, unknown>) => (b.register && b.signals ? (b as unknown as RisksData) : undefined), [])
  const { state, reload } = useAdminData("/api/admin/risks", pick)
  return state.kind === "ready" ? <RisksView data={state.data} onChanged={reload} /> : <AdminNotReady state={state} what="Security & risk" />
}
