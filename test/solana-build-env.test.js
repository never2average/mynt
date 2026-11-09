import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { ENV_FILES, SOLANA_ENV_CHECK_SCRIPT, SOLANA_ENV_KEY, SOLANA_ENV_PREP_SCRIPT, SOLANA_ENV_STATE_SCRIPT, SolanaBuildEnv } from "../dist/build-env.js";
import { FreestyleSandboxes } from "../dist/freestyle-sandboxes.js";
import { createServer } from "../dist/server.js";
import { SOLANA_TOOLCHAIN, SOLANA_TOOLCHAIN_SCRIPT, TOOLCHAIN_PINS_SHA256 } from "../dist/solana/toolchain.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const STATE = "5".repeat(64);
const V = "/home/user/mynt-verify";

// A sandbox host that can snapshot machines, as Freestyle can. Sandboxes become ready when told to; commands are
// recorded and answered by what they do.
function snapshotBoat({ snapshots = true } = {}) {
  const sandboxes = new Map();
  const taken = new Map();
  let n = 0;
  const boat = {
    sandboxes,
    taken,
    deleted: [],
    checkExit: 0,
    failBootFrom: null,
    async createSandbox(opts) {
      if (opts.snapshot && opts.snapshot === boat.failBootFrom) throw new Error("snapshot not found");
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), commands: [], stopped: false, running: new Set() });
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
    async host(id, port) {
      return { url: `https://${id}-${port}.preview.example` };
    },
    async costDollars() {
      return 0;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    async exec(id, command, opts = {}) {
      const s = sandboxes.get(id);
      s.commands.push(command);
      if (command.startsWith(`bash ${ENV_FILES.check}`)) return { exitCode: boat.checkExit, stdout: boat.checkExit ? "snapshot-mismatch" : "snapshot-verified in 9s", stderr: "" };
      if (command.includes("tar --exclude")) return { exitCode: 0, stdout: `${"a".repeat(64)}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
      if (opts.detached) {
        const pid = 100 + s.commands.length;
        s.running.add(pid);
        return { processId: pid, exitCode: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async commandStatus(id, pid) {
      return { running: sandboxes.get(id).running.has(pid), exitCode: 0 };
    },
    async downloadUrl(id, path) {
      return `https://files.example/${id}${path}?sig=x`;
    },
    ...(snapshots
      ? {
          async snapshot(id, opts) {
            const snapshotId = `sh-${taken.size + 1}`;
            taken.set(snapshotId, { from: id, ...opts });
            return { snapshotId };
          },
          async deleteSnapshot(id) {
            boat.deleted.push(id);
          },
        }
      : {}),
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    finish(id) {
      sandboxes.get(id).running.clear();
    },
  };
  return boat;
}

async function setup(boat = snapshotBoat(), config = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const builds = await BuildService.open(db, store, boat, null, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, ...config });
  const { user: dev } = await store.createUser("Dev", ["developer"]);
  const { user: admin } = await store.createUser("Ada", ["admin"]);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  return { db, store, builds, boat, dev, admin, connect };
}

// Builds the environment the way the worker does: the builder comes up, runs Mynt's prep script, reports the
// state hash, and is snapshotted.
async function buildEnvironment({ builds, boat }) {
  await builds.solanaEnv.preparing;
  const [builder] = [...boat.sandboxes.values()].filter((s) => s.opts.labels?.mynt_role === "solana-env" && !s.stopped);
  assert.ok(builder, "a builder sandbox was started");
  boat.ready(builder.id);
  await builds.tick();
  boat.finish(builder.id);
  builder.files.set(ENV_FILES.result, JSON.stringify({ ok: true, state_sha256: STATE, install_seconds: 412 }));
  await builds.tick();
  return builder;
}

