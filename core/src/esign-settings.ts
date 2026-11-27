import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ESIGN_ADAPTERS, ESIGN_ENV, ESIGN_PROVIDER_NAMES } from "./esign/adapters.js";
import { ESignError, testModeFromEnv, type ESign } from "./esign/provider.js";
import type { Store, User } from "./store.js";
import { PlatformKeyVault } from "./platform-keys.js";

// E-signature set up from Mynt itself (Mynt Studio's Settings → E-signature, admins only), so nobody edits the
// server's environment: an admin pastes the service's API key once; Mynt checks it with the service, keeps it in the
// platform key vault (platform-keys.ts: one row per key, sealed by the confidential host, never returned or logged),
// registers the webhook that sends it the service's events (reusing one already pointing at Mynt) and keeps that
// webhook's id the same way (it's the key the service signs its events with). Both are rows of the vault, so the
// vault's own Set key and Remove key work on them too. Test mode and the provider are plain settings. The
// environment still wins where it's set: ESIGN_PROVIDER, SIGNWELL_API_KEY, SIGNWELL_WEBHOOK_ID and ESIGN_TEST_MODE
// override what's stored, so a deployment that set them keeps working.
//
// The live configuration (`current`) is rebuilt whenever an admin changes it, so the next call uses it.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const SETTING = "esign";
export const ESIGN_WEBHOOK_PATH = "/esign/webhook";

type Stored = { provider?: string; test_mode?: boolean; webhook_url?: string | null; webhook_registered_at?: string | null; webhook_reused?: boolean };
type Source = "studio" | "environment" | null;

// What the agreement tools and the webhook need: the configuration as it is now.
export type EsignSource = ESign | { readonly current: ESign | null } | null | undefined;
export const currentEsign = (s: EsignSource): ESign | null => (!s ? null : "provider" in s ? s : s.current);

export interface EsignSettingsOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch; // tests only: a fake of the service
  publicUrl?: string | null; // defaults to PUBLIC_URL
  keys?: PlatformKeyVault; // the platform key vault the keys live in; one over the same environment when not given
}

export class EsignSettings {
  current: ESign | null = null;
  private constructor(
    private readonly store: Store,
    private readonly opts: EsignSettingsOptions,
    readonly keys: PlatformKeyVault,
  ) {}

  static async open(store: Store, opts: EsignSettingsOptions = {}): Promise<EsignSettings> {
    const s = new EsignSettings(store, opts, opts.keys ?? (await PlatformKeyVault.open(store, { env: opts.env })));
    // A key set or removed in the vault itself (set_platform_key) is in use from the next call.
    s.keys.onChange((type) => (Object.values(ESIGN_ENV).some((n) => n.apiKey === type || n.webhookId === type) ? s.reload().catch(() => undefined) : undefined));
    await s.reload().catch((e) => console.error("esign settings: not loaded:", e instanceof ESignError ? e.code : (e as Error).name));
    return s;
  }

  private get env() {
    return this.opts.env ?? process.env;
  }

  private async stored(): Promise<Stored> {
    return (await this.store.getSetting<Stored>(SETTING)) ?? {};
  }

