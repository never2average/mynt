import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction, type Db } from "./db.js";
import type { App, Store, User } from "./store.js";
import { coveredStates, US_STATE_NAMES } from "./workspace-compliance.js";
import { lockAppStage } from "./promotion-schema.js";
import { appRole, frozenReason, isUuid, memberApp, type AppStage } from "./workspaces.js";

// Promoting an app between the studio's folders: idea → staging → production, one step at a time, and back down.
//
// Every check is computed here by Mynt from its own records (the builds Mynt verified in its clean sandbox and the
// independent audit it ran, its hosting's state, the licences and sponsorships behind each product, the app's keys
// and webhooks, the mainnet program gate, admins' sign-offs), never from anything an app or an agent reports. What
// Mynt can't measure is "pending", never "pass", and blocks a promotion like a failure; "warn" blocks too, except where it is advisory (every staging warning; in production, ADVISORY_PRODUCTION_CHECKS).
//
// Who may do what: every member of the app's workspace sees the checks (get_promotion_checks); only its owners and
// admins promote, demote, set the states the app serves, or ask for an admin's sign-off. Members ask them, and see
// the same checks they do. Promotion re-runs every check inside one transaction holding the app's lock, so a check
// that started failing after someone looked is caught then, and the snapshot it passed with is in the audit trail.
//
// Sign-off: a production promotion needs a Mynt admin's sign-off when the app moves value: it has Solana programs
// (beyond devnet, or its verified build carries programs) or a product it uses is covered by a firm with an approved
// money rail. A sign-off is for one verified build (its id and source hash): a newer verified build needs a new one.
// The admin who decides is never the one who asked, nor anyone in the app's workspace. The sign-off is also bound to what made it
// necessary (its basis: programs, rails): if that changes without a new build, it no longer counts. Production promotes
// what runs: the hosted build must be the verified build the checks and sign-off are about.
//
// The stage is stored, and changes only by promotion and demotion: a new app starts as an idea, however far its builds
// and hosting get. Apps from before promotions kept the stage Mynt derived for them then (seedAppStages).

const T = "financial_products";

export type CheckStatus = "pass" | "fail" | "warn" | "pending";
export interface PromotionCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  fix?: { label: string; href?: string; tool?: string };
}
export type SignoffStatus = "none" | "requested" | "approved" | "rejected";
export interface PromotionChecks {
  app_id: string;
  from_stage: AppStage;
  to_stage: "staging" | "production";
  checks: PromotionCheck[];
  can_promote: boolean;
  needs_admin_signoff: boolean;
  signoff?: { status: SignoffStatus; by?: string; at?: string };
}

type Q = Pick<Db, "query">;
type Row = Record<string, unknown>;
const ORDER: AppStage[] = ["idea", "staging", "production"];
const iso = (v: unknown) => (v == null ? undefined : new Date(v as string).toISOString());
const short = (id: unknown) => String(id ?? "").slice(0, 8);
const rowsOf = async (q: Q, sql: string, params: unknown[] = []) => (await q.query(sql, params)).rows as Row[];
const one = async (q: Q, sql: string, params: unknown[] = []) => (await rowsOf(q, sql, params))[0];

// Which optional services' tables this Mynt has (builds, hosting, Solana): checked first, never by catching an error,
// so a check can run inside a transaction.
async function tables(q: Q, names: string[]): Promise<Set<string>> {
  const r = await rowsOf(q, `SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass('${T}.' || n) IS NOT NULL`, [names]);
  return new Set(r.map((x) => x.n as string));
}

// ---- the stage ----

// The stage the studio shows: what the app was last promoted or demoted to (apps from before promotions were given
// the stage Mynt derived for them then: seedAppStages); a new app starts as an idea.
export async function effectiveStages(db: Db, apps: Pick<App, "id">[]): Promise<Map<string, AppStage>> {
  const out = new Map<string, AppStage>(apps.map((a) => [a.id, "idea"]));
  if (!apps.length) return out;
  const set = await rowsOf(db, `SELECT app_id::text AS app_id, stage FROM ${T}.app_promotions WHERE app_id::text = ANY($1)`, [apps.map((a) => a.id)]);
  for (const r of set) out.set(r.app_id as string, r.stage as AppStage);
  return out;
}

async function stageOf(q: Q, app: Pick<App, "id">): Promise<AppStage> {
  const r = await one(q, `SELECT stage FROM ${T}.app_promotions WHERE app_id = $1`, [app.id]);
  return (r?.stage as AppStage | undefined) ?? "idea";
}

// ---- what the checks read ----

interface State {
  have: Set<string>;
  verified: Row | undefined; // the latest build Mynt verified (succeeded)
  newestFinished: Row | undefined; // the latest build that ended, whatever its result
  running: Row | undefined; // a build still going
  hosted: Row | undefined; // its deployment on Mynt's hosting, with the VM's status
  promotion: Row | undefined;
}

async function readState(q: Q, appId: string): Promise<State> {
  const have = await tables(q, ["build_runs", "hosted_apps", "hosting_tenants", "solana_programs", "solana_program_flags", "solana_mainnet_reviews"]);
  const builds = have.has("build_runs");
  const verified = builds
    ? await one(q, `SELECT * FROM ${T}.build_runs WHERE app_id = $1 AND status = 'succeeded' ORDER BY COALESCE(finished_at, updated_at) DESC, created_at DESC LIMIT 1`, [appId])
    : undefined;
  const newestFinished = builds
    ? await one(
        q,
        `SELECT * FROM ${T}.build_runs WHERE app_id = $1 AND status IN ('succeeded', 'blocked', 'failed', 'stopped', 'over_budget') ORDER BY COALESCE(finished_at, updated_at) DESC, created_at DESC LIMIT 1`,
        [appId],
      )
    : undefined;
  const running = builds
    ? await one(q, `SELECT * FROM ${T}.build_runs WHERE app_id = $1 AND status NOT IN ('succeeded', 'blocked', 'failed', 'stopped', 'over_budget') ORDER BY created_at DESC LIMIT 1`, [appId])
    : undefined;
  const hosted =
    have.has("hosted_apps") && have.has("hosting_tenants")
      ? await one(q, `SELECT h.*, t.status AS tenant_status FROM ${T}.hosted_apps h LEFT JOIN ${T}.hosting_tenants t ON t.id = h.tenant_id WHERE h.app_id = $1`, [appId])
      : undefined;
  const promotion = await one(q, `SELECT * FROM ${T}.app_promotions WHERE app_id = $1`, [appId]);
  return { have, verified, newestFinished, running, hosted, promotion };
}

