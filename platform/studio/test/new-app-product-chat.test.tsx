// @vitest-environment jsdom
// New app's Create product mode: the composer's Build app / Create product toggle and /create-product
// switch to it; "/create-product <description>" sent from Build app goes to the product assistant, never
// a build; a Build app message that asks for a product only offers the switch. In Create product the
// assistant's draft shows in the chat as a card, Review and create opens the Create product sheet filled
// with it, and confirming calls POST /api/products once with the confirmed fields; the product is then a
// Draft in the Products tab with Test and Publish. Mynt's refusals show; Build app sending is unchanged.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NewAppWorkspace, productModeCommands, type NewAppProduct } from "@/components/new-app-workspace";
import { DRAFT_PRODUCT, validateProductDraft } from "@/lib/product-chat";
import type { NewAppRequest } from "@/lib/new-app";

vi.setConfig({ testTimeout: 20_000 });

const PRODUCTS: NewAppProduct[] = [
  { id: "p1", name: "Dollar account", productLine: "custody_settlement", by: "Lead Trust", accessMode: "open", jurisdictions: ["US"], status: "published" },
];
const OPTIONS = {
  regions: [{ code: "US", name: "United States", regulators: ["FinCEN", "OCC"] }],
  categories: [{ id: "deposits", name: "Deposits", productLines: ["account_operations"] }],
};
const DRAFT_INPUT = {
  name: "Green Savings",
  product_line: "account_operations",
  category: "deposits",
  region: "US",
  regulator: "OCC",
  action: "issuance",
  risk_level: "low",
  liquidity: "high",
  typical_horizon: "short",
  return_type: "fixed_interest",
  description: "A savings account that rounds up card spend.",
  key_features: ["Round-ups"],
};
const { draft: DRAFT } = validateProductDraft(DRAFT_INPUT, { ...OPTIONS, buildable: [], mine: [] }, "draft-1") as { draft: { id: string; request: Record<string, unknown> } };

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function () {};
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(cleanup);

// The product assistant, faked: records what's sent and answers each message with the next reply.
type Reply = UIMessageChunk[];
const text = (t: string): Reply => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }];
const reasoning = (t: string): Reply => [{ type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: t }, { type: "reasoning-end", id: "r" }];
const tool = (id: string, output: unknown): Reply => [
  { type: "tool-input-available", toolCallId: id, toolName: DRAFT_PRODUCT, input: DRAFT_INPUT },
  { type: "tool-output-available", toolCallId: id, output },
];
function fakeTransport(sent: string[], replies: Reply[]): ChatTransport<UIMessage> {
  return {
    sendMessages: async ({ messages }) => {
      const last = messages[messages.length - 1];
      sent.push(last.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
      const chunks: UIMessageChunk[] = [{ type: "start" }, ...(replies.shift() ?? text("Done.")), { type: "finish" }];
      return new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(ch);
          c.close();
        },
      });
    },
    reconnectToStream: async () => null,
  };
}

