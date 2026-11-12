import { describe, expect, it } from "vitest";
import { isDeveloper, parseStudioCall, rolesFrom, STUDIO_TOOLS } from "@/lib/studio-tools";

describe("STUDIO_TOOLS", () => {
  it("can start and steer builds, and nothing else that writes: no running, shipping, hosting changes or VM access", () => {
    const names = Object.keys(STUDIO_TOOLS);
    expect(names).toEqual(expect.arrayContaining(["start_build", "steer_build"]));
    for (const banned of [
      "finish_build",
      "stop_build",
      "sandbox_run",
      "open_sandbox_editor",
      "reopen_sandbox",
      "create_app",
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

  it("lets developers, innovators and admins in", () => {
    expect(rolesFrom({ roles: ["developer"], effective_roles: ["consumer", "developer"] })).toEqual(["consumer", "developer"]);
    expect(rolesFrom({ roles: ["innovator"] })).toEqual(["innovator"]);
    expect(rolesFrom(null)).toEqual([]);
    expect(isDeveloper(["consumer", "developer"])).toBe(true);
    expect(isDeveloper(["innovator"])).toBe(true);
    expect(isDeveloper(["consumer"])).toBe(false);
  });
});
