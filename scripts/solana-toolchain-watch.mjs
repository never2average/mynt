#!/usr/bin/env node
// Mynt's weekly Solana toolchain watcher (run by .github/workflows/solana-toolchain-watch.yml).
//
// It looks for new stable releases of everything Mynt pins in schemas/solana-toolchain.json (Agave, the Anchor
// CLI and its verifiable-build image, Rust and rustup, the @coral-xyz/anchor client), computes each new download's
// sha256 and the image's digest itself, checks the RustSec and GitHub advisory databases for the pinned and the
// proposed versions, and rewrites every place a pin appears: the pins file, the starter program in
// workspaces/coding-build/templates/solana-program, the version-matched docs in workspaces/coding-build/docs/solana
// (re-vendored at the new tags), and the vendored solana-dev skill (brought to its latest upstream commit). The
// workflow then opens a pull request, whose CI builds and tests the template program with the new toolchain. It
// never merges anything.
//
// How versions are chosen (each a stable release: no -alpha, -beta or -rc):
//   Anchor   the newest release of the pinned major.minor line (--anchor-line patch, the weekly default), or the
//            newest of all (--anchor-line latest), or an exact version. A release is adopted only when its Linux
//            binary and its verifiable-build image (by digest) are both published.
//   Agave    the newest release of the major.minor line that Anchor release builds its image with (docker/Makefile
//            SOLANA_CLI at the Anchor tag), never older than that.
//   Rust     the current stable (--rust stable), or as pinned (--rust pinned); rustup its current stable.
//   client   the newest @coral-xyz/anchor of the chosen Anchor's major.minor line.
//
// usage: node scripts/solana-toolchain-watch.mjs [--apply] [--anchor-line patch|latest|X.Y.Z] [--rust stable|pinned]
//          [--no-hash] [--docs-only] [--body FILE] [--title FILE] [--branch-file FILE]
// Without --apply it only reports. GITHUB_TOKEN, when set, is used for GitHub's API (rate limits); nothing is ever
// printed from it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const PATHS = {
  pins: "schemas/solana-toolchain.json",
  template: "workspaces/coding-build/templates/solana-program",
  docs: "workspaces/coding-build/docs/solana",
  skill: "workspaces/coding-build/.claude/skills/solana-dev",
};
const REPOS = { agave: "anza-xyz/agave", anchor: "solana-foundation/anchor", skill: "solana-foundation/solana-dev-skill", rust: "rust-lang/rust", rustup: "rust-lang/rustup" };

// ---- versions ----

export const parseVersion = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v).trim());
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, text: `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ""}` } : null;
};
export const isStable = (v) => {
  const p = parseVersion(v);
  return !!p && !p.pre;
};
export const compare = (a, b) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major - y.major || x.minor - y.minor || x.patch - y.patch || (x.pre ? (y.pre ? x.pre.localeCompare(y.pre) : -1) : y.pre ? 1 : 0);
};
export const sameLine = (a, b) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  return x.major === y.major && x.minor === y.minor;
};
const newest = (versions) => [...versions].sort(compare).at(-1) ?? null;
// A breaking move: a new major, or a new minor (which is a major for 0.x).
export const isBreaking = (from, to) => !!from && !!to && compare(from, to) !== 0 && !sameLine(from, to);

// Anchor candidates, newest first, by the policy in force.
export function anchorCandidates(tags, pinned, line = "patch") {
  const stable = tags.map((t) => parseVersion(t)).filter((p) => p && !p.pre).map((p) => p.text);
  let pool;
  if (line === "latest") pool = stable;
  else if (line === "patch") pool = stable.filter((v) => sameLine(v, pinned));
  else pool = stable.filter((v) => v === parseVersion(line)?.text);
  // Never older than the pin, unless asked for an exact version.
  const floor = line === "patch" || line === "latest";
  return [...new Set(pool)].filter((v) => !floor || compare(v, pinned) >= 0).sort(compare).reverse();
}

// The newest stable Agave of `target`'s major.minor line, never older than it.
export function pickAgave(tags, target) {
  const pool = tags.map((t) => parseVersion(t)).filter((p) => p && !p.pre && sameLine(p.text, target) && compare(p.text, target) >= 0).map((p) => p.text);
  return newest(pool);
}

// What an Anchor tag's docker/Makefile says its image is built with.
export function parseAnchorMakefile(text) {
  const solana = /^SOLANA_CLI\s*=\s*v?(\S+)/m.exec(text)?.[1] ?? null;
  const image = /^VERSIONED_IMG_NAME\s*=\s*(\S+?):\$\(ANCHOR_CLI\)/m.exec(text)?.[1] ?? null;
  return { solana, image };
}

