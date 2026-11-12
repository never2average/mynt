import { z } from "zod";

const TermsSchema = z
  .array(z.strictObject({ label: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(120) }))
  .min(1)
  .max(8);

// The product card as the user sees it. The server builds it (see buildProductCard): the
// title and provider come from Mynt's get_product, and every term value must appear there.
export const ProductCardSchema = z.strictObject({
  product_id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(600),
  terms: TermsSchema,
  provider: z.string().trim().min(1).max(120).optional(),
});
export type ProductCard = z.infer<typeof ProductCardSchema>;

// What the model passes to the local show_product_card tool: which product, a sentence on why it
// fits, and the terms to show, picked from get_product.
export const CardChoiceSchema = z.strictObject({
  product_id: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(600),
  terms: TermsSchema,
});
export type CardChoice = z.infer<typeof CardChoiceSchema>;

// Mynt's product lines, by economic function (the same list as the server's catalog).
export const PRODUCT_LINES = [
  "credit",
  "securitization",
  "payments",
  "account_operations",
  "custody_settlement",
  "wealth",
  "insurance",
  "guarantees_trade",
  "exchange",
  "derivatives",
  "information",
] as const;

// A product request the model proposes with the local propose_product_request tool. Nothing
// reaches Mynt until the user taps "Send request" (see /api/request).
export const RequestProposalSchema = z.strictObject({
  need: z.string().trim().min(10).max(2000),
  product_line: z.enum(PRODUCT_LINES).optional(),
  amount: z.number().positive().optional(),
  tenor_days: z.number().int().positive().max(36500).optional(),
  context: z.string().trim().min(1).max(2000).optional(),
});
export type RequestProposal = z.infer<typeof RequestProposalSchema>;

// One item in the chat as the user sees it.
export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "card"; card: ProductCard }
  | { kind: "request"; id: string; request: RequestProposal }
  | { kind: "note"; text: string; tone: "ok" | "error" };

// What /api/chat streams to the browser, one JSON object per SSE "data:" line.
export type ChatEvent =
  | { type: "text"; text: string } // a piece of the assistant's reply
  | { type: "card"; card: ProductCard }
  | { type: "request"; id: string; request: RequestProposal } // waiting for the user to confirm
  | { type: "status"; label: string } // e.g. "Searching Mynt's catalogue…"
  | { type: "error"; message: string }
  | { type: "auth_required" }
  | { type: "done" };

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, input: unknown, what: string): Parsed<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `${issue?.path.join(".") || what}: ${issue?.message ?? "invalid"}` };
}

export function parseProductCard(input: unknown): { ok: true; card: ProductCard } | { ok: false; error: string } {
  const parsed = parseWith(ProductCardSchema, input, "card");
  return parsed.ok ? { ok: true, card: parsed.value } : parsed;
}

export const parseCardChoice = (input: unknown) => parseWith(CardChoiceSchema, input, "card");
export const parseRequestProposal = (input: unknown) => parseWith(RequestProposalSchema, input, "request");

// Every string and number in a JSON value, for checking a card's terms against Mynt's data.
function textsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(textsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(textsIn);
  return [];
}
const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// The card for a product, from the model's choice and Mynt's get_product reply (its JSON text).
// Refused unless the product is published and every term value appears in Mynt's data, so text
// in a tool result can't put made-up terms on a real product's card.
export function buildProductCard(choice: CardChoice, productJson: string): { ok: true; card: ProductCard } | { ok: false; error: string } {
  let product: Record<string, unknown>;
  try {
    product = JSON.parse(productJson) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "Mynt's product details couldn't be read." };
  }
  if (!product || typeof product !== "object" || typeof product.name !== "string") {
    return { ok: false, error: "Mynt's product details couldn't be read." };
  }
  // get_product returns a status only for the caller's own unpublished products.
  if ("status" in product && product.status !== "published") {
    return { ok: false, error: `${choice.product_id} isn't published, so the user can't accept it.` };
  }
  const haystack = normalise(textsIn(product).join("\n"));
  const invented = choice.terms.filter((t) => !haystack.includes(normalise(t.value)));
  if (invented.length > 0) {
    return {
      ok: false,
      error: `These term values aren't in get_product's reply: ${invented.map((t) => JSON.stringify(t.value)).join(", ")}. Copy values exactly, or leave the term out.`,
    };
  }
  return parseProductCard({
    product_id: choice.product_id,
    title: product.name.slice(0, 120),
    summary: choice.summary,
    terms: choice.terms,
    ...(typeof product.provider === "string" && product.provider.trim() ? { provider: product.provider.slice(0, 120) } : {}),
  });
}

// The card's headline figure: the first term that reads like an amount ("Amount", "Limit",
// "Cover"…) and contains a digit. Returned separately so the UI can show it large.
const AMOUNT_LABEL = /amount|limit|cover|sum|principal|loan|credit line/i;
export function splitHeadline(card: ProductCard): { headline?: { label: string; value: string }; rest: ProductCard["terms"] } {
  const i = card.terms.findIndex((t) => AMOUNT_LABEL.test(t.label) && /\d/.test(t.value));
  if (i < 0) return { rest: card.terms };
  return { headline: card.terms[i], rest: card.terms.filter((_, j) => j !== i) };
}

// The amount to enrol with when the user taps Accept: the card's headline figure, when it is
// one amount to borrow, deposit or invest (not a limit, cover or range). Otherwise undefined and
// the product's own terms apply.
const ENROL_LABEL = /amount|principal|loan|deposit|invest/i;
const NOT_ENROL_LABEL = /limit|cover|sum assured|premium|up to|max|min/i;
const UNITS: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, crore: 1e7, crores: 1e7, cr: 1e7 };
export function enrolAmount(card: ProductCard): number | undefined {
  const { headline } = splitHeadline(card);
  if (!headline || !ENROL_LABEL.test(headline.label) || NOT_ENROL_LABEL.test(headline.label)) return undefined;
  const m = /^(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lac|crores?|cr)?$/i.exec(headline.value.trim());
  if (!m) return undefined;
  const amount = Number(m[1].replace(/,/g, "")) * (m[2] ? UNITS[m[2].toLowerCase()] : 1);
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

export function encodeEvent(event: ChatEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const EVENT_TYPES = new Set(["text", "card", "request", "status", "error", "auth_required", "done"]);

function toEvent(json: string): ChatEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const e = value as { type?: unknown; text?: unknown; label?: unknown; message?: unknown; card?: unknown; id?: unknown; request?: unknown };
  if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type)) return undefined;
  switch (e.type) {
    case "request": {
      const request = parseRequestProposal(e.request);
      return request.ok && typeof e.id === "string" ? { type: "request", id: e.id, request: request.value } : undefined;
    }
    case "text":
      return typeof e.text === "string" ? { type: "text", text: e.text } : undefined;
    case "status":
      return typeof e.label === "string" ? { type: "status", label: e.label } : undefined;
    case "error":
      return typeof e.message === "string" ? { type: "error", message: e.message } : undefined;
    case "card": {
      const card = parseProductCard(e.card);
      return card.ok ? { type: "card", card: card.card } : undefined;
    }
    default:
      return { type: e.type as "auth_required" | "done" };
  }
}

// Incremental SSE parser for the browser: feed it chunks as they arrive; it returns the
// complete events and keeps any partial one for the next chunk. Unknown or malformed events
// are dropped.
export class SseParser {
  private buffer = "";

  push(chunk: string): ChatEvent[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const events: ChatEvent[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      const event = toEvent(data);
      if (event) events.push(event);
    }
    return events;
  }
}
