"use client"

// Platform admin → Agent benchmarks → an Ask AI run's page. Ask AI is Studio's code, so its benchmark's tasks are run
// by Studio, from this page, while the run is going: the run was started with Start run and its cap, and this only
// carries it out (lib/ask-benchmark-client.ts; POST /api/admin/benchmarks/ask). It shows one line saying so. For any
// other agent's run, and once the run has ended, it shows nothing and does nothing.
import { useEffect, useRef, useState } from "react"

import { driveAskBenchmark } from "@/lib/ask-benchmark-client"
import { runIsGoing } from "@/lib/benchmarks"

export const ASK_RUNNER_NOTE = "Ask AI's tasks are run from this page: keep it open until the run ends. Mynt scores each answer."

export function AskBenchmarkRunner({ run, onStep, fetcher, pauseMs }: { run: { id: string; agent: string; status: string } | null; onStep?: () => void; fetcher?: typeof fetch; pauseMs?: number }) {
  const going = run?.agent === "ask-ai" && runIsGoing(run.status)
  const id = run?.id ?? null
  const [failed, setFailed] = useState<string | null>(null)
  const [ran, setRan] = useState(0)
  // The page's own reload changes identity as it likes; the loop reads the latest.
  const stepped = useRef(onStep)
  stepped.current = onStep
  useEffect(() => {
    if (!going) return
    const stop = new AbortController()
    setFailed(null)
    setRan(0)
    void driveAskBenchmark({
      signal: stop.signal,
      fetcher,
      pauseMs,
      onStep: (step) => {
        if (step.ran === null) return
        setRan((n) => n + 1)
        stepped.current?.()
      },
    }).then((end) => {
      if (!end) return
      if (end.kind === "failed") setFailed(end.message)
      stepped.current?.()
    })
    return () => stop.abort()
  }, [going, id, fetcher, pauseMs])
  if (!going && !failed) return null
  return (
    <p role="status" className={failed ? "text-sm text-destructive" : "text-sm text-muted-foreground"} data-ask-benchmark-runner>
      {failed ? `${failed} Open this page again to carry on.` : `${ASK_RUNNER_NOTE}${ran ? ` ${ran} run from here so far.` : ""}`}
    </p>
  )
}
