import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { workspaceFiles, WORKSPACES_ROOT } from "./agent-host.js";
import { appKinds } from "./app-kinds.js";
import type { FinancialProduct } from "./catalog.js";
import { DECISION_PURPOSES, explorationAngles } from "./explore.js";
import { OBJECTIVES, type Objective } from "./explore-score.js";
import { runProductTests } from "./product-tests.js";
import { checklist, type Subject } from "./review.js";

// The agent benchmarks' task sets: fixed, versioned JSON files (benchmarks/<agent>.v<n>.json), one per hosted agent,
// checked against schemas/benchmark-task-set.schema.json and then for what a schema can't say (a coding task's kind
// exists, a desk task's product passes Mynt's product checks, a review sample's items follow the checklist, a
// connector task names only its own prospects). The latest version of each agent's set is the one runs use.

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (opts: object) => { compile: (s: object) => AjvValidate };
const addFormats = require("ajv-formats").default as (ajv: unknown) => void;
type AjvValidate = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };

export const BENCHMARKS_DIR = fileURLToPath(new URL("../benchmarks/", import.meta.url));
export const CORE_DIR = fileURLToPath(new URL("../", import.meta.url));
export const TASK_SET_SCHEMA_PATH = fileURLToPath(new URL("../schemas/benchmark-task-set.schema.json", import.meta.url));

export const BENCHMARK_AGENTS = ["coding", "product-desk", "algorithm-explorer", "governance-review", "program-audit", "program-red-team", "connector"] as const;
export type BenchmarkAgent = (typeof BENCHMARK_AGENTS)[number];

export interface CodingTask {
  id: string;
  idea?: string;
  kind?: string;
  prompt: string;
  products: { name: string; product_line?: string; category?: string }[];
  checks: string[];
}
export interface DeskTask {
  id: string;
  idea?: string;
  product: Omit<FinancialProduct, "id">;
  terms: { inputs: Record<string, number | string | boolean>; assumptions?: Record<string, unknown> };
  goal: string;
  expect: { verdicts: string[]; min_checks?: number; min_metrics?: number };
}
export interface ExplorerTask {
  id: string;
  idea?: string;
  product: Omit<FinancialProduct, "id">;
  terms: { inputs: Record<string, number | string | boolean>; assumptions?: Record<string, unknown> };
  // The decision algorithm to improve, as it stands in the product's definition (core_algorithms).
  algorithm: { _id: string; algorithm_name: string; description: string; purpose: string; repository: string };
  baseline_dir: string; // the algorithm as pinned: a repository's files, with <repository>/model.json declaring `decide`
  angle: string;
  objective: Objective;
  constraints: { max_loss_rate_pct: number; apr_cap_pct: number; min_adverse_impact_ratio: number };
}
export interface ReviewTask {
  id: string;
  sample: "good" | "bad";
  planted?: string;
  subject_kind: Subject;
  subject: Record<string, unknown>;
  facts: Record<string, string[]>;
  regulatory: Record<string, unknown>;
  decided_by_mynt: Record<string, "met" | "not_met" | "silent">;
  expect: { flagged: boolean; not_met?: string[] };
}
export interface ProgramTask {
  id: string;
  sample: "good" | "bad";
  planted?: string;
  description?: string;
  source_dir: string;
  expect: { blocked?: boolean; file?: string; exploit_confirmed?: boolean };
}
export interface ConnectorProspect {
  key: string;
  kind: "innovator" | "developer";
  name: string;
  org?: string;
  title?: string;
  region: string;
  source: string;
  source_url?: string;
  stage?: string;
  contacts: { channel: "email"; address: string; consent: "none" | "public_business" | "referred" | "opted_in"; consent_source?: string }[];
  history?: { direction: "in" | "out"; days_ago: number; subject?: string; body: string }[];
}
export interface ConnectorTask {
  id: string;
  at: string;
  prospects: ConnectorProspect[];
  expect: {
    drafted_to?: string[];
    no_outbound_to?: string[];
    handled?: string[];
    consent?: { key: string; channel: string; consent: string }[];
    stage?: Record<string, string>;
    max_outbound?: number;
    no_intro_made?: true;
    not_shared?: { of: string; with: string }[];
  };
}
export type BenchmarkTask = CodingTask | DeskTask | ExplorerTask | ReviewTask | ProgramTask | ConnectorTask;

export interface TaskSet<T = BenchmarkTask> {
  agent: BenchmarkAgent;
  version: number;
  title: string;
  description: string;
  workspaces: string[];
  tasks: T[];
  file: string; // its file's name
  sha256: string; // of the file's bytes: what a run records, so two runs are known to have had the same tasks
}

let validator: AjvValidate | null = null;
function schemaValidator() {
  if (!validator) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    validator = (ajv as unknown as { compile: (s: object) => AjvValidate }).compile(JSON.parse(readFileSync(TASK_SET_SCHEMA_PATH, "utf8")));
  }
  return validator;
}

