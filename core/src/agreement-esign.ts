import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AGREEMENT_TEMPLATE_SOURCES, SIGNATURE_PLACEMENTS } from "./agreement-esign-schema.js";
import { agreementScopeLabel } from "./app-agreements-schema.js";
import { ESIGN_NOT_CONFIGURED, ESignError, type ESign, type ESignDocument, type ESignSigner } from "./esign/provider.js";
import { schedulePdf } from "./esign/schedule-pdf.js";
import { currentEsign, type EsignSource } from "./esign-settings.js";
import { noticeFirm } from "./firm-notices.js";
import { effectiveRoles, type Store, type User } from "./store.js";
import { open as unseal, seal, vaultAvailable } from "./vault.js";
import { appRole, memberApp } from "./workspaces.js";

// Program agreements signed by e-signature (esign/provider.ts names what Mynt needs of the service; esign/signwell.ts
// is the adapter). The flow:
//
// 1. A licence provider's members upload their firm's program agreement as a template (upload_agreement_template): a
//    PDF or DOCX Mynt keeps sealed under the vault key, or the id of a template the firm keeps at the e-signature
//    service, attached to one of its licences or sponsorships (or neither: the firm's default). Versions never change;
//    a new upload under the same name is the next version and the active one. Only the firm's own licence providers
//    manage them, never an admin on their behalf.
// 2. When the firm accepts an app's program agreement (respond_to_app_agreement), Mynt picks the firm's most specific
//    active template (the sponsorship's, else a licence's behind the products' sponsorships, else the firm's default),
//    appends its program schedule (what Mynt fills in: both parties, the developer's firm, the app, the products, the scope, the
//    states, the dates, the template's version and SHA-256) and creates the e-signature document with two signers: the
//    person who accepted for the firm and the person who proposed for the app, signing in either order. If the firm
//    has no template yet, or the service can't be reached, the agreement stays accepted and the document is made the
//    first time someone asks to sign (get_agreement_signing_link).
// 3. Each signer signs inside Mynt Studio (get_agreement_signing_link gives the embedded signing page, only to that
//    signer). The service's webhook (ESIGN_WEBHOOK_PATH, verified and handled once per event) prompts Mynt to read the
//    document's state back from the service; opening a signing link or the signed copy does too.
// 4. Only a completed document signs the agreement: Mynt downloads the signed copy and the service's audit certificate,
//    seals both with their SHA-256 and sets the agreement 'signed' with signed_at. A signer declining makes it
//    'declined'; the document canceled or expired ends it ('terminated'). Every step is audited.
//
// With e-signature configured, sign_app_agreement doesn't sign program agreements (app-agreements.ts); without it, it
// stays the way both sides record their signatures. Both parties' members read the signed copy
// (download_agreement_document), and nobody else.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const UUID = z.string().uuid();
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
type Row = Record<string, unknown>;

export { ESIGN_WEBHOOK_PATH } from "./esign-settings.js";
export const MAX_TEMPLATE_BYTES = 5 * 1024 * 1024;
// The variables Mynt fills in; a provider template maps each it wants to one of its own fields (field_map).
export const TEMPLATE_VARIABLES = ["licence_provider", "developer_firm", "app", "products", "states", "effective_from", "effective_to", "agreement_id", "terms_summary", "scope"] as const;
type Variable = (typeof TEMPLATE_VARIABLES)[number];

const MANAGERS = ["owner", "admin"];

export interface TemplateRecord {
  id: string;
  entity_id: string;
  licence_id: string | null;
  sponsorship_id: string | null;
  kind: "program";
  name: string;
  version: number;
  source: (typeof AGREEMENT_TEMPLATE_SOURCES)[number];
  file_name: string | null;
  file_type: "pdf" | "docx" | null;
  file_size: number | null;
  sha256: string | null;
  provider: string | null;
  provider_template_id: string | null;
  placeholders: { counterparty?: string; app?: string };
  field_map: Partial<Record<Variable, string>>;
  signature_placement: (typeof SIGNATURE_PLACEMENTS)[number];
  notes: string | null;
  active: boolean;
  created_by: string | null;
  created_at: string;
  retired_at: string | null;
}

const toTemplate = (r: Row): TemplateRecord => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  licence_id: (r.licence_id as string | null) ?? null,
  sponsorship_id: (r.sponsorship_id as string | null) ?? null,
  kind: "program",
  name: r.name as string,
  version: Number(r.version),
  source: r.source as TemplateRecord["source"],
  file_name: (r.file_name as string | null) ?? null,
  file_type: (r.file_type as TemplateRecord["file_type"]) ?? null,
  file_size: r.file_size == null ? null : Number(r.file_size),
  sha256: (r.sha256 as string | null) ?? null,
  provider: (r.provider as string | null) ?? null,
  provider_template_id: (r.provider_template_id as string | null) ?? null,
  placeholders: (r.placeholders as TemplateRecord["placeholders"]) ?? {},
  field_map: (r.field_map as TemplateRecord["field_map"]) ?? {},
  signature_placement: (r.signature_placement as TemplateRecord["signature_placement"]) ?? "signature_page",
  notes: (r.notes as string | null) ?? null,
  active: r.active === true,
  created_by: (r.created_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
  retired_at: iso(r.retired_at),
});

