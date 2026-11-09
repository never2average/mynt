import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { stripComments } from "./program-rules.js";

// What the compiler actually compiles from a captured workspace, and what in the workspace can change the build
// beyond the source Mynt reviews. The hard rules run over every file reachable from a crate root (mod, #[path],
// include!), wherever it lives (a tests/ folder or a nested target/ included), and never over files nothing
// reaches. Build-influencing configuration is listed as exceptions an admin must allow by name.

export interface Package {
  dir: string; // relative to the workspace ("" at its root)
  manifest: string;
  name: string;
  lib: string | null; // the lib target's root file, when the workspace has it
  bins: string[]; // binary targets' roots
  build: string | null; // the build script, when there is one
  procMacro: boolean;
  patch: boolean; // [patch] or [replace]: dependencies redirected
  unparsed?: string; // the manifest isn't valid TOML
}

export interface CrateTree {
  packages: Package[];
  roots: string[];
  // Every file the compiler reads as code, with its text: crate roots, modules, and include!() targets.
  code: Map<string, string>;
  includes: { from: string; line: number; macro: string; target: string | null; resolved: string | null }[];
  paths: { from: string; line: number; target: string; resolved: string }[];
  missing: { from: string; line: number; module: string }[];
  // cfg_attr(..., path = ...): which file is compiled depends on cfg; the resolver follows every candidate.
  cfgPaths: { from: string; line: number; detail: string }[];
}

const norm = (p: string) => {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
};
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (...ps: string[]) => norm(ps.filter((x) => x !== "").join("/"));
const lineOf = (t: string, i: number) => t.slice(0, i).split("\n").length;

type Toml = Record<string, unknown>;
const obj = (v: unknown): Toml | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Toml) : null);
const text = (v: unknown) => (typeof v === "string" ? v : null);

// Manifests read with a real TOML parser (smol-toml, pinned), so a dotted key (package.build = ...) or an inline
// table (lib = { path = ... }) means exactly what it means to cargo.
export function packagesOf(files: Record<string, string>): Package[] {
  const out: Package[] = [];
  for (const [path, body] of Object.entries(files)) {
    if (!/(^|\/)Cargo\.toml$/.test(path)) continue;
    const dir = dirOf(path);
    let m: Toml;
    try {
      m = parseToml(body) as Toml;
    } catch (e) {
      out.push({ dir, manifest: path, name: "(unreadable)", lib: null, bins: [], build: null, procMacro: false, patch: false, unparsed: (e as Error).message.slice(0, 200) });
      continue;
    }
    const pkg = obj(m.package);
    const patch = !!(obj(m.patch) || obj(m.replace));
    if (!pkg) {
      if (patch) out.push({ dir, manifest: path, name: "(workspace)", lib: null, bins: [], build: null, procMacro: false, patch });
      continue;
    }
    const lib = obj(m.lib);
    const libPath = join(dir, text(lib?.path) ?? "src/lib.rs");
    const b = pkg.build;
    const build = b === false ? null : text(b) ? join(dir, text(b)!) : b === true || files[join(dir, "build.rs")] !== undefined ? join(dir, "build.rs") : null;
    const bins = [
      ...(Array.isArray(m.bin) ? (m.bin as unknown[]).map((x) => obj(x)).filter((x): x is Toml => !!x).map((x) => join(dir, text(x.path) ?? `src/bin/${text(x.name) ?? ""}.rs`)) : []),
      ...(pkg.autobins === false ? [] : Object.keys(files).filter((f) => f === join(dir, "src/main.rs") || (dirOf(f) === join(dir, "src/bin") && f.endsWith(".rs")))),
    ].filter((f, i, all) => files[f] !== undefined && all.indexOf(f) === i);
    out.push({
      dir,
      manifest: path,
      name: text(pkg.name) ?? dir,
      lib: files[libPath] !== undefined ? libPath : null,
      bins,
      build,
      procMacro: lib?.["proc-macro"] === true || lib?.proc_macro === true,
      patch,
    });
  }
  return out.sort((a, b) => a.manifest.localeCompare(b.manifest));
}

