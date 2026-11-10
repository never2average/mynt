import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runPartnerWalkthrough } from "../scripts/demo/partner-walkthrough.mjs";

// The partner walkthrough (scripts/demo/partner-walkthrough.mjs, docs/demo.md) end to end, on the in-memory stand-in
// chain, so the demo can't rot: every step passes, and nothing is left behind.

const SCRIPT = fileURLToPath(new URL("../scripts/demo/partner-walkthrough.mjs", import.meta.url));
const handles = () => process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap" && r !== "Timeout").sort();

test("the walkthrough tells the whole story, every step passes, and it cleans up after itself", { timeout: 15 * 60_000 }, async () => {
  const parent = mkdtempSync(join(tmpdir(), "walkthrough-test-"));
  const before = handles();
  const lines = [];
  try {
    const out = await runPartnerWalkthrough({ say: (s) => lines.push(s), parentDir: parent });
    const text = lines.join("\n");
    assert.equal(out.passed, true, text);
    assert.deepEqual(out.summary.map((s) => s.step), [1, 2, 3, 4, 5, 6, 7]);
    // What each step must show, in its own words.
    assert.match(text, /gleif_lei: match/);
    assert.match(text, /fincen_msb: match/);
    assert.match(text, /developer-ready: yes/);
    assert.match(text, /Avery deposits \$250\.00: HTTP 201, completed/);
    assert.match(text, /Avery takes a \$100\.00 payout: HTTP 201, completed/);
    assert.match(text, /HTTP 403, state_unverified/);
    assert.match(text, /HTTP 403, state_not_sponsored/);
    assert.match(text, /verify: OVERALL PASS/);
    assert.match(text, /received covenant\.breached .* signature valid/);
    assert.match(text, /Withdrawal of \$20,000\.00: paying then paid/);
    assert.match(text, /second withdrawal of \$10,000\.00: queued/);
    // Placeholders stay placeholders.
    assert.match(text, /Example Money Transmitter \(placeholder\)/);
    // Nothing left behind: no folder, no server, no socket, and a "cleaned up" section that says so.
    assert.equal(out.kept, false);
    assert.deepEqual(out.not_cleaned, []);
    assert.ok(out.cleaned.some((c) => c.startsWith("removed the working folder")));
    assert.match(text, /== Cleaned up ==/);
    assert.equal(existsSync(out.dir), false);
    assert.deepEqual(readdirSync(parent), []);
    // A closed server's handle and a keep-alive socket to it go on the event loop's next turns, not at once.
    for (let i = 0; i < 50 && JSON.stringify(handles()) !== JSON.stringify(before); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(handles(), before, "no handle left open");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

const cli = (args) => new Promise((resolve) => execFile(process.execPath, [SCRIPT, ...args], (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout + stderr })));

test("--cleanup-only removes only a folder a --keep run made", async () => {
  const parent = mkdtempSync(join(tmpdir(), "walkthrough-cleanup-"));
  try {
    const kept = join(parent, "mynt-partner-demo-abc123");
    mkdirSync(join(kept, "pgdata"), { recursive: true });
    writeFileSync(join(kept, "health-answer.json"), "{}");
    const other = join(parent, "something-else");
    mkdirSync(other);
    const refused = await cli(["--cleanup-only", "--dir", other]);
    assert.equal(refused.code, 2);
    assert.ok(existsSync(other), "a folder it didn't make is left alone");
    const done = await cli(["--cleanup-only", "--dir", kept]);
    assert.equal(done.code, 0, done.out);
    assert.equal(existsSync(kept), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("it never runs as production", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(runPartnerWalkthrough({ say: () => {} }), /never runs with NODE_ENV=production/);
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});
