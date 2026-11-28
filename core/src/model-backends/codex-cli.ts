// The agent runner for the "responses" backend: the small Node program Mynt runs in a sandbox to drive the provider's
// own coding-agent CLI (OpenAI's Codex CLI) headless. The other runner (agent-runner.ts) drives Claude Code, which
// can't talk to this backend. Both keep the same record for Mynt (<dir>/state.json, <dir>/agent.jsonl), so whoever
// started the agent reads its run the same way.
//
// Mynt writes <dir>/config.json ({ prompt, cwd, model, budgetUsd, version }) and <dir>/auth.json ({ token, baseUrl }:
// the run's token and Mynt's agent proxy; read once, then deleted), and runs `node <dir>/runner.mjs <dir>` detached.
// The provider's key never enters the sandbox: the CLI is given a provider of Mynt's own in its config file, whose
// base URL is Mynt's proxy and whose key is the run's token.
//
// What this relies on, each checked against the CLI itself (`codex exec --help`, and runs of version 0.172.0
// against a stand-in provider on the loopback address) and its documentation (non-interactive mode, AGENTS.md,
// advanced configuration), 2026-11-28:
//   - `codex exec [PROMPT]` runs one turn without the terminal UI; with --json, stdout is JSON Lines:
//     thread.started { thread_id }, turn.started, item.started / item.completed { item: { type: "agent_message",
//     text } | { type: "command_execution", … } | { type: "error", message } }, turn.completed { usage: {
//     input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }, turn.failed { error: { message } },
//     error { message }. It exits 0 after turn.completed and 1 after turn.failed.
//   - -o / --output-last-message <file> writes the agent's last message; -C <dir> is its working root; -m its model.
//   - --skip-git-repo-check lets it run outside a Git repository; --ephemeral keeps no session files.
//   - --dangerously-bypass-approvals-and-sandbox: no approval prompts and no sandbox of the CLI's own, "intended
//     solely for running in environments that are externally sandboxed". Mynt's sandbox is that environment (a
//     throwaway VM holding nothing but the job), and the red team must start a local validator and reach package
//     registries, which the CLI's own sandbox modes don't allow.
//   - It waits on stdin when stdin is open ("Reading additional input from stdin..."), so stdin is closed.
//   - $CODEX_HOME/config.toml: model_provider and [model_providers.<id>] (name, base_url, env_key, wire_api =
//     "responses"); it then POSTs <base_url>/responses with `Authorization: Bearer <the env_key variable's value>`.
//     [analytics], [feedback] and [history] switch off its analytics, feedback uploads and transcript history;
//     [shell_environment_policy] exclude keeps a variable out of the environment of the commands it runs.
//   - It reads AGENTS.md from its working directory as the project's instructions (32 KiB by default,
//     project_doc_max_bytes), not CLAUDE.md: see projectInstructions below.
// It has no dollar budget of its own: the proxy meters the run and refuses calls once its cap is spent, which this
// runner records the way the other runner records a spent budget.

export const CODEX_CLI_VERSION = "0.172.0";
export const CODEX_CLI_PACKAGE = "@openai/codex";
// The most AGENTS.md may hold, set in the CLI's config (its default is 32 KiB).
export const PROJECT_DOC_MAX_BYTES = 256 * 1024;

/** The CLI's config file for one run: Mynt's proxy as its only provider, nothing sent anywhere else, nothing kept. */
export function codexConfigToml(o: { model: string; baseUrl: string }): string {
  const q = (s: string) => JSON.stringify(s); // a JSON string is a TOML basic string for what Mynt writes here
  return [
    `model = ${q(o.model)}`,
    `model_provider = "mynt"`,
    `project_doc_max_bytes = ${PROJECT_DOC_MAX_BYTES}`,
    ``,
    `[model_providers.mynt]`,
    `name = "Mynt agent proxy"`,
    `base_url = ${q(o.baseUrl)}`,
    `env_key = "MYNT_AGENT_TOKEN"`,
    `wire_api = "responses"`,
    ``,
    `[analytics]`,
    `enabled = false`,
    ``,
    `[feedback]`,
    `enabled = false`,
    ``,
    `[history]`,
    `persistence = "none"`,
    ``,
    // The run's token stays out of the environment of the commands the agent runs.
    `[shell_environment_policy]`,
    `exclude = ["MYNT_AGENT_TOKEN"]`,
    ``,
  ].join("\n");
}

/** The CLI's arguments for one headless run. */
export function codexExecArgs(o: { cwd: string; model: string; lastMessageFile: string; prompt: string }): string[] {
  return ["exec", "--json", "--skip-git-repo-check", "--ephemeral", "--dangerously-bypass-approvals-and-sandbox", "-C", o.cwd, "-m", o.model, "-o", o.lastMessageFile, o.prompt];
}

/**
 * AGENTS.md for a workspace, made from its CLAUDE.md when the job is prepared, so a workspace keeps one set of
 * instructions: CLAUDE.md, word for word, under a note saying where its skills are (plain Markdown the CLI can read
 * by path). Returns nothing to add when the workspace brings an AGENTS.md of its own.
 */
