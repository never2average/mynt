import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { HostingService } from "../dist/hosting.js";
import { createMcpHttpServer } from "../dist/http.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { EDGE_KEY_HEADER } from "../dist/freestyle.js";
import { serviceEndpoint } from "../dist/services.js";
import { callVendor, resolveVendorUrl } from "../dist/vendor-call.js";
import { servedAt, vendorPrefill } from "../dist/vendors.js";
import { planAppRemoval } from "../dist/app-removal.js";
import { CATALOG } from "./helpers.js";

// Services: the third kind built on Mynt. A service is an app record of kind 'service' with its one vendor offering,
// built and hosted like an app. These tests cover who may create one, that its endpoint is derived and never typed,
// that its signing secret reaches it only as a hosted setting, that Mynt's calls carry a signature and nothing else
// (no app key, no credential), that every build that goes online is tested before it serves anyone, what going
// offline, archiving and removal do, its promotion checks (Production is listed), and the request path for a new
// service type.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");

const idleSandboxes = {
  async createSandbox() {
    return { id: "sbx", state: "provisioning" };
  },
  async getSandbox() {
    return undefined;
  },
  async stop() {},
  async readFile() {
    return null;
  },
  async exec() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  async costDollars() {
    return 0;
  },
};

// A direct hosting provider: records the deploy job's environment (where a service's settings arrive) and the
// egress rules (where an app's key is added, for calls out to Mynt only).
function fakeDirect() {
  return {
    name: "freestyle",
    direct: true,
    jobs: [],
    injected: new Map(),
    egress: new Map(),
    deleted: [],
    deployExit: 0,
    async usage() {
      return { seconds: 0 };
    },
    vms: [],
    routes: new Map(), // address -> the VM it is served from, as the host's edge would route it
    onVm: async () => {},
    async createVm(slug) {
      const id = `vm-${slug}`;
      this.vms.push(id);
      await this.onVm(id);
      return { id };
    },
    async run(vmId, command, opts = {}) {
      if (command.includes("useradd")) return { exitCode: 0, stdout: "29.1.3\nruntime: runc\n", stderr: "" };
      if (command.includes("nohup bash")) {
        this.jobs.push({ vmId, command, env: opts.env });
        return { exitCode: 0, stdout: "started\n", stderr: "" };
      }
      if (command.startsWith("cat ") && command.includes(".exit")) return { exitCode: 0, stdout: `${this.deployExit}\n`, stderr: "" };
      if (command.startsWith("tail -c 8000")) return { exitCode: 0, stdout: this.deployExit ? `boom ${this.jobs.at(-1).env.MYNT_VENDOR_SIGNING_SECRET ?? ""}` : "running", stderr: "" };
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async setEgress(vmId, hosts, inject = {}) {
      this.egress.set(vmId, hosts);
      this.injected.set(vmId, inject);
    },
    async setRoute(vmId, domain) {
      this.routes.set(domain, vmId);
    },
    async removeRoute(domain) {
      this.routes.delete(domain);
    },
    async pause() {},
    async start() {},
    deleteFails: false,
    async deleteVm(vmId) {
      if (this.deleteFails) throw new Error("the host answered 503");
      this.deleted.push(vmId);
      for (const [domain, vm] of this.routes) if (vm === vmId) this.routes.delete(domain);
    },
  };
}

// The service as its build would run it: POST /mynt/services/<key>, verified by Mynt-Signature with the secret the
// deploy handed it, and nothing else. It records every request's headers.
async function serviceServer(secretOf, mode = "ok") {
  // hold: a promise the build waits on before answering, so a test can look around while Mynt is still testing it.
  const state = { mode, requests: [], hold: null };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    state.requests.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (state.hold) await state.hold;
    const reply = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (state.mode === "missing") return reply(404, { error: "not_found" });
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers["mynt-signature"] ?? "");
    const secret = secretOf();
    const good = m && secret && Math.abs(Date.now() / 1000 - Number(m[1])) <= 300 && timingSafeEqual(createHmac("sha256", secret).update(`${m[1]}.${raw}`).digest(), Buffer.from(m[2], "hex"));
    if (!good) return reply(401, { error: "bad_signature" });
    const body = JSON.parse(raw);
    // "leaky": a build that echoes its own settings into its answers.
    reply(200, { request_id: body.request_id, status: "ok", output: state.mode === "bad_output" ? { score: "high" } : (state.output ?? { score: 712, band: "good" }), error: null, ...(state.mode === "leaky" ? { debug: { secret, authorization: "Bearer abcdefghijklmnop" } } : {}) });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { state, origin: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
}

const SCORE = {
  region: "US",
  key: "cashflow_score",
  name: "Cash-flow score",
  category: "analytics",
  moves_money: false,
  input_schema: { type: "object", required: ["full_name"], properties: { full_name: { type: "string", description: "The customer's name" } }, additionalProperties: false },
  output_schema: { type: "object", required: ["score", "band"], properties: { score: { type: "integer", minimum: 300, maximum: 850 }, band: { type: "string", enum: ["poor", "fair", "good"] } }, additionalProperties: false },
  consent_purpose: "cashflow_scoring",
  fills: [],
  innovator_licences: [],
  vendor_licences: [],
};
const TERMS = { document_url: "https://scores.example.com/terms-v1.pdf", document_sha256: "a".repeat(64), summary: "Standard terms.", pricing_summary: "USD 0.10 per score", scopes: ["technology"] };
const PUBLIC_URL = "https://mynt.example.com";

const closers = [];
after(() => closers.forEach((c) => c()));

async function world() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  await BuildService.open(db, store, idleSandboxes, null, { ...buildConfigFromEnv({}), publicUrl: PUBLIC_URL, agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } });
  const provider = fakeDirect();
  const hosting = await HostingService.open(db, provider, { publicUrl: PUBLIC_URL, gatewayEndpoint: "", gatewayPublicKey: "", gatewayIp: "", region: "x", size: "x", appsDomain: null }, async () => "ghs_readonly");
  hosting.githubFetch = async () => new Response("{}", { status: 404 });
  hosting.jobPollMs = 1;
  hosting.drainMs = 0;
  // Each VM the host creates runs its own copy of the service, which verifies with the secret its own deploy job
  // handed it. `app` is the first one (the copy a first deploy puts online); `next` is how the next copy behaves.
  const secretOn = (vmId) => provider.jobs.findLast((j) => j.vmId === vmId)?.env.MYNT_VENDOR_SIGNING_SECRET;
  const copies = new Map();
  const next = { mode: "ok", hold: null };
  const app = await serviceServer(() => secretOn(provider.vms[0]));
  closers.push(app.close);
  provider.onVm = async (vmId) => {
    if (!copies.size) return void copies.set(vmId, app);
    const copy = await serviceServer(() => secretOn(vmId), next.mode);
    copy.state.hold = next.hold;
    closers.push(copy.close);
    copies.set(vmId, copy);
  };
  // Mynt's calls go where the host routes the address Mynt derived for the copy.
  const appAddress = (_appId, copy) => copies.get(provider.routes.get(copy?.domain))?.origin ?? app.origin;
  const ctx = { hosting, vendors: { allowInsecureLoopback: true, timeoutMs: 800, appAddress } };
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, ctx).connect(s);
    const client = new Client({ name: "services", version: "0" });
    await client.connect(c);
    return async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      let data;
      try {
        data = JSON.parse(res.content[0].text);
      } catch {
        data = { error: res.content[0].text };
      }
      return { isError: res.isError ?? false, data };
    };
  };
  const ok = async (call, name, args = {}) => {
    const r = await call(name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const person = async (name, roles, entityId = null) => {
    const { user } = await store.createUser(name, roles);
    if (entityId) await store.setUserEntity(user.id, entityId);
    const fresh = (await store.getUser(user.id)) ?? user;
    return { user: fresh, call: await connect(fresh) };
  };
  const root = await person("Root", ["admin"]);
  const firm = await store.createEntity(root.user.id, { name: "Scoreworks", registration_numbers: {}, regions: ["US"] });
  const other = await store.createEntity(root.user.id, { name: "Otherco", registration_numbers: {}, regions: ["US"] });
  await ok(root.call, "define_service_type", { service_type: SCORE });
  const vera = await person("Vera", ["developer", "vendor"], firm.id); // builds and holds the vendor role
  const dan = await person("Dan", ["developer"], firm.id); // builds, without the vendor role
  const ws = await ok(vera.call, "create_workspace", { name: "Scoreworks team" });
  await ok(vera.call, "request_hosting", { workspace_id: ws.id });
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, dan.user.id]);
  await pg.query("INSERT INTO financial_products.repo_connections (developer_id, repository, installation_id, approval) VALUES ($1, 'scoreworks/score', 1, 'approved')", [vera.user.id]);
  let clock = Date.now() - 3600_000;
  const build = async (appId, sha) => {
    const id = randomUUID();
    clock += 1000;
    await pg.query(
      `INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd, repository, commit_sha, source_sha256, created_at, updated_at, finished_at)
       VALUES ($1, $2, $3, 'build it', 'succeeded', 5, 'scoreworks/score', $4, $5, $6, $6, $6)`,
      [id, vera.user.id, appId, sha, "ab".repeat(32), new Date(clock).toISOString()],
    );
    return id;
  };
  const create = (extra = {}) => ok(vera.call, "create_service", { workspace_id: ws.id, name: "Cash-flow score", description: "Scores a customer's cash flow.", service_type: "cashflow_score", region: "US", ...extra });
  const offering = async (serviceId) => (await pg.query("SELECT * FROM financial_products.vendor_offerings WHERE app_id = $1", [serviceId])).rows[0];
  const deploy = async (serviceId, sha = "a".repeat(40)) => {
    const buildId = await build(serviceId, sha);
    const r = await ok(vera.call, "deploy_app", { app_id: serviceId, build_id: buildId });
    await hosting.pending;
    return { buildId, deployed: r };
  };
  // One request as Mynt sends it to whatever serves the offering right now: the endpoint and the secret read together.
  const callServing = async (offeringId) => {
    const at = await servedAt(store.db, offeringId);
    const body = { request_id: randomUUID(), environment: "test", input: { full_name: "Asha Verma" }, consent: { purpose: "cashflow_scoring", artefact_ref: "x", given_at: new Date().toISOString() } };
    return callVendor({ base_url: at.test_base_url, service_type: "cashflow_score", body, signing_secret: at.secret, exact_url: true }, ctx.vendors);
  };
  return { pg, store, hosting, provider, app, copies, next, ctx, connect, ok, person, root, firm, other, vera, dan, ws, build, create, offering, deploy, callServing };
}