test("the environment's scripts are valid bash, keyed by the pins and the scripts, and check the image by its pinned digest", () => {
  for (const s of [SOLANA_ENV_STATE_SCRIPT, SOLANA_ENV_PREP_SCRIPT, SOLANA_ENV_CHECK_SCRIPT]) {
    const r = spawnSync("bash", ["-n"], { input: s });
    assert.equal(r.status, 0, r.stderr?.toString());
  }
  assert.match(SOLANA_ENV_KEY, /^[0-9a-f]{16}$/);
  assert.ok(SOLANA_ENV_PREP_SCRIPT.includes(`docker pull -q "${SOLANA_TOOLCHAIN.anchorImage}"`), "pulled by digest");
  assert.ok(SOLANA_ENV_PREP_SCRIPT.includes(`bash "${ENV_FILES.installer}"`), "installed by the checksum-verifying installer");
  assert.ok(SOLANA_ENV_STATE_SCRIPT.includes(SOLANA_TOOLCHAIN.anchorImage));
  assert.ok(TOOLCHAIN_PINS_SHA256.length === 64);
});

test("the state hash covers every file, mode and link and the image; a sandbox uses the environment only when it matches, else wipes it", () => {
  const home = mkdtempSync(join(tmpdir(), "mynt-env-"));
  const bin = join(home, "fakebin");
  mkdirSync(bin);
  const [, digest] = SOLANA_TOOLCHAIN.anchorImage.split("@");
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nif [ "$1" = image ] && [ "$2" = inspect ]; then [ -f "$HOME/no-image" ] && exit 1; echo "sha256:1111 [\\"x@${digest}\\"]"; exit 0; fi\necho "$@" >> "$HOME/docker.log"\n`);
  writeFileSync(join(bin, "solana-keygen"), `#!/bin/sh\nmkdir -p "$HOME/.config/solana"; echo key > "$HOME/.config/solana/id.json"\n`);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "solana-keygen"), 0o755);
  const root = join(home, ".mynt-solana");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "anchor"), "anchor binary");
  chmodSync(join(root, "bin", "anchor"), 0o755);
  writeFileSync(join(root, "env"), `export PATH="${bin}:$PATH"\n`);
  const scripts = join(home, "scripts");
  mkdirSync(scripts);
  writeFileSync(join(scripts, "state.sh"), SOLANA_ENV_STATE_SCRIPT);
  // The check script runs Mynt's state script from its fixed path; point it at this copy.
  writeFileSync(join(scripts, "check.sh"), SOLANA_ENV_CHECK_SCRIPT.replaceAll(ENV_FILES.state, join(scripts, "state.sh")));
  const env = { HOME: home, PATH: `${bin}:${process.env.PATH}` };
  const state = () => spawnSync("bash", [join(scripts, "state.sh")], { env, encoding: "utf8" }).stdout.trim();
  const check = (expected) => spawnSync("bash", [join(scripts, "check.sh"), expected], { env, encoding: "utf8" });

  const kept = state();
  assert.match(kept, /^[0-9a-f]{64}$/);
  assert.equal(state(), kept, "deterministic");
  // Matches: used, and the sandbox gets its own throwaway wallet.
  const ok = check(kept);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /snapshot-verified/);
  assert.ok(existsSync(join(home, ".config/solana/id.json")));
  // Each kind of change is seen: a mode, a link, the image.
  chmodSync(join(root, "bin", "anchor"), 0o777);
  assert.notEqual(state(), kept);
  chmodSync(join(root, "bin", "anchor"), 0o755);
  spawnSync("ln", ["-s", "/etc/passwd", join(root, "bin", "solana")]);
  assert.notEqual(state(), kept);
  spawnSync("rm", ["-f", join(root, "bin", "solana")]);
  writeFileSync(join(home, "no-image"), "");
  assert.notEqual(state(), kept);
  spawnSync("rm", ["-f", join(home, "no-image")]);
  assert.equal(state(), kept);
  // A changed binary: refused, the toolchain wiped and the image removed, so the installer starts afresh.
  writeFileSync(join(root, "bin", "anchor"), "swapped");
  const bad = check(kept);
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /snapshot-mismatch/);
  assert.ok(!existsSync(root), "the toolchain is gone");
  assert.match(readFileSync(join(home, "docker.log"), "utf8"), new RegExp(`image rm -f ${SOLANA_TOOLCHAIN.anchorImage.replace(/[.:@/]/g, "\\$&")}`));
});

