import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_AGREEMENT_KINDS, APP_AGREEMENT_STATUSES } from "./app-agreements-schema.js";
import { cancelSigning, signatureDocumentOf, startSigning } from "./agreement-esign.js";
import { inTransaction } from "./db.js";
import type { ESign } from "./esign/provider.js";
import { currentEsign, type EsignSource } from "./esign-settings.js";
import { noticeFirm } from "./firm-notices.js";
import type { FirmWebhookEvent } from "./runtime.js";
import { effectiveRoles, productStage, type App, type Store, type User } from "./store.js";
import { appRole, memberApp, workspaceRole } from "./workspaces.js";
import { endVendorSubscription, getSubscription, subscriptionInLiveUse, type Subscription } from "./vendors.js";
import { openSubscriptionAgreements } from "./vendor-terms.js";

// An app is the distribution layer: it holds no licences of its own. The financial products it uses are the regulated
// things, each covered by its own firm's licences or a licence provider's sponsorship (sponsorships.ts). What the app's
// workspace does hold is business agreements with the firms behind those products:
//
// - program: with a licence provider sponsoring products the app uses (the provider must sponsor every product named),
// - vendor: with a vendor firm whose services the app relies on (it must list offerings on Mynt),
// - data_sharing: with either of those,
// - msa: a master services agreement, and sla: service levels (agreement-slas.ts), with either of those. Every kind is
//   for one app.
//
// Either side proposes: the app's owners or admins (propose_app_agreement), or a licence provider for its firm
// (propose_workspace_agreement, for an app whose products the firm sponsors). The other side answers it.
//
// Double-yes, like the business-development agent's introductions: the app's owners or admins propose one
// (propose_app_agreement), a member of the other firm accepts or declines it (respond_to_app_agreement), then each side
// signs (sign_app_agreement), and it is signed only once both have. Either side may end it with a reason
// (terminate_app_agreement). Every change is audited (with the app's id, so the app's trail shows it) and the other
// firm is told on its webhooks and notices (firm-notices.ts); the app's side sees the other firm's answers, signatures
// and terminations in its workspace's attention list (attention.ts). Production waits on program agreements: a signed
// one in force with the sponsor of each product the app uses (programAgreementCoverage below, promotions.ts).
//
// Vendor agreements are usually not negotiated: vendors list standard services under standard terms in the vendor
// marketplace, and subscribing with subscribe_vendor_service accepts them, recording a 'vendor' agreement per app already
// signed by both sides (vendor-terms.ts). Those end with their subscription, and ending the last of them ends it.
//
// The app also records which customer segments (personas) it targets, picked from its products' customer_segments
// (set_app_target_segments), and get_app_customers reads them back with live customer counts where Mynt measures them.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

type Row = Record<string, unknown>;
type Kind = (typeof APP_AGREEMENT_KINDS)[number];
const OPEN = ["proposed", "accepted", "signed"];
const MANAGERS = ["owner", "admin"];
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: unknown) => (v == null ? null : typeof v === "string" ? v.slice(0, 10) : new Date(v as Date).toISOString().slice(0, 10));
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date as YYYY-MM-DD");
const UUID = z.string().uuid();

export interface AppAgreement {
  id: string;
  workspace_id: string | null;
  app_id: string | null;
  counterparty_entity_id: string;
  kind: Kind;
  status: (typeof APP_AGREEMENT_STATUSES)[number];
  products: string[];
  terms_summary: string;
  document_url: string | null;
  document_sha256: string | null;
  effective_from: string | null;
  effective_to: string | null;
  proposed_by: string | null;
  proposed_at: string;
  responded_by: string | null;
  responded_at: string | null;
  response_note: string | null;
  app_signed_by: string | null;
  app_signed_at: string | null;
  counterparty_signed_by: string | null;
  counterparty_signed_at: string | null;
  signed_at: string | null; // when it became signed (by both sides, or by a completed e-signature)
  terminated_by: string | null;
  terminated_at: string | null;
  termination_reason: string | null;
  // A vendor's standard terms accepted by click-through (vendor-terms.ts): the subscription it came with, the offering,
  // the version accepted and its pricing. Null on a negotiated agreement.
  vendor_subscription_id: string | null;
  offering_id: string | null;
  terms_version: number | null;
  pricing_summary: string | null;
  // Which side proposed it (the other answers it), and the licence provider's template it was proposed on, if any.
  proposed_by_side: "app" | "counterparty";
  template_id: string | null;
  created_at: string;
  updated_at: string;
}

