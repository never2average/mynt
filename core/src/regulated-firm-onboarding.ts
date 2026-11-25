import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { licenseInForce } from "./access.js";
import { firmLegitimacy, FIRM_CHECK_SOURCES, leiOf, legitimacySummary, validLei, type FirmCheckSource, type Legitimacy, type LegitimacyRule } from "./firm-checks.js";
import { pendingMembers } from "./firm-notices.js";
import { reconcileEntity } from "./parties.js";
import { partnerKitSummary } from "./partner-kit.js";
import type { Entity, FirmCheck, HeldLicense, Store, User } from "./store.js";
import { effectiveRoles } from "./store.js";

// A regulated firm's (licence provider's) onboarding, as one ordered checklist (get_regulated_firm_onboarding): what's
// done, what's next and what waits on someone else before the firm can sponsor builders' products, each step in plain
// words with the tool that does it. It only reads: every step is done with the existing tools (register_firm,
// invite_user, set_entity_facts, run_firm_checks, register_license, review_license, add_party…), and Mynt decides each
// one as before. It mirrors a vendor's (vendor-onboarding.ts).
//
// A step's status: done; next (the first thing the firm can do now); not_started (theirs to do, after the next one);
// blocked (waiting on Mynt, a public register or a step before it: the detail says which). The partner ledger, an
// agreement template and the first sponsorship are informational: nothing refuses a sponsorship for want of them, so
// they never count towards progress. A figure Mynt doesn't measure is null, never 0.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const day = (v: string | null | undefined) => (v ? v.slice(0, 10) : null);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const FIRM_STEP_STATUSES = ["done", "next", "not_started", "blocked"] as const;
export type FirmStepStatus = (typeof FIRM_STEP_STATUSES)[number];
// Who does a step: the firm's own licence providers, a Mynt admin, or the builders who ask for sponsorship.
export type FirmStepActor = "firm" | "admin" | "builder";

export interface FirmOnboardingStep {
  key: string;
  title: string;
  status: FirmStepStatus;
  detail: string;
  tool: string | null; // the MCP tool that does this step
  by: FirmStepActor;
  informational: boolean; // true: shown, never counted
  facts: Record<string, unknown>;
}
export interface FirmProgress {
  done: number;
  total: number;
  next: { key: string; title: string; status: FirmStepStatus; tool: string | null } | null;
  complete: boolean;
}

type Raw = Omit<FirmOnboardingStep, "status"> & { state: "done" | "todo" | "blocked" };
const step = (key: string, title: string, state: Raw["state"], detail: string, tool: string | null, by: FirmStepActor, facts: Record<string, unknown> = {}, informational = false): Raw => ({
  key,
  title,
  state,
  detail,
  tool,
  by,
  informational,
  facts,
});

// The first step still to do becomes next; the rest are not started. Blocked and done steps keep their state. With a
// gate (the firm isn't active, or nobody there can act yet), everything not done waits on it.
function settle(raws: Raw[], gate: string | null): FirmOnboardingStep[] {
  let nextGiven = false;
  return raws.map(({ state, ...s }) => {
    if (state === "done") return { ...s, status: "done" as const };
    if (state === "blocked") return { ...s, status: "blocked" as const };
    if (gate) return { ...s, status: "blocked" as const, detail: `${gate} ${s.detail}` };
    if (s.informational || nextGiven) return { ...s, status: "not_started" as const };
    nextGiven = true;
    return { ...s, status: "next" as const };
  });
}

function progressOf(steps: FirmOnboardingStep[]): FirmProgress {
  const counted = steps.filter((s) => !s.informational);
  const next = counted.find((s) => s.status === "next") ?? counted.find((s) => s.status === "blocked") ?? null;
  const done = counted.filter((s) => s.status === "done").length;
  return { done, total: counted.length, next: next ? { key: next.key, title: next.title, status: next.status, tool: next.tool } : null, complete: done === counted.length };
}

const STATUS_WORDS: Record<string, string> = { suspended: "suspended", under_liquidation: "marked as under liquidation", dissolved: "marked as dissolved", struck_off: "marked as struck off" };

