// Services: the third kind of thing built on Mynt, beside apps and financial products. A service is a vendor service
// its firm builds, verifies and hosts with the same machinery as an app (the builder chat, builds, hosting, the
// Idea → Staging → Production stages) and lists in the Marketplace. Mynt keeps it as an app record of kind "service"
// with one vendor offering made with it, so its id is an app id wherever builds, hosting and promotions take one.
//
// Pure: Mynt's replies (get_service, list_my_services, list_service_types, list_service_type_requests) into what the
// studio shows, the checklist's labelled actions, and the schema an admin starts from when defining a requested
// service type. A figure Mynt doesn't measure stays null with its reason; nothing here turns it into 0.
import { z } from "zod";
import { scopeLabelOf, scopesOf, type AgreementScope } from "./app-panel";
import { STEP_STATUSES, type Step, type StepStatus, type TermsVersion, type VendorOffering } from "./vendor-area";
import { STAGES, type Stage } from "./workspaces";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const stage = (v: unknown): Stage => (STAGES.includes(v as Stage) ? (v as Stage) : "idea");

export const serviceHref = (id: string, buildId?: string | null) => `/services/${encodeURIComponent(id)}${buildId ? `/${encodeURIComponent(buildId)}` : ""}`;

/** The service whose workspace a path is (/services/<id>, /services/<id>/<build id>), if it is one. */
export function serviceIdOfPath(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "services" || !parts[1]) return undefined;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return parts[1];
  }
}

export const NEEDS_VENDOR_ROLE = "Ask a Mynt admin for the vendor role";
export const SERVICE_ENDPOINT_PENDING = "Set by Mynt when the service is online";
export const NOT_MEASURED = "Not measured";
export const NOT_RECORDED = "Not recorded";

// ---- the three types the Build page makes ----

export const BUILD_TYPES = ["app", "product", "service"] as const;
export type BuildType = (typeof BUILD_TYPES)[number];
export const BUILD_TYPE_LABELS: Record<BuildType, string> = { app: "App", product: "Financial product", service: "Service" };
export const BUILD_TYPE_DESCRIPTIONS: Record<BuildType, string> = {
  app: "An app for customers, built on financial products",
  product: "A regulated product composed from primitives",
  service: "A service other builders plug in, listed in the Marketplace",
};
export const isBuildType = (v: unknown): v is BuildType => BUILD_TYPES.includes(v as BuildType);
export const BUILD_TYPE_KEY = "mynt_studio_build_type";

/** The type the address names (?type=app|product|service), if it names one. */
export function buildTypeFromSearch(search: string): BuildType | null {
  const v = new URLSearchParams(search).get("type");
  return isBuildType(v) ? v : null;
}
/** The last type picked in this browser, or null (nothing kept, or storage blocked: the page works without it). */
export function rememberedBuildType(): BuildType | null {
  try {
    const v = window.localStorage.getItem(BUILD_TYPE_KEY);
    return isBuildType(v) ? v : null;
  } catch {
    return null;
  }
}
export function rememberBuildType(type: BuildType) {
  try {
    window.localStorage.setItem(BUILD_TYPE_KEY, type);
  } catch {
    // private window or blocked storage: it just isn't remembered
  }
}

// ---- service types, as the Build page's picker lists them ----

export type ServiceTypeChoice = { region: string; key: string; name: string; category: string; description: string; vendorLicences: string[] };
export function serviceTypeChoices(reply: unknown): ServiceTypeChoice[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((t) =>
      str(t.region) && str(t.key)
        ? [
            {
              region: str(t.region)!,
              key: str(t.key)!,
              name: str(t.name) ?? str(t.key)!,
              category: str(t.category) ?? "other",
              description: str(t.description) ?? "",
              vendorLicences: arr(t.vendor_licences).map(str).filter((x): x is string => Boolean(x)),
            },
          ]
        : [],
    );
}
export const typeChoiceId = (t: Pick<ServiceTypeChoice, "region" | "key">) => `${t.region}/${t.key}`;
/** A service type's licence prerequisite, in words. */
export const licencePrerequisite = (t: Pick<ServiceTypeChoice, "vendorLicences">) => (t.vendorLicences.length ? `Needs one of: ${t.vendorLicences.join(", ")}` : "No licence needed");

