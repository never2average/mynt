import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ESignError,
  type CreateFromDocumentInput,
  type CreateFromTemplateInput,
  type ESignDocument,
  type ESignAdapter,
  type ESignDocumentStatus,
  type ESignProvider,
  type ESignSetup,
  type ESignSigner,
  type WebhookCheck,
} from "./provider.js";

// The SignWell adapter (https://developers.signwell.com): REST over HTTPS with the API key in X-Api-Key, nothing else
// of Mynt's sent. The key and the webhook id are set by an admin in Mynt Studio (esign-settings.ts), sealed in Mynt's
// database, with SIGNWELL_API_KEY and SIGNWELL_WEBHOOK_ID in the environment as overrides (SignWell signs
// each webhook event with its webhook's id as the HMAC key). Mynt's outbound rules: a fixed https base, a time limit
// on every call, size caps on what comes back, and SignWell's own error text never passed on (it may echo what was
// sent). The key is never logged or put in an error.
//
// SignWell's event hash covers only the event's type and time (HMAC-SHA256 of "type@time"), not the document it names,
// so Mynt never trusts an event's body: an event is only a prompt to read the document's state back from the API
// (agreement-esign.ts, syncDocument).

const BASE = "https://www.signwell.com/api/v1";
const JSON_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
// Events older than this are refused (a captured one replayed later); SignWell's retries come well within it.
const WEBHOOK_MAX_AGE_S = 3 * 86_400;
const WEBHOOK_MAX_SKEW_S = 300;

// Mynt's signers by recipient id on SignWell's documents.
const RECIPIENT_ID: Record<ESignSigner["role"], string> = { counterparty: "1", app: "2" };
const ROLE_OF: Record<string, ESignSigner["role"]> = { "1": "counterparty", "2": "app" };

const STATUS: Record<string, ESignDocumentStatus> = {
  draft: "draft",
  created: "pending",
  sending: "pending",
  sent: "pending",
  pending: "pending",
  viewed: "pending",
  completed: "completed",
  // Completed by the sender without every signature: not a signature by both parties, so never "completed" here.
  "manually completed": "error",
  declined: "declined",
  canceled: "canceled",
  cancelled: "canceled",
  expired: "expired",
  bounced: "error",
  blocked: "error",
  error: "error",
};

type Fetch = typeof fetch;
type Row = Record<string, unknown>;

export interface SignWellOptions {
  apiKey: string;
  webhookId?: string | null;
  fetch?: Fetch; // tests pass a fake; never the live API
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) throw new ESignError("response_too_large", res.status);
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new ESignError("response_too_large", res.status);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

const recipientsOf = (signers: ESignSigner[], template = false, placeholders?: { counterparty: string; app: string }) =>
  signers.map((s) => ({
    id: RECIPIENT_ID[s.role],
    name: s.name,
    email: s.email,
    ...(template && placeholders ? { placeholder_name: placeholders[s.role] } : {}),
    // Signing happens inside Mynt Studio; SignWell doesn't email the signing link.
    send_email: false,
  }));

const filesOf = (files: { name: string; content: Buffer }[]) => files.map((f) => ({ name: f.name, file_base64: f.content.toString("base64") }));

export function toDocument(body: unknown): ESignDocument {
  const b = (body && typeof body === "object" ? body : {}) as Row;
  const id = typeof b.id === "string" ? b.id : "";
  if (!id) throw new ESignError("malformed_response");
  const status = STATUS[String(b.status ?? "").trim().toLowerCase()] ?? "error";
  const recipients = Array.isArray(b.recipients) ? (b.recipients as Row[]) : [];
  return {
    id,
    status,
    testMode: b.test_mode === true,
    signers: recipients.map((r) => {
      const st = String(r.status ?? "").toLowerCase();
      return {
        role: ROLE_OF[String(r.id ?? "")] ?? null,
        email: typeof r.email === "string" ? r.email : "",
        signed: st === "completed" || st === "signed",
        embeddedSigningUrl: typeof r.embedded_signing_url === "string" && r.embedded_signing_url.startsWith("https://") ? r.embedded_signing_url : null,
      };
    }),
  };
}

