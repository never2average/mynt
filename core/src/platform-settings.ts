import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store, User } from "./store.js";

// Mynt's operational settings: what this server runs with that isn't a secret (prices, budgets, the build audit).
// Admins change them from Mynt (Mynt Studio's Platform settings → Operational settings); each is one row of the
// `settings` table (key `ops:<NAME>`), checked against its type before it's kept, and audited old → new.
//
// Precedence, the same for every setting: the server's environment where it sets the name, else what an admin stored,
// else Mynt's default. So a deployment that sets them on the server keeps running exactly as it did, and those rows
// are read-only in Mynt until the server stops setting them.
//
// Every setting here is read where it's used (operationalSetting below), so a change applies to the next build,
// audit, exploration or usage sample without a restart. A setting whose consumer can't do that doesn't belong here.

type Check =
  | { type: "number"; min: number; max: number; integer?: boolean }
  | { type: "enum"; values: readonly string[] }
  | { type: "text"; pattern: RegExp; words: string; max: number }
  | { type: "list"; item: RegExp; words: string; max: number };
export interface PlatformSettingSpec {
  key: string;
  default: string; // "" where Mynt has none: the setting is not set until an admin (or the environment) sets it
  kind: "usd" | "usd_per_hour" | "usd_per_mtok" | "minutes" | "count" | "text" | "list";
  description: string;
  used_by: string;
  check: Check;
}

