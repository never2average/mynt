// @vitest-environment jsdom
// The user's threads (lib/threads.ts): apps, product chats kept on Mynt (lib/chat-sessions.ts, through
// app/api/threads; a fake of it here, test/threads-fake.ts) and the user's own products, merged newest
// first. Chats an older studio kept in this browser move to Mynt once, then leave the browser. The Build page's Recent shows at most six, each labelled App or
// Financial product; View all lists every one with a search and a type filter; each kind opens in its
// place (an app's page, a product chat back in Create product, a product in the Products tab); a first
// message in Create product makes a thread. The sidebar's stage folders list apps and products together,
// each marked with its own icon and kind.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { NewAppWorkspace, type NewAppProduct } from "@/components/new-app-workspace";
import { NavFolders } from "@/components/nav-folders";
import { stagedItems } from "@/components/app-sidebar";
import { Sidebar, SidebarContent, SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatSaver, LEGACY_KEYS, migrateLocalChats, saveTiming, sessionIdFor } from "@/lib/chat-sessions";
import {
  filterThreads,
  mergeThreads,
  myProductsFrom,
  openFromSearch,
  relativeTime,
  type AppThreadSource,
  type MyProduct,
  type ProductChatRecord,
} from "@/lib/threads";
import { groupByStage } from "@/lib/workspaces";
import { fakeThreads, uuid } from "./threads-fake";

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
let server = fakeThreads();
beforeEach(() => {
  window.localStorage.clear();
  saveTiming.delayMs = 5;
  server = fakeThreads({ fallback: async (url) => (url === "/api/product-chat" ? new Response(JSON.stringify({ enabled: true }), { status: 200 }) : new Response("{}", { status: 404 })) });
});
afterEach(cleanup);

