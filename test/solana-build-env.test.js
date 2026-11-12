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
import {
  ENV_FILES,
  SOLANA_ENV_CHECK_SCRIPT,
  SOLANA_ENV_KEY,
  SOLANA_ENV_PREP_SCRIPT,
  SOLANA_ENV_STATE_SCRIPT,
  SOLANA_ENV_WIPE_COMMAND,
  SolanaBuildEnv,
  solanaEnvKey,
} from "../dist/build-env.js";
import { FreestyleSandboxes } from "../dist/sandbox-providers/freestyle.js";
import { createServer } from "../dist/server.js";
import { SOLANA_TOOLCHAIN, SOLANA_TOOLCHAIN_SCRIPT, TOOLCHAIN_PINS_SHA256 } from "../dist/solana/toolchain.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const STATE = "5".repeat(64);
const CHECK = `bash ${ENV_FILES.check} ${STATE} `;

// A sandbox host that can snapshot machines, as Freestyle can. Sandboxes become ready when told to; commands are
// recorded and answered by what they do.
function snapshotSandboxHost({ snapshots = true } = {}) {
  const sandboxes = new Map();
  const taken = new Map();
  let n = 0;
  const host = {
    sandboxes,
    taken,
    deleted: [],
    checkExit: 0, // what the check in a verify sandbox ends with: 0, 3, null (no status), or "throw" (timeout)
    wipeWorks: true,
    bootError: null,
    async createSandbox(opts) {
      if (opts.snapshot && host.bootError) throw new Error(host.bootError);
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
      if (opts.detached) {
        const pid = 100 + s.commands.length;
        s.running.add(pid);
        return { processId: pid, exitCode: null, stdout: "", stderr: "" };
      }
      if (command.startsWith(CHECK)) {
        if (host.checkExit === "throw") throw new Error("Freestyle POST /vms/x/exec-await: timed out");
        return { exitCode: host.checkExit, stdout: host.checkExit === 0 ? "snapshot-verified in 1s" : "", stderr: "" };
      }
      if (command === SOLANA_ENV_WIPE_COMMAND) return host.wipeWorks ? { exitCode: 0, stdout: "wiped\n", stderr: "" } : { exitCode: 1, stdout: "", stderr: "busy" };
      if (command.includes("tar --exclude")) return { exitCode: 0, stdout: `${"a".repeat(64)}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
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
            host.deleted.push(id);
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
  return host;
}

async function setup(sandboxes = snapshotSandboxHost(), config = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const builds = await BuildService.open(db, store, sandboxes, null, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, ...config });
  const { user: dev } = await store.createUser("Dev", ["developer"]);
  const { user: admin } = await store.createUser("Ada", ["admin"]);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  return { db, store, builds, sandboxes, dev, admin, connect };
}

// Builds the environment the way the worker does: the builder comes up, runs Mynt's prep script, reports the
// state hash, and is snapshotted.
async function buildEnvironment({ builds, sandboxes }, env = builds.solanaEnv) {
  await env.preparing;
  const [builder] = [...sandboxes.sandboxes.values()].filter((s) => s.opts.labels?.mynt_role === "solana-env" && !s.stopped);
  assert.ok(builder, "a builder sandbox was started");
  sandboxes.ready(builder.id);
  await env.tick();
  sandboxes.finish(builder.id);
  builder.files.set(ENV_FILES.result, JSON.stringify({ ok: true, state_sha256: STATE, install_seconds: 412 }));
  await env.tick();
  return builder;
}

// A build in its verify sandbox's first step, booted from the environment.
async function verifyingFromSnapshot({ builds, sandboxes, dev, db }, snapshotId) {
  const b = await builds.start(dev, { goal: "Ledger", solana: true });
  const vid = (await sandboxes.createSandbox({ name: "v", snapshot: snapshotId })).id;
  await db.query(
    "UPDATE financial_products.build_runs SET status = 'verifying', verify_step = 'provisioning', sandbox_id = 'sbx_1', verify_sandbox_id = $2, source_url = 'https://dl.example/x', source_sha256 = $3, solana_env = $4 WHERE id = $1",
    [b.id, vid, "a".repeat(64), JSON.stringify({ verify: { key: SOLANA_ENV_KEY, snapshot_id: snapshotId, state_sha256: STATE } })],
  );
  sandboxes.ready(vid);
  return { id: b.id, vid };
}

test("the environment's scripts are valid bash, keyed by the pins, the scripts, the host's setup and the sandbox type", () => {
  for (const s of [SOLANA_ENV_STATE_SCRIPT, SOLANA_ENV_PREP_SCRIPT, SOLANA_ENV_CHECK_SCRIPT, SOLANA_ENV_WIPE_COMMAND]) {
    const r = spawnSync("bash", ["-n"], { input: s });
    assert.equal(r.status, 0, r.stderr?.toString());
  }
  assert.match(SOLANA_ENV_KEY, /^[0-9a-f]{16}$/);
  assert.notEqual(solanaEnvKey("setup-a"), solanaEnvKey("setup-b"), "the host's first-boot setup is in the key");
  assert.notEqual(solanaEnvKey("", "default"), solanaEnvKey("", "large"), "the sandbox type is in the key");
  assert.notEqual(new FreestyleSandboxes({}).setupFingerprint, undefined);
  assert.ok(SOLANA_ENV_PREP_SCRIPT.includes(`docker pull -q "${SOLANA_TOOLCHAIN.anchorImage}"`), "pulled by digest");
  assert.ok(SOLANA_ENV_PREP_SCRIPT.includes(`bash "${ENV_FILES.installer}"`), "installed by the checksum-verifying installer");
  assert.ok(SOLANA_ENV_STATE_SCRIPT.includes("RootFS.Layers"));
  assert.doesNotMatch(SOLANA_ENV_STATE_SCRIPT, /MYNT_SOLANA_HOME/, "nothing from the environment chooses what is hashed");
  assert.equal(TOOLCHAIN_PINS_SHA256.length, 64);
});

test("the state hash covers files, modes, links, Docker's config, ~/.cargo and the image; a sandbox uses the environment only when it matches, else wipes it", () => {
  const home = mkdtempSync(join(tmpdir(), "mynt-env-"));
  const bin = join(home, "fakebin");
  mkdirSync(bin);
  const [, digest] = SOLANA_TOOLCHAIN.anchorImage.split("@");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\nif [ "$1" = image ] && [ "$2" = inspect ]; then [ -f "$HOME/no-image" ] && exit 1; echo "sha256:1111 [\\"x@${digest}\\"] [\\"sha256:layer\\"]"; exit 0; fi\necho "$@" >> "$HOME/docker.log"\n`,
  );
  writeFileSync(join(bin, "solana-keygen"), `#!/bin/sh\nmkdir -p "$HOME/.config/solana"; echo key > "$HOME/.config/solana/id.json"\n`);
  writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 1\n");
  for (const f of ["docker", "solana-keygen", "sudo"]) chmodSync(join(bin, f), 0o755);
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
  const state = (extra = {}) => spawnSync("bash", [join(scripts, "state.sh")], { env: { ...env, ...extra }, encoding: "utf8" }).stdout.trim();
  const check = (expected) => spawnSync("bash", [join(scripts, "check.sh"), expected, "ab".repeat(32)], { env, encoding: "utf8" });

  const kept = state();
  assert.match(kept, /^[0-9a-f]{64}$/);
  assert.equal(state(), kept, "deterministic");
  assert.equal(state({ MYNT_SOLANA_HOME: join(home, "elsewhere") }), kept, "MYNT_SOLANA_HOME can't point the hash elsewhere");
  // Matches: used, the env file is back, and the sandbox gets its own throwaway wallet.
  const ok = check(kept);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /snapshot-verified/);
  assert.ok(existsSync(join(root, "env")) && !existsSync(join(root, "env.held")));
  assert.ok(existsSync(join(home, ".config/solana/id.json")));
  // Each kind of change is seen: a mode, a link, Docker's client config, ~/.cargo, the image.
  const changes = [
    [() => chmodSync(join(root, "bin", "anchor"), 0o777), () => chmodSync(join(root, "bin", "anchor"), 0o755)],
    [() => spawnSync("ln", ["-s", "/etc/passwd", join(root, "bin", "solana")]), () => spawnSync("rm", ["-f", join(root, "bin", "solana")])],
    [() => (mkdirSync(join(home, ".docker")), writeFileSync(join(home, ".docker", "config.json"), "{}")), () => spawnSync("rm", ["-r", join(home, ".docker")])],
    [() => (mkdirSync(join(home, ".cargo")), writeFileSync(join(home, ".cargo", "config.toml"), "")), () => spawnSync("rm", ["-r", join(home, ".cargo")])],
    [() => writeFileSync(join(home, "no-image"), ""), () => spawnSync("rm", ["-f", join(home, "no-image")])],
  ];
  for (const [change, undo] of changes) {
    change();
    assert.notEqual(state(), kept);
    undo();
    assert.equal(state(), kept);
  }
  // A changed binary: refused, the env file never comes back (agents wait for it), the toolchain is wiped and the
  // image removed, so the installer starts afresh.
  writeFileSync(join(root, "bin", "anchor"), "swapped");
  const bad = check(kept);
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /snapshot-mismatch/);
  assert.ok(!existsSync(root), "the toolchain is gone, env file and all");
  assert.match(readFileSync(join(home, "docker.log"), "utf8"), new RegExp(`image rm -f ${SOLANA_TOOLCHAIN.anchorImage.replace(/[.:@/]/g, "\\$&")}`));
});

