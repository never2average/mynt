import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { parseStudioCall } from "@/lib/studio-tools";

// A financial product's workspace route (GET /api/products/<id>/panel): the product for the header, and
// each of its seven tabs, read from Mynt for this product only and only for the user's own products. What
// Mynt doesn't offer the user is "not available" with why, never an empty table or a 0.

const fake = {
  session: undefined as Session | undefined,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  tools: [] as string[],
  mine: [] as unknown[],
  definition: null as unknown,
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools.map((name) => ({ name, inputSchema: { type: "object" } })) }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      switch (name) {
        case "whoami":
          return ok({ id: "u1", effective_roles: ["developer"] });
        case "list_my_products":
          return ok(fake.mine);
        case "get_product_definition":
          return fake.definition ? ok({ definition: fake.definition, valid: true }) : { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "'green-savings' has no v2 definition yet" }) }] };
        case "list_my_sponsorships":
          return ok([
            {
              id: "s1",
              product_id: "green-savings",
              component_key: "deposit",
              status: "approved",
              jurisdictions: ["us-ny"],
              provider: { name: "Lead Trust" },
              component: { key: "deposit" },
              licences: [{ regulator_id: "nydfs", license_id: "money_transmitter", jurisdiction: "us-ny", in_force: true }],
              covenant_pauses: [{ rule_type: "min_reserve", paused_at: "2026-11-20T10:00:00.000Z" }],
            },
          ]);
        case "list_product_health":
          return ok([{ product_id: "green-savings", pool_id: null, chain: { status: "ok" }, gaps: [], snapshots: [{ sequence: 3, period_start: "2026-11-01T00:00:00Z", period_end: "2026-11-02T00:00:00Z", status: "published", source: "partner_ledger", verified: true, fingerprint: "abcdef0123456789" }] }]);
        case "list_my_apps":
          return ok([
            { id: "app-1", name: "Saver", stage: "staging", product_ids: ["green-savings"], workspace_id: "ws1" },
            { id: "app-2", name: "Other", stage: "idea", product_ids: ["dollar-account"], workspace_id: "ws1" },
          ]);
        case "get_workspace_obligations":
          return ok([
            { licence_id: "l1", obligation_id: "o1", title: "Keep records five years", partner: { name: "Lead Trust" }, regulator: "nydfs", licence_type: "money_transmitter", products: [{ id: "green-savings", name: "Green Savings" }], status: "unknown", reason: "Lead Trust hasn't recorded its compliance" },
            { licence_id: "l1", obligation_id: "o2", title: "Not this product's", partner: { name: "Lead Trust" }, products: [{ id: "dollar-account", name: "Dollar" }], status: "met" },
          ]);
        case "get_product_promotion_checks":
          return ok({ product_id: args.product_id, from_stage: "idea", to_stage: args.to_stage, checks: [{ id: "tests_passed", label: "Latest test passed", status: "fail", detail: "Not tested yet", fix: { label: "Run tests", tool: "test_product" } }], can_promote: false });
        case "list_my_vendor_subscriptions":
          return ok([{ subscription_id: "sub-1", vendor: "Acme KYC", service_type: "kyc", offering: "Acme ID", live: false, status: "active" }]);
        case "list_product_versions":
          return ok({ live_version: null, versions: [{ version: 1, status: "draft", changelog: "First", test_passed: null, published_at: null }] });
        case "list_product_activity":
          return ok({ product_id: "green-savings", events: [{ at: "2026-11-21T09:00:00.000Z", action: "product_archived", actor: "you", details: { reason: "Parked", stage: "idea" } }] });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const route = await import("@/app/api/products/[productId]/panel/route");
const ORIGIN = "http://localhost:3000";
const get = async (id: string, tab?: string) => {
  const res = await route.GET(new Request(`${ORIGIN}/api/products/${id}/panel${tab ? `?tab=${tab}` : ""}`), { params: Promise.resolve({ productId: id }) });
  return { status: res.status, body: await res.json() };
};
const called = (name: string) => fake.calls.filter((c) => c.name === name);
const sectionOf = (body: { data: { sections: { id: string }[] } }, id: string) => body.data.sections.find((s) => s.id === id) as unknown as { rows: { cells: string[]; href?: string }[] | null; reason?: string; empty?: string; note?: string };

