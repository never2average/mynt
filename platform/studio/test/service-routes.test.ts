import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// Services' routes (app/api/services/*, and the platform admin's requests): the allow-list takes the new tools
// strictly; creating a service needs Mynt's vendor role (refused before anything reaches Mynt) and then starts its
// first build with the service's id as the app id; a service is read whole and archived by its id; a service type is
// requested with JSON objects only; an admin declines a request with a reason or defines the type from it; and
// list_my_apps' services never come back as apps.

const REQ = "88888888-8888-4888-8888-888888888888";
const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const ALL_TOOLS = [
  { name: "list_my_apps", inputSchema: props("workspace_id") },
  { name: "list_builds", inputSchema: props("workspace_id", "app_id") },
  { name: "list_workspaces", inputSchema: props() },
  { name: "create_app", inputSchema: props("workspace_id") },
  { name: "start_build", inputSchema: props("goal", "app_id", "mode") },
  { name: "create_service", inputSchema: props("workspace_id", "name") },
  { name: "get_service", inputSchema: props("service_id", "days") },
  { name: "list_my_services", inputSchema: props("workspace_id") },
  { name: "archive_service", inputSchema: props("service_id", "archived", "reason") },
  { name: "list_service_types", inputSchema: props("region") },
  { name: "request_service_type", inputSchema: props("name") },
  { name: "list_service_type_requests", inputSchema: props("status") },
  { name: "decline_service_type_request", inputSchema: props("request_id", "reason") },
  { name: "define_service_type", inputSchema: props("service_type", "from_request") },
  { name: "list_vendor_offerings", inputSchema: props("include_unlisted") },
];
const SERVICE = {
  id: "svc-1",
  kind: "service",
  name: "Swift ID",
  description: "Verifies identity documents.",
  workspace_id: "ws-own",
  stage: "idea",
  archived: false,
  service_type: { key: "identity_verification", name: "Identity verification", region: "US" },
  offering: { id: "55555555-5555-4555-8555-555555555555", name: "Swift ID", status: "draft", status_words: "Needs conformance" },
  reliability: { window_days: 30, calls: { value: null, not_measured: "Nobody subscribes yet, so nothing has called it" } },
};
const REQUEST = { id: REQ, name: "Proof of address", region: "US", what_it_does: "Checks an address", example_input: { line1: "1 Main St" }, example_output: { verified: true }, status: "requested", status_words: "Waiting for Mynt", decision_note: null, service_type_key: null, requested_by: { id: "u1", name: "Vera" }, firm: { id: "f1", name: "KYC Works" }, requested_at: "2026-11-20T10:00:00Z", decided_at: null };