const counts = (b: Row | undefined) => ((b?.maxwell as { counts?: Record<string, number> } | null)?.counts ?? {}) as Record<string, number>;
const serious = (b: Row | undefined) => (counts(b).critical ?? 0) + (counts(b).high ?? 0);

// ---- staging: the build Mynt verified, its audit, and that it runs ----

function buildCheck(appId: string, s: State): PromotionCheck {
  const base = { id: "build_verified", label: "Latest build verified by Mynt" };
  const fix = { label: "Start a build", href: `/${appId}`, tool: "start_build" };
  if (!s.have.has("build_runs")) return { ...base, status: "pending", detail: "This Mynt doesn't run builds, so no build can be verified" };
  if (!s.verified)
    return s.running
      ? { ...base, status: "pending", detail: `Build ${short(s.running.id)} is ${s.running.status}; nothing has passed Mynt's verification yet` }
      : { ...base, status: "fail", detail: "No build has passed Mynt's verification in a clean sandbox yet", fix };
  const detail = `Build ${short(s.verified.id)} passed Mynt's verification in a clean sandbox on ${iso(s.verified.finished_at ?? s.verified.updated_at)!.slice(0, 10)}${s.verified.source_sha256 ? ` (source sha256 ${String(s.verified.source_sha256).slice(0, 12)})` : ""}`;
  if (s.newestFinished && s.newestFinished.id !== s.verified.id)
    return { ...base, status: "warn", detail: `${detail}; a newer build, ${short(s.newestFinished.id)}, ended ${s.newestFinished.status}${s.newestFinished.error ? `: ${String(s.newestFinished.error).slice(0, 200)}` : ""}`, fix: { label: "Open the build", href: `/${appId}` } };
  return { ...base, status: "pass", detail };
}

// `production`: a build with no independent audit only warns; `strict` (the app needs a sign-off: it moves value): fails.
const NO_AUDIT = "No independent audit ran on this build: Mynt shipped it on its own checks (tests, types, secrets, static scan, dependencies, disclosures)";
function auditCheck(s: State, o: { production: boolean; strict: boolean }): PromotionCheck {
  const base = { id: "audit_passed", label: "Independent audit passed" };
  if (!s.verified) return { ...base, status: "pending", detail: "Waits for a build Mynt verified" };
  if (!s.verified.maxwell) {
    if (o.strict) return { ...base, status: "fail", detail: `${NO_AUDIT}; an app that moves value needs one`, fix: { label: "Build again with the independent audit on", href: `/${s.verified.app_id}` } };
    return o.production ? { ...base, status: "warn", detail: NO_AUDIT } : { ...base, status: "pass", detail: `Not required for this build. ${NO_AUDIT}` };
  }
  const c = counts(s.verified);
  if (serious(s.verified) > 0) return { ...base, status: "fail", detail: `${serious(s.verified)} critical or high finding(s) in the independent audit` };
  return { ...base, status: "pass", detail: `Mynt's independent audit found no critical or high issues (medium ${c.medium ?? 0}, low ${c.low ?? 0})` };
}

function hostingCheck(appId: string, s: State, required: boolean): PromotionCheck {
  const base = required ? { id: "hosting_healthy", label: "Healthy on Mynt's hosting" } : { id: "app_runs", label: "App builds and runs" };
  const deploy = { label: "Deploy the app", href: `/${appId}`, tool: "deploy_app" };
  const h = s.hosted;
  if (!h) {
    if (required) return { ...base, status: "fail", detail: "Not deployed on Mynt's hosting; production apps run there", fix: deploy };
    if (!s.verified) return { ...base, status: "pending", detail: "Waits for a build Mynt verified" };
    return { ...base, status: "warn", detail: "Not deployed on Mynt's hosting yet; the verified build ran its tests in Mynt's clean sandbox", fix: deploy };
  }
  if (h.tenant_status && h.tenant_status !== "running") return { ...base, status: "fail", detail: `The workspace's hosting is ${h.tenant_status}`, fix: { label: "Hosting status", href: `/${appId}`, tool: "hosting_status" } };
  if (h.status === "deploying") return { ...base, status: "pending", detail: `Build ${short(h.build_id)} is still deploying` };
  if (h.status !== "running") return { ...base, status: "fail", detail: `Its deployment is ${h.status}${h.error ? `: ${String(h.error).slice(0, 300)}` : ""}`, fix: deploy };
  const ran = `Running on Mynt's hosting (commit ${String(h.commit_sha).slice(0, 12)}, as its VM last reported)`;
  // Production promotes what runs: the hosted build must be the verified build every other check (and the sign-off)
  // is about.
  if (s.verified && h.build_id !== s.verified.id)
    return { ...base, status: required ? "fail" : "warn", detail: `${ran}, from build ${short(h.build_id)}, not the latest verified build ${short(s.verified.id)}`, fix: { label: "Deploy the latest build", href: `/${appId}`, tool: "deploy_app" } };
  return { ...base, status: "pass", detail: ran };
}

// ---- production: licences, keys, webhooks, findings, the program gate, sign-off ----

const stateName = (code: string) => US_STATE_NAMES[code] ?? code;

