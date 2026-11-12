// The studio's chat, as pure functions: whether a message steers a running build or starts one,
// following a build's activity, and turning that activity into chat messages drawn with
// Adorable's tool cards. The studio has no model of its own; the "assistant" is Mynt's coding
// agent, and what it says and does comes from get_build_activity.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Build statuses in which Mynt's agent is running and steer_build reaches it (src/builds.ts AGENT_PHASES). */
export const STEERABLE = new Set(["coding", "auditing", "checking", "previewing", "pushing"]);
/** Statuses after which nothing more will happen. */
export const FINISHED = new Set(["succeeded", "blocked", "failed", "stopped", "over_budget"]);
/** A build that's starting: not steerable yet, but another must not be started beside it. */
export const STARTING = new Set(["queued", "provisioning"]);

export type BuildSummary = {
  id: string;
  app_id: string | null;
  status: string;
  commit_sha: string | null;
  updated_at: string;
};

export function buildSummaries(listBuildsReply: unknown): BuildSummary[] {
  const builds = isObj(listBuildsReply) && Array.isArray(listBuildsReply.builds) ? listBuildsReply.builds : [];
  return builds.filter(isObj).flatMap((b) => {
    const id = str(b.id);
    if (!id) return [];
    return [{ id, app_id: str(b.app_id) ?? null, status: str(b.status) ?? "unknown", commit_sha: str(b.commit_sha) ?? null, updated_at: str(b.updated_at) ?? str(b.created_at) ?? "" }];
  });
}

/** What the signed-in user's Mynt offers, read from its tool list. */
export type Capabilities = {
  /** start_build takes mode "session" and continue_from, and finish_build exists (session builds). */
  sessionBuilds: boolean;
};

export function capabilitiesFrom(tools: { name: string; inputSchema?: unknown }[]): Capabilities {
  const start = tools.find((t) => t.name === "start_build");
  const props = isObj(start?.inputSchema) && isObj(start.inputSchema.properties) ? start.inputSchema.properties : {};
  return { sessionBuilds: "mode" in props && "continue_from" in props && tools.some((t) => t.name === "finish_build") };
}

export type ChatAction =
  | { kind: "steer"; buildId: string; args: { build_id: string; message: string } }
  | { kind: "start"; args: { goal: string; app_id: string; mode?: "session"; continue_from?: string } }
  | { kind: "follow"; buildId: string; message: string }
  | { kind: "refuse"; message: string };

export const MIN_GOAL = 10;
export const MIN_STEER = 3;
export const MAX_MESSAGE = 4000;

export const STARTING_NOTE = "A build of this app is still starting. Send your message again once the agent is working; here's what it's doing.";
export const FINISHING_NOTE =
  "The agent has finished its work on this build, and Mynt is checking and shipping it, so it can't take more instructions. Here's its progress; send your message again once it's done to start a new build.";

/**
 * Steer if the project has a running build (the one the user is looking at, else its newest),
 * otherwise start one for the app. Session builds, where this Mynt has them, keep the agent
 * waiting for the next message and carry on from the app's last build.
 */
export function chooseAction(opts: {
  appId: string;
  selectedBuildId: string | null;
  builds: BuildSummary[];
  text: string;
  capabilities: Capabilities;
}): ChatAction {
  const text = opts.text.trim();
  if (!text) return { kind: "refuse", message: "Type a message first." };
  if (text.length > MAX_MESSAGE) return { kind: "refuse", message: `Keep it under ${MAX_MESSAGE} characters.` };
  const mine = opts.builds.filter((b) => b.app_id === opts.appId).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const live = mine.filter((b) => STEERABLE.has(b.status));
  const target = live.find((b) => b.id === opts.selectedBuildId) ?? live[0];
  if (target) {
    if (text.length < MIN_STEER) return { kind: "refuse", message: `Say a little more (at least ${MIN_STEER} characters).` };
    return { kind: "steer", buildId: target.id, args: { build_id: target.id, message: text } };
  }
  // One build at a time per app: a build that's still starting is followed, not doubled.
  const starting = mine.find((b) => STARTING.has(b.status));
  if (starting) return { kind: "follow", buildId: starting.id, message: STARTING_NOTE };

  if (text.length < MIN_GOAL) return { kind: "refuse", message: `Say a little more about what to build (at least ${MIN_GOAL} characters).` };
  const args: { goal: string; app_id: string; mode?: "session"; continue_from?: string } = { goal: text, app_id: opts.appId };
  if (opts.capabilities.sessionBuilds) {
    args.mode = "session";
    const previous = mine.find((b) => b.commit_sha);
    if (previous) args.continue_from = previous.id;
  }
  return { kind: "start", args };
}

