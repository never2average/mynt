// @vitest-environment jsdom
// The /new page on Earn's chat workspace: the centred "What do you want to build?" with the composer and a
// few of the kinds' app ideas as chips; the tabs on the right (Templates, Products) with their icons beside the chat corner
// while the panel is closed; the composer's Products picker sharing the selection with the Products tab; and
// sending as Build it, blocked until a product is picked (the reason is the disabled Send's tooltip, never a
// line under the composer).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pushed: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (p: string) => void pushed.push(p) }) }));

import { pickType } from "./build-type-helper";

const { default: NewAppPage } = await import("@/app/(studio)/new/page");
const { chipText } = await import("@/lib/new-app");
const { newAppCommands, pickerLabel } = await import("@/components/new-app-workspace");

const PRODUCTS = [
  { id: "p1", name: "Dollar account", productLine: "custody_settlement", by: "Lead Trust", accessMode: "open" },
  { id: "p2", name: "Bank transfers", productLine: "payments", by: "Example Money Transmitter", accessMode: "open" },
  { id: "p3", name: "Wire transfers", productLine: "payments", by: "Example Money Transmitter", accessMode: "open" },
];
const idea = (id: string, problem: string, lines: string[], chipLabel?: string) => ({ id, ...(chipLabel ? { chipLabel } : {}), problem, pitch: `What the app does about it (${id}).`, goal: `An app for this: ${problem.toLowerCase()}. The goal to start from and edit.`, productLines: lines });
const KINDS = [
  {
    id: "money-transfers",
    title: "Money transfers",
    description: "Move US dollars in and out by bank transfer or wire.",
    productLines: ["payments"],
    goalTemplate: "A money transfers app. Customers move dollars in and out.",
    ideas: [idea("trip-kitty", "Friends on a trip lose track of who owes whom", ["payments"], "Trip kitty"), idea("creator-tip-jar", "Fans have no simple way to send a creator a few dollars", ["payments"]), idea("closing-day-wire", "Homebuyers fear wiring closing funds to a fraudster", ["payments"])],
  },
  {
    id: "savings-goals",
    title: "Savings goals",
    description: "Set savings goals and put dollars aside toward each.",
    productLines: ["custody_settlement"],
    goalTemplate: "A savings goals app. Customers set goals and add money.",
    ideas: [idea("skipped-it-jar", "Money saved by skipping a coffee never actually gets saved", ["custody_settlement"], "Skipped-coffee jar"), idea("rent-ready-streak", "Renters scramble to find the full rent when it falls due", ["custody_settlement"]), idea("payday-envelopes", "Paychecks are gone before rent and groceries are covered", ["custody_settlement"]), idea("family-goal-board", "Teens saving for a first car have no shared plan with parents", ["custody_settlement"])],
  },
];
const IDEAS = KINDS.flatMap((k) => k.ideas.map((e) => ({ ...e, kind: k.id })));
const chipIds = () => [...document.querySelectorAll("[data-chat-welcome] [data-chips] [data-chip]")].map((c) => c.getAttribute("data-chip")!);
const chipOf = (kind: string) => document.querySelector(`[data-chips] [data-chip-kind="${kind}"]`) as HTMLElement;
const ideaOf = (id: string) => IDEAS.find((e) => e.id === id)!;
// What a chip says: the idea's short label, or (an idea added before chip labels) its problem cut to 34 characters.
const chipTextOf = (id: string) => {
  const e = ideaOf(id) as { chipLabel?: string; problem: string };
  return chipText(e.chipLabel, e.problem);
};
const SINGLE_LINE = ["whitespace-nowrap", "truncate", "max-w-full", "rounded-full"];
const singleLine = (el: Element) => SINGLE_LINE.every((c) => el.classList.contains(c)) && !el.classList.contains("text-balance") && !el.classList.contains("rounded-2xl");

let posted: unknown[] = [];
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
beforeEach(() => {
  posted = [];
  pushed.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
    if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: KINDS }), { status: 200 });
    if (url === "/api/apps") {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ appId: "app-1", buildId: "build-1" }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  // The Type picked is remembered per browser and kept in the address: each test starts without either.
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

