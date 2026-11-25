import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgreementScopesSchema, type AgreementScope } from "./app-agreements-schema.js";
import type { Db } from "./db.js";
import { noticeFirm } from "./firm-notices.js";
import type { Store } from "./store.js";

// The vendor marketplace: vendors list standard services under standard terms, and app workspaces subscribe by
// accepting them, instead of negotiating each deal (app-agreements.ts keeps negotiated ones).
//
// Each offering carries the vendor's standard terms: a link to the document (https) with its SHA-256, a short summary,
// the pricing in words (billed by the vendor directly; Mynt never bills or holds money for it), the scopes they cover
// (AGREEMENT_SCOPES: technology, manpower, financial regulatory operations) and a version. Setting them again with
// anything changed, scopes included, is a new version; agreements already made keep the version they accepted. Terms
// versions from before scopes were recorded have none (an empty list) and stay so until the vendor sets new terms. Listing an
// offering with terms is the vendor's standing acceptance of them (who set them and when is kept).
//
// Subscribing to an offering with terms is click-through: the subscriber names the version it accepts (it must be the
// current one) and the apps (and products) it's for, and Mynt records, with the subscription, one app agreement per
// app (kind 'vendor', with the vendor's firm) already signed: by the vendor through its listing, by the subscriber
// through the click. Each copies the accepted version's document, SHA-256, summary, pricing and scopes (empty when that
// version has none: never invented). Ending the subscription ends those agreements, and ending the last of them ends the subscription.

const T = "financial_products";
type Row = Record<string, unknown>;
type Query = Pick<Db, "query">;
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

export const StandardTermsSchema = z
  .object({
    document_url: z
      .string()
      .url()
      .max(2000)
      .refine((u) => u.startsWith("https://"), "The terms document link must be https"),
    document_sha256: z.string().regex(/^[a-f0-9]{64}$/, "A SHA-256 as 64 lowercase hex characters"),
    summary: z.string().trim().min(10).max(2000).describe("The terms in a few sentences, as subscribers see them before accepting"),
    pricing_summary: z.string().trim().min(3).max(1000).describe("Your pricing in words (e.g. '$0.40 per check, invoiced monthly'); you bill subscribers directly, never through Mynt"),
    scopes: AgreementScopesSchema.describe(
      "What your terms cover, one or more of: technology (a platform or software licence), manpower (people and staffing), financial_regulatory_operations (compliance and regulatory operations); every agreement made on these terms records them",
    ),
  })
  .strict();
export type StandardTermsInput = z.infer<typeof StandardTermsSchema>;

export interface StandardTerms extends Omit<StandardTermsInput, "scopes"> {
  // Empty only on a terms version from before scopes were recorded ("Not set").
  scopes: AgreementScope[];
  version: number;
  set_by: string | null;
  set_at: string | null;
}

/** An offering row's current standard terms, or null when it has none on file. */
export function termsOfRow(r: Row): StandardTerms | null {
  if (r.terms_version == null) return null;
  return {
    version: Number(r.terms_version),
    document_url: r.terms_document_url as string,
    document_sha256: r.terms_document_sha256 as string,
    summary: r.terms_summary as string,
    pricing_summary: r.pricing_summary as string,
    scopes: Array.isArray(r.terms_scopes) ? (r.terms_scopes as AgreementScope[]) : [],
    set_by: (r.terms_set_by as string | null) ?? null,
    set_at: iso(r.terms_set_at),
  };
}

// Scopes compare as a set (the order they're named in doesn't make new terms).
const sameScopes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((s) => b.includes(s));
const same = (a: StandardTerms | null, b: StandardTermsInput) =>
  a !== null &&
  a.document_url === b.document_url &&
  a.document_sha256 === b.document_sha256 &&
  a.summary === b.summary &&
  a.pricing_summary === b.pricing_summary &&
  sameScopes(a.scopes, b.scopes);

/**
 * Sets an offering's standard terms: unchanged terms keep their version, anything changed (scopes included) is the
 * next version.
 * Agreements already made keep the version they accepted (they carry their own copy).
 */
