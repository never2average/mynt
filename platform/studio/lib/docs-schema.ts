// A tool's inputs, from its JSON Schema (docs/site/tools.json): the rows of its inputs table and an example call
// built from the schema. Pure functions, used by the docs pages (app/docs) and their tests.

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  propertyNames?: JsonSchema;
  default?: unknown;
  format?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  $ref?: string;
  [key: string]: unknown;
};

export type InputRow = {
  name: string; // dotted for nested fields: procedures[].product_line
  depth: number;
  type: string;
  required: boolean;
  description: string | null;
  values: string[]; // an enum's values
  constraints: string[]; // min/max, format, pattern, default
};

// Follows a local $ref (#/…) within the tool's own schema.
function resolve(s: JsonSchema | undefined, root: JsonSchema): JsonSchema {
  let cur = s ?? {};
  for (let i = 0; i < 10 && typeof cur.$ref === "string" && cur.$ref.startsWith("#/"); i++) {
    let at: unknown = root;
    for (const part of cur.$ref.slice(2).split("/")) at = (at as Record<string, unknown> | undefined)?.[decodeURIComponent(part.replace(/~1/g, "/").replace(/~0/g, "~"))];
    if (!at || typeof at !== "object") break;
    cur = { ...(at as JsonSchema), description: cur.description ?? (at as JsonSchema).description };
  }
  return cur;
}

// The options of a union, without the null that marks a field nullable.
const options = (s: JsonSchema) => (s.anyOf ?? s.oneOf ?? []).filter((o) => o.type !== "null");
const nullable = (s: JsonSchema) => (s.anyOf ?? s.oneOf ?? []).some((o) => o.type === "null") || (Array.isArray(s.type) && s.type.includes("null"));

export function typeLabel(input: JsonSchema | undefined, root: JsonSchema = input ?? {}): string {
  const s = resolve(input, root);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.every((v) => typeof v === "string") ? "string" : [...new Set(s.enum.map((v) => typeof v))].join(" | ");
  const opts = options(s);
  if (opts.length) {
    const t = [...new Set(opts.map((o) => typeLabel(o, root)))].join(" | ");
    return nullable(s) ? `${t} | null` : t;
  }
  if (s.type === "array") return `${typeLabel(s.items, root)}[]`;
  if (Array.isArray(s.type)) return s.type.join(" | ");
  if (s.type === "object" && !s.properties && s.additionalProperties && typeof s.additionalProperties === "object") return `map of ${typeLabel(s.additionalProperties, root)}`;
  return s.type ?? "any";
}

function constraintsOf(s: JsonSchema): string[] {
  const out: string[] = [];
  if (s.format) out.push(`format: ${s.format}`);
  if (s.minLength !== undefined && s.maxLength !== undefined) out.push(`${s.minLength}–${s.maxLength} characters`);
  else if (s.minLength !== undefined) out.push(`at least ${s.minLength} character${s.minLength === 1 ? "" : "s"}`);
  else if (s.maxLength !== undefined) out.push(`at most ${s.maxLength} characters`);
  if (s.minimum !== undefined) out.push(`≥ ${s.minimum}`);
  if (s.exclusiveMinimum !== undefined) out.push(`> ${s.exclusiveMinimum}`);
  if (s.maximum !== undefined) out.push(`≤ ${s.maximum}`);
  if (s.exclusiveMaximum !== undefined) out.push(`< ${s.exclusiveMaximum}`);
  if (s.minItems !== undefined) out.push(`at least ${s.minItems} item${s.minItems === 1 ? "" : "s"}`);
  if (s.maxItems !== undefined) out.push(`at most ${s.maxItems} items`);
  // A uuid's pattern says nothing its format doesn't.
  if (s.pattern && s.format !== "uuid") out.push(`pattern: ${s.pattern}`);
  if (s.default !== undefined) out.push(`default: ${JSON.stringify(s.default)}`);
  return out;
}

// One row per input, and its nested fields under it (objects, arrays of objects), down to `maxDepth`.
export function inputRows(schema: JsonSchema, maxDepth = 2): InputRow[] {
  const rows: InputRow[] = [];
  const walk = (obj: JsonSchema, prefix: string, depth: number) => {
    const req = new Set(obj.required ?? []);
    for (const [name, raw] of Object.entries(obj.properties ?? {})) {
      const s = resolve(raw, schema);
      const opts = options(s);
      const enumOf = s.enum ?? (opts.length && opts.every((o) => o.const !== undefined) ? opts.map((o) => o.const) : undefined);
      const full = `${prefix}${name}`;
      rows.push({
        name: full,
        depth,
        type: typeLabel(s, schema),
        required: req.has(name),
        description: s.description?.trim() || null,
        values: (enumOf ?? (s.type === "array" ? resolve(s.items, schema).enum : undefined) ?? []).map((v) => (typeof v === "string" ? v : JSON.stringify(v))),
        constraints: constraintsOf(s),
      });
      if (depth >= maxDepth) continue;
      const inner = s.type === "array" ? resolve(s.items, schema) : opts.length === 1 ? resolve(opts[0], schema) : s;
      if (inner.properties) walk(inner, `${full}${s.type === "array" ? "[]" : ""}.`, depth + 1);
    }
  };
  walk(resolve(schema, schema), "", 0);
  return rows;
}

const PATTERN_GUESSES = ["US", "global", "example", "example-1", "EX", "0x0", "2026-01-01", "1", "a"];

// A value that fits the schema, for the example call. Optional fields are left out.
export function exampleValue(input: JsonSchema | undefined, root: JsonSchema = input ?? {}, depth = 0): unknown {
  const s = resolve(input, root);
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const opts = options(s);
  if (opts.length) return exampleValue(opts[0], root, depth);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type) {
    case "string": {
      if (s.format === "uuid") return "00000000-0000-4000-8000-000000000000";
      if (s.format === "date-time") return "2026-01-01T00:00:00Z";
      if (s.format === "date") return "2026-01-01";
      if (s.format === "email") return "name@example.com";
      if (s.format === "uri" || s.format === "url") return "https://app.example.com";
      if (s.pattern) {
        try {
          const re = new RegExp(s.pattern);
          const hit = PATTERN_GUESSES.find((g) => re.test(g));
          if (hit) return hit;
        } catch {
          // fall through
        }
      }
      const base = "string";
      return s.minLength && s.minLength > base.length ? base.padEnd(s.minLength, "x") : base;
    }
    case "integer":
    case "number":
      return s.minimum ?? (s.exclusiveMinimum !== undefined ? s.exclusiveMinimum + 1 : 1);
    case "boolean":
      return true;
    case "array":
      return depth > 4 ? [] : Array.from({ length: Math.max(1, s.minItems ?? 1) }, () => exampleValue(s.items, root, depth + 1));
    case "object": {
      if (depth > 4) return {};
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) out[k] = exampleValue(s.properties?.[k], root, depth + 1);
      return out;
    }
    default:
      return null;
  }
}

// The JSON-RPC request an MCP client sends to call the tool.
export function exampleCall(name: string, schema: JsonSchema): string {
  return JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: exampleValue(schema) ?? {} } }, null, 2);
}