export const rustStable = (channelToml) => /\[pkg\.rust\]\s*\nversion = "(\d+\.\d+\.\d+)/.exec(channelToml)?.[1] ?? null;
export const rustupStable = (releaseToml) => /^version = '(\d+\.\d+\.\d+)'/m.exec(releaseToml)?.[1] ?? null;

// GitHub's vulnerable_version_range: "< 1.2.3", ">= 1.0.0, < 1.0.5", "= 2.0.0", "<= 3".
export function rangeAffects(range, version) {
  if (!range) return false;
  const v = parseVersion(version)?.text;
  if (!v) return false;
  const norm = (x) => {
    const parts = String(x).trim().split(".");
    while (parts.length < 3) parts.push("0");
    return parts.join(".");
  };
  return range.split(",").every((clause) => {
    const m = /^\s*(<=|>=|<|>|=)?\s*v?([0-9][0-9A-Za-z.-]*)\s*$/.exec(clause);
    if (!m) return false;
    const c = compare(v, norm(m[2]));
    return { "<": c < 0, "<=": c <= 0, ">": c > 0, ">=": c >= 0, "=": c === 0 }[m[1] ?? "="];
  });
}

// The same canonical form src/solana/toolchain.ts hashes: keys sorted at every level.
const canonical = (v) =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
export const pinsOf = (j) => ({
  agave: { version: j.agave.version, sha256: j.agave.sha256 },
  anchor: { version: j.anchor.version, sha256: j.anchor.sha256, commit: j.anchor.commit },
  rust: { version: j.rust.version, rustup: j.rust.rustup, rustupSha256: j.rust.rustupSha256 },
  anchorImage: j.anchorImage,
  anchorTs: { package: j.anchorTs.package, version: j.anchorTs.version },
});
export const pinsSha256 = (j) => createHash("sha256").update(canonical(pinsOf(j))).digest("hex");

// ---- the network ----