const usd = (min: number, max: number): Check => ({ type: "number", min, max });
// What a million tokens cost on a model: never 0 (a price of nothing would meter nothing).
const perMtok: Check = { type: "number", min: 0.0001, max: 10_000 };
const RED_TEAM = "The mainnet program gate's red team";
// The first nine are the settings the server has always listed; the rest are the other agents' budgets and limits.
export const PLATFORM_SETTINGS: readonly PlatformSettingSpec[] = [
  { key: "BUILD_CAP_USD", default: "10", kind: "usd", description: "Spend cap for one coding-agent build", used_by: "Coding-agent builds", check: usd(0.5, 500) },
  { key: "BUILD_MONTHLY_CAP_USD", default: "100", kind: "usd", description: "Each developer's build budget per calendar month", used_by: "Coding-agent builds", check: usd(1, 50_000) },
  { key: "BUILD_AUDIT", default: "none", kind: "text", description: "The security audit run on each build: maxwell, or none", used_by: "Build verification", check: { type: "enum", values: ["none", "maxwell"] } },
  {
    key: "BUILD_AUDIT_MODEL",
    default: "claude-sonnet-5-5",
    kind: "text",
    description: "The model the build audit runs on",
    used_by: "Build verification",
    check: { type: "text", pattern: /^[a-z0-9][a-z0-9.@:_-]{2,79}$/, words: "a model id: lower-case letters, digits, dots and dashes", max: 80 },
  },
  { key: "BUILD_AUDIT_CAP_USD", default: "5", kind: "usd", description: "Spend cap for one build audit", used_by: "Build verification", check: usd(0.5, 200) },
  { key: "BUILD_AUDIT_MINUTES", default: "20", kind: "minutes", description: "Time limit for one build audit", used_by: "Build verification", check: { type: "number", min: 1, max: 240, integer: true } },
  {
    key: "BUILD_AUDIT_WORKFLOWS",
    default: "probe-cicd-env",
    kind: "list",
    description: "The audit's workflows, in order",
    used_by: "Build verification",
    check: { type: "list", item: /^[a-z0-9][a-z0-9-]{1,48}$/, words: "workflow names separated by commas (lower-case letters, digits and dashes)", max: 12 },
  },
  { key: "EXPLORE_CAP_USD", default: "20", kind: "usd", description: "Spend cap for one algorithm exploration", used_by: "Algorithm explorations", check: usd(0.5, 500) },
  { key: "FREESTYLE_USD_PER_HOUR", default: "0.2", kind: "usd_per_hour", description: "What one hosted VM hour is priced at for spend caps and P&L", used_by: "Hosting and agent sandboxes", check: usd(0, 50) },
  { key: "EXPLORE_MAX_ITERATIONS", default: "25", kind: "count", description: "The most experiments one exploration may run", used_by: "Algorithm explorations", check: { type: "number", min: 1, max: 500, integer: true } },
  { key: "EXPLORE_MAX_MINUTES", default: "60", kind: "minutes", description: "Time limit for one algorithm exploration", used_by: "Algorithm explorations", check: { type: "number", min: 5, max: 720, integer: true } },
  { key: "DESK_JOB_CAP_USD", default: "5", kind: "usd", description: "Spend cap for one product-desk job", used_by: "The product desk", check: usd(0.5, 200) },
  { key: "DESK_MONTHLY_CAP_USD", default: "50", kind: "usd", description: "Each firm's product-desk budget per calendar month", used_by: "The product desk", check: usd(1, 50_000) },
  { key: "REVIEW_CASE_CAP_USD", default: "3", kind: "usd", description: "Spend cap for one governance review case", used_by: "The governance desk", check: usd(0.5, 200) },
  { key: "REVIEW_MONTHLY_CAP_USD", default: "60", kind: "usd", description: "The governance desk's budget per calendar month", used_by: "The governance desk", check: usd(1, 50_000) },
  { key: "BENCHMARK_CAP_USD", default: "25", kind: "usd", description: "The most one agent benchmark run may spend; each run is started with its own cap, never above this", used_by: "Agent benchmarks", check: usd(1, 2_000) },
  // The red team's model backend (model-backends/): the values are that module's ROLE_BACKEND_VALUES.
  {
    key: "RED_TEAM_BACKEND",
    default: "default",
    kind: "text",
    description: "The model backend the red team runs on: default (the one every agent uses), or responses (a second provider's Responses API, with its own key in the key vault)",
    used_by: RED_TEAM,
    check: { type: "enum", values: ["default", "responses"] },
  },
  {
    key: "RED_TEAM_MODEL",
    default: "",
    kind: "text",
    description: "The model the red team runs on when its backend isn't the default: the id the provider account uses for it. Mynt names none",
    used_by: RED_TEAM,
    check: { type: "text", pattern: /^[A-Za-z0-9][A-Za-z0-9.@:_-]{2,79}$/, words: "a model id: letters, digits, dots and dashes", max: 80 },
  },
  { key: "RED_TEAM_INPUT_USD_PER_MTOK", default: "", kind: "usd_per_mtok", description: "What a million input tokens cost on RED_TEAM_MODEL: what the red team's cap is metered with. Not set: no run starts on that backend", used_by: RED_TEAM, check: perMtok },
  { key: "RED_TEAM_OUTPUT_USD_PER_MTOK", default: "", kind: "usd_per_mtok", description: "What a million output tokens cost on RED_TEAM_MODEL. Not set: no run starts on that backend", used_by: RED_TEAM, check: perMtok },
  { key: "RED_TEAM_CACHED_INPUT_USD_PER_MTOK", default: "", kind: "usd_per_mtok", description: "What a million cached input tokens cost on RED_TEAM_MODEL. Not set: they are metered at the input price, never lower", used_by: RED_TEAM, check: perMtok },
  {
    key: "RED_TEAM_ACCESS_PROGRAM",
    default: "",
    kind: "text",
    description: "The access programme the provider approved this account's security work under, named on every red-team request to the second backend. Not set: none is named",
    used_by: RED_TEAM,
    check: { type: "text", pattern: /^[a-z][a-z0-9_]{1,39}$/, words: "a programme's name as the provider writes it: lower-case letters, digits and underscores", max: 40 },
  },
];
const SPEC = new Map(PLATFORM_SETTINGS.map((s) => [s.key, s]));
export const PLATFORM_SETTING_KEYS = PLATFORM_SETTINGS.map((s) => s.key) as [string, ...string[]];
const ROW = (key: string) => `ops:${key}`;
const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

