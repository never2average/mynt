// The small Node program Mynt runs in a sandbox to drive Claude Code headless. Mynt, not the sandbox
// host, runs the agent: it installs a pinned Claude Code, gives it a prompt and a dollar budget, and
// reaches the model only through Mynt's agent proxy with a per-build token, so no Anthropic key ever
// enters the sandbox.
//
// Mynt writes <dir>/config.json ({ prompt, cwd, model, budgetUsd, version }) and <dir>/auth.json (the
// build token and the env pointing Claude Code at Mynt's proxy, for the Anthropic API or Vertex AI, and
// optionally Mynt's MCP server as the agent's tools; read once, then deleted), then runs `node <dir>/runner.mjs <dir>` detached. The
// runner keeps <dir>/state.json up to date and copies Claude Code's stream-json output to
// <dir>/agent.jsonl. To steer, Mynt drops a file into <dir>/inbox/: the runner interrupts the current
// turn and sends the message as the next one.

export const CLAUDE_CODE_VERSION = "2.1.314";

export interface AgentState {
  session_id: string | null;
  cost_usd: number;
  turns: number; // results seen
  sent: number; // user messages sent
  last_subtype: string | null; // "success" when the last turn finished cleanly
  done: boolean;
  exit_code: number | null;
  error: string | null;
  summary: string | null; // the agent's final message
}

export const AGENT_RUNNER = String.raw`
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
unlinkSync(join(dir, "auth.json"));

const state = { session_id: null, cost_usd: 0, turns: 0, sent: 0, last_subtype: null, done: false, exit_code: null, error: null, summary: null };
const save = () => {
  writeFileSync(join(dir, "state.tmp"), JSON.stringify(state));
  renameSync(join(dir, "state.tmp"), join(dir, "state.json"));
};
save();

const prefix = join(homedir(), ".mynt-claude");
const bin = join(prefix, "node_modules", ".bin", "claude");
try {
  if (!existsSync(bin)) {
    execFileSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "@anthropic-ai/claude-code@" + cfg.version], { stdio: "ignore" });
  }
} catch {
  state.done = true;
  state.error = "Couldn't install Claude Code " + cfg.version;
  save();
  process.exit(1);
}

mkdirSync(cfg.cwd, { recursive: true });
// Only the model calls, through Mynt: no telemetry, update checks or other outside traffic.
const env = { ...process.env, ...auth.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
for (const k of ["ANTHROPIC_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]) delete env[k];
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--dangerously-skip-permissions", "--max-budget-usd", String(cfg.budgetUsd)];
if (cfg.model) args.push("--model", cfg.model);
// Mynt's MCP server, when the run gets one: the config holds the token, so it's private to this user.
if (auth.mcp) {
  const mcpFile = join(dir, "mcp.json");
  writeFileSync(mcpFile, JSON.stringify({ mcpServers: { mynt: { type: "http", url: auth.mcp.url, headers: { Authorization: "Bearer " + auth.mcp.token } } } }), { mode: 0o600 });
  args.push("--mcp-config", mcpFile, "--strict-mcp-config");
}
const child = spawn(bin, args, { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const say = (text) => {
  send({ type: "user", message: { role: "user", content: text } });
  state.sent++;
  save();
};

const inbox = join(dir, "inbox");
mkdirSync(inbox, { recursive: true });
const seen = new Set();
const pending = () => readdirSync(inbox).filter((f) => !seen.has(f)).sort();
let ended = false;
// After its input is closed, Claude Code exits on its own, unless a background task it started (a preview
// server, say) keeps it alive: then it only reports on that task, forever. So once it has been quiet this long
// after its last result, end it; its last result stands.
const SETTLE_MS = Number(process.env.MYNT_AGENT_SETTLE_MS || 90000);
let quiet = null;
const settle = () => {
  clearTimeout(quiet);
  quiet = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10000).unref();
  }, SETTLE_MS);
};
// Close stdin once every message has had its turn and nothing is waiting: Claude Code then exits.
const maybeEnd = () => {
  if (!ended && state.turns >= state.sent && pending().length === 0) {
    ended = true;
    child.stdin.end();
  }
  if (ended) settle();
};

let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    appendFileSync(join(dir, "agent.jsonl"), line + "\n");
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "system" && m.subtype === "init") state.session_id = m.session_id ?? null;
    if (m.type === "result") {
      state.turns++;
      state.last_subtype = m.subtype ?? null;
      if (typeof m.result === "string") state.summary = m.result.slice(0, 4000);
      if (typeof m.total_cost_usd === "number") state.cost_usd = Math.max(state.cost_usd, m.total_cost_usd);
      save();
      maybeEnd();
    }
  }
});
child.stderr.on("data", (d) => appendFileSync(join(dir, "agent.err"), d));

const timer = setInterval(() => {
  if (ended) return;
  for (const f of pending()) {
    seen.add(f);
    let message;
    try {
      message = JSON.parse(readFileSync(join(inbox, f), "utf8")).message;
    } catch {
      continue;
    }
    if (typeof message !== "string" || !message) continue;
    if (state.turns < state.sent) send({ type: "control_request", request_id: "steer-" + f, request: { subtype: "interrupt" } });
    say(message);
  }
}, 2000);

say(cfg.prompt);

child.on("exit", (code) => {
  clearInterval(timer);
  clearTimeout(quiet);
  state.done = true;
  state.exit_code = code;
  save();
});
`;
