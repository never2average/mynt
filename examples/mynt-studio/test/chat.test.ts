import { describe, expect, it } from "vitest";
import {
  ActivityFollower,
  activityToParts,
  buildSummaries,
  buildToMessages,
  capabilitiesFrom,
  chooseAction,
  newSince,
  consumeTurnEnds,
  planSteer,
  FINISHING_NOTE,
  STARTING_NOTE,
  parseToolSummary,
  turnOver,
  type BuildSummary,
} from "@/lib/chat";
import { toUIMessages } from "@/lib/conversation";
import { GENERIC_REFUSAL, refusalMessage } from "@/lib/studio-server";

const plain = { sessionBuilds: false };
const session = { sessionBuilds: true };
const build = (id: string, status: string, extra: Partial<BuildSummary> = {}): BuildSummary => ({
  id,
  app_id: "app",
  status,
  commit_sha: null,
  updated_at: `2026-11-1${id.length}T00:00:00Z`,
  ...extra,
});

describe("start or steer", () => {
  it("steers the build the user is looking at, if its agent is running", () => {
    const builds = [build("b1", "coding", { updated_at: "2026-11-01" }), build("b2", "checking", { updated_at: "2026-11-02" })];
    expect(chooseAction({ appId: "app", selectedBuildId: "b1", builds, text: "Make the button blue", capabilities: plain })).toEqual({
      kind: "steer",
      buildId: "b1",
      args: { build_id: "b1", message: "Make the button blue" },
    });
  });

  it("otherwise steers the app's newest running build", () => {
    const builds = [build("b1", "coding", { updated_at: "2026-11-01" }), build("b2", "pushing", { updated_at: "2026-11-02" }), build("b3", "succeeded", { updated_at: "2026-11-03" })];
    const a = chooseAction({ appId: "app", selectedBuildId: "b3", builds, text: "Use the blue theme", capabilities: plain });
    expect(a).toMatchObject({ kind: "steer", buildId: "b2" });
  });

  it("never steers another app's build, or one that isn't running", () => {
    const builds = [build("x", "coding", { app_id: "other" }), build("v", "verifying"), build("s", "succeeded")];
    expect(chooseAction({ appId: "app", selectedBuildId: "x", builds, text: "Build the onboarding flow", capabilities: plain })).toEqual({
      kind: "start",
      args: { goal: "Build the onboarding flow", app_id: "app" },
    });
  });

  it("starts a session build that carries on from the app's last pushed build, where Mynt offers them", () => {
    const builds = [build("old", "succeeded", { commit_sha: "abc", updated_at: "2026-11-01" }), build("newer", "failed", { updated_at: "2026-11-05" }), build("other-app", "succeeded", { app_id: "zzz", commit_sha: "def", updated_at: "2026-11-09" })];
    expect(chooseAction({ appId: "app", selectedBuildId: null, builds, text: "Add a statements page", capabilities: session })).toEqual({
      kind: "start",
      args: { goal: "Add a statements page", app_id: "app", mode: "session", continue_from: "old" },
    });
    expect(chooseAction({ appId: "app", selectedBuildId: null, builds: [], text: "Add a statements page", capabilities: session })).toEqual({
      kind: "start",
      args: { goal: "Add a statements page", app_id: "app", mode: "session" },
    });
  });

  it("follows a build that's still starting instead of starting another beside it", () => {
    for (const status of ["queued", "provisioning"]) {
      expect(chooseAction({ appId: "app", selectedBuildId: null, builds: [build("q", status)], text: "Build the onboarding flow", capabilities: plain })).toEqual({
        kind: "follow",
        buildId: "q",
        message: STARTING_NOTE,
      });
    }
  });

  it("refuses a steer under 3 characters before anything is sent", () => {
    expect(chooseAction({ appId: "app", selectedBuildId: null, builds: [build("b", "coding")], text: "ok", capabilities: plain }).kind).toBe("refuse");
  });

  it("refuses empty, too short (for a new build) and too long messages", () => {
    expect(chooseAction({ appId: "app", selectedBuildId: null, builds: [], text: "   ", capabilities: plain }).kind).toBe("refuse");
    expect(chooseAction({ appId: "app", selectedBuildId: null, builds: [], text: "hi there", capabilities: plain }).kind).toBe("refuse");
    expect(chooseAction({ appId: "app", selectedBuildId: null, builds: [build("b", "coding")], text: "hi there", capabilities: plain }).kind).toBe("steer");
    expect(chooseAction({ appId: "app", selectedBuildId: null, builds: [], text: "x".repeat(4001), capabilities: plain }).kind).toBe("refuse");
  });

  it("reads list_builds", () => {
    expect(buildSummaries({ builds: [{ id: "b", app_id: "a", status: "coding", commit_sha: null, updated_at: "t" }, { nope: 1 }, null] })).toEqual([
      { id: "b", app_id: "a", status: "coding", commit_sha: null, updated_at: "t" },
    ]);
    expect(buildSummaries("text")).toEqual([]);
  });
});

