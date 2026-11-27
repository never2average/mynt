// @vitest-environment jsdom
// A financial product's own workspace (/products/<id>), laid out as an app's: the header with the product's
// name and stage and its labelled actions (Move to staging / Move to production / Move back, Archive or
// Unarchive), each opening its sheet; the product's chat on the left (the product chat whose draft made it,
// read back from Mynt, else a new one seeded "Continue with <name>: "); the seven tabs on the right, live,
// each saying why when Mynt can't answer. Then the wiring: the sidebar's product items link here and are
// marked active here, search finds products, a product created on the Build page opens here, and
// /new?product=<id> redirects here.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pickType } from "./build-type-helper";

const nav = { pushed: [] as string[], replaced: [] as string[] };
vi.mock("next/navigation", () => ({
  usePathname: () => "/products/green-savings",
  useRouter: () => ({ push: (p: string) => void nav.pushed.push(p), replace: (p: string) => void nav.replaced.push(p), prefetch: () => undefined, back: () => undefined }),
}));

const { ProductHeader, ProductWorkspace, productTabCommands } = await import("@/components/product-workspace");
const { NewAppWorkspace } = await import("@/components/new-app-workspace");
const { SidebarView } = await import("@/components/app-sidebar");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { PRODUCT_TABS, PRODUCT_TAB_LABELS } = await import("@/lib/product-panel");
const { isAppPath, isProductPath, pageTitle, searchIndex, searchStudio } = await import("@/lib/studio-search");
const { productHref, productIdOfPath } = await import("@/lib/threads");
const { groupByStage } = await import("@/lib/workspaces");
const { DRAFT_PRODUCT, validateProductDraft } = await import("@/lib/product-chat");
const { fakeThreads, uuid } = await import("./threads-fake");
type WorkspaceProduct = import("@/lib/product-panel").WorkspaceProduct;

vi.setConfig({ testTimeout: 20_000 });

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

const GREEN: WorkspaceProduct = { id: "green-savings", name: "Green Savings", stage: "idea", archived: false, productLine: "account_operations", category: "deposits", region: "US" };
const NOT_YET_REASON: Record<string, string> = {
  terms: "This product has no v2 definition yet.",
  customers: "This product has no v2 definition yet.",
  apps: "Mynt didn't answer with your apps.",
};

