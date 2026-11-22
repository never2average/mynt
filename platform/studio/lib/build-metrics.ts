// A build's cost and time as Mynt measured them (get_build / list_builds: cost_cents, cap_cents,
// durations_seconds, timing, measured_at, not_measured). Pure, for the Builds page, the builder's
// top bar, the dashboard and the tests. A figure Mynt didn't measure is null, shown as "Not
// measured" with Mynt's reason, never as 0.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export const NOT_MEASURED = "Not measured";
// What an older Mynt, which doesn't report a build's cost and time, leaves unmeasured.
export const NOT_REPORTED = "Mynt doesn't report this build's cost and time yet";

export type DurationKey = "queued" | "coding" | "verify" | "total";
export type BuildMetrics = {
  costCents: number | null;
  capCents: number | null;
  seconds: Record<DurationKey, number | null>;
  timing: { queuedAt: string | null; startedAt: string | null; codingStartedAt: string | null; verifyStartedAt: string | null; finishedAt: string | null };
  /** When Mynt measured the durations: a running build's count on from here. */
  measuredAt: string | null;
  /** Why each figure that is null wasn't measured, keyed as Mynt keys it ("cost_cents", "durations_seconds.total"). */
  notMeasured: Record<string, string>;
};

/** The measured figures on one of Mynt's builds; null when this Mynt doesn't report them. */
export function metricsFrom(build: unknown): BuildMetrics | null {
  if (!isObj(build) || !("cost_cents" in build || "durations_seconds" in build)) return null;
  const d = isObj(build.durations_seconds) ? build.durations_seconds : {};
  const t = isObj(build.timing) ? build.timing : {};
  const why = isObj(build.not_measured) ? build.not_measured : {};
  return {
    costCents: num(build.cost_cents),
    capCents: num(build.cap_cents),
    seconds: { queued: num(d.queued), coding: num(d.coding), verify: num(d.verify), total: num(d.total) },
    timing: { queuedAt: str(t.queued_at), startedAt: str(t.started_at), codingStartedAt: str(t.coding_started_at), verifyStartedAt: str(t.verify_started_at), finishedAt: str(t.finished_at) },
    measuredAt: str(build.measured_at),
    notMeasured: Object.fromEntries(Object.entries(why).filter((e): e is [string, string] => typeof e[1] === "string")),
  };
}

const RUNNING = /^(queued|provisioning|coding|auditing|checking|previewing|pushing|verifying)$/;
export const isRunningBuild = (status: string) => RUNNING.test(status);

export function dollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/** "45s", "3m 05s", "1h 02m". */
export function durationText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

export type Shown = { text: string; measured: boolean; reason: string | null };
const unmeasured = (reason: string | undefined): Shown => ({ text: NOT_MEASURED, measured: false, reason: reason ?? NOT_REPORTED });

/** "$3.10 of $20.00"; "Not measured" with the reason when the cost is unknown. */
export function costOfCap(m: BuildMetrics | null | undefined): Shown {
  if (!m || m.costCents === null) return unmeasured(m?.notMeasured.cost_cents);
  return { text: m.capCents === null ? dollars(m.costCents) : `${dollars(m.costCents)} of ${dollars(m.capCents)}`, measured: true, reason: null };
}

// How far past Mynt's measurement `now` is: a running build's figure grows by this much.
const since = (m: BuildMetrics, now: number) => {
  const at = m.measuredAt ? Date.parse(m.measuredAt) : NaN;
  return Number.isNaN(at) ? 0 : Math.max(0, (now - at) / 1000);
};

/** A duration as of `now`: Mynt's figure, counted on while the build (and, for a phase, that phase) runs. */
export function liveSeconds(m: BuildMetrics | null | undefined, key: DurationKey, status: string, now = Date.now()): number | null {
  const s = m?.seconds[key] ?? null;
  if (!m || s === null || !isRunningBuild(status)) return s;
  const ticking =
    key === "total" ||
    (key === "queued" && !m.timing.startedAt) ||
    (key === "coding" && !!m.timing.codingStartedAt && !m.timing.verifyStartedAt) ||
    (key === "verify" && !!m.timing.verifyStartedAt);
  return ticking ? s + since(m, now) : s;
}

/** The build's total time, live while it runs; "Not measured" with the reason when unknown. */
export function totalTime(m: BuildMetrics | null | undefined, status: string, now = Date.now()): Shown {
  const s = liveSeconds(m, "total", status, now);
  return s === null ? unmeasured(m?.notMeasured["durations_seconds.total"]) : { text: durationText(s), measured: true, reason: null };
}

/** How long the build has been in the phase it's in now (or was in last). */
export function phaseElapsed(m: BuildMetrics | null | undefined, status: string, now = Date.now()): number | null {
  const total = liveSeconds(m, "total", status, now);
  if (!m || total === null) return null;
  const { queuedAt, startedAt, codingStartedAt, verifyStartedAt } = m.timing;
  const from = Date.parse(verifyStartedAt ?? codingStartedAt ?? startedAt ?? "");
  const queued = Date.parse(queuedAt ?? "");
  return Number.isNaN(from) || Number.isNaN(queued) ? total : Math.max(0, total - (from - queued) / 1000);
}

/** Averages over the builds whose figure was measured, finished builds only; null when none was. */
export function buildAverages(builds: { status: string; metrics?: BuildMetrics | null }[]): { costCents: number | null; seconds: number | null; costCount: number; timeCount: number } {
  const done = builds.filter((b) => !isRunningBuild(b.status) && b.metrics);
  const costs = done.map((b) => b.metrics!.costCents).filter((c): c is number => c !== null);
  const times = done.map((b) => b.metrics!.seconds.total).filter((s): s is number => s !== null);
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return { costCents: avg(costs), seconds: avg(times), costCount: costs.length, timeCount: times.length };
}
