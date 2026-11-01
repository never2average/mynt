import { z } from "zod";

// The developer console: which of Mynt's developer tools the browser may ask this app to call,
// with what arguments, and how their replies become table rows. Pure functions only, so the
// server route and the page share them and the tests can check them without a network.

const id = z.string().trim().min(1).max(200);
const command = z.string().min(1).max(4000);
// A compose app's service (e.g. api or web), as Mynt checks it (src/hosting-tools.ts).
const service = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/).optional();

// Mynt's coding-agent and hosting tools (src/builds.ts, src/hosting-tools.ts), with the same
// limits Mynt applies. Mynt checks everything again; these keep junk off the wire. Anything not
// listed here (start_build, connect_repository, admin tools...) can't be called from the console.
export const DEV_TOOLS = {
  list_builds: z.object({ status: z.string().max(40).optional() }),
  get_build: z.object({ build_id: id }),
  get_build_activity: z.object({ build_id: id, limit: z.number().int().min(1).max(200).optional() }),
  steer_build: z.object({ build_id: id, message: z.string().trim().min(3).max(4000) }),
  stop_build: z.object({ build_id: id, reason: z.string().trim().min(1).max(500).optional() }),
  open_sandbox_editor: z.object({ build_id: id }),
  sandbox_run: z.object({ build_id: id, command, timeout_seconds: z.number().int().min(1).max(300).optional() }),
  sandbox_files: z.object({ build_id: id, path: z.string().max(1000).optional() }),
  sandbox_diff: z.object({ build_id: id }),
  reopen_sandbox: z.object({ build_id: id, hours: z.number().min(1).max(8).optional() }),
  close_sandbox: z.object({ build_id: id }),
  hosting_status: z.object({}),
  request_hosting: z.object({}),
  deploy_app: z.object({ app_id: id, build_id: id }),
  undeploy_app: z.object({ app_id: id }),
  vm_access: z.object({ hours: z.number().int().min(1).max(24).optional() }),
  app_status: z.object({ app_id: id }),
  app_logs: z.object({ app_id: id, tail: z.number().int().min(1).max(2000).optional(), service }),
  app_run: z.object({ app_id: id, command, timeout_seconds: z.number().int().min(1).max(120).optional(), service }),
  restart_app: z.object({ app_id: id, service }),
} as const;

export type DevTool = keyof typeof DEV_TOOLS;

// Tools whose replies carry a credential (the editor's password, an SSH login). Their replies go
// straight to the browser that asked: never logged, cached or kept in the session.
export const SECRET_TOOLS: ReadonlySet<DevTool> = new Set<DevTool>(["open_sandbox_editor", "vm_access"]);

export function isDevTool(name: unknown): name is DevTool {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(DEV_TOOLS, name);
}

export type DevCall = { tool: DevTool; args: Record<string, unknown> } | { error: string };