const loaded = async () => {
  render(<NewAppPage />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
};
const input = () => screen.getByLabelText("Message input") as HTMLTextAreaElement;
const openTab = async (label: string) => act(async () => void fireEvent.click(screen.getByRole("button", { name: `Open ${label}` })));
const pickedCount = () => document.querySelector('[data-panel-content="products"] [data-picked-count]')!.textContent;
const tabCheckbox = (id: string) => document.querySelector(`[data-pick="${id}"]`) as HTMLInputElement;
const openPicker = async () => act(async () => void fireEvent.click(document.querySelector("[data-product-picker]")!));

describe("the New app page", () => {
  it("is Earn's chat workspace: the centred welcome with app ideas as chips, and the tabs' icons beside the chat", async () => {
    await loaded();
    expect(document.querySelector("[data-new-app-page] [data-chat-workspace]")).not.toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "What do you want to build?" })).toBeTruthy();
    // Four to six of the ideas, at least one from each kind, each named by its short chip label on one line (or its
    // problem cut short, for an idea without one), with the problem it solves as the tooltip.
    const ids = chipIds();
    expect(ids.length).toBeGreaterThanOrEqual(4);
    expect(ids.length).toBeLessThanOrEqual(6);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const chip = document.querySelector(`[data-chip="${id}"]`)!;
      expect(chip.textContent).toBe(chipTextOf(id));
      expect(chip.textContent!.length).toBeLessThan(35);
      expect(chip.getAttribute("title")).toBe(ideaOf(id).problem);
      expect(singleLine(chip)).toBe(true);
    }
    expect(new Set(ids.map((id) => ideaOf(id).kind))).toEqual(new Set(["money-transfers", "savings-goals"]));
    // Closed until a tab is picked or a message is sent; its tabs wait as icons in the chat's corner.
    expect(document.querySelector("[data-chat-workspace]")!.getAttribute("data-panel-open")).toBe("false");
    expect(screen.getByRole("button", { name: "Open Templates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Products" })).toBeTruthy();
    await openTab("Templates");
    expect(document.querySelector("[data-chat-workspace]")!.getAttribute("data-panel-open")).toBe("true");
    expect([...document.querySelectorAll("[data-panel-tab]")].map((t) => t.textContent)).toEqual(["Templates", "Products"]);
    // The chips don't change while the user looks.
    expect(chipIds()).toEqual(ids);
  });

  it("picks the chips once per page load: another load may pick others, but always from the ideas", async () => {
    const seen = new Set<string>();
    for (const r of [0.01, 0.37, 0.73, 0.99]) {
      const random = vi.spyOn(Math, "random").mockReturnValue(r);
      await loaded();
      random.mockRestore();
      for (const id of chipIds()) seen.add(id);
      cleanup();
    }
    for (const id of seen) expect(ideaOf(id)).toBeTruthy();
    expect(seen.size).toBeGreaterThan(4);
  });

  it("a Mynt with no ideas yet (not seeded, or older) offers the kinds themselves as chips", async () => {
    const bare = KINDS.map(({ ideas: _, ...k }) => k);
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
      if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: bare }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    await loaded();
    expect(chipIds()).toEqual(["money-transfers", "savings-goals"]);
    await act(async () => void fireEvent.click(document.querySelector('[data-chip="savings-goals"]')!));
    expect(input().value).toBe(KINDS[1].goalTemplate);
  });

  it("reads the route's product ideas: App mode keeps the app ideas, Financial product mode shows the product ideas", async () => {
    const productIdeas = [
      { id: "no-penalty-cd", chipLabel: "No-penalty CD for gig workers", label: "Gig workers avoid CDs in case they need the cash early", productName: "6-Month No-Penalty CD", summary: "A 6-month CD.", productLine: "account_operations", category: "deposits", region: "US", keyFeatures: ["One", "Two"] },
      { id: "tips-ladder", label: "Savers want TIPS maturing on a set schedule", productName: "TIPS Ladder Bundle", summary: "TIPS with staggered maturities.", productLine: "credit", category: "bonds", region: "US", keyFeatures: ["One", "Two"] },
    ];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
      if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: KINDS, productIdeas }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    await loaded();
    expect(chipIds().every((id) => IDEAS.some((e) => e.id === id))).toBe(true);
    expect(document.querySelector("[data-product-chip]")).toBeNull();
    await pickType("product");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // Named by the chip label, or the product name when there's none; one line each.
    const productChipEls = [...document.querySelectorAll("[data-product-chip]")];
    expect(productChipEls.map((c) => c.textContent).sort()).toEqual(["No-penalty CD for gig workers", "TIPS Ladder Bundle"]);
    expect(productChipEls.every(singleLine)).toBe(true);
    expect(chipIds()).toEqual([]);
  });

  it("lists the ideas as a table grouped by kind; Use fills the composer with its goal and picks a product of its line", async () => {
    await loaded();
    await openTab("Templates");
    const panel = document.querySelector('[data-panel-content="templates"]')!;
    expect([...panel.querySelectorAll("thead th")].map((h) => h.textContent)).toEqual(["Problem", "What the app does", "Kind", "Product lines", ""]);
    // Each kind's heading, then its ideas.
    const order = [...panel.querySelectorAll("tbody tr")].map((r) => r.getAttribute("data-template-group") ?? r.getAttribute("data-template-row"));
    expect(order.slice(0, 5)).toEqual(["money-transfers", "trip-kitty", "creator-tip-jar", "closing-day-wire", "savings-goals"]);
    expect(order.slice(5).every((id) => ideaOf(id!).kind === "savings-goals")).toBe(true);
    const row = panel.querySelector('[data-template-row="trip-kitty"]')!;
    expect([...row.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["Friends on a trip lose track of who owes whom", "What the app does about it (trip-kitty).", "Money transfers", "payments", "Use"]);
    await act(async () => void fireEvent.click(within(row as HTMLElement).getByRole("button", { name: "Use" })));
    expect(input().value).toBe(ideaOf("trip-kitty").goal);
    expect(pickedCount()).toBe("1 picked");
    expect(tabCheckbox("p2").checked).toBe(true);
    // The Products tab is filtered to the template's line.
    await act(async () => void fireEvent.click(document.querySelector('[data-panel-tab="products"]')!));
    const rows = [...document.querySelectorAll('[data-panel-content="products"] [data-product-row]')].map((r) => r.getAttribute("data-product-row"));
    expect(rows).toEqual(["p2", "p3"]);
  });

  it("a chip under the welcome does what Use does", async () => {
    await loaded();
    const chip = chipOf("savings-goals");
    await act(async () => void fireEvent.click(chip));
    expect(input().value).toBe(ideaOf(chip.getAttribute("data-chip")!).goal);
    expect(document.querySelector("[data-product-picker-label]")!.textContent).toBe("Dollar account");
  });

  it("the Products tab: a checkbox column, search, the Product line filter and the picked count", async () => {
    await loaded();
    await openTab("Products");
    const panel = document.querySelector('[data-panel-content="products"]')!;
    expect([...panel.querySelectorAll("thead th")].map((h) => h.textContent)).toEqual(["", "Product", "By", "Product line", ""]);
    expect(pickedCount()).toBe("Pick at least one");
    fireEvent.click(tabCheckbox("p1"));
    expect(pickedCount()).toBe("1 picked");
    fireEvent.change(within(panel as HTMLElement).getByLabelText("Search products"), { target: { value: "wire" } });
    expect([...panel.querySelectorAll("[data-product-row]")].map((r) => r.getAttribute("data-product-row"))).toEqual(["p3"]);
    fireEvent.change(within(panel as HTMLElement).getByLabelText("Search products"), { target: { value: "" } });
    await act(async () => void fireEvent.click(panel.querySelector("[data-filters-menu-button]")!));
    const menu = document.querySelector("[data-filters-menu]")!;
    expect(menu.querySelector("[data-facet-heading]")!.textContent).toBe("Product line");
    await act(async () => void fireEvent.click(menu.querySelector('[data-chip="payments"]')!));
    expect([...panel.querySelectorAll("[data-product-row]")].map((r) => r.getAttribute("data-product-row"))).toEqual(["p2", "p3"]);
    expect(pickedCount()).toBe("1 picked"); // picks survive filtering
  });

  it("the composer's Products picker: in the toolbar, grouped by line, and the same selection as the Products tab", async () => {
    await loaded();
    const picker = document.querySelector("[data-composer-toolbar] [data-product-picker]")!;
    expect(picker).not.toBeNull();
    expect(picker.textContent).toBe("Pick products");
    await openPicker();
    const menu = document.querySelector("[data-product-picker-menu]")!;
    expect([...menu.querySelectorAll("[data-picker-line] > p")].map((h) => h.textContent)).toEqual(["custody settlement", "payments"]);
    expect(menu.querySelector("[data-picker-count]")!.textContent).toBe("Pick at least one");
    fireEvent.click(menu.querySelector('[data-picker-option="p2"]')!);
    expect(menu.querySelector('[data-picker-option="p2"]')!.getAttribute("aria-checked")).toBe("true");
    expect(menu.querySelector("[data-picker-count]")!.textContent).toBe("1 picked");
    expect(document.querySelector("[data-product-picker-label]")!.textContent).toBe("Bank transfers");
    // Picked there, picked in the tab; picked in the tab, shown by the picker.
    await openTab("Products");
    expect(tabCheckbox("p2").checked).toBe(true);
    fireEvent.click(tabCheckbox("p3"));
    expect(document.querySelector("[data-product-picker-label]")!.textContent).toBe("Products · 2");
    expect(menu.querySelector('[data-picker-option="p3"]')!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(menu.querySelector("[data-picker-clear]")!);
    expect(pickedCount()).toBe("Pick at least one");
    expect(document.querySelector("[data-product-picker-label]")!.textContent).toBe("Pick products");
  });

  it("can't send until a product is picked, saying why as Send's tooltip only; then sending creates the app with the template's kind and opens it", async () => {
    await loaded();
    fireEvent.change(input(), { target: { value: "A savings app with round-ups for students" } });
    const send = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);
    expect(send().title).toBe("Pick at least one product to build on.");
    expect(send().getAttribute("aria-description")).toBe("Pick at least one product to build on.");
    // No line of text under the composer: the picker's "Pick products" is the cue.
    expect(document.querySelector("p[data-send-blocked]")).toBeNull();
    expect(document.querySelector("[data-new-app-chat]")!.textContent).not.toContain("Pick at least one product to build on.");
    expect(document.querySelector("[data-product-picker-label]")!.textContent).toBe("Pick products");
    // Enter doesn't send either.
    fireEvent.keyDown(input(), { key: "Enter" });
    await act(async () => undefined);
    expect(posted).toEqual([]);

    const chip = chipOf("savings-goals");
    await act(async () => void fireEvent.click(chip));
    expect(send().disabled).toBe(false);
    expect(send().getAttribute("aria-description")).toBeNull();
    await act(async () => void fireEvent.click(send()));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(posted).toEqual([{ prompt: ideaOf(chip.getAttribute("data-chip")!).goal, product_ids: ["p1"], kind: "savings-goals" }]);
    expect(pushed).toEqual(["/app-1/build-1"]);
  });

  it("a prompt too short to build from can't be sent either, and says so as Send's tooltip", async () => {
    await loaded();
    await openTab("Products");
    fireEvent.click(tabCheckbox("p1"));
    fireEvent.change(input(), { target: { value: "An app" } });
    await act(async () => undefined);
    const send = screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toMatch(/at least 10 characters/);
    expect(document.querySelector("p[data-send-blocked]")).toBeNull();
    fireEvent.keyDown(input(), { key: "Enter" });
    await act(async () => undefined);
    expect(posted).toEqual([]);
    expect(input().value).toBe("An app");
  });

  it("a build that couldn't start says why and gives the message back", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
      if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: KINDS }), { status: 200 });
      return new Response(JSON.stringify({ message: "Pick at least one product to build on." }), { status: 400 });
    });
    await loaded();
    await openTab("Products");
    fireEvent.click(tabCheckbox("p1"));
    fireEvent.change(input(), { target: { value: "A savings app with round-ups for students" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Send message" })));
    await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByRole("alert").textContent).toBe("Pick at least one product to build on.");
    expect(input().value).toBe("A savings app with round-ups for students");
    expect(pushed).toEqual([]);
  });

  it("shows skeleton rows while the products load, not a Loading line", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    render(<NewAppPage />);
    await openTab("Products");
    expect(document.querySelectorAll("[data-product-list] [data-loading]").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/Loading/);
  });
});