async function licenceCheck(store: Store, app: App, s: State): Promise<{ check: PromotionCheck; moneyFirms: string[] }> {
  const base = { id: "licences", label: "Every product licensed where the app serves" };
  const fix = { label: "See licences", href: "/licences" };
  const targets = ((s.promotion?.target_states as string[] | undefined) ?? []).map((x) => x.toLowerCase());
  const setStates = { label: "Set the states this app serves", href: `/${app.id}`, tool: "set_app_target_states" };
  if (!targets.length) {
    // Still read the coverage: whose firms cover its products decides whether it moves money (sign-off).
    const firms = new Set<string>();
    for (const id of app.product_ids) {
      const record = await store.getProduct(id);
      if (record?.status === "published") for (const covers of (await coveredStates(store, record)).values()) for (const c of covers) firms.add(c.entity_id);
    }
    return { check: { ...base, status: "fail", detail: "Set the states this app serves: production checks every product is licensed in each", fix: setStates }, moneyFirms: [...firms] };
  }
  if (!app.product_ids.length) return { check: { ...base, status: "pass", detail: `The app uses no regulated products (it serves ${targets.length} state(s))` }, moneyFirms: [] };
  const problems: string[] = [];
  const covered: string[] = [];
  const firms = new Set<string>();
  for (const id of app.product_ids) {
    const record = await store.getProduct(id);
    if (!record) {
      problems.push(`${id} doesn't exist`);
      continue;
    }
    if (record.status !== "published") {
      problems.push(`${record.product.name} isn't published`);
      continue;
    }
    if (record.drift) {
      problems.push(`${record.product.name}'s sales are paused`);
      continue;
    }
    const states = await coveredStates(store, record);
    for (const covers of states.values()) for (const c of covers) firms.add(c.entity_id);
    const action = record.action;
    if (!states.size) {
      problems.push(`${record.product.name} (${action}) has no licence in force covering it in any US state`);
      continue;
    }
    const missing = targets.filter((t) => !states.has(t));
    if (missing.length) problems.push(`${record.product.name} (${action}) isn't covered in ${missing.map(stateName).join(", ")}`);
    else covered.push(`${record.product.name} (${action}) in ${targets.length ? targets.length : states.size} state(s)`);
  }
  const moneyFirms = [...firms];
  if (problems.length) return { check: { ...base, status: "fail", detail: problems.join("; "), fix }, moneyFirms };
  return { check: { ...base, status: "pass", detail: `Covered by a licence in force for every target state: ${covered.join("; ")}` }, moneyFirms };
}

// No live-key check: live keys come after promotion (production gates real money), so an app can't hold one before.

async function webhookCheck(q: Q, app: App): Promise<PromotionCheck> {
  const base = { id: "webhooks", label: "Webhooks verified" };
  const hooks = await rowsOf(
    q,
    `SELECT w.id::text AS id, w.url, w.disabled_at,
       EXISTS (SELECT 1 FROM ${T}.workspace_members m WHERE m.workspace_id = $2 AND m.user_id = w.last_secret_issued_to) AS secret_held,
       (SELECT d.status FROM ${T}.webhook_deliveries d WHERE d.webhook_id = w.id ORDER BY d.created_at DESC LIMIT 1) AS last_status,
       EXISTS (SELECT 1 FROM ${T}.webhook_deliveries d WHERE d.webhook_id = w.id AND d.status = 'delivered') AS ever_delivered
     FROM ${T}.webhooks w WHERE w.app_id = $1 ORDER BY w.created_at`,
    [app.id, app.workspace_id],
  );
  if (!hooks.length) return { ...base, status: "pass", detail: "The app has no webhooks" };
  const fails: string[] = [];
  const pending: string[] = [];
  for (const h of hooks) {
    const name = `${short(h.id)} (${h.url})`;
    if (h.disabled_at) fails.push(`${name} is turned off`);
    else if (!h.secret_held) fails.push(`${name}: no current member holds its signing secret, so its receiver can't check deliveries`);
    else if (h.last_status === "failed") fails.push(`${name}: its last delivery failed`);
    else if (!h.ever_delivered) pending.push(`${name}: no delivery has reached it yet`);
  }
  if (fails.length) return { ...base, status: "fail", detail: fails.join("; "), fix: { label: "Fix webhooks", href: `/${app.id}`, tool: fails.some((f) => f.includes("turned off")) ? "enable_webhook" : "rotate_webhook_secret" } };
  if (pending.length) return { ...base, status: "pending", detail: `${pending.join("; ")}. A sandbox hand-off sends one`, fix: { label: "Send a test event", href: `/${app.id}`, tool: "simulate_handoff" } };
  return { ...base, status: "pass", detail: `${hooks.length} webhook(s) on, each receiving deliveries signed with a secret a member holds` };
}

function findingsCheck(appId: string, s: State, strict: boolean): PromotionCheck {
  const base = { id: "audit_findings", label: "No open blocking audit findings" };
  if (!s.verified) return { ...base, status: "pending", detail: "Waits for a build Mynt verified" };
  const latest = s.newestFinished;
  if (latest && latest.id !== s.verified.id) {
    if (serious(latest) > 0) return { ...base, status: "fail", detail: `The newest build, ${short(latest.id)}, has ${serious(latest)} critical or high audit finding(s)`, fix: { label: "Open the build", href: `/${appId}` } };
    if (latest.status === "blocked" && /security gate/i.test(String(latest.error ?? ""))) return { ...base, status: "fail", detail: `The newest build, ${short(latest.id)}, was blocked: ${latest.error}`, fix: { label: "Open the build", href: `/${appId}` } };
  }
  if (serious(s.verified) > 0) return { ...base, status: "fail", detail: `${serious(s.verified)} critical or high finding(s)` };
  if (!s.verified.maxwell)
    // Nothing audited it, so there are no findings to read: not a pass.
    return strict
      ? { ...base, status: "fail", detail: "No independent audit ran on this build, so its findings are unknown; an app that moves value needs one", fix: { label: "Build again with the independent audit on", href: `/${appId}` } }
      : { ...base, status: "warn", detail: "No independent audit ran on this build, so there are no findings to read" };
  return { ...base, status: "pass", detail: "None in the latest audited build" };
}

