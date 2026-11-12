import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { workspaceFiles, WORKSPACES_ROOT } from "../dist/agent-host.js";
import { evidenceChecker, fetchPublic } from "../dist/evidence.js";
import { recommend, ReviewService, reviewConfigFromEnv } from "../dist/review.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

const CWD = "/home/user/workspaces/governance-review";
const A = "/home/user/mynt-agent";
const REGISTER = "https://regulator.example/register?id=N-14.03268";
const REGISTER_PAGE = "<html><body><table><tr><td>N-14.03268</td><td>Sunrise Finance Private Limited</td><td>NBFC-ICC</td><td>Cancelled</td></tr></table></body></html>";

// ---- the workspace itself ----

test("the governance-review workspace loads as a folder of instructions, skills, checklists and scripts", () => {
  const files = workspaceFiles("governance-review");
  for (const f of ["CLAUDE.md", ".claude/skills/review-licence/SKILL.md", ".claude/skills/cite-evidence/SKILL.md", "checklists/license.json", "scripts/fetch_page.py", "scripts/check_review.py"]) {
    assert.ok(files[f], f);
  }
  assert.match(files[".claude/skills/review-licence/SKILL.md"], /^---\nname: review-licence\n/);
  assert.throws(() => workspaceFiles("../etc"), /Bad workspace name/);
});

