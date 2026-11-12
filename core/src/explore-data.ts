// Synthetic applicants for algorithm explorations (see explore.ts). Mynt generates them itself, deterministically
// from a seed, so an exploration can be re-scored exactly and nobody's real customers are involved.
//
// Each applicant has the features a decision algorithm may use, and hidden fields only Mynt keeps:
//   - pd: a latent probability of default, from a logistic model of the features (plus noise and a mild drift
//     over the application months, so later months are a little worse: the time-like slices test stability);
//   - defaulted: an outcome sampled from pd;
//   - protected_group: a synthetic protected attribute ("A" reference, "B" protected) used only for fairness
//     metrics. It is not an input to pd, but it is correlated with region and income, as such attributes are
//     in real books, so a policy that cuts hard on income or region can show adverse impact.
// The generator is deliberately simple; `assumptions` says what it assumes and is saved on the job.
//
// The holdout must stay unknowable to the explorers, who see the job id, these parameters and this (public) code.
// So each job has a random 32-byte secret, kept only in Mynt's database, and every split's randomness comes from
// HMAC-SHA256 keyed by it (a counter-mode stream: 256-bit key, nothing to brute-force from the outputs). Within a
// split, features and outcomes come from separately keyed streams, so the features an algorithm sees say nothing
// about the draws behind the protected group, the default-probability noise or who defaulted.

import { createHmac, randomBytes } from "node:crypto";
import type { ProductRecord } from "./store.js";

export const EMPLOYMENT_TYPES = ["salaried", "self_employed", "gig"] as const;
export const REGIONS = ["north", "south", "east", "west"] as const;
export const DATASET_SIZE = 2000; // applicants per split
export const MONTHS = 12; // application months; the holdout is scored on three slices of four

export interface Applicant {
  id: string;
  segment: string;
  employment_type: (typeof EMPLOYMENT_TYPES)[number];
  monthly_income: number;
  bureau_score: number | null; // null: no credit history (thin file)
  existing_obligations: number; // monthly repayments on other debt
  tenure_months: number; // at the current employer or business
  region: (typeof REGIONS)[number];
  requested_amount: number;
  application_month: number; // 1..12
}

export interface Truth {
  id: string;
  pd: number;
  defaulted: boolean;
  protected_group: "A" | "B";
}

export interface GeneratorParams {
  product_line: string;
  segments: string[];
  amount_min: number;
  amount_max: number;
  target_pd_pct: number; // the mean default probability the sample is calibrated to
}

