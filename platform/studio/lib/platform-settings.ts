// Platform admin → Platform settings (/platform/settings): what its four tabs show, read from Mynt's answers
// (core/src/platform-keys.ts, platform-settings.ts). Pure, for the routes, the views and the tests.
//
// - Key vault: every key Mynt's own server uses, one row per key type. Never a value: Mynt never answers with one,
//   and nothing here has a field for one. A row carries where the key comes from (the vault, the server's
//   environment, or nowhere), who set it and when, and a short fingerprint.
// - Operational settings: the non-secret settings, each with its value, default, source and how it's checked.
// - E-signature and Risk grading have their own modules (lib/esign-settings.ts, lib/risk-grading.ts).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

// ---- the page's tabs (in its address: /platform/settings?tab=…) ----

export const SETTINGS_TABS = ["keys", "operational", "esign", "risk-grading"] as const;
export type SettingsTabId = (typeof SETTINGS_TABS)[number];
export const SETTINGS_TAB_LABELS: Record<SettingsTabId, string> = { keys: "Key vault", operational: "Operational settings", esign: "E-signature", "risk-grading": "Risk grading" };
export const settingsTabOf = (v: unknown): SettingsTabId => (SETTINGS_TABS as readonly string[]).includes(v as string) ? (v as SettingsTabId) : "keys";
export const settingsHref = (tab: SettingsTabId) => `/platform/settings?tab=${tab}`;

// ---- Key vault ----

export type KeySource = "vault" | "environment" | "none";
export const KEY_SOURCE_LABELS: Record<KeySource, string> = { vault: "Key vault", environment: "Server environment", none: "Not set" };
export type PlatformKey = {
  type: string;
  label: string;
  purpose: string;
  usedBy: string;
  validation: string | null;
  multiline: boolean;
  source: KeySource;
  serverOnly: boolean;
  setAt: string | null;
  setBy: string | null;
  fingerprint: string | null;
  validatedAt: string | null;
  lastUsedAt: string | null;
  needsRestart: boolean;
  timesReplaced: number;
  note: string | null;
};
export type KeyVault = { keys: PlatformKey[]; vaultReady: boolean };

const keySource = (v: unknown): KeySource => (v === "vault" || v === "environment" ? v : "none");
// A fingerprint is eight hex characters and nothing else: anything longer is never shown.
const fingerprintOf = (v: unknown) => (typeof v === "string" && /^[0-9a-f]{8}$/.test(v) ? v : null);

/** Mynt's list_platform_keys answer as the page's rows. Only the named fields are read: a value has nowhere to go. */
export function keyVaultFrom(reply: unknown): KeyVault | null {
  if (!isObj(reply) || !Array.isArray(reply.keys)) return null;
  const keys = reply.keys.filter(isObj).filter((k) => str(k.type)).map(
    (k): PlatformKey => ({
      type: String(k.type),
      label: str(k.label) ?? String(k.type),
      purpose: str(k.purpose) ?? "",
      usedBy: str(k.used_by) ?? "",
      validation: str(k.validation),
      multiline: k.multiline === true,
      source: keySource(k.source),
      serverOnly: k.server_only === true,
      setAt: str(k.set_at),
      setBy: str(k.set_by),
      fingerprint: fingerprintOf(k.fingerprint),
      validatedAt: str(k.validated_at),
      lastUsedAt: str(k.last_used_at),
      needsRestart: k.needs_restart !== false,
      timesReplaced: typeof k.times_replaced === "number" ? k.times_replaced : 0,
      note: str(k.note),
    }),
  );
  return { keys, vaultReady: reply.vault_ready !== false };
}

export const dayOf = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : null);
export const ENV_KEY_NOTE = "Set on the server; overrides the vault";
/** What a key's row may do: a server-only key and one the server's environment sets are read-only. */
export const keyActions = (k: PlatformKey): { set: "Set key" | "Replace key" | null; remove: boolean; readOnly: string | null } => {
  if (k.serverOnly) return { set: null, remove: false, readOnly: k.note ?? "Set on the server only" };
  if (k.source === "environment") return { set: null, remove: false, readOnly: ENV_KEY_NOTE };
  return { set: k.source === "vault" ? "Replace key" : "Set key", remove: k.source === "vault", readOnly: null };
};
export const takesEffectWords = (k: PlatformKey) => (k.serverOnly ? "After a restart (set on the server)" : k.needsRestart ? "After a restart" : "At once");
export const setOnWords = (k: PlatformKey) => (k.source === "vault" ? (dayOf(k.setAt) ?? "An earlier date") : k.source === "environment" ? "On the server" : "Never");
export const setByWords = (k: PlatformKey) => (k.source === "vault" ? (k.setBy ?? "Not recorded") : k.source === "environment" ? "Whoever runs the server" : "Nobody");

export const KEY_CSV_HEAD = ["Key", "Type", "Used by", "Source", "Set on", "Set by", "Fingerprint", "Takes effect"];
/** A row of the export: what the table shows. There is no value to export. */
export const keyCsvRow = (k: PlatformKey) => [k.label, k.type, k.usedBy, KEY_SOURCE_LABELS[k.source], setOnWords(k), setByWords(k), k.fingerprint ?? "", takesEffectWords(k)];

// ---- Operational settings ----

export type SettingSource = "environment" | "stored" | "default";
export const SETTING_SOURCE_LABELS: Record<SettingSource, string> = { environment: "Server environment", stored: "Set in Mynt", default: "Mynt's default" };
export type PlatformSetting = {
  key: string;
  value: string;
  default: string;
  source: SettingSource;
  description: string;
  usedBy: string;
  validation: string | null;
  options: string[] | null;
  setAt: string | null;
  setBy: string | null;
  needsRestart: boolean;
};
export function settingsFrom(reply: unknown): PlatformSetting[] | null {
  if (!isObj(reply) || !Array.isArray(reply.settings)) return null;
  return reply.settings.filter(isObj).map((s) => ({
    key: String(s.key ?? ""),
    value: String(s.value ?? ""),
    default: String(s.default ?? ""),
    source: s.source === "environment" ? "environment" : s.source === "stored" ? "stored" : "default",
    description: String(s.description ?? ""),
    usedBy: str(s.used_by) ?? "",
    validation: str(s.validation),
    options: Array.isArray(s.options) ? s.options.filter((o): o is string => typeof o === "string") : null,
    setAt: str(s.set_at),
    setBy: str(s.set_by),
    needsRestart: s.needs_restart === true,
  }));
}
export const ENV_SETTING_NOTE = "Set on the server; overrides what's set in Mynt";
export const settingSourceWords = (s: PlatformSetting) =>
  s.source === "stored" ? `${SETTING_SOURCE_LABELS.stored}${s.setBy ? ` by ${s.setBy}` : ""}${dayOf(s.setAt) ? ` on ${dayOf(s.setAt)}` : ""}` : SETTING_SOURCE_LABELS[s.source];
export const SETTING_CSV_HEAD = ["Setting", "Value", "Default", "Source", "Description", "Used by", "How it's checked"];
export const settingCsvRow = (s: PlatformSetting) => [s.key, s.value, s.default, SETTING_SOURCE_LABELS[s.source], s.description, s.usedBy, s.validation ?? ""];
