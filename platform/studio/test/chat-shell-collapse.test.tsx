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

  it("collapses the panel to a rail and opens it again", async () => {
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
    expect(document.querySelector("[data-panel-rail]")).not.toBeNull();
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
});
