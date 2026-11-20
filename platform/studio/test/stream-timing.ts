// Reads a streamed (SSE) response as the browser would, piece by piece, noting when each of its
// JSON chunks arrived, so a test can tell a reply that streams from one that arrives all at once.
export type TimedChunk = { at: number; chunk: Record<string, unknown> };

export async function readTimed(res: Response): Promise<TimedChunk[]> {
  const out: TimedChunk[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const at = performance.now();
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.startsWith("data: ") && line !== "data: [DONE]") out.push({ at, chunk: JSON.parse(line.slice(6)) });
    }
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