test("creating a service: the vendor role, a firm, and an owner or admin of the workspace; one service type and region, its offering made with it", async () => {
  const w = await world();
  // No vendor role: the tool isn't theirs at all, and nothing else creates a service.
  const refused = await w.dan.call("create_service", { workspace_id: w.ws.id, name: "X", description: "x", service_type: "cashflow_score", region: "US" });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.data), /not found|Unknown tool|create_service/i);
  // The vendor role, but only a member of the workspace.
  const mem = await w.person("Mem", ["developer", "vendor"], w.firm.id);
  await w.pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [w.ws.id, mem.user.id]);
  assert.match((await mem.call("create_service", { workspace_id: w.ws.id, name: "X", description: "x", service_type: "cashflow_score", region: "US" })).data.error, /owners and admins/);
  // The vendor role with no firm.
  const loose = await w.person("Loose", ["developer", "vendor"]);
  assert.match((await loose.call("create_service", { name: "X", description: "x", service_type: "cashflow_score", region: "US" })).data.error, /Ask a Mynt admin/);
  // Not somebody else's workspace, not a type that doesn't exist, never the ramp.
  const outsider = await w.person("Out", ["developer", "vendor"], w.other.id);
  assert.match((await outsider.call("create_service", { workspace_id: w.ws.id, name: "X", description: "x", service_type: "cashflow_score", region: "US" })).data.error, /No workspace of yours/);
  assert.match((await w.vera.call("create_service", { workspace_id: w.ws.id, name: "X", description: "x", service_type: "nope", region: "US" })).data.error, /request_service_type/);

  const s = await w.create();
  assert.equal(s.kind, "service");
  assert.equal(s.stage, "idea");
  assert.deepEqual([s.service_type.key, s.service_type.region, s.firm.name], ["cashflow_score", "US", "Scoreworks"]);
  assert.equal(s.offering.status, "draft");
  assert.equal(s.contract.endpoint.app_path, "/mynt/services/cashflow_score");
  assert.equal(s.contract.endpoint.address, null, "no address until it is online");
  assert.equal(s.hosted, null);
  assert.ok(!/mvs_/.test(JSON.stringify(s)), "the signing secret is never in an answer");
  const row = await w.offering(s.id);
  assert.deepEqual([row.entity_id, row.test_base_url, row.live_base_url, row.requires_credential], [w.firm.id, null, null, false]);
  const app = await w.store.getApp(s.id);
  assert.deepEqual([app.kind, app.product_ids, app.workspace_id], ["service", [], w.ws.id]);
  // 1:1, by the schema too.
  await assert.rejects(w.pg.query("INSERT INTO financial_products.vendor_offerings (id, entity_id, region, service_type, name, price, conformance_secret, app_id) SELECT gen_random_uuid(), entity_id, region, service_type, 'again', price, conformance_secret, app_id FROM financial_products.vendor_offerings"));

  // Its workspace reads it; another firm's builder doesn't; an app isn't a service.
  assert.equal((await w.ok(w.dan.call, "get_service", { service_id: s.id })).vendor_role, false);
  assert.match((await outsider.call("get_service", { service_id: s.id })).data.error, /No service of yours/);
  const listed = await w.ok(w.vera.call, "list_my_services", {});
  assert.deepEqual(listed.map((x) => [x.id, x.stage, x.status_words, x.online]), [[s.id, "idea", "Needs conformance", false]]);
  // The checklist, in order, starting with the role.
  assert.deepEqual(s.checklist.map((c) => c.key), ["vendor_role", "app_online", "service_endpoint", "practice", "conformance", "terms", "listed"]);
  assert.match(s.checklist[1].detail, /Put the service online first/);
  // The fields as tables.
  assert.deepEqual(s.contract.input_fields, [{ field: "full_name", type: "string", required: true, description: "The customer's name" }]);
  assert.deepEqual(s.contract.output_fields.map((f) => [f.field, f.type, f.required]), [["score", "integer", true], ["band", "string (poor | fair | good)", true]]);
  // Audited.
  const audit = (await w.pg.query("SELECT details FROM financial_products.audit_log WHERE action = 'create_service' AND target = $1", [s.id])).rows[0];
  assert.equal(audit.details.service_type, "cashflow_score");
});

