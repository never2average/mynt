// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { WalletControl, NOT_YET } = await import("@/components/wallet-control");
const { SiteHeader } = await import("@/components/site-header");
const { AppTopBar } = await import("@/components/app-top-bar");
const { DashboardView } = await import("@/components/dashboard-view");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { fromDashboardTool } = await import("@/lib/dashboard");
const { resetStudioAccess } = await import("@/lib/use-liquidity-access");
const { fromLinkedAccounts, networkOf, NOT_LINKED, shortAddress, UNKNOWN_NETWORK } = await import("@/lib/linked-accounts");
type BrowserWallet = import("@/lib/browser-wallet").BrowserWallet;

const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7";
const SOLANA = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const MANAGE = "https://accounts.example.com/user";
const withWallet = fromLinkedAccounts({ git: { username: "ines" }, wallets: [{ address: SOLANA, chain: "solana" }], manage_url: MANAGE });
const noWallet = fromLinkedAccounts({ git: null, wallets: [], manage_url: MANAGE });
const both = { builder: true, liquidityProvider: true };

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("button", { name: /^Wallet / }), { key: "Enter" });
  });
  return document.querySelector("[data-wallet-menu]") as HTMLElement;
};

describe("linked accounts", () => {
  it("reads the GitHub username, the first wallet and the account page", () => {
    expect(fromLinkedAccounts({ git: { username: "ines" }, wallets: [{ address: SOLANA, chain: "solana" }, { address: "0xother" }], manage_url: MANAGE })).toEqual({
      supported: true,
      github: "ines",
      wallet: { address: SOLANA, chain: "solana", network: "Solana" },
      manageUrl: MANAGE,
    });
    expect(fromLinkedAccounts({ git: null, wallets: [] })).toEqual({ supported: true, github: null, wallet: null, manageUrl: null });
  });

  it("links out only to an https page", () => {
    for (const bad of ["javascript:alert(1)", "http://accounts.example.com", "/user", "https://u:p@accounts.example.com", "data:text/html,x"]) {
      expect(fromLinkedAccounts({ manage_url: bad }).manageUrl, bad).toBeNull();
    }
  });

  it("names the wallet's network only when the address fits it", () => {
    expect(networkOf(SOLANA, "solana")).toBe("Solana");
    expect(networkOf(ADDRESS, "ethereum")).toBe("Ethereum");
    expect(networkOf(ADDRESS)).toBe("EVM");
    expect(networkOf(ADDRESS, "solana")).toBe(UNKNOWN_NETWORK);
    expect(networkOf(SOLANA, "ethereum")).toBe(UNKNOWN_NETWORK);
    expect(networkOf(ADDRESS, "made-up-chain")).toBe(UNKNOWN_NETWORK);
    expect(networkOf("0x1234")).toBe(UNKNOWN_NETWORK);
  });

  it("shortens an address so it's still recognisable", () => {
    expect(shortAddress(ADDRESS)).toBe("0x5290…9EE7");
    expect(shortAddress("short")).toBe("short");
  });
});

