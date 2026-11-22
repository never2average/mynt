import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WORKSPACES_ROOT } from "./agent-host.js";
import { PRODUCT_LINES, type ProductLine } from "./catalog.js";

// App kinds: starting points for common finance apps (savings goals, money transfers, …). Each is a JSON
// file the coding agent reads, in its own workspace (workspaces/coding-build/templates/kinds/<id>.json),
// checked against schemas/app-kind.schema.json. The studio lists them (list_app_kinds), start_build takes
// one as `kind`, and the agent scaffolds the starter with its screens (scripts/scaffold_app.py --kind).

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (opts: object) => { compile: (s: object) => AjvValidate };
type AjvValidate = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };

export const APP_KIND_SCHEMA_PATH = fileURLToPath(new URL("../schemas/app-kind.schema.json", import.meta.url));
export const APP_KINDS_DIR = join(WORKSPACES_ROOT, "coding-build", "templates", "kinds");

export interface AppKind {
  id: string;
  title: string;
  description: string;
  product_lines: ProductLine[];
  goal_template: string;
  // Specific app ideas on this kind (New app's chips and Templates rows), each with its own goal.
  examples: { id: string; title: string; pitch: string; goal: string; product_lines: ProductLine[] }[];
  screens: { id: string; title: string; purpose: string; journey?: boolean }[];
  flows: { id: string; title: string; steps: string[] }[];
  sdk_calls: { server: string[]; browser: string[] };
}

// What's wrong with one kind file: its schema, then what the schema can't say (its id is its file's name,
// its lines are real product lines, at most one journey screen, no screen, flow or example twice, and each
// example builds on the kind's own lines).
export function appKindErrors(file: string, data: unknown, validate = kindValidator()): string[] {
  if (!validate(data)) return (validate.errors ?? []).map((e) => `${file}${e.instancePath} ${e.message ?? "is invalid"}`);
  const k = data as AppKind;
  const errors: string[] = [];
  if (`${k.id}.json` !== file) errors.push(`${file}: id '${k.id}' isn't the file's name`);
  for (const l of k.product_lines) if (!(PRODUCT_LINES as readonly string[]).includes(l)) errors.push(`${file}: '${l}' isn't a product line`);
  if (k.screens.filter((s) => s.journey).length > 1) errors.push(`${file}: more than one journey screen`);
  for (const e of k.examples)
    for (const l of e.product_lines) if (!k.product_lines.includes(l)) errors.push(`${file}: example '${e.id}' builds on '${l}', which isn't one of the kind's product lines`);
  for (const [what, ids] of [["screen", k.screens.map((s) => s.id)], ["flow", k.flows.map((f) => f.id)], ["example", k.examples.map((e) => e.id)]] as const)
    for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`${file}: ${what} '${id}' twice`);
  return errors;
}

let validator: AjvValidate | null = null;
function kindValidator() {
  if (!validator) validator = new Ajv2020({ allErrors: true, strict: false }).compile(JSON.parse(readFileSync(APP_KIND_SCHEMA_PATH, "utf8")));
  return validator;
}

// Every kind in the workspace, by title. Read once: they ship with the server. A bad file is a bug in the
// repository, so it throws (the test suite reads them all).
let loaded: AppKind[] | null = null;
export function appKinds(dir = APP_KINDS_DIR): AppKind[] {
  if (dir === APP_KINDS_DIR && loaded) return loaded;
  const kinds: AppKind[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;
    const errors = appKindErrors(file, data);
    if (errors.length) throw new Error(`Bad app kind: ${errors.join("; ")}`);
    const { $schema: _, ...kind } = data as AppKind & { $schema?: string };
    kinds.push(kind);
  }
  kinds.sort((a, b) => a.title.localeCompare(b.title));
  // An example's id names it across every kind (the studio keys its chips by it).
  const ids = kinds.flatMap((k) => k.examples.map((e) => e.id));
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) throw new Error(`Bad app kind: example '${id}' is in more than one kind`);
  if (dir === APP_KINDS_DIR) loaded = kinds;
  return kinds;
}

export const appKind = (id: string) => appKinds().find((k) => k.id === id) ?? null;

// start_build's check: a kind that's there, or a refusal naming the ones that are.
export function requireAppKind(id: string): AppKind {
  const k = appKind(id);
  if (!k) throw new Error(`No app kind '${id}'; list_app_kinds lists them (${appKinds().map((x) => x.id).join(", ")})`);
  return k;
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function registerAppKindTools(server: McpServer) {
  server.registerTool(
    "list_app_kinds",
    {
      title: "App kinds",
      description:
        "Developer: starting points for common finance apps (a dollar account, savings goals, money transfers, …): each one's title, one-line description, the product lines it builds on, a goal to start from and edit, specific app ideas on it (examples: a title, a one-line pitch and a goal each), the screens and flows built first and the SDK calls it relies on. Pass its id as start_build's kind: the coding agent starts from the starter app with those screens laid down.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ kinds: appKinds() }),
  );
}