// ---- the people ----

// The firm's licence providers: those with standing (they act for it), those waiting to be accepted by one of them
// (decide_firm_member), and those Mynt added before they signed in (they join when they first do).
async function people(store: Store, entityId: string) {
  const { rows } = await store.db.query(`SELECT name, email, lp_since FROM ${T}.users WHERE entity_id = $1 AND 'license_provider' = ANY(roles) AND lp_since IS NOT NULL ORDER BY lp_since, id`, [entityId]);
  const waiting = (await pendingMembers(store, entityId)).map((r) => ({ request_id: r.request_id, email: r.member_email, requested_at: r.requested_at, admin_recovery: "admin_recovery" in r }));
  const invited = (await store.pendingFirmMembers(entityId)).filter((p) => p.roles.includes("license_provider")).map((p) => ({ email: p.email, invited_at: p.created_at }));
  const providers = rows.map((r) => ({ name: (r.name as string | null) ?? null, email: (r.email as string | null) ?? null, since: new Date(r.lp_since as string).toISOString() }));
  return { members: providers.length, waiting: waiting.length, invited: invited.length, lists: { licence_providers: providers, waiting, invited } };
}

// ---- the facts the real-company check needs ----

// What each rule looks a firm up by. The LEI is the firm's `lei` identifier; FinCEN's list is matched by legal name, and
// the firm's MSB registration number (identifier us_fincen_msb, or its registered FinCEN licence) is what an admin
// checks by hand beside it.
const NEEDS: Record<LegitimacyRule, { lei: boolean; msb: boolean; either: boolean; words: string }> = {
  lei_or_msb: { lei: true, msb: true, either: true, words: "its LEI or its FinCEN MSB registration number" },
  lei_and_msb: { lei: true, msb: true, either: false, words: "its LEI and its FinCEN MSB registration number" },
  lei: { lei: true, msb: false, either: false, words: "its LEI" },
  msb: { lei: false, msb: true, either: false, words: "its FinCEN MSB registration number" },
  off: { lei: false, msb: false, either: false, words: "nothing" },
};
const msbNumberOf = (entity: Entity, held: HeldLicense[]) =>
  entity.identifiers.find((i) => i.scheme === "us_fincen_msb")?.value.trim() || held.find((l) => l.regulator_id === "fincen" && l.status !== "rejected")?.registration_number || null;

const HOW_LEI = "its LEI (set_entity_facts identifiers: { scheme: 'lei', value })";
const HOW_MSB = "its FinCEN MSB registration number (set_entity_facts identifiers: { scheme: 'us_fincen_msb', value }, or register the FinCEN registration with register_license)";

function factsStep(entity: Entity, held: HeldLicense[], l: Legitimacy): Raw {
  const title = "Firm facts for the real-company check";
  const need = NEEDS[l.rule];
  const lei = leiOf(entity);
  const leiOk = lei !== null && validLei(lei);
  const msb = msbNumberOf(entity, held);
  const facts = {
    rule: l.rule,
    rule_text: l.rule_text,
    legal_name: entity.name,
    lei,
    lei_valid: lei === null ? null : leiOk,
    fincen_msb_registration_number: msb,
    needs: { lei: need.lei, fincen_msb: need.msb, either: need.either },
  };
  const s = (state: Raw["state"], detail: string) => step("firm_facts", title, state, detail, "set_entity_facts", "firm", facts);
  if (l.rule === "off") return s("done", "This server doesn't run the real-company check, so no facts are needed for it.");
  const have = [leiOk ? `LEI ${lei}` : null, msb ? `FinCEN MSB registration ${msb}` : null].filter((x): x is string => x !== null);
  if (lei && !leiOk && need.lei) return s("todo", `The LEI on record (${lei}) isn't a valid LEI: it is 20 letters and digits ending in two check digits. Record ${HOW_LEI} again.`);
  const met = need.either ? leiOk || Boolean(msb) : (!need.lei || leiOk) && (!need.msb || Boolean(msb));
  if (met) return s("done", `On record: ${have.join(" and ")}. Mynt looks ${entity.name} up by ${have.length > 1 ? "those" : "that"}, and by its legal name.`);
  // The check can pass on the legal name alone (a single FinCEN registrant of that name): the facts aren't in its way.
  if (l.passes) return s("done", `The real-company check passed on ${entity.name}'s legal name. Recording ${need.words} keeps it matched if another firm takes a like name.`);
  const missing = [need.lei && !leiOk ? HOW_LEI : null, need.msb && !msb ? HOW_MSB : null].filter((x): x is string => x !== null);
  return s("todo", `Mynt checks ${entity.name} against public registers by ${need.words}${have.length ? ` (on record: ${have.join(" and ")})` : ""}. Record ${missing.join(need.either ? ", or " : ", and ")}.`);
}