const DEFINITION = {
  terms: [{ _id: "term_months", label: "Term", type: "duration", default: "P12M", allowed: ["P6M", "P12M"], negotiable: "customer_choice", post_issue: { rule: "immutable" }, set_by: ["template"] }],
  rates: [{ _id: "apy", kind: "deposit", rate_type: "fixed", value: 4.1 }],
  fees: [{ _id: "early_exit", type: "EXIT", method: "fixed", amount: { amount: 25, currency: "USD" }, payer: "customer" }],
  limits: [],
  lifecycle_events: [{ _id: "MD", sequence: 2, trigger: "scheduled" }, { _id: "IED", sequence: 1, trigger: "customer" }],
  servicing_policies: [{ _id: "statements", kind: "statement", config: { frequency: "monthly" } }],
  costs: [{ _id: "kyc", kind: "vendor", estimate: { amount: 1.5, currency: "USD" }, basis: "per customer" }],
  customer_segments: [{ _id: "retail", name: "US adults", customer_kind: "individual", qualification: { age: 18 }, channels: ["app"], target_market: { client_type: "retail" } }],
  risk_models: [{ _id: "fraud", model_name: "Fraud score", purpose: "fraud_score", repository: "models/fraud", description: "Scores sign-ups" }],
  core_algorithms: [],
  partner_handoffs: [{ _id: "kyc_check", name: "Identity check", trigger: "IED", sends: {}, returns: {}, on_failure: "manual_review" }],
  connections: [
    { _id: "c1", type: "handoff_to_party", from: { kind: "partner_handoff", id: "kyc_check" }, to: { kind: "party", id: "p1" }, attributes: { sla: "PT1M", consent_purpose: "kyc", channel: "api", vendor_subscription_id: "sub-1" } },
    { _id: "c2", type: "funds", from: { kind: "component", id: "deposit" }, to: { kind: "component", id: "card" } },
  ],
  descriptions: { summary: "Savings", key_features: [], documents: { terms_and_conditions: "https://example.com/terms" } },
};

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.calls = [];
  fake.tools = ["list_my_products", "get_product_definition", "list_my_sponsorships", "list_product_health", "list_my_apps", "get_workspace_obligations", "get_product_promotion_checks", "list_my_vendor_subscriptions", "list_product_versions", "list_product_activity"];
  fake.mine = [{ id: "green-savings", name: "Green Savings", product_line: "account_operations", region: "US", status: "draft", stage: "idea" }];
  fake.definition = DEFINITION;
});

describe("the product", () => {
  it("is the user's own (archived ones too), for the header", async () => {
    const r = await get("green-savings");
    expect(r.status).toBe(200);
    expect(r.body.product).toEqual({ id: "green-savings", name: "Green Savings", stage: "idea", archived: false, productLine: "account_operations", category: null, region: "US" });
    expect(called("list_my_products")[0].args).toEqual({ include_archived: true });
  });

  it("another firm's product, a bad id or an unknown tab is refused", async () => {
    expect((await get("not-mine")).status).toBe(404);
    expect((await get("Not A Slug")).status).toBe(400);
    expect((await get("green-savings", "pnl")).status).toBe(400);
    fake.session = undefined;
    expect((await get("green-savings", "terms")).status).toBe(401);
  });

  it("the studio may read only the product's own reads, strictly", () => {
    expect(parseStudioCall("get_product_definition", { product_id: "green-savings" })).toHaveProperty("tool");
    expect(parseStudioCall("get_product_definition", { product_id: "green-savings", working: true })).toHaveProperty("error");
    expect(parseStudioCall("list_product_activity", { id: "green-savings", limit: 50 })).toHaveProperty("tool");
    expect(parseStudioCall("list_product_activity", { id: "../x" })).toHaveProperty("error");
    expect(parseStudioCall("get_product_health", { product_id: "green-savings", pool_id: "x" })).toHaveProperty("error");
    expect(parseStudioCall("list_covenants", {})).toHaveProperty("error");
    for (const write of ["set_covenant", "set_product_definition", "subscribe_vendor_service", "request_sponsorship"]) expect(parseStudioCall(write, {})).toHaveProperty("error");
  });
});

