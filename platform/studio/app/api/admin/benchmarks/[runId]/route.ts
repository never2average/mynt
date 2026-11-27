import { z } from "zod";
import { hasTools, isUuid, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { benchmarkDetailFrom, comparisonFrom } from "@/lib/benchmarks";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ runId: string }> };

// Admin → Agent benchmarks → one run (/platform/benchmarks/<id>). GET: the run with its scoreboard and every task
// (get_benchmark_run); with ?baseline=<run id>, also this run compared against that one (compare_benchmark_runs), for
// the Compare tab. POST: Stop run (stop_benchmark_run), with the reason.
const StopRun = ADMIN_TOOLS.stop_benchmark_run.omit({ run_id: true }).extend({ action: z.literal("stop") }).strict();

export async function GET(req: Request, { params }: Params) {
  const { runId } = await params;
  const baseline = new URL(req.url).searchParams.get("baseline");
  if (!isUuid(runId) || (baseline !== null && !isUuid(baseline))) return json({ error: "bad_request" }, 400);
  return asAdmin("reading a benchmark run", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_benchmark_run"))) return json(UNSUPPORTED);
    const detail = benchmarkDetailFrom(await callAdminTool(mynt, session, "get_benchmark_run", { run_id: runId }));
    if (!detail) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    const comparison = baseline ? comparisonFrom(await callAdminTool(mynt, session, "compare_benchmark_runs", { baseline, candidate: runId })) : null;
    return json({ detail, comparison });
  });
}

export async function POST(req: Request, { params }: Params) {
  const { runId } = await params;
  if (!isUuid(runId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, StopRun);
  if (!w.ok) return w.res;
  return asAdmin("stopping a benchmark run", async (mynt, session) => {
    await callAdminTool(mynt, session, "stop_benchmark_run", { run_id: runId, reason: w.body.reason });
    return json({ ok: true, message: "The run is stopped. The task in flight isn't held against the agent, and the rest are recorded as not run." });
  });
}
