// @vitest-environment jsdom
// The /new page in the dashboard's layout: its page frame, the prompt, the products as a panel with a
// toolbar search and a Product line filter, and Build it as the one primary button.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

const { default: NewAppPage } = await import("@/app/(studio)/new/page");

const PRODUCTS = [
  { id: "p1", name: "High-yield savings", productLine: "deposits", by: "Lead Bank", accessMode: "open" },
  { id: "p2", name: "Charge card", productLine: "card_issuing", by: "Lead Bank", accessMode: "open" },
];

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const loaded = async () => {
  render(<NewAppPage />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
};

describe("the New app page", () => {
  it("uses the dashboard's page frame, full width, with no heading repeating the header", async () => {
    await loaded();
    const frame = document.querySelector("[data-new-app-page]")!;
    for (const c of ["flex", "flex-col", "gap-4", "p-4", "lg:gap-5", "lg:p-6"]) expect(frame.className.split(" "), c).toContain(c);
    expect(frame.className).not.toMatch(/max-w-|mx-auto/);
    expect(document.querySelector("h1")).toBeNull();
    expect(screen.queryByRole("heading", { name: "What do you want to build?" })).toBeNull();
    const prompt = screen.getByLabelText("What do you want to build?") as HTMLTextAreaElement;
    expect(prompt.placeholder).toMatch(/^What do you want to build\?/);
  });

  it("shows the products in a panel with its section heading and the count as plain text, no card", async () => {
    await loaded();
    const panel = document.querySelector('[data-panel][data-row="products"]')!;
    expect(panel).not.toBeNull();
    expect(document.querySelector('[data-slot^="card"]')).toBeNull();
    const heading = screen.getByRole("heading", { name: "Products it builds on" });
    expect(heading.className).toBe("text-sm font-semibold");
    expect(panel.querySelector("[data-picked-count]")!.textContent).toBe("Pick at least one");
    fireEvent.click(screen.getByRole("button", { name: /High-yield savings/ }));
    expect(panel.querySelector("[data-picked-count]")!.textContent).toBe("1 picked");
  });

  it("searches from the toolbar's search, with a Product line filter beside it", async () => {
    await loaded();
    const search = screen.getByLabelText("Search products");
    expect(search.className).toContain("pl-8");
    expect(search.parentElement!.className).toMatch(/relative min-w-64 flex-1/);
    expect(search.parentElement!.querySelector("svg")!.getAttribute("class")).toContain("left-2.5");
    const filter = document.querySelector('[data-filter="Product line"]')!;
    expect(filter.closest("[data-toolbar]")).toBe(search.closest("[data-toolbar]"));
    expect(document.querySelector("select")).toBeNull();
  });

  it("filters by product line and keeps what was picked", async () => {
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: /Charge card/ }));
    fireEvent.keyDown(document.querySelector('[data-filter="Product line"]')!, { key: "Enter" });
    await act(async () => undefined);
    const options = [...document.querySelectorAll("[data-filter-option]")].map((o) => o.textContent);
    expect(options).toEqual(["card issuing", "deposits"]);
    await act(async () => void fireEvent.click(document.querySelector('[data-filter-option="deposits"]')!));
    expect(screen.queryByRole("button", { name: /Charge card/ })).toBeNull();
    expect(screen.getByRole("button", { name: /High-yield savings/ })).toBeTruthy();
    expect(document.querySelector("[data-picked-count]")!.textContent).toBe("1 picked");
  });

  it("keeps Build it as the primary button, ready once there's a prompt and a product", async () => {
    await loaded();
    const build = screen.getByRole("button", { name: "Build it" }) as HTMLButtonElement;
    expect(build.getAttribute("data-variant")).toBe("default");
    expect(build.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What do you want to build?"), { target: { value: "A savings app with round-ups" } });
    fireEvent.click(screen.getByRole("button", { name: /High-yield savings/ }));
    expect(build.disabled).toBe(false);
  });

  it("shows skeleton rows while the products load, not a Loading line", () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    render(<NewAppPage />);
    expect(document.querySelectorAll("[data-product-list] [data-loading]").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/Loading/);
  });
});