// ---- creating one ----

export const NewServiceRequest = z
  .object({
    prompt: z.string().trim().min(10, "Say a little more about what to build (at least 10 characters).").max(4000),
    service_type: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, "Pick a service type."),
    region: z.string().regex(/^[A-Z]{2}$/, "Pick a service type."),
  })
  .strict();
export type NewServiceRequest = z.infer<typeof NewServiceRequest>;

export const NO_SERVICE_TYPE = "Pick a service type to build.";
/** The composer's reason a service can't be sent yet. */
export function serviceBlockedReason(vendor: boolean, typeId: string | null, text = ""): string | null {
  if (!vendor) return NEEDS_VENDOR_ROLE;
  if (!typeId) return NO_SERVICE_TYPE;
  const typed = text.trim().length;
  return typed > 0 && typed < 10 ? "Say a little more about what to build (at least 10 characters)." : null;
}

/** The page's submit: creates the service through /api/services and opens its workspace (on its first build when it started). */
export async function submitNewService(request: NewServiceRequest, deps: { fetch: typeof fetch; navigate: (path: string) => void }): Promise<string | null> {
  let res: Response;
  try {
    res = await deps.fetch("/api/services", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } catch {
    return "Couldn't reach the studio. Check your connection.";
  }
  const data = (await res.json().catch(() => null)) as { serviceId?: string; buildId?: string | null; message?: string } | null;
  if (!res.ok || !data?.serviceId) return data?.message ?? "Couldn't create the service. Please try again.";
  deps.navigate(serviceHref(data.serviceId, data.buildId));
  return null;
}

// ---- asking Mynt for a service type ----

/** A JSON object typed into a field, or why it isn't one. */
export function jsonObjectOf(text: string): { ok: true; value: Obj } | { ok: false; error: string } {
  try {
    const v = JSON.parse(text) as unknown;
    return isObj(v) ? { ok: true, value: v } : { ok: false, error: "It must be a JSON object, like { \"name\": \"Ada\" }." };
  } catch {
    return { ok: false, error: "That isn't valid JSON." };
  }
}

export type TypeRequestStatus = "requested" | "defined" | "declined";
export type ServiceTypeRequest = {
  id: string;
  name: string;
  region: string;
  whatItDoes: string;
  exampleInput: Obj;
  exampleOutput: Obj;
  status: TypeRequestStatus;
  statusWords: string;
  decisionNote: string | null;
  serviceTypeKey: string | null;
  requestedBy: string | null;
  firm: string | null;
  requestedAt: string | null;
  decidedAt: string | null;
};
const REQUEST_WORDS: Record<TypeRequestStatus, string> = { requested: "Waiting for Mynt", defined: "Defined", declined: "Declined" };
export function typeRequestsFrom(reply: unknown): ServiceTypeRequest[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((r): ServiceTypeRequest[] => {
      const id = str(r.id);
      if (!id) return [];
      const status: TypeRequestStatus = r.status === "defined" || r.status === "declined" ? r.status : "requested";
      return [
        {
          id,
          name: str(r.name) ?? "Service type",
          region: str(r.region) ?? "—",
          whatItDoes: str(r.what_it_does) ?? "",
          exampleInput: isObj(r.example_input) ? r.example_input : {},
          exampleOutput: isObj(r.example_output) ? r.example_output : {},
          status,
          statusWords: str(r.status_words) ?? REQUEST_WORDS[status],
          decisionNote: str(r.decision_note),
          serviceTypeKey: str(r.service_type_key),
          requestedBy: isObj(r.requested_by) ? str(r.requested_by.name) : null,
          firm: isObj(r.firm) ? str(r.firm.name) : null,
          requestedAt: str(r.requested_at),
          decidedAt: str(r.decided_at),
        },
      ];
    });
}

const jsonType = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v === "boolean" ? "boolean" : typeof v === "object" ? "object" : "string");
/** The least a JSON Schema can say about an example: an object, each of its keys a property of the type it has there. For an admin to edit. */
export function schemaFromExample(example: Obj): Obj {
  return { type: "object", properties: Object.fromEntries(Object.entries(example).map(([k, v]) => [k, { type: jsonType(v) }])), required: Object.keys(example) };
}
/** A service type's key from its name: lower case, underscores ("Proof of address" is proof_of_address). */
export const keyFromName = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "s_$1")
    .slice(0, 60);

