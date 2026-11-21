// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ChatWorkspaceShell } from "@/components/chat-workspace-shell";

const tabs = [
  { id: "pools", label: "Pools", content: <div data-testid="pools">pools</div> },
  { id: "drafts", label: "Drafts", content: <div>drafts</div> },
];

function Shell({ isMobile = false }: { isMobile?: boolean }) {
  return <ChatWorkspaceShell chat={<div data-testid="chat">chat</div>} showPanel tabs={tabs} tab="pools" onTab={() => {}} isMobile={isMobile} />;
}

describe("chat workspace: divider and collapsible panel", () => {
  beforeAll(() => {
    // jsdom has no matchMedia (useIsMobile reads it); the tests pass isMobile explicitly.
    window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("separates the chat from the panel with a visible divider", () => {
    render(<Shell />);
    expect(document.querySelector("[data-panel-side]")!.className).toContain("border-l");
  });

  it("collapses the panel away and opens it again", async () => {
    render(<Shell />);
    expect(document.querySelector("[data-panel-tabs]")).not.toBeNull();
    await act(async () => void fireEvent.click(document.querySelector("[data-collapse-panel]")!));
    expect(document.querySelector("[data-panel-side]")!.getAttribute("data-panel-collapsed")).toBe("true");
    expect(document.querySelector("[data-panel-tabs]")).toBeNull();
    expect(document.querySelector("[data-expand-panel]")!.getAttribute("aria-label")).toBe("Show tabs");
    await act(async () => void fireEvent.click(document.querySelector("[data-expand-panel]")!));
    expect(document.querySelector("[data-panel-tabs]")).not.toBeNull();
    expect(document.querySelector("[data-panel-rail]")).toBeNull();
  });

  it("remembers the collapsed panel in this browser", async () => {
    window.localStorage.setItem("mynt.chat-panel.collapsed", "1");
    render(<Shell />);
    await act(async () => {});
    // (Was a slim rail; collapsed now takes no room, and Show tabs floats in the chat's corner.)
    expect(document.querySelector("[data-panel-side]")!.getAttribute("data-panel-collapsed")).toBe("true");
    expect(document.querySelector("[data-chat-corner] [data-expand-panel]")).not.toBeNull();
  });

  it("puts Show tabs beside what the page floats at the chat's top right, collapsed or not open yet", async () => {
    // Collapsed: the panel takes no room and Show tabs sits right of the page's own button.
    window.localStorage.setItem("mynt.chat-panel.collapsed", "1");
    const { rerender } = render(<ChatWorkspaceShell chat={<div />} chatCorner={<button data-history-button>h</button>} showPanel tabs={tabs} tab="pools" onTab={() => {}} isMobile={false} />);
    await act(async () => {});
    const corner = document.querySelector("[data-chat-corner]")!;
    expect(corner.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "top-3", "right-3", "flex"]));
    expect(corner.closest("[data-chat-side]")).toBeTruthy();
    expect([...corner.querySelectorAll("button")].map((b) => (b.hasAttribute("data-history-button") ? "history" : b.getAttribute("aria-label")))).toEqual(["history", "Show tabs"]);
    expect(document.querySelector("[data-panel-side]")!.className).not.toContain("border-l");
    // Not open yet: Show tabs asks the page to open it.
    window.localStorage.clear();
    let opened = 0;
    rerender(<ChatWorkspaceShell chat={<div />} chatCorner={<button data-history-button>h</button>} showPanel={false} onOpenPanel={() => opened++} tabs={tabs} tab="pools" onTab={() => {}} isMobile={false} />);
    await act(async () => {});
    await act(async () => void fireEvent.click(document.querySelector("[data-chat-corner] [data-expand-panel]")!));
    expect(opened).toBe(1);
    // Open (and not collapsed): only the page's own button.
    cleanup();
    render(<ChatWorkspaceShell chat={<div />} chatCorner={<button data-history-button>h</button>} showPanel onOpenPanel={() => opened++} tabs={tabs} tab="pools" onTab={() => {}} isMobile={false} />);
    await act(async () => {});
    expect(document.querySelector("[data-expand-panel]")).toBeNull();
    expect(document.querySelector("[data-chat-corner] [data-history-button]")).not.toBeNull();
  });

  it("centres the chat while the tabs panel is closed or collapsed, and moves it left once the panel is open", async () => {
    const root = () => document.querySelector("[data-chat-workspace]")!;
    const { rerender } = render(<ChatWorkspaceShell chat={<div />} showPanel={false} tabs={tabs} tab="pools" onTab={() => {}} isMobile={false} />);
    expect(root().getAttribute("data-chat-align")).toBe("center");
    rerender(<ChatWorkspaceShell chat={<div />} showPanel tabs={tabs} tab="pools" onTab={() => {}} isMobile={false} />);
    await act(async () => {});
    expect(root().getAttribute("data-chat-align")).toBe("left");
    await act(async () => void fireEvent.click(document.querySelector("[data-collapse-panel]")!));
    expect(root().getAttribute("data-chat-align")).toBe("center");
    cleanup();
    render(<Shell isMobile />);
    expect(root().getAttribute("data-chat-align")).toBe("center");
  });

  it("has no collapse control on phones (one side at a time there)", () => {
    render(<Shell isMobile />);
    expect(document.querySelector("[data-collapse-panel]")).toBeNull();
  });

  it("collapsed, tabs with icons show one button each beside the corner, opening the panel on that tab", async () => {
    const Icon = () => <svg />;
    const iconTabs = tabs.map((t) => ({ ...t, icon: Icon, badge: t.id === "drafts" ? 2 : undefined }));
    window.localStorage.setItem("mynt.chat-panel.collapsed", "1");
    const picked: string[] = [];
    render(<ChatWorkspaceShell chat={<div />} chatCorner={<button data-history-button>h</button>} showPanel tabs={iconTabs} tab="pools" onTab={(id) => picked.push(id)} isMobile={false} />);
    await act(async () => {});
    const corner = document.querySelector("[data-chat-corner]")!;
    expect([...corner.querySelectorAll("button")].map((b) => (b.hasAttribute("data-history-button") ? "history" : b.getAttribute("aria-label")))).toEqual(["history", "Open Pools", "Open Drafts"]);
    expect(corner.querySelector('[data-expand-panel="drafts"] [data-tab-badge]')!.textContent).toBe("2");
    await act(async () => void fireEvent.click(corner.querySelector('[data-expand-panel="drafts"]')!));
    expect(picked).toEqual(["drafts"]);
    expect(document.querySelector("[data-panel-side]")!.getAttribute("data-panel-collapsed")).toBe("false");
    expect(document.querySelector("[data-panel-tabs]")).not.toBeNull();
  });
});
