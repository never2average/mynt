import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RateLimiter } from "./rate-limit.js";
import type { Store } from "./store.js";
import { fixtureValue } from "./vault.js";
import { signBody, type VendorResult } from "./vendor-call.js";
import { conformanceCases, conformanceSecret, getOffering, PRACTICE_REF, QUOTE_MAX_SECONDS, redactTranscript, schemaProblems, serviceType, vendorLicenceGap, type CaseResult, type Offering, type ServiceType } from "./vendors.js";

// Mynt's vendor sandbox: a practice endpoint Mynt serves itself for every offering, so a vendor that has no test
// endpoint yet can see the conformance test pass (and read exactly what Mynt sends and expects) before wiring its own.
//
//   POST <PUBLIC_URL>/vendor-sandbox/<offering_id>            (also .../<offering_id>/v1/<service_type_key>)
//
// It behaves as a correct vendor for the offering's service type: it verifies Mynt-Signature with the offering's
// conformance signing secret, answers 401 to a bad or stale (over 300 s) signature, checks the input against the
// service type's input schema and answers with a fixture output built from its output schema.
//
// A practice pass is never conformance, by construction:
// - the sandbox answers only requests marked as practice (consent.artefact_ref "mynt_practice"); the real test marks
//   its requests "mynt_conformance", so it fails here even if an offering's endpoint somehow reached this one;
// - an offering's test or live endpoint may not be this path (create/update refuse it, and run_conformance again);
// - practice runs are kept in their own table (vendor_practice_runs), which nothing that reads real conformance
//   reads, and a practice run never writes an offering's status.
//
// It makes no outbound call, holds no customer data (inputs are Mynt's sandbox fixtures; it stores nothing a caller
// sends), takes bodies up to 64 KB and is rate-limited. The practice run itself (run_practice_conformance) is answered
// in-process by the same code, so it needs no public network.

export const VENDOR_SANDBOX_PATH = "/vendor-sandbox";
const MAX_BODY = 64 * 1024;
const T = "financial_products";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Does a URL name Mynt's practice sandbox (on any host)? Such a URL is never an offering's endpoint.
export function pointsAtVendorSandbox(raw: string): boolean {
  let path: string;
  try {
    path = new URL(raw.trim()).pathname;
  } catch {
    return false;
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the path as written
  }
  path = path.replace(/\/+/g, "/").toLowerCase();
  return path === VENDOR_SANDBOX_PATH || path.startsWith(`${VENDOR_SANDBOX_PATH}/`);
}

export const vendorSandboxUrl = (offeringId: string): string | null => {
  const base = process.env.PUBLIC_URL?.replace(/\/+$/, "");
  return base ? `${base}${VENDOR_SANDBOX_PATH}/${offeringId}` : null;
};

// ---- a fixture output from the output schema ----

type Schema = Record<string, unknown>;
const isObj = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

// A string matching a simple regular expression: the first alternative, the first character of each class, the
// fewest repeats. Anything it can't read (look-arounds, back-references) gives null, and the caller checks the result
// against the schema anyway.
export function sampleFromPattern(pattern: string): string | null {
  let i = 0;
  const unreadable = (): never => {
    throw new Error("unreadable");
  };
  const fromEscape = (c: string): string => (c === "d" ? "0" : c === "w" ? "a" : c === "s" ? " " : c === "n" ? "\n" : c === "t" ? "\t" : c === "" || /[DWSbB\dpPkux]/.test(c) ? unreadable() : c);
  const classChar = (): string => {
    // after "["
    const negated = pattern[i] === "^";
    if (negated) i++;
    const members: string[] = [];
    for (let first = true; i < pattern.length && (pattern[i] !== "]" || first); first = false) {
      let c = pattern[i++];
      if (c === "\\") c = fromEscape(pattern[i++] ?? "");
      if (pattern[i] === "-" && pattern[i + 1] !== undefined && pattern[i + 1] !== "]") i += 2; // a range: its start will do
      members.push(c);
    }
    if (pattern[i++] !== "]") unreadable();
    const pick = negated ? ["a", "0", "A", "-", "_", "x"].find((c) => !members.includes(c)) : members[0];
    return pick ?? unreadable();
  };
  const repeats = (): number => {
    const c = pattern[i];
    let n = 1;
    if (c === "?" || c === "*") {
      n = 0;
      i++;
    } else if (c === "+") i++;
    else if (c === "{") {
      const m = /^\{(\d+)(,\d*)?\}/.exec(pattern.slice(i));
      if (!m) return unreadable();
      n = Number(m[1]);
      i += m[0].length;
    } else return 1;
    if (pattern[i] === "?") i++; // lazy
    return n > 1000 ? unreadable() : n;
  };
  const alternatives = (): string => {
    let chosen: string | undefined;
    for (;;) {
      let seq = "";
      while (i < pattern.length && pattern[i] !== "|" && pattern[i] !== ")") {
        let atom: string;
        const c = pattern[i++];
        if (c === "(") {
          if (pattern[i] === "?") {
            if (pattern[i + 1] !== ":") unreadable();
            i += 2;
          }
          atom = alternatives();
          if (pattern[i++] !== ")") unreadable();
        } else if (c === "[") atom = classChar();
        else if (c === "\\") atom = fromEscape(pattern[i++] ?? "");
        else if (c === "^" || c === "$") atom = "";
        else if (c === ".") atom = "a";
        else atom = c;
        seq += atom.repeat(repeats());
      }
      chosen ??= seq;
      if (pattern[i] !== "|") return chosen;
      i++;
    }
  };
  try {
    const out = alternatives();
    return i === pattern.length ? out : null;
  } catch {
    return null;
  }
}

