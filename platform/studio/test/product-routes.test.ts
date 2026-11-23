import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { parseStudioCall } from "@/lib/studio-tools";

// New app's product routes: the list (what the user may build on, then their own drafts), Create product
// (create_product), and a draft's Test (test_product) and Publish (publish_product). Each needs a signed-in
// developer, writes come only from the studio's own origin, arguments are checked strictly before
// anything reaches Mynt, and Mynt's refusals come back in its words.

const fake = {
  session: undefined as Session | undefined,
  roles: ["developer"] as string[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: {} as Record<string, string>,
  mine: [] as unknown[],
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse[name] }) }] };
      switch (name) {
        case "whoami":
          return ok({ id: "u1", effective_roles: fake.roles });
        case "list_buildable_products":
          return ok([{ id: "dollar-account", name: "Dollar account", product_line: "custody_settlement", region: "US", by: "Lead Trust", access_mode: "open" }]);
        case "list_my_products":
          return ok(fake.mine);
        case "list_regions":
          return ok([{ code: "US", name: "United States", regulators: ["OCC"], active: true }]);
        case "list_product_categories":
          return ok([{ id: "deposits", name: "Deposits", product_lines: ["account_operations"], description: "", active: true }]);
        case "create_product":
          return ok({ ...args, status: "draft" });
        case "test_product":
          return ok({ passed: false, fingerprint: "f", checks: [{ name: "region", status: "fail", message: "Region 'XX' isn't defined or active" }] });
        case "publish_product":
          return ok({ id: args.id, version: 1 });
        case "get_product_promotion_checks":
          return ok({ product_id: args.product_id, from_stage: "idea", to_stage: args.to_stage, checks: [{ id: "tests_passed", label: "Latest test passed (test_product)", status: "pass", detail: "passed" }], can_promote: true });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const productsRoute = await import("@/app/api/products/route");
const productRoute = await import("@/app/api/products/[productId]/route");
const optionsRoute = await import("@/app/api/products/options/route");

const ORIGIN = "http://localhost:3000";
const req = (path: string, method = "GET", body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, body === undefined ? { method } : { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const getReq = (path: string) => Object.assign(req(path), { nextUrl: new URL(`${ORIGIN}${path}`) }) as never;
const product = (id: string) => ({ params: Promise.resolve({ productId: id }) });
const called = (name: string) => fake.calls.filter((c) => c.name === name);

const NEW = {
  id: "green-savings",
  name: "Green Savings",
  product_line: "account_operations",
  category: "deposits",
  region: "US",
  action: "issuance",
  underlying_product_ids: [],
  risk_level: "low",
  liquidity: "high",
  typical_horizon: "short",
  return_type: "fixed_interest",
  regulator: "OCC",
  description: "A savings account that rounds up card spend.",
  key_features: ["Round-ups"],
};

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.roles = ["developer"];
  fake.calls = [];
  fake.refuse = {};
  fake.mine = [];
});

describe("the products list", () => {
  it("lists what the user may build on with its jurisdictions, then their own drafts", async () => {
    fake.mine = [
      { id: "dollar-account", name: "Dollar account", product_line: "custody_settlement", region: "US", status: "published" },
      { id: "green-savings", name: "Green Savings", product_line: "account_operations", region: "US", status: "draft", last_test_passed: null },
    ];
    const body = await (await productsRoute.GET(getReq("/api/products"))).json();
    expect(body.products).toEqual([
      { id: "dollar-account", name: "Dollar account", productLine: "custody_settlement", by: "Lead Trust", accessMode: "open", jurisdictions: ["US"], status: "published", stage: "production", mine: true, lastTestPassed: null },
      { id: "green-savings", name: "Green Savings", productLine: "account_operations", by: "You", accessMode: "", jurisdictions: ["US"], status: "draft", stage: "idea", mine: true, lastTestPassed: null },
    ]);
    // New apps build in the sandbox: products in staging can be picked too.
    expect(called("list_buildable_products")[0].args).toEqual({ environment: "sandbox" });
  });

  it("also gives every product of the user's own, with when it changed, and the hashed key their chats are kept under", async () => {
    fake.mine = [
      { id: "dollar-account", name: "Dollar account", status: "published", published_at: "2026-11-02T00:00:00Z" },
      { id: "green-savings", name: "Green Savings", status: "draft" },
    ];
    const body = await (await productsRoute.GET(getReq("/api/products"))).json();
    expect(body.mine).toEqual([
      { id: "dollar-account", name: "Dollar account", status: "published", stage: "production", updatedAt: "2026-11-02T00:00:00Z" },
      { id: "green-savings", name: "Green Savings", status: "draft", stage: "idea", updatedAt: null },
    ]);
    expect(body.owner).toMatch(/^[A-Za-z0-9_-]{22}$/);
    // ?mine=1: only those, without asking Mynt what can be built on.
    fake.calls = [];
    const only = await (await productsRoute.GET(getReq("/api/products?mine=1"))).json();
    expect(only).toEqual({ mine: body.mine, owner: body.owner });
    expect(called("list_buildable_products")).toEqual([]);
  });

  it("still lists what can be built on when Mynt won't list the user's own products", async () => {
    fake.refuse = { list_my_products: "Unknown tool" };
    const res = await productsRoute.GET(getReq("/api/products"));
    expect(res.status).toBe(200);
    expect((await res.json()).products.map((p: { id: string }) => p.id)).toEqual(["dollar-account"]);
  });
});

describe("Create product (POST /api/products)", () => {
  it("needs a signed-in session", async () => {
    fake.session = undefined;
    expect((await productsRoute.POST(req("/api/products", "POST", NEW))).status).toBe(401);
    expect(called("create_product")).toHaveLength(0);
  });

  it("refuses another origin", async () => {
    expect((await productsRoute.POST(req("/api/products", "POST", NEW, "https://elsewhere.example"))).status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses someone without the developer (innovator) role before it reaches Mynt", async () => {
    fake.session!.roles = ["consumer"];
    const res = await productsRoute.POST(req("/api/products", "POST", NEW));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_developer");
    expect(called("create_product")).toHaveLength(0);
  });

  it("checks the request strictly: the id's rule, extra fields, underlying products for a sale", async () => {
    for (const bad of [
      { ...NEW, id: "Green_Savings" },
      { ...NEW, owner_id: "someone-else" },
      { ...NEW, product_line: "groceries" },
      { ...NEW, region: "United States" },
      { ...NEW, action: "sale", underlying_product_ids: [] },
      { ...NEW, name: "" },
      (({ regulator: _r, ...rest }) => rest)(NEW),
    ]) {
      const res = await productsRoute.POST(req("/api/products", "POST", bad));
      expect(res.status).toBe(400);
    }
    const slug = await productsRoute.POST(req("/api/products", "POST", { ...NEW, id: "Green" }));
    expect((await slug.json()).message).toBe("Use a lowercase slug like 'green-fd'");
    expect(called("create_product")).toHaveLength(0);
  });

  it("creates the draft with create_product's inputs, once", async () => {
    const res = await productsRoute.POST(req("/api/products", "POST", NEW));
    expect(res.status).toBe(201);
    expect(called("create_product")).toEqual([{ name: "create_product", args: NEW }]);
    expect((await res.json()).product).toEqual({ id: "green-savings", name: "Green Savings", productLine: "account_operations", category: "deposits", by: "You", accessMode: "", jurisdictions: ["US"], status: "draft", stage: "idea", mine: true, lastTestPassed: null });
    const sale = { ...NEW, id: "dollar-resale", action: "sale", underlying_product_ids: ["dollar-account"] };
    expect((await productsRoute.POST(req("/api/products", "POST", sale))).status).toBe(201);
    expect(called("create_product")[1].args).toEqual(sale);
  });

  it("shows Mynt's refusal in its words", async () => {
    fake.refuse = { create_product: "A product with id 'green-savings' already exists" };
    const res = await productsRoute.POST(req("/api/products", "POST", NEW));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "mynt_refused", message: "A product with id 'green-savings' already exists" });
  });
});

