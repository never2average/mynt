// The coding agent's stream-json output (Claude Code with --include-partial-messages) as activity a developer can
// follow: its messages, the commands it runs and the files it edits, and, while it writes a message, the words so far.
// Its thinking (the reasoning text the API returns to Claude Code) is followed the same way: thinking_delta entries
// while a thinking block is written, then a finished `thinking` entry, scrubbed exactly as text is.
//
// Everything stored is shown to people, so every piece of text is scrubbed of secrets (redact, as sandbox_run output
// is). A message being written arrives in small deltas, and a secret can be split across two of them, so deltas are
// never scrubbed one by one: each block's text is accumulated, and what goes out is the scrubbed form of its settled
// part only, the text up to its last whitespace. A word still being written (where a token, a URL with a password,
// or an assignment's value would be) is held back until it's complete. What goes out must extend what already went
// out; if scrubbing the longer text changes what was sent (a private key block, recognised only once its content
// follows its BEGIN line), the block stops streaming, and its full message, scrubbed whole, is all that's added.

import { redact } from "./boxes.js";

export type ActivityEntry = { type: string; summary: string; stream?: string };

// One block's streamed text is kept up to this many characters; past it, the block stops streaming and only its
// final message (cut, as every message is) is added.
export const STREAM_TEXT_MAX = 16_000;

// Summaries are stored and shown: control characters (NUL among them, which Postgres text refuses) go, secrets are
// scrubbed before the text is cut (so a cut can't leave a partial token the patterns miss), and a cut never leaves
// half a surrogate pair. Text is scrubbed with its line breaks still in it (a private key block is recognised by
// them), then again once it's on one line.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// Streamed text keeps its line breaks (the agent writes markdown); other control characters go.
const streamClean = (text: string) =>
  text
    .replace(LONE_SURROGATE, "�")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, " ");
export function activitySummary(text: string, limit = 400) {
  const clean = redact(
    redact(streamClean(text))
      .replace(/[\u0000-\u001F\u007F]+/g, " ")
      .replace(/\s+/g, " "),
  );
  return clean.slice(0, limit).replace(LONE_SURROGATE, "");
}

type Kind = "text" | "thinking";
type Block = { id: string; kind: Kind; raw: string; sent: string; live: boolean; touched: boolean };
// Each kind of block's entries: the words as they're written, and the whole block.
const DELTA: Record<Kind, string> = { text: "text_delta", thinking: "thinking_delta" };
const WHOLE: Record<Kind, string> = { text: "message", thinking: "thinking" };
type Lane = { message: string | null; blocks: Map<number, Block> };

// What's known of the messages being written, per lane (the lead agent, and each sub-agent by the tool call that
// started it). It's carried from one read of the log to the next; a reader that starts without it (Mynt restarted)
// doesn't stream the blocks already under way, and their full messages are added when they end.
export class StreamState {
  lanes = new Map<string, Lane>();

  clone(): StreamState {
    const c = new StreamState();
    for (const [k, l] of this.lanes) c.lanes.set(k, { message: l.message, blocks: new Map([...l.blocks].map(([i, b]) => [i, { ...b }])) });
    return c;
  }

  private lane(key: string): Lane {
    let l = this.lanes.get(key);
    if (!l) this.lanes.set(key, (l = { message: null, blocks: new Map() }));
    return l;
  }

  // One line of the log as entries, oldest first.
  entries(m: Record<string, unknown>): ActivityEntry[] {
    const key = typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : "";
    if (m.type === "stream_event") {
      this.onEvent(key, m);
      return [];
    }
    const out = this.flush();
    if (m.type === "result") {
      out.push({ type: "turn_finished", summary: activitySummary(`${str(m.subtype)}, US$${Number(m.total_cost_usd ?? 0).toFixed(2)}`) });
      return out;
    }
    const message = m.message as { id?: unknown; content?: unknown } | undefined;
    if (m.type !== "assistant" || !Array.isArray(message?.content)) return out;
    const id = typeof message.id === "string" ? message.id : null;
    for (const c of message.content as Record<string, unknown>[]) {
      if (c?.type === "text") out.push(...this.finish(key, id, str(c.text), "text"));
      // Thinking with no text (its display omitted, or redacted) adds nothing.
      else if (c?.type === "thinking" && typeof c.thinking === "string" && c.thinking.trim()) out.push(...this.finish(key, id, c.thinking, "thinking"));
      else if (c?.type === "tool_use") out.push({ type: "tool_use", summary: activitySummary(`${str(c.name)} ${str(c.input)}`) });
    }
    return out;
  }