// The check, in words, for the page and the tool's answer.
export function validationWords(s: PlatformSettingSpec): string {
  const c = s.check;
  if (c.type === "number") return `${c.integer ? "A whole number" : "A number"} from ${c.min} to ${c.max}`;
  if (c.type === "enum") return `One of: ${c.values.join(", ")}`;
  if (c.type === "text") return capital(c.words);
  return `${capital(c.words)}; at most ${c.max}`;
}

// The value as it's kept, or why it isn't one.
export function checkSetting(key: string, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const s = SPEC.get(key);
  if (!s) return { ok: false, error: `${key} isn't an operational setting` };
  const v = raw.trim();
  const no = { ok: false as const, error: `${key} takes ${validationWords(s).replace(/^./, (ch) => ch.toLowerCase())}` };
  const c = s.check;
  if (c.type === "number") {
    if (!/^\d+(\.\d+)?$/.test(v)) return no;
    const n = Number(v);
    return Number.isFinite(n) && n >= c.min && n <= c.max && (!c.integer || Number.isInteger(n)) ? { ok: true, value: String(n) } : no;
  }
  if (c.type === "enum") return c.values.includes(v) ? { ok: true, value: v } : no;
  if (c.type === "text") return v.length <= c.max && c.pattern.test(v) ? { ok: true, value: v } : no;
  const items = v
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length >= 1 && items.length <= c.max && items.every((x) => c.item.test(x)) ? { ok: true, value: items.join(",") } : no;
}

// What admins stored, as this process last read it. One map for the process: the settings are the server's, and their
// consumers (the config objects built from the environment) read through operationalSetting.
let stored = new Map<string, string>();

/** A setting's raw value in effect: the environment's where it sets one, else what an admin stored, else undefined (the consumer's default). */
export function operationalSetting(key: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env[key];
  if (raw !== undefined && raw.trim() !== "") return raw;
  return stored.get(key) ?? raw;
}

export type SettingSource = "environment" | "stored" | "default";
const SOURCE_WORDS: Record<SettingSource, string> = { environment: "Server environment", stored: "Set in Mynt", default: "Mynt's default" };

