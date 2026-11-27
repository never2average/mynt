import { describe, expect, it } from "vitest";
import { isDeveloper, parseStudioCall, rolesFrom, STUDIO_TOOLS } from "@/lib/studio-tools";

describe("STUDIO_TOOLS", () => {
  it("can create apps, start, steer and ship builds and put a verified build online, and nothing else that writes: no running, stopping, undeploying or VM access", () => {
    const names = Object.keys(STUDIO_TOOLS);
    // finish_build is the builder chat's Ship.
    expect(names).toEqual(expect.arrayContaining(["start_build", "steer_build", "finish_build", "create_app"]));
    expect(parseStudioCall("finish_build", { build_id: "b1" })).toEqual({ tool: "finish_build", args: { build_id: "b1" } });
    expect(parseStudioCall("finish_build", { build_id: "b1", reason: "ttl" })).toHaveProperty("error");
    for (const banned of [
      "stop_build",
      "sandbox_run",
      "open_sandbox_editor",
      "reopen_sandbox",
      "update_app",
      "undeploy_app",
      "restart_app",
      "vm_access",
      "app_run",
    ]) {
      expect(names).not.toContain(banned);
    }
    expect(names).toEqual(
      expect.arrayContaining(["whoami", "list_my_apps", "list_builds", "get_build", "get_build_activity", "app_status"]),
    );
  });

  it("checks Put online's tools strictly: one app and one build, the app's workspace, and an owner/name repository", () => {
    expect(parseStudioCall("deploy_app", { app_id: "a1", build_id: "b1" })).toEqual({ tool: "deploy_app", args: { app_id: "a1", build_id: "b1" } });
    expect(parseStudioCall("deploy_app", { app_id: "a1" })).toHaveProperty("error");
    expect(parseStudioCall("deploy_app", { app_id: "a1", build_id: "b1", environment: "live" })).toHaveProperty("error");
    expect(parseStudioCall("request_hosting", { workspace_id: "ws_1" })).toHaveProperty("tool");
    expect(parseStudioCall("request_hosting", {})).toHaveProperty("error"); // always the app's workspace, never a default
    expect(parseStudioCall("request_hosting", { workspace_id: "ws 1" })).toHaveProperty("error");
    expect(parseStudioCall("hosting_status", {})).toHaveProperty("tool");
    expect(parseStudioCall("hosting_status", { workspace_id: "ws_1" })).toHaveProperty("tool");
    expect(parseStudioCall("set_app_repository", { app_id: "a1", repository: "octo/app" })).toHaveProperty("tool");
    expect(parseStudioCall("set_app_repository", { app_id: "a1", repository: "not a repo" })).toHaveProperty("error");
    expect(parseStudioCall("get_app_repository", { app_id: "a1", token: true })).toHaveProperty("error");
  });

  it("refuses tools that aren't listed, including admin tools and prototype keys", () => {
    for (const tool of ["vm_access", "app_run", "remove_app", "constructor", "__proto__", 42, undefined]) {
      expect(parseStudioCall(tool, {})).toEqual({ error: "That tool isn't available in the studio" });
    }
  });

  it("checks arguments and refuses extra ones", () => {
    expect(parseStudioCall("get_build", { build_id: " b1 " })).toEqual({ tool: "get_build", args: { build_id: "b1" } });
    expect(parseStudioCall("get_build", {})).toHaveProperty("error");
    expect(parseStudioCall("get_build", { build_id: "x".repeat(201) })).toHaveProperty("error");
    expect(parseStudioCall("list_my_apps", { owner_id: "someone-else" })).toHaveProperty("error");
    expect(parseStudioCall("app_logs", { app_id: "a", service: "web; rm -rf /" })).toHaveProperty("error");
    expect(parseStudioCall("get_build_activity", { build_id: "b", limit: 500 })).toHaveProperty("error");
  });

  it("checks the chat's write tools", () => {
    expect(parseStudioCall("start_build", { goal: "A savings screen with a goal tracker", app_id: "a1" })).toEqual({
      tool: "start_build",
      args: { goal: "A savings screen with a goal tracker", app_id: "a1" },
    });
    expect(parseStudioCall("start_build", { goal: "short", app_id: "a1" })).toHaveProperty("error");
    expect(parseStudioCall("start_build", { goal: "A savings screen with a goal tracker" })).toHaveProperty("error"); // an app is required
    // No cap is ever sent from the studio: Mynt applies its own to every build.
    expect(parseStudioCall("start_build", { goal: "A savings screen with a goal tracker", app_id: "a1", cap_usd: 5 })).toHaveProperty("error");
    expect(parseStudioCall("start_build", { goal: "A savings screen with a goal tracker", app_id: "a1", mode: "batch" })).toHaveProperty("error");
    expect(parseStudioCall("start_build", { goal: "A savings screen with a goal tracker", app_id: "a1", mode: "session", continue_from: "b0" })).toHaveProperty("tool");
    expect(parseStudioCall("start_build", { goal: "A savings screen with a goal tracker", app_id: "a1", repository: "not a repo" })).toHaveProperty("error");
    expect(parseStudioCall("steer_build", { build_id: "b1", message: "ok" })).toHaveProperty("error");
    expect(parseStudioCall("steer_build", { build_id: "b1", message: "Use the blue theme" })).toHaveProperty("tool");
    expect(parseStudioCall("get_build_activity", { build_id: "b1", after: 12 })).toHaveProperty("tool");
    expect(parseStudioCall("get_build_activity", { build_id: "b1", after: -1 })).toHaveProperty("error");
    expect(parseStudioCall("list_builds", { app_id: "a1" })).toHaveProperty("tool");
  });

  it("checks New app's and the dashboard's tools strictly", () => {
    const app = { name: "Round-up savings", description: "Rounds up card purchases", audience: "Savers", product_ids: ["p1"] };
    expect(parseStudioCall("create_app", app)).toHaveProperty("tool");
    expect(parseStudioCall("create_app", { ...app, product_ids: [] })).toHaveProperty("error");
    expect(parseStudioCall("create_app", { ...app, owner_id: "someone-else" })).toHaveProperty("error");
    expect(parseStudioCall("create_app", { ...app, name: "x".repeat(81) })).toHaveProperty("error");
    expect(parseStudioCall("get_developer_dashboard", {})).toHaveProperty("tool");
    expect(parseStudioCall("get_developer_dashboard", { days: 30 })).toHaveProperty("tool");
    expect(parseStudioCall("get_developer_dashboard", { days: 365 })).toHaveProperty("error");
    expect(parseStudioCall("get_developer_dashboard", { user_id: "u2" })).toHaveProperty("error");
    expect(parseStudioCall("list_buildable_products", { query: "savings" })).toHaveProperty("tool");
  });

  it("checks the workspace and linked-account tools strictly", () => {
    const ok = (t: string, a: object) => expect(parseStudioCall(t, a), t).toHaveProperty("tool");
    const bad = (t: string, a: object) => expect(parseStudioCall(t, a), t).toHaveProperty("error");
    ok("list_workspaces", {});
    ok("create_workspace", { name: "Acme" });
    bad("create_workspace", { name: "" });
    ok("rename_workspace", { workspace_id: "w1", name: "Acme 2" });
    ok("list_workspace_members", { workspace_id: "w1" });
    bad("list_workspace_members", { workspace_id: "../w1" });
    ok("invite_to_workspace", { workspace_id: "w1", email: "a@example.com", role: "admin" });
    bad("invite_to_workspace", { workspace_id: "w1", email: "a@example.com", role: "owner" });
    bad("invite_to_workspace", { workspace_id: "w1", email: "not an email", role: "member" });
    ok("revoke_workspace_invite", { workspace_id: "w1", invite_id: "i1" });
    ok("change_member_role", { workspace_id: "w1", user_id: "u2", role: "member" });
    bad("change_member_role", { workspace_id: "w1", user_id: "u2", role: "owner" });
    ok("remove_workspace_member", { workspace_id: "w1", user_id: "u2" });
    ok("leave_workspace", { workspace_id: "w1" });
    ok("list_my_apps", { workspace_id: "w1" });
    ok("get_developer_dashboard", { days: 30, workspace_id: "w1" });
    ok("get_linked_accounts", {});
    bad("get_linked_accounts", { user_id: "u2" });
    ok("list_my_invitations", {});
    bad("list_my_invitations", { user_id: "u2" });
    ok("accept_workspace_invite", { invite_id: "inv1" });
    bad("accept_workspace_invite", { invite_id: "../inv1" });
    bad("accept_workspace_invite", { invite_id: "inv1", workspace_id: "w1" });
    ok("decline_workspace_invite", { invite_id: "inv1" });
    bad("decline_workspace_invite", {});
  });

  it("checks the compliance pages' reads (Coverage, Licences, Audits)", () => {
    const ok = (tool: string, args: Record<string, unknown>) => expect(parseStudioCall(tool, args), tool).toHaveProperty("tool");
    const bad = (tool: string, args: Record<string, unknown>) => expect(parseStudioCall(tool, args), JSON.stringify(args)).toHaveProperty("error");
    ok("get_compliance_coverage", { workspace_id: "w1" });
    ok("get_compliance_coverage", {});
    bad("get_compliance_coverage", { workspace_id: "w1", all: true });
    ok("list_workspace_licences", { workspace_id: "w1", status: "active", regulator: "OCC", state: "CA" });
    bad("list_workspace_licences", { workspace_id: "w1", state: "California" });
    ok("list_workspace_audit", { workspace_id: "w1", cursor: "c2", action: "app.created", user_id: "u1", app_id: "a1", from: "2026-11-01", to: "2026-11-13" });
    bad("list_workspace_audit", { workspace_id: "w1", from: "yesterday" });
    bad("list_workspace_audit", { workspace_id: "w1", from: "2026-02-30" });
    bad("list_workspace_audit", { workspace_id: "w1", cursor: "" });
    bad("list_workspace_audit", { workspace_id: "w1", limit: 10000 });
    for (const t of ["get_compliance_coverage", "list_workspace_licences", "list_workspace_audit"]) expect(Object.keys(STUDIO_TOOLS)).toContain(t);
  });

  it("lets developers, innovators and admins in", () => {
    expect(rolesFrom({ roles: ["developer"], effective_roles: ["consumer", "developer"] })).toEqual(["consumer", "developer"]);
    expect(rolesFrom({ roles: ["innovator"] })).toEqual(["innovator"]);
    expect(rolesFrom(null)).toEqual([]);
    expect(isDeveloper(["consumer", "developer"])).toBe(true);
    expect(isDeveloper(["innovator"])).toBe(true);
    expect(isDeveloper(["consumer"])).toBe(false);
  });
});

