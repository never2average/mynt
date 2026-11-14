"use client"

// Promotions: moving an app Ideas -> Staging -> Production is a screen with checks, never a drag.
// The app's top bar has the stage control (Promote to Staging / Promote to Production, and Move
// back for owners and admins); it opens this sheet, which lists each of Mynt's checks with a red,
// amber or green status, its detail and its fix, and a Promote button enabled only when Mynt says
// the app can move. Members see the checks and that an owner or admin promotes. The views are
// server-renderable, so the tests render them without a browser.
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { ArrowDownToLine, ArrowUpRight, ExternalLink, Rocket, ShieldCheck } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  CHECK_LABELS,
  CHECK_TONE,
  earlierStages,
  nextStage,
  STAGE_NAMES,
  type DemotionTarget,
  type PromotionCheck,
  type PromotionChecks,
  type PromotionTarget,
} from "@/lib/promotions"
import { cn } from "@/lib/utils"
import type { Stage } from "@/lib/workspaces"

const DOT: Record<"green" | "amber" | "red", string> = { green: "bg-emerald-500", amber: "bg-amber-500", red: "bg-red-500" }

export function StatusDot({ tone, label }: { tone: "green" | "amber" | "red"; label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium" data-tone={tone}>
      <span aria-hidden className={cn("size-2.5 rounded-full", DOT[tone])} />
      {label}
    </span>
  )
}

function Fix({ check }: { check: PromotionCheck }) {
  const fix = check.fix
  if (!fix) return null
  if (fix.href && fix.external)
    return (
      <Button asChild size="sm" variant="outline" data-fix={check.id}>
        <a href={fix.href} target="_blank" rel="noopener noreferrer">
          <ExternalLink />
          {fix.label}
        </a>
      </Button>
    )
  if (fix.href)
    return (
      <Button asChild size="sm" variant="outline" data-fix={check.id}>
        <Link href={fix.href}>
          <ArrowUpRight />
          {fix.label}
        </Link>
      </Button>
    )
  // A fix Mynt does with one of its tools, with no page to open: named, for the coding agent or
  // an owner to do.
  return (
    <span className="text-xs text-muted-foreground" data-fix={check.id}>
      To fix: {fix.label}
    </span>
  )
}

export type PromotionViewProps = {
  appName: string
  checks: PromotionChecks
  canChange: boolean // an owner or admin of the app's workspace
  signoffSupported: boolean
  busy?: boolean
  error?: string | null
  result?: string | null
  onPromote: () => void
  onRequestSignoff: () => void
}

const SIGNOFF_TEXT = {
  none: "Not requested yet.",
  requested: "Requested. A Mynt admin reviews it.",
  approved: "Approved.",
  rejected: "Rejected. Fix what the admin raised, then request it again.",
} as const