test("lazily built on the first Solana build, then Solana build and verify sandboxes boot from it and check it first", async () => {
  const ctx = await setup();
  const { builds, boat, dev, store } = ctx;
  // First Solana build: no environment yet, so its sandbox starts plain and the environment's build starts.
  const first = await builds.start(dev, { goal: "Ledger program", solana: true });
  await builds.tick();
  const firstSandbox = boat.sandboxes.get((await builds.get(first.id)).sandbox_id);
  assert.equal(firstSandbox.opts.snapshot, undefined);
  const builder = await buildEnvironment(ctx);
  assert.deepEqual(builder.opts.env, {}, "the builder gets no secrets");
  assert.equal(builder.files.get(ENV_FILES.installer), SOLANA_TOOLCHAIN_SCRIPT);
  assert.equal(builder.files.get(ENV_FILES.prep), SOLANA_ENV_PREP_SCRIPT);
  assert.ok(builder.commands.includes(`bash ${ENV_FILES.prep}`));
  assert.ok(builder.stopped, "the builder is gone once snapshotted");
  const [[snapshotId, shot]] = [...boat.taken];
  assert.equal(shot.from, builder.id);
  assert.match(shot.slug, new RegExp(`^mynt-solana-${SOLANA_ENV_KEY}-[0-9a-f]{6}$`));
  const [row] = await builds.solanaEnv.list();
  assert.deepEqual([row.status, row.snapshot_id, row.state_sha256, row.install_seconds, row.pins_sha256], ["ready", snapshotId, STATE, 412, TOOLCHAIN_PINS_SHA256]);

  // Second Solana build: booted from the snapshot; the install command checks it against Mynt's hash first.
  const b = await builds.start(dev, { goal: "Ledger program v2", solana: true });
  await builds.tick();
  let build = await builds.get(b.id);
  const sbx = boat.sandboxes.get(build.sandbox_id);
  assert.equal(sbx.opts.snapshot, snapshotId);
  assert.deepEqual(build.solana_env.build, { key: SOLANA_ENV_KEY, snapshot_id: snapshotId, state_sha256: STATE });
  boat.ready(sbx.id);
  await builds.tick();
  assert.equal(sbx.files.get(ENV_FILES.check), SOLANA_ENV_CHECK_SCRIPT, "Mynt's own copy of the check, never the snapshot's");
  assert.equal(sbx.files.get(ENV_FILES.state), SOLANA_ENV_STATE_SCRIPT);
  const install = sbx.commands.find((c) => c.includes("mynt-solana-toolchain.sh"));
  assert.equal(install, `bash ${ENV_FILES.check} ${STATE} > ${ENV_FILES.checkLog} 2>&1; bash ${ENV_FILES.installer} > /home/user/.mynt-solana-install.log 2>&1`);
  // A plain (non-Solana) build never boots from it.
  const plain = await builds.start(dev, { goal: "A web page" });
  await builds.tick();
  assert.equal(boat.sandboxes.get((await builds.get(plain.id)).sandbox_id).opts.snapshot, undefined);

  // The verify sandbox boots from it too, checks it before the source is even fetched, and the toolchain is
  // recorded with where it came from.
  const agentPid = [...sbx.running].at(-1);
  sbx.files.set("/home/user/mynt-agent/state.json", JSON.stringify({ done: true, last_subtype: "success", cost_usd: 0 }));
  sbx.running.delete(agentPid);
  await builds.tick();
  build = await builds.get(b.id);
  assert.equal(build.status, "verifying");
  const vsb = boat.sandboxes.get(build.verify_sandbox_id);
  assert.equal(vsb.opts.snapshot, snapshotId);
  assert.deepEqual(vsb.opts.env, {});
  boat.ready(vsb.id);
  await builds.tick();
  const checkAt = vsb.commands.indexOf(`bash ${ENV_FILES.check} ${STATE}`);
  const fetchAt = vsb.commands.findIndex((c) => c.includes("verify.sh --fetch"));
  assert.ok(checkAt >= 0 && checkAt < fetchAt, vsb.commands.join("\n"));
  build = await builds.get(b.id);
  assert.deepEqual(build.solana_toolchain.environment, { source: "snapshot", snapshot_id: snapshotId });
  assert.equal(build.solana_toolchain.pins_sha256, TOOLCHAIN_PINS_SHA256);
  assert.equal(build.solana_toolchain.anchor_image, SOLANA_TOOLCHAIN.anchorImage);
  assert.ok((await builds.events(b.id)).some((e) => e.message === "The pre-built Solana environment matched Mynt's record" && e.data.verified === true));
  assert.equal((await builds.solanaEnv.list())[0].uses, 2);
  void store;
});

