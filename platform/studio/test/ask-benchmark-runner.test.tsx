// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ASK_RUNNER_NOTE, AskBenchmarkRunner } from "@/components/admin-ask-benchmark-runner";

// The line on an Ask AI run's page that carries the run out from Studio (POST /api/admin/benchmarks/ask, one task a
// step). It only ever acts for an Ask AI run that is going: any other agent's run, or an ended one, gets nothing.

afterEach(() => cleanup());

const RUN = "11111111-1111-4111-8111-111111111111";
function answering(answers: (Record<string, unknown> | number)[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string) => {
    calls.push(url);
    const a = answers.shift() ?? { ran: null, going: false, wait: null };
    return typeof a === "number" ? new Response(JSON.stringify({ error: "not_configured", message: "AI is not configured in Studio." }), { status: a }) : new Response(JSON.stringify(a), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

describe("the Ask AI benchmark runner on a run's page", () => {
  it("does nothing for another agent's run, an ended Ask AI run, or no run yet", async () => {
    const { calls, fetcher } = answering([]);
    for (const run of [{ id: RUN, agent: "coding", status: "running" }, { id: RUN, agent: "ask-ai", status: "finished" }, { id: RUN, agent: "ask-ai", status: "stopped_at_cap" }, null]) {
      const { container } = render(<AskBenchmarkRunner run={run} fetcher={fetcher} />);
      await settle();
      expect(container.innerHTML).toBe("");
      cleanup();
    }
    expect(calls).toEqual([]);
  });

  it("runs an Ask AI run's tasks while it is going, says so, and tells the page after each task", async () => {
    const { calls, fetcher } = answering([{ ran: "apps-and-stages", going: true, wait: null }, { ran: null, going: true, wait: "Mynt is scoring the last record." }, { ran: "workspace-members", going: true, wait: null }, { ran: null, going: false, wait: null }]);
    let reloads = 0;
    const { container } = render(<AskBenchmarkRunner run={{ id: RUN, agent: "ask-ai", status: "running" }} fetcher={fetcher} pauseMs={1} onStep={() => reloads++} />);
    expect(container.querySelector("[data-ask-benchmark-runner]")?.textContent).toContain(ASK_RUNNER_NOTE);
    await settle();
    expect(calls).toEqual(Array(4).fill("/api/admin/benchmarks/ask"));
    expect(reloads).toBe(3); // after each of the two tasks, and when the run was over
    expect(container.querySelector("[data-ask-benchmark-runner]")?.textContent).toContain("2 run from here so far.");
  });

  it("says why when a step fails, and stops when the page is left", async () => {
    const failed = answering([503]);
    const { container } = render(<AskBenchmarkRunner run={{ id: RUN, agent: "ask-ai", status: "queued" }} fetcher={failed.fetcher} />);
    await settle();
    expect(container.querySelector("[data-ask-benchmark-runner]")?.textContent).toBe("AI is not configured in Studio. Open this page again to carry on.");
    expect(failed.calls).toHaveLength(1);
    cleanup();

    const going = answering(Array.from({ length: 500 }, () => ({ ran: null, going: true, wait: "Another runner is answering this task." })));
    const page = render(<AskBenchmarkRunner run={{ id: RUN, agent: "ask-ai", status: "running" }} fetcher={going.fetcher} pauseMs={5} />);
    await settle();
    page.unmount();
    const made = going.calls.length;
    await settle();
    expect(made).toBeGreaterThan(0);
    expect(going.calls.length).toBe(made);
  });
});
