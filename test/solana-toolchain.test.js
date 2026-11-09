import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advisories,
  anchorCandidates,
  applyPins,
  compare,
  docsIndex,
  globMatch,
  isBreaking,
  main,
  parseAnchorMakefile,
  pickAgave,
  pinsSha256,
  plan,
  rangeAffects,
  refreshSkill,
  renderPr,
  rustStable,
  rustupStable,
  vendorDocs,
  PATHS,
  ROOT,
} from "../scripts/solana-toolchain-watch.mjs";

const { SOLANA_TOOLCHAIN, TOOLCHAIN_PINS_SHA256, parseToolchainPins, toolchainRecord } = await import("../dist/solana/toolchain.js");
const PINS = JSON.parse(readFileSync(join(ROOT, PATHS.pins), "utf8"));
const H = (c) => c.repeat(64);

test("the pins live in one JSON file that the server reads, checks and hashes the same way as the watcher", () => {
  assert.equal(SOLANA_TOOLCHAIN.anchor.version, PINS.anchor.version);
  assert.equal(SOLANA_TOOLCHAIN.anchorImage, PINS.anchorImage);
  assert.equal(TOOLCHAIN_PINS_SHA256, pinsSha256(PINS));
  assert.match(TOOLCHAIN_PINS_SHA256, /^[0-9a-f]{64}$/);
  // Any change of a pin changes the hash; the description doesn't.
  assert.notEqual(pinsSha256({ ...PINS, rust: { ...PINS.rust, version: "1.90.0" } }), TOOLCHAIN_PINS_SHA256);
  assert.equal(pinsSha256({ ...PINS, description: "other words" }), TOOLCHAIN_PINS_SHA256);
  // A malformed pin never reaches a shell script.
  for (const bad of [
    { ...PINS, agave: { ...PINS.agave, version: "2.3.13; rm -rf ~" } },
    { ...PINS, anchor: { ...PINS.anchor, sha256: "abc" } },
    { ...PINS, anchorImage: "solanafoundation/anchor:v0.32.1" },
    { ...PINS, anchorTs: undefined },
  ])
    assert.throws(() => parseToolchainPins(JSON.stringify(bad)), /malformed/);
  const r = toolchainRecord({ source: "snapshot", snapshot_id: "sh-1" });
  assert.deepEqual(
    { agave: r.agave, anchor: r.anchor, rust: r.rust, image: r.anchor_image, pins: r.pins_sha256, env: r.environment },
    { agave: PINS.agave.version, anchor: PINS.anchor.version, rust: PINS.rust.version, image: PINS.anchorImage, pins: TOOLCHAIN_PINS_SHA256, env: { source: "snapshot", snapshot_id: "sh-1" } },
  );
});

test("versions: only stable releases count, lines and breaking moves are told apart, ranges are read as GitHub writes them", () => {
  assert.ok(compare("1.2.0", "1.10.0") < 0);
  assert.ok(compare("4.1.0-rc.1", "4.1.0") < 0);
  assert.deepEqual(anchorCandidates(["v0.32.3", "v0.32.2", "v0.32.1", "v0.31.9", "v1.2.2", "v2.0.0-rc.2"], "0.32.1", "patch"), ["0.32.3", "0.32.2", "0.32.1"]);
  assert.deepEqual(anchorCandidates(["v0.32.3", "v0.31.9", "v1.2.2", "v2.0.0-rc.2"], "0.32.1", "latest"), ["1.2.2", "0.32.3"]);
  assert.deepEqual(anchorCandidates(["v0.32.3", "v1.2.2"], "0.32.1", "1.2.2"), ["1.2.2"]);
  assert.equal(pickAgave(["v4.1.2", "v4.1.3", "v4.1.4-rc.1", "v4.2.0", "v4.0.9"], "4.1.2"), "4.1.3");
  assert.equal(pickAgave(["v2.3.13", "v2.3.14", "v4.1.2"], "2.3.0"), "2.3.14");
  assert.equal(isBreaking("0.32.1", "0.32.3"), false);
  assert.equal(isBreaking("0.32.1", "0.33.0"), true);
  assert.equal(isBreaking("0.32.1", "1.2.2"), true);
  assert.equal(rangeAffects(">= 1.87.0, < 1.89.0", "1.89.0"), false);
  assert.equal(rangeAffects(">= 1.87.0, < 1.89.0", "1.88.0"), true);
  assert.equal(rangeAffects("< 1.77.2", "1.77.1"), true);
  assert.equal(rangeAffects("<= 1.58", "1.58.0"), true);
  assert.equal(rangeAffects("= 2.3.13", "2.3.13"), true);
  assert.equal(rangeAffects("garbage", "2.3.13"), false);
  assert.deepEqual(parseAnchorMakefile("ANCHOR_CLI=v1.2.0\nSOLANA_CLI=v4.1.2\nVERSIONED_IMG_NAME=quay.io/ottersec/anchor:$(ANCHOR_CLI)\n"), { solana: "4.1.2", image: "quay.io/ottersec/anchor" });
  assert.equal(rustStable('[pkg.rust]\nversion = "1.99.1 (58cf8f9c3 2026-10-13)"\n'), "1.99.1");
  assert.equal(rustupStable("schema-version = '1'\nversion = '1.29.3'\n"), "1.29.3");
  assert.ok(globMatch("updates/release-notes/0-32-*.mdx", "updates/release-notes/0-32-1.mdx"));
  assert.ok(!globMatch("basics/*.mdx", "basics/deep/x.mdx"));
});