const toAgreement = (r: Row): AppAgreement => ({
  id: r.id as string,
  workspace_id: (r.workspace_id as string | null) ?? null,
  app_id: (r.app_id as string | null) ?? null,
  counterparty_entity_id: r.counterparty_entity_id as string,
  kind: r.kind as Kind,
  status: r.status as AppAgreement["status"],
  products: Array.isArray(r.products) ? (r.products as string[]) : [],
  terms_summary: r.terms_summary as string,
  document_url: (r.document_url as string | null) ?? null,
  document_sha256: (r.document_sha256 as string | null) ?? null,
  effective_from: day(r.effective_from),
  effective_to: day(r.effective_to),
  proposed_by: (r.proposed_by as string | null) ?? null,
  proposed_at: iso(r.proposed_at)!,
  responded_by: (r.responded_by as string | null) ?? null,
  responded_at: iso(r.responded_at),
  response_note: (r.response_note as string | null) ?? null,
  app_signed_by: (r.app_signed_by as string | null) ?? null,
  app_signed_at: iso(r.app_signed_at),
  counterparty_signed_by: (r.counterparty_signed_by as string | null) ?? null,
  counterparty_signed_at: iso(r.counterparty_signed_at),
  signed_at: iso(r.signed_at),
  terminated_by: (r.terminated_by as string | null) ?? null,
  terminated_at: iso(r.terminated_at),
  termination_reason: (r.termination_reason as string | null) ?? null,
  vendor_subscription_id: (r.vendor_subscription_id as string | null) ?? null,
  offering_id: (r.offering_id as string | null) ?? null,
  terms_version: r.terms_version == null ? null : Number(r.terms_version),
  pricing_summary: (r.pricing_summary as string | null) ?? null,
  proposed_by_side: r.proposed_by_side === "counterparty" ? "counterparty" : "app",
  template_id: (r.template_id as string | null) ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

async function getAgreement(store: Store, id: string): Promise<AppAgreement | undefined> {
  if (!UUID.safeParse(id).success) return undefined;
  const r = (await store.db.query(`SELECT * FROM ${T}.app_agreements WHERE id = $1`, [id])).rows[0];
  return r ? toAgreement(r) : undefined;
}

// The licence providers sponsoring each of the app's products (approved sponsorships), with where they sponsor it.
async function sponsorsOf(store: Store, productId: string) {
  const approved = await store.sponsorships({ product_id: productId, status: "approved" });
  const byFirm = new Map<string, { entity_id: string; name: string | null; jurisdictions: Set<string> }>();
  for (const s of approved) {
    const f = byFirm.get(s.provider_entity_id) ?? { entity_id: s.provider_entity_id, name: (await store.getEntity(s.provider_entity_id))?.name ?? null, jurisdictions: new Set<string>() };
    s.jurisdictions.forEach((j) => f.jurisdictions.add(j));
    byFirm.set(s.provider_entity_id, f);
  }
  return [...byFirm.values()].map((f) => ({ entity_id: f.entity_id, name: f.name, jurisdictions: [...f.jurisdictions].sort() }));
}

// The customer segments a product's definition declares (its working copy).
const segmentsOf = (definition: Record<string, unknown> | null) =>
  (Array.isArray(definition?.customer_segments) ? (definition!.customer_segments as Row[]) : [])
    .filter((s) => typeof s?._id === "string")
    .map((s) => ({ id: s._id as string, name: typeof s.name === "string" && s.name ? s.name : (s._id as string), customer_kind: typeof s.customer_kind === "string" ? s.customer_kind : null, description: typeof s.description === "string" ? s.description : null }));

// The app's products as the app side sees them: stage, sponsors and where they're sponsored.
async function appProducts(store: Store, app: App) {
  return Promise.all(
    app.product_ids.map(async (id) => {
      const record = await store.getProduct(id);
      if (!record) return { id, name: id, missing: true, stage: null, sponsors: [], states: [], customer_segments: [] };
      const sponsors = await sponsorsOf(store, id);
      return {
        id,
        name: record.product.name,
        stage: productStage(record),
        sponsors,
        states: [...new Set(sponsors.flatMap((s) => s.jurisdictions))].sort(),
        customer_segments: segmentsOf(record.definition),
      };
    }),
  );
}

// The firms of the app's workspace's members (or its owner's, for an app in no workspace).
export async function memberFirms(store: Store, app: App): Promise<string[]> {
  const { rows } = app.workspace_id
    ? await store.db.query(`SELECT DISTINCT u.entity_id FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.entity_id IS NOT NULL`, [app.workspace_id])
    : await store.db.query(`SELECT entity_id FROM ${T}.users WHERE id = $1 AND entity_id IS NOT NULL`, [app.owner_id]);
  return rows.map((r) => r.entity_id as string);
}

// The vendor services the app's workspace relies on: active subscriptions of its members' firms.
async function vendorContracts(store: Store, app: App) {
  const firms = await memberFirms(store, app);
  if (!firms.length) return [];
  const { rows } = await store.db.query(
    `SELECT s.id, s.live, s.status, s.created_at, s.offering_id, o.name AS offering, o.service_type, o.entity_id AS vendor_entity_id, o.terms_version AS current_terms_version, e.name AS vendor,
            (SELECT count(*)::int FROM ${T}.app_agreements a WHERE a.vendor_subscription_id = s.id) AS accepted_any,
            mine.id AS agreement_id, mine.terms_version, mine.document_url AS terms_document_url, mine.app_signed_at AS accepted_at
       FROM ${T}.vendor_subscriptions s JOIN ${T}.vendor_offerings o ON o.id = s.offering_id LEFT JOIN ${T}.entities e ON e.id = o.entity_id
       LEFT JOIN ${T}.app_agreements mine ON mine.vendor_subscription_id = s.id AND mine.app_id = $2 AND mine.status IN ('proposed', 'accepted', 'signed')
      WHERE s.entity_id = ANY($1::uuid[]) AND s.status = 'active' ORDER BY s.created_at`,
    [firms, app.id],
  );
  return rows.map((r) => ({
    subscription_id: r.id,
    offering_id: r.offering_id,
    vendor: { entity_id: r.vendor_entity_id, name: r.vendor ?? null },
    offering: r.offering,
    service_type: r.service_type,
    environment: r.live ? "live" : "test",
    since: iso(r.created_at),
    // The vendor's standard terms accepted for this app (click-through), if any.
    agreement_id: r.agreement_id ?? null,
    terms_version: r.terms_version == null ? null : Number(r.terms_version),
    terms_document_url: r.terms_document_url ?? null,
    accepted_at: iso(r.accepted_at),
    current_terms_version: r.current_terms_version == null ? null : Number(r.current_terms_version),
    // Subscribed before the vendor had standard terms on file (or without accepting any): no agreement records them.
    no_standard_terms: !r.accepted_any,
    for_this_app: Boolean(r.agreement_id),
  }));
}

// Introductions the business-development agent has in progress for the workspace's members (bd.ts): double-yes, so
// the other side is named only once both have said yes.
async function introductions(store: Store, app: App) {
  const has = (await store.db.query(`SELECT to_regclass('${T}.bd_intros') IS NOT NULL AS ok`)).rows[0]?.ok;
  if (!has) return null;
  const members = app.workspace_id
    ? (await store.db.query(`SELECT user_id FROM ${T}.workspace_members WHERE workspace_id = $1`, [app.workspace_id])).rows.map((r) => r.user_id as string)
    : [app.owner_id];
  if (!members.length) return [];
  const { rows } = await store.db.query(
    `SELECT i.id, i.status, i.created_at, i.updated_at, i.a_yes, i.b_yes, mine.id AS mine_id, i.a, other.name AS other_name, other.org AS other_org, other.kind AS other_kind
       FROM ${T}.bd_intros i
       JOIN ${T}.bd_prospects mine ON (mine.id = i.a OR mine.id = i.b) AND mine.user_id = ANY($1::uuid[])
       JOIN ${T}.bd_prospects other ON other.id = CASE WHEN mine.id = i.a THEN i.b ELSE i.a END
      WHERE i.status <> 'declined' ORDER BY i.updated_at DESC LIMIT 50`,
    [members],
  );
  return rows.map((r) => {
    const agreed = r.status === "agreed" || r.status === "made";
    const mineIsA = r.mine_id === r.a;
    return {
      id: r.id,
      status: r.status,
      counterparty: agreed ? { name: (r.other_org as string | null) ?? (r.other_name as string), kind: r.other_kind } : null,
      your_side_said_yes: (mineIsA ? r.a_yes : r.b_yes) ?? null,
      other_side_said_yes: (mineIsA ? r.b_yes : r.a_yes) ?? null,
      since: iso(r.created_at),
      updated_at: iso(r.updated_at),
    };
  });
}

// ---- the production gate: a signed program agreement with each product's sponsor ----
//
// An app moves to production only with a signed program agreement, in force today, with the licence provider
// sponsoring each product it uses, covering that product (promotions.ts, the program_agreements check). Which sponsors
// count: those sponsoring the product in a state the app serves (a sponsorship for the whole country counts for each of
// its states), or every sponsor of it while the app's states aren't set. A product no licence provider sponsors is
// covered by its own firm's licences, so it needs none. In force: signed by both sides, effective_from on or before
// today (or unset), effective_to today or later (or unset). One that ends, or is terminated, after the app reached
// production doesn't move the app back: the check fails, and the workspace's attention list, the app's Agreements tab
// and ops_status flag it.

export interface ProgramCoverage {
  product_id: string;
  product_name: string;
  sponsor_entity_id: string;
  sponsor_name: string | null;
  covered: boolean;
  agreement_id: string | null; // the agreement it rests on, or the nearest one when none is in force
  agreement_status: AppAgreement["status"] | null;
  note: string | null; // why the nearest agreement doesn't count, in words
}

type Q = Pick<Store["db"], "query">;
export const today = () => new Date().toISOString().slice(0, 10);

// Whether a program agreement is signed and in force on `on`.
export const inForce = (a: Pick<AppAgreement, "status" | "effective_from" | "effective_to">, on: string) =>
  a.status === "signed" && (!a.effective_from || a.effective_from <= on) && (!a.effective_to || a.effective_to >= on);

// Each side's signature on an accepted agreement: the agreement's own (signed by hand), or, where it's signed by
// e-signature, the e-signature document's (the agreement's own are set only once both have signed there).
type Signed = { app: boolean; counterparty: boolean };
const signedSides = (a: AppAgreement, esign?: Signed): Signed => ({ app: a.app_signed_at !== null || Boolean(esign?.app), counterparty: a.counterparty_signed_at !== null || Boolean(esign?.counterparty) });

function whyNot(a: AppAgreement, sponsor: string, on: string, esign?: Signed): string {
  if (a.status === "signed") return a.effective_from && a.effective_from > on ? `its signed agreement takes effect on ${a.effective_from}` : `its signed agreement ended on ${a.effective_to}`;
  if (a.status === "accepted") {
    const s = signedSides(a, esign);
    return `${sponsor} accepted it; waiting for ${!s.app && !s.counterparty ? "both signatures" : s.app ? `${sponsor}'s signature` : "your signature"}`;
  }
  if (a.status === "proposed") return `proposed, waiting for ${sponsor} to accept`;
  if (a.status === "declined") return `${sponsor} declined it`;
  return `it was ended on ${a.terminated_at?.slice(0, 10) ?? "an earlier date"}${a.termination_reason ? `: ${a.termination_reason}` : ""}`;
}

// Each (product, sponsor) pair the app needs a program agreement for, and whether one in force covers it. Every
// approved sponsor of every product the app uses counts, wherever the app serves (the operator's rule).
export async function programAgreementCoverage(q: Q, store: Store, app: Pick<App, "id" | "product_ids">, on = today()): Promise<ProgramCoverage[]> {
  if (!app.product_ids.length) return [];
  const rows = (
    await q.query(
      `SELECT g.*, d.app_signed_at AS esign_app_signed_at, d.counterparty_signed_at AS esign_counterparty_signed_at
         FROM ${T}.app_agreements g LEFT JOIN ${T}.app_agreement_documents d ON d.agreement_id = g.id
        WHERE g.app_id = $1 AND g.kind = 'program' ORDER BY g.created_at DESC`,
      [app.id],
    )
  ).rows;
  const agreements = rows.map(toAgreement);
  // Where an agreement is signed by e-signature, each side's signature as the document has it (agreement-esign.ts).
  const esignSigned = new Map(rows.map((r) => [r.id as string, { app: r.esign_app_signed_at != null, counterparty: r.esign_counterparty_signed_at != null }]));
  // The nearest agreement when none is in force: one on its way first, then the latest that ended (expired,
  // terminated or declined). The list is newest first, and the sort keeps that order within a rank.
  const rank = (a: AppAgreement) => (inForce(a, on) ? 0 : a.status === "signed" && a.effective_from && a.effective_from > on ? 1 : a.status === "accepted" ? 2 : a.status === "proposed" ? 3 : 4);
  const out: ProgramCoverage[] = [];
  for (const productId of app.product_ids) {
    const record = await store.getProduct(productId);
    if (!record) continue; // the licences check names a product that doesn't exist
    const approved = await store.sponsorships({ product_id: productId, status: "approved" });
    for (const sponsor of new Set(approved.map((s) => s.provider_entity_id))) {
      const name = (await store.getEntity(sponsor))?.name ?? null;
      const nearest = agreements.filter((a) => a.counterparty_entity_id === sponsor && a.products.includes(productId)).sort((a, b) => rank(a) - rank(b))[0];
      const covered = !!nearest && inForce(nearest, on);
      out.push({
        product_id: productId,
        product_name: record.product.name,
        sponsor_entity_id: sponsor,
        sponsor_name: name,
        covered,
        agreement_id: nearest?.id ?? null,
        agreement_status: nearest?.status ?? null,
        note: nearest && !covered ? whyNot(nearest, name ?? "the sponsor", on, esignSigned.get(nearest.id)) : null,
      });
    }
  }
  return out;
}

// The words for one pair with no agreement in force.
export const missingAgreementText = (c: ProgramCoverage) => `No signed program agreement with ${c.sponsor_name ?? c.sponsor_entity_id} for ${c.product_name}${c.note ? ` (${c.note})` : ""}`;

// A firm that lists vendor offerings on Mynt.
const isVendorFirm = async (store: Store, entityId: string) =>
  Boolean((await store.db.query(`SELECT 1 FROM ${T}.vendor_offerings WHERE entity_id = $1 LIMIT 1`, [entityId])).rows[0]);

// An agreement as either side sees it: both parties named, the products named.
async function describe(store: Store, esign: ESign | null, a: AppAgreement) {
  const [app, counterparty] = await Promise.all([a.app_id ? store.getApp(a.app_id) : undefined, store.getEntity(a.counterparty_entity_id)]);
  const products = await Promise.all(a.products.map(async (id) => ({ id, name: (await store.getProduct(id))?.product.name ?? id })));
  // The developer workspace behind the app, by name, for the other firm's list.
  const workspace = a.workspace_id ? (await store.db.query(`SELECT name FROM ${T}.workspaces WHERE id = $1`, [a.workspace_id])).rows[0] : undefined;
  const document = a.kind === "program" ? await signatureDocumentOf(store, esign, a.id) : null;
  return {
    ...a,
    app: a.app_id ? { id: a.app_id, name: app?.name ?? null } : null,
    workspace: a.workspace_id ? { id: a.workspace_id, name: (workspace?.name as string | undefined) ?? null } : null,
    counterparty: { entity_id: a.counterparty_entity_id, name: counterparty?.name ?? null },
    products: products,
    signatures: { app_side: a.app_signed_at !== null, counterparty_side: a.counterparty_signed_at !== null },
    // Program agreements are signed by e-signature where it's configured (agreement-esign.ts).
    signed_by_esignature: esign !== null && a.kind === "program",
    signature_document: document,
    // The licence provider's template it was proposed on, or the one its e-signature document was made from.
    template: (await templateOf(store, a.template_id)) ?? document?.template ?? null,
  };
}

async function templateOf(store: Store, id: string | null) {
  if (!id) {
    return null;
  }
  const t = (await store.db.query(`SELECT name, version FROM ${T}.agreement_templates WHERE id = $1`, [id])).rows[0];
  return t ? { id, name: t.name as string, version: Number(t.version) } : null;
}

// A workspace's apps (any member's).
async function workspaceApps(store: Store, workspaceId: string): Promise<App[]> {
  const { rows } = await store.db.query(`SELECT id FROM ${T}.apps WHERE workspace_id = $1 ORDER BY created_at`, [workspaceId]);
  return (await Promise.all(rows.map((r) => store.getApp(r.id as string)))).filter((a): a is App => Boolean(a));
}

// The app's side (developers): propose, sign, terminate and list an app's agreements; choose its target customers.
// The counterparty's side (licence providers and vendors): respond, sign, terminate and list the agreements naming its
// firm. One account can be both; each call works out which side it acts for from the agreement.
export function registerAppAgreementTools(server: McpServer, store: Store, user: User, sides: { app: boolean; counterparty: boolean }, esignSource: EsignSource = null) {
  // E-signature as it's configured now (an admin may set it up or change it while the server runs).
  const esign = () => currentEsign(esignSource);
  // The caller's firm, when it may act for it as a counterparty (read afresh: a licence provider without standing at
  // its firm acts for none, store.ts rolesWithStanding). licenceProvider: only a licence provider's firm.
  const myFirm = async (licenceProvider = false) => {
    if (!sides.counterparty) return null;
    const me = await store.getUser(user.id);
    const roles = me ? effectiveRoles(me.roles) : [];
    return me?.entity_id && (roles.includes("license_provider") || (!licenceProvider && roles.includes("vendor"))) ? me.entity_id : null;
  };
  // The app, when the caller is one of its workspace's owners or admins.
  const managedApp = async (appId: string) => {
    if (!sides.app) return { app: undefined, error: `No app '${appId}' of yours` };
    const app = await memberApp(store, user, appId);
    if (!app) return { app: undefined, error: `No app '${appId}' of yours` };
    if (!MANAGERS.includes((await appRole(store, user, app)) ?? "")) return { app: undefined, error: "Only the workspace's owners and admins make agreements for its apps" };
    return { app, error: null };
  };
  // The caller's role in a workspace (null: not a member, or not a developer here).
  const roleIn = async (workspaceId: string | null) => (sides.app && workspaceId && UUID.safeParse(workspaceId).success ? workspaceRole(store.db, workspaceId, user.id) : null);
  // The caller's role on the app's side of an agreement: in the app's workspace.
  const appSideRole = async (a: Pick<AppAgreement, "app_id">): Promise<string | null> => {
    if (!sides.app || !a.app_id) return null;
    const app = await memberApp(store, user, a.app_id);
    return app ? ((await appRole(store, user, app)) ?? null) : null;
  };
  // Who the caller is on an agreement: a member of the app's side (a manager or not), and/or its counterparty.
  const partyOf = async (a: AppAgreement) => {
    const role = await appSideRole(a);
    return { app: role !== null, manager: MANAGERS.includes(role ?? ""), counterparty: (await myFirm()) === a.counterparty_entity_id };
  };
  type Party = Awaited<ReturnType<typeof partyOf>>;
  // Which side the caller acts for on this agreement, if any (the app's side first, for one account on both).
  const sideOf = async (a: AppAgreement): Promise<"app" | "counterparty" | null> => {
    const p = await partyOf(a);
    return p.manager ? "app" : p.counterparty ? "counterparty" : null;
  };
  // What the caller may do with an agreement now. The side that didn't propose it answers it; the proposer may
  // withdraw it until then. Each side signs an accepted one once; either ends an accepted or signed one.
  const actionsFor = (a: AppAgreement, p: Party, signed: Signed) => {
    const mine = (side: "app" | "counterparty") => (side === "app" ? p.manager : p.counterparty);
    const answerer = a.proposed_by_side === "app" ? "counterparty" : "app";
    if (a.status === "proposed") return [...(mine(answerer) ? ["accept", "decline"] : []), ...(mine(a.proposed_by_side) ? ["withdraw"] : [])];
    if (a.status === "accepted") return [...((p.manager && !signed.app) || (p.counterparty && !signed.counterparty) ? ["sign"] : []), ...(p.manager || p.counterparty ? ["end"] : [])];
    if (a.status === "signed") return p.manager || p.counterparty ? ["end"] : [];
    return [];
  };
  // An agreement as the caller sees it: described, with the caller's side and what they may do.
  const view = async (a: AppAgreement, party?: Party) => {
    const d = await describe(store, esign(), a);
    const p = party ?? (await partyOf(a));
    const doc = d.signature_document;
    const signed = signedSides(a, doc ? { app: doc.signers.app.signed, counterparty: doc.signers.counterparty.signed } : undefined);
    return { ...d, your_side: p.counterparty ? (p.app ? "both" : "counterparty") : "app", actions: actionsFor(a, p, signed) };
  };
  // Tell the other firm (the counterparty).
  const tell = async (a: AppAgreement, type: FirmWebhookEvent, extra: Record<string, unknown> = {}) => {
    const told = await noticeFirm(store, a.counterparty_entity_id, type, { agreement_id: a.id, app_id: a.app_id, workspace_id: a.workspace_id, kind: a.kind, status: a.status, products: a.products, ...extra }).catch(() => null);
    return told ? told.webhooks + told.members : 0;
  };
  // Tell the app's side: the firms of its workspace's members (or the app owner's).
  const tellAppSide = async (a: AppAgreement, type: FirmWebhookEvent, extra: Record<string, unknown> = {}) => {
    const app = a.app_id ? await store.getApp(a.app_id) : undefined;
    const firms = app ? await memberFirms(store, app) : [];
    let told = 0;
    for (const f of new Set(firms)) {
      if (f === a.counterparty_entity_id) continue;
      const r = await noticeFirm(store, f, type, { agreement_id: a.id, app_id: a.app_id, workspace_id: a.workspace_id, kind: a.kind, status: a.status, products: a.products, ...extra }).catch(() => null);
      told += r ? r.webhooks + r.members : 0;
    }
    return told;
  };
  const insert = async (o: { workspace_id: string | null; app_id: string | null; counterparty: string; kind: Kind; products: string[]; terms_summary: string; document_url?: string; document_sha256?: string; effective_from?: string; effective_to?: string; side: "app" | "counterparty"; template_id?: string | null }) =>
    toAgreement(
      (
        await store.db.query(
          `INSERT INTO ${T}.app_agreements (id, workspace_id, app_id, counterparty_entity_id, kind, products, terms_summary, document_url, document_sha256, effective_from, effective_to, proposed_by, proposed_by_side, template_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
          [randomUUID(), o.workspace_id, o.app_id, o.counterparty, o.kind, JSON.stringify(o.products), o.terms_summary, o.document_url ?? null, o.document_sha256 ?? null, o.effective_from ?? null, o.effective_to ?? null, user.id, o.side, o.template_id ?? null],
        )
      ).rows[0],
    );
  // An open negotiated agreement of this kind between the same parties for the app.
  const openOne = async (appId: string, counterparty: string, kind: Kind) =>
    (await store.db.query(`SELECT id FROM ${T}.app_agreements WHERE app_id = $1 AND counterparty_entity_id = $2 AND kind = $3 AND status = ANY($4) AND vendor_subscription_id IS NULL`, [appId, counterparty, kind, OPEN])).rows[0] as
      | { id: string }
      | undefined;
  const DOC_URL = z.string().url().max(2000).refine((u) => u.startsWith("https://"), "The document link must be https");
  const SHA = z.string().regex(/^[a-f0-9]{64}$/, "A SHA-256 as 64 lowercase hex characters");

  if (sides.app) {
    server.registerTool(
      "propose_app_agreement",
      {
        title: "Propose an agreement for an app",
        description:
          "Developer (the app's workspace owners and admins): propose a business agreement between the app's workspace and another firm, for that app: 'program' with a licence provider that sponsors every product named (see list_app_agreements' products and their sponsors), 'vendor' with a firm that lists vendor services on Mynt, 'data_sharing' with either, 'msa' (a master services agreement) or 'sla' (service levels, set with add_agreement_sla) with either. Name the products it covers (from the app's own), a short summary of the terms, and optionally a link to the document (https) with its SHA-256 and the dates it runs between. The other firm is told and accepts or declines it (respond_to_app_agreement); then both sides sign (sign_app_agreement). Apps hold no licences themselves: licence coverage is the products'. Audited.",
        inputSchema: {
          app_id: UUID,
          counterparty_entity_id: UUID.describe("The other firm's id: a sponsor of the app's products, or a vendor"),
          kind: z.enum(APP_AGREEMENT_KINDS),
          products: z.array(z.string().min(1).max(200)).max(20).default([]).describe("Ids of the app's products the agreement covers; at least one for a program agreement"),
          terms_summary: z.string().trim().min(10).max(4000),
          document_url: DOC_URL.optional(),
          document_sha256: SHA.optional(),
          effective_from: DATE.optional(),
          effective_to: DATE.optional(),
        },
      },
      async ({ app_id, counterparty_entity_id, kind, products, terms_summary, document_url, document_sha256, effective_from, effective_to }) => {
        const { app, error } = await managedApp(app_id);
        if (!app) return fail(error!);
        const covered = [...new Set(products)];
        const foreign = covered.filter((p) => !app.product_ids.includes(p));
        if (foreign.length) return fail(`${app.name} doesn't use ${foreign.map((p) => `'${p}'`).join(", ")}: an agreement covers only the app's own products`);
        if (effective_from && effective_to && effective_to < effective_from) return fail("effective_to is before effective_from");
        if (document_sha256 && !document_url) return fail("document_sha256 needs the document_url it's the hash of");
        const firm = await store.getEntity(counterparty_entity_id);
        if (!firm) return fail(`No firm '${counterparty_entity_id}' on Mynt`);
        if ((await memberFirms(store, app)).includes(counterparty_entity_id)) return fail("That's your own workspace's firm: an agreement is with another firm");
        const sponsorsOfEach = await Promise.all(app.product_ids.map(async (p) => ({ p, sponsors: (await sponsorsOf(store, p)).map((s) => s.entity_id) })));
        const sponsors = (p: string) => sponsorsOfEach.find((x) => x.p === p)?.sponsors ?? [];
        const sponsorsAny = sponsorsOfEach.some((x) => x.sponsors.includes(counterparty_entity_id));
        if (kind === "program") {
          if (!covered.length) return fail("A program agreement names the products it covers: those the licence provider sponsors");
          const unsponsored = covered.filter((p) => !sponsors(p).includes(counterparty_entity_id));
          if (unsponsored.length) return fail(`${firm.name} doesn't sponsor ${unsponsored.map((p) => `'${p}'`).join(", ")}: a program agreement is with the licence provider sponsoring each product it covers`);
        } else if (kind === "vendor") {
          if (!(await isVendorFirm(store, counterparty_entity_id))) return fail(`${firm.name} lists no vendor services on Mynt`);
        } else if (!sponsorsAny && !(await isVendorFirm(store, counterparty_entity_id))) {
          return fail(`${firm.name} neither sponsors the app's products nor lists vendor services on Mynt`);
        }
        const open = await openOne(app.id, counterparty_entity_id, kind);
        if (open) return fail(`There's already an open ${kind} agreement with ${firm.name} for this app (${open.id}); terminate it first`);
        const a = await insert({ workspace_id: app.workspace_id, app_id: app.id, counterparty: counterparty_entity_id, kind, products: covered, terms_summary, document_url, document_sha256, effective_from, effective_to, side: "app" });
        await store.audit(user.id, "propose_app_agreement", a.id, { app_id: a.app_id, workspace_id: a.workspace_id, counterparty_entity_id, kind, products: covered, document_sha256: document_sha256 ?? null, side: "app" });
        const told = await tell(a, "app_agreement.proposed", { app_name: app.name, terms_summary, respond_with: "respond_to_app_agreement { agreement_id, decision }" });
        return json({ ...(await view(a)), counterparty_told: told > 0 });
      },
    );
  }

  // Licence providers propose to workspaces (vendors' terms come with their marketplace subscriptions instead).
  if (sides.counterparty && effectiveRoles(user.roles).includes("license_provider")) {
    server.registerTool(
      "propose_workspace_agreement",
      {
        title: "Propose an agreement to a workspace's app",
        description:
          "Licence provider (for your own firm): propose a business agreement for one app (app_id) of a developer workspace whose apps use products your firm sponsors (see list_app_agreements without app_id: proposable_workspaces): 'program' covering products you sponsor for it, 'data_sharing', 'msa' (a master services agreement) or 'sla' (service levels, set with add_agreement_sla). Optionally name one of your firm's active agreement templates (template_id: a program agreement signed by e-signature is made from it), a link to the document (https) with its SHA-256, and the dates it runs between. The workspace's owners and admins accept or decline it (respond_to_app_agreement); then both sides sign. Audited; the workspace is told.",
        inputSchema: {
          workspace_id: UUID.describe("The app's workspace"),
          app_id: UUID,
          kind: z.enum(["program", "data_sharing", "msa", "sla"]),
          products: z.array(z.string().min(1).max(200)).max(20).default([]),
          terms_summary: z.string().trim().min(10).max(4000),
          document_url: DOC_URL.optional(),
          document_sha256: SHA.optional(),
          template_id: UUID.optional(),
          effective_from: DATE.optional(),
          effective_to: DATE.optional(),
        },
      },
      async ({ workspace_id, app_id, kind, products, terms_summary, document_url, document_sha256, template_id, effective_from, effective_to }) => {
        const firm = await myFirm(true);
        if (!firm) return fail("You don't act for a firm as a licence provider; its licence providers propose agreements");
        const app = await store.getApp(app_id);
        if (!app || app.workspace_id !== workspace_id) return fail(`No app '${app_id}' in workspace '${workspace_id}'`);
        const covered = [...new Set(products)];
        const foreign = covered.filter((p) => !app.product_ids.includes(p));
        if (foreign.length) return fail(`${app.name} doesn't use ${foreign.map((p) => `'${p}'`).join(", ")}`);
        if (effective_from && effective_to && effective_to < effective_from) return fail("effective_to is before effective_from");
        if (document_sha256 && !document_url) return fail("document_sha256 needs the document_url it's the hash of");
        if ((await memberFirms(store, app)).includes(firm)) return fail("That's your own firm's workspace: an agreement is with another firm");
        const sponsored = new Set<string>();
        for (const p of app.product_ids) if ((await sponsorsOf(store, p)).some((s) => s.entity_id === firm)) sponsored.add(p);
        if (kind === "program") {
          if (!covered.length) return fail("A program agreement names the products it covers: those your firm sponsors");
          const not = covered.filter((p) => !sponsored.has(p));
          if (not.length) return fail(`Your firm doesn't sponsor ${not.map((p) => `'${p}'`).join(", ")}`);
        } else if (!sponsored.size) {
          const before = (await store.db.query(`SELECT 1 FROM ${T}.app_agreements WHERE app_id = $1 AND counterparty_entity_id = $2 LIMIT 1`, [app.id, firm])).rows[0];
          if (!before) return fail("Your firm sponsors none of that app's products");
        }
        if (template_id) {
          const t = (await store.db.query(`SELECT 1 FROM ${T}.agreement_templates WHERE id = $1 AND entity_id = $2 AND active`, [template_id, firm])).rows[0];
          if (!t) return fail(`No template '${template_id}' of your firm in use`);
        }
        const open = await openOne(app.id, firm, kind);
        if (open) return fail(`There's already an open ${kind} agreement with ${app.name} (${open.id}); terminate it first`);
        const a = await insert({ workspace_id, app_id: app.id, counterparty: firm, kind, products: covered, terms_summary, document_url, document_sha256, effective_from, effective_to, side: "counterparty", template_id: template_id ?? null });
        await store.audit(user.id, "propose_app_agreement", a.id, { app_id: a.app_id, workspace_id, counterparty_entity_id: firm, kind, products: covered, document_sha256: document_sha256 ?? null, template_id: template_id ?? null, side: "counterparty" });
        const told = await tellAppSide(a, "app_agreement.proposed", { counterparty_name: (await store.getEntity(firm))?.name ?? null, terms_summary, respond_with: "respond_to_app_agreement { agreement_id, decision }" });
        return json({ ...(await view(a)), workspace_told: told > 0 });
      },
    );
  }

  server.registerTool(
    "respond_to_app_agreement",
    {
      title: "Accept or decline an agreement",
      description:
        "The side that didn't propose an agreement answers it: a licence provider or vendor for its firm (an agreement an app's workspace proposed to it), or the workspace's owners and admins (one a licence provider proposed to it). Accepting lets both sides sign it (sign_app_agreement); declining ends it. The side that proposed it can't answer it, only withdraw it (terminate_app_agreement). Audited.",
      inputSchema: { agreement_id: UUID, decision: z.enum(["accept", "decline"]), note: z.string().trim().max(2000).optional() },
    },
    async ({ agreement_id, decision, note }) => {
      const a = await getAgreement(store, agreement_id);
      const p = a ? await partyOf(a) : null;
      if (!a || !p || (!p.counterparty && !p.app)) return fail(`No agreement '${agreement_id}' proposed to you`);
      const answerer = a.proposed_by_side === "app" ? "counterparty" : "app";
      if (answerer === "counterparty" ? !p.counterparty : !p.manager) {
        if (answerer === "app" && p.app) return fail("Only the workspace's owners and admins answer agreements for it");
        return fail("Your side proposed it: the other side accepts or declines it (you may withdraw it with terminate_app_agreement)");
      }
      const status = decision === "accept" ? "accepted" : "declined";
      const r = (
        await store.db.query(
          `UPDATE ${T}.app_agreements SET status = $2, responded_by = $3, responded_at = now(), response_note = $4, updated_at = now() WHERE id = $1 AND status = 'proposed' RETURNING *`,
          [a.id, status, user.id, note ?? null],
        )
      ).rows[0];
      if (!r) return fail(`That agreement is ${a.status}, not waiting for an answer`);
      const done = toAgreement(r);
      await store.audit(user.id, decision === "accept" ? "accept_app_agreement" : "decline_app_agreement", done.id, { app_id: done.app_id, workspace_id: done.workspace_id, counterparty_entity_id: done.counterparty_entity_id, kind: done.kind, note: note ?? null, side: answerer });
      // The app's side answered: the licence provider's firm is told. (The app's side hears of the firm's answers in
      // its workspace's attention list.)
      if (answerer === "app") await tell(done, "app_agreement.answered", { decision, note: note ?? null });
      // An accepted program agreement goes to e-signature at once where it's configured; if that can't happen yet
      // (no template, the service unreachable) it's made when someone first asks to sign (get_agreement_signing_link).
      const signing = esign() && done.kind === "program" && status === "accepted" ? await startSigning(store, esign(), done.id, user.id) : null;
      return json({ ...(await view(done)), ...(signing ? { signing: signing.ok ? { ready: true } : { ready: false, reason: signing.error } } : {}) });
    },
  );

  server.registerTool(
    "sign_app_agreement",
    {
      title: "Sign an app agreement",
      description:
        "Either side of an accepted agreement records its signature: the workspace's owners or admins for the app's side, a member of the other firm for it. It becomes signed only once both sides have. Where e-signature is configured, program agreements are signed by e-signature instead (get_agreement_signing_link) and this refuses them. Audited, and the other firm is told when it's signed.",
      inputSchema: { agreement_id: UUID },
    },
    async ({ agreement_id }) => {
      const a = await getAgreement(store, agreement_id);
      const side = a ? await sideOf(a) : null;
      if (!a || !side) return fail(`No agreement '${agreement_id}' you can sign`);
      if (a.status !== "accepted") return fail(a.status === "proposed" ? (a.proposed_by_side === "app" ? "The other firm hasn't accepted it yet" : "It hasn't been accepted yet") : `That agreement is ${a.status}`);
      // With e-signature configured, only a completed e-signature signs a program agreement.
      if (esign() && a.kind === "program") return fail("This deployment signs program agreements by e-signature: each signer opens get_agreement_signing_link, and it's signed once both have");
      const col = side === "app" ? "app" : "counterparty";
      if (side === "app" ? a.app_signed_at : a.counterparty_signed_at) return fail("Your side has already signed it");
      const r = (
        await store.db.query(
          `UPDATE ${T}.app_agreements SET ${col}_signed_by = $2, ${col}_signed_at = now(), updated_at = now(),
             status = CASE WHEN ${col === "app" ? "counterparty" : "app"}_signed_at IS NOT NULL THEN 'signed' ELSE status END,
             signed_at = CASE WHEN ${col === "app" ? "counterparty" : "app"}_signed_at IS NOT NULL THEN now() ELSE signed_at END
           WHERE id = $1 AND status = 'accepted' AND ${col}_signed_at IS NULL RETURNING *`,
          [a.id, user.id],
        )
      ).rows[0];
      if (!r) return fail("That agreement changed meanwhile; read it again");
      const done = toAgreement(r);
      await store.audit(user.id, "sign_app_agreement", done.id, { app_id: done.app_id, workspace_id: done.workspace_id, counterparty_entity_id: done.counterparty_entity_id, side, signed: done.status === "signed" });
      if (done.status === "signed") await tell(done, "app_agreement.signed");
      return json(await view(done));
    },
  );

  server.registerTool(
    "terminate_app_agreement",
    {
      title: "End an app agreement",
      description:
        "Either side ends an agreement that's proposed (withdrawing it), accepted or signed, with the reason. Audited, and the other firm is told. A vendor's standard terms accepted with a subscription (vendor_subscription_id): ending the last such agreement ends the subscription too, refused while live products hand off through it.",
      inputSchema: { agreement_id: UUID, reason: z.string().trim().min(3).max(2000) },
    },
    async ({ agreement_id, reason }) => {
      const a = await getAgreement(store, agreement_id);
      const side = a ? await sideOf(a) : null;
      if (!a || !side) return fail(`No agreement '${agreement_id}' you can end`);
      // A vendor's standard terms accepted with a subscription: ending the last of its agreements ends the subscription,
      // so it's refused while live products hand off through it.
      let subscription: Subscription | undefined;
      if (a.vendor_subscription_id && OPEN.includes(a.status)) {
        const others = (await openSubscriptionAgreements(store.db, a.vendor_subscription_id)).filter((x) => x.id !== a.id);
        const s = others.length ? undefined : await getSubscription(store.db, a.vendor_subscription_id);
        if (s?.status === "active") {
          const inUse = await subscriptionInLiveUse(store, s);
          if (inUse) return fail(`Ending this agreement ends the subscription it came with. ${inUse}`);
          subscription = s;
        }
      }
      const r = (
        await store.db.query(
          `UPDATE ${T}.app_agreements SET status = 'terminated', terminated_by = $2, terminated_at = now(), termination_reason = $3, updated_at = now() WHERE id = $1 AND status = ANY($4) RETURNING *`,
          [a.id, user.id, reason, OPEN],
        )
      ).rows[0];
      if (!r) return fail(`That agreement is already ${a.status}`);
      const done = toAgreement(r);
      await store.audit(user.id, "terminate_app_agreement", done.id, { app_id: done.app_id, workspace_id: done.workspace_id, counterparty_entity_id: done.counterparty_entity_id, side, from_status: a.status, reason, ...(done.vendor_subscription_id ? { vendor_subscription_id: done.vendor_subscription_id } : {}) });
      await cancelSigning(store, esign(), done.id, user.id);
      if (side === "app") await tell(done, "app_agreement.terminated", { reason });
      const ended = subscription ? await endVendorSubscription(store, subscription, user.id, reason) : null;
      return json({ ...(await view(done)), ...(ended && !("error" in ended) ? { subscription_ended: ended.subscription_id } : {}) });
    },
  );

  // The workspaces a firm may propose to: those whose apps use products it sponsors (approved), and those it already
  // has an agreement with.
  const proposableWorkspaces = async (firm: string) => {
    const sponsored = (await store.db.query(`SELECT DISTINCT product_id FROM ${T}.sponsorships WHERE provider_entity_id = $1 AND status = 'approved'`, [firm])).rows.map((r) => r.product_id as string);
    const { rows } = await store.db.query(
      `SELECT DISTINCT w.id, w.name FROM ${T}.workspaces w
        WHERE EXISTS (SELECT 1 FROM ${T}.apps a WHERE a.workspace_id = w.id AND a.product_ids && $1::text[])
           OR EXISTS (SELECT 1 FROM ${T}.app_agreements g JOIN ${T}.apps x ON x.id = g.app_id WHERE x.workspace_id = w.id AND g.counterparty_entity_id = $2)
        ORDER BY w.name LIMIT 500`,
      [sponsored, firm],
    );
    const own = new Set(
      (await store.db.query(`SELECT DISTINCT m.workspace_id FROM ${T}.workspace_members m JOIN ${T}.users u ON u.id = m.user_id WHERE u.entity_id = $1`, [firm])).rows.map((r) => String(r.workspace_id)),
    );
    const out = [];
    for (const w of rows) {
      if (own.has(String(w.id))) continue;
      const apps = await workspaceApps(store, w.id as string);
      out.push({ workspace: { id: w.id as string, name: w.name as string }, apps: apps.map((x) => ({ id: x.id, name: x.name, product_ids: x.product_ids, sponsored_product_ids: x.product_ids.filter((p) => sponsored.includes(p)) })) });
    }
    return out;
  };
  // The firms a workspace may propose to: the sponsors of its apps' products.
  const proposableCounterparties = async (apps: App[]) => {
    const byFirm = new Map<string, { entity_id: string; name: string | null; product_ids: Set<string>; app_ids: Set<string> }>();
    for (const app of apps)
      for (const p of app.product_ids)
        for (const s of await sponsorsOf(store, p)) {
          const f = byFirm.get(s.entity_id) ?? { entity_id: s.entity_id, name: s.name, product_ids: new Set<string>(), app_ids: new Set<string>() };
          f.product_ids.add(p);
          f.app_ids.add(app.id);
          byFirm.set(s.entity_id, f);
        }
    return [...byFirm.values()].map((f) => ({ entity_id: f.entity_id, name: f.name, product_ids: [...f.product_ids].sort(), app_ids: [...f.app_ids] }));
  };

  server.registerTool(
    "list_app_agreements",
    {
      title: "App agreements",
      description:
        "With app_id (developer, any member of the app's workspace): the app's agreements with other firms, program_coverage (each product and the licence provider sponsoring it where the app serves, and whether a signed program agreement in force covers it: production needs every one; production_gate says what's missing, and flagged when the app is already in production without one), the products it uses (each with its stage, the licence providers sponsoring it and the states they sponsor it in: an app's licence coverage is its products'), the vendor services its workspace relies on (each with the version of the vendor's standard terms accepted for this app, or no_standard_terms when none were), and introductions the business-development agent has in progress for its members (null when that agent isn't running here). With workspace_id (developer, any member): every agreement of the workspace's apps (all kinds), can_manage, and proposable_counterparties (the sponsors of its apps' products). Without either (licence provider or vendor): the agreements made with your firm, both those apps' workspaces proposed and those your firm proposed, and proposable_workspaces (those whose apps use products your firm sponsors, or that already have an agreement with it). Each agreement says which side proposed it (proposed_by_side), the template it was made on, your_side and what you may do now (actions: accept, decline, sign, withdraw, end). status filters any list.",
      inputSchema: { app_id: UUID.optional(), workspace_id: UUID.optional(), status: z.enum(APP_AGREEMENT_STATUSES).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id, workspace_id, status }) => {
      if (app_id) {
        const app = sides.app ? await memberApp(store, user, app_id) : undefined;
        if (!app) return fail(`No app '${app_id}' of yours`);
        const { rows } = await store.db.query(`SELECT * FROM ${T}.app_agreements WHERE app_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC`, [app.id, status ?? null]);
        const stage = ((await store.db.query(`SELECT stage FROM ${T}.app_promotions WHERE app_id = $1`, [app.id])).rows[0]?.stage as string | undefined) ?? "idea";
        const coverage = await programAgreementCoverage(store.db, store, app);
        const missing = coverage.filter((c) => !c.covered);
        return json({
          app: { id: app.id, name: app.name, workspace_id: app.workspace_id, stage },
          can_manage: MANAGERS.includes((await appRole(store, user, app)) ?? ""),
          agreements: await Promise.all(rows.map((r) => view(toAgreement(r)))),
          // Production needs a signed program agreement in force for each of these (the program_agreements check).
          program_coverage: coverage,
          production_gate: {
            met: missing.length === 0,
            missing: missing.map(missingAgreementText),
            // In production already without one: the app keeps running, but its production checks fail until it's fixed.
            flagged: stage === "production" && missing.length > 0,
          },
          products: (await appProducts(store, app)).map(({ customer_segments: _s, ...p }) => p),
          vendor_contracts: await vendorContracts(store, app),
          introductions: await introductions(store, app),
        });
      }
      if (workspace_id) {
        const role = await roleIn(workspace_id);
        if (!role) return fail(`No workspace '${workspace_id}' of yours`);
        const apps = await workspaceApps(store, workspace_id);
        const { rows } = await store.db.query(
          `SELECT * FROM ${T}.app_agreements WHERE app_id = ANY($1::uuid[]) AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC`,
          [apps.map((x) => x.id), status ?? null],
        );
        const ws = (await store.db.query(`SELECT name FROM ${T}.workspaces WHERE id = $1`, [workspace_id])).rows[0];
        return json({
          workspace: { id: workspace_id, name: (ws?.name as string | undefined) ?? null },
          can_manage: MANAGERS.includes(role),
          agreements: await Promise.all(rows.map((r) => view(toAgreement(r)))),
          apps: apps.map((x) => ({ id: x.id, name: x.name, product_ids: x.product_ids })),
          proposable_counterparties: await proposableCounterparties(apps),
        });
      }
      const firm = await myFirm();
      if (!firm) return fail(sides.app ? "Name the app (app_id) or the workspace (workspace_id) whose agreements you want" : "You don't belong to a firm as a licence provider or vendor yet");
      const { rows } = await store.db.query(`SELECT * FROM ${T}.app_agreements WHERE counterparty_entity_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at DESC`, [firm, status ?? null]);
      return json({
        entity_id: firm,
        agreements: await Promise.all(rows.map((r) => view(toAgreement(r)))),
        proposable_workspaces: (await myFirm(true)) ? await proposableWorkspaces(firm) : [],
      });
    },
  );

  if (!sides.app) return;

  server.registerTool(
    "get_app_customers",
    {
      title: "An app's target customers",
      description:
        "Developer: the customer segments (personas) each of the app's products declares, which of them the app targets (set_app_target_segments), and how many customers it has where Mynt measures that: distinct customers with client sessions and with records in the customer vault, live and sandbox apart. A count Mynt can't measure yet (no client sessions in that environment) is null with the reason, never 0.",
      inputSchema: { app_id: UUID },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id }) => {
      const app = await memberApp(store, user, app_id);
      if (!app) return fail(`No app '${app_id}' of yours`);
      const chosen = (await store.db.query(`SELECT product_id, segment_id FROM ${T}.app_target_segments WHERE app_id = $1`, [app.id])).rows;
      const products = (await appProducts(store, app)).map((p) => ({
        id: p.id,
        name: p.name,
        segments: p.customer_segments.map((s) => ({ ...s, targeted: chosen.some((c) => c.product_id === p.id && c.segment_id === s.id) })),
      }));
      const counts = async (sandbox: boolean) => {
        const s = (await store.db.query(`SELECT count(*)::int AS sessions, count(DISTINCT customer_ref)::int AS customers FROM ${T}.client_sessions WHERE app_id = $1 AND sandbox = $2`, [app.id, sandbox])).rows[0];
        if (!s || !s.sessions) return { customers_with_sessions: null, customers_in_vault: null, reason: `No ${sandbox ? "sandbox" : "live"} client sessions yet, so Mynt hasn't measured customers here` };
        const v = (await store.db.query(`SELECT count(DISTINCT customer_ref)::int AS n FROM ${T}.customer_vault WHERE app_id = $1 AND sandbox = $2`, [app.id, sandbox])).rows[0];
        return { customers_with_sessions: s.customers as number, customers_in_vault: (v?.n as number) ?? 0, reason: null };
      };
      return json({ app: { id: app.id, name: app.name }, can_manage: MANAGERS.includes((await appRole(store, user, app)) ?? ""), products, customers: { live: await counts(false), sandbox: await counts(true) } });
    },
  );

  server.registerTool(
    "set_app_target_segments",
    {
      title: "Choose an app's target customers",
      description:
        "Developer (the app's workspace owners and admins): set which customer segments (personas) the app targets, each a segment its product declares (see get_app_customers). Replaces the app's whole choice; an empty list clears it. Audited.",
      inputSchema: { app_id: UUID, segments: z.array(z.object({ product_id: z.string().min(1).max(200), segment_id: z.string().min(1).max(200) }).strict()).max(100) },
    },
    async ({ app_id, segments }) => {
      const { app, error } = await managedApp(app_id);
      if (!app) return fail(error!);
      const products = await appProducts(store, app);
      const bad = segments.filter((s) => !products.find((p) => p.id === s.product_id)?.customer_segments.some((c) => c.id === s.segment_id));
      if (bad.length) return fail(`Not a segment of the app's products: ${bad.map((s) => `${s.product_id}/${s.segment_id}`).join(", ")}`);
      const unique = [...new Map(segments.map((s) => [`${s.product_id}/${s.segment_id}`, s])).values()];
      await inTransaction(store.db, async (tx) => {
        await tx.query(`DELETE FROM ${T}.app_target_segments WHERE app_id = $1`, [app.id]);
        for (const s of unique) await tx.query(`INSERT INTO ${T}.app_target_segments (app_id, product_id, segment_id, chosen_by) VALUES ($1, $2, $3, $4)`, [app.id, s.product_id, s.segment_id, user.id]);
      });
      await store.audit(user.id, "set_app_target_segments", app.id, { app_id: app.id, workspace_id: app.workspace_id, segments: unique });
      return json({ app_id: app.id, segments: unique });
    },
  );
}