describe("the header's wallet control", () => {
  it("sits right beside New app in the page header", async () => {
    resetStudioAccess();
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url.startsWith("/api/liquidity/access") ? { developer: true, access: { builder: true, liquidityProvider: false }, owner: "o" } : {}), { status: 200 }));
    const { container } = render(
      <TooltipProvider>
        <SidebarProvider>
          <SiteHeader title="Dashboard" />
        </SidebarProvider>
      </TooltipProvider>,
    );
    await act(async () => undefined);
    // Not known yet (no linked accounts read): nothing rather than a guess; New app still there.
    expect(container.querySelector("[data-new-app]")).not.toBeNull();
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>
          <div>
            <WalletControl linked={withWallet} access={both} />
            <a data-new-app href="/new">New app</a>
          </div>
        </SidebarProvider>
      </TooltipProvider>,
    );
    expect(html.indexOf("data-wallet-control")).toBeLessThan(html.indexOf("data-new-app"));
  });

  it("with a wallet: the short address and network; the menu has the full address, Copy, role links and Manage linked accounts", async () => {
    const copied: string[] = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (s: string) => void copied.push(s) } });
    render(<WalletControl linked={withWallet} access={both} />);
    const trigger = screen.getByRole("button", { name: /^Wallet / });
    expect(trigger.textContent).toContain("7EcDhS…FLtV");
    // The network is named once, in the menu, as text: never on the button, never as a mark or badge.
    expect(trigger.textContent).not.toContain("Solana");
    expect(trigger.querySelector("[data-brand-icon], [data-network-mark], [data-slot='badge']")).toBeNull();
    const menu = await open();
    expect(menu.querySelector("[data-network]")?.textContent).toBe("Solana");
    expect(menu.textContent!.match(/Solana/g)).toHaveLength(1);
    expect(menu.querySelector("[data-slot='badge']")).toBeNull();
    expect(menu.textContent).not.toContain("Crypto wallet");
    expect(menu.querySelector("[data-full-address]")?.textContent).toBe(SOLANA);
    expect(menu.querySelector('[data-liquidity-link="Manage pools"]')?.getAttribute("href")).toBe("/earn?tab=my-pools");
    expect(menu.querySelector('[data-liquidity-link="Provide liquidity"]')?.getAttribute("href")).toBe("/earn?tab=opportunities");
    const manage = menu.querySelector("[data-manage-wallet]")!;
    expect(manage.textContent).toContain("Manage linked accounts");
    expect(manage.getAttribute("href")).toBe(MANAGE);
    expect(manage.getAttribute("target")).toBeNull(); // the same tab, never embedded
    await act(async () => {
      fireEvent.click(menu.querySelector("[data-copy-address]")!);
    });
    expect(copied).toEqual([SOLANA]);
    expect(document.querySelector("[data-copy-address]")?.textContent).toContain("Copied");
  });

  it("shows only the links for the user's roles", async () => {
    render(<WalletControl linked={withWallet} access={{ builder: false, liquidityProvider: true }} />);
    const menu = await open();
    expect(menu.querySelector('[data-liquidity-link="Manage pools"]')).toBeNull();
    expect(menu.querySelector('[data-liquidity-link="Provide liquidity"]')).not.toBeNull();
    cleanup();
    render(<WalletControl linked={withWallet} access={{ builder: false, liquidityProvider: false }} />);
    expect((await open()).querySelector("[data-liquidity-link]")).toBeNull();
  });

  it("an address that doesn't fit its chain says Unknown network", async () => {
    render(<WalletControl linked={fromLinkedAccounts({ wallets: [{ address: ADDRESS, chain: "solana" }] })} access={both} />);
    expect((await open()).querySelector("[data-network]")?.textContent).toBe(UNKNOWN_NETWORK);
  });

  it("names the wallet app with its own name and icon once a browser wallet has connected the address", async () => {
    const icon = `data:image/svg+xml;base64,${btoa("<svg>p</svg>")}`;
    const phantom = { version: "1.0.0", name: "Phantom", icon, chains: ["solana:devnet"], accounts: [{ address: SOLANA, publicKey: new Uint8Array(32), chains: ["solana:devnet"], features: [] }], features: {} } as unknown as BrowserWallet;
    render(<WalletControl linked={withWallet} access={both} browserWallets={[phantom]} />);
    const trigger = screen.getByRole("button", { name: /^Wallet / });
    expect(trigger.querySelector('[data-wallet-app="Phantom"]')?.textContent).toBe("Phantom");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe(icon);
    expect(trigger.querySelector("svg.lucide-wallet")).toBeNull();
    expect(trigger.textContent).toContain("7EcDhS…FLtV");
    const menu = await open();
    expect(menu.querySelector('[data-wallet-app="Phantom"]')).not.toBeNull();
    expect(menu.querySelector("[data-connect-wallet]")).toBeNull(); // already named
  });

  it("with no known app: the short address only, and Connect wallet lists the detected wallets or says none was found", async () => {
    const solflare = { version: "1.0.0", name: "Solflare", icon: `data:image/svg+xml;base64,${btoa("<svg>s</svg>")}`, chains: ["solana:devnet"], accounts: [], features: {} } as unknown as BrowserWallet;
    render(<WalletControl linked={withWallet} access={both} browserWallets={[solflare]} />);
    const trigger = screen.getByRole("button", { name: /^Wallet / });
    expect(trigger.querySelector("[data-wallet-app]")).toBeNull();
    expect(trigger.querySelector("svg.lucide-wallet")).not.toBeNull();
    let menu = await open();
    await act(async () => void fireEvent.click(menu.querySelector("[data-connect-wallet]")!));
    expect([...document.querySelectorAll("[data-detected-wallet]")].map((e) => e.textContent)).toEqual(["Solflare"]);
    cleanup();
    render(<WalletControl linked={withWallet} access={both} browserWallets={[]} />);
    menu = await open();
    await act(async () => void fireEvent.click(menu.querySelector("[data-connect-wallet]")!));
    expect(document.querySelector("[data-no-wallet-detected]")?.textContent).toBe("No wallet found in this browser.");
  });

  it("without a wallet: Link wallet, to the account page in the same tab", () => {
    render(<WalletControl linked={noWallet} access={both} />);
    const link = screen.getByRole("link", { name: "Link wallet" });
    expect(link.getAttribute("href")).toBe(MANAGE);
    expect(link.getAttribute("target")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("before Mynt has linked accounts: Link wallet is there but disabled, saying why", () => {
    render(<WalletControl linked={NOT_LINKED} access={both} />);
    const button = screen.getByRole("button", { name: "Link wallet" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe(NOT_YET);
  });

  it("in an app's top bar: compact, the short address only", async () => {
    resetStudioAccess();
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify(url.startsWith("/api/linked-accounts") ? { linked: withWallet } : url.startsWith("/api/liquidity/access") ? { access: both, developer: true } : {}), { status: 200 }),
    );
    const { container } = render(
      <TooltipProvider>
        <SidebarProvider>
          <AppTopBar appName="Cards" stage="idea" backLabel="All apps" onBack={() => undefined} previewUrl={null} iframeRef={{ current: null }} device="desktop" onDevice={() => undefined} />
        </SidebarProvider>
      </TooltipProvider>,
    );
    await act(async () => undefined);
    const control = container.querySelector('[data-wallet-control="linked"]')!;
    expect(control.textContent).toContain("7EcDhS…FLtV");
    expect(control.querySelector("[data-network]")).toBeNull();
  });
});

describe("the dashboard", () => {
  it("no longer has the wallet tile", () => {
    const html = renderToStaticMarkup(<DashboardView dashboard={fromDashboardTool({})} />);
    expect(html).not.toContain('data-tile="wallet"');
    expect(html).not.toContain("7EcDhS…FLtV");
    expect(html).not.toContain("Link wallet");
    expect(html).not.toContain("/earn?tab=");
  });
});
