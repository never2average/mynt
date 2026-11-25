// My services (/vendor): a service provider's own area in the studio, for accounts with Mynt's vendor role. Pure: Mynt's
// replies (get_vendor_onboarding, list_my_offerings, list_my_subscribers, list_service_types, get_my_entity) into what
// the page shows, each step's status in words and the action the studio offers for it, the CSV, and the SHA-256 of a
// standard terms document (computed in the browser, from the file itself). Mynt decides every step; nothing here does.
import { scopeLabelOf, scopesOf, type AgreementScope } from "./app-panel";
import { toCsv } from "./compliance";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The vendor role, as Mynt's whoami gives it. */
export const isVendor = (roles: readonly string[]) => roles.includes("vendor");

// ---- the onboarding checklist ----

export type StepStatus = "done" | "next" | "not_started" | "blocked";
export const STEP_STATUSES: readonly StepStatus[] = ["done", "next", "not_started", "blocked"];
/** A step's status in words (shown with its mark, never as colour alone). */
export const STEP_STATUS_WORDS: Record<StepStatus, string> = { done: "Done", next: "Do this next", not_started: "Not started", blocked: "Waiting" };

/** What the studio can do for a step: open one of the area's sheets. Steps only Mynt can do have none. */
export type StepAction = "create" | "edit" | "terms" | "conformance" | "list";
export const STEP_ACTION_LABELS: Record<StepAction, string> = {
  create: "Create service",
  edit: "Edit service",
  terms: "Set standard terms",
  conformance: "Run conformance",
  list: "List service",
};

export type Step = {
  key: string;
  title: string;
  status: StepStatus;
  detail: string;
  tool: string | null;
  by: "vendor" | "admin" | "subscriber";
  informational: boolean;
  facts: Obj;
};
export type Progress = { done: number; total: number; next: { key: string; title: string; status: StepStatus; offeringId: string | null } | null; complete: boolean };
export type OfferingChecklist = { offeringId: string; name: string; region: string; serviceType: string; serviceName: string | null; status: string; steps: Step[]; progress: Progress };
export type ConformanceRun = { runId: string; passed: boolean; at: string | null; runBy: string | null; failures: { case: string; problems: string[] }[] };
// scopes: null when Mynt doesn't know them for that version (an earlier one nobody accepted), [] for one from before
// scopes were recorded.
export type TermsVersion = { version: number; current: boolean; documentUrl: string | null; documentSha256: string | null; summary: string | null; pricing: string | null; scopes: AgreementScope[] | null; setAt: string | null; setBy: string | null; agreements: number | null };
export type Onboarding = {
  entity: { id: string; name: string; status: string } | null;
  firmSteps: Step[];
  offerings: OfferingChecklist[];
  progress: Progress;
  history: { offeringId: string; runs: ConformanceRun[]; termsVersions: TermsVersion[] }[];
};

const stepOf = (s: Obj): Step | null => {
  const key = str(s.key);
  const status = str(s.status) as StepStatus | null;
  if (!key || !status || !STEP_STATUSES.includes(status)) return null;
  const by = s.by === "admin" || s.by === "subscriber" ? s.by : "vendor";
  return { key, title: str(s.title) ?? key, status, detail: str(s.detail) ?? "", tool: str(s.tool), by, informational: s.informational === true, facts: isObj(s.facts) ? s.facts : {} };
};
const stepsOf = (v: unknown) => arr(v).filter(isObj).map(stepOf).filter((s): s is Step => s !== null);
export const progressOf = (p: unknown): Progress => {
  const o = isObj(p) ? p : {};
  const n = isObj(o.next) ? o.next : null;
  const status = n ? (str(n.status) as StepStatus | null) : null;
  return {
    done: num(o.done) ?? 0,
    total: num(o.total) ?? 0,
    next: n && str(n.key) ? { key: str(n.key)!, title: str(n.title) ?? str(n.key)!, status: status && STEP_STATUSES.includes(status) ? status : "next", offeringId: str(n.offering_id) } : null,
    complete: o.complete === true,
  };
};
const runOf = (r: Obj): ConformanceRun | null =>
  str(r.run_id)
    ? {
        runId: str(r.run_id)!,
        passed: r.passed === true,
        at: str(r.at),
        runBy: str(r.run_by),
        failures: arr(r.failures)
          .filter(isObj)
          .map((f) => ({ case: str(f.case) ?? "case", problems: arr(f.problems).map(str).filter((p): p is string => Boolean(p)) })),
      }
    : null;