export function httpClient({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  const get = async (url, { headers = {}, method = "GET", body } = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method, headers: { "User-Agent": "mynt-solana-toolchain-watch", ...headers }, body });
      if (res.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return res;
    }
  };
  const gh = async (path) => {
    const res = await get(`https://api.github.com/${path}`, { headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!res.ok) throw new Error(`GitHub ${path}: ${res.status}`);
    return res.json();
  };
  const text = async (url) => {
    const res = await get(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.text();
  };
  const json = async (url, opts) => {
    const res = await get(url, opts);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  };
  // A download's sha256, streamed (an Agave release is hundreds of MB); null when it isn't published.
  const sha256 = async (url) => {
    const res = await get(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    const h = createHash("sha256");
    for await (const chunk of res.body) h.update(chunk);
    return h.digest("hex");
  };
  const exists = async (url) => (await get(url, { method: "HEAD" })).ok;
  // An image's manifest digest from its registry (anonymous pull token where the registry asks for one).
  const imageDigest = async (image, tag) => {
    const [registry, repo] = image.includes(".") && image.split("/")[0].includes(".") ? [image.split("/")[0], image.split("/").slice(1).join("/")] : ["registry-1.docker.io", image];
    const accept =
      "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json";
    const url = `https://${registry}/v2/${repo}/manifests/${tag}`;
    let res = await get(url, { method: "HEAD", headers: { Accept: accept } });
    if (res.status === 401) {
      const p = Object.fromEntries([...(res.headers.get("www-authenticate") ?? "").matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
      if (!p.realm?.startsWith("https://")) return null;
      const t = await json(`${p.realm}?service=${encodeURIComponent(p.service ?? registry)}&scope=${encodeURIComponent(p.scope ?? `repository:${repo}:pull`)}`);
      res = await get(url, { method: "HEAD", headers: { Accept: accept, Authorization: `Bearer ${t.token ?? t.access_token}` } });
    }
    const digest = res.ok ? res.headers.get("docker-content-digest") : null;
    return /^sha256:[0-9a-f]{64}$/.test(digest ?? "") ? digest : null;
  };
  return { get, gh, text, json, sha256, exists, imageDigest };
}

const tagsOf = async (net, repo) => {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const rs = await net.gh(`repos/${repo}/releases?per_page=100&page=${page}`);
    out.push(...rs.filter((r) => !r.draft && !r.prerelease).map((r) => r.tag_name));
    if (rs.length < 100) break;
  }
  return out;
};

// ---- advisories (RustSec through OSV, and GitHub's advisory database) ----

export function advisoryTargets(p) {
  return [
    { tool: "anchor", ecosystem: "crates.io", ghEcosystem: "rust", name: "anchor-lang", version: p.anchor.version },
    { tool: "anchor", ecosystem: "crates.io", ghEcosystem: "rust", name: "anchor-cli", version: p.anchor.version },
    { tool: "anchorTs", ecosystem: "npm", ghEcosystem: "npm", name: p.anchorTs.package, version: p.anchorTs.version },
    { tool: "agave", ecosystem: "crates.io", ghEcosystem: "rust", name: "solana-program-runtime", version: p.agave.version },
    { tool: "agave", ecosystem: "crates.io", ghEcosystem: "rust", name: "solana-runtime", version: p.agave.version },
    { tool: "agave", ecosystem: "crates.io", ghEcosystem: "rust", name: "agave-validator", version: p.agave.version },
  ];
}

export async function advisories(net, p) {
  const found = [];
  const add = (a) => {
    if (!found.some((f) => f.id === a.id && f.tool === a.tool)) found.push(a);
  };
  const targets = advisoryTargets(p);
  const osv = await net.json("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries: targets.map((t) => ({ package: { name: t.name, ecosystem: t.ecosystem }, version: t.version })) }),
  });
  (osv.results ?? []).forEach((r, i) => {
    for (const v of r.vulns ?? []) add({ id: v.id, tool: targets[i].tool, package: targets[i].name, version: targets[i].version, url: `https://osv.dev/vulnerability/${v.id}` });
  });
  for (const t of targets) {
    const list = await net.gh(`advisories?ecosystem=${t.ghEcosystem}&affects=${encodeURIComponent(`${t.name}@${t.version}`)}&per_page=50`).catch(() => []);
    for (const a of list) add({ id: a.ghsa_id, tool: t.tool, package: t.name, version: t.version, severity: a.severity, summary: a.summary, url: a.html_url });
  }
  // Advisories the projects publish themselves, matched against the pinned version.
  const repoChecks = [
    { tool: "agave", repo: REPOS.agave, version: p.agave.version },
    { tool: "anchor", repo: REPOS.anchor, version: p.anchor.version },
    { tool: "rust", repo: REPOS.rust, version: p.rust.version, packages: ["std", "rustc", "rust", "cargo"] },
    { tool: "rustup", repo: REPOS.rustup, version: p.rust.rustup },
  ];
  for (const c of repoChecks) {
    const list = await net.gh(`repos/${c.repo}/security-advisories?state=published&per_page=100`).catch(() => []);
    for (const a of list) {
      const hit = (a.vulnerabilities ?? []).some((v) => (!c.packages || c.packages.includes(String(v.package?.name ?? "").toLowerCase())) && rangeAffects(v.vulnerable_version_range, c.version));
      if (hit) add({ id: a.ghsa_id, tool: c.tool, package: c.repo, version: c.version, severity: a.severity, summary: a.summary, url: a.html_url });
    }
  }
  return found;
}

// ---- the plan ----

export async function plan(net, current, { anchorLine = "patch", rust = "stable", hash = true } = {}) {
  const notes = [];
  const next = structuredClone(pinsOf(current));
  // Anchor: the newest candidate with a Linux binary and a verifiable-build image.
  const anchorTags = await tagsOf(net, REPOS.anchor);
  const newestAnchor = newest(anchorTags.filter(isStable).map((t) => parseVersion(t).text));
  let anchor = null;
  for (const v of anchorCandidates(anchorTags, current.anchor.version, anchorLine)) {
    if (v === current.anchor.version) {
      anchor = { version: v, keep: true };
      break;
    }
    const make = parseAnchorMakefile(await net.text(`https://raw.githubusercontent.com/${REPOS.anchor}/v${v}/docker/Makefile`).catch(() => ""));
    const bin = `https://github.com/${REPOS.anchor}/releases/download/v${v}/anchor-${v}-x86_64-unknown-linux-gnu`;
    if (!(await net.exists(bin))) {
      notes.push(`Anchor ${v} is released but has no x86_64 Linux binary; not adopted.`);
      continue;
    }
    // The image the release's own Makefile names, else the registries Anchor has published to.
    const images = [...new Set([make.image, "quay.io/ottersec/anchor", "solanafoundation/anchor"].filter(Boolean))];
    let image = null;
    for (const name of images) {
      const digest = await net.imageDigest(name, `v${v}`);
      if (digest) {
        image = `${name}:v${v}@${digest}`;
        break;
      }
    }
    if (!image) {
      notes.push(`Anchor ${v} is released but no verifiable-build image is published for it (looked in ${images.join(", ")}); not adopted.`);
      continue;
    }
    const commit = (await net.gh(`repos/${REPOS.anchor}/commits/v${v}`)).sha;
    anchor = { version: v, bin, image, commit, solana: make.solana };
    break;
  }
  if (anchor && !anchor.keep) {
    const sha = hash ? await net.sha256(anchor.bin) : current.anchor.sha256;
    if (!sha) throw new Error(`Anchor ${anchor.version}'s binary vanished while hashing`);
    next.anchor = { version: anchor.version, sha256: sha, commit: anchor.commit };
    next.anchorImage = anchor.image;
  } else {
    // The pinned image's tag may have been re-pushed: say so, never follow it silently.
    const [ref, digest] = current.anchorImage.split("@");
    const name = ref.slice(0, ref.lastIndexOf(":"));
    const live = await net.imageDigest(name, ref.slice(ref.lastIndexOf(":") + 1)).catch(() => null);
    if (live && live !== digest) notes.push(`The tag ${ref} now points at ${live}, not the pinned ${digest}; Mynt keeps the pinned digest.`);
  }
  if (newestAnchor && compare(newestAnchor, next.anchor.version) > 0 && !sameLine(newestAnchor, next.anchor.version))
    notes.push(
      `Anchor ${newestAnchor} is the newest release: a breaking upgrade from ${next.anchor.version}, not applied by the weekly run. Run this workflow with anchor_line "latest" for a pull request that adopts it (the template program and its tests will need migrating; see the solana-dev skill's migrating guide).`,
    );

  // Agave: the line the chosen Anchor's image is built with.
  const agaveTags = await tagsOf(net, REPOS.agave);
  let target = anchor?.solana ?? null;
  if (!target) {
    const make = parseAnchorMakefile(await net.text(`https://raw.githubusercontent.com/${REPOS.anchor}/v${next.anchor.version}/docker/Makefile`).catch(() => ""));
    target = make.solana ?? current.agave.version;
  }
  if (compare(target, current.agave.version) < 0 && sameLine(target, current.agave.version)) target = current.agave.version;
  const agave = pickAgave(agaveTags, target);
  const newestAgave = newest(agaveTags.filter(isStable).map((t) => parseVersion(t).text));
  if (agave && agave !== current.agave.version) {
    const url = `https://github.com/${REPOS.agave}/releases/download/v${agave}/solana-release-x86_64-unknown-linux-gnu.tar.bz2`;
    const sha = hash ? await net.sha256(url) : current.agave.sha256;
    if (sha) next.agave = { version: agave, sha256: sha };
    else notes.push(`Agave ${agave} has no x86_64 Linux release archive; kept ${current.agave.version}.`);
  }
  if (newestAgave && compare(newestAgave, next.agave.version) > 0)
    notes.push(`Agave ${newestAgave} is the newest stable release; Mynt follows the line Anchor ${next.anchor.version} is built with (${parseVersion(target).major}.${parseVersion(target).minor}).`);

  // Rust and rustup.
  if (rust === "stable") {
    const version = rustStable(await net.text("https://static.rust-lang.org/dist/channel-rust-stable.toml"));
    if (version && compare(version, current.rust.version) > 0) next.rust.version = version;
  }
  const rustup = rustupStable(await net.text("https://static.rust-lang.org/rustup/release-stable.toml"));
  if (rustup && compare(rustup, current.rust.rustup) > 0) {
    const url = `https://static.rust-lang.org/rustup/archive/${rustup}/x86_64-unknown-linux-gnu/rustup-init`;
    const sha = hash ? await net.sha256(url) : current.rust.rustupSha256;
    // rustup publishes its own checksum beside the binary: it must agree with the one computed here.
    const published = hash ? (await net.text(`${url}.sha256`)).trim().split(/\s+/)[0] : sha;
    if (sha && sha === published) next.rust = { ...next.rust, rustup, rustupSha256: sha };
    else notes.push(`rustup ${rustup}: the computed sha256 doesn't match the published one; kept ${current.rust.rustup}.`);
  }

  // The TypeScript client of the chosen Anchor line.
  const npm = await net.json(`https://registry.npmjs.org/${current.anchorTs.package.replace("/", "%2f")}`);
  const client = newest(Object.keys(npm.versions ?? {}).filter((v) => isStable(v) && sameLine(v, next.anchor.version) && compare(v, next.anchor.version) <= 0));
  if (client) next.anchorTs.version = client;
  else if (!sameLine(next.anchorTs.version, next.anchor.version))
    notes.push(`${current.anchorTs.package} has no release for Anchor ${next.anchor.version}'s line; the template's client must be migrated by hand.`);

  const changes = [];
  const link = {
    agave: (v) => `https://github.com/${REPOS.agave}/releases/tag/v${v}`,
    anchor: (v) => `https://github.com/${REPOS.anchor}/releases/tag/v${v}`,
    rust: (v) => `https://github.com/${REPOS.rust}/blob/${v}/RELEASES.md`,
    rustup: () => `https://github.com/${REPOS.rustup}/blob/master/CHANGELOG.md`,
    anchorTs: (v) => `https://www.npmjs.com/package/${current.anchorTs.package}/v/${v}`,
    anchorImage: () => `the image Anchor ${next.anchor.version} publishes for verifiable builds`,
  };
  const add = (tool, from, to, breaking) => from !== to && changes.push({ tool, from, to, breaking, notes: link[tool](to) });
  add("agave", current.agave.version, next.agave.version, isBreaking(current.agave.version, next.agave.version));
  add("anchor", current.anchor.version, next.anchor.version, isBreaking(current.anchor.version, next.anchor.version));
  add("anchorImage", current.anchorImage, next.anchorImage, false);
  add("rust", current.rust.version, next.rust.version, false);
  add("rustup", current.rust.rustup, next.rust.rustup, false);
  add("anchorTs", current.anchorTs.version, next.anchorTs.version, isBreaking(current.anchorTs.version, next.anchorTs.version));
  return { current: pinsOf(current), next, changes, notes };
}

// ---- writing the pins everywhere they appear ----

export function applyPins(root, current, next) {
  const pinsPath = join(root, PATHS.pins);
  const pins = JSON.parse(readFileSync(pinsPath, "utf8"));
  Object.assign(pins, pinsOf(next));
  writeFileSync(pinsPath, `${JSON.stringify(pins, null, 2)}\n`);
  const t = join(root, PATHS.template);
  const pkgPath = join(t, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const clientChanged = pkg.dependencies[next.anchorTs.package] !== next.anchorTs.version;
  pkg.dependencies[next.anchorTs.package] = next.anchorTs.version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const cargoPath = join(t, "programs", "mynt_program", "Cargo.toml");
  writeFileSync(cargoPath, readFileSync(cargoPath, "utf8").replace(/^anchor-lang = "=[^"]+"/m, `anchor-lang = "=${next.anchor.version}"`));
  const rtPath = join(t, "rust-toolchain.toml");
  writeFileSync(rtPath, readFileSync(rtPath, "utf8").replace(/^channel = "[^"]+"/m, `channel = "${next.rust.version}"`));
  return { clientChanged };
}

// The template's package-lock.json, resolved again for a new client version (no scripts run).
export function relock(root) {
  const r = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: join(root, PATHS.template), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm couldn't resolve the template's lock: ${r.stderr.slice(-500)}`);
}

// ---- the version-matched docs and the solana-dev skill ----

// Where each vendored folder comes from. `include` is matched against paths under `path` at the tag the pin names.
export const DOC_SOURCES = {
  anchor: {
    repo: REPOS.anchor,
    path: "docs/content/docs",
    pin: "anchor",
    license: "Apache-2.0",
    include: ["basics/*.mdx", "features/*.mdx", "references/*.mdx", "testing/*.mdx", "clients/*.mdx", "quickstart/local.mdx", "updates/release-notes/{major}-{minor}-*.mdx"],
    about: "The Anchor framework: program structure, accounts and constraints, PDAs, CPIs, errors, events, IDL, testing, clients, Anchor.toml, the CLI and verifiable builds.",
  },
  agave: {
    repo: REPOS.agave,
    path: "docs/src",
    pin: "agave",
    license: "Apache-2.0",
    include: [
      "cli/examples/test-validator.md",
      "cli/examples/choose-a-cluster.md",
      "cli/examples/deploy-a-program.md",
      "runtime/programs.md",
      "runtime/sysvars.md",
      "implemented-proposals/rent.md",
      "implemented-proposals/readonly-accounts.md",
      "implemented-proposals/instruction_introspection.md",
      "implemented-proposals/testing-programs.md",
      "implemented-proposals/commitment.md",
      "proposals/return-data.md",
      "proposals/log_data.md",
      "proposals/versioned-transactions.md",
      "consensus/commitments.md",
      "backwards-compatibility.md",
    ],
    about: "The Solana runtime as Agave implements it: the local test validator, sysvars, rent, read-only accounts, instruction introspection, return data, program logs, commitment levels and versioned transactions.",
  },
};

export const globMatch = (pattern, path) =>
  new RegExp(`^${pattern.split("**").map((p) => p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`).test(path);

async function subtree(net, repo, ref, path) {
  let tree = await net.gh(`repos/${repo}/git/trees/${encodeURIComponent(ref)}`);
  for (const seg of path.split("/")) {
    const entry = tree.tree.find((e) => e.path === seg && e.type === "tree");
    if (!entry) throw new Error(`${repo}@${ref} has no ${path}`);
    tree = await net.gh(`repos/${repo}/git/trees/${entry.sha}`);
  }
  const all = await net.gh(`repos/${repo}/git/trees/${tree.sha}?recursive=1`);
  return all.tree.filter((e) => e.type === "blob").map((e) => e.path);
}

// Re-vendors one docs folder at the tag its pin names: only the included files, verbatim, with the licence.
export async function vendorDocs(net, root, name, pins) {
  const src = DOC_SOURCES[name];
  const version = pins[src.pin].version;
  const v = parseVersion(version);
  const tag = `v${version}`;
  const commit = (await net.gh(`repos/${src.repo}/commits/${tag}`)).sha;
  const include = src.include.map((p) => p.replace("{major}", v.major).replace("{minor}", v.minor));
  const files = (await subtree(net, src.repo, commit, src.path)).filter((p) => include.some((g) => globMatch(g, p))).sort();
  if (!files.length) throw new Error(`${src.repo}@${tag}: no docs matched`);
  const dir = join(root, PATHS.docs, name);
  rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const out = join(dir, f);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, await net.text(`https://raw.githubusercontent.com/${src.repo}/${commit}/${src.path}/${f}`));
  }
  writeFileSync(join(dir, "LICENSE"), await net.text(`https://raw.githubusercontent.com/${src.repo}/${commit}/LICENSE`));
  const upstream = {
    repo: src.repo,
    tag,
    commit,
    path: src.path,
    url: `https://github.com/${src.repo}/tree/${commit}/${src.path}`,
    license: src.license,
    pin: src.pin,
    version,
    include: src.include,
    files,
    modified: "Verbatim: only the files listed, at the tag the pinned version names; re-vendored by scripts/solana-toolchain-watch.mjs whenever the pin moves.",
  };
  writeFileSync(join(dir, "UPSTREAM.json"), `${JSON.stringify(upstream, null, 2)}\n`);
  return upstream;
}

// The vendored solana-dev skill, brought to its upstream's latest commit: the same files as before (a file
// upstream removed is dropped and named), verbatim, with the licence.
export async function refreshSkill(net, root) {
  const dir = join(root, PATHS.skill);
  const upstream = JSON.parse(readFileSync(join(dir, "UPSTREAM.json"), "utf8"));
  const repo = await net.gh(`repos/${upstream.repo}`);
  const commit = (await net.gh(`repos/${upstream.repo}/commits/${repo.default_branch}`)).sha;
  if (commit === upstream.commit) return { changed: false, commit, dropped: [] };
  const base = dirname(upstream.path);
  const dropped = [];
  const kept = [];
  for (const f of upstream.files) {
    const res = await net.get(`https://raw.githubusercontent.com/${upstream.repo}/${commit}/${base}/${f}`);
    if (res.status === 404) {
      dropped.push(f);
      rmSync(join(dir, f), { force: true });
      continue;
    }
    if (!res.ok) throw new Error(`${upstream.repo}/${f}: ${res.status}`);
    writeFileSync(join(dir, f), await res.text());
    kept.push(f);
  }
  writeFileSync(join(dir, "LICENSE"), await net.text(`https://raw.githubusercontent.com/${upstream.repo}/${commit}/LICENSE`));
  const license = (await net.gh(`repos/${upstream.repo}/license`).catch(() => null))?.license?.spdx_id;
  Object.assign(upstream, { commit, url: `https://github.com/${upstream.repo}/blob/${commit}/${upstream.path}`, files: kept, ...(license && license !== "NOASSERTION" ? { license } : {}) });
  writeFileSync(join(dir, "UPSTREAM.json"), `${JSON.stringify(upstream, null, 2)}\n`);
  return { changed: true, commit, dropped };
}

// The index agents read first: which versions are pinned and where their docs are.
export function docsIndex(pins, sources) {
  const p = pinsOf(pins);
  const row = (name) => {
    const s = sources[name];
    return `- \`${name}/\`: ${DOC_SOURCES[name].about} From [${s.repo}](https://github.com/${s.repo}) at \`${s.tag}\` (${s.commit.slice(0, 12)}), ${s.license}; see \`${name}/UPSTREAM.json\`.`;
  };
  return `# Solana docs for Mynt's pinned toolchain

Generated by \`scripts/solana-toolchain-watch.mjs\` from \`schemas/solana-toolchain.json\`; don't edit by hand.

Mynt builds and tests Solana programs with exactly these versions. Read these docs, not newer ones on the web:
APIs and defaults differ between releases.

| Tool | Pinned |
|---|---|
| Agave (\`solana\`, \`solana-test-validator\`, \`cargo build-sbf\`) | ${p.agave.version} |
| Anchor CLI and \`anchor-lang\` | ${p.anchor.version} |
| \`${p.anchorTs.package}\` | ${p.anchorTs.version} |
| Rust | ${p.rust.version} |
| Verifiable-build image | \`${p.anchorImage.split("@")[0]}\` |

${Object.keys(DOC_SOURCES).map(row).join("\n")}

Start with \`anchor/basics/program-structure.mdx\`, \`anchor/references/account-constraints.mdx\`, \`anchor/basics/pda.mdx\`,
\`anchor/basics/cpi.mdx\`, \`anchor/features/events.mdx\` and \`anchor/features/errors.mdx\`; for tests,
\`agave/cli/examples/test-validator.md\` and \`anchor/references/anchor-toml.mdx\`.
`;
}

// ---- the pull request ----

export function renderPr({ changes, notes, advisoriesBefore = [], advisoriesAfter = [], docs = [], skill = null, diffstat = "" }) {
  const breaking = changes.filter((c) => c.breaking);
  const fixed = advisoriesBefore.filter((a) => !advisoriesAfter.some((b) => b.id === a.id && b.tool === a.tool));
  const urgent = advisoriesBefore.length > 0;
  const summary = changes.filter((c) => c.tool !== "anchorImage").map((c) => `${c.tool === "anchorTs" ? "@coral-xyz/anchor" : c.tool} ${c.to}`);
  const title = `${urgent ? "URGENT (security advisory): " : ""}${breaking.length ? "BREAKING: " : ""}Solana toolchain: ${summary.join(", ") || "docs and skill refresh"}`;
  const lines = ["Weekly Solana toolchain update, opened by `scripts/solana-toolchain-watch.mjs`. It is never merged automatically: CI's `solana-program` job builds and tests the template program with these pins, and a person merges it once that is green.", ""];
  if (urgent) {
    lines.push("## Security advisories affecting the pinned toolchain", "");
    for (const a of advisoriesBefore) lines.push(`- **${a.id}** (${a.package} ${a.version}${a.severity ? `, ${a.severity}` : ""}): ${a.summary ?? ""} ${a.url}${fixed.includes(a) ? " (fixed by this update)" : " (**still affects the proposed versions**)"}`);
    lines.push("");
  }
  if (advisoriesAfter.length && !urgent) {
    lines.push("## Advisories affecting the proposed versions", "", ...advisoriesAfter.map((a) => `- **${a.id}** (${a.package} ${a.version}): ${a.summary ?? ""} ${a.url}`), "");
  }
  if (changes.length) {
    lines.push("## Changes", "", "| Tool | From | To | Release notes |", "|---|---|---|---|");
    for (const c of changes) lines.push(`| ${c.tool}${c.breaking ? " **(breaking)**" : ""} | \`${c.from}\` | \`${c.to}\` | ${c.notes} |`);
    lines.push("");
  }
  if (breaking.length)
    lines.push(
      "## Breaking changes",
      "",
      ...breaking.map((c) => `- ${c.tool} moves from ${c.from} to ${c.to}, a new ${parseVersion(c.from).major !== parseVersion(c.to).major ? "major" : "minor"} version: read its release notes; the template program, its tests and the coding agents' instructions may need changes before this can merge.`),
      "",
    );
  if (notes.length) lines.push("## Notes", "", ...notes.map((n) => `- ${n}`), "");
  if (docs.length || skill?.changed) {
    lines.push("## Docs and skill", "");
    for (const d of docs) lines.push(`- \`docs/solana/${d.name}\`: ${d.repo} at \`${d.tag}\` (${d.files} files, ${d.license}).`);
    if (skill?.changed) lines.push(`- \`solana-dev\` skill: solana-foundation/solana-dev-skill at ${skill.commit.slice(0, 12)}${skill.dropped.length ? `; upstream removed ${skill.dropped.join(", ")}` : ""}.`);
    lines.push("");
  }
  if (diffstat) lines.push("## Diff", "", "```", diffstat.trim(), "```", "");
  lines.push("Checksums and the image digest were computed by the watcher from the published downloads; the toolchain installer checks every download against them again.");
  return { title, body: lines.join("\n") };
}

// ---- main ----

function args(argv) {
  const o = { apply: false, anchorLine: "patch", rust: "stable", hash: true, docsOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") o.apply = true;
    else if (a === "--no-hash") o.hash = false;
    else if (a === "--docs-only") o.docsOnly = true;
    else if (a === "--anchor-line") o.anchorLine = argv[++i];
    else if (a === "--rust") o.rust = argv[++i];
    else if (a === "--body") o.body = argv[++i];
    else if (a === "--title") o.title = argv[++i];
    else if (a === "--branch-file") o.branchFile = argv[++i];
    else if (a === "--diffstat") o.diffstat = argv[++i];
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!["patch", "latest"].includes(o.anchorLine) && !parseVersion(o.anchorLine)) throw new Error("--anchor-line is patch, latest or a version");
  if (!["stable", "pinned"].includes(o.rust)) throw new Error("--rust is stable or pinned");
  return o;
}

export async function main(argv = process.argv.slice(2), { root = ROOT, net = httpClient() } = {}) {
  const o = args(argv);
  const current = JSON.parse(readFileSync(join(root, PATHS.pins), "utf8"));
  if (o.docsOnly) {
    const sources = {};
    for (const name of Object.keys(DOC_SOURCES)) sources[name] = await vendorDocs(net, root, name, current);
    writeFileSync(join(root, PATHS.docs, "README.md"), docsIndex(current, sources));
    return { docs: Object.values(sources).map((s) => `${s.repo}@${s.tag}: ${s.files.length} files`) };
  }
  const p = await plan(net, current, { anchorLine: o.anchorLine, rust: o.rust, hash: o.hash });
  const advisoriesBefore = await advisories(net, p.current);
  const advisoriesAfter = p.changes.length ? await advisories(net, p.next) : advisoriesBefore;
  let docs = [];
  let skill = null;
  if (o.apply) {
    const { clientChanged } = applyPins(root, p.current, p.next);
    if (clientChanged) relock(root);
    const sources = {};
    for (const name of Object.keys(DOC_SOURCES)) {
      const before = JSON.parse(readFileSync(join(root, PATHS.docs, name, "UPSTREAM.json"), "utf8"));
      sources[name] = before.version === p.next[DOC_SOURCES[name].pin].version ? before : await vendorDocs(net, root, name, p.next);
      if (sources[name] !== before) docs.push({ name, repo: sources[name].repo, tag: sources[name].tag, files: sources[name].files.length, license: sources[name].license });
    }
    writeFileSync(join(root, PATHS.docs, "README.md"), docsIndex(p.next, sources));
    skill = await refreshSkill(net, root);
  }
  const pr = renderPr({ ...p, advisoriesBefore, advisoriesAfter, docs, skill, diffstat: o.diffstat && existsSync(o.diffstat) ? readFileSync(o.diffstat, "utf8") : "" });
  if (o.title) writeFileSync(o.title, pr.title);
  if (o.body) writeFileSync(o.body, pr.body);
  if (o.branchFile) writeFileSync(o.branchFile, `solana-toolchain/${pinsSha256(p.next).slice(0, 12)}${skill?.changed ? `-skill-${skill.commit.slice(0, 7)}` : ""}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `# ${pr.title}\n\n${pr.body}\n`);
  return { title: pr.title, changes: p.changes, notes: p.notes, advisories: { pinned: advisoriesBefore, proposed: advisoriesAfter }, urgentWithoutFix: advisoriesBefore.length > 0 && p.changes.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      // An advisory on the pinned toolchain with nothing to update to: fail, so the run is noticed.
      if (r.urgentWithoutFix) process.exit(2);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
