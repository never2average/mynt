import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { clerkWebhookEvent } from "./clerk-orgs.js";
import type { WorkspaceSync } from "./workspace-sync.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AdminContext } from "./admin.js";
import { agentProxy } from "./agent-proxy.js";
import type { ClerkAuth } from "./auth.js";
import { RAMP_ADAPTER_WEBHOOK_PATH, rampAdapterWebhook } from "./ramp-adapters/index.js";
import { RAMP_SANDBOX_PATH, rampSandbox } from "./ramp-sandbox.js";
import { createRuntimeApi, type RuntimeApiOptions } from "./runtime-api.js";
import { createServer } from "./server.js";
import { llmsFullCache, llmsTxt } from "./llms-txt.js";
import type { Store, User } from "./store.js";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

// Clerk's authorization server metadata, mirrored on this origin for clients that look for it here.
function authServerMetadata(issuer: string) {
  let cached: { at: number; body: unknown } | null = null;
  return async () => {
    if (!cached || Date.now() - cached.at > 3_600_000) {
      const r = await fetch(`${issuer}/.well-known/oauth-authorization-server`);
      if (!r.ok) throw new Error(`Clerk metadata ${r.status}`);
      cached = { at: Date.now(), body: await r.json() };
    }
    return cached.body;
  };
}

// With Clerk configured, every MCP request needs a Clerk OAuth access token for a whitelisted user;
// local fpm_ tokens and guests are refused. Without it, fpm_ tokens and read-only guests are served.
async function authenticate(
  store: Store,
  clerk: ClerkAuth | null,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ user: User | null } | null> {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;

  if (clerk) {
    const challenge = (extra = "") => `Bearer resource_metadata="${clerk.resourceMetadataUrl}"${extra}`;
    if (!token) {
      sendJson(res, 401, { error: "unauthorized", message: "Sign in with Clerk" }, { "WWW-Authenticate": challenge() });
      return null;
    }
    const result = await clerk.authenticate(token);
    if (!result.ok) {
      const headers: Record<string, string> = result.status === 401 ? { "WWW-Authenticate": challenge(`, error="invalid_token"`) } : {};
      sendJson(res, result.status, { error: result.error, message: result.message }, headers);
      return null;
    }
    return { user: result.user };
  }

  const user = token ? ((await store.userByToken(token)) ?? null) : null;
  if (token && !user) {
    sendJson(res, 401, { error: "Invalid token" }, { "WWW-Authenticate": "Bearer" });
    return null;
  }
  return { user };
}

const TEXT_CACHE = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" };

const sendText = (req: IncomingMessage, res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(req.method === "HEAD" ? undefined : body);
};

// The origin people and agents should use: the configured public URL, else the Host the request came to.
function publicBase(clerk: ClerkAuth | null, runtimeOptions: RuntimeApiOptions, req: IncomingMessage): string {
  const configured = runtimeOptions.publicUrl ?? process.env.PUBLIC_URL ?? (clerk ? clerk.resource.replace(/\/mcp$/, "") : undefined);
  return (configured ?? `http://${req.headers.host ?? "localhost"}`).replace(/\/+$/, "");
}

interface Handlers {
  meta: (() => Promise<unknown>) | null;
  runtime: ReturnType<typeof createRuntimeApi>;
  llmsFull: (base: string) => Promise<string>;
  runtimeOptions: RuntimeApiOptions;
}

