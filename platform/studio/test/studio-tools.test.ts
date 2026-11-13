import { describe, expect, it } from "vitest";
import { isDeveloper, parseStudioCall, rolesFrom, STUDIO_TOOLS } from "@/lib/studio-tools";

describe("STUDIO_TOOLS", () => {
  it("can create apps and start and steer builds, and nothing else that writes: no running, shipping, hosting changes or VM access", () => {
    const names = Object.keys(STUDIO_TOOLS);
    expect(names).toEqual(expect.arrayContaining(["start_build", "steer_build", "create_app"]));
    for (const banned of [
      "finish_build",
      "stop_build",
      "sandbox_run",
      "open_sandbox_editor",
      "reopen_sandbox",
      "update_app",
      "connect_repository",
      "request_hosting",
      "deploy_app",
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
    expect(parseStudioCall("start_build", { goal: "A savings screen with a goal tracker", app_id: "a1", cap_usd: 500 })).toHaveProperty("error");
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
