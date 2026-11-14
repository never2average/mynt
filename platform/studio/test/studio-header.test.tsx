// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";

const nav = { pathname: "/", pushed: [] as string[] };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: (href: string) => nav.pushed.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { default: StudioLayout } = await import("@/app/(studio)/layout");
const { AppTopBar } = await import("@/components/app-top-bar");
const { AskAiPanel, AskAiUnavailable, NOT_CONFIGURED } = await import("@/components/ask-ai");
const { FOLDER_ICONS, NavFolders } = await import("@/components/nav-folders");
const { NavUser, REVEAL_LOGOUT } = await import("@/components/nav-user");
const { SearchResults } = await import("@/components/studio-search");
const { Command, CommandInput, CommandList } = await import("@/components/ui/command");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { isAppPath, pageTitle, searchIndex, searchStudio } = await import("@/lib/studio-search");
const { groupByStage } = await import("@/lib/workspaces");

beforeAll(() => {
  // What jsdom lacks and Radix / cmdk use.
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});

beforeEach(() => {
  nav.pathname = "/";
  nav.pushed = [];
  // The studio's API, as an empty account: no workspaces, apps or members yet; Ask AI off.
  vi.stubGlobal("fetch", async (url: string) => {
    const body = url.startsWith("/api/ask") ? { enabled: false } : url.startsWith("/api/workspaces") ? { workspaces: [], supported: false } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const withProviders = (ui: React.ReactNode, open = true) => (
  <TooltipProvider>
    <SidebarProvider defaultOpen={open}>{ui}</SidebarProvider>
  </TooltipProvider>
);

describe("the account row's Log out", () => {
  it("is an icon-only button, hidden until the row is hovered or focused, and always shown without hover (touch)", () => {
    render(withProviders(<NavUser user={{ name: "Ines Diaz", email: "ines@example.com" }} />));
    const button = screen.getByRole("button", { name: "Log out" });
    expect(button.textContent?.trim()).toBe(""); // the LogOut icon only
    expect(button.querySelector("svg.lucide-log-out")).not.toBeNull();
    for (const c of ["opacity-0", "group-hover/account:opacity-100", "group-focus-within/account:opacity-100", "focus-visible:opacity-100", "[@media(hover:none)]:opacity-100"])
      expect(button.className).toContain(c);
    expect(REVEAL_LOGOUT).toContain("opacity-0");
    // The row is the hover/focus group.
    expect(button.closest("[data-account]")?.className).toContain("group/account");
  });

  it("is still reachable by keyboard: a real button in the tab order, posting to logout", () => {
    render(withProviders(<NavUser user={{ name: "Ines Diaz", email: null }} />));
    const button = screen.getByRole("button", { name: "Log out" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("tabindex")).not.toBe("-1");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("type")).toBe("submit");
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    const form = button.closest("form");
    expect(form?.getAttribute("action")).toBe("/api/auth/logout");
    expect(form?.getAttribute("method")).toBe("post");
  });
});

describe("the sidebar's folders", () => {
  const groups = groupByStage([{ id: "a", name: "Allowance", stage: "production" }]);
  const iconsOf = (container: HTMLElement) =>
    ["production", "staging", "idea"].map((s) => container.querySelector(`[data-folder="${s}"] [data-folder-icon]`)?.getAttribute("class") ?? "");

  it("each has its own icon: Production a rocket, Staging a flask, Ideas a lightbulb", () => {
    const { container } = render(withProviders(<NavFolders groups={groups} />));
    const icons = iconsOf(container);
    expect(icons[0]).toContain("lucide-rocket");
    expect(icons[1]).toContain("lucide-flask-conical");
    expect(icons[2]).toContain("lucide-lightbulb");
    expect(new Set(icons).size).toBe(3);
    expect(new Set(Object.values(FOLDER_ICONS)).size).toBe(3);
  });

  it("keeps them when the sidebar is collapsed, each with its name as the tooltip", () => {
    const { container } = render(withProviders(<NavFolders groups={groups} />, false));
    expect(new Set(iconsOf(container)).size).toBe(3);
    for (const s of ["production", "staging", "idea"]) {
      const button = container.querySelector(`[data-folder="${s}"] [data-sidebar="menu-button"]`);
      expect(button?.getAttribute("data-state")).toBeTruthy(); // a tooltip trigger (Radix sets its state)
    }
  });
});

describe("page titles", () => {
  it("are only the page's name, never the workspace", () => {
    expect(["/", "/coverage", "/licences", "/audits", "/members", "/builds", "/new"].map(pageTitle)).toEqual([
      "Dashboard",
      "Coverage",
      "Licences",
      "Audits",
      "Members",
      "Builds",
      "New app",
    ]);
    expect(pageTitle("/app-1")).toBeNull();
    expect(pageTitle("/app-1/build-9")).toBeNull();
    expect([isAppPath("/"), isAppPath("/coverage"), isAppPath("/app-1"), isAppPath("/app-1/b")]).toEqual([false, false, true, true]);
  });
});

describe("the studio's header", () => {
  const pages: [string, string][] = [
    ["/", "Dashboard"],
    ["/coverage", "Coverage"],
    ["/licences", "Licences"],
    ["/audits", "Audits"],
    ["/members", "Members"],
    ["/builds", "Builds"],
    ["/new", "New app"],
  ];

  for (const [path, title] of pages) {
    it(`on ${path}: sticky, titled "${title}" only, with search and New app`, async () => {
      nav.pathname = path;
      const { container } = render(<TooltipProvider>{<StudioLayout><p>page</p></StudioLayout>}</TooltipProvider>);
      await act(async () => undefined);
      const header = container.querySelector("[data-site-header]")!;
      expect(header).not.toBeNull();
      expect(header.className).toContain("sticky");
      expect(header.className).toContain("top-0");
      expect(header.querySelector("h1")?.textContent).toBe(title);
      expect(header.textContent).not.toMatch(/·|workspace/i);
      const newApp = header.querySelector("[data-new-app]");
      expect(newApp?.getAttribute("href")).toBe("/new");
      expect(newApp?.textContent).toContain("New app");
      expect(header.querySelector("[data-search-trigger]")).not.toBeNull();
      expect(container.querySelector("[data-app-top-bar]")).toBeNull();
    });
  }

  it("inside an app, gives way to the app's own top bar (the generic header isn't shown)", async () => {
    nav.pathname = "/app-1/build-9";
    const { container } = render(<TooltipProvider>{<StudioLayout><p>app</p></StudioLayout>}</TooltipProvider>);
    await act(async () => undefined);
    expect(container.querySelector("[data-site-header]")).toBeNull();
  });

  it("Cmd+K opens the search modal, with Ask AI showing it's not configured", async () => {
    render(<TooltipProvider>{<StudioLayout><p>page</p></StudioLayout>}</TooltipProvider>);
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    await act(async () => undefined);
    expect(screen.getByPlaceholderText(/Search apps, pages, members/)).toBeTruthy();
    const ask = document.querySelector("[data-ask-ai]")!;
    expect(ask.getAttribute("data-disabled")).toBe("true");
    expect(ask.textContent).toContain(NOT_CONFIGURED);
  });
});

describe("an app's top bar", () => {
  const props = {
    appName: "Round-up savings",
    stage: "staging" as const,
    backLabel: "All apps",
    onBack: () => undefined,
    previewUrl: "https://pv.example.test/dashboard?token=abc",
    iframeRef: createRef<HTMLIFrameElement>(),
    device: "desktop" as const,
    onDevice: () => undefined,
  };

  it("names the app and its stage, with the preview's controls, and compact search and New app", () => {
    const { container } = render(withProviders(<AppTopBar {...props} />));
    const bar = container.querySelector("[data-app-top-bar]")!;
    expect(bar.className).toContain("sticky");
    expect(bar.querySelector("[data-app-name]")?.textContent).toBe("Round-up savings");
    expect(bar.querySelector("[data-app-stage]")?.textContent).toBe("Staging");
    expect(screen.getByRole("button", { name: "Reload preview" })).toBeTruthy();
    expect((screen.getByLabelText("Preview path") as HTMLInputElement).value).toBe("/dashboard");
    expect(screen.getByRole("button", { name: "Desktop" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Tablet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Phone" })).toBeTruthy();
    const open = screen.getByRole("link", { name: "Open preview in a new tab" });
    expect(open.getAttribute("href")).toBe("https://pv.example.test/dashboard?token=abc");
    expect(open.getAttribute("target")).toBe("_blank");
    expect(open.getAttribute("rel")).toContain("noopener");
    expect(bar.querySelector("[data-new-app]")?.getAttribute("aria-label")).toBe("New app");
    expect(bar.querySelector("[data-search-trigger]")).not.toBeNull();
    // Not the generic page header.
    expect(container.querySelector("[data-site-header]")).toBeNull();
  });

  it("switches the preview's width", () => {
    const picked: string[] = [];
    render(withProviders(<AppTopBar {...props} onDevice={(d) => picked.push(d)} />));
    fireEvent.click(screen.getByRole("button", { name: "Phone" }));
    fireEvent.click(screen.getByRole("button", { name: "Tablet" }));
    expect(picked).toEqual(["mobile", "tablet"]);
  });

  it("without a preview yet, shows the name and stage and no preview controls", () => {
    const { container } = render(withProviders(<AppTopBar {...props} previewUrl={null} />));
    expect(container.querySelector("[data-preview-controls]")).toBeNull();
    expect(container.querySelector("[data-app-name]")?.textContent).toBe("Round-up savings");
  });
});

const index = searchIndex({
  apps: [
    { id: "a1", name: "Round-up savings", stage: "production" },
    { id: "a2", name: "Budgeting", stage: "staging" },
    { id: "a3", name: "Crypto vault", stage: "idea" },
  ],
  members: [{ userId: "u1", name: "Ines Diaz", email: "ines@example.com", role: "owner" }],
  licences: [{ partner: "Lead Bank", type: "Money transmitter", regulator: "NYDFS", number: "MT-1", states: ["NY"], status: "active" }],
  auditActions: ["app.created", "member.invited", "app.created"],
});

describe("search", () => {
  it("finds pages, apps by name or stage, members, licences and audit actions", () => {
    const labels = (q: string) => searchStudio(index, q).map((i) => `${i.group}:${i.label}`);
    expect(labels("budg")).toEqual(["Apps:Budgeting"]);
    expect(labels("staging")).toEqual(["Apps:Budgeting"]);
    expect(labels("production")).toEqual(["Apps:Round-up savings"]);
    expect(labels("ines")).toEqual(["Members:Ines Diaz"]);
    expect(labels("nydfs")).toEqual(["Licences:Lead Bank · Money transmitter"]);
    expect(labels("invited")).toEqual(["Audit actions:member.invited"]);
    expect(labels("cover")).toEqual(["Pages:Coverage"]);
    expect(labels("zzz")).toEqual([]);
    // Every word must match; empty lists the pages and apps.
    expect(labels("round savings")).toEqual(["Apps:Round-up savings"]);
    expect(searchStudio(index, "").every((i) => i.group === "Pages" || i.group === "Apps")).toBe(true);
    // Audit actions are listed once, and open the trail filtered to them.
    expect(index.filter((i) => i.group === "Audit actions").map((i) => i.href)).toEqual(["/audits?action=app.created", "/audits?action=member.invited"]);
    expect(index.find((i) => i.label === "Crypto vault")?.href).toBe("/a3");
  });

  function results(askStatus: "enabled" | "disabled", onSelect: (i: unknown) => unknown = () => undefined, onAsk: () => unknown = () => undefined) {
    const Harness = () => {
      const [q, setQ] = useState("");
      return (
        <Command shouldFilter={false} loop>
          <CommandInput value={q} onValueChange={setQ} placeholder="Search" />
          <CommandList>
            <SearchResults items={index} query={q} askStatus={askStatus} onSelect={onSelect} onAsk={onAsk} />
          </CommandList>
        </Command>
      );
    };
    return render(<Harness />);
  }

  it("filters as you type, and moves through the results with the arrow keys and Enter", async () => {
    const picked: string[] = [];
    let asked = 0;
    results("enabled", (i) => picked.push((i as { href: string }).href), () => asked++);
    const input = screen.getByPlaceholderText("Search");
    await act(async () => {
      fireEvent.change(input, { target: { value: "a" } });
    });
    expect(document.querySelectorAll("[data-result]").length).toBeGreaterThan(1);
    await act(async () => {
      fireEvent.change(input, { target: { value: "budg" } });
    });
    const shown = [...document.querySelectorAll("[data-result]")].map((e) => e.textContent);
    expect(shown).toEqual(["BudgetingStaging"]);
    const selected = () => document.querySelector('[cmdk-item][data-selected="true"]');
    // Ask AI is first; Down moves to the first result, Enter opens it.
    expect(selected()?.hasAttribute("data-ask-ai")).toBe(true);
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    expect(selected()?.textContent).toBe("BudgetingStaging");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(picked).toEqual(["/a2"]);
    // Up goes back to Ask AI, and Enter asks.
    await act(async () => {
      fireEvent.keyDown(input, { key: "ArrowUp" });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(asked).toBe(1);
    expect(document.querySelector("[data-ask-ai]")?.textContent).toContain("Ask AI: “budg”");
  });

  it("with no model configured, Ask AI is disabled and says so, and search still works", async () => {
    let asked = 0;
    results("disabled", () => undefined, () => asked++);
    const ask = document.querySelector("[data-ask-ai]")!;
    expect(ask.getAttribute("data-disabled")).toBe("true");
    expect(ask.textContent).toContain(NOT_CONFIGURED);
    const input = screen.getByPlaceholderText("Search");
    await act(async () => {
      fireEvent.change(input, { target: { value: "ines" } });
    });
    expect([...document.querySelectorAll("[data-result]")].map((e) => e.textContent)).toEqual(["Ines Diazowner"]);
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(asked).toBe(0);
  });
});

describe("Ask AI when not configured", () => {
  it("shows the notice and a composer that can't be typed in", () => {
    render(<AskAiUnavailable status="disabled" />);
    expect(screen.getByRole("status").textContent).toContain(NOT_CONFIGURED);
    const box = screen.getByLabelText("Message input") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe(NOT_CONFIGURED);
  });

  it("the panel keeps Search (back), New chat and Close", () => {
    const chat = { messages: [], setMessages: () => undefined, stop: async () => undefined } as unknown as Parameters<typeof AskAiPanel>[0]["chat"];
    let back = 0;
    render(<AskAiPanel chat={chat} status="disabled" onBack={() => back++} onClose={() => undefined} onNavigate={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    expect(back).toBe(1);
    expect((screen.getByRole("button", { name: /New chat/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(NOT_CONFIGURED);
  });
});
