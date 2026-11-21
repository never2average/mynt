// Ask AI's requests from the browser. The chat shows a failed request's body as its error, so a
// refusal is turned into a sentence here: Mynt's or the studio's own message ({"message": ...}),
// a friendly line for the studio's error codes, never the raw JSON.
export const ASK_ERRORS: Record<string, string> = {
  not_developer: "Ask AI is for developers. Ask a Mynt admin for the developer role.",
  auth_required: "Your session ended. Sign in again to ask.",
  rate_limited: "That's a lot of questions for one hour. Please try again later.",
  not_configured: "AI is not configured.",
};
export const ASK_FAILED = "Ask AI couldn't answer just now. Please try again.";

/** The sentence a failed Ask AI request shows, from its body. */
export function askErrorText(body: string): string {
  try {
    const data = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof data.error === "string" && ASK_ERRORS[data.error]) return ASK_ERRORS[data.error];
    if (typeof data.message === "string" && data.message.trim()) return data.message.trim().slice(0, 300);
    return ASK_FAILED;
  } catch {
    const text = body.trim();
    // Plain text that isn't markup or JSON-ish is shown as it is; anything else, the generic line.
    return text && text.length <= 300 && !/[<{]/.test(text) ? text : ASK_FAILED;
  }
}

/** A fetch for the chat transport: failures come back with a readable sentence as their body. */
export const askFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.ok) return res;
  const text = askErrorText(await res.text().catch(() => ""));
  return new Response(text, { status: res.status, headers: { "content-type": "text/plain; charset=utf-8" } });
};

type SendOptions = { id: string; messages: { parts?: { type: string }[] }[]; body?: object; trigger?: unknown; messageId?: unknown };

/**
 * The chat transport's request body as the AI SDK would send it, less the reasoning shown in
 * earlier answers: the server reads only their text, so the reasoning would only fill the request.
 */
export const withoutReasoning = (o: SendOptions) => ({
  body: {
    ...o.body,
    id: o.id,
    messages: o.messages.map((m) => (m.parts ? { ...m, parts: m.parts.filter((p) => p.type !== "reasoning") } : m)),
    trigger: o.trigger,
    messageId: o.messageId,
  },
});