test("the endpoint is derived, never typed; the secret arrives only as a hosted setting; Mynt's calls carry a signature and no key", async () => {
  const w = await world();
  const s = await w.create();
  const row0 = await w.offering(s.id);
  // Nobody types an endpoint, takes a credential, or lists it by hand.
  for (const args of [{ test_base_url: "https://elsewhere.example.com" }, { live_base_url: "https://elsewhere.example.com" }, { requires_credential: true }])
    assert.match((await w.vera.call("update_vendor_offering", { offering_id: row0.id, ...args })).data.error, /can't be set/);
  assert.match((await w.vera.call("update_vendor_offering", { offering_id: row0.id, listed: true })).data.error, /moving it to Production/);
  // Before it is online there is nothing to test.
  assert.match((await w.vera.call("run_conformance", { offering_id: row0.id })).data.error, /Put the service online first/);

  const { buildId, deployed } = await w.deploy(s.id);
  // The secret: in the deploy job's environment, never in its text, never in an answer.
  const job = w.provider.jobs.at(-1);
  const secret = job.env.MYNT_VENDOR_SIGNING_SECRET;
  assert.match(secret, /^mvs_[A-Za-z0-9_-]{40,}$/);
  assert.ok(!job.command.includes(secret) && !job.env.JOB_SCRIPT.includes(secret), "as environment, never in the command or the script");
  assert.match(job.env.JOB_SCRIPT, /-e MYNT_VENDOR_SIGNING_SECRET/, "a Dockerfile app is passed the setting by name");
  assert.ok(!JSON.stringify(deployed).includes(secret));
  assert.equal(job.env.MYNT_API_KEY, "mynt_test_injected_at_edge", "the service holds only the key placeholder");
  // The edge adds the service's key to its own calls out to Mynt's host, and to nothing else.
  const inject = w.provider.injected.get(job.vmId);
  assert.deepEqual(Object.keys(inject), ["mynt.example.com"]);
  const appKey = inject["mynt.example.com"][EDGE_KEY_HEADER];
  assert.match(appKey, /^mynt_test_/);

  // The offering follows the deploy, and Mynt tested the build itself as soon as it answered.
  const row = await w.offering(s.id);
  assert.equal(row.test_base_url, `${w.app.origin}/mynt/services/cashflow_score`);
  assert.equal(row.live_base_url, row.test_base_url);
  assert.equal(row.app_build_id, buildId);
  assert.equal(row.status, "conformance_passed", "Mynt's own test of the new build passed");
  assert.equal(deployed.service.status, "draft", "off until that test passes");
  const run = (await w.pg.query("SELECT passed, run_by, cases FROM financial_products.vendor_conformance_runs WHERE offering_id = $1", [row.id])).rows[0];
  assert.deepEqual([run.passed, run.run_by], [true, null], "run by Mynt, not by a person and not by the service");
  assert.deepEqual(run.cases.map((c) => [c.case, c.passed]), [["fixture_1", true], ["bad_signature_refused", true], ["stale_timestamp_refused", true]]);

  // What reached the service: the fixed path, a signature, and neither the app key nor any credential.
  assert.ok(w.app.state.requests.length >= 3);
  for (const r of w.app.state.requests) {
    assert.equal(`${r.method} ${r.url}`, "POST /mynt/services/cashflow_score", "the derived path, with no /v1/<key> appended");
    assert.match(r.headers["mynt-signature"], /^t=\d+,v1=[0-9a-f]{64}$/);
    assert.equal(r.headers.authorization, undefined, "no credential");
    assert.equal(r.headers[EDGE_KEY_HEADER], undefined, "no app key header");
    assert.ok(!JSON.stringify(r.headers).includes(appKey) && !JSON.stringify(r.headers).includes("mynt_test_"), "the app's key is nowhere on a vendor call");
  }
  // An unsigned request, and one signed with another secret, are refused by the service (401): conformance sent the second.
  const unsigned = await fetch(`${w.app.origin}/mynt/services/cashflow_score`, { method: "POST", headers: { "Content-Type": "application/json", [EDGE_KEY_HEADER]: appKey, Authorization: `Bearer ${appKey}` }, body: "{}" });
  assert.equal(unsigned.status, 401, "an app key gets a caller nowhere: only Mynt-Signature authenticates");

  // No per-subscriber secret to take: there is one, the service's, shown to nobody.
  const view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(view.hosted.online, true);
  assert.equal(view.conformance.tested_build_id, buildId);
  assert.deepEqual(view.conformance.runs.map((r) => [r.kind, r.passed, r.passed_cases, r.total_cases]), [["conformance", true, 3, 3]]);
  assert.ok(view.activity.some((a) => a.action === "service_conformance_after_deploy" && a.detail === "Passed" && a.by === "Mynt"));
  const mine = await w.ok(w.vera.call, "list_my_offerings", {});
  assert.deepEqual(mine[0].service, { id: s.id, name: "Cash-flow score" });
  assert.ok(!JSON.stringify(mine).includes(secret));
});

test("outbound rules for a hosted address: public HTTPS only, and the address is the provider's, not Mynt's own host", async () => {
  // Where Mynt calls a service in production: the hosting provider's address for it, plus the fixed path.
  const hosting = { appDomain: (id) => `mynt-${id.slice(0, 8)}.style.dev` };
  const id = randomUUID();
  assert.equal(serviceEndpoint(hosting, null, id, "cashflow_score"), `https://mynt-${id.slice(0, 8)}.style.dev/mynt/services/cashflow_score`);
  // A compose project: its web service's address (which forwards the path to the api).
  const hosted = { status: "running", build_id: id, error: null, services: [{ expose: "api", domain: "a-api.style.dev" }, { expose: "web", domain: "a.style.dev" }] };
  assert.equal(serviceEndpoint(hosting, hosted, id, "x"), "https://a.style.dev/mynt/services/x");
  // The same outbound rules as any vendor call: an address that is private, loopback or plain HTTP is refused.
  for (const bad of ["http://127.0.0.1/mynt/services/x", "https://127.0.0.1/mynt/services/x", "https://10.0.0.5/mynt/services/x", "https://169.254.169.254/mynt/services/x", "http://a.style.dev/mynt/services/x"])
    await assert.rejects(resolveVendorUrl(bad), /private, loopback|HTTPS only/);
});

const until = async (f, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    if (await f()) return;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const PATH = "/mynt/services/cashflow_score";

test("a first build, or one put online while nothing serves, goes in place: Mynt tests it itself, and a failure stays off", async () => {
  const w = await world();
  const s = await w.create();
  // The first build doesn't answer the contract: nothing serves yet, so nothing is callable.
  w.app.state.mode = "bad_output";
  const first = await w.deploy(s.id);
  assert.equal(first.deployed.service.status, "draft");
  let row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id], ["draft", first.buildId]);
  const id = row.id;
  const view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.equal(view.conformance.needed, true);
  assert.ok(view.reliability.incidents.some((i) => i.what === "Mynt's conformance test failed"));
  // Fixed. Nothing was serving, so the next build replaces it in place (one copy), and Mynt tests it on deploy.
  w.app.state.mode = "ok";
  const second = await w.deploy(s.id, "b".repeat(40));
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id, row.candidate_id], ["conformance_passed", second.buildId, null]);
  assert.equal(w.provider.vms.length, 1, "no second copy when nothing was serving");
  // By hand works too.
  await w.pg.query("UPDATE financial_products.vendor_offerings SET status = 'draft' WHERE id = $1", [id]);
  assert.equal((await w.ok(w.vera.call, "run_conformance", { offering_id: id })).status, "conformance_passed");

  // A deploy that fails to build, with nothing serving: nothing is tested, and the offering stays off.
  await w.pg.query("UPDATE financial_products.vendor_offerings SET status = 'draft' WHERE id = $1", [id]);
  w.provider.deployExit = 1;
  const failed = await w.deploy(s.id, "d".repeat(40));
  row = await w.offering(s.id);
  assert.equal(row.status, "draft");
  const hostedRow = (await w.pg.query("SELECT status, error FROM financial_products.hosted_apps WHERE app_id = $1", [s.id])).rows[0];
  assert.equal(hostedRow.status, "stopped");
  assert.ok(!hostedRow.error.includes("mvs_"), "the signing secret is scrubbed from a failed deploy's output");
  assert.match((await w.vera.call("run_conformance", { offering_id: id })).data.error, /isn't online/);
  assert.ok(failed.buildId);

  // The endpoint isn't in the build: the checklist says so in plain words.
  w.provider.deployExit = 0;
  w.app.state.mode = "missing";
  await w.deploy(s.id, "e".repeat(40));
  const missing = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.match(missing.checklist.find((c) => c.key === "service_endpoint").detail, /answered 404 at \/mynt\/services\/cashflow_score/);
});

