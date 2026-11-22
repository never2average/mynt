// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";

// New app's cap for the first build: it starts at the usual cap or what's left this month,
// whichever is less, goes with the request, and when too little is left, Build it is off and the
// page says why.

vi.mock("next/navigation", () => ({
  usePathname: () => "/new",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
}));
configure({ asyncUtilTimeout: 5000 });

const { default: NewAppPage } = await import("@/app/(studio)/new/page");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function studio(monthLeftUsd: number) {
  const posted: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/builds/budget"))
        return new Response(JSON.stringify({ budget: { defaultCapUsd: 10, monthLeftUsd, workspaceLeftUsd: null, minCapUsd: 0.5, sessionCapAboveUsd: 2 }, session: true }), { status: 200 });
      if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: [{ id: "p1", name: "Savings", productLine: "deposits", by: "Bank", accessMode: "open" }] }), { status: 200 });
      if (url === "/api/apps") {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ message: "stop here" }), { status: 400 });
      }
      return new Response("{}", { status: 200 });
    }),
  );
  return posted;
}

describe("New app's cap", () => {
  it("starts at what's left this month and goes with the request", async () => {
    const posted = studio(6.5);
    render(<NewAppPage />);
    const field = (await screen.findByLabelText("Spending cap for this build, in US dollars")) as HTMLInputElement;
    expect(field.value).toBe("6.50");
    fireEvent.change(screen.getByLabelText("What do you want to build?"), { target: { value: "A savings app that rounds up purchases" } });
    fireEvent.click(await screen.findByRole("button", { name: /Savings/ }));
    fireEvent.change(field, { target: { value: "3" } });
    fireEvent.blur(field);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Build it/ }));
    });
    await waitFor(() => expect(posted).toEqual([{ prompt: "A savings app that rounds up purchases", product_ids: ["p1"], cap_usd: 3 }]));
  });

  it("turns Build it off, saying why, when too little is left", async () => {
    studio(1.5);
    render(<NewAppPage />);
    expect(await screen.findByText(/Only US\$1\.50 of your build budget is left this month/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What do you want to build?"), { target: { value: "A savings app that rounds up purchases" } });
    fireEvent.click(await screen.findByRole("button", { name: /Savings/ }));
    expect((screen.getByRole("button", { name: /Build it/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByLabelText("Spending cap for this build, in US dollars")).toBeNull();
  });
});