export class OperationalSettings {
  private meta = new Map<string, { at: string; by: string | null }>();
  private constructor(
    private readonly store: Store,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  /** Reads what admins stored and makes it what operationalSetting answers with. */
  static async open(store: Store, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<OperationalSettings> {
    const s = new OperationalSettings(store, opts.env ?? process.env);
    await s.reload();
    return s;
  }

  async reload(): Promise<void> {
    const { rows } = await this.store.db.query(
      `SELECT s.key, s.value, s.updated_at, u.name FROM financial_products.settings s LEFT JOIN financial_products.users u ON u.id = s.updated_by WHERE s.key LIKE 'ops:%'`,
    );
    const next = new Map<string, string>();
    const meta = new Map<string, { at: string; by: string | null }>();
    for (const r of rows) {
      const key = String(r.key).slice(4);
      // A stored value that no longer passes its check (a range tightened since) is ignored, never half-applied.
      const checked = typeof r.value === "string" ? checkSetting(key, r.value) : null;
      if (!checked?.ok) continue;
      next.set(key, checked.value);
      meta.set(key, { at: new Date(r.updated_at as string).toISOString(), by: (r.name as string | null) ?? null });
    }
    stored = next;
    this.meta = meta;
  }

  list() {
    return PLATFORM_SETTINGS.map((s) => {
      const raw = this.env[s.key];
      const fromEnv = typeof raw === "string" && raw.trim() !== "";
      const kept = stored.get(s.key);
      const source: SettingSource = fromEnv ? "environment" : kept !== undefined ? "stored" : "default";
      const inEffect = fromEnv ? raw!.trim().slice(0, 200) : (kept ?? s.default);
      // BUILD_AUDIT takes only maxwell; anything else runs none (builds.ts).
      const value = s.key === "BUILD_AUDIT" ? (inEffect === "maxwell" ? "maxwell" : "none") : inEffect;
      const meta = this.meta.get(s.key);
      return {
        key: s.key,
        value,
        default: s.default,
        source,
        source_label: SOURCE_WORDS[source],
        kind: s.kind,
        description: s.description,
        used_by: s.used_by,
        validation: validationWords(s),
        options: s.check.type === "enum" ? [...s.check.values] : null,
        // The environment wins: a row it sets can't be changed from Mynt until the server stops setting it.
        overridden_by_environment: fromEnv,
        stored_value: kept ?? null,
        set_at: kept !== undefined ? (meta?.at ?? null) : null,
        set_by: kept !== undefined ? (meta?.by ?? null) : null,
        needs_restart: false,
      };
    });
  }

  /** Stores a value (null: back to Mynt's default), audited old → new. */
  async set(user: User, key: string, raw: string | null): Promise<{ ok: true; from: string; to: string; in_effect: boolean } | { ok: false; error: string }> {
    const spec = SPEC.get(key);
    if (!spec) return { ok: false, error: `${key} isn't an operational setting` };
    const before = this.list().find((s) => s.key === key)!;
    let to: string;
    if (raw === null) {
      await this.store.db.query(`DELETE FROM financial_products.settings WHERE key = $1`, [ROW(key)]);
      to = spec.default;
    } else {
      const checked = checkSetting(key, raw);
      if (!checked.ok) return checked;
      await this.store.setSetting(ROW(key), checked.value, user.id);
      to = checked.value;
    }
    await this.reload();
    const inEffect = !before.overridden_by_environment;
    const from = before.stored_value ?? before.default;
    await this.store.audit(user.id, "set_platform_setting", key, { key, from, to, reset_to_default: raw === null, in_effect: inEffect, ...(inEffect ? {} : { overridden_by: "environment" }) });
    return { ok: true, from, to, in_effect: inEffect };
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// One per store, for servers made without one (tests, the stdio command before its services open).
const OPENED = new WeakMap<Store, Promise<OperationalSettings>>();
export const operationalSettingsFor = (store: Store): Promise<OperationalSettings> => {
  let s = OPENED.get(store);
  if (!s) OPENED.set(store, (s = OperationalSettings.open(store)));
  return s;
};

/** Admins only: the operational settings, read and changed. */
export function registerPlatformSettingTools(server: McpServer, store: Store, user: User, given?: OperationalSettings | null) {
  const settings = async () => given ?? (await operationalSettingsFor(store));
  server.registerTool(
    "get_platform_settings",
    {
      title: "Operational settings",
      description:
        "Admin: the operational settings this server runs with that aren't secrets (build, audit, desk, review, exploration and benchmark budgets and limits, the build audit, the hosted VM hour's price, and the model backend the mainnet gate's red team runs on with its model and token prices): each one's value in effect, its default, where the value comes from (the server's environment, which wins; what an admin set in Mynt; or Mynt's default), how a new value is checked, and what it's for. Change one with set_platform_setting.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json({ settings: (await settings()).list(), precedence: "The server's environment, where it sets a setting, overrides what's set in Mynt; what's set in Mynt overrides Mynt's default." }),
  );

  server.registerTool(
    "set_platform_setting",
    {
      title: "Change an operational setting",
      description:
        "Admin: change one operational setting (get_platform_settings lists them and how each is checked). The value is checked against the setting's type and range first. It applies from the next use, without a restart. Where the server's environment sets the same setting, the environment keeps winning and the answer says so. value null puts the setting back to Mynt's default. Audited, old value to new.",
      inputSchema: z.object({ key: z.enum(PLATFORM_SETTING_KEYS), value: z.string().trim().min(1).max(600).nullable().describe("The new value, as text; null for Mynt's default") }).strict(),
    },
    async ({ key, value }) => {
      const s = await settings();
      const r = await s.set(user, key, value);
      if (!r.ok) return fail(r.error);
      const row = s.list().find((x) => x.key === key)!;
      return json({
        ok: true,
        key,
        from: r.from,
        to: r.to,
        in_effect: r.in_effect,
        message: r.in_effect ? `${key} is now ${row.value}. It applies from the next use.` : `${key} is stored as ${r.to}, but the server's environment sets it to ${row.value}, which wins until it's removed there.`,
        setting: row,
      });
    },
  );
}