/**
 * Whether a steer reaches the agent, decided from the build's latest activity just before it's
 * sent, and how to tell when the agent has answered it.
 *
 * - Mid-turn (the latest entry isn't a finished turn): Mynt's runner interrupts the running
 *   turn to deliver the steer, so the interrupted turn reports finishing first. That first
 *   finished turn isn't the answer; the next one is.
 * - Between turns, without session builds: the runner has stopped taking messages (it's
 *   finishing the build), though the status may still say coding for a while. A steer would be
 *   accepted and never read, so it isn't sent.
 * - Between turns, with session builds: the agent is waiting for the next message.
 */
export function planSteer(latest: ActivityItem | undefined, capabilities: Capabilities): { send: true; skipTurnEnds: number } | { send: false; message: string } {
  const betweenTurns = latest?.type === "turn_finished";
  if (betweenTurns && !capabilities.sessionBuilds) return { send: false, message: FINISHING_NOTE };
  return { send: true, skipTurnEnds: betweenTurns ? 0 : 1 };
}

/**
 * Reads a batch of new activity for the end of the agent's answer: the first finished turn
 * after any that are to be skipped. Returns whether the answer is over and how many finished
 * turns are still to skip.
 */
export function consumeTurnEnds(items: ActivityItem[], skip: number, status: string | null): { over: boolean; skip: number } {
  let left = skip;
  for (const i of items) {
    if (i.type !== "turn_finished") continue;
    if (left > 0) left--;
    else return { over: true, skip: left };
  }
  return { over: status !== null && FINISHED.has(status), skip: left };
}

/* ------------------------------------------------------------------ */
/*  Activity                                                          */
/* ------------------------------------------------------------------ */

export type ActivityItem = { type: string; summary: string; seq?: number; at?: string };

export type ActivityReply = {
  status: string | null;
  phaseMessage: string | null;
  /** Oldest first. */
  items: ActivityItem[];
  /** Present when Mynt keeps activity with a cursor. */
  cursor: number | null;
  firstSeq: number | null;
};

function item(v: unknown): ActivityItem | null {
  if (!isObj(v) || typeof v.type !== "string" || typeof v.summary !== "string") return null;
  return { type: v.type, summary: v.summary, ...(typeof v.seq === "number" ? { seq: v.seq } : {}), ...(typeof v.at === "string" ? { at: v.at } : {}) };
}

/**
 * get_build_activity's reply, oldest first. With a cursor (`after`), Mynt returns entries oldest
 * first; without one it returns the latest, newest first.
 */
export function parseActivity(reply: unknown, askedAfter: boolean): ActivityReply {
  const r = isObj(reply) ? reply : {};
  const items = (Array.isArray(r.activity) ? r.activity : []).map(item).filter((x): x is ActivityItem => x !== null);
  const cursor = typeof r.cursor === "number" ? r.cursor : null;
  const oldestFirst = askedAfter && cursor !== null ? items : [...items].reverse();
  return {
    status: str(r.status) ?? null,
    phaseMessage: typeof r.phase_message === "string" ? r.phase_message : null,
    items: oldestFirst,
    cursor,
    firstSeq: typeof r.first_seq === "number" ? r.first_seq : null,
  };
}

const same = (a: ActivityItem, b: ActivityItem) => a.type === b.type && a.summary === b.summary;

/**
 * Without a cursor, each poll returns the latest window. The new items are what follows the
 * longest stretch of the previous window that the new one starts with.
 */
export function newSince(previous: ActivityItem[], current: ActivityItem[]): ActivityItem[] {
  if (!previous.length) return current;
  for (let start = 0; start < previous.length; start++) {
    const overlap = previous.length - start;
    if (overlap > current.length) continue;
    let ok = true;
    for (let i = 0; i < overlap; i++) {
      if (!same(previous[start + i], current[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return current.slice(overlap);
  }
  return current; // no overlap: the window moved past everything seen
}

/**
 * Follows a build's activity across polls: by cursor where Mynt has one, otherwise by comparing
 * windows. `baseline` marks what was there before the user's message, so only what follows it
 * is shown.
 */
export class ActivityFollower {
  private cursor: number | null = null;
  private window: ActivityItem[] = [];
  /** Entries were trimmed before they could be shown. */
  missed = false;

  /** Arguments for the next get_build_activity call. */
  next(buildId: string): { build_id: string; limit: number; after?: number } {
    return this.cursor === null ? { build_id: buildId, limit: 200 } : { build_id: buildId, limit: 200, after: this.cursor };
  }

  /** Feeds one reply; returns the items not seen before. */
  take(reply: unknown): { items: ActivityItem[]; status: string | null; phaseMessage: string | null } {
    const askedAfter = this.cursor !== null;
    const r = parseActivity(reply, askedAfter);
    let items: ActivityItem[];
    if (r.cursor !== null) {
      if (askedAfter && r.firstSeq !== null && this.cursor !== null && r.firstSeq > this.cursor + 1) this.missed = true;
      items = askedAfter ? r.items.filter((i) => i.seq === undefined || i.seq > (this.cursor ?? 0)) : r.items;
      this.cursor = Math.max(this.cursor ?? 0, r.cursor);
    } else {
      items = newSince(this.window, r.items);
      this.window = r.items;
    }
    return { items, status: r.status, phaseMessage: r.phaseMessage };
  }

  /** Records the current state without showing it (before the user's message is sent). */
  baseline(reply: unknown): { status: string | null; latest: ActivityItem | undefined } {
    const { items, status } = this.take(reply);
    return { status, latest: items[items.length - 1] };
  }
}

/* ------------------------------------------------------------------ */
/*  Activity → message parts                                          */
/* ------------------------------------------------------------------ */

export type ChatPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; toolName: string; input: Obj };

const FIELD = /"(command|file_path|path|pattern|notebook_path|url|description)"\s*:\s*"((?:[^"\\]|\\.)*)/g;

