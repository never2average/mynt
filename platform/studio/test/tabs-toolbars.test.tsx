// @vitest-environment jsdom
// One look for every page-level tab bar (shadcn's line tabs), no explainer text on Audits, and
// the header's controls as one outlined group with real marks.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const root = process.cwd();
const { Tab, TabList } = await import("@/components/ui/tabs");
const { AuditTabs } = await import("@/components/audits-view");
const { PanelTabStrip } = await import("@/components/chat-workspace-shell");
const { AUDIT_CLASS_HELP } = await import("@/lib/audit-classes");
const { ThemeProvider, ThemeSwitcher } = await import("@/components/theme-switcher");
const { WalletControl } = await import("@/components/wallet-control");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { fromLinkedAccounts } = await import("@/lib/linked-accounts");
const { GithubControl } = await import("@/components/github-control");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("page-level tab bars", () => {
  it("use the shared line variant: one bottom border, a 2px foreground underline on the active tab, muted otherwise, no pill and no accent", () => {
    const html = renderToStaticMarkup(
      <TabList aria-label="Demo">
        <Tab selected>One</Tab>
        <Tab selected={false}>Two</Tab>
      </TabList>,
    );
    expect(html).toMatch(/role="tablist" aria-label="Demo" data-slot="tabs-list" data-variant="line" class="[^"]*border-b/);
    expect(html).not.toMatch(/bg-muted|rounded-lg|[\s"]p-1[\s"]|primary|mint/);
    const active = /<button[^>]*data-state="active"[^>]*class="([^"]*)"/.exec(html)![1];
    for (const c of ["border-b-2", "data-[state=active]:border-foreground", "data-[state=active]:text-foreground", "text-muted-foreground"]) expect(active).toContain(c);
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*tabindex="0"/);
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*tabindex="-1"/);
  });

  it("Audits, Settings and the app and Earn right panels all use it", () => {
    expect(renderToStaticMarkup(<AuditTabs tab="security" onTab={() => undefined} />)).toContain('data-variant="line"');
    const panel = renderToStaticMarkup(<PanelTabStrip tabs={[{ id: "a", label: "Preview", content: null }, { id: "b", label: "Drafts", badge: 2, content: null }]} tab="a" onTab={() => undefined} />);
    expect(panel).toContain('data-variant="line"');
    expect(panel).not.toMatch(/bg-primary|text-primary-foreground/); // the badge is neutral too
    for (const f of ["components/workspace-view.tsx", "components/audits-view.tsx", "components/chat-workspace-shell.tsx"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).toMatch(/<TabList /);
      expect(src, f).not.toMatch(/role="tablist"/);
    }
  });

  it("move with the arrow keys", () => {
    const picked: string[] = [];
    render(
      <TabList aria-label="Demo">
        {["a", "b", "c"].map((t) => (
          <Tab key={t} selected={t === "a"} onClick={() => picked.push(t)}>
            {t}
          </Tab>
        ))}
      </TabList>,
    );
    screen.getByRole("tab", { name: "a" }).focus();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    expect(picked).toEqual(["b", "c"]);
  });
});

describe("Audits", () => {
  it("has no explainer text: none under its tabs, no tooltip help on them, no line about unclassified records", () => {
    const html = renderToStaticMarkup(<AuditTabs tab="security" onTab={() => undefined} />);
    for (const help of Object.values(AUDIT_CLASS_HELP)) expect(html).not.toContain(help);
    expect(html).not.toMatch(/title="/);
    const page = readFileSync(join(root, "app/(studio)/audits/page.tsx"), "utf8");
    expect(page).not.toMatch(/AUDIT_CLASS_HELP/);
    expect(page).not.toMatch(/sort its records into classes/);
    expect(page).not.toContain("data-unclassified");
  });
});

describe("the header's controls", () => {
  const SOLANA = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
  const linked = fromLinkedAccounts({ git: { username: "ines" }, wallets: [{ address: SOLANA, chain: "solana" }], manage_url: "https://accounts.example.test/user" });

  it("are one outlined group: GitHub with the GitHub mark, the wallet with a wallet icon and no chain mark, the theme an outlined icon button", async () => {
    render(
      <ThemeProvider>
        <TooltipProvider>
          <GithubControl linked={linked} repos={{ kind: "ready", repos: [], connect: true }} />
          <WalletControl linked={linked} access={{ builder: false, liquidityProvider: false }} />
          <ThemeSwitcher />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await act(async () => undefined);
    const gh = document.querySelector('[data-github-control="linked"]')!;
    expect(gh.getAttribute("data-variant")).toBe("outline");
    expect(gh.querySelector('svg[data-brand-icon="github"]')?.getAttribute("fill")).toBe("currentColor");
    expect(gh.querySelector("svg.lucide-github")).toBeNull();
    const wallet = document.querySelector('[data-wallet-control="linked"]')!;
    expect(wallet.getAttribute("data-variant")).toBe("outline");
    expect(wallet.querySelector("svg.lucide-wallet")).not.toBeNull();
    expect(wallet.querySelector("[data-brand-icon], [data-network-mark]")).toBeNull();
    const theme = screen.getByRole("button", { name: "Theme" });
    expect(theme.getAttribute("data-variant")).toBe("outline");
    expect(theme.className).toContain("size-8");
    // No brand colours: the marks are drawn in the text colour, and no namespace URL is committed.
    const icons = readFileSync(join(root, "components/brand-icons.tsx"), "utf8");
    expect(icons).not.toMatch(/xmlns|#[0-9a-f]{6}/i);
  });

  it("an unknown network gets no network mark, just the wallet icon", () => {
    const evm = fromLinkedAccounts({ wallets: [{ address: "0x52908400098527886E0F7030069857D2E4169EE7" }] });
    render(<WalletControl linked={evm} access={{ builder: false, liquidityProvider: false }} />);
    const wallet = document.querySelector('[data-wallet-control="linked"]')!;
    expect(wallet.querySelector("svg.lucide-wallet")).not.toBeNull();
    expect(wallet.querySelector("[data-network-mark]")).toBeNull();
  });
});
