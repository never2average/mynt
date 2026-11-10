import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accessStatus, BuildTermsSchema, productsAnsweredBy, type ExperienceCheck } from "./access.js";
import { DuplicateError, type AccessRequest, type App, type Handoff, type ProductRecord, type Store, type User } from "./store.js";
import { open } from "./vault.js";
import { isBlockedAddress, resolveVendorUrl, safePost, type VendorCallOptions } from "./vendor-call.js";

// The runtime layer: what a developer's shipped app talks to. Per-app API keys for the REST API
// (src/runtime-api.ts), webhooks, a sandbox, app releases and analytics.

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export const WEBHOOK_EVENTS = [
  "product.version_published",
  "product.unpublished",
  "product.suspended",
  "product.drifted",
  "product.drift_cleared",
  "access.approved",
  "access.revoked",
  "request.decided",
  "handoff.completed",
  "handoff.failed",
  "handoff.reversed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const HANDOFF_ACTIONS = ["deep_link", "initiate_onboarding"] as const;
export const APP_EVENT_TYPES = ["view", "click", "handoff_started"] as const;

// ---- products an app may show ----

// Published, and still accessible to the app's developer for this app (innovators can revoke or
// suspend access at any time, and the product drops out at once).
export async function appProducts(store: Store, app: App): Promise<ProductRecord[]> {
  const owner = await store.getUser(app.owner_id);
  if (!owner) return [];
  const out: ProductRecord[] = [];
  for (const id of app.product_ids) {
    const record = await store.getProduct(id);
    if (record?.status === "published" && (await accessStatus(store, owner, record, app.id)).granted) out.push(record);
  }
  return out;
}

// Whether developers can build on a product: it's published with a developer contract (a v2 definition),
// names a real regulator, and its rate data agrees with itself. Anything else is hidden from developers'
// catalogue (list_products with developer_ready) until its firm fixes it; the reasons say what to fix.
const PLACEHOLDER_REGULATOR = /\be\.g\.|^banking regulator$|\b(unknown|tbd|todo|placeholder|n\/a)\b/i;
export function developerReadiness(record: ProductRecord): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const p = record.product;
  if (record.status !== "published") reasons.push("not published");
  if (!record.pins?.contract) reasons.push("no developer contract (published without a v2 definition)");
  if (!p.regulator?.trim() || PLACEHOLDER_REGULATOR.test(p.regulator.trim())) reasons.push(`placeholder regulator '${p.regulator ?? ""}'`);
  const features = p.key_features.join(" ").toLowerCase();
  if (p.return_type === "fixed_interest" && /\b(variable|floating)\b[^.]*\brate\b/.test(features)) reasons.push("return_type is fixed_interest but its features say the rate is variable");
  if (p.return_type === "variable_interest" && /\b(fixed|locked)\b[^.]*\brate\b|\brate (is )?(fixed|locked)\b/.test(features)) reasons.push("return_type is variable_interest but its features say the rate is fixed");
  return { ready: reasons.length === 0, reasons };
}

export const buildTerms = (record: ProductRecord) => ({ ...BuildTermsSchema.parse({}), ...record.build_terms });

// ---- webhook events ----

// Set by a running worker so new events go out without waiting for its next tick.
let kick: (() => void) | null = null;

// Queues `type` for every webhook of `appIds` subscribed to it.
export async function emitEvent(store: Store, appIds: string[], type: WebhookEvent, data: Record<string, unknown>, sandbox = false) {
  const payload = { id: randomUUID(), type, created_at: new Date().toISOString(), data };
  if ((await store.enqueueEvent([...new Set(appIds)], payload, sandbox)) > 0) kick?.();
}