async function programsOf(q: Q, appId: string, s: State) {
  if (!s.have.has("solana_programs")) return [];
  return rowsOf(
    q,
    `SELECT p.id::text AS id, p.name, p.cluster, p.program_id, p.status, p.verifiable_hash,
       ${s.have.has("solana_program_flags") ? `(SELECT count(*)::int FROM ${T}.solana_program_flags f WHERE f.program = p.id AND f.status = 'open')` : "0"} AS open_flags,
       ${s.have.has("solana_mainnet_reviews") ? `(SELECT r.status FROM ${T}.solana_mainnet_reviews r WHERE r.program = p.id ORDER BY r.created_at DESC LIMIT 1)` : "NULL"} AS review_status
     FROM ${T}.solana_programs p WHERE p.app_id = $1 ORDER BY p.created_at`,
    [appId],
  );
}

function programCheck(appId: string, s: State, programs: Row[]): PromotionCheck {
  const base = { id: "program_gate", label: "Mainnet program gate" };
  const fix = { label: "Request a mainnet review", href: `/${appId}`, tool: "request_mainnet_review" };
  const solanaBuild = !!s.verified?.solana;
  if (!programs.length && !solanaBuild) return { ...base, status: "pass", detail: "Not applicable: the app has no Solana programs" };
  const mainnet = programs.filter((p) => p.cluster !== "devnet");
  if (!mainnet.length) return { ...base, status: "fail", detail: programs.length ? `Its programs (${programs.map((p) => p.name).join(", ")}) are on devnet only; production needs them on mainnet through the program gate` : "Its verified build carries Solana programs, none of them on mainnet yet", fix };
  const fails: string[] = [];
  const pending: string[] = [];
  for (const p of mainnet) {
    if (Number(p.open_flags) > 0) fails.push(`${p.name} has ${p.open_flags} open vulnerability flag(s)`);
    else if (p.status !== "deployed") {
      if (["running", "awaiting_approval", "approved", "started"].includes(String(p.review_status))) pending.push(`${p.name}'s mainnet review is ${p.review_status}`);
      else fails.push(`${p.name} isn't deployed on mainnet (${p.status}${p.review_status ? `, review ${p.review_status}` : ""})`);
    }
  }
  if (fails.length) return { ...base, status: "fail", detail: fails.join("; "), fix };
  if (pending.length) return { ...base, status: "pending", detail: pending.join("; ") };
  return { ...base, status: "pass", detail: `${mainnet.length} mainnet program(s) passed the gate, with no open flags` };
}

// The sign-off for this build: none until one was asked for this very build and source (an older build's doesn't
// count).
async function signoffFor(q: Q, appId: string, build: Row | undefined): Promise<Row | undefined> {
  if (!build) return undefined;
  return one(
    q,
    `SELECT * FROM ${T}.promotion_signoffs WHERE app_id = $1 AND build_id = $2 AND source_sha256 IS NOT DISTINCT FROM $3 AND status <> 'superseded' ORDER BY requested_at DESC LIMIT 1`,
    [appId, build.id, build.source_sha256 ?? null],
  );
}

// What made a sign-off necessary, exactly: the app's programs beyond devnet, whether its build carries programs, and
// the approved money rails of the firms covering its products. An approval holds only while this stays the same.
export interface SignoffBasis {
  programs: string[];
  solana_build: boolean;
  rails: string[];
}
const sameBasis = (a: unknown, b: SignoffBasis) => {
  const x = a as Partial<SignoffBasis> | null;
  return !!x && JSON.stringify([...(x.programs ?? [])].sort()) === JSON.stringify(b.programs) && !!x.solana_build === b.solana_build && JSON.stringify([...(x.rails ?? [])].sort()) === JSON.stringify(b.rails);
};
// An approval whose basis changed without a new build counts as none.
const stale = (row: Row | undefined, basis: SignoffBasis) => row?.status === "approved" && !sameBasis(row.basis, basis);

function signoffView(row: Row | undefined, basis: SignoffBasis): NonNullable<PromotionChecks["signoff"]> {
  if (!row || stale(row, basis)) return { status: "none" };
  const status = row.status as SignoffStatus;
  return status === "requested"
    ? { status, by: row.requested_by as string, at: iso(row.requested_at) }
    : { status, by: (row.decided_by as string | null) ?? undefined, at: iso(row.decided_at) };
}

async function signoffCheck(q: Q, appId: string, s: State, row: Row | undefined, reasons: string[], basis: SignoffBasis): Promise<PromotionCheck> {
  const base = { id: "admin_signoff", label: "Mynt admin sign-off" };
  const ask = { label: "Ask for sign-off", href: `/${appId}`, tool: "request_promotion_signoff" };
  const why = `Needed because ${reasons.join(" and ")}`;
  if (!s.verified) return { ...base, status: "pending", detail: `${why}; waits for a build Mynt verified` };
  if (stale(row, basis)) return { ...base, status: "fail", detail: `${why}; what needed it (its programs or money rails) changed since it was approved, so it needs a new one`, fix: ask };
  if (!row) {
    const older = await one(q, `SELECT build_id FROM ${T}.promotion_signoffs WHERE app_id = $1 AND status = 'approved' ORDER BY decided_at DESC LIMIT 1`, [appId]);
    const was = older ? `; the last one was for build ${short(older.build_id)}, and a new build needs its own` : "";
    return { ...base, status: "fail", detail: `${why}${was}`, fix: ask };
  }
  if (row.status === "requested") return { ...base, status: "pending", detail: `${why}; asked for build ${short(s.verified.id)}, waiting for a Mynt admin` };
  if (row.status === "rejected") return { ...base, status: "fail", detail: `A Mynt admin rejected it${row.note ? `: ${row.note}` : ""}`, fix: ask };
  return { ...base, status: "pass", detail: `Approved for build ${short(s.verified.id)}${row.note ? `: ${row.note}` : ""}` };
}