// ---- the user's services, as the sidebar and search list them ----

export type ServiceItem = { id: string; name: string; description: string; stage: Stage; archived: boolean; typeKey: string; typeName: string; region: string; offeringId: string | null; statusWords: string; online: boolean; updatedAt: string | null };
export function servicesFrom(reply: unknown): ServiceItem[] {
  return arr(reply)
    .filter(isObj)
    .flatMap((s): ServiceItem[] => {
      const id = str(s.id);
      if (!id) return [];
      const t = isObj(s.service_type) ? s.service_type : {};
      return [
        {
          id,
          name: str(s.name) ?? "Untitled service",
          description: str(s.description) ?? "",
          stage: stage(s.stage),
          archived: s.archived === true,
          typeKey: str(t.key) ?? "",
          typeName: str(t.name) ?? str(t.key) ?? "Service",
          region: str(t.region) ?? "—",
          offeringId: str(s.offering_id),
          statusWords: str(s.status_words) ?? "",
          online: s.online === true,
          updatedAt: str(s.updated_at),
        },
      ];
    });
}
/** Whether one of list_my_apps' records is a service (kind "service"): never an app. */
export const isServiceRecord = (a: unknown) => isObj(a) && a.kind === "service";

// ---- one service, whole (get_service) ----

export type ServiceField = { field: string; type: string; required: boolean; description: string };
export type RunCase = { case: string; passed: boolean; httpStatus: number | null; problems: string[] };
export type ServiceRun = {
  runId: string;
  kind: "conformance" | "practice";
  passed: boolean;
  at: string | null;
  runBy: string | null;
  failures: { case: string; problems: string[] }[];
  cases: RunCase[] | null; // null: Mynt keeps only a practice run's failures
  passedCases: number | null;
  totalCases: number | null;
};
/** A figure Mynt measures, or null with why it doesn't. Never 0 for want of a measurement. */
export type Measured = { value: number | null; notMeasured: string | null };
export type ServiceSubscriber = { subscriptionId: string; firm: string; appName: string | null; termsVersion: number | null; since: string | null; environment: "Live" | "Sandbox"; subscriptionStatus: string; agreementStatus: string | null };
export type ServiceContract = {
  endpoint: { method: string; path: string; address: string | null; note: string };
  signature: { header: string; format: string; algorithm: string; toleranceSeconds: number | null; compare: string; refuseWith: number | null; secretSetting: string; rule: string };
  limits: string;
  inputFields: ServiceField[];
  paramsFields: ServiceField[];
  outputFields: ServiceField[];
  fixtures: unknown[];
  exampleOutput: unknown;
};
export type ServiceView = {
  id: string;
  name: string;
  description: string;
  workspaceId: string | null;
  workspaceRole: string | null;
  stage: Stage;
  archived: boolean;
  firm: string | null;
  vendorRole: boolean;
  serviceType: { key: string; name: string; region: string; category: string | null; description: string };
  offering: { id: string; name: string; status: string; statusWords: string; statusNote: string | null; price: { amount: number; currency: string } | null; buildId: string | null };
  hosted: { status: string; online: boolean; buildId: string | null; address: string | null } | null;
  contract: ServiceContract | null;
  conformance: { runs: ServiceRun[]; needed: boolean; testedBuildId: string | null };
  terms: { current: VendorOffering["terms"]; versions: TermsVersion[] };
  subscribers: ServiceSubscriber[];
  reliability: {
    windowDays: number;
    calls: Measured;
    errorRate: Measured;
    responseTimeMs: Measured & { inLastConformanceRun: { median: number | null; max: number | null; requests: number | null; at: string | null } | null };
    byDay: { day: string; environment: string; calls: number; errors: number; errorRate: number | null }[];
    incidents: { at: string | null; kind: string; what: string }[];
  };
  activity: { at: string | null; action: string; what: string; detail: string; by: string | null }[];
  checklist: Step[];
  progress: { done: number; total: number };
};

const fieldsOf = (v: unknown): ServiceField[] =>
  arr(v)
    .filter(isObj)
    .flatMap((f) => (str(f.field) ? [{ field: str(f.field)!, type: str(f.type) ?? "any", required: f.required === true, description: str(f.description) ?? "" }] : []));
