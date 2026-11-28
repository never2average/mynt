// The "responses" model backend: a provider that serves the Responses API (OpenAI's API). What is the provider's own
// is here and nowhere else: where its API is, what Mynt lets through to it, how it reports usage, and how it says it
// declined a request.
//
// A sandboxed agent on this backend calls Mynt's agent proxy at /agent/r/v1/responses with its run's token as the
// bearer. Mynt swaps the token for the provider's key (which never enters a sandbox), sends the request to the one
// model the run is set to whatever it asked for, names the access programme an admin set (and none the sandbox
// asked for), meters the answer's tokens against the run's cap at the prices an admin set, and records a refusal by
// the provider's safeguards with the provider's request id.
//
// Relied on (the provider's API reference and its CLI's source, read 2026-11-28):
//   - POST /v1/responses with `Authorization: Bearer <key>`; the request id comes back in `x-request-id`;
//   - usage is `{ input_tokens, input_tokens_details: { cached_tokens }, output_tokens }` on the response object,
//     which a stream carries in its `response.completed` (or `response.incomplete` / `response.failed`) event;
//   - a response says which access programme applied in `access_programs.cyber`, and the provider's own CLI asks
//     for one with the same field on the request.
// Not documented precisely enough to rely on: what a safeguards refusal looks like on the wire. Everything Mynt
// assumes about that is in refusalOf below.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AgentMeter } from "../agent-meter.js";
import type { AgentRun } from "../agent-proxy.js";
import { redact } from "../boxes.js";
import { BACKEND_PROXY_PATH, priceTokens, type ProviderRefusal, type TokenUsage } from "./index.js";

const UPSTREAM = "https://api.openai.com/v1/responses";
const PATH = `${BACKEND_PROXY_PATH.responses}/responses`;
const MAX_BODY = 32 * 1024 * 1024;
const FORWARD_RESPONSE = ["content-type", "x-request-id", "retry-after"];
// The tools a sandboxed agent runs itself. Anything else in a request's `tools` is one the provider would run and
// bill apart from tokens (web search, code execution, remote MCP), outside the run's cap and the sandbox: dropped.
const LOCAL_TOOLS = new Set(["function", "custom", "namespace", "local_shell", "apply_patch"]);
// A run stops once this many of its answered calls couldn't be measured: its spend is no longer known.
export const UNMEASURED_CALL_LIMIT = 5;

const reply = (res: ServerResponse, status: number, code: string, message: string) =>
  void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message, type: "mynt_proxy_error", code } }));

interface ErrorBody {
  code?: unknown;
  type?: unknown;
  message?: unknown;
}

/**
 * Whether a provider's answer is its safeguards declining the request, and under what name. The one place Mynt
 * guesses at the provider's wire format: an error whose code or type names a policy, a response cut short by the
 * content filter, or a message the model itself refused to write. Null for everything else (a bad request, a rate
 * limit, an outage), which is never recorded as a refusal.
 */
export function refusalOf(o: { error?: ErrorBody | null; incompleteReason?: string | null; refused?: boolean }): string | null {
  const code = typeof o.error?.code === "string" ? o.error.code : typeof o.error?.type === "string" ? o.error.type : "";
  if (/(^|_)(policy|safety|safeguard)s?(_|$)|content_filter|invalid_prompt|violation/i.test(code)) return code.slice(0, 80);
  if (typeof o.error?.message === "string" && /\b(usage|content|safety|cyber\w*) polic(y|ies)\b|safety system|safeguards?\b/i.test(o.error.message)) return (code || "policy").slice(0, 80);
  if (o.incompleteReason === "content_filter") return "content_filter";
  return o.refused ? "refusal" : null;
}

interface ResponseObject {
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null;
  error?: ErrorBody | null;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string }[] }[];
}

/** Reads usage and any refusal out of an answer as it streams past: a JSON body, or server-sent events. */
export class ResponsesReader {
  private buffer = "";
  private usage: TokenUsage | null = null;
  private refusal: string | null = null;
  private refusedOnly = false;
  private wrote = false;
  constructor(private readonly streamed: boolean) {}

