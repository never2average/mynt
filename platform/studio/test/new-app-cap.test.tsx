// @vitest-environment jsdom
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// New app's cap for the first build, in the composer's toolbar beside the Products picker: it starts
// at the usual cap or what's left this month, whichever is less, goes with the request (with the
// template's kind), and when too little is left, sending is blocked and the composer says why.

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

function studio(monthLeftUsd: number) {
  const posted: unknown[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/builds/budget"))
      return new Response(JSON.stringify({ budget: { defaultCapUsd: 10, monthLeftUsd, workspaceLeftUsd: null, minCapUsd: 0.5, sessionCapAboveUsd: 2 }, session: true }), { status: 200 });
    if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: PRODUCTS }), { status: 200 });
    if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: KINDS }), { status: 200 });
    if (url === "/api/apps") {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ appId: "app-1", buildId: "build-1" }), { status: 201 });
    }
    return new Response("{}", { status: 404 });
  });
  return posted;
}
const send = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
const capField = () => screen.queryByLabelText("Spending cap for this build, in US dollars") as HTMLInputElement | null;

describe("New app's cap", () => {
  it("sits beside the Products picker, starts at what's left this month, and goes with the request", async () => {
    const posted = studio(6.5);
    render(<NewAppPage />);
    await waitFor(() => expect(capField()?.value).toBe("6.50"));
    expect(document.querySelector("[data-composer-toolbar] [data-product-picker]")).not.toBeNull();
    expect(document.querySelector("[data-composer-toolbar] [data-cap-field]")).not.toBeNull();
    fireEvent.change(capField()!, { target: { value: "3" } });
    fireEvent.blur(capField()!);
    await act(async () => void fireEvent.click(document.querySelector('[data-chips] [data-chip="savings-goals"]')!));
    expect(send().disabled).toBe(false);
    await act(async () => void fireEvent.click(send()));
    await waitFor(() => expect(posted).toEqual([{ prompt: KINDS[0].goalTemplate, product_ids: ["p1"], kind: "savings-goals", cap_usd: 3 }]));
  });

  it("blocks sending, saying why, when too little is left this month", async () => {
    const posted = studio(1.5);
    render(<NewAppPage />);
    await waitFor(() => expect(document.querySelector('[data-chips] [data-chip="savings-goals"]')).not.toBeNull());
    await act(async () => void fireEvent.click(document.querySelector('[data-chips] [data-chip="savings-goals"]')!));
    await waitFor(() => expect(document.querySelector("p[data-send-blocked]")?.textContent).toMatch(/^Only US\$1\.50 of your build budget is left this month/));
    expect(send().disabled).toBe(true);
    expect(capField()).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Message input"), { key: "Enter" });
    await act(async () => undefined);
    expect(posted).toEqual([]);
  });
});