test("lazily built on the first Solana build, then Solana build and verify sandboxes boot from it and check it first", async () => {
  const ctx = await setup();
  const { builds, sandboxes, dev } = ctx;
  // First Solana build: no environment yet, so its sandbox starts plain and the environment's build starts.
  const first = await builds.start(dev, { goal: "Ledger program", solana: true });
  await builds.tick();
  assert.equal(sandboxes.sandboxes.get((await builds.get(first.id)).sandbox_id).opts.snapshot, undefined);
  const builder = await buildEnvironment(ctx);
  assert.deepEqual(builder.opts.env, {}, "the builder gets no secrets");
  assert.equal(builder.files.get(ENV_FILES.installer), SOLANA_TOOLCHAIN_SCRIPT);
  assert.equal(builder.files.get(ENV_FILES.prep), SOLANA_ENV_PREP_SCRIPT);
  assert.equal(builder.commands.filter((c) => c === `bash ${ENV_FILES.prep}`).length, 1);
  assert.ok(builder.stopped, "the builder is gone once snapshotted");
  const [[snapshotId, shot]] = [...sandboxes.taken];
  assert.equal(shot.from, builder.id);
  assert.match(shot.slug, new RegExp(`^mynt-solana-${SOLANA_ENV_KEY}-[0-9a-f]{6}$`));
  const [row] = await builds.solanaEnv.list();
  assert.deepEqual([row.status, row.snapshot_id, row.state_sha256, row.install_seconds, row.pins_sha256], ["ready", snapshotId, STATE, 412, TOOLCHAIN_PINS_SHA256]);

  // Second Solana build: booted from the snapshot; the install command checks it (with a fresh nonce) first, and
  // wipes it itself when the check ends any way but matched (0) or wiped (3).
  const b = await builds.start(dev, { goal: "Ledger program v2", solana: true });
  await builds.tick();
  let build = await builds.get(b.id);
  const sbx = sandboxes.sandboxes.get(build.sandbox_id);
  assert.equal(sbx.opts.snapshot, snapshotId);
  assert.deepEqual(build.solana_env.build, { key: SOLANA_ENV_KEY, snapshot_id: snapshotId, state_sha256: STATE });
  sandboxes.ready(sbx.id);
  await builds.tick();
  assert.equal(sbx.files.get(ENV_FILES.check), SOLANA_ENV_CHECK_SCRIPT, "Mynt's own copy of the check, never the snapshot's");
  assert.equal(sbx.files.get(ENV_FILES.state), SOLANA_ENV_STATE_SCRIPT);
  const install = sbx.commands.find((c) => c.includes("mynt-solana-toolchain.sh"));
  const m = new RegExp(`^bash ${ENV_FILES.check} ${STATE} ([0-9a-f]{64}) > ${ENV_FILES.checkLog} 2>&1; rc=\\$\\?; if \\[ "\\$rc" != 0 \\] && \\[ "\\$rc" != 3 \\]; then (.+) >> ${ENV_FILES.checkLog} 2>&1; fi; bash ${ENV_FILES.installer} > /home/user/\\.mynt-solana-install\\.log 2>&1$`).exec(install);
  assert.ok(m, install);
  assert.equal(m[2], SOLANA_ENV_WIPE_COMMAND);
  // A plain (non-Solana) build never boots from it.
  const plain = await builds.start(dev, { goal: "A web page" });
  await builds.tick();
  assert.equal(sandboxes.sandboxes.get((await builds.get(plain.id)).sandbox_id).opts.snapshot, undefined);

  // The verify sandbox boots from it too, checks it before the source is even fetched, and the toolchain is
  // recorded with where it came from.
  sbx.files.set("/home/user/mynt-agent/state.json", JSON.stringify({ done: true, last_subtype: "success", cost_usd: 0 }));
  sbx.running.clear();
  await builds.tick();
  build = await builds.get(b.id);
  assert.equal(build.status, "verifying");
  const vsb = sandboxes.sandboxes.get(build.verify_sandbox_id);
  assert.equal(vsb.opts.snapshot, snapshotId);
  assert.deepEqual(vsb.opts.env, {});
  sandboxes.ready(vsb.id);
  await builds.tick();
  const checks = vsb.commands.filter((c) => c.startsWith(CHECK));
  assert.equal(checks.length, 1);
  assert.notEqual(checks[0].split(" ")[3], m[1], "each VM gets its own nonce");
  const fetchAt = vsb.commands.findIndex((c) => c.includes("verify.sh --fetch"));
  assert.ok(vsb.commands.indexOf(checks[0]) < fetchAt, vsb.commands.join("\n"));
  build = await builds.get(b.id);
  assert.deepEqual(build.solana_toolchain.environment, { source: "snapshot", snapshot_id: snapshotId });
  assert.equal(build.solana_toolchain.pins_sha256, TOOLCHAIN_PINS_SHA256);
  assert.ok((await builds.events(b.id)).some((e) => e.message === "The pre-built Solana environment matched Mynt's record" && e.data.verified === true));
  const [after] = await builds.solanaEnv.list();
  assert.equal(after.uses, 2);
  assert.ok(after.last_used_at);
});

