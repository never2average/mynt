// @vitest-environment jsdom
// One look for every page-level tab bar (shadcn's line tabs), no explainer text on Audits, and
// the header's controls as one outlined group with real marks.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const root = process.cwd();
const { Tab, TabList, tabsThatFit } = await import("@/components/ui/tabs");
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
  it("use the shared line variant: one bottom line, a 2px foreground underline on the active tab, muted otherwise, no pill and no accent", () => {
    const html = renderToStaticMarkup(
      <TabList aria-label="Demo">
        <Tab selected>One</Tab>
        <Tab selected={false}>Two</Tab>
      </TabList>,
    );
    expect(html).toMatch(/role="tablist" aria-label="Demo" data-slot="tabs-list" data-variant="line"/);
    // One bottom line across the row (the tablist and More), drawn inside it so the active underline covers it.
    expect(html).toMatch(/class="[^"]*shadow-\[inset_0_-1px_0_var\(--color-border\)\][^"]*" data-slot="tabs-row"/);
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

  it("never scroll: no overflow-x-auto or scrollbar on any tab row, and the focus ring stays inside the bar", () => {
    const html = renderToStaticMarkup(
      <TabList aria-label="Demo">
        <Tab selected>One</Tab>
        <Tab selected={false}>Two</Tab>
      </TabList>,
    );
    expect(html).not.toMatch(/overflow-x-auto|overflow-x-scroll|overflow-auto|overflow-y-auto|scrollbar-none/);
    const tab = /<button[^>]*class="([^"]*)"/.exec(html)![1].split(" ");
    expect(tab).not.toContain("-mb-px");
    expect(tab).toEqual(expect.arrayContaining(["focus-visible:ring-2", "focus-visible:ring-inset"]));
    const panel = renderToStaticMarkup(<PanelTabStrip tabs={["a", "b", "c", "d", "e"].map((id) => ({ id, label: id, content: null }))} tab="a" onTab={() => undefined} />);
    expect(panel).not.toMatch(/overflow-x-auto|overflow-auto/);
    expect(renderToStaticMarkup(<AuditTabs tab="security" onTab={() => undefined} />)).not.toMatch(/overflow-x-auto/);
    expect(readFileSync(join(root, "components/ui/tabs.tsx"), "utf8")).not.toMatch(/overflow-x-auto|scrollbar-none|matchMedia/);
    for (const f of ["app/(studio)/licences/licences-page.tsx", "components/admin-kit.tsx", "components/risk-area-tabs.tsx", "components/licences-kit.tsx", "components/workspace-view.tsx", "components/audits-view.tsx", "components/chat-workspace-shell.tsx"]) {
      expect(readFileSync(join(root, f), "utf8"), f).not.toMatch(/<TabList [^>]*className="[^"]*overflow/);
    }
  });

  describe("when the row is too narrow", () => {
    // jsdom has no layout: the row's and each tab's width are given here, and the row's ResizeObserver is driven by hand.
    const TAB = 120;
    const MORE = 90;
    let room = 0;
    const observers: (() => void)[] = [];
    beforeEach(() => {
      room = 0;
      observers.length = 0;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        const slot = this.getAttribute("data-slot");
        const width = slot === "tabs-row" ? room : slot === "tabs-trigger" ? TAB : slot === "tabs-more" ? MORE : 0;
        return { width, height: 36, top: 0, left: 0, right: width, bottom: 36, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      });
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private cb: () => void) {}
          observe() {
            observers.push(() => this.cb());
          }
          disconnect() {}
          unobserve() {}
        },
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });
    const resize = async (width: number) => {
      room = width;
      await act(async () => observers.forEach((o) => o()));
    };

    const FIVE = ["Business agreements", "MSA", "SLA", "Audit obligations", "Activity"];
    function Bar({ start = 0, count = 5 }: { start?: number; count?: number }) {
      const [tab, setTab] = useState(start);
      return (
        <TabList aria-label="Demo">
          {FIVE.slice(0, count).map((t, i) => (
            <Tab key={t} selected={tab === i} onClick={() => setTab(i)} data-demo-tab={i}>
              {t}
            </Tab>
          ))}
        </TabList>
      );
    }
    const inlineTabs = () => screen.getAllByRole("tab").map((t) => t.textContent);
    const more = () => document.querySelector("[data-tabs-more]") as HTMLButtonElement | null;

    it("a wide row (or one not measured) shows every tab inline and no More", async () => {
      render(<Bar />);
      expect(inlineTabs()).toEqual(FIVE); // nothing measured yet: everything fits
      expect(more()).toBeNull();
      await resize(5 * TAB + 4 * 16); // exactly room for all five
      expect(inlineTabs()).toEqual(FIVE);
      expect(more()).toBeNull();
    });

    it("a narrow row shows the first tabs that fit and a labelled More after the tablist; widening it brings them back", async () => {
      render(<Bar />);
      await resize(3 * TAB + 3 * 16 + MORE); // three tabs and More
      expect(inlineTabs()).toEqual(["Business agreements", "MSA", "SLA"]);
      const trigger = more()!;
      expect(trigger.textContent).toBe("More");
      expect(trigger.querySelector("svg.lucide-chevron-down")).not.toBeNull();
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("data-state")).toBe("inactive");
      expect(screen.getByRole("tablist").contains(trigger)).toBe(false);
      expect(screen.getByRole("tablist").nextElementSibling).toBe(trigger);
      await resize(100); // narrower than anything: still the first two
      expect(inlineTabs()).toEqual(["Business agreements", "MSA"]);
      await resize(2000);
      expect(inlineTabs()).toEqual(FIVE);
      expect(more()).toBeNull();
    });

    it("choosing a tab under More activates it: the trigger reads More: <tab> and is the active one; an inline tab clears it", async () => {
      render(<Bar />);
      await resize(3 * TAB + 3 * 16 + MORE);
      await act(async () => void fireEvent.keyDown(more()!, { key: "Enter" }));
      const items = [...document.querySelectorAll("[data-tabs-more-menu] [data-tabs-more-item]")];
      expect(items.map((i) => i.textContent)).toEqual(["Audit obligations", "Activity"]);
      expect(items.map((i) => i.getAttribute("role"))).toEqual(["menuitem", "menuitem"]);
      await act(async () => void fireEvent.click(document.querySelector('[data-tabs-more-item][data-demo-tab="3"]')!));
      expect(more()!.textContent).toBe("More: Audit obligations");
      expect(more()!.getAttribute("data-state")).toBe("active");
      expect(screen.getAllByRole("tab").every((t) => t.getAttribute("aria-selected") === "false")).toBe(true);
      // The tablist stays in the keyboard order (its first tab), then More.
      expect(screen.getAllByRole("tab").map((t) => t.tabIndex)).toEqual([0, -1, -1]);
      await act(async () => void fireEvent.click(screen.getByRole("tab", { name: "MSA" })));
      expect(more()!.textContent).toBe("More");
      expect(screen.getByRole("tab", { name: "MSA" }).getAttribute("aria-selected")).toBe("true");
    });

    it("a page opened on a tab under More shows it on the trigger", async () => {
      render(<Bar start={4} />);
      await resize(3 * TAB + 3 * 16 + MORE);
      expect(more()!.textContent).toBe("More: Activity");
    });

    it("three tabs or fewer that fit never show More; two never do", async () => {
      render(<Bar count={3} />);
      await resize(3 * TAB + 2 * 16);
      expect(inlineTabs()).toEqual(FIVE.slice(0, 3));
      expect(more()).toBeNull();
      cleanup();
      render(<Bar count={2} />);
      await resize(50);
      expect(inlineTabs()).toEqual(FIVE.slice(0, 2));
      expect(more()).toBeNull();
    });
  });

  it("the fit rule: all when they fit or nothing is measured, else as many as fit beside More, at least two", () => {
    expect(tabsThatFit(5, 0, [], 0)).toBe(5);
    expect(tabsThatFit(5, 400, [0, 0, 0, 0, 0], 0)).toBe(5);
    expect(tabsThatFit(5, 664, [120, 120, 120, 120, 120], 90)).toBe(5);
    expect(tabsThatFit(5, 498, [120, 120, 120, 120, 120], 90)).toBe(3);
    expect(tabsThatFit(5, 10, [120, 120, 120, 120, 120], 90)).toBe(2);
    expect(tabsThatFit(2, 10, [120, 120], 90)).toBe(2);
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
