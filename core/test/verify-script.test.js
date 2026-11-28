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

test("a production review's copy is the commit's archive: fetched with a header file that is deleted, unpacked without its top folder, read-only, hashed", () => {
  const f = fixture();
  try {
    // A commit's archive as a repository host serves it: one folder at the top, named for the commit.
    const pack = join(f.root, "pack");
    mkdirSync(join(pack, "acme-app-ccccccc", "api"), { recursive: true });
    writeFileSync(join(pack, "acme-app-ccccccc", "api/index.ts"), "export const x = 1;\n");
    writeFileSync(join(pack, "acme-app-ccccccc", "README.md"), "# app\n");
    const archive = join(f.root, "commit.tgz");
    assert.equal(spawnSync("tar", ["-czf", archive, "-C", pack, "acme-app-ccccccc"]).status, 0);
    const header = join(f.V, "source.header");
    writeFileSync(header, "Authorization: Bearer not-a-real-token\n");
    const made = f.run("--review-copy", "file://" + archive, header);
    assert.equal(made.status, 0, made.stderr);
    const before = tree(made.stdout);
    assert.ok(before, made.stdout);
    assert.throws(() => statSync(header), /ENOENT/, "the header file is gone before anything else runs");
    assert.equal(readFileSync(join(f.copy, "api/index.ts"), "utf8"), "export const x = 1;\n", "the source is what is inside the archive's top folder");
    assert.equal(statSync(join(f.copy, "api/index.ts")).mode & 0o222, 0, "read-only");
    assert.equal(tree(f.run("--rehash").stdout), before, "untouched, it hashes the same afterwards");
    // A change to it is caught and named, as for a build's audit.
    chmodSync(join(f.copy, "README.md"), 0o644);
    writeFileSync(join(f.copy, "README.md"), "# changed\n");
    assert.notEqual(tree(f.run("--rehash").stdout), before);
    assert.match(readFileSync(join(f.V, "changed.txt"), "utf8"), /README\.md/);
    // An archive that can't be fetched: no copy, and the header file is still deleted.
    writeFileSync(header, "Authorization: Bearer not-a-real-token\n");
    const missing = f.run("--review-copy", "file://" + join(f.root, "nothing.tgz"), header);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /could not download the source/);
    assert.throws(() => statSync(header), /ENOENT/);
    assert.equal(f.run("--review-copy", "file://" + archive).status, 2, "it needs the header file's path");
  } finally {
    f.cleanup();
  }
});