// Every file of a program sample's source the gate's agents would read, by path relative to it.
export function programSources(sourceDir: string, root = CORE_DIR): Record<string, string> {
  const base = join(root, sourceDir);
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!["target", "node_modules"].includes(name) && !name.startsWith(".")) walk(path);
      } else if (name.endsWith(".rs") || ["Cargo.toml", "Anchor.toml", "Cargo.lock"].includes(name)) out[relative(base, path)] = readFileSync(path, "utf8");
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

/**
 * A program sample as the gate takes it: its program's name (the folder under programs/), the address it declares,
 * and the files Mynt lays over the coding agents' starter program. Null when the folder holds no such program.
 */
export function programSample(sourceDir: string, root = CORE_DIR): { name: string; program_id: string; files: Record<string, string> } | null {
  const files = programSources(sourceDir, root);
  for (const path of Object.keys(files).sort()) {
    const name = /^programs\/([a-z][a-z0-9_]{1,40})\/src\/lib\.rs$/.exec(path)?.[1];
    const id = name ? /declare_id!\(\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"\s*\)/.exec(files[path])?.[1] : undefined;
    if (name && id) return { name, program_id: id, files };
  }
  return null;
}

// Every file of an explorer task's baseline (the repository the exploration starts from), by path relative to it.
export function baselineFiles(baselineDir: string, root = CORE_DIR): Record<string, string> {
  const base = join(root, baselineDir);
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!["node_modules", "__pycache__"].includes(name) && !name.startsWith(".")) walk(path);
      } else out[relative(base, path)] = readFileSync(path, "utf8");
    }
  };
  if (existsSync(base)) walk(base);
  return out;
}

/** What's wrong with one task-set file: its schema first, then what the schema can't say. Empty when it's sound. */
export function taskSetErrors(file: string, data: unknown): string[] {
  const validate = schemaValidator();
  if (!validate(data)) return (validate.errors ?? []).map((e) => `${file}${e.instancePath} ${e.message ?? "is invalid"}`);
  const set = data as TaskSet;
  const errors: string[] = [];
  const named = /^([a-z0-9-]+)\.v(\d+)\.json$/.exec(file);
  if (!named || named[1] !== set.agent || Number(named[2]) !== set.version) errors.push(`${file}: a task set's file is <agent>.v<version>.json, and this one says ${set.agent} v${set.version}`);
  for (const w of set.workspaces) if (!existsSync(join(WORKSPACES_ROOT, w, "CLAUDE.md"))) errors.push(`${file}: no agent workspace '${w}'`);
  const ids = set.tasks.map((t) => t.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`${file}: task '${id}' twice`);
  for (const task of set.tasks) {
    const at = `${file}: ${task.id}`;
    if (set.agent === "coding") {
      const t = task as CodingTask;
      if (t.kind && !appKinds().some((k) => k.id === t.kind)) errors.push(`${at}: '${t.kind}' isn't an app kind`);
    } else if (set.agent === "product-desk") {
      const t = task as DeskTask;
      const report = runProductTests({ id: `benchmark-${t.id}`, ...t.product } as FinancialProduct);
      for (const c of report.checks) if (c.status === "fail") errors.push(`${at}: the product fails Mynt's product checks (${c.name}: ${c.message})`);
    } else if (set.agent === "algorithm-explorer") {
      const t = task as ExplorerTask;
      const report = runProductTests({ id: `benchmark-explore-${t.id}`, ...t.product } as FinancialProduct);
      for (const c of report.checks) if (c.status === "fail") errors.push(`${at}: the product fails Mynt's product checks (${c.name}: ${c.message})`);
      if (!DECISION_PURPOSES.includes(t.algorithm.purpose)) errors.push(`${at}: '${t.algorithm.purpose}' isn't a decision algorithm's purpose`);
      if (!(OBJECTIVES as readonly string[]).includes(t.objective)) errors.push(`${at}: '${t.objective}' isn't an objective Mynt scores`);
      if (!explorationAngles().some((a) => a.id === t.angle)) errors.push(`${at}: '${t.angle}' isn't an exploration angle`);
      const files = baselineFiles(t.baseline_dir);
      let model: { decide?: unknown } | null = null;
      try {
        model = JSON.parse(files[`${t.algorithm.repository}/model.json`] ?? "") as { decide?: unknown };
      } catch {
        errors.push(`${at}: no readable ${t.algorithm.repository}/model.json under ${t.baseline_dir}`);
      }
      if (model && (typeof model.decide !== "string" || !model.decide.trim())) errors.push(`${at}: the baseline's model.json declares no decide command`);
    } else if (set.agent === "governance-review") {
      const t = task as ReviewTask;
      const list = checklist(t.subject_kind);
      const mine = list.filter((i) => i.by === "mynt").map((i) => i.id);
      const agents = list.filter((i) => i.by === "agent").map((i) => i.id);
      for (const id of mine) if (!(id in t.decided_by_mynt)) errors.push(`${at}: decided_by_mynt leaves out '${id}'`);
      for (const id of Object.keys(t.decided_by_mynt)) if (!mine.includes(id)) errors.push(`${at}: '${id}' isn't an item Mynt decides for a ${t.subject_kind}`);
      for (const id of t.expect.not_met ?? []) if (!agents.includes(id)) errors.push(`${at}: '${id}' isn't an item the agent answers for a ${t.subject_kind}`);
      if (t.sample === "bad" && !(t.expect.not_met ?? []).length) errors.push(`${at}: a bad sample names the item that must come out not met`);
      // A bad sample must be rejected because of the agent's finding, not because Mynt's own items already fail.
      if (list.some((i) => i.by === "mynt" && i.material && t.decided_by_mynt[i.id] === "not_met")) errors.push(`${at}: a material item Mynt decides is not met, so the sample's answer wouldn't depend on the agent`);
    } else if (set.agent === "program-audit" || set.agent === "program-red-team") {
      const t = task as ProgramTask;
      const sources = programSources(t.source_dir);
      if (!Object.keys(sources).some((p) => p.endsWith(".rs"))) errors.push(`${at}: no Rust source under ${t.source_dir}`);
      else if (!programSample(t.source_dir)) errors.push(`${at}: no programs/<name>/src/lib.rs that declares its address under ${t.source_dir}`);
      if (set.agent === "program-red-team" && t.sample === "bad" && !t.expect.exploit_confirmed) errors.push(`${at}: a bad sample expects an exploit Mynt confirms`);
      if (t.expect.file && !(t.expect.file in sources)) errors.push(`${at}: no file '${t.expect.file}' under ${t.source_dir}`);
      if (set.agent === "program-audit" && t.sample === "bad" && !(t.expect.blocked && t.expect.file)) errors.push(`${at}: a bad sample expects a blocking finding and names its file`);
    } else {
      const t = task as ConnectorTask;
      const keys = t.prospects.map((p) => p.key);
      for (const k of new Set(keys)) if (keys.filter((x) => x === k).length > 1) errors.push(`${at}: prospect '${k}' twice`);
      const e = t.expect;
      const used = [...(e.drafted_to ?? []), ...(e.no_outbound_to ?? []), ...(e.handled ?? []), ...(e.consent ?? []).map((c) => c.key), ...Object.keys(e.stage ?? {}), ...(e.not_shared ?? []).flatMap((s) => [s.of, s.with])];
      for (const k of new Set(used)) if (!keys.includes(k)) errors.push(`${at}: expect names '${k}', which isn't one of its prospects`);
      if (Number.isNaN(Date.parse(t.at))) errors.push(`${at}: 'at' isn't a date`);
    }
  }
  return errors;
}

