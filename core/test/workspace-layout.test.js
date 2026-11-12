import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The server installs from its own lockfile only (core/package-lock.json: what the host installer,
// the Docker image and CI's core jobs use). The repository's root workspaces are the apps under
// platform/, and the root lockfile must not hold a second, drifting copy of the server's
// dependencies.
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("core isn't a root workspace, and the root lockfile holds nothing of core's", () => {
  const root = read("../../package.json");
  const rootLock = read("../../package-lock.json");
  const core = read("../package.json");
  assert.deepEqual(root.workspaces, ["platform/*", "platform/packages/*"]);
  const keys = Object.keys(rootLock.packages);
  assert.ok(!keys.some((k) => k === "core" || k.startsWith("core/")), "no core entries in the root lockfile");
  assert.ok(!keys.includes(`node_modules/${core.name}`), "core isn't linked into the root");
  assert.ok(!(rootLock.packages[""].workspaces ?? []).includes("core"));
});

test("core's own lockfile is for core's package.json", () => {
  const core = read("../package.json");
  const lock = read("../package-lock.json");
  assert.equal(lock.name, core.name);
  const top = lock.packages[""];
  assert.deepEqual(top.dependencies ?? {}, core.dependencies ?? {});
  assert.deepEqual(top.devDependencies ?? {}, core.devDependencies ?? {});
  for (const name of Object.keys({ ...core.dependencies, ...core.devDependencies })) {
    assert.ok(lock.packages[`node_modules/${name}`], `${name} is locked`);
  }
});