test("no gap for subscribers: a new build goes online beside the one serving, and Mynt switches only after it passes; a failure is removed and shown", async () => {
  const w = await world();
  w.ctx.vendors.timeoutMs = 6000;
  const s = await w.create();
  const first = await w.deploy(s.id);
  const id = (await w.offering(s.id)).id;
  await w.ok(w.vera.call, "update_vendor_offering", { offering_id: id, standard_terms: TERMS });
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "staging" });
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "production" });
  assert.equal((await w.offering(s.id)).status, "listed", "Production is listed");
  const subscriber = await w.person("Sam", ["innovator"], w.other.id);
  const listed = async () => (await w.ok(subscriber.call, "list_vendor_offerings", {})).some((o) => o.offering_id === id);
  const firstSecret = w.provider.jobs.at(-1).env.MYNT_VENDOR_SIGNING_SECRET;
  const firstVm = w.provider.vms[0];
  const serving = `${w.app.origin}${PATH}`;

  // Put a new build online and stop while Mynt is in the middle of testing it.
  const putOnline = async (sha, mode) => {
    let release;
    w.next.mode = mode;
    w.next.hold = new Promise((r) => (release = r));
    const buildId = await w.build(s.id, sha);
    const copies = w.copies.size;
    const deployed = await w.ok(w.vera.call, "deploy_app", { app_id: s.id, build_id: buildId });
    await until(() => w.copies.size > copies && [...w.copies.values()].at(-1).state.requests.length > 0, "Mynt's first request to the new build");
    return { buildId, deployed, copy: [...w.copies.values()].at(-1), vm: w.provider.vms.at(-1), finish: async () => (release(), (w.next.hold = null), await w.hosting.pending) };
  };

  // ---- a build that fails Mynt's test ----
  const bad = await putOnline("b".repeat(40), "bad_output");
  // The answer to Put online says what is happening: nothing about the offering changed.
  assert.deepEqual([bad.deployed.service.status, bad.deployed.service.serving_build_id, bad.deployed.service.testing_build_id], ["listed", first.buildId, bad.buildId]);
  assert.match(bad.deployed.service.next, /keeps serving and stays listed/);
  assert.ok(!JSON.stringify(bad.deployed).includes("mvs_"));
  // While Mynt is testing the new build: two copies online, and the old one is the one subscribers reach.
  assert.equal(w.provider.vms.length, 2, "the new build is a second copy, on a VM of its own");
  assert.notEqual(bad.vm, firstVm);
  let row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id, row.test_base_url, row.live_base_url, row.candidate_build_id], ["listed", first.buildId, serving, serving, bad.buildId]);
  assert.equal(await listed(), true, "still in the Marketplace while the new build is tested");
  const before = w.app.state.requests.length;
  const during = await w.callServing(id);
  assert.deepEqual([during.ok, during.http_status], [true, 200], "a subscriber's call is answered while the new build is being tested");
  assert.equal(w.app.state.requests.length, before + 1, "by the build that was serving");
  let view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.deepEqual([view.new_build.build_id, view.new_build.status, view.new_build.serving_build_id, view.hosted.build_id, view.offering.status], [bad.buildId, "testing", first.buildId, first.buildId, "listed"]);
  // The new copy got a signing secret of its own, as a hosted setting, never the serving copy's.
  const badSecret = w.provider.jobs.at(-1).env.MYNT_VENDOR_SIGNING_SECRET;
  assert.match(badSecret, /^mvs_[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(badSecret, firstSecret);
  assert.ok(!w.provider.jobs.at(-1).command.includes(badSecret) && !w.provider.jobs.at(-1).env.JOB_SCRIPT.includes(badSecret), "as environment, never in the command or the script");
  await bad.finish();
  // It failed: removed, and nothing changed for subscribers.
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id, row.test_base_url, row.candidate_id, row.candidate_secret], ["listed", first.buildId, serving, null, null]);
  assert.equal(await listed(), true);
  assert.ok(w.provider.deleted.includes(bad.vm), "the failed copy's VM is deleted");
  assert.ok(!w.provider.deleted.includes(firstVm));
  assert.ok(![...w.provider.routes.values()].includes(bad.vm), "and its address is gone");
  assert.deepEqual((await w.callServing(id)).http_status, 200);
  const hostedNow = (await w.pg.query("SELECT build_id::text AS build_id, status, vm_id FROM financial_products.hosted_apps WHERE app_id = $1", [s.id])).rows[0];
  assert.deepEqual([hostedNow.build_id, hostedNow.status, hostedNow.vm_id], [first.buildId, "running", firstVm]);
  // Shown plainly: a run of its own, with its cases and transcript, never the offering's standing result.
  view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.equal(view.new_build, null);
  const failedRun = view.conformance.runs.find((r) => r.new_build);
  assert.deepEqual([failedRun.kind, failedRun.passed, failedRun.switched, failedRun.build_id, failedRun.passed_cases, failedRun.total_cases], ["conformance", false, false, bad.buildId, 2, 3]);
  assert.match(failedRun.outcome, /Mynt's conformance test failed on it\. It was removed; the build that was serving kept serving/);
  assert.equal(failedRun.transcript.length, 3);
  assert.equal(view.conformance.tested_build_id, first.buildId);
  assert.ok(view.reliability.incidents.some((i) => /didn't take over: Mynt's conformance test failed on it/.test(i.what)));
  assert.ok(view.activity.some((a) => a.action === "service_build_not_switched" && a.by === "Mynt"));
  assert.ok(!JSON.stringify(view).includes(badSecret) && !JSON.stringify(view).includes(firstSecret));
  // The standing record other readers use (listing, the marketplace, promotion checks) never saw the failure.
  const standing = (await w.pg.query("SELECT passed, build_id::text AS build_id FROM financial_products.vendor_conformance_runs WHERE offering_id = $1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
  assert.deepEqual([standing.passed, standing.build_id], [true, first.buildId]);

  // ---- a build that passes ----
  const good = await putOnline("c".repeat(40), "ok");
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id, row.test_base_url], ["listed", first.buildId, serving], "nothing is switched before the test has passed");
  assert.equal((await w.callServing(id)).http_status, 200);
  assert.equal(await listed(), true);
  const goodSecret = w.provider.jobs.at(-1).env.MYNT_VENDOR_SIGNING_SECRET;
  await good.finish();
  // Passed: the endpoint, the secret and the hosted copy switched together, and it never left the list.
  row = await w.offering(s.id);
  const switchedTo = `${good.copy.origin}${PATH}`;
  assert.deepEqual([row.status, row.app_build_id, row.test_base_url, row.live_base_url, row.candidate_id, row.candidate_secret], ["listed", good.buildId, switchedTo, switchedTo, null, null]);
  assert.notEqual(switchedTo, serving);
  assert.equal(await listed(), true);
  const served = await servedAt(w.store.db, id);
  assert.equal(served.secret, goodSecret, "the offering now signs with the new copy's secret");
  const n = good.copy.state.requests.length;
  assert.equal((await w.callServing(id)).http_status, 200);
  assert.equal(good.copy.state.requests.length, n + 1, "subscribers now reach the new build");
  // The old secret is no use against the new build.
  const stale = await callVendor({ base_url: switchedTo, service_type: "cashflow_score", body: { request_id: randomUUID() }, signing_secret: firstSecret, exact_url: true }, w.ctx.vendors);
  assert.equal(stale.http_status, 401);
  // The copy that served until then is removed; the new copy's VM is the service's.
  assert.ok(w.provider.deleted.includes(firstVm));
  assert.ok(!w.provider.deleted.includes(good.vm));
  const hostedAfter = (await w.pg.query("SELECT build_id::text AS build_id, status, vm_id FROM financial_products.hosted_apps WHERE app_id = $1", [s.id])).rows[0];
  assert.deepEqual([hostedAfter.build_id, hostedAfter.status, hostedAfter.vm_id], [good.buildId, "running", good.vm]);
  assert.deepEqual((await w.hosting.candidatesOf(s.id)).map((c) => c.status), ["promoted", "failed"]);
  view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.deepEqual([view.hosted.build_id, view.conformance.tested_build_id, view.new_build], [good.buildId, good.buildId, null]);
  const passedRun = view.conformance.runs.find((r) => r.passed && r.build_id === good.buildId);
  assert.deepEqual([passedRun.kind, passedRun.new_build, passedRun.transcript.length], ["conformance", undefined, 3]);
  assert.ok(view.activity.some((a) => a.action === "service_build_switched"));
  // Every request any copy received: a signature and nothing else. No app key, no credential.
  for (const copy of w.copies.values())
    for (const r of copy.state.requests) {
      assert.equal(`${r.method} ${r.url}`, `POST ${PATH}`);
      assert.equal(r.headers.authorization, undefined);
      assert.equal(r.headers[EDGE_KEY_HEADER], undefined);
      assert.ok(!JSON.stringify(r.headers).includes("mynt_test_") && !JSON.stringify(r.headers).includes("mynt_live_"));
    }
  // The service's promotion checks still pass on the build now online.
  const conformance = (await w.pg.query("SELECT passed FROM financial_products.vendor_conformance_runs WHERE offering_id = $1 ORDER BY created_at DESC LIMIT 1", [id])).rows[0];
  assert.equal(conformance.passed, true);

  // ---- a build that doesn't start ----
  w.next.mode = "ok";
  w.provider.deployExit = 1;
  const dead = await w.deploy(s.id, "d".repeat(40));
  w.provider.deployExit = 0;
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id, row.test_base_url, row.candidate_id], ["listed", good.buildId, switchedTo, null]);
  assert.equal((await w.callServing(id)).http_status, 200);
  const deadCopy = (await w.hosting.candidatesOf(s.id))[0];
  assert.deepEqual([deadCopy.status, deadCopy.build_id], ["failed", dead.buildId]);
  assert.ok(!deadCopy.error.includes("mvs_"), "the signing secret is scrubbed from a failed deploy's output");
  assert.ok(w.provider.deleted.includes(w.provider.vms.at(-1)));
  view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  const deadRun = view.conformance.runs.find((r) => r.build_id === dead.buildId);
  assert.match(deadRun.outcome, /didn't start on Mynt's hosting/);
  assert.deepEqual([deadRun.transcript, deadRun.total_cases], [null, 0]);
  assert.match(deadRun.transcript_note, /Nothing was sent/);

  // ---- a removal the host didn't confirm is kept and tried again ----
  w.provider.deleteFails = true;
  w.next.mode = "bad_output";
  await w.deploy(s.id, "e".repeat(40));
  const stuckVm = w.provider.vms.at(-1);
  assert.ok(!w.provider.deleted.includes(stuckVm));
  assert.equal((await w.pg.query("SELECT vm_id FROM financial_products.hosted_candidates WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1", [s.id])).rows[0].vm_id, stuckVm, "still recorded");
  assert.equal((await w.offering(s.id)).status, "listed");
  w.provider.deleteFails = false;
  await w.hosting.cleanupCopies();
  assert.ok(w.provider.deleted.includes(stuckVm));

  // ---- offline and archive take a copy being tested with them ----
  const pending = await putOnline("f".repeat(40), "ok");
  const archived = await w.ok(w.vera.call, "archive_service", { service_id: s.id, reason: "retired" });
  assert.equal(archived.archived, true);
  await pending.finish();
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_pause, row.app_build_id, row.candidate_id], ["suspended", "stopped", good.buildId, null], "an archived service switches to nothing");
  assert.ok(w.provider.deleted.includes(pending.vm));
});

