// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, FIRM_TOOLS, parseAdminCall, parseFirmCall, parseStudioCall, STUDIO_TOOLS } from "@/lib/studio-tools";

// Platform admin → Regulated firms: the list's onboarding progress (get_regulated_firm_onboarding { all_firms }), a
// firm's checklist with its real-company check and the registers' answers (get_regulated_firm_onboarding { entity_id }),
// and Run checks (run_firm_checks). Only for an account Mynt says is an admin; a write only from the studio's own page.

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

const firms = await import("@/app/api/admin/firms/route");
const firm = await import("@/app/api/admin/firms/[firmId]/route");
const checks = await import("@/app/api/admin/firms/[firmId]/checks/route");

const FIRM = "33333333-3333-4333-8333-333333333333";
const VENDOR_FIRM = "34343434-3434-4343-8343-343434343434";
const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const req = (path: string, body?: unknown) =>
  new Request(`http://localhost:3000${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = (firmId: string) => ({ params: Promise.resolve({ firmId }) });
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);

const STEPS = [
  { key: "firm_registered", title: "Your firm is registered with Mynt", status: "done", detail: "Acme Trust is registered with Mynt and active.", tool: "register_firm", by: "admin", informational: false, facts: {} },
  {
    key: "real_company_check",
    title: "Real-company check passed",
    status: "blocked",
    detail: "Not passed. GLEIF's LEI record: not found (2026-11-20).",
    tool: "run_firm_checks",
    by: "admin",
    informational: false,
    facts: { rule: "lei_or_msb", rule_text: "a matching GLEIF LEI record or a matching FinCEN MSB registration, and no mismatch or lapse", passes: false, reasons: ["gleif_lei: not_found"], last_run_at: "2026-11-20T10:00:00.000Z", last_answer_at: "2026-11-20T10:00:00.000Z" },
  },
];

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = {};
  fake.reply = {
    list_entities: [
      { id: FIRM, name: "Acme Trust", status: "active", regions: ["US"], members: [{ id: "u1", name: "Lee", email: "lee@example.com", roles: ["license_provider"] }], licenses: [] },
      { id: VENDOR_FIRM, name: "KYC Works", status: "active", regions: ["US"], members: [{ id: "u2", name: "Vera", email: "vera@example.com", roles: ["vendor"] }], licenses: [] },
    ],
    get_regulated_firm_onboarding: {
      firms: [{ entity_id: FIRM, name: "Acme Trust", status: "active", licence_provider_members: 1, licences: 2, sponsorships_approved: 0, real_company_check: { rule: "lei_or_msb", passes: false, last_run_at: null }, ready_to_sponsor: false, progress: { done: 5, total: 7, next: { key: "real_company_check", title: "Real-company check passed", status: "blocked", tool: "run_firm_checks" }, complete: false } }],
    },
    run_firm_checks: {
      results: [{ source: "gleif_lei", status: "match" }, { source: "fincen_msb", status: "unavailable" }],
      legitimacy: { rule: "lei_or_msb", passes: true, reasons: [] },
      drifted_products: [],
    },
  };
});

describe("Regulated firms: onboarding and the real-company check", () => {
  it("the list carries each regulated firm's progress; a firm that isn't a licence provider's has none; a Mynt without the tool leaves it unknown", async () => {
    const body = await (await firms.GET()).json();
    expect(called("get_regulated_firm_onboarding")).toEqual([{ all_firms: true }]);
    expect(body.firms[0].onboarding).toEqual({ entityId: FIRM, done: 5, total: 7, complete: false, next: { title: "Real-company check passed", waiting: true }, checkPasses: false, readyToSponsor: false });
    expect(body.firms[1].onboarding).toBeNull();
    fake.tools = fake.tools.filter((t) => t.name !== "get_regulated_firm_onboarding");
    const older = await (await firms.GET()).json();
    expect(older.firms).toHaveLength(2);
    expect("onboarding" in older.firms[0]).toBe(false);
  });

  it("a firm's page reads its checklist, the check and the registers' answers by its id", async () => {
    fake.reply.get_regulated_firm_onboarding = {
      entity: { id: FIRM, name: "Acme Trust", status: "active" },
      steps: STEPS,
      progress: { done: 1, total: 7, next: null, complete: false },
      ready_to_sponsor: false,
      checks: [{ id: "c1", source: "gleif_lei", source_name: "GLEIF's LEI record", status: "not_found", status_words: "not found", at: "2026-11-20T10:00:00.000Z", note: "No LEI record", scheduled: true }],
    };
    const body = await (await firm.GET(req("/x"), p(FIRM))).json();
    expect(called("get_regulated_firm_onboarding")).toEqual([{ entity_id: FIRM }]);
    expect(body.onboarding.check).toMatchObject({ passes: false, rule: "lei_or_msb", reasons: ["gleif_lei: not_found"], lastRunAt: "2026-11-20T10:00:00.000Z" });
    expect(body.onboarding.checks).toEqual([{ id: "c1", source: "gleif_lei", sourceName: "GLEIF's LEI record", status: "not_found", statusWords: "not found", at: "2026-11-20T10:00:00.000Z", note: "No LEI record", scheduled: true }]);
    expect(body.onboarding.steps.map((s: { key: string }) => s.key)).toEqual(["firm_registered", "real_company_check"]);
    fake.tools = fake.tools.filter((t) => t.name !== "get_regulated_firm_onboarding");
    expect((await (await firm.GET(req("/x"), p(FIRM))).json()).onboarding).toBeNull();
  });

  it("Run checks → run_firm_checks, answering each register's result in words; an outage is said as such, never a failure", async () => {
    const res = await checks.POST(req("/x", {}), p(FIRM));
    expect(res.status).toBe(200);
    expect(called("run_firm_checks")).toEqual([{ entity_id: FIRM }]);
    expect(await res.json()).toEqual({
      ok: true,
      passes: true,
      message: "GLEIF's LEI record: matches. FinCEN's MSB registrant list: couldn't be reached (not a failure; Mynt tries again daily). The firm passes the real-company check.",
    });
    // No LEI on record: GLEIF isn't asked, and that's said; drifted products are counted.
    fake.reply.run_firm_checks = { results: [{ source: "fincen_msb", status: "not_found" }], legitimacy: { rule: "lei_or_msb", passes: false, reasons: ["x"] }, drifted_products: ["p1"] };
    expect((await (await checks.POST(req("/x", {}), p(FIRM))).json()).message).toBe(
      "GLEIF's LEI record: not asked (the firm has no valid LEI on record). FinCEN's MSB registrant list: not found. The firm doesn't pass the real-company check yet. 1 published product it sponsors drifted.",
    );
    // The check off on this Mynt: not measured, never called a pass.
    fake.reply.run_firm_checks = { results: [{ source: "fincen_msb", status: "not_found" }], legitimacy: { rule: "off", passes: true, reasons: [] }, drifted_products: [] };
    expect(await (await checks.POST(req("/x", {}), p(FIRM))).json()).toMatchObject({ passes: null, message: expect.stringMatching(/This Mynt doesn't require the real-company check\.$/) });
  });

  it("Run checks: Mynt's refusal in its words; nothing sent from another origin, with a body, for a bad id, or by someone who isn't an admin", async () => {
    fake.refuse.run_firm_checks = JSON.stringify({ error: "No firm 'x'" });
    const refused = await checks.POST(req("/x", {}), p(FIRM));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toBe("No firm 'x'");
    fake.calls = [];
    fake.refuse = {};
    expect((await checks.POST(req("/x", { entity_id: VENDOR_FIRM }), p(FIRM))).status).toBe(400);
    expect((await checks.POST(req("/x", {}), p("../x"))).status).toBe(400);
    fake.sameOrigin = false;
    expect((await checks.POST(req("/x", {}), p(FIRM))).status).toBe(403);
    fake.sameOrigin = true;
    for (const roles of [["consumer", "developer", "innovator"], ["license_provider"], ["vendor"]]) {
      fake.session = session(roles);
      expect((await checks.POST(req("/x", {}), p(FIRM))).status).toBe(404);
      expect((await firm.GET(req("/x"), p(FIRM))).status).toBe(404);
    }
    fake.session = undefined;
    expect((await checks.POST(req("/x", {}), p(FIRM))).status).toBe(401);
    expect(fake.calls).toEqual([]);
    fake.session = session(["admin"]);
    fake.tools = fake.tools.filter((t) => t.name !== "run_firm_checks");
    expect((await checks.POST(req("/x", {}), p(FIRM))).status).toBe(501);
  });

  it("the tools are on the right lists: an admin reads any firm or all of them and runs checks; a licence provider's studio call only ever reads its own", () => {
    expect(parseAdminCall("get_regulated_firm_onboarding", { all_firms: true })).toHaveProperty("tool");
    expect(parseAdminCall("get_regulated_firm_onboarding", { entity_id: FIRM })).toHaveProperty("tool");
    expect(parseAdminCall("get_regulated_firm_onboarding", { entity_id: FIRM, all_firms: true })).toHaveProperty("error");
    expect(parseAdminCall("get_regulated_firm_onboarding", {})).toHaveProperty("error");
    expect(parseAdminCall("run_firm_checks", { entity_id: FIRM })).toHaveProperty("tool");
    expect(parseAdminCall("run_firm_checks", {})).toHaveProperty("error");
    expect(parseFirmCall("get_regulated_firm_onboarding", {})).toHaveProperty("tool");
    expect(parseFirmCall("get_regulated_firm_onboarding", { entity_id: FIRM })).toHaveProperty("error");
    expect(parseFirmCall("get_regulated_firm_onboarding", { all_firms: true })).toHaveProperty("error");
    expect(parseFirmCall("run_firm_checks", { entity_id: FIRM })).toHaveProperty("error"); // only Mynt's admins run them
    expect(parseStudioCall("run_firm_checks", { entity_id: FIRM })).toHaveProperty("error");
    const writes = ["approve_sponsorship", "decline_sponsorship", "revoke_sponsorship", "register_license", "set_entity_facts", "add_party", "end_party", "decide_firm_member"];
    for (const t of writes) {
      expect(Object.keys(FIRM_TOOLS)).toContain(t);
      expect(parseAdminCall(t, {})).toHaveProperty("error"); // never an admin acting for a firm
      expect(Object.keys(STUDIO_TOOLS)).not.toContain(t); // nor the chat, Ask AI or any other page
    }
    // None of a firm's tools takes a firm id: Mynt acts for the caller's own firm.
    for (const [name, schema] of Object.entries(FIRM_TOOLS)) expect(schema.safeParse({ entity_id: FIRM }).success, name).toBe(false);
  });
});