describe("the tabs", () => {
  it("Terms: the definition's terms, rates, fees, limits, lifecycle, servicing and costs; an empty list says so", async () => {
    const { body } = await get("green-savings", "terms");
    expect(body.data.sections.map((s: { id: string }) => s.id)).toEqual(["terms", "rates", "fees", "limits", "lifecycle", "servicing", "costs"]);
    expect(sectionOf(body, "terms").rows![0].cells).toEqual(["Term", "duration", "P12M", "P6M, P12M", "customer choice", "immutable"]);
    expect(sectionOf(body, "fees").rows![0].cells[3]).toBe("25 USD");
    expect(sectionOf(body, "lifecycle").rows!.map((r) => r.cells[0])).toEqual(["IED", "MD"]);
    expect(sectionOf(body, "limits").rows).toEqual([]);
    expect(sectionOf(body, "limits").empty).toBe("The definition declares no limits.");
    expect(called("get_product_definition")[0].args).toEqual({ product_id: "green-savings" });
  });

  it("Terms and Customers without a definition say why, not an empty table", async () => {
    fake.definition = null;
    for (const tab of ["terms", "customers"]) {
      const { body } = await get("green-savings", tab);
      expect(body.data.available).toBe(false);
      expect(body.data.reason).toMatch(/no v2 definition yet/);
    }
  });

  it("Customers: segments with their qualification and channels, and the target market", async () => {
    const { body } = await get("green-savings", "customers");
    expect(sectionOf(body, "segments").rows![0].cells).toEqual(["US adults", "individual", "age: 18", "app"]);
    expect(sectionOf(body, "target-market").rows![0].cells[1]).toBe("client type: retail");
  });

  it("Risk: models, algorithms, covenant pauses and the health record's status; covenants and the figures say who reads them", async () => {
    const { body } = await get("green-savings", "risk");
    expect(sectionOf(body, "risk-models").rows![0].cells[0]).toBe("Fraud score");
    expect(sectionOf(body, "algorithms").rows).toEqual([]);
    expect(sectionOf(body, "covenants").rows).toBeNull();
    expect(sectionOf(body, "covenants").reason).toMatch(/Only the licence provider/);
    expect(sectionOf(body, "covenant-pauses").rows![0].cells).toEqual(["Lead Trust", "min reserve", "2026-11-20 10:00"]);
    expect(sectionOf(body, "health").rows![0].cells).toEqual(["3", "2026-11-01 00:00 to 2026-11-02 00:00", "published", "partner ledger", "Verified", "abcdef012345"]);
    expect(sectionOf(body, "health").note).toMatch(/Only the product's licence provider and its liquidity providers/);
    expect(called("list_covenants")).toHaveLength(0);
  });

  it("Compliance: sponsorship, this product's obligations (through its apps' workspaces), documents and what the next stage needs", async () => {
    const { body } = await get("green-savings", "compliance");
    expect(sectionOf(body, "sponsorship").rows![0].cells).toEqual(["Lead Trust", "deposit", "approved", "nydfs · money_transmitter · us-ny", "US-NY"]);
    expect(sectionOf(body, "obligations").rows!.map((r) => r.cells[0])).toEqual(["Keep records five years"]);
    expect(called("get_workspace_obligations").map((c) => c.args)).toEqual([{ workspace_id: "ws1" }]);
    expect(sectionOf(body, "documents").rows![0].cells).toEqual(["terms and conditions", "https://example.com/terms"]);
    expect(sectionOf(body, "next-stage").rows![0].cells).toEqual(["Latest test passed", "Failing", "Not tested yet", "Run tests"]);
    expect(called("get_product_promotion_checks")[0].args).toEqual({ product_id: "green-savings", to_stage: "staging" });
  });

  it("Compliance with no app on the product: obligations say why they can't be read", async () => {
    fake.tools = fake.tools.filter((t) => t !== "list_my_apps");
    const { body } = await get("green-savings", "compliance");
    expect(sectionOf(body, "obligations").rows).toBeNull();
    expect(sectionOf(body, "obligations").reason).toMatch(/no app of yours uses this one yet/);
  });

  it("Integrations: hand-offs with the vendor service each is bound to, the firm's services, connections and the ledger", async () => {
    const { body } = await get("green-savings", "integrations");
    expect(sectionOf(body, "handoffs").rows![0].cells).toEqual(["Identity check", "IED", "api", "Acme KYC · kyc", "manual review"]);
    expect(sectionOf(body, "subscriptions").rows![0].cells).toEqual(["Acme KYC", "kyc", "Acme ID", "Sandbox only", "Used by this product"]);
    expect(sectionOf(body, "connections").rows![0].cells).toEqual(["funds", "component deposit", "component card"]);
    expect(sectionOf(body, "ledger").rows![0].cells).toEqual(["Product", "partner ledger", "2026-11-02 00:00", "ok", "0"]);
  });

  it("Apps: the user's apps on this product, each linking to it", async () => {
    const { body } = await get("green-savings", "apps");
    expect(sectionOf(body, "apps").rows).toEqual([{ key: "app-1", href: "/app-1", cells: ["Saver", "Staging", "—"] }]);
  });

  it("Activity: versions and the product's audit trail, with who did what", async () => {
    const { body } = await get("green-savings", "activity");
    expect(sectionOf(body, "versions").rows![0].cells).toEqual(["v1", "draft", "First", "Not tested", "—"]);
    expect(sectionOf(body, "events").rows![0].cells).toEqual(["2026-11-21 09:00", "Archived", "“Parked”", "You"]);
  });

  it("every tab, on a Mynt that offers none of its reads, says it isn't available, never an empty table or a 0", async () => {
    fake.tools = ["list_my_products"];
    for (const tab of ["terms", "customers", "risk", "compliance", "integrations", "apps", "activity"]) {
      const { body } = await get("green-savings", tab);
      if (!body.data.available) {
        expect(body.data.reason).toBeTruthy();
        continue;
      }
      for (const s of body.data.sections) {
        if (s.id === "next-stage") continue; // no tool: says so too
        expect(s.rows, `${tab}/${s.id}`).toBeNull();
        expect(s.reason).toBeTruthy();
      }
    }
  });
});
