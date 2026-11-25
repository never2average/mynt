import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// My firm's routes (app/api/firm/*): each serves only an account Mynt granted the licence-provider role (403 before
// anything reaches Mynt's licence-provider tools; an admin's implied role doesn't count), a write must come from the
// studio's own page and name a sponsorship, licence, party or member request of the caller's own firm (404 otherwise,
// and nothing is sent), each sends Mynt exactly the tool and arguments it should, and Mynt's refusals are passed on in
// its words. The access route says whether the sidebar shows My firm.

const FIRM = "33333333-3333-4333-8333-333333333333";
const LIC = "44444444-4444-4444-8444-444444444444";
const REQ = "55555555-5555-4555-8555-555555555555";
const SPON = "66666666-6666-4666-8666-666666666666";
const PARTY = "77777777-7777-4777-8777-777777777777";
const MEMBER = "88888888-8888-4888-8888-888888888888";
const OTHER = "99999999-9999-4999-8999-999999999999";

const TOOLS = [
  "get_regulated_firm_onboarding",
  "get_my_entity",
  "list_my_licenses",
  "list_sponsorship_requests",
  "list_sponsored_products",
  "list_firm_notices",
  "get_region",
  "register_license",
  "set_entity_facts",
  "approve_sponsorship",
  "decline_sponsorship",
  "revoke_sponsorship",
  "add_party",
  "end_party",
  "decide_firm_member",
].map((name) => ({ name, inputSchema: { type: "object", properties: {} } }));

