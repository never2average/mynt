// @vitest-environment jsdom
// New app's products: each shows the flags of the countries it's offered in (from Mynt's region and the
// jurisdictions it lists), in the composer's picker, its single-product label and the Products tab.
// Create product (the picker's last item, the tab's button, /create-product) opens one sheet with
// create_product's inputs; the new product is listed as an Idea, can't be picked until it's in Staging,
// and moves between stages from its row through the approval sheet (Mynt's checks, a test run there,
// Move to staging / Move to production / Move back), with Mynt's refusals in its words.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pushed: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (p: string) => void pushed.push(p) }) }));
vi.setConfig({ testTimeout: 20_000 });

const { default: NewAppPage } = await import("@/app/(studio)/new/page");
const { newAppCommands, pickerLabel } = await import("@/components/new-app-workspace");
const { countryOf, flagEmoji, flagsFor, NewProductRequest, productsFrom, slugFromName, testSummary, PRODUCT_SLUG } = await import("@/lib/products");

const PRODUCTS = [
  { id: "p1", name: "Dollar account", productLine: "custody_settlement", by: "Lead Trust", accessMode: "open", jurisdictions: ["US"], status: "published" },
  { id: "p2", name: "Bank transfers", productLine: "payments", by: "Example Money Transmitter", accessMode: "open", jurisdictions: ["US", "us-ny", "CA"], status: "published" },
  { id: "p3", name: "Wire transfers", productLine: "payments", by: "Example Money Transmitter", accessMode: "open", jurisdictions: ["global"], status: "published" },
  { id: "my-draft", name: "My savings", productLine: "account_operations", by: "You", accessMode: "", jurisdictions: ["US"], status: "draft", mine: true },
  { id: "my-staged", name: "My card", productLine: "payments", by: "You", accessMode: "open", jurisdictions: ["US"], status: "unpublished", stage: "staging", mine: true },
];
const check = (id: string, status: string, detail: string) => ({ id, label: id, status, detail });
const checksFor = (to: string, can: boolean, checks: unknown[]) => ({ checks: { appId: "", fromStage: null, toStage: to, checks, canPromote: can, needsAdminSignoff: false, signoff: null } });
const OPTIONS = {
  regions: [{ code: "US", name: "United States", regulators: ["FinCEN", "OCC"] }],
  categories: [
    { id: "deposits", name: "Deposits", productLines: ["account_operations"] },
    { id: "loans", name: "Loans", productLines: ["credit"] },
  ],
};