// The studio's API for these tests: the product, its tabs (each "not available", or a section that isn't),
// the product chat's assistant switch, and the chats kept on Mynt (test/threads-fake.ts).
let product: WorkspaceProduct;
let tabReads: string[];
let threads: ReturnType<typeof fakeThreads>;
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function api(url: string, init?: RequestInit): Promise<Response> {
  const path = url.split("?")[0];
  const tab = new URLSearchParams(url.split("?")[1] ?? "").get("tab");
  if (path === `/api/products/${GREEN.id}/panel`) {
    if (!tab) return Promise.resolve(ok({ product }));
    tabReads.push(tab);
    if (NOT_YET_REASON[tab]) return Promise.resolve(ok({ product, tab, data: { available: false, reason: NOT_YET_REASON[tab] } }));
    return Promise.resolve(ok({ product, tab, data: { available: true, sections: [{ id: `${tab}-s`, title: `${tab} section`, columns: ["A"], rows: null, reason: `Mynt can't read ${tab} yet.` }] } }));
  }
  if (path === "/api/product-chat") return Promise.resolve(ok({ enabled: true }));
  if (path === "/api/products/options") return Promise.resolve(ok({ regions: [{ code: "US", name: "United States", regulators: ["OCC"] }], categories: [{ id: "deposits", name: "Deposits", productLines: ["account_operations"] }] }));
  if (path === "/api/products" && init?.method === "POST") {
    const body = JSON.parse(String(init.body));
    return Promise.resolve(ok({ product: { id: body.id, name: body.name, productLine: body.product_line, by: "You", accessMode: "", jurisdictions: [body.region], status: "draft", mine: true } }, 201));
  }
  return Promise.resolve(ok({}, 404));
}
beforeEach(() => {
  product = { ...GREEN };
  tabReads = [];
  nav.pushed = [];
  nav.replaced = [];
  threads = fakeThreads({ fallback: api });
  vi.stubGlobal("fetch", threads.fetcher);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

// The product assistant, faked.
const text = (t: string): UIMessageChunk[] => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }];
function fakeTransport(sent: string[], replies: UIMessageChunk[][]): ChatTransport<UIMessage> {
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

const settle = async (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const withProviders = (ui: React.ReactNode) => (
  <TooltipProvider>
    <SidebarProvider>{ui}</SidebarProvider>
  </TooltipProvider>
);
const open = async (transport?: ChatTransport<UIMessage>) => {
  render(withProviders(<ProductWorkspace productId={GREEN.id} isMobile={false} transport={transport ?? fakeTransport([], [])} />));
  await settle();
  await settle();
};
const input = () => screen.getByLabelText("Message input") as HTMLTextAreaElement;
const header = () => document.querySelector("[data-product-header]") as HTMLElement;
const tabButton = (t: string) => document.querySelector(`[data-panel-tab="${t}"]`) as HTMLElement;

describe("the header", () => {
  const view = (p: WorkspaceProduct) =>
    render(withProviders(<ProductHeader product={p} onMove={() => undefined} onArchive={() => undefined} onBack={() => undefined} />)).container.querySelector("[data-product-actions]") as HTMLElement;
  const labels = (el: HTMLElement) => within(el).queryAllByRole("button").map((b) => b.textContent);

  it("names the product and its stage, with the labelled actions for that stage", () => {
    const idea = view(GREEN);
    expect(screen.getByRole("heading", { name: "Green Savings" })).toBeTruthy();
    expect(document.querySelector("[data-product-stage]")!.textContent).toBe("Ideas");
    expect(labels(idea)).toEqual(["Move to staging", "Archive"]);
    cleanup();
    expect(labels(view({ ...GREEN, stage: "staging" }))).toEqual(["Move to production", "Move back", "Archive"]);
    cleanup();
    // In production: only Move back (archiving needs it moved back first).
    expect(labels(view({ ...GREEN, stage: "production" }))).toEqual(["Move back"]);
    cleanup();
    expect(labels(view({ ...GREEN, archived: true }))).toEqual(["Unarchive"]);
    expect(document.querySelector("[data-product-archived]")!.textContent).toBe("Archived");
  });

  it("each action opens its sheet; Back goes to Build", async () => {
    await open();
    await act(async () => void fireEvent.click(within(header()).getByRole("button", { name: "Move to staging" })));
    await settle();
    const stageSheet = document.querySelector("[data-product-stage-sheet]") as HTMLElement;
    expect(stageSheet).not.toBeNull();
    expect(within(stageSheet).getByText("Move to staging: Green Savings")).toBeTruthy();
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle();
    await act(async () => void fireEvent.click(within(header()).getByRole("button", { name: "Archive" })));
    await settle();
    expect(document.querySelector('[data-product-archive-sheet="archive"]')).not.toBeNull();
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle();
    await act(async () => void fireEvent.click(within(header()).getByRole("button", { name: "Back to Build" })));
    expect(nav.pushed).toContain("/new");
  });
});

describe("the tabs", () => {
  it("are the seven, in order, Terms first; only the one on screen is read, with when", async () => {
    await open();
    expect([...document.querySelectorAll("[data-panel-tab]")].map((t) => t.textContent)).toEqual(["Terms", "Customers", "Risk", "Compliance", "Integrations", "Apps", "Activity"]);
    expect(PRODUCT_TABS.map((t) => PRODUCT_TAB_LABELS[t])).toEqual(["Terms", "Customers", "Risk", "Compliance", "Integrations", "Apps", "Activity"]);
    expect(tabReads).toEqual(["terms"]);
    expect(document.querySelector('[data-product-tab="terms"] [data-updated]')!.textContent).toMatch(/^Updated \d+s ago$/);
  });

  it("each says why when Mynt can't answer: the whole tab, or a section of it; never an empty table", async () => {
    await open();
    for (const t of PRODUCT_TABS) {
      await act(async () => void fireEvent.click(tabButton(t)));
      await settle();
      const panel = document.querySelector(`[data-product-tab="${t}"]`) as HTMLElement;
      if (NOT_YET_REASON[t]) expect(panel.querySelector("[data-not-yet]")!.textContent).toBe(`Not available yet. ${NOT_YET_REASON[t]}`);
      else expect(panel.querySelector("[data-not-available]")!.textContent).toBe(`Not available. Mynt can't read ${t} yet.`);
      expect(panel.querySelector("table")).toBeNull();
    }
    expect(tabReads).toEqual([...PRODUCT_TABS]);
  });

  it("a section Mynt answered is a table; an answered empty list says there are none", async () => {
    const { ProductTabBody } = await import("@/components/product-workspace");
    render(
      <ProductTabBody
        data={{
          available: true,
          sections: [
            { id: "apps", title: "Apps built on this product", columns: ["App", "Stage"], rows: [{ key: "a1", href: "/a1", cells: ["Saver", "Staging"] }], empty: "None" },
            { id: "fees", title: "Fees", columns: ["Fee"], rows: [], empty: "The definition declares no fees." },
          ],
        }}
      />,
    );
    const apps = document.querySelector('[data-tab-section="apps"]') as HTMLElement;
    expect(within(apps).getByRole("link", { name: "Saver" }).getAttribute("href")).toBe("/a1");
    expect(document.querySelector('[data-tab-section="fees"] [data-none]')!.textContent).toBe("The definition declares no fees.");
    expect(document.querySelector('[data-tab-section="fees"] table')).toBeNull();
  });

  it("the chat's slash commands show each tab", async () => {
    const shown: string[] = [];
    expect(productTabCommands((t) => shown.push(t)).map((c) => `/${c.name}`)).toEqual(["/terms", "/customers", "/risk", "/compliance", "/integrations", "/apps", "/activity"]);
    await open();
    fireEvent.change(input(), { target: { value: "/ris" } });
    await settle();
    await act(async () => void fireEvent.click(document.querySelector('[data-slash-menu] [data-slash-command="risk"]') as HTMLElement));
    await settle();
    expect(tabButton("risk").getAttribute("aria-selected")).toBe("true");
    expect(tabReads).toContain("risk");
  });
});

describe("the chat", () => {
  it("is the product chat whose draft made the product, read back from Mynt", async () => {
    threads.seed("product", {
      id: uuid(1),
      title: "A savings account",
      updatedAt: "2026-11-20T10:00:00.000Z",
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "A savings account that rounds up card spend" }] },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "Here is Green Savings." }] },
      ],
      outcomes: { "draft-1": { product_id: "green-savings" } },
      metadata: { product_ids: ["green-savings"] },
    });
    await open();
    expect(document.querySelector("[data-product-workspace-chat]")!.getAttribute("data-chat-state")).toBe("restored");
    expect(document.body.textContent).toContain("Here is Green Savings.");
    expect(input().value).toBe("");
  });

  it("a product made without a chat gets a new one, seeded with its name, kept on Mynt tagged with the product", async () => {
    const sent: string[] = [];
    await open(fakeTransport(sent, [text("Sure: what should change?")]));
    expect(document.querySelector("[data-product-workspace-chat]")!.getAttribute("data-chat-state")).toBe("new");
    expect(input().value).toBe("Continue with Green Savings: ");
    fireEvent.change(input(), { target: { value: "Continue with Green Savings: add a bonus rate" } });
    await act(async () => void fireEvent.keyDown(input(), { key: "Enter" }));
    await settle(600);
    expect(sent).toEqual(["Continue with Green Savings: add a bonus rate"]);
    const kept = threads.list("product");
    expect(kept).toHaveLength(1);
    expect(kept[0].metadata).toEqual({ product_ids: ["green-savings"] });
  });
});

