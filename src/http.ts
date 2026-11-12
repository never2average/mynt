import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AdminContext } from "./admin.js";
import { agentProxy } from "./agent-proxy.js";
import { GIT_CALLBACK_PATH, GIT_START_PATH, stateCookieName } from "./repo-ownership.js";
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
  // A ramp partner's webhooks, for an offering Mynt runs through an adapter: verified with the partner's own scheme.
  if (url.pathname.startsWith(RAMP_ADAPTER_WEBHOOK_PATH)) return rampAdapterWebhook(store, req, res, url);
  // The runtime API for developers' apps authenticates with app keys, not Clerk.
  if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) return runtime(req, res, url);
  // The Mynt Ramp's sandbox endpoint: answers only requests Mynt signed for a ramp offering pointed at it.
  if (url.pathname.startsWith(`${RAMP_SANDBOX_PATH}/`)) return rampSandbox(store, req, res, url);
  // Linking a person's git account (repo-ownership.ts). The start link (from connect_git_account) sets a host-only
  // cookie with a hash of the state and sends the browser to the host; the host sends it back to the callback, which
  // needs that cookie, and shows a one-time code that only the Mynt account that started the sign-in can confirm.
  // Nothing about the token is ever shown.
  if (ctx.ownership && req.method === "GET" && (url.pathname === GIT_START_PATH || url.pathname === GIT_CALLBACK_PATH)) {
    const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY" };
    const state = url.searchParams.get("state") ?? "";
    // The sign-in's cookie is spent at the callback, whatever happens there.
    const clear = state && url.pathname === GIT_CALLBACK_PATH ? { "set-cookie": `${stateCookieName(state)}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } : {};
    const page = (status: number, text: string) => void res.writeHead(status, { ...headers, ...clear }).end(text);
    try {
      if (url.pathname === GIT_START_PATH) {
        if (!state) return page(400, "This link is incomplete. Start again with connect_git_account.");
        const go = await ctx.ownership.startRedirect(state);
        return void res
          .writeHead(302, { ...headers, location: go.location, "set-cookie": `${go.cookieName}=${go.cookie}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax` })
          .end();
      }
      const code = url.searchParams.get("code") ?? "";
      if (!state || !code) return page(400, "This link is incomplete, or the sign-in was declined. Start again with connect_git_account.");
      const name = stateCookieName(state);
      const cookie = (req.headers.cookie ?? "")
        .split(";")
        .map((c) => c.trim().split("="))
        .find(([k]) => k === name)?.[1];
      const done = await ctx.ownership.callback(state, code, cookie ?? null);
      const account = `${done.mynt_account.name}${done.mynt_account.firm ? ` (${done.mynt_account.firm})` : ""}`;
      return page(
        200,
        [
          `You signed in on your git host as ${done.login ?? "(unknown)"}.`,
          `Confirming links that git account to the Mynt account ${account}.`,
          "",
          "If that isn't your Mynt account, or you didn't start this yourself, stop here: close this tab, and nothing is linked.",
          "",
          "Otherwise, one step left, in the Mynt assistant you started from:",
          "",
          `    confirm_git_account ${done.confirm_code}`,
          "",
          "It expires in ten minutes, and only that Mynt account can confirm it.",
          "Never share this code: Mynt never asks for it, and no one else needs it.",
        ].join("\n"),
      );
    } catch (e) {
      return page(400, (e as Error).message);
    }
  }

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
