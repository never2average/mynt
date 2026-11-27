// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, parseAdminCall } from "@/lib/studio-tools";

// The platform admin's Agent benchmarks routes (GET and POST /api/admin/benchmarks, GET and POST
// /api/admin/benchmarks/<id>): Mynt admins only (anyone else a 404, nothing sent to Mynt), strict bodies, a run never
// started without a cap, Mynt's refusal passed on in its own words, and an older Mynt without benchmarks said as such.

const fake = {
  session: undefined as Session | undefined,
  tools: [] as { name: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  reply: {} as Record<string, unknown>,
  refuse: {} as Record<string, string>,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => true, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse[name] }) }] };
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));

const list = await import("@/app/api/admin/benchmarks/route");
const one = await import("@/app/api/admin/benchmarks/[runId]/route");

const RUN = "11111111-1111-4111-8111-111111111111";
const BASE = "22222222-2222-4222-8222-222222222222";
const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const req = (path: string, body?: unknown) =>
  new Request(`http://studio.test${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = (runId: string) => ({ params: Promise.resolve({ runId }) });
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);
const BOARD = { tasks: 2, passed: 1, failed: 1, infrastructure_failures: 0, harness_failures: 0, not_run: 0, waiting: 0, scored: 2, pass_rate: 0.5, pass_rate_note: null, cost_usd: 1.3, cost_note: null, median_duration_ms: 61000, duration_note: null };
const RUN_ROW = { id: RUN, agent: "coding", label: "baseline", task_set: "coding.v1.json", task_set_version: 1, status: "finished", stop_reason: null, cap_usd: 20, charged_usd: 1.3, model: "claude-opus-5-5", workspace_revisions: { "coding-build": "a".repeat(64) }, source_commit: null, source_commit_note: "Not recorded: the server wasn't running from a git checkout", started_by: "Ada", created_at: "2026-11-27T10:00:00.000Z", finished_at: "2026-11-27T10:30:00.000Z" };

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = {};
  fake.reply = {
    list_benchmark_runs: { runs: [{ ...RUN_ROW, scoreboard: BOARD }], agents: [{ agent: "coding", task_set: "coding.v1.json", version: 1, title: "App builds", description: "Eight app builds", tasks: 8, workspaces: ["coding-build"], model: "claude-opus-5-5", max_task_usd: 10, ready: false, why_not: "No sandbox host is configured on this Mynt, so agents have nowhere to run", needs: ["A sandbox host with allowance left"] }], cap: { setting: "BENCHMARK_CAP_USD", max_usd_per_run: 25 } },
    get_benchmark_run: { run: RUN_ROW, scoreboard: BOARD, tasks: [{ task_id: "two-key-household-fund", position: 0, status: "passed", failure_class: null, failed_check: null, detail: null, checks: [{ name: "tests", status: "pass" }], cap_usd: 10, cost_usd: 0.6, cost_parts: { agent_model: 0.5, sandboxes: 0.1, mynt_audit: null }, cost_note: null, duration_ms: 61000 }] },
    compare_benchmark_runs: { comparison: { baseline: BASE, candidate: RUN, comparable: true, problems: [], notes: ["Workspace folders changed: coding-build"], pass_rate: { baseline: 1, candidate: 0.5, delta: -0.5 }, cost_usd: { baseline: 1, candidate: 1.3, delta: 0.3 }, tasks: [{ task_id: "tax-refund-split", baseline: "passed", candidate: "failed (agent)", change: "regressed", why: null, failed_check: "tests", cost_delta_usd: 0.3, duration_delta_ms: 2000 }], regressions: ["tax-refund-split"], fixed: [], not_comparable: [] }, gate: { verdict: "fail", reasons: ["1 task(s) passed in the baseline and fail in the candidate"] } },
    start_benchmark_run: { run: { id: RUN }, message: "Started: 8 coding task(s), one at a time, up to US$20. Follow it with get_benchmark_run." },
  };
});

describe("who gets in", () => {
  it("anyone but a Mynt admin gets 404 from every route, and nothing reaches Mynt", async () => {
    fake.session = session(["developer", "license_provider"]);
    const res = [await list.GET(), await list.POST(req("/api/admin/benchmarks", { agent: "coding", cap_usd: 5 })), await one.GET(req("/x"), p(RUN)), await one.POST(req("/x", { action: "stop", reason: "wrong set" }), p(RUN))];
    for (const r of res) expect(r.status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it("the benchmark tools are admin tools only, never the studio's", async () => {
    const { STUDIO_TOOLS } = await import("@/lib/studio-tools");
    for (const t of ["list_benchmark_runs", "get_benchmark_run", "compare_benchmark_runs", "start_benchmark_run", "stop_benchmark_run"]) {
      expect(Object.keys(ADMIN_TOOLS)).toContain(t);
      expect(Object.keys(STUDIO_TOOLS)).not.toContain(t);
    }
    expect(parseAdminCall("start_benchmark_run", { agent: "coding" })).toHaveProperty("error");
    expect(parseAdminCall("start_benchmark_run", { agent: "no-such-agent", cap_usd: 5 })).toHaveProperty("error");
  });
});

describe("reading", () => {
  it("the list: runs with their scoreboards, the agents' task sets and readiness, and the most a run's cap may be", async () => {
    const body = await (await list.GET()).json();
    expect(called("list_benchmark_runs")).toEqual([{}]);
    expect(body.list.runs[0]).toMatchObject({ id: RUN, agent: "coding", label: "baseline", status: "finished", capUsd: 20, scoreboard: { passed: 1, scored: 2, passRate: 0.5, costUsd: 1.3 } });
    expect(body.list.agents[0]).toMatchObject({ agent: "coding", tasks: 8, ready: false, whyNot: expect.stringContaining("No sandbox host"), maxTaskUsd: 10 });
    expect(body.list.maxCapUsd).toBe(25);
  });

  it("an older Mynt without benchmarks says so, never an empty list", async () => {
    fake.tools = fake.tools.filter((t) => !t.name.includes("benchmark"));
    expect(await (await list.GET()).json()).toEqual({ supported: false });
    expect(await (await one.GET(req("/x"), p(RUN))).json()).toEqual({ supported: false });
    expect((await list.POST(req("/api/admin/benchmarks", { agent: "coding", cap_usd: 5 }))).status).toBe(422);
    expect(fake.calls).toEqual([]);
  });

  it("a run: its tasks; and, with a baseline, the comparison and the gate's verdict", async () => {
    const alone = await (await one.GET(req(`/api/admin/benchmarks/${RUN}`), p(RUN))).json();
    expect(called("get_benchmark_run")).toEqual([{ run_id: RUN }]);
    expect(alone.comparison).toBeNull();
    expect(alone.detail.tasks[0]).toMatchObject({ taskId: "two-key-household-fund", status: "passed", costUsd: 0.6, costParts: { agent_model: 0.5, sandboxes: 0.1, mynt_audit: null } });
    expect(called("compare_benchmark_runs")).toEqual([]);
    const compared = await (await one.GET(req(`/api/admin/benchmarks/${RUN}?baseline=${BASE}`), p(RUN))).json();
    expect(called("compare_benchmark_runs")).toEqual([{ baseline: BASE, candidate: RUN }]);
    expect(compared.comparison).toMatchObject({ regressions: ["tax-refund-split"], gate: { verdict: "fail" }, passRate: { delta: -0.5 } });
    expect((await one.GET(req("/x"), p("not-a-run"))).status).toBe(400);
    expect((await one.GET(req(`/x?baseline=../etc`), p(RUN))).status).toBe(400);
  });
});

describe("Start run and Stop run", () => {
  it("a run is started with exactly what the sheet sent, and never without a cap", async () => {
    const ok = await list.POST(req("/api/admin/benchmarks", { agent: "product-desk", cap_usd: 20, label: "baseline", repository: "mynt-bench/desk" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, id: RUN, message: expect.stringContaining("Started") });
    expect(called("start_benchmark_run")).toEqual([{ agent: "product-desk", cap_usd: 20, label: "baseline", repository: "mynt-bench/desk" }]);
    for (const bad of [{ agent: "coding" }, { agent: "coding", cap_usd: 0 }, { agent: "coding", cap_usd: "20" }, { agent: "coding", cap_usd: 5, start_now: true }, { agent: "coding", cap_usd: 5, repository: "not a repo" }, { cap_usd: 5 }]) {
      expect((await list.POST(req("/api/admin/benchmarks", bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect(called("start_benchmark_run")).toHaveLength(1);
  });

  it("Mynt's refusal is passed on in its own words", async () => {
    fake.refuse.start_benchmark_run = "This run can't start: the sandbox host's allowance is used up.";
    const res = await list.POST(req("/api/admin/benchmarks", { agent: "coding", cap_usd: 20 }));
    expect(res.ok).toBe(false);
    expect((await res.json()).message).toContain("the sandbox host's allowance is used up");
  });

  it("a run is stopped with its reason", async () => {
    const res = await one.POST(req("/x", { action: "stop", reason: "wrong task set" }), p(RUN));
    expect(res.status).toBe(200);
    expect(called("stop_benchmark_run")).toEqual([{ run_id: RUN, reason: "wrong task set" }]);
    expect((await one.POST(req("/x", { action: "stop" }), p(RUN))).status).toBe(400);
    expect((await one.POST(req("/x", { action: "start", reason: "no such action" }), p(RUN))).status).toBe(400);
  });
});