export function fromOnboarding(reply: unknown): Onboarding | null {
  if (!isObj(reply) || !Array.isArray(reply.firm_steps)) return null;
  const e = isObj(reply.entity) ? reply.entity : null;
  return {
    entity: e && str(e.id) ? { id: str(e.id)!, name: str(e.name) ?? "Your firm", status: str(e.status) ?? "active" } : null,
    firmSteps: stepsOf(reply.firm_steps),
    offerings: arr(reply.offerings)
      .filter(isObj)
      .flatMap((o): OfferingChecklist[] =>
        str(o.offering_id)
          ? [{ offeringId: str(o.offering_id)!, name: str(o.name) ?? "Service", region: str(o.region) ?? "—", serviceType: str(o.service_type) ?? "", serviceName: str(o.service_name), status: str(o.status) ?? "draft", steps: stepsOf(o.steps), progress: progressOf(o.progress) }]
          : [],
      ),
    progress: progressOf(reply.progress),
    history: arr(reply.history)
      .filter(isObj)
      .flatMap((h) =>
        str(h.offering_id)
          ? [
              {
                offeringId: str(h.offering_id)!,
                runs: arr(h.conformance_runs).filter(isObj).map(runOf).filter((r): r is ConformanceRun => r !== null),
                termsVersions: arr(h.terms_versions)
                  .filter(isObj)
                  .flatMap((v) =>
                    num(v.version) !== null
                      ? [{ version: num(v.version)!, current: v.current === true, documentUrl: str(v.document_url), documentSha256: str(v.document_sha256), summary: str(v.summary), pricing: str(v.pricing_summary), scopes: Array.isArray(v.scopes) ? scopesOf(v.scopes) : null, setAt: str(v.set_at), setBy: str(v.set_by), agreements: num(v.agreements) }]
                      : [],
                  ),
              },
            ]
          : [],
      ),
  };
}

/**
 * The studio's action for a step, where the vendor can take it now: the first service (Create service), naming a
 * licence on the service (Edit service), Mynt's test (Run conformance), standard terms (Set standard terms, at any
 * time before they're set) and listing (List service, once it passed). Steps only Mynt or subscribers can do, and
 * steps already done, have none.
 */
export function stepAction(step: Step): StepAction | null {
  if (step.status === "done" || step.status === "blocked" || step.by !== "vendor") return null;
  switch (step.key) {
    case "first_service":
      return "create";
    case "licence":
      return step.tool === "update_vendor_offering" ? "edit" : null; // registering a licence stays with the MCP tool
    case "conformance":
      return "conformance";
    case "terms":
      return "terms";
    case "listed":
      return step.status === "next" ? "list" : null;
    default:
      return null;
  }
}

/** What a step waiting on Mynt says, from the vendor's side: its own detail ("Waiting for Mynt to verify your licence …"). */
export const stepWords = (s: Step) => `${STEP_STATUS_WORDS[s.status]}: ${s.detail}`;

/** Progress in words: "4 of 6 steps done", or "Done: every step" when complete. Never a count Mynt didn't give. */
export function progressWords(p: Progress): string {
  if (!p.total) return "No steps yet";
  if (p.complete) return `All ${p.total} steps done`;
  return `${p.done} of ${p.total} steps done`;
}

// ---- the firm's services ----

export type VendorOffering = {
  id: string;
  name: string;
  region: string;
  serviceKey: string;
  status: string;
  testBaseUrl: string;
  liveBaseUrl: string | null;
  price: { amount: number; currency: string } | null;
  slaNotes: string;
  licenceIds: string[];
  requiresCredential: boolean;
  statusNote: string | null;
  // scopes: what the terms cover; none on a terms version from before scopes were recorded (scopeLabel "Not set").
  terms: { version: number; documentUrl: string; documentSha256: string; summary: string; pricing: string; scopes: AgreementScope[]; scopeLabel: string; setAt: string | null } | null;
  lastConformance: { passed: boolean; at: string | null } | null;
  subscribers: number | null; // null: Mynt didn't say
  createdAt: string | null;
};