// Why a production promotion needs an admin's sign-off (empty: it doesn't).
async function signoffReasons(q: Q, s: State, programs: Row[], moneyFirms: string[]): Promise<{ reasons: string[]; basis: SignoffBasis }> {
  const reasons: string[] = [];
  const beyondDevnet = programs.filter((p) => p.cluster !== "devnet").map((p) => `${p.cluster}:${p.program_id}`).sort();
  const solanaBuild = !!s.verified?.solana;
  if (beyondDevnet.length || solanaBuild) reasons.push("the app has Solana programs");
  const rails = moneyFirms.length
    ? (await rowsOf(q, `SELECT id::text AS id FROM ${T}.money_rails WHERE status = 'approved' AND entity_id::text = ANY($1) ORDER BY id`, [moneyFirms])).map((r) => r.id as string).sort()
    : [];
  if (rails.length) reasons.push("a product it uses moves money over an approved money rail");
  return { reasons, basis: { programs: beyondDevnet, solana_build: solanaBuild, rails } };
}

// ---- the checks for one step ----

export class PromotionError extends Error {}

// The checks for moving `app` one step up to `to`, from Mynt's own records. `q`: a transaction's connection when
// promoting, so the checks and the change read the same state.
export async function promotionChecks(q: Q, store: Store, app: App, to: "staging" | "production"): Promise<PromotionChecks> {
  const from = await stageOf(q, app);
  if (ORDER.indexOf(to) !== ORDER.indexOf(from) + 1)
    throw new PromotionError(
      from === to ? `The app is already in ${from}` : ORDER.indexOf(to) <= ORDER.indexOf(from) ? `The app is in ${from}; use demote_app to move it down` : `Promote one step at a time: the app is in ${from}, so its next stage is staging`,
    );
  return stageChecks(q, store, app, from, to);
}

// The checks of a stage, whatever stage the app is in now: what promotion to it needs, and what a production app
// must go on meeting (get_workspace_attention).
export async function stageChecks(q: Q, store: Store, app: App, from: AppStage, to: "staging" | "production"): Promise<PromotionChecks> {
  return (await evaluate(q, store, app, from, to)).result;
}

// A warning that doesn't block. Staging: every warning is advisory. Production: only these (a newer build that failed
// while the verified one runs; no independent audit, and so no findings to read, when the app moves no value).
export const ADVISORY_PRODUCTION_CHECKS = ["build_verified", "audit_passed", "audit_findings"] as const;

async function evaluate(q: Q, store: Store, app: App, from: AppStage, to: "staging" | "production") {
  const s = await readState(q, app.id);
  let needs = false;
  let signoff: PromotionChecks["signoff"];
  let basis: SignoffBasis = { programs: [], solana_build: false, rails: [] };
  let reasons: string[] = [];
  let checks: PromotionCheck[];
  if (to === "staging") checks = [buildCheck(app.id, s), auditCheck(s, { production: false, strict: false }), hostingCheck(app.id, s, false)];
  else {
    const { check, moneyFirms } = await licenceCheck(store, app, s);
    const programs = await programsOf(q, app.id, s);
    ({ reasons, basis } = await signoffReasons(q, s, programs, moneyFirms));
    needs = reasons.length > 0;
    checks = [
      buildCheck(app.id, s),
      auditCheck(s, { production: true, strict: needs }),
      hostingCheck(app.id, s, true),
      check,
      await webhookCheck(q, app),
      findingsCheck(app.id, s, needs),
      programCheck(app.id, s, programs),
    ];
    const row = await signoffFor(q, app.id, s.verified);
    signoff = signoffView(row, basis);
    if (needs) checks.push(await signoffCheck(q, app.id, s, row, reasons, basis));
  }
  const advisory = (c: PromotionCheck) => to === "staging" || (ADVISORY_PRODUCTION_CHECKS as readonly string[]).includes(c.id);
  const result: PromotionChecks = {
    app_id: app.id,
    from_stage: from,
    to_stage: to,
    checks,
    can_promote: checks.every((c) => c.status === "pass" || (c.status === "warn" && advisory(c))),
    needs_admin_signoff: needs,
    ...(signoff ? { signoff } : {}),
  };
  return { result, s, basis, reasons };
}

// An approved sign-off for the app's current verified build whose basis has changed since (attention).
export async function staleSignoff(store: Store, app: App): Promise<boolean> {
  const { s, basis } = await evaluate(store.db, store, app, "staging", "production");
  return stale(await signoffFor(store.db, app.id, s.verified), basis);
}

const lockApp = lockAppStage;
// A frozen workspace (its organization deleted in the identity provider) or one being archived moves no app's stage
// and asks for no sign-off until an owner relinks or unarchives it.
async function refuseFrozen(q: Q, app: Pick<App, "workspace_id">) {
  const why = app.workspace_id ? await frozenReason(q, app.workspace_id) : null;
  if (why) throw new PromotionError(`${why}; no app in it changes stage meanwhile`);
}
const auditIn = (q: Q, actor: string | null, action: string, target: string, details: unknown) =>
  q.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), actor, action, target, JSON.stringify(details)]);

