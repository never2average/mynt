import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction, type Db } from "./db.js";
import type { SolanaService } from "./solana/service.js";
import type { Store, User } from "./store.js";

// Admins remove an app that never went live (a test, a demo) with everything that hangs off it: its keys and
// sessions, its sandbox data, its builds and what Mynt built from them, its Solana programs (deployed devnet ones
// are closed on chain first) and its webhooks. Anything live, published, hosted or on mainnet is refused, and the
// audit log is never touched: the removal itself is written to it, with the full list of what went.

const T = "financial_products";
type Q = Pick<Db, "query">;

// Sets the steps below refer to; $1 is always the app's id.
const BUILDS = `(SELECT id FROM ${T}.build_runs WHERE app_id = $1)`;
const PROGRAMS = `(SELECT id FROM ${T}.solana_programs WHERE app_id = $1)`;
const WEBHOOKS = `(SELECT id FROM ${T}.webhooks WHERE app_id = $1)`;
const ARTIFACTS = `${T}.solana_program_artifacts`;
// A captured source, dependency list or dep-info (shared by hash) goes only when no other build's artifact keeps it.
const capturedBy = (column: string) =>
  `t.sha256 IN (SELECT a.${column} FROM ${ARTIFACTS} a WHERE a.build_id IN ${BUILDS}) AND NOT EXISTS (SELECT 1 FROM ${ARTIFACTS} o WHERE o.${column} = t.sha256 AND o.build_id NOT IN ${BUILDS})`;

// What remove_app deletes, in the order it deletes it: whatever references a row goes before that row. `list` is a
// column whose values the audit entry records one by one (the rest are counted).
export const APP_REMOVAL_STEPS: { table: string; where: string; list?: string }[] = [
  { table: "webhook_deliveries", where: `t.webhook_id IN ${WEBHOOKS}` },
  { table: "webhooks", where: "t.app_id = $1", list: "id" },
  { table: "vendor_action_runs", where: "t.app_id = $1" },
  { table: "ramp_link_requests", where: "t.app_id = $1" },
  { table: "money_movements", where: "t.app_id = $1" },
  { table: "client_evidence", where: "t.app_id = $1" },
  { table: "handoffs", where: "t.app_id = $1" },
  { table: "client_sessions", where: "t.app_id = $1" },
  { table: "api_keys", where: "t.app_id = $1", list: "id" },
  { table: "app_events", where: "t.app_id = $1" },
  { table: "customer_vault", where: "t.app_id = $1" },
  { table: "test_consumers", where: "t.app_id = $1" },
  { table: "app_journeys", where: "t.app_id = $1" },
  { table: "app_releases", where: "t.app_id = $1", list: "version" },
  { table: "requests", where: "t.app_id = $1" },
  { table: "hosting_commands", where: "t.app_id = $1" },
  { table: "solana_program_events", where: `t.program IN ${PROGRAMS}` },
  { table: "solana_program_versions", where: `t.program IN ${PROGRAMS}` },
  { table: "solana_program_flags", where: `t.program IN ${PROGRAMS}` },
  // Each program's own keys in Mynt's vault (its reserved keypair, a leftover deploy buffer's key): scoped by its id.
  { table: "solana_keys", where: `t.scope IN (SELECT id::text FROM ${T}.solana_programs WHERE app_id = $1)`, list: "public_key" },
  { table: "solana_programs", where: "t.app_id = $1", list: "program_id" },
  { table: "solana_program_sources", where: capturedBy("sources_sha256") },
  { table: "solana_program_deps", where: capturedBy("deps_sha256") },
  { table: "solana_program_depinfo", where: capturedBy("depinfo_sha256") },
  { table: "solana_program_artifacts", where: `t.build_id IN ${BUILDS}` },
  { table: "build_activity", where: `t.build_id IN ${BUILDS}` },
  { table: "build_events", where: `t.build_id IN ${BUILDS}` },
  // What each build's agents spent on models (the meter's run key).
  { table: "agent_spend", where: `t.run_key IN (SELECT 'build:' || id::text FROM ${T}.build_runs WHERE app_id = $1)` },
  { table: "build_runs", where: "t.app_id = $1", list: "id" },
  { table: "apps", where: "t.id = $1", list: "id" },
];