export interface Economics {
  default_apr_pct: number; // used when a decision doesn't set its own apr_pct
  cost_of_funds_pct: number;
  lgd_pct: number;
  opex_pct: number;
  tenor_months: number;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// Generator parameters and loan economics from the product's definition and term sheet, each with where it came
// from. Defaults are stated, never hidden.
export function datasetInputs(p: ProductRecord, inputs: Record<string, unknown> = {}) {
  const def = (p.definition ?? {}) as Record<string, unknown>;
  const assumptions: string[] = [];
  const from = <T>(label: string, value: T | undefined, fallback: T, source: string) => {
    if (value !== undefined) {
      assumptions.push(`${label}: ${value} (${source})`);
      return value;
    }
    assumptions.push(`${label}: ${fallback} (Mynt's default; set it on the term sheet to change it)`);
    return fallback;
  };

  const segments = ((def.customer_segments as { _id?: string }[] | undefined) ?? []).map((s) => s._id).filter((s): s is string => !!s);
  if (segments.length) assumptions.push(`segments: ${segments.join(", ")} (from the definition, equally likely)`);
  else assumptions.push("segments: one 'default' segment (the definition names none)");

  // A money term with a range, preferring one that looks like the amount lent.
  const terms = ((def.terms as { _id: string; type?: string; range?: { min?: number; max?: number } }[] | undefined) ?? []).filter((t) => t.type === "money" && t.range);
  const amountTerm = terms.find((t) => /amount|principal|limit|loan/i.test(t._id)) ?? terms[0];
  const amountMin = from("amount_min", num(amountTerm?.range?.min) ?? num(inputs.min_amount), 10000, amountTerm ? `term ${amountTerm._id}` : "term sheet min_amount");
  const amountMax = from("amount_max", num(amountTerm?.range?.max) ?? num(inputs.max_amount), 500000, amountTerm ? `term ${amountTerm._id}` : "term sheet max_amount");
  const lending = ((def.rates as { kind?: string; value?: unknown }[] | undefined) ?? []).find((r) => r.kind === "lending" && num(r.value) !== undefined);

  const params: GeneratorParams = {
    product_line: p.product.product_line,
    segments: segments.length ? segments : ["default"],
    amount_min: Math.min(amountMin, amountMax),
    amount_max: Math.max(amountMin, amountMax),
    target_pd_pct: from("mean default probability %", num(inputs.expected_pd_pct), 5, "term sheet expected_pd_pct"),
  };
  const economics: Economics = {
    default_apr_pct: from("apr % when a decision sets none", num(inputs.apr_pct) ?? num(lending?.value), 18, num(inputs.apr_pct) !== undefined ? "term sheet apr_pct" : "definition lending rate"),
    cost_of_funds_pct: from("cost of funds %", num(inputs.cost_of_funds_pct), 9, "term sheet cost_of_funds_pct"),
    lgd_pct: from("loss given default %", num(inputs.lgd_pct), 65, "term sheet lgd_pct"),
    opex_pct: from("operating cost % a year", num(inputs.opex_pct), 3, "term sheet opex_pct"),
    tenor_months: from("tenor (months)", num(inputs.tenor_months), 12, "term sheet tenor_months"),
  };
  assumptions.push(
    `${DATASET_SIZE} applicants per split over ${MONTHS} application months; income is log-normal (median about a quarter of the mid requested amount, lower for gig and self-employed work); bureau scores 300-900, 8% with no history`,
    "default probability: logistic in bureau score, debt-to-income, tenure, employment type and amount-to-income, plus noise and a drift that makes later months slightly worse; calibrated to the mean above",
    "protected_group is synthetic: about 25% 'B', more likely in the east region and with lower income; it never drives default directly and is never given to the algorithm",
    "economics: non-defaulters pay the full APR over the tenor, defaulters pay no interest and lose LGD of the amount; funding and operating costs accrue on every approved amount",
  );
  if (p.product.product_line !== "credit") assumptions.push(`applicants are modelled as credit applicants, although the product line is ${p.product.product_line}`);
  return { params, economics, assumptions };
}

// A deterministic stream of uniforms in [0, 1) from HMAC-SHA256(key, counter): 4 draws of 53 bits per block.
function stream(key: Buffer) {
  let counter = 0;
  let block: Buffer = Buffer.alloc(0);
  let at = 32;
  return () => {
    if (at >= 32) {
      const c = Buffer.alloc(8);
      c.writeBigUInt64BE(BigInt(counter++));
      block = createHmac("sha256", key).update(c).digest();
      at = 0;
    }
    const v = block.readBigUInt64BE(at) >> 11n;
    at += 8;
    return Number(v) / 2 ** 53;
  };
}

const subkey = (key: Buffer | string, label: string) => createHmac("sha256", key).update(label).digest();

// A new exploration's secret. Stored with the job, never shown to anyone or written into a sandbox.
export const newDatasetSecret = () => randomBytes(32).toString("hex");

// The two splits' keys: the dev set explorers get (with outcomes) and the holdout only Mynt sees.
export function splitKeys(secretHex: string) {
  const secret = Buffer.from(secretHex, "hex");
  if (secret.length < 32) throw new Error("A dataset secret is 32 random bytes");
  return { dev: subkey(secret, "dev").toString("hex"), holdout: subkey(secret, "holdout").toString("hex") };
}

const round = (x: number, step: number) => Math.round(x / step) * step;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export function generateDataset(params: GeneratorParams, keyHex: string, prefix: string, n = DATASET_SIZE) {
  const key = Buffer.from(keyHex, "hex");
  const r = stream(subkey(key, "features"));
  const o = stream(subkey(key, "outcomes")); // protected group, default-probability noise, defaults
  const gaussian = (u: () => number) => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
  const normal = () => gaussian(r);
  const pick = <T>(xs: readonly T[], weights: number[]) => {
    let x = r() * weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < xs.length; i++) if ((x -= weights[i]) < 0) return xs[i];
    return xs[xs.length - 1];
  };
  const mid = (params.amount_min + params.amount_max) / 2;
  const rows: { a: Applicant; group: "A" | "B"; logit: number }[] = [];
  for (let i = 0; i < n; i++) {
    const region = pick(REGIONS, [0.3, 0.25, 0.2, 0.25]);
    const group: "A" | "B" = o() < (region === "east" ? 0.45 : 0.2) ? "B" : "A";
    const employment = pick(EMPLOYMENT_TYPES, [0.6, 0.3, 0.1]);
    const incomeMedian = (mid / 4) * (employment === "salaried" ? 1 : employment === "self_employed" ? 0.9 : 0.6) * (group === "B" ? 0.85 : 1);
    const income = round(incomeMedian * Math.exp(0.5 * normal()), 100);
    const thin = r() < 0.08;
    const score = thin ? null : Math.round(clamp(700 + 70 * normal(), 300, 900));
    const obligations = round(income * Math.min(0.8, Math.exp(-1.8 + 0.7 * normal())), 100);
    const tenure = Math.round(-48 * Math.log(Math.max(r(), 1e-9)));
    const amount = round(clamp(mid * Math.exp(0.6 * normal()), params.amount_min, params.amount_max), 1000);
    const month = 1 + Math.floor(r() * MONTHS);
    const dti = obligations / Math.max(income, 1);
    const logit =
      (score === null ? 0.6 : -0.012 * (score - 700)) +
      1.8 * (dti - 0.2) -
      0.006 * Math.min(tenure, 120) +
      (employment === "gig" ? 0.5 : employment === "self_employed" ? 0.25 : 0) +
      0.35 * Math.log(amount / Math.max(income, 1) / 4) +
      0.04 * (month - MONTHS / 2) +
      0.3 * gaussian(o);
    rows.push({
      a: {
        id: `${prefix}-${String(i + 1).padStart(6, "0")}`,
        segment: params.segments[Math.floor(r() * params.segments.length)],
        employment_type: employment,
        monthly_income: income,
        bureau_score: score,
        existing_obligations: obligations,
        tenure_months: tenure,
        region,
        requested_amount: amount,
        application_month: month,
      },
      group,
      logit,
    });
  }
  // Calibrate the intercept so the mean default probability matches the target (bisection: deterministic).
  const target = clamp(params.target_pd_pct / 100, 0.001, 0.5);
  let lo = -15;
  let hi = 15;
  for (let k = 0; k < 60; k++) {
    const c = (lo + hi) / 2;
    const mean = rows.reduce((s, x) => s + sigmoid(c + x.logit), 0) / rows.length;
    if (mean < target) lo = c;
    else hi = c;
  }
  const c = (lo + hi) / 2;
  const applicants: Applicant[] = [];
  const truth: Truth[] = [];
  for (const x of rows) {
    const pd = sigmoid(c + x.logit);
    applicants.push(x.a);
    truth.push({ id: x.a.id, pd: Math.round(pd * 1e6) / 1e6, defaulted: o() < pd, protected_group: x.group });
  }
  return { applicants, truth };
}

export const jsonl = (rows: unknown[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
