import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { PROPOSE_PRODUCT_REQUEST, runTurn, SHOW_PRODUCT_CARD, toClaudeTools } from "@/lib/agent";
import type { ChatEvent } from "@/lib/events";
import type { Llm, MessageStream } from "@/lib/llm";
import type { ToolOutcome } from "@/lib/mynt";

type Block = Anthropic.Beta.Messages.BetaContentBlock;
type Reply = { content: Block[]; stop_reason: string };

// A stand-in for Claude: replays scripted replies and records each request.
function fakeLlm(replies: Reply[]) {
  const requests: { tools: string[]; messages: unknown[] }[] = [];
  const llm: Llm = {
    stream(params) {
      requests.push({ tools: (params.tools ?? []).map((t) => (t as { name: string }).name), messages: structuredClone(params.messages) });
      const reply = replies.shift();
      if (!reply) throw new Error("no more scripted replies");
      const listeners: ((delta: string) => void)[] = [];
      const stream = {
        on(event: string, fn: (delta: string) => void) {
          if (event === "text") listeners.push(fn);
          return stream;
        },
        async finalMessage() {
          for (const b of reply.content) if (b.type === "text") listeners.forEach((fn) => fn(b.text));
          return { role: "assistant", content: reply.content, stop_reason: reply.stop_reason };
        },
      };
      return stream as unknown as MessageStream;
    },
  };
  return { llm, requests };
}

const text = (t: string) => ({ type: "text", text: t, citations: null }) as Block;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Block;

const goodCard = {
  product_id: "festive-stock-loan",
  summary: "Stock up before Diwali.",
  terms: [{ label: "Amount", value: "₹80,000" }],
};

// What Mynt's get_product returns for that product.
const PRODUCT = {
  id: "festive-stock-loan",
  name: "Festive Stock Loan",
  product_line: "credit",
  description: "Credit for festival stock, up to ₹80,000, repaid from daily UPI sales.",
  key_features: ["42-day tenor", "1.5% per month"],
};
const productTool = (product: object = PRODUCT) => (name: string): ToolOutcome =>
  name === "get_product" ? { isError: false, text: JSON.stringify(product, null, 2) } : { isError: false, text: `{"ok":true}` };

function run(replies: Reply[], tools = ["list_products", "get_product"], callTool?: (name: string, args: Record<string, unknown>) => ToolOutcome) {
  const { llm, requests } = fakeLlm(replies);
  const events: ChatEvent[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const history: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: "I need stock for Diwali" }];
  const promise = runTurn(history, {
    llm,
    model: "claude-opus-5-5",
    tools: tools.map((name) => ({ name, description: name, input_schema: { type: "object" } })),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return (callTool ?? productTool())(name, args);
    },
    emit: (e) => events.push(e),
  });
  return { promise, events, calls, history, requests };
}