test("a snapshot that doesn't match Mynt's record is wiped and the toolchain installed afresh; one that won't boot is dropped", async () => {
  const ctx = await setup();
  const { builds, boat, dev, db } = ctx;
  await builds.start(dev, { goal: "Ledger", solana: true });
  await builds.tick();
  await buildEnvironment(ctx);
  const [snapshotId] = [...boat.taken.keys()];

  // A verification whose check fails: recorded as installed, not as the snapshot.
  const b = await builds.start(dev, { goal: "Ledger 2", solana: true });
  await db.query("UPDATE financial_products.build_runs SET status = 'verifying', verify_step = 'provisioning', sandbox_id = 'sbx_1', verify_sandbox_id = $2, source_url = 'https://dl.example/x', source_sha256 = $3, solana_env = $4 WHERE id = $1", [
    b.id,
    (await boat.createSandbox({ name: "v" })).id,
    "a".repeat(64),
    JSON.stringify({ verify: { key: SOLANA_ENV_KEY, snapshot_id: snapshotId, state_sha256: STATE } }),
  ]);
  const vid = (await builds.get(b.id)).verify_sandbox_id;
  boat.ready(vid);
  boat.checkExit = 3;
  await builds.verify(await builds.get(b.id));
  assert.deepEqual((await builds.get(b.id)).solana_toolchain.environment, { source: "install" });
  assert.ok((await builds.events(b.id)).some((e) => /didn't match Mynt's record; installing the toolchain afresh/.test(e.message) && e.data.verified === false));

  // The host lost the snapshot: the sandbox starts plain, and the environment is marked for a rebuild.
  boat.failBootFrom = snapshotId;
  const c = await builds.start(dev, { goal: "Ledger 3", solana: true });
  await builds.tick();
  const sb = boat.sandboxes.get((await builds.get(c.id)).sandbox_id);
  assert.equal(sb.opts.snapshot, undefined);
  assert.equal((await builds.get(c.id)).solana_env, null);
  assert.ok(boat.deleted.includes(snapshotId));
  assert.equal((await builds.solanaEnv.list())[0].status, "failed");
});