const step = (key: string, status: string, extra: Record<string, unknown> = {}) => ({ key, title: key, status, detail: `${key} in words.`, tool: null, by: "firm", informational: false, facts: {}, ...extra });
const fake = {
  session: undefined as Session | undefined,
  ownOrigin: true,
  whoami: {} as Record<string, unknown>,
  refuse: null as { tool: string; error: string } | null,
  tools: TOOLS,
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
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      if (fake.refuse?.tool === name) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse.error }) }] };
      switch (name) {
        case "whoami":
          return ok(fake.whoami);
        case "get_regulated_firm_onboarding":
          return ok({
            entity: { id: FIRM, name: "Partner Trust", status: "active" },
            steps: [
              step("firm_registered", "done", { by: "admin" }),
              step("licence_provider_members", "done", { by: "admin", facts: { members: 1, licence_providers: [{ name: "Lena", email: "lena@example.com", since: "2026-10-01T00:00:00Z" }], waiting: [{ request_id: MEMBER, email: "cy@example.com", requested_at: "2026-11-20T00:00:00Z", admin_recovery: false }], invited: [] } }),
              step("real_company_check", "blocked", { by: "admin", facts: { rule: "lei_or_msb", rule_text: "a matching LEI or MSB registration", passes: false, reasons: ["gleif_lei: not checked yet"], last_run_at: null, last_answer_at: null } }),
            ],
            progress: { done: 2, total: 7, next: { key: "firm_facts", title: "Firm facts", status: "next", tool: "set_entity_facts" }, complete: false },
            ready_to_sponsor: false,
            checks: [],
          });
        case "get_my_entity":
          return ok({ id: FIRM, name: "Partner Trust", status: "active", regions: ["US"], identifiers: [{ scheme: "us_ein", value: "12-3456789" }], members: [{ id: "u1", name: "Lena", email: "lena@example.com" }], licenses: [{ id: LIC, license_id: "nydfs_money_transmitter" }], parties: [{ id: PARTY, kind: "internal", person: { name: "Priya Shah" }, fills: [], status: "active" }], reconciliation: { licences: [] } });
        case "list_my_licenses":
          return ok({ entity_id: FIRM, licences: [{ id: LIC, region: "US", regulator_id: "nydfs", license_id: "nydfs_money_transmitter", registration_number: "MT-1", status: "verified", in_force: true, covers: ["us-ny"], sponsorships: [SPON] }] });
        case "list_sponsorship_requests":
          return ok([{ id: REQ, status: "pending", product: { id: "dollar-send", name: "Dollar Send" }, component: { key: "transmission" }, builder: { name: "Builder Inc" }, requested_jurisdictions: ["us-ny"], your_licences_granting_it: [{ id: LIC, license_id: "nydfs_money_transmitter", in_force: true }] }]);
        case "list_sponsored_products":
          return ok([{ id: SPON, status: "approved", product: { id: "pay", name: "Pay", status: "published" }, component: { key: "transmission" }, builder: { name: "Other Inc" }, jurisdictions: ["us-ny"], licences: [{ id: LIC, license_id: "nydfs_money_transmitter" }] }]);
        case "get_region":
          return ok({ code: "US", regulatory: { regulators: [{ id: "nydfs", name: "New York DFS", short_name: "NYDFS", license_types: [{ _id: "nydfs_money_transmitter", name: "Money transmitter licence" }, { _id: "state_mtl", name: "State licence", issued_per_jurisdiction: true, covers: ["us-ny", "us-ca"] }] }] } });
        case "list_firm_notices":
          return ok([{ id: "n1", type: "firm.member_pending", data: { member_email: "cy@example.com" }, at: "2026-11-20T00:00:00Z", read: false }]);
        case "approve_sponsorship":
          return ok({ id: REQ, status: "approved", jurisdictions: ["us-ny"] });
        case "revoke_sponsorship":
          return ok({ id: SPON, status: "revoked", drifted_products: ["pay"] });
        case "end_party":
          return ok({ id: PARTY, status: "ended", until: "2026-11-25", drifted_products: [] });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const home = await import("@/app/api/firm/route");
const notices = await import("@/app/api/firm/notices/route");
const licences = await import("@/app/api/firm/licences/route");
const facts = await import("@/app/api/firm/facts/route");
const sponsorship = await import("@/app/api/firm/sponsorships/[sponsorshipId]/route");
const parties = await import("@/app/api/firm/parties/route");
const party = await import("@/app/api/firm/parties/[partyId]/route");
const member = await import("@/app/api/firm/members/[requestId]/route");
const access = await import("@/app/api/liquidity/access/route");

const post = (path: string, body: unknown) => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const session = (roles: string[]) => ({ id: "s", userId: "u1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const WRITES = ["register_license", "set_entity_facts", "approve_sponsorship", "decline_sponsorship", "revoke_sponsorship", "add_party", "end_party", "decide_firm_member"];
const writes = () => fake.calls.filter((c) => WRITES.includes(c.name));
const sp = (sponsorshipId: string) => ({ params: Promise.resolve({ sponsorshipId }) });
const ADMIN_ROLES = ["consumer", "developer", "innovator", "vendor", "license_provider", "admin"];

beforeEach(() => {
  fake.session = session(["license_provider"]);
  fake.ownOrigin = true;
  fake.whoami = { id: "u1", roles: ["license_provider"], effective_roles: ["license_provider"] };
  fake.refuse = null;
  fake.tools = TOOLS;
  fake.calls = [];
});

describe("My firm's routes, for a licence provider", () => {
  it("GET: the checklist with the real-company check, the firm, its licences, requests and sponsored products, and the licence types of its regions", async () => {
    const res = await home.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.onboarding.entity).toEqual({ id: FIRM, name: "Partner Trust", status: "active" });
    expect(body.onboarding.check).toMatchObject({ status: "blocked", passes: false, rule: "lei_or_msb", lastRunAt: null });
    expect(body.firm.identifiers).toEqual([{ scheme: "us_ein", value: "12-3456789" }]);
    expect(body.licences.map((l: { id: string }) => l.id)).toEqual([LIC]);
    expect(body.requests.map((r: { id: string }) => r.id)).toEqual([REQ]);
    expect(body.sponsored.map((r: { id: string }) => r.id)).toEqual([SPON]);
    expect(body.licenceTypes).toEqual([
      { region: "US", regulatorId: "nydfs", regulator: "NYDFS", id: "nydfs_money_transmitter", name: "Money transmitter licence", perJurisdiction: false, jurisdictions: [] },
      { region: "US", regulatorId: "nydfs", regulator: "NYDFS", id: "state_mtl", name: "State licence", perJurisdiction: true, jurisdictions: ["us-ny", "us-ca"] },
    ]);
    expect(fake.calls.find((c) => c.name === "get_regulated_firm_onboarding")?.args).toEqual({}); // its own firm: never an id
    expect(fake.calls.find((c) => c.name === "list_sponsorship_requests")?.args).toEqual({ status: "pending" });
    expect(fake.calls.find((c) => c.name === "get_region")?.args).toEqual({ code: "US" });
    expect(fake.calls.some((c) => c.name === "list_firm_notices")).toBe(false); // reading notices marks them read: only on their tab
  });

  it("GET on a Mynt without the checklist says it isn't supported yet; a part Mynt can't answer is null, never an empty list", async () => {
    fake.tools = TOOLS.filter((t) => t.name !== "get_regulated_firm_onboarding");
    expect(await (await home.GET()).json()).toEqual({ supported: false });
    fake.tools = TOOLS;
    fake.refuse = { tool: "list_my_licenses", error: "temporarily unavailable" };
    const body = await (await home.GET()).json();
    expect(body.licences).toBeNull();
    expect(body.requests).toHaveLength(1);
  });

  it("Notices → list_firm_notices, in words", async () => {
    const body = await (await notices.GET()).json();
    expect(body.notices).toEqual([{ id: "n1", type: "firm.member_pending", what: "A member is waiting to be accepted", details: "member email: cy@example.com", at: "2026-11-20T00:00:00Z", read: false }]);
    expect(fake.calls.find((c) => c.name === "list_firm_notices")?.args).toEqual({ limit: 200 });
  });

  it("Register licence → register_license; Set firm facts → set_entity_facts", async () => {
    const lic = { region: "US", regulator_id: "nydfs", license_id: "state_mtl", jurisdiction: "us-ny", registration_number: "MT-2", valid_from: "2026-01-01", valid_to: "2027-01-01" };
    const res = await licences.POST(post("/api/firm/licences", lic));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/^Registered\. It waits for Mynt to verify it/);
    const ids = { identifiers: [{ scheme: "lei", value: "5493001KJTIIGC8Y1R12" }, { scheme: "us_ein", value: "12-3456789" }] };
    expect((await facts.POST(post("/api/firm/facts", ids))).status).toBe(200);
    expect(writes()).toEqual([
      { name: "register_license", args: lic },
      { name: "set_entity_facts", args: ids },
    ]);
  });

  it("Review request: Approve sponsorship → approve_sponsorship under the firm's own licences; Decline request → decline_sponsorship", async () => {
    const res = await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "approve", licence_ids: [LIC], jurisdictions: ["us-ny"], note: "Welcome" }), sp(REQ));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("Approved in US-NY. The component is covered there by your licence.");
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "decline", reason: "Outside our programme" }), sp(REQ))).status).toBe(200);
    expect(writes()).toEqual([
      { name: "approve_sponsorship", args: { sponsorship_id: REQ, licence_ids: [LIC], jurisdictions: ["us-ny"], note: "Welcome" } },
      { name: "decline_sponsorship", args: { sponsorship_id: REQ, reason: "Outside our programme" } },
    ]);
  });

  it("Revoke sponsorship → revoke_sponsorship on one the firm approved, saying what drifted", async () => {
    const res = await sponsorship.POST(post(`/api/firm/sponsorships/${SPON}`, { action: "revoke", reason: "Covenant breach" }), sp(SPON));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe("Revoked. 1 published product drifted and paused new sales.");
    expect(writes()).toEqual([{ name: "revoke_sponsorship", args: { sponsorship_id: SPON, reason: "Covenant breach" } }]);
  });

  it("Add party → add_party; End party → end_party; Decide → decide_firm_member", async () => {
    expect((await parties.POST(post("/api/firm/parties", { kind: "internal", person: { name: "Priya Shah" }, fills: [{ licence_id: LIC, stakeholder: "compliance_officer" }] }))).status).toBe(200);
    expect((await parties.POST(post("/api/firm/parties", { kind: "external", new_legal_entity: { name: "Audit LLP" }, relationship: "statutory_audit" }))).status).toBe(200);
    const ended = await party.POST(post(`/api/firm/parties/${PARTY}`, { until: "2026-11-25" }), { params: Promise.resolve({ partyId: PARTY }) });
    expect((await ended.json()).message).toBe("Ended from 2026-11-25.");
    const decided = await member.POST(post(`/api/firm/members/${MEMBER}`, { accept: true }), { params: Promise.resolve({ requestId: MEMBER }) });
    expect((await decided.json()).message).toMatch(/^Accepted\./);
    expect(writes()).toEqual([
      { name: "add_party", args: { kind: "internal", person: { name: "Priya Shah" }, fills: [{ licence_id: LIC, stakeholder: "compliance_officer" }] } },
      { name: "add_party", args: { kind: "external", new_legal_entity: { name: "Audit LLP" }, relationship: "statutory_audit", fills: [] } },
      { name: "end_party", args: { party_id: PARTY, until: "2026-11-25" } },
      { name: "decide_firm_member", args: { request_id: MEMBER, accept: true } },
    ]);
  });

  it("shows Mynt's refusal in its own words: the real-company check at approval, an admin account's revocation", async () => {
    fake.refuse = { tool: "approve_sponsorship", error: "Your firm can't sponsor products until Mynt's public checks show it's a real company" };
    const res = await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "approve", licence_ids: [LIC] }), sp(REQ));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "mynt_refused", message: "Your firm can't sponsor products until Mynt's public checks show it's a real company" });
    // An admin account that Mynt also granted the role, at its own firm: the studio sends it, and Mynt refuses.
    fake.session = session(ADMIN_ROLES);
    fake.whoami = { id: "a1", roles: ["admin", "license_provider"], effective_roles: ADMIN_ROLES };
    fake.refuse = { tool: "revoke_sponsorship", error: "Revoking is the licence provider's own decision: an admin account can't do it, even one that belongs to the firm" };
    const revoked = await sponsorship.POST(post(`/api/firm/sponsorships/${SPON}`, { action: "revoke", reason: "As an admin" }), sp(SPON));
    expect(revoked.status).toBe(422);
    expect((await revoked.json()).message).toMatch(/^Revoking is the licence provider's own decision/);
  });

  it("refuses, before anything is written: another firm's sponsorship, licence, party or request; another origin; a bad body", async () => {
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${OTHER}`, { action: "decline", reason: "No thanks" }), sp(OTHER))).status).toBe(404);
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${SPON}`, { action: "decline", reason: "No thanks" }), sp(SPON))).status).toBe(404); // approved already: not waiting
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "revoke", reason: "No thanks" }), sp(REQ))).status).toBe(404); // not approved yet
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "approve", licence_ids: [OTHER] }), sp(REQ))).status).toBe(404);
    expect((await sponsorship.POST(post("/api/firm/sponsorships/x", { action: "decline", reason: "No thanks" }), sp("not-a-uuid"))).status).toBe(404);
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "approve", licence_ids: [] }), sp(REQ))).status).toBe(400);
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "decline", reason: "x" }), sp(REQ))).status).toBe(400);
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${SPON}`, { action: "revoke", reason: "Stop", breach_id: OTHER }), sp(SPON))).status).toBe(400); // a breach stays with the MCP tool
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "delete" }), sp(REQ))).status).toBe(400);
    expect((await parties.POST(post("/api/firm/parties", { kind: "internal", person: { name: "P" }, fills: [{ licence_id: OTHER, stakeholder: "compliance_officer" }] }))).status).toBe(404);
    expect((await parties.POST(post("/api/firm/parties", { kind: "internal", person: { name: "P" }, entity_id: OTHER }))).status).toBe(400); // never another firm's roster
    expect((await party.POST(post(`/api/firm/parties/${OTHER}`, {}), { params: Promise.resolve({ partyId: OTHER }) })).status).toBe(404);
    expect((await member.POST(post(`/api/firm/members/${OTHER}`, { accept: true }), { params: Promise.resolve({ requestId: OTHER }) })).status).toBe(404);
    expect((await licences.POST(post("/api/firm/licences", { region: "US", regulator_id: "nydfs", license_id: "x", registration_number: "1", entity_id: OTHER }))).status).toBe(400);
    expect((await licences.POST(post("/api/firm/licences", { region: "US", regulator_id: "nydfs", license_id: "x", registration_number: "1", valid_to: "2026-02-31" }))).status).toBe(400);
    expect((await facts.POST(post("/api/firm/facts", { identifiers: [{ scheme: "lei", value: "A" }, { scheme: "lei", value: "B" }] }))).status).toBe(400);
    expect((await facts.POST(post("/api/firm/facts", { legal_form: "trust" }))).status).toBe(400); // identifiers only
    fake.ownOrigin = false;
    expect((await licences.POST(post("/api/firm/licences", { region: "US", regulator_id: "nydfs", license_id: "x", registration_number: "1" }))).status).toBe(403);
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "decline", reason: "No thanks" }), sp(REQ))).status).toBe(403);
    expect((await member.POST(post(`/api/firm/members/${MEMBER}`, { accept: false }), { params: Promise.resolve({ requestId: MEMBER }) })).status).toBe(403);
    expect(writes()).toEqual([]);
  });

  it("serves only accounts granted the licence-provider role: a developer, a vendor and an admin who only implies it are refused before Mynt's tools are called", async () => {
    for (const roles of [["consumer", "developer", "innovator"], ["vendor"]]) {
      fake.session = session(roles);
      fake.calls = [];
      const res = await home.GET();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("not_licence_provider");
      expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "decline", reason: "No thanks" }), sp(REQ))).status).toBe(403);
      expect(fake.calls.filter((c) => c.name !== "whoami")).toEqual([]);
    }
    // An admin: Mynt's roles imply licence provider, but it wasn't granted, so My firm isn't theirs to act in.
    fake.session = session(ADMIN_ROLES);
    fake.whoami = { id: "a1", roles: ["admin"], effective_roles: ADMIN_ROLES };
    fake.calls = [];
    expect((await home.GET()).status).toBe(403);
    expect((await notices.GET()).status).toBe(403);
    expect((await facts.POST(post("/api/firm/facts", { identifiers: [] }))).status).toBe(403);
    expect((await sponsorship.POST(post(`/api/firm/sponsorships/${REQ}`, { action: "approve", licence_ids: [LIC] }), sp(REQ))).status).toBe(403);
    expect(fake.calls.filter((c) => c.name !== "whoami")).toEqual([]);
  });

  it("the access route: My firm for the licence-provider role as granted, never one an admin only implies", async () => {
    expect((await (await access.GET()).json()).firm).toBe(true);
    fake.session = session(["consumer", "developer", "innovator"]);
    expect((await (await access.GET()).json()).firm).toBe(false);
    fake.session = session(ADMIN_ROLES);
    fake.whoami = { id: "a1", roles: ["admin"], effective_roles: ADMIN_ROLES };
    expect((await (await access.GET()).json()).firm).toBe(false);
    fake.whoami = { id: "a1", roles: ["admin", "license_provider"], effective_roles: ADMIN_ROLES };
    expect((await (await access.GET()).json()).firm).toBe(true);
  });
});