  push(chunk: Buffer) {
    this.buffer += chunk.toString("utf8");
    if (!this.streamed) return;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line.startsWith("data:")) this.event(line.slice(5).trim());
    }
  }

  private response(r: ResponseObject | null | undefined) {
    if (!r) return;
    const u = r.usage;
    if (u && (typeof u.input_tokens === "number" || typeof u.output_tokens === "number")) this.usage = { input: u.input_tokens ?? 0, cachedInput: u.input_tokens_details?.cached_tokens ?? 0, output: u.output_tokens ?? 0 };
    this.refusal ??= refusalOf({ error: r.error, incompleteReason: r.incomplete_details?.reason ?? null });
    for (const item of r.output ?? []) {
      if (item.type !== "message") continue;
      for (const part of item.content ?? []) part.type === "refusal" ? (this.refusedOnly = true) : (this.wrote = true);
    }
  }

  private event(data: string) {
    try {
      const e = JSON.parse(data) as { type?: string; response?: ResponseObject; item?: { type?: string; content?: { type?: string }[] }; error?: ErrorBody; code?: unknown; message?: unknown };
      if (e.type === "response.completed" || e.type === "response.incomplete" || e.type === "response.failed") this.response(e.response);
      else if (e.type === "response.output_item.done" && e.item) this.response({ output: [e.item] });
      else if (e.type === "error") this.refusal ??= refusalOf({ error: e.error ?? { code: e.code, message: e.message } });
    } catch {
      // not JSON: ignore
    }
  }

  result(): { usage: TokenUsage | null; refusal: string | null } {
    if (!this.streamed) {
      try {
        const body = JSON.parse(this.buffer) as ResponseObject;
        this.response(body);
      } catch {
        // not JSON: nothing to read
      }
    }
    // A message that is only the model's refusal, with nothing else written.
    return { usage: this.usage, refusal: this.refusal ?? refusalOf({ refused: this.refusedOnly && !this.wrote }) };
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export interface ResponsesProxyOptions {
  meter?: AgentMeter | null;
  // The backend's API key as it is now (the environment's, else the key vault's); null when it isn't set.
  apiKey: () => string | null;
}

/** Serves one request of a sandboxed agent on the "responses" backend. `resolve` finds the live run behind a token. */
export async function responsesProxy(resolve: (token: string) => Promise<AgentRun | null>, req: IncomingMessage, res: ServerResponse, url: URL, opts: ResponsesProxyOptions) {
  // One path, one method: a sandbox's token reaches nothing else of the provider's API.
  if (req.method !== "POST" || url.pathname !== PATH) return reply(res, 404, "not_found", "Not found");
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const run = token ? await resolve(token) : null;
  if (!run) return reply(res, 401, "inactive_token", "This agent token isn't active");
  const backend = run.backend;
  if (backend?.kind !== "responses") return reply(res, 403, "wrong_backend", "This agent token isn't for this model backend");
  const key = opts.apiKey();
  if (!key) return reply(res, 503, "backend_not_set", "This model backend's key isn't set on this Mynt");
  if (!run.model) return reply(res, 503, "backend_not_set", "No model is set for this run's backend");
  // Without a price nothing is forwarded: the call's spend couldn't be measured against the run's cap.
  const price = backend.price;
  if (!price) return reply(res, 503, "backend_not_set", "No token price is set for this run's backend, so its spend couldn't be measured; nothing was sent");
  const meter = opts.meter ?? null;
  if (meter) {
    if ((await meter.spent(run.key)) >= run.capUsd) return reply(res, 402, "budget_spent", `This run's model budget (US$${run.capUsd}) is spent`);
    if (((await meter.unmeasured(run.key))?.calls ?? 0) >= UNMEASURED_CALL_LIMIT) return reply(res, 402, "budget_unmeasured", `This run's model budget (US$${run.capUsd}) is spent as far as Mynt can tell: ${UNMEASURED_CALL_LIMIT} of its calls couldn't be measured`);
  }
  const raw = await readBody(req);
  if (!raw) return reply(res, 413, "too_large", "Request too large");
  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    json = parsed as Record<string, unknown>;
  } catch {
    return reply(res, 400, "bad_request", "The request body must be a JSON object");
  }
  // The run's model, whatever the sandbox asked for; the standard service tier (the price an admin set is for it);
  // the access programme an admin set, never one the sandbox names; and only tools the sandbox runs itself.
  json.model = run.model;
  delete json.service_tier;
  delete json.access_programs;
  if (backend.accessProgram) json.access_programs = { cyber: backend.accessProgram };
  if (Array.isArray(json.tools)) json.tools = json.tools.filter((t) => t && typeof t === "object" && LOCAL_TOOLS.has(String((t as { type?: unknown }).type)));
  const streamed = json.stream === true;

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const scrub = (text: string) => redact(text.split(key).join("[key]"), [key]);
  let up: Response;
  try {
    up = await fetch(UPSTREAM, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: streamed ? "text/event-stream" : "application/json" }, body: JSON.stringify(json), signal: abort.signal });
  } catch {
    return reply(res, 502, "provider_unreachable", "Couldn't reach the model provider");
  }
  const out: Record<string, string> = { "Cache-Control": "no-cache, no-transform" };
  for (const h of FORWARD_RESPONSE) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  const requestId = up.headers.get("x-request-id")?.slice(0, 200) ?? null;
  const refused = (category: string) => meter?.addRefusal(run.key, { category, request_id: requestId } satisfies ProviderRefusal).catch((e) => console.error("agent meter", (e as Error).message));

  // An error from the provider: small, so it is read whole, scrubbed of the key, and looked at for a refusal.
  if (!up.ok) {
    const text = scrub((await up.text().catch(() => "")).slice(0, 64_000));
    let error: ErrorBody | null = null;
    try {
      error = (JSON.parse(text) as { error?: ErrorBody }).error ?? null;
    } catch {
      // not JSON: forwarded as it is
    }
    const category = refusalOf({ error });
    if (category) await refused(category);
    return void res.writeHead(up.status, out).end(text);
  }
  res.writeHead(up.status, out);
  if (!up.body) return void res.end();
  const reader = new ResponsesReader((up.headers.get("content-type") ?? "").includes("event-stream"));
  const stream = Readable.fromWeb(up.body as import("node:stream/web").ReadableStream);
  let settled = false;
  // Once per answer, however it ended: its tokens priced and added, or the call counted as not measured.
  const settle = () => {
    if (settled) return;
    settled = true;
    const { usage, refusal } = reader.result();
    if (refusal) void refused(refusal);
    if (!meter) return;
    const done = usage ? meter.add(run.key, priceTokens(price, usage)) : meter.addUnmeasured(run.key, null);
    void done.catch((e) => console.error("agent meter", (e as Error).message));
  };
  stream.on("data", (c: Buffer) => reader.push(c));
  stream.on("end", settle);
  stream.on("error", () => {
    settle();
    res.destroy();
  });
  res.on("close", settle);
  stream.pipe(res);
}