// ---- the real-company check ----

const SOURCE_NAMES: Record<FirmCheckSource, string> = { gleif_lei: "GLEIF's LEI record", fincen_msb: "FinCEN's MSB registrant list" };
const CHECK_WORDS: Record<string, string> = { match: "matches", mismatch: "doesn't match", not_found: "not found", unavailable: "couldn't be reached", not_run: "not checked yet" };
const sourceWords = (source: FirmCheckSource, c: Legitimacy["checks"][FirmCheckSource]) => {
  const answer = c.last_result ?? c.latest;
  const status = c.lapsed ? "no longer lists the firm" : (CHECK_WORDS[c.status] ?? c.status);
  return `${SOURCE_NAMES[source]}: ${status}${answer ? ` (${day(answer.retrieved_at)})` : ""}`;
};
// One register's answer, as the checklist and the admin's Checks tab show it. scheduled: Mynt's own monthly re-check.
export const firmCheckView = (c: FirmCheck) => ({
  id: c.id,
  source: c.source,
  source_name: SOURCE_NAMES[c.source as FirmCheckSource] ?? c.source,
  status: c.status,
  status_words: CHECK_WORDS[c.status] ?? c.status,
  subject: c.subject,
  at: c.retrieved_at,
  note: c.note,
  url: c.url,
  scheduled: c.run_by === null,
});

function checkStep(entity: Entity, l: Legitimacy, factsState: Raw["state"]): Raw {
  const title = "Real-company check passed";
  const sources = Object.fromEntries(
    FIRM_CHECK_SOURCES.map((src) => {
      const c = l.checks[src];
      const answer = c.last_result ?? c.latest;
      return [src, { status: c.status, lapsed: c.lapsed, at: answer?.retrieved_at ?? null, note: answer?.note ?? null, unavailable_at: c.latest?.status === "unavailable" ? c.latest.retrieved_at : null }];
    }),
  );
  const answered = FIRM_CHECK_SOURCES.map((src) => l.checks[src].last_result?.retrieved_at ?? null)
    .filter((x): x is string => x !== null)
    .sort();
  const facts = { rule: l.rule, rule_text: l.rule_text, passes: l.rule === "off" ? null : l.passes, reasons: l.reasons, sources, last_run_at: l.last_run_at, last_answer_at: answered.at(-1) ?? null };
  const s = (state: Raw["state"], detail: string) => step("real_company_check", title, state, detail, "run_firm_checks", "admin", facts);
  if (l.rule === "off") return s("done", "This server doesn't require the real-company check before sponsoring.");
  const ran = FIRM_CHECK_SOURCES.filter((src) => l.checks[src].status !== "not_run");
  // Registers Mynt couldn't reach on its latest try: said as such, with when, and never held against the firm.
  const down = FIRM_CHECK_SOURCES.filter((src) => l.checks[src].latest?.status === "unavailable");
  const downWords = down.length ? ` ${down.map((src) => SOURCE_NAMES[src]).join(" and ")} couldn't be reached on ${day(l.checks[down[0]].latest!.retrieved_at)}: unavailable, not a failure. Mynt tries again daily.` : "";
  if (l.passes) {
    const matched = FIRM_CHECK_SOURCES.filter((src) => l.checks[src].last_result?.status === "match");
    return s("done", `Passed. ${matched.map((src) => sourceWords(src, l.checks[src])).join("; ")}.${down.length ? `${downWords} The earlier answer stands.` : ""} Mynt checks again monthly.`);
  }
  if (!ran.length) {
    if (factsState !== "done") return s("blocked", `Mynt hasn't run it yet. It waits for your firm's facts first, then for Mynt to run it. The rule: ${l.rule_text}.`);
    return s("blocked", `Mynt hasn't run it yet. Waiting for Mynt to check ${entity.name} against the public registers (it also runs by itself, monthly). The rule: ${l.rule_text}.`);
  }
  const failing = FIRM_CHECK_SOURCES.filter((src) => l.checks[src].last_result !== null && l.checks[src].last_result!.status !== "match");
  if (!failing.length && down.length) return s("blocked", `Not known yet.${downWords} Waiting for the register to answer. The rule: ${l.rule_text}.`);
  const why = failing.map((src) => `${sourceWords(src, l.checks[src])}${l.checks[src].last_result?.note ? `: ${l.checks[src].last_result!.note}` : ""}`);
  return s(
    "blocked",
    `Not passed. ${why.join("; ") || l.reasons.join("; ")}.${downWords} The rule: ${l.rule_text}. If your firm's LEI on Mynt is wrong, correct it (set_entity_facts); Mynt corrects a legal name. Otherwise it waits for the register to show your firm, then for Mynt to run the check again. Until it passes, Mynt refuses approve_sponsorship.`,
  );
}

