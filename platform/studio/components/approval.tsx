"use client"

// Approval, the same on all three Earn tabs: ApprovalStatus (a dot and its words: what a row waits
// on, with the reason in its tooltip), ApprovalSummary (an approval sheet's terms) and ApprovalSteps (where an approval stands: each step done,
// current, still to come, skipped, failed or declined; compact in a table cell, full in a sheet).
// Built from the studio's own StatusDot and lucide icons.
import { Check, Minus, X } from "lucide-react"

import { StatusDot, type DotTone } from "@/components/promotion-view"
import { cn } from "@/lib/utils"

export type ApprovalState = "needs-approval" | "needs-answer" | "sign" | "sending" | "done" | "declined" | "blocked" | "failed" | "waiting"

const TONE: Record<ApprovalState, DotTone> = { "needs-approval": "blue", "needs-answer": "blue", sign: "blue", sending: "gray", done: "green", declined: "gray", blocked: "amber", failed: "red", waiting: "amber" }
export const APPROVAL_LABELS: Record<ApprovalState, string> = {
  "needs-approval": "Needs your approval",
  "needs-answer": "Needs your answer",
  sign: "Sign in wallet",
  sending: "Sending…",
  done: "Done",
  declined: "Declined",
  blocked: "Can't be sent",
  failed: "Failed",
  waiting: "Waiting",
}

/** A row's approval status: a dot and its words (one line, cut short), the reason in its tooltip. */
export function ApprovalStatus({ state, label, reason, className, ...rest }: { state: ApprovalState; label?: string; reason?: string | null; className?: string } & Omit<React.HTMLAttributes<HTMLSpanElement>, "children">) {
  const text = label ?? APPROVAL_LABELS[state]
  return <StatusDot tone={TONE[state]} label={text} title={reason ?? text} className={cn("max-w-full min-w-0 overflow-hidden font-normal", state === "failed" && "text-destructive", className)} data-approval-status={state} {...rest} />
}

/** What will happen, as an approval sheet's summary: one term a line ([label, value, id]). */
export function ApprovalSummary({ rows }: { rows: ([string, React.ReactNode, string] | null | false)[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-lg border p-3 text-sm" data-approval-summary>
      {rows
        .filter((r): r is [string, React.ReactNode, string] => Boolean(r))
        .map(([label, value, id]) => (
          <div key={id} className="contents" data-summary-row={id}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0">{value}</dd>
          </div>
        ))}
    </dl>
  )
}

export type StepState ="done" | "current" | "todo" | "skipped" | "failed" | "declined"
export type Step = { label: string; state: StepState; title?: string }

/** Steps in order, the one at `current` in progress (all done once `current` is past the end). */
export function linearSteps(labels: string[], current: number, stopped?: "failed" | "declined"): Step[] {
  return labels.map((label, i) => ({ label, state: i < current ? "done" : i === current ? (stopped ?? "current") : "todo" }))
}

const STEP_WORDS: Record<StepState, string> = { done: "done", current: "current step", todo: "to come", skipped: "not needed", failed: "failed", declined: "declined" }

function StepMark({ step, n, small }: { step: Step; n: number; small?: boolean }) {
  const size = small ? "size-4 text-[10px]" : "size-5 text-xs"
  const icon = small ? "size-2.5" : "size-3"
  const look: Record<StepState, string> = {
    done: "bg-emerald-500 text-white",
    current: "bg-primary text-primary-foreground ring-2 ring-primary/30",
    todo: "border border-muted-foreground/40 text-muted-foreground",
    skipped: "border border-dashed border-muted-foreground/40 text-muted-foreground",
    failed: "bg-red-500 text-white",
    declined: "bg-muted-foreground/50 text-white",
  }
  return (
    <span aria-hidden className={cn("inline-flex shrink-0 items-center justify-center rounded-full font-medium tabular-nums", size, look[step.state])}>
      {step.state === "done" ? <Check className={icon} /> : step.state === "failed" || step.state === "declined" ? <X className={icon} /> : step.state === "skipped" ? <Minus className={icon} /> : n}
    </span>
  )
}

/**
 * Where an approval stands, as its steps in order. Full (a sheet): every step's mark and name, the
 * current one bold. Compact (a table cell, one line): every step's mark, named in its tooltip, then
 * the name of the step it stands at.
 */
export function ApprovalSteps({ steps, compact = false, className }: { steps: Step[]; compact?: boolean; className?: string }) {
  const at = steps.find((s) => s.state === "current" || s.state === "failed" || s.state === "declined") ?? null
  const finished = !at && steps.every((s) => s.state === "done" || s.state === "skipped")
  const name = (s: Step) => `${s.label}: ${s.title ?? STEP_WORDS[s.state]}`
  if (compact)
    return (
      <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)} data-approval-steps="compact" aria-label={steps.map(name).join(", ")} role="img">
        <span className="flex shrink-0 items-center gap-0.5">
          {steps.map((s, i) => (
            <span key={s.label} className="flex items-center gap-0.5" title={name(s)} data-step={s.label} data-step-state={s.state}>
              {i > 0 && <span aria-hidden className={cn("h-px w-1.5", s.state === "done" ? "bg-emerald-500" : "bg-muted-foreground/40")} />}
              <StepMark step={s} n={i + 1} small />
            </span>
          ))}
        </span>
        <span className={cn("min-w-0 truncate", at ? "font-medium" : "text-muted-foreground")} data-step-at>
          {at ? at.label : finished ? steps[steps.length - 1]?.label : ""}
        </span>
      </span>
    )
  return (
    <ol className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-sm", className)} data-approval-steps="full" aria-label="Approval steps">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2" aria-current={s.state === "current" ? "step" : undefined} title={name(s)} data-step={s.label} data-step-state={s.state}>
          {i > 0 && <span aria-hidden className={cn("h-px w-4", s.state === "done" ? "bg-emerald-500" : "bg-muted-foreground/40")} />}
          <StepMark step={s} n={i + 1} />
          <span className={cn(s.state === "current" || s.state === "failed" ? "font-semibold" : "text-muted-foreground", s.state === "failed" && "text-destructive")}>{s.label}</span>
        </li>
      ))}
    </ol>
  )
}
