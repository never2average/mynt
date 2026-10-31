import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activityRows,
  appRow,
  buildFacts,
  buildRows,
  diffView,
  FINISHED_BUILD,
  reopenState,
  sshLogins,
  usageFacts,
  filesView,
  hostingView,
  isDeveloper,
  joinPath,
  logLine,
  logRows,
  matches,
  parseDevCall,
  parseListing,
  rolesFrom,
  runRow,
  safeUrl,
  SECRET_TOOLS,
  statusRows,
  timelineRows,
} from "@/lib/developer";

describe("developer tool calls", () => {
  it("allows Mynt's developer tools with valid arguments", () => {
    expect(parseDevCall({ tool: "list_builds" })).toEqual({ tool: "list_builds", args: {} });
    expect(parseDevCall({ tool: "sandbox_run", args: { build_id: "b1", command: "npm test" } })).toEqual({
      tool: "sandbox_run",
      args: { build_id: "b1", command: "npm test" },
    });
    expect(parseDevCall({ tool: "vm_access", args: { hours: 8 } })).toEqual({ tool: "vm_access", args: { hours: 8 } });
  });

  it("refuses other tools and bad arguments", () => {
    expect(parseDevCall({ tool: "start_build", args: { goal: "build me something" } })).toEqual({ error: "Unknown developer tool" });
    expect(parseDevCall({ tool: "enroll_in_product", args: {} })).toEqual({ error: "Unknown developer tool" });
    expect(parseDevCall({ tool: "toString" })).toEqual({ error: "Unknown developer tool" });
    expect(parseDevCall(null)).toEqual({ error: "Unknown developer tool" });
    expect(parseDevCall({ tool: "get_build", args: {} })).toHaveProperty("error");
    expect(parseDevCall({ tool: "sandbox_run", args: { build_id: "b1", command: "" } })).toHaveProperty("error");
    expect(parseDevCall({ tool: "vm_access", args: { hours: 48 } })).toHaveProperty("error");
    expect(parseDevCall({ tool: "reopen_sandbox", args: { build_id: "b1", hours: 4 } })).toEqual({ tool: "reopen_sandbox", args: { build_id: "b1", hours: 4 } });
    expect(parseDevCall({ tool: "reopen_sandbox", args: { build_id: "b1" } })).toEqual({ tool: "reopen_sandbox", args: { build_id: "b1" } });
    expect(parseDevCall({ tool: "reopen_sandbox", args: { build_id: "b1", hours: 0 } })).toHaveProperty("error");
    expect(parseDevCall({ tool: "reopen_sandbox", args: { build_id: "b1", hours: 9 } })).toHaveProperty("error");
    expect(parseDevCall({ tool: "close_sandbox", args: { build_id: "b1" } })).toEqual({ tool: "close_sandbox", args: { build_id: "b1" } });
    expect(parseDevCall({ tool: "close_sandbox", args: {} })).toHaveProperty("error");
    expect(parseDevCall({ tool: "app_logs", args: { app_id: "a1", service: "api" } })).toEqual({ tool: "app_logs", args: { app_id: "a1", service: "api" } });
    expect(parseDevCall({ tool: "app_run", args: { app_id: "a1", command: "ls", service: "web.1" } })).toHaveProperty("tool", "app_run");
    expect(parseDevCall({ tool: "restart_app", args: { app_id: "a1", service: "api" } })).toHaveProperty("tool", "restart_app");
    expect(parseDevCall({ tool: "restart_app", args: { app_id: "a1", service: "-bad" } })).toHaveProperty("error");
    expect(parseDevCall({ tool: "app_logs", args: { app_id: "a1", service: "a b" } })).toHaveProperty("error");
    expect(parseDevCall({ tool: "steer_build", args: { build_id: "b1", message: "x" } })).toHaveProperty("error");
  });

  it("marks the credential-bearing tools as secret", () => {
    expect([...SECRET_TOOLS].sort()).toEqual(["open_sandbox_editor", "vm_access"]);
  });

  it("logs a failed call by tool name only", () => {
    const line = logLine("vm_access", new Error("ssh -i key dev@vm.example.com token=abc"));
    expect(line).toBe("developer tool vm_access failed (Error)");
    expect(line).not.toContain("abc");
  });
});

