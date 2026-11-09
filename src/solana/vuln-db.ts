import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Mynt's Solana vulnerability database (schemas/solana-vulnerabilities.json): one entry per vulnerability class,
// each with how it's detected, public references, and a bad and a good fixture its tests run. Entries with
// machine-run detections drive the mainnet program gate's hard rules (program-rules.ts); the whole database is the
// audit and red-team agents' checklist. It changes only by a reviewed pull request: admins' proposals are stored
// for that review, never merged by Mynt itself. A new version re-checks every deployed mainnet program.

export const VULN_DB_PATH = fileURLToPath(new URL("../../schemas/solana-vulnerabilities.json", import.meta.url));

export const VULN_CATEGORIES = ["rug_pull", "access_control", "account_validation", "cpi", "signatures", "arithmetic", "economic", "resource", "dependencies"] as const;
export const VULN_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const DETECTION_TYPES = ["source_pattern", "idl_shape", "bytecode_program_ref", "dependency_advisory", "red_team_scenario"] as const;
// Detections whose logic is code, named by the entries that use them.
export const SOURCE_BUILTINS = [
  "hardcoded_admin",
  "authority_to_non_signer",
  "close_to_non_signer",
  "authority_not_signer",
  "missing_has_one",
  "duplicate_mutable",
  "unchecked_program_account",
  "signed_cpi_to_unchecked_program",
  "no_reload_after_cpi",
  "swap_without_bounds",
  "unbounded_account_vec",
] as const;
export const IDL_BUILTINS = ["token_program_account", "pinned_signer"] as const;

export type Detection =
  | { type: "source_pattern"; builtin: (typeof SOURCE_BUILTINS)[number] }
  | { type: "source_pattern"; pattern: string; flags?: string; unless?: string; files?: string; message: string }
  | { type: "source_pattern"; absent: string; files: string; message: string }
  | { type: "idl_shape"; builtin: (typeof IDL_BUILTINS)[number] }
  | { type: "bytecode_program_ref"; program_ids: string[]; message?: string }
  | { type: "dependency_advisory"; tool: string; database: string }
  | { type: "red_team_scenario"; scenario: string };

export interface VulnEntry {
  id: string;
  title: string;
  severity: (typeof VULN_SEVERITIES)[number];
  category: (typeof VULN_CATEGORIES)[number];
  gate: "block" | "flag";
  description: string;
  detection: Detection[];
  references: { title: string; url: string }[];
  fixtures: { bad: string; good: string };
  also_covers?: string[];
}

export interface VulnDb {
  version: number;
  updated: string;
  description?: string;
  entries: VulnEntry[];
}

const ID = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/;