test("the workspace's check_review.py holds the agent to Mynt's rules before it finishes", () => {
  const ws = mkdtempSync(join(tmpdir(), "mynt-review-ws-"));
  cpSync(join(WORKSPACES_ROOT, "governance-review"), ws, { recursive: true });
  mkdirSync(join(ws, "job"), { recursive: true });
  mkdirSync(join(ws, "sources"), { recursive: true });
  const kase = { subject_kind: "license", items: [{ id: "register_entry" }, { id: "in_force" }, { id: "no_enforcement" }], subject: { licence: { registration_number: "N-14.03268" } } };
  writeFileSync(join(ws, "job", "case.json"), JSON.stringify(kase));
  writeFileSync(join(ws, "sources", createHash("sha256").update(REGISTER).digest("hex").slice(0, 16) + ".txt"), `${REGISTER}\nN-14.03268 Sunrise Finance Private Limited NBFC-ICC Cancelled`);
  const run = (review) => {
    writeFileSync(join(ws, "job", "review.json"), JSON.stringify(review));
    return spawnSync("python3", ["scripts/check_review.py"], { cwd: ws, encoding: "utf8" });
  };
  const good = {
    items: [
      { id: "register_entry", status: "met", evidence: [{ source_url: REGISTER, quote: "N-14.03268  Sunrise Finance Private Limited" }] },
      { id: "in_force", status: "not_met", evidence: [{ source_url: REGISTER, quote: "NBFC-ICC Cancelled" }] },
      { id: "no_enforcement", status: "silent", evidence: [], searched_for: "Enforcement orders page for 'Sunrise Finance' and N-14.03268" },
    ],
  };
  const ok = run(good);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const bad = run({
    items: [
      { id: "register_entry", status: "met", evidence: [{ source_url: REGISTER, quote: "Sunrise Finance Limited is registered" }] },
      { id: "in_force", status: "met", evidence: [] },
      { id: "no_enforcement", status: "silent" },
      { id: "extra", status: "met" },
    ],
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /register_entry: quote not on/);
  assert.match(bad.stdout, /in_force: met needs at least one quote/);
  assert.match(bad.stdout, /no_enforcement: silent needs searched_for/);
  assert.match(bad.stdout, /not in the case/);
});

// ---- Mynt's side ----

test("Mynt's recommendation: material failures reject, unconfirmed material items need info, and too little reviewed is no recommendation", () => {
  const item = (id, status, material = true) => ({ id, title: id, material, by: "agent", status, evidence: [], searched_for: null, note: null });
  assert.equal(recommend([item("a", "met"), item("b", "not_met")]).verdict, "reject");
  assert.equal(recommend([item("a", "met"), item("b", "silent")]).verdict, "needs_info");
  assert.equal(recommend([item("a", "met"), item("b", "unverified")]).verdict, "needs_info");
  const v = recommend([item("a", "met"), item("b", "not_met", false)]);
  assert.equal(v.verdict, "verify");
  assert.match(v.reason, /minor open points: b/);
  assert.equal(recommend([item("a", "met"), item("b", "not_reviewed"), item("c", "not_reviewed"), item("d", "met")]).verdict, "incomplete");
  assert.equal(recommend([]).verdict, "incomplete");
});

test("evidence: quotes must be on the page (or in the case), and only public https sources are fetched", async () => {
  const check = evidenceChecker({ fetcher: async () => ({ ok: true, status: 200, contentType: "text/html", text: REGISTER_PAGE }), caseText: '{"description":"Guaranteed 12% returns, risk-free"}' });
  assert.deepEqual(await check({ source_url: REGISTER, quote: "N-14.03268 Sunrise Finance Private Limited" }), { verified: true });
  assert.equal((await check({ source_url: REGISTER, quote: "Sunrise Finance Limited, active" })).verified, false);
  assert.equal((await check({ source_url: "mynt://case", quote: "guaranteed 12% returns" })).verified, true);
  assert.equal((await check({ source_url: "http://regulator.example/x", quote: "N-14.03268 Sunrise" })).verified, false);
  await assert.rejects(fetchPublic("https://127.0.0.1/"), /not a public host/);
  await assert.rejects(fetchPublic("http://example.com/"), /only https/);
});

function fakeSandboxHost() {
  const sandboxes = new Map();
  let n = 0;
  return {
    sandboxes,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), running: false, stopped: false });
      return { id, state: "provisioning" };
    },
    async getSandbox(id) {
      return sandboxes.get(id);
    },
    async writeFile(id, path, content) {
      sandboxes.get(id).files.set(path, content);
    },
    async readFile(id, path) {
      return sandboxes.get(id).files.get(path) ?? null;
    },
    async exec(id) {
      sandboxes.get(id).running = true;
      return { processId: 99, exitCode: null, stdout: "", stderr: "" };
    },
    async commandStatus(id) {
      return { running: sandboxes.get(id).running, exitCode: 0 };
    },
    async costDollars() {
      return 0.01;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    finish(id, review, cost = 0.8) {
      const s = sandboxes.get(id);
      s.files.set(`${CWD}/job/review.json`, JSON.stringify(review));
      s.files.set(`${A}/state.json`, JSON.stringify({ done: true, last_subtype: "success", cost_usd: cost, summary: "Register shows the registration cancelled" }));
      s.running = false;
    },
  };
}

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const sandboxes = fakeSandboxHost();
  const pages = { [REGISTER]: REGISTER_PAGE };
  const fetcher = async (url) => (pages[url] ? { ok: true, status: 200, contentType: "text/html", text: pages[url] } : { ok: false, status: 404, contentType: "text/html", text: "" });
  const host = { agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, model: "claude-opus-5-5", publicUrl: "https://mynt.example.com" };
  const review = await ReviewService.open(db, store, sandboxes, reviewConfigFromEnv(host, {}), null, fetcher);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { review }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  return { pg, store, review, sandboxes, connect, call };
}

