import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostingService } from "../dist/hosting.js";
import { createMcpHttpServer } from "../dist/http.js";
import { ModuleRegistry } from "../dist/modules.js";
import { createServer } from "../dist/server.js";
import { publishDefined, setup, definitionFor } from "./v2-helpers.js";

// Records what Mynt asks of the cloud.
function fakeProvider() {
  const calls = [];
  return {
    calls,
    name: "fake",
    async createVm(spec) {
      calls.push(["create", spec]);
      return { id: "vm-1" };
    },
    async lockDown(id, ip, port) {
      calls.push(["lockDown", id, ip, port]);
    },
    async powerOff(id) {
      calls.push(["powerOff", id]);
    },
    async powerOn(id) {
      calls.push(["powerOn", id]);
    },
    async deleteVm(id) {
      calls.push(["delete", id]);
    },
  };
}
const CONFIG = {
  publicUrl: "https://mynt.example.com",
  gatewayEndpoint: "203.0.113.10:51820",
  gatewayPublicKey: "G".repeat(43) + "=",
  gatewayIp: "203.0.113.10",
  region: "blr1",
  size: "s-1vcpu-2gb",
  appsDomain: "apps.example.com",
};
const WG_KEY = "A".repeat(43) + "=";

async function world({ provider = fakeProvider(), config = CONFIG } = {}) {
  const ctx = await setup();
  await publishDefined(ctx, (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    return d;
  });
  await ctx.call(ctx.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  const hosting = await HostingService.open(ctx.store.db, provider, config, async () => "ghs_readonly");
  const modules = await ModuleRegistry.open(ctx.store.db);
  const connectWith = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(ctx.store, user, { hosting, modules }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const { user: devUser } = await ctx.store.createUser("Dev", ["developer"]);
  const dev = await connectWith(devUser);
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "Daily saving", audience: "Savers", product_ids: ["everyday-rd"] })).data;
  // The builds service owns build_runs; a minimal table stands in for it here.
  await ctx.store.db.exec(`CREATE TABLE IF NOT EXISTS financial_products.build_runs (id uuid PRIMARY KEY, developer_id uuid, app_id uuid, repository text, commit_sha text, status text)`);
  const build = async (status, sha = "a".repeat(40)) => {
    const id = randomUUID();
    await ctx.store.db.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, repository, commit_sha, status) VALUES ($1, $2, $3, $4, $5, $6)", [id, devUser.id, app.id, "dev/saver", sha, status]);
    return id;
  };
  const http = createMcpHttpServer(ctx.store, null, { hosting, modules }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const api = async (method, path, token, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const close = () => {
    http.closeAllConnections();
    http.close();
  };
  return { ...ctx, provider, hosting, modules, connectWith, devUser, dev, app, build, api, close };
}

test("hosting: a locked-down VM per developer, apps from verified builds, a policy over the tunnel, and a kill switch", async () => {
  const w = await world();
  try {
    const { call, dev, api } = w;
    const tenant = (await call(dev, "request_hosting")).data;
    assert.equal(tenant.status, "provisioning");
    const [, spec] = w.provider.calls.find(([c]) => c === "create");
    assert.deepEqual([spec.region, spec.size, spec.tags], ["blr1", "s-1vcpu-2gb", ["mynt-tenant"]]);
    assert.match(spec.userData, /wg genkey/, "the VM makes its own WireGuard key");
    assert.match(spec.userData, /--runtime runsc --read-only/, "apps run under gVisor, read-only");
    assert.doesNotMatch(spec.userData, /PrivateKey = [A-Za-z0-9+/]{43}=/, "no private key is ever sent to it");
    const token = spec.userData.match(/\\"token\\":\\"([A-Za-z0-9_-]+)\\"/)[1];
    assert.equal((await call(dev, "request_hosting")).data.id, tenant.id, "one VM per developer");

    // It registers once, gets its tunnel address, and is locked down to WireGuard to the gateway.
    assert.equal((await api("POST", "/v1/hosting/bootstrap", null, { token, wg_public_key: "not a key" })).status, 400);
    const reg = await api("POST", "/v1/hosting/bootstrap", null, { token, wg_public_key: WG_KEY });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal(reg.body.tunnel_ip, "10.88.1.2");
    assert.deepEqual(w.provider.calls.find(([c]) => c === "lockDown"), ["lockDown", "vm-1", "203.0.113.10", 51820]);
    assert.equal((await api("POST", "/v1/hosting/bootstrap", null, { token, wg_public_key: WG_KEY })).status, 401, "the token works once");
    const agent = reg.body.agent_token;

    // Only builds Mynt verified are deployed.
    const failed = await w.build("failed");
    assert.match((await call(dev, "deploy_app", { app_id: w.app.id, build_id: failed })).data.error, /didn't pass Mynt's verification/);
    const ok = await w.build("succeeded");
    const deployed = await call(dev, "deploy_app", { app_id: w.app.id, build_id: ok });
    assert.equal(deployed.isError, false, JSON.stringify(deployed.data));
    assert.equal(deployed.data.port, 9000);
    assert.equal(deployed.data.environment, "sandbox");
    assert.ok(deployed.data.egress.includes("bank.example.com") && deployed.data.egress.includes("mynt.example.com") && !deployed.data.egress.includes("evil.example.com"));

    // The agent's policy: the verified commit, a read-only token to fetch it, the app's dedicated key.
    assert.equal((await api("GET", "/v1/hosting/policy", "wrong")).status, 401);
    const policy = (await api("GET", "/v1/hosting/policy", agent)).body;
    const [a] = policy.apps;
    assert.equal(a.commit_sha, "a".repeat(40));
    assert.equal(a.source_url, `https://api.github.com/repos/dev/saver/tarball/${"a".repeat(40)}`);
    assert.equal(a.source_token, "ghs_readonly");
    assert.match(a.app_key, /^mynt_test_/);
    assert.equal(a.tunnel_ip, "10.88.1.2");
    const sealed = (await w.store.db.query("SELECT app_key_sealed FROM financial_products.hosted_apps")).rows[0].app_key_sealed;
    assert.ok(!sealed.includes(a.app_key), "the app key is stored sealed");

    // The gateway's peers and the edge's routes.
    assert.match(await w.hosting.wireguardPeers(), new RegExp(`PublicKey = ${WG_KEY.replace(/[+/=]/g, "\\$&")}\\nAllowedIPs = 10.88.1.2/32`));
    assert.deepEqual(await w.hosting.routes(), [{ host: `${w.app.id.slice(0, 8)}.apps.example.com`, upstream: "10.88.1.2:9000" }]);

    // The kill switch: off the gateway at once, powered off; resume brings it back.
    const { user: adminUser } = await w.store.createUser("Ada", ["admin"]);
    const admin = await w.connectWith(adminUser);
    assert.equal((await call(admin, "suspend_tenant", { tenant_id: tenant.id, reason: "abuse report" })).data.status, "suspended");
    assert.ok(w.provider.calls.some(([c, id]) => c === "powerOff" && id === "vm-1"));
    assert.equal(await w.hosting.wireguardPeers(), "");
    assert.deepEqual(await w.hosting.routes(), []);
    assert.deepEqual((await api("GET", "/v1/hosting/policy", agent)).body, { apps: [], status: "suspended" });
    assert.equal((await call(admin, "resume_tenant", { tenant_id: tenant.id })).data.status, "running");
    assert.equal((await api("GET", "/v1/hosting/policy", agent)).body.apps.length, 1);

    assert.equal((await call(dev, "undeploy_app", { app_id: w.app.id })).isError, false);
    assert.deepEqual((await api("GET", "/v1/hosting/policy", agent)).body.apps, []);
  } finally {
    w.close();
  }
});

test("hosting: developers see and work their hosted app through the VM's agent, never on the VM itself", async () => {
  const w = await world();
  try {
    const { call, dev, api } = w;
    await call(dev, "request_hosting");
    const [, spec] = w.provider.calls.find(([c]) => c === "create");
    assert.match(spec.userData, /mynt-agent-commands/, "the VM runs a command loop next to the reconcile loop");
    assert.match(spec.userData, /grep -Eqx 'mynt-app-\[0-9a-f\]\{8\}'/, "it only ever touches app containers");
    assert.match(spec.userData, /docker exec "\$NAME" sh -c/, "exec runs inside the app's container");
    const token = spec.userData.match(/\\"token\\":\\"([A-Za-z0-9_-]+)\\"/)[1];
    const agent = (await api("POST", "/v1/hosting/bootstrap", null, { token, wg_public_key: WG_KEY })).body.agent_token;
    const container = `mynt-app-${w.app.id.slice(0, 8)}`;

    assert.match((await call(dev, "app_logs", { app_id: w.app.id })).data.error, /isn't hosted on your VM/);
    await call(dev, "deploy_app", { app_id: w.app.id, build_id: await w.build("succeeded") });

    // The VM's agent: claims what's queued, runs it, reports back; the developer's call waits for it.
    const answer = async (output, exit_code = 0) => {
      for (let i = 0; i < 50; i++) {
        const { body } = await api("GET", "/v1/hosting/commands", agent);
        if (body.commands.length) {
          for (const c of body.commands) assert.equal((await api("POST", `/v1/hosting/commands/${c.id}/result`, agent, { exit_code, output })).status, 200);
          return body.commands;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("nothing queued");
    };
    const [logs, claimed] = await Promise.all([call(dev, "app_logs", { app_id: w.app.id, tail: 50 }), answer("ready on 8080\nMYNT_API_KEY=mynt_test_abcdefgh12345678")]);
    assert.deepEqual(claimed.map((c) => [c.kind, c.container, c.args]), [["logs", container, { tail: 50 }]]);
    assert.equal(logs.data.exit_code, 0);
    assert.equal(logs.data.output, "ready on 8080\nMYNT_API_KEY=[redacted]", "secrets are scrubbed");

    const [ran, [exec]] = await Promise.all([call(dev, "app_run", { app_id: w.app.id, command: "wget -qO- localhost:8080/healthz" }), answer('{"ok":true}')]);
    assert.deepEqual([exec.kind, exec.args], ["exec", { command: "wget -qO- localhost:8080/healthz", timeout_seconds: 30 }]);
    assert.equal(ran.data.output, '{"ok":true}');
    const [restarted] = await Promise.all([call(dev, "restart_app", { app_id: w.app.id }), answer(container)]);
    assert.equal(restarted.data.kind, "restart");

    // Results only from the VM that claimed the command, once.
    const [status] = await Promise.all([
      call(dev, "app_status", { app_id: w.app.id }),
      (async () => {
        const [c] = await answer("running");
        assert.equal((await api("POST", `/v1/hosting/commands/${c.id}/result`, agent, { exit_code: 0, output: "again" })).status, 404);
        assert.equal((await api("POST", `/v1/hosting/commands/${c.id}/result`, "wrong", { exit_code: 0, output: "x" })).status, 401);
      })(),
    ]);
    assert.equal(status.data.output, "running");

    // Someone else's app, and an audit trail.
    const { user: otherUser } = await w.store.createUser("Other", ["developer"]);
    const other = await w.connectWith(otherUser);
    assert.match((await call(other, "app_run", { app_id: w.app.id, command: "id" })).data.error, /No app of yours/);
    const audit = (await w.store.db.query("SELECT action, details FROM financial_products.audit_log WHERE action LIKE 'app_%' ORDER BY created_at")).rows;
    assert.deepEqual(audit.map((r) => r.action), ["app_logs", "app_exec", "app_restart", "app_status"]);
  } finally {
    w.close();
  }
});

// A direct provider (Freestyle-shaped): records what Mynt does to each VM.
function fakeDirect() {
  const calls = [];
  const egress = new Map();
  const routes = new Map();
  return {
    calls,
    egress,
    routes,
    name: "freestyle",
    direct: true,
    deployExit: 0,
    async createVm(slug) {
      calls.push(["create", slug]);
      return { id: "vm-direct" };
    },
    async run(vmId, command, opts = {}) {
      calls.push(["run", vmId, command, opts]);
      if (command.includes("useradd")) return { exitCode: 0, stdout: "29.1.3\n", stderr: "" };
      if (command.includes("docker build")) return { exitCode: this.deployExit, stdout: "", stderr: this.deployExit ? `npm ERR! auth ${opts.env.MYNT_API_KEY}` : "" };
      if (command.includes("docker logs")) return { exitCode: 0, stdout: "listening on 8080\nMYNT_API_KEY=mynt_test_abcdefgh12345678\n", stderr: "" };
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async setEgress(vmId, hosts) {
      egress.set(vmId, hosts);
    },
    async setRoute(vmId, domain, port) {
      routes.set(domain, `${vmId}:${port}`);
    },
    async removeRoute(domain) {
      routes.delete(domain);
    },
    async pause(vmId) {
      calls.push(["pause", vmId]);
    },
    async start(vmId) {
      calls.push(["start", vmId]);
    },
    async deleteVm() {},
    async grantAccess(vmId, user, expiresAt) {
      calls.push(["grant", vmId, user]);
      return { ssh: `ssh ${vmId}+${user}:tok_${calls.length}@beta-ssh.freestyle.sh`, expires_at: expiresAt.toISOString(), identity: `idn-${calls.length}` };
    },
    async revokeAccess(identity) {
      calls.push(["revoke", identity]);
    },
  };
}

test("direct hosting (Freestyle): a VM up at once, egress per app, built from the verified commit, routed, and an SSH login", async () => {
  const provider = fakeDirect();
  const w = await world({ provider, config: { ...CONFIG, gatewayEndpoint: "", gatewayPublicKey: "", gatewayIp: "", appsDomain: null } });
  try {
    const { call, dev, api } = w;
    const tenant = (await call(dev, "request_hosting")).data;
    assert.equal(tenant.status, "running", "no bootstrap, no tunnel: the VM is up at once");
    assert.deepEqual(provider.calls[0], ["create", `mynt-t-${tenant.id.slice(0, 8)}`]);
    assert.match(provider.calls[1][2], /useradd --create-home --shell \/bin\/bash developer[\s\S]*usermod -aG docker developer/);
    assert.equal((await api("POST", "/v1/hosting/bootstrap", null, { token: "x".repeat(32), wg_public_key: WG_KEY })).status, 401, "nothing to bootstrap");

    const deployed = (await call(dev, "deploy_app", { app_id: w.app.id, build_id: await w.build("succeeded") })).data;
    assert.equal(deployed.status, "deploying");
    assert.equal(deployed.url, `https://mynt-${w.app.id.slice(0, 8)}.style.dev`);
    await w.hosting.pending;
    const run = provider.calls.find(([c, , cmd]) => c === "run" && cmd.includes("docker build"));
    assert.match(run[3].env.MYNT_API_KEY, /^mynt_test_/);
    assert.equal(run[3].env.SOURCE_TOKEN, "ghs_readonly");
    assert.equal(run[3].env.SOURCE_URL, `https://api.github.com/repos/dev/saver/tarball/${"a".repeat(40)}`);
    assert.ok(!run[2].includes(run[3].env.MYNT_API_KEY) && !run[2].includes("ghs_readonly"), "secrets travel as environment, never in the command");
    assert.match(run[2], /--read-only --tmpfs \/tmp --cap-drop ALL/);
    assert.ok(provider.egress.get("vm-direct").includes("bank.example.com") && provider.egress.get("vm-direct").includes("registry.npmjs.org"));
    assert.equal(provider.routes.get(`mynt-${w.app.id.slice(0, 8)}.style.dev`), "vm-direct:9000");
    assert.equal((await call(dev, "hosting_status")).data.apps[0].status, "running");

    // Commands run at once on the VM; the developer's command arrives as $CMD, not in the script.
    const logs = (await call(dev, "app_logs", { app_id: w.app.id, tail: 20 })).data;
    assert.equal(logs.output, "listening on 8080\nMYNT_API_KEY=[redacted]\n");
    const ran = await call(dev, "app_run", { app_id: w.app.id, command: "cat /etc/hostname; rm -rf /" });
    assert.equal(ran.isError, false);
    const exec = provider.calls.findLast(([c]) => c === "run");
    assert.match(exec[2], /^timeout 30 docker exec mynt-app-[0-9a-f]{8} sh -c "\$CMD"/);
    assert.equal(exec[3].env.CMD, "cat /etc/hostname; rm -rf /");

    // An SSH login for the developer's own user; a new one revokes the last.
    const first = (await call(dev, "vm_access", { hours: 2 })).data;
    assert.match(first.ssh, /^ssh vm-direct\+developer:tok_\d+@beta-ssh\.freestyle\.sh$/);
    const second = (await call(dev, "vm_access", {})).data;
    assert.notEqual(second.ssh, first.ssh);
    assert.ok(provider.calls.some(([c, id]) => c === "revoke" && id.startsWith("idn-")), "the previous login is revoked");

    // A failed build says why, without the secrets.
    provider.deployExit = 1;
    await call(dev, "deploy_app", { app_id: w.app.id, build_id: await w.build("succeeded", "b".repeat(40)) });
    await w.hosting.pending;
    const failed = (await call(dev, "hosting_status")).data.apps[0];
    assert.equal(failed.status, "stopped");
    assert.match(failed.error, /npm ERR! auth/);
    assert.doesNotMatch(failed.error, /mynt_test_/);

    // Kill switch pauses; undeploy removes the container, the route and the app's egress.
    const { user: adminUser } = await w.store.createUser("Ada", ["admin"]);
    await call(await w.connectWith(adminUser), "suspend_tenant", { tenant_id: tenant.id, reason: "abuse report" });
    assert.ok(provider.calls.some(([c]) => c === "pause"));
    await w.hosting.resume(tenant.id);
    assert.equal((await call(dev, "undeploy_app", { app_id: w.app.id })).isError, false);
    assert.equal(provider.routes.size, 0);
    assert.deepEqual(provider.egress.get("vm-direct"), []);
  } finally {
    w.close();
  }
});

test("Freestyle provider: egress rules diffed per VM, npm by its addresses, routes by shape, SSH logins scoped to one user", async () => {
  const { FreestyleProvider } = await import("../dist/freestyle.js");
  const tls = [{ id: "tls-old", domain: "old.example.com", source: { vmId: "vm-1" }, destination: { public: true } }, { id: "tls-other", domain: "x.example.com", source: { vmId: "vm-2" }, destination: { public: true } }];
  const fw = [{ id: "fw-stale", source: { vmId: "vm-1" }, destination: { cidr: "198.51.100.9/32" } }];
  const sent = [];
  const fetch = async (url, init) => {
    const path = url.replace("https://api.freestyle.sh/v5", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push([init.method, path, body]);
    assert.match(init.headers.Authorization, /^Bearer fs_key$/);
    const reply = (v, status = 200) => new Response(JSON.stringify(v), { status });
    if (init.method === "GET" && path === "/tls") return reply({ rules: tls });
    if (init.method === "GET" && path === "/firewall/rules") return reply({ rules: fw });
    if (init.method === "POST" && path === "/identities") return reply({ id: "idn-1", managed: false });
    if (init.method === "POST" && path === "/identities/idn-1/tokens") return reply({ id: "tok", token: "secret_token", expiresAt: body.expiresAt });
    return reply({});
  };
  const p = new FreestyleProvider("fs_key", { fetch, resolve4: async (h) => (h === "registry.npmjs.org" ? ["104.16.1.35", "104.16.2.35"] : []) });

  await p.setEgress("vm-1", ["api.github.com", "registry.npmjs.org"]);
  const writes = sent.filter(([m]) => m !== "GET");
  assert.deepEqual(writes, [
    ["DELETE", "/firewall/rules/fw-stale", undefined],
    ["POST", "/firewall/rules", { action: "allow", source: { vmId: "vm-1" }, destination: { cidr: "104.16.1.35/32" } }],
    ["POST", "/firewall/rules", { action: "allow", source: { vmId: "vm-1" }, destination: { cidr: "104.16.2.35/32" } }],
    ["DELETE", "/tls/tls-old", undefined],
    ["POST", "/tls", { action: "allow", domain: "api.github.com", source: { vmId: "vm-1" }, destination: { public: true } }],
  ], "another VM's rules are untouched; npm goes by address");

  sent.length = 0;
  await p.setRoute("vm-1", "app.style.dev", 9000);
  assert.deepEqual(sent.at(-1), ["POST", "/tls", { action: "allow", domain: "app.style.dev", protocol: "http", source: { public: true }, destination: { vmId: "vm-1", port: 9000 } }]);

  const access = await p.grantAccess("vm-1", "developer", new Date("2026-11-01T00:00:00Z"));
  assert.equal(access.ssh, "ssh vm-1+developer:secret_token@beta-ssh.freestyle.sh");
  assert.ok(sent.some(([m, path, b]) => m === "POST" && path === "/identities/idn-1/permissions/vm" && b.allowedLinuxUsers[0] === "developer" && b.allowedLinuxUsers.length === 1));
});

test("modules: manifests checked against live contracts, namespaces owned, outdated once a contract changes", async () => {
  const w = await world();
  try {
    const { call, dev } = w;
    const manifest = (over = {}) => ({
      module: "@asha/rd-planner",
      version: "1.0.0",
      description: "Plans a recurring deposit and sets up its mandate",
      runtime: "client",
      built_on: [{ product_id: "everyday-rd", contract_version: 1, actions: ["view_offers", "mandate_setup"] }],
      exports: [{ name: "RdPlanner", kind: "component", renders_documents: ["kfs"] }],
      consent_purposes: ["mandate_setup"],
      ...over,
    });
    const errors = async (m) => (await call(dev, "check_module", { manifest: m })).data.errors.join("\n");
    assert.match(await errors(manifest({ consent_purposes: [] })), /declare consent purpose 'mandate_setup'/);
    assert.match(await errors(manifest({ exports: [{ name: "RdPlanner", kind: "component" }] })), /must render document 'kfs'/);
    assert.match(await errors(manifest({ built_on: [{ product_id: "everyday-rd", contract_version: 1, actions: ["premature_closure"] }] })), /a client module can't use 'premature_closure'/);
    assert.match(await errors(manifest({ built_on: [{ product_id: "everyday-rd", contract_version: 7, actions: ["view_offers"] }] })), /on contract version 1, not 7/);
    assert.match(await errors(manifest({ source_build_id: randomUUID() })), /No build of yours/);

    const published = await call(dev, "publish_module", { manifest: manifest({ source_build_id: await w.build("succeeded") }) });
    assert.equal(published.isError, false, JSON.stringify(published.data));
    assert.equal(published.data.verified, true);
    assert.match((await call(dev, "publish_module", { manifest: manifest() })).data.error, /already published/);

    const { user: rivalUser } = await w.store.createUser("Ravi", ["developer"]);
    const rival = await w.connectWith(rivalUser);
    assert.match((await call(rival, "publish_module", { manifest: manifest({ module: "@asha/other", version: "1.0.0" }) })).data.error, /belongs to another developer/);
    const listed = (await call(rival, "list_modules", { query: "planner" })).data;
    assert.deepEqual(listed.map((m) => [m.module, m.verified, m.current, m.mine]), [["@asha/rd-planner", true, true, false]]);

    // The product publishes contract version 2: the module is outdated until republished on it.
    const def = definitionFor(w, (await w.store.grcRecords(w.entity.id)).find((r) => r.section === "risk_models").id);
    def.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    def.descriptions.summary = "A daily recurring deposit, now with a higher rate.";
    assert.equal((await call(w.client, "set_product_definition", { product_id: "everyday-rd", definition: def })).isError, false);
    await call(w.client, "test_product", { id: "everyday-rd" });
    assert.equal((await call(w.client, "publish_product", { id: "everyday-rd" })).isError, false);
    assert.equal((await call(rival, "list_modules", {})).data[0].current, false);
  } finally {
    w.close();
  }
});
