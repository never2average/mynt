// Settings → E-signature (admins): how e-signature is set up on this Mynt (core/src/esign-settings.ts), as the page
// shows it. Never a key or a webhook id: only whether each is set, by whom, when and from where. Pure, for the route,
// the view and the tests.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export type EsignStatus = {
  providers: string[];
  provider: string | null;
  configured: boolean;
  vaultReady: boolean;
  key: { set: boolean; source: "studio" | "environment" | null; setAt: string | null; setBy: string | null };
  webhook: { registered: boolean; source: "studio" | "environment" | null; registeredAt: string | null; callbackUrl: string | null; canRegister: boolean };
  testMode: { on: boolean; source: "studio" | "environment" };
  lastEventAt: string | null;
};

const source = (v: unknown) => (v === "studio" || v === "environment" ? v : null);

export function esignStatusFrom(reply: unknown): EsignStatus | null {
  if (!isObj(reply) || !isObj(reply.key) || !isObj(reply.webhook) || !isObj(reply.test_mode)) return null;
  const k = reply.key;
  const w = reply.webhook;
  const t = reply.test_mode;
  return {
    providers: Array.isArray(reply.providers) ? reply.providers.filter((p): p is string => typeof p === "string") : [],
    provider: str(reply.provider),
    configured: reply.configured === true,
    vaultReady: reply.vault_ready === true,
    key: { set: k.set === true, source: source(k.source), setAt: str(k.set_at), setBy: str(k.set_by) },
    webhook: { registered: w.registered === true, source: source(w.source), registeredAt: str(w.registered_at), callbackUrl: str(w.callback_url), canRegister: w.can_register === true },
    testMode: { on: t.on !== false, source: t.source === "environment" ? "environment" : "studio" },
    lastEventAt: str(reply.last_event_at),
  };
}

export const PROVIDER_LABELS: Record<string, string> = { signwell: "SignWell" };
export const providerLabel = (p: string | null) => (p ? (PROVIDER_LABELS[p] ?? p) : "None");
const day = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : null);

// The key's line, in words: never any part of the key.
export function keyLine(s: EsignStatus): string {
  if (!s.key.set) return "No key set";
  if (s.key.source === "environment") return "Key set in the server's environment (it takes precedence)";
  return `Key set on ${day(s.key.setAt) ?? "an earlier date"}${s.key.setBy ? ` by ${s.key.setBy}` : ""}`;
}

export function webhookLine(s: EsignStatus): string {
  if (s.webhook.source === "environment") return "Webhook id set in the server's environment";
  if (s.webhook.registered) return `Registered on ${day(s.webhook.registeredAt) ?? "an earlier date"}`;
  return s.webhook.canRegister ? "Not registered" : "Not registered: this Mynt's public address isn't https, so the service can't reach it";
}

export const TEST_MODE_WORDS = {
  on: "Test mode: documents are free and not legally binding. Use it to try the whole flow.",
  off: "Live: documents are legally binding and count towards the e-signature service's billing.",
} as const;

// What the route accepts from the page: one action at a time.
export type EsignAction =
  | { action: "set_key"; provider: string; api_key: string }
  | { action: "register_webhook" }
  | { action: "remove_key" }
  | { action: "test_mode"; test_mode: boolean };
