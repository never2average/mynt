import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";

// Ask AI's model, on the same path and settings as Mynt's sample chat (platform/chat/lib/llm.ts):
// Claude through the Claude API when ANTHROPIC_API_KEY is set, otherwise through Google Vertex AI
// (VERTEX_PROJECT_ID, VERTEX_REGION; credentials from GOOGLE_APPLICATION_CREDENTIALS or the
// machine's default Google credentials). Neither set: Ask AI is off and says so; search still works.
//
// Both paths fall back to another model if a request is declined by Claude's safety classifiers:
// the Claude API server side ("fallbacks": "default"); on Vertex the SDK's refusal-fallback
// middleware retries on CHAT_FALLBACK_MODEL.

type Env = Record<string, string | undefined>;
export type MessageStream = BetaMessageStream<unknown>;

export interface Llm {
  stream(params: BetaMessageStreamParams, options?: { signal?: AbortSignal }): MessageStream;
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
  const client = new AnthropicVertex({
    projectId,
    region: env.VERTEX_REGION?.trim() || "global",
    middleware: [betaRefusalFallbackMiddleware([{ model: env.CHAT_FALLBACK_MODEL?.trim() || "claude-opus-4-8" }])],
  });
  return { stream: (params, options) => client.beta.messages.stream(params, options) };
}