// Every file reachable from the crate roots. With no package in the workspace (a bare fixture), every src/lib.rs
// is a root; with none of those either, every .rs file.
export function resolveCrateTree(files: Record<string, string>): CrateTree {
  const packages = packagesOf(files);
  let roots = [...new Set(packages.flatMap((p) => [p.lib, p.build, ...p.bins].filter((x): x is string => !!x)))];
  if (!packages.some((p) => !p.name.startsWith("("))) {
    roots = Object.keys(files).filter((p) => /(^|\/)src\/lib\.rs$/.test(p));
    if (!roots.length) roots = Object.keys(files).filter((p) => p.endsWith(".rs"));
  }
  return { ...resolveCrateTreeFrom(files, roots), packages };
}

function resolveCrateTreeFrom(files: Record<string, string>, roots: string[]): CrateTree {
  const packages: Package[] = [];
  const tree: CrateTree = { packages, roots, code: new Map(), includes: [], paths: [], missing: [], cfgPaths: [] };
  const visit = (file: string, childDir: string, pathBase: string) => {
    if (tree.code.has(file) || files[file] === undefined) return;
    const body = files[file];
    tree.code.set(file, body);
    const code = stripComments(body);
    for (const m of code.matchAll(/#\s*!?\s*\[\s*cfg_attr\s*\(([^\]]*)\]/g))
      if (/\bpath\s*=/.test(m[1]) && !tree.cfgPaths.some((c) => c.from === file && c.line === lineOf(code, m.index!)))
        tree.cfgPaths.push({ from: file, line: lineOf(code, m.index!), detail: m[0].replace(/\s+/g, " ").slice(0, 200) });
    region(file, code, 0, childDir, pathBase);
  };
  // One region of a file (the whole file, or an inline module's body): its mod declarations and includes.
  const region = (file: string, code: string, offset: number, childDir: string, pathBase: string) => {
    const re = /((?:#\s*\[[^\]]*\]\s*)*)(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(?:r#)?(\w+)\s*([;{])|\b(include|include_str|include_bytes)\s*!\s*\(\s*("([^"]*)")?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const line = lineOf(code, m.index);
      if (m[4]) {
        const target = m[5] ? m[6] : null;
        const resolved = target !== null ? join(dirOf(file), target) : null;
        tree.includes.push({ from: file, line, macro: m[4], target, resolved });
        // include!() is code; include_str!/include_bytes! are data.
        if (m[4] === "include" && resolved) visit(resolved, childDir, pathBase);
        continue;
      }
      const attrs = m[1] ?? "";
      const name = m[2];
      // A path chosen by cfg_attr: rustc picks it, or not, by cfg. Every candidate is followed, and it's an exception.
      const conditional = /\bcfg_attr\s*\(/.test(attrs) && /\bpath\s*=/.test(attrs);
      if (conditional) tree.cfgPaths.push({ from: file, line, detail: attrs.replace(/\s+/g, " ").trim().slice(0, 200) + ` mod ${name}` });
      const pathAttr = /\bpath\s*=\s*"([^"]+)"/.exec(attrs);
      if (m[3] === "{") {
        const open = m.index + m[0].length - 1;
        let depth = 0;
        let end = open;
        for (let i = open; i < code.length; i++) {
          if (code[i] === '"') {
            i++;
            while (i < code.length && code[i] !== '"') i += code[i] === "\\" ? 2 : 1;
            continue;
          }
          if (code[i] === "{") depth++;
          else if (code[i] === "}" && --depth === 0) {
            end = i;
            break;
          }
        }
        const dir = pathAttr ? join(pathBase, pathAttr[1]) : join(childDir, name);
        region(file, code.slice(open + 1, end), offset + open + 1, dir, dir);
        re.lastIndex = end + 1;
        continue;
      }
      if (pathAttr) {
        const resolved = join(pathBase, pathAttr[1]);
        tree.paths.push({ from: file, line, target: pathAttr[1], resolved });
        // A #[path] file behaves like a mod.rs: its own modules sit beside it.
        if (files[resolved] !== undefined) visit(resolved, dirOf(resolved), dirOf(resolved));
        else tree.missing.push({ from: file, line, module: `${name} (#[path = "${pathAttr[1]}"])` });
        if (!conditional) continue;
      }
      const flat = join(childDir, `${name}.rs`);
      const nested = join(childDir, name, "mod.rs");
      if (files[flat] !== undefined) visit(flat, join(childDir, name), childDir);
      else if (files[nested] !== undefined) visit(nested, join(childDir, name), join(childDir, name));
      else tree.missing.push({ from: file, line, module: name });
    }
  };
  for (const r of roots) {
    const base = r.split("/").pop()!;
    const dir = dirOf(r);
    // lib.rs, main.rs, mod.rs and build scripts keep their modules beside them; foo.rs keeps them in foo/.
    visit(r, /^(lib|main|mod|build)\.rs$/.test(base) ? dir : join(dir, base.replace(/\.rs$/, "")), dir);
  }
  return tree;
}

// ---- what in a workspace can change the build: exceptions an admin must allow, by id ----

export interface Exception {
  id: string;
  kind:
    | "cargo_config"
    | "build_script"
    | "proc_macro"
    | "non_rust_include"
    | "dynamic_include"
    | "unresolved_module"
    | "link"
    | "cargo_patch"
    | "crate"
    | "cfg_attr_path"
    | "manifest_unparsed"
    | "module_tree_mismatch"
    | "generated_code";
  detail: string;
}

// The one cargo setting a workspace may carry without an exception (the template's, which Mynt's build sets by
// environment anyway): resolving dependencies to versions the platform tools can build.
const SAFE_CARGO_CONFIG = /^(\[resolver\]|incompatible-rust-versions\s*=\s*"fallback")$/;

export function workspaceExceptions(bundle: { files: Record<string, string>; binary?: Record<string, string>; links?: Record<string, string> }, tree: CrateTree): Exception[] {
  const out: Exception[] = [];
  const all = { ...bundle.files, ...Object.fromEntries(Object.keys(bundle.binary ?? {}).map((k) => [k, ""])) };
  for (const path of Object.keys(all).sort()) {
    if (!/(^|\/)\.cargo\/config(\.toml)?$/.test(path)) continue;
    const lines = (bundle.files[path] ?? "\u0000")
      .split("\n")
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean);
    if (!lines.every((l) => SAFE_CARGO_CONFIG.test(l)))
      out.push({ id: `cargo-config:${path}`, kind: "cargo_config", detail: `${path} sets cargo configuration (wrappers, flags, sources or registries can change what's compiled): ${lines.slice(0, 6).join("; ").slice(0, 300)}` });
  }
  for (const c of tree.cfgPaths)
    out.push({ id: `cfg-attr-path:${c.from}:${c.line}`, kind: "cfg_attr_path", detail: `${c.from}:${c.line}: ${c.detail}: which file is compiled depends on cfg` });
  for (const p of tree.packages) {
    if (p.unparsed) out.push({ id: `manifest-unparsed:${p.manifest}`, kind: "manifest_unparsed", detail: `${p.manifest} isn't valid TOML (${p.unparsed})` });
    if (p.build) out.push({ id: `build-script:${p.manifest}`, kind: "build_script", detail: `${p.name} has a build script (${p.build}), which runs at build time and can generate code` });
    if (p.procMacro) out.push({ id: `proc-macro:${p.manifest}`, kind: "proc_macro", detail: `${p.name} is a procedural macro crate: it runs at build time and writes code the source doesn't show` });
    if (p.patch) out.push({ id: `cargo-patch:${p.manifest}`, kind: "cargo_patch", detail: `${p.manifest} has [patch] or [replace]: dependencies are redirected` });
  }
  for (const i of tree.includes) {
    if (i.target === null) out.push({ id: `dynamic-include:${i.from}:${i.line}`, kind: "dynamic_include", detail: `${i.from}:${i.line}: ${i.macro}! of a path that isn't a plain string, so Mynt can't tell what it compiles` });
    else if (!/\.rs$/.test(i.target) || (i.macro === "include" && bundle.files[i.resolved!] === undefined))
      out.push({ id: `non-rust-include:${i.from}:${i.line}`, kind: "non_rust_include", detail: `${i.from}:${i.line}: ${i.macro}!("${i.target}")${bundle.files[i.resolved!] === undefined ? ", a file Mynt can't read as text" : ""}` });
  }
  for (const p of tree.paths)
    if (!/\.rs$/.test(p.target)) out.push({ id: `non-rust-include:${p.from}:${p.line}`, kind: "non_rust_include", detail: `${p.from}:${p.line}: #[path = "${p.target}"] loads a module from a file that isn't .rs` });
  for (const m of tree.missing)
    out.push({ id: `unresolved-module:${m.from}:${m.line}`, kind: "unresolved_module", detail: `${m.from}:${m.line}: mod ${m.module} has no file in the workspace (generated at build time?)` });
  for (const [path, target] of Object.entries(bundle.links ?? {}))
    out.push({ id: `link:${path}`, kind: "link", detail: `${path} is a link to ${target}` });
  return out;
}

// ---- the IDL, checked against the bytes ----

// Every instruction the IDL lists must have its discriminator in the program: as 8 bytes in a row, or split across
// a 64-bit load (lddw: the low 4 bytes, then the high 4 bytes 8 bytes later), or as two 32-bit immediates. An IDL that
// names instructions the program doesn't have is refused. (Instructions the IDL leaves out can't be found this way.)
export function verifyIdl(idl: unknown, program: Uint8Array) {
  const ixs = (idl as { instructions?: { name?: string; discriminator?: number[] }[] } | null)?.instructions;
  if (!Array.isArray(ixs) || !ixs.length) return { verified: false, checked: 0, problems: ["the IDL lists no instructions"] };
  const problems: string[] = [];
  const has = (needle: Uint8Array, at?: (i: number) => boolean) => {
    for (let i = program.indexOf(needle[0]); i >= 0 && i <= program.length - needle.length; i = program.indexOf(needle[0], i + 1)) {
      let ok = true;
      for (let j = 1; j < needle.length && ok; j++) ok = program[i + j] === needle[j];
      if (ok && (!at || at(i))) return true;
    }
    return false;
  };
  const forms: Record<string, number> = { contiguous: 0, lddw: 0, halves: 0 };
  for (const ix of ixs) {
    const name = String(ix.name ?? "");
    const d =
      Array.isArray(ix.discriminator) && ix.discriminator.length === 8
        ? Uint8Array.from(ix.discriminator)
        : new Uint8Array(createHash("sha256").update(`global:${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`).digest().subarray(0, 8));
    const lo = d.subarray(0, 4);
    const hi = d.subarray(4, 8);
    if (has(d)) forms.contiguous++;
    else if (has(lo, (i) => program[i + 8] === hi[0] && program[i + 9] === hi[1] && program[i + 10] === hi[2] && program[i + 11] === hi[3])) forms.lddw++;
    else if (has(lo, (i) => i % 8 === 4) && has(hi, (i) => i % 8 === 4)) forms.halves++;
    else problems.push(`instruction ${name}: its discriminator [${[...d].join(", ")}] isn't in the program`);
  }
  return { verified: problems.length === 0, checked: ixs.length, forms, problems };
}

// An IDL as the agents get it, with the developer's free text neutralised (it could carry instructions to them): no
// doc strings, no error messages, no constant values, and names cut to 64 characters.
export function stripIdlDocs(idl: unknown, key = ""): unknown {
  if (Array.isArray(idl)) return idl.map((x) => stripIdlDocs(x, key));
  if (idl && typeof idl === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(idl)) {
      if (k === "docs") continue;
      if (key === "errors" && k === "msg") continue;
      if (key === "constants" && k === "value") {
        out[k] = "(removed by Mynt)";
        continue;
      }
      out[k] = stripIdlDocs(v, k);
    }
    return out;
  }
  if (typeof idl === "string" && key === "name" && idl.length > 64) return `${idl.slice(0, 64)}…`;
  return idl;
}