describe("roles", () => {
  it("reads effective roles from whoami", () => {
    expect(rolesFrom({ roles: ["innovator"], effective_roles: ["consumer", "developer", "innovator"] })).toEqual(["consumer", "developer", "innovator"]);
    expect(rolesFrom({ roles: ["consumer"] })).toEqual(["consumer"]);
    expect(rolesFrom(null)).toEqual([]);
  });

  it("lets developers (and the roles that include it) in", () => {
    expect(isDeveloper(["consumer", "developer"])).toBe(true);
    expect(isDeveloper(["innovator"])).toBe(true);
    expect(isDeveloper(["consumer"])).toBe(false);
    expect(isDeveloper([])).toBe(false);
  });
});

describe("builds table", () => {
  const listed = {
    month_spend_usd: 3.5,
    monthly_cap_usd: 100,
    builds: [
      { id: "b1", status: "coding", goal: "Add a savings goal screen", cost_usd: 1.25, cap_usd: 10, created_at: "2026-10-30T09:15:00.000Z", preview_url: "javascript:alert(1)" },
      { id: "b2", status: "succeeded", goal: "Ship the deposit flow", cost_usd: 2.25, cap_usd: 10, created_at: "2026-10-29T08:00:00Z", pr_url: "https://github.com/o/r/pull/1" },
      { status: "failed" },
    ],
  };

  it("maps list_builds to rows with status, goal, cost and created", () => {
    const { rows, monthSpend, monthlyCap } = buildRows(listed);
    expect(monthSpend).toBe(3.5);
    expect(monthlyCap).toBe(100);
    expect(rows).toHaveLength(2); // the row without an id is dropped
    expect(rows[0]).toMatchObject({ id: "b1", status: "coding", goal: "Add a savings goal screen", cost: "US$1.25 of US$10.00", created: "2026-10-30 09:15 UTC" });
    expect(rows[0].preview_url).toBe(""); // only http(s) links
    expect(rows[1].pr_url).toBe("https://github.com/o/r/pull/1");
  });

  it("copes with replies that aren't the expected shape", () => {
    expect(buildRows("Coding-agent builds aren't enabled").rows).toEqual([]);
    expect(buildRows(null).rows).toEqual([]);
  });

  it("builds the metadata card and tables for one build", () => {
    const build = {
      id: "b1",
      status: "blocked",
      goal: "g",
      phase_message: "Maxwell found 1 high finding",
      cost_usd: 4,
      cap_usd: 10,
      created_at: "2026-10-30T09:15:00Z",
      branch: "mynt/b1",
      commit_sha: "0123456789abcdef0123",
      error: null,
      timeline: [{ at: "2026-10-30T09:16:00Z", phase: "coding", message: "Agent started" }],
    };
    expect(buildFacts(build)).toEqual([
      ["Status", "blocked"],
      ["Phase", "Maxwell found 1 high finding"],
      ["Cost", "US$4.00 of US$10.00"],
      ["Created", "2026-10-30 09:15 UTC"],
      ["Branch", "mynt/b1"],
      ["Commit", "0123456789ab"],
    ]);
    expect(timelineRows(build)).toEqual([{ at: "2026-10-30 09:16 UTC", kind: "coding", message: "Agent started" }]);
    expect(activityRows({ activity: [{ type: "bash", summary: "npm test" }] })).toEqual([{ at: "", kind: "bash", message: "npm test" }]);
  });
});