// ---- licences ----

const licenceName = (l: HeldLicense) => `${l.license_id}${l.jurisdiction ? ` (${l.jurisdiction})` : ""} ${l.registration_number}`;
const licenceFacts = (held: HeldLicense[]) => ({
  licences: held.map((l) => ({
    id: l.id,
    region: l.region,
    regulator_id: l.regulator_id,
    license_id: l.license_id,
    jurisdiction: l.jurisdiction,
    registration_number: l.registration_number,
    status: l.status,
    in_force: licenseInForce(l),
    valid_to: l.valid_to,
  })),
});

function registeredStep(held: HeldLicense[]): Raw {
  const title = "Register your licences";
  const standing = held.filter((l) => l.status !== "rejected");
  const facts = { registered: standing.length, rejected: held.length - standing.length };
  if (standing.length) return step("licences_registered", title, "done", `${plural(standing.length, "licence", "licences")} registered.`, "register_license", "firm", facts);
  if (held.length)
    return step("licences_registered", title, "todo", `Mynt didn't verify the ${held.length === 1 ? "licence" : "licences"} you registered. Register ${held.length === 1 ? "it" : "them"} again with the right details.`, "register_license", "firm", facts);
  return step(
    "licences_registered",
    title,
    "todo",
    "Record each licence your firm holds: its type, its number, the state it was issued for where the type is issued per state, and its dates. Mynt verifies each one.",
    "register_license",
    "firm",
    facts,
  );
}

function verifiedStep(held: HeldLicense[]): Raw {
  const title = "Licences verified by Mynt";
  const facts = licenceFacts(held);
  const s = (state: Raw["state"], detail: string, tool: string, by: FirmStepActor) => step("licences_verified", title, state, detail, tool, by, facts);
  const ready = held.filter((l) => licenseInForce(l));
  const pending = held.filter((l) => l.status === "pending");
  const suspended = held.filter((l) => l.status === "suspended");
  const lapsed = held.filter((l) => l.status === "verified" && !licenseInForce(l));
  const rejected = held.filter((l) => l.status === "rejected");
  const others = [
    pending.length ? `${pending.length} waiting for Mynt to verify` : null,
    suspended.length ? `${suspended.length} suspended by Mynt` : null,
    lapsed.length ? `${lapsed.length} no longer in force` : null,
    rejected.length ? `${rejected.length} not verified` : null,
  ].filter((x): x is string => x !== null);
  if (ready.length) return s("done", `${plural(ready.length, "licence is", "licences are")} verified and in force${others.length ? `; ${others.join(", ")}` : ""}.`, "review_license", "admin");
  if (pending.length) return s("blocked", `Waiting for Mynt to verify ${pending.length === 1 ? `your licence ${licenceName(pending[0])}` : `your ${pending.length} licences`}.`, "review_license", "admin");
  if (suspended.length)
    return s("blocked", `Mynt suspended your licence ${licenceName(suspended[0])}${suspended[0].review_note ? ` ("${suspended[0].review_note}")` : ""}. Waiting for Mynt to restore it.`, "review_license", "admin");
  if (lapsed.length) return s("todo", `Your licence ${licenceName(lapsed[0])} isn't in force${lapsed[0].valid_to ? ` (valid to ${lapsed[0].valid_to})` : ""}. Register the renewed one.`, "register_license", "firm");
  if (rejected.length)
    return s("todo", `Mynt didn't verify your licence ${licenceName(rejected[0])}${rejected[0].review_note ? ` ("${rejected[0].review_note}")` : ""}. Register it again with the right details.`, "register_license", "firm");
  return s("todo", "Mynt verifies each licence against the regulator's register once you've registered it.", "register_license", "firm");
}