test("who may put a service online, and what a build must meet to take over in Production", async () => {
  const w = await world();
  const s = await w.create();
  const first = await w.deploy(s.id);
  const id = (await w.offering(s.id)).id;
  await w.ok(w.vera.call, "update_vendor_offering", { offering_id: id, standard_terms: TERMS });
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "staging" });
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "production" });

  // A plain member of the workspace (even at the firm) can't swap the build, take it down, restart it or run commands in it.
  await w.pg.query("INSERT INTO financial_products.repo_connections (developer_id, repository, installation_id, approval) VALUES ($1, 'scoreworks/score', 1, 'approved')", [w.dan.user.id]);
  const mine = await w.build(s.id, "b".repeat(40));
  const jobs = w.provider.jobs.length;
  assert.match((await w.dan.call("deploy_app", { app_id: s.id, build_id: mine })).data.error, /Only the workspace's owners and admins put a service online/);
  assert.match((await w.dan.call("undeploy_app", { app_id: s.id })).data.error, /owners and admins/);
  assert.match((await w.dan.call("app_run", { app_id: s.id, command: "env" })).data.error, /owners and admins run commands in a service or restart it/);
  assert.match((await w.dan.call("restart_app", { app_id: s.id })).data.error, /owners and admins/);
  // Nor an admin of the workspace who belongs to another firm.
  const olga = await w.person("Olga", ["developer", "vendor"], w.other.id);
  await w.pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')", [w.ws.id, olga.user.id]);
  await w.pg.query("INSERT INTO financial_products.repo_connections (developer_id, repository, installation_id, approval) VALUES ($1, 'scoreworks/score', 1, 'approved')", [olga.user.id]);
  assert.match((await olga.call("deploy_app", { app_id: s.id, build_id: mine })).data.error, /offered by another firm/);
  assert.match((await olga.call("undeploy_app", { app_id: s.id })).data.error, /offered by another firm/);
  assert.match((await olga.call("app_run", { app_id: s.id, command: "env" })).data.error, /another firm/);
  assert.equal(w.provider.jobs.length, jobs, "nothing was deployed, so nobody was handed a secret");
  let row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id], ["listed", first.buildId]);

  // Subscribers and the firm's checklist are the offering firm's (and Mynt's admins'): not a workspace member's from another firm.
  const sam = await w.person("Sam", ["innovator"], w.other.id);
  const outside = await w.ok(olga.call, "get_service", { service_id: s.id });
  assert.deepEqual([outside.subscribers, outside.checklist, outside.progress], [null, [], { done: 0, total: 0 }]);
  assert.match(outside.firm_only, /Scoreworks's people only/);
  assert.equal(outside.name, "Cash-flow score", "the rest of the service is theirs to read");
  const inside = await w.ok(w.dan.call, "get_service", { service_id: s.id });
  assert.ok(Array.isArray(inside.subscribers) && inside.checklist.length > 0 && inside.firm_only === undefined);

  // A build that passes conformance but has critical audit findings doesn't take over in Production.
  const flagged = await w.build(s.id, "c".repeat(40));
  await w.pg.query("UPDATE financial_products.build_runs SET maxwell = $2 WHERE id = $1", [flagged, JSON.stringify({ counts: { critical: 1, high: 0, medium: 0, low: 0 } })]);
  await w.ok(w.vera.call, "deploy_app", { app_id: s.id, build_id: flagged });
  await w.hosting.pending;
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id, row.candidate_id], ["listed", first.buildId, null], "conformance alone never switches a Production service to a build");
  let view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  const blocked = view.conformance.runs.find((r) => r.build_id === flagged);
  assert.deepEqual([blocked.passed, blocked.switched, blocked.new_build], [true, false, true]);
  assert.match(blocked.outcome, /passed Mynt's conformance test, but a service in Production also needs: Independent audit passed: 1 critical or high finding/);
  assert.ok(w.provider.deleted.includes(w.provider.vms.at(-1)), "the copy is removed");

  // The same when nothing is serving and a build goes online in place: passing conformance doesn't list it.
  await w.ok(w.vera.call, "undeploy_app", { app_id: s.id });
  assert.deepEqual([(await w.offering(s.id)).status, (await w.offering(s.id)).app_pause], ["suspended", "offline"]);
  await w.ok(w.vera.call, "deploy_app", { app_id: s.id, build_id: flagged });
  await w.hosting.pending;
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id], ["conformance_passed", flagged], "tested and passing, but not listed");
  const sam2 = await w.ok(sam.call, "list_vendor_offerings", {});
  assert.equal(sam2.some((o) => o.offering_id === id), false);
  const byHand = await w.ok(w.vera.call, "run_conformance", { offering_id: id });
  assert.equal(byHand.status, "conformance_passed");
  assert.match(byHand.not_listed.join(" "), /Independent audit passed/);
  // A clean build then takes over beside it, and the service is listed again with nobody listing it.
  const clean = await w.deploy(s.id, "d".repeat(40));
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_build_id], ["listed", clean.buildId]);
  view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.equal(view.stage, "production");
});

