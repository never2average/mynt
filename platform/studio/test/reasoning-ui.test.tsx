// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useChat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { Thread } from "@/components/assistant-ui/thread";
import { withoutReasoning } from "@/lib/ask-client";

// Every studio chat (the app builder, Ask AI, Earn) draws its answers with this Thread: the model's
// reasoning is a collapsible "Reasoning" block above the answer, open while it streams and
// collapsed once the answer starts.

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {};
});
afterEach(cleanup);

// A transport whose reply the test writes a chunk at a time.
function heldTransport() {
  let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async () =>
      new ReadableStream<UIMessageChunk>({
        start(c) {
          controller = c;
        },
      }),
    reconnectToStream: async () => null,
  };
  return {
    transport,
    ready: () => controller !== null,
    write: (...chunks: UIMessageChunk[]) => act(async () => void chunks.forEach((c) => controller!.enqueue(c))),
    end: () => act(async () => controller!.close()),
  };
}

function Chat({ transport, messages }: { transport: ChatTransport<UIMessage>; messages?: UIMessage[] }) {
  const chat = useChat<UIMessage>({ transport, messages });
  const runtime = useAISDKRuntime(chat);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread placeholder="Ask" />
    </AssistantRuntimeProvider>
  );
}

const content = () => document.querySelector('[data-slot="reasoning-content"]');
const root = () => document.querySelector('[data-slot="reasoning-root"]');

describe("what Ask AI and Earn send back", () => {
  it("is the conversation without the reasoning shown in it (the server reads only the text)", () => {
    const messages = [{ id: "a", role: "assistant", parts: [{ type: "reasoning", text: "long thoughts" }, { type: "text", text: "Answer" }] }];
    expect(withoutReasoning({ id: "c", messages, body: { wallet: null }, trigger: "submit-message", messageId: undefined })).toEqual({
      body: { wallet: null, id: "c", messages: [{ id: "a", role: "assistant", parts: [{ type: "text", text: "Answer" }] }], trigger: "submit-message", messageId: undefined },
    });
  });
});

describe("the Reasoning block", () => {
  it("is shown collapsed above an earlier answer, and opens when clicked", async () => {
    const messages: UIMessage[] = [
      { id: "u", role: "user", parts: [{ type: "text", text: "Which apps?" }] },
      { id: "a", role: "assistant", parts: [{ type: "reasoning", text: "Looking at their apps." }, { type: "text", text: "You have one app." }] },
    ];
    render(<Chat transport={heldTransport().transport} messages={messages} />);
    expect(await screen.findByText("You have one app.")).toBeTruthy();
    const trigger = screen.getByRole("button", { name: /Reasoning/ });
    expect(root()!.getAttribute("data-state")).toBe("closed");
    // Above the answer: the block comes before the answer's text in the message.
    expect(root()!.compareDocumentPosition(screen.getByText("You have one app.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(trigger);
    expect(root()!.getAttribute("data-state")).toBe("open");
    expect(screen.getByText("Looking at their apps.")).toBeTruthy();
    // Muted and smaller than the answer.
    expect(content()!.className).toContain("text-muted-foreground");
    expect(content()!.className).toContain("text-xs");
  });

  it("is open while the reasoning streams, and collapses once the answer starts", async () => {
    const held = heldTransport();
    render(<Chat transport={held.transport} />);
    const input = screen.getByLabelText("Message input");
    fireEvent.change(input, { target: { value: "Which apps?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(held.ready()).toBe(true));
    await held.write({ type: "start" }, { type: "reasoning-start", id: "r1" }, { type: "reasoning-delta", id: "r1", delta: "Checking their apps." });
    await waitFor(() => expect(screen.getByText("Checking their apps.")).toBeTruthy());
    expect(root()!.getAttribute("data-state")).toBe("open");
    await held.write({ type: "reasoning-end", id: "r1" }, { type: "text-start", id: "t1" }, { type: "text-delta", id: "t1", delta: "You have one app." });
    await waitFor(() => expect(screen.getByText("You have one app.")).toBeTruthy());
    expect(root()!.getAttribute("data-state")).toBe("closed");
    await held.write({ type: "text-end", id: "t1" }, { type: "finish" });
    await held.end();
  });
});
