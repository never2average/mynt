"use client"

// A build's measured cost and time as the studio shows them: a figure, or "Not measured" with
// Mynt's reason in a tooltip (never 0); and the builder's compact live line (phase · elapsed ·
// cost of cap), which counts up each second on the figures the view already polls.
import { useEffect, useState } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { costOfCap, durationText, isRunningBuild, NOT_MEASURED, NOT_REPORTED, phaseElapsed, type BuildMetrics, type Shown } from "@/lib/build-metrics"
import { cn } from "@/lib/utils"

/** A measured figure, or "Not measured" with Mynt's reason in a tooltip. */
export function Measured({ shown, field }: { shown: Shown; field: string }) {
  if (shown.measured) return <span data-field={field}>{shown.text}</span>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className="text-muted-foreground underline decoration-dotted underline-offset-2"
          data-field={field}
          data-not-measured={shown.reason ?? ""}
          aria-label={`${shown.text}: ${shown.reason}`}
        >
          {shown.text}
        </span>
      </TooltipTrigger>
      <TooltipContent>{shown.reason}</TooltipContent>
    </Tooltip>
  )
}

/** The current time, every second while `live`: running builds' times count up without asking Mynt again. */
export function useNow(live: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [live])
  return now
}

export type MeteredBuild = { id: string; status: string; metrics?: BuildMetrics | null }

const phaseLabel = (status: string) => {
  const t = status.replace(/_/g, " ").trim()
  return t ? t[0].toUpperCase() + t.slice(1) : "Unknown"
}

/** The builder's live line for one build: phase · elapsed in it · cost of cap. */
export function BuildMeter({ build, className }: { build: MeteredBuild; className?: string }) {
  const running = isRunningBuild(build.status)
  const now = useNow(running)
  const elapsed = phaseElapsed(build.metrics, build.status, now)
  const reason = build.metrics ? (build.metrics.notMeasured["durations_seconds.total"] ?? NOT_REPORTED) : NOT_REPORTED
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground tabular-nums", className)} data-build-meter={build.id} data-live={running || undefined}>
      <span className={cn("size-1.5 shrink-0 rounded-full", running ? "animate-pulse bg-amber-500" : "bg-muted-foreground/40")} aria-hidden />
      <span data-field="phase">{phaseLabel(build.status)}</span>
      <span aria-hidden>·</span>
      <Measured shown={elapsed === null ? { text: NOT_MEASURED, measured: false, reason } : { text: durationText(elapsed), measured: true, reason: null }} field="elapsed" />
      <span aria-hidden>·</span>
      <Measured shown={costOfCap(build.metrics)} field="cost" />
    </span>
  )
}