const OWNER = "owner-hash";
const msg = (id: string, role: "user" | "assistant", text: string): UIMessage => ({ id, role, parts: [{ type: "text", text }] });
const msgsOf = (id: string, title: string) => [msg(`${id}-u`, "user", title), msg(`${id}-a`, "assistant", `About ${title}`)];
const chat = (id: string, title: string, updatedAt: string, created: Record<string, string> = {}): ProductChatRecord => ({
  id,
  title,
  updatedAt,
  metadata: Object.keys(created).length ? { product_ids: Object.values(created) } : {},
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
// The same two chats as Mynt keeps them, under session ids.
const C1 = uuid("c1");
const C2 = uuid("c2");
function seedChats() {
  server.seed("product", { id: C1, title: "A green savings account", updatedAt: "2026-11-21T12:00:00Z", messages: msgsOf("c1", "A green savings account") });
  server.seed("product", {
    id: C2,
    title: "A card for students",
    updatedAt: "2026-11-18T12:00:00Z",
    messages: msgsOf("c2", "A card for students"),
    outcomes: { "draft-1": { product_id: "student-card" } },
    metadata: { product_ids: ["student-card"] },
  });
}

describe("the threads list", () => {
  it("merges apps, product chats and products, newest first, each labelled and linked", () => {
    const list = mergeThreads(APPS, CHATS, MINE);
    expect(list.map((t) => t.key)).toEqual(["app:app-2", "product:green-savings", "chat:c1", "app:app-1", "product:dollar-account", "chat:c2", "app:app-3"]);
    expect(list.map((t) => t.kind)).toEqual(["app", "product", "product", "app", "product", "product", "app"]);
    expect(list.map((t) => t.status)).toEqual(["Idea", "Idea", "Chat", "Staging", "Production", "Created", "Production"]);
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

  it("a chat's status is Created once a draft of it became a product", () => {
    expect(mergeThreads([], CHATS, []).map((t) => [t.id, t.status])).toEqual([
      ["c1", "Chat"],
      ["c2", "Created"],
    ]);
  });

  it("reads the user's own products and the Build page's address", () => {
    expect(myProductsFrom([{ id: "a", name: "A", status: "draft", updated_at: "2026-11-01" }, { id: "b", status: "published", published_at: "2026-11-02" }, { id: "c" }, { id: "s", status: "unpublished", stage: "staging" }, null, { name: "no id" }])).toEqual([
      { id: "a", name: "A", status: "draft", stage: "idea", updatedAt: "2026-11-01" },
      { id: "b", name: "b", status: "published", stage: "production", updatedAt: "2026-11-02" },
      { id: "c", name: "c", status: "published", stage: "production", updatedAt: null },
      { id: "s", name: "s", status: "unpublished", stage: "staging", updatedAt: null },
    ]);
    expect(openFromSearch("?thread=c1")).toEqual({ thread: "c1" });
    expect(openFromSearch("?product=green-savings")).toEqual({ product: "green-savings" });
    expect(openFromSearch("")).toBeNull();
  });

  it("leaves archived products (archive_product) out of Recent and the sidebar's folders", () => {
    const mine = myProductsFrom([
      { id: "a", name: "A", status: "draft" },
      { id: "devnet-demo-product", name: "Devnet demo product", status: "draft", stage: "staging", archived: true, archived_at: "2026-11-23T00:00:00Z" },
    ]);
    expect(mine.map((p) => p.id)).toEqual(["a"]);
    const folders = stagedItems({ idea: [], staging: [], production: [] }, mine)!;
    expect([...folders.idea, ...folders.staging, ...folders.production].map((i) => i.id)).toEqual(["a"]);
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
const settle = async (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const modeOf = () => document.querySelector("[data-new-app-chat]")!.getAttribute("data-mode");

function workspace(opts: { onOpenApp?: (href: string) => void; sent?: string[]; openRequest?: { thread?: string; product?: string; n: number }; owner?: string | null } = {}) {
  return (
    <NewAppWorkspace
      products={PRODUCTS}
      kinds={[]}
      onBuild={async () => null}
      fetcher={server.fetcher}
      transport={fakeTransport(opts.sent ?? [])}
      apps={APPS}
      myProducts={MINE}
      historyOwner={opts.owner === undefined ? OWNER : opts.owner}
      onOpenApp={opts.onOpenApp}
      openRequest={opts.openRequest ?? null}
    />
  );
}

describe("threads on the Build page", () => {
  it("the Build page has no Recent section or View all (threads are in the sidebar)", async () => {
    seedChats();
    render(workspace());
    await settle();
    expect(document.querySelector("[data-recent]")).toBeNull();
    expect(document.querySelector("[data-recent-thread]")).toBeNull();
    expect(screen.queryByRole("button", { name: "View all" })).toBeNull();
  });

  it("a product chat comes back in Create product with its messages, read from Mynt", async () => {
    seedChats();
    render(workspace({ openRequest: { thread: C1, n: 1 } }));
    await settle(60);
    expect(modeOf()).toBe("product");
    expect(screen.getByText("About A green savings account")).toBeTruthy();
    // Reopened, not saved again as a newer one.
    expect(server.posts).toEqual([]);
    expect(server.list("product").map((c) => [c.id, c.updatedAt])).toEqual([
      [C1, "2026-11-21T12:00:00Z"],
      [C2, "2026-11-18T12:00:00Z"],
    ]);
  });

  it("?thread= (or the sidebar) reopens a product chat once the user's key is known", async () => {
    seedChats();
    render(workspace({ openRequest: { thread: C2, n: 1 } }));
    await settle(60);
    expect(modeOf()).toBe("product");
    expect(screen.getByText("About A card for students")).toBeTruthy();
  });

  it("a product opens the Products tab on it", async () => {
    render(workspace({ openRequest: { product: "green-savings", n: 1 } }));
    await settle();
    const row = document.querySelector('[data-product-row="green-savings"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.getAttribute("data-focused")).toBe("true");
    expect((screen.getByLabelText("Search products") as HTMLInputElement).value).toBe("Green Savings");
  });

  it("a first message in Create product saves the chat on Mynt", async () => {
    const sent: string[] = [];
    render(workspace({ sent }));
    await settle();
    await act(async () => void fireEvent.click(document.querySelector('[data-mode-option="product"]') as HTMLElement));
    await settle();
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "A savings account for nurses" } });
    await act(async () => void fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" }));
    await settle(100);
    expect(sent).toEqual(["A savings account for nurses"]);
    const saved = server.list("product");
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe("A savings account for nurses");
    expect(saved[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // The question went at once, the reply once it settled: two message events, each appended once.
    expect(saved[0].events.map((e) => [e.seq, e.type, e.role])).toEqual([
      [1, "message", "user"],
      [2, "message", "assistant"],
    ]);
  });

  // The hashed key only ever keyed this browser's old copies (and /api/products may not answer with it):
  // Mynt knows the user from the session, so saving and reopening never wait on it.
  it("without the browser's hashed key, a product chat is still saved, and a ?thread= still opens", async () => {
    const sent: string[] = [];
    seedChats();
    render(workspace({ sent, owner: null, openRequest: { thread: C2, n: 1 } }));
    await settle(60);
    expect(modeOf()).toBe("product");
    expect(screen.getByText("About A card for students")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Message input"), { target: { value: "Lower the fee" } });
    await act(async () => void fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" }));
    await settle(100);
    expect(sent).toEqual(["Lower the fee"]);
    expect(server.posts.length).toBeGreaterThan(0);
    expect(server.list("product").find((c) => c.id === C2)!.messages.map((m) => m.parts[0].type === "text" && m.parts[0].text)).toEqual(["A card for students", "About A card for students", "Lower the fee", "What should it be called?"]);
  });

  it("a product picked opens the product chat that created it, with its messages, and shows the product", async () => {
    seedChats();
    render(workspace({ owner: null, openRequest: { product: "student-card", n: 1 } }));
    await settle(60);
    expect(modeOf()).toBe("product");
    expect(screen.getByText("About A card for students")).toBeTruthy();
    expect(screen.queryByText("About A green savings account")).toBeNull();
    expect(document.querySelector('[data-panel-tab][aria-selected="true"]')?.getAttribute("data-panel-tab")).toBe("products");
    // Opening it saves nothing.
    expect(server.posts).toEqual([]);
  });

  it("a product with no chat (made by hand) opens a new product chat with 'Continue with' and its name in the composer", async () => {
    seedChats();
    render(workspace({ owner: null, openRequest: { product: "green-savings", n: 1 } }));
    await settle(60);
    expect(modeOf()).toBe("product");
    expect((screen.getByLabelText("Message input") as HTMLTextAreaElement).value).toBe("Continue with Green Savings: ");
    expect(screen.queryByText("About A card for students")).toBeNull();
    const row = document.querySelector('[data-product-row="green-savings"]') as HTMLElement;
    expect(row.getAttribute("data-focused")).toBe("true");
  });

  it("from the sidebar while the page is open: a second product right after the first, then the open one again, each opens", async () => {
    seedChats();
    server.seed("product", { id: uuid("c3"), title: "Dollar account chat", updatedAt: "2026-11-22T12:00:00Z", messages: msgsOf("c3", "A dollar account"), outcomes: { d9: { product_id: "dollar-account" } }, metadata: { product_ids: ["dollar-account"] } });
    const { rerender } = render(workspace({ owner: null, openRequest: { product: "student-card", n: 1 } }));
    // The second click comes before the first has finished opening: the second wins.
    rerender(workspace({ owner: null, openRequest: { product: "dollar-account", n: 2 } }));
    await settle(80);
    expect(screen.getByText("About A dollar account")).toBeTruthy();
    expect(screen.queryByText("About A card for students")).toBeNull();
    rerender(workspace({ owner: null, openRequest: { product: "student-card", n: 3 } }));
    await settle(60);
    expect(screen.getByText("About A card for students")).toBeTruthy();
    // The one already open, clicked again, is read back again (Mynt's copy may have moved on in another tab).
    server.seed("product", { id: C2, title: "A card for students", updatedAt: "2026-11-23T12:00:00Z", messages: [...msgsOf("c2", "A card for students"), ...msgsOf("c2b", "Add a cashback")], outcomes: { "draft-1": { product_id: "student-card" } }, metadata: { product_ids: ["student-card"] } });
    rerender(workspace({ owner: null, openRequest: { product: "student-card", n: 4 } }));
    await settle(60);
    expect(screen.getByText("About Add a cashback")).toBeTruthy();
  });

  it("a product chat that can't be read says so in the chat", async () => {
    seedChats();
    server.state.down = true;
    render(workspace({ owner: null, openRequest: { thread: C1, n: 1 } }));
    await settle(60);
    expect(modeOf()).toBe("product");
    const alert = document.querySelector("[data-thread-error]")!;
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("Couldn't open that conversation. Try again.");
  });
});

// ---- saving to Mynt, and the chats an older studio kept in this browser ----

describe("product chats on Mynt", () => {
  const snap = (n: number) => ({ messages: msgsOf("n", "A savings account for nurses").slice(0, n), outcomes: {} });

  it("a save that fails is kept and sent again; what Mynt has is never sent twice", async () => {
    const saver = new ChatSaver("product", { fetcher: server.fetcher });
    server.state.down = true;
    saver.save(C1, snap(1), { now: true });
    await settle(20);
    expect(server.list("product")).toEqual([]);
    expect(saver.isPending(C1)).toBe(true);
    server.state.down = false;
    await act(async () => void (await saver.flush()));
    expect(server.list("product").map((c) => c.events.length)).toEqual([1]);
    // The same chat again: nothing to send.
    saver.save(C1, snap(1), { now: true });
    await settle(20);
    expect(server.posts).toHaveLength(1);
    // A reply: only the new message goes.
    saver.save(C1, snap(2), { now: true });
    await settle(20);
    expect(server.posts).toHaveLength(2);
    expect((server.posts[1] as { events: unknown[] }).events).toHaveLength(1);
    expect(server.list("product")[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    saver.dispose();
  });

  it("Mynt refusing a chat (too long to keep) stops trying for it, and the chat stays open", async () => {
    const saver = new ChatSaver("product", { fetcher: server.fetcher });
    server.state.refuse = true;
    saver.save(C1, snap(1), { now: true });
    await settle(20);
    saver.save(C1, snap(2), { now: true });
    await settle(20);
    expect(server.posts).toHaveLength(1);
    expect(saver.isPending(C1)).toBe(false);
    saver.dispose();
  });

  it("a refusal is told to the page; a 401 or 403 (signed out, roles being read again) is tried again, not given up on", async () => {
    const refused: string[] = [];
    let status = 403;
    const posts: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts.push(url);
      return status === 200 ? server.fetcher(url, init) : new Response(JSON.stringify({ error: "x" }), { status });
    }) as typeof fetch;
    const saver = new ChatSaver("product", { fetcher, onRefused: (id) => refused.push(id) });
    saver.save(C1, snap(1), { now: true });
    await act(async () => void (await saver.flush()));
    expect(saver.isPending(C1)).toBe(true);
    status = 401;
    await act(async () => void (await saver.flush()));
    expect(saver.isPending(C1)).toBe(true);
    status = 200;
    await act(async () => void (await saver.flush()));
    expect(server.list("product").map((c) => c.id)).toEqual([C1]);
    expect(refused).toEqual([]);
    status = 422;
    saver.save(C2, snap(1), { now: true });
    await act(async () => void (await saver.flush()));
    expect(refused).toEqual([C2]);
    saver.dispose();
  });

  it("chats an older studio kept in this browser go to Mynt once, with their drafts, then leave the browser", async () => {
    const old = [
      { id: C1, title: "A green savings account", updatedAt: "2026-11-21T12:00:00Z", messages: msgsOf("c1", "A green savings account"), created: {} },
      { id: "t-old-1", title: "A card for students", updatedAt: "2026-11-18T12:00:00Z", messages: msgsOf("c2", "A card for students"), created: { "draft-1": "student-card" } },
    ];
    const stored = JSON.stringify({ [OWNER]: old, "someone-else": [old[0]] });
    window.localStorage.setItem(LEGACY_KEYS.product, stored);
    render(workspace());
    await settle(100);
    const kept = server.list("product");
    // Oldest first, so the newest stays newest.
    expect(kept.map((c) => c.id)).toEqual([C1, sessionIdFor("t-old-1")]);
    expect(kept[1].outcomes).toEqual({ "draft-1": { product_id: "student-card" } });
    expect(kept[1].metadata).toEqual({ product_ids: ["student-card"] });
    expect(kept[0].messages).toEqual(old[0].messages);
    // Only this user's left the browser.
    expect(Object.keys(JSON.parse(window.localStorage.getItem(LEGACY_KEYS.product)!))).toEqual(["someone-else"]);
    // Run again (another tab had the same copy): nothing added twice.
    const events = kept.map((c) => c.events.length);
    window.localStorage.setItem(LEGACY_KEYS.product, stored);
    expect(await migrateLocalChats("product", OWNER, { fetcher: server.fetcher })).toBe(2);
    expect(server.list("product").map((c) => c.events.length)).toEqual(events);
    expect(window.localStorage.getItem(LEGACY_KEYS.product)).toBe(JSON.stringify({ "someone-else": [old[0]] }));
  });

  it("offline, the older chats stay in the browser for next time", async () => {
    window.localStorage.setItem(LEGACY_KEYS.product, JSON.stringify({ [OWNER]: [{ id: C1, title: "x", updatedAt: "2026-11-21T12:00:00Z", messages: msgsOf("c1", "x"), created: {} }] }));
    server.state.down = true;
    expect(await migrateLocalChats("product", OWNER, { fetcher: server.fetcher })).toBe(0);
    expect(JSON.parse(window.localStorage.getItem(LEGACY_KEYS.product)!)[OWNER]).toHaveLength(1);
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

  it("marks every app as an App", () => {
    window.localStorage.setItem("mynt_studio_folder", "staging");
    render(withSidebar(<NavFolders groups={groups} />));
    const link = screen.getByRole("link", { name: "App: Trip kitty" })
    expect(link.getAttribute("href")).toBe("/app-1");
    expect(link.getAttribute("title")).toBe("App · Staging");
    expect(link.querySelector("[data-thread-icon=app]")).not.toBeNull();
  });

  it("lists apps and financial products together in the stage folders, each with its icon and kind", () => {
    window.localStorage.setItem("mynt_studio_folder", "idea");
    const both = stagedItems(groups, MINE);
    expect(both!.production.map((i) => `${i.kind}:${i.id}`)).toEqual(["product:dollar-account", "app:app-3"]);
    render(withSidebar(<NavFolders groups={both} />));
    expect(document.querySelector("[data-sidebar=group-label]")?.textContent).toBe("Apps and products");
    const idea = [...document.querySelectorAll("[data-folder=idea] [data-thread-item]")] as HTMLElement[];
    expect(idea.map((i) => i.getAttribute("aria-label"))).toEqual(["Financial product: Green Savings", "App: Rent ready"]);
    expect(idea[0].querySelector("[data-thread-icon=product]")).not.toBeNull();
    expect(idea[1].querySelector("[data-thread-icon=app]")).not.toBeNull();
    expect(idea[0].getAttribute("title")).toBe("Financial product · Idea");
    expect(idea[0].getAttribute("href")).toBe("/new?product=green-savings");
    // No separate Financial products group; product chats aren't in the folders (they have no stage).
    expect(document.querySelector("[data-products-group]")).toBeNull();
    expect(document.querySelector("[data-thread-item^=chat]")).toBeNull();
  });

  it("picking a product there opens it in place when the Build page is open", () => {
    window.localStorage.setItem("mynt_studio_folder", "idea");
    const seen: unknown[] = [];
    const listen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("mynt:open-thread", listen);
    // jsdom can't follow the link itself.
    const stay = (e: Event) => e.preventDefault();
    document.addEventListener("click", stay);
    render(withSidebar(<NavFolders groups={stagedItems(groups, MINE)} />));
    fireEvent.click(screen.getByRole("link", { name: "Financial product: Green Savings" }));
    window.removeEventListener("mynt:open-thread", listen);
    document.removeEventListener("click", stay);
    expect(seen).toEqual([{ product: "green-savings" }]);
  });

  it("an app opens its newest build's conversation; the app or product on screen is marked active, in its folder", () => {
    window.localStorage.setItem("mynt_studio_folder", "staging");
    const withBuilds = groupByStage(APPS.map(({ id, name, stage }) => ({ id, name, stage, conversationId: id === "app-2" ? "build-9" : null })));
    const { unmount } = render(withSidebar(<NavFolders groups={stagedItems(withBuilds, MINE)} activeProductId="green-savings" />));
    // The product's folder (Ideas) is the one open, though Staging was remembered.
    const product = screen.getByRole("link", { name: "Financial product: Green Savings" });
    expect(product.getAttribute("data-active")).toBe("true");
    const app = screen.getByRole("link", { name: "App: Rent ready" });
    expect(app.getAttribute("href")).toBe("/app-2/build-9");
    expect(app.getAttribute("data-active")).toBe("false");
    unmount();
    render(withSidebar(<NavFolders groups={stagedItems(withBuilds, MINE)} activeAppId="app-2" />));
    expect(screen.getByRole("link", { name: "App: Rent ready" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByRole("link", { name: "Financial product: Green Savings" }).getAttribute("data-active")).toBe("false");
  });

  it("collapsed: the three folder icons stay; clicking one expands the sidebar on its apps and products", async () => {
    const { container } = render(withSidebar(<NavFolders groups={stagedItems(groups, MINE)} />, false));
    for (const s of ["production", "staging", "idea"]) expect(container.querySelector(`[data-folder-icon=${s}]`)).not.toBeNull();
    await act(async () => void fireEvent.click(container.querySelector("[data-folder=production] [data-sidebar=menu-button]")!));
    expect(container.querySelector("[data-slot=sidebar]")?.getAttribute("data-state")).toBe("expanded");
    expect(screen.getByRole("link", { name: "Financial product: Dollar account" })).toBeTruthy();
  });
});