describe("steering a running build", () => {
  const finished = { type: "turn_finished", summary: "success" };
  it("mid-turn: the interrupted turn's end is skipped, and the next one ends the answer", () => {
    expect(planSteer({ type: "tool_use", summary: "Bash" }, plain)).toEqual({ send: true, skipTurnEnds: 1 });
    expect(planSteer(undefined, plain)).toEqual({ send: true, skipTurnEnds: 1 }); // first turn, nothing written yet
    expect(planSteer({ type: "message", summary: "x" }, session)).toEqual({ send: true, skipTurnEnds: 1 });
  });

  it("between turns without session builds: not sent, since the runner no longer reads messages", () => {
    expect(planSteer(finished, plain)).toEqual({ send: false, message: FINISHING_NOTE });
  });

  it("between turns with session builds: sent, and its own turn's end ends the answer", () => {
    expect(planSteer(finished, session)).toEqual({ send: true, skipTurnEnds: 0 });
  });

  it("consumeTurnEnds skips across polls and stops on a finished build", () => {
    expect(consumeTurnEnds([finished], 1, "coding")).toEqual({ over: false, skip: 0, answered: false });
    expect(consumeTurnEnds([say("answer"), finished], 0, "coding")).toEqual({ over: true, skip: 0, answered: true });
    expect(consumeTurnEnds([say("old"), finished, say("a"), finished], 1, "coding")).toEqual({ over: true, skip: 0, answered: true });
    expect(consumeTurnEnds([say("old"), finished], 1, "coding")).toEqual({ over: false, skip: 0, answered: false });
    expect(consumeTurnEnds([], 1, "failed")).toEqual({ over: true, skip: 1, answered: false });
    expect(consumeTurnEnds([], 0, "coding")).toEqual({ over: false, skip: 0, answered: false });
  });
});

describe("errors shown in the chat", () => {
  it("are Mynt's own {error} message, else a generic one; raw replies are never shown", () => {
    expect(refusalMessage(JSON.stringify({ error: "Build is succeeded; only a running agent can be steered" }))).toBe("Build is succeeded; only a running agent can be steered");
    expect(refusalMessage("Traceback: internal detail at /srv/x.py")).toBe(GENERIC_REFUSAL);
    expect(refusalMessage(JSON.stringify({ detail: "x" }))).toBe(GENERIC_REFUSAL);
    expect(refusalMessage(JSON.stringify({ error: "a\u0007b" }))).toBe("a b");
    expect(refusalMessage(JSON.stringify({ error: "x".repeat(900) })).length).toBe(501);
  });
});