export function projectInstructions(files: Record<string, string>): Record<string, string> {
  if (files["AGENTS.md"] !== undefined) return {};
  const claude = files["CLAUDE.md"];
  if (!claude) throw new Error("The workspace has no CLAUDE.md to make AGENTS.md from");
  const skills = Object.keys(files)
    .map((path) => /^\.claude\/skills\/([^/]+)\/SKILL\.md$/.exec(path))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => a[1].localeCompare(b[1]));
  const text = [
    "<!-- Made by Mynt from this workspace's CLAUDE.md when the job was prepared. Change CLAUDE.md, never this file. -->",
    "",
    "Below the line are this workspace's instructions, word for word. Where they say CLAUDE.md, they mean this text.",
    ...(skills.length
      ? ["Each skill they name is a Markdown file in this folder. Read a skill's file before you use it:", "", ...skills.map((m) => `- \`${m[1]}\`: \`${m[0]}\``)]
      : []),
    "",
    "---",
    "",
    claude,
  ].join("\n");
  if (Buffer.byteLength(text) > PROJECT_DOC_MAX_BYTES) throw new Error(`The workspace's instructions are over ${PROJECT_DOC_MAX_BYTES} bytes, more than the agent CLI reads`);
  return { "AGENTS.md": text };
}

const TEMPLATE = String.raw`
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2];
const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
unlinkSync(join(dir, "auth.json"));

// usage: the CLI's own token counts, for the record only. What the run spent is metered at Mynt's proxy.
const state = { session_id: null, cost_usd: 0, turns: 0, sent: 0, last_subtype: null, done: false, exit_code: null, error: null, summary: null, usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
const save = () => {
  writeFileSync(join(dir, "state.tmp"), JSON.stringify(state));
  renameSync(join(dir, "state.tmp"), join(dir, "state.json"));
};
save();

const prefix = join(homedir(), ".mynt-agent-cli");
const bin = process.env.MYNT_AGENT_CLI_BIN || join(prefix, "node_modules", ".bin", "codex");
try {
  if (!existsSync(bin)) {
    execFileSync("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "__PACKAGE__@" + cfg.version], { stdio: "ignore" });
  }
} catch {
  state.done = true;
  state.error = "Couldn't install the agent CLI " + cfg.version;
  save();
  process.exit(1);
}

mkdirSync(cfg.cwd, { recursive: true });
// The CLI's home for this run: its config (Mynt's proxy as the only provider) and nothing of anyone's account.
const home = join(dir, "cli-home");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "config.toml"), __CONFIG__({ model: cfg.model, baseUrl: auth.baseUrl }), { mode: 0o600 });
const env = { ...process.env, CODEX_HOME: home, MYNT_AGENT_TOKEN: auth.token };
for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "ANTHROPIC_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]) delete env[k];
const lastMessageFile = join(dir, "last-message.txt");
const args = __ARGS__({ cwd: cfg.cwd, model: cfg.model, lastMessageFile, prompt: cfg.prompt });
// stdin closed: with it open the CLI waits for more input before it starts.
const child = spawn(bin, args, { cwd: cfg.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
state.sent = 1;
save();

const log = (line) => appendFileSync(join(dir, "agent.jsonl"), line + "\n");
const text = (s) => (typeof s === "string" ? s.slice(0, 4000) : null);
// The proxy's words once the run's cap is spent (it answers 402 with them, and the CLI repeats them).
const BUDGET = /This run's model budget \(US\$[\d.]+\) is spent/;
let lastMessage = null;
let lastError = null;
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    log(line);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (!m || typeof m !== "object") continue;
    if (m.type === "thread.started") state.session_id = typeof m.thread_id === "string" ? m.thread_id : null;
    if (m.type === "item.completed" && m.item && m.item.type === "agent_message") lastMessage = text(m.item.text);
    if (m.type === "error") lastError = text(m.message);
    if (m.type === "turn.completed") {
      state.turns++;
      state.last_subtype = "success";
      state.summary = lastMessage;
      const u = m.usage || {};
      for (const k of ["input_tokens", "cached_input_tokens", "output_tokens"]) if (typeof u[k] === "number") state.usage[k] += u[k];
      save();
    }
    if (m.type === "turn.failed") {
      const why = text(m.error && m.error.message) || lastError || "The turn failed";
      state.turns++;
      state.last_subtype = BUDGET.test(why) ? "error_max_budget_usd" : "error_during_execution";
      state.summary = why;
      save();
    }
  }
});
child.stderr.on("data", (d) => appendFileSync(join(dir, "agent.err"), d));
child.on("error", (e) => {
  state.done = true;
  state.error = "Couldn't start the agent CLI: " + String(e && e.message).slice(0, 300);
  save();
});
child.on("exit", (code) => {
  // The file the CLI wrote its last message to, where the events gave none.
  if (state.last_subtype === "success" && !state.summary && existsSync(lastMessageFile)) state.summary = text(readFileSync(lastMessageFile, "utf8"));
  if (state.turns === 0 && lastError) state.summary = lastError;
  state.done = true;
  state.exit_code = code;
  save();
});
`;

/** The runner program, with the config and argument builders above written into it: one source for both. */
export const CODEX_RUNNER = TEMPLATE.replace("__PACKAGE__", () => CODEX_CLI_PACKAGE)
  .replace("__CONFIG__", () => `(${codexConfigToml.toString().replace("PROJECT_DOC_MAX_BYTES", String(PROJECT_DOC_MAX_BYTES))})`)
  .replace("__ARGS__", () => `(${codexExecArgs.toString()})`);
