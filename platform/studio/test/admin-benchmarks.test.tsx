// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The platform admin's Agent benchmarks (/platform/benchmarks): two read views, each one table under one toolbar
// (Runs and Task sets), a labelled Start run opening a sheet that asks for the cap and says the run spends money, and
// a run's page (/platform/benchmarks/<id>): a metadata card, then Tasks, Failures, Cost and Compare, each a table,
// with a labelled Stop run while it's going. With no runs the page says so and what a run needs. A figure nothing
// measured reads "Not measured" with why, never 0.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/benchmarks",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { BenchmarksView, BenchmarkRunView, StartRunSheet, StopRunSheet, RUNS_HEAD, TASK_SETS_HEAD, RECORDS_HEAD, LIST_TABS, RUN_TABS, NO_RUNS_NOTE, NO_RECORDS_NOTE } = await import("@/components/admin-benchmarks");
const lib = await import("@/lib/benchmarks");
const { PLATFORM_SECTIONS } = await import("@/components/platform-shell");
const admin = await import("@/lib/admin");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const RUN = "11111111-1111-4111-8111-111111111111";
const BASE = "22222222-2222-4222-8222-222222222222";
const board = (over: Record<string, unknown> = {}) => ({ tasks: 3, passed: 1, failed: 1, infrastructure_failures: 1, harness_failures: 0, not_run: 0, waiting: 0, scored: 2, pass_rate: 0.5, pass_rate_note: null, cost_usd: 1.3, cost_note: null, median_duration_ms: 61000, duration_note: null, ...over });
const runRow = (over: Record<string, unknown> = {}) => ({ id: RUN, agent: "coding", label: "After the secure skill change", task_set: "coding.v1.json", task_set_version: 1, status: "finished", stop_reason: null, cap_usd: 20, charged_usd: 1.3, model: "claude-opus-5-5", workspace_revisions: { "coding-build": "abcdef0123456789".repeat(4) }, source_commit: null, source_commit_note: "Not recorded: the server wasn't running from a git checkout", started_by: "Ada Admin", created_at: "2026-11-27T10:00:00.000Z", finished_at: "2026-11-27T10:30:00.000Z", ...over });
const AGENTS = [
  { agent: "coding", task_set: "coding.v1.json", version: 1, title: "App builds on the starter ideas", description: "Eight app builds.", tasks: 8, model: "claude-opus-5-5", max_task_usd: 10, ready: true, why_not: null, needs: ["A sandbox host with allowance left, the agents' model backend, and PUBLIC_URL."], budget: { tasks: 8, per_task_ceiling_usd: 10, set_ceiling_usd: 80, cap_usd: 25, fits_whole_set: false, tasks_covered_in_full: 2, can_start: true, note: "The whole set could cost up to US$80 (8 task(s) at up to US$10 each), more than the cap of US$25. The cap is sure to cover 2 task(s) in full: pick up to 2, or raise BENCHMARK_CAP_USD in Platform settings." }, task_list: ["two-key-household-fund", "tax-refund-split", "closing-date-cd", "payroll-buffer", "t5", "t6", "t7", "t8"].map((id) => ({ id, label: `The ${id} app` })) },
  { agent: "product-desk", task_set: "product-desk.v1.json", version: 1, title: "Feasibility models", description: "Six product ideas.", tasks: 6, model: "claude-opus-5-5", max_task_usd: 5, ready: true, why_not: null, needs: ["Nothing else: no repository."], budget: { tasks: 6, per_task_ceiling_usd: 5, set_ceiling_usd: 30, cap_usd: 25, fits_whole_set: false, tasks_covered_in_full: 5, can_start: true, note: "The whole set could cost up to US$30." }, task_list: ["d1", "d2", "d3", "d4", "d5", "d6"].map((id) => ({ id, label: id })) },
  { agent: "program-audit", task_set: "program-audit.v1.json", version: 1, title: "Solana programs", description: "Four programs.", tasks: 4, model: null, max_task_usd: null, ready: false, why_not: "Program-audit benchmarks can't run yet", needs: ["Not runnable yet."], budget: { tasks: 4, per_task_ceiling_usd: null, set_ceiling_usd: null, cap_usd: 25, fits_whole_set: false, tasks_covered_in_full: 0, can_start: false, note: "Not measured: this agent's per-task cap isn't set on this Mynt" }, task_list: [] },
];
const RECORDS = {
  note: "Made by benchmark runs and used only by them.",
  account: { id: "u1", name: "Mynt benchmarks", created_at: "2026-11-20T10:00:00.000Z" },
  workspaces: [{ id: "w1", name: "Mynt benchmarks", created_at: "2026-11-20T10:00:00.000Z" }],
  apps: [{ id: "a1", name: "Benchmark: tax-refund-split", status: "draft", created_at: "2026-11-20T10:00:00.000Z" }],
  firms: [{ id: "e1", name: "Mynt benchmarks (not a firm)", created_at: "2026-11-20T10:00:00.000Z" }],
  products: [{ id: "benchmark-d1", name: "Starter certificate", status: "draft", created_at: "2026-11-20T10:00:00.000Z" }],
};
const listOf = (runs: unknown[], records: unknown = null) => lib.benchmarkListFrom({ runs, agents: AGENTS, cap: { max_usd_per_run: 25 }, records })!;
const TASKS = [
  { task_id: "two-key-household-fund", status: "passed", failure_class: null, failed_check: null, detail: null, checks: [{ name: "tests", status: "pass" }, { name: "secrets_scan", status: "pass" }], cap_usd: 10, cost_usd: 0.6, cost_parts: { agent_model: 0.5, sandboxes: 0.1, mynt_audit: null }, cost_note: null, duration_ms: 61000 },
  { task_id: "tax-refund-split", status: "failed", failure_class: "agent", failed_check: "secrets_scan", detail: "failed: Not production-ready: secrets_scan (gitleaks: 1 leak)", checks: [{ name: "secrets_scan", status: "fail" }], cap_usd: 10, cost_usd: 0.7, cost_parts: { agent_model: 0.6, sandboxes: 0.1, mynt_audit: null }, cost_note: null, duration_ms: 75000 },
  { task_id: "closing-date-cd", status: "failed", failure_class: "infrastructure", failed_check: "infrastructure", detail: "failed: Sandbox error: host out of machines", checks: [], cap_usd: 10, cost_usd: null, cost_parts: null, cost_note: "Not measured: the build ended before Mynt first measured its cost", duration_ms: null },
  { task_id: "payroll-buffer", status: "not_run", failure_class: null, failed_check: null, detail: "The run's cap of US$20 was reached", checks: [], cap_usd: null, cost_usd: null, cost_parts: null, cost_note: null, duration_ms: null },
];
const detailOf = (run: Record<string, unknown> = {}, scoreboard = board()) => lib.benchmarkDetailFrom({ run: runRow(run), scoreboard, tasks: TASKS })!;
const COMPARISON = lib.comparisonFrom({
  comparison: { baseline: BASE, candidate: RUN, problems: [], notes: ["Workspace folders changed: coding-build"], pass_rate: { baseline: 1, candidate: 0.5, delta: -0.5 }, cost_usd: { baseline: 1, candidate: 1.3, delta: 0.3 }, tasks: [{ task_id: "tax-refund-split", baseline: "passed", candidate: "failed (agent)", change: "regressed", why: null, failed_check: "secrets_scan", cost_delta_usd: 0.3, duration_delta_ms: 14000 }, { task_id: "closing-date-cd", baseline: "passed", candidate: "failed (infrastructure)", change: "not_comparable", why: "candidate: failed (infrastructure)", failed_check: "infrastructure", cost_delta_usd: null, duration_delta_ms: null }], regressions: ["tax-refund-split"], fixed: [] },
  gate: { verdict: "fail", reasons: ["1 task(s) passed in the baseline and fail in the candidate (at most 0 allowed): tax-refund-split"] },
})!;
const fetcher = (reply: Record<string, unknown> = { ok: true, id: RUN, message: "Started: 8 coding task(s)." }, status = 200) => {
  const calls: { url: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply), { status });
  });
  return { f: f as unknown as typeof fetch, calls };
};
const heads = (html: string) => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));

