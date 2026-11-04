import { createHash } from "node:crypto";
import { DATA_DICTIONARY, isDataField, type CaptureMethod, type Sensitivity } from "./data-dictionary.js";
import type { Definition } from "./definition.js";

// The developer contract: what a developer may build against, derived from a product's v2 definition and
// frozen with each published version. It carries the public side only: offers per customer segment (their
// eligibility, terms, rates, fees and customer-facing limits), the actions an app may trigger with where
// each may run (client or server), the lifecycle events it can listen to, the consent purposes it must hold
// and the documents it must show. Algorithms, risk models, fraud and velocity controls, costs, revenue
// shares and the parties behind the product never appear in it.

type Node = Record<string, unknown> & { _id: string };
type Conn = { _id: string; type: string; from: { kind: string; id?: string }; to: { kind: string; id?: string }; attributes?: Record<string, unknown> };

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const TERM_FIELDS = ["_id", "label", "type", "unit", "currency", "default", "range", "allowed", "negotiable"];
const RATE_FIELDS = ["_id", "kind", "rate_type", "value", "index", "spread", "floor", "cap", "day_count", "compounding", "application", "tiers"];
const FEE_FIELDS = ["_id", "type", "method", "amount", "rate", "rate_base", "min", "max", "cap", "cap_period", "payer", "waivers"];
const LIMIT_FIELDS = ["_id", "constraint_type", "min", "max", "scope"];

export interface ContractAction {
  id: string;
  name: string;
  surface: "client" | "server" | "either";
  flow?: "hosted";
  host?: "provider";
  component?: string;
  consent_purpose?: string | null;
  inputs?: unknown;
  returns?: unknown;
  idempotent?: boolean;
  data: "public" | "personal";
  data_requirements?: { field: string; known: boolean; sensitivity?: Sensitivity; capture?: CaptureMethod[] }[];
  // Served by a vendor's standard service Mynt calls for the product: the device gets back only this outcome
  // (a status, a reference, the listed fields, and a redirect_url to the provider's page when `redirect`).
  served_by?: { kind: "vendor_service"; service_type: string | null; client_result: { statuses: string[]; fields: string[]; redirect: boolean } };
}

// Per handoff id, the vendor service that serves it (see vendorServedActions in vendors.ts).
export type ServedActions = Record<string, { service_type: string; client_result: { statuses: string[]; fields: string[]; redirect: boolean } }>;

export interface DeveloperContract {
  product_id: string;
  version: number;
  components: { key: string; country: string; primitive: string; action: string }[];
  offers: {
    segment_id: string;
    name: string;
    customer_kind?: unknown;
    eligibility: unknown;
    channels?: unknown;
    terms: Record<string, unknown>[];
    rates: Record<string, unknown>[];
    fees: Record<string, unknown>[];
    limits: Record<string, unknown>[];
  }[];
  actions: ContractAction[];
  events: { type: string; trigger: unknown; component?: string }[];
  consent_purposes: string[];
  documents: Record<string, string>;
  contract_hash: string;
}