  private async putStored(next: Stored, userId: string) {
    await this.store.db.query(
      `INSERT INTO ${T}.settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [SETTING, JSON.stringify(next), userId],
    );
  }

  // The provider: the environment's, else the stored one, else the one a stored key belongs to.
  private async providerName(stored: Stored): Promise<{ name: string | null; source: Source }> {
    const fromEnv = (this.env.ESIGN_PROVIDER ?? "").trim().toLowerCase();
    if (fromEnv) return { name: fromEnv, source: "environment" };
    if (stored.provider) return { name: stored.provider, source: "studio" };
    return { name: null, source: null };
  }

  private callbackUrl(): string | null {
    const base = (this.opts.publicUrl ?? this.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    return base.startsWith("https://") ? `${base}${ESIGN_WEBHOOK_PATH}` : null;
  }

  async reload(): Promise<void> {
    const stored = await this.stored();
    const { name } = await this.providerName(stored);
    const adapter = name ? ESIGN_ADAPTERS[name] : undefined;
    if (!adapter) {
      if (name) console.error(`e-signature: no adapter called "${name}"; e-signature stays off`);
      this.current = null;
      return;
    }
    const envNames = ESIGN_ENV[adapter.name];
    const apiKey = this.env[envNames.apiKey]?.trim() || (await this.keys.stored(envNames.apiKey)) || null;
    const webhookId = this.env[envNames.webhookId]?.trim() || (await this.keys.stored(envNames.webhookId)) || null;
    const testMode = (this.env.ESIGN_TEST_MODE ?? "").trim() ? testModeFromEnv(this.env) : stored.test_mode !== false;
    this.current = apiKey ? { provider: adapter.provider({ apiKey, webhookId, fetch: this.opts.fetch }), testMode } : null;
  }

  // What the Settings page shows: never a key or a webhook id, only whether each is set, by whom, when and from where.
  async status() {
    const stored = await this.stored();
    const { name, source: providerSource } = await this.providerName(stored);
    const env = name ? ESIGN_ENV[name] : undefined;
    const keyRow = env ? await this.keys.row(env.apiKey) : null;
    const hookRow = env ? await this.keys.row(env.webhookId) : null;
    const keyFromEnv = Boolean(env && this.env[env.apiKey]?.trim());
    const hookFromEnv = Boolean(env && this.env[env.webhookId]?.trim());
    const testFromEnv = Boolean((this.env.ESIGN_TEST_MODE ?? "").trim());
    const last = (await this.store.db.query(`SELECT max(received_at) AS at FROM ${T}.esign_webhook_events`)).rows[0]?.at;
    return {
      providers: [...ESIGN_PROVIDER_NAMES],
      provider: name,
      provider_source: providerSource,
      configured: this.current !== null,
      vault_ready: await this.keys.ready(),
      key: keyFromEnv
        ? { set: true, source: "environment" as const, set_at: null, set_by: null }
        : keyRow
          ? { set: true, source: "studio" as const, set_at: keyRow.set_at, set_by: keyRow.set_by }
          : { set: false, source: null, set_at: null, set_by: null },
      webhook: {
        registered: hookFromEnv || Boolean(hookRow),
        source: hookFromEnv ? ("environment" as const) : hookRow ? ("studio" as const) : null,
        registered_at: hookRow ? hookRow.set_at : null,
        reused_existing: hookRow ? stored.webhook_reused === true : null,
        callback_url: this.callbackUrl(),
        can_register: this.callbackUrl() !== null,
      },
      test_mode: { on: this.current?.testMode ?? (testFromEnv ? testModeFromEnv(this.env) : stored.test_mode !== false), source: testFromEnv ? ("environment" as const) : ("studio" as const) },
      last_event_at: last ? new Date(last as string).toISOString() : null,
      signing_origins: this.current ? [...this.current.provider.signingOrigins] : [],
    };
  }

  // Checks the key with the service, seals it, and registers the webhook. Refused keys aren't stored.
  async setKey(user: User, provider: string, apiKey: string): Promise<{ ok: true; webhook: { registered: boolean; reused?: boolean; reason?: string } } | { ok: false; error: string }> {
    const adapter = ESIGN_ADAPTERS[provider];
    if (!adapter) return { ok: false, error: `No e-signature adapter called '${provider}'` };
    if (!(await this.keys.ready())) return { ok: false, error: "This server's vault key (MYNT_VAULT_KEY) isn't configured, so it can't keep the key" };
    try {
      await adapter.setup({ apiKey, fetch: this.opts.fetch }).validateKey();
    } catch (e) {
      const code = e instanceof ESignError ? e.code : "unexpected";
      await this.store.audit(user.id, "set_esign_api_key_refused", "esign", { provider, reason: code });
      return { ok: false, error: code === "not_authorised" ? "The e-signature service refused that key: check it and paste it again" : `Couldn't check the key with the e-signature service (${code}); try again shortly` };
    }
    const kept = await this.keys.set(user, ESIGN_ENV[adapter.name].apiKey, apiKey, { validated: true });
    if (!kept.ok) return kept;
    const stored = await this.stored();
    await this.putStored({ ...stored, provider }, user.id);
    await this.store.audit(user.id, "set_esign_api_key", "esign", { provider });
    // The server's environment sets the key in effect: the one just pasted is only kept for later, so it registers
    // nothing at the service (a webhook registered with it would belong to an account Mynt isn't using, and its id
    // would replace the one in use).
    const webhook = this.env[ESIGN_ENV[adapter.name].apiKey]?.trim()
      ? { registered: false, reason: "The server's environment sets the e-signature API key, which overrides the one kept here: no webhook was registered with the key you pasted. It's registered when that key comes into use (remove the environment's, then Re-register webhook)" }
      : await this.registerWebhook(user, apiKey);
    await this.reload();
    return { ok: true, webhook };
  }

