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
  const vendored = Object.keys(files).filter((p) => p.endsWith("UPSTREAM.json"));
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
