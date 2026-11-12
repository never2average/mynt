import Anthropic, { betaRefusalFallbackMiddleware } from "@anthropic-ai/sdk";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";

type StreamParams = BetaMessageStreamParams;
type StreamOptions = { signal?: AbortSignal };
export type MessageStream = BetaMessageStream<unknown>;

// The one Claude call this app makes, on whichever platform is configured.
export interface Llm {
  stream(params: StreamParams, options?: StreamOptions): MessageStream;
}

// Claude through the Claude API when ANTHROPIC_API_KEY is set, otherwise through Google Vertex
// AI (VERTEX_PROJECT_ID, VERTEX_REGION; credentials from GOOGLE_APPLICATION_CREDENTIALS or the
// machine's default Google credentials).
//
// Both paths fall back to another model if a request is declined by Claude's safety
// classifiers: the Claude API does it server side ("fallbacks": "default"); on Vertex the SDK's
// refusal-fallback middleware retries on CHAT_FALLBACK_MODEL.
export function createLlm(env = process.env): Llm {
  if (env.ANTHROPIC_API_KEY) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return {
      stream: (params, options) =>
        client.beta.messages.stream(
          { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
          options,
        ),
    };
  }
  const projectId = env.VERTEX_PROJECT_ID?.trim();
  if (!projectId) throw new Error("Set ANTHROPIC_API_KEY, or VERTEX_PROJECT_ID for Google Vertex AI (see .env.example)");
  const client = new AnthropicVertex({
    projectId,
    region: env.VERTEX_REGION?.trim() || "global",
    middleware: [betaRefusalFallbackMiddleware([{ model: env.CHAT_FALLBACK_MODEL?.trim() || "claude-opus-4-8" }])],
  });
  return { stream: (params, options) => client.beta.messages.stream(params, options) };
}