// What a file is, by its bytes: a PDF, or a DOCX (a zip holding word/document.xml). Anything else is refused.
export function sniffAgreementFile(name: string, content: Buffer): "pdf" | "docx" | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") && content.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (lower.endsWith(".docx") && content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && content.includes("word/document.xml")) return "docx";
  return null;
}

interface DocumentRow {
  agreement_id: string;
  template_id: string | null;
  template_version: number | null;
  provider: string;
  provider_document_id: string | null;
  test_mode: boolean;
  status: string;
  counterparty_signer_id: string | null;
  app_signer_id: string | null;
  counterparty_signed_at: string | null;
  app_signed_at: string | null;
  signed_sha256: string | null;
  certificate_sha256: string | null;
  completed_at: string | null;
}
const toDocRow = (r: Row): DocumentRow => ({
  agreement_id: r.agreement_id as string,
  template_id: (r.template_id as string | null) ?? null,
  template_version: r.template_version == null ? null : Number(r.template_version),
  provider: r.provider as string,
  provider_document_id: (r.provider_document_id as string | null) ?? null,
  test_mode: r.test_mode === true,
  status: r.status as string,
  counterparty_signer_id: (r.counterparty_signer_id as string | null) ?? null,
  app_signer_id: (r.app_signer_id as string | null) ?? null,
  counterparty_signed_at: iso(r.counterparty_signed_at),
  app_signed_at: iso(r.app_signed_at),
  signed_sha256: (r.signed_sha256 as string | null) ?? null,
  certificate_sha256: (r.certificate_sha256 as string | null) ?? null,
  completed_at: iso(r.completed_at),
});

async function documentOf(store: Store, agreementId: string): Promise<DocumentRow | undefined> {
  const r = (await store.db.query(`SELECT * FROM ${T}.app_agreement_documents WHERE agreement_id = $1`, [agreementId])).rows[0];
  return r ? toDocRow(r) : undefined;
}

async function agreementRow(store: Store, id: string): Promise<Row | undefined> {
  if (!UUID.safeParse(id).success) return undefined;
  return (await store.db.query(`SELECT * FROM ${T}.app_agreements WHERE id = $1`, [id])).rows[0];
}

// The e-signature side of an agreement, as both parties see it (list_app_agreements and the other agreement tools).
export async function signatureDocumentOf(store: Store, esign: ESign | null, agreementId: string) {
  const d = await documentOf(store, agreementId);
  if (!d) return null;
  const t = d.template_id ? (await store.db.query(`SELECT name, version FROM ${T}.agreement_templates WHERE id = $1`, [d.template_id])).rows[0] : undefined;
  return {
    status: d.status,
    test_mode: d.test_mode,
    template: t ? { id: d.template_id, name: t.name as string, version: Number(t.version) } : null,
    signers: { counterparty: { user_id: d.counterparty_signer_id, signed: d.counterparty_signed_at !== null }, app: { user_id: d.app_signer_id, signed: d.app_signed_at !== null } },
    signed_copy: d.signed_sha256 ? { sha256: d.signed_sha256, certificate_sha256: d.certificate_sha256 } : null,
    completed_at: d.completed_at,
    e_signature_configured: esign !== null,
  };
}

// The firm's most specific active template for an agreement: one attached to an approved sponsorship of the agreement's
// products, else to a licence those sponsorships are approved under, else the firm's default (neither attached).
export async function templateFor(store: Store, entityId: string, products: string[]): Promise<TemplateRecord | undefined> {
  const { rows } = await store.db.query(`SELECT * FROM ${T}.agreement_templates WHERE entity_id = $1 AND kind = 'program' AND active ORDER BY created_at DESC`, [entityId]);
  const templates = rows.map(toTemplate);
  if (!templates.length) return undefined;
  const sponsorships = (await Promise.all(products.map((p) => store.sponsorships({ product_id: p, status: "approved" })))).flat().filter((s) => s.provider_entity_id === entityId);
  const sIds = new Set(sponsorships.map((s) => s.id));
  const lIds = new Set(sponsorships.flatMap((s) => s.licence_ids));
  return templates.find((t) => t.sponsorship_id && sIds.has(t.sponsorship_id)) ?? templates.find((t) => !t.sponsorship_id && t.licence_id && lIds.has(t.licence_id)) ?? templates.find((t) => !t.sponsorship_id && !t.licence_id);
}

// The e-signature service reads {{...}} in a document's text as a text tag (a signature, date or text field for a
// signer) when the template places signatures by text tags. Nothing Mynt writes into the schedule, the document's
// fields or its title may carry one: the terms summary and the app's, firms', products' and signers' names come from
// the parties, so a tag written there could add or move a signer's field. The braces stay, set apart.
export const withoutTextTags = (s: string) => s.replace(/\{(?=\{)/g, "{ ").replace(/\}(?=\})/g, "} ");