// Events a firm (an innovator) gets at its own webhooks, about what Mynt did for it: a client action its
// product's bound vendor service answered, with the full result (sealed while queued, opened only to send).
// vendor_action.reversed: a completed ramp transfer the partner later reversed; vendor_action.late_settlement: one
// it settled after Mynt had ended the run (to handle by hand); ramp_link.requested: to the Mynt Ramp firm, a
// customer asked to be linked to the ramp partner (link_ramp_partner_customer).
// program.deployed, program.upgraded, program.event: the firm's Solana programs (src/solana/), deployed or upgraded by
// Mynt, and each Anchor event they emit. program.upgrade_scheduled, program.upgrade_cancelled: a mainnet upgrade
// passed the mainnet program gate and is announced before its timelock ends, or was cancelled or rejected.
// program.review_flagged: a new vulnerability database version refuses a deployed mainnet program (it keeps
// running; its upgrades wait for an admin's review).
// covenant.breached, covenant.cleared: to a licence provider, one of its rules on a sponsored product tripped or
// passed again (covenants.ts), with the observed value sealed until it's sent.
// Developer-side data only; customers never see it.
export const FIRM_WEBHOOK_EVENTS = [
  "vendor_action.completed",
  "vendor_action.failed",
  "vendor_action.reversed",
  "vendor_action.late_settlement",
  "ramp_link.requested",
  "program.deployed",
  "program.upgraded",
  "program.event",
  "program.upgrade_scheduled",
  "program.upgrade_cancelled",
  "program.review_flagged",
  "covenant.breached",
  "covenant.cleared",
] as const;
export type FirmWebhookEvent = (typeof FIRM_WEBHOOK_EVENTS)[number];

// Queues `type` for every webhook of the firm subscribed to it. `sealedResult` (sealed with the sandbox or live
// key, as `sandbox` says) goes out as data.result.
export async function emitFirmEvent(store: Store, entityId: string, type: FirmWebhookEvent, data: Record<string, unknown>, sandbox: boolean, sealedResult?: string) {
  const payload = { id: randomUUID(), type, created_at: new Date().toISOString(), data: { ...data, ...(sealedResult ? { result_sealed: sealedResult } : {}) } };
  if ((await store.enqueueFirmEvent(entityId, payload, sandbox)) > 0) kick?.();
}

// A queued payload as sent: a sealed result is opened into data.result.
function wireBody(payload: unknown, sandbox: boolean): string {
  const p = payload as { data?: Record<string, unknown> };
  const sealed = p?.data?.result_sealed;
  if (typeof sealed !== "string") return JSON.stringify(payload);
  const { result_sealed, ...data } = p.data!;
  return JSON.stringify({ ...p, data: { ...data, result: JSON.parse(open(sealed, sandbox)) } });
}

// To every app that includes the product.
export async function emitProductEvent(store: Store, productId: string, type: WebhookEvent, data: Record<string, unknown> = {}) {
  const apps = await store.appsUsingProduct(productId);
  await emitEvent(store, apps.map((a) => a.id), type, { product_id: productId, ...data });
}

// To the app a request was for or, for an invitation (no app), every app of the developer using the product.
export async function emitRequestEvent(store: Store, r: AccessRequest, type: WebhookEvent, data: Record<string, unknown> = {}) {
  const appIds = r.app_id
    ? [r.app_id]
    : (await store.appsByOwner(r.requester_id)).filter((a) => a.product_ids.includes(r.product_id)).map((a) => a.id);
  await emitEvent(store, appIds, type, { request_id: r.id, product_id: r.product_id, ...data });
}

export async function resolveHandoff(store: Store, handoff: Handoff, outcome: "completed" | "failed") {
  const resolved = await store.resolveHandoff(handoff.id, outcome);
  if (!resolved) return undefined;
  await emitEvent(
    store,
    [resolved.app_id],
    outcome === "completed" ? "handoff.completed" : "handoff.failed",
    { handoff_id: resolved.id, product_id: resolved.product_id, action: resolved.action, consumer_ref: resolved.consumer_ref, sandbox: resolved.sandbox },
    resolved.sandbox,
  );
  return resolved;
}

// https only in production, and never to loopback or private addresses; plain http to loopback is
// allowed outside production for local testing.
export function webhookUrlProblem(raw: string, production = process.env.NODE_ENV === "production"): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a valid URL";
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
  if (url.username || url.password) return "URLs with credentials aren't allowed";
  if (url.protocol === "http:" && loopback && !production) return null;
  if (url.protocol !== "https:") return "Webhook URLs must use https";
  // Every private, loopback, link-local, carrier-grade NAT or reserved address, in any notation (IPv4-mapped
  // IPv6 included), by the same rules as calls to vendors.
  const privateIp = isIP(host) !== 0 && isBlockedAddress(host);
  if (loopback || privateIp || host.endsWith(".internal") || host.endsWith(".local")) return "Webhook URLs must be publicly reachable";
  return null;
}