test("a licence review: the agent works in its workspace, Mynt verifies its evidence and recommends, the admin decides", async () => {
  const { pg, store, review, sandboxes, connect, call } = await setup();
  const { user: inno } = await store.createUser("Ines", ["innovator"]);
  await licensed(store, inno, { region: "IN", category: "deposits", action: "issuance" });
  const pending = await store.registerLicense(inno.id, { entity_id: inno.entity_id, region: "IN", regulator_id: "test_deposits_issuance", license_id: "lic", registration_number: "N-14.03268", valid_from: null, valid_to: null }).catch(async () => {
    // licensed() already registered one; use it, back to pending.
    const r = (await pg.query("SELECT id FROM financial_products.held_licenses LIMIT 1")).rows[0];
    await pg.query("UPDATE financial_products.held_licenses SET status = 'pending', registration_number = 'N-14.03268' WHERE id = $1", [r.id]);
    return { id: r.id };
  });
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const admin = await connect(adminUser);
  const opened = (await call(admin, "open_review_case", { subject_kind: "license", subject_id: pending.id })).data;
  assert.equal(opened.status, "queued");
  assert.match((await call(admin, "open_review_case", { subject_kind: "license", subject_id: pending.id })).data.error, /already running/);

  await review.tick();
  const sbx = (await review.get(opened.case_id)).sandbox_id;
  assert.deepEqual(sandboxes.sandboxes.get(sbx).opts.env, {}, "no credentials in the review sandbox");
  sandboxes.ready(sbx);
  await review.tick();
  const files = sandboxes.sandboxes.get(sbx).files;
  assert.ok(files.get(`${CWD}/CLAUDE.md`).includes("Mynt governance review"), "the workspace is the agent's working directory");
  assert.ok(files.has(`${CWD}/.claude/skills/review-licence/SKILL.md`) && files.has(`${CWD}/scripts/check_review.py`));
  const kase = JSON.parse(files.get(`${CWD}/job/case.json`));
  assert.equal(kase.subject.licence.registration_number, "N-14.03268");
  assert.deepEqual(kase.items.map((i) => i.id), ["register_entry", "holder_matches", "type_matches", "in_force", "no_enforcement"], "only the items needing research");
  assert.equal(JSON.parse(files.get(`${A}/config.json`)).cwd, CWD);
  const { token } = JSON.parse(files.get(`${A}/auth.json`));
  assert.equal(await review.agentTokenActive(token), true);

  sandboxes.finish(sbx, {
    items: [
      { id: "register_entry", status: "met", evidence: [{ source_url: REGISTER, quote: "N-14.03268 Sunrise Finance Private Limited" }] },
      { id: "holder_matches", status: "met", evidence: [{ source_url: REGISTER, quote: "Holder: Sunrise Finance Private Limited (active)" }] },
      { id: "type_matches", status: "silent" },
      { id: "in_force", status: "not_met", evidence: [{ source_url: REGISTER, quote: "NBFC-ICC Cancelled" }], note: "The register shows it cancelled" },
      { id: "no_enforcement", status: "silent", searched_for: "Orders page for N-14.03268" },
    ],
    suggestions: ["Add a script for the regulator's register search"],
  });
  await review.tick();
  const ready = (await call(admin, "get_review_case", { case_id: opened.case_id })).data;
  assert.equal(ready.status, "ready");
  const status = Object.fromEntries(ready.items.map((i) => [i.id, i.status]));
  assert.deepEqual(status, {
    licence_type_defined: "met",
    register_entry: "met",
    holder_matches: "unverified",
    type_matches: "not_reviewed",
    in_force: "not_met",
    no_enforcement: "silent",
  });
  assert.equal(ready.items.find((i) => i.id === "holder_matches").evidence[0].reason, "the quote isn't on that page");
  assert.equal(ready.recommendation.verdict, "reject");
  assert.match(ready.recommendation.reason, /In force/);
  assert.deepEqual(ready.suggestions, ["Add a script for the regulator's register search"]);
  assert.equal(await review.agentTokenActive(token), false, "the token dies with the run");
  assert.ok(sandboxes.sandboxes.get(sbx).stopped);

  const decided = (await call(admin, "decide_review_case", { case_id: opened.case_id, decision: "reject", note: "Register shows the registration cancelled" })).data;
  assert.deepEqual(decided, { decision: "reject", applied: "licence rejected" });
  assert.equal((await store.getHeldLicense(pending.id)).status, "rejected");
  const audit = (await call(admin, "audit_log", { limit: 5 })).data;
  assert.ok(JSON.stringify(audit).includes("decide_review_case"));
  assert.match((await call(admin, "decide_review_case", { case_id: opened.case_id, decision: "verify", note: "again" })).data.error, /only a ready case/);
});