test("a service in Staging is open to sandbox testing by its offering id: never listed, never live; Production makes it live-subscribable and subscribers carry over", async () => {
  const w = await world();
  // A service type whose answer fills a customer's field, so a subscriber's call can be made as the runtime makes it.
  const LOOKUP = {
    ...SCORE,
    key: "name_lookup",
    name: "Name lookup",
    category: "kyc",
    input_schema: { type: "object", required: ["pan"], properties: { pan: { type: "string" } }, additionalProperties: false },
    output_schema: { type: "object", required: ["full_name"], properties: { full_name: { type: "string" } }, additionalProperties: false },
    consent_purpose: "kyc_records_fetch",
    fills: ["full_name"],
  };
  await w.ok(w.root.call, "define_service_type", { service_type: LOOKUP });
  w.app.state.output = { full_name: "Asha Verma" };
  const s = await w.create({ service_type: "name_lookup", name: "Name lookup" });
  const id = (await w.offering(s.id)).id;
  const sam = await w.person("Sam", ["innovator"], w.other.id);
  const subscribe = () => sam.call("subscribe_vendor_service", { offering_id: id });
  const seen = async (args = {}) => (await w.ok(sam.call, "list_vendor_offerings", args)).find((o) => o.offering_id === id);

  // An idea: nothing to subscribe to, by id or otherwise.
  assert.match((await subscribe()).data.error, /No listed offering/);
  assert.equal(await seen({ offering_id: id }), undefined);
  // Online and passed, but still an idea: not yet.
  await w.deploy(s.id);
  assert.equal((await w.offering(s.id)).status, "conformance_passed");
  assert.match((await subscribe()).data.error, /No listed offering/);
  let view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.equal(view.testing.open, false);

  // Staging: open to sandbox testing, by its id only.
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "staging" });
  view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.deepEqual([view.testing.open, view.testing.offering_id, view.testing.words], [true, id, "In testing: sandbox only until its builder moves it to Production"]);
  assert.equal(await seen(), undefined, "never in the Marketplace list");
  assert.equal(await seen({ region: "US", service_type: "name_lookup" }), undefined);
  const byId = await seen({ offering_id: id });
  assert.deepEqual([byId.availability, byId.sandbox_only, byId.live_available, byId.vendor], ["in_testing", true, false, "Scoreworks"]);
  assert.match((await sam.call("subscribe_vendor_service", { offering_id: id, live_credential: "x".repeat(12) })).data.error, /in testing/);
  const sub = await w.ok(sam.call, "subscribe_vendor_service", { offering_id: id });
  assert.deepEqual([sub.live, sub.status, sub.availability, sub.availability_words], [false, "active", "in_testing", "In testing: sandbox only until its builder moves it to Production"]);
  assert.match(sub.next, /only once its builder moves it to Production/);
  assert.match((await sam.call("set_subscription_live", { subscription_id: sub.subscription_id, live: true })).data.error, /in testing: your subscription calls it in the sandbox only/);
  const mine = await w.ok(sam.call, "list_my_vendor_subscriptions", {});
  assert.deepEqual(mine.map((x) => [x.subscription_id, x.availability]), [[sub.subscription_id, "in_testing"]]);
  // The vendor's side shows the subscriber, as sandbox.
  view = await w.ok(w.vera.call, "get_service", { service_id: s.id });
  assert.deepEqual(view.subscribers.map((x) => [x.firm, x.environment, x.subscription_status]), [["Otherco", "Sandbox", "active"]]);

  // A call as the runtime makes it for a product bound to the subscription.
  const saved = [];
  const call = (sandbox) =>
    vendorPrefill(
      w.store,
      {
        record: { pins: { vendor_bindings: [{ subscription_id: sub.subscription_id }] } },
        sandbox,
        source: "ckyc",
        fields: ["full_name"],
        held: async () => ({ pan: "ABCDE1234F" }),
        consent: async () => ({ id: "consent-1", created_at: new Date().toISOString() }),
        save: async (f, v) => void saved.push([f, v]),
      },
      w.ctx.vendors,
    );
  const before = w.app.state.requests.length;
  assert.deepEqual(await call(true), { kind: "ok", filled: ["full_name"], missing: [] });
  assert.deepEqual(saved, [["full_name", "Asha Verma"]]);
  const sent = w.app.state.requests.slice(before);
  assert.equal(sent.length, 1);
  assert.match(sent[0].headers["mynt-signature"], /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(sent[0].headers.authorization, undefined, "no credential and no app key on a subscriber's call either");
  assert.equal(sent[0].headers[EDGE_KEY_HEADER], undefined);
  // Never live: a live session isn't served, and even a subscription forced live in the database isn't called.
  assert.deepEqual(await call(false), { kind: "none" });
  await w.pg.query("UPDATE financial_products.vendor_subscriptions SET live = true WHERE id = $1", [sub.subscription_id]);
  const forced = await call(false);
  assert.deepEqual([forced.kind, forced.code], ["error", "vendor_unavailable"]);
  assert.equal(w.app.state.requests.length, before + 1, "no live request reached the service");
  await w.pg.query("UPDATE financial_products.vendor_subscriptions SET live = false WHERE id = $1", [sub.subscription_id]);

  // Production: listed, and the same subscription can now be turned live.
  await w.ok(w.vera.call, "update_vendor_offering", { offering_id: id, standard_terms: TERMS });
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "production" });
  assert.equal((await w.offering(s.id)).status, "listed");
  const listed = await seen();
  assert.deepEqual([listed.availability, listed.your_subscription_id, listed.live_available], ["listed", sub.subscription_id, true]);
  const carried = await w.ok(sam.call, "list_my_vendor_subscriptions", {});
  assert.deepEqual(carried.map((x) => [x.subscription_id, x.status, x.availability, x.live]), [[sub.subscription_id, "active", "listed", false]]);
  assert.deepEqual(await call(true), { kind: "ok", filled: ["full_name"], missing: [] }, "the sandbox goes on working");
  const live = await w.ok(sam.call, "set_subscription_live", { subscription_id: sub.subscription_id, live: true });
  assert.equal(live.live, true);
  assert.deepEqual(await call(false), { kind: "ok", filled: ["full_name"], missing: [] });
  // Moved back to Staging: sandbox only again, for the same subscription.
  await w.ok(w.vera.call, "demote_app", { app_id: s.id, to_stage: "staging", reason: "reworking" });
  assert.equal((await call(false)).code, "vendor_unavailable");
  assert.deepEqual(await call(true), { kind: "ok", filled: ["full_name"], missing: [] });
  assert.equal(await seen(), undefined);
});

test("every run keeps its transcript, redacted: real runs and practice runs alike", async () => {
  const w = await world();
  const s = await w.create();
  const id = (await w.offering(s.id)).id;
  // A practice run before anything is online.
  const practice = await w.ok(w.vera.call, "run_practice_conformance", { offering_id: id });
  assert.equal(practice.passed, true);
  // A build that echoes its settings into its answers: the worst case for a transcript.
  w.app.state.mode = "leaky";
  await w.deploy(s.id);
  const secret = w.provider.jobs.at(-1).env.MYNT_VENDOR_SIGNING_SECRET;
  const real = await w.ok(w.vera.call, "run_conformance", { offering_id: id });
  assert.ok(!JSON.stringify(real).includes(secret));
  const view = await w.ok(w.dan.call, "get_service", { service_id: s.id });
  const text = JSON.stringify(view);
  assert.ok(!text.includes(secret), "the signing secret is never in a transcript, even when the service sends it back");
  assert.ok(!text.includes("abcdefghijklmnop"), "nor anything shaped like a credential");
  assert.ok(!/v1=[0-9a-f]{64}/.test(text), "nor a signature's digest");
  const runs = view.conformance.runs;
  assert.deepEqual(runs.map((r) => r.kind).sort(), ["conformance", "conformance", "practice"]);
  for (const run of runs) {
    assert.deepEqual(run.transcript.map((x) => x.case), ["fixture_1", "bad_signature_refused", "stale_timestamp_refused"], `${run.kind} run`);
    assert.equal(run.total_cases, 3);
    assert.equal(run.transcript_note, undefined);
    for (const x of run.transcript) {
      assert.deepEqual(Object.keys(x.request.headers).sort(), ["Content-Type", "Mynt-Signature", "User-Agent"]);
      assert.match(x.request.headers["Mynt-Signature"], /^t=\d+,v1=<redacted>$/);
      assert.equal(x.request.method, "POST");
      assert.equal(typeof x.request.body.request_id, "string");
      assert.ok(x.expected.length > 10);
    }
  }
  const run = runs.find((r) => r.kind === "conformance" && r.run_id === real.run_id);
  assert.equal(run.transcript[0].request.path, "/mynt/services/cashflow_score", "the path, never the address");
  assert.deepEqual([run.transcript[0].response.http_status, run.transcript[0].response.body.status], [200, "ok"]);
  assert.deepEqual(run.transcript[0].response.body.debug, { secret: "<redacted>", authorization: "<redacted>" });
  assert.deepEqual([run.transcript[1].response.http_status, run.transcript[2].response.http_status], [401, 401]);
  assert.equal(run.build_id, (await w.offering(s.id)).app_build_id);
  const practised = runs.find((r) => r.kind === "practice");
  assert.equal(practised.run_id, practice.run_id);
  assert.equal(practised.transcript[0].request.path, "/v1/cashflow_score");
  assert.equal(practised.transcript[0].response.http_status, 200);
  // What is stored is already redacted.
  const stored = JSON.stringify((await w.pg.query("SELECT transcript FROM financial_products.vendor_conformance_runs WHERE offering_id = $1 UNION ALL SELECT transcript FROM financial_products.vendor_practice_runs WHERE offering_id = $1", [id])).rows);
  assert.ok(!stored.includes(secret) && !/v1=[0-9a-f]{64}/.test(stored) && !stored.includes("abcdefghijklmnop"));
  // A run from before transcripts were kept says so.
  await w.pg.query("UPDATE financial_products.vendor_conformance_runs SET transcript = NULL WHERE id = $1", [real.run_id]);
  const older = (await w.ok(w.vera.call, "get_service", { service_id: s.id })).conformance.runs.find((r) => r.run_id === real.run_id);
  assert.deepEqual([older.transcript, older.transcript_note], [null, "Not recorded: this run is from before Mynt kept transcripts"]);
});