// Tables with an app_id that remove_app never deletes from: their rows make it refuse (see the checks below).
const REFUSING_TABLES = ["hosted_apps", "customer_state_history", "customer_verified_states", "customer_state_erasures"];

// Rows that are a live customer's: any of them and the app is refused.
const LIVE: { table: string; where: string }[] = [
  ...["client_sessions", "client_evidence", "customer_vault", "handoffs", "app_events", "ramp_link_requests", "vendor_action_runs", "money_movements"].map((table) => ({
    table,
    where: "t.app_id = $1 AND NOT t.sandbox",
  })),
  { table: "webhook_deliveries", where: `t.webhook_id IN ${WEBHOOKS} AND NOT t.sandbox` },
  // Identity providers' results and erasure records exist only for live customers.
  { table: "customer_verified_states", where: "t.app_id = $1" },
  { table: "customer_state_erasures", where: "t.app_id = $1" },
];

// Rows outside the app that point into what would be removed: removing it would leave them dangling or take
// someone else's records with it, so the app is refused and the table named.
const ENTANGLED: { table: string; where: string; why: string }[] = [
  { table: "customer_state_history", where: "t.app_id = $1", why: "it is append-only (customers' state changes are never deleted)" },
  { table: "pool_movements", where: `t.movement_id IN (SELECT id FROM ${T}.money_movements WHERE app_id = $1)`, why: "liquidity pools' books name the app's money movements" },
  { table: "pool_flags", where: `t.movement_id IN (SELECT id FROM ${T}.money_movements WHERE app_id = $1)`, why: "liquidity providers' flags name the app's money movements" },
  { table: "pool_movement_states", where: `t.movement_id IN (SELECT id FROM ${T}.money_movements WHERE app_id = $1)`, why: "liquidity pools' records name the app's money movements" },
  { table: "ramp_partner_links", where: `t.link_request_id IN (SELECT id FROM ${T}.ramp_link_requests WHERE app_id = $1)`, why: "ramp partners' links name the app's link requests" },
  { table: "solana_mainnet_reviews", where: `t.program IN ${PROGRAMS} OR t.build_id IN ${BUILDS}`, why: "mainnet program reviews name the app's programs or builds" },
  {
    table: "solana_programs",
    where: `(t.app_id IS DISTINCT FROM $1) AND (t.build_id IN ${BUILDS} OR t.pending_build_id IN ${BUILDS})`,
    why: "another app's or product's program was deployed from one of this app's builds",
  },
  {
    table: "solana_program_versions",
    where: `t.build_id IN ${BUILDS} AND t.program NOT IN ${PROGRAMS}`,
    why: "another program's versions were deployed from one of this app's builds",
  },
  { table: "hosted_apps", where: `t.build_id IN ${BUILDS} AND t.app_id <> $1`, why: "another hosted app runs one of this app's builds" },
];

// Single-column foreign keys into the tables remove_app deletes from, and which of their rows go.
const REMOVED_KEYS: Record<string, string> = {
  apps: "(SELECT $1::uuid)",
  build_runs: BUILDS,
  solana_programs: PROGRAMS,
  webhooks: WEBHOOKS,
  api_keys: `(SELECT id FROM ${T}.api_keys WHERE app_id = $1)`,
  client_sessions: `(SELECT id FROM ${T}.client_sessions WHERE app_id = $1)`,
  money_movements: `(SELECT id FROM ${T}.money_movements WHERE app_id = $1)`,
};

const TERMINAL_BUILDS = ["succeeded", "blocked", "failed", "stopped", "over_budget"];