export function parseDevCall(body: unknown): DevCall {
  const b = (body ?? {}) as { tool?: unknown; args?: unknown };
  if (!isDevTool(b.tool)) return { error: "Unknown developer tool" };
  const parsed = DEV_TOOLS[b.tool].safeParse(b.args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  return { tool: b.tool, args: parsed.data as Record<string, unknown> };
}

// A line for the server log about a failed call: the tool name only, never its arguments (a
// command may contain a token) or its reply (it may be a credential).
export function logLine(tool: DevTool, err: unknown): string {
  const message = err instanceof Error ? err.name : "error";
  return `developer tool ${tool} failed (${message})`;
}

// Mynt replies with JSON text; anything else is shown as text.
export function parseToolText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Mynt's error replies are {"error": "..."}.
export function toolError(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") return (data as { error: string }).error;
  if (typeof data === "string" && data.trim()) return data.trim();
  return fallback;
}

// whoami's effective_roles (developers include innovators); roles as a fallback.
export function rolesFrom(whoami: unknown): string[] {
  const w = (whoami ?? {}) as { effective_roles?: unknown; roles?: unknown };
  const list = Array.isArray(w.effective_roles) ? w.effective_roles : Array.isArray(w.roles) ? w.roles : [];
  return list.filter((r): r is string => typeof r === "string");
}

export const isDeveloper = (roles: string[]) => roles.includes("developer") || roles.includes("innovator") || roles.includes("admin");

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function formatUsd(v: number | null): string {
  return v === null ? "" : `US$${v.toFixed(2)}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Builds

export interface BuildRow {
  id: string;
  status: string;
  goal: string;
  cost: string;
  cost_usd: number | null;
  cap_usd: number | null;
  created: string;
  created_at: string;
  app_id: string;
  preview_url: string;
  pr_url: string;
}

export function buildRow(b: unknown): BuildRow {
  const o = obj(b);
  const cost = num(o.cost_usd);
  const cap = num(o.cap_usd);
  return {
    id: str(o.id),
    status: str(o.status),
    goal: str(o.goal),
    cost: cost === null ? "" : cap === null ? formatUsd(cost) : `${formatUsd(cost)} of ${formatUsd(cap)}`,
    cost_usd: cost,
    cap_usd: cap,
    created: formatDate(str(o.created_at)),
    created_at: str(o.created_at),
    app_id: str(o.app_id),
    preview_url: safeUrl(o.preview_url),
    pr_url: safeUrl(o.pr_url),
  };
}

export interface BuildList {
  rows: BuildRow[];
  monthSpend: number | null;
  monthlyCap: number | null;
}

export function buildRows(data: unknown): BuildList {
  const o = obj(data);
  return {
    rows: arr(o.builds).map(buildRow).filter((r) => r.id),
    monthSpend: num(o.month_spend_usd),
    monthlyCap: num(o.monthly_cap_usd),
  };
}

// The build's facts for the metadata card, in a fixed order.
export function buildFacts(data: unknown): [string, string][] {
  const o = obj(data);
  const r = buildRow(o);
  const facts: [string, string][] = [
    ["Status", r.status],
    ["Phase", str(o.phase_message)],
    ["Cost", r.cost],
    ["Created", r.created],
    ["Finished", formatDate(str(o.finished_at))],
    ["App", r.app_id],
    ["Repository", str(o.repository)],
    ["Branch", str(o.branch)],
    ["Commit", str(o.commit_sha).slice(0, 12)],
    ["Error", str(o.error)],
  ];
  return facts.filter(([, v]) => v);
}

export interface EventRow {
  at: string;
  kind: string;
  message: string;
}

export function timelineRows(data: unknown): EventRow[] {
  return arr(obj(data).timeline).map((e) => {
    const o = obj(e);
    return { at: formatDate(str(o.at)), kind: str(o.phase), message: str(o.message) };
  });
}

export function activityRows(data: unknown): EventRow[] {
  return arr(obj(data).activity).map((e) => {
    const o = obj(e);
    return { at: "", kind: str(o.type), message: str(o.summary) };
  });
}

// sandbox_files: a directory listing (ls -la) or a file's content.

export interface FileRow {
  name: string;
  kind: "dir" | "file" | "link" | "other";
  size: string;
  modified: string;
  mode: string;
}

export type FilesView = { path: string; entries: FileRow[] } | { path: string; content: string } | { path: string; error: string };

export function parseListing(listing: string): FileRow[] {
  const rows: FileRow[] = [];
  for (const line of listing.split("\n")) {
    // drwxr-xr-x 2 user group 4096 Oct 31 10:00 name
    const m = line.match(/^([-dlcbps][rwxsStT-]{9}[.+@]?)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+[\d:]{4,5})\s+(.+)$/);
    if (!m) continue;
    const [, mode, size, modified, rawName] = m;
    const name = mode.startsWith("l") ? rawName.split(" -> ")[0] : rawName;
    if (name === "." || name === "..") continue;
    const kind = mode.startsWith("d") ? "dir" : mode.startsWith("l") ? "link" : mode.startsWith("-") ? "file" : "other";
    rows.push({ name, kind, size: kind === "dir" ? "" : size, modified: modified.replace(/\s+/g, " "), mode });
  }
  return rows.sort((a, b) => (a.kind === "dir") === (b.kind === "dir") ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1);
}

export function filesView(data: unknown, requested: string): FilesView {
  const o = obj(data);
  const path = str(o.path) || requested;
  if (typeof o.error === "string") return { path, error: o.error };
  if (typeof o.listing === "string") return { path, entries: parseListing(o.listing) };
  if (typeof o.content === "string") return { path, content: o.content };
  return { path, error: typeof data === "string" ? data : "Mynt returned nothing for this path" };
}

// A path relative to the app, for the next sandbox_files call.
export function joinPath(dir: string, name: string): string {
  if (name === "..") {
    const parts = dir.split("/").filter((p) => p && p !== ".");
    parts.pop();
    return parts.length ? parts.join("/") : ".";
  }
  return dir === "." || dir === "" ? name : `${dir.replace(/\/+$/, "")}/${name}`;
}

// sandbox_diff: "git status --short", "----", "git diff --stat", "----", the full diff.

export interface ChangeRow {
  status: string;
  path: string;
  stat: string;
}

export function diffView(data: unknown): { changes: ChangeRow[]; diff: string; error: string } {
  const o = obj(data);
  const text = str(o.diff);
  const [statusPart = "", statPart = "", ...rest] = text.split(/^----$/m);
  const stats = new Map<string, string>();
  for (const line of statPart.split("\n")) {
    const m = line.match(/^\s*(.+?)\s+\|\s+(.+)$/);
    if (m) stats.set(m[1].trim(), m[2].trim());
  }
  const changes = statusPart
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim())
    .map((l) => {
      const path = l.slice(3).trim();
      return { status: l.slice(0, 2).trim() || "?", path, stat: stats.get(path) ?? "" };
    });
  return { changes, diff: rest.join("----").replace(/^\n/, ""), error: o.exit_code && o.exit_code !== 0 ? str(o.stderr) : "" };
}

// sandbox_run and app_run: one row per command run in this page.

export interface RunRow {
  command: string;
  exit: string;
  output: string;
  at: string;
}

export function runRow(command: string, data: unknown, isError: boolean, at = new Date().toISOString()): RunRow {
  const o = obj(data);
  if (isError) return { command, exit: "error", output: toolError(data, "Mynt couldn't run this"), at: formatDate(at) };
  const output = typeof o.output === "string" ? o.output : [str(o.stdout), str(o.stderr)].filter(Boolean).join("\n");
  return { command, exit: o.exit_code === undefined || o.exit_code === null ? "" : str(o.exit_code), output, at: formatDate(at) };
}

// Hosting

export interface AppRow {
  app_id: string;
  url: string;
  status: string;
  error: string;
  commit: string;
  build_id: string;
  repository: string;
  updated: string;
  services: ServiceRow[];
}

// A compose app's services, each served at its own address.
export interface ServiceRow {
  service: string;
  expose: string;
  port: string;
  url: string;
}

export function serviceRows(v: unknown): ServiceRow[] {
  return arr(v)
    .map((x) => {
      const o = obj(x);
      return { service: str(o.service), expose: str(o.expose), port: str(o.port), url: safeUrl(o.url) };
    })
    .filter((x) => x.service);
}

export function appRow(a: unknown): AppRow {
  const o = obj(a);
  return {
    app_id: str(o.app_id),
    url: safeUrl(o.url),
    status: str(o.status),
    error: str(o.error),
    commit: str(o.commit_sha).slice(0, 12),
    build_id: str(o.build_id),
    repository: str(o.repository),
    updated: formatDate(str(o.updated_at)),
    services: serviceRows(o.services),
  };
}

// hosting_status usage: machine time across the app VMs and its estimated cost (or null).
export function usageFacts(v: unknown): [string, string][] | null {
  if (!v || typeof v !== "object") return null;
  const o = obj(v);
  const vms = num(o.vms);
  const hours = num(o.hours);
  const usd = num(o.usd_estimate);
  const rate = num(o.usd_per_hour);
  return ([
    ["VMs", vms === null ? "" : String(vms)],
    ["Machine hours", hours === null ? "" : String(hours)],
    ["Estimated cost", usd === null ? "" : `${formatUsd(usd)} (estimate${rate === null ? "" : `, at ${formatUsd(rate)} per VM hour`})`],
  ] as [string, string][]).filter(([, x]) => x);
}

// vm_access: one SSH login per hosted app VM, named after the app when the console knows it.
export interface LoginRow {
  app_id: string;
  name: string;
  ssh: string;
}

export function sshLogins(data: unknown, names: Record<string, string> = {}): { logins: LoginRow[]; expires: string } {
  const o = obj(data);
  const logins = arr(o.logins)
    .map((x) => {
      const l = obj(x);
      const app_id = str(l.app_id);
      return { app_id, name: names[app_id] || app_id, ssh: typeof l.ssh === "string" ? l.ssh : "" };
    })
    .filter((l) => l.app_id && l.ssh);
  return { logins, expires: formatDate(str(o.expires_at)) };
}

export function hostingView(data: unknown): { tenant: [string, string][] | null; status: string; apps: AppRow[]; usage: [string, string][] | null } {
  const o = obj(data);
  const t = o.tenant ? obj(o.tenant) : null;
  const tenant = t
    ? ([
        ["Status", str(t.status)],
        ["Provider", str(t.provider)],
        ["VM", str(t.vm_id)],
        ["Created", formatDate(str(t.created_at))],
        ["Updated", formatDate(str(t.updated_at))],
        ["Error", str(t.error)],
      ] as [string, string][]).filter(([, v]) => v)
    : null;
  return { tenant, status: t ? str(t.status) : "", apps: arr(o.apps).map(appRow).filter((a) => a.app_id), usage: usageFacts(o.usage) };
}

// app_logs: "<RFC3339 timestamp> <line>" per line (docker logs --timestamps).
export function logRows(output: string): { at: string; line: string }[] {
  return output
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const m = l.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s(.*)$/);
      return m ? { at: m[1].replace("T", " ").replace(/\.\d+/, ""), line: m[2] } : { at: "", line: l };
    });
}

// app_status: "running since ..., health ..., restarts N, image ..." then "x% CPU, y memory".
export function statusRows(output: string): [string, string][] {
  const rows: [string, string][] = [];
  for (const line of output.split("\n")) {
    for (const part of line.split(/,\s+/)) {
      const p = part.trim();
      if (!p) continue;
      const since = p.match(/^(\w+) since (.+)$/);
      if (since) {
        rows.push(["State", since[1]], ["Since", since[2]]);
        continue;
      }
      const kv = p.match(/^(health|restarts|image)\s+(.+)$/);
      if (kv) {
        rows.push([kv[1][0].toUpperCase() + kv[1].slice(1), kv[2]]);
        continue;
      }
      const tail = p.match(/^(.+?)\s+(CPU|memory)$/);
      if (tail) {
        rows.push([tail[2] === "CPU" ? "CPU" : "Memory", tail[1]]);
        continue;
      }
      rows.push(["", p]);
    }
  }
  return rows;
}

// Links from Mynt open only if they're http(s).
export function safeUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : "";
  } catch {
    return "";
  }
}

// The search box: a row matches when every word appears in one of its values.
export function matches(row: object, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = Object.values(row)
    .map((v) => (typeof v === "string" || typeof v === "number" ? String(v) : ""))
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export const ACTIVE_BUILD = new Set(["queued", "provisioning", "coding", "auditing", "checking", "previewing", "pushing", "verifying"]);

// Finished builds whose sandbox can be reopened on their branch (reopen_sandbox).
export const FINISHED_BUILD = new Set(["succeeded", "blocked", "failed", "stopped", "over_budget"]);

// reopen_sandbox's reply: ready, and until when.
export function reopenState(data: unknown): { ready: boolean; until: string } {
  const o = obj(data);
  return { ready: o.ready === true, until: formatDate(str(o.until)) };
}
