// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { CHOSEN_KEY, type EarnWallets } from "@/lib/wallets";

// The Earn page and its chat workspace take several seconds to load on a busy or slow runner: a
// longer timeout for this file only. The assertions are unchanged.
vi.setConfig({ testTimeout: 20_000 });

// The Earn page with the wallet picker in its chat bar: the chosen wallet is sent with every message
// (its address only), and the choice is remembered for this user in this browser.

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const SOL2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const WALLETS: EarnWallets = {
  supported: true,
  balancesSupported: true,
  owner: "owner-a",
  wallets: [
    { address: SOL, chain: "solana", network: "Solana", balances: { solLamports: "1000000000", usdcBaseUnits: "5000000" } },
    { address: SOL2, chain: "solana", network: "Solana", balances: null },
  ],
  manageUrl: null,
  treasury: { deposit: true, withdraw: true, status: true },
};

function stubFetch(sent: Record<string, unknown>[]) {
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/earn/wallets")) return json(WALLETS);
      if (url.endsWith("/api/liquidity")) return json({ supported: true, access: { builder: false, liquidityProvider: true }, provider: { pools: [], positions: [], withdrawals: [], canCommit: true, canWithdraw: true } });
      if (url.endsWith("/api/earn") && init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        const sse = ['{"type":"start"}', '{"type":"text-start","id":"t"}', '{"type":"text-delta","id":"t","delta":"ok"}', '{"type":"text-end","id":"t"}', '{"type":"finish"}'].map((d) => `data: ${d}\n\n`).join("") + "data: [DONE]\n\n";
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1" } });
      }
      if (url.endsWith("/api/earn")) return json({ enabled: true });
      return json({});
    }),
  );
}

const { default: EarnPage } = await import("@/app/(studio)/earn/page");
const flush = () => act(async () => new Promise((r) => setTimeout(r, 30)));

describe("the Earn page's wallet", () => {
  it("puts the picker in the chat bar and sends the chosen wallet with each message", async () => {
    const sent: Record<string, unknown>[] = [];
    stubFetch(sent);
    render(<EarnPage />);
    await flush();
    const picker = document.querySelector('[data-composer-toolbar] [data-wallet-picker="wallets"]')!;
    expect(picker.textContent).toContain("7EcDhS…FLtV");
    await act(async () => void fireEvent.click(document.querySelector("[data-chip]")!));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].wallet).toEqual({ address: SOL });
  });

  it("remembers a wallet picked before, for this user", async () => {
    localStorage.setItem(CHOSEN_KEY, JSON.stringify({ "owner-a": SOL2, "owner-b": SOL }));
    const sent: Record<string, unknown>[] = [];
    stubFetch(sent);
    render(<EarnPage />);
    await flush();
    expect(document.querySelector('[data-wallet-picker="wallets"]')!.textContent).toContain("9xQeWv…VFin");
    await act(async () => void fireEvent.click(document.querySelector("[data-chip]")!));
    await flush();
    expect(sent[0].wallet).toEqual({ address: SOL2 });
  });
});
