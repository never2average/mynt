// Mynt's scorer for algorithm explorations: decisions plus the hidden truth in, metrics and constraint checks out.
// Mynt runs it on the holdout, outside any agent sandbox, and that is the only ranking that counts. Explorers get
// the same code as a script (SCORER_SCRIPT) to run on their dev set while they iterate.
//
// `scoreSet` and `scoreWithStability` are self-contained on purpose (no imports, no outside helpers): the script
// is built from their source text, so the explorers' copy can't drift from Mynt's.

export const OBJECTIVES = ["net_margin", "net_margin_pct", "approved_volume", "approval_rate", "interest_revenue"] as const;
export type Objective = (typeof OBJECTIVES)[number];

export interface ScoringSpec {
  objective: { maximise: Objective };
  economics: { default_apr_pct: number; cost_of_funds_pct: number; lgd_pct: number; opex_pct: number; tenor_months: number };
  constraints: {
    max_loss_rate_pct: number; // realised losses as % of the approved amount
    apr_cap_pct: number | null; // null when neither the job, the term sheet nor the definition sets one
    min_adverse_impact_ratio: number; // approval rate of the protected group / the reference group
  };
}

export interface Check {
  name: string;
  status: "pass" | "fail" | "not_set";
  value: number | null;
  threshold: number | null;
  detail: string;
}

export interface SetScore {
  metrics: Record<string, number | null>;
  checks: Check[];
  eligible: boolean;
  objective: { metric: string; value: number | null };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scoreSet(applicants: any[], truth: any[], decisions: any[], spec: ScoringSpec): SetScore {
  const r2 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);
  const byId = new Map();
  for (const d of decisions) if (d && typeof d.id === "string" && !byId.has(d.id)) byId.set(d.id, d);
  const truthById = new Map(truth.map((t) => [t.id, t]));
  const e = spec.economics;
  const years = e.tenor_months / 12;
  let approved = 0;
  let missing = 0;
  let volume = 0;
  let expectedLoss = 0;
  let realisedLoss = 0;
  let interest = 0;
  let maxApr: number | null = null;
  let declinesWithoutReasons = 0;
  let hasPd = true;
  const groups: Record<string, { n: number; approved: number }> = { A: { n: 0, approved: 0 }, B: { n: 0, approved: 0 } };
  for (const a of applicants) {
    const t = truthById.get(a.id);
    const d = byId.get(a.id);
    const group = t && groups[t.protected_group] ? groups[t.protected_group] : null;
    if (group) group.n++;
    if (!d || typeof d.approve !== "boolean") {
      missing++;
      continue;
    }
    if (!d.approve) {
      if (!Array.isArray(d.reason_codes) || d.reason_codes.filter((c: unknown) => typeof c === "string" && c).length === 0) declinesWithoutReasons++;
      continue;
    }
    approved++;
    if (group) group.approved++;
    const limit = typeof d.limit === "number" && d.limit > 0 ? d.limit : a.requested_amount;
    const amount = Math.min(limit, a.requested_amount);
    const apr = typeof d.apr_pct === "number" ? d.apr_pct : e.default_apr_pct;
    maxApr = maxApr === null ? apr : Math.max(maxApr, apr);
    volume += amount;
    if (t && typeof t.pd === "number") expectedLoss += t.pd * (e.lgd_pct / 100) * amount;
    else hasPd = false;
    if (t && t.defaulted) realisedLoss += (e.lgd_pct / 100) * amount;
    else interest += amount * (apr / 100) * years;
  }
  const costs = volume * ((e.cost_of_funds_pct + e.opex_pct) / 100) * years;
  const netMargin = interest - realisedLoss - costs;
  const n = applicants.length;
  const rateA = groups.A.n ? groups.A.approved / groups.A.n : null;
  const rateB = groups.B.n ? groups.B.approved / groups.B.n : null;
  const air = rateA && rateB !== null ? rateB / rateA : null;
  const metrics: Record<string, number | null> = {
    applicants: n,
    approved,
    approval_rate: r2(n ? approved / n : null),
    approved_volume: r2(volume),
    // Expected loss needs the latent default probability, which only Mynt holds: on the dev set it can't be measured.
    expected_loss_rate_pct: hasPd && volume ? r2((100 * expectedLoss) / volume) : null,
    realised_loss_rate_pct: volume ? r2((100 * realisedLoss) / volume) : null,
    interest_revenue: r2(interest),
    net_margin: r2(netMargin),
    net_margin_pct: volume ? r2((100 * netMargin) / volume) : null,
    max_apr_pct: maxApr,
    approval_rate_protected: r2(rateB),
    approval_rate_reference: r2(rateA),
    adverse_impact_ratio: r2(air),
    missing_decisions: missing,
    declines_without_reason_codes: declinesWithoutReasons,
  };
  const c = spec.constraints;
  const lossRate = metrics.realised_loss_rate_pct;
  const checks: Check[] = [
    {
      name: "complete_decisions",
      status: missing === 0 ? "pass" : "fail",
      value: missing,
      threshold: 0,
      detail: missing === 0 ? "A decision for every applicant" : `${missing} applicant(s) without a valid decision`,
    },
    {
      name: "loss_rate",
      status: approved === 0 || (lossRate !== null && lossRate <= c.max_loss_rate_pct) ? "pass" : "fail",
      value: lossRate,
      threshold: c.max_loss_rate_pct,
      detail: `Realised loss rate ${lossRate ?? "n/a"}% against a ceiling of ${c.max_loss_rate_pct}%`,
    },
    c.apr_cap_pct === null
      ? { name: "apr_cap", status: "not_set", value: maxApr, threshold: null, detail: "No APR cap set by the job, the term sheet or the definition" }
      : {
          name: "apr_cap",
          status: maxApr === null || maxApr <= c.apr_cap_pct ? "pass" : "fail",
          value: maxApr,
          threshold: c.apr_cap_pct,
          detail: `Highest APR approved ${maxApr ?? "n/a"}% against a cap of ${c.apr_cap_pct}%`,
        },
    {
      name: "adverse_impact",
      status: air !== null && air >= c.min_adverse_impact_ratio ? "pass" : "fail",
      value: r2(air),
      threshold: c.min_adverse_impact_ratio,
      detail:
        air === null
          ? "Can't be measured: no approvals in the reference group"
          : `Protected group approved at ${r2(air)} times the reference group's rate (at least ${c.min_adverse_impact_ratio} required)`,
    },
    {
      name: "reason_codes",
      status: declinesWithoutReasons === 0 ? "pass" : "fail",
      value: declinesWithoutReasons,
      threshold: 0,
      detail: declinesWithoutReasons === 0 ? "Every decline carries reason codes" : `${declinesWithoutReasons} decline(s) without reason codes`,
    },
  ];
  return {
    metrics,
    checks,
    eligible: checks.every((x) => x.status !== "fail"),
    objective: { metric: spec.objective.maximise, value: metrics[spec.objective.maximise] ?? null },
  };
}