test("a product review: Mynt decides coverage, tests and segments itself; the agent may quote the case", async () => {
  const { store, review, sandboxes } = await setup();
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const c = await review.openCase("product", CATALOG.find((p) => p.region === "IN").id, adminUser.id);
  await review.tick();
  const sbx = (await review.get(c.id)).sandbox_id;
  sandboxes.ready(sbx);
  await review.tick();
  const kase = JSON.parse(sandboxes.sandboxes.get(sbx).files.get(`${CWD}/job/case.json`));
  const quote = kase.subject.product.description.slice(0, 40);
  sandboxes.finish(sbx, {
    items: [
      { id: "regulatory_limits", status: "silent", searched_for: "Recorded law for this product: none sets limits" },
      { id: "claims_not_misleading", status: "met", evidence: [{ source_url: "mynt://case", quote }] },
      { id: "disclosures_adequate", status: "silent", searched_for: "No disclosure duties recorded" },
    ],
  });
  await review.tick();
  const done = await review.get(c.id);
  const status = Object.fromEntries(done.items.map((i) => [i.id, i.status]));
  assert.equal(status.covered_by_verified_licence, "not_met", "a bundled product has no firm or licence");
  assert.equal(status.claims_not_misleading, "met");
  assert.equal(status.feasibility_current, "silent");
  assert.equal(done.recommendation.verdict, "reject");
  assert.equal((await review.decide(c.id, adminUser, "needs_info", "Waiting on the firm")).applied, null, "a product decision changes nothing by itself");
});

test("only admins get the governance desk", async () => {
  const { store, connect } = await setup();
  for (const role of ["consumer", "developer", "innovator"]) {
    const { user } = await store.createUser(role, [role]);
    const tools = (await (await connect(user)).listTools()).tools.map((t) => t.name);
    assert.ok(!tools.some((t) => t.includes("review_case")), role);
  }
});

test("a provider's passing 5xx doesn't fail a review; a persistent one, quota exhaustion or a real error does", async () => {
  const { store, review, sandboxes } = await setup();
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const product = CATALOG.find((p) => p.region === "IN").id;
  const real = sandboxes.getSandbox;
  const failWith = (msg) => {
    sandboxes.getSandbox = async () => {
      throw new Error(msg);
    };
  };
  const heal = () => {
    sandboxes.getSandbox = real;
  };
  const outage = 'sandboxes GET /sandboxes/sbx: 503 {"code":"INTERNAL_ERROR"}';
  const open = async () => {
    const c = await review.openCase("product", product, adminUser.id);
    await review.tick(); // sandbox requested
    return c;
  };

  // A passing outage: the case rides it out and carries on.
  const a = await open();
  failWith(outage);
  await review.tick();
  await review.tick();
  assert.equal((await review.get(a.id)).status, "provisioning", "a passing outage is ridden out");
  heal();
  sandboxes.ready((await review.get(a.id)).sandbox_id);
  await review.tick();
  assert.equal((await review.get(a.id)).status, "reviewing");
  await review.stop(a.id, "done with it");

  // An outage that outlasts the grace period fails the case, with the provider's error.
  const grace = ReviewService.TRANSIENT_GRACE_MS;
  ReviewService.TRANSIENT_GRACE_MS = 30;
  const b = await open();
  failWith(outage);
  await review.tick();
  assert.equal((await review.get(b.id)).status, "provisioning");
  await new Promise((r) => setTimeout(r, 50));
  await review.tick();
  ReviewService.TRANSIENT_GRACE_MS = grace;
  heal();
  assert.equal((await review.get(b.id)).status, "failed", "an outage past the grace fails the case");
  assert.match((await review.get(b.id)).error, /503/);

  // A provider out of allowance fails at once, saying what to do.
  const q = await open();
  failWith("sandboxes: LIMIT_EXCEEDED: allowance for sandboxes has been used");
  await review.tick();
  heal();
  assert.equal((await review.get(q.id)).status, "failed", "quota exhaustion fails at once");
  assert.match((await review.get(q.id)).error, /add billing/);

  // Any other error fails at once.
  const bad = await open();
  failWith("sandboxes GET /sandboxes/sbx: 400 bad request");
  await review.tick();
  heal();
  assert.equal((await review.get(bad.id)).status, "failed", "a real error fails at once");
  assert.match((await review.get(bad.id)).error, /400/);
});