describe("where it lives", () => {
  it("Agent benchmarks is a section of the platform admin, with its own address and a page per run", () => {
    expect(PLATFORM_SECTIONS.map((s) => s.label)).toContain("Agent benchmarks");
    expect(admin.adminHref("benchmarks")).toBe("/platform/benchmarks");
    expect(admin.platformRouteOf("/platform/benchmarks")).toEqual({ tab: "benchmarks", id: null });
    expect(admin.platformRouteOf(`/platform/benchmarks/${RUN}`)).toEqual({ tab: "benchmarks", id: RUN });
    expect(admin.platformTitle(`/platform/benchmarks/${RUN}`)).toBe("Agent benchmarks");
  });
});

describe("the list", () => {
  it("with no runs yet it says so plainly, says what a run is and costs, and the Task sets tab says what each needs", () => {
    const html = renderToStaticMarkup(<BenchmarksView list={listOf([])} onOpen={() => undefined} />);
    expect(html).toContain("No benchmark run has been made yet, so nothing has been measured.");
    expect(NO_RUNS_NOTE).toMatch(/started here by a Mynt admin, with a cap in US dollars/);
    expect(NO_RUNS_NOTE).toMatch(/spends money/);
    expect(html).toContain("No benchmark run has been made yet.");
    expect(heads(html)).toEqual([...RUNS_HEAD]);
    expect(html).not.toMatch(/>0%<|US\$0\.00/);
    // One toolbar: a search and labelled buttons (never an icon alone), then one table.
    expect(html).toMatch(/aria-label="Search runs by label, agent, status or model"/);
    expect(html).toMatch(/data-start-run[^>]*>.*Start run<\/button>/);
    expect(html).toMatch(/data-export[^>]*>.*Export CSV<\/button>/);
    expect((html.match(/<table/g) ?? []).length).toBe(1);

    const sets = renderToStaticMarkup(<BenchmarksView list={listOf([])} onOpen={() => undefined} initialTab="task-sets" />);
    expect(heads(sets)).toEqual([...TASK_SETS_HEAD]);
    expect(sets).toContain("Coding agents");
    expect(sets).toContain("A sandbox host with allowance left");
    expect(sets).toMatch(/data-agent-ready="yes"[^>]*>Yes</);
    // Each set's ceiling against the cap one run may have; a ceiling nothing set is said, never shown as 0.
    expect(sets).toMatch(/data-agent-ceiling="part"[^>]*>US\$80\.00 at most; the US\$25 cap covers 2 of 8 tasks in full</);
    expect(sets).toMatch(/data-agent-ceiling="none"[^>]*>Not measured: this agent&#x27;s per-task cap isn&#x27;t set on this Mynt</);
    expect(sets).not.toContain("US$0");
    expect(sets).toMatch(/data-agent-ready="no"[^>]*>No\. Program-audit benchmarks can&#x27;t run yet/);
    expect((sets.match(/<table/g) ?? []).length).toBe(1);
  });

  it("a run's row: passed out of scored, the pass rate, infrastructure failures apart, cost against the cap", () => {
    const html = renderToStaticMarkup(<BenchmarksView list={listOf([{ ...runRow(), scoreboard: board() }])} onOpen={() => undefined} />);
    expect(html).toContain("After the secure skill change");
    expect(html).toMatch(/data-run-passed[^>]*>1 of 2 scored</);
    expect(html).toMatch(/data-run-pass-rate[^>]*>50%</);
    expect(html).toMatch(/data-run-cost[^>]*>US\$1\.30 of a US\$20 cap</);
    expect(html).toMatch(/data-open-run="11111111[^>]*>Open<\/button>/);
    expect(html).not.toContain(NO_RUNS_NOTE);
  });

  it("a run that scored nothing shows Not measured with the reason, never 0", () => {
    const empty = board({ passed: 0, failed: 0, scored: 0, pass_rate: null, pass_rate_note: "Not measured: no task has passed or failed on the agent's own account yet", cost_usd: null, cost_note: "Not measured: no task has a recorded cost" });
    const html = renderToStaticMarkup(<BenchmarksView list={listOf([{ ...runRow({ status: "stopped", stop_reason: "The sandbox provider has used up this account's allowance" }), scoreboard: empty }])} onOpen={() => undefined} />);
    expect(html).toMatch(/data-run-pass-rate[^>]*>Not measured: no task has passed or failed/);
    expect(html).toMatch(/data-run-cost[^>]*>Not measured: no task has a recorded cost of a US\$20 cap</);
    expect(html).not.toMatch(/>0%<|US\$0\.00/);
    expect(lib.usdWords(null)).toBe("Not measured");
    expect(lib.rateWords(0)).toBe("0%");
  });

  it("Start run opens a sheet that asks for the cap, says it spends money, and posts what was entered", async () => {
    const { f, calls } = fetcher();
    const view = render(<BenchmarksView list={listOf([])} onOpen={() => undefined} fetcher={f} />);
    fireEvent.click(view.container.querySelector("[data-start-run]")!);
    const sheet = document.querySelector('[data-admin-sheet="start-benchmark-run"]')!;
    expect(sheet.textContent).toContain("This spends money on the model and on sandboxes, up to the cap you give.");
    expect(sheet.textContent).toContain("At most US$25 (the BENCHMARK_CAP_USD operational setting).");
    expect(sheet.textContent).toContain("could cost up to US$80");
    const submit = sheet.querySelector("[data-start-run-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // no cap, no run
    fireEvent.change(sheet.querySelector("[data-start-run-cap]")!, { target: { value: "20" } });
    fireEvent.change(sheet.querySelector("[data-start-run-label]")!, { target: { value: "baseline" } });
    expect(sheet.querySelector("[data-start-run-repository]")).toBeNull();
    // Before anything is spent: the set's ceiling against the cap, and what the cap typed covers of the tasks picked.
    expect(sheet.querySelector("[data-start-run-ceiling]")!.textContent).toContain("The cap is sure to cover 2 task(s) in full");
    expect(sheet.querySelector("[data-start-run-cover]")!.textContent).toContain("8 tasks at up to US$10 each could cost at most US$80.00. A cap of US$20 is sure to cover 2 of them in full");
    await act(async () => {
      fireEvent.submit(sheet.querySelector("[data-start-run-form]")!);
    });
    // The whole set: no task list is sent.
    expect(calls).toEqual([{ url: "/api/admin/benchmarks", body: { agent: "coding", cap_usd: 20, label: "baseline" } }]);
    expect(document.querySelector("[data-sheet-result]")!.textContent).toContain("Started: 8 coding task(s).");
  });

  it("the sheet takes no repository from anyone, shows why an agent can't run, and Mynt's refusal", async () => {
    const { f, calls } = fetcher({ error: "refused", message: "This run can't start: the sandbox host's allowance is used up." }, 409);
    render(<StartRunSheet open agents={listOf([]).agents} maxCapUsd={25} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    const sheet = document.querySelector('[data-admin-sheet="start-benchmark-run"]')!;
    fireEvent.change(sheet.querySelector("[data-start-run-agent]")!, { target: { value: "program-audit" } });
    expect(sheet.querySelector("[data-start-run-not-ready]")!.textContent).toContain("Program-audit benchmarks can't run yet");
    fireEvent.change(sheet.querySelector("[data-start-run-agent]")!, { target: { value: "product-desk" } });
    // A product-desk run names no repository: there is nowhere to type one.
    expect(sheet.querySelector("[data-start-run-repository]")).toBeNull();
    expect(sheet.textContent).not.toMatch(/repository set aside|GitHub App/);
    fireEvent.change(sheet.querySelector("[data-start-run-cap]")!, { target: { value: "15" } });
    await act(async () => {
      fireEvent.submit(sheet.querySelector("[data-start-run-form]")!);
    });
    expect(calls[0].body).toEqual({ agent: "product-desk", cap_usd: 15 });
    expect(document.querySelector("[data-sheet-error]")!.textContent).toContain("the sandbox host's allowance is used up");
  });

  it("the task picker: a chosen part of a set is what is posted, and the sheet says what the cap covers of it", async () => {
    const { f, calls } = fetcher();
    render(<StartRunSheet open agents={listOf([]).agents} maxCapUsd={25} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    const sheet = document.querySelector('[data-admin-sheet="start-benchmark-run"]')!;
    const cover = () => sheet.querySelector("[data-start-run-cover]")!.textContent!;
    const submit = sheet.querySelector("[data-start-run-submit]") as HTMLButtonElement;
    expect(sheet.querySelectorAll("[data-start-run-task]").length).toBe(8);
    expect(sheet.querySelector("[data-start-run-tasks]")!.textContent).toContain("Tasks to run (8 of 8)");
    expect(sheet.querySelector("[data-start-run-tasks]")!.textContent).toContain("The tax-refund-split app");
    // A cap that can't cover even one task says so plainly.
    fireEvent.change(sheet.querySelector("[data-start-run-cap]")!, { target: { value: "6" } });
    expect(cover()).toContain("A cap of US$6 can't cover even one task in full");
    expect(cover()).toContain("Give at least US$10.");
    // A cap over what one run may spend names the setting.
    fireEvent.change(sheet.querySelector("[data-start-run-cap]")!, { target: { value: "40" } });
    expect(cover()).toContain("A cap of US$40 is over US$25, the most one run may spend (BENCHMARK_CAP_USD in Platform settings).");
    // Nothing picked: nothing to run.
    fireEvent.click(sheet.querySelector("[data-start-run-none]")!);
    fireEvent.change(sheet.querySelector("[data-start-run-cap]")!, { target: { value: "20" } });
    expect(cover()).toBe("Pick at least one task.");
    expect(submit.disabled).toBe(true);
    // Two tasks under a cap that covers both.
    fireEvent.click(sheet.querySelector('[data-start-run-task="tax-refund-split"]')!);
    fireEvent.click(sheet.querySelector('[data-start-run-task="payroll-buffer"]')!);
    expect(sheet.querySelector("[data-start-run-tasks]")!.textContent).toContain("Tasks to run (2 of 8)");
    expect(cover()).toBe("2 tasks at up to US$10 each could cost at most US$20.00. A cap of US$20 covers all of them.");
    expect(submit.disabled).toBe(false);
    await act(async () => {
      fireEvent.submit(sheet.querySelector("[data-start-run-form]")!);
    });
    expect(calls).toEqual([{ url: "/api/admin/benchmarks", body: { agent: "coding", cap_usd: 20, task_ids: ["tax-refund-split", "payroll-buffer"] } }]);
  });

  it("Records: the benchmarks' own account, workspace, apps, stand-in firm and draft products, one table, read only", () => {
    expect(LIST_TABS.map((t) => t.label)).toEqual(["Runs", "Task sets", "Records"]);
    const html = renderToStaticMarkup(<BenchmarksView list={listOf([], RECORDS)} onOpen={() => undefined} initialTab="records" />);
    expect(heads(html)).toEqual([...RECORDS_HEAD]);
    expect((html.match(/<table/g) ?? []).length).toBe(1);
    for (const [kind, name] of [["Account", "Mynt benchmarks"], ["Workspace", "Mynt benchmarks"], ["App", "Benchmark: tax-refund-split"], ["Stand-in firm", "Mynt benchmarks (not a firm)"], ["Draft product", "Starter certificate"]])
      expect(html).toMatch(new RegExp(`data-benchmark-record="${kind}"[^>]*>${name.replace(/[()]/g, "\\$&")}<`));
    expect(html).toContain("Made by benchmark runs and used only by them.");
    // The only button is the section's own labelled one: nothing here edits a record.
    expect([...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "")).filter((b) => /Start run/.test(b)).length).toBe(1);
    const none = renderToStaticMarkup(<BenchmarksView list={listOf([])} onOpen={() => undefined} initialTab="records" />);
    expect(none).toContain(NO_RECORDS_NOTE);
    expect(none).toContain("No benchmark run has made any record yet.");
  });
});

describe("a run's page", () => {
  const page = (props: Record<string, unknown> = {}) => (
    <BenchmarkRunView detail={detailOf()} others={[]} comparison={null} baseline={null} onBaseline={() => undefined} onBack={() => undefined} {...props} />
  );

  it("a metadata card on top, then Tasks, Failures, Cost and Compare, each one table", () => {
    const html = renderToStaticMarkup(page());
    expect(RUN_TABS.map((t) => t.label)).toEqual(["Tasks", "Failures", "Cost", "Compare"]);
    expect(html.indexOf("data-metadata-card")).toBeLessThan(html.indexOf("data-detail-tab"));
    for (const [label, value] of [["Agent", "Coding agents"], ["Passed", "1 of 2 scored"], ["Pass rate", "50%"], ["Model", "claude-opus-5-5"], ["Cap", "US$20 (US$1.30 counted)"], ["Not counted", "1 infrastructure, 0 benchmark, 0 not run"]]) {
      expect(html).toMatch(new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>${value.replace(/[$()]/g, "\\$&")}`));
    }
    expect(html).toContain("coding-build abcdef0123");
    expect(html).toContain("Not recorded: the server wasn&#x27;t running from a git checkout");
    expect(heads(html)).toEqual(["Task", "Outcome", "Failed check", "Cost", "Duration", "Mynt's checks".replace("'", "&#x27;")]);
    expect((html.match(/<table/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-task-status="not_run"[^>]*>Not run<span[^>]*>The run&#x27;s cap of US\$20 was reached/);
    expect(html).not.toContain("data-stop-run");
    for (const tab of ["failures", "cost", "compare"]) expect((renderToStaticMarkup(page({ initialTab: tab })).match(/<table/g) ?? []).length, tab).toBe(1);
  });

  it("Failures says whose failure each is; Cost never shows an unmeasured figure as 0", () => {
    const failures = renderToStaticMarkup(page({ initialTab: "failures" }));
    expect(failures).toMatch(/data-failure-class="agent"[^>]*>The agent \(counts against it\)/);
    expect(failures).toMatch(/data-failure-class="infrastructure"[^>]*>Infrastructure \(not counted\)/);
    expect(failures).toContain("Sandbox error: host out of machines");
    expect(failures).not.toContain("two-key-household-fund");
    const cost = renderToStaticMarkup(page({ initialTab: "cost" }));
    expect(cost).toContain("US$0.60");
    expect(cost).toContain("US$0.50");
    expect(cost).toContain("Not measured: the build ended before Mynt first measured its cost");
    expect(cost).toContain("Not measured: this part wasn&#x27;t recorded"); // Mynt's audit didn't run for the measured tasks
    expect(cost).toContain("Not run yet");
    expect(cost).toContain("Not set: the task never started");
    expect(cost).not.toMatch(/US\$0\.00/);
  });

  it("Compare: pick a baseline, then each task's change, the deltas and the regression gate's verdict", () => {
    const none = renderToStaticMarkup(page({ initialTab: "compare" }));
    expect(none).toContain("There is no other Coding agents run to compare against yet. Two runs are needed: one before a change, one after.");
    const other = listOf([{ ...runRow({ id: BASE, label: "Baseline" }), scoreboard: board({ pass_rate: 1 }) }]).runs;
    const picked: (string | null)[] = [];
    const view = render(page({ initialTab: "compare", others: other, onBaseline: (id: string | null) => picked.push(id) }));
    expect(view.container.textContent).toContain("Choose a baseline run to compare this one against.");
    fireEvent.change(view.container.querySelector("[data-baseline-select]")!, { target: { value: BASE } });
    expect(picked).toEqual([BASE]);
    const html = renderToStaticMarkup(page({ initialTab: "compare", others: other, baseline: BASE, comparison: COMPARISON }));
    expect(html).toMatch(/data-gate="fail"/);
    expect(html).toContain("Regression gate: Fail. Pass rate 100% to 50% (−50.0 points); cost US$1.00 to US$1.30 (+US$0.30).");
    expect(html).toContain("Regressed: tax-refund-split");
    expect(html).toMatch(/data-change="regressed"[^>]*>Regressed: secrets_scan/);
    expect(html).toMatch(/data-change="not_comparable"[^>]*>Not compared<span[^>]*>candidate: failed \(infrastructure\)/);
    expect(html).toContain("Workspace folders changed: coding-build");
    expect(html).toContain("+14 s");
    expect((html.match(/<table/g) ?? []).length).toBe(1);
  });

  it("a run that is going has a labelled Stop run, whose sheet posts the reason", async () => {
    const { f, calls } = fetcher({ ok: true, message: "The run is stopped." });
    const view = render(page({ detail: detailOf({ status: "running" }), fetcher: f }));
    const stop = view.container.querySelector("[data-stop-run]")!;
    expect(stop.textContent).toContain("Stop run");
    fireEvent.click(stop);
    const sheet = document.querySelector('[data-admin-sheet="stop-benchmark-run"]')!;
    expect(sheet.textContent).toContain("isn't held against the agent");
    fireEvent.change(sheet.querySelector("[data-stop-run-reason]")!, { target: { value: "wrong task set" } });
    await act(async () => {
      fireEvent.submit(sheet.querySelector("[data-stop-run-form]")!);
    });
    expect(calls).toEqual([{ url: `/api/admin/benchmarks/${RUN}`, body: { action: "stop", reason: "wrong task set" } }]);
    cleanup();
    render(<StopRunSheet run={null} onClose={() => undefined} onDone={() => undefined} />);
    expect(document.querySelector('[data-admin-sheet="stop-benchmark-run"]')).toBeNull();
  });
});
