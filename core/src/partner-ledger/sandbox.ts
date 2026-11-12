import { createHash } from "node:crypto";
import type { PartnerLedger } from "./types.js";

// SANDBOX ONLY: made-up figures so licence providers can see the flow end to end before their own systems are
// connected. They're stable per product and period, reach no partner, and a snapshot read from here is marked
// `source: sandbox`, which can never count as live. No real ledger ships with Mynt yet.
export const sandboxPartnerLedger: PartnerLedger = {
  id: "sandbox",
  name: "Sandbox partner ledger (test figures, not real money)",
  kind: "sandbox",
  async read(ctx) {
    const seed = createHash("sha256").update(`${ctx.product_id}:${ctx.pool_id ?? ""}:${ctx.period_end}`).digest();
    const obligations = 1_000_000 + (seed.readUInt32LE(0) % 9_000_000);
    const reserves = obligations + (seed.readUInt32LE(4) % 1_000_000);
    return { reserves_held_cents: reserves, customer_obligations_cents: obligations, as_of: ctx.period_end };
  },
};