  // Registers (or finds) the service's webhook to Mynt and seals its id.
  async registerWebhook(user: User, keyGiven?: string): Promise<{ registered: boolean; reused?: boolean; reason?: string }> {
    const stored = await this.stored();
    const name = (await this.providerName(stored)).name;
    const adapter = name ? ESIGN_ADAPTERS[name] : undefined;
    if (!adapter) return { registered: false, reason: "E-signature isn't configured on this deployment yet" };
    const apiKey = keyGiven ?? (this.env[ESIGN_ENV[adapter.name].apiKey]?.trim() || (await this.keys.stored(ESIGN_ENV[adapter.name].apiKey)));
    if (!apiKey) return { registered: false, reason: "Set the e-signature service's API key first" };
    const url = this.callbackUrl();
    if (!url) return { registered: false, reason: "This server's public address (PUBLIC_URL) isn't an https address, so the service can't reach its webhook" };
    try {
      const hook = await adapter.setup({ apiKey, fetch: this.opts.fetch }).registerWebhook(url);
      const kept = await this.keys.set(user, ESIGN_ENV[adapter.name].webhookId, hook.id, { validated: true });
      if (!kept.ok) return { registered: false, reason: kept.error };
      await this.putStored({ ...(await this.stored()), webhook_url: url, webhook_registered_at: new Date().toISOString(), webhook_reused: hook.reused }, user.id);
      await this.store.audit(user.id, "register_esign_webhook", "esign", { provider: adapter.name, callback_url: url, reused: hook.reused });
      await this.reload();
      return { registered: true, reused: hook.reused };
    } catch (e) {
      const code = e instanceof ESignError ? e.code : "unexpected";
      await this.store.audit(user.id, "register_esign_webhook_refused", "esign", { provider: adapter.name, callback_url: url, reason: code });
      return { registered: false, reason: `The e-signature service didn't register the webhook (${code}); try Re-register webhook shortly` };
    }
  }

  // Removes the stored key and webhook id, deleting the webhook at the service first (best effort).
  async removeKey(user: User): Promise<{ removed: boolean; webhook_deleted: boolean; still_configured_by_environment: boolean }> {
    const stored = await this.stored();
    const name = (await this.providerName(stored)).name;
    const adapter = name ? ESIGN_ADAPTERS[name] : undefined;
    let webhookDeleted = false;
    let removed = false;
    if (adapter) {
      const names = ESIGN_ENV[adapter.name];
      const key = await this.keys.stored(names.apiKey);
      const hook = await this.keys.stored(names.webhookId);
      if (key && hook) {
        try {
          await adapter.setup({ apiKey: key, fetch: this.opts.fetch }).deleteWebhook(hook);
          webhookDeleted = true;
        } catch {
          // the stored id goes either way; a hook left at the service can't reach a Mynt without its id
        }
      }
      // Both rows are retired and their values destroyed (platform-keys.ts).
      const gone = [await this.keys.remove(user, names.apiKey), await this.keys.remove(user, names.webhookId)];
      removed = gone.some((g) => g.removed);
      await this.putStored({ ...stored, webhook_url: null, webhook_registered_at: null, webhook_reused: false }, user.id);
      await this.store.audit(user.id, "remove_esign_api_key", "esign", { provider: adapter.name, webhook_deleted: webhookDeleted });
    }
    await this.reload();
    return { removed, webhook_deleted: webhookDeleted, still_configured_by_environment: this.current !== null };
  }

