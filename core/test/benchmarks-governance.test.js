import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCHMARKS_DIR, taskSetErrors, taskSetFor } from "../dist/benchmark-tasks.js";
import { checklist } from "../dist/review.js";
import { Store } from "../dist/store.js";
import { REVIEW, T, carefulReview, drive, met, notMet, review, reviewPlay, start, world } from "./benchmark-standins.js";

// The governance set's firm and licence samples (governance-review.v2.json). A firm or licence review normally reads
// public registers; in a sample the register's record is a fixture held in the case, so the answer is in the case and
// Mynt verifies the agent's quotes against the case (mynt://case). The reviewers here are stand-ins; the review
// service, Mynt's pass over the answers and the recommendation are the production code.

const FILE = "governance-review.v2.json";
const v2 = () => JSON.parse(readFileSync(join(BENCHMARKS_DIR, FILE), "utf8"));
const v1 = () => JSON.parse(readFileSync(join(BENCHMARKS_DIR, "governance-review.v1.json"), "utf8"));
const NEW = v2().tasks.filter((t) => t.subject_kind !== "product");

// Every read or write of a firm, a licence or a product through the store, while `during` runs.
async function storeTouches(w, during) {
  const names = Object.getOwnPropertyNames(Store.prototype).filter((n) => /entit|licen[sc]e|product/i.test(n) && typeof w.store[n] === "function");
  assert.ok(["getEntity", "getHeldLicense", "getProduct", "createEntity"].every((n) => names.includes(n)));
  const touched = [];
  for (const n of names) w.store[n] = (...args) => (touched.push(n), Store.prototype[n].apply(w.store, args));
  try {
    await during();
  } finally {
    for (const n of names) delete w.store[n];
  }
  return touched;
}
const realRecords = async (w) => Object.fromEntries(await Promise.all(["entities", "held_licenses", "products", "review_cases"].map(async (t) => [t, await w.count(t)])));
const outcome = (t) => [t.status, t.failure_class, t.failed_check];

// ---- the set ----