export function fromMyOfferings(reply: unknown): VendorOffering[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((o): VendorOffering[] => {
      const id = str(o.id);
      if (!id) return [];
      const t = isObj(o.terms) ? o.terms : null;
      const p = isObj(o.price) && num(o.price.amount) !== null && str(o.price.currency) ? { amount: num(o.price.amount)!, currency: str(o.price.currency)! } : null;
      const c = isObj(o.last_conformance) ? { passed: o.last_conformance.passed === true, at: str(o.last_conformance.at) } : null;
      return [
        {
          id,
          name: str(o.name) ?? "Service",
          region: str(o.region) ?? "—",
          serviceKey: str(o.service_type) ?? "",
          status: str(o.status) ?? "draft",
          testBaseUrl: str(o.test_base_url) ?? "",
          liveBaseUrl: str(o.live_base_url),
          price: p,
          slaNotes: str(o.sla_notes) ?? "",
          licenceIds: arr(o.licence_ids).map(str).filter((x): x is string => Boolean(x)),
          requiresCredential: o.requires_credential === true,
          statusNote: str(o.status_note),
          terms:
            t && num(t.version) !== null
              ? {
                  version: num(t.version)!,
                  documentUrl: str(t.document_url) ?? "",
                  documentSha256: str(t.document_sha256) ?? "",
                  summary: str(t.summary) ?? "",
                  pricing: str(t.pricing_summary) ?? "",
                  scopes: scopesOf(t.scopes),
                  scopeLabel: scopeLabelOf(scopesOf(t.scopes)),
                  setAt: str(t.set_at),
                }
              : null,
          lastConformance: c,
          subscribers: num(o.subscribers),
          createdAt: str(o.created_at),
        },
      ];
    });
}

/** An offering's status in words. */
export const OFFERING_STATUS_WORDS: Record<string, string> = { draft: "Draft", conformance_passed: "Passed, not listed", listed: "Listed", suspended: "Suspended by Mynt" };
export const offeringStatusWords = (s: string) => OFFERING_STATUS_WORDS[s] ?? s;
export function conformanceWords(c: VendorOffering["lastConformance"]): string {
  if (!c) return "Not run yet";
  return `${c.passed ? "Passed" : "Failed"}${c.at ? ` ${c.at.slice(0, 10)}` : ""}`;
}
export const priceWords = (p: VendorOffering["price"]) =>
  p ? `${new Intl.NumberFormat("en-US", { style: "currency", currency: p.currency, maximumFractionDigits: 4 }).format(p.amount)} per call` : "Not stated";

export type ServiceTypeOption = { region: string; key: string; name: string; category: string; vendorLicences: string[] };
export function serviceTypeOptions(reply: unknown): ServiceTypeOption[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((t) =>
      str(t.region) && str(t.key)
        ? [{ region: str(t.region)!, key: str(t.key)!, name: str(t.name) ?? str(t.key)!, category: str(t.category) ?? "other", vendorLicences: arr(t.vendor_licences).map(str).filter((x): x is string => Boolean(x)) }]
        : [],
    );
}
export type LicenceOption = { id: string; region: string; licenceType: string; number: string; status: string };
export function licenceOptions(entity: unknown): LicenceOption[] {
  if (!isObj(entity)) return [];
  return arr(entity.licenses)
    .filter(isObj)
    .flatMap((l) => (str(l.id) ? [{ id: str(l.id)!, region: str(l.region) ?? "", licenceType: str(l.license_id) ?? "Licence", number: str(l.registration_number) ?? "", status: str(l.status) ?? "pending" }] : []));
}

export type Subscriber = { subscriptionId: string; subscriber: string; status: string; live: boolean; since: string | null; termsVersions: number[]; calls: number | null };
export function fromSubscribers(reply: unknown): Subscriber[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((s) =>
      str(s.subscription_id)
        ? [
            {
              subscriptionId: str(s.subscription_id)!,
              subscriber: str(s.subscriber) ?? "A firm",
              status: str(s.status) ?? "active",
              live: s.live === true,
              since: str(s.created_at),
              termsVersions: [...new Set(arr(s.terms_accepted).filter(isObj).map((a) => num(a.terms_version)).filter((v): v is number => v !== null))].sort((a, b) => a - b),
              calls: isObj(s.usage) ? num(s.usage.calls) : null,
            },
          ]
        : [],
    );
}

export function offeringsCsv(rows: VendorOffering[]): string {
  return toCsv(
    ["Service", "Type", "Region", "Status", "Conformance", "Terms version", "Listed", "Subscribers"],
    rows.map((o) => [o.name, o.serviceKey, o.region, offeringStatusWords(o.status), conformanceWords(o.lastConformance), o.terms ? `v${o.terms.version}` : "None", o.status === "listed" ? "Yes" : "No", o.subscribers === null ? "Not known" : String(o.subscribers)]),
  );
}

// ---- standard terms: the document's SHA-256 ----

const SHA256 = /^[a-f0-9]{64}$/;
/** A pasted SHA-256, lower-cased, or null when it isn't 64 hex characters. */
export function sha256Of(text: string): string | null {
  const t = text.trim().toLowerCase();
  return SHA256.test(t) ? t : null;
}
/** The SHA-256 of a file's bytes, as 64 lowercase hex characters (Web Crypto, in the browser; never sent anywhere). */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const isHttpsUrl = (u: string) => {
  try {
    return new URL(u.trim()).protocol === "https:";
  } catch {
    return false;
  }
};
