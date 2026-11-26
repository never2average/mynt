import { describe, expect, it, vi } from "vitest";
import { ADMIN_ASK_TOOLS } from "@/lib/admin-ask";
import { ASK_TOOLS } from "@/lib/ask";
import { cleanAnswer, conversationFrom, hasUncited, seconds } from "@/lib/ask-answer";
import { argsSummary, ASK_READS, MAX_ROW_SOURCES, readLabel, readSummary, sourcesOf } from "@/lib/ask-sources";
import { HIDDEN, scrub, scrubText } from "@/lib/scrub";
import { isStudioPath } from "@/lib/studio-search";

vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({}) }));
const { MAX_RESULT_SHOWN, shownResult } = await import("@/lib/ask-server");

// Ask AI's reads in words, the sources they give an answer, and what keeps secrets out of what the panel shows.

const APP = "a1";
const WS = "44444444-4444-4444-8444-444444444444";
const FIRM = "33333333-3333-4333-8333-333333333333";
const RISK = "55555555-5555-4555-8555-555555555555";

// A reply of each read, as Mynt returns it, with what its sources must be: [title, href] each, the read's page first.
type Case = { args?: Record<string, unknown>; result: unknown; sources: [string, string][]; summary: string };
const STUDIO: Record<(typeof ASK_TOOLS)[number], Case> = {
  whoami: { result: { id: "u1", name: "Ines" }, sources: [["Settings › Your account", "/settings"]], summary: "Read" },
  list_my_apps: {
    result: [{ id: APP, name: "Round-up savings", stage: "production" }, { id: "a2", name: "Budgeting", stage: "staging" }],
    sources: [["Dashboard › Apps", "/"], ["Apps › Round-up savings", "/a1"], ["Apps › Budgeting", "/a2"]],
    summary: "2 apps",
  },
  list_buildable_products: { result: { total: 1, products: [{ id: "p1", name: "Card credit" }] }, sources: [["Build › Products to build on", "/new"], ["Build › Products › Card credit", "/new"]], summary: "1 product" },
  get_product: { args: { id: "p1" }, result: { id: "p1", name: "Card credit" }, sources: [["Build › Products › Card credit", "/new"]], summary: "Read" },
  get_developer_dashboard: { result: { money_moved: null }, sources: [["Dashboard", "/"]], summary: "Read" },
  get_linked_accounts: { result: { git: null, wallets: [] }, sources: [["Settings › Linked accounts", "/settings"]], summary: "Read" },
  list_workspaces: { result: [{ id: "w1", name: "Acme", role: "owner" }], sources: [["Settings › Workspaces", "/settings"], ["Settings › Workspaces › Acme", "/settings"]], summary: "1 workspace" },
  list_workspace_members: {
    args: { workspace_id: "w1" },
    result: { members: [{ user_id: "u1", name: "Ines Diaz", email: "ines@example.com", role: "owner" }, { user_id: "u2", name: null, email: "omar@example.com", role: "member" }] },
    sources: [["Settings › Members", "/settings?tab=members"], ["Settings › Members › Ines Diaz", "/settings?tab=members"], ["Settings › Members › omar@example.com", "/settings?tab=members"]],
    summary: "2 members",
  },
  list_my_invitations: { result: { invitations: [] }, sources: [["Settings › Invitations", "/settings"]], summary: "0 invitations" },
  get_compliance_coverage: { result: { states: [] }, sources: [["Licences › Coverage", "/licences"]], summary: "Read" },
  list_workspace_licences: { args: { workspace_id: "w1" }, result: { licences: [{ license_type: "Money transmitter", regulator: "NYDFS" }] }, sources: [["Licences", "/licences"], ["Licences › Money transmitter", "/licences"]], summary: "1 licence" },
  list_workspace_audit: {
    args: { workspace_id: "w1" },
    result: { events: [{ action: "app.created", at: "2026-11-01T00:00:00Z" }, { action: "app.created", at: "2026-11-02T00:00:00Z" }, { action: "member.invited" }] },
    // Two entries of one action are one source: the trail filtered by that action.
    sources: [["Audits", "/audits"], ["Audits › app.created", "/audits?action=app.created"], ["Audits › member.invited", "/audits?action=member.invited"]],
    summary: "3 entries",
  },
  list_builds: { result: [{ id: "b1", goal: "Add a card screen", status: "succeeded" }], sources: [["Builds", "/builds"], ["Builds › Add a card screen", "/builds"]], summary: "1 build" },
  get_build: { args: { build_id: "b1" }, result: { id: "b1", goal: "Add a card screen" }, sources: [["Builds › Add a card screen", "/builds"]], summary: "Read" },
};

