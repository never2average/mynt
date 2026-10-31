import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { HttpBoatClient } from "../dist/boat.js";
import { envFile, FreestyleSandboxes, sandboxesFromEnv } from "../dist/freestyle-sandboxes.js";

// Records what the adapter asks of Freestyle; answers exec like a shell would for the protocol's commands.
function fakeFreestyle() {
  const calls = [];
  const routes = [];
  return {
    calls,
    routes,
    async call(method, path, body) {
      calls.push(["call", method, path, body]);
      if (method === "POST" && path === "/vms") return { id: "vm-1" };
      if (method === "GET") return { id: "vm-1", state: "running", totalRunSeconds: 1800 };
      return {};
    },
    async run(id, command, opts = {}) {
      calls.push(["run", id, command, opts]);
      if (command.includes("echo started")) return { exitCode: 0, stdout: "started\n", stderr: "" };
      if (command.includes(".exit ]; then")) return { exitCode: 0, stdout: "exit 7\n", stderr: "" };
      if (command.includes("MISSING")) return opts.env.MYNT_PATH.endsWith("nope") ? { exitCode: 3, stdout: "", stderr: "MISSING" } : { exitCode: 0, stdout: Buffer.from("hello").toString("base64"), stderr: "" };
      return { exitCode: 0, stdout: "v22.11.0\n", stderr: "" };
    },
    async setRoute(id, domain, port) {
      routes.push([id, domain, port]);
    },
    async deleteVm(id) {
      calls.push(["delete", id]);
    },
  };
}

test("agent sandboxes: boat by default, Freestyle when asked or when it's the only key", () => {
  assert.equal(sandboxesFromEnv({}), null);
  assert.ok(sandboxesFromEnv({ BOAT_API_KEY: "b" }) instanceof HttpBoatClient);
  assert.ok(sandboxesFromEnv({ BOAT_API_KEY: "b", FREESTYLE_API_KEY: "f" }) instanceof HttpBoatClient, "hosting on Freestyle doesn't move the agents");
  assert.ok(sandboxesFromEnv({ BOAT_API_KEY: "b", FREESTYLE_API_KEY: "f", SANDBOX_PROVIDER: "freestyle" }) instanceof FreestyleSandboxes);
  assert.ok(sandboxesFromEnv({ FREESTYLE_API_KEY: "f" }) instanceof FreestyleSandboxes);
  assert.equal(sandboxesFromEnv({ BOAT_API_KEY: "b", SANDBOX_PROVIDER: "freestyle" }), null, "asked for Freestyle without its key: none, not boat");
});

test("the sandbox env file survives quotes and dollars when a shell sources it", () => {
  const env = { A: "it's \"quoted\" $HOME `x`", B: "plain", "BAD-NAME": "dropped" };
  const out = execFileSync("bash", ["-c", 'set -a; eval "$F"; set +a; printf "%s|%s|%s" "$A" "$B" "${BAD_NAME:-none}"'], { env: { F: envFile(env), PATH: process.env.PATH } }).toString();
  assert.equal(out, "it's \"quoted\" $HOME `x`|plain|none");
});

test("Freestyle sandboxes: set up as `user` with the env, run as it, detached commands tracked, previews and downloads unguessable", async () => {
  const fs = fakeFreestyle();
  const sb = new FreestyleSandboxes(fs, { usdPerHour: 0.4 });
  const created = await sb.createSandbox({ name: "mynt-build-ABC_123--x", ttlSeconds: 600, labels: { mynt_build: "b1" }, env: { GITHUB_TOKEN: "ghs_secret" } });
  assert.deepEqual(created, { id: "vm-1", state: "ready" });
  const [, , , body] = fs.calls[0];
  assert.equal(body.slug, "mynt-build-abc-123-x");
  assert.equal(body.ttlSeconds, 600);
  assert.deepEqual(body.firewall.rules, [{ action: "allow", source: {}, destination: { public: true } }]);
  const setup = fs.calls[1];
  assert.match(setup[2], /useradd --create-home --home-dir \/home\/user/);
  assert.ok(!setup[2].includes("ghs_secret"), "the env goes in the command's environment, not its text");
  assert.equal(Buffer.from(setup[3].env.MYNT_ENV, "base64").toString(), "GITHUB_TOKEN='ghs_secret'\n");

  await sb.exec("vm-1", "npm test", { timeoutSeconds: 900 });
  const run = fs.calls.at(-1);
  assert.equal(run[3].linuxUser, "user");
  assert.match(run[2], /^set -a; \[ -f ~\/\.mynt-env \] && \. ~\/\.mynt-env; set \+a; cd ~; bash -c "\$MYNT_CMD"$/);
  assert.equal(run[3].env.MYNT_CMD, "npm test");
  assert.equal(run[3].timeoutMs, 300_000, "capped at Freestyle's limit");

  const d = await sb.exec("vm-1", "node runner.mjs", { detached: true });
  assert.ok(Number.isInteger(d.processId));
  assert.match(fs.calls.at(-1)[2], new RegExp(`echo \\$\\? > /home/user/\\.mynt-procs/${d.processId}\\.exit`));
  assert.deepEqual(await sb.commandStatus("vm-1", d.processId), { running: false, exitCode: 7 });

  await sb.writeFile("vm-1", "/home/user/a.txt", "héllo");
  assert.equal(Buffer.from(fs.calls.at(-1)[3].stdin, "base64").toString(), "héllo");
  assert.equal(await sb.readFile("vm-1", "/home/user/a.txt"), "hello");
  assert.equal(await sb.readFile("vm-1", "/home/user/nope"), null);

  const { url } = await sb.host("vm-1", 8080);
  assert.match(url, /^https:\/\/mynt-pv-[0-9a-f]{24}\.style\.dev$/);
  assert.deepEqual(fs.routes.at(-1).slice(0, 1).concat(fs.routes.at(-1)[2]), ["vm-1", 28080]);
  const dl = await sb.downloadUrl("vm-1", "/home/user/mynt-out/app.tgz", 3600);
  assert.match(dl, /^https:\/\/mynt-dl-[0-9a-f]{24}\.style\.dev\/[0-9a-f]{36}$/);
  await assert.rejects(sb.downloadUrl("vm-1", "/x", 7200), /between 1 and 3600/);

  assert.equal(await sb.costDollars("vm-1"), 0.2, "half an hour at 0.40/h");
  assert.deepEqual((await sb.getSandbox("vm-1")).state, "ready");
  await sb.stop("vm-1");
  assert.deepEqual(fs.calls.at(-1), ["delete", "vm-1"]);
});