// ---- the roster ----

async function rosterStep(store: Store, entity: Entity, held: HeldLicense[]): Promise<Raw> {
  const title = "Roster filled for your licences";
  const standing = held.filter((l) => l.status !== "rejected");
  if (!standing.length)
    return step(
      "roster_complete",
      title,
      "todo",
      "Each licence type names the people and firms its holder must have (a compliance officer, an auditor…). Add them once a licence is registered.",
      "add_party",
      "firm",
      { mandated: null, filled: null, missing: [] },
    );
  const r = await reconcileEntity(store, entity.id);
  const name = (id: string) => {
    const l = standing.find((h) => h.id === id);
    return l ? `${l.license_id}${l.jurisdiction ? ` (${l.jurisdiction})` : ""}` : id;
  };
  const known = r.licences.filter((l) => l.known);
  const unknown = r.licences.filter((l) => !l.known);
  const mandated = known.reduce((n, l) => n + l.mandated, 0);
  const filled = known.reduce((n, l) => n + l.filled.length, 0);
  const missing = known.flatMap((l) => l.missing.map((m) => ({ licence_id: l.licence_id, license_id: l.license_id, stakeholder: m.stakeholder, name: m.name, kind: m.kind })));
  const unqualified = known.flatMap((l) => l.unqualified.map((u) => ({ licence_id: l.licence_id, license_id: l.license_id, ...u })));
  const facts = { mandated, filled, missing, unqualified, licences_not_in_model: unknown.map((l) => l.license_id) };
  const s = (state: Raw["state"], detail: string) => step("roster_complete", title, state, detail, "add_party", "firm", facts);
  if (unknown.length && !known.length)
    return s("blocked", `Mynt's regulatory model no longer has the licence ${unknown.length === 1 ? "type" : "types"} ${unknown.map((l) => l.license_id).join(", ")}, so it can't say who they require. Waiting for Mynt.`);
  if (missing.length || unqualified.length) {
    const gaps = [
      ...missing.slice(0, 4).map((m) => `${m.name} (${m.kind === "internal" ? "a person" : "a firm"}, for ${name(m.licence_id)})`),
      ...unqualified.slice(0, 2).map((u) => `${u.stakeholder} for ${name(u.licence_id)} doesn't meet ${u.failed.join(", ")}`),
    ];
    const more = missing.length + unqualified.length - gaps.length;
    return s("todo", `${filled} of ${mandated} required roles filled. Still needed: ${gaps.join("; ")}${more > 0 ? ` (and ${more} more)` : ""}. Add each to your roster; a gap blocks publishing the products you sponsor.`);
  }
  if (!mandated) return s("done", "Your licences require no named roles.");
  return s("done", `All ${mandated} required ${mandated === 1 ? "role is" : "roles are"} filled across ${plural(known.length, "licence", "licences")}.`);
}

// ---- for information: the ledger, a template, the first sponsorship ----

