import type { ChatEvent, TranscriptItem } from "./events";

// Folds one streamed event into the chat as the user sees it. Used by the browser to draw
// the stream and by the server to keep the same transcript for reloads.
// Text continues the assistant bubble that's open; a card closes it, so text after a card
// starts a new bubble below it.
export function appendEvent(items: TranscriptItem[], event: ChatEvent): TranscriptItem[] {
  switch (event.type) {
    case "text": {
      const last = items.at(-1);
      if (last?.kind === "assistant") return [...items.slice(0, -1), { kind: "assistant", text: last.text + event.text }];
      return [...items, { kind: "assistant", text: event.text }];
    }
    case "card":
      return [...items, { kind: "card", card: event.card }];
    case "request":
      return [...items, { kind: "request", id: event.id, request: event.request }];
    case "error":
      return [...items, { kind: "note", tone: "error", text: event.message }];
    default:
      return items;
  }
}

// Items worth drawing: no empty bubbles, no stray whitespace.
export function visibleItems(items: TranscriptItem[]): TranscriptItem[] {
  return items.flatMap((item): TranscriptItem[] => {
    if (item.kind !== "assistant") return [item];
    const text = item.text.trim();
    return text ? [{ kind: "assistant", text }] : [];
  });
}
