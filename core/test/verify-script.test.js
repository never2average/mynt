import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERIFY_SCRIPT } from "../dist/verify-script.js";

// Mynt's verify.sh, run for real on a temporary tree: the auditor's read-only copy of the source and the re-hash
// that blocks a build when the audit changed it.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mynt-verify-"));
  const V = join(root, "verify");
  const src = join(root, "src");
  mkdirSync(V, { recursive: true });
  for (const [path, text] of Object.entries({
    "api/index.ts": "export const x = 1;\n",
    "web/package.json": "{}\n",
    ".git/index": "git index v1",
    ".git/HEAD": "ref: refs/heads/main\n",
    "web/.git/config": "[core]\n",
  })) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  symlinkSync("index.ts", join(src, "api/link.ts"));
  // Packaged as the build does it: tar of the workspace, without node_modules.
  const tar = spawnSync("tar", ["--exclude=node_modules", "-czf", join(V, "app.tgz"), "."], { cwd: src });
  assert.equal(tar.status, 0, tar.stderr?.toString());
  writeFileSync(join(V, "verify.sh"), VERIFY_SCRIPT);
  const sha = createHash("sha256").update(readFileSync(join(V, "app.tgz"))).digest("hex");
  const env = { ...process.env, MYNT_VERIFY_DIR: V, MYNT_VERIFY_APP: join(root, "app"), MYNT_VERIFY_AUDIT_SRC: join(root, "audit-src") };
  const run = (...args) => {
    const r = spawnSync("bash", [join(V, "verify.sh"), ...args], { env });
    return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const copy = join(root, "audit-src");
  const cleanup = () => {
    spawnSync("chmod", ["-R", "u+w", root]);
    rmSync(root, { recursive: true, force: true });
  };
  return { root, V, sha, run, copy, cleanup };
}

const tree = (out) => out.match(/^(?:audit-copy|rehash) ([0-9a-f]{64})$/m)?.[1];

test("the auditor's copy is the verified archive, read-only; git's own folders don't count as source", () => {
  const f = fixture();
  try {
    assert.equal(f.run("--audit-copy", "0".repeat(64)).status, 2, "a copy is made only from the hash-checked archive");
    const made = f.run("--audit-copy", f.sha);
    assert.equal(made.status, 0, made.stderr);
    const before = tree(made.stdout);
    assert.ok(before, made.stdout);
    assert.equal(readFileSync(join(f.copy, "api/index.ts"), "utf8"), "export const x = 1;\n");
    // Read-only, so incidental writes fail instead of changing the source.
    assert.equal(statSync(join(f.copy, "api/index.ts")).mode & 0o222, 0, "no write bits on source files");
    assert.equal(statSync(join(f.copy, "api")).mode & 0o222, 0, "nor on their folders");
    assert.ok(statSync(join(f.copy, ".git/index")).mode & 0o200, "git's own folder stays writable for git commands");
    if (process.getuid?.() !== 0) assert.throws(() => writeFileSync(join(f.copy, "api/index.ts"), "x"));
    // What git commands rewrite (its index, at any depth) isn't source: still unchanged.
    writeFileSync(join(f.copy, ".git/index"), "git index v2");
    writeFileSync(join(f.copy, "web/.git/config"), "[core]\nbare = false\n");
    // Installed packages aren't source either. The copy is read-only, so (as an ordinary user, as in CI)
    // the folder can only be added by opening its parent for a moment, then putting its mode back exactly.
    const webMode = statSync(join(f.copy, "web")).mode & 0o7777;
    chmodSync(join(f.copy, "web"), webMode | 0o200);
    mkdirSync(join(f.copy, "web/node_modules"), { recursive: true });
    chmodSync(join(f.copy, "web"), webMode);
    let r = f.run("--rehash");
    assert.equal(tree(r.stdout), before, r.stdout + r.stderr);
    assert.equal(readFileSync(join(f.V, "changed.txt"), "utf8"), "");

    // Any change to a source file is caught and named: an edit, an added file, a deleted one, a moved link.
    chmodSync(join(f.copy, "api"), 0o755);
    chmodSync(join(f.copy, "api/index.ts"), 0o644);
    writeFileSync(join(f.copy, "api/index.ts"), "export const x = 2;\n");
    writeFileSync(join(f.copy, "api/extra.ts"), "new\n");
    unlinkSync(join(f.copy, "api/link.ts"));
    symlinkSync("extra.ts", join(f.copy, "api/link.ts"));
    chmodSync(join(f.copy, "web"), 0o755);
    unlinkSync(join(f.copy, "web/package.json"));
    r = f.run("--rehash");
    assert.notEqual(tree(r.stdout), before);
    assert.deepEqual(readFileSync(join(f.V, "changed.txt"), "utf8").trim().split("\n"), [
      "./api/index.ts",
      "./api/link.ts",
      "./web/package.json (deleted)",
      "./api/extra.ts (added)",
    ]);

    // A fresh copy (the build's next verification) starts from the archive again.
    const again = f.run("--audit-copy", f.sha);
    assert.equal(tree(again.stdout), before, again.stderr);
  } finally {
    f.cleanup();
  }
});

