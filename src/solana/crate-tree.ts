import { createHash } from "node:crypto";
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
  build: string | null; // the build script, when there is one
  procMacro: boolean;
  patch: boolean; // [patch] or [replace]: dependencies redirected
}

export interface CrateTree {
  packages: Package[];
  roots: string[];
  // Every file the compiler reads as code, with its text: crate roots, modules, and include!() targets.
  code: Map<string, string>;
  includes: { from: string; line: number; macro: string; target: string | null; resolved: string | null }[];
  paths: { from: string; line: number; target: string; resolved: string }[];
  missing: { from: string; line: number; module: string }[];
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

// Enough of TOML for Cargo manifests: sections, and string, boolean and inline-table keys.
function manifest(text: string) {
  const sections = new Map<string, Map<string, string>>();
  let current = "";
  sections.set("", new Map());
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const h = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (h) {
      current = h[1].replace(/\s+/g, "");
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const kv = /^([A-Za-z0-9_.\-"]+)\s*=\s*(.+)$/.exec(line);
    if (kv) sections.get(current)!.set(kv[1].replace(/"/g, ""), kv[2].trim());
  }
  return sections;
}
const str = (v: string | undefined) => (v && /^"(.*)"$/.test(v) ? v.slice(1, -1) : v && /^'(.*)'$/.test(v) ? v.slice(1, -1) : null);

export function packagesOf(files: Record<string, string>): Package[] {
  const out: Package[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/(^|\/)Cargo\.toml$/.test(path)) continue;
    const m = manifest(text);
    const pkg = m.get("package");
    const patch = [...m.keys()].some((k) => k.startsWith("patch") || k === "replace");
    if (!pkg) {
      if (patch) out.push({ dir: dirOf(path), manifest: path, name: "(workspace)", lib: null, build: null, procMacro: false, patch });
      continue;
    }
    const dir = dirOf(path);
    const lib = m.get("lib");
    const libPath = join(dir, str(lib?.get("path")) ?? "src/lib.rs");
    const buildKey = pkg.get("build");
    const build = buildKey === "false" ? null : str(buildKey) ? join(dir, str(buildKey)!) : files[join(dir, "build.rs")] !== undefined ? join(dir, "build.rs") : null;
    out.push({
      dir,
      manifest: path,
      name: str(pkg.get("name")) ?? dir,
      lib: files[libPath] !== undefined ? libPath : null,
      build,
      procMacro: lib?.get("proc-macro") === "true" || lib?.get("proc_macro") === "true",
      patch,
    });
  }
  return out.sort((a, b) => a.manifest.localeCompare(b.manifest));
}

// Every file reachable from the crate roots. With no package in the workspace (a bare fixture), every src/lib.rs
// is a root; with none of those either, every .rs file.
export function resolveCrateTree(files: Record<string, string>): CrateTree {
  const packages = packagesOf(files);
  let roots = [...new Set(packages.flatMap((p) => [p.lib, p.build].filter((x): x is string => !!x)))];
  if (!packages.some((p) => p.name !== "(workspace)")) {
    roots = Object.keys(files).filter((p) => /(^|\/)src\/lib\.rs$/.test(p));
    if (!roots.length) roots = Object.keys(files).filter((p) => p.endsWith(".rs"));
  }
  const tree: CrateTree = { packages, roots, code: new Map(), includes: [], paths: [], missing: [] };
  const visit = (file: string, childDir: string, pathBase: string) => {
    if (tree.code.has(file) || files[file] === undefined) return;
    const text = files[file];
    tree.code.set(file, text);
    region(file, stripComments(text), 0, childDir, pathBase);
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
        continue;
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
  kind: "cargo_config" | "build_script" | "proc_macro" | "non_rust_include" | "dynamic_include" | "unresolved_module" | "link" | "cargo_patch" | "crate";
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
  for (const p of tree.packages) {
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

// An IDL as the agents get it: no doc strings (they're the developer's text, which could carry instructions).
export function stripIdlDocs(idl: unknown): unknown {
  if (Array.isArray(idl)) return idl.map(stripIdlDocs);
  if (idl && typeof idl === "object") return Object.fromEntries(Object.entries(idl).filter(([k]) => k !== "docs").map(([k, v]) => [k, stripIdlDocs(v)]));
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