describe("a draft's Test and Publish (POST /api/products/<id>)", () => {
  it("needs a session, the studio's origin, the developer role, a product id and a known action", async () => {
    fake.session = undefined;
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "test" }), product("green-savings"))).status).toBe(401);
    fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["consumer"], rolesAt: Date.now() } as Session;
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "publish" }), product("green-savings"))).status).toBe(403);
    fake.session.roles = ["innovator"];
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "test" }, "https://elsewhere.example"), product("green-savings"))).status).toBe(403);
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "unpublish" }), product("green-savings"))).status).toBe(400);
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "test", force: true }), product("green-savings"))).status).toBe(400);
    expect((await productRoute.POST(req("/api/products/x", "POST", { action: "test" }), product("../admin"))).status).toBe(400);
    expect(called("test_product")).toHaveLength(0);
    expect(called("publish_product")).toHaveLength(0);
  });

  it("tests with test_product and says which checks failed, in Mynt's words", async () => {
    const res = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "test" }), product("green-savings"));
    expect(res.status).toBe(200);
    expect(called("test_product")).toEqual([{ name: "test_product", args: { id: "green-savings" } }]);
    expect(await res.json()).toEqual({ passed: false, message: "Tests failed: Region 'XX' isn't defined or active" });
  });

  it("publishes with publish_product", async () => {
    const res = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "publish" }), product("green-savings"));
    expect(res.status).toBe(200);
    expect(called("publish_product")).toEqual([{ name: "publish_product", args: { id: "green-savings" } }]);
    expect((await res.json()).published).toBe(true);
  });

  it("shows why Mynt won't publish it (a licence or sponsorship needed)", async () => {
    const reason = "Publishing needs a verified licence for issuance of 'deposits' in US, held by your entity (see find_licenses, register_license), or a composition whose components your licences cover (set_product_composition)";
    fake.refuse = { publish_product: reason };
    const res = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "publish" }), product("green-savings"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "mynt_refused", message: reason });
  });
});