// The tables this Mynt has (a server that never started a service has none of its tables), and whether a step's
// table and every table its condition reads exist: a missing one holds no rows to remove or to refuse over.
const presentTables = async (q: Q) =>
  new Set(((await q.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1`, [T])).rows as { table_name: string }[]).map((r) => r.table_name));
const usable = (present: Set<string>, table: string, where: string) =>
  present.has(table) && [...where.matchAll(new RegExp(`${T}\\.(\\w+)`, "g"))].every((m) => present.has(m[1]));

const count = async (q: Q, present: Set<string>, table: string, where: string, appId: string) =>
  usable(present, table, where) ? Number(((await q.query(`SELECT count(*)::int AS n FROM ${T}.${table} t WHERE ${where}`, [appId])).rows[0] as { n: number }).n) : 0;

export interface RemovalPlan {
  app: { id: string; name: string; status: string; owner_id: string } | null;
  refusals: string[];
  rows: Record<string, number>;
  programs: { id: string; program_id: string; name: string; cluster: string; status: string; operation: string | null; on_chain: "close" | "nothing to close" | "already closed" }[];
  builds: { id: string; status: string }[];
}

// What removing the app would delete, and every reason it can't be (empty when it can). Read-only.
export async function planAppRemoval(q: Q, appId: string): Promise<RemovalPlan> {
  const app = (await q.query(`SELECT id, name, status, owner_id FROM ${T}.apps WHERE id::text = $1`, [appId])).rows[0] as RemovalPlan["app"] | undefined;
  if (!app) return { app: null, refusals: [`No app with id '${appId}'`], rows: {}, programs: [], builds: [] };
  const present = await presentTables(q);
  const refusals: string[] = [];
  if (app.status === "published") refusals.push("The app is published (anyone can find it with list_apps); only an app that was never published is removed");
  const hosted = !present.has("hosted_apps") ? undefined : (await q.query(`SELECT status FROM ${T}.hosted_apps WHERE app_id = $1`, [app.id])).rows[0] as { status: string } | undefined;
  if (hosted) refusals.push(`The app is hosted on Mynt (${hosted.status}): undeploy it first (undeploy_app)`);

  const programs = (
    (!present.has("solana_programs") ? { rows: [] } : await q.query(`SELECT id, program_id, name, cluster, status, operation FROM ${T}.solana_programs WHERE app_id = $1 ORDER BY created_at`, [app.id])).rows as Omit<
      RemovalPlan["programs"][number],
      "on_chain"
    >[]
  ).map((p) => ({ ...p, on_chain: (p.status === "deployed" ? "close" : p.status === "closed" ? "already closed" : "nothing to close") as RemovalPlan["programs"][number]["on_chain"] }));
  const mainnet = programs.filter((p) => p.cluster !== "devnet");
  if (mainnet.length) refusals.push(`The app has mainnet programs (${mainnet.map((p) => p.program_id).join(", ")}); Mynt never removes or closes a mainnet program`);
  for (const p of programs.filter((p) => p.operation)) refusals.push(`A ${p.operation} of program ${p.program_id} is running; wait for it to finish`);
  for (const p of programs.filter((p) => p.status === "deploying")) if (!p.operation) refusals.push(`Program ${p.program_id} is still deploying`);

  const builds = (!present.has("build_runs") ? { rows: [] } : await q.query(`SELECT id, status, box_sandbox_id, box_until FROM ${T}.build_runs WHERE app_id = $1 ORDER BY created_at`, [app.id])).rows as {
    id: string;
    status: string;
    box_sandbox_id: string | null;
    box_until: string | null;
  }[];
  for (const b of builds) {
    if (!TERMINAL_BUILDS.includes(b.status)) refusals.push(`Build ${b.id} is still ${b.status}: stop it first (stop_build)`);
    else if (b.box_sandbox_id && b.box_until && new Date(b.box_until).getTime() > Date.now())
      refusals.push(`Build ${b.id} has a reopened sandbox open until ${new Date(b.box_until).toISOString()}: close it first (close_sandbox)`);
  }

  for (const l of LIVE) {
    const n = await count(q, present, l.table, l.where, app.id);
    if (n) refusals.push(`The app has live customer data: ${n} live row${n === 1 ? "" : "s"} in ${l.table}${l.table === "money_movements" ? " (live money movements)" : ""}`);
  }
  for (const e of ENTANGLED) {
    const n = await count(q, present, e.table, e.where, app.id);
    if (n) refusals.push(`${e.table} can't be cleaned safely: ${n} row${n === 1 ? "" : "s"} (${e.why})`);
  }

  // Anything this code doesn't know about yet (a table added later) that names the app or points into what would
  // go: refused, by name, rather than left dangling.
  const handled = new Set([...APP_REMOVAL_STEPS.map((s) => s.table), ...REFUSING_TABLES]);
  const withAppId = (
    (await q.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = $1 AND column_name = 'app_id' AND table_name <> ALL($2)`, [T, [...handled]])).rows as {
      table_name: string;
    }[]
  ).map((r) => r.table_name);
  for (const table of withAppId) {
    const n = await count(q, present, table, "t.app_id = $1", app.id);
    if (n) refusals.push(`${table} can't be cleaned safely: ${n} row${n === 1 ? "" : "s"} name the app, and remove_app doesn't know that table`);
  }
  const fks = (
    await q.query(
      `SELECT c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref, a.attname AS col
         FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.connamespace = $1::regnamespace AND array_length(c.conkey, 1) = 1`,
      [T],
    )
  ).rows as { tbl: string; ref: string; col: string }[];
  for (const fk of fks) {
    const table = fk.tbl.replace(`${T}.`, "");
    const ref = fk.ref.replace(`${T}.`, "");
    if (handled.has(table) || ENTANGLED.some((e) => e.table === table) || !REMOVED_KEYS[ref]) continue;
    const n = await count(q, present, table, `t.${fk.col} IN ${REMOVED_KEYS[ref]}`, app.id);
    if (n) refusals.push(`${table} can't be cleaned safely: ${n} row${n === 1 ? "" : "s"} reference ${ref} rows that would be removed`);
  }

  const rows: Record<string, number> = {};
  for (const s of APP_REMOVAL_STEPS) rows[s.table] = await count(q, present, s.table, s.where, app.id);
  return { app, refusals, rows, programs, builds: builds.map((b) => ({ id: b.id, status: b.status })) };
}

export class RemovalRefused extends Error {
  constructor(readonly refusals: string[]) {
    super(refusals.join("; "));
  }
}

export interface RemoveAppOptions {
  confirm?: boolean;
  proceed_without_closing?: boolean;
  reason?: string;
}

// Removes the app (confirm: true) or says what that would remove (the default). Deployed devnet programs are closed
// on chain first; if one can't be, nothing is deleted unless proceed_without_closing says to go on without it.
export async function removeApp(db: Db, solana: SolanaService | null, actor: User, appId: string, o: RemoveAppOptions = {}) {
  const plan = await planAppRemoval(db, appId);
  if (!plan.app) throw new Error(plan.refusals[0]);
  const summary = {
    app: plan.app,
    rows: Object.fromEntries(Object.entries(plan.rows).filter(([, n]) => n > 0)),
    programs: plan.programs.map((p) => ({ program_id: p.program_id, name: p.name, cluster: p.cluster, status: p.status, on_chain: p.on_chain })),
    builds: plan.builds,
    kept: "audit_log: never deleted; this removal is added to it",
  };
  if (plan.refusals.length) return { removed: false, refused: plan.refusals, would_remove: summary };
  if (!o.confirm) return { removed: false, dry_run: true, would_remove: summary, next: "Call remove_app again with confirm: true to remove all of this" };

  // On chain first: a program closed there can't be un-closed, so this happens before anything is deleted.
  const closed: unknown[] = [];
  const notClosed: { program_id: string; error: string }[] = [];
  for (const p of plan.programs.filter((x) => x.on_chain === "close")) {
    try {
      if (!solana) throw new Error("Mynt's Solana service isn't running on this server");
      const record = await solana.get(p.program_id);
      if (!record) throw new Error("the program's record is gone");
      closed.push(await solana.closeProgram(record));
    } catch (e) {
      notClosed.push({ program_id: p.program_id, error: (e as Error).message });
      if (!o.proceed_without_closing) break;
    }
  }
  if (notClosed.length && !o.proceed_without_closing) {
    await db.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, 'remove_app', $3, $4)`, [
      randomUUID(),
      actor.id,
      plan.app.id,
      JSON.stringify({ outcome: "stopped", app: plan.app, closed, not_closed: notClosed, reason: o.reason ?? null }),
    ]);
    return {
      removed: false,
      stopped: `Closing ${notClosed[0].program_id} on devnet failed, so nothing was deleted: ${notClosed[0].error}`,
      closed,
      not_closed: notClosed,
      next: "Fix the cause and call remove_app again, or pass proceed_without_closing: true to remove the app and leave that program on devnet (recorded in the audit log)",
    };
  }

  const removed = await inTransaction(db, async (tx) => {
    // Locked first: nothing can attach itself to the app (a key, a session, a hosted copy) while it goes.
    await tx.query(`SELECT id FROM ${T}.apps WHERE id = $1 FOR UPDATE`, [plan.app!.id]);
    const again = await planAppRemoval(tx, plan.app!.id);
    if (again.refusals.length) throw new RemovalRefused(again.refusals);
    const present = await presentTables(tx);
    const out: Record<string, { count: number; ids?: string[] }> = {};
    for (const s of APP_REMOVAL_STEPS) {
      if (!usable(present, s.table, s.where)) continue;
      const r = (await tx.query(`DELETE FROM ${T}.${s.table} t WHERE ${s.where} RETURNING ${s.list ? `t.${s.list}::text AS k` : "1 AS k"}`, [plan.app!.id])).rows as { k: string }[];
      if (r.length) out[s.table] = { count: r.length, ...(s.list ? { ids: r.map((x) => x.k) } : {}) };
    }
    await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, 'remove_app', $3, $4)`, [
      randomUUID(),
      actor.id,
      plan.app!.id,
      JSON.stringify({
        outcome: "removed",
        app: plan.app,
        removed: out,
        programs: summary.programs,
        closed,
        ...(notClosed.length ? { not_closed: notClosed, proceeded_without_closing: true } : {}),
        reason: o.reason ?? null,
      }),
    ]);
    return out;
  }).catch((e) => {
    if (e instanceof RemovalRefused) return e;
    throw e;
  });
  if (removed instanceof RemovalRefused) return { removed: false, refused: removed.refusals, closed, note: closed.length ? "The programs listed under closed were closed on devnet before this refusal" : undefined };
  return { removed: true, app: plan.app, deleted: removed, closed, ...(notClosed.length ? { not_closed: notClosed, proceeded_without_closing: true } : {}) };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export function registerAppRemovalTools(server: McpServer, store: Store, user: User, solana: SolanaService | null) {
  server.registerTool(
    "remove_app",
    {
      title: "Remove an app",
      description:
        "Admin: remove an app that never went live (a test or demo) with everything that references it: its API keys and client sessions, its sandbox data, its builds and what Mynt built and recorded from them, its Solana programs (each deployed devnet program is closed on chain first, its lamports back to Mynt's devnet deploy authority) and its webhooks, in one transaction. Refused when the app is published or hosted, has live customer data or money movements, or has any mainnet program. A dry run by default: it lists exactly what would go; confirm: true removes it. The audit log is never deleted from; the removal is recorded there with the full list.",
      inputSchema: {
        app_id: z.string(),
        confirm: z.boolean().default(false).describe("false (default): only list what would be removed. true: remove it"),
        proceed_without_closing: z
          .boolean()
          .default(false)
          .describe("If closing a deployed devnet program fails, remove the app anyway and leave the program on devnet (recorded in the audit log). Default: stop and delete nothing"),
        reason: z.string().max(500).optional().describe("Why it is being removed, for the audit log"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ app_id, confirm, proceed_without_closing, reason }) => {
      try {
        const r = await removeApp(store.db, solana, user, app_id, { confirm, proceed_without_closing, reason });
        return "refused" in r || "stopped" in r ? { ...json(r), isError: true } : json(r);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
}