function read(file: string, dir: string): TaskSet {
  const bytes = readFileSync(join(dir, file));
  const data = JSON.parse(bytes.toString("utf8")) as unknown;
  const errors = taskSetErrors(file, data);
  if (errors.length) throw new Error(`Benchmark task set ${file} is wrong: ${errors.join("; ")}`);
  const { $schema: _, ...set } = data as TaskSet & { $schema?: string };
  return { ...set, file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// Every task set in the folder. Read once: they ship with the server. A bad file is a bug in the repository, so it
// throws (the test suite reads them all).
let loaded: TaskSet[] | null = null;
export function taskSets(dir = BENCHMARKS_DIR): TaskSet[] {
  if (dir === BENCHMARKS_DIR && loaded) return loaded;
  const sets = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => read(f, dir));
  if (dir === BENCHMARKS_DIR) loaded = sets;
  return sets;
}

/** An agent's task set: the version asked for, else its latest. */
export function taskSetFor(agent: BenchmarkAgent, version?: number, dir = BENCHMARKS_DIR): TaskSet | null {
  const mine = taskSets(dir).filter((s) => s.agent === agent);
  if (version !== undefined) return mine.find((s) => s.version === version) ?? null;
  return mine.sort((a, b) => b.version - a.version)[0] ?? null;
}

/** A content hash of an agent workspace folder: every file's path and text. What "the agent's instructions" were for a run. */
export function workspaceRevision(name: string, root = WORKSPACES_ROOT): string {
  const files = workspaceFiles(name, root);
  const h = createHash("sha256");
  for (const path of Object.keys(files).sort()) h.update(`${path}\0${files[path].length}\0${files[path]}\0`);
  return h.digest("hex");
}

/** The commit this server runs from, when it runs from a git checkout (read from .git, nothing is executed); else null. */
export function sourceCommit(root = join(CORE_DIR, "..")): string | null {
  try {
    let git = join(root, ".git");
    // A worktree's .git is a file pointing at its directory.
    if (statSync(git).isFile()) git = readFileSync(git, "utf8").replace(/^gitdir:\s*/, "").trim();
    const head = readFileSync(join(git, "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    if (!ref) return null;
    const common = existsSync(join(git, "commondir")) ? join(git, readFileSync(join(git, "commondir"), "utf8").trim()) : git;
    for (const base of [git, common]) {
      if (existsSync(join(base, ref))) return readFileSync(join(base, ref), "utf8").trim();
      const packed = existsSync(join(base, "packed-refs")) ? readFileSync(join(base, "packed-refs"), "utf8") : "";
      const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
      if (line) return line.split(" ")[0];
    }
    return null;
  } catch {
    return null;
  }
}
