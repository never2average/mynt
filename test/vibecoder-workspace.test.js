import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceFiles } from "../dist/agent-host.js";

const files = workspaceFiles("coding-build");
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, "has frontmatter");
  return Object.fromEntries(m[1].split("\n").filter((l) => /^[a-z-]+:/.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
};
const TEAM = ["architect", "server-engineer", "web-engineer", "mobile-engineer", "compliance-reviewer", "qa-engineer", "release-engineer"];
const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense", "CC0-1.0"];

test("the coding agent's team: every specialist has frontmatter, and every skill it uses is in the workspace", () => {
  assert.match(files["CLAUDE.md"], /lead engineer/);
  for (const role of TEAM) {
    const fm = frontmatter(files[`.claude/agents/${role}.md`]);
    assert.equal(fm.name, role);
    assert.ok(fm.description.length > 40 && fm.tools, `${role} says when to use it and what it may touch`);
    for (const skill of fm.skills.split(",").map((s) => s.trim())) assert.ok(files[`.claude/skills/${skill}/SKILL.md`], `${role} uses ${skill}`);
  }
  assert.match(frontmatter(files[".claude/agents/compliance-reviewer.md"]).tools, /^Read, Grep, Glob, Bash$/, "the reviewer can't edit");
  assert.ok(!Object.keys(files).some((p) => /^\.claude\/agents\/.+\//.test(p)), "no nested agent files to clash with the team");
});

test("skills found by HyDE search are vendored verbatim with their upstream licence and source", () => {
  // Skills and agents (under .claude/); the version-matched docs under docs/ are checked below.
  const vendored = Object.keys(files).filter((p) => p.startsWith(".claude/") && p.endsWith("UPSTREAM.json"));
  assert.ok(vendored.length >= 12);
  for (const p of vendored) {
    const u = JSON.parse(files[p]);
    assert.ok(PERMISSIVE.includes(u.license), `${p}: ${u.license}`);
    assert.match(u.commit, /^[0-9a-f]{40}$/);
    assert.equal(u.url, `https://github.com/${u.repo}/blob/${u.commit}/${u.path}`);
    assert.equal(u.found_by, "HyDE");
    const licence = p.endsWith("/UPSTREAM.json") ? p.replace("UPSTREAM.json", "LICENSE") : p.replace(".UPSTREAM.json", ".LICENSE");
    assert.ok(files[licence]?.length > 100, `${p} ships its licence text`);
  }
});

test("the starter app is one Compose project: api holds the key, web and mobile run on client sessions", () => {
  const t = (p) => files[`templates/mynt-app/${p}`];
  for (const p of ["compose.yaml", ".env.example", "api/src/server.ts", "api/Dockerfile", "web/src/App.tsx", "web/Dockerfile", "mobile/app/index.tsx", "mobile/Dockerfile"]) assert.ok(t(p), p);
  const compose = t("compose.yaml");
  for (const service of ["api", "web", "mobile"]) assert.match(compose, new RegExp(`\\n  ${service}:\\n`));
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop: \["ALL"\]/);
  assert.doesNotMatch(compose, /privileged|network_mode: host|\/var\/run\/docker\.sock/);
  assert.match(t("api/src/server.ts"), /createClientSession/);
  assert.match(t("api/src/server.ts"), /verifyWebhook\(raw/);
  for (const client of ["web/src/App.tsx", "mobile/app/index.tsx"]) {
    assert.match(t(client), /createMyntBrowserClient\(\{ clientSecret/);
    assert.doesNotMatch(t(client), /MYNT_API_KEY|mynt_(live|test)_/, `${client} never sees the app key`);
  }
  assert.ok(files["scripts/scaffold_app.py"]);
});

test("native mobile starters (Kotlin, Swift, Flutter) run a journey on a client session, never an app key", () => {
  const starters = {
    kotlin: ["README.md", "settings.gradle.kts", "app/build.gradle.kts", "app/src/main/AndroidManifest.xml", "app/src/main/kotlin/app/mynt/starter/MainActivity.kt"],
    swift: ["README.md", "Package.swift", "Sources/MyntStarter/MyntStarterApp.swift"],
    flutter: ["README.md", "pubspec.yaml", "lib/main.dart"],
  };
  for (const [lang, paths] of Object.entries(starters)) {
    for (const p of paths) assert.ok(files[`templates/mynt-app-mobile/${lang}/${p}`], `${lang}/${p}`);
    for (const [p, text] of Object.entries(files).filter(([p]) => p.startsWith(`templates/mynt-app-mobile/${lang}/`))) {
      assert.doesNotMatch(text, /MYNT_API_KEY|mynt_(live|test)_/, `${p} never sees the app key`);
    }
  }
  const t = (p) => files[`templates/mynt-app-mobile/${p}`];
  assert.match(t("kotlin/app/src/main/kotlin/app/mynt/starter/MainActivity.kt"), /FLAG_SECURE[\s\S]*CustomTabsIntent[\s\S]*JourneyRunner\(/);
  assert.match(t("swift/Sources/MyntStarter/MyntStarterApp.swift"), /ASWebAuthenticationSession/);
  assert.match(t("swift/Sources/MyntStarter/MyntStarterApp.swift"), /SecureField/);
  assert.match(t("flutter/lib/main.dart"), /obscureText[\s\S]*inAppBrowserView/);
});

test("the Solana docs are vendored for exactly the pinned toolchain, with their upstream, tag and licence", async () => {
  const { SOLANA_TOOLCHAIN } = await import("../dist/solana/toolchain.js");
  const pins = { anchor: SOLANA_TOOLCHAIN.anchor.version, agave: SOLANA_TOOLCHAIN.agave.version };
  for (const name of ["anchor", "agave"]) {
    const u = JSON.parse(files[`docs/solana/${name}/UPSTREAM.json`] ?? "null");
    assert.ok(u, `docs/solana/${name}/UPSTREAM.json exists`);
    assert.equal(u.license, "Apache-2.0");
    assert.ok(PERMISSIVE.includes(u.license));
    assert.match(files[`docs/solana/${name}/LICENSE`], /Apache License\s+Version 2\.0/);
    assert.match(u.commit, /^[0-9a-f]{40}$/);
    assert.equal(u.url, `https://github.com/${u.repo}/tree/${u.commit}/${u.path}`);
    // The docs are the pinned release's own.
    assert.equal(u.version, pins[u.pin]);
    assert.equal(u.tag, `v${pins[u.pin]}`);
    assert.ok(u.files.length >= 10);
    for (const f of u.files) assert.ok(files[`docs/solana/${name}/${f}`]?.length > 0, `${name}/${f}`);
    // Only what is listed: nothing hand-added beside the vendored files.
    const prefix = `docs/solana/${name}/`;
    const present = Object.keys(files).filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
    assert.deepEqual(present.filter((p) => p !== "UPSTREAM.json" && p !== "LICENSE").sort(), [...u.files].sort());
  }
  for (const f of ["anchor/basics/pda.mdx", "anchor/basics/cpi.mdx", "anchor/references/account-constraints.mdx", "agave/cli/examples/test-validator.md"]) assert.ok(files[`docs/solana/${f}`], f);
  // The index names exactly the pinned versions.
  const index = files["docs/solana/README.md"];
  for (const v of [SOLANA_TOOLCHAIN.agave.version, SOLANA_TOOLCHAIN.anchor.version, SOLANA_TOOLCHAIN.rust.version, SOLANA_TOOLCHAIN.anchorTs.version]) assert.ok(index.includes(`| ${v} |`), v);
  assert.ok(index.includes(SOLANA_TOOLCHAIN.anchorImage.split("@")[0]));
  // The agents are pointed at them, and their instructions name no version of their own that could go stale.
  assert.match(files["CLAUDE.md"], /docs\/solana\//);
  assert.match(files[".claude/agents/server-engineer.md"], /docs\/solana\//);
  assert.doesNotMatch(files["CLAUDE.md"], /Anchor \d+\.\d+\.\d+|@coral-xyz\/anchor` \d/);
});

test("the starter program uses exactly the pinned Anchor, client and Rust", async () => {
  const { SOLANA_TOOLCHAIN } = await import("../dist/solana/toolchain.js");
  const t = (p) => files[`templates/solana-program/${p}`];
  const esc = (v) => v.replace(/\./g, "\\.");
  assert.equal(JSON.parse(t("package.json")).dependencies[SOLANA_TOOLCHAIN.anchorTs.package], SOLANA_TOOLCHAIN.anchorTs.version);
  assert.equal(JSON.parse(t("package-lock.json")).packages[`node_modules/${SOLANA_TOOLCHAIN.anchorTs.package}`].version, SOLANA_TOOLCHAIN.anchorTs.version);
  assert.match(t("programs/mynt_program/Cargo.toml"), new RegExp(`^anchor-lang = "=${esc(SOLANA_TOOLCHAIN.anchor.version)}"$`, "m"));
  assert.match(t("rust-toolchain.toml"), new RegExp(`^channel = "${esc(SOLANA_TOOLCHAIN.rust.version)}"$`, "m"));
});

test("the vendored solana-dev skill lists the files the watcher refreshes, all present", () => {
  const u = JSON.parse(files[".claude/skills/solana-dev/UPSTREAM.json"]);
  assert.ok(u.files.includes("SKILL.md"));
  for (const f of u.files) assert.ok(files[`.claude/skills/solana-dev/${f}`], f);
});