type Call = { url: string; body: unknown };
let posts: Call[];
let builds: NewAppRequest[];
let createReply: { status: number; body: unknown };
const fetcher = (async (url: string, init?: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (init?.method === "POST") posts.push({ url, body });
  if (url === "/api/product-chat") return new Response(JSON.stringify({ enabled: true }), { status: 200 });
  if (url === "/api/products/options") return new Response(JSON.stringify(OPTIONS), { status: 200 });
  if (url === "/api/products" && init?.method === "POST") {
    if (createReply.status !== 201) return new Response(JSON.stringify(createReply.body), { status: createReply.status });
    return new Response(JSON.stringify({ product: { id: body.id, name: body.name, productLine: body.product_line, by: "You", accessMode: "", jurisdictions: [body.region], status: "draft", mine: true } }), { status: 201 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

let sent: string[];
let replies: Reply[];
function Harness() {
  const [products, setProducts] = useState<NewAppProduct[]>(PRODUCTS);
  const [transport] = useState(() => fakeTransport(sent, replies));
  return (
    <NewAppWorkspace
      products={products}
      kinds={[]}
      onBuild={async (r) => (builds.push(r), null)}
      onProductsChange={(change) => setProducts((l) => change(l))}
      fetcher={fetcher}
      transport={transport}
    />
  );
}
beforeEach(() => {
  posts = [];
  builds = [];
  sent = [];
  replies = [];
  createReply = { status: 201, body: null };
});

const settle = async (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const loaded = async () => {
  render(<Harness />);
  await settle();
};
const input = () => screen.getByLabelText("Message input") as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(input(), { target: { value: v } });
const sendButton = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
const send = async () => {
  await act(async () => void fireEvent.keyDown(input(), { key: "Enter" }));
  await settle();
};
const modeOf = () => document.querySelector("[data-new-app-chat]")!.getAttribute("data-mode");
const option = (m: string) => document.querySelector(`[data-mode-option="${m}"]`) as HTMLButtonElement;
const sheet = () => document.querySelector("[data-create-product-sheet]") as HTMLElement | null;

describe("Build app and Create product", () => {
  it("are a labelled toggle in the composer; switching carries what's typed", async () => {
    await loaded();
    expect(screen.getByRole("radiogroup", { name: "What to do" })).toBeTruthy();
    expect(option("build").textContent).toBe("App");
    expect(option("product").textContent).toBe("Financial product");
    expect(option("build").getAttribute("aria-checked")).toBe("true");
    expect(modeOf()).toBe("build");

    type("A high-yield savings account");
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    expect(modeOf()).toBe("product");
    expect(option("product").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("heading", { name: "What product do you want to create?" })).toBeTruthy();
    expect(input().value).toBe("A high-yield savings account");
    // No products to pick for a product.
    expect(document.querySelector("[data-product-picker]")).toBeNull();

    type("Back to apps");
    await act(async () => void fireEvent.click(option("build")));
    await settle();
    expect(modeOf()).toBe("build");
    expect(input().value).toBe("Back to apps");
    expect(sent).toEqual([]);
    expect(builds).toEqual([]);
  });

  it("/create-product switches to Create product; /build-app switches back", async () => {
    await loaded();
    type("/create-pro");
    await settle();
    const item = document.querySelector('[data-slash-menu] [data-slash-command="create-product"]') as HTMLElement;
    expect(item.textContent).toContain("Create a product: describe it in the chat");
    await act(async () => void fireEvent.click(item));
    await settle();
    expect(modeOf()).toBe("product");
    expect(input().value).toBe("");
    const buildApp = vi.fn();
    expect(productModeCommands({ tab: vi.fn(), buildApp }).map((c) => c.name)).toEqual(["build-app", "templates", "products"]);
    type("/build");
    await settle();
    await act(async () => void fireEvent.click(document.querySelector('[data-slash-menu] [data-slash-command="build-app"]') as HTMLElement));
    await settle();
    expect(modeOf()).toBe("build");
  });

  it("'/create-product <description>' sent from Build app goes to the product assistant, even with no product picked, and starts no build", async () => {
    await loaded();
    type("/create-product A savings account that rounds up card spend");
    await settle();
    expect(sendButton().disabled).toBe(false);
    await send();
    expect(modeOf()).toBe("product");
    expect(sent).toEqual(["A savings account that rounds up card spend"]);
    expect(builds).toEqual([]);
  });

  it("a Build app message that asks for a product offers the switch, but sending it is still a build", async () => {
    await loaded();
    type("Create a product for student savings");
    await settle();
    const offer = document.querySelector("[data-suggest-product]")!;
    expect(offer.textContent).toContain("This sounds like a new product rather than an app.");
    // Build mode's own rules still apply (no product picked), and it is not rerouted.
    expect(sendButton().disabled).toBe(true);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open Products" })));
    await act(async () => void fireEvent.click(document.querySelector('[data-pick="p1"]')!));
    await send();
    expect(builds).toEqual([{ prompt: "Create a product for student savings", product_ids: ["p1"] }]);
    expect(sent).toEqual([]);
    expect(modeOf()).toBe("build");
  });

  it("the offer's button switches, carrying the text", async () => {
    await loaded();
    type("I want to offer a CD to members");
    await settle();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Create product instead" })));
    await settle();
    expect(modeOf()).toBe("product");
    expect(input().value).toBe("I want to offer a CD to members");
    expect(sent).toEqual([]);
  });
});

describe("drafting a product in the chat", () => {
  it("streams the reply and reasoning, shows the draft as a card, opens the sheet filled with it, and creates it once with the confirmed fields", async () => {
    replies = [[...reasoning("Which regulator?"), ...text("Which regulator: FinCEN or OCC?")], [...text("Here's the draft."), ...tool("call-1", { ok: true, draft: DRAFT })]];
    await loaded();
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    type("A savings account that rounds up card spend");
    await send();
    expect(document.body.textContent).toContain("Which regulator: FinCEN or OCC?");
    expect(document.querySelector("[data-new-app-chat]")!.textContent).toContain("Reasoning");
    type("OCC");
    await send();
    expect(sent).toEqual(["A savings account that rounds up card spend", "OCC"]);

    const card = document.querySelector('[data-product-draft="draft-1"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.querySelector("[data-draft-name]")!.textContent).toBe("Green Savings");
    expect(card.querySelector("[data-draft-id]")!.textContent).toBe("green-savings");
    expect(card.querySelector('[data-draft-row="Jurisdiction"]')!.textContent).toBe("🇺🇸 US · OCC");
    expect(posts).toEqual([]);

    await act(async () => void fireEvent.click(within(card).getByRole("button", { name: "Review and create" })));
    await settle();
    const s = within(sheet()!);
    expect((s.getByLabelText("Name") as HTMLInputElement).value).toBe("Green Savings");
    expect((s.getByLabelText("Product id") as HTMLInputElement).value).toBe("green-savings");
    expect((s.getByLabelText("Product line") as HTMLSelectElement).value).toBe("account_operations");
    expect((s.getByLabelText("Jurisdiction") as HTMLSelectElement).value).toBe("US");
    expect((s.getByLabelText("Category") as HTMLSelectElement).value).toBe("deposits");
    expect((s.getByLabelText("Regulator") as HTMLSelectElement).value).toBe("OCC");
    expect((s.getByLabelText("Risk level") as HTMLSelectElement).value).toBe("low");
    expect((s.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("A savings account that rounds up card spend.");
    // Every field stays editable: the user changes one before confirming.
    fireEvent.change(s.getByLabelText("Liquidity"), { target: { value: "moderate" } });
    const create = s.getByRole("button", { name: "Create product" });
    await act(async () => {
      fireEvent.click(create);
      fireEvent.click(create);
    });
    await settle();
    expect(posts).toEqual([{ url: "/api/products", body: { ...DRAFT.request, liquidity: "moderate" } }]);
    expect(sheet()).toBeNull();

    // The card is done and can't be sent again; the product is a Draft in Products, with Test and Publish.
    expect(card.querySelector("[data-draft-created]")!.textContent).toBe("Created as a draft. Test and Publish it in the Products tab.");
    expect(within(card).queryByRole("button", { name: "Review and create" })).toBeNull();
    const row = document.querySelector('[data-panel-content="products"] [data-product-row="green-savings"]') as HTMLElement;
    expect(row.querySelector("[data-product-status]")!.textContent).toBe("Draft");
    expect(within(row).getByRole("button", { name: "Test" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Publish" })).toBeTruthy();
  });

  it("shows Mynt's refusal in the sheet and keeps the card open to try again", async () => {
    replies = [tool("call-1", { ok: true, draft: DRAFT })];
    createReply = { status: 422, body: { error: "mynt_refused", message: "A product with id 'green-savings' already exists" } };
    await loaded();
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    type("A savings account that rounds up card spend");
    await send();
    const card = document.querySelector('[data-product-draft="draft-1"]') as HTMLElement;
    await act(async () => void fireEvent.click(within(card).getByRole("button", { name: "Review and create" })));
    await settle();
    await act(async () => void fireEvent.click(within(sheet()!).getByRole("button", { name: "Create product" })));
    await settle();
    expect(posts).toHaveLength(1);
    expect(within(sheet()!).getByRole("alert").textContent).toBe("A product with id 'green-savings' already exists");
    expect(card.querySelector("[data-draft-created]")).toBeNull();
  });

  it("shows a draft Mynt sent back, with what to fix, and no button", async () => {
    replies = [[...tool("call-1", { ok: false, error: "region must be one of: US." }), ...text("Which region?")]];
    await loaded();
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    type("A savings account in Canada");
    await send();
    expect(document.querySelector("[data-draft-refused]")!.textContent).toBe("Mynt sent the draft back to fix: region must be one of: US.");
    expect(screen.queryByRole("button", { name: "Review and create" })).toBeNull();
  });
});
