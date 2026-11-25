// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, parseAdminCall } from "@/lib/studio-tools";

// The platform admin's Risk models routes (GET and POST /api/admin/risk-models, GET and POST
// /api/admin/risk-models/<id>): Mynt admins only (anyone else a 404, nothing sent to Mynt), one risk area at a time,
// strict bodies, each sheet's action to its own tool, and an older Mynt without risk models said as such.

const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  reply: {} as Record<string, unknown>,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));

const list = await import("@/app/api/admin/risk-models/route");
const one = await import("@/app/api/admin/risk-models/[modelId]/route");

const MODEL = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "88888888-8888-4888-8888-888888888888";
const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const req = (path: string, body?: unknown) =>
  new Request(`http://studio.test${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = (modelId: string) => ({ params: Promise.resolve({ modelId }) });
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);
const ADD = { risk_area: "financial", name: "Pool liquidity coverage", purpose: "Whether pools can pay out", method: "Liquid over outflows", inputs: [], outputs: [], thresholds: [{ name: "minimum", value: 1.2 }] };

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
  fake.calls = [];
  fake.reply = {
    list_risk_models: { models: [{ id: MODEL, risk_area: "financial", status: "draft", version: 1, name: "Pool liquidity coverage", purpose: "p", method: "m", inputs: [], outputs: [], thresholds: [], owner: null, validation: { overdue: false } }], counts: { draft: 1, active: 0, retired: 0, overdue: 0 } },
    list_whitelist: { whitelist: [{ email: "boss@example.com", roles: ["admin"] }], users: [{ id: ADMIN_ID, email: "boss@example.com", name: "Boss" }] },
    admin_list_product_risk_models: { models: [{ product: { id: "fd", name: "Fixed deposit" }, firm: null, model: { id: "pd", name: "PD scorecard", purpose: "pd_scorecard" } }] },
    add_risk_model: { model: { id: MODEL } },
  };
});

describe("who gets in", () => {
  it("anyone but a Mynt admin gets 404 from every route, and nothing reaches Mynt", async () => {
    fake.session = session(["developer", "license_provider"]);
    const res = [
      await list.GET(req("/api/admin/risk-models?area=financial")),
      await list.POST(req("/api/admin/risk-models", ADD)),
      await one.GET(req("/x"), p(MODEL)),
      await one.POST(req("/x", { action: "retire", reason: "Old model" }), p(MODEL)),
    ];
    for (const r of res) expect(r.status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it("the risk-model tools are admin tools only, never the studio's", async () => {
    const { STUDIO_TOOLS } = await import("@/lib/studio-tools");
    for (const t of ["list_risk_models", "add_risk_model", "update_risk_model", "validate_risk_model", "retire_risk_model", "admin_list_product_risk_models"]) {
      expect(Object.keys(ADMIN_TOOLS)).toContain(t);
      expect(Object.keys(STUDIO_TOOLS)).not.toContain(t);
    }
    expect(parseAdminCall("add_risk_model", { ...ADD, risk_area: "security" })).toHaveProperty("error");
  });
});

describe("the list", () => {
  it("one area at a time: its models, the admins who may own one; products' own models only on Regulated product risk", async () => {
    const body = await (await list.GET(req("/api/admin/risk-models?area=financial"))).json();
    expect(called("list_risk_models")).toEqual([{ risk_area: "financial" }]);
    expect(called("admin_list_product_risk_models")).toEqual([]);
    expect(body).toMatchObject({ area: "financial", owners: [{ userId: ADMIN_ID, name: "Boss" }], productModels: null });
    expect(body.models.models[0]).toMatchObject({ id: MODEL, status: "draft", name: "Pool liquidity coverage" });
    const reg = await (await list.GET(req("/api/admin/risk-models?area=regulated_product"))).json();
    expect(called("admin_list_product_risk_models")).toEqual([{}]);
    expect(reg.productModels.rows[0]).toMatchObject({ productName: "Fixed deposit", modelName: "PD scorecard", href: null });
    fake.calls = [];
    expect((await list.GET(req("/api/admin/risk-models?area=security"))).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("an older Mynt without risk models says not yet; one without the product read says not available, with why", async () => {
    fake.tools = [{ name: "list_risk_models" }];
    const reg = await (await list.GET(req("/api/admin/risk-models?area=regulated_product"))).json();
    expect(reg.productModels).toEqual({ available: false, reason: "Reading financial products' own risk models comes with Mynt's next update." });
    fake.tools = [];
    expect(await (await list.GET(req("/api/admin/risk-models?area=financial"))).json()).toEqual({ supported: false });
  });

  it("Add risk model sends add_risk_model its own arguments; a body it doesn't take is refused before Mynt is asked", async () => {
    const res = await list.POST(req("/api/admin/risk-models", ADD));
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(MODEL);
    expect(called("add_risk_model")).toEqual([ADD]);
    fake.calls = [];
    for (const bad of [{ ...ADD, risk_area: "security" }, { ...ADD, extra: 1 }, { ...ADD, inputs: "not a list" }, { ...ADD, thresholds: [{ value: 1 }] }]) expect((await list.POST(req("/api/admin/risk-models", bad))).status).toBe(400);
    expect(fake.calls).toEqual([]);
    fake.sameOrigin = false;
    expect((await list.POST(req("/api/admin/risk-models", ADD))).status).toBe(403);
  });
});

describe("one model", () => {
  it("GET reads it with every version and validation", async () => {
    fake.reply.list_risk_models = { model: (fake.reply.list_risk_models as { models: unknown[] }).models[0], versions: [{ version: 1, name: "Pool liquidity coverage" }], validations: [] };
    const body = await (await one.GET(req("/x"), p(MODEL))).json();
    expect(called("list_risk_models")).toEqual([{ model_id: MODEL }]);
    expect(body.detail.model.id).toBe(MODEL);
    expect(body.detail.versions).toHaveLength(1);
    expect((await one.GET(req("/x"), p("../x"))).status).toBe(400);
  });

  it("each action goes to its own tool for this model", async () => {
    await one.POST(req("/x", { action: "edit", method: "Over 45 days", note: "Longer horizon" }), p(MODEL));
    await one.POST(req("/x", { action: "validate", outcome: "passed", notes: "Back-tested", next_validation_due: "2099-01-01" }), p(MODEL));
    await one.POST(req("/x", { action: "retire", reason: "Replaced" }), p(MODEL));
    expect(fake.calls.map((c) => [c.name, c.args])).toEqual([
      ["update_risk_model", { model_id: MODEL, method: "Over 45 days", note: "Longer horizon" }],
      ["validate_risk_model", { model_id: MODEL, outcome: "passed", notes: "Back-tested", next_validation_due: "2099-01-01" }],
      ["retire_risk_model", { model_id: MODEL, reason: "Replaced" }],
    ]);
    fake.calls = [];
    for (const bad of [{ action: "delete" }, { action: "retire" }, { action: "validate", outcome: "fine", notes: "x", next_validation_due: "2099-01-01" }, { action: "edit", model_id: MODEL, name: "Other" }])
      expect((await one.POST(req("/x", bad), p(MODEL))).status).toBe(400);
    expect((await one.POST(req("/x", { action: "retire", reason: "Replaced" }), p("nope"))).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});