export async function setOfferingTerms(db: Query, offeringId: string, terms: StandardTermsInput, by: string): Promise<{ terms: StandardTerms; changed: boolean }> {
  const row = (await db.query(`SELECT * FROM ${T}.vendor_offerings WHERE id = $1`, [offeringId])).rows[0];
  const current = row ? termsOfRow(row) : null;
  if (current && same(current, terms)) return { terms: current, changed: false };
  const r = (
    await db.query(
      `UPDATE ${T}.vendor_offerings SET terms_version = COALESCE(terms_version, 0) + 1, terms_document_url = $2, terms_document_sha256 = $3, terms_summary = $4, pricing_summary = $5,
         terms_scopes = $7::text[], terms_set_by = $6, terms_set_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [offeringId, terms.document_url, terms.document_sha256, terms.summary, terms.pricing_summary, by, terms.scopes],
    )
  ).rows[0];
  return { terms: termsOfRow(r)!, changed: true };
}

/** One app the subscription is for, with the products (of that app's own) it's used for. */
export type TermsApp = { id: string; name: string; workspace_id: string | null; products: string[] };

/**
 * Records the click-through agreements of a subscription: one per app, signed by both sides at once (the vendor through
 * its listing of these terms, the subscriber now). Returns their ids. Runs in the caller's transaction.
 */
export async function recordClickThrough(
  tx: Query,
  o: { subscription_id: string; offering_id: string; vendor_entity_id: string; terms: StandardTerms; apps: TermsApp[]; by: string },
): Promise<{ id: string; app_id: string }[]> {
  const out: { id: string; app_id: string }[] = [];
  for (const app of o.apps) {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO ${T}.app_agreements (id, workspace_id, app_id, counterparty_entity_id, kind, status, products, terms_summary, document_url, document_sha256,
         proposed_by, responded_by, responded_at, app_signed_by, app_signed_at, counterparty_signed_by, counterparty_signed_at,
         vendor_subscription_id, offering_id, terms_version, pricing_summary, effective_from, scopes)
       VALUES ($1, $2, $3, $4, 'vendor', 'signed', $5, $6, $7, $8, $9, $10, $11, $9, now(), $10, $11, $12, $13, $14, $15, current_date, $16::text[])`,
      [
        id,
        app.workspace_id,
        app.id,
        o.vendor_entity_id,
        JSON.stringify(app.products),
        o.terms.summary,
        o.terms.document_url,
        o.terms.document_sha256,
        o.by,
        o.terms.set_by,
        o.terms.set_at,
        o.subscription_id,
        o.offering_id,
        o.terms.version,
        o.terms.pricing_summary,
        o.terms.scopes, // the accepted version's own (empty for a version from before scopes: never invented)
      ],
    );
    out.push({ id, app_id: app.id });
  }
  return out;
}

/** The open click-through agreements of a subscription. */
export async function openSubscriptionAgreements(db: Query, subscriptionId: string): Promise<Row[]> {
  return (await db.query(`SELECT * FROM ${T}.app_agreements WHERE vendor_subscription_id = $1 AND status IN ('proposed', 'accepted', 'signed') ORDER BY created_at`, [subscriptionId])).rows;
}

/** Ends a subscription's open click-through agreements (the subscription ended), audited one by one, the vendor told. */
export async function endSubscriptionAgreements(store: Store, subscriptionId: string, by: string, reason: string): Promise<string[]> {
  const rows = (
    await store.db.query(
      `UPDATE ${T}.app_agreements SET status = 'terminated', terminated_by = $2, terminated_at = now(), termination_reason = $3, updated_at = now()
        WHERE vendor_subscription_id = $1 AND status IN ('proposed', 'accepted', 'signed') RETURNING id, app_id, workspace_id, counterparty_entity_id, kind, status, products`,
      [subscriptionId, by, reason],
    )
  ).rows;
  for (const r of rows) {
    await store.audit(by, "terminate_app_agreement", r.id as string, {
      app_id: r.app_id,
      workspace_id: r.workspace_id,
      counterparty_entity_id: r.counterparty_entity_id,
      side: "app",
      from_status: "signed",
      reason,
      vendor_subscription_id: subscriptionId,
    });
    await noticeFirm(store, r.counterparty_entity_id as string, "app_agreement.terminated", {
      agreement_id: r.id,
      app_id: r.app_id,
      kind: r.kind,
      status: r.status,
      products: r.products,
      reason,
      vendor_subscription_id: subscriptionId,
    }).catch(() => null);
  }
  return rows.map((r) => r.id as string);
}
