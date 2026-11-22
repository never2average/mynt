// A new build's spending cap, picked by the developer: what Mynt says a cap may be (list_builds'
// `budget`), the cap the picker starts at, and why no build can start when too little is left.
// Pure, so the routes, the pickers and the tests share it. Mynt checks the cap again when the
// build starts.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

export type BuildBudget = {
  /** Mynt's usual cap for a build. */
  defaultCapUsd: number;
  /** What's left of the developer's month, and of the app's workspace's (null when it has no budget of its own). */
  monthLeftUsd: number;
  workspaceLeftUsd: number | null;
  /** Below this much left, no build starts. */
  minCapUsd: number;
  /** A session build's cap must be above this (it keeps that much to ship its work). */
  sessionCapAboveUsd: number;
};

/** list_builds' `budget`, or null where this Mynt doesn't report one. */
export function budgetFrom(listBuildsReply: unknown): BuildBudget | null {
  const b = isObj(listBuildsReply) && isObj(listBuildsReply.budget) ? listBuildsReply.budget : null;
  if (!b) return null;
  const defaultCapUsd = num(b.default_cap_usd);
  const monthLeftUsd = num(b.month_left_usd);
  if (defaultCapUsd === null || monthLeftUsd === null) return null;
  return {
    defaultCapUsd,
    monthLeftUsd,
    workspaceLeftUsd: num(b.workspace_left_usd),
    minCapUsd: num(b.min_cap_usd) ?? 0.5,
    sessionCapAboveUsd: num(b.session_cap_above_usd) ?? 0,
  };
}

// Down to the cent (a hair of float error never costs a cent).
const cents = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

export type CapChoice = {
  /** The most a cap may be: the usual cap, or what's left if that's less. */
  maxUsd: number;
  /** The least: a session build's must be above its reserve. */
  minUsd: number;
  /** Where the picker starts. */
  startUsd: number;
  /** Why no build can start now, or null. */
  blocked: string | null;
};

const money = (n: number) => `US$${n.toFixed(2)}`;

export function capChoice(budget: BuildBudget, opts: { session: boolean }): CapChoice {
  const left = cents(Math.min(budget.monthLeftUsd, budget.workspaceLeftUsd ?? Infinity));
  const maxUsd = cents(Math.min(budget.defaultCapUsd, left));
  // A session cap must be above the reserve: the smallest cent over it.
  const minUsd = opts.session ? cents(budget.sessionCapAboveUsd + 0.01) : budget.minCapUsd;
  const whose = budget.workspaceLeftUsd !== null && budget.workspaceLeftUsd < budget.monthLeftUsd ? "the workspace's" : "your";
  let blocked: string | null = null;
  if (left < budget.minCapUsd) blocked = `Only ${money(left)} of ${whose} build budget is left this month, and a build needs at least ${money(budget.minCapUsd)}. It renews at the start of next month.`;
  else if (maxUsd < minUsd)
    blocked = `Only ${money(left)} of ${whose} build budget is left this month, and a build here needs a cap above ${money(budget.sessionCapAboveUsd)} (it keeps that much to ship the work). It renews at the start of next month.`;
  return { maxUsd, minUsd: Math.min(minUsd, maxUsd), startUsd: maxUsd, blocked };
}

/** A cap the developer typed, held to what's allowed; null if it isn't a number. */
export function clampCap(value: unknown, choice: CapChoice): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return cents(Math.max(choice.minUsd, Math.min(choice.maxUsd, n)));
}
