// @vitest-environment jsdom
// The user's threads (lib/threads.ts): apps, product chats kept in this browser and the user's own
// products, merged newest first. The Build page's Recent shows at most six, each labelled App or
// Financial product; View all lists every one with a search and a type filter; each kind opens in its
// place (an app's page, a product chat back in Create product, a product in the Products tab); a first
// message in Create product makes a thread. The sidebar marks every app and product and has a Financial
// products group, its own icon when collapsed.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NewAppWorkspace, type NewAppProduct } from "@/components/new-app-workspace";
import { RecentThreads, ThreadsDialog } from "@/components/recent-threads";
import { NavFolders } from "@/components/nav-folders";
import { NavProducts } from "@/components/nav-products";
import { Sidebar, SidebarContent, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  filterThreads,
  listProductChats,
  mergeThreads,
  myProductsFrom,
  openFromSearch,
  PRODUCT_CHATS_KEY,
  relativeTime,
  saveProductChat,
  type AppThreadSource,
  type MyProduct,
  type ProductChatRecord,
} from "@/lib/threads";
import { groupByStage } from "@/lib/workspaces";

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
beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const OWNER = "owner-hash";
const msg = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const chat = (id: string, title: string, updatedAt: string, created: Record<string, string> = {}): ProductChatRecord => ({
  id,
  title,
  updatedAt,
  messages: [msg(`${id}-u`, "user", title), msg(`${id}-a`, "assistant", `About ${title}`)],
  created,
});
const APPS: AppThreadSource[] = [
  { id: "app-1", name: "Trip kitty", stage: "staging", lastActivityAt: "2026-11-20T10:00:00Z" },
  { id: "app-2", name: "Rent ready", stage: "idea", lastActivityAt: "2026-11-22T09:00:00Z" },
  { id: "app-3", name: "Old app", stage: "production", lastActivityAt: null },
];
const CHATS = [chat("c1", "A green savings account", "2026-11-21T12:00:00Z"), chat("c2", "A card for students", "2026-11-18T12:00:00Z", { "draft-1": "student-card" })];
const MINE: MyProduct[] = [
  { id: "green-savings", name: "Green Savings", status: "draft", updatedAt: "2026-11-22T08:00:00Z" },
  { id: "dollar-account", name: "Dollar account", status: "published", updatedAt: "2026-11-19T08:00:00Z" },
];
const NOW = new Date("2026-11-22T10:00:00Z");

