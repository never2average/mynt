// A licence provider's own ledger: what it holds in reserve and what it owes customers on a product. The numbers
// come from the partner's systems and only from there, never from the developer's app, because they're what a
// licence provider and its liquidity providers judge the product by.
//
// A ledger only translates. It returns the partner's own figures, never decides what's healthy, and never logs or
// returns a credential. A figure it can't give is null; there's no such thing as a default of zero.

export type LedgerError = { error: { code: string; message: string } }; // code: [a-z0-9_]; message: no partner text, no secrets
export const ledgerError = (code: string, message: string): LedgerError => ({ error: { code, message } });
export const isLedgerError = (x: unknown): x is LedgerError => !!x && typeof x === "object" && "error" in (x as object);

export interface PartnerLedgerReading {
  reserves_held_cents: number | null; // integer cents held in reserve for this product
  customer_obligations_cents: number | null; // integer cents owed to this product's customers
  as_of: string; // ISO date-time: when the partner's own books said this
  reason?: string | null; // why a figure is null, when one is
}

export interface PartnerLedgerContext {
  product_id: string;
  pool_id: string | null;
  provider_entity_id: string; // the licence provider whose books are read
  period_end: string; // the snapshot's period end, ISO
  now: () => Date;
}

export interface PartnerLedger {
  id: string; // stored with each snapshot
  name: string;
  // sandbox: test figures, which can never count as a live product's health. live: the partner's real books.
  kind: "sandbox" | "live";
  read(ctx: PartnerLedgerContext): Promise<PartnerLedgerReading | LedgerError>;
}