// The products published for US developers today, and ideas on the kinds that follow them.
const LIVE_PRODUCTS = [
  { id: "certificate-of-deposit", name: "Certificate of Deposit (CD)", productLine: "account_operations", category: "deposits", by: "Reference", accessMode: "open", jurisdictions: ["US"], status: "published" },
  { id: "money-market-account", name: "Money Market Account", productLine: "account_operations", category: "deposits", by: "Reference", accessMode: "open", jurisdictions: ["US"], status: "published" },
  { id: "401k", name: "401(k) Plan", productLine: "wealth", category: "retirement", by: "Reference", accessMode: "open", jurisdictions: ["US"], status: "published" },
  { id: "ira", name: "Individual Retirement Account (IRA)", productLine: "wealth", category: "retirement", by: "Reference", accessMode: "open", jurisdictions: ["US"], status: "published" },
  { id: "money-market-fund", name: "Money Market Fund", productLine: "wealth", category: "mutual_funds", by: "Reference", accessMode: "open", jurisdictions: ["US"], status: "published" },
];
const liveIdea = (id: string, problem: string, lines: string[], categories: string[], productNames?: string[]) => ({ ...idea(id, problem, lines), categories, ...(productNames ? { productNames } : {}) });
const LIVE_KINDS = [
  {
    id: "savings-goals",
    title: "Savings goals",
    description: "Set savings goals in a deposit account.",
    productLines: ["account_operations"],
    categories: ["deposits"],
    goalTemplate: "A savings goals app on a deposit account.",
    ideas: [liveIdea("emergency-fund", "Families have nothing set aside for a surprise bill", ["account_operations"], ["deposits"], ["Money Market Account"])],
  },
  {
    id: "retirement-account",
    title: "Retirement account",
    description: "An IRA or a 401(k) plan.",
    productLines: ["wealth"],
    categories: ["retirement"],
    goalTemplate: "A retirement account app.",
    ideas: [liveIdea("any-retirement", "Savers don't know how much room is left under the yearly limit", ["wealth"], ["retirement"])],
  },
  {
    id: "treasury-securities",
    title: "Treasury securities",
    description: "TIPS, not published here.",
    productLines: ["credit"],
    categories: ["bonds"],
    goalTemplate: "A Treasury securities app.",
    ideas: [liveIdea("tips-calendar", "Holders lose track of maturity dates", ["credit"], ["bonds"])],
  },
];