describe("the threads list", () => {
  it("merges apps, product chats and products, newest first, each labelled and linked", () => {
    const list = mergeThreads(APPS, CHATS, MINE);
    expect(list.map((t) => t.key)).toEqual(["app:app-2", "product:green-savings", "chat:c1", "app:app-1", "product:dollar-account", "chat:c2", "app:app-3"]);
    expect(list.map((t) => t.kind)).toEqual(["app", "product", "product", "app", "product", "product", "app"]);
    expect(list.map((t) => t.status)).toEqual(["Idea", "Draft", "Chat", "Staging", "Published", "Created", "Production"]);
    expect(list.find((t) => t.key === "app:app-1")?.href).toBe("/app-1");
    expect(list.find((t) => t.key === "chat:c1")?.href).toBe("/new?thread=c1");
    expect(list.find((t) => t.key === "product:green-savings")?.href).toBe("/new?product=green-savings");
    expect(mergeThreads(null, null, null)).toEqual([]);
  });

  it("searches and filters by type", () => {
    const list = mergeThreads(APPS, CHATS, MINE);
    expect(filterThreads(list, "", "app").map((t) => t.id)).toEqual(["app-2", "app-1", "app-3"]);
    expect(filterThreads(list, "", "product")).toHaveLength(4);
    expect(filterThreads(list, "savings").map((t) => t.key)).toEqual(["product:green-savings", "chat:c1"]);
    expect(filterThreads(list, "savings", "app")).toEqual([]);
  });

  it("says when, relatively, and never shows an unknown time as a time", () => {
    expect(relativeTime("2026-11-22T09:59:30Z", NOW)).toBe("just now");
    expect(relativeTime("2026-11-22T09:55:00Z", NOW)).toBe("5 min ago");
    expect(relativeTime("2026-11-22T07:00:00Z", NOW)).toBe("3 h ago");
    expect(relativeTime("2026-11-21T09:00:00Z", NOW)).toBe("yesterday");
    expect(relativeTime("2026-11-19T09:00:00Z", NOW)).toBe("3 days ago");
    expect(relativeTime(null, NOW)).toBe("—");
    expect(relativeTime("not a date", NOW)).toBe("—");
  });

  it("keeps product chats per user in this browser, newest first", () => {
    saveProductChat(OWNER, CHATS[1]);
    saveProductChat(OWNER, CHATS[0]);
    saveProductChat("someone-else", chat("x", "Theirs", "2026-11-22T00:00:00Z"));
    expect(listProductChats(OWNER).map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(listProductChats(null)).toEqual([]);
    expect(Object.keys(JSON.parse(window.localStorage.getItem(PRODUCT_CHATS_KEY)!))).toEqual([OWNER, "someone-else"]);
  });

  it("reads the user's own products and the Build page's address", () => {
    expect(myProductsFrom([{ id: "a", name: "A", status: "draft", updated_at: "2026-11-01" }, { id: "b", status: "published", published_at: "2026-11-02" }, { id: "c" }, null, { name: "no id" }])).toEqual([
      { id: "a", name: "A", status: "draft", updatedAt: "2026-11-01" },
      { id: "b", name: "b", status: "published", updatedAt: "2026-11-02" },
      { id: "c", name: "c", status: "published", updatedAt: null },
    ]);
    expect(openFromSearch("?thread=c1")).toEqual({ thread: "c1" });
    expect(openFromSearch("?product=green-savings")).toEqual({ product: "green-savings" });
    expect(openFromSearch("")).toBeNull();
  });
});

describe("Recent and View all", () => {
  const list = mergeThreads(APPS, CHATS, MINE);

  it("Recent shows at most six, each with its type, name, status and when", () => {
    render(<RecentThreads threads={list} onOpen={() => undefined} now={NOW} />);
    const items = document.querySelectorAll("[data-recent-thread]");
    expect(items).toHaveLength(6);
    expect([...items].map((i) => i.getAttribute("data-recent-thread"))).toEqual(list.slice(0, 6).map((t) => t.key));
    const first = items[0] as HTMLElement;
    expect(first.getAttribute("aria-label")).toBe("App: Rent ready");
    expect(first.querySelector("[data-thread-kind]")?.textContent).toBe("App");
    expect(first.querySelector("[data-thread-status]")?.textContent).toBe("Idea");
    expect(first.querySelector("[data-thread-updated]")?.textContent).toBe("1 h ago");
    expect((items[1] as HTMLElement).querySelector("[data-thread-kind]")?.textContent).toBe("Financial product");
    expect(screen.getByRole("button", { name: "View all" })).toBeTruthy();
  });

  it("Recent is left out until there is a thread", () => {
    render(<RecentThreads threads={[]} onOpen={() => undefined} />);
    expect(document.querySelector("[data-recent]")).toBeNull();
  });

  it("View all lists every thread with a search box and All · Apps · Financial products", async () => {
    const onOpen = vi.fn();
    render(<RecentThreads threads={list} onOpen={onOpen} now={NOW} />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "View all" })));
    const dialog = document.querySelector("[data-dialog=threads]") as HTMLElement;
    expect(dialog).not.toBeNull();
    const rows = () => [...dialog.querySelectorAll("[data-thread-row]")].map((r) => r.getAttribute("data-thread-row"));
    expect(rows()).toEqual(list.map((t) => t.key));
    const filters = within(dialog).getByRole("radiogroup", { name: "Show" });
    expect([...filters.querySelectorAll("[role=radio]")].map((b) => b.textContent)).toEqual(["All", "Apps", "Financial products"]);
    await act(async () => void fireEvent.click(within(filters).getByRole("radio", { name: "Apps" })));
    expect(rows()).toEqual(["app:app-2", "app:app-1", "app:app-3"]);
    await act(async () => void fireEvent.click(within(filters).getByRole("radio", { name: "Financial products" })));
    expect(rows()).toEqual(["product:green-savings", "chat:c1", "product:dollar-account", "chat:c2"]);
    fireEvent.change(within(dialog).getByLabelText("Search threads"), { target: { value: "student" } });
    expect(rows()).toEqual(["chat:c2"]);
    fireEvent.change(within(dialog).getByLabelText("Search threads"), { target: { value: "nothing like it" } });
    expect(dialog.querySelector("[data-no-threads]")?.textContent).toBe("No threads match.");
  });

  it("picking a row opens it and closes the list", async () => {
    const onOpen = vi.fn();
    render(<ThreadsDialog open onOpenChange={() => undefined} threads={list} onOpen={onOpen} />);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Financial product: Green Savings" })));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ key: "product:green-savings" }));
  });
});