const measuredOf = (v: unknown): Measured => {
  const o = isObj(v) ? v : {};
  const value = num(o.value);
  return { value, notMeasured: value === null ? (str(o.not_measured) ?? "Mynt didn't say why") : null };
};
const casesOf = (v: unknown): RunCase[] | null =>
  Array.isArray(v)
    ? v.filter(isObj).map((c) => ({ case: str(c.case) ?? "case", passed: c.passed === true, httpStatus: num(c.http_status), problems: arr(c.problems).map(str).filter((p): p is string => Boolean(p)) }))
    : null;
const termsOf = (t: unknown): VendorOffering["terms"] => {
  if (!isObj(t) || num(t.version) === null) return null;
  const scopes: AgreementScope[] = scopesOf(t.scopes);
  return { version: num(t.version)!, documentUrl: str(t.document_url) ?? "", documentSha256: str(t.document_sha256) ?? "", summary: str(t.summary) ?? "", pricing: str(t.pricing_summary) ?? "", scopes, scopeLabel: scopeLabelOf(scopes), setAt: str(t.set_at) };
};
const stepsOf = (v: unknown): Step[] =>
  arr(v)
    .filter(isObj)
    .flatMap((s): Step[] => {
      const key = str(s.key);
      const status = str(s.status) as StepStatus | null;
      if (!key || !status || !STEP_STATUSES.includes(status)) return [];
      return [{ key, title: str(s.title) ?? key, status, detail: str(s.detail) ?? "", tool: str(s.tool), by: s.by === "admin" || s.by === "subscriber" ? s.by : "vendor", informational: s.informational === true, facts: isObj(s.facts) ? s.facts : {} }];
    });