describe("promotions, attention and workspace settings on the allow-list", () => {
  it("check stages, reasons and that archiving can't skip its 7 days", () => {
    expect(parseStudioCall("get_promotion_checks", { app_id: "a1", to_stage: "production" })).toEqual({ tool: "get_promotion_checks", args: { app_id: "a1", to_stage: "production" } });
    expect(parseStudioCall("promote_app", { app_id: "a1", to_stage: "idea" })).toHaveProperty("error");
    expect(parseStudioCall("demote_app", { app_id: "a1", to_stage: "production", reason: "nope" })).toHaveProperty("error");
    expect(parseStudioCall("demote_app", { app_id: "a1", to_stage: "idea" })).toHaveProperty("error");
    expect(parseStudioCall("request_promotion_signoff", { app_id: "a1" })).toHaveProperty("tool");
    expect(parseStudioCall("get_workspace_attention", { workspace_id: "w1" })).toHaveProperty("tool");
    expect(parseStudioCall("archive_workspace", { workspace_id: "w1", now: true })).toHaveProperty("error");
    for (const t of ["unarchive_workspace", "relink_workspace_org"]) expect(parseStudioCall(t, { workspace_id: "w1" })).toHaveProperty("tool");
  });
});

describe("My services (service providers) on the allow-list", () => {
  const OFF = "55555555-5555-4555-8555-555555555555";
  const TERMS = { document_url: "https://example.com/terms.pdf", document_sha256: "a".repeat(64), summary: "Our standard terms.", pricing_summary: "$1 per check", scopes: ["technology"] };
  it("reads the caller's own firm only, and writes services strictly: https endpoints, a SHA-256, no extra fields", () => {
    expect(parseStudioCall("get_vendor_onboarding", {})).toHaveProperty("tool");
    expect(parseStudioCall("get_vendor_onboarding", { offering_id: OFF })).toHaveProperty("tool");
    expect(parseStudioCall("get_vendor_onboarding", { all_firms: true })).toHaveProperty("error");
    expect(parseStudioCall("list_my_offerings", { entity_id: OFF })).toHaveProperty("error");
    const create = { region: "US", service_type: "identity_verification", name: "ID", test_base_url: "https://test.example.com", price: { amount: 1, currency: "USD" } };
    expect(parseStudioCall("create_vendor_offering", create)).toHaveProperty("tool");
    expect(parseStudioCall("create_vendor_offering", { ...create, test_base_url: "http://test.example.com" })).toHaveProperty("error");
    expect(parseStudioCall("create_vendor_offering", { ...create, standard_terms: TERMS })).toHaveProperty("error");
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, standard_terms: TERMS })).toHaveProperty("tool");
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, standard_terms: { ...TERMS, document_sha256: "A".repeat(64) } })).toHaveProperty("error");
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, standard_terms: { ...TERMS, version: 3 } })).toHaveProperty("error");
    // The terms name what they cover: at least one scope from the fixed list, each once.
    const { scopes: _scopes, ...unscoped } = TERMS;
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, standard_terms: unscoped })).toHaveProperty("error");
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, standard_terms: { ...TERMS, scopes: [] } })).toHaveProperty("error");
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, standard_terms: { ...TERMS, scopes: ["marketing"] } })).toHaveProperty("error");
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, standard_terms: { ...TERMS, scopes: ["manpower", "financial_regulatory_operations"] } })).toHaveProperty("tool");
    expect(parseStudioCall("update_vendor_offering", { offering_id: OFF, listed: true })).toHaveProperty("tool");
    expect(parseStudioCall("update_vendor_offering", { offering_id: "x", listed: true })).toHaveProperty("error");
    expect(parseStudioCall("run_conformance", { offering_id: OFF, test_credential: "c" })).toHaveProperty("tool");
    // Run practice test takes the service and nothing else; a new draft may have no test endpoint yet (never an http one).
    expect(parseStudioCall("run_practice_conformance", { offering_id: OFF })).toHaveProperty("tool");
    expect(parseStudioCall("run_practice_conformance", { offering_id: OFF, test_credential: "c" })).toHaveProperty("error");
    expect(parseStudioCall("run_practice_conformance", { offering_id: OFF, practice: false })).toHaveProperty("error");
    expect(parseStudioCall("run_practice_conformance", { offering_id: "x" })).toHaveProperty("error");
    expect(parseStudioCall("run_practice_conformance", {})).toHaveProperty("error");
    const { test_base_url: _none, ...draft } = create;
    expect(parseStudioCall("create_vendor_offering", draft)).toHaveProperty("tool");
    // Subscribers' signing secrets stay with the MCP tools.
    for (const t of ["reveal_subscription_secret", "rotate_subscription_secret", "suspend_vendor_offering", "define_service_type"]) expect(parseStudioCall(t, {})).toHaveProperty("error");
  });
});