const ADMIN: Record<(typeof ADMIN_ASK_TOOLS)[number], Case> = {
  ops_status: { result: { attention: [] }, sources: [["Overview › What needs attention", "/platform"]], summary: "Read" },
  list_all_workspaces: { result: { workspaces: [{ id: WS, name: "Harbor Lending" }], total: 1 }, sources: [["Workspaces", "/platform/workspaces"], ["Workspaces › Harbor Lending", `/platform/workspaces/${WS}`]], summary: "1 workspace" },
  admin_get_workspace: { args: { workspace_id: WS }, result: { workspace: { id: WS, name: "Harbor Lending" }, members: [] }, sources: [["Workspaces › Harbor Lending", `/platform/workspaces/${WS}`]], summary: "Read" },
  list_entities: { result: [{ id: FIRM, name: "Atlas Trust Bank" }], sources: [["Regulated firms", "/platform/firms"], ["Regulated firms › Atlas Trust Bank", `/platform/firms/${FIRM}`]], summary: "1 firm" },
  list_whitelist: { result: { public_signup: false, whitelist: [], users: [{ id: "u1", name: "Ana Admin", email: "ana@example.com" }] }, sources: [["Overview › People and invitations", "/platform"], ["Overview › People › Ana Admin", "/platform"]], summary: "1 person" },
  list_license_reviews: {
    result: [{ id: "l1", entity_id: FIRM, entity: "Atlas Trust Bank", license_type: "Bank charter", status: "pending" }],
    sources: [["Regulated firms › Licences", "/platform/firms?tab=licences"], ["Regulated firms › Atlas Trust Bank › Licences › Bank charter", `/platform/firms/${FIRM}`]],
    summary: "1 licence",
  },
  list_service_types: { result: [{ id: "kyc_basic", name: "Identity check" }], sources: [["Vendors › Service types", "/platform/vendors"], ["Vendors › Service types › Identity check", "/platform/vendors"]], summary: "1 service type" },
  list_vendor_offerings: { args: { include_unlisted: true }, result: { offerings: [{ id: "o1", name: "Verify ID" }] }, sources: [["Vendors › Services", "/platform/vendors"], ["Vendors › Services › Verify ID", "/platform/vendors"]], summary: "1 service" },
  get_vendor_onboarding: { args: { all_firms: true }, result: { firms: [{ entity_id: FIRM, name: "Acme Trust" }] }, sources: [["Vendors › Onboarding", "/platform/vendors"], ["Vendors › Acme Trust › Onboarding", `/platform/firms/${FIRM}`]], summary: "1 vendor" },
  get_regulated_firm_onboarding: {
    args: { all_firms: true },
    result: { firms: [{ entity_id: FIRM, name: "Atlas Trust Bank" }] },
    sources: [["Regulated firms › Onboarding", "/platform/firms"], ["Regulated firms › Atlas Trust Bank › Onboarding", `/platform/firms/${FIRM}`]],
    summary: "1 firm",
  },
  audit_log: { result: [{ action: "review_license", actor: "ana" }], sources: [["Audit trails", "/platform/audit"], ["Audit trails › review_license", "/platform/audit"]], summary: "1 entry" },
  admin_list_risks: { result: { risks: [{ id: RISK, title: "Vendor outage" }], total: 1 }, sources: [["Risk register › Every register", "/platform/risk-register"], ["Risk register › Vendor outage", `/platform/risk-register/${RISK}`]], summary: "1 risk" },
  list_risks: { args: { subject_type: "platform", subject_id: "mynt" }, result: { risks: [] }, sources: [["Risk register › Mynt's own risks", "/platform/risk-register"]], summary: "0 risks" },
  get_risk: { args: { risk_id: RISK }, result: { risk: { id: RISK, title: "Vendor outage" } }, sources: [["Risk register › Vendor outage", `/platform/risk-register/${RISK}`]], summary: "Read" },
  list_risk_models: { result: { models: [{ id: "m1", name: "Credit scorecard" }] }, sources: [["Risk models", "/platform/risk-models"], ["Risk models › Credit scorecard", "/platform/risk-models"]], summary: "1 model" },
  admin_list_product_risk_models: { result: { models: [{ id: "m2", name: "Affordability" }], products: 1 }, sources: [["Risk models › Products' models", "/platform/risk-models"], ["Risk models › Products' models › Affordability", "/platform/risk-models"]], summary: "1 model" },
  get_platform_settings: { result: { settings: [{ key: "BUILD_CAP_USD", value: "5" }] }, sources: [["Platform settings", "/platform/settings"], ["Platform settings › BUILD_CAP_USD", "/platform/settings"]], summary: "1 setting" },
  get_risk_grading: { result: { version: 1 }, sources: [["Platform settings › Risk grading", "/platform/settings"]], summary: "Read" },
  get_esign_settings: { result: { provider: "signwell", key_set: true }, sources: [["Platform settings › E-signature", "/platform/settings"]], summary: "Read" },
  list_enclave_releases: { result: { releases: [{ id: "r1", release: "2026.11.1" }] }, sources: [["Platform settings › Confidential service releases", "/platform/settings"], ["Platform settings › Confidential service releases › 2026.11.1", "/platform/settings"]], summary: "1 release" },
};