export function serviceFrom(reply: unknown): ServiceView | null {
  if (!isObj(reply) || !str(reply.id) || reply.kind !== "service") return null;
  const o = isObj(reply.offering) ? reply.offering : null;
  if (!o || !str(o.id)) return null;
  const t = isObj(reply.service_type) ? reply.service_type : {};
  const h = isObj(reply.hosted) ? reply.hosted : null;
  const c = isObj(reply.contract) ? reply.contract : null;
  const ce = c && isObj(c.endpoint) ? c.endpoint : {};
  const cs = c && isObj(c.signature) ? c.signature : {};
  const cr = c && isObj(c.response) ? c.response : {};
  const conf = isObj(reply.conformance) ? reply.conformance : {};
  const terms = isObj(reply.terms) ? reply.terms : {};
  const rel = isObj(reply.reliability) ? reply.reliability : {};
  const rt = isObj(rel.response_time_ms) ? rel.response_time_ms : {};
  const last = isObj(rt.in_last_conformance_run) ? rt.in_last_conformance_run : null;
  const price = isObj(o.price) && num(o.price.amount) !== null && str(o.price.currency) ? { amount: num(o.price.amount)!, currency: str(o.price.currency)! } : null;
  const progress = isObj(reply.progress) ? reply.progress : {};
  return {
    id: str(reply.id)!,
    name: str(reply.name) ?? "Untitled service",
    description: str(reply.description) ?? "",
    workspaceId: str(reply.workspace_id),
    workspaceRole: str(reply.workspace_role),
    stage: stage(reply.stage),
    archived: reply.archived === true,
    firm: isObj(reply.firm) ? str(reply.firm.name) : null,
    vendorRole: reply.vendor_role === true,
    serviceType: { key: str(t.key) ?? "", name: str(t.name) ?? str(t.key) ?? "Service", region: str(t.region) ?? "—", category: str(t.category), description: str(t.description) ?? "" },
    offering: { id: str(o.id)!, name: str(o.name) ?? "Service", status: str(o.status) ?? "draft", statusWords: str(o.status_words) ?? "", statusNote: str(o.status_note), price, buildId: str(o.build_id) },
    hosted: h ? { status: str(h.status) ?? "unknown", online: h.online === true, buildId: str(h.build_id), address: str(h.address) } : null,
    contract: c
      ? {
          endpoint: { method: str(ce.method) ?? "POST", path: str(ce.app_path) ?? "", address: str(ce.address), note: str(ce.note) ?? "" },
          signature: {
            header: str(cs.header) ?? "",
            format: str(cs.format) ?? "",
            algorithm: str(cs.algorithm) ?? "",
            toleranceSeconds: num(cs.tolerance_seconds),
            compare: str(cs.compare) ?? "",
            refuseWith: num(cs.refuse_with),
            secretSetting: str(cs.secret_setting) ?? "",
            rule: str(cs.rule) ?? "",
          },
          limits: str(cr.limits) ?? "",
          inputFields: fieldsOf(c.input_fields),
          paramsFields: fieldsOf(c.params_fields),
          outputFields: fieldsOf(c.output_fields),
          fixtures: arr(c.fixtures),
          exampleOutput: c.example_output ?? null,
        }
      : null,
    conformance: {
      runs: arr(conf.runs)
        .filter(isObj)
        .flatMap((r): ServiceRun[] =>
          str(r.run_id)
            ? [
                {
                  runId: str(r.run_id)!,
                  kind: r.kind === "practice" ? "practice" : "conformance",
                  passed: r.passed === true,
                  at: str(r.at),
                  runBy: str(r.run_by),
                  failures: arr(r.failures)
                    .filter(isObj)
                    .map((f) => ({ case: str(f.case) ?? "case", problems: arr(f.problems).map(str).filter((p): p is string => Boolean(p)) })),
                  cases: casesOf(r.cases),
                  passedCases: num(r.passed_cases),
                  totalCases: num(r.total_cases),
                },
              ]
            : [],
        ),
      needed: conf.needed === true,
      testedBuildId: str(conf.tested_build_id),
    },
    terms: {
      current: termsOf(terms.current),
      versions: arr(terms.versions)
        .filter(isObj)
        .flatMap((v): TermsVersion[] =>
          num(v.version) !== null
            ? [{ version: num(v.version)!, current: v.current === true, documentUrl: str(v.document_url), documentSha256: str(v.document_sha256), summary: str(v.summary), pricing: str(v.pricing_summary), scopes: Array.isArray(v.scopes) ? scopesOf(v.scopes) : null, setAt: str(v.set_at), setBy: str(v.set_by), agreements: num(v.agreements) }]
            : [],
        ),
    },
    subscribers: arr(reply.subscribers)
      .filter(isObj)
      .flatMap((s): ServiceSubscriber[] =>
        str(s.subscription_id)
          ? [
              {
                subscriptionId: str(s.subscription_id)!,
                firm: str(s.firm) ?? "A firm",
                appName: str(s["app"]),
                termsVersion: num(s.terms_version),
                since: str(s.since),
                environment: s.environment === "Live" ? "Live" : "Sandbox",
                subscriptionStatus: str(s.subscription_status) ?? "active",
                agreementStatus: str(s.agreement_status),
              },
            ]
          : [],
      ),
    reliability: {
      windowDays: num(rel.window_days) ?? 30,
      calls: measuredOf(rel.calls),
      errorRate: measuredOf(rel.error_rate),
      responseTimeMs: { ...measuredOf(rel.response_time_ms), inLastConformanceRun: last ? { median: num(last.median), max: num(last.max), requests: num(last.requests), at: str(last.at) } : null },
      byDay: arr(rel.by_day)
        .filter(isObj)
        .flatMap((d) => (str(d.day) && num(d.calls) !== null ? [{ day: str(d.day)!, environment: d.environment === "live" ? "Live" : "Sandbox", calls: num(d.calls)!, errors: num(d.errors) ?? 0, errorRate: num(d.error_rate) }] : [])),
      incidents: arr(rel.incidents)
        .filter(isObj)
        .map((i) => ({ at: str(i.at), kind: str(i.kind) ?? "", what: str(i.what) ?? "" })),
    },
    activity: arr(reply.activity)
      .filter(isObj)
      .map((a) => ({ at: str(a.at), action: str(a.action) ?? "", what: str(a.what) ?? str(a.action) ?? "", detail: str(a.detail) ?? "", by: str(a.by) })),
    checklist: stepsOf(reply.checklist),
    progress: { done: num(progress.done) ?? 0, total: num(progress.total) ?? 0 },
  };
}