// What Mynt fills in for an agreement.
async function valuesFor(store: Store, a: Row): Promise<Record<Variable, string>> {
  const counterparty = await store.getEntity(a.counterparty_entity_id as string);
  const app = a.app_id ? await store.getApp(a.app_id as string) : undefined;
  const proposer = a.proposed_by ? await store.getUser(a.proposed_by as string) : undefined;
  const proposerFirm = proposer?.entity_id ? await store.getEntity(proposer.entity_id) : undefined;
  const workspace = a.workspace_id ? (await store.db.query(`SELECT name FROM ${T}.workspaces WHERE id = $1`, [a.workspace_id])).rows[0] : undefined;
  const products = Array.isArray(a.products) ? (a.products as string[]) : [];
  const names = await Promise.all(products.map(async (id) => `${(await store.getProduct(id))?.product.name ?? id} (${id})`));
  const states = new Set<string>();
  for (const p of products) for (const s of await store.sponsorships({ product_id: p, status: "approved" })) if (s.provider_entity_id === a.counterparty_entity_id) s.jurisdictions.forEach((j) => states.add(j));
  const day = (v: unknown) => (v == null ? "" : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
  const values: Record<Variable, string> = {
    licence_provider: counterparty?.name ?? (a.counterparty_entity_id as string),
    developer_firm: proposerFirm?.name ?? (workspace?.name as string | undefined) ?? proposer?.name ?? "",
    app: app ? `${app.name} (${app.id})` : "",
    products: names.join("; "),
    states: [...states].sort().map((s) => s.toUpperCase()).join(", "),
    effective_from: day(a.effective_from) || "On signature",
    effective_to: day(a.effective_to) || "Until ended by either party",
    agreement_id: a.id as string,
    terms_summary: (a.terms_summary as string) ?? "",
    // What it covers, in words, as the other side accepted it ("Not set" on an agreement from before scopes).
    scope: Array.isArray(a.scopes) && a.scopes.length ? (a.scopes as string[]).map(agreementScopeLabel).join("; ") : "Not set",
  };
  for (const k of TEMPLATE_VARIABLES) values[k] = withoutTextTags(values[k]);
  return values;
}

const LABELS: Record<Variable, string> = {
  licence_provider: "Licence provider (sponsor)",
  developer_firm: "Developer",
  app: "App",
  products: "Financial products covered",
  states: "States the sponsorship covers",
  effective_from: "Effective from",
  effective_to: "Effective until",
  agreement_id: "Mynt agreement id",
  terms_summary: "Summary of the terms (as proposed)",
  scope: "Scope of the agreement",
};

export function scheduleFor(values: Record<Variable, string>, template: TemplateRecord, signers: ESignSigner[]): Buffer {
  return schedulePdf(
    "Program schedule (filled in by Mynt)",
    [
      { heading: "Parties", lines: [[LABELS.licence_provider, values.licence_provider], [LABELS.developer_firm, values.developer_firm]] },
      { heading: "What the agreement covers", lines: (["app", "products", "scope", "states", "effective_from", "effective_to", "terms_summary"] as const).map((k) => [LABELS[k], values[k]]) },
      {
        heading: "Agreement",
        lines: [
          [LABELS.agreement_id, values.agreement_id],
          ["Template", withoutTextTags(`${template.name}, version ${template.version}`)],
          ...(template.sha256 ? ([["Template SHA-256", template.sha256]] as [string, string][]) : []),
          ...signers.map((s): [string, string] => [s.role === "counterparty" ? "Signs for the licence provider" : "Signs for the developer", withoutTextTags(s.name)]),
        ],
      },
    ],
    "This schedule forms part of the agreement it is attached to. Where the agreement and this schedule differ on the parties, the app, the products, the scope or the states covered, this schedule governs. The products are each covered by the licence provider's sponsorship on Mynt; the app itself holds no licence.",
  );
}

export type StartResult = { ok: true; created: boolean } | { ok: false; error: string };

// Creates the e-signature document for an accepted program agreement, once. Signers: who accepted it for the firm and
// who proposed it for the app.
export async function startSigning(store: Store, esign: ESign | null, agreementId: string, actorId: string | null): Promise<StartResult> {
  if (!esign) return { ok: false, error: ESIGN_NOT_CONFIGURED };
  const a = await agreementRow(store, agreementId);
  if (!a || a.kind !== "program") return { ok: false, error: "Only program agreements are signed by e-signature" };
  if (a.status !== "accepted") return { ok: false, error: a.status === "proposed" ? "The licence provider hasn't accepted it yet" : `That agreement is ${a.status}` };
  const existing = await documentOf(store, agreementId);
  if (existing && existing.status !== "failed") return { ok: true, created: false };
  const products = Array.isArray(a.products) ? (a.products as string[]) : [];
  // The template the licence provider proposed it on, while it's still in use; else the firm's most specific one.
  const chosen = a.template_id ? (await store.db.query(`SELECT * FROM ${T}.agreement_templates WHERE id = $1 AND entity_id = $2 AND active`, [a.template_id, a.counterparty_entity_id])).rows[0] : undefined;
  const template = chosen ? toTemplate(chosen) : await templateFor(store, a.counterparty_entity_id as string, products);
  const firm = await store.getEntity(a.counterparty_entity_id as string);
  if (!template) return { ok: false, error: `${firm?.name ?? "The licence provider"} hasn't uploaded a program agreement template yet; its licence providers add one with upload_agreement_template` };
  if (template.source === "provider_template" && template.provider && template.provider !== esign.provider.name) return { ok: false, error: "The licence provider's template is kept at a different e-signature service than this deployment's" };
  // The licence provider's signer is whoever acted for it (accepted it, or proposed it), and the app's likewise.
  const lpSide = a.proposed_by_side === "counterparty" ? a.proposed_by : a.responded_by;
  const appSide = a.proposed_by_side === "counterparty" ? a.responded_by : a.proposed_by;
  const [lp, dev] = await Promise.all([lpSide ? store.getUser(lpSide as string) : undefined, appSide ? store.getUser(appSide as string) : undefined]);
  if (!lp?.email) return { ok: false, error: "The person who acted for the licence provider has no email address on Mynt, which the signature needs" };
  if (!dev?.email) return { ok: false, error: "The person who acted for the app has no email address on Mynt, which the signature needs" };
  const signers: ESignSigner[] = [
    { role: "counterparty", name: lp.name, email: lp.email },
    { role: "app", name: dev.name, email: dev.email },
  ];
  // Claim the agreement's document first, so two callers never create two.
  const claimed = await store.db.query(
    `INSERT INTO ${T}.app_agreement_documents (agreement_id, template_id, template_version, template_sha256, provider, test_mode, status, counterparty_signer_id, app_signer_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'creating', $7, $8)
     ON CONFLICT (agreement_id) DO UPDATE SET template_id = EXCLUDED.template_id, template_version = EXCLUDED.template_version, template_sha256 = EXCLUDED.template_sha256,
       provider = EXCLUDED.provider, test_mode = EXCLUDED.test_mode, status = 'creating', counterparty_signer_id = EXCLUDED.counterparty_signer_id, app_signer_id = EXCLUDED.app_signer_id, updated_at = now()
       WHERE ${T}.app_agreement_documents.status = 'failed'
     RETURNING agreement_id`,
    [agreementId, template.id, template.version, template.sha256, esign.provider.name, esign.testMode, lp.id, dev.id],
  );
  if (!claimed.rows.length) return { ok: true, created: false };
  const values = await valuesFor(store, a);
  const schedule = scheduleFor(values, template, signers);
  const metadata = { mynt_agreement_id: agreementId, mynt_template_id: template.id };
  const title = `${values.licence_provider}: program agreement for ${values.app || "an app"}`.slice(0, 200);
  let doc: ESignDocument;
  try {
    if (template.source === "upload") {
      const sealed = (await store.db.query(`SELECT file_sealed FROM ${T}.agreement_templates WHERE id = $1`, [template.id])).rows[0]?.file_sealed as string;
      const file = Buffer.from(unseal(sealed, false), "base64");
      if (sha256(file) !== template.sha256) throw new ESignError("template_hash_mismatch");
      doc = await esign.provider.createFromDocument({
        name: title,
        files: [
          { name: template.file_name ?? `agreement.${template.file_type}`, content: file },
          { name: "program-schedule.pdf", content: schedule },
        ],
        signers,
        signature: template.signature_placement,
        metadata,
        testMode: esign.testMode,
      });
    } else {
      doc = await esign.provider.createFromTemplate({
        name: title,
        templateId: template.provider_template_id!,
        placeholders: { counterparty: template.placeholders.counterparty ?? "Licence provider", app: template.placeholders.app ?? "Developer" },
        fields: Object.entries(template.field_map).flatMap(([k, apiId]) => (apiId && k in values ? [{ apiId, value: values[k as Variable] }] : [])),
        appendFiles: [{ name: "program-schedule.pdf", content: schedule }],
        signers,
        metadata,
        testMode: esign.testMode,
      });
    }
  } catch (e) {
    const code = e instanceof ESignError ? e.code : "unexpected";
    await store.db.query(`UPDATE ${T}.app_agreement_documents SET status = 'failed', updated_at = now() WHERE agreement_id = $1`, [agreementId]);
    await store.audit(actorId, "esign_document_failed", agreementId, { app_id: a.app_id, counterparty_entity_id: a.counterparty_entity_id, template_id: template.id, reason: code });
    return { ok: false, error: `The e-signature service didn't create the document (${code}); try again shortly` };
  }
  await store.db.query(`UPDATE ${T}.app_agreement_documents SET provider_document_id = $2, status = $3, schedule_sha256 = $4, test_mode = $5, last_synced_at = now(), updated_at = now() WHERE agreement_id = $1`, [
    agreementId,
    doc.id,
    doc.status,
    sha256(schedule),
    doc.testMode || esign.testMode,
  ]);
  await store.audit(actorId, "esign_document_created", agreementId, {
    app_id: a.app_id,
    workspace_id: a.workspace_id,
    counterparty_entity_id: a.counterparty_entity_id,
    provider: esign.provider.name,
    provider_document_id: doc.id,
    template_id: template.id,
    template_version: template.version,
    template_sha256: template.sha256,
    schedule_sha256: sha256(schedule),
    signers: { counterparty: lp.id, app: dev.id },
    test_mode: esign.testMode,
  });
  return { ok: true, created: true };
}

// Reads the document's state back from the service and applies it, idempotently: each side's signature as the service
// reports it; a completed document downloaded, sealed and the agreement signed; declined, canceled or expired ended.
export async function syncDocument(store: Store, esign: ESign, agreementId: string): Promise<DocumentRow | undefined> {
  const d = await documentOf(store, agreementId);
  if (!d?.provider_document_id || d.provider !== esign.provider.name || ["completed", "declined", "canceled", "expired"].includes(d.status)) return d;
  const doc = await esign.provider.getStatus(d.provider_document_id);
  const a = await agreementRow(store, agreementId);
  if (!a) return d;
  const ctx = { app_id: a.app_id, workspace_id: a.workspace_id, counterparty_entity_id: a.counterparty_entity_id, provider_document_id: d.provider_document_id };
  for (const side of ["counterparty", "app"] as const) {
    if (!doc.signers.find((s) => s.role === side)?.signed) continue;
    const r = await store.db.query(`UPDATE ${T}.app_agreement_documents SET ${side}_signed_at = now(), updated_at = now() WHERE agreement_id = $1 AND ${side}_signed_at IS NULL RETURNING agreement_id`, [agreementId]);
    if (r.rows.length) await store.audit(null, "esign_signer_signed", agreementId, { ...ctx, side, user_id: side === "app" ? d.app_signer_id : d.counterparty_signer_id });
  }
  const allSigned = doc.signers.length >= 2 && doc.signers.every((s) => s.signed) && (["counterparty", "app"] as const).every((r) => doc.signers.some((s) => s.role === r));
  if (doc.status === "completed" && allSigned) {
    if (!vaultAvailable(false)) throw new ESignError("vault_unconfigured");
    const { signed, certificate } = await esign.provider.downloadCompleted(d.provider_document_id);
    const signedHash = sha256(signed);
    const certHash = sha256(certificate);
    const won = await store.db.query(
      `UPDATE ${T}.app_agreement_documents SET status = 'completed', signed_sealed = $2, signed_sha256 = $3, signed_size = $4, certificate_sealed = $5, certificate_sha256 = $6, certificate_size = $7,
         completed_at = now(), last_synced_at = now(), updated_at = now(), counterparty_signed_at = coalesce(counterparty_signed_at, now()), app_signed_at = coalesce(app_signed_at, now())
       WHERE agreement_id = $1 AND status <> 'completed' RETURNING agreement_id`,
      [agreementId, seal(signed.toString("base64"), false), signedHash, signed.length, seal(certificate.toString("base64"), false), certHash, certificate.length],
    );
    if (won.rows.length) {
      const signedRow = (
        await store.db.query(
          `UPDATE ${T}.app_agreements SET status = 'signed', signed_at = now(), updated_at = now(),
             app_signed_by = coalesce(app_signed_by, $2), app_signed_at = coalesce(app_signed_at, now()),
             counterparty_signed_by = coalesce(counterparty_signed_by, $3), counterparty_signed_at = coalesce(counterparty_signed_at, now()),
             document_sha256 = $4
           WHERE id = $1 AND status = 'accepted' RETURNING id`,
          [agreementId, d.app_signer_id, d.counterparty_signer_id, signedHash],
        )
      ).rows[0];
      await store.audit(null, "esign_completed", agreementId, { ...ctx, signed_sha256: signedHash, certificate_sha256: certHash, test_mode: d.test_mode, agreement_signed: Boolean(signedRow) });
      if (signedRow)
        await noticeFirm(store, a.counterparty_entity_id as string, "app_agreement.signed", { agreement_id: agreementId, app_id: a.app_id, kind: a.kind, status: "signed", products: a.products, signed_sha256: signedHash }).catch(() => null);
    }
  } else if (doc.status === "declined") {
    await store.db.query(`UPDATE ${T}.app_agreement_documents SET status = 'declined', last_synced_at = now(), updated_at = now() WHERE agreement_id = $1`, [agreementId]);
    const r = await store.db.query(`UPDATE ${T}.app_agreements SET status = 'declined', response_note = coalesce(response_note || ' ', '') || '(Declined at signing.)', updated_at = now() WHERE id = $1 AND status = 'accepted' RETURNING id`, [agreementId]);
    if (r.rows.length) await store.audit(null, "esign_declined", agreementId, ctx);
  } else if (doc.status === "canceled" || doc.status === "expired") {
    await store.db.query(`UPDATE ${T}.app_agreement_documents SET status = $2, last_synced_at = now(), updated_at = now() WHERE agreement_id = $1`, [agreementId, doc.status]);
    const reason = doc.status === "expired" ? "The e-signature document expired before both sides signed" : "The e-signature document was canceled";
    const r = await store.db.query(`UPDATE ${T}.app_agreements SET status = 'terminated', terminated_at = now(), termination_reason = $2, updated_at = now() WHERE id = $1 AND status = 'accepted' RETURNING id`, [agreementId, reason]);
    if (r.rows.length) await store.audit(null, doc.status === "expired" ? "esign_expired" : "esign_canceled", agreementId, ctx);
  } else {
    await store.db.query(`UPDATE ${T}.app_agreement_documents SET status = $2, last_synced_at = now(), updated_at = now() WHERE agreement_id = $1 AND status <> 'completed'`, [agreementId, doc.status]);
  }
  return documentOf(store, agreementId);
}

// Ends the service's document when the agreement is ended before it's complete (terminate_app_agreement). Best effort:
// the agreement is ended either way, and a document the service still holds can no longer sign it.
export async function cancelSigning(store: Store, esign: ESign | null, agreementId: string, actorId: string): Promise<void> {
  const d = await documentOf(store, agreementId);
  if (!esign || !d?.provider_document_id || d.provider !== esign.provider.name || ["completed", "declined", "canceled", "expired"].includes(d.status)) return;
  try {
    await esign.provider.cancel(d.provider_document_id);
  } catch {
    // reported by status below
  }
  await store.db.query(`UPDATE ${T}.app_agreement_documents SET status = 'canceled', updated_at = now() WHERE agreement_id = $1`, [agreementId]);
  await store.audit(actorId, "esign_canceled", agreementId, { provider_document_id: d.provider_document_id, by: "terminate_app_agreement" });
}

// The e-signature service's webhook: the raw body checked with the service's own scheme, each event handled once, and
// the document's state read back from the service (an event's body is never trusted). Answers 2xx once handled or
// ignored, 401 for a bad signature, 5xx when the service should send it again.
export async function esignWebhook(store: Store, source: EsignSource, req: IncomingMessage, res: ServerResponse) {
  const esign = currentEsign(source);
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
  if (!esign) return reply(503, { error: "esign_not_configured" });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) return reply(413, { error: "too_large" });
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const check = esign.provider.verifyWebhook(raw, headers);
  if (!check.ok) return reply(check.reason === "unconfigured" ? 503 : check.reason === "bad_signature" ? 401 : 400, { error: check.reason });
  const { event } = check;
  const fresh = await store.db.query(`INSERT INTO ${T}.esign_webhook_events (provider, event_id, type, document_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING event_id`, [
    esign.provider.name,
    event.eventId.slice(0, 300),
    event.type.slice(0, 100),
    event.documentId,
  ]);
  if (!fresh.rows.length) return reply(200, { received: true, duplicate: true });
  const d = event.documentId ? (await store.db.query(`SELECT agreement_id FROM ${T}.app_agreement_documents WHERE provider = $1 AND provider_document_id = $2`, [esign.provider.name, event.documentId])).rows[0] : undefined;
  if (!d) return reply(200, { received: true, ignored: true });
  try {
    await syncDocument(store, esign, d.agreement_id as string);
    return reply(200, { received: true });
  } catch (e) {
    // Not handled: forget the event so the service's retry is handled.
    await store.db.query(`DELETE FROM ${T}.esign_webhook_events WHERE provider = $1 AND event_id = $2`, [esign.provider.name, event.eventId.slice(0, 300)]);
    console.error("esign webhook: not applied:", e instanceof ESignError ? e.code : "unexpected");
    return reply(502, { error: "not_applied" });
  }
}