/** A tool_use summary is `Name {json input}`, possibly cut short. */
export function parseToolSummary(summary: string): { name: string; input: Obj } {
  const space = summary.indexOf(" ");
  const name = (space === -1 ? summary : summary.slice(0, space)).trim();
  const rest = space === -1 ? "" : summary.slice(space + 1).trim();
  try {
    const parsed = JSON.parse(rest);
    if (isObj(parsed)) return { name, input: parsed };
  } catch {
    // cut short: pick the fields the cards use out of the text
  }
  const input: Obj = {};
  for (const m of rest.matchAll(FIELD)) {
    if (!(m[1] in input)) {
      try {
        input[m[1]] = JSON.parse(`"${m[2]}"`);
      } catch {
        input[m[1]] = m[2];
      }
    }
  }
  return { name, input };
}

/** The coding agent's tools, drawn with Adorable's cards (components/assistant-ui/thread.tsx). */
export function toolCard(name: string, input: Obj): { toolName: string; input: Obj } {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case "Bash":
      return { toolName: "bashTool", input: { command: str(input.command) ?? "" } };
    case "Read":
      return { toolName: "readFileTool", input: { file: file ?? "" } };
    case "Write":
      return { toolName: "writeFileTool", input: { file: file ?? "" } };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { toolName: "replaceInFileTool", input: { file: file ?? "" } };
    case "Glob":
    case "LS":
      return { toolName: "listFilesTool", input: { path: str(input.pattern) ?? file ?? "" } };
    case "Grep":
      return { toolName: "searchFilesTool", input: { query: str(input.pattern) ?? "" } };
    default:
      return { toolName: name.replace(/[^A-Za-z0-9_-]/g, "_") || "tool", input };
  }
}

/** Activity items as chat parts. A finished turn draws nothing. */
export function activityToParts(items: ActivityItem[]): ChatPart[] {
  return items.flatMap((i): ChatPart[] => {
    if (i.type === "message") return i.summary.trim() ? [{ kind: "text", text: i.summary }] : [];
    if (i.type === "tool_use") {
      const { name, input } = parseToolSummary(i.summary);
      return [{ kind: "tool", ...toolCard(name, input) }];
    }
    return [];
  });
}

/** The agent finished answering: a turn ended, or the build is done. */
export function turnOver(items: ActivityItem[], status: string | null): boolean {
  return items.some((i) => i.type === "turn_finished") || (status !== null && FINISHED.has(status));
}

/* ------------------------------------------------------------------ */
/*  A build as a conversation                                         */
/* ------------------------------------------------------------------ */

export type HistoryMessage = { id: string; role: "user" | "assistant"; parts: ChatPart[] };

/**
 * A past build rebuilt as a conversation: the goal and each steer the developer sent are user
 * messages, the agent's activity is the assistant's. Ordered by time where Mynt gives times.
 */
export function buildToMessages(build: unknown, activityReply: unknown): HistoryMessage[] {
  const b = isObj(build) ? build : {};
  const id = str(b.id) ?? "build";
  type Entry = { at: string; order: number; role: "user" | "assistant"; parts: ChatPart[] };
  const entries: Entry[] = [];
  let order = 0;
  const goal = str(b.goal);
  if (goal) entries.push({ at: str(b.created_at) ?? "", order: order++, role: "user", parts: [{ kind: "text", text: goal }] });
  for (const e of Array.isArray(b.timeline) ? b.timeline.filter(isObj) : []) {
    const message = isObj(e.data) ? str(e.data.message) : undefined;
    if (message && /steered/i.test(str(e.message) ?? "")) entries.push({ at: str(e.at) ?? str(e.created_at) ?? "", order: order++, role: "user", parts: [{ kind: "text", text: message }] });
  }
  for (const a of parseActivity(activityReply, false).items) {
    const parts = activityToParts([a]);
    if (parts.length) entries.push({ at: a.at ?? "", order: order++, role: "assistant", parts });
  }
  const timed = entries.every((e) => e.at);
  if (timed) entries.sort((x, y) => x.at.localeCompare(y.at) || x.order - y.order);

  // Consecutive entries from the same side become one message.
  const out: HistoryMessage[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.role === e.role) last.parts.push(...e.parts);
    else out.push({ id: `${id}-${out.length}`, role: e.role, parts: [...e.parts] });
  }
  return out;
}