// ---- on the Build page ----

const PRODUCTS: NewAppProduct[] = [
  { id: "dollar-account", name: "Dollar account", productLine: "custody_settlement", by: "You", accessMode: "open", status: "published" },
  { id: "green-savings", name: "Green Savings", productLine: "account_operations", by: "You", accessMode: "", status: "draft", mine: true },
  ...Array.from({ length: 30 }, (_, i) => ({ id: `other-${i}`, name: `Other ${i}`, productLine: "payments", by: "Lead Trust", accessMode: "open", status: "published" as const })),
];
type Reply = UIMessageChunk[];
const text = (t: string): Reply => [{ type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: t }, { type: "text-end", id: "t" }];
function fakeTransport(sent: string[]): ChatTransport<UIMessage> {
  return {
    sendMessages: async ({ messages }) => {
      const last = messages[messages.length - 1];
      sent.push(last.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
      const chunks: UIMessageChunk[] = [{ type: "start" }, ...text("What should it be called?"), { type: "finish" }];
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
const fetcher = (async (url: string) => (url === "/api/product-chat" ? new Response(JSON.stringify({ enabled: true }), { status: 200 }) : new Response("{}", { status: 404 }))) as typeof fetch;
const settle = async (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const modeOf = () => document.querySelector("[data-new-app-chat]")!.getAttribute("data-mode");
const recentKeys = () => [...document.querySelectorAll("[data-recent-thread]")].map((e) => e.getAttribute("data-recent-thread"));

function workspace(opts: { onOpenApp?: (href: string) => void; sent?: string[]; openRequest?: { thread?: string; product?: string; n: number } } = {}) {
  return (
    <NewAppWorkspace
      products={PRODUCTS}
      kinds={[]}
      onBuild={async () => null}
      fetcher={fetcher}
      transport={fakeTransport(opts.sent ?? [])}
      apps={APPS}
      myProducts={MINE}
      historyOwner={OWNER}
      onOpenApp={opts.onOpenApp}
      openRequest={opts.openRequest ?? null}
    />
  );
}

describe("threads on the Build page", () => {
  it("Recent sits under the welcome, above the idea chips; an app opens its page", async () => {
    for (const c of CHATS) saveProductChat(OWNER, c);
    const onOpenApp = vi.fn();
    render(workspace({ onOpenApp }));
    await settle();
    const welcome = document.querySelector("[data-chat-welcome]")!;
    expect(welcome.querySelector("[data-recent]")).not.toBeNull();
    expect(recentKeys()).toHaveLength(6);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "App: Rent ready" })));
    expect(onOpenApp).toHaveBeenCalledWith("/app-2");
  });

  it("a product chat comes back in Create product with its messages", async () => {
    for (const c of CHATS) saveProductChat(OWNER, c);
    render(workspace());
    await settle();
    expect(modeOf()).toBe("build");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Financial product: A green savings account" })));
    await settle();
    expect(modeOf()).toBe("product");
    expect(screen.getByText("About A green savings account")).toBeTruthy();
    // Reopened, not saved again as a newer one.
    expect(listProductChats(OWNER).map((c) => [c.id, c.updatedAt])).toEqual([
      ["c1", CHATS[0].updatedAt],
      ["c2", CHATS[1].updatedAt],
    ]);
  });

  it("?thread= (or the sidebar) reopens a product chat once the user's key is known", async () => {
    saveProductChat(OWNER, CHATS[1]);
    render(workspace({ openRequest: { thread: "c2", n: 1 } }));
    await settle();
    expect(modeOf()).toBe("product");
    expect(screen.getByText("About A card for students")).toBeTruthy();
  });

  it("a product opens the Products tab on it", async () => {
    render(workspace());
    await settle();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Financial product: Green Savings" })));
    await settle();
    const row = document.querySelector('[data-product-row="green-savings"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("data-focused")).toBe("true");
    expect((screen.getByLabelText("Search products") as HTMLInputElement).value).toBe("Green Savings");
  });

  it("a first message in Create product makes a thread that's in Recent next time", async () => {
    const sent: string[] = [];
    render(workspace({ sent }));
    await settle();
    expect(recentKeys().some((k) => k?.startsWith("chat:"))).toBe(false);
    await act(async () => void fireEvent.click(document.querySelector('[data-mode-option="product"]') as HTMLElement));
    await settle();
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "A savings account for nurses" } });
    await act(async () => void fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" }));
    await settle(60);
    expect(sent).toEqual(["A savings account for nurses"]);
    const saved = listProductChats(OWNER);
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe("A savings account for nurses");
    expect(saved[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    cleanup();
    render(workspace());
    await settle();
    expect(recentKeys()[0]).toBe(`chat:${saved[0].id}`);
    expect(screen.getByRole("button", { name: "Financial product: A savings account for nurses" })).toBeTruthy();
  });
});

// ---- the sidebar ----

const withSidebar = (ui: React.ReactNode, open = true) => (
  <TooltipProvider>
    <SidebarProvider defaultOpen={open}>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarContent>{ui}</SidebarContent>
      </Sidebar>
    </SidebarProvider>
  </TooltipProvider>
);

describe("the sidebar's threads", () => {
  const groups = groupByStage(APPS.map(({ id, name, stage }) => ({ id, name, stage })));
  const products = mergeThreads([], CHATS, MINE);

  it("marks every app as an App", () => {
    window.localStorage.setItem("mynt_studio_folder", "staging");
    render(withSidebar(<NavFolders groups={groups} />));
    const link = screen.getByRole("link", { name: "App: Trip kitty" })
    expect(link.getAttribute("href")).toBe("/app-1");
    expect(link.getAttribute("title")).toBe("App · Staging");
    expect(link.querySelector("[data-thread-icon=app]")).not.toBeNull();
  });

  it("has a Financial products group listing products and product chats, each marked with its status", () => {
    render(withSidebar(<NavProducts threads={products} />));
    expect(document.querySelector("[data-products-group] [data-sidebar=group-label]")?.textContent).toBe("Financial products");
    const items = [...document.querySelectorAll("[data-products-group] [data-thread-item]")] as HTMLElement[];
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
      "Financial product: Green Savings",
      "Financial product: A green savings account",
      "Financial product: Dollar account",
      "Financial product: A card for students",
    ]);
    expect(items.every((i) => i.querySelector("[data-thread-icon=product]"))).toBe(true);
    expect(items.map((i) => i.getAttribute("title"))).toEqual(["Financial product · Draft", "Financial product · Chat", "Financial product · Published", "Financial product · Created"]);
    expect(items[1].getAttribute("href")).toBe("/new?thread=c1");
    expect(items[0].getAttribute("href")).toBe("/new?product=green-savings");
  });

  it("picking a product chat there opens it in place when the Build page is open", () => {
    const seen: unknown[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("mynt:open-thread", listen);
    // jsdom can't follow the link itself.
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener("click", stay);
    render(withSidebar(<NavProducts threads={products} />));
    fireEvent.click(screen.getByRole("link", { name: "Financial product: A green savings account" }));
    window.removeEventListener("mynt:open-thread", listen);
    document.removeEventListener("click", stay);
    expect(seen).toEqual([{ thread: "c1" }]);
  });

  it("collapsed: the apps' folder icons and the products' own icon tell them apart; clicking it expands the group", async () => {
    window.localStorage.setItem("mynt_studio_products_open", "0");
    const { container } = render(
      withSidebar(
        <>
          <NavFolders groups={groups} />
          <NavProducts threads={products} />
        </>,
        false,
      ),
    );
    for (const s of ["production", "staging", "idea"]) expect(container.querySelector(`[data-folder-icon=${s}]`)).not.toBeNull();
    expect(container.querySelector("[data-products-icon]")).not.toBeNull();
    await act(async () => void fireEvent.click(container.querySelector("[data-products-folder] [data-sidebar=menu-button]")!));
    expect(container.querySelector("[data-slot=sidebar]")?.getAttribute("data-state")).toBe("expanded");
    expect(container.querySelector("[data-products-folder]")?.getAttribute("data-open")).toBe("true");
    expect(screen.getByRole("link", { name: "Financial product: Green Savings" })).toBeTruthy();
  });
});