// The outside world, as the watcher sees it: GitHub releases, raw files, registries, npm, Rust's channel and the
// advisory databases.
const OLD = "2026-01-01T00:00:00Z";
function fakeNet({ anchorTags, agaveTags, images, advisoriesByRepo = {}, osv = {}, npmVersions = ["0.32.0", "0.32.1"], published = {}, rustDate = "2026-01-01", skillRelease = { tag_name: "v1.4.0", published_at: OLD }, files = {} }) {
  const calls = [];
  const res = (status, body = "") => ({ ok: status < 300, status, text: async () => body, json: async () => JSON.parse(body), body: [Buffer.from(body)], headers: new Map() });
  const net = {
    calls,
    async gh(path) {
      calls.push(`gh ${path}`);
      let m;
      if (/\/releases\/latest$/.test(path)) {
        if (!skillRelease) throw new Error("404");
        return skillRelease;
      }
      if ((m = /^repos\/([^/]+\/[^/]+)\/releases\?/.exec(path)))
        return (m[1].endsWith("anchor") ? anchorTags : agaveTags).map((t) => ({ tag_name: t, draft: false, prerelease: /-/.test(t), published_at: published[t] ?? OLD }));
      if ((m = /^repos\/([^/]+\/[^/]+)\/commits\?(.+)$/.exec(path))) return [{ sha: createSha(`${m[1]}?${decodeURIComponent(m[2]).split("&until=")[0]}`) }];
      if ((m = /^repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(path))) return { sha: createSha(`${m[1]}@${m[2]}`), commit: { committer: { date: published[m[2]] ?? OLD } } };
      if ((m = /^repos\/([^/]+\/[^/]+)\/security-advisories/.exec(path))) return advisoriesByRepo[m[1]] ?? [];
      if (path.startsWith("advisories?")) return [];
      if (/^repos\/[^/]+\/[^/]+\/license$/.test(path)) return { license: { spdx_id: "MIT" } };
      if (/^repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: "main" };
      if ((m = /^repos\/[^/]+\/[^/]+\/git\/trees\/([^?]+)(\?recursive=1)?$/.exec(path))) return files.trees(m[1], !!m[2]);
      throw new Error(`unexpected gh ${path}`);
    },
    async text(url) {
      calls.push(`get ${url}`);
      if (url.endsWith("/docker/Makefile")) {
        const v = /anchor\/v([^/]+)\//.exec(url)[1];
        return v.startsWith("1.") ? "ANCHOR_CLI=v1.2.0\nSOLANA_CLI=v4.1.2\nVERSIONED_IMG_NAME=quay.io/ottersec/anchor:$(ANCHOR_CLI)\n" : "ANCHOR_CLI=v0.32.1\nSOLANA_CLI=v2.3.0\nVERSIONED_IMG_NAME=solanafoundation/anchor:$(ANCHOR_CLI)\n";
      }
      if (url.endsWith("channel-rust-stable.toml")) return `manifest-version = "2"\ndate = "${rustDate}"\n[pkg.rust]\nversion = "1.99.1 (58cf8f9c3 2026-10-13)"\n`;
      if (url.endsWith("release-stable.toml")) return "schema-version = '1'\nversion = '1.29.3'\n";
      if (url.endsWith("rustup-init.sha256")) return `${H("9")}  rustup-init\n`;
      if (files.raw && url.startsWith("https://raw.githubusercontent.com/")) return files.raw(url);
      throw new Error(`unexpected get ${url}`);
    },
    async json(url) {
      calls.push(`json ${url}`);
      if (url.startsWith("https://registry.npmjs.org/")) return { versions: Object.fromEntries(npmVersions.map((v) => [v, {}])), time: Object.fromEntries(npmVersions.map((v) => [v, published[`npm:${v}`] ?? OLD])) };
      if (url.startsWith("https://api.osv.dev/")) return { results: osv.results ?? [] };
      throw new Error(`unexpected json ${url}`);
    },
    async get(url) {
      calls.push(`get ${url}`);
      if (files.raw && url.startsWith("https://raw.githubusercontent.com/")) {
        try {
          return res(200, await files.raw(url));
        } catch {
          return res(404);
        }
      }
      return res(404);
    },
    async exists(url) {
      return /anchor-(0\.32\.\d|1\.2\.2)-x86_64-unknown-linux-gnu$/.test(url);
    },
    async sha256(url) {
      calls.push(`sha256 ${url}`);
      if (url.includes("rustup-init")) return H("9");
      if (url.includes("/agave/")) return H("a");
      if (url.includes("/anchor/")) return H("b");
      return null;
    },
    async imageDigest(name, tag) {
      return images[`${name}:${tag}`] ?? null;
    },
  };
  return net;
}
const createSha = (s) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(8, "0").repeat(5);
};