test("gateway-mode hosting can't host a service: creating one and putting one online refuse, and say why", async () => {
  const w = await world();
  const s = await w.create();
  const buildId = await w.build(s.id, "a".repeat(40));
  // The same Mynt, hosting through its gateway instead (a provider that isn't direct).
  const gateway = {
    name: "digitalocean",
    async createVm() {
      return { id: "1" };
    },
    async lockDown() {},
    async powerOff() {},
    async powerOn() {},
    async deleteVm() {},
  };
  const hosting = await HostingService.open(w.store.db, gateway, { publicUrl: PUBLIC_URL, gatewayEndpoint: "gateway.example.com:51820", gatewayPublicKey: "k", gatewayIp: "203.0.113.9", region: "x", size: "x", appsDomain: "apps.example.com" });
  const [c, srv] = InMemoryTransport.createLinkedPair();
  await createServer(w.store, w.vera.user, { ...w.ctx, hosting }).connect(srv);
  const client = new Client({ name: "gateway", version: "0" });
  await client.connect(c);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const created = await call("create_service", { workspace_id: w.ws.id, name: "Another", description: "Another score.", service_type: "cashflow_score", region: "US" });
  assert.match(created.error, /hosts apps through its gateway.*can't host a service.*Services need Mynt's direct hosting/s);
  assert.equal((await w.pg.query("SELECT count(*)::int AS n FROM financial_products.apps WHERE kind = 'service'")).rows[0].n, 1, "nothing was created");
  const online = await call("deploy_app", { app_id: s.id, build_id: buildId });
  assert.match(online.error, /can't host a service/);
  assert.equal((await w.pg.query("SELECT count(*)::int AS n FROM financial_products.hosted_apps")).rows[0].n, 0, "nothing was half-deployed");
  const row = await w.offering(s.id);
  assert.deepEqual([row.status, row.test_base_url, row.app_secret_at], ["draft", null, null], "the offering was never pointed anywhere or handed a secret");
  // The structural reasons, from the hosting layer itself: no second copy, and a compose project is refused.
  const tenant = { id: randomUUID(), status: "running" };
  await assert.rejects(hosting.deployCandidate(tenant, { id: s.id }, { id: buildId, repository: "scoreworks/score", commit_sha: "a".repeat(40) }, "k", true), /needs direct hosting/);
  await assert.rejects(hosting.deploy(tenant, { id: s.id }, { id: buildId, repository: "scoreworks/score", commit_sha: "a".repeat(40) }, "k", true, [], { composeFile: "compose.yaml", check: { errors: [], services: ["api"], exposed: [] } }), /Compose apps need direct hosting/);
});

test("promotion checks for a service, and moving back unlists", async () => {
  const w = await world();
  const s = await w.create();
  const checks = async (to) => (await w.ok(w.vera.call, "get_promotion_checks", { app_id: s.id, to_stage: to })).checks.map((c) => [c.id, c.status]);
  assert.deepEqual(await checks("staging"), [["build_verified", "fail"], ["audit_passed", "pending"], ["app_runs", "pending"]]);
  await w.deploy(s.id);
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "staging" });
  // Production: conformance on the build online, terms with scope, licence, then security and hosting. No app checks.
  const production = await w.ok(w.vera.call, "get_promotion_checks", { app_id: s.id, to_stage: "production" });
  assert.deepEqual(production.checks.map((c) => [c.id, c.label, c.status]), [
    ["service_conformance", "Conformance passed on the build that is online", "pass"],
    ["service_terms", "Standard terms set, with their scope", "fail"],
    ["service_licence", "Licence verified by Mynt", "pass"],
    ["build_verified", "Latest build verified by Mynt", "pass"],
    ["audit_passed", "Independent audit passed", "warn"],
    ["audit_findings", production.checks[5].label, production.checks[5].status],
    ["hosting_healthy", "Healthy on Mynt's hosting", "pass"],
  ]);
  for (const absent of ["licences", "program_agreements", "webhooks", "target_states"]) assert.ok(!production.checks.some((c) => c.id === absent), `no ${absent} check on a service`);
  assert.equal(production.needs_admin_signoff, false);
  assert.equal(production.can_promote, false);
  assert.match((await w.vera.call("promote_app", { app_id: s.id, to_stage: "production" })).data.error, /Standard terms set/);
  const id = (await w.offering(s.id)).id;
  await w.ok(w.vera.call, "update_vendor_offering", { offering_id: id, standard_terms: TERMS });
  // Only owners and admins move it.
  assert.match((await w.dan.call("promote_app", { app_id: s.id, to_stage: "production" })).data.error, /owners and admins/);
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "production" });
  assert.equal((await w.offering(s.id)).status, "listed");
  // In the Marketplace like any offering; only its own firm is told it is one of its services.
  const subscriber = await w.person("Sam", ["innovator"], w.other.id);
  const seen = (await w.ok(subscriber.call, "list_vendor_offerings", {})).find((o) => o.offering_id === id);
  assert.equal(seen.vendor, "Scoreworks");
  assert.equal(seen.service, undefined, "subscribers see the vendor, as for any offering");
  // Moving back unlists.
  const back = await w.ok(w.vera.call, "demote_app", { app_id: s.id, to_stage: "staging", reason: "reworking" });
  assert.equal(back.unlisted, true);
  assert.equal((await w.offering(s.id)).status, "conformance_passed");
  assert.equal((await w.ok(subscriber.call, "list_vendor_offerings", {})).some((o) => o.offering_id === id), false);
});

test("a service type that needs a licence: the check fails until a verified one is named", async () => {
  const w = await world();
  await w.pg.query("UPDATE financial_products.service_types SET vendor_licences = '{us_msb}' WHERE key = 'cashflow_score'");
  const s = await w.create();
  await w.deploy(s.id);
  await w.ok(w.vera.call, "promote_app", { app_id: s.id, to_stage: "staging" });
  const c = (await w.ok(w.vera.call, "get_promotion_checks", { app_id: s.id, to_stage: "production" })).checks;
  assert.equal(c.find((x) => x.id === "service_licence").status, "fail");
  assert.equal(c.find((x) => x.id === "service_conformance").status, "fail", "the licence gap fails Mynt's conformance run too");
});