describe("a product's stage (GET and POST /api/products/<id>)", () => {
  it("reads Mynt's checks for the next stage", async () => {
    const res = await productRoute.GET(req("/api/products/green-savings?to=staging"), product("green-savings"));
    expect(res.status).toBe(200);
    expect(called("get_product_promotion_checks")).toEqual([{ name: "get_product_promotion_checks", args: { product_id: "green-savings", to_stage: "staging" } }]);
    const { checks } = await res.json();
    expect(checks.canPromote).toBe(true);
    expect(checks.checks.map((c: { id: string }) => c.id)).toEqual(["tests_passed"]);
    expect((await productRoute.GET(req("/api/products/green-savings?to=idea"), product("green-savings"))).status).toBe(400);
  });

  it("moves it up with promote_product and back with demote_product (a reason needed)", async () => {
    const up = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "promote", to_stage: "staging" }), product("green-savings"));
    expect(up.status).toBe(200);
    expect((await up.json()).stage).toBe("staging");
    expect(called("promote_product")).toEqual([{ name: "promote_product", args: { product_id: "green-savings", to_stage: "staging" } }]);
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "demote", to_stage: "idea" }), product("green-savings"))).status).toBe(400);
    const down = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "demote", to_stage: "idea", reason: "Rates changing" }), product("green-savings"));
    expect(down.status).toBe(200);
    expect(called("demote_product")).toEqual([{ name: "demote_product", args: { product_id: "green-savings", to_stage: "idea", reason: "Rates changing" } }]);
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "promote", to_stage: "idea" }), product("green-savings"))).status).toBe(400);
  });

  it("shows why Mynt won't move it to production, in Mynt's words", async () => {
    const reason = "Not promoted: Licensed: a verified licence or sponsorship covers it: Publishing needs a verified licence for issuance of 'deposits' in US, held by your entity. See get_product_promotion_checks";
    fake.refuse = { promote_product: reason };
    const res = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "promote", to_stage: "production" }), product("green-savings"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "mynt_refused", message: reason });
  });
});