// The same rules, plus what the host resolves to now (a public name pointing at a private address is refused).
// Deliveries check again at send time and connect only to the address they checked.
export async function checkWebhookUrl(raw: string, production = process.env.NODE_ENV === "production"): Promise<string | null> {
  const problem = webhookUrlProblem(raw, production);
  if (problem) return problem;
  try {
    await resolveVendorUrl(raw, webhookOutbound(production));
  } catch (e) {
    return `Webhook URLs must be publicly reachable (${(e as Error).message})`;
  }
  return null;
}
// How webhooks go out: the vendors' outbound guard, on any https port; plain http to loopback only outside production.
const webhookOutbound = (production = process.env.NODE_ENV === "production", timeoutMs?: number): VendorCallOptions => ({
  anyPort: true,
  anyBody: true,
  allowInsecureLoopback: !production,
  timeoutMs,
});

export const signWebhook = (secret: string, timestamp: number, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

export interface WebhookWorkerOptions {
  intervalMs?: number; // how often due deliveries are sent (default 5s)
  timeoutMs?: number; // per request (default 10s)
  maxAttempts?: number; // then the delivery is marked failed (default 8)
  batch?: number;
}

// Seconds before retry n (1-based): 30s, 1m, 2m, 4m … capped at 6h.
export const retryDelay = (attempt: number) => Math.min(30 * 2 ** (attempt - 1), 6 * 3600);

// Sends every delivery due at `now` once. Tests pass a later `now` to skip the backoff.
export async function deliverDueWebhooks(store: Store, opts: WebhookWorkerOptions & { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const result = { attempted: 0, delivered: 0, failed: 0 };
  for (;;) {
    const due = await store.claimDueDeliveries(now, opts.batch ?? 20);
    if (due.length === 0) return result;
    await Promise.all(
      due.map(async (d) => {
        const t = Math.floor(Date.now() / 1000);
        let code: number | null = null;
        let error: string | null = null;
        try {
          const body = wireBody(d.payload, d.sandbox);
          // Resolved, checked and pinned like a call to a vendor: never a private address, never a redirect.
          const res = await safePost(d.url, body, { "User-Agent": "Mynt-Webhooks/1", "Mynt-Signature": `t=${t},v1=${signWebhook(d.secret, t, body)}` }, webhookOutbound(undefined, opts.timeoutMs));
          code = res.http_status;
          error = res.error;
        } catch (e) {
          error = (e as Error).message.slice(0, 500);
        }
        const ok = code !== null && code >= 200 && code < 300;
        const attempts = d.attempts + 1;
        const retry = !ok && attempts < (opts.maxAttempts ?? 8) ? new Date(now.getTime() + retryDelay(attempts) * 1000) : null;
        await store.recordDeliveryAttempt(d.id, { ok, code, error: ok ? null : (error ?? `HTTP ${code}`), next_attempt_at: retry });
        result.attempted++;
        if (ok) result.delivered++;
        else if (!retry) result.failed++;
      }),
    );
  }
}

// A small in-process worker. Deliveries live in the database, so several server processes can
// run one each; flush() sends whatever is due now.
export function startWebhookWorker(store: Store, opts: WebhookWorkerOptions = {}) {
  let running: Promise<unknown> | null = null;
  const flush = () => (running ??= deliverDueWebhooks(store, opts).finally(() => (running = null)));
  const tick = () => void flush().catch((e) => console.error("webhooks:", e));
  const timer = setInterval(tick, opts.intervalMs ?? 5000);
  timer.unref();
  kick = tick;
  return {
    flush,
    stop() {
      clearInterval(timer);
      if (kick === tick) kick = null;
    },
  };
}

// ---- metrics ----

const METRIC_KINDS: Record<string, string> = {
  view: "views",
  click: "clicks",
  handoff_started: "handoff_events",
  "handoff:started": "handoffs_started",
  "handoff:completed": "handoffs_completed",
  "handoff:failed": "handoffs_failed",
};

const blank = () => ({ views: 0, clicks: 0, handoff_events: 0, handoffs_started: 0, handoffs_completed: 0, handoffs_failed: 0 });
type Counts = ReturnType<typeof blank>;
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 10_000) / 10_000 : null);
const withRates = (c: Counts) => ({
  ...c,
  conversion_rate: rate(c.handoffs_completed, c.views),
  handoff_completion_rate: rate(c.handoffs_completed, c.handoffs_started),
});