async function handle(store: Store, clerk: ClerkAuth | null, ctx: AdminContext, h: Handlers, req: IncomingMessage, res: ServerResponse) {
  const { meta, runtime } = h;
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/healthz") {
    await store.ping();
    return void res.writeHead(200).end("ok");
  }
  // For AI assistants (https://llmstxt.org): markdown served as plain text, no sign-in, no customer data.
  const readOnly = req.method === "GET" || req.method === "HEAD";
  if (readOnly && (url.pathname === "/llms.txt" || url.pathname === "/.well-known/llms.txt")) {
    return sendText(req, res, 200, llmsTxt(publicBase(clerk, h.runtimeOptions, req)), TEXT_CACHE);
  }
  if (readOnly && url.pathname === "/llms-full.txt") {
    return sendText(req, res, 200, await h.llmsFull(publicBase(clerk, h.runtimeOptions, req)), TEXT_CACHE);
  }
  if (readOnly && url.pathname === "/") {
    const base = publicBase(clerk, h.runtimeOptions, req);
    return sendText(req, res, 200, `Mynt MCP server. Connect an MCP client to ${base}/mcp. AI assistants: start at ${base}/llms.txt.\n`, TEXT_CACHE);
  }
  if (clerk && req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    return sendJson(res, 200, clerk.protectedResourceMetadata(), { "Cache-Control": "public, max-age=3600" });
  }
  if (meta && req.method === "GET" && url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
    return sendJson(res, 200, await meta(), { "Cache-Control": "public, max-age=3600" });
  }
  // The identity provider's organization events (workspaces follow them): verified, each handled once.
  if (url.pathname === ORG_WEBHOOK_PATH && req.method === "POST") return orgWebhook(store, ctx.workspaceSync ?? null, req, res);
  // A ramp partner's webhooks, for an offering Mynt runs through an adapter: verified with the partner's own scheme.
  if (url.pathname.startsWith(RAMP_ADAPTER_WEBHOOK_PATH)) return rampAdapterWebhook(store, req, res, url);
  // The runtime API for developers' apps authenticates with app keys, not Clerk.
  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return runtime(req, res, url);
  // The Mynt Ramp's sandbox endpoint: answers only requests Mynt signed for a ramp offering pointed at it.
  if (url.pathname.startsWith(`${RAMP_SANDBOX_PATH}/`)) return rampSandbox(store, req, res, url);
  // Build agents reach Anthropic through Mynt with a per-build token (see agent-proxy.ts).
  if (ctx.builds && url.pathname.startsWith("/agent/")) {
    const builds = ctx.builds;
    const resolve = async (t: string) =>
      (await builds.agentRun(t)) ?? (ctx.bd ? await ctx.bd.agentRun(t) : null) ?? (ctx.desk ? await ctx.desk.agentRun(t) : null) ?? (ctx.review ? await ctx.review.agentRun(t) : null) ?? (ctx.explore ? await ctx.explore.agentRun(t) : null) ?? (ctx.gate ? await ctx.gate.agentRun(t) : null);
    return agentProxy(builds.config.agentBackend, resolve, req, res, url, {
      meter: builds.meter,
      model: builds.config.model,
      models: (process.env.AGENT_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean),
    });
  }
  // One-click opt-out from the connector's messages.
  if (ctx.bd && url.pathname === "/bd/unsubscribe" && (req.method === "GET" || req.method === "POST")) {
    const done = await ctx.bd.unsubscribe(url.searchParams.get("c") ?? "", url.searchParams.get("s") ?? "");
    res.writeHead(done ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" });
    return void res.end(done ? "You won't hear from Mynt's connector again." : "This link isn't valid.");
  }
  // Connector agent runs reach Mynt's MCP server with their run token, as the agent, not as a person.
  const bearer = req.headers.authorization?.startsWith("Bearer mynt_bd_") ? req.headers.authorization.slice(7).trim() : null;
  if (bearer && url.pathname === "/mcp") {
    const run = ctx.bd ? await ctx.bd.runForToken(bearer) : undefined;
    if (!run) return sendJson(res, 401, { error: "invalid_token", message: "This connector run isn't active" });
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
    return serveMcp(createServer(store, null, { ...ctx, bdRun: { id: run.id as string } }), req, res);
  }
  if (url.pathname !== "/mcp") {
    const base = publicBase(clerk, h.runtimeOptions, req);
    return sendText(req, res, 404, `Not found. Mynt's MCP endpoint is ${base}/mcp; start at ${base}/llms.txt.\n`);
  }
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();

  const authed = await authenticate(store, clerk, req, res);
  if (!authed) return;

  return serveMcp(createServer(store, authed.user, ctx), req, res);
}

async function serveMcp(server: ReturnType<typeof createServer>, req: IncomingMessage, res: ServerResponse) {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return void res.writeHead(400).end("Invalid JSON");
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export function createMcpHttpServer(
  store: Store,
  clerk: ClerkAuth | null = null,
  ctx: AdminContext = {},
  runtimeOptions: RuntimeApiOptions = {},
): Server {
  const meta = clerk ? authServerMetadata(clerk.issuer) : null;
  const runtime = createRuntimeApi(store, { hosting: ctx.hosting ?? null, ...runtimeOptions });
  const handlers: Handlers = { meta, runtime, llmsFull: llmsFullCache(store, ctx), runtimeOptions };
  return createHttpServer((req, res) =>
    handle(store, clerk, ctx, handlers, req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }),
  );
}

// POST /webhooks/clerk: the identity provider's organization, membership and invitation events, signed with
// CLERK_WEBHOOK_SECRET (off when that isn't set). Verified by the provider's own library, which also refuses an old
// or replayed signature; each event id is handled once, and a failure lets the provider deliver it again.
export const ORG_WEBHOOK_PATH = "/webhooks/clerk";
async function orgWebhook(store: Store, sync: WorkspaceSync | null, req: IncomingMessage, res: ServerResponse) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret || !sync) return void res.writeHead(404).end();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) return void res.writeHead(413).end();
    chunks.push(c as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  let parsed: Awaited<ReturnType<typeof clerkWebhookEvent>>;
  try {
    parsed = await clerkWebhookEvent(new Request("http://localhost" + ORG_WEBHOOK_PATH, { method: "POST", headers, body: Buffer.concat(chunks) }), secret);
  } catch {
    return void res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "invalid signature" }));
  }
  const fresh = await store.db.query("INSERT INTO financial_products.org_webhook_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id", [parsed.id, parsed.event?.type ?? null]);
  if (!fresh.rows.length) return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ duplicate: true }));
  try {
    if (parsed.event) await sync.handle(parsed.event);
  } catch (e) {
    await store.db.query("DELETE FROM financial_products.org_webhook_events WHERE id = $1", [parsed.id]).catch(() => undefined);
    console.error(`organization webhook: ${(e as Error).message}`);
    return void res.writeHead(500).end();
  }
  return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
}
