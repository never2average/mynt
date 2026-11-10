import { sandboxPartnerLedger } from "./sandbox.js";
import type { PartnerLedger } from "./types.js";

export * from "./types.js";
export { sandboxPartnerLedger };

// The ledger used when nothing else is chosen. A licence provider's real ledger, its HTTPS feed or its signed daily
// file, is chosen per firm by the partner kit (partner-kit.ts) once the firm passes conformance and switches to it.
export const PARTNER_LEDGERS: Record<string, PartnerLedger> = { [sandboxPartnerLedger.id]: sandboxPartnerLedger };
export const defaultLedgerFor = (_entityId: string): PartnerLedger => sandboxPartnerLedger;