type Call = { url: string; body: unknown };
let calls: Call[] = [];
let publishReply: { status: number; body: unknown } = { status: 200, body: { ok: true, message: "Moved." } };
let checksReply: unknown = null;
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
  calls = [];
  pushed.length = 0;
  publishReply = { status: 200, body: { ok: true, message: "Moved." } };
  checksReply = checksFor("staging", true, [check("tests_passed", "pass", "Mynt's checks passed")]);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") calls.push({ url, body });
    if (url === "/api/products/options") return new Response(JSON.stringify(OPTIONS), { status: 200 });
    if (url === "/api/products" && init?.method === "POST")
      return new Response(JSON.stringify({ product: { id: body.id, name: body.name, productLine: body.product_line, by: "You", accessMode: "", jurisdictions: [body.region], status: "draft", mine: true } }), { status: 201 });
    if (url.startsWith("/api/products/my-") || url.startsWith("/api/products/green-savings")) {
      if (url.includes("?to=")) return new Response(JSON.stringify(checksReply), { status: 200 });
      if (body?.action === "test") return new Response(JSON.stringify({ passed: true, message: "Tests passed. You can move it on." }), { status: 200 });
      return new Response(JSON.stringify(publishReply.body), { status: publishReply.status });
    }
    if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
    if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = async (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const loaded = async () => {
  render(<NewAppPage />);
  await settle();
};
const openTab = async (label: string) => act(async () => void fireEvent.click(screen.getByRole("button", { name: `Open ${label}` })));
const openPicker = async () => act(async () => void fireEvent.click(document.querySelector("[data-product-picker]")!));
const sheet = () => document.querySelector("[data-create-product-sheet]") as HTMLElement | null;
const flagsIn = (el: Element | null) => [...(el?.querySelectorAll("[data-flag]") ?? [])].map((f) => f.getAttribute("data-flag"));
const tabRow = (id: string) => document.querySelector(`[data-panel-content="products"] [data-product-row="${id}"]`) as HTMLElement;
const tabCheckbox = (id: string) => document.querySelector(`[data-pick="${id}"]`) as HTMLInputElement;

describe("flags", () => {
  it("turn an ISO 3166-1 alpha-2 code into its regional-indicator flag", () => {
    expect(flagEmoji("US")).toBe("🇺🇸");
    expect(flagEmoji("in")).toBe("🇮🇳");
    expect(flagsFor(["US"]).map((f) => f.emoji)).toEqual(["🇺🇸"]);
    expect(flagsFor(["US"])[0].name).toBe("United States");
    // Any assigned country, not a short table.
    expect(flagsFor(["NZ", "BR", "KE", "JP"]).map((f) => f.emoji)).toEqual(["🇳🇿", "🇧🇷", "🇰🇪", "🇯🇵"]);
  });

  it("show each country of a product with several jurisdictions once, states as their country", () => {
    expect(flagsFor(["US", "us-ny", "us-ca", "CA", "gb"]).map((f) => f.code)).toEqual(["US", "CA", "GB"]);
    expect(countryOf("us-ny")).toBe("US");
    expect(countryOf("UK")).toBe("GB");
  });

  it("show nothing for global or an unknown code, never a wrong flag", () => {
    for (const j of ["global", "", "USA", "XX", "ZZ", "QO", "AA", "EZ", "1A", "u-s"]) expect(countryOf(j)).toBeNull();
    expect(flagsFor(["global", "XX"])).toEqual([]);
  });

  it("carry the category Mynt gives (what an app idea picks by), and none when it gives none", () => {
    const products = productsFrom(
      [
        { id: "money-market-account", name: "Money Market Account", product_line: "account_operations", category: "deposits", region: "US" },
        { id: "older", name: "Older", product_line: "account_operations", region: "US" },
      ],
      [{ id: "d", name: "Draft", product_line: "wealth", category: "retirement", region: "US", status: "draft" }],
    );
    expect(products.map((p) => [p.id, p.category])).toEqual([
      ["money-market-account", "deposits"],
      ["older", undefined],
      ["d", "retirement"],
    ]);
    expect("category" in products[1]).toBe(false);
  });

  it("come from Mynt's region and any jurisdictions it lists; the user's drafts follow what they can build on", () => {
    const products = productsFrom(
      [
        { id: "a", name: "A", product_line: "payments", region: "US", offered_in: ["us-ny", "us-ca"], by: "Firm", access_mode: "open" },
        { id: "mine-live", name: "Live", product_line: "credit", region: "US" },
      ],
      [
        { id: "mine-live", name: "Live", product_line: "credit", region: "US", status: "published" },
        { id: "d", name: "Draft one", product_line: "credit", region: "CA", status: "draft", last_test_passed: null },
      ],
    );
    expect(products.map((p) => [p.id, p.status, p.jurisdictions])).toEqual([
      ["a", "published", ["US", "us-ny", "us-ca"]],
      ["mine-live", "published", ["US"]],
      ["d", "draft", ["CA"]],
    ]);
    expect(products.map((p) => p.stage)).toEqual(["production", "production", "idea"]);
    expect(products[1].mine).toBe(true);
    expect(products[2]).toMatchObject({ mine: true, by: "You" });
  });
});

describe("the picker and the Products tab show flags", () => {
  it("before each product's name in the composer's picker, with headings once per line", async () => {
    await loaded();
    await openPicker();
    const menu = document.querySelector("[data-product-picker-menu]")!;
    expect([...menu.querySelectorAll("[data-picker-line] > p")].map((h) => h.textContent)).toEqual(["account operations", "custody settlement", "payments"]);
    expect(flagsIn(menu.querySelector('[data-picker-option="p1"]'))).toEqual(["US"]);
    expect(flagsIn(menu.querySelector('[data-picker-option="p2"]'))).toEqual(["US", "CA"]);
    expect(flagsIn(menu.querySelector('[data-picker-option="p3"]'))).toEqual([]);
    expect(menu.querySelector('[data-picker-option="p1"]')!.textContent).toBe("🇺🇸Dollar account");
    // The button's label for one product carries its flags too.
    fireEvent.click(menu.querySelector('[data-picker-option="p2"]')!);
    expect(document.querySelector("[data-product-picker-label]")!.textContent).toBe("🇺🇸 🇨🇦 Bank transfers");
    expect(pickerLabel(["p3"], PRODUCTS as never)).toBe("Wire transfers");
  });

  it("before each product's name in the Products tab", async () => {
    await loaded();
    await openTab("Products");
    expect(flagsIn(tabRow("p1"))).toEqual(["US"]);
    expect(flagsIn(tabRow("p2"))).toEqual(["US", "CA"]);
    expect(flagsIn(tabRow("p3"))).toEqual([]);
    expect(tabRow("p2").querySelector('[data-flag="CA"]')!.getAttribute("aria-label")).toBe("Canada");
  });
});

describe("a product's stage", () => {
  const productSheet = () => document.querySelector("[data-product-stage-sheet]") as HTMLElement | null;
  it("shows as an Idea (as apps show their stage) and can't be picked, saying why", async () => {
    await loaded();
    await openTab("Products");
    const status = tabRow("my-draft").querySelector("[data-product-status]")!;
    expect(status.textContent).toBe("Idea");
    expect(status.closest("[data-slot=badge]")).toBeNull();
    expect(tabRow("p1").querySelector("[data-product-status] [data-tone=green]")!.textContent).toBe("Production");
    expect(tabRow("my-staged").querySelector("[data-product-status] [data-tone=amber]")!.textContent).toBe("Staging");
    expect(tabCheckbox("my-draft").disabled).toBe(true);
    expect(tabCheckbox("my-draft").title).toBe("Move this product to staging before building on it.");
    fireEvent.click(tabCheckbox("my-draft"));
    await settle(0);
    expect(document.querySelector('[data-panel-content="products"] [data-picked-count]')!.textContent).toBe("Pick at least one");
    await openPicker();
    const option = document.querySelector('[data-picker-option="my-draft"]') as HTMLButtonElement;
    expect(option.disabled).toBe(true);
    expect(option.title).toBe("Move this product to staging before building on it.");
    // A product in staging can be picked: a new app builds in the sandbox.
    expect((document.querySelector('[data-picker-option="my-staged"]') as HTMLButtonElement).disabled).toBe(false);
    // Others' products have no stage actions; the user's own have the labelled ones.
    expect(within(tabRow("p1")).queryAllByRole("button")).toEqual([]);
    expect(within(tabRow("my-draft")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Move to staging"]);
    expect(within(tabRow("my-staged")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Move to production", "Move back"]);
  });

  it("Move to staging opens the approval sheet with Mynt's checks; the test runs there; confirming moves it", async () => {
    checksReply = checksFor("staging", false, [check("tests_passed", "fail", "Product changed since its last test (or was never tested); run test_product first")]);
    await loaded();
    await openTab("Products");
    await act(async () => void fireEvent.click(within(tabRow("my-draft")).getByRole("button", { name: "Move to staging" })));
    await settle();
    const s = within(productSheet()!);
    expect(productSheet()!.querySelector("[data-approval-steps=full]")).not.toBeNull();
    expect(productSheet()!.querySelector("[data-approval-summary]")!.textContent).toContain("My savings");
    expect(productSheet()!.querySelector("[data-check=tests_passed]")!.textContent).toContain("run test_product first");
    const confirm = productSheet()!.querySelector("[data-product-confirm=staging]") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    checksReply = checksFor("staging", true, [check("tests_passed", "pass", "Mynt's checks passed")]);
    await act(async () => void fireEvent.click(s.getByRole("button", { name: "Run tests" })));
    await settle();
    expect(calls).toEqual([{ url: "/api/products/my-draft", body: { action: "test" } }]);
    await act(async () => void fireEvent.click(productSheet()!.querySelector("[data-product-confirm=staging]")!));
    await settle();
    expect(calls[1]).toEqual({ url: "/api/products/my-draft", body: { action: "promote", to_stage: "staging" } });
    expect(within(productSheet()!).getByRole("status").textContent).toBe("Moved.");
    expect(tabRow("my-draft").querySelector("[data-product-status]")!.textContent).toBe("Staging");
    expect(tabCheckbox("my-draft").disabled).toBe(false);
  });

  it("a refused Move to production shows Mynt's reason in its words and stays in Staging", async () => {
    checksReply = checksFor("production", true, [check("licences", "pass", "covered")]);
    publishReply = { status: 422, body: { error: "mynt_refused", message: "Not promoted: Publishing needs a verified licence for issuance of 'deposits' in US, held by your entity" } };
    await loaded();
    await openTab("Products");
    await act(async () => void fireEvent.click(within(tabRow("my-staged")).getByRole("button", { name: "Move to production" })));
    await settle();
    await act(async () => void fireEvent.click(productSheet()!.querySelector("[data-product-confirm=production]")!));
    await settle();
    expect(calls).toEqual([{ url: "/api/products/my-staged", body: { action: "promote", to_stage: "production" } }]);
    expect(within(productSheet()!).getByRole("alert").textContent).toBe("Not promoted: Publishing needs a verified licence for issuance of 'deposits' in US, held by your entity");
    expect(tabRow("my-staged").querySelector("[data-product-status]")!.textContent).toBe("Staging");
  });

  it("Move back asks for a reason, then moves it down one stage", async () => {
    await loaded();
    await openTab("Products");
    await act(async () => void fireEvent.click(within(tabRow("my-staged")).getByRole("button", { name: "Move back" })));
    await settle();
    const form = productSheet()!.querySelector("[data-move-back]") as HTMLFormElement;
    const submit = within(form).getByRole("button", { name: "Move back to Ideas" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText("Reason"), { target: { value: "Rates changing" } });
    await act(async () => void fireEvent.submit(form));
    await settle();
    expect(calls).toEqual([{ url: "/api/products/my-staged", body: { action: "demote", to_stage: "idea", reason: "Rates changing" } }]);
    expect(tabRow("my-staged").querySelector("[data-product-status]")!.textContent).toBe("Idea");
    expect(tabCheckbox("my-staged").disabled).toBe(true);
  });
});

describe("Create product", () => {
  it("opens one sheet from the picker's last item, the tab's toolbar (its last button) and /create-product", async () => {
    await loaded();
    await openPicker();
    const menu = document.querySelector("[data-product-picker-menu]")!;
    const create = menu.querySelector("[data-picker-create]")!;
    expect(create.textContent).toBe("Create product");
    expect(menu.lastElementChild).toBe(create);
    await act(async () => void fireEvent.click(create));
    await settle();
    expect(within(sheet()!).getByRole("heading", { name: "Create product" })).toBeTruthy();
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    await settle();
    expect(sheet()).toBeNull();

    await openTab("Products");
    const toolbar = document.querySelector('[data-panel-content="products"] [data-toolbar]')!;
    const buttons = [...toolbar.querySelectorAll("button")];
    expect(buttons.at(-1)!.textContent).toBe("Create product");
    await act(async () => void fireEvent.click(buttons.at(-1)!));
    await settle();
    expect(sheet()).not.toBeNull();

    const createProduct = vi.fn();
    const commands = newAppCommands({ tab: vi.fn(), applyKind: vi.fn(), createProduct }, []);
    expect(commands.map((c) => c.name)).toEqual(["templates", "products", "create-product"]);
    commands[2].run!();
    expect(createProduct).toHaveBeenCalledOnce();
  });

  it("derives the id from the name, lets it be edited, and checks it with create_product's rule", async () => {
    expect(slugFromName("Green FD — 2026!")).toBe("green-fd-2026");
    expect(slugFromName("  Café Savings  ")).toBe("cafe-savings");
    expect(PRODUCT_SLUG.test("green-fd")).toBe(true);
    for (const bad of ["Green", "green--fd", "-green", "green_fd", ""]) expect(PRODUCT_SLUG.test(bad)).toBe(false);

    await loaded();
    await openTab("Products");
    await act(async () => void fireEvent.click(document.querySelector("[data-create-product]")!));
    await settle();
    const s = within(sheet()!);
    fireEvent.change(s.getByLabelText("Name"), { target: { value: "Green Savings" } });
    const slug = s.getByLabelText("Product id") as HTMLInputElement;
    expect(slug.value).toBe("green-savings");
    fireEvent.change(slug, { target: { value: "Green_Savings" } });
    expect(sheet()!.querySelector("[data-slug-error]")!.textContent).toBe("Use a lowercase slug like 'green-fd'");
    expect((s.getByRole("button", { name: "Create product" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(slug, { target: { value: "green-saver" } });
    expect(sheet()!.querySelector("[data-slug-error]")).toBeNull();
    // Edited, it no longer follows the name.
    fireEvent.change(s.getByLabelText("Name"), { target: { value: "Green Savings Plus" } });
    expect(slug.value).toBe("green-saver");
  });

  it("sends create_product's inputs once; the new product shows as an Idea that can't be picked", async () => {
    await loaded();
    await openTab("Products");
    await act(async () => void fireEvent.click(document.querySelector("[data-create-product]")!));
    await settle();
    const s = within(sheet()!);
    // Jurisdictions are Mynt's regions, with their flags; the regulator is one of the region's.
    expect([...(s.getByLabelText("Jurisdiction") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Choose…", "🇺🇸 United States"]);
    fireEvent.change(s.getByLabelText("Name"), { target: { value: "Green Savings" } });
    fireEvent.change(s.getByLabelText("Product line"), { target: { value: "account_operations" } });
    expect([...(s.getByLabelText("Category") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "deposits"]);
    fireEvent.change(s.getByLabelText("Jurisdiction"), { target: { value: "US" } });
    fireEvent.change(s.getByLabelText("Category"), { target: { value: "deposits" } });
    fireEvent.change(s.getByLabelText("Regulator"), { target: { value: "OCC" } });
    fireEvent.change(s.getByLabelText("Risk level"), { target: { value: "low" } });
    fireEvent.change(s.getByLabelText("Liquidity"), { target: { value: "high" } });
    fireEvent.change(s.getByLabelText("Typical horizon"), { target: { value: "short" } });
    fireEvent.change(s.getByLabelText("Return type"), { target: { value: "fixed_interest" } });
    fireEvent.change(s.getByLabelText("Description"), { target: { value: "A savings account that rounds up card spend." } });
    // Underlying products only for sale and repackaging.
    expect(sheet()!.querySelector("[data-underlying]")).toBeNull();
    fireEvent.change(s.getByLabelText("Action"), { target: { value: "sale" } });
    const underlying = sheet()!.querySelector("[data-underlying]")!;
    // Only products in production can be sold or repackaged.
    expect([...underlying.querySelectorAll("[data-underlying-option]")].map((o) => o.getAttribute("data-underlying-option"))).toEqual(["p1", "p2", "p3"]);
    await act(async () => void fireEvent.click(s.getByRole("button", { name: "Create product" })));
    expect(s.getByRole("alert").textContent).toBe("Pick the products this one sells or repackages.");
    expect(calls).toEqual([]);
    fireEvent.change(s.getByLabelText("Action"), { target: { value: "issuance" } });
    // Key features wait under More.
    expect(s.queryByLabelText("Key features")).toBeNull();
    await act(async () => void fireEvent.click(s.getByRole("button", { name: "More" })));
    fireEvent.change(s.getByLabelText("Key features"), { target: { value: "Round-ups\n\nNo fees " } });
    await act(async () => void fireEvent.click(s.getByRole("button", { name: "Create product" })));
    await settle();
    expect(calls).toEqual([
      {
        url: "/api/products",
        body: {
          id: "green-savings",
          name: "Green Savings",
          product_line: "account_operations",
          category: "deposits",
          region: "US",
          action: "issuance",
          underlying_product_ids: [],
          risk_level: "low",
          liquidity: "high",
          typical_horizon: "short",
          return_type: "fixed_interest",
          regulator: "OCC",
          description: "A savings account that rounds up card spend.",
          key_features: ["Round-ups", "No fees"],
        },
      },
    ]);
    expect(NewProductRequest.safeParse(calls[0].body).success).toBe(true);
    expect(sheet()).toBeNull();
    expect(tabRow("green-savings").querySelector("[data-product-status]")!.textContent).toBe("Idea");
    expect(flagsIn(tabRow("green-savings"))).toEqual(["US"]);
    expect(tabCheckbox("green-savings").disabled).toBe(true);
    expect(within(tabRow("green-savings")).getByRole("button", { name: "Move to staging" })).toBeTruthy();
  });

  it("shows Mynt's refusal in its words and keeps what was typed", async () => {
    await loaded();
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (url === "/api/products/options") return new Response(JSON.stringify(OPTIONS), { status: 200 });
      if (url === "/api/products" && init?.method === "POST") {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ error: "mynt_refused", message: "A product with id 'my-draft' already exists" }), { status: 422 });
      }
      return new Response("{}", { status: 404 });
    });
    await openTab("Products");
    await act(async () => void fireEvent.click(document.querySelector("[data-create-product]")!));
    await settle();
    const s = within(sheet()!);
    fireEvent.change(s.getByLabelText("Name"), { target: { value: "My draft" } });
    for (const [label, value] of [["Product line", "account_operations"], ["Jurisdiction", "US"], ["Category", "deposits"], ["Regulator", "OCC"], ["Risk level", "low"], ["Liquidity", "high"], ["Typical horizon", "short"], ["Return type", "fixed_interest"]])
      fireEvent.change(s.getByLabelText(label), { target: { value } });
    fireEvent.change(s.getByLabelText("Description"), { target: { value: "Savings." } });
    await act(async () => void fireEvent.click(s.getByRole("button", { name: "Create product" })));
    await settle();
    expect(calls).toHaveLength(1);
    expect(s.getByRole("alert").textContent).toBe("A product with id 'my-draft' already exists");
    expect((s.getByLabelText("Name") as HTMLInputElement).value).toBe("My draft");
  });
});

describe("test_product's report", () => {
  it("is a line: passed, or the failing checks in Mynt's words", () => {
    expect(testSummary({ passed: true, checks: [{ name: "x", status: "warn", message: "w" }] })).toEqual({ passed: true, message: "Tests passed. You can publish it." });
    expect(testSummary({ passed: false, checks: [{ name: "region", status: "fail", message: "Region 'XX' isn't defined" }, { name: "y", status: "pass", message: "ok" }] })).toEqual({
      passed: false,
      message: "Tests failed: Region 'XX' isn't defined",
    });
    expect(testSummary(null).passed).toBe(false);
  });
});