export function deriveContract(def: Definition, version: number, served: ServedActions = {}): DeveloperContract {
  const conns = (def.connections ?? []) as Conn[];
  const nodes = (field: string) => ((def[field] as Node[] | undefined) ?? []).filter((n) => n && typeof n._id === "string");
  const applies = conns.filter((c) => c.type === "applies_to");
  // A node is public for a segment when it applies to the product, a component, or that segment;
  // segment overrides narrow it.
  const forSegment = (kind: string, field: string, fields: string[], segmentId: string, keep: (n: Node) => boolean = () => true) =>
    nodes(field)
      .filter(keep)
      .filter((n) => applies.some((a) => a.from.kind === kind && a.from.id === n._id && (a.to.kind !== "customer_segment" || a.to.id === segmentId)))
      .map((n) => {
        const override = applies.find((a) => a.from.kind === kind && a.from.id === n._id && a.to.kind === "customer_segment" && a.to.id === segmentId && a.attributes?.mode === "override");
        return pick({ ...n, ...((override?.attributes?.override as Record<string, unknown>) ?? {}) }, fields);
      });

  const offers = nodes("customer_segments").map((s) => ({
    segment_id: s._id,
    name: String(s.name ?? s._id),
    customer_kind: s.customer_kind,
    eligibility: s.qualification ?? {},
    channels: s.channels,
    terms: forSegment("term", "terms", TERM_FIELDS, s._id),
    rates: forSegment("rate", "rates", RATE_FIELDS, s._id),
    fees: forSegment("fee", "fees", FEE_FIELDS, s._id),
    // Customer-facing constraints only: fraud and velocity controls stay private.
    limits: forSegment("limit", "limits", LIMIT_FIELDS, s._id, (n) => n.kind === "constraint"),
  }));

  const actions: ContractAction[] = [{ id: "view_offers", name: "Show this product's offers", surface: "either", data: "public" }];
  for (const h of nodes("partner_handoffs")) {
    const party = conns.find((c) => c.type === "handoff_to_party" && c.from.id === h._id);
    const serves = conns.find((c) => c.type === "handoff_serves_component" && c.from.id === h._id)?.to.id;
    const purpose = (party?.attributes?.consent_purpose as string | null | undefined) ?? null;
    // Bound to a vendor subscription: Mynt calls the vendor; which one, and how, stays out of the contract.
    const vendor = party?.attributes?.vendor_subscription_id
      ? (served[h._id] ?? { service_type: (party.attributes.service_type as string | undefined) ?? null, client_result: { statuses: ["completed", "failed", "pending"], fields: [], redirect: false } })
      : null;
    actions.push({
      id: h._id,
      name: String(h.name ?? h._id),
      // Regulated steps run as the provider's hosted flow, started from the customer's device.
      surface: "client",
      flow: "hosted",
      host: "provider",
      component: serves,
      consent_purpose: purpose,
      inputs: h.sends,
      returns: h.returns,
      data: purpose ? "personal" : "public",
      // The customer data the handoff sends, as data dictionary fields (unknown names are flagged).
      data_requirements: ((h.sends as { required?: unknown } | undefined)?.required as string[] | undefined ?? [])
        .filter((f) => typeof f === "string")
        .map((f) => (isDataField(f) ? { field: f, known: true, sensitivity: DATA_DICTIONARY[f].sensitivity, capture: DATA_DICTIONARY[f].capture } : { field: f, known: false })),
      ...(vendor ? { served_by: { kind: "vendor_service" as const, ...vendor } } : {}),
    });
  }
  const occursOn = (id: string) => conns.find((c) => c.type === "occurs_on" && c.from.id === id)?.to.id;
  for (const e of nodes("lifecycle_events").filter((e) => e.trigger === "customer")) {
    // A customer-initiated event an app asks for on the customer's behalf: server side, idempotent.
    actions.push({ id: e._id, name: e._id.replace(/_/g, " "), surface: "server", component: occursOn(e._id), idempotent: true, data: "personal" });
  }

  const contract = {
    product_id: def._id,
    version,
    components: (def.components ?? []).map((c) => ({ key: c.key, country: c.country, primitive: c.primitive, action: c.action })),
    offers,
    actions,
    events: nodes("lifecycle_events").map((e) => ({ type: e._id, trigger: e.trigger, component: occursOn(e._id) })),
    consent_purposes: [...new Set(actions.map((a) => a.consent_purpose).filter((p): p is string => Boolean(p)))].sort(),
    documents: ((def.descriptions as { documents?: Record<string, string> }).documents ?? {}) as Record<string, string>,
  };
  return { ...contract, contract_hash: "sha256:" + createHash("sha256").update(JSON.stringify(contract)).digest("hex") };
}