// ---- dependencies ----

const CRATES_IO = new Set(["registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"]);

export interface DependencyVerdict {
  refusals: string[]; // the review is blocked
  exceptions: Exception[]; // crates an admin must allow by name
  crates: { name: string; version: string; checksum: string | null; crate_sha256: string | null; allowlisted: boolean }[];
}

export function dependencyVerdict(
  deps: { packages: { name: string; version: string; source?: string | null; checksum?: string | null; crate_sha256?: string; allowlisted?: boolean }[]; sources: Record<string, Record<string, string>>; complete: boolean; problems: string[] } | null,
  allowlist: Set<string>,
  workspace: Package[],
): DependencyVerdict {
  const v: DependencyVerdict = { refusals: [], exceptions: [], crates: [] };
  if (!deps) {
    v.refusals.push("Mynt has no record of this build's dependencies (builds now keep one); build it again");
    return v;
  }
  if (!deps.complete) v.refusals.push(`Mynt's record of the dependencies is incomplete: ${deps.problems.slice(0, 5).join("; ") || "no packages"}`);
  const local = new Set(workspace.map((p) => p.name));
  for (const p of deps.packages) {
    const allowed = allowlist.has(p.name);
    if (!p.source) {
      if (!local.has(p.name)) v.refusals.push(`${p.name} ${p.version} is a path dependency outside the workspace Mynt captured`);
      continue;
    }
    if (p.source.startsWith("git+")) {
      v.refusals.push(`${p.name} ${p.version} comes from git (${p.source.split("#")[0]}): mainnet programs' dependencies come from crates.io only`);
      continue;
    }
    if (!CRATES_IO.has(p.source)) {
      v.refusals.push(`${p.name} ${p.version} comes from another registry (${p.source}): crates.io only`);
      continue;
    }
    if (!p.checksum || p.crate_sha256 !== p.checksum) v.refusals.push(`${p.name} ${p.version}: the crate the build used doesn't match Cargo.lock's checksum`);
    v.crates.push({ name: p.name, version: p.version, checksum: p.checksum ?? null, crate_sha256: p.crate_sha256 ?? null, allowlisted: allowed });
    if (!allowed) {
      if (!deps.sources[`${p.name}@${p.version}`]) v.refusals.push(`${p.name} ${p.version} isn't on Mynt's crate allowlist and its source wasn't captured`);
      else v.exceptions.push({ id: `crate:${p.name}@${p.version}`, kind: "crate", detail: `${p.name} ${p.version} (crates.io, sha256 ${p.crate_sha256}) isn't on Mynt's crate allowlist; the hard rules ran over its source` });
    }
  }
  return v;
}

