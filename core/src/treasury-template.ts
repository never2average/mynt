import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "./solana/codec.js";

// Mynt's treasury template (workspaces/coding-build/templates/solana-treasury) at another program id: the same
// source with its declared id swapped for that one, everywhere it's written (the program's declare_id!, Anchor.toml
// and the extension probe's reference to the treasury). Mynt rebuilds this with its verifiable build script to know
// what the template compiles to at a pool's own address, so a deployed treasury can be checked byte for byte.

export const TREASURY_TEMPLATE_DIR = fileURLToPath(new URL("../workspaces/coding-build/templates/solana-treasury/", import.meta.url));
export const TREASURY_MANIFEST_PATH = fileURLToPath(new URL("../schemas/solana-treasury-template.json", import.meta.url));

export interface TreasuryManifest {
  declared_id: string;
  program: string;
  program_sha256: string;
  cargo_lock_sha256: string;
  deposit_approval?: "MYNTDEP2" | "MYNTDEP3";
  earlier_builds?: { program_sha256: string; deposit_approval: "MYNTDEP2" | "MYNTDEP3" }[];
}
export const readTreasuryManifest = (path = TREASURY_MANIFEST_PATH) => JSON.parse(readFileSync(path, "utf8")) as TreasuryManifest;

// Never part of the build: dependencies, build output, the tests' own packages.
const SKIP = new Set(["node_modules", "target", ".anchor", ".git", "test-ledger"]);
// The files the declared id is written in, and how many times in each: a template change that adds or drops one is
// caught here rather than building something that isn't the template at that id.
const ID_SITES: Record<string, number> = {
  "Anchor.toml": 2,
  "programs/mynt_treasury/src/lib.rs": 1,
  "programs/extension_probe/src/lib.rs": 1,
};

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, root, out);
    else if (st.isFile()) out.push(relative(root, path).split("\\").join("/"));
  }
  return out;
}

// Every file of the template (paths relative to it, '/'-separated) with the declared id replaced by `programId`.
export function treasuryTemplateAt(programId: string, o: { dir?: string; manifest?: TreasuryManifest } = {}): Record<string, string> {
  if (!isAddress(programId)) throw new Error("programId must be a Solana address");
  const dir = o.dir ?? TREASURY_TEMPLATE_DIR;
  const manifest = o.manifest ?? readTreasuryManifest();
  const from = manifest.declared_id;
  const files: Record<string, string> = {};
  for (const path of walk(dir)) {
    const text = readFileSync(join(dir, path), "utf8");
    const count = text.split(from).length - 1;
    const expected = ID_SITES[path] ?? 0;
    if (count !== expected) throw new Error(`The treasury template writes its program id ${count} time(s) in ${path}, not ${expected}: update ID_SITES (src/treasury-template.ts) after checking the template`);
    files[path] = count ? text.split(from).join(programId) : text;
  }
  for (const path of Object.keys(ID_SITES)) if (!(path in files)) throw new Error(`The treasury template has no ${path}`);
  return files;
}

// What Mynt's build script wrote for the template at `programId` (its programs.json and checks.jsonl): the program's
// hash when the build passed, at that declared id, from the recorded Cargo.lock; otherwise why not.
export function readTemplateBuild(programsJson: string | null, checksJsonl: string | null, programId: string, manifest: TreasuryManifest): { sha256: string; cargo_lock_sha256: string } | { error: string } {
  const check = (checksJsonl ?? "")
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l) as { name?: string; status?: string; detail?: string };
      } catch {
        return null;
      }
    })
    .find((c) => c?.name === "solana_build");
  if (!check) return { error: "the build didn't finish" };
  if (check.status !== "pass") return { error: `the build failed: ${(check.detail ?? "").slice(-300)}` };
  let programs: { name?: string; sha256?: string; declared_id?: string | null; cargo_lock_sha256?: string | null }[];
  try {
    programs = JSON.parse(programsJson ?? "null");
  } catch {
    return { error: "the build's programs.json couldn't be read" };
  }
  const p = Array.isArray(programs) ? programs.find((x) => x?.name === manifest.program) : undefined;
  if (!p || typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) return { error: `the build has no ${manifest.program} program` };
  if (p.declared_id !== programId) return { error: `the build declares ${p.declared_id}, not ${programId}` };
  if (p.cargo_lock_sha256 !== manifest.cargo_lock_sha256) return { error: "the build didn't use the template's recorded Cargo.lock" };
  return { sha256: p.sha256, cargo_lock_sha256: p.cargo_lock_sha256 };
}
