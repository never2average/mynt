import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { auditClass } from "../dist/audit-classes.js";
import { DEFAULT_RISK_GRADING, deriveResidual, gradingProblem, levelOf } from "../dist/risk-grading.js";
import { CATALOG } from "./helpers.js";

// The platform's risk grading: three-step scoring (inherent = likelihood × impact; control effectiveness in four
// steps; residual derived by the grading's method unless a keeper overrides it), kept as one versioned setting only
// Mynt's admins read and change. A change re-derives the residual scores that aren't overridden, and says how many.

const T = "financial_products";

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "risk-grading", version: "0" });
    await client.connect(c);
    const call = async (n, a = {}) => {
      const res = await client.callTool({ name: n, arguments: a });
      let data;
      try {
        data = JSON.parse(res.content[0].text);
      } catch {
        data = { error: res.content[0].text };
      }
      return { isError: res.isError ?? false, data };
    };
    return { user, call, tools: async () => (await client.listTools()).tools.map((t) => t.name) };
  };
  return { store, admin: await as("Ada", ["admin"]), dev: await as("Dana", ["developer"]) };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};
const PLATFORM = { subject_type: "platform", subject_id: "mynt" };
const add = async (t, title, likelihood, impact, more = {}) => ok(await t.admin.call("add_risk", { ...PLATFORM, title, category: "operational", risk_area: "operations", likelihood, impact, ...more })).risk;
const bands = (a, b, c) => [
  { level: "low", from: 1, to: a },
  { level: "medium", from: a + 1, to: b },
  { level: "high", from: b + 1, to: c },
  { level: "critical", from: c + 1, to: 25 },
];

test("derivation: the defaults are today's bands, and reduce takes a share of the inherent score per control step", () => {
  const g = DEFAULT_RISK_GRADING;
  assert.equal(gradingProblem(g), null);
  assert.deepEqual([1, 4, 5, 9, 10, 14, 15, 25].map((n) => levelOf(g.inherent_bands, n)), ["low", "low", "medium", "medium", "high", "high", "critical", "critical"]);
  assert.deepEqual(g.residual_bands, g.inherent_bands);
  assert.equal(g.residual_method, "reduce");
  assert.deepEqual(g.reduce, { none: 0, weak: 0.25, partial: 0.5, strong: 0.75 });
  assert.deepEqual(["none", "weak", "partial", "strong"].map((s) => deriveResidual(g, 20, s)), [20, 15, 10, 5]);
  assert.deepEqual(["none", "weak", "partial", "strong"].map((s) => deriveResidual(g, 12, s)), [12, 9, 6, 3]);
  // Rounded to the nearest whole number, and never below 1: a score is never 0.
  assert.equal(deriveResidual(g, 5, "partial"), 3);
  assert.equal(deriveResidual(g, 1, "strong"), 1);
  assert.equal(deriveResidual(g, 2, "strong"), 1);
  // The matrix: the inherent level and the step pick a level; the score is that band's top, or the inherent score when lower.
  const m = { ...g, residual_method: "matrix" };
  assert.deepEqual(["none", "weak", "partial", "strong"].map((s) => deriveResidual(m, 20, s)), [20, 20, 14, 9]);
  assert.deepEqual(["none", "weak", "partial", "strong"].map((s) => deriveResidual(m, 12, s)), [12, 12, 9, 4]);
  assert.deepEqual(["none", "weak", "partial", "strong"].map((s) => deriveResidual(m, 3, s)), [3, 3, 3, 3]);
});

