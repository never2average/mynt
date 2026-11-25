import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { licenseInForce } from "./access.js";
import { agreementScopeLabel } from "./app-agreements-schema.js";
import type { Entity, HeldLicense, Store, User } from "./store.js";
import { effectiveRoles } from "./store.js";
import { getOffering, offeringsOf, rampRefusal, serviceType, type Offering, type ServiceType } from "./vendors.js";

// A vendor's onboarding, as one ordered checklist (get_vendor_onboarding): what's done, what's next, and what waits on
// someone else, firm-wide and per offering, each step in plain words with the tool that does it. It only reads: every
// step is done with the existing tools (register_firm, invite_user, register_license, review_license,
// create_vendor_offering, run_conformance, update_vendor_offering…), and Mynt decides each one as before.
//
// A step's status: done; next (the first thing the vendor can do now); not_started (theirs to do, after the next one);
// blocked (waiting on Mynt or on a step before it: the detail says which). The first subscriber is informational: it's
// the subscribers' choice, never a step the vendor does, and it never counts towards progress. A figure Mynt doesn't
// measure is null, never 0.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const day = (v: string | null) => (v ? v.slice(0, 10) : null);

export const STEP_STATUSES = ["done", "next", "not_started", "blocked"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
// Who does a step: the vendor's own people, a Mynt admin, or the firms that subscribe.
export type StepActor = "vendor" | "admin" | "subscriber";

export interface OnboardingStep {
  key: string;
  title: string;
  status: StepStatus;
  detail: string;
  tool: string | null; // the MCP tool that does this step
  by: StepActor;
  informational: boolean; // true: shown, never counted (the first subscriber)
  facts: Record<string, unknown>;
}
export interface Progress {
  done: number;
  total: number;
  next: { key: string; title: string; status: StepStatus; tool: string | null; offering_id: string | null } | null;
  complete: boolean;
}

// A step before statuses are settled: done, blocked (with whom it waits on) or still to do.
type Raw = Omit<OnboardingStep, "status"> & { state: "done" | "todo" | "blocked" };
const step = (key: string, title: string, state: Raw["state"], detail: string, tool: string | null, by: StepActor, facts: Record<string, unknown> = {}, informational = false): Raw => ({
  key,
  title,
  state,
  detail,
  tool,
  by,
  informational,
  facts,
});

// The first step still to do becomes next; the rest are not started. Blocked and done steps keep their state.
function settle(raws: Raw[], gate: string | null): OnboardingStep[] {
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

function progressOf(steps: OnboardingStep[], offeringId: string | null = null): Progress {
  const counted = steps.filter((s) => !s.informational);
  const next = counted.find((s) => s.status === "next") ?? counted.find((s) => s.status === "blocked") ?? null;
  const done = counted.filter((s) => s.status === "done").length;
  return {
    done,
    total: counted.length,
    next: next ? { key: next.key, title: next.title, status: next.status, tool: next.tool, offering_id: offeringId } : null,
    complete: done === counted.length,
  };
}

const STATUS_WORDS: Record<string, string> = { suspended: "suspended", under_liquidation: "marked as under liquidation", dissolved: "marked as dissolved", struck_off: "marked as struck off" };

async function vendorMembers(store: Store, entityId: string): Promise<number> {
  const { rows } = await store.db.query(`SELECT count(*)::int AS n FROM ${T}.users WHERE entity_id = $1 AND 'vendor' = ANY(roles)`, [entityId]);
  return Number(rows[0]?.n ?? 0);
}

// The firm-wide steps: the firm on Mynt and active, its people with the vendor role, and a first service.
async function firmSteps(store: Store, entity: Entity | null, offerings: Offering[]): Promise<{ steps: OnboardingStep[]; gate: string | null }> {
  if (!entity) {
    const raws = [
      step("firm_registered", "Your firm is registered with Mynt", "blocked", "Waiting for Mynt to add your firm and you to it.", "register_firm", "admin"),
      step("vendor_members", "People with the vendor role", "blocked", "Waits for your firm to be added.", "invite_user", "admin", { members: null }),
      step("first_service", "Create your first service", "blocked", "Waits for your firm to be added.", "create_vendor_offering", "vendor", { services: null }),
    ];
    return { steps: settle(raws, null), gate: "Waits for your firm to be added." };
  }
  const active = entity.status === "active";
  const members = await vendorMembers(store, entity.id);
  // People Mynt added to the firm with the vendor role who haven't signed in yet: they join when they first do.
  const invited = members > 0 ? 0 : (await store.pendingFirmMembers(entity.id)).filter((p) => p.roles.includes("vendor")).length;
  const gate = active ? null : "Waits for your firm to be active again.";
  const raws = [
    active
      ? step("firm_registered", "Your firm is registered with Mynt", "done", `${entity.name} is registered with Mynt and active.`, "register_firm", "admin", { entity_status: entity.status })
      : step("firm_registered", "Your firm is registered with Mynt", "blocked", `Mynt has ${STATUS_WORDS[entity.status] ?? entity.status} ${entity.name}. Waiting for Mynt to make it active again.`, "set_entity_status", "admin", { entity_status: entity.status }),
    members > 0
      ? step("vendor_members", "People with the vendor role", "done", `${members} ${members === 1 ? "person has" : "people have"} the vendor role at ${entity.name}.`, "invite_user", "admin", { members })
      : invited > 0
        ? step("vendor_members", "People with the vendor role", "blocked", `Mynt invited ${invited} ${invited === 1 ? "person" : "people"} with the vendor role. Waiting for them to sign in: they join ${entity.name} when they do.`, "invite_user", "admin", { members, invited })
        : step("vendor_members", "People with the vendor role", "blocked", "Waiting for Mynt to invite your people with the vendor role.", "invite_user", "admin", { members }),
    offerings.length
      ? step("first_service", "Create your first service", "done", `${offerings.length} ${offerings.length === 1 ? "service" : "services"} created.`, "create_vendor_offering", "vendor", { services: offerings.length })
      : members > 0
        ? step("first_service", "Create your first service", "todo", "Choose a standard service type and give Mynt your test endpoint.", "create_vendor_offering", "vendor", { services: 0 })
        : // Nobody at the firm can create one yet: it isn't offered as the next thing to do.
          step("first_service", "Create your first service", "blocked", "Waits for your firm's people with the vendor role.", "create_vendor_offering", "vendor", { services: 0 }),
  ];
  return { steps: settle(raws, gate), gate };
}

type Run = { run_id: string; passed: boolean; at: string | null; run_by: string | null; failures: { case: string; problems: string[] }[] };
const runOf = (r: Record<string, unknown>): Run => ({
  run_id: r.id as string,
  passed: r.passed === true,
  at: iso(r.created_at),
  run_by: (r.run_by_name as string | null) ?? null,
  failures: ((r.cases as { case: string; passed: boolean; problems: string[] }[] | null) ?? []).filter((c) => !c.passed).map((c) => ({ case: c.case, problems: c.problems ?? [] })),
});
async function conformanceRuns(store: Store, offeringId: string, limit: number): Promise<Run[]> {
  const { rows } = await store.db.query(
    `SELECT r.id, r.passed, r.cases, r.created_at, u.name AS run_by_name FROM ${T}.vendor_conformance_runs r LEFT JOIN ${T}.users u ON u.id = r.run_by
      WHERE r.offering_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [offeringId, limit],
  );
  return rows.map(runOf);
}
async function activeSubscribers(store: Store, offeringId: string): Promise<number> {
  const { rows } = await store.db.query(`SELECT count(DISTINCT entity_id)::int AS n FROM ${T}.vendor_subscriptions WHERE offering_id = $1 AND status = 'active'`, [offeringId]);
  return Number(rows[0]?.n ?? 0);
}

const failureWords = (run: Run) => {
  const problems = run.failures.flatMap((f) => f.problems.map((p) => `${f.case.replace(/_/g, " ")}: ${p}`));
  return problems.length ? `${problems.slice(0, 2).join("; ")}${problems.length > 2 ? ` (and ${problems.length - 2} more)` : ""}` : "it didn't pass";
};

// The licence step, for a service type that needs the vendor to hold one: registered, verified by Mynt, in force and
// named on the offering.
function licenceStep(t: ServiceType, o: Offering, held: HeldLicense[]): Raw {
  const title = "Licence verified by Mynt";
  const types = t.vendor_licences.join(", ");
  const relevant = held.filter((l) => l.region === t.region && t.vendor_licences.includes(l.license_id));
  const facts = { needs_one_of: t.vendor_licences, licences: relevant.map((l) => ({ id: l.id, license_id: l.license_id, registration_number: l.registration_number, status: l.status, in_force: licenseInForce(l), named_on_service: o.licence_ids.includes(l.id) })) };
  const ready = relevant.filter((l) => licenseInForce(l));
  const named = ready.find((l) => o.licence_ids.includes(l.id));
  if (named) return step("licence", title, "done", `Verified and named on this service: ${named.license_id} (${named.registration_number}).`, "register_license", "vendor", facts);
  if (ready.length) return step("licence", title, "todo", `Name your verified licence ${ready[0].license_id} (${ready[0].registration_number}) on this service.`, "update_vendor_offering", "vendor", facts);
  const pending = relevant.find((l) => l.status === "pending");
  if (pending) return step("licence", title, "blocked", `Waiting for Mynt to verify your licence ${pending.license_id} (${pending.registration_number}).`, "review_license", "admin", facts);
  const suspended = relevant.find((l) => l.status === "suspended");
  if (suspended) return step("licence", title, "blocked", `Mynt suspended your licence ${suspended.license_id} (${suspended.registration_number}). Waiting for Mynt to restore it.`, "review_license", "admin", facts);
  const lapsed = relevant.find((l) => l.status === "verified");
  if (lapsed) return step("licence", title, "todo", `Your licence ${lapsed.license_id} isn't in force${lapsed.valid_to ? ` (valid to ${lapsed.valid_to})` : ""}. Register the renewed one.`, "register_license", "vendor", facts);
  const rejected = relevant.find((l) => l.status === "rejected");
  if (rejected) return step("licence", title, "todo", `Mynt didn't verify your licence ${rejected.license_id}${rejected.review_note ? ` ("${rejected.review_note}")` : ""}. Register it again with the right details.`, "register_license", "vendor", facts);
  return step("licence", title, "todo", `${t.name} in ${t.region} needs a licence of one of: ${types}. Register yours for Mynt to verify.`, "register_license", "vendor", facts);
}

export interface OfferingOnboarding {
  offering_id: string;
  name: string;
  region: string;
  service_type: string;
  service_name: string | null;
  status: Offering["status"];
  steps: OnboardingStep[];
  progress: Progress;
}

async function offeringOnboarding(store: Store, o: Offering, held: HeldLicense[], gate: string | null, runs: Run[]): Promise<OfferingOnboarding> {
  const t = await serviceType(store.db, o.region, o.service_type);
  const suspended = o.status === "suspended";
  const suspendedWords = `Mynt suspended this service${o.status_note ? `: ${o.status_note}` : ""}. Waiting for Mynt to reinstate it.`;
  const raws: Raw[] = [
    step("service_created", "Create the service", "done", `${t?.name ?? o.service_type} in ${o.region}.`, "create_vendor_offering", "vendor", { service_type: o.service_type, region: o.region }),
  ];
  const licence = t && t.vendor_licences.length ? licenceStep(t, o, held) : null;
  if (licence) raws.push(licence);
  const ramp = t ? await rampRefusal(store, t, o.entity_id) : null;

  // Conformance: Mynt's own test of the endpoint, latest run first.
  const last = runs[0] ?? null;
  const conformanceFacts = { last_run: last };
  const passedNow = o.status === "conformance_passed" || o.status === "listed";
  if (suspended) raws.push(step("conformance", "Pass Mynt's conformance test", "blocked", suspendedWords, "suspend_vendor_offering", "admin", conformanceFacts));
  else if (ramp) raws.push(step("conformance", "Pass Mynt's conformance test", "blocked", `${ramp}.`, "set_mynt_ramp", "admin", conformanceFacts));
  else if (last?.passed && passedNow) raws.push(step("conformance", "Pass Mynt's conformance test", "done", `Passed on ${day(last.at)}.`, "run_conformance", "vendor", conformanceFacts));
  else if (licence && licence.state === "blocked") raws.push(step("conformance", "Pass Mynt's conformance test", "blocked", "Waits for Mynt to verify your licence first.", "run_conformance", "vendor", conformanceFacts));
  else if (!last) raws.push(step("conformance", "Pass Mynt's conformance test", "todo", "Mynt hasn't tested your endpoint yet. Run the conformance test.", "run_conformance", "vendor", conformanceFacts));
  else if (last.passed) raws.push(step("conformance", "Pass Mynt's conformance test", "todo", `It passed on ${day(last.at)}, but the endpoint or licences changed since. Run it again.`, "run_conformance", "vendor", conformanceFacts));
  else raws.push(step("conformance", "Pass Mynt's conformance test", "todo", `The last run on ${day(last.at)} failed: ${failureWords(last)}. Fix your endpoint and run it again.`, "run_conformance", "vendor", conformanceFacts));

  // Standard terms: what subscribers accept in the Marketplace.
  const termsFacts = { terms_version: o.terms?.version ?? null, set_at: o.terms?.set_at ?? null, scopes: o.terms?.scopes ?? [] };
  // Terms from before scopes were recorded: they stand (agreements made on them keep no scopes), but new terms name them.
  if (o.terms && !o.terms.scopes.length && !suspended)
    raws.push(
      step(
        "terms",
        "Set your standard terms",
        "todo",
        `Version ${o.terms.version} doesn't say what it covers. Set new terms with their scope (technology, manpower or financial regulatory operations); agreements already made keep version ${o.terms.version}.`,
        "update_vendor_offering",
        "vendor",
        termsFacts,
      ),
    );
  else if (o.terms) raws.push(step("terms", "Set your standard terms", "done", `Version ${o.terms.version}, set on ${day(o.terms.set_at) ?? "an earlier date"}${o.terms.scopes.length ? `. Scope: ${o.terms.scopes.map(agreementScopeLabel).join(", ")}` : ""}.`, "update_vendor_offering", "vendor", termsFacts));
  else if (suspended) raws.push(step("terms", "Set your standard terms", "blocked", suspendedWords, "suspend_vendor_offering", "admin", termsFacts));
  else if (o.status === "listed")
    // Listed before any terms were set: the same gap, said the same way on both steps.
    raws.push(
      step(
        "terms",
        "Set your standard terms",
        "todo",
        "It's listed without standard terms: app teams see it in the Marketplace and can't subscribe until you set them, with their scope (technology, manpower or financial regulatory operations).",
        "update_vendor_offering",
        "vendor",
        termsFacts,
      ),
    );
  else raws.push(step("terms", "Set your standard terms", "todo", "No standard terms yet: set them with their scope (technology, manpower or financial regulatory operations). App teams can't subscribe from the Marketplace without them.", "update_vendor_offering", "vendor", termsFacts));

  // Listing.
  const listedFacts = { offering_status: o.status };
  if (o.status === "listed")
    raws.push(step("listed", "List the service", "done", o.terms ? "Listed in the Marketplace." : "Listed in the Marketplace, without standard terms: app teams can't subscribe until you set them.", "update_vendor_offering", "vendor", listedFacts));
  else if (suspended) raws.push(step("listed", "List the service", "blocked", suspendedWords, "suspend_vendor_offering", "admin", listedFacts));
  else if (o.status === "conformance_passed") raws.push(step("listed", "List the service", "todo", "It passed Mynt's test: list it in the Marketplace.", "update_vendor_offering", "vendor", listedFacts));
  else raws.push(step("listed", "List the service", "todo", "List it once it passes Mynt's conformance test.", "update_vendor_offering", "vendor", listedFacts));

  // The first subscriber: theirs to choose, shown for information.
  const subscribers = await activeSubscribers(store, o.id);
  raws.push(
    subscribers > 0
      ? step("first_subscriber", "First subscriber", "done", `${subscribers} ${subscribers === 1 ? "firm subscribes" : "firms subscribe"}.`, "subscribe_vendor_service", "subscriber", { subscribers }, true)
      : step("first_subscriber", "First subscriber", "todo", o.status === "listed" && !o.terms ? "No subscribers yet. App teams can subscribe from the Marketplace once you set standard terms." : "No subscribers yet. App teams subscribe from the Marketplace once it's listed with standard terms.", "subscribe_vendor_service", "subscriber", { subscribers }, true),
  );

  const steps = settle(raws, gate);
  return { offering_id: o.id, name: o.name, region: o.region, service_type: o.service_type, service_name: t?.name ?? null, status: o.status, steps, progress: progressOf(steps, o.id) };
}

// Every version of an offering's standard terms Mynt knows: the current one in full, earlier ones from the audit log
// (version, SHA-256, when, by whom) and from the agreements that accepted them (each keeps its own copy).
async function termsVersions(store: Store, o: Offering) {
  type V = { version: number; current: boolean; document_url: string | null; document_sha256: string | null; summary: string | null; pricing_summary: string | null; scopes: string[] | null; set_at: string | null; set_by: string | null; agreements: number };
  const by = new Map<number, V>();
  const get = (version: number): V => {
    let v = by.get(version);
    if (!v) by.set(version, (v = { version, current: false, document_url: null, document_sha256: null, summary: null, pricing_summary: null, scopes: null, set_at: null, set_by: null, agreements: 0 }));
    return v;
  };
  const audits = await store.db.query(
    `SELECT a.details, a.created_at, u.name AS actor FROM ${T}.audit_log a LEFT JOIN ${T}.users u ON u.id = a.actor_id WHERE a.action = 'set_vendor_terms' AND a.target = $1 ORDER BY a.created_at`,
    [o.id],
  );
  for (const r of audits.rows) {
    const d = (r.details ?? {}) as { version?: unknown; document_sha256?: unknown; scopes?: unknown };
    if (typeof d.version !== "number") continue;
    const v = get(d.version);
    v.document_sha256 ??= typeof d.document_sha256 === "string" ? d.document_sha256 : null;
    v.scopes ??= Array.isArray(d.scopes) ? (d.scopes as string[]) : null;
    v.set_at = iso(r.created_at);
    v.set_by = (r.actor as string | null) ?? null;
  }
  const agreed = await store.db.query(
    `SELECT terms_version, document_url, document_sha256, terms_summary, pricing_summary, scopes, counterparty_signed_at, count(*)::int AS n FROM ${T}.app_agreements
      WHERE offering_id = $1 AND terms_version IS NOT NULL GROUP BY terms_version, document_url, document_sha256, terms_summary, pricing_summary, scopes, counterparty_signed_at`,
    [o.id],
  );
  for (const r of agreed.rows) {
    const v = get(Number(r.terms_version));
    v.document_url ??= (r.document_url as string | null) ?? null;
    v.document_sha256 ??= (r.document_sha256 as string | null) ?? null;
    v.summary ??= (r.terms_summary as string | null) ?? null;
    v.pricing_summary ??= (r.pricing_summary as string | null) ?? null;
    v.scopes ??= (r.scopes as string[] | null) ?? null;
    v.set_at ??= iso(r.counterparty_signed_at);
    v.agreements += Number(r.n ?? 0);
  }
  if (o.terms) {
    const v = get(o.terms.version);
    Object.assign(v, { current: true, document_url: o.terms.document_url, document_sha256: o.terms.document_sha256, summary: o.terms.summary, pricing_summary: o.terms.pricing_summary, scopes: o.terms.scopes, set_at: o.terms.set_at ?? v.set_at });
  }
  return [...by.values()].sort((a, b) => b.version - a.version);
}

export async function vendorOnboarding(store: Store, entityId: string | null, opts: { offering_id?: string; history?: boolean } = {}) {
  const entity = entityId ? ((await store.getEntity(entityId)) ?? null) : null;
  const all = entity ? await offeringsOf(store.db, entity.id) : [];
  const offerings = opts.offering_id ? all.filter((o) => o.id === opts.offering_id) : all;
  const held = entity ? await store.licensesOf(entity.id) : [];
  const firm = await firmSteps(store, entity, all);
  const out: OfferingOnboarding[] = [];
  const history: Record<string, unknown>[] = [];
  for (const o of offerings) {
    const runs = await conformanceRuns(store, o.id, opts.history ? 20 : 1);
    out.push(await offeringOnboarding(store, o, held, firm.gate, runs));
    if (opts.history) history.push({ offering_id: o.id, conformance_runs: runs, terms_versions: await termsVersions(store, o) });
  }
  // The firm's overall progress: its own steps and every offering's, and the first thing to do (firm first).
  const steps = [...firm.steps, ...out.flatMap((o) => o.steps)];
  const counted = steps.filter((s) => !s.informational);
  const firmNext = progressOf(firm.steps).next;
  const offeringNexts = out.map((o) => o.progress.next).filter((n) => n !== null);
  const next = firmNext ?? offeringNexts.find((n) => n.status === "next") ?? offeringNexts[0] ?? null;
  const done = counted.filter((s) => s.status === "done").length;
  return {
    entity: entity ? { id: entity.id, name: entity.name, status: entity.status } : null,
    firm_steps: firm.steps,
    offerings: out,
    progress: {
      done,
      total: counted.length,
      next,
      complete: done === counted.length,
    } satisfies Progress,
    ...(opts.history ? { history } : {}),
  };
}
// Firms that are vendors: one with a member holding the vendor role (or one invited with it who hasn't signed in yet),
// or with an offering.
export async function vendorFirms(store: Store) {
  const { rows } = await store.db.query(
    `SELECT e.id FROM ${T}.entities e WHERE EXISTS (SELECT 1 FROM ${T}.users u WHERE u.entity_id = e.id AND 'vendor' = ANY(u.roles))
        OR EXISTS (SELECT 1 FROM ${T}.firm_pending_members p JOIN ${T}.invites i ON i.email = p.email WHERE p.entity_id = e.id AND 'vendor' = ANY(i.roles))
        OR EXISTS (SELECT 1 FROM ${T}.vendor_offerings o WHERE o.entity_id = e.id) ORDER BY e.name, e.id`,
  );
  const firms = [];
  for (const r of rows) {
    const o = await vendorOnboarding(store, r.id as string);
    const members = o.firm_steps.find((s) => s.key === "vendor_members")?.facts.members ?? null;
    firms.push({ entity_id: o.entity!.id, name: o.entity!.name, status: o.entity!.status, vendor_members: members, services: o.offerings.length, listed: o.offerings.filter((x) => x.status === "listed").length, progress: o.progress });
  }
  return firms;
}

export function registerVendorOnboardingTools(server: McpServer, store: Store, user: User, opts: { admin?: boolean } = {}) {
  server.registerTool(
    "get_vendor_onboarding",
    {
      title: "Where a vendor's onboarding stands",
      description:
        "Vendor (your own firm) or admin (any firm, with entity_id; every vendor firm's progress, with all_firms): the ordered onboarding checklist, firm-wide and per offering, each step done, next, not_started or blocked (waiting on Mynt or an earlier step), in plain words with the tool that does it: the firm registered and active, people with the vendor role, a first service, the licence the service type needs (registered and verified by Mynt), the offering (service type, region), Mynt's conformance test (latest run, when, failures), standard terms (version), listed, and the first subscriber (informational, never counted). offering_id narrows it to one offering and adds its history: conformance runs and terms versions. It only reads; a figure Mynt doesn't measure is null.",
      inputSchema: {
        entity_id: z.string().uuid().optional().describe("Admins: the vendor's firm. Vendors may omit it (their own firm)."),
        offering_id: z.string().uuid().optional().describe("One offering, with its conformance runs and terms versions"),
        all_firms: z.literal(true).optional().describe("Admins: every vendor firm's progress"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entity_id, offering_id, all_firms }) => {
      const me = (await store.getUser(user.id)) ?? user;
      const roles = effectiveRoles(me.roles);
      const admin = opts.admin === true && roles.includes("admin");
      // A firm member with the vendor role granted (an admin only implies it).
      const vendor = me.roles.includes("vendor");
      if (all_firms) {
        if (!admin) return fail("Only Mynt admins see every vendor firm");
        return json({ firms: await vendorFirms(store) });
      }
      let entityId = entity_id ?? null;
      if (offering_id) {
        const o = await getOffering(store.db, offering_id);
        if (!o || (entityId && o.entity_id !== entityId)) return fail(`No offering '${offering_id}'${entityId ? " at that firm" : ""}`);
        entityId = o.entity_id;
      }
      if (entityId === null) {
        if (!vendor) return fail("Name the vendor's firm (entity_id), or all_firms: true");
        entityId = me.entity_id;
      }
      // A vendor reads its own firm only; an admin any firm.
      if (!admin && (!vendor || entityId !== me.entity_id)) return fail(offering_id ? `No offering of yours '${offering_id}'` : "You can only see your own firm's onboarding");
      if (entityId && !(await store.getEntity(entityId))) return fail(`No firm '${entityId}'`);
      return json(await vendorOnboarding(store, entityId, { offering_id, history: Boolean(offering_id) }));
    },
  );
}