describe("the source mapper", () => {
  it("covers every read on both allow-lists, and nothing else", () => {
    expect(Object.keys(ASK_READS.studio).sort()).toEqual([...ASK_TOOLS].sort());
    expect(Object.keys(ASK_READS.admin).sort()).toEqual([...ADMIN_ASK_TOOLS].sort());
  });

  for (const [area, cases] of [["studio", STUDIO], ["admin", ADMIN]] as const)
    for (const [tool, c] of Object.entries(cases))
      it(`${area} ${tool}: its page, then each record's own page`, () => {
        const got = sourcesOf(area, tool, c.args ?? {}, c.result);
        expect(got.map((s) => [s.title, s.href])).toEqual(c.sources);
        // Every source is a page of Studio, in its own area.
        for (const s of got) {
          expect(isStudioPath(s.href), s.href).toBe(true);
          if (area === "admin") expect(s.href).toMatch(/^\/platform(\/|\?|$)/);
          else expect(s.href).not.toMatch(/^\/platform/);
        }
        expect(readSummary(area, tool, c.result)).toBe(c.summary);
        expect(readLabel(area, tool)).toMatch(/^Read [a-zA-Z]/);
        // A reply that isn't what was expected still has the read's page, and never throws.
        for (const odd of [null, "text", 7, [], [null, 3, "x"], { rows: "no" }]) expect(sourcesOf(area, tool, {}, odd).length).toBeGreaterThanOrEqual(1);
      });

  it("lists at most a dozen records of a read; the rest are covered by its page", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, name: `App ${i}` }));
    const got = sourcesOf("studio", "list_my_apps", {}, many);
    expect(got).toHaveLength(MAX_ROW_SOURCES + 1);
    expect(got[0]).toEqual({ title: "Dashboard › Apps", href: "/" });
    expect(readSummary("studio", "list_my_apps", many)).toBe("40 apps");
  });

  it("never puts what isn't an id into an address", () => {
    for (const id of ["../x", "a b", "//evil.example", "a?b=c", "", 7, null]) {
      expect(sourcesOf("studio", "list_my_apps", {}, [{ id, name: "X" }]).at(-1)!.href).toBe("/");
      expect(sourcesOf("admin", "list_all_workspaces", {}, { workspaces: [{ id, name: "X" }] }).at(-1)!.href).toBe("/platform/workspaces");
      expect(sourcesOf("admin", "get_risk", { risk_id: id }, {})[0].href).toBe("/platform/risk-register");
    }
    expect(sourcesOf("studio", "list_workspace_audit", {}, { events: [{ action: "a b&c=d" }] }).at(-1)!.href).toBe("/audits?action=a%20b%26c%3Dd");
  });

  it("a read off the lists is the area's first page, named by its tool", () => {
    expect(sourcesOf("studio", "create_app", {}, {})).toEqual([{ title: "Dashboard", href: "/" }]);
    expect(sourcesOf("admin", "review_license", {}, {})).toEqual([{ title: "Overview", href: "/platform" }]);
    expect(readLabel("admin", "review_license")).toBe("Read review license");
    // The studio's reads aren't the platform admin's.
    expect(sourcesOf("admin", "list_my_apps", {}, [{ id: "a1", name: "X" }])).toEqual([{ title: "Overview", href: "/platform" }]);
  });

  it("a read's arguments on one line: ids shortened, long text cut", () => {
    expect(argsSummary({})).toBe("");
    expect(argsSummary({ workspace_id: WS, status: "pending", limit: 20, all_firms: true, note: "x".repeat(60), skip: undefined })).toBe(`workspace_id: 44444444…, status: pending, limit: 20, all_firms: true, note: ${"x".repeat(40)}…`);
    expect(argsSummary({ ids: [1, 2], filter: { a: 1 } })).toBe("ids: 2 items, filter: …");
  });
});