// Every problem with one entry (an empty list when it's sound). `known` are the ids already taken.
export function entryProblems(e: unknown, known: Set<string> = new Set()): string[] {
  const p: string[] = [];
  const x = e as Partial<VulnEntry> | null;
  if (!x || typeof x !== "object") return ["an entry must be an object"];
  if (typeof x.id !== "string" || !ID.test(x.id)) p.push("id: upper-case words joined by hyphens, e.g. AC-MISSING-SIGNER");
  else if (known.has(x.id)) p.push(`id: ${x.id} is already in the database`);
  if (typeof x.title !== "string" || x.title.length < 5) p.push("title is required");
  if (!VULN_SEVERITIES.includes(x.severity as never)) p.push(`severity: one of ${VULN_SEVERITIES.join(", ")}`);
  if (!VULN_CATEGORIES.includes(x.category as never)) p.push(`category: one of ${VULN_CATEGORIES.join(", ")}`);
  if (x.gate !== "block" && x.gate !== "flag") p.push("gate: block (refuses a program) or flag (a lead for the auditor)");
  if (typeof x.description !== "string" || x.description.length < 20) p.push("description is required");
  if (!Array.isArray(x.detection) || !x.detection.length) p.push("detection: at least one");
  for (const [i, d] of (Array.isArray(x.detection) ? x.detection : []).entries()) {
    const at = `detection[${i}]`;
    const dd = d as Record<string, unknown>;
    if (!DETECTION_TYPES.includes(dd?.type as never)) {
      p.push(`${at}.type: one of ${DETECTION_TYPES.join(", ")}`);
      continue;
    }
    const regex = (k: string) => {
      if (dd[k] === undefined) return;
      try {
        new RegExp(String(dd[k]), typeof dd.flags === "string" ? dd.flags : "");
      } catch (err) {
        p.push(`${at}.${k}: not a valid regular expression (${(err as Error).message})`);
      }
    };
    if (dd.type === "source_pattern") {
      if (dd.builtin !== undefined) {
        if (!SOURCE_BUILTINS.includes(dd.builtin as never)) p.push(`${at}.builtin: one of ${SOURCE_BUILTINS.join(", ")}`);
      } else if (typeof dd.pattern === "string" || typeof dd.absent === "string") {
        regex("pattern");
        regex("absent");
        regex("unless");
        regex("files");
        if (typeof dd.message !== "string") p.push(`${at}.message is required`);
        if (typeof dd.absent === "string" && typeof dd.files !== "string") p.push(`${at}: an absent pattern needs files`);
      } else p.push(`${at}: a source_pattern needs a pattern, an absent pattern or a builtin`);
    }
    if (dd.type === "idl_shape" && !IDL_BUILTINS.includes(dd.builtin as never)) p.push(`${at}.builtin: one of ${IDL_BUILTINS.join(", ")}`);
    if (dd.type === "bytecode_program_ref" && !(Array.isArray(dd.program_ids) && dd.program_ids.length && dd.program_ids.every((s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s))))
      p.push(`${at}.program_ids: Solana addresses`);
    if (dd.type === "dependency_advisory" && typeof dd.tool !== "string") p.push(`${at}.tool is required`);
    if (dd.type === "red_team_scenario" && typeof dd.scenario !== "string") p.push(`${at}.scenario is required`);
  }
  if (!Array.isArray(x.references) || !x.references.length || !x.references.every((r) => r && typeof r.title === "string" && /^https:\/\//.test(String(r.url))))
    p.push("references: at least one, each with a title and an https url");
  if (!x.fixtures || typeof x.fixtures.bad !== "string" || typeof x.fixtures.good !== "string") p.push("fixtures: a bad and a good fixture path");
  return p;
}

export function dbProblems(db: unknown): string[] {
  const d = db as Partial<VulnDb> | null;
  if (!d || typeof d !== "object") return ["the database must be an object"];
  const p: string[] = [];
  if (!Number.isInteger(d.version) || (d.version as number) < 1) p.push("version: a positive integer");
  if (!Array.isArray(d.entries)) return [...p, "entries: a list"];
  const seen = new Set<string>();
  for (const e of d.entries) {
    p.push(...entryProblems(e, seen).map((x) => `${(e as VulnEntry)?.id ?? "?"}: ${x}`));
    if (typeof (e as VulnEntry)?.id === "string") seen.add((e as VulnEntry).id);
  }
  return p;
}

let cached: VulnDb | null = null;
export function loadVulnDb(path = VULN_DB_PATH): VulnDb {
  if (path === VULN_DB_PATH && cached) return cached;
  const db = JSON.parse(readFileSync(path, "utf8")) as VulnDb;
  const problems = dbProblems(db);
  if (problems.length) throw new Error(`The vulnerability database is invalid: ${problems.slice(0, 5).join("; ")}`);
  if (path === VULN_DB_PATH) cached = db;
  return db;
}

// The database as the agents get it: every entry, with what Mynt already checks itself marked.
export function agentChecklist(db: VulnDb) {
  return {
    version: db.version,
    how_to_use:
      "Go through every entry. For each, decide whether the program has it, using the description, the detections (patterns Mynt already ran show where to look; red_team_scenario says how to attack it) and the references. Report what you find with the entry's id.",
    entries: db.entries.map(({ fixtures: _f, ...e }) => e),
  };
}

// ---- suggestions from new advisories (scripts/vuln-db-suggest.mjs) ----

export interface Advisory {
  id: string; // RUSTSEC-YYYY-NNNN (or an OSV id with a RUSTSEC alias)
  aliases?: string[];
  summary?: string;
  details?: string;
  published?: string;
  affected?: { package?: { name?: string; ecosystem?: string } }[];
  references?: { url?: string }[];
}

// Solana and Anchor crates, and the crypto and serialization crates programs build on.
export const WATCHED_CRATES = [
  "anchor-lang",
  "anchor-spl",
  "anchor-syn",
  "anchor-attribute-account",
  "solana-program",
  "solana-sdk",
  "solana-zk-token-sdk",
  "solana-zk-sdk",
  "spl-token",
  "spl-token-2022",
  "spl-associated-token-account",
  "spl-token-metadata-interface",
  "borsh",
  "bytemuck",
  "curve25519-dalek",
  "ed25519-dalek",
  "libsecp256k1",
  "pinocchio",
] as const;

// Entries for review: one per new RustSec advisory against a watched crate that the database doesn't mention yet.
export function suggestFromAdvisories(advisories: Advisory[], db: VulnDb, opts: { since?: string } = {}) {
  const mentioned = JSON.stringify(db.entries);
  const out: (VulnEntry & { suggested_from: string })[] = [];
  for (const a of advisories) {
    const rustsec = [a.id, ...(a.aliases ?? [])].find((x) => /^RUSTSEC-\d{4}-\d{4}$/.test(x));
    if (!rustsec || mentioned.includes(rustsec) || out.some((e) => e.suggested_from === rustsec)) continue;
    if (opts.since && a.published && a.published.slice(0, 10) < opts.since) continue;
    const crates = (a.affected ?? []).map((x) => x.package?.name).filter((n): n is string => !!n && (WATCHED_CRATES as readonly string[]).includes(n));
    if (!crates.length) continue;
    out.push({
      id: `DEP-${rustsec}`,
      title: `${crates.join(", ")}: ${a.summary ?? rustsec}`.slice(0, 200),
      severity: "high",
      category: "dependencies",
      gate: "block",
      description: `RustSec advisory ${rustsec} against ${crates.join(", ")}: ${(a.summary ?? a.details ?? "").slice(0, 600)}. cargo-audit already blocks a program whose Cargo.lock has it; an entry records the class, and its fixtures, for reviewers and the agents.`,
      detection: [{ type: "dependency_advisory", tool: "cargo-audit", database: "https://rustsec.org/" }],
      references: [{ title: `RustSec: ${rustsec}`, url: `https://rustsec.org/advisories/${rustsec}.html` }],
      fixtures: { bad: `test/fixtures/solana-vulns/DEP-${rustsec}/bad`, good: `test/fixtures/solana-vulns/DEP-${rustsec}/good` },
      suggested_from: rustsec,
    });
  }
  return out;
}