const FORMATS: Record<string, string> = {
  date: "2026-01-15",
  "date-time": "2026-01-15T12:00:00.000Z",
  time: "12:00:00Z",
  uuid: "00000000-0000-4000-8000-000000000000",
  uri: "https://sandbox.invalid/practice",
  url: "https://sandbox.invalid/practice",
  email: "practice@sandbox.invalid",
  hostname: "sandbox.invalid",
  ipv4: "192.0.2.1",
};

function resolveRef(root: Schema, schema: Schema, depth: number): Schema {
  let s = schema;
  for (let n = 0; n < 8 && typeof s.$ref === "string"; n++) {
    if (!s.$ref.startsWith("#")) return {};
    let at: unknown = root;
    for (const part of s.$ref.slice(1).split("/").filter(Boolean)) at = isObj(at) ? at[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
    if (!isObj(at)) return {};
    s = at;
  }
  if (Array.isArray(s.allOf) && depth < 8) {
    const merged: Schema = { ...s, allOf: undefined };
    for (const part of s.allOf.filter(isObj).map((p) => resolveRef(root, p, depth + 1))) {
      Object.assign(merged, part, {
        properties: { ...(isObj(merged.properties) ? merged.properties : {}), ...(isObj(part.properties) ? part.properties : {}) },
        required: [...(Array.isArray(merged.required) ? merged.required : []), ...(Array.isArray(part.required) ? part.required : [])],
      });
    }
    delete merged.allOf;
    return merged;
  }
  return s;
}

const stated = (s: Schema): boolean => "const" in s || "default" in s || (Array.isArray(s.examples) && s.examples.length > 0);

// One value for a schema: what the schema states itself (const, default, the first example, the first enum value),
// else Mynt's sandbox fixture for a data dictionary field of that name, else the simplest value of its type. The same
// schema always gives the same value, except a quote's expires_at, which must be ahead of now.
function sample(root: Schema, raw: Schema, name: string, now: Date, depth: number): unknown {
  const s = resolveRef(root, raw, depth);
  if (depth > 12) return null;
  if ("const" in s) return s.const;
  if ("default" in s) return s.default;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  for (const k of ["oneOf", "anyOf"] as const) {
    const branches = s[k];
    if (Array.isArray(branches) && branches.length && !s.type && !s.properties) return sample(root, isObj(branches[0]) ? branches[0] : {}, name, now, depth + 1);
  }
  const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === "string" ? [s.type] : [];
  const type = types.find((t) => t !== "null") ?? (types.includes("null") ? "null" : isObj(s.properties) || Array.isArray(s.required) ? "object" : s.items ? "array" : "string");
  if (type === "null") return null;
  if (type === "boolean") return true;
  if (type === "number" || type === "integer") {
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    let n = 0;
    const min = num(s.minimum);
    const xmin = num(s.exclusiveMinimum);
    const max = num(s.maximum);
    const xmax = num(s.exclusiveMaximum);
    if (min !== null && n < min) n = min;
    if (xmin !== null && n <= xmin) n = type === "integer" ? Math.floor(xmin) + 1 : xmin + 1;
    if (max !== null && n > max) n = max;
    if (xmax !== null && n >= xmax) n = type === "integer" ? Math.ceil(xmax) - 1 : xmax - 1;
    const step = num(s.multipleOf);
    if (step && step > 0) n = Math.ceil(n / step) * step;
    return type === "integer" ? Math.ceil(n) : n;
  }
  if (type === "array") {
    const min = typeof s.minItems === "number" ? s.minItems : 0;
    const max = typeof s.maxItems === "number" ? s.maxItems : Infinity;
    const count = Math.min(Math.max(min, isObj(s.items) ? 1 : 0), max, 20);
    return Array.from({ length: count }, () => sample(root, isObj(s.items) ? s.items : {}, name, now, depth + 1));
  }
  if (type === "object") {
    const props = isObj(s.properties) ? s.properties : {};
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    const out: Schema = {};
    for (const [k, v] of Object.entries(props)) {
      const p = isObj(v) ? v : {};
      if (required.includes(k) || stated(resolveRef(root, p, depth + 1))) out[k] = sample(root, p, k, now, depth + 1);
    }
    for (const k of required) if (!(k in out)) out[k] = `sandbox_${k}`;
    return out;
  }
  // A string: the first candidate the property's own schema accepts.
  const candidates: string[] = [];
  if (name === "expires_at") candidates.push(new Date(now.getTime() + 60_000).toISOString());
  const fixture = fixtureValue(name);
  if (fixture != null) candidates.push(fixture);
  if (typeof s.format === "string" && FORMATS[s.format]) candidates.push(FORMATS[s.format]);
  if (typeof s.pattern === "string") {
    const fromPattern = sampleFromPattern(s.pattern);
    if (fromPattern !== null) candidates.push(fromPattern);
  }
  let plain = `sandbox_${name || "value"}`;
  if (typeof s.minLength === "number" && plain.length < s.minLength) plain = plain.padEnd(s.minLength, "x");
  if (typeof s.maxLength === "number") plain = plain.slice(0, s.maxLength);
  candidates.push(plain);
  return candidates.find((c) => !schemaProblems(s, c).length) ?? candidates[0];
}

// The sandbox's answer for a service type: an output valid against its output schema, or why Mynt can't build one
// (then the sandbox says so, and a practice run fails honestly rather than pass on an invalid answer).
export function sandboxOutput(t: ServiceType, now = new Date()): { output: Record<string, unknown> } | { problems: string[] } {
  let output: unknown;
  try {
    output = sample(t.output_schema, t.output_schema, "", now, 0);
  } catch {
    return { problems: ["the output schema couldn't be read"] };
  }
  const problems = schemaProblems(t.output_schema, output);
  if (problems.length || !isObj(output)) return { problems: problems.length ? problems.map((p) => `output ${p}`) : ["the output isn't an object"] };
  if (t.quote) {
    const at = Date.parse(String(output.expires_at));
    if (typeof output.quote_id !== "string" || !output.quote_id || output.quote_id.length > 200 || Number.isNaN(at) || at <= now.getTime() || at > now.getTime() + QUOTE_MAX_SECONDS * 1000)
      return { problems: ["a quote's quote_id and expires_at couldn't be built from the output schema"] };
  }
  return { output };
}

// ---- the endpoint ----

function signatureVerifies(header: string | undefined, raw: string, secret: string): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  return timingSafeEqual(createHmac("sha256", secret).update(`${m[1]}.${raw}`).digest(), Buffer.from(m[2], "hex"));
}

