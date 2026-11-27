import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { benchmarkListFrom } from "@/lib/benchmarks";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Agent benchmarks (/platform/benchmarks). GET: the runs with their scoreboards, and every agent that has a
// task set with what a run needs and whether one could start now (list_benchmark_runs). An older Mynt without
// benchmarks answers { supported: false }. POST: Start run (start_benchmark_run), the tool's own arguments, checked
// here first and again by Mynt; a run spends money, so the cap is required and Mynt's refusal is passed on in its words.
export async function GET() {
  return asAdmin("reading agent benchmarks", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_benchmark_runs"))) return json(UNSUPPORTED);
    const list = benchmarkListFrom(await callAdminTool(mynt, session, "list_benchmark_runs", {}));
    if (!list) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    return json({ list });
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, ADMIN_TOOLS.start_benchmark_run);
  if (!w.ok) return w.res;
  return asAdmin("starting a benchmark run", async (mynt, session) => {
    if (!(await hasTools(mynt, "start_benchmark_run"))) return json({ error: "unsupported", message: "Agent benchmarks come with Mynt's next update." }, 422);
    const reply = (await callAdminTool(mynt, session, "start_benchmark_run", w.body)) as { run?: { id?: string }; message?: string } | null;
    return json({ ok: true, id: reply?.run?.id ?? null, message: reply?.message ?? "The run has started. It's recorded in the audit trail." });
  });
}
