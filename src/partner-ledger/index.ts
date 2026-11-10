import { sandboxPartnerLedger } from "./sandbox.js";
import type { PartnerLedger } from "./types.js";

export * from "./types.js";

// The ledgers Mynt can read. Only the sandbox ships; a licence provider's real ledger is added here and chosen per firm.
export const PARTNER_LEDGERS: Record<string, PartnerLedger> = { [sandboxPartnerLedger.id]: sandboxPartnerLedger };
export const defaultLedgerFor = (_entityId: string): PartnerLedger => sandboxPartnerLedger;
