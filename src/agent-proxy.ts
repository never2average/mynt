import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { AgentBackend } from "./agent-host.js";
import { priceUsage, UsageReader, type AgentMeter } from "./agent-meter.js";

// Claude Code in a build sandbox reaches the model only through here, authenticated by its build's
// token, which works only while that build is running. Mynt adds its own credentials and streams the
// response straight back; the sandbox never sees them. Two backends:
//   - Anthropic API: ANTHROPIC_BASE_URL=<public>/agent, token as the bearer; /agent/v1/messages[...]
//   - Vertex AI: ANTHROPIC_VERTEX_BASE_URL=<public>/agent/t/<token>/v1 with Claude Code's Google auth
//     skipped; Mynt pins the project and region, and signs with its service account.

const ANTHROPIC_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const VERTEX_PATH = /^\/v1\/projects\/[^/]+\/locations\/[^/]+\/publishers\/anthropic\/models\/(claude-[a-z0-9.@-]+|count-tokens):(rawPredict|streamRawPredict)$/;
const FORWARD_REQUEST = ["content-type", "anthropic-version", "anthropic-beta", "accept"];
const FORWARD_RESPONSE = ["content-type", "request-id", "retry-after", "anthropic-ratelimit-requests-remaining", "anthropic-ratelimit-tokens-remaining"];
const MAX_BODY = 32 * 1024 * 1024;

const reply = (res: ServerResponse, status: number, message: string) =>
  void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "mynt_proxy_error", message } }));

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

export const vertexHost = (region: string) => (region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`);

// The run a live agent token belongs to (a build, a desk job, a review case, a connector run) and its budget.
export interface AgentRun {
  key: string;
  capUsd: number;
}

export interface ProxyOptions {
  // Meters every response against its run, and refuses calls once the run's budget is spent.
  meter?: AgentMeter | null;
  // The model agents run on; a request for one outside `models` is sent to this one instead (a tool that pins a
  // model the deployment doesn't serve would otherwise fail outright).
  model?: string;
  models?: string[];
}

// `resolve` finds the live run behind a token (or null when it isn't live).
export async function agentProxy(backend: AgentBackend | null, resolve: (token: string) => Promise<AgentRun | null>, req: IncomingMessage, res: ServerResponse, url: URL, opts: ProxyOptions = {}) {
  if (!backend) return reply(res, 503, "Builds aren't enabled");
  if (req.method !== "POST") return reply(res, 404, "Not found");

  const allowed = (m: string) => !opts.model || m === "count-tokens" || [opts.model, ...(opts.models ?? [])].includes(m);
  let token: string;
  let upstream: string;
  let model = "";
  let counting = false;
  const headers: Record<string, string> = {};
  if (backend.kind === "vertex") {
    const m = /^\/agent\/t\/([A-Za-z0-9_-]+)(\/.*)$/.exec(url.pathname);
    const route = m && VERTEX_PATH.exec(m[2]);
    if (!m || !route) return reply(res, 404, "Not found");
    token = m[1];
    model = allowed(route[1]) ? route[1] : opts.model!;
    counting = route[1] === "count-tokens";
    upstream = `https://${vertexHost(backend.region)}/v1/projects/${backend.projectId}/locations/${backend.region}/publishers/anthropic/models/${model}:${route[2]}`;
  } else {
    const path = url.pathname.slice("/agent".length);
    if (!ANTHROPIC_PATHS.has(path)) return reply(res, 404, "Not found");
    const auth = req.headers.authorization ?? "";
    token = auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-api-key"] ?? "");
    upstream = `https://api.anthropic.com${path}${url.search}`;
    headers["x-api-key"] = backend.apiKey;
    counting = path.endsWith("/count_tokens");
  }
  const run = token ? await resolve(token) : null;
  if (!run) return reply(res, 401, "This agent token isn't active");
  if (opts.meter && (await opts.meter.spent(run.key)) >= run.capUsd) return reply(res, 402, `This run's model budget (US$${run.capUsd}) is spent`);
  let body = await readBody(req);
  if (!body) return reply(res, 413, "Request too large");
  if (backend.kind !== "vertex") {
    try {
      const json = JSON.parse(body.toString("utf8")) as { model?: string };
      model = json.model ?? "";
      if (model && !allowed(model)) {
        model = opts.model!;
        body = Buffer.from(JSON.stringify({ ...json, model }));
      }
    } catch {
      // not JSON: forwarded as is
    }
  }
  for (const h of FORWARD_REQUEST) {
    const v = req.headers[h];
    if (typeof v === "string") headers[h] = v;
  }
  if (backend.kind === "vertex") {
    try {
      headers.authorization = `Bearer ${await backend.auth.accessToken()}`;
    } catch {
      return reply(res, 502, "Couldn't get a Google Cloud access token");
    }
  }

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  let up: Response;
  try {
    up = await fetch(upstream, { method: "POST", headers, body: new Uint8Array(body), signal: abort.signal });
  } catch {
    return reply(res, 502, "Couldn't reach the model provider");
  }
  const out: Record<string, string> = { "Cache-Control": "no-cache, no-transform" };
  for (const h of FORWARD_RESPONSE) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body) return void res.end();
  const stream = Readable.fromWeb(up.body as import("node:stream/web").ReadableStream).on("error", () => res.destroy());
  if (opts.meter && up.ok && !counting) {
    const meter = opts.meter;
    const reader = new UsageReader((up.headers.get("content-type") ?? "").includes("event-stream"));
    stream.on("data", (c: Buffer) => reader.push(c));
    stream.on("end", () => void meter.add(run.key, priceUsage(model, reader.result())).catch((e) => console.error("agent meter", e)));
  }
  stream.pipe(res);
}