// Promote one step: the checks again, under the app's lock, and the change only if they all pass.
export async function promoteApp(store: Store, user: Pick<User, "id">, app: App, to: "staging" | "production") {
  return inTransaction(store.db, async (tx) => {
    await lockApp(tx, app.id);
    await refuseFrozen(tx, app);
    const result = await promotionChecks(tx, store, app, to);
    if (!result.can_promote) return { promoted: false as const, ...result };
    const s = await readState(tx, app.id);
    // What was promoted: the verified build, and the build its hosting runs (in production, always the same one).
    const build = s.verified?.id ?? null;
    const sha = (s.verified?.source_sha256 as string | null | undefined) ?? null;
    const hosted = (s.hosted?.build_id as string | undefined) ?? null;
    await tx.query(
      `INSERT INTO ${T}.app_promotions (app_id, stage, build_id, source_sha256, hosted_build_id, checks, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (app_id) DO UPDATE SET stage = EXCLUDED.stage, build_id = EXCLUDED.build_id, source_sha256 = EXCLUDED.source_sha256, hosted_build_id = EXCLUDED.hosted_build_id,
         checks = EXCLUDED.checks, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [app.id, to, build, sha, hosted, JSON.stringify(result.checks), user.id],
    );
    await auditIn(tx, user.id, "app_promoted", app.id, {
      app_id: app.id,
      workspace_id: app.workspace_id,
      from_stage: result.from_stage,
      to_stage: to,
      build_id: build,
      source_sha256: sha,
      hosted_build_id: hosted,
      checks: result.checks,
      signoff: result.signoff ?? null,
    });
    return { promoted: true as const, ...result };
  });
}

export async function demoteApp(store: Store, user: Pick<User, "id">, app: App, to: AppStage, reason: string) {
  return inTransaction(store.db, async (tx) => {
    await lockApp(tx, app.id);
    await refuseFrozen(tx, app);
    const from = await stageOf(tx, app);
    if (ORDER.indexOf(to) !== ORDER.indexOf(from) - 1)
      throw new PromotionError(from === "idea" ? "The app is in idea, the first stage" : `Demote one step at a time: the app is in ${from}, so it goes down to ${ORDER[ORDER.indexOf(from) - 1]}`);
    // Out of production, nothing may still reach real money: refused while it has active live keys (the caller revokes
    // them first, deliberately; demotion never revokes them itself), and the app stops being published.
    let unpublished = false;
    if (from === "production") {
      const keys = (await rowsOf(tx, `SELECT id::text AS id, label FROM ${T}.api_keys WHERE app_id = $1 AND environment = 'live' AND status = 'active' ORDER BY created_at`, [app.id])) as { id: string; label: string }[];
      if (keys.length)
        throw new PromotionError(
          `The app still has ${keys.length} active live key(s) (${keys.map((k) => `${k.label}: ${k.id}`).join(", ")}): revoke them first (revoke_api_key; a hosted app's runtime key too, after undeploying it or before redeploying it on a sandbox key)`,
        );
      unpublished = (await rowsOf(tx, `UPDATE ${T}.apps SET status = 'draft', updated_at = now() WHERE id = $1 AND status = 'published' RETURNING id`, [app.id])).length > 0;
    }
    await tx.query(
      `INSERT INTO ${T}.app_promotions (app_id, stage, build_id, checks, updated_by, updated_at) VALUES ($1, $2, NULL, NULL, $3, now())
       ON CONFLICT (app_id) DO UPDATE SET stage = EXCLUDED.stage, build_id = NULL, source_sha256 = NULL, hosted_build_id = NULL, checks = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [app.id, to, user.id],
    );
    await auditIn(tx, user.id, "app_demoted", app.id, { app_id: app.id, workspace_id: app.workspace_id, from_stage: from, to_stage: to, reason, unpublished });
    return { app_id: app.id, from_stage: from, to_stage: to, reason, ...(unpublished ? { unpublished: true } : {}) };
  });
}

// ---- sign-off ----

export async function requestSignoff(store: Store, user: Pick<User, "id">, app: App) {
  return inTransaction(store.db, async (tx) => {
    await lockApp(tx, app.id);
    await refuseFrozen(tx, app);
    const from = await stageOf(tx, app);
    if (from !== "staging") throw new PromotionError(`Sign-off is for promoting to production, and the app is in ${from}`);
    const { result, s, basis, reasons } = await evaluate(tx, store, app, from, "production");
    if (!result.needs_admin_signoff) throw new PromotionError("This app doesn't need an admin's sign-off to go to production");
    if (!s.verified) throw new PromotionError("Sign-off is for a build Mynt verified, and the app has none yet");
    // The sign-off is for what runs: the verified build must be the one deployed on Mynt's hosting.
    if (s.hosted?.build_id !== s.verified.id)
      throw new PromotionError(`Sign-off is for the build that runs: deploy build ${short(s.verified.id)} on Mynt's hosting first${s.hosted ? ` (it runs ${short(s.hosted.build_id)})` : ""}`);
    const current = await signoffFor(tx, app.id, s.verified);
    if (current?.status === "requested" || (current?.status === "approved" && !stale(current, basis))) return { signoff: publicSignoff(current), already: true };
    // An open request for an older build, or an approval whose basis changed, no longer applies.
    await tx.query(`UPDATE ${T}.promotion_signoffs SET status = 'superseded' WHERE app_id = $1 AND (status = 'requested' OR (status = 'approved' AND id = $2))`, [app.id, current?.id ?? null]);
    const id = randomUUID();
    const row = await one(
      tx,
      `INSERT INTO ${T}.promotion_signoffs (id, app_id, workspace_id, build_id, source_sha256, commit_sha, status, reasons, basis, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8, $9) RETURNING *`,
      [id, app.id, app.workspace_id, s.verified.id, s.verified.source_sha256 ?? null, s.verified.commit_sha ?? null, JSON.stringify(reasons), JSON.stringify(basis), user.id],
    );
    await auditIn(tx, user.id, "promotion_signoff_requested", app.id, { app_id: app.id, workspace_id: app.workspace_id, signoff_id: id, build_id: s.verified.id, basis });
    return { signoff: publicSignoff(row!), already: false };
  });
}

function publicSignoff(r: Row) {
  return {
    id: r.id as string,
    app_id: r.app_id as string,
    workspace_id: (r.workspace_id as string | null) ?? null,
    build_id: r.build_id as string,
    source_sha256: (r.source_sha256 as string | null) ?? null,
    commit_sha: (r.commit_sha as string | null) ?? null,
    status: r.status as string,
    reasons: (r.reasons as string[]) ?? [],
    basis: (r.basis as SignoffBasis | null) ?? null,
    requested_by: (r.requested_by as string | null) ?? null,
    requested_at: iso(r.requested_at) ?? null,
    decided_by: (r.decided_by as string | null) ?? null,
    decided_at: iso(r.decided_at) ?? null,
    note: (r.note as string | null) ?? null,
  };
}

export async function listSignoffs(db: Db, status?: string) {
  const builds = (await tables(db, ["build_runs"])).has("build_runs");
  const r = await rowsOf(
    db,
    `SELECT s.*, a.name AS app_name, w.name AS workspace_name, u.name AS requested_by_name,
       ${builds ? `(SELECT b.id FROM ${T}.build_runs b WHERE b.app_id = s.app_id AND b.status = 'succeeded' ORDER BY COALESCE(b.finished_at, b.updated_at) DESC, b.created_at DESC LIMIT 1)` : "NULL::uuid"} AS latest_build_id
     FROM ${T}.promotion_signoffs s JOIN ${T}.apps a ON a.id = s.app_id LEFT JOIN ${T}.workspaces w ON w.id = s.workspace_id LEFT JOIN ${T}.users u ON u.id = s.requested_by
     WHERE ($1::text IS NULL OR s.status = $1) ORDER BY s.requested_at DESC LIMIT 200`,
    [status ?? null],
  );
  return r.map((x) => ({
    ...publicSignoff(x),
    app_name: x.app_name as string,
    workspace_name: (x.workspace_name as string | null) ?? null,
    requested_by_name: (x.requested_by_name as string | null) ?? null,
    // Still for the app's latest verified build: a newer build makes it moot.
    current: x.latest_build_id === x.build_id,
  }));
}

export async function decideSignoff(store: Store, admin: Pick<User, "id">, id: string, approve: boolean, note: string | undefined) {
  if (!isUuid(id)) throw new PromotionError(`No sign-off request '${id}'`);
  const req = await one(store.db, `SELECT * FROM ${T}.promotion_signoffs WHERE id = $1`, [id]);
  if (!req) throw new PromotionError(`No sign-off request '${id}'`);
  const out = await inTransaction(store.db, async (tx) => {
    await lockApp(tx, req.app_id as string);
    const r = await one(tx, `SELECT * FROM ${T}.promotion_signoffs WHERE id = $1`, [id]);
    if (r!.status !== "requested") throw new PromotionError(`This request is already ${r!.status}`);
    if (r!.requested_by === admin.id) throw new PromotionError("You asked for this sign-off; another Mynt admin decides it");
    // Nobody signs off their own workspace's app: a Mynt admin in it (in any role) leaves it to another.
    if (await one(tx, `SELECT 1 FROM ${T}.workspace_members m JOIN ${T}.apps a ON a.workspace_id = m.workspace_id WHERE a.id = $1 AND m.user_id = $2`, [r!.app_id, admin.id]))
      throw new PromotionError("You're a member of this app's workspace; a Mynt admin outside it decides");
    const app = await store.getApp(r!.app_id as string);
    const { s, basis } = await evaluate(tx, store, app!, "staging", "production");
    if (!s.verified || s.verified.id !== r!.build_id || s.verified.source_sha256 !== r!.source_sha256 || !sameBasis(r!.basis, basis)) {
      // Recorded (the transaction commits), then refused.
      await tx.query(`UPDATE ${T}.promotion_signoffs SET status = 'superseded' WHERE id = $1`, [id]);
      return { superseded: true as const };
    }
    const row = await one(
      tx,
      `UPDATE ${T}.promotion_signoffs SET status = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $1 RETURNING *`,
      [id, approve ? "approved" : "rejected", admin.id, note ?? null],
    );
    await auditIn(tx, admin.id, approve ? "promotion_signoff_approved" : "promotion_signoff_rejected", r!.app_id as string, {
      app_id: r!.app_id,
      workspace_id: r!.workspace_id,
      signoff_id: id,
      build_id: r!.build_id,
      note: note ?? null,
    });
    return publicSignoff(row!);
  });
  if ("superseded" in out) throw new PromotionError("A newer build, or a change to its programs or money rails, replaced what this sign-off was for; the workspace asks again");
  return out;
}

// ---- target states ----

const STATE = z.string().regex(/^us-[a-z]{2}$/i, "A US state as ISO 3166-2, e.g. 'us-ny'");

export async function setTargetStates(store: Store, user: Pick<User, "id">, app: App, states: string[]) {
  const codes = [...new Set(states.map((x) => x.toLowerCase()))].sort();
  const unknown = codes.filter((c) => !US_STATE_NAMES[c]);
  if (unknown.length) throw new PromotionError(`Not a US state or DC: ${unknown.join(", ")}`);
  return inTransaction(store.db, async (tx) => {
    await lockApp(tx, app.id);
    const stage = await stageOf(tx, app);
    await tx.query(
      `INSERT INTO ${T}.app_promotions (app_id, stage, target_states, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (app_id) DO UPDATE SET target_states = EXCLUDED.target_states`,
      [app.id, stage, codes, user.id],
    );
    await auditIn(tx, user.id, "app_target_states_set", app.id, { app_id: app.id, workspace_id: app.workspace_id, states: codes });
    return { app_id: app.id, target_states: codes };
  });
}

// ---- tools ----

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const TO = z.enum(["staging", "production"]);

export function registerPromotionTools(server: McpServer, store: Store, user: User) {
  const mine = async (appId: string) => {
    const app = await memberApp(store, user, appId);
    return app ? { app, role: await appRole(store, user, app) } : null;
  };
  const guard = async <T>(f: () => Promise<T>) => {
    try {
      return json(await f());
    } catch (e) {
      if (e instanceof PromotionError) return fail(e.message);
      throw e;
    }
  };
  const managersOnly = "Only the workspace's owners and admins do this; members see the checks with get_promotion_checks and ask them";

  server.registerTool(
    "get_promotion_checks",
    {
      title: "What an app needs to move up a stage",
      description:
        "Developer (any member of the app's workspace): the checks for promoting an app one step, idea → staging or staging → production, computed by Mynt from its own records, never from what the app or an agent reports. staging: the latest build passed Mynt's verification in a clean sandbox, its independent audit passed (or wasn't required), and it runs (healthy on Mynt's hosting if deployed there). production: all of that, running on Mynt's hosting from that very verified build, target states set and every product licensed (a licence in force covering its action) in each, every webhook verified, no open critical or high audit findings, the mainnet program gate passed when the app has Solana programs, and a Mynt admin's sign-off for this very build when the app moves value (which then also needs the independent audit). Each check is pass, fail, warn or pending (Mynt can't tell yet: blocks like a fail), with a fix where there is one. can_promote: every check passes, or warns where the warning is advisory (any staging check; in production only build_verified, audit_passed and audit_findings). Production gates real money: live keys, live runtime calls and publishing are for production apps only, so they come after promotion, not before.",
      inputSchema: { app_id: z.string(), to_stage: TO },
      annotations: { readOnlyHint: true },
    },
    async ({ app_id, to_stage }) => {
      const m = await mine(app_id);
      if (!m) return fail(`No app of yours with id '${app_id}'`);
      return guard(() => promotionChecks(store.db, store, m.app, to_stage));
    },
  );

  server.registerTool(
    "promote_app",
    {
      title: "Promote an app one stage",
      description:
        "Developer (the workspace's owners and admins): move an app up one stage (idea → staging, staging → production). Mynt runs every check again at that moment and refuses unless all pass or warn; the result, and the checks it passed with, are in the workspace's audit trail (app_promoted).",
      inputSchema: { app_id: z.string(), to_stage: TO },
    },
    async ({ app_id, to_stage }) => {
      const m = await mine(app_id);
      if (!m) return fail(`No app of yours with id '${app_id}'`);
      if (m.role === "member") return fail(managersOnly);
      return guard(async () => {
        const r = await promoteApp(store, user, m.app, to_stage);
        if (!r.promoted) {
          const blocking = r.checks.filter((c) => c.status === "fail" || c.status === "pending").map((c) => `${c.label} (${c.status})`);
          throw new PromotionError(`Not promoted: ${blocking.join(", ")}. See get_promotion_checks`);
        }
        return r;
      });
    },
  );

  server.registerTool(
    "demote_app",
    {
      title: "Move an app down one stage",
      description:
        "Developer (the workspace's owners and admins): move an app down one stage (production → staging, staging → idea), with the reason, recorded in the workspace's audit trail (app_demoted). Out of production nothing may reach real money: demoting a production app is refused while it has active live keys (revoke them first with revoke_api_key; demotion never revokes them for you), and it unpublishes the app. Its hosting and webhooks stay as they are.",
      inputSchema: { app_id: z.string(), to_stage: z.enum(["idea", "staging"]), reason: z.string().min(1).max(1000) },
    },
    async ({ app_id, to_stage, reason }) => {
      const m = await mine(app_id);
      if (!m) return fail(`No app of yours with id '${app_id}'`);
      if (m.role === "member") return fail(managersOnly);
      return guard(() => demoteApp(store, user, m.app, to_stage, reason));
    },
  );

  server.registerTool(
    "set_app_target_states",
    {
      title: "Set the US states an app serves",
      description:
        "Developer (the workspace's owners and admins): the US states (ISO 3166-2, e.g. 'us-ny'; 'us-dc' for DC) the app serves. Promotion to production checks that every product it uses is covered by a licence in force in each. Replaces the list; an empty list clears it.",
      inputSchema: { app_id: z.string(), states: z.array(STATE).max(51) },
    },
    async ({ app_id, states }) => {
      const m = await mine(app_id);
      if (!m) return fail(`No app of yours with id '${app_id}'`);
      if (m.role === "member") return fail("Only the workspace's owners and admins set the states an app serves");
      return guard(() => setTargetStates(store, user, m.app, states));
    },
  );

  server.registerTool(
    "request_promotion_signoff",
    {
      title: "Ask a Mynt admin to sign off a production promotion",
      description:
        "Developer (the workspace's owners and admins): when get_promotion_checks says needs_admin_signoff, ask Mynt's admins to sign off the app's latest verified build for production. The sign-off is for that build only: a newer verified build needs a new one. Asking again for the same build returns the open request.",
      inputSchema: { app_id: z.string() },
    },
    async ({ app_id }) => {
      const m = await mine(app_id);
      if (!m) return fail(`No app of yours with id '${app_id}'`);
      if (m.role === "member") return fail(managersOnly);
      return guard(() => requestSignoff(store, user, m.app));
    },
  );
}

export function registerPromotionAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "list_promotion_signoffs",
    {
      title: "Production sign-off requests",
      description:
        "Admin: requests to sign off an app's promotion to production, newest first (requested, approved, rejected or superseded by a newer build), each with its app, workspace, the build and source hash it is for, why it's needed, and whether that build is still the app's latest verified one.",
      inputSchema: { status: z.enum(["requested", "approved", "rejected", "superseded"]).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => json({ signoffs: await listSignoffs(store.db, status) }),
  );

  server.registerTool(
    "decide_promotion_signoff",
    {
      title: "Approve or reject a production sign-off",
      description:
        "Admin: approve or reject a sign-off request, with a note. Only for the build it was asked for while that is still the app's latest verified build; never one you asked for yourself. Recorded in the audit trail.",
      inputSchema: { id: z.string(), approve: z.boolean(), note: z.string().max(2000).optional() },
    },
    async ({ id, approve, note }) => {
      try {
        return json(await decideSignoff(store, user, id, approve, note));
      } catch (e) {
        if (e instanceof PromotionError) return fail(e.message);
        throw e;
      }
    },
  );
}
