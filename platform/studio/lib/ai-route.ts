import { z } from "zod";

// What the studio's assistants' routes share (Ask AI, app/api/ask; Earn, app/api/earn): reading a
// capped request body and the conversation's shape.

export const TOO_LARGE = Symbol("too large");

// The body as text, read no further than `max` bytes: a declared length over it, or a stream that
// goes past it, is refused before anything is parsed.
export async function readCapped(req: Request, max: number): Promise<string | typeof TOO_LARGE> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) return TOO_LARGE;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const ChatBody = z.object({
  messages: z
    .array(
      z
        .object({
          role: z.string(),
          parts: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
        })
        .passthrough(),
    )
    .min(1)
    .max(200),
});
