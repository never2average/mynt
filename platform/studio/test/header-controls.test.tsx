// @vitest-environment jsdom
// The header's right side: Search, GitHub, Wallet, New app and the theme switcher (far right).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const root = process.cwd(); // vitest runs from platform/studio
const { ThemeProvider, ThemeSwitcher } = await import("@/components/theme-switcher");
const { GithubControl, MENU_REPOS } = await import("@/components/github-control");
const { SiteHeader } = await import("@/components/site-header");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { NOT_LINKED } = await import("@/lib/linked-accounts");

const MANAGE = "https://accounts.example.test/user";
const linked = { supported: true, github: "ines", wallet: null, manageUrl: MANAGE };
const repo = (repository: string, approval: "approved" | "pending" | "rejected") => ({ repository, approval, note: null, connectedAt: null });

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openMenu = async (name: RegExp | string) => {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
  });
};

describe("the theme", () => {
  it("has no hard-coded dark class: next-themes sets it, with the CSP nonce and no hydration warning", () => {
    const layout = readFileSync(join(root, "app/layout.tsx"), "utf8");
    expect(layout).not.toMatch(/className="dark\b/);
    expect(layout).toContain("suppressHydrationWarning");
    expect(layout).toMatch(/<ThemeProvider nonce=\{nonce\}>/);
    expect(layout).toMatch(/headers\(\)\)\.get\("x-nonce"\)/);
    const provider = readFileSync(join(root, "components/theme-switcher.tsx"), "utf8");
    expect(provider).toMatch(/attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange nonce=\{nonce\}/);
  });

  it("the switcher's menu (Light, Dark, System) switches the class on <html>, keeps the choice and the theme-color follows", async () => {
    const meta = Object.assign(document.createElement("meta"), { name: "theme-color", content: "#FFFFFF" });
    document.head.append(meta);
    render(
      <ThemeProvider nonce="abc">
        <TooltipProvider>
          <ThemeSwitcher />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Theme" })).toBeTruthy();
    await openMenu("Theme");
    const menu = document.querySelector("[data-theme-menu]")!;
    expect([...menu.querySelectorAll("[data-theme-option]")].map((o) => o.textContent)).toEqual(["Light", "Dark", "System"]);
    await act(async () => {
      fireEvent.click(menu.querySelector('[data-theme-option="dark"]')!);
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("dark");
    expect(meta.content).toBe("#09090B");
    await openMenu("Theme");
    await act(async () => {
      fireEvent.click(document.querySelector('[data-theme-option="light"]')!);
    });
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(meta.content).toBe("#FFFFFF");
    meta.remove();
  });
});

describe("the header's GitHub control", () => {
  it("linked: the username; the menu lists up to five repositories with their status in words, View all, Connect repository and Manage linked accounts", async () => {
    const repos = [repo("ines/savings", "approved"), repo("ines/cards", "pending"), repo("ines/vault", "rejected"), ...Array.from({ length: 5 }, (_, i) => repo(`ines/r${i}`, "approved"))];
    render(<GithubControl linked={linked} repos={{ kind: "ready", repos, connect: true }} />);
    const trigger = screen.getByRole("button", { name: "GitHub ines" });
    expect(trigger.textContent).toContain("ines");
    await openMenu("GitHub ines");
    const menu = document.querySelector("[data-github-menu]")!;
    expect(menu.querySelectorAll("[data-repo]")).toHaveLength(MENU_REPOS);
    expect(menu.querySelector('[data-repo="ines/savings"]')?.textContent).toContain("Approved");
    expect(menu.querySelector('[data-repo="ines/cards"]')?.textContent).toContain("Waiting for an admin");
    expect(menu.querySelector('[data-repo="ines/vault"]')?.textContent).toContain("Rejected");
    const all = menu.querySelector("[data-view-all]")!;
    expect(all.getAttribute("href")).toBe("/settings?tab=repositories");
    expect(all.textContent).toContain("View all (8)");
    const manage = menu.querySelector("[data-manage-github]")!;
    expect(manage.textContent).toContain("Manage linked accounts");
    expect(manage.getAttribute("href")).toBe(MANAGE);
    expect(manage.getAttribute("target")).toBeNull();
    // Connect repository opens the same dialog as Settings.
    await act(async () => {
      fireEvent.click(menu.querySelector("[data-menu-connect]")!);
    });
    expect(screen.getByRole("dialog").textContent).toContain("Connect repository");
    expect(screen.getByLabelText("Repository (owner/name)")).toBeTruthy();
  });

  it("not linked: Link GitHub, to the account page in the same tab", () => {
    render(<GithubControl linked={{ ...linked, github: null }} repos={{ kind: "ready", repos: [], connect: true }} />);
    const link = screen.getByRole("link", { name: "Link GitHub" });
    expect(link.getAttribute("href")).toBe(MANAGE);
    expect(link.getAttribute("target")).toBeNull();
  });

  it("before Mynt has linked accounts or repositories: Link GitHub disabled, and the menu says repositories aren't available yet", async () => {
    render(<GithubControl linked={NOT_LINKED} repos={{ kind: "unsupported" }} />);
    expect((screen.getByRole("button", { name: "Link GitHub" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<GithubControl linked={linked} repos={{ kind: "unsupported" }} />);
    await openMenu("GitHub ines");
    const menu = document.querySelector("[data-github-menu]")!;
    expect(menu.querySelector('[data-repos="unsupported"]')?.textContent).toContain("aren't available yet");
    expect(menu.querySelector("[data-menu-connect]")?.getAttribute("data-disabled")).not.toBeNull();
  });
});

describe("the header's order", () => {
  it("Search, GitHub (hidden on phones), Wallet, New app, then the theme switcher at the far right", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      new Response(JSON.stringify(url.startsWith("/api/linked-accounts") ? { linked: { ...linked, wallet: { address: "0x52908400098527886E0F7030069857D2E4169EE7", chain: null, network: "EVM" } } } : url.startsWith("/api/repositories") ? { repositories: [], connect: true } : {}), { status: 200 }),
    );
    const { container } = render(
      <ThemeProvider>
        <TooltipProvider>
          <SidebarProvider>
            <SiteHeader title="Dashboard" />
          </SidebarProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    await act(async () => undefined);
    const header = container.querySelector("[data-site-header]")!;
    const at = ["[data-search-trigger]", "[data-github-control]", "[data-wallet-control]", "[data-new-app]", "[data-theme-switcher]"].map((s) => {
      const el = header.querySelector(s);
      expect(el, s).not.toBeNull();
      return [...header.querySelectorAll("*")].indexOf(el!);
    });
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(header.querySelector("[data-github-control]")!.closest(".hidden")?.className).toContain("md:flex");
  });
});