// Mynt's image stage (images.py, src/verify-images.ts), run for real against stand-ins for docker, syft and grype:
// what it builds, what it scans, and what the image_scan and sbom checks then say.
const { VERIFY_IMAGES_SCRIPT } = await import("../dist/verify-images.js");
const NODE_BASE = `node:22-alpine@sha256:${"1".repeat(64)}`;
const CADDY_BASE = `caddy:2-alpine@sha256:${"2".repeat(64)}`;
const vuln = (id, severity, name, version, fixedIn, artifact = {}) => ({
  vulnerability: { id, severity, fix: fixedIn ? { state: "fixed", versions: [fixedIn] } : { state: "not-fixed", versions: [] } },
  artifact: { name, version, type: "apk", purl: `pkg:apk/alpine/${name}@${version}`, locations: [{ path: "/lib/apk/db/installed" }], ...artifact },
});
function imagesFixture({ files, services = null, matches = [], dockerWorks = true }) {
  const root = mkdtempSync(join(tmpdir(), "mynt-images-"));
  const [src, V, stub] = [join(root, "src"), join(root, "verify"), join(root, "stub")];
  for (const d of [src, V, join(stub, "bin")]) mkdirSync(d, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), text);
  }
  const tool = (name, body) => {
    writeFileSync(join(stub, "bin", name), `#!/bin/bash\necho "${name} $*" >> "$STUB/calls.log"\n${body}\n`);
    chmodSync(join(stub, "bin", name), 0o755);
  };
  tool(
    "docker",
    [
      'case "$1" in',
      `  info) exit ${dockerWorks ? 0 : 1};;`,
      '  compose) cat "$STUB/compose.json"; exit 0;;',
      '  build) if [ -f "$STUB/build-fails" ]; then echo "npm error the lockfile is out of sync"; exit 1; fi; echo sha256:built; exit 0;;',
      "  pull) exit 0;;",
      `  image) echo "sha256:${"e".repeat(64)} 12345"; exit 0;;`,
      "esac",
    ].join("\n"),
  );
  tool("syft", 'for a in "$@"; do case "$a" in cyclonedx-json=*) out=$(echo "$a" | sed "s/^cyclonedx-json=//");; esac; done\nif [ -f "$STUB/base-sbom.json" ] && echo "$1" | grep -q "^registry:"; then cp "$STUB/base-sbom.json" "$out"; elif [ -f "$STUB/sbom-empty" ]; then echo \'{"components": []}\' > "$out"; else echo \'{"bomFormat": "CycloneDX", "components": [{"name": "musl"}, {"name": "node"}]}\' > "$out"; fi');
  tool("grype", 'while [ $# -gt 0 ]; do if [ "$1" = "--file" ]; then out="$2"; fi; shift; done\ncp "$STUB/grype.json" "$out"');
  writeFileSync(join(stub, "grype.json"), JSON.stringify({ matches, descriptor: { db: { status: { built: "2026-11-28T06:20:09Z" } } } }));
  // What `docker compose config --format json` gives for the app's Compose file: contexts made absolute.
  const absolute = Object.fromEntries(Object.entries(services ?? {}).map(([name, s]) => [name, s.build ? { ...s, build: { ...s.build, context: src } } : s]));
  writeFileSync(join(stub, "compose.json"), JSON.stringify({ name: "app", services: absolute }));
  writeFileSync(join(V, "images.py"), VERIFY_IMAGES_SCRIPT);
  const run = () => {
    const r = spawnSync("python3", [join(V, "images.py"), src, V, join(stub, "bin/syft"), join(stub, "bin/grype"), "--syft-version", "1.18.1", "--grype-version", "0.121.3"], {
      env: { ...process.env, STUB: stub, PATH: `${join(stub, "bin")}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr.toString() + r.stdout.toString());
    return JSON.parse(readFileSync(join(V, "images.json"), "utf8"));
  };
  const calls = () => readFileSync(join(stub, "calls.log"), "utf8").trim().split("\n");
  return { root, src, V, stub, run, calls, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const STARTER = {
  files: {
    "compose.yaml": "services: {}\n",
    "api/Dockerfile": `FROM ${NODE_BASE} AS build\nRUN npm ci\nFROM ${NODE_BASE}\nCOPY --from=build /app /app\n`,
    "web/Dockerfile": `FROM ${NODE_BASE} AS build\nRUN npm ci\n\nFROM ${CADDY_BASE}\nCOPY --from=build /app/web/dist /srv\n`,
    "mobile/Dockerfile": `FROM ${NODE_BASE} AS build\nFROM ${CADDY_BASE}\n`,
  },
  services: {
    api: { build: { dockerfile: "api/Dockerfile" } },
    web: { build: { dockerfile: "web/Dockerfile" } },
    mobile: { build: { dockerfile: "mobile/Dockerfile" }, profiles: ["mobile"] },
  },
};

test("image_scan builds every image the app ships from the verified source, scans it and keeps its SBOM", () => {
  const f = imagesFixture(STARTER);
  try {
    const r = f.run();
    assert.deepEqual(r.check, { status: "pass", detail: "no high or critical vulnerability in 2 image(s) (grype 0.121.3; api 0 critical / 0 high, web 0 critical / 0 high); not scanned: mobile (only in profile mobile: Mynt's hosting doesn't start it)" });
    // Built from the Dockerfile the Compose file names, with the source as the context; never the profile-only one.
    const builds = f.calls().filter((c) => c.startsWith("docker build"));
    assert.deepEqual(builds.map((c) => c.split(" ").slice(2, 5).join(" ")), [`-q -f ${join(f.src, "api/Dockerfile")}`, `-q -f ${join(f.src, "web/Dockerfile")}`]);
    assert.ok(builds.every((c) => c.endsWith(` ${f.src}`)));
    // Each built image: its base images (which one ships, pinned or not), its id, its SBOM beside the source's, its scan.
    const web = r.images.find((i) => i.service === "web");
    assert.deepEqual(web.base_images, [{ ref: NODE_BASE, pinned: true, final: false }, { ref: CADDY_BASE, pinned: true, final: true }]);
    assert.equal(web.image_id, `sha256:${"e".repeat(64)}`);
    assert.equal(web.dockerfile, "web/Dockerfile");
    assert.equal(web.sbom.path, join(f.V, "sbom-images/web.cdx.json"));
    assert.equal(web.sbom.components, 2);
    assert.equal(web.sbom.sha256, createHash("sha256").update(readFileSync(web.sbom.path)).digest("hex"));
    assert.deepEqual([web.scan.tool, web.scan.tool_version, web.scan.database_built, web.scan.critical, web.scan.high], ["grype", "0.121.3", "2026-11-28T06:20:09Z", 0, 0]);
    // The scan reads the image's SBOM, and the SBOM is of the built image.
    assert.ok(f.calls().some((c) => c.startsWith("syft docker:mynt-verify/web:")));
    assert.ok(f.calls().some((c) => c.startsWith(`grype sbom:${web.sbom.path}`)));
    assert.deepEqual(r.sbom, { ok: true, detail: "api (2 components), web (2 components)", missing: [] });
    assert.deepEqual(r.skipped, [{ service: "mobile", reason: "only in profile mobile: Mynt's hosting doesn't start it" }]);
  } finally {
    f.cleanup();
  }
});

test("image_scan fails on a high or critical vulnerability that has a fix, and only warns about one that has none", () => {
  const fixable = vuln("CVE-2026-28389", "High", "libssl3", "3.3.2-r1", "3.3.7-r0");
  const critical = vuln("CVE-2026-1", "Critical", "musl", "1.2.5-r0", "1.2.5-r3");
  const unfixable = vuln("GHSA-jqcq-xjh3-6g23", "High", "pgproto3", "v2.3.3", null);
  const medium = vuln("CVE-2026-2", "Medium", "busybox", "1.37", "1.38");
  let f = imagesFixture({ ...STARTER, matches: [fixable, fixable, critical, unfixable, medium] });
  try {
    const r = f.run();
    assert.equal(r.check.status, "fail");
    assert.match(r.check.detail, /^4 high or critical vulnerabilities with a fix available \(grype 0\.121\.3\): api: CVE-2026-1 critical in musl 1\.2\.5-r0 \(fixed in 1\.2\.5-r3\); api: CVE-2026-28389 high in libssl3 3\.3\.2-r1 \(fixed in 3\.3\.7-r0\); web: /);
    assert.match(r.check.detail, /2 high or critical with no fixed version yet: api: GHSA-jqcq-xjh3-6g23 high in pgproto3 v2\.3\.3 \(no fixed version yet\)/);
    // Counted once per vulnerability and package, by severity, with how many have a fix.
    const api = r.images.find((i) => i.service === "api").scan;
    assert.deepEqual([api.critical, api.high, api.medium, api.low], [1, 2, 1, 0]);
    assert.deepEqual([api.fixable.critical, api.fixable.high, api.fixable.medium], [1, 1, 1]);
  } finally {
    f.cleanup();
  }
  f = imagesFixture({ ...STARTER, matches: [unfixable, medium] });
  try {
    const r = f.run();
    assert.equal(r.check.status, "warn");
    assert.match(r.check.detail, /^no high or critical vulnerability this build's Dockerfiles can fix \(grype 0\.121\.3; api 0 critical \/ 1 high, web 0 critical \/ 1 high\); 2 high or critical with no fixed version yet: /);
  } finally {
    f.cleanup();
  }
});

test("a fixed library compiled into a program of the base image is a warning naming it; the same in a program the build made fails", () => {
  // Caddy as its publisher built it: only a newer build of that image has the fixed library.
  // The library is told apart by the base image's own SBOM (its package url and the file it is in), not by image
  // layers: the starter's Dockerfile rewrites Caddy's file when it strips its capability, without changing it.
  const xnet = { type: "go-module", purl: "pkg:golang/golang.org/x/net@v0.60.0" };
  const baseSbom = JSON.stringify({ components: [{ name: "golang.org/x/net", purl: xnet.purl, properties: [{ name: "syft:location:0:layerID", value: "sha256:x" }, { name: "syft:location:0:path", value: "/usr/bin/caddy" }] }] });
  const inBase = vuln("GO-2026-6860", "High", "golang.org/x/net", "v0.60.0", "0.62.0", { ...xnet, locations: [{ path: "/usr/bin/caddy", layerID: "sha256:rewritten-by-the-build" }] });
  let f = imagesFixture({ ...STARTER, matches: [inBase] });
  try {
    writeFileSync(join(f.stub, "base-sbom.json"), baseSbom);
    const r = f.run();
    assert.equal(r.check.status, "warn");
    assert.match(
      r.check.detail,
      /2 high or critical in programs the base image's publisher compiled, which only a newer build of that image fixes: api: GO-2026-6860 high in golang\.org\/x\/net v0\.60\.0 compiled into \/usr\/bin\/caddy \(the library is fixed in 0\.62\.0\)/,
    );
    const web = r.images.find((i) => i.service === "web").scan;
    assert.deepEqual([web.high, web.fixable.high, web.blocking.length, web.publisher_built.length], [1, 1, 0, 1], "counted as what it is, whatever its kind");
    // The base image asked is the one the shipped stage is built on, once.
    assert.equal(f.calls().filter((c) => c.startsWith(`syft registry:${CADDY_BASE} `)).length, 1);
  } finally {
    f.cleanup();
  }
  // A program the Dockerfile itself built or fetched: the build can fix it, so it fails.
  const ownBuild = vuln("GO-2026-6860", "High", "golang.org/x/net", "v0.60.0", "0.62.0", { ...xnet, locations: [{ path: "/app/server" }] });
  f = imagesFixture({ ...STARTER, matches: [ownBuild] });
  try {
    writeFileSync(join(f.stub, "base-sbom.json"), baseSbom);
    const r = f.run();
    assert.equal(r.check.status, "fail");
    assert.match(r.check.detail, /^2 high or critical vulnerabilities with a fix available/);
  } finally {
    f.cleanup();
  }
  // A system package or a runtime of the base image is the build's to fix (upgrade it, or a newer base image).
  f = imagesFixture({ ...STARTER, matches: [vuln("CVE-2026-9", "High", "node", "22.11.0", "22.23.4", { type: "binary", purl: "pkg:generic/node@22.11.0", locations: [{ path: "/usr/local/bin/node" }] })] });
  try {
    assert.equal(f.run().check.status, "fail");
  } finally {
    f.cleanup();
  }
});

test("image_scan fails when an image doesn't build or has no SBOM, and warns about a base image that isn't pinned", () => {
  let f = imagesFixture(STARTER);
  try {
    writeFileSync(join(f.stub, "build-fails"), "");
    const r = f.run();
    assert.equal(r.check.status, "fail");
    assert.match(r.check.detail, /^api: the image didn't build: npm error the lockfile is out of sync; web: the image didn't build: /);
    assert.deepEqual(r.sbom.missing, ["api", "web"], "and the sbom check has no image SBOMs to show");
    assert.equal(r.sbom.ok, false);
  } finally {
    f.cleanup();
  }
  f = imagesFixture(STARTER);
  try {
    writeFileSync(join(f.stub, "sbom-empty"), "");
    const r = f.run();
    assert.equal(r.check.status, "fail");
    assert.match(r.check.detail, /^api: no SBOM of the image: the SBOM has no components/);
    assert.ok(!f.calls().some((c) => c.startsWith("grype")), "nothing is scanned without an SBOM");
  } finally {
    f.cleanup();
  }
  // A tag alone can move: named, as a warning. A service that names an image instead of building one is pulled and scanned.
  f = imagesFixture({
    files: { "compose.yaml": "services: {}\n", "api/Dockerfile": "FROM node:22-alpine AS build\nFROM build\nCMD [\"node\"]\n" },
    services: { api: { build: { dockerfile: "api/Dockerfile" } }, db: { image: "postgres:16-alpine" } },
  });
  try {
    const r = f.run();
    assert.equal(r.check.status, "warn");
    assert.match(r.check.detail, /base image not pinned by digest: node:22-alpine, postgres:16-alpine$/);
    assert.deepEqual(r.images.find((i) => i.service === "api").base_images, [{ ref: "node:22-alpine", pinned: false, final: true }], "a stage that continues an earlier one ships that stage's base");
    assert.ok(f.calls().includes("docker pull -q postgres:16-alpine"));
    assert.ok(f.calls().some((c) => c.startsWith("syft docker:postgres:16-alpine")));
  } finally {
    f.cleanup();
  }
});

test("image_scan without docker scans the base images only and says so; an app with no container files has nothing to scan", () => {
  let f = imagesFixture({ ...STARTER, dockerWorks: false });
  try {
    const r = f.run();
    assert.equal(r.built, false);
    assert.equal(r.check.status, "warn", "never a pass: the images themselves weren't scanned");
    assert.match(r.check.detail, /docker isn't available in this verification sandbox, so no image was built: only the base images the Dockerfiles name were scanned/);
    assert.match(r.check.detail, /covered by dependency_audit and the source SBOM, not by this scan/);
    assert.ok(!f.calls().some((c) => c.startsWith("docker build")));
    // Each distinct base image once, read from its registry.
    assert.deepEqual(f.calls().filter((c) => c.startsWith("syft")).map((c) => c.split(" ")[1]).sort(), [`registry:${CADDY_BASE}`, `registry:${NODE_BASE}`]);
    assert.deepEqual(r.images.map((i) => i.source), ["base-image", "base-image"]);
  } finally {
    f.cleanup();
  }
  // A fixable high in a base image still fails.
  f = imagesFixture({ ...STARTER, dockerWorks: false, matches: [vuln("CVE-2026-28389", "High", "libssl3", "3.3.2-r1", "3.3.7-r0")] });
  try {
    assert.equal(f.run().check.status, "fail");
  } finally {
    f.cleanup();
  }
  f = imagesFixture({ files: { "package.json": "{}\n", "docs/Dockerfile": "FROM scratch\n" } });
  try {
    const r = f.run();
    assert.deepEqual(r.check, { status: "pass", detail: "no Compose file or Dockerfile at the root: this build ships no container image" });
    assert.equal(r.applicable, false);
  } finally {
    f.cleanup();
  }
  // An app without Compose: its root Dockerfile is the one image.
  f = imagesFixture({ files: { Dockerfile: `FROM ${NODE_BASE}\n` } });
  try {
    const r = f.run();
    assert.equal(r.check.status, "pass");
    assert.deepEqual(r.images.map((i) => [i.service, i.dockerfile]), [["app", "Dockerfile"]]);
  } finally {
    f.cleanup();
  }
});

test("the checks' script pins every scanner by version and archive hash, and writes the pipeline record the evidence is made from", () => {
  for (const pin of ["gitleaks_8.21.2_linux_$GA.tar.gz", "syft_1.18.1_linux_$SA.tar.gz", "grype_0.121.3_linux_$SA.tar.gz"]) assert.ok(VERIFY_SCRIPT.includes(pin), pin);
  // A tool is used only when its download matches the hash Mynt keeps, for both architectures it runs on.
  assert.equal((VERIFY_SCRIPT.match(/(GITLEAKS|SYFT|GRYPE)_SHA=[0-9a-f]{64}/g) ?? []).length, 6);
  assert.match(VERIFY_SCRIPT, /\[ "\$\(sha256sum "\$V\/\$asset" \| cut -d' ' -f1\)" = "\$want" \] \|\| return 1/);
  assert.match(VERIFY_SCRIPT, /\[ -n "\$want" \] \|\| return 1/, "no hash for this machine: not used");
  // The dependency gate is Mynt's own command, whatever the app's install flags say.
  assert.match(VERIFY_SCRIPT, /npm audit --omit=dev --audit-level=high >"\$V\/audit\.log"/);
  for (const check of ["source", "tests", "lint_typecheck", "secrets_scan", "secrets_history", "dependency_audit", "static_scan", "sbom", "image_scan", "disclosures"])
    assert.match(VERIFY_SCRIPT, new RegExp(`\\bran(_tests\\(\\) \\{ ran)? ${check} `), `${check} records what ran`);
  // The images are built from a fresh extraction of the verified archive, not the folder the tests ran in.
  assert.match(VERIFY_SCRIPT, /IMG_SRC="\$V\/image-src"; rm -rf "\$IMG_SRC"; mkdir -p "\$IMG_SRC" && tar -xzf "\$V\/app\.tgz" -C "\$IMG_SRC"/);
  assert.match(VERIFY_SCRIPT, /python3 "\$V\/images\.py" "\$IMG_SRC" "\$V"/);
  const syntax = spawnSync("bash", ["-n"], { input: VERIFY_SCRIPT });
  assert.equal(syntax.status, 0, syntax.stderr.toString());
});
