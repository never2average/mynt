import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { bdConfigFromEnv } from "../dist/bd.js";
import { taskSetFor } from "../dist/benchmark-tasks.js";
import { BenchmarkService, budgetFor } from "../dist/benchmarks.js";
import { buildConfigFromEnv } from "../dist/builds.js";
import { deskConfigFromEnv } from "../dist/desk.js";
import { PLATFORM_SETTINGS } from "../dist/platform-settings.js";
import { reviewConfigFromEnv } from "../dist/review.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// The cap, made usable: every agent's set is shown against what one run may spend, a run can take a chosen part of
// a set, and a cap that can't cover even one task says so in plain words.

test("a set's ceiling against the cap: fits, covers part, covers none in full, can't start", () => {
  // Eight tasks at US$10: the default cap of 25 is sure of two.
  const part = budgetFor(8, 10, 0, 25);
  assert.deepEqual([part.set_ceiling_usd, part.per_task_ceiling_usd, part.tasks_covered_in_full, part.fits_whole_set, part.can_start], [80, 10, 2, false, true]);
  assert.match(part.note, /could cost up to US\$80 .* more than the cap of US\$25\. The cap is sure to cover 2 task\(s\) in full: pick up to 2, or raise BENCHMARK_CAP_USD in Platform settings/);
  // With Mynt's audit on top of each build, 15 a task: one.
  assert.equal(budgetFor(8, 10, 5, 25).tasks_covered_in_full, 1);
  assert.equal(budgetFor(8, 10, 5, 25).set_ceiling_usd, 120);
  // The whole set fits.
  const fits = budgetFor(5, 3, 0.5, 25);
  assert.deepEqual([fits.set_ceiling_usd, fits.fits_whole_set, fits.tasks_covered_in_full], [17.5, true, 5]);
  assert.match(fits.note, /^The whole set fits/);
  // Not even one task in full: a run could start, and would stop after a short first task.
  const none = budgetFor(8, 10, 0, 6);
  assert.deepEqual([none.tasks_covered_in_full, none.can_start], [0, true]);
  assert.match(none.note, /can't cover even one task in full: one task may spend up to US\$10\..* Raise BENCHMARK_CAP_USD in Platform settings to at least US\$10/);
  // Not enough to start one at all.
  const never = budgetFor(4, 8, 1, 1);
  assert.deepEqual([never.tasks_covered_in_full, never.can_start, never.least_cap_usd], [0, false, 1.5]);
  assert.match(never.note, /can't cover even one task: a run needs at least US\$1\.5 to start one/);
  // A per-task cap nobody set is said, never shown as 0.
  assert.equal(budgetFor(4, 0, 0, 25).set_ceiling_usd, null);
  assert.match(budgetFor(4, 0, 0, 25).note, /^Not measured/);
});

test("every agent's set is listed with its ceiling, the cap, its tasks to pick from, and what the cap covers; a chosen part is a run of its own", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const buildConfig = { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } };
  const sandboxes = { createSandbox: async () => ({ id: "s", state: "ready" }), getSandbox: async () => ({ id: "s", state: "provisioning" }), writeFile: async () => {}, readFile: async () => null, costDollars: async () => 0, stop: async () => {}, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), commandStatus: async () => ({ running: true, exitCode: null }) };
  const b = await BenchmarkService.open(db, store, { sandboxes, repos: null, buildConfig, deskConfig: deskConfigFromEnv(buildConfig, {}), reviewConfig: reviewConfigFromEnv(buildConfig, {}), bdConfig: bdConfigFromEnv(buildConfig, {}) });
  const admin = (await store.createUser("Ada Admin", ["admin"])).user;
  const cap = Number(PLATFORM_SETTINGS.find((s) => s.key === "BENCHMARK_CAP_USD").default);
  assert.equal(cap, 25, "the safe default stays");

  const agents = await b.agents();
  for (const a of agents) {
    const set = taskSetFor(a.agent);
    assert.equal(a.budget.cap_usd, cap, a.agent);
    assert.equal(a.budget.tasks, set.tasks.length);
    assert.deepEqual(a.task_list.map((t) => t.id), set.tasks.map((t) => t.id));
    assert.ok(a.task_list.every((t) => t.label && t.label.length <= 160), `${a.agent}: every task has a line to pick it by`);
    assert.ok(a.budget.note.length > 20);
  }
  const coding = agents.find((a) => a.agent === "coding");
  assert.equal(coding.budget.fits_whole_set, false);
  assert.equal(coding.budget.set_ceiling_usd, coding.budget.per_task_ceiling_usd * 8);
  assert.equal(coding.budget.tasks_covered_in_full, Math.floor(cap / coding.budget.per_task_ceiling_usd));

  // A part of the set the cap covers: the run holds exactly those tasks, and says what its cap covers.
  const ids = coding.task_list.slice(0, coding.budget.tasks_covered_in_full).map((t) => t.id);
  const started = await b.start(admin, { agent: "coding", cap_usd: cap, task_ids: ids });
  assert.deepEqual(started.tasks.map((t) => t.task_id), ids);
  assert.equal(started.budget.fits_whole_set, true);
  assert.deepEqual(started.run.options.task_ids, ids);
  await b.stop(started.run.id, "the test has what it needs");

  // A cap too small for one task is refused in the same plain words, before anything starts.
  await assert.rejects(b.start(admin, { agent: "coding", cap_usd: 0.4 }), /too small for even one task: a coding run needs at least US\$0\.5 to start one, and US\$\d+ to give one task its whole budget/);
  // A task the set doesn't have is refused by name.
  await assert.rejects(b.start(admin, { agent: "coding", cap_usd: 5, task_ids: ["no-such-task"] }), /no task 'no-such-task'/);
});