export const discriminatorOf = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

// ---- what the compiler actually read: rustc's dep-info, from Mynt's build container ----

// What the build kept (solana-verify.sh): every dep-info file cargo wrote in the build container, the sha256 of
// every workspace file and every unpacked registry file as the container held them after the build, and the sha256
// of every file in each .crate cargo downloaded.
export interface DepInfoCapture {
  d_files: Record<string, string>;
  workdir: Record<string, string>; // path relative to /workdir -> sha256
  registry: Record<string, string>; // "<index>/<name>-<version>/<path>" -> sha256
  crate_files: Record<string, Record<string, string>>; // "<name>-<version>" -> path -> sha256
  problems?: string[];
}

// Every source path a dep-info (Makefile-style) file lists: the prerequisites of its rules, with escaped spaces.
export function parseDepInfo(d: string): string[] {
  const out = new Set<string>();
  for (const raw of d.replace(/\\\n/g, " ").split("\n")) {
    if (!raw.trim() || raw.startsWith("#")) continue;
    const colon = raw.search(/:(\s|$)/);
    if (colon < 0) continue;
    const deps = raw.slice(colon + 1);
    for (const tok of deps.match(/(?:\\ |[^\s])+/g) ?? []) out.add(tok.replace(/\\ /g, " "));
  }
  return [...out];
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const REGISTRY = /^\/root\/\.cargo\/registry\/src\/([^/]+)\/([^/]+)\/(.+)$/;

export interface CompiledFiles {
  workspace: string[]; // relative to the workspace: what the rules must read
  registry: { crate: string; path: string }[];
  generated: { path: string; package: string | null }[];
  problems: string[]; // the review is refused
}

// The authoritative list of what was compiled, checked file by file: a workspace file must be in the captured
// archive with the same contents the container compiled; a registry file must be in the .crate cargo downloaded
// for a crate of the Cargo.lock, unchanged; generated files (a build script's OUT_DIR) are listed; anything else
// is refused.
export function evaluateDepInfo(
  depinfo: DepInfoCapture | null,
  bundle: { files: Record<string, string>; binary?: Record<string, string> },
  lockCrates: Set<string>, // "<name>-<version>" of every registry package in the Cargo.lock
): CompiledFiles {
  const r: CompiledFiles = { workspace: [], registry: [], generated: [], problems: [] };
  if (!depinfo || !Object.keys(depinfo.d_files ?? {}).length) {
    r.problems.push("Mynt has no record of the files the compiler read (rustc's dep-info) for this build; build it again");
    return r;
  }
  r.problems.push(...(depinfo.problems ?? []));
  const captured = (rel: string) =>
    bundle.files[rel] !== undefined ? sha(Buffer.from(bundle.files[rel], "utf8")) : bundle.binary?.[rel] !== undefined ? sha(Buffer.from(bundle.binary[rel], "base64")) : null;
  const seen = new Set<string>();
  for (const [dfile, body] of Object.entries(depinfo.d_files)) {
    for (const raw of parseDepInfo(body)) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      // Paths are relative to the workspace (/workdir) or absolute.
      const abs = raw.startsWith("/") ? norm(raw).replace(/^/, "/") : `/workdir/${norm(raw)}`;
      if (abs.startsWith("/workdir/docker-target/")) {
        const out = /\/build\/([A-Za-z0-9_-]+?)-[0-9a-f]{16}\/out\//.exec(abs);
        r.generated.push({ path: abs.slice("/workdir/".length), package: out ? out[1] : null });
        continue;
      }
      if (abs.startsWith("/workdir/")) {
        const rel = abs.slice("/workdir/".length);
        const mine = captured(rel);
        if (mine === null) r.problems.push(`the compiler read ${rel}, which isn't in the workspace Mynt captured (in ${dfile})`);
        else if (depinfo.workdir[rel] !== mine) r.problems.push(`${rel} in the build container isn't the file Mynt captured: something rewrote it during the build`);
        r.workspace.push(rel);
        continue;
      }
      const reg = REGISTRY.exec(abs);
      if (reg) {
        const [, index, crate, path] = reg;
        if (!lockCrates.has(crate)) r.problems.push(`the compiler read ${crate}/${path}, from a crate that isn't in the Cargo.lock`);
        else if (!depinfo.crate_files[crate] || depinfo.crate_files[crate][path] === undefined) r.problems.push(`the compiler read ${crate}/${path}, which isn't in the .crate cargo downloaded`);
        else if (depinfo.registry[`${index}/${crate}/${path}`] !== depinfo.crate_files[crate][path]) r.problems.push(`${crate}/${path} in the build container isn't the file in its .crate: something rewrote it during the build`);
        r.registry.push({ crate, path });
        continue;
      }
      r.problems.push(`the compiler read ${raw}, outside the workspace and the crates.io registry cache`);
    }
  }
  r.workspace = [...new Set(r.workspace)].sort();
  return r;
}