async function ledgerStep(store: Store, entityId: string): Promise<Raw> {
  const title = "Connect your ledger";
  const kit = await partnerKitSummary(store, entityId, { runs: 1 });
  const facts = { ledger_source: kit.ledger_source, live: kit.live, activated_at: kit.activated_at, live_until: kit.live_until, endpoints_set: kit.endpoints !== null };
  if (kit.live) {
    const how = kit.ledger_source === "file" ? "your daily file" : "your HTTPS feed";
    return step(
      "partner_ledger",
      title,
      "done",
      `Mynt reads ${how}${kit.activated_at ? ` since ${day(kit.activated_at)}` : ""}${kit.live_until ? `; its conformance pass runs to ${day(kit.live_until)}` : ""}.`,
      "get_partner_kit",
      "firm",
      facts,
      true,
    );
  }
  return step(
    "partner_ledger",
    title,
    "todo",
    "Not needed before you sponsor: Mynt reads the sandbox ledger for your firm until yours is connected. Connect it with the partner kit before sponsored products report real figures.",
    "get_partner_kit",
    "firm",
    facts,
    true,
  );
}

async function templateStep(store: Store, entityId: string): Promise<Raw> {
  const title = "Upload your program agreement template";
  const { rows } = await store.db.query(`SELECT count(*)::int AS n FROM ${T}.agreement_templates WHERE entity_id = $1 AND active`, [entityId]);
  const n = Number(rows[0]?.n ?? 0);
  return n
    ? step("agreement_template", title, "done", `${plural(n, "template", "templates")} in use.`, "upload_agreement_template", "firm", { templates: n }, true)
    : step(
        "agreement_template",
        title,
        "todo",
        "Optional: with a template, apps sign your program agreement by e-signature when you accept theirs. Without one, each side records its signature.",
        "upload_agreement_template",
        "firm",
        { templates: 0 },
        true,
      );
}

async function sponsorshipStep(store: Store, entityId: string, l: Legitimacy): Promise<Raw> {
  const title = "First sponsorship approved";
  const all = await store.sponsorships({ provider_entity_id: entityId });
  const approved = all.filter((x) => x.status === "approved").length;
  const pending = all.filter((x) => x.status === "pending").length;
  const facts = { approved, pending };
  const waiting = `${plural(pending, "request is", "requests are")} waiting for your decision`;
  if (approved) return step("first_sponsorship", title, "done", `${plural(approved, "sponsorship", "sponsorships")} approved${pending ? `; ${waiting}` : ""}.`, "approve_sponsorship", "firm", facts, true);
  if (pending)
    return step("first_sponsorship", title, "todo", `${waiting}.${l.passes ? "" : " Mynt refuses an approval until the real-company check passes; you can still decline."}`, "approve_sponsorship", "firm", facts, true);
  return step(
    "first_sponsorship",
    title,
    "todo",
    "No requests yet. Builders name your firm id and ask (request_sponsorship); share the id with them, as there is no directory of firms.",
    "request_sponsorship",
    "builder",
    facts,
    true,
  );
}

// ---- the checklist ----

const NO_FIRM = "Waits for your firm to be added.";

