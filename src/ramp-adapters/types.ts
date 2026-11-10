// The ramp adapter interface. The Mynt Ramp's licensed partner plugs in one of two ways:
//
// 1. It implements Mynt's vendor wire contract itself (docs/reference.md): its offerings' base URLs are its own
//    endpoints, and nothing here is used.
// 2. Mynt runs an adapter in front of the partner's own API. The offering names the adapter (set_ramp_adapter),
//    its base URLs are the partner's API, and the partner's credential sits sealed in the ramp firm's key vault.
//    Mynt then answers its own signed wire-contract requests in-process: the adapter translates each to the
//    partner's API and the partner's answers and webhooks back to Mynt's statuses. Conformance, quotes, the
//    single accept, callbacks and the dollars-only rule work exactly as for a partner that speaks the contract.
//
// An adapter only translates. It never sees a signing secret, never logs or returns a credential (Mynt hands it
// a bound `http` that adds the credential itself), and never decides what a device is told: Mynt does.

export type RampDirection = "in" | "out"; // in: dollars from the customer's bank; out: dollars to it
export type RampTransferStatus = "submitted" | "settled" | "failed" | "returned"; // Mynt's wire statuses

// code: [a-z0-9_]; message: no partner text, no secrets. partner_status: the partner's HTTP status, when it answered.
// partner_transfer_id: the partner's id for a transfer it accepted in an answer Mynt couldn't otherwise read.
export type RampError = { error: { code: string; message: string }; partner_status?: number | null; partner_transfer_id?: string };
export const rampError = (code: string, message: string): RampError => ({ error: { code, message } });
export const isRampError = (x: unknown): x is RampError => !!x && typeof x === "object" && "error" in (x as object);

// One call to the partner's API, under Mynt's outbound rules (HTTPS, no private addresses, no redirects, time and
// size limits), already bound to the offering's base URL for the environment and carrying the credential.
export type PartnerHttp = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<{ status: number | null; body: unknown; error: string | null }>;

export interface RampAdapterContext {
  environment: "test" | "live";
  config: Record<string, string>; // the offering's non-secret settings, already validated by the adapter
  http: PartnerHttp;
  now: () => Date;
}

// Mynt's own price for a quote. When the partner has no expiring quotes (Bridge), the adapter prices from its
// config and Mynt sets the validity; a partner with firm quotes would return its own here.
export interface RampPrice {
  amount_usd: string; // what the customer asked to move
  fee_usd: string;
  total_usd: string; // in: added to their dollar balance (amount less fee); out: taken from it (amount plus fee)
  estimated_arrival: string | null; // ISO date-time, when known
  settlement_asset: "USDC"; // partner-side only
  settlement_network: "solana"; // partner-side only
  settlement_amount: string; // partner-side only
}

export interface RampCustomer {
  key: string; // Mynt's pseudonymous key for (app, customer): never the customer's reference itself
  partner_customer_id: string | null; // the partner's id for this customer, once linked (link_ramp_partner_customer)
  partner_payout_account_id: string | null; // the partner's id for the customer's payout bank account, once linked
}

export interface RampTransferRequest {
  direction: RampDirection;
  price: RampPrice; // the accepted quote, as Mynt issued it
  idempotency_key: string; // the same for every attempt to accept one quote
  customer: RampCustomer;
  input: { full_name?: string; bank_account_number?: string; routing_number?: string }; // from the customer's vault
}

// What the partner said, in Mynt's terms. Only the customer-facing part reaches a device, and only through the
// service type's client_result; everything else is partner-side (sealed to the innovator or kept by the adapter).
export interface RampTransferUpdate {
  partner_transfer_id: string;
  status: RampTransferStatus;
  estimated_arrival: string | null;
  // In US dollars, for a customer who pushes the payment from their bank (on-ramp without a pull).
  pay_to?: { bank_name: string | null; account_number: string | null; routing_number: string | null; reference: string | null } | null;
  settlement_ref: string | null; // partner-side
  settlement_tx: string | null; // partner-side: an on-chain transaction, never shown to a device
  // What the partner reports it actually moved, when it does (its own fees included): total_usd in dollars for the
  // customer (in: added to the balance; out: paid to the bank), settlement_amount partner-side. Never assumed 1:1.
  total_usd?: string | null;
  settlement_amount?: string | null;
  paid_out_usd?: string | null; // out: what reached the customer's bank, as the partner reports it
  partner_side?: Record<string, unknown>; // e.g. where the USDC leg is to be sent; kept by the adapter only
}

// Who the partner verified the customer to be, to match against what the customer gave Mynt before a link counts.
export interface RampPartnerIdentity {
  full_name: string | null;
  date_of_birth: string | null; // YYYY-MM-DD
  // The US state of the residential address the partner verified (ISO 3166-2, e.g. us-ny), and when, if it says.
  // null: this partner doesn't tell Mynt. Never assumed, and never taken from anything but the partner's own record.
  residential_state: string | null;
  verified_at?: string | null;
}

export interface RampWebhookEvent {
  event_id: string;
  update: RampTransferUpdate;
}

export interface RampAdapter {
  id: string; // stored on the offering
  name: string;
  docs: string; // the partner's public API docs
  // The non-secret settings this adapter needs, with what each is for.
  config_fields: Record<string, { required: boolean; description: string }>;
  configProblems(config: Record<string, string>): string[];
  // How the partner wants its credential sent (the bound http adds these).
  authHeaders(credential: string): Record<string, string>;
  // A read-only check, with the credential, that the partner answers: used by Mynt's conformance run.
  probe(ctx: RampAdapterContext): Promise<RampError | null>;
  price(ctx: RampAdapterContext, direction: RampDirection, amount_usd: string): RampPrice | RampError;
  transfer(ctx: RampAdapterContext, req: RampTransferRequest): Promise<RampTransferUpdate | RampError>;
  status(ctx: RampAdapterContext, partner_transfer_id: string, direction: RampDirection): Promise<RampTransferUpdate | RampError>;
  // Voids a transfer that never got its money (when its window passes), if the partner can. null: voided.
  cancel?(ctx: RampAdapterContext, partner_transfer_id: string): Promise<RampError | null>;
  // The identity the partner holds for one of its customers.
  customerIdentity(ctx: RampAdapterContext, partner_customer_id: string): Promise<RampPartnerIdentity | RampError>;
  // Whether a payout bank account at the partner belongs to that partner customer (and is usable).
  payoutAccountOf(ctx: RampAdapterContext, partner_customer_id: string, partner_payout_account_id: string): Promise<boolean | RampError>;
  // Whether each environment points at the partner's matching environment (sandbox URL and key for test, and the
  // other way round), as far as the partner documents it.
  environmentProblems(e: { test_base_url: string; live_base_url: string | null; test_credential?: string; live_credential?: string }): string[];
  // Whether this adapter can cash out yet (the stablecoin leg into the partner exists). Refused otherwise.
  offrampReady(ctx: RampAdapterContext): boolean;
  // A partner webhook: verified with the partner's own scheme, then normalised. null: not an event Mynt needs.
  webhook(ctx: Omit<RampAdapterContext, "http">, raw: string, headers: Record<string, string | undefined>): RampWebhookEvent | null | RampError;
}