// The whole set, plus the same metrics on three time-like slices (application months 1-4, 5-8, 9-12): an
// algorithm whose objective swings between slices is fragile even when its total looks good.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function scoreWithStability(applicants: any[], truth: any[], decisions: any[], spec: ScoringSpec) {
  const overall = scoreSet(applicants, truth, decisions, spec);
  const slices = [
    [1, 4],
    [5, 8],
    [9, 12],
  ].map(([from, to]) => {
    const part = applicants.filter((a) => a.application_month >= from && a.application_month <= to);
    const s = scoreSet(part, truth, decisions, spec);
    return {
      months: `${from}-${to}`,
      applicants: part.length,
      objective: s.objective.value,
      approval_rate: s.metrics.approval_rate,
      realised_loss_rate_pct: s.metrics.realised_loss_rate_pct,
      eligible: s.eligible,
    };
  });
  const values = slices.map((s) => s.objective).filter((v): v is number => typeof v === "number");
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const spread = values.length === 3 && mean !== 0 ? Math.round(((Math.max(...values) - Math.min(...values)) / Math.abs(mean)) * 10000) / 10000 : null;
  return { ...overall, stability: { slices, objective_spread: spread, eligible_in_every_slice: slices.every((s) => s.eligible) } };
}

// The explorers' copy: `node score.mjs <explore.json> <dir with applicants.jsonl, truth.jsonl, decisions.jsonl>`.
export const SCORER_SCRIPT = `// Mynt's scorer, generated from Mynt's own source (src/explore-score.ts). Use it on the dev set only;
// Mynt ranks variants by scoring the holdout itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";

${scoreSet.toString()}

${scoreWithStability.toString()}

const [specPath, dir] = process.argv.slice(2);
const read = (name) => {
  try {
    return readFileSync(join(dir, name), "utf8").split("\\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch {
    return [];
  }
};
const spec = JSON.parse(readFileSync(specPath, "utf8")).scoring;
console.log(JSON.stringify(scoreWithStability(read("applicants.jsonl"), read("truth.jsonl"), read("decisions.jsonl"), spec), null, 2));
`;