describe("runTurn", () => {
  it("checks the product exists, then streams a card titled from Mynt's data", async () => {
    const { promise, events, calls, history, requests } = run([
      { content: [text("Here's one."), toolUse("t1", "show_product_card", goodCard)], stop_reason: "tool_use" },
      { content: [text("Tap Accept if it suits you.")], stop_reason: "end_turn" },
    ]);
    const result = await promise;
    expect(calls).toEqual([{ name: "get_product", args: { id: "festive-stock-loan" } }]);
    const card = { ...goodCard, title: "Festive Stock Loan" };
    expect(events.filter((e) => e.type === "card")).toEqual([{ type: "card", card }]);
    expect(result.cards).toEqual([card]);
    expect(requests[0].tools).toEqual(["list_products", "get_product", SHOW_PRODUCT_CARD.name, PROPOSE_PRODUCT_REQUEST.name]);
    // user, assistant(tool_use), user(tool_result), assistant(final)
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("refuses cards for products Mynt doesn't have", async () => {
    const { promise, events, history } = run(
      [
        { content: [toolUse("t1", "show_product_card", { ...goodCard, product_id: "made-up" })], stop_reason: "tool_use" },
        { content: [text("Sorry.")], stop_reason: "end_turn" },
      ],
      undefined,
      () => ({ isError: true, text: "not found" }),
    );
    await promise;
    expect(events.some((e) => e.type === "card")).toBe(false);
    const results = history[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(results[0]).toMatchObject({ tool_use_id: "t1", is_error: true });
  });

  it("refuses cards with terms that aren't in Mynt's data", async () => {
    const { promise, events, history } = run([
      {
        content: [toolUse("t1", "show_product_card", { ...goodCard, terms: [{ label: "Rate", value: "0%" }] })],
        stop_reason: "tool_use",
      },
      { content: [text("Sorry.")], stop_reason: "end_turn" },
    ]);
    await promise;
    expect(events.some((e) => e.type === "card")).toBe(false);
    const [result] = history[2].content as Anthropic.Beta.Messages.BetaToolResultBlockParam[];
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('"0%"') });
  });

  it("refuses cards for unpublished products, even the user's own drafts", async () => {
    const { promise, events, history } = run(
      [
        { content: [toolUse("t1", "show_product_card", goodCard)], stop_reason: "tool_use" },
        { content: [text("Sorry.")], stop_reason: "end_turn" },
      ],
      undefined,
      productTool({ ...PRODUCT, status: "draft" }),
    );
    await promise;
    expect(events.some((e) => e.type === "card")).toBe(false);
    expect((history[2].content as { is_error?: boolean }[])[0].is_error).toBe(true);
  });

  it("never lets the model set the card's title or provider", async () => {
    const { promise, calls } = run([
      { content: [toolUse("t1", "show_product_card", { ...goodCard, title: "Free money", provider: "RBI" })], stop_reason: "tool_use" },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    await promise;
    expect(calls).toEqual([]);
  });

  it("proposes product requests for the user to confirm, without sending them", async () => {
    const proposal = { need: "Cover for slow monsoon weeks at my tea stall", product_line: "insurance" };
    const { promise, events, calls, history } = run(
      [
        { content: [toolUse("t1", "propose_product_request", proposal)], stop_reason: "tool_use" },
        { content: [text("Tap Send request if that's right.")], stop_reason: "end_turn" },
      ],
      ["list_products", "get_product", "request_product"],
    );
    const result = await promise;
    expect(calls).toEqual([]);
    expect(result.requests).toEqual([{ id: expect.any(String), request: proposal }]);
    expect(events).toContainEqual({ type: "request", id: result.requests[0].id, request: proposal });
    expect((history[2].content as { is_error?: boolean }[])[0].is_error).toBeUndefined();
  });

  it("refuses malformed cards without calling Mynt", async () => {
    const { promise, calls, history } = run([
      { content: [toolUse("t1", "show_product_card", { product_id: "x", title: "T" })], stop_reason: "tool_use" },
      { content: [text("ok")], stop_reason: "end_turn" },
    ]);
    await promise;
    expect(calls).toEqual([]);
    expect((history[2].content as { is_error?: boolean }[])[0].is_error).toBe(true);
  });

  it("never runs tools outside the allowed list, such as enrolment", async () => {
    const { promise, calls, history } = run([
      { content: [toolUse("t1", "enroll_in_product", { product_id: "x" })], stop_reason: "tool_use" },
      { content: [text("Please tap Accept.")], stop_reason: "end_turn" },
    ]);
    await promise;
    expect(calls).toEqual([]);
    expect((history[2].content as { is_error?: boolean }[])[0].is_error).toBe(true);
  });

  it("runs parallel tool calls and returns all results in one message", async () => {
    const { promise, calls, history } = run([
      {
        content: [toolUse("a", "list_products", { product_line: "credit" }), toolUse("b", "get_product", { id: "p" })],
        stop_reason: "tool_use",
      },
      { content: [text("done")], stop_reason: "end_turn" },
    ]);
    await promise;
    expect(calls.map((c) => c.name).sort()).toEqual(["get_product", "list_products"]);
    expect((history[2].content as { tool_use_id: string }[]).map((r) => r.tool_use_id)).toEqual(["a", "b"]);
  });

  it("drops a tool call cut off by max_tokens instead of running it", async () => {
    const { promise, calls, events, history } = run([
      { content: [toolUse("t1", "list_products", { query: "sto" })], stop_reason: "max_tokens" },
    ]);
    await promise;
    expect(calls).toEqual([]);
    expect(history).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("reports refusals and takes the whole refused turn back out of the history", async () => {
    const { promise, events, history } = run([
      { content: [toolUse("a", "list_products", { query: "x" })], stop_reason: "tool_use" },
      { content: [], stop_reason: "refusal" },
    ]);
    const result = await promise;
    expect(result.refused).toBe(true);
    expect(history).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "error", message: expect.any(String) });
  });
});

describe("toClaudeTools", () => {
  it("maps MCP tool definitions to Messages API tools", () => {
    const [tool] = toClaudeTools([
      { name: "list_products", description: "List", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
    ]);
    expect(tool).toEqual({ name: "list_products", description: "List", input_schema: { type: "object", properties: { query: { type: "string" } } } });
  });
});