test("the check fails closed: a mismatch or a check that never finished is wiped (by Mynt if need be) or the sandbox replaced; never used", async () => {
  const ctx = await setup();
  const { builds, sandboxes, dev } = ctx;
  await builds.start(dev, { goal: "Ledger", solana: true });
  await builds.tick();
  await buildEnvironment(ctx);
  const [snapshotId] = [...sandboxes.taken.keys()];
  const reset = async () => ctx.db.query("UPDATE financial_products.solana_build_envs SET status = 'ready', snapshot_id = $1, error = NULL", [snapshotId]);

  // Exit 3: the check wiped it. Installed afresh, recorded as such, and the snapshot is dropped.
  sandboxes.checkExit = 3;
  let v = await verifyingFromSnapshot(ctx, snapshotId);
  await builds.verify(await builds.get(v.id));
  assert.deepEqual((await builds.get(v.id)).solana_toolchain.environment, { source: "install" });
  assert.ok(!sandboxes.sandboxes.get(v.vid).commands.includes(SOLANA_ENV_WIPE_COMMAND), "already wiped by the check");
  assert.ok((await builds.events(v.id)).some((e) => /didn't match Mynt's record; installing the toolchain afresh/.test(e.message) && e.data.check_exit === 3));
  assert.equal((await builds.solanaEnv.list())[0].status, "failed");
  assert.ok(sandboxes.deleted.includes(snapshotId));

  // No status, or a timeout: never treated as passing. Mynt wipes it itself, confirmed, and installs afresh.
  for (const outcome of [null, "throw"]) {
    await reset();
    sandboxes.checkExit = outcome;
    v = await verifyingFromSnapshot(ctx, snapshotId);
    await builds.verify(await builds.get(v.id));
    const vs = sandboxes.sandboxes.get(v.vid);
    assert.ok(vs.commands.includes(SOLANA_ENV_WIPE_COMMAND), `wiped after ${outcome}`);
    assert.deepEqual((await builds.get(v.id)).solana_toolchain.environment, { source: "install" });
    assert.ok(vs.commands.some((c) => c.includes("verify.sh --fetch")), "then verification goes on, without the snapshot");
    assert.equal((await builds.solanaEnv.list())[0].status, "failed");
  }

  // The wipe can't be confirmed: that machine isn't used at all. A plain one replaces it.
  await reset();
  sandboxes.checkExit = null;
  sandboxes.wipeWorks = false;
  v = await verifyingFromSnapshot(ctx, snapshotId);
  await builds.verify(await builds.get(v.id));
  const b = await builds.get(v.id);
  assert.ok(sandboxes.sandboxes.get(v.vid).stopped);
  assert.ok(!sandboxes.sandboxes.get(v.vid).commands.some((c) => c.includes("verify.sh")), "nothing ran on it");
  assert.notEqual(b.verify_sandbox_id, v.vid);
  assert.equal(sandboxes.sandboxes.get(b.verify_sandbox_id).opts.snapshot, undefined);
  assert.equal(b.verify_step, "provisioning");
  assert.equal(b.solana_env.verify, undefined);
  assert.equal(b.solana_toolchain, null);
  assert.ok((await builds.events(v.id)).some((e) => /couldn't be checked or wiped; verifying in a plain sandbox/.test(e.message)));
});

test("a snapshot that won't boot is dropped; a transient host error is retried, never held against it", async () => {
  const ctx = await setup();
  const { builds, sandboxes, dev } = ctx;
  await builds.start(dev, { goal: "Ledger", solana: true });
  await builds.tick();
  await buildEnvironment(ctx);
  const [snapshotId] = [...sandboxes.taken.keys()];

  // A 503 from the host: the build waits for the next tick; the snapshot stays.
  sandboxes.bootError = "Freestyle POST /vms: 503 upstream unavailable";
  const t = await builds.start(dev, { goal: "Ledger 2", solana: true });
  await builds.tick();
  assert.equal((await builds.get(t.id)).status, "queued");
  assert.equal((await builds.solanaEnv.list())[0].status, "ready");
  assert.deepEqual(sandboxes.deleted, []);

  // The host refuses the snapshot itself: dropped, and the sandbox starts plain.
  sandboxes.bootError = "Freestyle POST /vms: 404 snapshot not found";
  await builds.tick();
  const sb = sandboxes.sandboxes.get((await builds.get(t.id)).sandbox_id);
  assert.equal(sb.opts.snapshot, undefined);
  assert.equal((await builds.get(t.id)).solana_env, null);
  assert.ok(sandboxes.deleted.includes(snapshotId));
  assert.equal((await builds.solanaEnv.list())[0].status, "failed");
});

test("an environment older than the maximum age is rebuilt, once, by one server", async () => {
  const ctx = await setup(snapshotSandboxHost(), { solanaSnapshotMaxAgeDays: 7 });
  const { builds, sandboxes, dev, db } = ctx;
  await builds.start(dev, { goal: "Ledger", solana: true });
  await builds.tick();
  await buildEnvironment(ctx);
  const [old] = [...sandboxes.taken.keys()];
  await db.query("UPDATE financial_products.solana_build_envs SET ready_at = now() - interval '8 days'");
  const other = await SolanaBuildEnv.open(db, sandboxes, { key: SOLANA_ENV_KEY });
  const [a, b] = await Promise.all([builds.solanaEnv.ready(), other.ready()]);
  assert.deepEqual([a, b], [null, null], "too old to use");
  await Promise.all([builds.solanaEnv.preparing, other.preparing]);
  assert.deepEqual(sandboxes.deleted, [old], "deleted once");
  const builders = [...sandboxes.sandboxes.values()].filter((s) => s.opts.labels?.mynt_role === "solana-env" && !s.stopped);
  assert.equal(builders.length, 1, "one new builder");
  assert.equal((await builds.solanaEnv.list())[0].status, "building");
  // Two servers ticking the same build start its prep once.
  sandboxes.ready(builders[0].id);
  await Promise.all([builds.solanaEnv.tick(), other.tick()]);
  assert.equal(builders[0].commands.filter((c) => c === `bash ${ENV_FILES.prep}`).length, 1);
});

test("another key's snapshot is deleted only once nothing has booted from it for hours; hosts without snapshots install as before", async () => {
  const ctx = await setup();
  const { builds, sandboxes, dev, db } = ctx;
  await builds.start(dev, { goal: "Ledger", solana: true });
  await builds.tick();
  await buildEnvironment(ctx);
  const [old] = [...sandboxes.taken.keys()];
  await builds.solanaEnv.used({ key: SOLANA_ENV_KEY, snapshot_id: old, state_sha256: STATE });
  // A server on other pins, sharing the database: it builds its own, and leaves the one still in use alone.
  const next = await SolanaBuildEnv.open(db, sandboxes, { key: "f".repeat(16) });
  assert.equal(await next.ready(), null);
  await next.preparing;
  await next.tick();
  assert.deepEqual(sandboxes.deleted, [], "in use by the other server: kept");
  let rows = await next.list();
  assert.equal(rows.find((r) => r.key === SOLANA_ENV_KEY).status, "ready");
  assert.equal(rows.find((r) => r.key === "f".repeat(16)).status, "building");
  // Unused for hours: retired and deleted.
  await db.query("UPDATE financial_products.solana_build_envs SET last_used_at = now() - interval '7 hours' WHERE key = $1", [SOLANA_ENV_KEY]);
  await next.tick();
  assert.deepEqual(sandboxes.deleted, [old]);
  rows = await next.list();
  assert.equal(rows.find((r) => r.key === SOLANA_ENV_KEY).status, "retired");

  // A sandbox host without snapshots: nothing is built, every Solana sandbox installs the toolchain itself.
  const plainCtx = await setup(snapshotSandboxHost({ snapshots: false }));
  await plainCtx.builds.start(plainCtx.dev, { goal: "Ledger", solana: true });
  await plainCtx.builds.tick();
  assert.equal(plainCtx.builds.solanaEnv.supported, false);
  assert.deepEqual(await plainCtx.builds.solanaEnv.list(), []);
  assert.ok([...plainCtx.sandboxes.sandboxes.values()].every((s) => !s.opts.snapshot && s.opts.labels?.mynt_role !== "solana-env"));
  // And it can be turned off.
  const off = await setup(snapshotSandboxHost(), buildConfigFromEnv({ SOLANA_BUILD_SNAPSHOT: "off" }));
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
  assert.equal(r.data.key, ctx.builds.solanaEnv.key);
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
  assert.equal(ctx.sandboxes.deleted.length, 1, "the replaced snapshot is deleted");
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
});