test("offline, archive and removal", async () => {
  const w = await world();
  const s = await w.create();
  await w.deploy(s.id);
  const id = (await w.offering(s.id)).id;
  // Offline: suspended with a plain reason, not an admin's suspension, and back by itself when it is online again.
  const down = await w.ok(w.vera.call, "undeploy_app", { app_id: s.id });
  assert.equal(down.service_suspended.offering_id, id);
  let row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_pause], ["suspended", "offline"]);
  assert.match(row.status_note, /isn't online\. Put it online again/);
  assert.match((await w.root.call("suspend_vendor_offering", { offering_id: id, suspended: false })).data.error, /isn't online/);
  assert.equal((await w.ok(w.vera.call, "get_service", { service_id: s.id })).offering.status_words, "Off: not online");
  await w.deploy(s.id, "b".repeat(40));
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_pause, row.status_note], ["conformance_passed", null, null]);

  // An admin's suspension survives a deploy.
  await w.ok(w.root.call, "suspend_vendor_offering", { offering_id: id, note: "under review" });
  await w.deploy(s.id, "c".repeat(40));
  assert.deepEqual([(await w.offering(s.id)).status, (await w.offering(s.id)).status_note], ["suspended", "under review"]);
  await w.ok(w.root.call, "suspend_vendor_offering", { offering_id: id, suspended: false });

  // Removal refuses a service that isn't archived (and a hosted one, as for any app).
  await w.ok(w.vera.call, "undeploy_app", { app_id: s.id });
  let plan = await planAppRemoval(w.store.db, s.id);
  assert.ok(plan.refusals.some((r) => /archive it first \(archive_service\)/.test(r)), JSON.stringify(plan.refusals));
  // Archive: owners and admins of its workspace, at its firm.
  assert.match((await w.dan.call("get_service", { service_id: s.id })).data.error ?? "", /^$/);
  const archived = await w.ok(w.vera.call, "archive_service", { service_id: s.id, reason: "retired" });
  assert.equal(archived.archived, true);
  row = await w.offering(s.id);
  assert.deepEqual([row.status, row.app_pause], ["suspended", "stopped"]);
  assert.match((await w.vera.call("archive_service", { service_id: s.id })).data.error, /already archived/);
  // An archived service gets no secret and no offering change on a deploy.
  const before = w.provider.jobs.length;
  await w.deploy(s.id, "d".repeat(40));
  assert.equal(w.provider.jobs.length, before + 1);
  assert.equal(w.provider.jobs.at(-1).env.MYNT_VENDOR_SIGNING_SECRET, undefined);
  assert.equal((await w.offering(s.id)).app_pause, "stopped");
  await w.ok(w.vera.call, "undeploy_app", { app_id: s.id });
  // Now removal goes through, and the offering stays, unlinked.
  plan = await planAppRemoval(w.store.db, s.id);
  assert.deepEqual(plan.refusals.filter((r) => /vendor|service/.test(r)), []);
  const removed = await w.ok(w.root.call, "remove_app", { app_id: s.id, confirm: true });
  assert.equal(removed.removed, true, JSON.stringify(removed));
  assert.deepEqual(removed.deleted.vendor_offerings_unlinked, { count: 1, ids: [id] });
  const kept = (await w.pg.query("SELECT app_id, status FROM financial_products.vendor_offerings WHERE id = $1", [id])).rows[0];
  assert.deepEqual([kept.app_id, kept.status], [null, "suspended"]);

  // Restore brings an archived service back as a draft, to be put online and tested again.
  const t = await w.create({ name: "Second" });
  await w.ok(w.vera.call, "archive_service", { service_id: t.id });
  const restored = await w.ok(w.vera.call, "archive_service", { service_id: t.id, archived: false });
  assert.deepEqual([restored.archived, restored.offering.status], [false, "draft"]);
});

test("the contract a build reads: by tool, by the runtime API with the build's key, and in the build's job", async () => {
  const w = await world();
  const contract = await w.ok(w.dan.call, "get_service_type_contract", { key: "cashflow_score", region: "US" });
  assert.equal(contract.endpoint.app_path, "/mynt/services/cashflow_score");
  assert.deepEqual([contract.signature.header, contract.signature.tolerance_seconds, contract.signature.refuse_with, contract.signature.secret_setting], ["Mynt-Signature", 300, 401, "MYNT_VENDOR_SIGNING_SECRET"]);
  assert.deepEqual(contract.request.input_schema, SCORE.input_schema);
  assert.deepEqual(contract.response.output_schema, SCORE.output_schema);
  assert.ok(contract.fixtures.length >= 1 && typeof contract.fixtures[0].input.full_name === "string");
  assert.deepEqual(Object.keys(contract.example_output).sort(), ["band", "score"]);
  assert.match((await w.dan.call("get_service_type_contract", { key: "nope", region: "US" })).data.error, /request_service_type/);

  // Over the runtime API, with a sandbox key of the service (what a build's sandbox holds).
  const s = await w.create();
  const { secret } = await w.store.createApiKey(w.vera.user.id, { app_id: s.id, environment: "sandbox", label: "build", allowed_origins: [] });
  const server = createMcpHttpServer(w.store, null, w.ctx).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/v1/service_types/cashflow_score/contract?region=US`, { headers: { Authorization: `Bearer ${secret}` } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).signature, contract.signature);
    assert.equal((await fetch(`${base}/v1/service_types/cashflow_score/contract?region=US`)).status, 401, "a key is needed");
    assert.equal((await fetch(`${base}/v1/service_types/nope/contract?region=US`, { headers: { Authorization: `Bearer ${secret}` } })).status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("request_service_type: asked by a builder, defined from the request or declined by an admin, audited", async () => {
  const w = await world();
  const ask = { name: "Income verification", what_it_does: "Confirms a customer's stated income against payroll data.", example_input: { full_name: "Asha Verma" }, example_output: { verified: true } };
  const first = await w.ok(w.dan.call, "request_service_type", ask);
  assert.deepEqual([first.status, first.status_words, first.region, first.firm.name], ["requested", "Waiting for Mynt", "US", "Scoreworks"]);
  const second = await w.ok(w.vera.call, "request_service_type", { ...ask, name: "Rent history" });
  // The requester and their firm see theirs; another firm doesn't; an admin sees everyone's.
  assert.equal((await w.ok(w.dan.call, "list_service_type_requests", {})).length, 2);
  const out = await w.person("Out", ["developer"], w.other.id);
  assert.deepEqual(await w.ok(out.call, "list_service_type_requests", {}), []);
  assert.equal((await w.ok(w.root.call, "list_service_type_requests", { status: "requested" })).length, 2);
  // Only an admin decides.
  assert.equal((await w.dan.call("decline_service_type_request", { request_id: first.id, reason: "no" })).isError, true);
  const declined = await w.ok(w.root.call, "decline_service_type_request", { request_id: second.id, reason: "Covered by credit_bureau_report." });
  assert.deepEqual([declined.status, declined.decision_note], ["declined", "Covered by credit_bureau_report."]);
  assert.match((await w.root.call("decline_service_type_request", { request_id: second.id, reason: "again" })).data.error, /already declined/);
  // Defined from the request: the service type exists and the request says which.
  const defined = await w.ok(w.root.call, "define_service_type", { service_type: { ...SCORE, key: "income_verification", name: "Income verification" }, from_request: first.id });
  assert.equal(defined.from_request, first.id);
  const mine = await w.ok(w.dan.call, "list_service_type_requests", {});
  assert.deepEqual(mine.find((r) => r.id === first.id) && [mine.find((r) => r.id === first.id).status, mine.find((r) => r.id === first.id).service_type_key], ["defined", "income_verification"]);
  assert.match((await w.root.call("define_service_type", { service_type: SCORE, from_request: first.id })).data.error, /already defined/);
  // Oversized examples are refused; each step is in the audit log.
  assert.match((await w.dan.call("request_service_type", { ...ask, example_input: { blob: "x".repeat(9000) } })).data.error, /under 8 KB/);
  const actions = (await w.pg.query("SELECT action FROM financial_products.audit_log WHERE action IN ('request_service_type', 'decline_service_type_request') OR (action = 'define_service_type' AND details->>'from_request' IS NOT NULL) ORDER BY created_at, seq")).rows.map((r) => r.action);
  assert.deepEqual(actions, ["request_service_type", "request_service_type", "decline_service_type_request", "define_service_type"]);
});
