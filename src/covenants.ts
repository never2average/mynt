import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { checkDrift, driftDependents } from "./pins.js";
import type { Figure, Figures, ProductHealthService, SnapshotRow } from "./product-health.js";
import { emitFirmEvent } from "./runtime.js";
import type { DriftChange, ProductRecord, Sponsorship, Store, User } from "./store.js";
import { open as openSealed, seal, vaultAvailable } from "./vault.js";
import { serialLoop } from "./worker.js";

// Covenants: the rules a licence provider sets on each product it sponsors, checked against the product's health record
// (product-health.ts). A rule either alerts the sponsor or pauses the product, as the sponsor chose per rule.
//
//   - a null figure is `unknown`, with its reason: never a pass, never a breach; unknown too long is itself an alert;
//   - a figure from sandbox books never pauses anything: on a published product it's unknown, otherwise labelled sandbox;
//   - each new snapshot is evaluated, and a timer evaluates too, so a rule about missing snapshots fires with no snapshot;
//   - the breach record is append-only; the sealed figures in it are opened for the sponsor's own people only;
//   - a pause holds the product through the drift mechanism (kind `covenant`) until the sponsor releases it; it stops new
//     sales only, and never touches money already in flight, which it reports.

const T = "financial_products";

export const RULE_TYPES = ["coverage_below", "reversal_rate_above", "failure_rate_above", "unresolved_above", "complaints_above", "snapshot_missed_for", "consecutive_gaps", "unverified_for"] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export const COVENANT_ACTIONS = ["alert", "pause"] as const;
export type CovenantAction = (typeof COVENANT_ACTIONS)[number];
export const COVENANT_SEVERITIES = ["info", "warning", "critical"] as const;
export type CovenantSeverity = (typeof COVENANT_SEVERITIES)[number];
export type CovenantStatus = "unevaluated" | "pass" | "fail" | "unknown";

interface FigureRule {
  figure: keyof Figures;
  direction: "below" | "above";
  unit: "bps" | "cents" | "count";
  partial_is_lower_bound: boolean; // a total of only what could be measured can only understate it, so going over is real
}
const FIGURE_RULES: Partial<Record<RuleType, FigureRule>> = {
  coverage_below: { figure: "coverage_bps", direction: "below", unit: "bps", partial_is_lower_bound: false },
  reversal_rate_above: { figure: "reversal_rate_bps", direction: "above", unit: "bps", partial_is_lower_bound: false },
  failure_rate_above: { figure: "failure_rate_bps", direction: "above", unit: "bps", partial_is_lower_bound: false },
  unresolved_above: { figure: "unresolved_cents", direction: "above", unit: "cents", partial_is_lower_bound: true },
  complaints_above: { figure: "open_complaints", direction: "above", unit: "count", partial_is_lower_bound: false },
};
const unitOf = (rule: RuleType) => FIGURE_RULES[rule]?.unit ?? (rule === "consecutive_gaps" ? "periods" : "seconds");
const SECONDS_RULES: RuleType[] = ["snapshot_missed_for", "unverified_for"];
const NOT_LIVE_REASON = "The product isn't live, so there's no partner signature to expect";

export interface Judged {
  status: "pass" | "fail" | "unknown";
  observed: number | null;
  reason: string | null;
}

// A rule against one figure. Null is unknown with the figure's own reason; a partial figure can't be called a pass.
export function judgeFigure(rule: RuleType, threshold: number, f: Figure | undefined): Judged {
  const r = FIGURE_RULES[rule]!;
  if (!f || f.value === null) return { status: "unknown", observed: null, reason: f?.reason ?? "This figure isn't in the snapshot" };
  const tripped = r.direction === "below" ? f.value < threshold : f.value > threshold;
  if (f.partial) {
    if (r.partial_is_lower_bound && tripped) return { status: "fail", observed: f.value, reason: `${r.figure} is over the threshold even counting only what could be measured` };
    return { status: "unknown", observed: null, reason: f.reason ?? "This figure only covers part of what it should" };
  }
  return tripped ? { status: "fail", observed: f.value, reason: `${r.figure} is ${r.direction} the threshold` } : { status: "pass", observed: f.value, reason: null };
}

export interface CovenantConfig {
  pollMs: number;
}
export const covenantConfigFromEnv = (env = process.env): CovenantConfig => ({ pollMs: Math.max(Number(env.COVENANT_POLL_MS ?? 60_000) || 60_000, 1000) });

export interface CovenantDeps {
  now?: () => Date;
}

export class CovenantError extends Error {}

interface Covenant {
  id: string;
  sponsorship_id: string;
  product_id: string;
  provider_entity_id: string;
  rule_type: RuleType;
  threshold: number;
  action: CovenantAction;
  severity: CovenantSeverity;
  cooldown_seconds: number;
  unknown_limit_seconds: number;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  status: CovenantStatus;
  status_reason: string | null;
  status_since: string | null;
  status_sandbox: boolean;
  live_tick_at: string | null;
  relaunched_at: string | null;
  last_evaluated_at: string | null;
  last_epoch: number | null;
  last_sequence: number | null;
  last_version: number | null;
  last_alert_at: string | null;
  open_breach_id: string | null;
  open_unknown_breach_id: string | null;
}

interface Breach {
  id: string;
  covenant_id: string;
  sponsorship_id: string;
  product_id: string;
  provider_entity_id: string;
  rule_type: RuleType;
  kind: "breach" | "unknown_limit" | "historical";
  severity: CovenantSeverity;
  action: CovenantAction;
  action_taken: string;
  alerted: boolean;
  sandbox: boolean;
  threshold: number;
  unit: string;
  observed_value: number | null;
  observed_sealed: string | null;
  snapshot_epoch: number | null;
  snapshot_sequence: number | null;
  snapshot_fingerprint: string | null;
  reason: string | null;
  in_flight: unknown;
  opened_at: string;
}

interface BreachEvent {
  breach_id: string;
  event: string;
  actor_id: string | null;
  reason: string | null;
  details: unknown;
  at: string;
}

interface Hold {
  id: string;
  breach_id: string;
  covenant_id: string;
  sponsorship_id: string;
  product_id: string;
  provider_entity_id: string;
  rule_type: RuleType;
  paused_at: string;
  released_at: string | null;
  released_by: string | null;
  release_reason: string | null;
  override: boolean;
}

const covenantOf = (r: Record<string, unknown>): Covenant => ({ ...(r as unknown as Covenant), threshold: Number(r.threshold) });
const breachOf = (r: Record<string, unknown>): Breach => ({ ...(r as unknown as Breach), threshold: Number(r.threshold), observed_value: r.observed_value === null ? null : Number(r.observed_value) });

interface RuleResult extends Judged {
  sealed: boolean; // the observed value is a figure from the sealed report
  snapshot: { epoch: number; sequence: number; fingerprint: string | null } | null;
  sandbox: boolean;
}

const SEVERITY_RANK: Record<CovenantSeverity, number> = { info: 0, warning: 1, critical: 2 };
// Whether a new rule says less than the old one: a looser threshold, alert in place of pause, a lower severity, or
// a slower or later alarm.
function weakens(old: Covenant, next: Pick<Covenant, "threshold" | "action" | "severity" | "cooldown_seconds" | "unknown_limit_seconds">): boolean {
  const looser = old.rule_type === "coverage_below" ? next.threshold < old.threshold : next.threshold > old.threshold;
  return looser || (old.action === "pause" && next.action === "alert") || SEVERITY_RANK[next.severity] < SEVERITY_RANK[old.severity] || next.cooldown_seconds > old.cooldown_seconds || next.unknown_limit_seconds > old.unknown_limit_seconds;
}

const DEFAULT_COOLDOWN_SECONDS = 24 * 3600;
const DEFAULT_UNKNOWN_LIMIT_SECONDS = 24 * 3600;
const MAX_RULES_PER_SPONSORSHIP = 20;
const MAX_REPLAY = 50;

type History = Awaited<ReturnType<ProductHealthService["covenantRows"]>>;

