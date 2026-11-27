// Ask AI's benchmark from the browser: Studio runs its tasks, one step per request (POST /api/admin/benchmarks/ask),
// for as long as an Ask AI run a Mynt admin started is going. This is the loop the run's page keeps going
// (components/admin-ask-benchmark-runner.tsx). It starts nothing and stops nothing: no run going, it ends.
export const ASK_BENCHMARK_ROUTE = "/api/admin/benchmarks/ask"

/** One step's answer: the task that was run (none when Mynt had none waiting), and whether an Ask AI run is still going. */
export type AskBenchmarkStep = { ran: string | null; going: boolean; wait: string | null }
/** Why the loop ended: the run is over, or a step failed (with the sentence to show). */
export type AskBenchmarkEnd = { kind: "over" } | { kind: "failed"; message: string }

export const ASK_BENCHMARK_FAILED = "Studio couldn't run Ask AI's next task. The run waits a few minutes for it, then stops."

export async function askBenchmarkStep(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<AskBenchmarkStep | { error: string }> {
  const res = await fetcher(ASK_BENCHMARK_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store", signal }).catch(() => null)
  const body = (await res?.json().catch(() => null)) as Record<string, unknown> | null
  if (!res?.ok || !body) return { error: typeof body?.message === "string" && body.message.trim() ? body.message.trim().slice(0, 300) : ASK_BENCHMARK_FAILED }
  return { ran: typeof body.ran === "string" ? body.ran : null, going: body.going === true, wait: typeof body.wait === "string" ? body.wait : null }
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true })
  })

/**
 * Runs Ask AI's tasks until no Ask AI run is going, a step fails, or `signal` aborts (the page was left). After a
 * task it asks for the next at once; with none waiting (Mynt is scoring, or handing the next one out) it waits
 * `pauseMs` first.
 */
export async function driveAskBenchmark(o: { signal: AbortSignal; fetcher?: typeof fetch; onStep?: (step: AskBenchmarkStep) => void; pauseMs?: number }): Promise<AskBenchmarkEnd | null> {
  while (!o.signal.aborted) {
    const step = await askBenchmarkStep(o.fetcher, o.signal)
    if (o.signal.aborted) return null
    if ("error" in step) return { kind: "failed", message: step.error }
    if (!step.going) return { kind: "over" }
    o.onStep?.(step)
    if (step.ran === null) await pause(o.pauseMs ?? 3000, o.signal)
  }
  return null
}
