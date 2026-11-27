// Mynt's vendor service endpoint: POST /mynt/services/<service type key>.
//
// It verifies Mynt-Signature over the raw body, checks the input against the service type's input schema, calls
// handleService (handle-service.ts), checks the output against the output schema, and answers. The signature is its
// only authentication: it needs no Mynt app key and must never ask for one. You shouldn't need to change this file.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

export interface ServiceContract {
  service_type: { key: string; region: string; name: string; [k: string]: unknown };
  endpoint: { app_path: string; [k: string]: unknown };
  signature: { header: string; tolerance_seconds: number; [k: string]: unknown };
  request: { input_schema: Record<string, unknown>; params_schema?: Record<string, unknown> | null; [k: string]: unknown };
  response: { output_schema: Record<string, unknown>; [k: string]: unknown };
  fixtures: { input: Record<string, unknown>; params?: Record<string, unknown> }[];
  example_output?: Record<string, unknown> | null;
  [k: string]: unknown;
}

/** The contract the scaffold fetched from Mynt, kept beside the code (api/contract/service-contract.json). */
export function loadContract(url: URL = new URL("../contract/service-contract.json", import.meta.url)): ServiceContract {
  return JSON.parse(readFileSync(url, "utf8")) as ServiceContract;
}

export const TOLERANCE_SECONDS = 300;

/**
 * Mynt-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the signing secret>.
 * True only when the secret is set, the timestamp is within the tolerance and the digest matches (compared in
 * constant time). Verify the raw bytes, before parsing them.
 */
export function verifySignature(header: string | undefined, rawBody: Buffer | string, secret: string | undefined, nowSeconds = Date.now() / 1000, toleranceSeconds = TOLERANCE_SECONDS): boolean {
  if (!secret) return false; // no secret set: everything is refused
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(nowSeconds - Number(m[1])) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${m[1]}.`).update(rawBody).digest();
  const given = Buffer.from(m[2], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type Validate = ((data: unknown) => boolean) & { errors?: { instancePath: string; message?: string }[] | null };
const require = createRequire(import.meta.url);
function compile(schema: Record<string, unknown>): Validate {
  const Ajv2020 = require("ajv/dist/2020").default as new (opts: object) => { compile: (s: object) => Validate };
  const addFormats = require("ajv-formats").default as (ajv: unknown) => void;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}
// Which rules failed, as paths and rules only: never the values, which may be a customer's.
const problems = (v: Validate) => (v.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`).slice(0, 20);

export interface Answer {
  status: number;
  body: Record<string, unknown>;
}
export type Handler = (
  input: Record<string, unknown>,
  request: { request_id: string; environment: "test" | "live"; params?: Record<string, unknown>; quote?: { quote_id: string } },
  contract: ServiceContract,
) => Promise<Record<string, unknown>>;

const refuse = (status: number, code: string, message: string, requestId: unknown = null, extra: Record<string, unknown> = {}): Answer => ({
  status,
  body: { request_id: typeof requestId === "string" ? requestId : null, status: "error", output: null, error: { code, message, ...extra } },
});

/**
 * The endpoint as a function of what arrived: the service type in the path, the Mynt-Signature header and the raw
 * body. `secret` is read per request, so a rotated setting takes effect on the next deploy without a code change.
 */
export function createVendorService(o: { contract: ServiceContract; secret: () => string | undefined; handle: Handler; now?: () => number }) {
  const validInput = compile(o.contract.request.input_schema);
  const validParams = o.contract.request.params_schema ? compile(o.contract.request.params_schema) : null;
  const validOutput = compile(o.contract.response.output_schema);
  const tolerance = Number(o.contract.signature.tolerance_seconds) || TOLERANCE_SECONDS;
  return async function answer(typeKey: string, signature: string | undefined, raw: Buffer): Promise<Answer> {
    // The signature first, over the raw bytes: an unsigned caller learns nothing, not even which types exist.
    if (!verifySignature(signature, raw, o.secret(), (o.now ?? Date.now)() / 1000, tolerance)) return refuse(401, "bad_signature", "The Mynt-Signature didn't verify");
    if (typeKey !== o.contract.service_type.key) return refuse(404, "unknown_service_type", "This service doesn't serve that service type");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return refuse(400, "invalid_json", "The body isn't JSON");
    }
    const requestId = body?.request_id;
    if (typeof requestId !== "string" || !requestId) return refuse(400, "invalid_request", "request_id is missing");
    if (!validInput(body.input)) return refuse(400, "invalid_input", "The input doesn't fit the service type's input schema", requestId, { problems: problems(validInput) });
    if (validParams && !validParams(body.params ?? {})) return refuse(400, "invalid_params", "The params don't fit the service type's params schema", requestId, { problems: problems(validParams) });
    let output: Record<string, unknown>;
    try {
      output = await o.handle(
        body.input as Record<string, unknown>,
        { request_id: requestId, environment: body.environment === "live" ? "live" : "test", params: body.params as Record<string, unknown> | undefined, quote: body.quote as { quote_id: string } | undefined },
        o.contract,
      );
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      // A refusal the service chose (ServiceError): said as a code. Anything else: no detail leaves.
      if (typeof code === "string" && /^[a-z][a-z0-9_]{0,60}$/.test(code)) return { status: 200, body: { request_id: requestId, status: "error", output: null, error: { code, message: (e as Error).message.slice(0, 300) } } };
      return refuse(500, "service_failed", "The service couldn't answer", requestId);
    }
    // An output that doesn't fit the schema is never sent.
    if (!validOutput(output)) return refuse(500, "invalid_output", "The service's answer doesn't fit the service type's output schema", requestId, { problems: problems(validOutput) });
    return { status: 200, body: { request_id: requestId, status: "ok", output, error: null } };
  };
}
