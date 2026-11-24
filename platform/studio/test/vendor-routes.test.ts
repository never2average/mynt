import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// My services' routes (app/api/vendor/*): each serves only an account with the vendor role (403 before anything reaches
// Mynt's vendor tools), a write must come from the studio's own page and name a service of the caller's own firm (404
// otherwise, and nothing is sent), and each sends Mynt exactly the tool and arguments it should. The access route says
// whether the sidebar shows My services: the vendor role as granted, never the one an admin only implies.

const OFF = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const FIRM = "33333333-3333-4333-8333-333333333333";

const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const TOOLS = [
  { name: "get_vendor_onboarding", inputSchema: props("offering_id") },
  { name: "list_my_offerings", inputSchema: props() },
  { name: "list_my_subscribers", inputSchema: props("offering_id", "days") },
  { name: "list_service_types", inputSchema: props("region") },
  { name: "get_my_entity", inputSchema: props() },
  { name: "create_vendor_offering", inputSchema: props("region", "service_type") },
  { name: "update_vendor_offering", inputSchema: props("offering_id", "listed", "standard_terms") },
  { name: "run_conformance", inputSchema: props("offering_id", "test_credential") },
];
const fake = {
  session: undefined as Session | undefined,
  ownOrigin: true,
  whoami: { id: "v1", roles: ["vendor"], effective_roles: ["vendor"] } as Record<string, unknown>,
  calls: [] as { name: string; args: Record<string, unknown> }[],
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: () => fake.ownOrigin,
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: TOOLS }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      switch (name) {
        case "whoami":
          return ok(fake.whoami);
        case "get_vendor_onboarding":
          return ok({
            entity: { id: FIRM, name: "KYC Works", status: "active" },
            firm_steps: [{ key: "firm_registered", title: "Your firm is registered with Mynt", status: "done", detail: "KYC Works is registered.", tool: "register_firm", by: "admin", informational: false, facts: {} }],
            offerings: [],
            progress: { done: 1, total: 1, next: null, complete: true },
            ...(args.offering_id ? { history: [{ offering_id: args.offering_id, conformance_runs: [{ run_id: "r1", passed: true, at: "2026-11-20T00:00:00Z", run_by: "Vera", failures: [] }], terms_versions: [] }] } : {}),
          });
        case "list_my_offerings":
          return ok([{ id: OFF, name: "KYC Works ID", region: "US", service_type: "identity_verification", status: "draft", test_base_url: "https://test.example.com", price: { amount: 1, currency: "USD" }, licence_ids: [], subscribers: 0 }]);
        case "list_my_subscribers":
          return ok([]);
        case "list_service_types":
          return ok([{ region: "US", key: "identity_verification", name: "Identity verification", category: "identity", vendor_licences: [] }]);
        case "get_my_entity":
          return ok({ id: FIRM, licenses: [] });
        case "create_vendor_offering":
          return ok({ id: OFF, status: "draft", conformance_signing_secret: "mvs_shown_once" });
        case "update_vendor_offering":
          return ok({ id: OFF, status: "draft", terms: args.standard_terms ? { version: 2 } : null });
        case "run_conformance":
          return ok({ run_id: "r2", passed: false, status: "draft", cases: [{ case: "fixture_1", passed: false, problems: ["timeout"] }, { case: "bad_signature_refused", passed: true, problems: [] }] });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const home = await import("@/app/api/vendor/route");
const create = await import("@/app/api/vendor/offerings/route");
const one = await import("@/app/api/vendor/offerings/[offeringId]/route");
const terms = await import("@/app/api/vendor/offerings/[offeringId]/terms/route");
const conformance = await import("@/app/api/vendor/offerings/[offeringId]/conformance/route");
const listing = await import("@/app/api/vendor/offerings/[offeringId]/listing/route");
const access = await import("@/app/api/liquidity/access/route");

const post = (path: string, body: unknown) => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (offeringId: string) => ({ params: Promise.resolve({ offeringId }) });
const session = (roles: string[]) => ({ id: "s", userId: "v1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const writes = () => fake.calls.filter((c) => ["create_vendor_offering", "update_vendor_offering", "run_conformance"].includes(c.name));
const TERMS = { document_url: "https://example.com/terms.pdf", document_sha256: "a".repeat(64), summary: "Our standard terms.", pricing_summary: "$1 per check" };

beforeEach(() => {
  fake.session = session(["vendor"]);
  fake.ownOrigin = true;
  fake.whoami = { id: "v1", roles: ["vendor"], effective_roles: ["vendor"] };
  fake.calls = [];
});

describe("My services' routes, for a service provider", () => {
  it("GET: the checklist, the firm's services, the service types and its licences", async () => {
    const res = await home.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.onboarding.entity.name).toBe("KYC Works");
    expect(body.onboarding.firmSteps[0].status).toBe("done");
    expect(body.offerings.map((o: { id: string }) => o.id)).toEqual([OFF]);
    expect(body.serviceTypes[0].key).toBe("identity_verification");
    expect(fake.calls.find((c) => c.name === "get_vendor_onboarding")?.args).toEqual({});
  });

  it("a service's details: its history and subscribers; another firm's service is not found", async () => {
    const res = await one.GET(new Request(`http://localhost:3000/api/vendor/offerings/${OFF}`), params(OFF));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.runs.map((r: { runId: string }) => r.runId)).toEqual(["r1"]);
    expect(body.subscribers).toEqual([]);
    expect(fake.calls.find((c) => c.name === "get_vendor_onboarding")?.args).toEqual({ offering_id: OFF });
    expect(fake.calls.find((c) => c.name === "list_my_subscribers")?.args).toEqual({ offering_id: OFF });
    expect((await one.GET(new Request("http://localhost:3000/x"), params(OTHER))).status).toBe(404);
  });

  it("Create service → create_vendor_offering, with the signing secret passed back once", async () => {
    const res = await create.POST(post("/api/vendor/offerings", { region: "US", service_type: "identity_verification", name: "KYC Works ID", test_base_url: "https://test.example.com", price: { amount: 1, currency: "USD" }, licence_ids: [] }));
    expect(res.status).toBe(200);
    expect((await res.json()).signing_secret).toBe("mvs_shown_once");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(writes()).toEqual([{ name: "create_vendor_offering", args: { region: "US", service_type: "identity_verification", name: "KYC Works ID", test_base_url: "https://test.example.com", price: { amount: 1, currency: "USD" }, licence_ids: [] } }]);
  });

  it("Edit service, Set standard terms, Run conformance and List service → update_vendor_offering / run_conformance on the firm's own service", async () => {
    expect((await one.POST(post(`/api/vendor/offerings/${OFF}`, { name: "Renamed" }), params(OFF))).status).toBe(200);
    const t = await terms.POST(post(`/api/vendor/offerings/${OFF}/terms`, { standard_terms: TERMS }), params(OFF));
    expect((await t.json()).message).toMatch(/^Saved as version 2\. .*keep the version they accepted/);
    const c = await (await conformance.POST(post(`/api/vendor/offerings/${OFF}/conformance`, { test_credential: "cred" }), params(OFF))).json();
    expect(c).toMatchObject({ passed: false, cases: 2, failures: [{ case: "fixture_1", problems: ["timeout"] }] });
    expect(JSON.stringify(c)).not.toContain("cred\"");
    expect((await listing.POST(post(`/api/vendor/offerings/${OFF}/listing`, { listed: true }), params(OFF))).status).toBe(200);
    expect(writes()).toEqual([
      { name: "update_vendor_offering", args: { offering_id: OFF, name: "Renamed" } },
      { name: "update_vendor_offering", args: { offering_id: OFF, standard_terms: TERMS } },
      { name: "run_conformance", args: { offering_id: OFF, test_credential: "cred" } },
      { name: "update_vendor_offering", args: { offering_id: OFF, listed: true } },
    ]);
  });

  it("refuses, before anything is written: another firm's service, another origin, a bad body, terms without a SHA-256", async () => {
    expect((await listing.POST(post(`/api/vendor/offerings/${OTHER}/listing`, { listed: true }), params(OTHER))).status).toBe(404);
    expect((await listing.POST(post("/api/vendor/offerings/x/listing", { listed: true }), params("not-a-uuid"))).status).toBe(404);
    expect((await one.POST(post(`/api/vendor/offerings/${OFF}`, { name: "x", listed: true }), params(OFF))).status).toBe(400); // listing has its own route
    expect((await one.POST(post(`/api/vendor/offerings/${OFF}`, { test_base_url: "http://test.example.com" }), params(OFF))).status).toBe(400);
    expect((await terms.POST(post(`/api/vendor/offerings/${OFF}/terms`, { standard_terms: { ...TERMS, document_sha256: "nope" } }), params(OFF))).status).toBe(400);
    expect((await terms.POST(post(`/api/vendor/offerings/${OFF}/terms`, { standard_terms: { ...TERMS, document_url: "http://example.com/t.pdf" } }), params(OFF))).status).toBe(400);
    fake.ownOrigin = false;
    expect((await create.POST(post("/api/vendor/offerings", { region: "US" }))).status).toBe(403);
    expect((await terms.POST(post(`/api/vendor/offerings/${OFF}/terms`, { standard_terms: TERMS }), params(OFF))).status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("serves only accounts with the vendor role: a developer is refused before Mynt's vendor tools are called", async () => {
    fake.session = session(["consumer", "developer", "innovator"]);
    const res = await home.GET();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_vendor");
    expect((await listing.POST(post(`/api/vendor/offerings/${OFF}/listing`, { listed: true }), params(OFF))).status).toBe(403);
    expect(fake.calls.filter((c) => c.name !== "whoami")).toEqual([]);
  });

  it("the access route: My services for the vendor role as granted, never one an admin only implies", async () => {
    expect((await (await access.GET()).json()).vendor).toBe(true);
    fake.session = session(["consumer", "developer", "innovator"]);
    expect((await (await access.GET()).json()).vendor).toBe(false);
    fake.session = session(["consumer", "developer", "innovator", "vendor", "license_provider", "admin"]);
    fake.whoami = { id: "a1", roles: ["admin"], effective_roles: ["consumer", "developer", "innovator", "vendor", "license_provider", "admin"] };
    expect((await (await access.GET()).json()).vendor).toBe(false);
    fake.whoami = { id: "a1", roles: ["admin", "vendor"], effective_roles: ["consumer", "developer", "innovator", "vendor", "license_provider", "admin"] };
    expect((await (await access.GET()).json()).vendor).toBe(true);
  });
});
