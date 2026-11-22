// App kinds: starting points for common finance apps, as JSON files in the coding agent's workspace
// (workspaces/coding-build/templates/kinds). Every kind validates, names real product lines and SDK calls,
// and scaffolds the starter with its screens laid down.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_KINDS_DIR, appKind, appKindErrors, appKinds, requireAppKind } from "../dist/app-kinds.js";
import { workspaceFiles } from "../dist/agent-host.js";
import { PRODUCT_LINES } from "../dist/catalog.js";
import { clientSdkFiles } from "./fixtures/generate-client-sdks.mjs";

const SCAFFOLD = new URL("../workspaces/coding-build/scripts/scaffold_app.py", import.meta.url).pathname;
const files = readdirSync(APP_KINDS_DIR).filter((f) => f.endsWith(".json"));
let sdkOnce = null;
const generatedSdk = async () => (sdkOnce ??= (await clientSdkFiles()).files);

test("every app kind validates against its schema and names real product lines", () => {
  assert.ok(files.length >= 4 && files.length <= 6, `4 to 6 kinds, not ${files.length}`);
  for (const f of files) assert.deepEqual(appKindErrors(f, JSON.parse(readFileSync(join(APP_KINDS_DIR, f), "utf8"))), [], f);
  const kinds = appKinds();
  assert.deepEqual(kinds.map((k) => `${k.id}.json`).sort(), [...files].sort());
  for (const k of kinds) {
    assert.ok(k.product_lines.every((l) => PRODUCT_LINES.includes(l)), k.id);
    assert.ok(!("$schema" in k), "the schema pointer isn't part of the kind");
    assert.ok(k.screens.filter((s) => s.journey).length <= 1, k.id);
    assert.ok(k.goal_template.length >= 40, k.id);
  }
  assert.equal(appKind("savings-goals").title, "Savings goals");
  assert.equal(appKind("nope"), null);
  assert.throws(() => requireAppKind("nope"), /No app kind 'nope'; list_app_kinds lists them \(.*savings-goals/);
});

// What Mynt can't build on in the US today (no US product types for lending, insurance or investments), and
// what a finance app must never promise or call its users.
const UNSUPPORTED = /\b(loans?|lend\w*|borrow\w*|credit|bnpl|mortgages?|insur\w*|invest\w*|stocks?|bonds?|mutual funds?|index funds?|etfs?|brokerage|retirement|interest|yields?|apy|apr|dividends?|earn|returns?|profits?|guarantee\w*|risk-free|cards?|merchants?|shopkeepers?|sellers?|storefronts?|crypto trading|trading)\b/i;

test("every kind's examples validate, build on the kind's own lines and SDK calls, and offer nothing Mynt can't build", () => {
  const ids = [];
  for (const k of appKinds()) {
    assert.ok(k.examples.length >= 3 && k.examples.length <= 5, `${k.id}: 3 to 5 examples`);
    const calls = new Set([...k.sdk_calls.server, ...k.sdk_calls.browser]);
    for (const e of k.examples) {
      ids.push(e.id);
      assert.ok(e.product_lines.length && e.product_lines.every((l) => k.product_lines.includes(l)), `${k.id}/${e.id}: the kind's product lines only`);
      for (const text of [e.title, e.pitch, e.goal]) assert.doesNotMatch(text, UNSUPPORTED, `${k.id}/${e.id}`);
      assert.ok(e.pitch.length <= 120 && !e.pitch.includes("\n"), `${k.id}/${e.id}: one-line pitch`);
      // An SDK call named in the goal is one the kind relies on.
      for (const name of e.goal.match(/\b[a-z]+[A-Z]\w*\b/g) ?? []) assert.ok(calls.has(name), `${k.id}/${e.id}: ${name} isn't one of the kind's SDK calls`);
      // No hostname-like strings (a word, a dot, a word).
      assert.doesNotMatch(`${e.goal} ${e.pitch}`, /\b[a-z0-9-]+\.[a-z]{2,}\b/i, `${k.id}/${e.id}`);
      if (k.product_lines.includes("exchange")) assert.match(e.goal, /dollars only, never crypto/, `${k.id}/${e.id}: a stablecoin-settled app shows dollars only`);
    }
  }
  assert.equal(new Set(ids).size, ids.length, "example ids are unique across kinds");
  const good = JSON.parse(readFileSync(join(APP_KINDS_DIR, "money-transfers.json"), "utf8"));
  const withExample = (e) => ({ ...good, examples: [...good.examples.slice(0, 2), { ...good.examples[2], ...e }] });
  assert.deepEqual(appKindErrors("money-transfers.json", good), []);
  assert.match(appKindErrors("money-transfers.json", withExample({ product_lines: ["credit"] })).join(), /example 'shift-end-payouts' builds on 'credit'/);
  assert.match(appKindErrors("money-transfers.json", withExample({ id: good.examples[0].id })).join(), /example 'trip-kitty' twice/);
  assert.ok(appKindErrors("money-transfers.json", { ...good, examples: good.examples.slice(0, 2) }).length, "at least three examples");
  assert.ok(appKindErrors("money-transfers.json", withExample({ pitch: "x".repeat(121) })).length, "a pitch is one short line");
  assert.ok(appKindErrors("money-transfers.json", withExample({ extra: 1 })).length, "an example has no unknown fields");
  const { examples: _, ...noExamples } = good;
  assert.ok(appKindErrors("money-transfers.json", noExamples).length, "every kind has examples");
});

test("a kind's own checks: its id is its file's name, its lines are product lines, one journey at most", () => {
  const good = JSON.parse(readFileSync(join(APP_KINDS_DIR, "savings-goals.json"), "utf8"));
  assert.deepEqual(appKindErrors("savings-goals.json", good), []);
  assert.match(appKindErrors("other.json", good).join(), /isn't the file's name/);
  assert.match(appKindErrors("savings-goals.json", { ...good, product_lines: ["savings"] }).join(), /'savings' isn't a product line/);
  const twoJourneys = { ...good, screens: good.screens.map((s) => ({ ...s, journey: true })) };
  assert.match(appKindErrors("savings-goals.json", twoJourneys).join(), /more than one journey screen/);
  assert.match(appKindErrors("savings-goals.json", { ...good, screens: [good.screens[0], good.screens[0]] }).join(), /screen 'goals' twice/);
  assert.ok(appKindErrors("savings-goals.json", { ...good, extra: 1 }).length, "the schema refuses unknown fields");
  assert.ok(appKindErrors("savings-goals.json", { ...good, screens: [{ ...good.screens[0], id: "index" }, good.screens[1]] }).length, "no screen named index");
});

test("every SDK call a kind relies on is in the generated SDK (server calls in mynt-sdk, browser calls in mynt-sdk/browser)", async () => {
  const sdk = await generatedSdk();
  const server = sdk.find((f) => f.path === "typescript/src/index.ts").content;
  const browser = sdk.find((f) => f.path === "typescript/src/browser.ts").content;
  for (const k of appKinds()) {
    for (const c of k.sdk_calls.server) assert.match(server, new RegExp(`(async |function )${c}\\b`), `${k.id}: server ${c}`);
    for (const c of k.sdk_calls.browser) assert.match(browser, new RegExp(`(async |function )${c}\\b`), `${k.id}: browser ${c}`);
  }
});

test("the kinds ship in the coding agent's workspace, and its CLAUDE.md points at them as data", () => {
  const ws = workspaceFiles("coding-build");
  for (const f of files) assert.ok(ws[`templates/kinds/${f}`], f);
  assert.ok(ws["templates/mynt-app-kind/web/src/Shell.tsx"]);
  assert.match(ws["CLAUDE.md"], /templates\/kinds\/<kind>\.json/);
  assert.match(ws["CLAUDE.md"], /--kind <kind>/);
});

test("scaffold_app.py --kind lays down each kind's screens on the starter, and refuses an unknown kind", async () => {
  const sdk = await generatedSdk();
  const root = mkdtempSync(join(tmpdir(), "mynt-kinds-"));
  try {
    const sdkDir = join(root, "sdk");
    for (const f of sdk) {
      const p = join(sdkDir, f.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.content);
    }
    for (const k of appKinds()) {
      const dest = join(root, k.id);
      const out = execFileSync("python3", [SCAFFOLD, dest, "--sdk", sdkDir, "--kind", k.id], { encoding: "utf8" });
      assert.match(out, new RegExp(`kind ${k.id}: screens ${k.screens.map((s) => s.id).join(", ")}`));
      assert.deepEqual(JSON.parse(readFileSync(join(dest, "mynt-kind.json"), "utf8")), k);
      assert.match(readFileSync(join(dest, "web/src/main.tsx"), "utf8"), /<Shell \/>/);
      const index = readFileSync(join(dest, "web/src/screens/index.ts"), "utf8");
      for (const s of k.screens) {
        assert.ok(index.includes(`id: ${JSON.stringify(s.id)}, title: ${JSON.stringify(s.title)}`), `${k.id}: ${s.id} listed`);
        if (s.journey) {
          assert.ok(index.includes(`Screen: App }`), `${k.id}: the journey screen is the starter's journey runner`);
          assert.ok(!existsSync(join(dest, "web/src/screens", `${s.id}.tsx`)) && !existsSync(join(dest, "mobile/app", `${s.id}.tsx`)));
        } else {
          assert.ok(readFileSync(join(dest, "web/src/screens", `${s.id}.tsx`), "utf8").includes(JSON.stringify(s.purpose)), `${k.id}: web ${s.id}`);
          assert.match(readFileSync(join(dest, "mobile/app", `${s.id}.tsx`), "utf8"), /^export default function \w+Screen\(\)/m, `${k.id}: mobile ${s.id}`);
        }
      }
      // The starter itself is untouched: its journey runner, api and mobile index are the template's.
      assert.ok(existsSync(join(dest, "web/src/App.tsx")) && existsSync(join(dest, "mobile/app/index.tsx")) && existsSync(join(dest, "api/src/server.ts")));
    }
    // No mobile, no web: only what's there gets screens.
    const lean = join(root, "lean");
    execFileSync("python3", [SCAFFOLD, lean, "--sdk", sdkDir, "--kind", "money-transfers", "--no-mobile"]);
    assert.ok(!existsSync(join(lean, "mobile")) && existsSync(join(lean, "web/src/screens/transfers.tsx")));
    const bad = spawnSync("python3", [SCAFFOLD, join(root, "bad"), "--sdk", sdkDir, "--kind", "nope"], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /no app kind 'nope' \(templates\/kinds has .*savings-goals/);
    assert.ok(!existsSync(join(root, "bad")), "nothing is scaffolded for an unknown kind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