type Answer = { status: number; body: unknown };
const refusal = (status: number, code: string, message: string, requestId: unknown = null): Answer => ({ status, body: { request_id: typeof requestId === "string" ? requestId : null, status: "error", output: null, error: { code, message } } });

// One request to the sandbox for an offering, as a correct vendor would answer it. An unknown offering and a bad
// signature get the same 401, so the endpoint doesn't say which offerings exist.
export async function answerVendorSandbox(store: Store, offeringId: string, pathKey: string | null, raw: string, signature: string | undefined): Promise<Answer> {
  const badSignature = refusal(401, "bad_signature", "Mynt-Signature doesn't verify, or its timestamp is more than 300 s old");
  if (Buffer.byteLength(raw) > MAX_BODY) return refusal(413, "too_large", "Bodies are limited to 64 KB");
  const o = UUID.test(offeringId) ? await getOffering(store.db, offeringId) : undefined;
  if (!o || o.status === "suspended") return badSignature;
  if (!signatureVerifies(signature, raw, await conformanceSecret(store, o.id))) return badSignature;
  let body: { request_id?: unknown; environment?: unknown; input?: unknown; consent?: { artefact_ref?: unknown } | null };
  try {
    body = JSON.parse(raw);
  } catch {
    return refusal(400, "invalid_json", "The body isn't JSON");
  }
  if (!isObj(body)) return refusal(400, "invalid_json", "The body isn't a JSON object");
  if (pathKey !== null && pathKey !== o.service_type) return refusal(404, "not_found", "This offering is of another service type", body.request_id);
  const error = (code: string, message: string): Answer => ({ status: 200, body: { request_id: body.request_id ?? null, status: "error", output: null, error: { code, message } } });
  if (typeof body.request_id !== "string" || !body.request_id) return error("invalid_request", "request_id is missing");
  if (body.environment !== "test") return error("sandbox_only", "Mynt's vendor sandbox answers test requests only");
  // Only practice runs: a real conformance request (mynt_conformance) is never answered "ok" here.
  if (!isObj(body.consent) || body.consent.artefact_ref !== PRACTICE_REF)
    return error("practice_only", "Mynt's vendor sandbox answers practice runs only; the real conformance test must reach your own endpoint");
  const t = await serviceType(store.db, o.region, o.service_type);
  if (!t) return error("unavailable", "The offering's service type isn't defined");
  const inputProblems = schemaProblems(t.input_schema, body.input);
  if (inputProblems.length) return error("invalid_input", `input ${inputProblems[0]}`);
  const built = sandboxOutput(t);
  if ("problems" in built) return error("no_sandbox_answer", `Mynt's sandbox can't build an answer for this service type: ${built.problems[0]}`);
  return { status: 200, body: { request_id: body.request_id, status: "ok", output: built.output, error: null } };
}

