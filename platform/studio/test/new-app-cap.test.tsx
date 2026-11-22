// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// New app has no spending cap: no "Cap $" in the composer, no budget read, no send blocked for budget,
// and the request carries no cap_usd (Mynt applies its own cap to the first build).

const pushed: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (p: string) => void pushed.push(p) }) }));
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

const { default: NewAppPage } = await import("@/app/(studio)/new/page");

const PRODUCTS = [{ id: "p1", name: "Dollar account", productLine: "custody_settlement", by: "Lead Trust", accessMode: "open" }];
const KINDS = [{ id: "savings-goals", title: "Savings goals", description: "Set savings goals.", productLines: ["custody_settlement"], goalTemplate: "A savings goals app. Customers set goals and add money." }];

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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function studio() {
  const posted: unknown[] = [];
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    asked.push(url);
    if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
    if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: KINDS }), { status: 200 });
    if (url === "/api/apps") {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ appId: "app-1", buildId: "build-1" }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  });
  return { posted, asked };
}
const send = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;

describe("New app without a cap", () => {
  it("has only the Products picker in the composer's toolbar, reads no budget, and sends no cap", async () => {
    const s = studio();
    render(<NewAppPage />);
    await waitFor(() => expect(document.querySelector('[data-chips] [data-chip="savings-goals"]')).not.toBeNull());
    expect(document.querySelector("[data-composer-toolbar] [data-product-picker]")).not.toBeNull();
    expect(document.querySelector("[data-cap-field]")).toBeNull();
    expect(screen.queryByLabelText("Spending cap for this build, in US dollars")).toBeNull();
    await act(async () => void fireEvent.click(document.querySelector('[data-chips] [data-chip="savings-goals"]')!));
    expect(send().disabled).toBe(false);
    await act(async () => void fireEvent.click(send()));
    await waitFor(() => expect(s.posted).toEqual([{ prompt: KINDS[0].goalTemplate, product_ids: ["p1"], kind: "savings-goals" }]));
    expect(s.asked.some((u) => u.startsWith("/api/builds/budget"))).toBe(false);
  });
});