export async function regulatedFirmOnboarding(store: Store, entityId: string | null) {
  const entity = entityId ? ((await store.getEntity(entityId)) ?? null) : null;
  if (!entity) {
    const blocked = (key: string, title: string, tool: string, by: FirmStepActor, facts: Record<string, unknown> = {}, informational = false) => step(key, title, "blocked", NO_FIRM, tool, by, facts, informational);
    const steps = settle(
      [
        step("firm_registered", "Your firm is registered with Mynt", "blocked", "Waiting for Mynt to add your firm and you to it.", "register_firm", "admin"),
        blocked("licence_provider_members", "People with the licence-provider role", "invite_user", "admin", { members: null }),
        blocked("firm_facts", "Firm facts for the real-company check", "set_entity_facts", "firm"),
        blocked("real_company_check", "Real-company check passed", "run_firm_checks", "admin", { passes: null }),
        blocked("licences_registered", "Register your licences", "register_license", "firm", { registered: null }),
        blocked("licences_verified", "Licences verified by Mynt", "review_license", "admin"),
        blocked("roster_complete", "Roster filled for your licences", "add_party", "firm", { mandated: null, filled: null }),
        blocked("partner_ledger", "Connect your ledger", "get_partner_kit", "firm", {}, true),
        blocked("agreement_template", "Upload your program agreement template", "upload_agreement_template", "firm", { templates: null }, true),
        blocked("first_sponsorship", "First sponsorship approved", "approve_sponsorship", "firm", { approved: null, pending: null }, true),
      ],
      null,
    );
    return { entity: null, steps, progress: progressOf(steps), ready_to_sponsor: false, legitimacy: null, checks: [] };
  }
  const active = entity.status === "active";
  const who = await people(store, entity.id);
  const held = await store.licensesOf(entity.id);
  const legitimacy = (await firmLegitimacy(store, entity.id))!;
  const title = "People with the licence-provider role";
  const waitingWords = who.waiting ? ` ${plural(who.waiting, "more is", "more are")} waiting to be accepted by one of them (decide_firm_member).` : "";
  const invitedWords = who.invited ? ` ${plural(who.invited, "more was", "more were")} invited and ${who.invited === 1 ? "hasn't" : "haven't"} signed in yet.` : "";
  // The firm's own people, by name: its licence providers, those waiting for one of them, and those yet to sign in.
  const memberFacts = { members: who.members, waiting_to_be_accepted: who.waiting, invited_not_signed_in: who.invited, ...who.lists };
  const members =
    who.members > 0
      ? step("licence_provider_members", title, "done", `${plural(who.members, "person has", "people have")} the licence-provider role at ${entity.name}.${waitingWords}${invitedWords}`, "invite_user", "admin", memberFacts)
      : who.invited > 0
        ? step(
            "licence_provider_members",
            title,
            "blocked",
            `Mynt invited ${plural(who.invited, "person", "people")} with the licence-provider role. Waiting for them to sign in: they join ${entity.name} when they do.`,
            "invite_user",
            "admin",
            memberFacts,
          )
        : who.waiting > 0
          ? step(
              "licence_provider_members",
              title,
              "blocked",
              `${plural(who.waiting, "person is", "people are")} waiting to be accepted, and nobody at ${entity.name} can accept them. Waiting for Mynt (recover_firm_member).`,
              "recover_firm_member",
              "admin",
              memberFacts,
            )
          : step("licence_provider_members", title, "blocked", "Waiting for Mynt to invite your people with the licence-provider role.", "invite_user", "admin", memberFacts);
  const facts = factsStep(entity, held, legitimacy);
  const raws: Raw[] = [
    active
      ? step("firm_registered", "Your firm is registered with Mynt", "done", `${entity.name} is registered with Mynt and active.`, "register_firm", "admin", { entity_status: entity.status })
      : step(
          "firm_registered",
          "Your firm is registered with Mynt",
          "blocked",
          `Mynt has ${STATUS_WORDS[entity.status] ?? entity.status} ${entity.name}. Waiting for Mynt to make it active again.`,
          "set_entity_status",
          "admin",
          { entity_status: entity.status },
        ),
    members,
    facts,
    checkStep(entity, legitimacy, facts.state),
    registeredStep(held),
    verifiedStep(held),
    await rosterStep(store, entity, held),
    await ledgerStep(store, entity.id),
    await templateStep(store, entity.id),
    await sponsorshipStep(store, entity.id, legitimacy),
  ];
  // Nobody at the firm can do its steps while it isn't active, or before it has a licence provider.
  const gate = !active ? "Waits for your firm to be active again." : who.members === 0 ? "Waits for your firm's people with the licence-provider role." : null;
  const steps = settle(raws, gate);
  return {
    entity: { id: entity.id, name: entity.name, status: entity.status },
    steps,
    progress: progressOf(steps),
    // What approve_sponsorship itself needs of the firm: active, someone to decide, the real-company check, and a
    // licence in force.
    ready_to_sponsor: active && who.members > 0 && legitimacy.passes && held.some((l) => licenseInForce(l)),
    legitimacy: legitimacySummary(legitimacy),
    // Every answer the public registers gave about this firm, newest first (run_firm_checks, and the monthly re-check).
    checks: (await store.firmChecks(entity.id, 50)).map(firmCheckView),
  };
}

