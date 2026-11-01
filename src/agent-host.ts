import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_RUNNER, CLAUDE_CODE_VERSION, type AgentState } from "./agent-runner.js";
import type { BoatClient } from "./boat.js";

// Runs Claude Code (through Mynt's runner) in a boat sandbox. Shared by coding-agent builds and the
// business-development agent: both reach the model only through Mynt's agent proxy with a token
// their caller mints, and optionally reach Mynt's own MCP server with that token as their only tools.

export const AGENT_DIR = "/home/user/mynt-agent";
// Mynt's agent workspaces: workspaces/<name>/ in this repository (CLAUDE.md, .claude/skills, scripts),
// copied into the sandbox and used as the agent's working directory, so the workflow steers the agent.
export const WORKSPACES_ROOT = fileURLToPath(new URL("../workspaces/", import.meta.url));
export const workspaceCwd = (name: string) => `/home/user/workspaces/${name}`;

// Every file of a workspace, by path relative to it.
export function workspaceFiles(name: string, root = WORKSPACES_ROOT): Record<string, string> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Bad workspace name '${name}'`);
  const base = join(root, name);
  const out: Record<string, string> = {};
  let size = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "__pycache__") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else {
        const text = readFileSync(path, "utf8");
        size += text.length;
        if (size > 2 * 1024 * 1024) throw new Error(`Workspace '${name}' is over 2 MB`);
        out[relative(base, path)] = text;
      }
    }
  };
  walk(base);
  if (!out["CLAUDE.md"]) throw new Error(`Workspace '${name}' has no CLAUDE.md`);
  return out;
}

// Where agents' model calls go, through Mynt's agent proxy. The credentials stay on Mynt's server.
export type AgentBackend =
  | { kind: "anthropic"; apiKey: string }
  | { kind: "vertex"; projectId: string; region: string; auth: { accessToken(): Promise<string> } };

export interface AgentHostConfig {
  agentBackend: AgentBackend | null;
  model: string;
  publicUrl: string;
}

const parse = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

// The token and the env that point a sandbox's Claude Code at Mynt's proxy (and, with `mcp`, at
// Mynt's MCP server).
export function agentAuth(config: AgentHostConfig, token: string, opts: { mcp?: boolean } = {}) {
  const backend = config.agentBackend!;
  const base = `${config.publicUrl}/agent`;
  const env: Record<string, string> =
    backend.kind === "vertex"
      ? {
          CLAUDE_CODE_USE_VERTEX: "1",
          CLAUDE_CODE_SKIP_VERTEX_AUTH: "1", // Mynt signs the calls; the proxy pins the real project
          ANTHROPIC_VERTEX_BASE_URL: `${base}/t/${token}/v1`,
          ANTHROPIC_VERTEX_PROJECT_ID: "mynt",
          CLOUD_ML_REGION: backend.region,
        }
      : { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token };
  return { token, env, ...(opts.mcp ? { mcp: { url: `${config.publicUrl}/mcp`, token } } : {}) };
}

// Starts Claude Code in `sandbox` through the runner; returns the runner's process id.
export async function launchAgent(
  boat: BoatClient,
  config: AgentHostConfig,
  sandbox: string,
  o: {
    prompt: string;
    cwd?: string;
    budgetUsd: number;
    token: string;
    mcp?: boolean;
    workspace?: string; // a Mynt workspace to load as the agent's working directory
    jobFiles?: Record<string, string>; // job data, by path relative to the workspace (e.g. job/case.json)
  },
) {
  const budgetUsd = Math.max(0.5, Math.floor(o.budgetUsd * 100) / 100);
  let cwd = o.cwd ?? "/home/user";
  if (o.workspace) {
    cwd = workspaceCwd(o.workspace);
    const files = Object.fromEntries(Object.entries({ ...workspaceFiles(o.workspace), ...(o.jobFiles ?? {}) }).map(([path, content]) => [`${cwd}/${path}`, content]));
    if (boat.writeFiles) await boat.writeFiles(sandbox, files);
    else for (const [path, content] of Object.entries(files)) await boat.writeFile(sandbox, path, content);
  }
  const run = { prompt: o.prompt, cwd, model: config.model, budgetUsd, version: CLAUDE_CODE_VERSION };
  await boat.writeFile(sandbox, `${AGENT_DIR}/runner.mjs`, AGENT_RUNNER);
  await boat.writeFile(sandbox, `${AGENT_DIR}/config.json`, JSON.stringify(run));
  await boat.writeFile(sandbox, `${AGENT_DIR}/auth.json`, JSON.stringify(agentAuth(config, o.token, { mcp: o.mcp })));
  const started = await boat.exec(sandbox, `node ${AGENT_DIR}/runner.mjs ${AGENT_DIR} >${AGENT_DIR}/runner.log 2>&1`, { detached: true });
  if (started.processId === undefined) throw new Error("Couldn't start the agent");
  return String(started.processId);
}

export async function agentState(boat: BoatClient, sandbox: string, processId: string) {
  const state = parse<AgentState>(await boat.readFile(sandbox, `${AGENT_DIR}/state.json`));
  const running = state?.done ? false : (await boat.commandStatus(sandbox, Number(processId))).running;
  return { state, running, cost: state?.cost_usd ?? 0, ok: !running && state?.last_subtype === "success" };
}