  async setTestMode(user: User, on: boolean) {
    await this.putStored({ ...(await this.stored()), test_mode: on }, user.id);
    await this.store.audit(user.id, "set_esign_test_mode", "esign", { test_mode: on });
    await this.reload();
  }
}

// Admins only: e-signature set up from Mynt Studio (Settings → E-signature). Keys go in once and never come back.
export function registerEsignAdminTools(server: McpServer, store: Store, user: User, settings: EsignSettings) {
  server.registerTool(
    "get_esign_settings",
    {
      title: "E-signature settings",
      description:
        "Admin: how e-signature is set up here: the provider, whether its API key is set (by whom and when, or by the server's environment), whether its webhook is registered and where it points, test mode, and when Mynt last received an event. Never the key or the webhook's id.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await settings.status()),
  );

  server.registerTool(
    "set_esign_api_key",
    {
      title: "Set the e-signature API key",
      description:
        "Admin: set the e-signature service's API key. Mynt checks it with the service, keeps it sealed in the platform key vault (never shown again; set_platform_key does the same), then registers the service's webhook to this server (reusing one already pointing here). The server's environment, where it sets a key, still takes precedence: the pasted key is then only kept for later, and no webhook is registered with it. Audited without the key.",
      inputSchema: { provider: z.enum(ESIGN_PROVIDER_NAMES), api_key: z.string().trim().min(8).max(500).regex(/^[\x21-\x7e]+$/, "The key as the service shows it, without spaces") },
    },
    async ({ provider, api_key }) => {
      const r = await settings.setKey(user, provider, api_key);
      if (!r.ok) return fail(r.error);
      return json({ ok: true, webhook: r.webhook, settings: await settings.status() });
    },
  );

  server.registerTool(
    "register_esign_webhook",
    {
      title: "Re-register the e-signature webhook",
      description: "Admin: register the e-signature service's webhook to this server again (reusing one already pointing here), with the stored key. Audited.",
      inputSchema: {},
    },
    async () => {
      const r = await settings.registerWebhook(user);
      if (!r.registered) return fail(r.reason ?? "The webhook wasn't registered");
      return json({ ok: true, reused: r.reused ?? false, settings: await settings.status() });
    },
  );

  server.registerTool(
    "remove_esign_api_key",
    {
      title: "Remove the e-signature API key",
      description:
        "Admin: delete the stored e-signature API key and webhook id, deleting the webhook at the service first. E-signature then stays off (and program agreements are signed by hand) unless the server's environment sets a key. Audited.",
      inputSchema: { confirm: z.literal(true) },
    },
    async () => json({ ...(await settings.removeKey(user)), settings: await settings.status() }),
  );

  server.registerTool(
    "set_esign_test_mode",
    {
      title: "E-signature test mode",
      description:
        "Admin: turn the e-signature service's test mode on or off. On (the default): documents are free and not legally binding, for trying the flow. Off: documents are legally binding and count towards the service's billing. Documents already made keep the mode they were made in. ESIGN_TEST_MODE in the server's environment, where set, takes precedence. Audited.",
      inputSchema: { test_mode: z.boolean() },
    },
    async ({ test_mode }) => {
      await settings.setTestMode(user, test_mode);
      return json({ ok: true, settings: await settings.status() });
    },
  );
}
