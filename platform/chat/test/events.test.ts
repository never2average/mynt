import { describe, expect, it } from "vitest";
import {
  buildProductCard,
  encodeEvent,
  enrolAmount,
  parseProductCard,
  splitHeadline,
  SseParser,
  type ChatEvent,
  type ProductCard,
} from "@/lib/events";
import { appendEvent, visibleItems } from "@/lib/transcript";

const card: ProductCard = {
  product_id: "festive-stock-loan",
  title: "Festive stock loan",
  summary: "Stock up before Diwali and repay from daily settlements.",
  terms: [
    { label: "Tenor", value: "6 weeks" },
    { label: "Amount", value: "₹80,000" },
    { label: "Rate", value: "1.5% per month" },
  ],
  provider: "Example NBFC",
};

describe("product cards", () => {
  it("accepts a well-formed card and trims it", () => {
    const result = parseProductCard({ ...card, title: "  Festive stock loan " });
    expect(result).toEqual({ ok: true, card });
  });

  it("rejects cards without terms, with unknown fields, or with oversized values", () => {
    expect(parseProductCard({ ...card, terms: [] }).ok).toBe(false);
    expect(parseProductCard({ ...card, rate: "10%" }).ok).toBe(false);
    expect(parseProductCard({ ...card, title: "x".repeat(121) }).ok).toBe(false);
    const missing = parseProductCard({ title: "No id", summary: "s", terms: [{ label: "a", value: "b" }] });
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("product_id") });
  });

  it("lifts the amount out as the headline", () => {
    const { headline, rest } = splitHeadline(card);
    expect(headline).toEqual({ label: "Amount", value: "₹80,000" });
    expect(rest.map((t) => t.label)).toEqual(["Tenor", "Rate"]);
  });

  it("has no headline when no term reads like an amount", () => {
    const noAmount = { ...card, terms: [{ label: "Amount", value: "Flexible" }, { label: "Tenor", value: "6 weeks" }] };
    expect(splitHeadline(noAmount).headline).toBeUndefined();
  });
});

describe("building cards from Mynt's data", () => {
  const product = JSON.stringify({
    id: "festive-stock-loan",
    name: "Festive Stock Loan",
    provider: "Example NBFC",
    description: "Up to ₹80,000 for 6 weeks.",
    key_features: ["1.5% per month"],
  });
  const choice = { product_id: "festive-stock-loan", summary: "Stock up.", terms: [{ label: "Amount", value: "₹80,000" }, { label: "Rate", value: "1.5%  PER month" }] };

  it("takes the title and provider from Mynt and keeps terms whose values Mynt has", () => {
    expect(buildProductCard(choice, product)).toEqual({
      ok: true,
      card: { ...choice, title: "Festive Stock Loan", provider: "Example NBFC", terms: [choice.terms[0], { label: "Rate", value: "1.5%  PER month" }] },
    });
  });

  it("refuses invented values, unpublished products and unreadable replies", () => {
    expect(buildProductCard({ ...choice, terms: [{ label: "Rate", value: "0%" }] }, product).ok).toBe(false);
    expect(buildProductCard(choice, JSON.stringify({ ...JSON.parse(product), status: "draft" })).ok).toBe(false);
    expect(buildProductCard(choice, "not json").ok).toBe(false);
  });

  it("enrols with the headline amount only when it is one amount to borrow", () => {
    expect(enrolAmount(card)).toBe(80000);
    expect(enrolAmount({ ...card, terms: [{ label: "Loan amount", value: "₹1.5 lakh" }] })).toBe(150000);
    expect(enrolAmount({ ...card, terms: [{ label: "Limit", value: "₹80,000" }] })).toBeUndefined();
    expect(enrolAmount({ ...card, terms: [{ label: "Amount", value: "₹50,000 to ₹2,00,000" }] })).toBeUndefined();
    expect(enrolAmount({ ...card, terms: [{ label: "Tenor", value: "6 weeks" }] })).toBeUndefined();
  });
});

describe("SSE parsing", () => {
  const events: ChatEvent[] = [
    { type: "status", label: "Searching Mynt's catalogue…" },
    { type: "text", text: "Here is one option:\n" },
    { type: "card", card },
    { type: "request", id: "r1", request: { need: "Cover for slow monsoon weeks", product_line: "insurance" } },
    { type: "error", message: "oops" },
    { type: "auth_required" },
    { type: "done" },
  ];

  it("round-trips every event type", () => {
    const parser = new SseParser();
    expect(parser.push(events.map(encodeEvent).join(""))).toEqual(events);
  });

  it("handles events split across chunks at any point", () => {
    const wire = events.map(encodeEvent).join("");
    for (let cut = 1; cut < wire.length; cut += 7) {
      const parser = new SseParser();
      expect([...parser.push(wire.slice(0, cut)), ...parser.push(wire.slice(cut))]).toEqual(events);
    }
  });

  it("drops malformed, unknown and invalid-card events", () => {
    const parser = new SseParser();
    const wire =
      "data: {not json}\n\n" +
      'data: {"type":"exec","cmd":"rm"}\n\n' +
      `data: ${JSON.stringify({ type: "card", card: { ...card, terms: [] } })}\n\n` +
      ": comment\n\n" +
      encodeEvent({ type: "done" });
    expect(parser.push(wire)).toEqual([{ type: "done" }]);
  });

  it("accepts CRLF line endings", () => {
    const parser = new SseParser();
    expect(parser.push(encodeEvent({ type: "text", text: "hi" }).replace(/\n/g, "\r\n"))).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("transcript", () => {
  it("joins text into one bubble and starts a new one after a card", () => {
    let items = appendEvent([{ kind: "user", text: "stock for Diwali" }], { type: "text", text: "Let me " });
    items = appendEvent(items, { type: "text", text: "look." });
    items = appendEvent(items, { type: "card", card });
    items = appendEvent(items, { type: "text", text: "Want more?" });
    items = appendEvent(items, { type: "status", label: "ignored" });
    expect(items).toEqual([
      { kind: "user", text: "stock for Diwali" },
      { kind: "assistant", text: "Let me look." },
      { kind: "card", card },
      { kind: "assistant", text: "Want more?" },
    ]);
  });

  it("hides whitespace-only bubbles", () => {
    expect(visibleItems([{ kind: "assistant", text: "\n\n" }, { kind: "assistant", text: " ok " }])).toEqual([
      { kind: "assistant", text: "ok" },
    ]);
  });
});