describe("capabilities", () => {
  it("offers session builds only when start_build takes mode and continue_from and finish_build exists", () => {
    const start = (props: string[]) => ({ name: "start_build", inputSchema: { type: "object", properties: Object.fromEntries(props.map((p) => [p, {}])) } });
    expect(capabilitiesFrom([start(["goal", "app_id"])])).toEqual({ sessionBuilds: false });
    expect(capabilitiesFrom([start(["goal", "mode", "continue_from"])])).toEqual({ sessionBuilds: false });
    expect(capabilitiesFrom([start(["goal", "mode", "continue_from"]), { name: "finish_build" }])).toEqual({ sessionBuilds: true });
    expect(capabilitiesFrom([])).toEqual({ sessionBuilds: false });
  });
});

const say = (summary: string, seq?: number) => ({ type: "message", summary, ...(seq ? { seq } : {}) });
const bash = (command: string, seq?: number) => ({ type: "tool_use", summary: `Bash ${JSON.stringify({ command })}`, ...(seq ? { seq } : {}) });

describe("following activity", () => {
  it("with Mynt's cursor: shows only what's after the baseline, oldest first", () => {
    const f = new ActivityFollower();
    expect(f.next("b")).toEqual({ build_id: "b", limit: 200 });
    // Without `after`, Mynt sends the latest, newest first.
    f.baseline({ status: "coding", activity: [say("old 2", 2), say("old 1", 1)], cursor: 2, first_seq: 1 });
    expect(f.next("b")).toEqual({ build_id: "b", limit: 200, after: 2 });
    const r = f.take({ status: "coding", phase_message: "Coding", activity: [say("new 3", 3), bash("npm test", 4)], cursor: 4, first_seq: 1 });
    expect(r.items.map((i) => i.summary)).toEqual(["new 3", 'Bash {"command":"npm test"}']);
    expect(r.phaseMessage).toBe("Coding");
    expect(f.take({ status: "coding", activity: [], cursor: 4, first_seq: 1 }).items).toEqual([]);
    expect(f.next("b").after).toBe(4);
    expect(f.missed).toBe(false);
  });

  it("with Mynt's cursor: notices entries trimmed before they were shown", () => {
    const f = new ActivityFollower();
    f.baseline({ activity: [say("a", 1)], cursor: 1, first_seq: 1 });
    f.take({ activity: [say("z", 9000)], cursor: 9000, first_seq: 4000 });
    expect(f.missed).toBe(true);
  });

  it("without a cursor (older Mynt): compares windows and drops repeats", () => {
    const f = new ActivityFollower();
    f.baseline({ status: "coding", activity: [say("b"), say("a")] }); // newest first
    expect(f.next("b")).toEqual({ build_id: "b", limit: 200 });
    expect(f.take({ activity: [say("c"), say("b"), say("a")] }).items.map((i) => i.summary)).toEqual(["c"]);
    expect(f.take({ activity: [say("c"), say("b"), say("a")] }).items).toEqual([]);
    // Same text twice is still two entries.
    expect(f.take({ activity: [say("c"), say("c"), say("b"), say("a")] }).items.map((i) => i.summary)).toEqual(["c"]);
  });

  it("newSince: overlap, a moved window, and nothing before", () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((s) => say(s));
    expect(newSince([], [a, b])).toEqual([a, b]);
    expect(newSince([a, b, c], [b, c, d])).toEqual([d]);
    expect(newSince([a, b], [c, d])).toEqual([c, d]);
    expect(newSince([a, b], [])).toEqual([]);
  });

  it("knows when the agent's turn is over", () => {
    expect(turnOver([say("x")], "coding")).toBe(false);
    expect(turnOver([{ type: "turn_finished", summary: "success, US$0.10" }], "coding")).toBe(true);
    expect(turnOver([], "succeeded")).toBe(true);
    expect(turnOver([], "failed")).toBe(true);
  });
});