/** The service's offering as My services' sheets take one (Set standard terms, Run practice test, Run conformance). */
export function offeringForSheets(s: ServiceView): VendorOffering {
  return {
    id: s.offering.id,
    name: s.name,
    region: s.serviceType.region,
    serviceKey: s.serviceType.key,
    status: s.offering.status,
    // Mynt's own: the service's hosted address and the fixed path, once it is online.
    testBaseUrl: s.contract?.endpoint.address ?? "",
    liveBaseUrl: s.contract?.endpoint.address ?? null,
    price: s.offering.price,
    slaNotes: "",
    licenceIds: [],
    requiresCredential: false,
    statusNote: s.offering.statusNote,
    terms: s.terms.current,
    lastConformance: null,
    subscribers: s.subscribers.length,
    createdAt: null,
  };
}

// ---- what a figure says ----

export const measuredWords = (m: Measured, format: (n: number) => string = String) => (m.value === null ? `${NOT_MEASURED}: ${m.notMeasured}` : format(m.value));
export const percent = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.001 ? 2 : 1)}%`;
/** The build a run is recorded against: only the passing conformance run that stands (the newest one), never a guess. */
export function runBuild(s: Pick<ServiceView, "conformance">, run: ServiceRun): string | null {
  if (!s.conformance.testedBuildId || run.kind !== "conformance" || !run.passed) return null;
  const standing = s.conformance.runs.find((r) => r.kind === "conformance");
  return standing?.runId === run.runId ? s.conformance.testedBuildId : null;
}
export function casesWords(run: ServiceRun): string {
  if (run.passedCases !== null && run.totalCases !== null) return `${run.passedCases} of ${run.totalCases}`;
  if (run.cases) return `${run.cases.filter((c) => c.passed).length} of ${run.cases.length}`;
  return run.failures.length ? `${run.failures.length} failed` : NOT_RECORDED;
}

// ---- the checklist's labelled actions ----

export type ServiceStepAction = "online" | "restore" | "builder" | "practice" | "conformance" | "terms" | "production";
export const SERVICE_STEP_LABELS: Record<ServiceStepAction, string> = {
  online: "Put online",
  restore: "Restore",
  builder: "Ask the builder to add it",
  practice: "Run practice test",
  conformance: "Run conformance",
  terms: "Set standard terms",
  production: "Move to production",
};
/** The labelled action the studio offers for a step, where the builder can take it now. Steps only Mynt can do have none. */
export function serviceStepAction(step: Step): ServiceStepAction | null {
  if (step.key === "practice" && step.status !== "blocked") return "practice";
  if (step.status === "done" || step.status === "blocked" || step.by !== "vendor") return null;
  switch (step.key) {
    case "app_online":
      return step.tool === "archive_service" ? "restore" : "online";
    case "service_endpoint":
      return "builder";
    case "conformance":
      return step.tool === "run_conformance" ? "conformance" : null;
    case "terms":
      return "terms";
    case "listed":
      return step.tool === "promote_app" ? "production" : null;
    default:
      return null;
  }
}
/** What a step only an admin can clear says to do. */
export const stepWaitsOnAdmin = (step: Step) => step.key === "vendor_role" && step.status === "blocked";
export const ASK_AN_ADMIN = "Ask a Mynt admin";
/** The prepared message the checklist sends into the service's builder chat. */
export const builderEndpointMessage = (serviceTypeName: string) => `Add Mynt's vendor service endpoint for ${serviceTypeName}`;
export const BUILDER_MESSAGE_EVENT = "mynt:builder-message";

// ---- the service's tabs ----

// Overview holds the service's metadata card and its checklist (as My services shows its onboarding checklist); a
// service has no preview (it answers Mynt's signed requests, not a browser) and none of an app's Products, Agreements,
// Customers, P&L or SDK tabs.
export const SERVICE_TABS = ["overview", "contract", "conformance", "terms", "subscribers", "reliability", "security", "activity"] as const;
export type ServiceTab = (typeof SERVICE_TABS)[number];
export const SERVICE_TAB_LABELS: Record<ServiceTab, string> = {
  overview: "Overview",
  contract: "Contract",
  conformance: "Conformance",
  terms: "Terms & pricing",
  subscribers: "Subscribers",
  reliability: "Reliability",
  security: "Security & risk",
  activity: "Activity",
};
export const isServiceTab = (v: unknown): v is ServiceTab => SERVICE_TABS.includes(v as ServiceTab);
