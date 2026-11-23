// E-signature, brand-neutral: what Mynt needs from an e-signature service to have a program agreement signed by both
// parties and keep the signed copy. One adapter per service (signwell.ts); which one runs, and its keys, are settings
// set from Mynt Studio by an admin (esign-settings.ts), with environment overrides. Nothing here names a service.
//
// The adapter never decides an agreement is signed by itself: Mynt asks it for the document's state (getStatus) and
// only a completed document, downloaded and sealed by Mynt, signs an agreement (agreement-esign.ts).

export type ESignDocumentStatus = "draft" | "pending" | "completed" | "declined" | "canceled" | "expired" | "error";

export interface ESignSigner {
  // Mynt's own name for the signer on the document: "counterparty" (the licence provider) or "app" (the developer).
  role: "counterparty" | "app";
  name: string;
  email: string;
}

export interface ESignFile {
  name: string; // with its extension (.pdf or .docx)
  content: Buffer;
}

// What Mynt fills in for a template, by its own variable names (agreement-esign.ts, TEMPLATE_VARIABLES).
export type ESignValues = Record<string, string>;

export interface CreateFromDocumentInput {
  name: string; // the document's title, as the signers see it
  files: ESignFile[]; // the licence provider's agreement first, then Mynt's schedule
  signers: ESignSigner[];
  signature: "signature_page" | "text_tags"; // where the signatures go: a page added at the end, or the file's own tags
  metadata: Record<string, string>; // Mynt's agreement id, so the service's events name it
  testMode: boolean;
}

export interface CreateFromTemplateInput {
  name: string;
  templateId: string; // the template's id at the service
  placeholders: { counterparty: string; app: string }; // the template's signer placeholders
  fields: { apiId: string; value: string }[]; // template fields Mynt fills
  appendFiles: ESignFile[]; // Mynt's schedule, appended
  signers: ESignSigner[];
  metadata: Record<string, string>;
  testMode: boolean;
}

export interface ESignDocument {
  id: string;
  status: ESignDocumentStatus;
  testMode: boolean;
  // Each signer, by the role Mynt gave it; signed once the service says so. The signing link is for embedding and is
  // never stored by Mynt (it's asked for each time someone opens it).
  signers: { role: "counterparty" | "app" | null; email: string; signed: boolean; embeddedSigningUrl: string | null }[];
}

export interface ESignWebhookEvent {
  // The event's own id, unique per delivery attempt's content (replays carry the same one), for deduplication.
  eventId: string;
  type: string; // the service's event name, as it sent it
  documentId: string | null;
  occurredAt: Date;
}

export type WebhookCheck = { ok: true; event: ESignWebhookEvent } | { ok: false; reason: "unconfigured" | "malformed" | "bad_signature" | "stale" };

export interface ESignProvider {
  readonly name: string; // the adapter's id, as ESIGN_PROVIDER names it
  createFromDocument(input: CreateFromDocumentInput): Promise<ESignDocument>;
  createFromTemplate(input: CreateFromTemplateInput): Promise<ESignDocument>;
  getStatus(documentId: string): Promise<ESignDocument>;
  // The link for one signer to sign inside Mynt Studio (an embedded signing page). Null when that signer has signed
  // or the document isn't waiting for signatures.
  embeddedSigningUrl(documentId: string, signer: "counterparty" | "app"): Promise<string | null>;
  // The completed document (both signatures) and the service's audit certificate (who signed, when, from where).
  downloadCompleted(documentId: string): Promise<{ signed: Buffer; certificate: Buffer }>;
  // A webhook delivery, checked against the service's own scheme with the raw body and headers as received.
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>, now?: Date): WebhookCheck;
  cancel(documentId: string): Promise<void>;
  // The https origins the service's embedded signing pages are served from (the adapter's own list): a signing link
  // from anywhere else is never framed.
  readonly signingOrigins: readonly string[];
}

// Setting the service up from Mynt itself (esign-settings.ts): check a key, and register, find or remove the webhook
// that sends Mynt the service's events. Uses only the key it's given.
export interface ESignSetup {
  validateKey(): Promise<void>; // throws ESignError("not_authorised") for a key the service refuses
  registerWebhook(callbackUrl: string): Promise<{ id: string; reused: boolean }>;
  deleteWebhook(id: string): Promise<void>;
}

export interface ESignAdapter {
  name: string;
  // A provider for documents and webhooks, with the key and, once registered, the webhook's id.
  provider(opts: { apiKey: string; webhookId: string | null; fetch?: typeof fetch }): ESignProvider;
  setup(opts: { apiKey: string; fetch?: typeof fetch }): ESignSetup;
}

export class ESignError extends Error {
  // code: a short reason Mynt can show (never the service's own text, which may echo what was sent)
  constructor(
    readonly code: string,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
  }
}

// How e-signature runs on this deployment: the provider, and whether documents are created in the service's test
// mode (not legally binding, free). Test mode is on unless ESIGN_TEST_MODE is set to off.
export interface ESign {
  provider: ESignProvider;
  testMode: boolean;
}

export const ESIGN_NOT_CONFIGURED = "E-signature isn't configured on this deployment yet";

export const testModeFromEnv = (env: NodeJS.ProcessEnv = process.env) => !/^(off|false|0|no)$/i.test((env.ESIGN_TEST_MODE ?? "").trim());