// The module-tree resolver as a cross-check of dep-info: a disagreement is an exception an admin must name. Only
// packages the compiler built count (a crate nobody compiled has no dep-info).
export function crossCheck(tree: CrateTree, compiled: CompiledFiles): Exception[] {
  const listed = new Set(compiled.workspace);
  const roots = tree.roots.filter((r) => listed.has(r));
  const reached = new Set<string>();
  const sub = resolveFrom(tree, roots);
  for (const f of sub) reached.add(f);
  for (const i of tree.includes) if (i.resolved && reached.has(i.from)) reached.add(i.resolved);
  const out: Exception[] = [];
  for (const f of listed)
    if (!reached.has(f)) out.push({ id: `module-tree-mismatch:${f}`, kind: "module_tree_mismatch", detail: `the compiler read ${f}, which Mynt's own module resolution didn't reach` });
  for (const f of reached)
    if (!listed.has(f) && f.endsWith(".rs")) out.push({ id: `module-tree-mismatch:${f}`, kind: "module_tree_mismatch", detail: `Mynt's module resolution reached ${f}, which the compiler didn't read (cfg'd out?)` });
  for (const g of compiled.generated)
    if (g.package && tree.packages.some((p) => p.name.replace(/-/g, "_") === g.package!.replace(/-/g, "_")))
      out.push({ id: `generated:${g.path}`, kind: "generated_code", detail: `the compiler read ${g.path}, generated by ${g.package}'s build script: not in the reviewed source` });
  return out;
}

// The files the resolver reached from some roots only.
function resolveFrom(tree: CrateTree, roots: string[]) {
  const files = Object.fromEntries(tree.code);
  const sub = resolveCrateTreeFrom(files, roots);
  return [...sub.code.keys()];
}