// Per offering, and across all callers (the path's id is the caller's to choose, so the total is capped too).
const perOffering = new RateLimiter(30, 30);
const overall = new RateLimiter(300, 300);
const practiceRuns = new RateLimiter(10, 10);

export async function vendorSandbox(store: Store, req: IncomingMessage, res: ServerResponse, url: URL) {
  const reply = (a: Answer, headers: Record<string, string> = {}) => {
    res.writeHead(a.status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Mynt-Sandbox": "practice", ...headers });
    res.end(JSON.stringify(a.body));
  };
  const m = /^\/([^/]+)(?:\/v1\/([^/]+))?\/?$/.exec(url.pathname.slice(VENDOR_SANDBOX_PATH.length));
  if (!m) return reply(refusal(404, "not_found", "POST /vendor-sandbox/<offering_id>"));
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
  const wait = overall.take("all") || (UUID.test(m[1]) ? perOffering.take(m[1].toLowerCase()) : 0);
  if (wait) return reply(refusal(429, "rate_limited", "Too many requests to the vendor sandbox: try again shortly"), { "Retry-After": String(wait) });
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return reply(refusal(413, "too_large", "Bodies are limited to 64 KB"));
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return reply(refusal(413, "too_large", "Bodies are limited to 64 KB"));
    chunks.push(c as Buffer);
  }
  const signature = req.headers["mynt-signature"];
  return reply(await answerVendorSandbox(store, m[1], m[2] ?? null, Buffer.concat(chunks).toString("utf8"), typeof signature === "string" ? signature : undefined));
}

// ---- the practice run ----

const REDACTED = "<redacted>";
const EXPECTED: Record<string, string> = {
  bad_signature_refused: "Refused: 401 (Mynt accepts any 4xx, or 200 with status \"error\"). This request's signature was made with another secret.",
  stale_timestamp_refused: "Refused: 401 (Mynt accepts any 4xx, or 200 with status \"error\"). This request is correctly signed, but its timestamp is 600 s old.",
};
const EXPECTED_OK = "200 with the same request_id, status \"ok\" and an output valid against the service type's output schema.";

export interface PracticeExchange {
  case: string;
  request: { method: "POST"; path: string; headers: Record<string, string>; body: unknown };
  response: { http_status: number | null; body: unknown };
  expected: string;
}

// The secret can't be in a transcript (it signs; it's never sent), but nothing leaves here without the check.
function scrub<V>(value: V, secret: string): V {
  const text = JSON.stringify(value);
  return text.includes(secret) ? (JSON.parse(text.split(secret).join(REDACTED)) as V) : value;
}

export class PracticeRefused extends Error {}