export function PromotionView({ appName, checks, canChange, signoffSupported, busy = false, error = null, result = null, onPromote, onRequestSignoff }: PromotionViewProps) {
  const to = STAGE_NAMES[checks.toStage]
  const failing = checks.checks.filter((c) => c.status === "fail").length
  const signoff = checks.signoff?.status ?? "none"
  const enabled = checks.canPromote && canChange && !busy
  return (
    <div className="flex flex-col gap-4" data-promotion-view>
      {checks.checks.length ? (
        <ul className="flex flex-col divide-y rounded-lg border" data-checks>
          {checks.checks.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 p-3" data-check={c.id} data-status={c.status}>
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium">{c.label}</span>
                <StatusDot tone={CHECK_TONE[c.status]} label={CHECK_LABELS[c.status]} />
              </div>
              {c.detail && <p className="text-sm text-muted-foreground">{c.detail}</p>}
              {c.fix && (
                <div>
                  <Fix check={c} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Mynt has no checks for moving {appName} to {to}.</p>
      )}

      {checks.needsAdminSignoff && (
        <div className="flex flex-col gap-2 rounded-lg border p-3" data-signoff={signoff}>
          <div className="flex items-center gap-2 font-medium">
            <ShieldCheck className="size-4" />
            Admin sign-off
          </div>
          <p className="text-sm text-muted-foreground">
            {to} needs a Mynt admin&apos;s sign-off. {SIGNOFF_TEXT[signoff]}
            {checks.signoff?.by ? ` By ${checks.signoff.by}.` : ""}
          </p>
          {canChange && signoffSupported && (signoff === "none" || signoff === "rejected") && (
            <div>
              <Button size="sm" variant="outline" onClick={onRequestSignoff} disabled={busy}>
                Request admin sign-off
              </Button>
            </div>
          )}
        </div>
      )}

      {!canChange && (
        <p className="text-sm text-muted-foreground" data-members-note>
          Only the workspace&apos;s owners and admins promote apps. You can see what&apos;s left to do here.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-promotion-result>
          {result}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Button onClick={onPromote} disabled={!enabled} data-promote>
          <Rocket />
          Promote to {to}
        </Button>
        {!checks.canPromote && (
          <p className="text-xs text-muted-foreground">
            {failing ? `${failing} check${failing === 1 ? "" : "s"} must pass first.` : checks.needsAdminSignoff && signoff !== "approved" ? "Waiting for admin sign-off." : "Not every check has passed yet."}
          </p>
        )}
      </div>
    </div>
  )
}

export function MoveBackForm({ appName, stage, busy = false, onMoveBack }: { appName: string; stage: Stage; busy?: boolean; onMoveBack: (to: DemotionTarget, reason: string) => void }) {
  const options = earlierStages(stage)
  const [to, setTo] = useState<DemotionTarget | undefined>(options[0])
  const [reason, setReason] = useState("")
  if (!to) return null
  return (
    <form
      className="flex flex-col gap-3"
      data-move-back
      onSubmit={(e) => {
        e.preventDefault()
        onMoveBack(to, reason)
      }}
    >
      <p className="text-sm text-muted-foreground">
        {appName} is in {STAGE_NAMES[stage]}. Moving it back is recorded in the audit trail with your reason.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Move back to
        <select
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          value={to}
          onChange={(e) => setTo(e.target.value as DemotionTarget)}
        >
          {options.map((s) => (
            <option key={s} value={s}>
              {STAGE_NAMES[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Reason
        <textarea
          className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
          required
        />
      </label>
      <div>
        <Button type="submit" variant="outline" disabled={busy || reason.trim().length < 3}>
          <ArrowDownToLine />
          Move back to {STAGE_NAMES[to]}
        </Button>
      </div>
    </form>
  )
}

type Meta = { supported: false } | { supported: true; app: { id: string; name: string; stage: Stage }; canChange: boolean; tools: { demote: boolean; signoff: boolean } }

// Refreshes the sidebar's folders and the app's own stage after a move.
const refreshApps = () => window.dispatchEvent(new Event("adorable:projects-updated"))

/** The app top bar's stage control and its sheet. Hidden (a quiet note) until Mynt has promotions. */
export function StageControl({ appId, appName, stage }: { appId: string; appName: string; stage: Stage }) {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [mode, setMode] = useState<"promote" | "demote" | null>(null)
  const [checks, setChecks] = useState<PromotionChecks | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [promoted, setPromoted] = useState(false)
  const base = `/api/apps/${encodeURIComponent(appId)}/promotion`
  const target = nextStage(stage)
  // The sheet keeps the stage it was opened at: after a move the app's stage changes under it,
  // and the sheet still shows what was done.
  const [sheetStage, setSheetStage] = useState<Stage>(stage)
  const sheetTarget = nextStage(sheetStage)

  useEffect(() => {
    let live = true
    void (async () => {
      const res = await fetch(base, { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as Meta | null
      if (live && res?.ok && body) setMeta(body)
    })()
    return () => {
      live = false
    }
  }, [base])

  const loadChecks = useCallback(
    async (to: PromotionTarget) => {
      setChecks(null)
      setLoadError(null)
      const res = await fetch(`${base}?to=${to}`, { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { checks?: PromotionChecks; message?: string } | null
      if (res?.ok && body?.checks) setChecks(body.checks)
      else setLoadError(body?.message ?? "Couldn't load the checks. Please try again.")
    },
    [base],
  )

  const open = (m: "promote" | "demote") => {
    setMode(m)
    setError(null)
    setResult(null)
    setPromoted(false)
    setSheetStage(stage)
    if (m === "promote" && target) void loadChecks(target)
  }

  const send = async (payload: Record<string, unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { message?: string; stage?: Stage } | null
    setBusy(false)
    if (!res?.ok) {
      setError(body?.message ?? "That didn't work. Please try again.")
      return
    }
    setResult(body?.message ?? "Done.")
    if (payload.action === "promote") setPromoted(true)
    refreshApps()
    if (payload.action === "request_signoff" && sheetTarget) void loadChecks(sheetTarget)
  }

  if (!meta) return null
  if (!meta.supported)
    return (
      <span className="hidden shrink-0 px-2 text-xs text-muted-foreground lg:inline" data-promotion="unavailable">
        Promotions aren&apos;t available yet
      </span>
    )
  const canMoveBack = meta.canChange && meta.tools.demote && earlierStages(stage).length > 0

  return (
    <>
      <div className="flex shrink-0 items-center gap-1" data-stage-control>
        {target && (
          <Button size="sm" variant="outline" className="h-7" onClick={() => open("promote")} data-open-promotion={target}>
            <Rocket />
            Promote to {STAGE_NAMES[target]}
          </Button>
        )}
        {canMoveBack && (
          <Button size="sm" variant="ghost" className="h-7" onClick={() => open("demote")} data-open-move-back>
            Move back
          </Button>
        )}
      </div>
      <Sheet open={mode !== null} onOpenChange={(o) => !o && setMode(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{mode === "demote" ? `Move ${appName} back` : sheetTarget ? `Promote ${appName} to ${STAGE_NAMES[sheetTarget]}` : appName}</SheetTitle>
            <SheetDescription>
              {mode === "demote"
                ? "Owners and admins can move an app back a stage."
                : `From ${STAGE_NAMES[sheetStage]}. Mynt checks the app before it moves; each check shows what to fix.`}
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {mode === "demote" ? (
              result ? (
                <p role="status" className="text-sm font-medium" data-promotion-result>
                  {result}
                </p>
              ) : (
                <>
                  <MoveBackForm appName={appName} stage={sheetStage} busy={busy} onMoveBack={(to, reason) => void send({ action: "demote", to_stage: to, reason })} />
                  {error && (
                    <p role="alert" className="mt-3 text-sm text-destructive">
                      {error}
                    </p>
                  )}
                </>
              )
            ) : loadError ? (
              <p role="alert" className="text-sm text-destructive">
                {loadError}
              </p>
            ) : checks ? (
              <PromotionView
                appName={appName}
                checks={checks}
                canChange={meta.canChange && !promoted}
                signoffSupported={meta.tools.signoff}
                busy={busy}
                error={error}
                result={result}
                onPromote={() => sheetTarget && void send({ action: "promote", to_stage: sheetTarget })}
                onRequestSignoff={() => void send({ action: "request_signoff" })}
              />
            ) : (
              <p className="text-sm text-muted-foreground">Checking {appName}…</p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