test("validation: bands contiguous and covering 1-25; a control never raises a risk", () => {
  const g = DEFAULT_RISK_GRADING;
  const bad = (change, re) => assert.match(gradingProblem({ ...g, ...change }) ?? "", re);
  bad({ inherent_bands: bands(4, 9, 14).map((b, i) => (i === 0 ? { ...b, from: 2 } : b)) }, /inherent bands must start at 1/);
  bad({ residual_bands: bands(4, 9, 14).map((b, i) => (i === 3 ? { ...b, to: 24 } : b)) }, /residual bands must end at 25/);
  bad({ inherent_bands: bands(4, 9, 14).map((b, i) => (i === 1 ? { ...b, from: 6 } : b)) }, /contiguous: medium must start at 5/);
  bad({ inherent_bands: bands(4, 9, 14).map((b, i) => (i === 1 ? { ...b, from: 4 } : b)) }, /contiguous/);
  bad({ inherent_bands: [...bands(4, 9, 14)].reverse() }, /four levels in order/);
  bad({ levels: { ...g.levels, high: "medium" } }, /own name/);
  bad({ reduce: { none: 0.5, weak: 0.25, partial: 0.5, strong: 0.75 } }, /can't reduce less/);
  bad({ matrix: { ...g.matrix, low: { none: "medium", weak: "low", partial: "low", strong: "low" } } }, /never raises/);
  bad({ matrix: { ...g.matrix, high: { none: "high", weak: "medium", partial: "high", strong: "low" } } }, /can't leave high higher/);
  assert.equal(gradingProblem({ ...g, inherent_bands: bands(3, 8, 15) }), null);
});

test("three-step scoring on a risk: inherent, control, residual; not assessed says so; an override is kept with who, when and why", async () => {
  const t = await setup();
  const risk = await add(t, "Ledger outage", 4, 5);
  assert.deepEqual(risk.inherent, { likelihood: 4, impact: 5, score: 20, level: "critical", level_name: "Critical" });
  assert.deepEqual(risk.control, { effectiveness: null, words: "Not assessed", note: null });
  assert.equal(risk.residual.score, 20, "the residual is the inherent score until the control is assessed");
  assert.equal(risk.residual.assessed, false);
  assert.equal(risk.residual.overridden, false);
  assert.equal(risk.residual.words, "20 (Critical): same as inherent, control not assessed");
  assert.equal(risk.score, 20);
  assert.equal(risk.level, "critical");

  let r = ok(await t.admin.call("update_risk", { risk_id: risk.id, control_effectiveness: "partial", control_note: "Failover tested monthly" })).risk;
  assert.deepEqual(r.control, { effectiveness: "partial", words: "Partial", note: "Failover tested monthly" });
  assert.equal(r.residual.score, 10);
  assert.equal(r.residual.level, "high");
  assert.equal(r.residual.assessed, true);
  assert.equal(r.residual.words, "10 (High)");
  // The inherent score moves: the residual is derived again.
  r = ok(await t.admin.call("update_risk", { risk_id: risk.id, likelihood: 2 })).risk;
  assert.equal(r.inherent.score, 10);
  assert.equal(r.residual.score, 5);

  // An override needs all three parts, and replaces the derived score.
  refused(await t.admin.call("update_risk", { risk_id: risk.id, residual_likelihood: 1 }), /override needs/);
  refused(await t.admin.call("update_risk", { risk_id: risk.id, residual_likelihood: 1, residual_impact: 2 }), /override needs/);
  refused(await t.admin.call("update_risk", { risk_id: risk.id, clear_residual_override: true }), /isn't overridden/);
  r = ok(await t.admin.call("update_risk", { risk_id: risk.id, residual_likelihood: 1, residual_impact: 5, residual_override_reason: "Insurance covers the loss" }));
  assert.deepEqual(r.changed, ["residual_override"]);
  r = r.risk;
  assert.equal(r.residual.score, 5);
  assert.equal(r.residual.overridden, true);
  assert.equal(r.residual.likelihood, 1);
  assert.equal(r.residual.impact, 5);
  assert.equal(r.residual.override.by, t.admin.user.id);
  assert.equal(r.residual.override.why, "Insurance covers the loss");
  assert.ok(r.residual.override.at);
  assert.equal(r.residual.words, "5 (Medium), overridden: 1 × 5");
  // The override stays while the inherent score and the control move under it.
  r = ok(await t.admin.call("update_risk", { risk_id: risk.id, likelihood: 5, control_effectiveness: "none" })).risk;
  assert.equal(r.inherent.score, 25);
  assert.equal(r.residual.score, 5);
  // Dropped: derived again from where the risk stands now.
  r = ok(await t.admin.call("update_risk", { risk_id: risk.id, clear_residual_override: true })).risk;
  assert.equal(r.residual.overridden, false);
  assert.equal(r.residual.override, null);
  assert.equal(r.residual.score, 25);

  // Added with a control: derived at once.
  assert.equal((await add(t, "Phishing", 3, 4, { control_effectiveness: "strong" })).residual.score, 3);
});

test("lists: three scores each, highest residual first, counted and filtered by residual level", async () => {
  const t = await setup();
  await add(t, "A: critical, strong control", 5, 5, { control_effectiveness: "strong" }); // 25 → 6 medium
  await add(t, "B: high, not assessed", 3, 4); // 12 → 12 high
  await add(t, "C: medium, weak control", 3, 3, { control_effectiveness: "weak" }); // 9 → 7 medium
  await add(t, "D: low", 1, 2, { control_effectiveness: "none" }); // 2 → 2 low
  const list = ok(await t.admin.call("list_risks", PLATFORM));
  assert.deepEqual(list.risks.map((r) => [r.title[0], r.inherent.score, r.control.words, r.residual.score, r.residual.level_name]), [
    ["B", 12, "Not assessed", 12, "High"],
    ["C", 9, "Weak", 7, "Medium"],
    ["A", 25, "Strong", 6, "Medium"],
    ["D", 2, "None", 2, "Low"],
  ]);
  assert.deepEqual(list.residual_levels, { low: 1, medium: 2, high: 1, critical: 0 });
  assert.deepEqual(list.level_names, { low: "Low", medium: "Medium", high: "High", critical: "Critical" });
  assert.deepEqual(ok(await t.admin.call("list_risks", { ...PLATFORM, residual_level: "medium" })).risks.map((r) => r.title[0]), ["C", "A"]);

  const across = ok(await t.admin.call("admin_list_risks", {}));
  assert.deepEqual(across.risks.map((r) => r.title[0]), ["B", "C", "A", "D"]);
  assert.deepEqual(across.counts, { critical: 1, high: 1, medium: 1, low: 1 }, "by inherent level");
  assert.deepEqual(across.residual_counts, { critical: 0, high: 1, medium: 2, low: 1 });
  assert.deepEqual(ok(await t.admin.call("admin_list_risks", { residual_level: "high" })).risks.map((r) => r.title[0]), ["B"]);
});

test("the grading setting: Mynt admins only; a change is a new version, re-derives what isn't overridden, and audits how many moved", async () => {
  const t = await setup();
  assert.ok((await t.admin.tools()).includes("get_risk_grading") && (await t.admin.tools()).includes("set_risk_grading"));
  for (const name of ["get_risk_grading", "set_risk_grading"]) assert.ok(!(await t.dev.tools()).includes(name), name);

  const first = ok(await t.admin.call("get_risk_grading"));
  assert.equal(first.version, 0, "Mynt's defaults, never changed");
  assert.deepEqual(first.grading, DEFAULT_RISK_GRADING);
  assert.deepEqual(first.history, []);
  assert.match(first.method_in_words, /none 0%, weak 25%, partial 50%, strong 75%/);
  // The heat map: 5 rows (the likeliest first) of 5 cells, each with its score and level in words.
  assert.deepEqual(first.heat_map.map((r) => r.likelihood), [5, 4, 3, 2, 1]);
  assert.deepEqual(first.heat_map[0].cells.map((c) => [c.impact, c.score, c.level_name]), [[1, 5, "Medium"], [2, 10, "High"], [3, 15, "Critical"], [4, 20, "Critical"], [5, 25, "Critical"]]);
  assert.deepEqual(first.heat_map[4].cells.map((c) => c.level), ["low", "low", "low", "low", "medium"]);

  const derived = await add(t, "Derived", 4, 5, { control_effectiveness: "partial" }); // 20 → 10
  const same = await add(t, "Stays the same", 1, 1, { control_effectiveness: "partial" }); // 1 → 1 either way
  const open = await add(t, "Not assessed", 4, 4); // no derived residual
  const overridden = await add(t, "Overridden", 4, 5, { control_effectiveness: "partial" });
  ok(await t.admin.call("update_risk", { risk_id: overridden.id, residual_likelihood: 2, residual_impact: 2, residual_override_reason: "Measured losses are small" }));

  refused(await t.admin.call("set_risk_grading", { note: "Nothing" }), /Nothing to change/);
  refused(await t.admin.call("set_risk_grading", { reduce: DEFAULT_RISK_GRADING.reduce, note: "Same again" }), /Nothing to change/);
  refused(await t.admin.call("set_risk_grading", { inherent_bands: bands(4, 9, 14).map((b, i) => (i === 2 ? { ...b, from: 11 } : b)), note: "A gap" }), /contiguous/);
  refused(await t.admin.call("set_risk_grading", { restore_version: 1, note: "Nothing kept yet" }), /No risk grading version 1/);
  refused(await t.admin.call("set_risk_grading", { restore_version: 1, residual_method: "matrix", note: "Both" }), /not both/);

  const changed = ok(await t.admin.call("set_risk_grading", { reduce: { none: 0, weak: 0.2, partial: 0.4, strong: 0.8 }, levels: { low: "Minor", medium: "Moderate", high: "Major", critical: "Severe" }, note: "Partial controls count for less" }));
  assert.equal(changed.version, 2, "the defaults were kept as version 1");
  assert.deepEqual(changed.changed, ["levels", "reduce"]);
  assert.equal(changed.residuals_changed, 1, "only the derived risk moved");
  const after = async (id) => ok(await t.admin.call("get_risk", { risk_id: id })).risk;
  assert.equal((await after(derived.id)).residual.score, 12);
  assert.equal((await after(derived.id)).residual.level_name, "Major");
  assert.equal((await after(same.id)).residual.score, 1);
  assert.equal((await after(open.id)).residual.score, 16);
  assert.equal((await after(open.id)).residual.assessed, false);
  assert.equal((await after(overridden.id)).residual.score, 4, "an overridden residual is never derived again");
  // The moved risk's own history shows it, score before → after.
  const moved = ok(await t.admin.call("get_risk", { risk_id: derived.id })).history.at(-1);
  assert.equal(moved.action, "rederive_risk_residual");
  assert.match(moved.what, /risk grading version 2/);
  assert.deepEqual([moved.score.before.residual, moved.score.after.residual], [10, 12]);
  assert.equal(moved.score.after.inherent, 20);

  const audit = (await t.store.db.query(`SELECT details FROM ${T}.audit_log WHERE action = 'set_risk_grading'`)).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.residuals_changed, 1);
  assert.equal(audit[0].details.version, 2);
  assert.equal(audit[0].details.note, "Partial controls count for less");
  for (const a of ["set_risk_grading", "rederive_risk_residual"]) assert.equal(auditClass(a), "obligations");

  // The matrix method, then restoring a previous version: each a new version; the old ones stay.
  const matrix = ok(await t.admin.call("set_risk_grading", { residual_method: "matrix", note: "Try the matrix" }));
  assert.equal(matrix.version, 3);
  assert.equal((await after(derived.id)).residual.score, 14, "critical with a partial control → high: the top of its band");
  const restored = ok(await t.admin.call("set_risk_grading", { restore_version: 1, note: "Back to the defaults" }));
  assert.equal(restored.version, 4);
  assert.equal(restored.restored_from, 1);
  assert.deepEqual(restored.grading, DEFAULT_RISK_GRADING);
  assert.equal((await after(derived.id)).residual.score, 10);
  assert.equal((await after(derived.id)).residual.level_name, "High");
  const now = ok(await t.admin.call("get_risk_grading"));
  assert.equal(now.version, 4);
  assert.deepEqual(now.history.map((v) => [v.version, v.note, v.restored_from, v.residuals_changed, v.created_by?.name ?? null]), [
    [4, "Back to the defaults", 1, 1, "Ada"],
    [3, "Try the matrix", null, 1, "Ada"],
    [2, "Partial controls count for less", null, 1, "Ada"],
    [1, "Mynt's defaults", null, null, null],
  ]);
  assert.equal(now.history[1].grading.residual_method, "matrix");
});
