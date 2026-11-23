import type { ESignAdapter } from "./provider.js";
import { SIGNWELL } from "./signwell.js";

// The e-signature adapters this server has, by name (the one file that names them besides the adapters themselves).
// Which one runs, and its keys, are set from Mynt Studio by an admin (esign-settings.ts), with the environment's
// ESIGN_PROVIDER, SIGNWELL_API_KEY, SIGNWELL_WEBHOOK_ID and ESIGN_TEST_MODE as overrides.
export const ESIGN_ADAPTERS: Record<string, ESignAdapter> = { signwell: SIGNWELL };
export const ESIGN_PROVIDER_NAMES = ["signwell"] as const;

// Each adapter's environment variables (names only; values are read where they're used).
export const ESIGN_ENV: Record<string, { apiKey: string; webhookId: string }> = {
  signwell: { apiKey: "SIGNWELL_API_KEY", webhookId: "SIGNWELL_WEBHOOK_ID" },
};
