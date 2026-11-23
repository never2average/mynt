// @vitest-environment jsdom
// New app's Create product mode: the composer's Build app / Create product toggle and /create-product
// switch to it; "/create-product <description>" sent from Build app goes to the product assistant, never
// a build; a Build app message that asks for a product only offers the switch. In Create product the
// assistant's draft shows in the chat as a card, Review and create opens the Create product sheet filled
// with it, and confirming calls POST /api/products once with the confirmed fields; the product is then a
// Idea in the Products tab with Move to staging. Mynt's refusals show; Build app sending is unchanged.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NewAppWorkspace, productModeCommands, type NewAppProduct } from "@/components/new-app-workspace";
import { DRAFT_PRODUCT, validateProductDraft } from "@/lib/product-chat";
import { productIdeaMessage, productIdeasFrom, type ProductIdea } from "@/lib/product-ideas";
import { chipText, type AppKind, type NewAppRequest } from "@/lib/new-app";

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
let productIdeas: ProductIdea[] | null;
let kinds: AppKind[];
function Harness() {
  const [products, setProducts] = useState<NewAppProduct[]>(PRODUCTS);
  const [transport] = useState(() => fakeTransport(sent, replies));
  return (
    <NewAppWorkspace
      products={products}
      kinds={kinds}
      productIdeas={productIdeas}
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
  productIdeas = null;
  kinds = [];
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

// Financial product mode's chips and Templates are ideas for new products (list_product_ideas), not app ideas.
const PIDEA = (id: string, line: string, category: string, label: string, chipLabel?: string) => ({
  id,
  ...(chipLabel ? { chip_label: chipLabel } : {}),
  label,
  // The one without a chip label has a long name, which its chip cuts short.
  product_name: chipLabel ? `Draft ${id}` : `Draft ${id} with a name too long for a chip`,
  summary: `A factual line about ${id}.`,
  product_line: line,
  category,
  region: "US",
  key_features: [`${id} feature one`, `${id} feature two`],
  risk_level: "low",
  liquidity: "moderate",
  typical_horizon: "short",
  return_type: "fixed_interest",
});
const IDEAS = productIdeasFrom({
  ideas: [
    PIDEA("no-penalty-cd", "account_operations", "deposits", "Gig workers avoid CDs in case they need the cash early", "No-penalty CD for gig workers"),
    PIDEA("rate-reset-cd", "account_operations", "deposits", "Savers hesitate to lock in one CD rate for two years", "Two-year CD with a rate reset"),
    PIDEA("dual-approval-mma", "account_operations", "deposits", "Nonprofit boards want two signers on reserve cash", "Two-signer nonprofit reserve"),
    PIDEA("catch-up-ira", "wealth", "retirement", "Savers over 50 miss the higher IRA limit", "IRA catch-up schedule"),
    PIDEA("payday-ira", "wealth", "retirement", "First-job workers think an IRA needs a lot to open", "Starter payday IRA"),
    PIDEA("sweep-mmf", "wealth", "mutual_funds", "Small businesses leave operating cash idle", "Business cash sweep"),
    PIDEA("tips-ladder", "credit", "bonds", "Savers want TIPS maturing on a set schedule", "TIPS ladder bundle"),
    PIDEA("tips-gift", "credit", "bonds", "Grandparents want a gift that arrives at a milestone"),
  ],
});
const APP_KINDS: AppKind[] = [
  {
    id: "savings-goals",
    title: "Savings goals",
    description: "Save toward goals.",
    productLines: ["custody_settlement"],
    goalTemplate: "A savings goals app.",
    ideas: [{ id: "two-key-household-fund", problem: "Two-adult households argue over the emergency fund", pitch: "Both approve.", goal: "A two-key fund app on the account.", productLines: ["custody_settlement"] }],
  },
];
const SINGLE_LINE = ["whitespace-nowrap", "truncate", "max-w-full", "rounded-full"];
const singleLine = (el: Element) => SINGLE_LINE.every((c) => el.classList.contains(c)) && !el.classList.contains("text-balance") && !el.classList.contains("rounded-2xl");
const productChips = () => [...document.querySelectorAll("[data-product-chip]")].map((c) => c.getAttribute("data-product-chip"));
const appChips = () => [...document.querySelectorAll("[data-chip]")].map((c) => c.getAttribute("data-chip"));

describe("product ideas in Financial product mode", () => {
  it("App mode shows app ideas; Financial product mode shows six product ideas as chips instead, one from each line first", async () => {
    productIdeas = IDEAS;
    kinds = APP_KINDS;
    await loaded();
    expect(appChips()).toEqual(["two-key-household-fund"]);
    expect(productChips()).toEqual([]);
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    const chips = productChips();
    expect(chips).toHaveLength(6);
    expect(new Set(chips).size).toBe(6);
    expect(appChips()).toEqual([]);
    const lines = chips.slice(0, 3).map((id) => IDEAS.find((i) => i.id === id)!.productLine);
    expect(new Set(lines)).toEqual(new Set(["account_operations", "wealth", "credit"]));
    // Each chip is named by its short chip label on one line (an idea without one: its product name cut to 34
    // characters), with the product name and the problem it answers as the tooltip.
    for (const id of chips) {
      const chip = document.querySelector(`[data-product-chip="${id}"]`)!;
      const idea = IDEAS.find((i) => i.id === id)!;
      expect(chip.textContent).toBe(chipText(idea.chipLabel, idea.productName));
      expect(chip.textContent!.length).toBeLessThan(35);
      expect(chip.getAttribute("title")).toBe(`${idea.productName}: ${idea.label}`);
      expect(singleLine(chip)).toBe(true);
    }
    // The app idea's chip, back in App mode: its label cut short (it has no chip label), the problem as the tooltip.
    await act(async () => void fireEvent.click(option("build")));
    await settle();
    const appChip = document.querySelector('[data-chip="two-key-household-fund"]')!;
    expect(appChip.textContent).toBe("Two-adult households argue over…");
    expect(appChip.getAttribute("title")).toBe("Two-adult households argue over the emergency fund");
    expect(singleLine(appChip)).toBe(true);
  });

  it("a chip starts the product chat with the idea as the first message, and starts no build", async () => {
    productIdeas = IDEAS;
    await loaded();
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    const id = productChips()[0]!;
    await act(async () => void fireEvent.click(document.querySelector(`[data-product-chip="${id}"]`)!));
    await settle();
    expect(sent).toEqual([productIdeaMessage(IDEAS.find((i) => i.id === id)!)]);
    expect(builds).toEqual([]);
    expect(posts).toEqual([]);
    // The chat has begun: the welcome, and its chips, are gone.
    expect(productChips()).toEqual([]);
  });

  it("Templates lists every product idea (Product, For, Product line), and Use opens the Create product sheet filled with it", async () => {
    productIdeas = IDEAS;
    await loaded();
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open Templates" })));
    await settle();
    const panel = document.querySelector('[data-panel-content="templates"]') as HTMLElement;
    expect([...panel.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["Product", "For", "Product line", ""]);
    expect(panel.querySelectorAll("[data-product-idea-row]").length).toBeGreaterThan(0);
    expect(panel.querySelector("[data-template-row]")).toBeNull();
    const row = panel.querySelector('[data-product-idea-row="no-penalty-cd"]') as HTMLElement;
    // Product is the draft name; For is the problem it answers, with the whole sentence as its tooltip.
    const cells = row.querySelectorAll("td");
    expect(cells[0].textContent).toBe("Draft no-penalty-cd");
    expect(cells[0].getAttribute("title")).toBe("A factual line about no-penalty-cd.");
    const problem = row.querySelector("[data-product-idea-problem]")!;
    expect(cells[1].contains(problem)).toBe(true);
    expect(problem.textContent).toBe("Gig workers avoid CDs in case they need the cash early");
    expect(problem.getAttribute("title")).toBe("Gig workers avoid CDs in case they need the cash early");
    expect(row.textContent).toContain("account operations");

    await act(async () => void fireEvent.click(within(row).getByRole("button", { name: "Use" })));
    await settle();
    const s = within(sheet()!);
    expect((s.getByLabelText("Name") as HTMLInputElement).value).toBe("Draft no-penalty-cd");
    expect((s.getByLabelText("Product id") as HTMLInputElement).value).toBe("draft-no-penalty-cd");
    expect((s.getByLabelText("Product line") as HTMLSelectElement).value).toBe("account_operations");
    expect((s.getByLabelText("Jurisdiction") as HTMLSelectElement).value).toBe("US");
    expect((s.getByLabelText("Category") as HTMLSelectElement).value).toBe("deposits");
    expect((s.getByLabelText("Regulator") as HTMLSelectElement).value).toBe("");
    expect((s.getByLabelText("Risk level") as HTMLSelectElement).value).toBe("low");
    expect((s.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("A factual line about no-penalty-cd.");
    expect(sent).toEqual([]);
    expect(posts).toEqual([]);

    // The firm picks the regulator and creates it with its own click: the idea's features go with it.
    fireEvent.change(s.getByLabelText("Regulator"), { target: { value: "OCC" } });
    await act(async () => void fireEvent.click(s.getByRole("button", { name: "Create product" })));
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ id: "draft-no-penalty-cd", name: "Draft no-penalty-cd", category: "deposits", region: "US", regulator: "OCC", key_features: ["no-penalty-cd feature one", "no-penalty-cd feature two"] });
  });

  it("back in App mode, Templates lists app ideas again", async () => {
    productIdeas = IDEAS;
    kinds = APP_KINDS;
    await loaded();
    await act(async () => void fireEvent.click(option("product")));
    await settle();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open Templates" })));
    await act(async () => void fireEvent.click(option("build")));
    await settle();
    const panel = document.querySelector('[data-panel-content="templates"]') as HTMLElement;
    expect(panel.querySelector('[data-template-row="two-key-household-fund"]')).not.toBeNull();
    expect(panel.querySelector("[data-product-idea-row]")).toBeNull();
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

    // The card is done and can't be sent again; the product is an Idea in Products, with Move to staging.
    expect(card.querySelector("[data-draft-created]")!.textContent).toBe("Created as an idea. Move it to staging in the Products tab.");
    expect(within(card).queryByRole("button", { name: "Review and create" })).toBeNull();
    const row = document.querySelector('[data-panel-content="products"] [data-product-row="green-savings"]') as HTMLElement;
    expect(row.querySelector("[data-product-status]")!.textContent).toBe("Idea");
    expect(within(row).getByRole("button", { name: "Move to staging" })).toBeTruthy();
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
