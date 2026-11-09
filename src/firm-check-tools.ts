import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { firmLegitimacy, runFirmChecks } from "./firm-checks.js";
import { driftSweep } from "./pins.js";
import { effectiveRoles, type Store, type User } from "./store.js";
import { serialLoop } from "./worker.js";

// The admin's on-demand run of a firm's public checks (see firm-checks.ts), and the monthly re-run for every
// licence provider's firm.

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// Runs a firm's checks, then re-checks the products resting on it (a mismatch or lapse drifts those it sponsors).
export async function runAndSweep(store: Store, entityId: string, runBy: string | null) {
  const results = await runFirmChecks(store, entityId, runBy);
  const drifted = await driftSweep(store, entityId);
  return { results, legitimacy: await firmLegitimacy(store, entityId), drifted_products: drifted };
}

export function registerFirmCheckAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "run_firm_checks",
    {
      title: "Check a firm is a real company",
      description:
        "Admin: run Mynt's public checks that a firm is a real, legitimate company, now: GLEIF's record of its LEI (identifier 'lei': legal name, jurisdiction, entity and LEI status) and FinCEN's MSB registrant list (legal name and state). Each answer is stored with its source, URL, time, matched fields and a hash. A licence provider sponsors only once they pass (SPONSOR_LEGITIMACY_RULE; default: a matching LEI or MSB registration, and no mismatch or lapse); a mismatch or lapse drifts the products it sponsors. The NMLS ID and FinCEN registration number are listed to check by hand. Licence providers' firms are re-checked monthly on their own.",
      inputSchema: { entity_id: z.string().uuid() },
    },
    async ({ entity_id }) => {
      if (!(await store.getEntity(entity_id))) return fail(`No firm '${entity_id}'`);
      const out = await runAndSweep(store, entity_id, user.id);
      await store.audit(user.id, "run_firm_checks", entity_id, {
        results: out.results.map((r) => ({ source: r.source, status: r.status, response_hash: r.response_hash })),
        passes: out.legitimacy?.passes ?? false,
        drifted_products: out.drifted_products,
      });
      return json(out);
    },
  );
}

// Licence providers' firms whose checks are due: none answered within FIRM_CHECKS_EVERY_DAYS (default 30), and
// no attempt in the last day (so a source that's down is retried daily, not every hour).
export async function dueFirmChecks(store: Store, now = Date.now()) {
  const everyMs = Number(process.env.FIRM_CHECKS_EVERY_DAYS ?? 30) * 24 * 60 * 60 * 1000;
  const due: string[] = [];
  for (const e of await store.listEntities()) {
    if (!(await store.entityMembers(e.id)).some((m) => effectiveRoles(m.roles).includes("license_provider"))) continue;
    const history = await store.firmChecks(e.id, 20);
    const answered = history.find((c) => c.status !== "unavailable");
    if (answered && now - Date.parse(answered.retrieved_at) < everyMs) continue;
    if (history[0] && now - Date.parse(history[0].retrieved_at) < 24 * 60 * 60 * 1000) continue;
    due.push(e.id);
  }
  return due;
}

export async function firmChecksTick(store: Store) {
  const ran: string[] = [];
  for (const id of await dueFirmChecks(store)) {
    const out = await runAndSweep(store, id, null);
    await store.audit(null, "run_firm_checks", id, { scheduled: true, results: out.results.map((r) => ({ source: r.source, status: r.status })), drifted_products: out.drifted_products });
    ran.push(id);
  }
  return ran;
}

export function startFirmChecksWorker(store: Store, intervalMs = Number(process.env.FIRM_CHECKS_POLL_MS ?? 60 * 60 * 1000)) {
  return serialLoop(() => firmChecksTick(store), intervalMs, "firm checks");
}