const fake = {
  session: undefined as Session | undefined,
  ownOrigin: true,
  tools: ALL_TOOLS,
  whoami: {} as Record<string, unknown>,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: null as string | null,
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: () => fake.ownOrigin,
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false, claim: async () => async () => undefined }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      if (fake.refuse === name) return { isError: true, content: [{ type: "text", text: "Only the workspace's owners and admins archive or restore a service" }] };
      switch (name) {
        case "whoami":
          return ok(fake.whoami);
        case "list_workspaces":
          return ok([{ id: "ws-own", name: "Mine", personal: true, role: "owner" }]);
        case "list_my_apps":
          return ok([
            { id: "app-1", kind: "app", name: "Budgeting", status: "draft", stage: "idea", updated_at: "2026-11-20T00:00:00Z" },
            { id: "svc-1", kind: "service", name: "Swift ID", status: "draft", stage: "staging", updated_at: "2026-11-21T00:00:00Z" },
          ]);
        case "list_builds":
          return ok({ builds: [{ id: "b-svc", app_id: "svc-1", goal: "Add the endpoint", status: "succeeded", created_at: "2026-11-21T00:00:00Z" }] });
        case "create_service":
          return ok({ ...SERVICE, next: "Build it" });
        case "start_build":
          return ok({ id: "build-1" });
        case "get_service":
          return args.service_id === "svc-1" ? ok(SERVICE) : { isError: true, content: [{ type: "text", text: `No service of yours with id '${String(args.service_id)}'` }] };
        case "list_my_services":
          return ok([{ id: "svc-1", kind: "service", name: "Swift ID", description: "", workspace_id: "ws-own", stage: "staging", archived: false, service_type: { key: "identity_verification", name: "Identity verification", region: "US" }, offering_id: SERVICE.offering.id, offering_status: "draft", status_words: "Needs conformance", online: true }]);
        case "archive_service":
          return ok({ ...SERVICE, archived: args.archived, drifted_products: args.archived ? [{ id: "p1" }] : [] });
        case "list_service_types":
          return ok([{ region: "US", key: "identity_verification", name: "Identity verification", category: "identity", description: "Checks a person.", vendor_licences: ["us-msb"], input_schema: {}, output_schema: {}, consent_purpose: "identity_verification", fills: [], moves_money: false }]);
        case "request_service_type":
          return ok({ ...REQUEST, next: "A Mynt admin defines it or declines" });
        case "list_service_type_requests":
          return ok([REQUEST]);
        case "decline_service_type_request":
          return ok({ ...REQUEST, status: "declined", decision_note: args.reason });
        case "list_vendor_offerings":
          return ok([]);
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const { parseStudioCall, parseAdminCall } = await import("@/lib/studio-tools");
const { toProjects, toServiceProjects } = await import("@/lib/projects");
const { appsFrom } = await import("@/lib/marketplace");
const services = await import("@/app/api/services/route");
const one = await import("@/app/api/services/[serviceId]/route");
const types = await import("@/app/api/services/types/route");
const projects = await import("@/app/api/projects/route");
const adminVendors = await import("@/app/api/admin/vendors/route");
const adminTypes = await import("@/app/api/admin/vendors/service-types/route");
const decline = await import("@/app/api/admin/vendors/requests/[requestId]/route");

const req = (path: string, body?: unknown) => new Request(`http://localhost:3000${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const session = (roles: string[]) => ({ id: "s", userId: "u1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const called = (name: string) => fake.calls.filter((c) => c.name === name);
const NEW = { prompt: "A service that verifies identity documents", service_type: "identity_verification", region: "US" };

beforeEach(() => {
  fake.session = session(["developer", "vendor"]);
  fake.ownOrigin = true;
  fake.tools = ALL_TOOLS;
  fake.whoami = { id: "u1", roles: ["developer", "vendor"], effective_roles: ["developer", "vendor"] };
  fake.calls = [];
  fake.refuse = null;
});

describe("the allow-list", () => {
  it("takes the service tools strictly", () => {
    expect(parseStudioCall("create_service", { name: "Swift ID", description: "Verifies IDs", service_type: "identity_verification", region: "US" })).toHaveProperty("tool");
    expect(parseStudioCall("create_service", { name: "Swift ID", description: "Verifies IDs", service_type: "identity_verification", region: "US", price: { amount: 1, currency: "USD" }, licence_ids: [REQ] })).toHaveProperty("tool");
    // A service's endpoint is Mynt's: never typed.
    for (const typed of ["test_base_url", "live_base_url", "endpoint"]) expect(parseStudioCall("create_service", { name: "Swift ID", description: "Verifies IDs", service_type: "identity_verification", region: "US", [typed]: "https://svc.example.com" })).toHaveProperty("error");
    expect(parseStudioCall("create_service", { name: "Swift ID", description: "Verifies IDs", service_type: "Identity Verification", region: "US" })).toHaveProperty("error");
    expect(parseStudioCall("get_service", { service_id: "svc-1", days: 30 })).toHaveProperty("tool");
    expect(parseStudioCall("get_service", { service_id: "svc-1", days: 365 })).toHaveProperty("error");
    expect(parseStudioCall("list_my_services", { workspace_id: "ws-1" })).toHaveProperty("tool");
    expect(parseStudioCall("list_my_services", { owner_id: "someone" })).toHaveProperty("error");
    expect(parseStudioCall("archive_service", { service_id: "svc-1", archived: true, reason: "Replaced" })).toHaveProperty("tool");
    expect(parseStudioCall("archive_service", { service_id: "svc-1" })).toHaveProperty("error"); // always says which way
    expect(parseStudioCall("get_service_type_contract", { key: "identity_verification", region: "US" })).toHaveProperty("tool");
    const ask = { name: "Proof of address", what_it_does: "Checks an address against a bill", example_input: { line1: "1 Main St" }, example_output: { verified: true } };
    expect(parseStudioCall("request_service_type", ask)).toHaveProperty("tool");
    expect(parseStudioCall("request_service_type", { ...ask, example_input: ["not", "an", "object"] })).toHaveProperty("error");
    expect(parseStudioCall("request_service_type", { ...ask, example_output: "{}" })).toHaveProperty("error");
    expect(parseStudioCall("request_service_type", { ...ask, example_input: { blob: "x".repeat(9000) } })).toHaveProperty("error");
    expect(parseStudioCall("list_service_type_requests", { status: "requested" })).toHaveProperty("tool");
    expect(parseStudioCall("list_service_type_requests", { status: "open" })).toHaveProperty("error");
  });

  it("keeps declining and defining for admins", () => {
    expect(parseStudioCall("decline_service_type_request", { request_id: REQ, reason: "Covered already" })).toHaveProperty("error");
    expect(parseAdminCall("decline_service_type_request", { request_id: REQ, reason: "Covered already" })).toHaveProperty("tool");
    expect(parseAdminCall("decline_service_type_request", { request_id: REQ, reason: "no" })).toHaveProperty("error"); // a reason the requester can read
    expect(parseAdminCall("decline_service_type_request", { request_id: "r1", reason: "Covered already" })).toHaveProperty("error");
    const type = { region: "US", key: "proof_of_address", name: "Proof of address", category: "identity", input_schema: { type: "object" }, output_schema: { type: "object" }, consent_purpose: "address_check", moves_money: false };
    expect(parseAdminCall("define_service_type", { service_type: type, from_request: REQ })).toHaveProperty("tool");
    expect(parseAdminCall("define_service_type", { service_type: type })).toHaveProperty("tool");
    expect(parseAdminCall("define_service_type", { service_type: type, from_request: "r1" })).toHaveProperty("error");
  });
});

describe("a service is never an app", () => {
  const APPS = [
    { id: "app-1", kind: "app", name: "Budgeting", status: "draft", stage: "idea" },
    { id: "svc-1", kind: "service", name: "Swift ID", status: "draft", stage: "staging" },
    { id: "old-1", name: "From before kinds", status: "draft", stage: "idea" },
  ];
  it("list_my_apps' services are left out of the apps and listed apart, with their builds", () => {
    const builds = { builds: [{ id: "b1", app_id: "svc-1", goal: "Add the endpoint", status: "succeeded", created_at: "2026-11-21T00:00:00Z" }] };
    expect(toProjects(APPS, builds).map((a) => a.id).sort()).toEqual(["app-1", "old-1"]);
    const [svc] = toServiceProjects(APPS, builds);
    expect(svc).toMatchObject({ id: "svc-1", name: "Swift ID", stage: "staging" });
    expect(svc.conversations.map((c) => c.id)).toEqual(["b1"]);
    expect(toServiceProjects([{ id: "svc-2", kind: "service" }], null)[0].name).toBe("Untitled service");
    // Nor an app a Marketplace subscription is for.
    expect(appsFrom(APPS).map((a) => a.id)).toEqual(["app-1", "old-1"]);
  });

  it("GET /api/projects answers with both lists", async () => {
    const body = await (await projects.GET(req("/api/projects") as never)).json();
    expect(body.projects.map((a: { id: string }) => a.id)).toEqual(["app-1"]);
    expect(body.services.map((a: { id: string }) => a.id)).toEqual(["svc-1"]);
    expect(body.services[0].conversations[0].id).toBe("b-svc");
  });
});

describe("creating a service", () => {
  it("creates it in the user's workspace and starts its first build with its id as the app id", async () => {
    const res = await services.POST(req("/api/services", NEW));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ serviceId: "svc-1", buildId: "build-1" });
    expect(called("create_service")[0].args).toEqual({ name: "A service that verifies identity documents", description: "A service that verifies identity documents", service_type: "identity_verification", region: "US", workspace_id: "ws-own" });
    expect(called("start_build")[0].args).toMatchObject({ goal: NEW.prompt, app_id: "svc-1" });
    // Never an app.
    expect(called("create_app")).toEqual([]);
  });

  it("needs the vendor role: anyone else is told to ask a Mynt admin, and nothing reaches Mynt's tools", async () => {
    fake.session = session(["developer"]);
    fake.whoami = { id: "u1", roles: ["developer"], effective_roles: ["developer"] };
    const res = await services.POST(req("/api/services", NEW));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_vendor", message: "Ask a Mynt admin for the vendor role." });
    expect(called("create_service")).toEqual([]);
    expect(called("start_build")).toEqual([]);
  });

  it("refuses another origin and a body it doesn't take", async () => {
    expect((await services.POST(req("/api/services", { ...NEW, test_base_url: "https://svc.example.com" }))).status).toBe(400);
    expect((await services.POST(req("/api/services", { ...NEW, prompt: "short" }))).status).toBe(400);
    expect((await services.POST(req("/api/services", { prompt: NEW.prompt }))).status).toBe(400);
    fake.ownOrigin = false;
    expect((await services.POST(req("/api/services", NEW))).status).toBe(403);
    expect(fake.calls).toEqual([]);
  });

  it("opens the service with a note when its build doesn't start", async () => {
    fake.refuse = "start_build";
    const res = await services.POST(req("/api/services", NEW));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ serviceId: "svc-1", buildId: null });
    expect(body.message).toContain("The service was created, but its first build didn't start");
  });
});

describe("reading and archiving a service", () => {
  it("GET lists the workspace's services", async () => {
    const body = await (await services.GET(req("/api/services") as never)).json();
    expect(body.supported).toBe(true);
    expect(body.services).toEqual([expect.objectContaining({ id: "svc-1", name: "Swift ID", stage: "staging", typeName: "Identity verification", region: "US", statusWords: "Needs conformance", online: true, archived: false })]);
    fake.tools = ALL_TOOLS.filter((t) => t.name !== "list_my_services");
    expect(await (await services.GET(req("/api/services") as never)).json()).toEqual({ supported: false, services: [] });
  });

  it("GET one reads it whole, keeps unmeasured figures null, and says not found for anything else", async () => {
    const res = await one.GET(req("/api/services/svc-1?days=7"), p({ serviceId: "svc-1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toMatchObject({ id: "svc-1", name: "Swift ID", stage: "idea" });
    expect(body.service.reliability.calls).toEqual({ value: null, notMeasured: "Nobody subscribes yet, so nothing has called it" });
    expect(called("get_service")[0].args).toEqual({ service_id: "svc-1", days: 7 });
    expect((await one.GET(req("/api/services/x y"), p({ serviceId: "x y" }))).status).toBe(404);
    expect((await one.GET(req("/api/services/other"), p({ serviceId: "other" }))).status).toBe(422);
    expect(called("get_service").at(-1)!.args).toEqual({ service_id: "other", days: 30 });
  });

  it("POST archives or restores it, and passes on Mynt's refusal", async () => {
    const res = await one.POST(req("/api/services/svc-1", { archived: true, reason: "Replaced by v2" }), p({ serviceId: "svc-1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("1 product that hands off through it has paused new sales");
    expect(called("archive_service")[0].args).toEqual({ service_id: "svc-1", archived: true, reason: "Replaced by v2" });
    const back = await one.POST(req("/api/services/svc-1", { archived: false }), p({ serviceId: "svc-1" }));
    expect((await back.json()).message).toContain("Restored as a draft");
    expect(called("archive_service")[1].args).toEqual({ service_id: "svc-1", archived: false });
    expect((await one.POST(req("/api/services/svc-1", { archived: "yes" }), p({ serviceId: "svc-1" }))).status).toBe(400);
    expect((await one.POST(req("/api/services/svc-1", {}), p({ serviceId: "svc-1" }))).status).toBe(400);
    fake.refuse = "archive_service";
    const refused = await one.POST(req("/api/services/svc-1", { archived: true }), p({ serviceId: "svc-1" }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toContain("owners and admins");
  });
});

describe("service types and requests", () => {
  it("GET: Mynt's service types with their licence prerequisite, whether the account may create, and its requests", async () => {
    const body = await (await types.GET()).json();
    expect(body).toMatchObject({ supported: true, vendor: true, canRequest: true });
    expect(body.serviceTypes).toEqual([{ region: "US", key: "identity_verification", name: "Identity verification", category: "identity", description: "Checks a person.", vendorLicences: ["us-msb"] }]);
    expect(body.requests[0]).toMatchObject({ id: REQ, name: "Proof of address", status: "requested", statusWords: "Waiting for Mynt", requestedBy: "Vera", firm: "KYC Works" });
    fake.session = session(["developer"]);
    fake.whoami = { id: "u1", roles: ["developer"], effective_roles: ["developer"] };
    expect((await (await types.GET()).json()).vendor).toBe(false);
  });

  it("POST asks Mynt for a service type; the examples must be JSON objects", async () => {
    const ask = { name: "Proof of address", what_it_does: "Checks an address against a bill", example_input: { line1: "1 Main St" }, example_output: { verified: true }, region: "US" };
    const res = await types.POST(req("/api/services/types", ask));
    expect(res.status).toBe(200);
    expect((await res.json()).request).toMatchObject({ id: REQ, status: "requested" });
    expect(called("request_service_type")[0].args).toEqual(ask);
    expect((await types.POST(req("/api/services/types", { ...ask, example_input: [1, 2] }))).status).toBe(400);
    expect((await types.POST(req("/api/services/types", { ...ask, example_output: "text" }))).status).toBe(400);
    expect((await types.POST(req("/api/services/types", { ...ask, status: "defined" }))).status).toBe(400);
    expect(called("request_service_type")).toHaveLength(1);
  });
});

describe("the platform admin's requested service types", () => {
  const TYPE = { region: "US", key: "proof_of_address", name: "Proof of address", category: "identity", input_schema: { type: "object", properties: { line1: { type: "string" } } }, output_schema: { type: "object", properties: { verified: { type: "boolean" } } }, consent_purpose: "address_check", moves_money: false };
  beforeEach(() => {
    fake.session = session(["admin"]);
    fake.whoami = { id: "a1", roles: ["admin"], effective_roles: ["admin", "developer"] };
  });

  it("GET lists every request with the service types and offerings", async () => {
    const body = await (await adminVendors.GET()).json();
    expect(body.requests).toEqual([expect.objectContaining({ id: REQ, name: "Proof of address", region: "US", firm: "KYC Works", requestedBy: "Vera", statusWords: "Waiting for Mynt", exampleInput: { line1: "1 Main St" } })]);
    fake.tools = ALL_TOOLS.filter((t) => t.name !== "list_service_type_requests");
    expect(await (await adminVendors.GET()).json()).not.toHaveProperty("requests");
  });

  it("Decline needs a reason and sends it", async () => {
    expect((await decline.POST(req("/x", { reason: "" }), p({ requestId: REQ }))).status).toBe(400);
    expect((await decline.POST(req("/x", {}), p({ requestId: REQ }))).status).toBe(400);
    expect((await decline.POST(req("/x", { reason: "Covered by identity verification" }), p({ requestId: "r1" }))).status).toBe(400);
    expect(called("decline_service_type_request")).toEqual([]);
    const res = await decline.POST(req("/x", { reason: "Covered by identity verification" }), p({ requestId: REQ }));
    expect(res.status).toBe(200);
    expect(called("decline_service_type_request")[0].args).toEqual({ request_id: REQ, reason: "Covered by identity verification" });
  });

  it("Define from request sends the new type with the request it answers", async () => {
    const res = await adminTypes.POST(req("/x", { service_type: TYPE, from_request: REQ }));
    expect(res.status).toBe(200);
    expect(called("define_service_type")[0].args).toEqual({ service_type: TYPE, from_request: REQ });
  });

  it("isn't for anyone else", async () => {
    fake.session = session(["developer", "vendor"]);
    fake.whoami = { id: "u1", roles: ["developer", "vendor"], effective_roles: ["developer", "vendor"] };
    expect((await decline.POST(req("/x", { reason: "Covered by identity verification" }), p({ requestId: REQ }))).status).toBe(404);
    expect((await adminTypes.POST(req("/x", { service_type: TYPE, from_request: REQ }))).status).toBe(404);
    expect(called("decline_service_type_request")).toEqual([]);
    expect(called("define_service_type")).toEqual([]);
  });
});