export function createSignWell(opts: SignWellOptions): ESignProvider {
  const doFetch: Fetch = opts.fetch ?? fetch;
  const headers = (json: boolean) => ({ "X-Api-Key": opts.apiKey, Accept: json ? "application/json" : "application/pdf", "User-Agent": "Mynt-ESign/1", ...(json ? { "Content-Type": "application/json" } : {}) });

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${BASE}${path}`, {
        method,
        headers: headers(true),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ESignError((e as Error).name === "TimeoutError" ? "timeout" : "unreachable");
    }
    const raw = await readCapped(res, MAX_JSON_BYTES);
    if (res.status === 401 || res.status === 403) throw new ESignError("not_authorised", res.status);
    if (res.status === 404) throw new ESignError("not_found", res.status);
    if (res.status === 429) throw new ESignError("rate_limited", res.status);
    if (res.status >= 300) throw new ESignError(res.status === 422 || res.status === 400 ? "refused" : "provider_error", res.status);
    if (!raw.length) return null;
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ESignError("malformed_response", res.status);
    }
  }

  async function download(path: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await doFetch(`${BASE}${path}`, { method: "GET", headers: headers(false), redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (e) {
      throw new ESignError((e as Error).name === "TimeoutError" ? "timeout" : "unreachable");
    }
    // A redirect may only land on https.
    if (res.url && !res.url.startsWith("https://")) throw new ESignError("insecure_redirect", res.status);
    if (res.status >= 300) throw new ESignError(res.status === 404 ? "not_found" : "provider_error", res.status);
    const pdf = await readCapped(res, MAX_DOWNLOAD_BYTES);
    if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ESignError("not_a_pdf", res.status);
    return pdf;
  }

  const docPath = (id: string) => {
    if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new ESignError("bad_document_id");
    return `/documents/${id}`;
  };

  return {
    name: "signwell",

    async createFromDocument(input: CreateFromDocumentInput) {
      return toDocument(
        await call("POST", "/documents", {
          test_mode: input.testMode,
          name: input.name,
          files: filesOf(input.files),
          recipients: recipientsOf(input.signers),
          draft: false,
          embedded_signing: true,
          embedded_signing_notifications: false,
          apply_signing_order: false,
          reminders: false,
          allow_decline: true,
          allow_reassign: false,
          ...(input.signature === "text_tags" ? { text_tags: true } : { with_signature_page: true }),
          metadata: input.metadata,
        }),
      );
    },

    async createFromTemplate(input: CreateFromTemplateInput) {
      return toDocument(
        await call("POST", "/document_templates/documents", {
          test_mode: input.testMode,
          template_id: input.templateId,
          name: input.name,
          recipients: recipientsOf(input.signers, true, input.placeholders),
          template_fields: input.fields.map((f) => ({ api_id: f.apiId, value: f.value })),
          ...(input.appendFiles.length ? { files: filesOf(input.appendFiles) } : {}),
          draft: false,
          embedded_signing: true,
          embedded_signing_notifications: false,
          apply_signing_order: false,
          reminders: false,
          allow_decline: true,
          allow_reassign: false,
          metadata: input.metadata,
        }),
      );
    },

    async getStatus(documentId: string) {
      return toDocument(await call("GET", docPath(documentId)));
    },

    async embeddedSigningUrl(documentId: string, signer: ESignSigner["role"]) {
      const doc = toDocument(await call("GET", docPath(documentId)));
      if (doc.status !== "pending") return null;
      const s = doc.signers.find((x) => x.role === signer);
      return s && !s.signed ? s.embeddedSigningUrl : null;
    },

    async downloadCompleted(documentId: string) {
      const path = `${docPath(documentId)}/completed_pdf`;
      // The signed document as both parties signed it, and the same with SignWell's audit page (the certificate).
      const signed = await download(`${path}?url_only=false&audit_page=false&file_format=pdf`);
      const certificate = await download(`${path}?url_only=false&audit_page=true&file_format=pdf`);
      return { signed, certificate };
    },

    verifyWebhook(rawBody: string, _headers: Record<string, string | undefined>, now = new Date()): WebhookCheck {
      if (!opts.webhookId) return { ok: false, reason: "unconfigured" };
      let body: Row;
      try {
        body = JSON.parse(rawBody) as Row;
      } catch {
        return { ok: false, reason: "malformed" };
      }
      const event = (body?.event && typeof body.event === "object" ? body.event : null) as Row | null;
      const type = typeof event?.type === "string" ? event.type : null;
      const time = typeof event?.time === "number" ? event.time : typeof event?.time === "string" && /^\d{1,12}$/.test(event.time) ? Number(event.time) : null;
      const hash = typeof event?.hash === "string" ? event.hash.toLowerCase() : null;
      if (!type || time === null || !hash || !/^[a-f0-9]{64}$/.test(hash) || type.length > 100) return { ok: false, reason: "malformed" };
      const expected = createHmac("sha256", opts.webhookId).update(`${type}@${event!.time}`).digest();
      if (!timingSafeEqual(expected, Buffer.from(hash, "hex"))) return { ok: false, reason: "bad_signature" };
      const age = now.getTime() / 1000 - time;
      if (age > WEBHOOK_MAX_AGE_S || age < -WEBHOOK_MAX_SKEW_S) return { ok: false, reason: "stale" };
      const data = (body.data && typeof body.data === "object" ? body.data : {}) as Row;
      const object = (data.object && typeof data.object === "object" ? data.object : {}) as Row;
      const documentId = typeof object.id === "string" && /^[A-Za-z0-9-]{1,100}$/.test(object.id) ? object.id : null;
      return { ok: true, event: { eventId: `${hash}:${documentId ?? "-"}`, type, documentId, occurredAt: new Date(time * 1000) } };
    },

    async cancel(documentId: string) {
      try {
        await call("DELETE", docPath(documentId));
      } catch (e) {
        if (!(e instanceof ESignError && e.code === "not_found")) throw e;
      }
    },

    signingOrigins: SIGNING_ORIGINS,
  };
}

// Where SignWell serves its embedded signing pages: Mynt frames a signing link only from here.
export const SIGNING_ORIGINS = ["https://www.signwell.com"] as const;

// Setting SignWell up from Mynt: the key checked with a cheap authenticated read (the key's own account), and the
// webhook found by its callback URL or created (SignWell's webhook id is the key its events are signed with).
export function signwellSetup(opts: { apiKey: string; fetch?: Fetch }): ESignSetup {
  const doFetch: Fetch = opts.fetch ?? fetch;
  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${BASE}${path}`, {
        method,
        headers: { "X-Api-Key": opts.apiKey, Accept: "application/json", "User-Agent": "Mynt-ESign/1", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ESignError((e as Error).name === "TimeoutError" ? "timeout" : "unreachable");
    }
    const raw = await readCapped(res, MAX_JSON_BYTES);
    if (res.status === 401 || res.status === 403) throw new ESignError("not_authorised", res.status);
    if (res.status === 404) throw new ESignError("not_found", res.status);
    if (res.status === 429) throw new ESignError("rate_limited", res.status);
    if (res.status >= 300) throw new ESignError(res.status === 422 || res.status === 400 ? "refused" : "provider_error", res.status);
    if (!raw.length) return null;
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ESignError("malformed_response", res.status);
    }
  }
  return {
    async validateKey() {
      const me = (await call("GET", "/me")) as Row | null;
      if (!me || typeof me !== "object") throw new ESignError("malformed_response");
    },
    async registerWebhook(callbackUrl: string) {
      if (!callbackUrl.startsWith("https://")) throw new ESignError("webhook_url_not_https");
      const hooks = await call("GET", "/hooks");
      const found = (Array.isArray(hooks) ? (hooks as Row[]) : []).find((h) => h.callback_url === callbackUrl && typeof h.id === "string");
      if (found) return { id: found.id as string, reused: true };
      const made = (await call("POST", "/hooks", { callback_url: callbackUrl })) as Row | null;
      if (!made || typeof made.id !== "string") throw new ESignError("malformed_response");
      return { id: made.id, reused: false };
    },
    async deleteWebhook(id: string) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new ESignError("bad_webhook_id");
      try {
        await call("DELETE", `/hooks/${id}`);
      } catch (e) {
        if (!(e instanceof ESignError && e.code === "not_found")) throw e;
      }
    },
  };
}

export const SIGNWELL: ESignAdapter = {
  name: "signwell",
  provider: ({ apiKey, webhookId, fetch: f }) => createSignWell({ apiKey, webhookId, fetch: f }),
  setup: ({ apiKey, fetch: f }) => signwellSetup({ apiKey, fetch: f }),
};

export function signwellFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: Fetch): ESignProvider | null {
  const apiKey = env.SIGNWELL_API_KEY?.trim();
  if (!apiKey) return null;
  return createSignWell({ apiKey, webhookId: env.SIGNWELL_WEBHOOK_ID?.trim() || null, fetch: fetchImpl });
}