export class CovenantService {
  private timer: NodeJS.Timeout | null = null;
  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly health: ProductHealthService,
    readonly config: CovenantConfig,
    private readonly deps: CovenantDeps,
  ) {}

  // The tables are created with the store's; hooking the health worker makes every new snapshot get evaluated at once.
  static async open(db: Db, store: Store, health: ProductHealthService, config: CovenantConfig = covenantConfigFromEnv(), deps: CovenantDeps = {}) {
    const service = new CovenantService(db, store, health, config, deps);
    health.afterAdvance = (productId) => service.evaluateProduct(productId);
    return service;
  }

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  // ---- evaluation ----

  // Every rule in force, whether or not a snapshot has arrived, and whether or not the health worker has ever run.
  async tick() {
    const now = this.now();
    await this.db.query(`INSERT INTO ${T}.product_health_worker (id, last_tick_at) VALUES ('covenants', $1) ON CONFLICT (id) DO UPDATE SET last_tick_at = EXCLUDED.last_tick_at`, [now]);
    const { rows } = await this.db.query(`SELECT DISTINCT c.product_id FROM ${T}.covenants c JOIN ${T}.sponsorships s ON s.id = c.sponsorship_id WHERE c.deleted_at IS NULL AND s.status = 'approved'`);
    for (const r of rows as unknown as { product_id: string }[]) await this.evaluateProduct(r.product_id).catch((e) => console.error("covenants:", r.product_id, (e as Error).message));
  }

  startWorker() {
    this.timer = serialLoop(() => this.tick(), this.config.pollMs, "covenants");
  }
  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async evaluateProduct(productId: string) {
    const record = await this.store.getProduct(productId);
    if (!record) return;
    const now = this.now();
    const interval = this.health.config.intervalMs / 1000;
    // A product that isn't live raises no alarms, and time not live doesn't count against it. A blip of up to about one
    // snapshot interval counts as live, so taking a product down between ticks can't stop the clocks.
    if (record.status !== "published") {
      await this.db.query(
        `UPDATE ${T}.covenants SET off_sale_since = COALESCE(off_sale_since, $2::timestamptz),
           live_tick_at = CASE WHEN COALESCE(off_sale_since, $2::timestamptz) <= $2::timestamptz - make_interval(secs => $3::double precision) THEN NULL ELSE live_tick_at END
         WHERE product_id = $1`,
        [productId, now, interval],
      );
      return;
    }
    await this.db.query(
      `UPDATE ${T}.covenants SET relaunched_at = CASE WHEN off_sale_since <= $2::timestamptz - make_interval(secs => $3::double precision) THEN $2::timestamptz ELSE relaunched_at END, off_sale_since = NULL
       WHERE product_id = $1 AND off_sale_since IS NOT NULL`,
      [productId, now, interval],
    );
    const { rows } = await this.db.query(
      `SELECT c.* FROM ${T}.covenants c JOIN ${T}.sponsorships s ON s.id = c.sponsorship_id WHERE c.product_id = $1 AND c.deleted_at IS NULL AND s.status = 'approved' ORDER BY c.created_at, c.id`,
      [productId],
    );
    if (!rows.length) return;
    const history = await this.health.covenantRows(productId);
    for (const row of rows as Record<string, unknown>[]) await this.evaluateCovenant(covenantOf(row), record, history).catch((e) => console.error("covenants:", row.id, (e as Error).message));
    // A hold whose pause didn't take (a failure partway): the record is put right here rather than left to chance.
    const current = await this.store.getProduct(productId);
    if (current?.status === "published" && (await this.activeHolds(productId)).length && !current.drift?.changes.some((c) => c.kind === "covenant")) await checkDrift(this.store, current);
  }

  private async evaluateCovenant(start: Covenant, record: ProductRecord, history: History): Promise<Covenant> {
    let c = start;
    const sponsorship = await this.store.getSponsorship(c.sponsorship_id);
    if (!sponsorship) return c;
    const published = record.status === "published";
    if (FIGURE_RULES[c.rule_type]) {
      const current = history.rows.filter((r) => r.epoch === history.epoch);
      const latest = current[current.length - 1];
      if (!latest) c = await this.applyResult(c, record, { status: "unknown", observed: null, reason: "No snapshot has been recorded yet", sealed: false, snapshot: null, sandbox: await this.sandboxOnly(sponsorship, published) });
      else if (this.isStale(latest)) {
        // A figure says nothing about now once the record has stopped moving: it isn't judged, for or against.
        c = await this.applyResult(c, record, { status: "unknown", observed: null, reason: "The latest snapshot is more than two intervals old, so it can't speak for now", sealed: false, snapshot: null, sandbox: await this.sandboxOnly(sponsorship, published) });
      } else {
        // A rule that's new or just changed starts from the latest snapshot; otherwise every snapshot since it last
        // looked, leaving out any too old to speak for now.
        const fresh = c.last_version !== c.version || c.last_epoch === null || c.last_sequence === null;
        const unseen = fresh ? [] : current.filter((r) => r.epoch > c.last_epoch! || r.sequence > c.last_sequence!);
        await this.recordUnjudged(c, sponsorship, unseen.filter((r) => this.isStale(r)), published);
        const pending = fresh ? [latest] : unseen.filter((r) => !this.isStale(r)).slice(-MAX_REPLAY);
        for (const r of pending) c = await this.applyResult(c, record, await this.judgeSnapshot(c, sponsorship, r, published));
      }
    } else c = await this.applyResult(c, record, await this.judgeTiming(c, sponsorship, record, history));
    c = await this.repairHold(c, record);
    return this.checkUnknownLimit(c, record, sponsorship);
  }

  // Snapshots too old to act on still leave a trace: how many went unjudged and their range, and if any of them would
  // have breached, a breach labelled historical that pauses nothing and is closed from the start.
  private async recordUnjudged(c: Covenant, s: Sponsorship, skipped: SnapshotRow[], published: boolean) {
    if (!skipped.length) return;
    const now = this.now();
    const range = { count: skipped.length, from_sequence: skipped[0].sequence, to_sequence: skipped[skipped.length - 1].sequence, from: new Date(skipped[0].period_start).toISOString(), to: new Date(skipped[skipped.length - 1].period_end).toISOString() };
    await this.store.audit(null, "covenant_rows_unjudged", c.product_id, { covenant_id: c.id, sponsorship_id: c.sponsorship_id, rule_type: c.rule_type, ...range });
    const failing: { row: SnapshotRow; result: RuleResult }[] = [];
    for (const row of skipped.slice(-MAX_REPLAY)) {
      const result = await this.judgeSnapshot(c, s, row, published);
      if (result.status === "fail") failing.push({ row, result });
    }
    if (!failing.length) return;
    const { result: r } = failing[failing.length - 1];
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO ${T}.covenant_breaches (id, covenant_id, sponsorship_id, product_id, provider_entity_id, rule_type, kind, severity, action, action_taken, alerted, sandbox, threshold, unit, observed_value, observed_sealed, snapshot_epoch, snapshot_sequence, snapshot_fingerprint, reason, opened_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'historical', $7, $8, 'historical_not_acted_on', false, $9, $10, $11, NULL, $12, $13, $14, $15, $16, $17)`,
      [id, c.id, c.sponsorship_id, c.product_id, c.provider_entity_id, c.rule_type, c.severity, c.action, r.sandbox, c.threshold, unitOf(c.rule_type), r.observed !== null ? seal(JSON.stringify({ value: r.observed }), r.sandbox, true) : null, r.snapshot?.epoch ?? null, r.snapshot?.sequence ?? null, r.snapshot?.fingerprint ?? null, "This snapshot would have breached the rule, but it was too old to act on when Mynt reached it", now],
    );
    await this.event(id, "resolved", null, "Too old to act on: recorded, not acted on", { ...range, failing_sequences: failing.map((f) => f.row.sequence) }, now);
    await this.store.audit(null, "covenant_breached", c.product_id, { breach_id: id, covenant_id: c.id, sponsorship_id: c.sponsorship_id, rule_type: c.rule_type, kind: "historical", action_taken: "historical_not_acted_on", sandbox: r.sandbox, sequence: r.snapshot?.sequence ?? null, fingerprint: r.snapshot?.fingerprint ?? null });
  }

  private isStale(r: SnapshotRow) {
    return this.now().getTime() - new Date(r.period_end).getTime() > 2 * this.health.config.intervalMs;
  }

  // Whether drift can hold this product: only a live product with pinned state can drift.
  private canPause(record: ProductRecord) {
    return record.status === "published" && !!record.pins;
  }

  // A pause rule with an open breach and no hold: the rule changed to pause, the product went live, or a failure
  // partway left it unheld. A hold once released has a row, so an override isn't undone here.
  private async repairHold(c: Covenant, record: ProductRecord): Promise<Covenant> {
    if (c.action !== "pause" || !c.open_breach_id || c.status !== "fail" || c.status_sandbox) return c;
    const b = await this.breach(c.open_breach_id);
    if (!b || b.sandbox || b.kind !== "breach" || !this.canPause(record) || (await this.holdFor(b.id))) return c;
    const now = this.now();
    await this.hold(c, b, record, now, true);
    return (await this.alertOrRecord(c, b, "covenant.breached", { paused: true }, now)) ? this.recordAlert(c, now) : c;
  }

  // Whether a result is sandbox-only, so it labels rather than acts. A published product is never sandbox here: its
  // sponsor's ledger being the sandbox makes its figures unknown, not harmless. Otherwise a snapshot is judged by its
  // own source, and without one by the ledger the firm is on now; a ledger Mynt can't tell is unknown, never sandbox.
  private async sandboxOnly(s: Sponsorship, published: boolean, r?: SnapshotRow) {
    if (published) return false;
    if (r && r.status !== "missed" && r.source) return r.source === "sandbox";
    return (await this.health.ledgerState(s.provider_entity_id)) === "sandbox";
  }

  private async judgeSnapshot(c: Covenant, s: Sponsorship, r: SnapshotRow, published: boolean): Promise<RuleResult> {
    const snapshot = { epoch: r.epoch, sequence: r.sequence, fingerprint: r.fingerprint };
    if (r.status === "missed") return { status: "unknown", observed: null, reason: r.missed_reason ?? "No snapshot for this period", sealed: false, snapshot, sandbox: await this.sandboxOnly(s, published, r) };
    // A sponsor reads only its own books; a second sponsor's numeric rules can't be answered from the first's figures.
    if (r.partner_entity_id !== s.provider_entity_id) return { status: "unknown", observed: null, reason: "This snapshot's figures come from another licence provider's books, which your firm can't read", sealed: false, snapshot, sandbox: await this.sandboxOnly(s, published, r) };
    const assessed = await this.health.assessOne(r);
    if (!assessed || !assessed.report) return { status: "unknown", observed: null, reason: assessed ? "The snapshot's report can't be authenticated" : "Mynt can't open the snapshot's report", sealed: false, snapshot, sandbox: false };
    if (assessed.source === "unavailable") return { status: "unknown", observed: null, reason: "The partner's ledger couldn't be read for this period", sealed: false, snapshot, sandbox: false };
    // Test figures say nothing about a live product: unknown (which starts the unknown clock), neither a pass nor a fail.
    if (assessed.source === "sandbox" && published) return { status: "unknown", observed: null, reason: "The sponsor's ledger is still the sandbox: test figures can't speak for a live product (connect it with the partner kit)", sealed: false, snapshot, sandbox: false };
    const figure = assessed.report.figures[FIGURE_RULES[c.rule_type]!.figure];
    return { ...judgeFigure(c.rule_type, c.threshold, figure), sealed: true, snapshot, sandbox: assessed.source === "sandbox" };
  }

  private async judgeTiming(c: Covenant, s: Sponsorship, record: ProductRecord, history: History): Promise<RuleResult> {
    const now = this.now();
    const sandbox = await this.sandboxOnly(s, record.status === "published");
    const current = history.rows.filter((r) => r.epoch === history.epoch);
    const last = current[current.length - 1];
    const snapshot = last ? { epoch: last.epoch, sequence: last.sequence, fingerprint: last.fingerprint } : null;
    const seconds = (from: Date) => Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
    const earliest = new Date(Math.max(new Date(c.created_at).getTime(), s.decided_at ? new Date(s.decided_at).getTime() : 0));
    const result = (status: Judged["status"], observed: number | null, reason: string | null): RuleResult => ({ status, observed, reason, sealed: false, snapshot, sandbox });
    const relaunched = c.relaunched_at ? new Date(c.relaunched_at).getTime() : Number.NEGATIVE_INFINITY;
    if (c.rule_type === "snapshot_missed_for") {
      const real = await this.lastRealSnapshot(history.rows);
      if (real === undefined) return result("unknown", null, "Mynt can't authenticate this record's snapshots (the vault key isn't available)");
      // Time off sale doesn't count: after a relaunch the clock runs from the relaunch or the last snapshot, whichever is later.
      const elapsed = seconds(new Date(Math.max(real ? new Date(real.period_end).getTime() : earliest.getTime(), relaunched)));
      return elapsed > c.threshold ? result("fail", elapsed, real ? "No snapshot has arrived for longer than the limit" : "No snapshot has ever arrived, for longer than the limit") : result("pass", elapsed, null);
    }
    if (c.rule_type === "consecutive_gaps") {
      if (!last) return result("unknown", null, "No snapshot has been recorded yet, so there's no record to count gaps in");
      const interval = this.health.config.intervalMs;
      const periods = (r: SnapshotRow) => Math.max(1, Math.round((new Date(r.period_end).getTime() - Math.max(new Date(r.period_start).getTime(), relaunched)) / interval));
      let gaps = 0;
      for (const r of [...current].reverse()) {
        if (r.status !== "missed" || new Date(r.period_end).getTime() <= relaunched) break;
        gaps += periods(r);
      }
      // Whole periods since the record stopped moving at all, when the worker isn't running to write them down.
      gaps += Math.max(0, Math.floor((now.getTime() - Math.max(new Date(last.period_end).getTime(), relaunched)) / interval) - 1);
      return gaps >= c.threshold ? result("fail", gaps, "The latest periods have no snapshot") : result("pass", gaps, null);
    }
    // unverified_for: a live product's snapshots carrying no partner signature.
    if (record.status !== "published") return result("unknown", null, NOT_LIVE_REASON);
    // Only the firm whose books they are can sign a snapshot, so a sponsor whose books aren't the latest has nothing to be held to.
    const own = history.rows.filter((r) => r.partner_entity_id === s.provider_entity_id);
    const latestReal = [...history.rows].reverse().find((r) => r.status !== "missed");
    if (latestReal?.partner_entity_id !== s.provider_entity_id) {
      await this.db.query(`UPDATE ${T}.covenants SET live_tick_at = $2 WHERE id = $1`, [c.id, now]); // time it couldn't have signed doesn't count
      return result("unknown", null, "The latest snapshot doesn't come from your firm's books, so there's nothing your firm could sign");
    }
    const signed = await this.health.lastPartnerSignedAt(own);
    if (signed === undefined) return result("unknown", null, "Mynt can't check the signatures on this record (the vault key isn't available)");
    const elapsed = await this.unsignedLiveSeconds(c, signed, now);
    return elapsed > c.threshold ? result("fail", elapsed, signed ? "No partner-signed snapshot for longer than the limit" : "No partner signature on any snapshot, for longer than the limit") : result("pass", elapsed, null);
  }

  // The newest snapshot that really arrived: not a missed period, a failed ledger read or a report that can't be
  // authenticated. Null when there's none; undefined when Mynt can't authenticate anything.
  private async lastRealSnapshot(rows: SnapshotRow[]): Promise<SnapshotRow | null | undefined> {
    for (const r of [...rows].reverse().slice(0, 200)) {
      if (r.status === "missed" || r.source === "unavailable") continue;
      const a = await this.health.assessOne(r);
      if (!a) return undefined;
      if (a.report && a.report_matches === true && a.source !== "unavailable") return r;
    }
    return null;
  }

  // How long the product has been live and unsigned. Time not live doesn't count, so a relaunch doesn't breach at once;
  // nothing a builder does while it's live restarts it, and only a newer valid signature does.
  private async unsignedLiveSeconds(c: Covenant, signed: Date | null, now: Date): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE ${T}.covenants SET
         unsigned_live_seconds = CASE WHEN $3::timestamptz IS NOT NULL AND (unsigned_anchor IS NULL OR $3::timestamptz > unsigned_anchor)
           THEN GREATEST(0, floor(extract(epoch FROM ($2::timestamptz - $3::timestamptz))))::bigint
           ELSE unsigned_live_seconds + CASE WHEN live_tick_at IS NULL THEN 0 ELSE GREATEST(0, floor(extract(epoch FROM ($2::timestamptz - live_tick_at))))::bigint END END,
         unsigned_anchor = CASE WHEN $3::timestamptz IS NOT NULL AND (unsigned_anchor IS NULL OR $3::timestamptz > unsigned_anchor) THEN $3::timestamptz ELSE unsigned_anchor END,
         live_tick_at = $2::timestamptz
       WHERE id = $1 RETURNING unsigned_live_seconds`,
      [c.id, now, signed],
    );
    return Number((rows[0] as { unsigned_live_seconds: unknown }).unsigned_live_seconds);
  }

  // A sandbox result says nothing about live figures, so it can't close what they opened.
  private async sandboxCantClose(id: string, r: RuleResult) {
    if (!r.sandbox) return false;
    const b = await this.breach(id);
    return !!b && !b.sandbox;
  }

  private async applyResult(c: Covenant, record: ProductRecord, r: RuleResult): Promise<Covenant> {
    const now = this.now();
    // Coming back live starts the unknown clock afresh: not being live wasn't this rule failing to be evaluated.
    const changed = r.status !== c.status || c.status_reason === NOT_LIVE_REASON;
    const { rows } = await this.db.query(
      `UPDATE ${T}.covenants SET status = $2, status_reason = $3, status_since = CASE WHEN status_since IS NULL OR $4 THEN $5::timestamptz ELSE status_since END,
         status_sandbox = $9, last_evaluated_at = $5, last_epoch = COALESCE($6, last_epoch), last_sequence = COALESCE($7, last_sequence), last_version = $8
       WHERE id = $1 RETURNING *`,
      [c.id, r.status, r.reason, changed, now, r.snapshot?.epoch ?? null, r.snapshot?.sequence ?? null, c.version, r.sandbox],
    );
    let next = covenantOf(rows[0] as Record<string, unknown>);
    if (r.status !== "unknown" && next.open_unknown_breach_id && !(await this.sandboxCantClose(next.open_unknown_breach_id, r))) next = await this.resolve(next, "open_unknown_breach_id", "the rule can be evaluated again");
    if (r.status === "pass" && next.open_breach_id && !(await this.sandboxCantClose(next.open_breach_id, r))) next = await this.resolve(next, "open_breach_id", "the rule passes again", true);
    if (r.status === "fail") next = await this.onFail(next, record, r);
    return next;
  }

  private async breach(id: string | null): Promise<Breach | undefined> {
    if (!id) return undefined;
    const { rows } = await this.db.query(`SELECT * FROM ${T}.covenant_breaches WHERE id = $1`, [id]);
    return rows[0] ? breachOf(rows[0] as Record<string, unknown>) : undefined;
  }

  private async onFail(c: Covenant, record: ProductRecord, r: RuleResult): Promise<Covenant> {
    let next = c;
    const open = await this.breach(next.open_breach_id);
    // Sandbox figures that turn real: the sandbox breach is over, and a live one starts in its place.
    if (open && open.sandbox && !r.sandbox) {
      next = await this.resolve(next, "open_breach_id", "superseded by a breach on live figures");
      return this.openBreach(next, record, r, "breach");
    }
    if (!open) return this.openBreach(next, record, r, "breach");
    if (r.sandbox && !open.sandbox) return next; // sandbox figures don't keep a live breach's alarm ringing
    return this.remind(next, open);
  }

  private async holdFor(breachId: string): Promise<Hold | undefined> {
    return (await this.db.query(`SELECT * FROM ${T}.covenant_holds WHERE breach_id = $1`, [breachId])).rows[0] as unknown as Hold | undefined;
  }

  private cooledDown(c: Covenant, now: Date) {
    return !c.last_alert_at || now.getTime() - new Date(c.last_alert_at).getTime() >= c.cooldown_seconds * 1000;
  }

  private async recordAlert(c: Covenant, now: Date) {
    await this.db.query(`UPDATE ${T}.covenants SET last_alert_at = $2 WHERE id = $1`, [c.id, now]);
    return { ...c, last_alert_at: now.toISOString() };
  }

  private async openBreach(c: Covenant, record: ProductRecord, r: RuleResult, kind: Breach["kind"]): Promise<Covenant> {
    const now = this.now();
    const col = kind === "breach" ? "open_breach_id" : "open_unknown_breach_id";
    const wantsPause = kind === "breach" && c.action === "pause" && !r.sandbox;
    const pausing = wantsPause && this.canPause(record);
    const pauseFailed = wantsPause && record.status === "published" && !pausing;
    // A pause is always told to the sponsor, cooldown or not.
    const alerting = pausing || pauseFailed || this.cooledDown(c, now);
    const reachable = (await this.store.reachableFirmWebhooks(c.provider_entity_id, "covenant.breached")) > 0;
    const told = alerting ? (reachable ? "alerted" : "alert_undelivered") : "alert_suppressed_by_cooldown";
    const inFlight = pausing ? await this.moneyInFlight(record.product.id) : null;
    let actionTaken: string;
    if (kind === "unknown_limit") actionTaken = told;
    else if (r.sandbox) actionTaken = "sandbox_labelled";
    else if (c.action === "pause") actionTaken = pausing ? (reachable ? "paused" : "paused_alert_undelivered") : pauseFailed ? "pause_failed_no_pins" : "pause_pending_publication";
    else actionTaken = told;
    const observedSealed = r.sealed && r.observed !== null ? seal(JSON.stringify({ value: r.observed }), r.sandbox, true) : null;
    const id = randomUUID();
    // One statement: the rule's open-breach pointer and the breach row, so a retry can't leave two open breaches.
    const { rows } = await this.db.query(
      `WITH claim AS (UPDATE ${T}.covenants SET ${col} = $1::uuid WHERE id = $2::uuid AND ${col} IS NULL AND deleted_at IS NULL RETURNING id)
       INSERT INTO ${T}.covenant_breaches (id, covenant_id, sponsorship_id, product_id, provider_entity_id, rule_type, kind, severity, action, action_taken, alerted, sandbox, threshold, unit, observed_value, observed_sealed, snapshot_epoch, snapshot_sequence, snapshot_fingerprint, reason, in_flight, opened_at)
       SELECT $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::text, $7::text, $8::text, $9::text, $10::text, $11::boolean, $12::boolean, $13::bigint, $14::text, $15::bigint, $16::text, $17::int, $18::int, $19::text, $20::text, $21::jsonb, $22::timestamptz FROM claim RETURNING *`,
      [
        id, c.id, c.sponsorship_id, c.product_id, c.provider_entity_id, c.rule_type, kind, c.severity, c.action, actionTaken, alerting && reachable, r.sandbox, c.threshold, unitOf(c.rule_type),
        r.sealed ? null : r.observed, observedSealed, r.snapshot?.epoch ?? null, r.snapshot?.sequence ?? null, r.snapshot?.fingerprint ?? null, r.reason, inFlight ? JSON.stringify(inFlight) : null, now,
      ],
    );
    if (!rows.length) return c; // someone else opened it first
    const breach = breachOf(rows[0] as Record<string, unknown>);
    let next: Covenant = { ...c, [col]: id } as Covenant;
    await this.store.audit(null, "covenant_breached", c.product_id, { breach_id: id, covenant_id: c.id, sponsorship_id: c.sponsorship_id, rule_type: c.rule_type, kind, action_taken: actionTaken, sandbox: r.sandbox, sequence: r.snapshot?.sequence ?? null, fingerprint: r.snapshot?.fingerprint ?? null });
    if (pausing) await this.hold(next, breach, record, now, false);
    if (pauseFailed) await this.event(id, "pause_failed", null, "The product has no pinned state, so drift can't hold it: it wasn't paused", {}, now);
    if (alerting) {
      // Nothing queued starts no cooldown, so an alert goes out as soon as there's a webhook to take it.
      if (await this.alertOrRecord(next, breach, "covenant.breached", {}, now, true)) next = await this.recordAlert(next, now);
    }
    return next;
  }

  private async remind(c: Covenant, breach: Breach): Promise<Covenant> {
    const now = this.now();
    // Claimed here, in one statement: two evaluators can't both send the same reminder.
    const { rows } = await this.db.query(
      `UPDATE ${T}.covenants SET last_alert_at = $2::timestamptz WHERE id = $1 AND (last_alert_at IS NULL OR last_alert_at <= $2::timestamptz - make_interval(secs => $3::double precision)) RETURNING id`,
      [c.id, now, c.cooldown_seconds],
    );
    if (!rows.length) return c;
    if (await this.alertOrRecord(c, breach, "covenant.breached", { reminder: true }, now)) await this.event(breach.id, "alert_repeated", null, null, {}, now);
    return { ...c, last_alert_at: now.toISOString() };
  }

  private async event(breachId: string, event: string, actorId: string | null, reason: string | null, details: unknown, at: Date) {
    await this.db.query(`INSERT INTO ${T}.covenant_breach_events (id, breach_id, event, actor_id, reason, details, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), breachId, event, actorId, reason, JSON.stringify(details ?? {}), at]);
  }

  // Closes a breach once, however many evaluations race for it; the alert says so only if one was sent.
  private async resolve(c: Covenant, col: "open_breach_id" | "open_unknown_breach_id", reason: string, emitCleared = false): Promise<Covenant> {
    const now = this.now();
    const id = c[col];
    if (!id) return c;
    const { rows } = await this.db.query(`UPDATE ${T}.covenants SET ${col} = NULL WHERE id = $1 AND ${col} = $2 RETURNING id`, [c.id, id]);
    if (!rows.length) return c;
    await this.event(id, "resolved", null, reason, {}, now);
    await this.store.audit(null, "covenant_cleared", c.product_id, { breach_id: id, covenant_id: c.id, rule_type: c.rule_type, reason });
    const breach = await this.breach(id);
    if (emitCleared && breach?.alerted) {
      const hold = await this.holdFor(id);
      await this.alertOrRecord(c, breach, "covenant.cleared", { hold_active: Boolean(hold && !hold.released_at) }, now);
    }
    return { ...c, [col]: null };
  }

  // Money already moving is reported and left alone: a pause only stops new sales.
  private async moneyInFlight(productId: string) {
    const { rows } = await this.db.query<{ n: number; cents: string }>(`SELECT count(*)::int AS n, COALESCE(sum(amount_cents), 0)::text AS cents FROM ${T}.money_movements WHERE product_id = $1 AND NOT sandbox AND status IN ('requested', 'submitted') AND COALESCE(action, '') NOT IN ('pool_deposit', 'pool_withdrawal')`, [productId]);
    return { movements: Number(rows[0]?.n ?? 0), amount_cents: Number(rows[0]?.cents ?? 0), statuses: ["requested", "submitted"], note: "These stay as they are: a covenant pause stops new sales only and cancels nothing already in flight" };
  }

  private async hold(c: Covenant, breach: Breach, record: ProductRecord, now: Date, late: boolean) {
    await this.db.query(
      `INSERT INTO ${T}.covenant_holds (id, breach_id, covenant_id, sponsorship_id, product_id, provider_entity_id, rule_type, paused_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (breach_id) DO NOTHING`,
      [randomUUID(), breach.id, c.id, c.sponsorship_id, c.product_id, c.provider_entity_id, c.rule_type, now],
    );
    if (late) await this.event(breach.id, "paused", null, "the rule was changed to pause, or the product went live, while it was still failing", { in_flight: await this.moneyInFlight(record.product.id) }, now);
    await this.store.audit(null, "covenant_paused_product", c.product_id, { breach_id: breach.id, covenant_id: c.id, sponsorship_id: c.sponsorship_id, rule_type: c.rule_type });
    await checkDrift(this.store, (await this.store.getProduct(c.product_id))!);
    await driftDependents(this.store, c.product_id);
  }

  // To the sponsor's own webhooks, with the numbers sealed until they're sent.
  private async alert(c: Covenant, b: Breach, type: "covenant.breached" | "covenant.cleared", extra: Record<string, unknown>): Promise<number> {
    const data = {
      breach_id: b.id,
      covenant_id: c.id,
      sponsorship_id: c.sponsorship_id,
      product_id: c.product_id,
      rule_type: c.rule_type,
      kind: b.kind,
      severity: b.severity,
      action: b.action,
      action_taken: b.action_taken,
      sandbox: b.sandbox,
      snapshot: b.snapshot_sequence === null ? null : { epoch: b.snapshot_epoch, sequence: b.snapshot_sequence, fingerprint: b.snapshot_fingerprint },
      reason: b.reason,
      opened_at: new Date(b.opened_at).toISOString(),
      ...extra,
    };
    let sealed: string | undefined;
    const figures = { threshold: b.threshold, unit: b.unit, observed: this.observedOf(b), in_flight: b.in_flight ?? null };
    if (vaultAvailable(b.sandbox)) sealed = seal(JSON.stringify(figures), b.sandbox, true);
    return emitFirmEvent(this.store, c.provider_entity_id, type, data, b.sandbox, sealed).catch((e) => {
      console.error("covenants: the alert couldn't be queued:", (e as Error).message);
      return 0;
    });
  }

  // Sends an alert and says whether it went anywhere; if it didn't, the record says so.
  private async alertOrRecord(c: Covenant, b: Breach, type: "covenant.breached" | "covenant.cleared", extra: Record<string, unknown>, now: Date, first = false): Promise<boolean> {
    const queued = await this.alert(c, b, type, extra);
    if (queued === 0) await this.event(b.id, "alert_undelivered", null, "No webhook could receive this alert", { type, first }, now);
    return queued > 0;
  }

  // A breach's value as the sponsor should read it; null when it was a figure Mynt can no longer open.
  private observedOf(b: Breach): number | null {
    if (b.observed_value !== null) return b.observed_value;
    if (!b.observed_sealed) return null;
    try {
      return (JSON.parse(openSealed(b.observed_sealed, b.sandbox)) as { value: number }).value;
    } catch {
      return null;
    }
  }

  // Unknown past the rule's named limit is itself alertable. It alerts only: not knowing never pauses a product.
  private async checkUnknownLimit(c: Covenant, record: ProductRecord, s: Sponsorship): Promise<Covenant> {
    if (c.status !== "unknown" || !c.status_since || record.status !== "published") return c;
    const now = this.now();
    const unknownFor = Math.floor((now.getTime() - new Date(c.status_since).getTime()) / 1000);
    const open = await this.breach(c.open_unknown_breach_id);
    if (open) return this.remind(c, open);
    if (unknownFor <= c.unknown_limit_seconds) return c;
    const snapshot = c.last_sequence !== null ? { epoch: c.last_epoch!, sequence: c.last_sequence, fingerprint: await this.health.fingerprintAt(c.product_id, c.last_epoch!, c.last_sequence) } : null;
    return this.openBreach(c, record, { status: "unknown", observed: unknownFor, reason: c.status_reason ?? "This rule can't be evaluated", sealed: false, snapshot, sandbox: await this.sandboxOnly(s, record.status === "published") }, "unknown_limit");
  }

  // ---- who may do what ----

  // Only a named licence-provider role at the sponsoring firm. Every admin implies that role, so an account with the
  // admin role is refused outright, as for co-signing and reading a firm's books (product-health.ts).
  private async sponsorOf(user: User, sponsorshipId: string, op: string): Promise<{ sponsorship: Sponsorship; me: User }> {
    const me = (await this.store.getUser(user.id)) ?? user;
    const s = await this.store.getSponsorship(sponsorshipId);
    const refuse = async (message: string): Promise<never> => {
      await this.store.audit(user.id, `${op}_refused`, sponsorshipId, { refused: message });
      throw new CovenantError(message);
    };
    if (!s) return refuse(`No sponsorship '${sponsorshipId}'`);
    if (me.roles.includes("admin")) return refuse("Mynt's admins can see breaches (list_covenant_breaches) but don't set, change or release a sponsor's rules: they belong to the firm whose licence is at stake");
    if (!me.roles.includes("license_provider")) return refuse("Only a licence provider firm's own members can do this");
    if (!me.entity_id || me.entity_id !== s.provider_entity_id) return refuse(`No sponsorship '${sponsorshipId}' by your firm`);
    if ((await this.store.getEntity(me.entity_id))?.status !== "active") return refuse("Your firm isn't active");
    const product = await this.store.getProduct(s.product_id);
    if (product && (product.owner_id === me.id || product.entity_id === me.entity_id)) return refuse("A firm doesn't hold covenants over its own product");
    return { sponsorship: s, me };
  }

  private async covenant(id: string): Promise<Covenant | undefined> {
    const { rows } = await this.db.query(`SELECT * FROM ${T}.covenants WHERE id = $1`, [id]);
    return rows[0] ? covenantOf(rows[0] as Record<string, unknown>) : undefined;
  }

  private async activeHolds(productId: string): Promise<Hold[]> {
    return (await this.db.query(`SELECT h.* FROM ${T}.covenant_holds h JOIN ${T}.sponsorships s ON s.id = h.sponsorship_id WHERE h.product_id = $1 AND h.released_at IS NULL AND s.status = 'approved' ORDER BY h.paused_at`, [productId])).rows as unknown as Hold[];
  }

  private async holdsOf(covenantId: string): Promise<Hold[]> {
    return (await this.db.query(`SELECT * FROM ${T}.covenant_holds WHERE covenant_id = $1 AND released_at IS NULL`, [covenantId])).rows as unknown as Hold[];
  }

  // The rules, in each rule type's own unit. A duration too short to be met by the schedule would simply always be failing.
  private checkThreshold(rule: RuleType, threshold: number) {
    if (!Number.isSafeInteger(threshold) || threshold < 0) throw new CovenantError("threshold must be a whole number, zero or more");
    if ((rule === "reversal_rate_above" || rule === "failure_rate_above") && threshold > 10_000) throw new CovenantError(`${rule}'s threshold is in basis points, at most 10000`);
    if (rule === "consecutive_gaps" && threshold < 1) throw new CovenantError("consecutive_gaps must be at least 1");
    if (SECONDS_RULES.includes(rule)) {
      const min = Math.ceil((2 * this.health.config.intervalMs) / 1000);
      if (threshold < min) throw new CovenantError(`${rule} is in seconds and must be at least ${min}: two of Mynt's snapshot intervals, or it would fail between ordinary snapshots`);
    }
  }

  // ---- the sponsor's tools ----

  async set(user: User, input: { sponsorship_id: string; covenant_id?: string; rule_type: RuleType; threshold: number; action: CovenantAction; severity?: CovenantSeverity; cooldown_seconds?: number; unknown_limit_seconds?: number; reason?: string }) {
    const { sponsorship: s, me } = await this.sponsorOf(user, input.sponsorship_id, "set_covenant");
    if (s.status !== "approved") throw new CovenantError(`The sponsorship is ${s.status}, not approved`);
    this.checkThreshold(input.rule_type, input.threshold);
    const now = this.now();
    if (input.covenant_id) {
      const old = await this.covenant(input.covenant_id);
      if (!old || old.sponsorship_id !== s.id || old.deleted_at) throw new CovenantError(`No covenant '${input.covenant_id}' on that sponsorship`);
      if (old.rule_type !== input.rule_type) throw new CovenantError("A covenant's rule type can't change: delete it and set a new one");
      const next = { threshold: input.threshold, action: input.action, severity: input.severity ?? old.severity, cooldown_seconds: input.cooldown_seconds ?? old.cooldown_seconds, unknown_limit_seconds: input.unknown_limit_seconds ?? old.unknown_limit_seconds };
      const open = [old.open_breach_id, old.open_unknown_breach_id].filter((x): x is string => !!x);
      const weakening = weakens(old, next);
      if (weakening && open.length && !input.reason) {
        await this.store.audit(user.id, "set_covenant_refused", old.id, { refused: "weakening with an open breach, no reason given", old: this.configOf(old), new: next });
        throw new CovenantError("This loosens a rule that has an open breach: say why in `reason`, and it's recorded with the breach");
      }
      const { rows } = await this.db.query(
        `UPDATE ${T}.covenants SET threshold = $2, action = $3, severity = $4, cooldown_seconds = $5, unknown_limit_seconds = $6, version = version + 1, updated_by = $7, updated_at = $8 WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [old.id, next.threshold, next.action, next.severity, next.cooldown_seconds, next.unknown_limit_seconds, me.id, now],
      );
      const updated = covenantOf(rows[0] as Record<string, unknown>);
      await this.store.audit(user.id, "set_covenant", old.id, { sponsorship_id: s.id, product_id: s.product_id, rule_type: old.rule_type, old: this.configOf(old), new: next, version: updated.version, weakening, reason: input.reason ?? null, open_breaches: open });
      if (weakening) for (const id of open) await this.event(id, "rule_weakened", me.id, input.reason ?? null, { old: this.configOf(old), new: next }, now);
      return this.view(updated);
    }
    const existing = (await this.db.query(`SELECT count(*)::int AS n FROM ${T}.covenants WHERE sponsorship_id = $1 AND deleted_at IS NULL`, [s.id])).rows[0] as { n: number };
    if (existing.n >= MAX_RULES_PER_SPONSORSHIP) throw new CovenantError(`A sponsorship can have at most ${MAX_RULES_PER_SPONSORSHIP} covenants`);
    const id = randomUUID();
    const severity = input.severity ?? "warning";
    const cooldown = input.cooldown_seconds ?? DEFAULT_COOLDOWN_SECONDS;
    const unknownLimit = input.unknown_limit_seconds ?? DEFAULT_UNKNOWN_LIMIT_SECONDS;
    const { rows } = await this.db.query(
      `INSERT INTO ${T}.covenants (id, sponsorship_id, product_id, provider_entity_id, rule_type, threshold, action, severity, cooldown_seconds, unknown_limit_seconds, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $12) RETURNING *`,
      [id, s.id, s.product_id, s.provider_entity_id, input.rule_type, input.threshold, input.action, severity, cooldown, unknownLimit, me.id, now],
    );
    const created = covenantOf(rows[0] as Record<string, unknown>);
    await this.store.audit(user.id, "set_covenant", id, { sponsorship_id: s.id, product_id: s.product_id, rule_type: input.rule_type, old: null, new: this.configOf(created), version: 1 });
    return this.view(created);
  }

  private configOf(c: Covenant) {
    return { threshold: c.threshold, action: c.action, severity: c.severity, cooldown_seconds: c.cooldown_seconds, unknown_limit_seconds: c.unknown_limit_seconds };
  }

  private async view(c: Covenant) {
    const holds = c.deleted_at ? [] : await this.holdsOf(c.id);
    return {
      id: c.id,
      sponsorship_id: c.sponsorship_id,
      product_id: c.product_id,
      rule_type: c.rule_type,
      threshold: c.threshold,
      unit: unitOf(c.rule_type),
      action: c.action,
      severity: c.severity,
      cooldown_seconds: c.cooldown_seconds,
      unknown_limit_seconds: c.unknown_limit_seconds,
      version: c.version,
      status: c.status,
      status_reason: c.status_reason,
      status_since: c.status_since ? new Date(c.status_since).toISOString() : null,
      status_sandbox: c.status_sandbox,
      last_evaluated_at: c.last_evaluated_at ? new Date(c.last_evaluated_at).toISOString() : null,
      evaluated_version: c.last_version,
      open_breach_id: c.open_breach_id,
      open_unknown_breach_id: c.open_unknown_breach_id,
      pause_held_by_breach_ids: holds.map((h) => h.breach_id),
      deleted_at: c.deleted_at ? new Date(c.deleted_at).toISOString() : null,
      ...(c.rule_type === "complaints_above" ? { note: "Mynt doesn't track complaints yet, so this rule reads unknown until it does" } : {}),
    };
  }

  async list(user: User, input: { sponsorship_id?: string; product_id?: string; include_deleted?: boolean }) {
    const me = (await this.store.getUser(user.id)) ?? user;
    if (me.roles.includes("admin")) throw new CovenantError("Mynt's admins see breaches (list_covenant_breaches), not a sponsor's rule set");
    if (!me.roles.includes("license_provider") || !me.entity_id) throw new CovenantError("Only a licence provider firm's own members can list its covenants");
    const { rows } = await this.db.query(
      `SELECT * FROM ${T}.covenants WHERE provider_entity_id = $1 AND ($2::uuid IS NULL OR sponsorship_id = $2) AND ($3::text IS NULL OR product_id = $3) AND ($4 OR deleted_at IS NULL) ORDER BY created_at`,
      [me.entity_id, input.sponsorship_id ?? null, input.product_id ?? null, input.include_deleted ?? false],
    );
    return Promise.all((rows as Record<string, unknown>[]).map((r) => this.view(covenantOf(r))));
  }

  async delete(user: User, input: { covenant_id: string; reason?: string }) {
    const c = await this.covenant(input.covenant_id);
    if (!c) throw new CovenantError(`No covenant '${input.covenant_id}'`);
    const { me } = await this.sponsorOf(user, c.sponsorship_id, "delete_covenant");
    if (c.deleted_at) throw new CovenantError("That covenant is already deleted");
    if ((await this.holdsOf(c.id)).length) throw new CovenantError("This rule is holding the product paused: release it first (release_covenant_pause)");
    const open = [c.open_breach_id, c.open_unknown_breach_id].filter((x): x is string => !!x);
    if (open.length && !input.reason) {
      await this.store.audit(user.id, "delete_covenant_refused", c.id, { refused: "deleting with an open breach, no reason given" });
      throw new CovenantError("This rule has an open breach: say why you're deleting it in `reason`, and it's recorded with the breach");
    }
    const now = this.now();
    await this.db.query(`UPDATE ${T}.covenants SET deleted_at = $2, updated_by = $3, updated_at = $2, open_breach_id = NULL, open_unknown_breach_id = NULL WHERE id = $1`, [c.id, now, me.id]);
    for (const id of open) await this.event(id, "resolved", me.id, `the rule was deleted: ${input.reason}`, {}, now);
    await this.store.audit(user.id, "delete_covenant", c.id, { sponsorship_id: c.sponsorship_id, product_id: c.product_id, rule_type: c.rule_type, old: this.configOf(c), new: null, reason: input.reason ?? null, open_breaches: open });
    return { deleted: c.id };
  }

  private async eventsOf(breachIds: string[]): Promise<Map<string, BreachEvent[]>> {
    const out = new Map<string, BreachEvent[]>();
    if (!breachIds.length) return out;
    const { rows } = await this.db.query(`SELECT breach_id, event, actor_id, reason, details, at FROM ${T}.covenant_breach_events WHERE breach_id = ANY($1::uuid[]) ORDER BY at, id`, [breachIds]);
    for (const e of rows as unknown as BreachEvent[]) out.set(e.breach_id, [...(out.get(e.breach_id) ?? []), e]);
    return out;
  }

  // What the record says about one breach. Admins get the status of it and not the figure, as with the health reports.
  private breachView(b: Breach, events: BreachEvent[], hold: Hold | undefined, admin: boolean, entitled: boolean) {
    const when = (t: string | null | undefined) => (t ? new Date(t).toISOString() : null);
    const last = (...names: string[]) => [...events].reverse().find((e) => names.includes(e.event));
    const resolved = last("resolved");
    const ack = last("acknowledged");
    const revoked = last("sponsorship_revoked");
    return {
      id: b.id,
      covenant_id: b.covenant_id,
      sponsorship_id: b.sponsorship_id,
      product_id: b.product_id,
      rule_type: b.rule_type,
      kind: b.kind,
      severity: b.severity,
      action: b.action,
      action_taken: b.action_taken,
      alerted: b.alerted && !events.some((e) => e.event === "alert_undelivered" && (e.details as { first?: boolean } | null)?.first === true),
      sandbox: b.sandbox,
      snapshot: b.snapshot_sequence === null ? null : { epoch: b.snapshot_epoch, sequence: b.snapshot_sequence, fingerprint: b.snapshot_fingerprint },
      reason: b.reason,
      ...(admin ? { rule_config_withheld: "The rule's settings are the sponsor's" } : { threshold: b.threshold, unit: b.unit }),
      observed: entitled ? this.observedOf(b) : null,
      ...(!entitled && b.observed_sealed ? { observed_withheld: admin ? "A figure from the firm's books: only its licence provider reads it" : "Your firm no longer sponsors this product, so its figures aren't shown" } : {}),
      in_flight_when_paused: entitled ? b.in_flight : null,
      opened_at: when(b.opened_at),
      status: resolved ? "resolved" : "open",
      resolved_at: when(resolved?.at),
      resolved_reason: admin ? null : (resolved?.reason ?? null),
      acknowledged_by: ack?.actor_id ?? null,
      acknowledged_at: when(ack?.at),
      pause: hold ? { paused_at: when(hold.paused_at), released_at: when(hold.released_at), released_by: hold.released_by, release_reason: admin ? null : hold.release_reason, override: hold.override } : null,
      revocation: revoked ? { at: when(revoked.at), by: revoked.actor_id, reason: admin ? null : revoked.reason } : null,
      events: admin ? events.map((e) => ({ event: e.event, at: when(e.at), actor_id: e.actor_id })) : events.map((e) => ({ event: e.event, at: when(e.at), actor_id: e.actor_id, reason: e.reason, details: entitled ? e.details : {} })),
    };
  }

  // Figures go only to a firm that's active and still sponsors the product: the same test as reading the report.
  private async readsFigures(b: Breach) {
    const [s, firm] = await Promise.all([this.store.getSponsorship(b.sponsorship_id), this.store.getEntity(b.provider_entity_id)]);
    return s?.status === "approved" && firm?.status === "active";
  }

  async listBreaches(user: User, input: { product_id?: string; sponsorship_id?: string; open_only?: boolean; limit: number }) {
    const me = (await this.store.getUser(user.id)) ?? user;
    const admin = me.roles.includes("admin");
    if (!admin && (!me.roles.includes("license_provider") || !me.entity_id)) throw new CovenantError("Only a licence provider firm's own members and Mynt's admins can see covenant breaches");
    const { rows } = await this.db.query(
      `SELECT b.* FROM ${T}.covenant_breaches b
        WHERE ($1::uuid IS NULL OR b.provider_entity_id = $1) AND ($2::text IS NULL OR b.product_id = $2) AND ($3::uuid IS NULL OR b.sponsorship_id = $3)
          AND (NOT $4 OR NOT EXISTS (SELECT 1 FROM ${T}.covenant_breach_events e WHERE e.breach_id = b.id AND e.event = 'resolved'))
        ORDER BY b.opened_at DESC, b.id LIMIT $5`,
      [admin ? null : me.entity_id, input.product_id ?? null, input.sponsorship_id ?? null, input.open_only ?? false, input.limit],
    );
    const breaches = (rows as Record<string, unknown>[]).map(breachOf);
    const events = await this.eventsOf(breaches.map((b) => b.id));
    const out = [];
    for (const b of breaches) out.push(this.breachView(b, events.get(b.id) ?? [], await this.holdFor(b.id), admin, !admin && (await this.readsFigures(b))));
    return out;
  }

  async acknowledge(user: User, input: { breach_id: string; note?: string }) {
    const b = await this.breach(input.breach_id);
    if (!b) throw new CovenantError(`No breach '${input.breach_id}'`);
    const { me } = await this.sponsorOf(user, b.sponsorship_id, "acknowledge_breach");
    const events = (await this.eventsOf([b.id])).get(b.id) ?? [];
    if (events.some((e) => e.event === "acknowledged")) throw new CovenantError("That breach has already been acknowledged");
    const now = this.now();
    await this.event(b.id, "acknowledged", me.id, input.note ?? null, {}, now);
    await this.store.audit(user.id, "acknowledge_breach", b.id, { covenant_id: b.covenant_id, product_id: b.product_id, note: input.note ?? null });
    const refreshed = (await this.eventsOf([b.id])).get(b.id) ?? [];
    return this.breachView(b, refreshed, await this.holdFor(b.id), false, await this.readsFigures(b));
  }

  // Lifts a covenant's hold. The rule is checked again first, and must pass, or the sponsor overrides it with a reason.
  async release(user: User, input: { breach_id: string; override_reason?: string }) {
    const b = await this.breach(input.breach_id);
    if (!b) throw new CovenantError(`No breach '${input.breach_id}'`);
    const { me, sponsorship } = await this.sponsorOf(user, b.sponsorship_id, "release_covenant_pause");
    const hold = await this.holdFor(b.id);
    if (!hold) throw new CovenantError("That breach didn't pause the product");
    if (hold.released_at) throw new CovenantError("That pause has already been released");
    if (sponsorship.status !== "approved") throw new CovenantError(`The sponsorship is ${sponsorship.status}: the pause no longer holds the product`);
    const c = await this.covenant(hold.covenant_id);
    if (!c) throw new CovenantError("That pause's rule is missing");
    const record = await this.store.getProduct(c.product_id);
    if (!record) throw new CovenantError("That pause's product is missing");
    const history = await this.health.covenantRows(c.product_id);
    const fresh = await this.evaluateCovenant(c, record, history);
    const now = this.now();
    const passed = fresh.status === "pass" && !fresh.status_sandbox;
    if (!passed && !input.override_reason) {
      const why = fresh.status === "unknown" ? `it can't be evaluated (${fresh.status_reason ?? "no reason recorded"})` : fresh.status === "pass" ? "it passes only on sandbox figures, which say nothing about the live product" : "it's still failing";
      await this.store.audit(user.id, "release_covenant_pause_refused", b.id, { covenant_id: c.id, status: fresh.status });
      throw new CovenantError(`The rule hasn't passed: ${why}. Pass override_reason to release it anyway; that's recorded`);
    }
    const override = !passed;
    const reason = override ? input.override_reason! : (input.override_reason ?? "the rule passes");
    const { rows } = await this.db.query(`UPDATE ${T}.covenant_holds SET released_at = $2, released_by = $3, release_reason = $4, override = $5 WHERE id = $1 AND released_at IS NULL RETURNING id`, [hold.id, now, me.id, reason, override]);
    if (!rows.length) throw new CovenantError("Someone else released it first");
    await this.event(b.id, "released", me.id, reason, { override, rule_status: fresh.status }, now);
    await this.store.audit(user.id, "release_covenant_pause", b.id, { covenant_id: c.id, product_id: c.product_id, rule_type: c.rule_type, override, reason, rule_status: fresh.status });
    await checkDrift(this.store, (await this.store.getProduct(c.product_id))!);
    await driftDependents(this.store, c.product_id);
    const after = await this.store.getProduct(c.product_id);
    const others = await this.activeHolds(c.product_id);
    return {
      released: b.id,
      product_id: c.product_id,
      override,
      rule_status: fresh.status,
      sales_paused: Boolean(after?.drift),
      other_covenant_holds: others.map((h) => ({ breach_id: h.breach_id, rule_type: h.rule_type })),
      in_flight: await this.moneyInFlight(c.product_id),
    };
  }
}

// ---- beside the service: the drift check and the sponsorship tools read these, and they need only the store ----

// One drift change for each rule holding this product. No thresholds or figures: these are shown to the product's builder.
export async function covenantChanges(store: Store, productId: string): Promise<DriftChange[]> {
  const { rows } = await store.db.query(
    `SELECT h.covenant_id, h.rule_type FROM ${T}.covenant_holds h JOIN ${T}.sponsorships s ON s.id = h.sponsorship_id WHERE h.product_id = $1 AND h.released_at IS NULL AND s.status = 'approved' ORDER BY h.paused_at, h.id`,
    [productId],
  );
  return (rows as unknown as { covenant_id: string; rule_type: string }[]).map((r) => ({ kind: "covenant" as const, id: r.covenant_id, was: "clear", now: "paused", rule_type: r.rule_type }));
}

// A published product's new version clears its recorded drift. A covenant's pause isn't the version's to clear: only the
// sponsor lifts it, so it's written back straight away.
export async function reassertCovenantPause(store: Store, productId: string) {
  if (!(await covenantChanges(store, productId)).length) return;
  const record = await store.getProduct(productId);
  if (record) await checkDrift(store, record);
}

// The audit log as an admin reads it: that a covenant was set, changed, released or acknowledged, and for what; its
// settings and the sponsor's reasons stay the sponsor's (they remain in the log itself).
const COVENANT_AUDIT = new Set(["set_covenant", "delete_covenant", "release_covenant_pause", "acknowledge_breach"].flatMap((a) => [a, `${a}_refused`]));
const AUDIT_KEPT = ["sponsorship_id", "product_id", "rule_type", "covenant_id", "breach_id", "version", "weakening", "override", "open_breaches", "status"];
export function auditForAdmin<E extends { action: string; details: unknown }>(entry: E): E {
  if (!COVENANT_AUDIT.has(entry.action)) return entry;
  const details = (entry.details ?? {}) as Record<string, unknown>;
  return { ...entry, details: Object.fromEntries(AUDIT_KEPT.filter((k) => k in details).map((k) => [k, details[k]])) };
}

// A drift change as a stranger to the product sees it: that a covenant is why, and nothing about which.
const redactedChange = (c: DriftChange): DriftChange => (c.kind === "covenant" ? { kind: "covenant", id: "redacted", was: c.was, now: c.now } : c);
export const appVisibleChanges = (changes: DriftChange[]): DriftChange[] => changes.map(redactedChange);

// A product's drift for one viewer: the product's own firm and admins see the rule type; anyone else, only that it's a covenant.
export function driftFor(record: ProductRecord, user: User | null | undefined): ProductRecord["drift"] {
  if (!record.drift) return record.drift;
  const insider = !!user && (user.roles.includes("admin") || record.owner_id === user.id || (!!user.entity_id && user.entity_id === record.entity_id));
  return insider ? record.drift : { ...record.drift, changes: appVisibleChanges(record.drift.changes) };
}

// What a sponsorship's builder is shown of a pause: exactly that a covenant holds it, the rule's type, and since when.
export async function builderCovenantPauses(store: Store, sponsorshipId: string) {
  const { rows } = await store.db.query(`SELECT rule_type, paused_at FROM ${T}.covenant_holds WHERE sponsorship_id = $1 AND released_at IS NULL ORDER BY paused_at`, [sponsorshipId]);
  return (rows as unknown as { rule_type: string; paused_at: string }[]).map((r) => ({ rule_type: r.rule_type, paused_at: new Date(r.paused_at).toISOString() }));
}

// Why a revocation can't name this breach, if it can't.
export async function revocationBreachProblem(store: Store, user: User, s: Sponsorship, breachId: string): Promise<string | null> {
  const me = (await store.getUser(user.id)) ?? user;
  if (me.roles.includes("admin") || !me.roles.includes("license_provider") || me.entity_id !== s.provider_entity_id) return "Only the sponsoring firm's own licence-provider members can revoke under a breach";
  const { rows } = await store.db.query(`SELECT sponsorship_id FROM ${T}.covenant_breaches WHERE id = $1`, [breachId]);
  if (!rows[0] || (rows[0] as { sponsorship_id: string }).sponsorship_id !== s.id) return `No breach '${breachId}' on this sponsorship`;
  return null;
}

// A revoked sponsorship's rules end with it: its holds are released (the revocation drifts the product by itself) and
// its open breaches close. The record keeps which breach it was revoked under.
export async function closeCovenantsOnRevocation(store: Store, s: Sponsorship, actorId: string, reason: string, breachId: string | undefined) {
  const db = store.db;
  const now = new Date();
  const addEvent = (id: string, event: string, why: string | null) => db.query(`INSERT INTO ${T}.covenant_breach_events (id, breach_id, event, actor_id, reason, details, at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [randomUUID(), id, event, actorId, why, JSON.stringify({ sponsorship_id: s.id }), now]);
  if (breachId) await addEvent(breachId, "sponsorship_revoked", reason);
  const { rows: holds } = await db.query(`UPDATE ${T}.covenant_holds SET released_at = $2, released_by = $3, release_reason = $4 WHERE sponsorship_id = $1 AND released_at IS NULL RETURNING breach_id`, [s.id, now, actorId, `The sponsorship was revoked: ${reason}`]);
  for (const h of holds as unknown as { breach_id: string }[]) await addEvent(h.breach_id, "released", "The sponsorship was revoked");
  const { rows: covs } = await db.query<{ id: string; open_breach_id: string | null; open_unknown_breach_id: string | null }>(`SELECT id, open_breach_id, open_unknown_breach_id FROM ${T}.covenants WHERE sponsorship_id = $1 AND (open_breach_id IS NOT NULL OR open_unknown_breach_id IS NOT NULL)`, [s.id]);
  for (const c of covs) for (const id of [c.open_breach_id, c.open_unknown_breach_id]) if (id) await addEvent(id, "resolved", "The sponsorship was revoked");
  await db.query(`UPDATE ${T}.covenants SET open_breach_id = NULL, open_unknown_breach_id = NULL WHERE sponsorship_id = $1`, [s.id]);
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const attempt = async (f: () => Promise<unknown>) => {
  try {
    return json(await f());
  } catch (e) {
    return fail((e as Error).message);
  }
};

const RULE_HELP =
  "coverage_below (basis points of reserves over obligations, breached below it), reversal_rate_above and failure_rate_above (basis points), unresolved_above (cents), complaints_above (a count; Mynt doesn't track complaints yet, so it reads unknown), snapshot_missed_for and unverified_for (seconds, at least two snapshot intervals), consecutive_gaps (breached at this many missed periods in a row, at least 1). A figure Mynt can't measure is status unknown with its reason: never a pass, never a breach.";

export function registerCovenantTools(server: McpServer, _store: Store, user: User, covenants: CovenantService) {
  server.registerTool(
    "set_covenant",
    {
      title: "Set a covenant on a sponsored product",
      description: `Licence provider: set a rule on a product your firm sponsors, or change one (pass covenant_id). action: 'alert' tells your firm (covenant.breached on your firm webhooks, list_covenant_breaches, ops_status); 'pause' also pauses new sales through drift, until you release it. Sandbox figures never pause anything. Rule types: ${RULE_HELP} Takes effect from the next evaluation; every change is audited with its old and new values. Loosening a rule with an open breach needs a reason. Mynt's admins can't call this.`,
      inputSchema: {
        sponsorship_id: z.string().uuid(),
        covenant_id: z.string().uuid().optional().describe("To change an existing rule; omit to add a new one"),
        rule_type: z.enum(RULE_TYPES),
        threshold: z.number().int().min(0).describe("In the rule type's own unit: basis points, cents, seconds, or a count"),
        action: z.enum(COVENANT_ACTIONS),
        severity: z.enum(COVENANT_SEVERITIES).optional().describe("Default warning"),
        cooldown_seconds: z.number().int().min(60).max(30 * 24 * 3600).optional().describe("The least time between alerts of this rule. A breach still recording during it is marked; a pause never waits. Default a day"),
        unknown_limit_seconds: z.number().int().min(60).max(30 * 24 * 3600).optional().describe("How long this rule may read unknown before that itself alerts your firm. Default a day"),
        reason: z.string().min(3).max(500).optional().describe("Needed when loosening a rule with an open breach"),
      },
    },
    async (input) => attempt(() => covenants.set(user, input)),
  );

  server.registerTool(
    "list_covenants",
    {
      title: "Your firm's covenants",
      description: "Licence provider: the rules your firm set, each with its current status (pass, fail, unknown with its reason, or unevaluated), since when, and any open breach or pause.",
      inputSchema: { sponsorship_id: z.string().uuid().optional(), product_id: z.string().optional(), include_deleted: z.boolean().default(false) },
      annotations: { readOnlyHint: true },
    },
    async (input) => attempt(() => covenants.list(user, input)),
  );

  server.registerTool(
    "delete_covenant",
    {
      title: "Delete a covenant",
      description: "Licence provider: remove a rule. A rule that's holding the product paused has to be released first; one with an open breach needs a reason, recorded with the breach. Breaches already recorded stay.",
      inputSchema: { covenant_id: z.string().uuid(), reason: z.string().min(3).max(500).optional() },
      annotations: { destructiveHint: true },
    },
    async (input) => attempt(() => covenants.delete(user, input)),
  );

  server.registerTool(
    "list_covenant_breaches",
    {
      title: "Covenant breaches",
      description: "The record of covenant breaches, newest first: the rule, the snapshot sequence and fingerprint, the action taken, sandbox or not, money in flight when a pause took effect, and who acknowledged or released it. Licence provider: your firm's, with the observed figures. Admin: every firm's, without the rule's settings, the reasons, or the observed figure, which is the firm's own books.",
      inputSchema: { product_id: z.string().optional(), sponsorship_id: z.string().uuid().optional(), open_only: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50) },
      annotations: { readOnlyHint: true },
    },
    async (input) => attempt(() => covenants.listBreaches(user, input)),
  );

  server.registerTool(
    "acknowledge_breach",
    {
      title: "Acknowledge a covenant breach",
      description: "Licence provider: record that your firm has seen a breach (who and when). It stops nothing and clears nothing.",
      inputSchema: { breach_id: z.string().uuid(), note: z.string().max(500).optional() },
    },
    async (input) => attempt(() => covenants.acknowledge(user, input)),
  );

  server.registerTool(
    "release_covenant_pause",
    {
      title: "Release a covenant's pause",
      description: "Licence provider: lift the pause a breach put on a product. The rule is re-checked first and has to pass; if it's failing or unknown, pass override_reason to release it anyway, which is audited. The product stays paused for any other reason it's paused. Mynt's admins can't call this.",
      inputSchema: { breach_id: z.string().uuid(), override_reason: z.string().min(10).max(500).optional().describe("Why you're releasing it while the rule hasn't passed") },
    },
    async (input) => attempt(() => covenants.release(user, input)),
  );
}