describe("secrets never reach the panel", () => {
  it("text under a key that names a secret is hidden; whether one is set, and everything else, stays", () => {
    const got = scrub({
      name: "Atlas Trust Bank",
      api_key: "abc123456789",
      apiKey: "abc123456789",
      webhook_secret: "whsec_1",
      access_token: "t0k3n",
      password: "hunter2",
      private_key: { pem: "x" },
      preview_url: "https://pv.example.test/x?token=abc",
      key_set: true,
      api_key_set: true,
      tokens_used: 1200,
      nested: [{ authorization: "Basic abc", status: "active" }],
    }) as Record<string, unknown>;
    expect(got).toEqual({
      name: "Atlas Trust Bank",
      api_key: HIDDEN,
      apiKey: HIDDEN,
      webhook_secret: HIDDEN,
      access_token: HIDDEN,
      password: HIDDEN,
      private_key: HIDDEN,
      preview_url: HIDDEN,
      key_set: true,
      api_key_set: true,
      tokens_used: 1200,
      nested: [{ authorization: HIDDEN, status: "active" }],
    });
  });

  it("text that looks like a secret is hidden wherever it sits, and a link loses its query string", () => {
    const secrets = ["mynt_live_abcdefghijklmnop", "mynt_test_abcdefghijklmnop", "sk-abcdefghijklmnopqrstuv", "ghp_abcdefghijklmnopqrstuvwxyz", "Bearer abcdefghijklmnop.qrst", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def", "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----"];
    for (const s of secrets) {
      expect(scrubText(`note: ${s} end`), s).toBe(`note: ${HIDDEN} end`);
      expect(JSON.stringify(scrub({ note: [`see ${s}`] })), s).not.toContain(s.slice(0, 12));
    }
    expect(scrubText("open https://pv.example.test/dashboard?token=abc&x=1 now")).toBe(`open https://pv.example.test/dashboard?${HIDDEN} now`);
    expect(scrubText("Round-up savings is in production")).toBe("Round-up savings is in production");
  });

  it("a read's reply is shown scrubbed and cut to its limit", () => {
    const shown = shownResult({ apps: [{ name: "Round-up savings", api_key: "mynt_live_abcdefghijklmnop" }], note: "y".repeat(MAX_RESULT_SHOWN * 2) });
    expect(shown).toContain("Round-up savings");
    expect(shown).not.toContain("mynt_live_");
    expect(shown.length).toBeLessThanOrEqual(MAX_RESULT_SHOWN + 20);
    expect(shown.endsWith("…(cut short)")).toBe(true);
    expect(shownResult("Bearer abcdefghijklmnop")).toBe(HIDDEN);
  });
});

describe("citations", () => {
  it("a citation of a source the answer wasn't given is dropped; the others stay", () => {
    expect(cleanAnswer("One app [1][7]. Its licence is verified [2] [12].", 2)).toBe("One app [1]. Its licence is verified [2].");
    expect(cleanAnswer("Nothing was read [1].", 0)).toBe("Nothing was read.");
  });

  it("an answer is flagged when a statement cites no source, and only then", () => {
    expect(hasUncited("You have one app, Round-up savings [2]. Its licence is verified [3][4].")).toBe(false);
    expect(hasUncited("You have two apps:\n\n- Round-up savings is in production [2]\n- Budgeting is in staging [3]")).toBe(false);
    expect(hasUncited("You have one app [2]. It was launched to great acclaim last year.")).toBe(true);
    expect(hasUncited("- Round-up savings is in production [2]\n- Budgeting is still waiting on its review")).toBe(true);
    expect(hasUncited("You have one app, and it is doing very well.")).toBe(true);
    // Short connectives, and an answer that says the data doesn't cover the question, aren't statements of fact.
    expect(hasUncited("Yes [1]. Two of them.")).toBe(false);
    expect(hasUncited("Mynt's data doesn't cover this. It has no weather readings at all.")).toBe(false);
  });
});

describe("the conversation, as the model takes it", () => {
  it("is the earlier turns then the question; it always starts with a question and never has two turns of one role in a row", () => {
    expect(conversationFrom(undefined, "Which apps do I have?")).toEqual([{ role: "user", content: "Which apps do I have?" }]);
    expect(conversationFrom([{ role: "assistant", text: "Hello [1]." }, { role: "user", text: "a" }, { role: "user", text: "b" }, { role: "assistant", text: "c [2][3]." }], "d")).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c." },
      { role: "user", content: "d" },
    ]);
    // An unanswered question before this one is joined to it.
    expect(conversationFrom([{ role: "user", text: "a" }], "b")).toEqual([{ role: "user", content: "a\n\nb" }]);
  });

  it("says how long in words", () => {
    expect([seconds(200), seconds(6200), seconds(65_000)]).toEqual(["under a second", "6s", "1m 5s"]);
  });
});