// Licence providers' templates (their firm's members only), and both parties' signing and signed copies.
export function registerAgreementEsignTools(server: McpServer, store: Store, user: User, esignSource: EsignSource, sides: { app: boolean; counterparty: boolean; licenceProvider?: boolean }) {
  const esign = () => currentEsign(esignSource);
  // The caller's firm when they act for it as a licence provider (read afresh: no standing, no firm).
  const lpFirm = async () => {
    if (!sides.counterparty) return null;
    const me = await store.getUser(user.id);
    return me?.entity_id && effectiveRoles(me.roles).includes("license_provider") ? me.entity_id : null;
  };
  // The caller's firm when they act for it as a counterparty of an app agreement: a licence provider (with standing)
  // for any kind, a vendor for every kind but 'program' (a program agreement's other side is the sponsor, so only its
  // licence providers sign, open or read it).
  const counterpartyFirm = async (kind: unknown) => {
    if (!sides.counterparty) return null;
    const me = await store.getUser(user.id);
    const roles = me ? effectiveRoles(me.roles) : [];
    return me?.entity_id && (roles.includes("license_provider") || (kind !== "program" && roles.includes("vendor"))) ? me.entity_id : null;
  };
  // Which party the caller belongs to on an agreement: any member of the app's workspace, or of the other firm. With
  // `manage`, only those who may act for it: the workspace's owners and admins.
  const partyOf = async (a: Row, manage: boolean): Promise<"app" | "counterparty" | null> => {
    if (sides.app && a.app_id) {
      const app = await memberApp(store, user, a.app_id as string);
      if (app && (!manage || MANAGERS.includes((await appRole(store, user, app)) ?? ""))) return "app";
    }
    if ((await counterpartyFirm(a.kind)) === a.counterparty_entity_id) return "counterparty";
    return null;
  };
  const noLpFirm = "You don't act for a firm as a licence provider; its licence providers manage its agreement templates";

  // Templates are a licence provider's: a vendor (a counterparty too, on its standard terms) is never shown them.
  if (sides.licenceProvider ?? sides.counterparty) {
    server.registerTool(
      "upload_agreement_template",
      {
        title: "Upload a program agreement template",
        description:
          "Licence provider (your firm's own licence providers only): add your firm's program agreement, which apps sign with you when you accept their program agreement. Either upload the document (source 'upload': a PDF or DOCX as base64, at most 5 MB; Mynt keeps it sealed with its SHA-256) or name a template your firm keeps at this deployment's e-signature service (source 'provider_template', with its placeholders for the two signers and field_map from Mynt's variables to the template's field ids). Attach it to one of your licences (licence_id) or sponsorships (sponsorship_id), or neither for your firm's default; the most specific active one is used. Mynt appends a program schedule stating the parties, the developer's firm, the app, the products, the scope, the states and the dates. Versions never change: a new upload under the same name is the next version and the active one. Audited.",
        inputSchema: {
          name: z.string().trim().min(3).max(120),
          source: z.enum(AGREEMENT_TEMPLATE_SOURCES).default("upload"),
          licence_id: UUID.optional(),
          sponsorship_id: UUID.optional(),
          file_name: z.string().trim().regex(/^[^/\\\0]{1,150}\.(pdf|docx)$/i, "A file name ending .pdf or .docx").optional(),
          file_base64: z.string().max(Math.ceil((MAX_TEMPLATE_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]*={0,2}$/, "base64").optional(),
          provider_template_id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/).optional(),
          placeholders: z.object({ counterparty: z.string().trim().min(1).max(100), app: z.string().trim().min(1).max(100) }).strict().optional(),
          field_map: z.partialRecord(z.enum(TEMPLATE_VARIABLES), z.string().trim().min(1).max(100)).optional(),
          signature_placement: z.enum(SIGNATURE_PLACEMENTS).default("signature_page").describe("signature_page: a signature page is added at the end; text_tags: the file carries the service's text tags"),
          notes: z.string().trim().max(2000).optional().describe("Notes on the template, e.g. where fields go"),
        },
      },
      async ({ name, source, licence_id, sponsorship_id, file_name, file_base64, provider_template_id, placeholders, field_map, signature_placement, notes }) => {
        const firm = await lpFirm();
        if (!firm) return fail(noLpFirm);
        if (licence_id && sponsorship_id) return fail("Attach a template to a licence or a sponsorship, not both");
        if (licence_id && !(await store.licensesOf(firm)).some((l) => l.id === licence_id)) return fail(`No licence '${licence_id}' of your firm`);
        if (sponsorship_id) {
          const s = await store.getSponsorship(sponsorship_id);
          if (!s || s.provider_entity_id !== firm) return fail(`No sponsorship '${sponsorship_id}' of your firm`);
        }
        let file: Buffer | null = null;
        let type: "pdf" | "docx" | null = null;
        if (source === "upload") {
          if (!file_name || !file_base64) return fail("An upload needs file_name and file_base64");
          if (provider_template_id) return fail("provider_template_id is for source 'provider_template'");
          if (!vaultAvailable(false)) return fail("This server's vault key (MYNT_VAULT_KEY) isn't configured, so it can't keep agreement files");
          file = Buffer.from(file_base64, "base64");
          if (!file.length) return fail("The file is empty");
          if (file.length > MAX_TEMPLATE_BYTES) return fail("The file is over 5 MB");
          type = sniffAgreementFile(file_name, file);
          if (!type) return fail("Upload a PDF or a Word document (.docx): that file isn't one");
        } else {
          if (!provider_template_id) return fail("A provider template needs provider_template_id");
          if (file_base64) return fail("A provider template is kept at the e-signature service: send no file");
          if (!esign()) return fail(`${ESIGN_NOT_CONFIGURED}, so a template kept there can't be used`);
        }
        const id = randomUUID();
        const r = await store.db.query(`SELECT coalesce(max(version), 0) + 1 AS v FROM ${T}.agreement_templates WHERE entity_id = $1 AND name = $2`, [firm, name]);
        const version = Number(r.rows[0].v);
        await store.db.query(`UPDATE ${T}.agreement_templates SET active = false WHERE entity_id = $1 AND name = $2 AND active`, [firm, name]);
        const row = (
          await store.db.query(
            `INSERT INTO ${T}.agreement_templates (id, entity_id, licence_id, sponsorship_id, name, version, source, file_name, file_type, file_size, file_sealed, sha256, provider, provider_template_id, placeholders, field_map, signature_placement, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *`,
            [
              id,
              firm,
              licence_id ?? null,
              sponsorship_id ?? null,
              name,
              version,
              source,
              file ? file_name : null,
              type,
              file?.length ?? null,
              file ? seal(file.toString("base64"), false) : null,
              file ? sha256(file) : null,
              source === "provider_template" ? esign()!.provider.name : null,
              provider_template_id ?? null,
              JSON.stringify(placeholders ?? {}),
              JSON.stringify(field_map ?? {}),
              signature_placement,
              notes ?? null,
              user.id,
            ],
          )
        ).rows[0];
        const t = toTemplate(row);
        await store.audit(user.id, "upload_agreement_template", t.id, { entity_id: firm, name, version, source, licence_id: t.licence_id, sponsorship_id: t.sponsorship_id, sha256: t.sha256, file_size: t.file_size });
        return json({ ...t, e_signature_configured: esign() !== null });
      },
    );

    server.registerTool(
      "list_agreement_templates",
      {
        title: "Your firm's agreement templates",
        description: "Licence provider: your firm's program agreement templates, each version with what it's attached to, its SHA-256 and whether it's the active one. include_retired lists the versions no longer in use too.",
        inputSchema: { include_retired: z.boolean().default(false) },
        annotations: { readOnlyHint: true },
      },
      async ({ include_retired }) => {
        const firm = await lpFirm();
        if (!firm) return fail(noLpFirm);
        const { rows } = await store.db.query(`SELECT * FROM ${T}.agreement_templates WHERE entity_id = $1 AND ($2::boolean OR active) ORDER BY name, version DESC`, [firm, include_retired]);
        return json({ entity_id: firm, e_signature_configured: esign() !== null, test_mode: esign()?.testMode ?? null, templates: rows.map(toTemplate) });
      },
    );

    server.registerTool(
      "retire_agreement_template",
      {
        title: "Retire an agreement template",
        description: "Licence provider: stop using one of your firm's templates for new agreements. Documents already made from it are unaffected, and the version is kept. Audited.",
        inputSchema: { template_id: UUID, reason: z.string().trim().max(500).optional() },
      },
      async ({ template_id, reason }) => {
        const firm = await lpFirm();
        if (!firm) return fail(noLpFirm);
        const r = (await store.db.query(`UPDATE ${T}.agreement_templates SET active = false, retired_by = $3, retired_at = now() WHERE id = $1 AND entity_id = $2 AND active RETURNING *`, [template_id, firm, user.id])).rows[0];
        if (!r) {
          const exists = (await store.db.query(`SELECT 1 FROM ${T}.agreement_templates WHERE id = $1 AND entity_id = $2`, [template_id, firm])).rows[0];
          return fail(exists ? "That template isn't in use already" : `No template '${template_id}' of your firm`);
        }
        await store.audit(user.id, "retire_agreement_template", template_id, { entity_id: firm, reason: reason ?? null });
        return json(toTemplate(r));
      },
    );
  }

  server.registerTool(
    "get_agreement_signing_link",
    {
      title: "Sign a program agreement",
      description:
        "The signer on either side of an accepted program agreement (who accepted it for the licence provider, who proposed it for the app): a link to sign it inside Mynt Studio (an embedded signing page, valid for a short while; ask again for a fresh one). Mynt makes the e-signature document from the licence provider's active template the first time if it wasn't made when the agreement was accepted, and reads its state back from the e-signature service. The agreement is signed only once the service reports both signatures complete.",
      inputSchema: { agreement_id: UUID },
    },
    async ({ agreement_id }) => {
      const live = esign();
      if (!live) return fail(`${ESIGN_NOT_CONFIGURED}: both sides record their signatures with sign_app_agreement`);
      const a = await agreementRow(store, agreement_id);
      const side = a ? await partyOf(a, true) : null;
      if (!a || !side) return fail(`No agreement '${agreement_id}' you can sign`);
      if (a.kind !== "program") return fail("Only program agreements are signed by e-signature");
      if (a.status === "signed") return fail("It's signed already: download_agreement_document has the signed copy");
      if (a.status !== "accepted") return fail(a.status === "proposed" ? "The licence provider hasn't accepted it yet" : `That agreement is ${a.status}`);
      const started = await startSigning(store, live, agreement_id, user.id);
      if (!started.ok) return fail(started.error);
      let d: DocumentRow | undefined;
      try {
        d = await syncDocument(store, live, agreement_id);
      } catch (e) {
        return fail(`Couldn't reach the e-signature service (${e instanceof ESignError ? e.code : "unexpected"}); try again shortly`);
      }
      if (!d?.provider_document_id) return fail("The signature document is still being made; try again in a moment");
      const after = await agreementRow(store, agreement_id);
      if (after?.status !== "accepted") return json({ agreement_id, status: after?.status, signing_url: null, message: `The agreement is ${after?.status} now` });
      const signerId = side === "app" ? d.app_signer_id : d.counterparty_signer_id;
      if (signerId !== user.id) {
        const signer = signerId ? await store.getUser(signerId) : undefined;
        return fail(`${signer?.name ?? "Someone else"} signs this for your side`);
      }
      if (side === "app" ? d.app_signed_at : d.counterparty_signed_at) return json({ agreement_id, status: "accepted", signing_url: null, message: "You've signed it; waiting for the other side" });
      let url: string | null;
      try {
        url = await live.provider.embeddedSigningUrl(d.provider_document_id, side);
      } catch (e) {
        return fail(`Couldn't reach the e-signature service (${e instanceof ESignError ? e.code : "unexpected"}); try again shortly`);
      }
      if (!url) return fail("The e-signature service has no signing page for you on this document right now");
      await store.audit(user.id, "open_agreement_signing", agreement_id, { side, provider_document_id: d.provider_document_id });
      return json({ agreement_id, side, signing_url: url, signing_origin: new URL(url).origin, signing_origin_allowed: live.provider.signingOrigins.includes(new URL(url).origin), test_mode: d.test_mode, signature_document: await signatureDocumentOf(store, live, agreement_id) });
    },
  );

  server.registerTool(
    "download_agreement_document",
    {
      title: "Download a signed agreement",
      description:
        "Either party's members (the app's workspace, or the other firm): the signed copy of a program agreement Mynt holds (part 'signed'), or the e-signature service's audit certificate with it (part 'certificate'), as base64 with its SHA-256, checked against what Mynt recorded when it was signed. Audited.",
      inputSchema: { agreement_id: UUID, part: z.enum(["signed", "certificate"]).default("signed") },
      annotations: { readOnlyHint: true },
    },
    async ({ agreement_id, part }) => {
      const a = await agreementRow(store, agreement_id);
      const side = a ? await partyOf(a, false) : null;
      if (!a || !side) return fail(`No agreement '${agreement_id}' of yours`);
      const live = esign();
      if (live && a.status === "accepted") await syncDocument(store, live, agreement_id).catch(() => undefined);
      const r = (await store.db.query(`SELECT signed_sealed, signed_sha256, certificate_sealed, certificate_sha256, test_mode FROM ${T}.app_agreement_documents WHERE agreement_id = $1`, [agreement_id])).rows[0];
      const sealedCol = part === "signed" ? r?.signed_sealed : r?.certificate_sealed;
      const hash = (part === "signed" ? r?.signed_sha256 : r?.certificate_sha256) as string | undefined;
      if (!sealedCol || !hash) return fail("There's no signed copy yet: it's kept once both sides have signed by e-signature");
      const content = Buffer.from(unseal(sealedCol as string, false), "base64");
      if (sha256(content) !== hash) return fail("The signed copy doesn't match the hash Mynt recorded; it isn't returned. Tell Mynt's operators");
      await store.audit(user.id, "download_agreement_document", agreement_id, { side, part, sha256: hash });
      return json({ agreement_id, part, file_name: `agreement-${agreement_id.slice(0, 8)}-${part}.pdf`, content_type: "application/pdf", size: content.length, sha256: hash, test_mode: r.test_mode === true, content_base64: content.toString("base64") });
    },
  );
}