test("version 2 of the governance set is valid, keeps version 1's product cases unchanged and adds firm and licence cases with a known answer", () => {
  const set = v2();
  assert.deepEqual(taskSetErrors(FILE, set), []);
  assert.deepEqual(taskSetErrors("governance-review.v1.json", v1()), [], "version 1 stays in place: a run records its set's version and hash");
  assert.deepEqual(set.tasks.slice(0, 6), v1().tasks);
  assert.equal(set.tasks.length, 15);
  // It is the set runs use; version 1 can still be read by the runs that recorded it.
  const latest = taskSetFor("governance-review");
  assert.deepEqual([latest.file, latest.version, latest.tasks.length], [FILE, 2, 15]);
  assert.deepEqual([taskSetFor("governance-review", 1).file, taskSetFor("governance-review", 1).tasks.length], ["governance-review.v1.json", 6]);
  assert.notEqual(latest.sha256, taskSetFor("governance-review", 1).sha256);

  for (const kind of ["entity", "license"]) {
    const mine = NEW.filter((t) => t.subject_kind === kind);
    assert.ok(mine.length >= 3, `${kind}: ${mine.length} cases`);
    assert.ok(mine.some((t) => t.sample === "good") && mine.some((t) => t.sample === "bad"), kind);
    const list = checklist(kind);
    for (const t of mine) {
      // What Mynt decides is fixed for the sample and met, so the answer depends on the agent's items alone.
      assert.deepEqual(t.decided_by_mynt, Object.fromEntries(list.filter((i) => i.by === "mynt").map((i) => [i.id, "met"])), t.id);
      if (t.sample === "bad") {
        // Exactly one planted problem, on an item the agent answers, and a material one: Mynt rejects on it.
        assert.equal(t.expect.not_met.length, 1, t.id);
        const item = list.find((i) => i.id === t.expect.not_met[0]);
        assert.deepEqual([item.by, item.material], ["agent", true], t.id);
        assert.ok(t.planted.length > 20);
      } else assert.equal(t.expect.not_met, undefined, t.id);
    }
  }
  // The planted problems cover what the checklists ask about a firm and a licence.
  assert.deepEqual(NEW.filter((t) => t.sample === "bad").map((t) => t.expect.not_met[0]).sort(), ["active_status", "holder_matches", "in_force", "registry_match", "type_matches"]);

  for (const t of NEW) {
    // Invented, and marked so in the case itself; a register copy is a fixture, never a live register's answer.
    assert.match(t.subject.sample_note, /^Invented for the benchmark\./, t.id);
    assert.match(t.subject.register_copy.what_this_is, /^A fixture: a copy of one register (record|entry), invented for this benchmark sample and held in the case\. It is not an answer from/, t.id);
    assert.match(t.subject.register_copy.register, /described generically/, t.id);
    assert.match(t.subject.entity.name, /^Sample /, t.id);
    for (const n of [...Object.values(t.subject.entity.registration_numbers), ...(t.subject.licence ? [t.subject.licence.registration_number] : [])]) assert.match(n, /^SAMPLE-/, `${t.id}: ${n} can't be a real firm's number`);
    // United States only; no live register is named or needed (the only links are to the law Mynt's model records).
    assert.deepEqual(t.facts.regions, ["US"], t.id);
    assert.equal(t.regulatory.region, "US");
    assert.doesNotMatch(JSON.stringify(t.subject), /https?:\/\//, `${t.id}: the subject names no web source`);
    // Quotable as it stands: a quote is found in the case's JSON text, so the fixture avoids characters JSON escapes.
    assert.doesNotMatch(JSON.stringify(t.subject).replace(/\\"/g, "\u0000"), /\u0000|\\\\|\\n/, t.id);
    for (const l of t.subject.register_copy.record) assert.ok(l.length >= 12, `${t.id}: '${l}' is long enough to verify as a quote`);
  }
  // A licence case's regulator and licence type are the ones Mynt's United States model records.
  const model = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));
  for (const t of NEW.filter((x) => x.subject_kind === "license")) {
    const regulator = model.regulators.find((r) => r.id === t.regulatory.regulator.id);
    assert.deepEqual(t.regulatory.regulator, { id: regulator.id, name: regulator.name, short_name: regulator.short_name }, t.id);
    const type = regulator.license_types.find((l) => l._id === t.regulatory.licence_type.id);
    assert.equal(t.regulatory.licence_type.name, type.name, t.id);
    assert.ok(type.scope.startsWith(t.regulatory.licence_type.scope), t.id);
    assert.deepEqual([t.subject.licence.regulator_id, t.subject.licence.license_id], [regulator.id, type._id]);
    for (const law of t.regulatory.law) assert.equal(model.legislation.find((l) => l.id === law.legal_ref).summary, law.summary, t.id);
  }
});

test("a firm or licence case that doesn't follow its checklist is refused", () => {
  const errors = (id, change) => {
    const set = v2();
    change(set.tasks.find((t) => t.id === id));
    return taskSetErrors(FILE, set).join("\n");
  };
  assert.match(errors("good-firm-on-the-register", (t) => delete t.decided_by_mynt.registration_ids_given), /decided_by_mynt leaves out 'registration_ids_given'/);
  assert.match(errors("good-firm-on-the-register", (t) => (t.decided_by_mynt.licence_type_defined = "met")), /'licence_type_defined' isn't an item Mynt decides for a entity/);
  assert.match(errors("bad-firm-dissolved", (t) => (t.expect.not_met = ["registration_ids_given"])), /isn't an item the agent answers for a entity/);
  assert.match(errors("bad-firm-dissolved", (t) => (t.decided_by_mynt.registration_ids_given = "not_met")), /wouldn't depend on the agent/);
  assert.match(errors("bad-licence-revoked", (t) => (t.expect.not_met = ["active_status"])), /isn't an item the agent answers for a license/);
  assert.match(errors("bad-licence-revoked", (t) => delete t.planted), /must have required property 'planted'/);
  assert.match(errors("good-money-transmission-licence", (t) => (t.expect.flagged = true)), /must be equal to constant/);
});

// ---- running them ----

test("every firm and licence sample can be answered from its case alone: a careful reviewer passes them all, on quotes Mynt verified in the case", async () => {
  const w = await world();
  const before = await realRecords(w);
  let runId;
  let done;
  const handed = {};
  const touched = await storeTouches(w, async () => {
    runId = await start(w, { agent: "governance-review", cap_usd: 25, task_ids: NEW.map((t) => t.id) });
    done = await drive(w, runId, reviewPlay((kase, taskId) => ((handed[taskId] = kase), carefulReview(kase))));
  });
  // The run is of version 2, and says so.
  assert.deepEqual([done.run.task_set, done.run.task_set_version, done.run.task_set_sha256], [FILE, 2, taskSetFor("governance-review").sha256]);
  assert.equal(done.run.status, "finished");
  const by = Object.fromEntries(done.tasks.map((t) => [t.task_id, t]));
  for (const t of NEW) assert.equal(by[t.id].status, "passed", `${t.id}: ${by[t.id].detail}`);
  assert.deepEqual([done.scoreboard.passed, done.scoreboard.failed, done.scoreboard.pass_rate], [9, 0, 1]);

  // Mynt's recommendation, from the answers it could verify: reject where a problem was planted, never on a sound one.
  for (const t of NEW.filter((x) => x.sample === "bad")) {
    assert.equal(by[t.id].observed.recommendation, "reject", t.id);
    const planted = t.expect.not_met[0];
    assert.equal(by[t.id].observed.items[planted], "not_met", t.id);
    // Only the planted item is not met: each bad sample has one problem.
    assert.deepEqual(Object.entries(by[t.id].observed.items).filter(([, s]) => s === "not_met").map(([id]) => id), [planted], t.id);
    assert.deepEqual(by[t.id].checks.map((c) => [c.name, c.status]), [["review_complete", "pass"], ["planted_problem_caught", "pass"], ["rejected", "pass"]], t.id);
  }
  assert.equal(by["good-firm-on-the-register"].observed.recommendation, "verify");
  // Nothing in that case about enforcement: the item is silent, and a silent minor item doesn't hold a sound licence back.
  assert.deepEqual([by["good-money-transmission-licence"].observed.recommendation, by["good-money-transmission-licence"].observed.items.no_enforcement], ["verify", "silent"]);
  assert.equal(by["good-licence-holder-name-abbreviated"].observed.recommendation, "verify");
  assert.deepEqual(by["good-licence-holder-name-abbreviated"].observed.items, { register_entry: "met", holder_matches: "met", type_matches: "met", in_force: "met", no_enforcement: "met" });
  // A register copy with no status line: the item is silent, the recommendation asks for more, and the sample passes.
  assert.equal(by["good-firm-register-copy-without-status"].observed.items.active_status, "silent");
  assert.equal(by["good-firm-register-copy-without-status"].observed.recommendation, "needs_info");

  // Every quote was checked by Mynt against the case it handed over, and found there.
  const cases = await w.rows(`SELECT subject_kind, subject_id, entity_id, items, snapshot FROM ${T}.bench_review_cases ORDER BY created_at`);
  assert.equal(cases.length, 9);
  for (const c of cases) {
    assert.equal(c.entity_id, null, "a sample belongs to no firm");
    assert.match(c.subject_id, /^benchmark:[0-9a-f]{8}:/);
    const quotes = c.items.filter((i) => i.by === "agent").flatMap((i) => i.evidence);
    assert.ok(quotes.length > 0);
    for (const e of quotes) assert.deepEqual([e.source_url, e.verified], ["mynt://case", true], e.quote);
    for (const i of c.items.filter((x) => x.by === "mynt")) assert.deepEqual([i.status, i.evidence[0].source_url], ["met", "mynt://records"]);
  }
  // The agent was handed the sample's subject whole, register copy and all, and the checklist's own items for its kind.
  for (const t of NEW) {
    assert.deepEqual(handed[t.id].subject, t.subject, t.id);
    assert.deepEqual(handed[t.id].items.map((i) => i.id), checklist(t.subject_kind).filter((i) => i.by === "agent").map((i) => i.id), t.id);
  }

  // No firm, licence or product was created or read: the store was never asked for one, and the real tables are as
  // they were. The governance desk's own queue never saw a sample.
  assert.deepEqual(touched, []);
  assert.deepEqual(await realRecords(w), before);
  assert.deepEqual([before.entities, before.held_licenses, before.review_cases], [0, 0, 0]);
  assert.deepEqual(await w.real.review.list(), []);
});

test("a firm sample and a licence sample, end to end: caught only on the planted item with a quote Mynt found in the case; a false alarm on a sound one fails", async () => {
  const w = await world();
  const before = await realRecords(w);
  const run = async (ids, answers) => {
    const runId = await start(w, { agent: "governance-review", cap_usd: 10, task_ids: ids });
    const done = await drive(w, runId, reviewPlay((kase, taskId) => (answers[taskId] ?? carefulReview)(kase)));
    assert.equal(done.run.status, "finished");
    return Object.fromEntries(done.tasks.map((t) => [t.task_id, t]));
  };
  const SAMPLES = ["good-firm-on-the-register", "bad-firm-dissolved", "good-money-transmission-licence", "bad-licence-revoked"];
  const but = (over) => (kase) => {
    const r = carefulReview(kase);
    return { items: r.items.map((i) => ({ ...i, ...(over[i.id] ?? {}) })) };
  };
  let by;
  const touched = await storeTouches(w, async () => {
    // 1. Careful reviewers: the sound firm and licence pass, the dissolved firm and the revoked licence are caught.
    by = await run(SAMPLES, {});
    for (const id of SAMPLES) assert.equal(by[id].status, "passed", `${id}: ${by[id].detail}`);
    assert.deepEqual([by["bad-firm-dissolved"].observed.recommendation, by["bad-firm-dissolved"].observed.items.active_status], ["reject", "not_met"]);
    assert.deepEqual([by["bad-licence-revoked"].observed.recommendation, by["bad-licence-revoked"].observed.items.in_force], ["reject", "not_met"]);
    assert.equal(by["good-firm-on-the-register"].cost_usd, 0.45);

    // 2. "Caught", but the quote isn't in the case (made up, or from a page Mynt can't find it on): it doesn't count.
    by = await run(SAMPLES, {
      "bad-firm-dissolved": but({ active_status: notMet("This company was struck off the register last year") }),
      "bad-licence-revoked": but({ in_force: { status: "not_met", evidence: [{ source_url: "https://regulator.example.com/licensees/SAMPLE-MT-618837", quote: "Status: Revoked by order of the regulator, effective 2025-09-12" }] } }),
      // A false alarm on a sound firm and a sound licence, each with a real quote from the case.
      "good-firm-on-the-register": but({ active_status: notMet("Status: Active, in good standing") }),
      "good-money-transmission-licence": but({ holder_matches: notMet("Licence holder: Sample Juniper Pay Inc.") }),
    });
    assert.deepEqual(outcome(by["bad-firm-dissolved"]), ["failed", "agent", "evidence_verified"]);
    assert.equal(by["bad-firm-dissolved"].observed.items.active_status, "unverified");
    assert.match(by["bad-firm-dissolved"].detail, /evidence_verified \(active_status: unverified\)/);
    assert.deepEqual(outcome(by["bad-licence-revoked"]), ["failed", "agent", "evidence_verified"]);
    assert.deepEqual(outcome(by["good-firm-on-the-register"]), ["failed", "agent", "nothing_falsely_flagged"]);
    assert.match(by["good-firm-on-the-register"].detail, /Marked not met: active_status/);
    assert.deepEqual(outcome(by["good-money-transmission-licence"]), ["failed", "agent", "nothing_falsely_flagged"]);
    assert.equal(by["good-money-transmission-licence"].observed.recommendation, "reject");

    // 3. Missed, or flagged on the wrong item: a bad sample passes only on the item that was planted.
    by = await run(["bad-firm-dissolved", "bad-licence-revoked", "bad-firm-number-is-another-company", "bad-licence-of-another-class"], {
      // waved through, quoting the firm's own record instead of the register
      "bad-firm-dissolved": but({ active_status: met("Sample Copper Canyon Lending Corporation") }),
      // rejected, but for the wrong reason: the holder, not the revocation
      "bad-licence-revoked": but({ holder_matches: notMet("Licence holder: Sample Rainier Transfer Company"), in_force: met("Date first licensed: 2019-05-20") }),
      // said nothing either way about anything
      "bad-firm-number-is-another-company": (kase) => review(kase, {}),
      "bad-licence-of-another-class": (kase) => review(kase, {}),
    });
    assert.deepEqual(outcome(by["bad-firm-dissolved"]), ["failed", "agent", "planted_problem_caught"]);
    assert.deepEqual(outcome(by["bad-licence-revoked"]), ["failed", "agent", "planted_problem_caught"]);
    assert.equal(by["bad-licence-revoked"].observed.recommendation, "reject", "Mynt would reject, but not on what was planted");
    for (const id of ["bad-firm-number-is-another-company", "bad-licence-of-another-class"]) {
      assert.deepEqual(outcome(by[id]), ["failed", "agent", "planted_problem_caught"], id);
      assert.equal(by[id].observed.recommendation, "needs_info");
    }

    // 4. Silent on everything is fine for a sound sample: nothing is flagged, and Mynt asks for more instead of rejecting.
    by = await run(["good-firm-register-copy-without-status", "good-licence-holder-name-abbreviated"], {
      "good-firm-register-copy-without-status": (kase) => review(kase, {}),
      "good-licence-holder-name-abbreviated": (kase) => review(kase, {}),
    });
    for (const id of Object.keys(by)) assert.deepEqual([by[id].status, by[id].observed.recommendation], ["passed", "needs_info"], id);
  });

  assert.deepEqual(touched, []);
  assert.deepEqual(await realRecords(w), before);
  assert.equal(await w.count("bench_review_cases"), 14);
  assert.equal(await w.count("audit_log", "action = 'start_benchmark_run'"), 4);
  // The case file the agent got is the sample, and names itself as invented.
  const box = [...w.sandboxes.sandboxes.values()][0];
  assert.match(JSON.parse(box.files.get(`${REVIEW}/job/case.json`)).subject.sample_note, /Invented for the benchmark/);
});
