// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

// The chat workspace shared by an app's builder and Earn: the same shell, different right-hand tabs.

const nav = { pathname: "/app-1" };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
}));

const { ChatWorkspaceShell } = await import("@/components/chat-workspace-shell");
const { ProjectWorkspaceShell, BUILDER_TABS } = await import("@/app/(studio)/[projectId]/project-workspace-shell");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { SidebarProvider } = await import("@/components/ui/sidebar");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
const fetched: string[] = [];
beforeEach(() => {
  fetched.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(String(url));
    if (String(url).startsWith("/api/projects"))
      return new Response(JSON.stringify({ projects: [{ id: "app-1", name: "Round-up savings", stage: "idea", previewUrl: null, conversations: [] }] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const tabs = [
  { id: "a", label: "Alpha", content: <p>alpha body</p> },
  { id: "b", label: "Beta", badge: 2, content: <p>beta body</p> },
];

describe("ChatWorkspaceShell", () => {
  it("shows the chat alone and centred until there's a panel, then the chat beside a tabbed panel", () => {
    const { rerender, container } = render(<ChatWorkspaceShell chat={<p>chat</p>} showPanel={false} tabs={tabs} tab="a" onTab={() => undefined} isMobile={false} />);
    const grid = container.querySelector("[data-chat-workspace] > div") as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe("1fr 0fr");
    expect(container.querySelector("[data-panel-tabs]")).toBeNull();
    rerender(<ChatWorkspaceShell chat={<p>chat</p>} showPanel tabs={tabs} tab="b" onTab={() => undefined} panelHeader={<span>header</span>} isMobile={false} />);
    expect(grid.style.gridTemplateColumns).toBe("2fr 3fr");
    expect(container.querySelector('[data-panel-tab="b"]')?.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[data-panel-tab="b"] [data-badge]')?.textContent).toBe("2");
    expect(container.querySelector('[data-panel-tab="a"] [data-badge]')).toBeNull();
    expect(container.querySelector('[data-panel-content="a"]')?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector('[data-panel-content="b"]')?.hasAttribute("hidden")).toBe(false);
    expect(container.textContent).toContain("header");
  });

  it("on phones shows one side at a time, switched by the round button", () => {
    const { container } = render(<ChatWorkspaceShell chat={<p>chat</p>} showPanel tabs={tabs} tab="a" onTab={() => undefined} isMobile />);
    const chatSide = container.querySelector("[data-chat-side]")!;
    const panelSide = container.querySelector("[data-panel-side]")!;
    expect(panelSide.classList.contains("hidden")).toBe(true);
    expect(chatSide.classList.contains("hidden")).toBe(false);
    fireEvent.click(container.querySelector("[data-mobile-switch]")!);
    expect(chatSide.classList.contains("hidden")).toBe(true);
    expect(panelSide.classList.contains("hidden")).toBe(false);
  });
});

describe("an app's builder", () => {
  it("renders the shared shell with Preview (the default), P&L, Licences, Security, SDK and Activity beside the chat; Promote is an action, not a tab", async () => {
    expect(BUILDER_TABS.map((t) => t.label)).toEqual(["Preview", "P&L", "Licences", "Security", "SDK", "Activity"]);
    const { container } = render(
      <TooltipProvider>
        <SidebarProvider>
          <ProjectWorkspaceShell projectId="app-1">
            <p>the chat</p>
          </ProjectWorkspaceShell>
        </SidebarProvider>
      </TooltipProvider>,
    );
    await act(async () => undefined);
    expect(container.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
    expect([...container.querySelectorAll("[data-panel-tab]")].map((b) => [b.getAttribute("data-panel-tab"), b.getAttribute("aria-selected")])).toEqual([
      ["preview", "true"],
      ["pnl", "false"],
      ["licences", "false"],
      ["security", "false"],
      ["sdk", "false"],
      ["activity", "false"],
    ]);
    expect(container.querySelector('[data-panel-tab="promote"]')).toBeNull();
    // Only the Preview is read until another tab is opened: no app tab was fetched.
    expect(fetched.filter((u) => u.includes("/panel?"))).toEqual([]);
    fireEvent.click(container.querySelector('[data-panel-tab="licences"]')!);
    await act(async () => undefined);
    expect(fetched.filter((u) => u.includes("/panel?"))).toEqual(["/api/apps/app-1/panel?tab=licences"]);
    expect(container.querySelector('[data-panel-content="preview"]')?.textContent).toContain("No preview yet");
    expect(container.querySelector("[data-chat-side]")?.textContent).toContain("the chat");
    expect(container.textContent).toContain("Round-up savings");
  });
});
