// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS } from "@/lib/studio-tools";

// The platform admin's Audit trails and Risk register routes (GET /api/admin/audit, GET and POST /api/admin/risks):
// Mynt admins only (anyone else a 404, with nothing sent to Mynt), a strict query, Mynt's own register kept on the
// platform subject, and every part Mynt can't answer said as "not available" with why.

const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: {} as Record<string, string>,
  reply: {} as Record<string, unknown>,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: fake.refuse[name] }] };
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));

const audit = await import("@/app/api/admin/audit/route");
const risks = await import("@/app/api/admin/risks/route");

const WS = "11111111-1111-4111-8111-111111111111";
const FIRM = "33333333-3333-4333-8333-333333333333";
const RISK = "77777777-7777-4777-8777-777777777777";
const ADMIN_ID = "88888888-8888-4888-8888-888888888888";
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const req = (path: string, body?: unknown) =>
  new Request(`http://studio.test${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);

const LOG = [
  { id: "a1", actor_id: ADMIN_ID, actor_email: "boss@example.com", action: "rotate_subscription_secret", target: "sub-1", details: { workspace_id: WS, secret: "never-shown", note: "rotated" }, created_at: daysAgo(1), class: "security" },
  { id: "a2", actor_id: null, actor_email: null, action: "set_entity_status", target: FIRM, details: { status: "suspended" }, created_at: daysAgo(2), class: "obligations" },
  { id: "a3", actor_id: ADMIN_ID, actor_email: "boss@example.com", action: "revoke_user", target: "x@example.com", details: {}, created_at: daysAgo(45), class: "security" },
];

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = [...Object.keys(ADMIN_TOOLS), "list_risks", "add_risk", "update_risk", "admin_list_risks"].map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = {};
  fake.reply = {
    audit_log: LOG,
    list_all_workspaces: { workspaces: [{ id: WS, name: "Team", status: "active" }], total: 1 },
    list_entities: [{ id: FIRM, name: "Acme Trust", members: [] }],
    list_whitelist: { whitelist: [{ email: "boss@example.com", roles: ["admin"] }], users: [{ id: ADMIN_ID, email: "boss@example.com", name: "Boss" }] },
    list_risks: { subject_type: "platform", subject_id: "mynt", can_manage: true, risks: [{ id: RISK, subject_type: "platform", subject_id: "mynt", title: "Key leak", category: "security", likelihood: 2, impact: 5, status: "open", review_by: "2026-01-01", overdue: true }], counts: { overdue: 1 } },
    admin_list_risks: {
      counts: { critical: 1, high: 0, medium: 2, low: 0 },
      overdue: 1,
      total: 3,
      risks: [
        { id: "r1", subject_type: "app", subject_id: "app-1", subject_name: "Saver", workspace_id: WS, title: "Fraud ring", category: "fraud", likelihood: 4, impact: 4, score: 16, status: "open", overdue: false },
        { id: "r2", subject_type: "product", subject_id: "p1", subject_name: "Fixed deposit", firm_id: FIRM, title: "Rate shock", category: "credit", likelihood: 3, impact: 3, score: 9, status: "mitigating", overdue: true },
      ],
    },
    ops_status: {
      attention: ["backups are on this server only; add an off-site bucket"],
      window_hours: 24,
      agents: {},
      vendors: { failed_conformance: [{ offering_id: "o1", offering: "Fast KYC", created_at: daysAgo(0) }], erroring_subscriptions: [] },
      apps: { production_without_program_agreements: [{ app_id: "app-1", app_name: "Saver", missing: 1 }] },
      agreement_audits: { overdue: 2, apps_flagged: 1 },
      backups: { last_run_at: daysAgo(0), ok: true, offsite: "local_only", last_success_at: daysAgo(0) },
    },
  };
});

describe("who gets in", () => {
  it("anyone but a Mynt admin gets 404 from both routes, and nothing reaches Mynt's admin tools", async () => {
    fake.session = session(["developer", "license_provider"]);
    for (const res of [await audit.GET(req("/api/admin/audit")), await risks.GET(req("/api/admin/risks?area=technology")), await risks.POST(req("/api/admin/risks", { action: "add", title: "X risk", category: "security", risk_area: "technology", likelihood: 1, impact: 1 }))]) expect(res.status).toBe(404);
    expect(fake.calls).toEqual([]);
    fake.session = undefined;
    expect((await audit.GET(req("/api/admin/audit"))).status).toBe(401);
  });

  it("the audit route takes only a limit (1 to 500); anything else is refused before Mynt is asked", async () => {
    for (const q of ["?class=security", "?limit=0", "?limit=501", "?limit=abc", "?cursor=x"]) expect((await audit.GET(req(`/api/admin/audit${q}`))).status, q).toBe(400);
    expect(fake.calls).toEqual([]);
    await audit.GET(req("/api/admin/audit?limit=50"));
    expect(called("audit_log")).toEqual([{ limit: 50 }]);
  });
});

describe("Audit trails", () => {
  it("the newest 500 entries, each with its class, workspace and firm by name; secrets never shown", async () => {
    const body = await (await audit.GET(req("/api/admin/audit"))).json();
    expect(called("audit_log")).toEqual([{ limit: 500 }]);
    expect(body.limit).toBe(500);
    const [a1, a2] = body.entries;
    expect(a1).toMatchObject({ id: "a1", class: "security", actor: { email: "boss@example.com" }, workspace: { id: WS, name: "Team" }, targetType: "vendor" });
    expect(a1.details).toEqual([["workspace_id", WS], ["secret", "Hidden"], ["note", "rotated"]]);
    expect(JSON.stringify(body)).not.toContain("never-shown");
    expect(a2).toMatchObject({ firm: { id: FIRM, name: "Acme Trust" }, targetType: "firm", actor: { email: null } });
  });

  it("an older Mynt without the audit log says not yet", async () => {
    fake.tools = [];
    expect(await (await audit.GET(req("/api/admin/audit"))).json()).toEqual({ supported: false });
  });
});

describe("Risk register: one risk area at a time", () => {
  const get = async (area?: string) => (await risks.GET(req(`/api/admin/risks${area ? `?area=${area}` : ""}`))).json();

  it("the area's part of Mynt's own register and its unassigned risks; the risks across apps and products in that area, mapped from their category", async () => {
    const body = await get("operations");
    expect(body.area).toBe("operations");
    expect(called("list_risks")).toEqual([
      { subject_type: "platform", subject_id: "mynt", risk_area: "operations" },
      { subject_type: "platform", subject_id: "mynt", risk_area: "unassigned" },
    ]);
    expect(called("admin_list_risks")).toEqual([{ limit: 100, risk_area: "operations" }]);
    expect(body.register).toMatchObject({ available: true, canManage: true, overdue: 1, owners: [{ userId: ADMIN_ID, name: "Boss" }] });
    expect(body.unassigned.available).toBe(true);
    // Fraud is an operations risk (the Rate shock, credit, is financial), and Mynt's own never shows here.
    expect(body.cross.risks.map((r: { id: string; href: string }) => [r.id, r.href])).toEqual([["r1", `/platform/workspaces/${WS}`]]);
    expect((await get("financial")).cross.risks.map((r: { id: string; href: string }) => [r.id, r.href])).toEqual([["r2", `/platform/firms/${FIRM}?tab=products`]]);
    // No area: the first one. Anything else is refused before Mynt is asked.
    expect((await get()).area).toBe("financial");
    fake.calls = [];
    expect((await risks.GET(req("/api/admin/risks?area=security"))).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("each area's signals: Technology security events and backups, Third-party vendors, Compliance agreements, Operations agents and hosting, Financial pools", async () => {
    fake.reply.ops_status = {
      ...(fake.reply.ops_status as Record<string, unknown>),
      attention: ["hosting: 2 app(s) stopped", "builds: 1 failed in the last 24h", "liquidity pools: 1 open over_withdrawal flag(s) on real money: list_pool_flags, then resolve_pool_flag", "covenants: 1 open breach(es) on live figures (list_covenant_breaches)", "backups are on this server only; add an off-site bucket"],
      covenants: { open_breaches: 1 },
      product_health: { stalled: [] },
    };
    const ids = (b: { signals: { id: string }[] }) => b.signals.map((s) => s.id);
    const tech = await get("technology");
    expect(ids(tech)).toEqual(["security", "backups"]);
    expect(tech.signals[0].signal.rows.map((r: { key: string }) => r.key)).toEqual(["a1"]); // the security class, the last 30 days only
    // Backups: one row under Last run, Result, Off-site, Last success, Last restore test.
    expect(tech.signals[1].columns).toEqual(["Last run", "Result", "Off-site", "Last success", "Last restore test"]);
    expect(tech.signals[1].signal.rows).toHaveLength(1);
    expect(tech.signals[1].signal.rows[0].cells.slice(1, 3)).toEqual(["Succeeded", "On this server only"]);
    expect(tech.signals[1].signal.rows[0].cells[4]).toBe("Not recorded");
    expect(called("audit_log")).toEqual([{ limit: 500 }]); // only Technology reads the audit log
    expect((await get("third_party")).signals[0].signal.rows[0].cells[0]).toBe("Fast KYC");
    // Compliance: the apps missing an agreement and the overdue audits are a table each.
    const comp = await get("compliance");
    expect(ids(comp)).toEqual(["agreements", "audits"]);
    expect(comp.signals[0].signal.rows.map((r: { cells: string[] }) => r.cells)).toEqual([["Saver", "1 signed program agreement missing"]]);
    expect(comp.signals[1].signal.rows.map((r: { cells: string[] }) => r.cells)).toEqual([["2", "1"]]);
    // Operations: Area, Item, Since. ops_status has no list behind these lines here, so Since isn't recorded.
    expect((await get("operations")).signals[0].signal.rows.map((r: { cells: string[] }) => r.cells)).toEqual([
      ["Hosting", "2 app(s) stopped", "Not recorded"],
      ["Builds", "1 failed in the last 24h", "Not recorded"],
    ]);
    expect((await get("financial")).signals[0].signal.rows.map((r: { cells: string[] }) => r.cells)).toEqual([["Liquidity pools", expect.stringMatching(/^1 open over_withdrawal flag/)]]);
    const bp = await get("business_process");
    expect(ids(bp)).toEqual(["covenants", "drift"]);
    expect(bp.signals[0].signal.rows.map((r: { cells: string[] }) => r.cells)).toEqual([["Covenants", expect.stringMatching(/^1 open breach/)]]);
    expect(bp.signals[1].signal).toMatchObject({ available: false });
    expect(ids(await get("regulated_product"))).toEqual(["covenants", "product-health", "drift"]);
  });

  it("each part this Mynt can't answer is not available, with why, never an empty table or a 0", async () => {
    fake.tools = [];
    for (const area of ["financial", "compliance", "third_party", "operations", "business_process", "technology", "regulated_product"]) {
      const body = await get(area);
      for (const part of [body.register, body.unassigned, body.cross, ...body.signals.map((s: { signal: unknown }) => s.signal)]) {
        expect(part.available, area).toBe(false);
        expect(part.reason.length).toBeGreaterThan(10);
      }
    }
    // An audit log without classes can't pick out security events.
    fake.tools = [{ name: "audit_log" }];
    fake.reply.audit_log = LOG.map(({ class: _c, ...e }) => e);
    expect((await get("technology")).signals[0].signal).toMatchObject({ available: false });
  });

  it("Add risk (with its area) and Review risk go to Mynt's own register only", async () => {
    const add = await risks.POST(req("/api/admin/risks", { action: "add", title: "Key leak", category: "security", risk_area: "technology", likelihood: 2, impact: 5, description: "" }));
    expect(add.status).toBe(200);
    expect(called("add_risk")).toEqual([{ subject_type: "platform", subject_id: "mynt", title: "Key leak", category: "security", risk_area: "technology", likelihood: 2, impact: 5 }]);
    // A platform risk always has an area.
    const none = await risks.POST(req("/api/admin/risks", { action: "add", title: "Key leak", category: "security", likelihood: 2, impact: 5 }));
    expect(none.status).toBe(400);
    expect((await none.json()).message).toMatch(/area/);
    await risks.POST(req("/api/admin/risks", { action: "review", risk_id: RISK, risk_area: "operations", status: "mitigating", note: "Rotating keys" }));
    expect(called("list_risks").at(-1)).toEqual({ subject_type: "platform", subject_id: "mynt", risk_id: RISK });
    expect(called("update_risk")).toEqual([{ risk_id: RISK, risk_area: "operations", status: "mitigating", note: "Rotating keys" }]);
    // Strict bodies: no other subject can be named, nor an area that isn't one.
    expect((await risks.POST(req("/api/admin/risks", { action: "add", title: "X risk", category: "security", risk_area: "technology", likelihood: 1, impact: 1, subject_type: "app" }))).status).toBe(400);
    expect((await risks.POST(req("/api/admin/risks", { action: "add", title: "X risk", category: "security", risk_area: "security", likelihood: 1, impact: 1 }))).status).toBe(400);
    fake.sameOrigin = false;
    expect((await risks.POST(req("/api/admin/risks", { action: "add", title: "X risk", category: "security", risk_area: "technology", likelihood: 1, impact: 1 }))).status).toBe(403);
  });
});