test("new pins (or scripts) retire the old snapshot and build a new one; hosts without snapshots install as before", async () => {
  const ctx = await setup();
  const { builds, boat, dev, db } = ctx;
  await builds.start(dev, { goal: "Ledger", solana: true });
  await builds.tick();
  await buildEnvironment(ctx);
  const [old] = [...boat.taken.keys()];
  // The same database under a server whose pins moved: a different key.
  const next = await SolanaBuildEnv.open(db, boat, { key: "f".repeat(16) });
  assert.equal(await next.ready(), null);
  await next.preparing;
  await next.tick();
  assert.ok(boat.deleted.includes(old), "the old snapshot is deleted");
  const rows = await next.list();
  assert.equal(rows.find((r) => r.key === SOLANA_ENV_KEY).status, "retired");
  assert.equal(rows.find((r) => r.key === "f".repeat(16)).status, "building");

  // boat.dev takes no snapshots: nothing is built, every Solana sandbox installs the toolchain itself.
  const plainCtx = await setup(snapshotBoat({ snapshots: false }));
  await plainCtx.builds.start(plainCtx.dev, { goal: "Ledger", solana: true });
  await plainCtx.builds.tick();
  assert.equal(plainCtx.builds.solanaEnv.supported, false);
  assert.deepEqual(await plainCtx.builds.solanaEnv.list(), []);
  assert.ok([...plainCtx.boat.sandboxes.values()].every((s) => !s.opts.snapshot && s.opts.labels?.mynt_role !== "solana-env"));
  // And it can be turned off.
  const off = await setup(snapshotBoat(), buildConfigFromEnv({ SOLANA_BUILD_SNAPSHOT: "off" }));
  assert.equal(off.builds.solanaEnv.supported, false);
});

test("admins see and prepare the environment with solana_build_environment; developers don't get the tool", async () => {
  const ctx = await setup();
  const admin = await ctx.connect(ctx.admin);
  const call = async (client, args) => {
    const r = await client.callTool({ name: "solana_build_environment", arguments: args });
    return { isError: r.isError ?? false, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };
  let r = await call(admin, {});
  assert.equal(r.data.supported, true);
  assert.equal(r.data.key, SOLANA_ENV_KEY);
  assert.equal(r.data.current, null);
  assert.equal(r.data.toolchain.pins_sha256, TOOLCHAIN_PINS_SHA256);
  r = await call(admin, { action: "prepare" });
  assert.equal(r.data.current.status, "building");
  await buildEnvironment(ctx);
  r = await call(admin, { action: "status" });
  assert.equal(r.data.current.status, "ready");
  assert.equal(r.data.saves_seconds_per_sandbox, 412);
  r = await call(admin, { action: "rebuild" });
  assert.equal(r.data.current.status, "building");
  assert.equal(ctx.boat.deleted.length, 1, "the replaced snapshot is deleted");
  const dev = await ctx.connect(ctx.dev);
  assert.ok(!(await dev.listTools()).tools.some((t) => t.name === "solana_build_environment"));
});

test("Freestyle: a sandbox boots from a snapshot by id, and Mynt snapshots and deletes through Freestyle's API", async () => {
  const calls = [];
  const fs = {
    async call(method, path, body) {
      calls.push([method, path, body]);
      if (method === "POST" && path === "/vms") return { id: "vm-9" };
      if (path === "/vms/vm-9/snapshot") return { snapshotId: "sh-abc", snapshot: {} };
      return {};
    },
    async run() {
      return { exitCode: 0, stdout: "v22.11.0\n", stderr: "" };
    },
    async deleteVm() {},
  };
  const sb = new FreestyleSandboxes(fs);
  await sb.createSandbox({ name: "mynt-build-x", env: {}, snapshot: "sh-abc" });
  assert.equal(calls[0][2].snapshotId, "sh-abc");
  await sb.createSandbox({ name: "mynt-build-y", env: {} });
  assert.ok(!("snapshotId" in calls.at(-1)[2]));
  assert.deepEqual(await sb.snapshot("vm-9", { slug: "mynt-solana-k", displayName: "Mynt Solana" }), { snapshotId: "sh-abc" });
  const [, , body] = calls.find(([, p]) => p === "/vms/vm-9/snapshot");
  assert.deepEqual(body, { slug: "mynt-solana-k", displayName: "Mynt Solana", autoDeleteSeconds: 30 * 24 * 3600 });
  await sb.deleteSnapshot("sh-abc");
  assert.deepEqual(calls.at(-1), ["DELETE", "/snapshots/sh-abc", undefined]);
  void V;
});