  // The text and thinking deltas accumulated since the last flush, one entry per block: the settled part, scrubbed.
  flush(): ActivityEntry[] {
    const out: ActivityEntry[] = [];
    for (const lane of this.lanes.values()) {
      for (const b of lane.blocks.values()) {
        if (!b.touched) continue;
        b.touched = false;
        const end = Math.max(b.raw.lastIndexOf(" "), b.raw.lastIndexOf("\n"));
        if (end < 0) continue;
        const piece = this.extend(b, redact(b.raw.slice(0, end + 1)));
        if (piece) out.push({ type: DELTA[b.kind], summary: piece, stream: b.id });
      }
    }
    return out;
  }

  // What `scrubbed` adds to what the block already sent, or "" (and the block stops streaming) if it doesn't
  // extend it.
  private extend(b: Block, scrubbed: string): string {
    if (!b.live) return "";
    if (!scrubbed.startsWith(b.sent)) {
      b.live = false;
      return "";
    }
    const piece = scrubbed.slice(b.sent.length);
    b.sent = scrubbed;
    return piece;
  }

  private onEvent(key: string, m: Record<string, unknown>) {
    const e = (m.event ?? {}) as Record<string, unknown>;
    const lane = this.lane(key);
    const apiId = typeof m.api_message_id === "string" ? m.api_message_id : null;
    if (e.type === "message_start") {
      const id = (e.message as { id?: unknown } | undefined)?.id;
      lane.message = typeof id === "string" ? id : apiId;
      lane.blocks.clear();
      return;
    }
    const index = typeof e.index === "number" ? e.index : null;
    if (index === null) return;
    const msg = apiId ?? lane.message;
    if (e.type === "content_block_start") {
      const kind = (e.content_block as { type?: unknown } | undefined)?.type;
      if ((kind !== "text" && kind !== "thinking") || !msg) return;
      if (lane.message !== msg) {
        lane.message = msg;
        lane.blocks.clear();
      }
      lane.blocks.set(index, { id: `${msg}:${index}`, kind, raw: "", sent: "", live: true, touched: false });
      return;
    }
    if (e.type === "content_block_delta") {
      const d = (e.delta ?? {}) as Record<string, unknown>;
      const piece = d.type === "text_delta" ? d.text : d.type === "thinking_delta" ? d.thinking : undefined;
      if (typeof piece !== "string" || lane.message !== msg) return;
      const b = lane.blocks.get(index);
      if (!b || !b.live || DELTA[b.kind] !== d.type) return;
      b.raw += streamClean(piece);
      if (b.raw.length > STREAM_TEXT_MAX) b.live = false;
      else b.touched = true;
    }
  }

  // A text (or thinking) block's whole entry: the rest of its streamed text first (the full text scrubbed whole, if
  // it extends what was sent), then the entry, tied to the stream so a follower closes it rather than printing it
  // twice. A block that wasn't streamed, or stopped streaming, carries no stream and is shown on its own.
  private finish(key: string, id: string | null, text: string, kind: Kind): ActivityEntry[] {
    const lane = this.lanes.get(key);
    const summary = activitySummary(text);
    const alone = [{ type: WHOLE[kind], summary }];
    if (!lane || !id || lane.message !== id) return alone;
    const index = [...lane.blocks.entries()].filter(([, x]) => x.kind === kind).map(([i]) => i).sort((a, b) => a - b)[0];
    const b = index === undefined ? undefined : lane.blocks.get(index);
    if (!b) return alone;
    lane.blocks.delete(index!);
    const full = streamClean(text);
    const rest = full.length > STREAM_TEXT_MAX ? "" : this.extend(b, redact(full));
    if (!b.live || full.length > STREAM_TEXT_MAX) return alone;
    return [...(rest ? [{ type: DELTA[kind], summary: rest, stream: b.id }] : []), { type: WHOLE[kind], summary, stream: b.id }];
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