describe("activity as messages", () => {
  it("draws the agent's tools with Adorable's cards", () => {
    const parts = activityToParts([
      say("Reading the spec"),
      bash("npm test"),
      { type: "tool_use", summary: 'Read {"file_path":"/app/web/src/App.tsx"}' },
      { type: "tool_use", summary: 'Edit {"file_path":"/app/web/src/App.tsx","old_string":"a","new_string":"b"}' },
      { type: "tool_use", summary: 'Write {"file_path":"/app/api/x.ts","content":"..."}' },
      { type: "tool_use", summary: 'Grep {"pattern":"TODO"}' },
      { type: "tool_use", summary: 'Glob {"pattern":"**/*.ts"}' },
      { type: "tool_use", summary: 'TodoWrite {"todos":[]}' },
      { type: "turn_finished", summary: "success, US$0.42" },
      say("  "),
    ]);
    expect(parts).toEqual([
      { kind: "text", text: "Reading the spec" },
      { kind: "tool", toolName: "bashTool", input: { command: "npm test" } },
      { kind: "tool", toolName: "readFileTool", input: { file: "/app/web/src/App.tsx" } },
      { kind: "tool", toolName: "replaceInFileTool", input: { file: "/app/web/src/App.tsx" } },
      { kind: "tool", toolName: "writeFileTool", input: { file: "/app/api/x.ts" } },
      { kind: "tool", toolName: "searchFilesTool", input: { query: "TODO" } },
      { kind: "tool", toolName: "listFilesTool", input: { path: "**/*.ts" } },
      { kind: "tool", toolName: "TodoWrite", input: { todos: [] } },
    ]);
  });

  it("reads tool summaries Mynt cut short", () => {
    expect(parseToolSummary('Bash {"command":"npm run build && npm te')).toEqual({ name: "Bash", input: { command: "npm run build && npm te" } });
    expect(parseToolSummary('Write {"file_path":"/app/a \\"b\\".ts","content":"lots')).toEqual({ name: "Write", input: { file_path: '/app/a "b".ts' } });
    expect(parseToolSummary("Bash")).toEqual({ name: "Bash", input: {} });
  });

  it("rebuilds a past build as a conversation, in time order", () => {
    const b = {
      id: "b1",
      goal: "Build a savings goal screen",
      created_at: "2026-11-01T00:00:00Z",
      timeline: [
        { at: "2026-11-01T00:00:01Z", phase: "coding", message: "Coding", data: {} },
        { at: "2026-11-01T00:05:00Z", phase: "coding", message: "Steered by the developer", data: { message: "Make it green" } },
      ],
    };
    const activity = {
      activity: [
        { type: "message", summary: "Done, it's green", seq: 3, at: "2026-11-01T00:06:00Z" },
        { type: "tool_use", summary: 'Bash {"command":"npm test"}', seq: 2, at: "2026-11-01T00:02:00Z" },
        { type: "message", summary: "Starting", seq: 1, at: "2026-11-01T00:01:00Z" },
      ],
      cursor: 3,
    };
    const messages = buildToMessages(b, activity);
    expect(messages.map((m) => [m.role, m.parts.map((p) => (p.kind === "text" ? p.text : p.toolName))])).toEqual([
      ["user", ["Build a savings goal screen"]],
      ["assistant", ["Starting", "bashTool"]],
      ["user", ["Make it green"]],
      ["assistant", ["Done, it's green"]],
    ]);
    const ui = toUIMessages(messages);
    expect(ui[1].parts[1]).toMatchObject({ type: "tool-bashTool", state: "output-available", input: { command: "npm test" } });
    expect(ui[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "Build a savings goal screen" }] });
  });

  it("without times (older Mynt), keeps the goal first and the activity in order", () => {
    const messages = buildToMessages({ id: "b", goal: "Build it please" }, { activity: [say("second"), say("first")] });
    expect(messages.map((m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")))).toEqual([["Build it please"], ["first", "second"]]);
    expect(buildToMessages(null, null)).toEqual([]);
  });
});