const WORLD = {
  anchorTags: ["v2.0.0-rc.2", "v1.2.2", "v0.32.3", "v0.32.2", "v0.32.1"],
  agaveTags: ["v4.5.0-beta.0", "v4.4.1", "v4.1.4-rc.1", "v4.1.3", "v4.1.2", "v2.3.14", "v2.3.13"],
  images: {
    [`solanafoundation/anchor:v0.32.1`]: PINS.anchorImage.split("@")[1],
    [`quay.io/ottersec/anchor:v1.2.2`]: `sha256:${H("c")}`,
  },
};

test("the weekly plan: patch releases without a published image aren't adopted, Agave follows Anchor's line, a newer Anchor line is named but not applied", async () => {
  const net = fakeNet(WORLD);
  const p = await plan(net, PINS, { anchorLine: "patch" });
  assert.equal(p.next.anchor.version, PINS.anchor.version, "0.32.2 and 0.32.3 have no image: kept");
  assert.equal(p.next.anchorImage, PINS.anchorImage);
  assert.ok(p.notes.some((n) => /Anchor 0\.32\.3 .*no verifiable-build image/.test(n)));
  assert.ok(p.notes.some((n) => /Anchor 1\.2\.2 is the newest release: a breaking upgrade/.test(n)));
  // Agave: the newest of the line the pinned Anchor's image is built with (2.3), its archive hashed by the watcher.
  assert.deepEqual(p.next.agave, { version: "2.3.14", sha256: H("a") });
  assert.ok(net.calls.includes("sha256 https://github.com/anza-xyz/agave/releases/download/v2.3.14/solana-release-x86_64-unknown-linux-gnu.tar.bz2"));
  assert.equal(p.next.rust.version, "1.99.1");
  assert.deepEqual([p.next.rust.rustup, p.next.rust.rustupSha256], ["1.29.3", H("9")]);
  assert.deepEqual(p.changes.map((c) => [c.tool, c.from, c.to, c.breaking]), [
    ["agave", PINS.agave.version, "2.3.14", false],
    ["rust", PINS.rust.version, "1.99.1", false],
    ["rustup", PINS.rust.rustup, "1.29.3", false],
  ]);
  const pr = renderPr({ ...p });
  assert.match(pr.title, /^Solana toolchain: agave 2\.3\.14, rust 1\.99\.1, rustup 1\.29\.3$/);
  assert.match(pr.body, /never merged automatically/);
  assert.match(pr.body, /https:\/\/github\.com\/anza-xyz\/agave\/releases\/tag\/v2\.3\.14/);
  assert.match(pr.body, /https:\/\/github\.com\/rust-lang\/rust\/blob\/1\.99\.1\/RELEASES\.md/);
});