describe("agreement scopes", () => {
  const AG = "11111111-1111-4111-8111-111111111111";
  const FIRM = "22222222-2222-4222-8222-222222222222";
  const app = { app_id: "a1", counterparty_entity_id: FIRM, kind: "msa", products: [], terms_summary: "Master services terms" };
  const ws = { workspace_id: "33333333-3333-4333-8333-333333333333", app_id: "a1", kind: "sla", terms_summary: "Service levels for the app" };

  it("both propose tools require one or more scopes from the fixed list, each once", () => {
    for (const [tool, base] of [["propose_app_agreement", app], ["propose_workspace_agreement", ws]] as const) {
      expect(parseStudioCall(tool, { ...base, scopes: ["technology", "financial_regulatory_operations"] }), tool).toHaveProperty("tool");
      expect(parseStudioCall(tool, base), tool).toHaveProperty("error"); // missing
      expect(parseStudioCall(tool, { ...base, scopes: [] }), tool).toHaveProperty("error");
      expect(parseStudioCall(tool, { ...base, scopes: ["catering"] }), tool).toHaveProperty("error");
      expect(parseStudioCall(tool, { ...base, scopes: ["manpower", "manpower"] }), tool).toHaveProperty("error");
    }
  });

  it("Change scope (update_agreement_scopes) is strict, and the list takes a scope filter", () => {
    expect(parseStudioCall("update_agreement_scopes", { agreement_id: AG, scopes: ["manpower"] })).toEqual({ tool: "update_agreement_scopes", args: { agreement_id: AG, scopes: ["manpower"] } });
    expect(parseStudioCall("update_agreement_scopes", { agreement_id: "g1", scopes: ["manpower"] })).toHaveProperty("error");
    expect(parseStudioCall("update_agreement_scopes", { agreement_id: AG, scopes: [] })).toHaveProperty("error");
    expect(parseStudioCall("update_agreement_scopes", { agreement_id: AG, scopes: ["manpower"], status: "signed" })).toHaveProperty("error");
    expect(parseStudioCall("list_app_agreements", { scope: "technology" })).toHaveProperty("tool");
    expect(parseStudioCall("list_app_agreements", { scope: "catering" })).toHaveProperty("error");
  });

  it("the studio's list is Mynt's (AGREEMENT_SCOPES in the server's app-agreements-schema.ts), keys and labels", async () => {
    const { AGREEMENT_SCOPES } = await import("@/lib/app-panel");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const core = readFileSync(join(process.cwd(), "..", "..", "core", "src", "app-agreements-schema.ts"), "utf8");
    const block = /export const AGREEMENT_SCOPES = \[([^]*?)\] as const;/.exec(core)![1];
    const pairs = [...block.matchAll(/\{ key: "([a-z_]+)", label: "([^"]+)" \}/g)].map((m) => ({ key: m[1], label: m[2] }));
    expect(pairs).toEqual(AGREEMENT_SCOPES.map((s) => ({ key: s.key, label: s.label })));
  });
});

describe("Services on the allow-list", () => {
  it("lists the service tools, and leaves the app tools they reuse as they were", () => {
    const names = Object.keys(STUDIO_TOOLS);
    // A service's own tools; its builds, hosting and stages are the app tools with its id.
    expect(names).toEqual(expect.arrayContaining(["create_service", "get_service", "list_my_services", "archive_service", "get_service_type_contract", "request_service_type", "list_service_type_requests"]));
    expect(names).toEqual(expect.arrayContaining(["start_build", "deploy_app", "get_promotion_checks", "promote_app", "demote_app"]));
    // Deciding a request stays with admins; taking a service offline stays with the MCP tools.
    for (const t of ["decline_service_type_request", "define_service_type", "undeploy_app"]) expect(names).not.toContain(t);
    expect(parseStudioCall("create_service", { name: "Swift ID", description: "Verifies IDs", service_type: "identity_verification", region: "US" })).toHaveProperty("tool");
    // Never a typed endpoint, a listing switch or a credential: Mynt derives the endpoint and lists by stage.
    for (const extra of ["test_base_url", "live_base_url", "listed", "requires_credential"]) expect(parseStudioCall("create_service", { name: "Swift ID", description: "Verifies IDs", service_type: "identity_verification", region: "US", [extra]: true })).toHaveProperty("error");
    expect(parseStudioCall("archive_service", { service_id: "s1", archived: false })).toEqual({ tool: "archive_service", args: { service_id: "s1", archived: false } });
    expect(parseStudioCall("request_service_type", { name: "Proof of address", what_it_does: "Checks an address against a bill", example_input: [], example_output: {} })).toHaveProperty("error");
  });
});
