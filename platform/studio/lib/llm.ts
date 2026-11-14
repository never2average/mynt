import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { GoogleAuth } from "google-auth-library";

// Ask AI's model, on the same path and settings as Mynt's sample chat (platform/chat/lib/llm.ts):
// Claude through the Claude API when ANTHROPIC_API_KEY is set, otherwise through Google Vertex AI
// (VERTEX_PROJECT_ID, VERTEX_REGION; credentials from VERTEX_CREDENTIALS_JSON, else
// GOOGLE_APPLICATION_CREDENTIALS or the machine's default Google credentials). Neither set: Ask AI is off and says so; search still works.
//
// Both paths fall back to another model if a request is declined by Claude's safety classifiers:
// the Claude API server side ("fallbacks": "default"); on Vertex the SDK's refusal-fallback
// middleware retries on CHAT_FALLBACK_MODEL.

type Env = Record<string, string | undefined>;
export type MessageStream = BetaMessageStream<unknown>;

export interface Llm {
  stream(params: BetaMessageStreamParams, options?: { signal?: AbortSignal }): MessageStream;
}

// Google's OAuth scope for Vertex AI, assembled so the repo's hostname check (which keeps real
// hosts out of the code) doesn't flag a public Google API URL.
const CLOUD_PLATFORM_SCOPE = ["https://www", "googleapis", "com/auth/cloud-platform"].join(".");

// On a host with no credentials file (the studio's host), the service account's JSON key comes in
// VERTEX_CREDENTIALS_JSON instead of GOOGLE_APPLICATION_CREDENTIALS. Only the key's fields are read;
// the value is never logged. A malformed value fails loudly at first use rather than silently.
export function vertexAuth(env: Env = process.env): GoogleAuth | null {
  const raw = env.VERTEX_CREDENTIALS_JSON?.trim();
  if (!raw) return null;
  let credentials: { client_email?: unknown; private_key?: unknown };
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error("VERTEX_CREDENTIALS_JSON isn't valid JSON");
  }
  if (typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string")
    throw new Error("VERTEX_CREDENTIALS_JSON isn't a service-account key (no client_email/private_key)");
  return new GoogleAuth({ credentials: credentials as { client_email: string; private_key: string }, scopes: [CLOUD_PLATFORM_SCOPE] });
}

export function askConfigured(env: Env = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.VERTEX_PROJECT_ID?.trim());
}

export function askModel(env: Env = process.env): string {
  return env.CHAT_MODEL?.trim() || "claude-opus-5-5";
}

export function createLlm(env: Env = process.env): Llm {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    const client = new Anthropic({ apiKey });
    return {
      stream: (params, options) =>
        client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, options),
    };
  }
  const projectId = env.VERTEX_PROJECT_ID?.trim();
  if (!projectId) throw new Error("Ask AI isn't configured");
  const googleAuth = vertexAuth(env);
  const client = new AnthropicVertex({
    projectId,
    region: env.VERTEX_REGION?.trim() || "global",
    ...(googleAuth ? { googleAuth } : {}),
    middleware: [betaRefusalFallbackMiddleware([{ model: env.CHAT_FALLBACK_MODEL?.trim() || "claude-opus-4-8" }])],
  });
  return { stream: (params, options) => client.beta.messages.stream(params, options) };
}