describe("the wiring", () => {
  it("the sidebar's product items link to the product's workspace, and it's marked active there", () => {
    const PERSONAL = { id: "personal", name: "Personal", role: "owner" as const, implicit: true };
    const groups = groupByStage([{ id: "app-1", name: "Saver", stage: "idea" }]);
    render(
      withProviders(
        <SidebarView
          workspaces={[PERSONAL]}
          selected={PERSONAL}
          supported={false}
          groups={groups}
          account={{ name: "Sam", email: null }}
          pathname="/products/green-savings"
          onSelectWorkspace={() => undefined}
          onCreateWorkspace={async () => null}
          products={[{ id: "green-savings", name: "Green Savings", status: "draft", stage: "idea", updatedAt: null }]}
        />,
      ),
    );
    const link = screen.getByRole("link", { name: "Financial product: Green Savings" });
    expect(link.getAttribute("href")).toBe("/products/green-savings");
    expect(link.getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("link", { name: "App: Saver" }).getAttribute("data-active")).toBe("false");
    expect(productHref("green savings")).toBe("/products/green%20savings");
    expect([productIdOfPath("/products/green-savings"), productIdOfPath("/products"), productIdOfPath("/green-savings")]).toEqual(["green-savings", undefined, undefined]);
  });

  it("a product's workspace has its own header (no page title), isn't an app, and search finds products", () => {
    expect(pageTitle("/products/green-savings")).toBeNull();
    expect(isProductPath("/products/green-savings")).toBe(true);
    expect(isAppPath("/products/green-savings")).toBe(false);
    expect(isAppPath("/app-1")).toBe(true);
    const items = searchIndex({ products: [{ id: "green-savings", name: "Green Savings", stage: "idea" }] });
    const hit = searchStudio(items, "green").find((i) => i.group === "Financial products");
    expect(hit).toMatchObject({ label: "Green Savings", hint: "Ideas", href: "/products/green-savings" });
  });

  it("/new?product=<id> redirects to the product's workspace", async () => {
    const { default: NewAppPage } = await import("@/app/(studio)/new/page");
    window.history.replaceState(null, "", "/new?product=green-savings");
    render(withProviders(<NewAppPage />));
    await settle();
    expect(nav.replaced).toEqual(["/products/green-savings"]);
  });

  it("a product created on the Build page from the chat's draft opens its workspace, once the chat is kept as the one that made it", async () => {
    const OPTIONS = { regions: [{ code: "US", name: "United States", regulators: ["OCC"] }], categories: [{ id: "deposits", name: "Deposits", productLines: ["account_operations"] }] };
    const input0 = { name: "Green Savings", product_line: "account_operations", category: "deposits", region: "US", regulator: "OCC", action: "issuance", risk_level: "low", liquidity: "high", typical_horizon: "short", return_type: "fixed_interest", description: "A savings account that rounds up card spend.", key_features: ["Round-ups"] };
    const { draft } = validateProductDraft(input0, { ...OPTIONS, buildable: [], mine: [] }, "draft-1") as { draft: { id: string } };
    const opened: string[] = [];
    const replies: UIMessageChunk[][] = [[...text("Here's the draft."), { type: "tool-input-available", toolCallId: "c1", toolName: DRAFT_PRODUCT, input: input0 }, { type: "tool-output-available", toolCallId: "c1", output: { ok: true, draft } }]];
    function Harness() {
      const [transport] = useState(() => fakeTransport([], replies));
      return <NewAppWorkspace products={[]} kinds={[]} onBuild={async () => null} fetcher={threads.fetcher} transport={transport} onOpenProduct={(id) => opened.push(id)} />;
    }
    render(<Harness />);
    await settle();
    await pickType("product");
    await settle();
    fireEvent.change(input(), { target: { value: "A savings account that rounds up card spend" } });
    await act(async () => void fireEvent.keyDown(input(), { key: "Enter" }));
    await settle(100);
    const card = document.querySelector('[data-product-draft="draft-1"]') as HTMLElement;
    await act(async () => void fireEvent.click(within(card).getByRole("button", { name: "Review and create" })));
    await settle();
    const sheet = document.querySelector("[data-create-product-sheet]") as HTMLElement;
    await act(async () => void fireEvent.click(within(sheet).getByRole("button", { name: "Create product" })));
    await settle(200);
    expect(opened).toEqual(["green-savings"]);
    // The chat that drafted it is kept with the product, so the workspace opens on it.
    const kept = threads.list("product");
    expect(kept[0].metadata).toEqual({ product_ids: ["green-savings"] });
    expect(kept[0].outcomes).toEqual({ "draft-1": { product_id: "green-savings" } });
  });
});