// Regulated firms: one with a licence provider (with or without standing yet, or invited and not signed in), or one
// that has been asked to sponsor.
export async function regulatedFirms(store: Store) {
  const { rows } = await store.db.query(
    `SELECT e.id FROM ${T}.entities e WHERE EXISTS (SELECT 1 FROM ${T}.users u WHERE u.entity_id = e.id AND 'license_provider' = ANY(u.roles))
        OR EXISTS (SELECT 1 FROM ${T}.firm_pending_members p JOIN ${T}.invites i ON i.email = p.email WHERE p.entity_id = e.id AND 'license_provider' = ANY(i.roles))
        OR EXISTS (SELECT 1 FROM ${T}.sponsorships s WHERE s.provider_entity_id = e.id) ORDER BY e.name, e.id`,
  );
  const firms = [];
  for (const r of rows) {
    const o = await regulatedFirmOnboarding(store, r.id as string);
    const fact = (key: string, name: string) => o.steps.find((s) => s.key === key)?.facts[name] ?? null;
    firms.push({
      entity_id: o.entity!.id,
      name: o.entity!.name,
      status: o.entity!.status,
      licence_provider_members: fact("licence_provider_members", "members"),
      licences: fact("licences_registered", "registered"),
      sponsorships_approved: fact("first_sponsorship", "approved"),
      real_company_check: o.legitimacy ? { rule: o.legitimacy.rule, passes: o.legitimacy.rule === "off" ? null : o.legitimacy.passes, last_run_at: o.legitimacy.last_run_at } : null,
      ready_to_sponsor: o.ready_to_sponsor,
      progress: o.progress,
    });
  }
  return firms;
}

export function registerRegulatedFirmOnboardingTools(server: McpServer, store: Store, user: User, opts: { admin?: boolean } = {}) {
  server.registerTool(
    "get_regulated_firm_onboarding",
    {
      title: "Where a regulated firm's onboarding stands",
      description:
        "Licence provider (your own firm) or admin (any firm, with entity_id; every regulated firm's progress, with all_firms): the ordered checklist of what a regulated firm needs before it can sponsor builders' products, each step done, next, not_started or blocked (waiting on Mynt, a public register or an earlier step), in plain words with the tool that does it: the firm registered and active, people with the licence-provider role (and those invited who haven't signed in), the facts the real-company check looks the firm up by (its LEI or FinCEN MSB registration number, by SPONSOR_LEGITIMACY_RULE), the real-company check itself (each public register's latest answer and when; 'unavailable' is said as such, never as a failure), licences registered, licences verified by Mynt, and the roster filled for those licences' mandated stakeholders. Three more are informational and never counted: the partner ledger, a program agreement template and the first approved sponsorship. It also gives ready_to_sponsor, the legitimacy result and the registers' answers so far (checks, newest first). It only reads; a figure Mynt doesn't measure is null.",
      inputSchema: {
        entity_id: z.string().uuid().optional().describe("Admins: the regulated firm. Licence providers may omit it (their own firm)."),
        all_firms: z.literal(true).optional().describe("Admins: every regulated firm's progress"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id, all_firms }) => {
      const me = (await store.getUser(user.id)) ?? user;
      const admin = opts.admin === true && effectiveRoles(me.roles).includes("admin");
      // A firm member with the licence-provider role granted, and standing at its firm (an admin only implies the role).
      const provider = me.roles.includes("license_provider");
      if (all_firms) {
        if (!admin) return fail("Only Mynt admins see every regulated firm");
        return json({ firms: await regulatedFirms(store) });
      }
      let entityId = entity_id ?? null;
      if (entityId === null) {
        if (!provider) return fail("Name the regulated firm (entity_id), or all_firms: true");
        entityId = me.entity_id;
      }
      // A licence provider reads its own firm only; an admin any firm.
      if (!admin && (!provider || entityId !== me.entity_id)) return fail("You can only see your own firm's onboarding");
      if (entityId && !(await store.getEntity(entityId))) return fail(`No firm '${entityId}'`);
      return json(await regulatedFirmOnboarding(store, entityId));
    },
  );
}
