// A model backend per agent role. Every agent runs on the deployment's model backend (builds.ts) unless its role is
// set to another one here. The first, and for now the only, role that can be: the program red team, whose work (it
// attacks a developer's own program on a local validator) a provider must have approved its account for.
//
// What a role runs on is operational settings, read where they're used, so an admin's change applies to the next
// run: the backend, the model (free text: the provider account decides which models it has; Mynt names none), what a
// million input and output tokens cost on it (what the run's cap is metered with; Mynt guesses no price), and the
// access programme the provider approved the account for, where it has one. The backend's API key is a platform key
// (platform-keys.ts): the environment's where it sets the name, else the key vault's; used only by Mynt's agent
// proxy, never sent to a sandbox.
//
// This file names no provider. A backend kind is a wire protocol; the files beside this one hold what is a
// provider's own: where its API is, how it reports usage and refusals (openai-api.ts), and how its coding-agent CLI
// is run headless in a sandbox (codex-cli.ts).
import { platformSecret } from "../platform-keys.js";
import { operationalSetting } from "../platform-settings.js";

/** The backends a role can be moved to. "responses": a provider that serves the Responses API. */
export const SECOND_BACKENDS = ["responses"] as const;
export type SecondBackendKind = (typeof SECOND_BACKENDS)[number];
export const ROLE_BACKEND_VALUES = ["default", ...SECOND_BACKENDS] as const;

/** The platform key each backend's API key is read by. */
export const BACKEND_KEY: Record<SecondBackendKind, string> = { responses: "RESPONSES_BACKEND_API_KEY" };

/** Where a sandbox reaches each backend through Mynt's agent proxy (under the proxy's /agent). */
export const BACKEND_PROXY_PATH: Record<SecondBackendKind, string> = { responses: "/agent/r/v1" };

/** US$ per million tokens, as an admin set them. Cached input is priced as input where it isn't set: never lower. */
export interface TokenPrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cachedInputUsdPerMtok: number | null;
}

/** Token counts in the one shape the meter prices, whatever the provider calls them. `input` includes `cachedInput`. */
export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
}

export function priceTokens(price: TokenPrice, u: TokenUsage): number {
  const cached = Math.min(u.cachedInput, u.input);
  return ((u.input - cached) * price.inputUsdPerMtok + cached * (price.cachedInputUsdPerMtok ?? price.inputUsdPerMtok) + u.output * price.outputUsdPerMtok) / 1_000_000;
}

// The roles that can run on a second backend, and the settings each is configured with.
export const MODEL_ROLES = {
  "program-red-team": {
    label: "the red team",
    backend: "RED_TEAM_BACKEND",
    model: "RED_TEAM_MODEL",
    inputPrice: "RED_TEAM_INPUT_USD_PER_MTOK",
    outputPrice: "RED_TEAM_OUTPUT_USD_PER_MTOK",
    cachedInputPrice: "RED_TEAM_CACHED_INPUT_USD_PER_MTOK",
    accessProgram: "RED_TEAM_ACCESS_PROGRAM",
  },
} as const;
export type ModelRole = keyof typeof MODEL_ROLES;

/** A role's second backend as it is configured now, with what is still missing before a run could use it. */
export interface RoleBackend {
  kind: SecondBackendKind;
  model: string | null;
  price: TokenPrice | null;
  accessProgram: string | null;
  keyName: string;
  keySet: boolean;
  // What an admin still has to set, each in words that name the setting or the key. Empty: a run can start.
  missing: string[];
}

const positive = (raw: string | undefined) => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

/** The second backend `role` is set to run on; null when it runs on the deployment's own (the default). */
export function roleBackend(role: ModelRole, env: NodeJS.ProcessEnv = process.env): RoleBackend | null {
  const s = MODEL_ROLES[role];
  const kind = (operationalSetting(s.backend, env) ?? "default").trim();
  if (!(SECOND_BACKENDS as readonly string[]).includes(kind)) return null;
  const k = kind as SecondBackendKind;
  const model = (operationalSetting(s.model, env) ?? "").trim() || null;
  const input = positive(operationalSetting(s.inputPrice, env));
  const output = positive(operationalSetting(s.outputPrice, env));
  const price = input !== null && output !== null ? { inputUsdPerMtok: input, outputUsdPerMtok: output, cachedInputUsdPerMtok: positive(operationalSetting(s.cachedInputPrice, env)) } : null;
  const keyName = BACKEND_KEY[k];
  const keySet = !!platformSecret(keyName, env);
  const missing = [
    ...(keySet ? [] : [`the backend's API key isn't set (${keyName}, in Platform settings → Key vault)`]),
    ...(model ? [] : [`${s.model} isn't set (the model ${s.label} runs on; Operational settings)`]),
    ...(price ? [] : [`${[...(input === null ? [s.inputPrice] : []), ...(output === null ? [s.outputPrice] : [])].join(" and ")} ${input === null && output === null ? "aren't" : "isn't"} set (what a million tokens cost on that model: without both, the run's spend couldn't be measured)`]),
  ];
  return { kind: k, model, price, accessProgram: (operationalSetting(s.accessProgram, env) ?? "").trim() || null, keyName, keySet, missing };
}

/** Why `role` can't run on the backend it is set to, in one line; null when it can (or runs on the default). */
export function roleBackendMissing(role: ModelRole, env: NodeJS.ProcessEnv = process.env): string | null {
  const b = roleBackend(role, env);
  if (!b?.missing.length) return null;
  const s = MODEL_ROLES[role];
  return `${s.label} is set to run on a second model backend (${s.backend} is ${b.kind}), and ${b.missing.join("; ")}`;
}

/**
 * What the agent proxy needs to serve one run on a second backend: carried on the run a token resolves to, so a
 * token made for one backend works on no other.
 */
export interface RunBackend {
  kind: SecondBackendKind;
  // Null when no price is set: the proxy then forwards nothing, since it couldn't measure what the call spent.
  price: TokenPrice | null;
  accessProgram: string | null;
}

/** A provider's refusal of a request (its safeguards declined it), as Mynt records it: never retried. */
export interface ProviderRefusal {
  category: string | null;
  request_id: string | null;
}

/**
 * How an agent is run in a sandbox on a second backend: the provider's own agent CLI, driven by a runner program
 * that keeps the same record (state.json, agent.jsonl) as Mynt's other runner.
 */
export interface BackendRunner {
  version: string; // the CLI's pinned version, installed in the sandbox when the run starts
  script: string; // the runner program (written to the sandbox as runner.mjs)
  // Files to add to the agent's workspace so the CLI reads its instructions (by path relative to the workspace).
  workspaceFiles(files: Record<string, string>): Record<string, string>;
}