test("anchor_line latest adopts the newest Anchor with its image by digest, moves Agave to its line, and flags the breaking change", async () => {
  const p = await plan(fakeNet({ ...WORLD, npmVersions: ["0.32.1"] }), PINS, { anchorLine: "latest", rust: "pinned" });
  assert.equal(p.next.anchor.version, "1.2.2");
  assert.equal(p.next.anchor.sha256, H("b"));
  assert.match(p.next.anchor.commit, /^[0-9a-f]{40}$/);
  assert.equal(p.next.anchorImage, `quay.io/ottersec/anchor:v1.2.2@sha256:${H("c")}`);
  assert.equal(p.next.agave.version, "4.1.3", "the newest stable 4.1.x, not 4.4 and never an -rc");
  assert.equal(p.next.rust.version, PINS.rust.version, "--rust pinned");
  // No @coral-xyz/anchor for 1.2: kept, and said.
  assert.equal(p.next.anchorTs.version, PINS.anchorTs.version);
  assert.ok(p.notes.some((n) => /no release for Anchor 1\.2\.2's line/.test(n)));
  const pr = renderPr(p);
  assert.match(pr.title, /^BREAKING: Solana toolchain: agave 4\.1\.3, anchor 1\.2\.2/);
  assert.match(pr.body, /anchor \*\*\(breaking\)\*\* \| `0\.32\.1` \| `1\.2\.2`/);
  assert.match(pr.body, /## Breaking changes[\s\S]*anchor moves from 0\.32\.1 to 1\.2\.2, a new major version/);
});

test("an advisory on a pinned tool marks the pull request urgent, and says whether the update fixes it", async () => {
  const net = fakeNet({
    ...WORLD,
    advisoriesByRepo: { "rust-lang/rust": [{ ghsa_id: "GHSA-test-std", severity: "high", summary: "std flaw", html_url: "https://github.com/advisories/GHSA-test-std", vulnerabilities: [{ package: { name: "std" }, vulnerable_version_range: ">= 1.87.0, < 1.90.0" }] }] },
  });
  const before = await advisories(net, PINS);
  assert.deepEqual(before.map((a) => [a.id, a.tool, a.version]), [["GHSA-test-std", "rust", PINS.rust.version]]);
  const p = await plan(net, PINS, { anchorLine: "patch" });
  const after = await advisories(net, p.next);
  assert.deepEqual(after, []);
  const pr = renderPr({ ...p, advisoriesBefore: before, advisoriesAfter: after });
  assert.match(pr.title, /^URGENT \(security advisory\): Solana toolchain/);
  assert.match(pr.body, /GHSA-test-std.*fixed by this update/);
  // RustSec findings come through OSV for the crates the template builds with.
  const osvNet = fakeNet({ ...WORLD, osv: { results: [{ vulns: [{ id: "RUSTSEC-2099-0001" }] }] } });
  const viaOsv = await advisories(osvNet, PINS);
  assert.deepEqual(viaOsv.map((a) => [a.id, a.package]), [["RUSTSEC-2099-0001", "anchor-lang"]]);
});

test("applying a plan rewrites every pin: the pins file, the starter program's Anchor, client and Rust", () => {
  const root = mkdtempSync(join(tmpdir(), "mynt-watch-"));
  mkdirSync(join(root, "schemas"));
  cpSync(join(ROOT, PATHS.pins), join(root, PATHS.pins));
  cpSync(join(ROOT, PATHS.template), join(root, PATHS.template), { recursive: true });
  const next = { ...PINS, anchor: { version: "0.32.9", sha256: H("b"), commit: "f".repeat(40) }, rust: { ...PINS.rust, version: "1.99.1" }, anchorTs: { ...PINS.anchorTs, version: "0.32.9" } };
  const { clientChanged } = applyPins(root, PINS, next);
  assert.equal(clientChanged, true);
  const pins = JSON.parse(readFileSync(join(root, PATHS.pins), "utf8"));
  assert.equal(pins.anchor.version, "0.32.9");
  assert.equal(pins.description, PINS.description, "the description stays");
  assert.equal(pinsSha256(pins), pinsSha256(next));
  assert.equal(JSON.parse(readFileSync(join(root, PATHS.template, "package.json"), "utf8")).dependencies["@coral-xyz/anchor"], "0.32.9");
  assert.match(readFileSync(join(root, PATHS.template, "programs/mynt_program/Cargo.toml"), "utf8"), /^anchor-lang = "=0\.32\.9"$/m);
  assert.match(readFileSync(join(root, PATHS.template, "rust-toolchain.toml"), "utf8"), /^channel = "1\.99\.1"$/m);
});

test("docs are re-vendored at the pinned tag (only the listed subset, with the licence), and the skill follows its upstream", async () => {
  const root = mkdtempSync(join(tmpdir(), "mynt-watch-docs-"));
  const tree = {
    root: [{ path: "docs", type: "tree", sha: "t-docs" }],
    "t-docs": [{ path: "src", type: "tree", sha: "t-src" }],
    "t-src": [],
    "t-src-r": ["cli/examples/test-validator.md", "runtime/sysvars.md", "operations/setup-a-validator.md", "proposals/log_data.md"],
  };
  const raw = {};
  const net = fakeNet({
    ...WORLD,
    files: {
      trees: (sha, recursive) => {
        if (recursive) return { tree: tree[`${sha}-r`].map((path) => ({ path, type: "blob" })) };
        if (tree[sha]) return { sha, tree: tree[sha] };
        return { sha: "root", tree: tree.root };
      },
      raw: (url) => {
        if (url.endsWith("/LICENSE")) return "Apache License\nVersion 2.0, January 2004\n".padEnd(200, ".");
        raw[url] = true;
        if (url.includes("solana-dev-skill") && url.endsWith("/references/testing.md")) throw new Error("404");
        return `content of ${url.split("/").pop()}`;
      },
    },
  });
  const u = await vendorDocs(net, root, "agave", PINS);
  assert.equal(u.tag, `v${PINS.agave.version}`);
  assert.deepEqual(u.files, ["cli/examples/test-validator.md", "proposals/log_data.md", "runtime/sysvars.md"], "the validator-operations page isn't vendored");
  assert.ok(existsSync(join(root, PATHS.docs, "agave/LICENSE")));
  assert.equal(readFileSync(join(root, PATHS.docs, "agave/runtime/sysvars.md"), "utf8"), "content of sysvars.md");
  assert.ok(Object.keys(raw).every((url) => url.includes(`/${u.commit}/`)), "fetched at the tag's commit");
  const index = docsIndex(PINS, { agave: u, anchor: { ...u, repo: "solana-foundation/anchor", tag: `v${PINS.anchor.version}` } });
  assert.match(index, new RegExp(`\\| ${PINS.agave.version.replace(/\./g, "\\.")} \\|`));

  // The skill: the same files at the upstream's newest commit; one removed upstream is dropped and named.
  const skillDir = join(root, PATHS.skill);
  mkdirSync(join(skillDir, "references"), { recursive: true });
  const upstream = JSON.parse(readFileSync(join(ROOT, PATHS.skill, "UPSTREAM.json"), "utf8"));
  writeFileSync(join(skillDir, "UPSTREAM.json"), JSON.stringify({ ...upstream, files: ["SKILL.md", "references/testing.md"] }));
  const s = await refreshSkill(net, root);
  assert.equal(s.changed, true);
  assert.deepEqual(s.dropped, ["references/testing.md"]);
  const after = JSON.parse(readFileSync(join(skillDir, "UPSTREAM.json"), "utf8"));
  assert.equal(after.commit, s.commit);
  assert.equal(after.url, `https://github.com/${after.repo}/blob/${s.commit}/${after.path}`);
  assert.deepEqual(after.files, ["SKILL.md"]);
  assert.equal(after.found_by, "HyDE", "the provenance stays");
});

test("a dry run writes the pull request's title and body and changes no file", async () => {
  const root = mkdtempSync(join(tmpdir(), "mynt-watch-dry-"));
  mkdirSync(join(root, "schemas"));
  cpSync(join(ROOT, PATHS.pins), join(root, PATHS.pins));
  const title = join(root, "title.txt");
  const body = join(root, "body.md");
  const branch = join(root, "branch.txt");
  const r = await main(["--title", title, "--body", body, "--branch-file", branch], { root, net: fakeNet(WORLD) });
  assert.equal(readFileSync(join(root, PATHS.pins), "utf8"), readFileSync(join(ROOT, PATHS.pins), "utf8"));
  assert.equal(readFileSync(title, "utf8"), r.title);
  assert.match(readFileSync(body, "utf8"), /## Changes/);
  assert.match(readFileSync(branch, "utf8"), /^solana-toolchain\/[0-9a-f]{12}$/);
  assert.equal(r.urgentWithoutFix, false);
});

test("supply chain: releases younger than the minimum age wait, the Solana Foundation's image is preferred, and the PR says a person must review it", async () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  const young = "2026-11-08T00:00:00Z";
  const world = {
    ...WORLD,
    images: { ...WORLD.images, "solanafoundation/anchor:v1.2.2": `sha256:${H("d")}` },
    published: { "v2.3.14": young, "1.29.3": young, "v1.2.2": "2026-11-01T00:00:00Z" },
    rustDate: "2026-11-08",
  };
  const p = await plan(fakeNet(world), PINS, { anchorLine: "latest", now, minAge: 3 * 86_400_000 });
  assert.equal(p.next.anchorImage, `solanafoundation/anchor:v1.2.2@sha256:${H("d")}`, "the Solana Foundation's registry first, though the Makefile names quay.io");
  const q = await plan(fakeNet(world), PINS, { anchorLine: "patch", now, minAge: 3 * 86_400_000 });
  assert.equal(q.next.agave.version, PINS.agave.version, "Agave 2.3.14 is a day old");
  assert.equal(q.next.rust.version, PINS.rust.version, "Rust 1.99.1's channel is a day old");
  assert.equal(q.next.rust.rustup, PINS.rust.rustup, "rustup 1.29.3's tag is a day old");
  for (const re of [/Agave 2\.3\.14 is less than 3 days old/, /Rust 1\.99\.1 is less than 3 days old/, /rustup 1\.29\.3 is less than 3 days old/]) assert.ok(q.notes.some((n) => re.test(n)), String(re));
  // With no minimum, they'd be adopted: the age is what held them back.
  const r = await plan(fakeNet(world), PINS, { anchorLine: "patch", now, minAge: 0 });
  assert.equal(r.next.agave.version, "2.3.14");
  const pr = renderPr(q);
  assert.match(pr.body, /A person must review this pull request before it is merged/);
  assert.match(pr.body, /excluded from any standing instruction to merge green pull requests/);
  // The docs tell agents who deploys.
  assert.match(docsIndex(PINS, { agave: { repo: "anza-xyz/agave", tag: "v1", commit: "c".repeat(40), license: "Apache-2.0" }, anchor: { repo: "solana-foundation/anchor", tag: "v1", commit: "c".repeat(40), license: "Apache-2.0" } }), /Mynt deploys; never run `anchor deploy`, `solana program deploy` or `curl \| sh` installers/);
});

test("the solana-dev skill moves only to a tagged release, or to a commit at least the minimum age old, with a link to the upstream diff", async () => {
  const root = mkdtempSync(join(tmpdir(), "mynt-watch-skill-"));
  const skillDir = join(root, PATHS.skill);
  mkdirSync(skillDir, { recursive: true });
  const upstream = JSON.parse(readFileSync(join(ROOT, PATHS.skill, "UPSTREAM.json"), "utf8"));
  writeFileSync(join(skillDir, "UPSTREAM.json"), JSON.stringify({ ...upstream, files: ["SKILL.md"] }));
  const files = { raw: (url) => (url.endsWith("/LICENSE") ? "MIT License".padEnd(200, ".") : "skill text") };
  // A tagged release: that tag's commit.
  let net = fakeNet({ ...WORLD, files });
  let s = await refreshSkill(net, root, 3 * 86_400_000);
  assert.equal(s.ref, "v1.4.0");
  assert.ok(net.calls.includes("gh repos/solana-foundation/solana-dev-skill/commits/v1.4.0"));
  assert.equal(s.compare, `https://github.com/solana-foundation/solana-dev-skill/compare/${upstream.commit}...${s.commit}`);
  assert.match(renderPr({ changes: [], notes: [], skill: s }).body, new RegExp(`v1\\.4\\.0 .*Upstream diff: ${s.compare.replace(/[.?]/g, "\\$&")}`));
  // No release (or a too-new one): the newest commit older than the minimum age, never the branch's head.
  writeFileSync(join(skillDir, "UPSTREAM.json"), JSON.stringify({ ...upstream, files: ["SKILL.md"] }));
  net = fakeNet({ ...WORLD, files, skillRelease: { tag_name: "v9", published_at: new Date().toISOString() } });
  s = await refreshSkill(net, root, 3 * 86_400_000);
  assert.equal(s.ref, null);
  const asked = net.calls.find((c) => c.startsWith("gh repos/solana-foundation/solana-dev-skill/commits?sha=main&until="));
  assert.ok(asked, net.calls.join("\n"));
  const until = Date.parse(decodeURIComponent(/until=([^&]+)/.exec(asked)[1]));
  assert.ok(Date.now() - until >= 3 * 86_400_000 - 60_000, "at least three days back");
});
