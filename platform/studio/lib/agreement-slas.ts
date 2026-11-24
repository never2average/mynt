// A service level agreement's measurable commitments and their breaches, as the Licences page's SLA tab shows them
// (Mynt's list_agreement_slas): each commitment a metric with its target, measurement window and source, and the
// remedy when it's missed; each breach a period, what was measured, who recorded it and whether it's resolved.
// Commitments are in force once their SLA agreement is signed. Pure, for the route, the view and the tests.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

export const SLA_WINDOWS = ["daily", "weekly", "monthly", "quarterly"] as const;
export const WINDOW_LABELS: Record<string, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly" };
export const SIDE_LABELS: Record<string, string> = { app: "The app's side", counterparty: "The licence provider" };

export type SlaAction = "record_breach" | "retire";
export type BreachRow = {
  id: string;
  slaId: string;
  periodStart: string | null;
  periodEnd: string | null;
  measured: string;
  recordedSide: string | null;
  recordedBy: string | null;
  note: string | null;
  createdAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  open: boolean;
  canResolve: boolean;
};
export type SlaRow = {
  id: string;
  agreementId: string;
  metric: string;
  target: string; // with its unit
  window: string;
  source: string;
  remedy: string | null;
  status: string; // active | retired
  appName: string;
  counterparty: string;
  openBreaches: number;
  breaches: BreachRow[];
  actions: SlaAction[];
};
export type SlaList = { slas: SlaRow[]; canAdd: string[] }; // canAdd: the SLA agreements the caller may add commitments to

const breachOf = (b: Obj, slaId: string): BreachRow | null => {
  const id = str(b.id);
  if (!id) return null;
  const by = isObj(b.recorded_by) ? str(b.recorded_by.name) : str(b.recorded_by);
  const resolvedAt = str(b.resolved_at);
  return {
    id,
    slaId: str(b.sla_id) ?? slaId,
    periodStart: str(b.period_start),
    periodEnd: str(b.period_end),
    measured: str(b.measured_value) ?? (num(b.measured_value) !== null ? String(num(b.measured_value)) : "—"),
    recordedSide: str(b.recorded_side),
    recordedBy: by,
    note: str(b.note),
    createdAt: str(b.created_at),
    resolvedAt,
    resolutionNote: str(b.resolution_note),
    open: typeof b.open === "boolean" ? b.open : !resolvedAt,
    canResolve: arr(b.actions).includes("resolve"),
  };
};

export function fromSlaList(reply: unknown): SlaList | null {
  if (!isObj(reply) || !Array.isArray(reply.slas)) return null;
  const slas = arr(reply.slas)
    .filter(isObj)
    .flatMap((s): SlaRow[] => {
      const id = str(s.id);
      const agreementId = str(s.agreement_id);
      if (!id || !agreementId) return [];
      const target = str(s.target) ?? (num(s.target_value) !== null ? String(num(s.target_value)) : "—");
      const unit = str(s.unit);
      const breaches = arr(s.breaches)
        .filter(isObj)
        .flatMap((b) => breachOf(b, id) ?? []);
      return [
        {
          id,
          agreementId,
          metric: str(s.metric) ?? "Unnamed commitment",
          target: unit ? `${target} ${unit}` : target,
          window: WINDOW_LABELS[str(s.measurement_window) ?? ""] ?? str(s.measurement_window) ?? "—",
          source: str(s.measurement_source) ?? "—",
          remedy: str(s.remedy),
          status: str(s.status) ?? "active",
          appName: (isObj(s["app"]) ? str(s["app"].name) : null) ?? "Whole workspace",
          counterparty: (isObj(s.counterparty) ? str(s.counterparty.name) : null) ?? "Unnamed firm",
          openBreaches: typeof s.open_breaches === "number" ? s.open_breaches : breaches.filter((b) => b.open).length,
          breaches,
          actions: arr(s.actions).filter((a): a is SlaAction => a === "record_breach" || a === "retire"),
        },
      ];
    });
  const canAdd = arr(reply.agreements)
    .filter(isObj)
    .filter((a) => a.can_add_slas === true)
    .map((a) => str(a.id))
    .filter((x): x is string => Boolean(x));
  return { slas, canAdd };
}

/** A commitment's status in words: retired, else in force, with its open breaches. */
export const slaStatusText = (s: Pick<SlaRow, "status" | "openBreaches">) =>
  s.status === "retired" ? "Retired" : s.openBreaches ? `${s.openBreaches} open breach${s.openBreaches === 1 ? "" : "es"}` : "No open breaches"
