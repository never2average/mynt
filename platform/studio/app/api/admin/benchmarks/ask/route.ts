import { z } from "zod";
import { writeBody } from "@/lib/admin-routes";
import { askInstructionsSha, nextTaskFrom, runAskBenchmarkTask } from "@/lib/ask-benchmark";
import { askConfigured, askModels, createLlm } from "@/lib/llm";
import { callAdminTool, listMyntTools } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Admin → Agent benchmarks → an Ask AI run, one step (POST /api/admin/benchmarks/ask, an empty body). Ask AI is
// Studio's code, so Studio runs its benchmark's tasks: this takes the task waiting in the Ask AI run a Mynt admin
// started (next_benchmark_task), answers it with Ask AI over the fixture Mynt handed out with it
// (lib/ask-benchmark.ts), and hands Mynt the record (submit_benchmark_answer). Mynt scores it. The run's page calls
// this while the run is going (components/admin-ask-benchmark-runner.tsx).
//
// It can't start a run or change one: with no Ask AI run going it does nothing and says so. What it spends is the
// model's calls for one question, held under the budget Mynt gave the task, inside the cap the run was started with.
// Mynt admins only (404 for anyone else, nothing sent to Mynt), and Mynt checks the role again on both calls.
export async function POST(req: Request) {
  const w = await writeBody(req, z.object({}).strict());
  if (!w.ok) return w.res;
  return asAdmin("running an Ask AI benchmark task", async (mynt, session) => {
    const tools = await listMyntTools(mynt);
    if (!["next_benchmark_task", "submit_benchmark_answer"].every((name) => tools.some((t) => t.name === name))) return json({ error: "unsupported", message: "Ask AI's benchmark comes with Mynt's next update." }, 422);
    if (!askConfigured()) return json({ error: "not_configured", message: "AI is not configured in Studio, so Ask AI's tasks can't be run. Stop the run, or configure the model and open this page again." }, 503);
    const models = askModels();
    const next = nextTaskFrom(await callAdminTool(mynt, session, "next_benchmark_task", { models, instructions_sha256: askInstructionsSha() }));
    if (!next) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    if (!("task" in next)) return json({ ran: null, going: next.going, wait: next.wait });
    // From here on the model is called: for this one question, metered against the task's budget.
    const record = await runAskBenchmarkTask(next, { tools, llm: createLlm(), models });
    await callAdminTool(mynt, session, "submit_benchmark_answer", { run_id: next.run.id, task_id: next.task.id, claim: next.claim, record });
    return json({ ran: next.task.id, going: true, wait: null });
  });
}