function rollUp(rows: { day: string; kind: string; n: number }[], key: (r: never) => string) {
  const totals = blank();
  const groups = new Map<string, Counts>();
  for (const r of rows) {
    const field = METRIC_KINDS[r.kind] as keyof Counts | undefined;
    if (!field) continue;
    totals[field] += r.n;
    const k = key(r as never);
    const g = groups.get(k) ?? blank();
    g[field] += r.n;
    groups.set(k, g);
  }
  return { totals: withRates(totals), groups: [...groups].map(([k, c]) => [k, withRates(c)] as const) };
}

const dateRange = (from?: string, to?: string) => {
  const end = to ?? new Date().toISOString().slice(0, 10);
  const start = from ?? new Date(Date.parse(end) - 29 * 86_400_000).toISOString().slice(0, 10);
  return { from: start, to: end, toExclusive: new Date(Date.parse(end) + 86_400_000).toISOString() };
};

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// ---- semver ----

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function compareSemver(a: string, b: string): number {
  const [, a1, a2, a3, ap] = a.match(SEMVER)!;
  const [, b1, b2, b3, bp] = b.match(SEMVER)!;
  for (const [x, y] of [[a1, b1], [a2, b2], [a3, b3]]) if (Number(x) !== Number(y)) return Number(x) - Number(y);
  if (!ap || !bp) return ap ? -1 : bp ? 1 : 0;
  const pa = ap.split(".");
  const pb = bp.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]);
    const nb = /^\d+$/.test(pb[i]);
    if (na && nb && Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// publish_app records a first release when an app has none, so rollback has something to go back to.
export async function ensureRelease(store: Store, app: App, userId: string) {
  if ((await store.appReleases(app.id)).length === 0) await store.createAppRelease(app.id, "1.0.0", "Initial release (publish_app)", userId);
}

export type Readiness = (app: App) => Promise<{
  access: { product_id: string; granted: boolean; status: string }[];
  lint: { passed: boolean; checks: ExperienceCheck[] };
  structure?: { passed: boolean; checks: { status: string }[] };
}>;

// ---- developer tools ----

// Developers: keys, webhooks, sandbox, releases and metrics for their own apps. `readiness` is
// publish_app's check, so releases and rollbacks pass exactly the same gate.
export function registerRuntimeTools(server: McpServer, store: Store, user: User, readiness: Readiness) {
  const audit = (action: string, target: string, details: unknown = {}) => store.audit(user.id, action, target, details);
  const ownApp = async (id: string) => {
    const app = await store.getApp(id);
    return app && app.owner_id === user.id ? app : undefined;
  };
  const ownKey = async (id: string) => {
    const key = await store.getApiKey(id);
    return key && (await ownApp(key.app_id)) ? key : undefined;
  };
  const ownWebhook = async (id: string) => {
    const hook = await store.getWebhook(id);
    return hook && (await ownApp(hook.app_id)) ? hook : undefined;
  };
  const notReady = (r: Awaited<ReturnType<Readiness>>) => {
    const blocked = r.access.filter((a) => !a.granted);
    const structureOk = r.structure?.passed ?? true;
    if (!blocked.length && r.lint.passed && structureOk) return null;
    return {
      ...json({
        error: "The experience doesn't meet its products' terms",
        access_needed: blocked.map((b) => ({ product_id: b.product_id, status: b.status })),
        failed_checks: [...r.lint.checks, ...(r.structure?.checks ?? [])].filter((c) => c.status === "fail"),
      }),
      isError: true,
    };
  };

  // ---- API keys ----

  const origin = z.string().refine((o) => {
    try {
      return new URL(o).origin === o;
    } catch {
      return false;
    }
  }, "An origin like https://app.example.com (scheme, host and optional port, nothing else)");

  server.registerTool(
    "create_api_key",
    {
      title: "Create an API key for an app",
      description:
        "Developer: a key your app uses to call Mynt's runtime API (/v1). live keys (mynt_live_…) work once the app is published; sandbox keys (mynt_test_…) work on drafts and simulate hand-offs. The key is shown once; Mynt keeps only its hash. List allowed_origins to call the API from browsers on those origins.",
      inputSchema: {
        app_id: z.string(),
        environment: z.enum(["live", "sandbox"]),
        label: z.string().min(1).max(100),
        allowed_origins: z.array(origin).max(20).default([]).describe("Browser origins allowed to use this key (CORS); empty: server-side only"),
      },
    },
    async ({ app_id, environment, label, allowed_origins }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const { key, secret } = await store.createApiKey(user.id, { app_id: app.id, environment, label, allowed_origins });
      await audit("create_api_key", key.id, { app_id: app.id, environment, label });
      return json({
        ...key,
        key: secret,
        note:
          environment === "live" && app.status !== "published"
            ? "Save this key now; it can't be shown again. It works once the app is published."
            : "Save this key now; it can't be shown again.",
      });
    },
  );

  server.registerTool(
    "list_api_keys",
    {
      title: "An app's API keys",
      description: "Developer: the keys of one of your apps (prefix, environment, origins, status, last use). Secrets are never shown again.",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      if (!(await ownApp(app_id))) return fail(`No app with id '${app_id}'`);
      return json(await store.apiKeysForApp(app_id));
    },
  );

  server.registerTool(
    "rotate_api_key",
    {
      title: "Rotate an API key",
      description: "Developer: replace a key's secret. The old secret stops working at once; the new one is shown once.",
      inputSchema: { key_id: z.string() },
    },
    async ({ key_id }) => {
      const key = await ownKey(key_id);
      if (!key) return fail(`No API key '${key_id}'`);
      if (key.status !== "active") return fail("The key is revoked; create a new one");
      const rotated = await store.rotateApiKey(key.id, key.environment);
      await audit("rotate_api_key", key.id, { app_id: key.app_id });
      return json({ ...rotated.key, key: rotated.secret, note: "Save this key now; it can't be shown again." });
    },
  );

  server.registerTool(
    "revoke_api_key",
    {
      title: "Revoke an API key",
      description: "Developer: permanently disable a key. Requests with it are refused from now on.",
      inputSchema: { key_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ key_id }) => {
      const key = await ownKey(key_id);
      if (!key) return fail(`No API key '${key_id}'`);
      if (key.status !== "active") return fail("The key is already revoked");
      const revoked = await store.revokeApiKey(key.id);
      await audit("revoke_api_key", key.id, { app_id: key.app_id });
      return json(revoked);
    },
  );

  // ---- webhooks ----

  server.registerTool(
    "create_webhook",
    {
      title: "Register a webhook",
      description:
        "Developer: receive events about one of your apps' products at an https URL: product.version_published, product.unpublished, product.suspended, product.drifted, product.drift_cleared, access.approved, access.revoked, request.decided, handoff.completed, handoff.failed, handoff.reversed (a completed Mynt Ramp transfer the bank later sent back). Each POST carries a Mynt-Signature header (t=<unix>,v1=<HMAC-SHA256 of \"t.body\" with the secret>). The secret is shown once.",
      inputSchema: { app_id: z.string(), url: z.string(), events: z.array(z.enum(WEBHOOK_EVENTS)).min(1) },
    },
    async ({ app_id, url, events }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const problem = await checkWebhookUrl(url);
      if (problem) return fail(problem);
      if ((await store.webhooksForApps([app.id])).length >= 10) return fail("An app can have at most 10 webhooks");
      const { webhook, secret } = await store.createWebhook(user.id, { app_id: app.id, url, events: [...new Set(events)] });
      await audit("create_webhook", webhook.id, { app_id: app.id, url, events: webhook.events });
      return json({ ...webhook, secret, note: "Save the signing secret now; it can't be shown again." });
    },
  );

  server.registerTool(
    "list_webhooks",
    {
      title: "My webhooks",
      description: "Developer: the webhooks of your apps (or of one app).",
      inputSchema: { app_id: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      if (app_id && !(await ownApp(app_id))) return fail(`No app with id '${app_id}'`);
      const ids = app_id ? [app_id] : (await store.appsByOwner(user.id)).map((a) => a.id);
      return json(await store.webhooksForApps(ids));
    },
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete a webhook",
      description: "Developer: stop sending events to a webhook, and drop its delivery history.",
      inputSchema: { webhook_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ webhook_id }) => {
      const hook = await ownWebhook(webhook_id);
      if (!hook) return fail(`No webhook '${webhook_id}'`);
      await store.deleteWebhook(hook.id);
      await audit("delete_webhook", hook.id, { app_id: hook.app_id, url: hook.url });
      return json({ deleted: hook.id });
    },
  );

  server.registerTool(
    "rotate_webhook_secret",
    {
      title: "Rotate a webhook's signing secret",
      description: "Developer: a new signing secret for a webhook, shown once. Deliveries from now on are signed with it.",
      inputSchema: { webhook_id: z.string() },
    },
    async ({ webhook_id }) => {
      const hook = await ownWebhook(webhook_id);
      if (!hook) return fail(`No webhook '${webhook_id}'`);
      const secret = await store.rotateWebhookSecret(hook.id);
      await audit("rotate_webhook_secret", hook.id, { app_id: hook.app_id });
      return json({ ...hook, secret, note: "Save the signing secret now; it can't be shown again." });
    },
  );

  server.registerTool(
    "list_webhook_deliveries",
    {
      title: "Webhook deliveries",
      description: "Developer: recent deliveries to one of your webhooks, newest first, with status (pending, delivered, failed), attempts and the last response code.",
      inputSchema: { webhook_id: z.string(), limit: z.number().int().min(1).max(200).default(50) },
      annotations: { readOnlyHint: true },
    },
    async ({ webhook_id, limit }) => {
      const hook = await ownWebhook(webhook_id);
      if (!hook) return fail(`No webhook '${webhook_id}'`);
      return json(await store.webhookDeliveries(hook.id, limit));
    },
  );

  // ---- sandbox ----

  server.registerTool(
    "create_test_consumer",
    {
      title: "Create a sandbox test consumer",
      description: "Developer: an opaque consumer_ref to use as a test user in sandbox hand-offs. It identifies nobody and carries no personal or financial data.",
      inputSchema: { app_id: z.string(), label: z.string().min(1).max(100) },
    },
    async ({ app_id, label }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      return json(await store.createTestConsumer(app.id, label));
    },
  );

  server.registerTool(
    "simulate_handoff",
    {
      title: "Resolve a sandbox hand-off",
      description: "Developer: finish one of your app's sandbox hand-offs as completed or failed, which sends handoff.completed or handoff.failed to your webhooks.",
      inputSchema: { handoff_id: z.string(), outcome: z.enum(["completed", "failed"]) },
    },
    async ({ handoff_id, outcome }) => {
      const h = await store.getHandoff(handoff_id);
      if (!h || !h.sandbox || !(await ownApp(h.app_id))) return fail(`No sandbox hand-off '${handoff_id}' for your apps`);
      const resolved = await resolveHandoff(store, h, outcome);
      return resolved ? json(resolved) : fail(`Hand-off is already ${h.status}`);
    },
  );

  // ---- releases ----

  server.registerTool(
    "release_app",
    {
      title: "Release a version of an app",
      description:
        "Developer: publish one of your apps as a numbered release. Runs publish_app's checks, then snapshots the whole app definition. Versions are semver (e.g. 1.2.0) and must increase.",
      inputSchema: {
        app_id: z.string(),
        version: z.string().regex(SEMVER, "Use a semver version such as 1.2.0"),
        changelog: z.string().min(3),
      },
    },
    async ({ app_id, version, changelog }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const latest = (await store.appReleases(app.id)).map((r) => r.version).sort(compareSemver).at(-1);
      if (latest && compareSemver(version, latest) <= 0) return fail(`Version must be greater than the latest release, ${latest}`);
      const blocked = notReady(await readiness(app));
      if (blocked) return blocked;
      await store.saveApp({ ...app, status: "published" });
      try {
        const { snapshot, ...release } = await store.createAppRelease(app.id, version, changelog, user.id);
        await audit("release_app", app.id, { version });
        return json({ ...release, status: "published" });
      } catch (e) {
        if (e instanceof DuplicateError) return fail(e.message);
        throw e;
      }
    },
  );

  server.registerTool(
    "list_app_releases",
    {
      title: "An app's releases",
      description: "Developer: the releases of one of your apps, oldest first, with changelogs.",
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      if (!(await ownApp(app_id))) return fail(`No app with id '${app_id}'`);
      return json((await store.appReleases(app_id)).map(({ snapshot, ...r }) => r));
    },
  );

  server.registerTool(
    "rollback_app",
    {
      title: "Roll an app back to a release",
      description:
        "Developer: make an earlier release's definition the app's current one. It must still pass the products' current terms and access (checked as publish_app does).",
      inputSchema: { app_id: z.string(), version: z.string() },
    },
    async ({ app_id, version }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const release = (await store.appReleases(app.id)).find((r) => r.version === version);
      if (!release) return fail(`No release ${version} of this app; see list_app_releases`);
      const candidate = { ...app, ...release.snapshot, id: app.id, owner_id: app.owner_id, status: app.status } as App;
      const blocked = notReady(await readiness(candidate));
      if (blocked) return blocked;
      const restored = await store.restoreAppSnapshot(app.id, release.snapshot);
      await audit("rollback_app", app.id, { version });
      return json({ rolled_back_to: version, app: restored });
    },
  );

  // ---- analytics ----

  server.registerTool(
    "get_app_metrics",
    {
      title: "App analytics",
      description:
        "Developer: views, clicks and hand-offs (started, completed, failed) for one of your apps, with conversion (completed hand-offs per view), per product and per day. Live traffic only unless include_sandbox. handoff_events counts the handoff_started events your app reported; handoffs_* count hand-offs made through POST /v1/handoffs.",
      inputSchema: {
        app_id: z.string(),
        from: day.optional().describe("First day, YYYY-MM-DD (UTC; default 30 days before `to`)"),
        to: day.optional().describe("Last day, inclusive (default today)"),
        include_sandbox: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id, from, to, include_sandbox }) => {
      const app = await ownApp(app_id);
      if (!app) return fail(`No app with id '${app_id}'`);
      const range = dateRange(from, to);
      const rows = await store.runtimeCounts({ app_ids: [app.id], from: range.from, to: range.toExclusive, include_sandbox });
      const byProduct = rollUp(rows, (r: { product_id: string }) => r.product_id);
      const byDay = rollUp(rows, (r: { day: string }) => r.day);
      return json({
        app_id: app.id,
        from: range.from,
        to: range.to,
        include_sandbox,
        totals: byProduct.totals,
        by_product: byProduct.groups.map(([product_id, c]) => ({ product_id, ...c })),
        by_day: byDay.groups.map(([d, c]) => ({ day: d, ...c })),
      });
    },
  );
}

// ---- innovator tools ----

export function registerRuntimeInnovatorTools(server: McpServer, store: Store, user: User) {
  const answersFor = async (productId: string) => (await productsAnsweredBy(store, user)).find((p) => p.product.id === productId);

  server.registerTool(
    "get_product_distribution_metrics",
    {
      title: "How a product performs across apps",
      description:
        "Innovator: views, clicks and hand-offs for one of your products across every developer app that shows it, per app and per day. Live traffic only.",
      inputSchema: { product_id: z.string(), from: day.optional(), to: day.optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id, from, to }) => {
      if (!(await answersFor(product_id))) return fail(`No product of yours with id '${product_id}'`);
      const range = dateRange(from, to);
      const rows = await store.runtimeCounts({ product_ids: [product_id], from: range.from, to: range.toExclusive, include_sandbox: false });
      const byApp = rollUp(rows, (r: { app_id: string }) => r.app_id);
      const byDay = rollUp(rows, (r: { day: string }) => r.day);
      return json({
        product_id,
        from: range.from,
        to: range.to,
        totals: byApp.totals,
        by_app: await Promise.all(
          byApp.groups.map(async ([app_id, c]) => {
            const app = await store.getApp(app_id);
            const dev = app && (await store.getUser(app.owner_id));
            return { app_id, app_name: app?.name, developer: dev && { name: dev.name, email: dev.email }, ...c };
          }),
        ),
        by_day: byDay.groups.map(([d, c]) => ({ day: d, ...c })),
      });
    },
  );

  server.registerTool(
    "report_handoff_outcome",
    {
      title: "Report how a hand-off ended",
      description:
        "Innovator: once a user who arrived through a developer app's hand-off (handoff_id in your handoff_url) finishes or abandons your onboarding, report it. The app's webhooks get handoff.completed or handoff.failed; no customer data is shared.",
      inputSchema: { handoff_id: z.string(), outcome: z.enum(["completed", "failed"]) },
    },
    async ({ handoff_id, outcome }) => {
      const h = await store.getHandoff(handoff_id);
      if (!h || h.sandbox || !(await answersFor(h.product_id))) return fail(`No hand-off '${handoff_id}' for your products`);
      const resolved = await resolveHandoff(store, h, outcome);
      if (!resolved) return fail(`Hand-off is already ${h.status}`);
      await store.audit(user.id, "report_handoff_outcome", h.id, { outcome, product_id: h.product_id });
      return json(resolved);
    },
  );
}