describe("New app on the live products: a chip picks its idea's products", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: LIVE_PRODUCTS }), { status: 200 });
      if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: LIVE_KINDS }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
  });
  const label = () => document.querySelector("[data-product-picker-label]")!.textContent;

  it("an idea naming one product picks it, and the picker names it with its flag", async () => {
    await loaded();
    await act(async () => void fireEvent.click(document.querySelector('[data-chip="emergency-fund"]')!));
    expect(label()).toBe("🇺🇸 Money Market Account");
    await openTab("Products");
    expect(pickedCount()).toBe("1 picked");
    expect(tabCheckbox("money-market-account").checked).toBe(true);
    expect(tabCheckbox("certificate-of-deposit").checked).toBe(false);
  });

  it("an idea naming a category picks every published product in it, and another chip replaces the picks", async () => {
    await loaded();
    await act(async () => void fireEvent.click(document.querySelector('[data-chip="any-retirement"]')!));
    expect(label()).toBe("Products · 2");
    await openTab("Products");
    expect(["401k", "ira", "money-market-fund"].map((id) => tabCheckbox(id).checked)).toEqual([true, true, false]);
    await act(async () => void fireEvent.click(document.querySelector('[data-chip="emergency-fund"]')!));
    expect(label()).toBe("🇺🇸 Money Market Account");
  });

  it("an idea with no published product isn't a chip, and its Templates row says so with Create product", async () => {
    await loaded();
    expect(chipIds().sort()).toEqual(["any-retirement", "emergency-fund"]);
    await openTab("Templates");
    const row = document.querySelector('[data-template-row="tips-calendar"]') as HTMLElement;
    expect(row.querySelector("[data-no-product]")!.textContent).toBe("No product yet");
    expect(within(row).getByRole("button", { name: "Create product" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Use" })).toBeTruthy();
    const ok = document.querySelector('[data-template-row="emergency-fund"]') as HTMLElement;
    expect(ok.querySelector("[data-no-product]")).toBeNull();
    expect(within(ok).queryByRole("button", { name: "Create product" })).toBeNull();
    // Create product opens the sheet.
    await act(async () => void fireEvent.click(within(row).getByRole("button", { name: "Create product" })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});

describe("New app's commands and picker label", () => {
  it("has /templates, /products and one command per template", () => {
    const tab = vi.fn();
    const applyKind = vi.fn();
    const commands = newAppCommands({ tab, applyKind }, KINDS);
    expect(commands.map((c) => c.name)).toEqual(["templates", "products", "money-transfers", "savings-goals"]);
    commands[1].run!();
    expect(tab).toHaveBeenCalledWith("products");
    commands[3].run!();
    expect(applyKind).toHaveBeenCalledWith(KINDS[1]);
    expect(commands[3].description).toBe("Start from Savings goals");
  });

  it("names the one product picked, counts several, and asks when there are none", () => {
    expect(pickerLabel([], PRODUCTS)).toBe("Pick products");
    expect(pickerLabel(["p2"], PRODUCTS)).toBe("Bank transfers");
    expect(pickerLabel(["p2", "p3"], PRODUCTS)).toBe("Products · 2");
  });
});