describe("sandbox files", () => {
  const listing = [
    "total 16",
    "drwxr-xr-x  4 user user 4096 Oct 31 10:00 .",
    "drwxr-xr-x  3 user user 4096 Oct 31 09:00 ..",
    "-rw-r--r--  1 user user  512 Oct 31 10:00 package.json",
    "drwxr-xr-x  2 user user 4096 Oct 30  9:05 src",
    "lrwxrwxrwx  1 user user    9 Oct 31 10:00 latest -> src/main.ts",
    "-rw-r--r--  1 user user   20 Oct 31 10:00 my notes.md",
  ].join("\n");

  it("parses ls -la into rows, folders first", () => {
    expect(parseListing(listing).map((r) => [r.name, r.kind, r.size])).toEqual([
      ["src", "dir", ""],
      ["latest", "link", "9"],
      ["my notes.md", "file", "20"],
      ["package.json", "file", "512"],
    ]);
  });

  it("tells a folder, a file and an error apart", () => {
    expect(filesView({ path: "/w/app", listing }, ".")).toMatchObject({ path: "/w/app", entries: expect.any(Array) });
    expect(filesView({ path: "/w/app/a.ts", content: "x" }, "a.ts")).toEqual({ path: "/w/app/a.ts", content: "x" });
    expect(filesView({ path: "/w/app/nope", error: "Not found" }, "nope")).toEqual({ path: "/w/app/nope", error: "Not found" });
  });

  it("joins and climbs relative paths", () => {
    expect(joinPath(".", "src")).toBe("src");
    expect(joinPath("src", "lib")).toBe("src/lib");
    expect(joinPath("src/lib", "..")).toBe("src");
    expect(joinPath("src", "..")).toBe(".");
  });
});

describe("diff and run", () => {
  it("splits sandbox_diff into changed files and the full diff", () => {
    const diff = [" M src/a.ts", "?? src/b.ts", "----", " src/a.ts | 3 ++-", " 1 file changed", "----", "diff --git a/src/a.ts b/src/a.ts", "+x"].join("\n");
    const v = diffView({ exit_code: 0, diff, stderr: "" });
    expect(v.changes).toEqual([
      { status: "M", path: "src/a.ts", stat: "3 ++-" },
      { status: "??", path: "src/b.ts", stat: "" },
    ]);
    expect(v.diff).toBe("diff --git a/src/a.ts b/src/a.ts\n+x");
    expect(v.error).toBe("");
  });

  it("turns command results into rows", () => {
    expect(runRow("ls", { exit_code: 0, stdout: "a\n", stderr: "" }, false, "2026-10-31T00:00:00Z")).toEqual({ command: "ls", exit: "0", output: "a\n", at: "2026-10-31 00:00 UTC" });
    expect(runRow("ls", { app_id: "x", exit_code: 1, output: "nope" }, false, "2026-10-31T00:00:00Z").output).toBe("nope");
    expect(runRow("ls", { error: "The build is stopped" }, true, "2026-10-31T00:00:00Z")).toMatchObject({ exit: "error", output: "The build is stopped" });
  });
});