// run_practice_conformance: the conformance test's own cases (conformanceCases), answered in-process by the sandbox
// endpoint's code instead of the vendor's endpoint. Recorded as a practice run; the offering is never changed.
export async function runPractice(store: Store, o: Offering, t: ServiceType, by: string | null) {
  if (o.status === "suspended") throw new PracticeRefused("An admin suspended this offering");
  const wait = practiceRuns.take(o.id);
  if (wait) throw new PracticeRefused(`Too many practice runs for this offering: try again in ${wait} s`);
  const secret = await conformanceSecret(store, o.id);
  const transcript: PracticeExchange[] = [];
  const cases: CaseResult[] = await conformanceCases(
    t,
    secret,
    async (name, body, signature) => {
      const raw = JSON.stringify(body);
      const started = Date.now();
      const header = signature ?? signBody(secret, raw);
      const a = await answerVendorSandbox(store, o.id, t.key, raw, header);
      const ok = a.status >= 200 && a.status < 300;
      transcript.push({
        case: name,
        request: {
          method: "POST",
          path: `/v1/${t.key}`,
          headers: { "Content-Type": "application/json", "User-Agent": "Mynt-Vendor-Client/1", "Mynt-Signature": header.replace(/v1=[0-9a-f]+$/, `v1=${REDACTED}`) },
          body,
        },
        response: { http_status: a.status, body: a.body },
        expected: EXPECTED[name] ?? EXPECTED_OK,
      });
      return { ok, http_status: a.status, body: a.body, error: ok ? null : `http ${a.status}`, latency_ms: Date.now() - started } satisfies VendorResult;
    },
    PRACTICE_REF,
  );
  const passed = cases.length > 0 && cases.every((c) => c.passed);
  const id = randomUUID();
  // Kept with the run, as it is shown: fixture requests and the sandbox's answers, the signature's digest left out and
  // the secret (and anything shaped like one) scrubbed.
  await store.db.query(`INSERT INTO ${T}.vendor_practice_runs (id, offering_id, kind, passed, cases, run_by, transcript) VALUES ($1, $2, 'practice', $3, $4, $5, $6)`, [
    id,
    o.id,
    passed,
    JSON.stringify(cases),
    by,
    JSON.stringify(redactTranscript(transcript, [secret])),
  ]);
  // The real test also checks the vendor's licences; a practice run only says so.
  const gap = await vendorLicenceGap(store, o, t);
  const endpoint = vendorSandboxUrl(o.id);
  return scrub(
    {
      run_id: id,
      kind: "practice" as const,
      passed,
      counts_as_conformance: false as const,
      status: o.status, // unchanged: a practice run never moves an offering
      message: passed
        ? "Practice run passed — now point Mynt at your own test endpoint and run the real test"
        : "Practice run didn't pass: Mynt's sandbox couldn't answer every case for this service type. It says nothing about your own endpoint",
      next: o.test_base_url ? "run_conformance" : "update_vendor_offering { test_base_url }, then run_conformance",
      cases,
      ...(gap ? { licence_note: `The real test also checks your licences: ${gap}` } : {}),
      // What Mynt sends and expects for this service type, to build against.
      reference: {
        service_type: t.key,
        region: t.region,
        sends: {
          method: "POST" as const,
          url: `<your test_base_url>/v1/${t.key}`,
          signature: `Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with your signing secret>. Answer 401 when it doesn't verify or t is more than 300 s old.`,
          marker: `In the real test consent.artefact_ref${t.accepts ? " and quote.quote_id are" : " is"} "mynt_conformance"; in a practice run, "${PRACTICE_REF}".`,
          input_schema: t.input_schema,
          params_schema: t.params_schema,
        },
        expects: {
          answer: `200 within 10 s, at most 256 KiB: { "request_id": <the same>, "status": "ok", "output": <valid against output_schema>, "error": null }`,
          output_schema: t.output_schema,
        },
        sandbox_endpoint: endpoint,
        sandbox_note: "Mynt's own practice endpoint for this offering. It answers practice requests signed with the offering's signing secret, and can never be the offering's test or live endpoint.",
        signing_secret: REDACTED,
        transcript,
      },
    },
    secret,
  );
}

export interface PracticeRun {
  run_id: string;
  kind: "practice";
  passed: boolean;
  at: string | null;
  run_by: string | null;
  failures: { case: string; problems: string[] }[];
}
// An offering's practice runs, newest first: for the onboarding checklist's informational line only.
export async function practiceRunsOf(store: Store, offeringId: string, limit: number): Promise<PracticeRun[]> {
  const { rows } = await store.db.query(
    `SELECT r.id, r.passed, r.cases, r.created_at, u.name AS run_by_name FROM ${T}.vendor_practice_runs r LEFT JOIN ${T}.users u ON u.id = r.run_by
      WHERE r.offering_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [offeringId, limit],
  );
  return rows.map((r) => ({
    run_id: r.id as string,
    kind: "practice" as const,
    passed: r.passed === true,
    at: r.created_at == null ? null : new Date(r.created_at as string).toISOString(),
    run_by: (r.run_by_name as string | null) ?? null,
    failures: ((r.cases as { case: string; passed: boolean; problems: string[] }[] | null) ?? []).filter((c) => !c.passed).map((c) => ({ case: c.case, problems: c.problems ?? [] })),
  }));
}