describe("Archive and Unarchive (POST /api/products/<id>, GET /api/products?archived=1)", () => {
  it("archives with archive_product (a reason needed) and unarchives with unarchive_product", async () => {
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "archive" }), product("green-savings"))).status).toBe(400);
    expect((await productRoute.POST(req("/api/products/green-savings", "POST", { action: "archive", reason: "Test product" }, "https://elsewhere.example"), product("green-savings"))).status).toBe(403);
    const off = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "archive", reason: "Test product" }), product("green-savings"));
    expect(off.status).toBe(200);
    expect((await off.json()).archived).toBe(true);
    expect(called("archive_product")).toEqual([{ name: "archive_product", args: { product_id: "green-savings", reason: "Test product" } }]);
    const back = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "unarchive" }), product("green-savings"));
    expect(back.status).toBe(200);
    expect(called("unarchive_product")).toEqual([{ name: "unarchive_product", args: { product_id: "green-savings" } }]);
  });

  it("shows Mynt's refusal for a product in production in its words", async () => {
    const reason = "The product is in production; move it back first (demote_product to staging), then archive it";
    fake.refuse = { archive_product: reason };
    const res = await productRoute.POST(req("/api/products/green-savings", "POST", { action: "archive", reason: "Retired" }), product("green-savings"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "mynt_refused", message: reason });
  });

  it("leaves archived products out of the list and Recent, and lists them apart for the Archived view", async () => {
    fake.mine = [
      { id: "green-savings", name: "Green Savings", product_line: "account_operations", region: "US", status: "draft" },
      { id: "devnet-demo", name: "Devnet demo", product_line: "account_operations", region: "US", status: "draft", stage: "staging", archived: true, archived_at: "2026-11-23T00:00:00Z" },
    ];
    const body = await (await productsRoute.GET(getReq("/api/products"))).json();
    expect(body.products.map((p: { id: string }) => p.id)).toEqual(["dollar-account", "green-savings"]);
    expect(body.mine.map((p: { id: string }) => p.id)).toEqual(["green-savings"]);
    const archived = await (await productsRoute.GET(getReq("/api/products?archived=1"))).json();
    expect(called("list_my_products").at(-1)!.args).toEqual({ include_archived: true });
    expect(archived.products).toEqual([
      { id: "devnet-demo", name: "Devnet demo", productLine: "account_operations", by: "You", accessMode: "", jurisdictions: ["US"], status: "draft", stage: "staging", mine: true, archived: true, lastTestPassed: null },
    ]);
  });
});

describe("Create product's choices", () => {
  it("are Mynt's regions with their regulators, and its categories", async () => {
    const body = await (await optionsRoute.GET()).json();
    expect(body).toEqual({ regions: [{ code: "US", name: "United States", regulators: ["OCC"] }], categories: [{ id: "deposits", name: "Deposits", productLines: ["account_operations"] }] });
  });
});

describe("the allow-list", () => {
  it("has create_product, test_product and publish_product with strict arguments", () => {
    expect(parseStudioCall("create_product", NEW)).toEqual({ tool: "create_product", args: NEW });
    expect(parseStudioCall("create_product", { ...NEW, owner_id: "x" })).toHaveProperty("error");
    expect(parseStudioCall("create_product", { ...NEW, id: "Not A Slug" })).toHaveProperty("error");
    expect(parseStudioCall("test_product", { id: "green-savings" })).toEqual({ tool: "test_product", args: { id: "green-savings" } });
    expect(parseStudioCall("publish_product", { id: "green-savings", force: true })).toHaveProperty("error");
    expect(parseStudioCall("unpublish_product", { id: "green-savings" })).toHaveProperty("error");
    expect(parseStudioCall("promote_product", { product_id: "green-savings", to_stage: "production" })).toEqual({ tool: "promote_product", args: { product_id: "green-savings", to_stage: "production" } });
    expect(parseStudioCall("promote_product", { product_id: "green-savings", to_stage: "idea" })).toHaveProperty("error");
    expect(parseStudioCall("demote_product", { product_id: "green-savings", to_stage: "idea" })).toHaveProperty("error");
    expect(parseStudioCall("archive_product", { product_id: "green-savings", reason: "Test product" })).toEqual({ tool: "archive_product", args: { product_id: "green-savings", reason: "Test product" } });
    expect(parseStudioCall("archive_product", { product_id: "green-savings" })).toHaveProperty("error");
    expect(parseStudioCall("unarchive_product", { product_id: "green-savings" })).toEqual({ tool: "unarchive_product", args: { product_id: "green-savings" } });
    expect(parseStudioCall("unarchive_product", { product_id: "green-savings", stage: "production" })).toHaveProperty("error");
    expect(parseStudioCall("list_my_products", { include_archived: true })).toEqual({ tool: "list_my_products", args: { include_archived: true } });
  });
});