describe("hosting", () => {
  const status = {
    tenant: { id: "t1", status: "running", provider: "direct", vm_id: "vm-1", error: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" },
    apps: [
      { app_id: "a1", status: "running", url: "https://a1.example.com", commit_sha: "abcdef0123456789", build_id: "b2", repository: "o/r", error: null, updated_at: "2026-10-31T10:00:00Z" },
      { app_id: "a2", status: "deploying", url: null, error: "image build failed" },
    ],
  };

  it("maps hosting_status to the card and the apps table", () => {
    const v = hostingView(status);
    expect(v.status).toBe("running");
    expect(v.tenant).toEqual([
      ["Status", "running"],
      ["Provider", "direct"],
      ["VM", "vm-1"],
      ["Created", "2026-10-01 00:00 UTC"],
      ["Updated", "2026-10-02 00:00 UTC"],
    ]);
    expect(v.apps.map((a) => [a.app_id, a.url, a.status, a.error, a.commit])).toEqual([
      ["a1", "https://a1.example.com/", "running", "", "abcdef012345"],
      ["a2", "", "deploying", "image build failed", ""],
    ]);
    expect(v.usage).toBeNull();
    expect(hostingView({ tenant: null, apps: [] })).toEqual({ tenant: null, status: "", apps: [], usage: null });
  });

  it("shows usage as VMs, hours and an estimated cost", () => {
    expect(hostingView({ ...status, usage: { vms: 2, hours: 12.5, usd_estimate: 2.5, usd_per_hour: 0.2 } }).usage).toEqual([
      ["VMs", "2"],
      ["Machine hours", "12.5"],
      ["Estimated cost", "US$2.50 (estimate, at US$0.20 per VM hour)"],
    ]);
    expect(usageFacts(null)).toBeNull();
  });

  it("maps a compose app's services with safe URLs", () => {
    const a = appRow({ app_id: "a3", services: [{ service: "api", expose: "api", port: 8081, domain: "x", url: "https://a3-api.example.com" }, { service: "web", expose: "web", port: 8080, domain: null, url: null }, { expose: "x" }] });
    expect(a.services).toEqual([
      { service: "api", expose: "api", port: "8081", url: "https://a3-api.example.com/" },
      { service: "web", expose: "web", port: "8080", url: "" },
    ]);
    expect(appRow({ app_id: "a1" }).services).toEqual([]);
  });

  it("lists one SSH login per app VM", () => {
    const v = sshLogins({ logins: [{ app_id: "a1", ssh: "ssh one" }, { app_id: "a2", ssh: "ssh two" }, { app_id: "a3" }], expires_at: "2026-10-31T18:00:00Z", user: "developer" }, { a1: "Deposits" });
    expect(v).toEqual({
      logins: [
        { app_id: "a1", name: "Deposits", ssh: "ssh one" },
        { app_id: "a2", name: "a2", ssh: "ssh two" },
      ],
      expires: "2026-10-31 18:00 UTC",
    });
    expect(sshLogins({ ssh: "old shape" }).logins).toEqual([]);
  });

  it("reads reopen_sandbox and knows which builds can reopen", () => {
    expect(reopenState({ build_id: "b1", ready: false, next: "call again" })).toEqual({ ready: false, until: "" });
    expect(reopenState({ build_id: "b1", ready: true, until: "2026-10-31T18:00:00Z" })).toEqual({ ready: true, until: "2026-10-31 18:00 UTC" });
    expect([...FINISHED_BUILD].sort()).toEqual(["blocked", "failed", "over_budget", "stopped", "succeeded"]);
  });

  it("reads docker logs and status output", () => {
    expect(logRows("2026-10-31T10:00:00.123456789Z listening on 8080\nplain line\n")).toEqual([
      { at: "2026-10-31 10:00:00Z", line: "listening on 8080" },
      { at: "", line: "plain line" },
    ]);
    expect(statusRows("running since 2026-10-31T09:00:00Z, health healthy, restarts 0, image mynt-app:abc\n0.50% CPU, 40MiB / 1GiB memory")).toEqual([
      ["State", "running"],
      ["Since", "2026-10-31T09:00:00Z"],
      ["Health", "healthy"],
      ["Restarts", "0"],
      ["Image", "mynt-app:abc"],
      ["CPU", "0.50%"],
      ["Memory", "40MiB / 1GiB"],
    ]);
  });

  it("only keeps http(s) links", () => {
    expect(safeUrl("https://x.example.com/a")).toBe("https://x.example.com/a");
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl(42)).toBe("");
    expect(appRow({ app_id: "a", url: "data:text/html,hi" }).url).toBe("");
  });
});

describe("search", () => {
  it("matches every word, case-insensitively, across a row's values", () => {
    const row = { status: "succeeded", goal: "Ship the Deposit flow", id: "b2" };
    expect(matches(row, "")).toBe(true);
    expect(matches(row, "deposit SUCC")).toBe(true);
    expect(matches(row, "deposit failed")).toBe(false);
  });
});

describe("secrets stay in component state", () => {
  // The editor password and the SSH login are shown once and kept only in React state. Nothing in
  // the console may write them to browser storage, cookies, the URL or the console.
  const dir = join(__dirname, "..", "components", "developer");
  const sources = readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")] as const);

  it("has console sources to check", () => {
    expect(sources.map(([f]) => f)).toEqual(expect.arrayContaining(["Builds.tsx", "Hosting.tsx", "ui.tsx", "api.ts"]));
  });

  it.each(sources)("%s never persists or logs", (_, src) => {
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|console\./);
  });
});
