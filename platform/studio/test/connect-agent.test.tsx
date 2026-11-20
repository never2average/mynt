// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { AgentInstructions, ConnectAgentButton, ConnectAgentPanel, claudeCodeCommand, cursorInstallLink, mcpUrl, vscodeInstallLink } from "@/components/connect-agent";

const URL_ = "https://studio.example/mcp";

describe("connect your agent", () => {
  afterEach(cleanup);

  it("points agents at this site's own /mcp", () => {
    expect(mcpUrl("https://studio.example")).toBe(URL_);
    expect(mcpUrl("https://studio.example/")).toBe(URL_);
  });

  it("builds each agent's install command or link with the address", () => {
    expect(claudeCodeCommand(URL_)).toBe(`claude mcp add --transport http mynt ${URL_}`);
    const c = new URLSearchParams(cursorInstallLink(URL_).split("?")[1]);
    expect(c.get("name")).toBe("mynt");
    expect(JSON.parse(atob(c.get("config")!))).toEqual({ url: URL_ });
    expect(JSON.parse(decodeURIComponent(vscodeInstallLink(URL_).split("?")[1]))).toEqual({ name: "mynt", type: "http", url: URL_ });
  });

  it("shows a one-click button where the agent has one, and the address everywhere", () => {
    for (const a of ["claude-code", "claude", "cursor", "vscode", "chatgpt", "other"] as const) {
      const { container, unmount } = render(<AgentInstructions agent={a} url={URL_} />);
      expect(container.querySelector("[data-copy-value]")!.textContent).toContain(URL_);
      expect(!!container.querySelector("[data-install-link]")).toBe(a === "cursor" || a === "vscode");
      unmount();
    }
  });

  it("is a page of its own, opened from the header's plug button", async () => {
    render(<TooltipProvider><ConnectAgentButton /></TooltipProvider>);
    const button = document.querySelector("[data-connect-agent-open]")!;
    expect(button.getAttribute("href")).toBe("/connect");
    expect(button.getAttribute("aria-label")).toBe("Connect your agent");
    cleanup();
    const { default: ConnectPage } = await import("@/app/(studio)/connect/page");
    render(<ConnectPage />);
    await act(async () => {});
    // The page header names it ("Connect your agent"); the body doesn't repeat it.
    expect(document.querySelector("[data-connect-page] h1")).toBeNull();
    expect(document.querySelector("[data-connect-page] [data-connect-agent]")).not.toBeNull();
  });

  it("is laid out in the dashboard's page frame, each section a panel with its section heading", async () => {
    const { default: ConnectPage } = await import("@/app/(studio)/connect/page");
    render(<ConnectPage />);
    await act(async () => {});
    const page = document.querySelector("[data-connect-page]")!;
    expect(page.className).toContain("p-4");
    expect(page.className).toContain("lg:p-6");
    expect(page.className).not.toContain("max-w-5xl");
    expect(document.querySelector("article")!.className).toMatch(/gap-4 lg:gap-5/);
    for (const s of document.querySelectorAll("[data-docs-section]")) {
      expect(s.className).toContain("rounded-lg border");
      expect(s.querySelector("h2")!.className).toBe("text-sm font-semibold");
    }
    // No box inside the panel around the picker.
    expect(document.querySelector('[data-docs-section="connect"] .rounded-lg.border')).toBeNull();
  });

  it("picks the agent with the studio's line tabs", async () => {
    render(<ConnectAgentPanel />);
    await act(async () => {});
    const list = document.querySelector('[role="tablist"][aria-label="Agent"]')!;
    expect(list.getAttribute("data-slot")).toBe("tabs-list");
    expect(list.getAttribute("data-variant")).toBe("line");
    const tab = list.querySelector('[data-agent-tab="claude-code"]')!;
    expect(tab.getAttribute("data-slot")).toBe("tabs-trigger");
    expect(tab.getAttribute("data-state")).toBe("active");
    expect(list.querySelector('[data-agent-tab="cursor"]')!.getAttribute("data-state")).toBe("inactive");
    expect(list.querySelector('[data-slot="button"]')).toBeNull();
  });

  it("switches agents on the page", async () => {
    render(<ConnectAgentPanel />);
    await act(async () => {});
    expect(document.querySelector('[data-agent="claude-code"]')).not.toBeNull();
    await act(async () => void fireEvent.click(document.querySelector('[data-agent-tab="cursor"]')!));
    expect(document.querySelector('[data-agent="cursor"]')).not.toBeNull();
    expect(document.querySelector("[data-copy-value]")!.textContent).toBe(`${window.location.origin}/mcp`);
  });
});

describe("the connect page is the guide too (/docs comes here)", () => {
  afterEach(cleanup);

  it("has the picker first, then every section of the guide, with this site's /mcp address", async () => {
    const { default: ConnectPage } = await import("@/app/(studio)/connect/page");
    render(<ConnectPage />);
    await act(async () => {});
    const order = [...document.querySelectorAll("[data-docs-section]")].map((e) => e.getAttribute("data-docs-section"));
    expect(order).toEqual(["connect", "address", "sign-in", "access", "try", "trouble"]);
    expect(document.querySelector('[data-docs-section="connect"] [data-connect-agent]')).not.toBeNull();
    // It scrolls in its own box, as every long studio page does (the shell fixes the window's height).
    expect(document.querySelector("[data-connect-scroll]")!.className).toMatch(/min-h-0 flex-1 [^"]*overflow-y-auto/);
    expect(document.querySelector("[data-connect-scroll] [data-connect-page]")).not.toBeNull();
    expect(document.querySelector('[data-docs-section="address"] [data-copy-value]')!.textContent).toBe(`${window.location.origin}/mcp`);
    expect(document.querySelector("[data-docs-link]")).toBeNull();
    // On this page sits on the right, after the guide, behind a vertical rule.
    const nav = document.querySelector('[data-on-this-page="side"]')!;
    expect(nav.className).toContain("border-l");
    expect(document.querySelector("article")!.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("goes to a section on a click and highlights it, wherever the page scrolls", async () => {
    const { default: ConnectPage } = await import("@/app/(studio)/connect/page");
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    render(<ConnectPage />);
    await act(async () => {});
    const link = document.querySelector('[data-on-this-page="side"] [data-section-link="access"]')!;
    await act(async () => void fireEvent.click(link));
    expect(scrolled).toContain("access");
    expect(window.location.hash).toBe("#access");
    // Opened at a #section, it goes there.
    cleanup();
    scrolled.length = 0;
    window.history.replaceState(null, "", "#trouble");
    render(<ConnectPage />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(scrolled).toContain("trouble");
    expect(document.querySelector('[data-on-this-page="side"] [aria-current="location"]')!.getAttribute("data-section-link")).toBe("trouble");
    window.history.replaceState(null, "", "#");
  });

  it("/docs sends people to /connect", async () => {
    vi.resetModules();
    const redirect = vi.fn();
    vi.doMock("next/navigation", () => ({ redirect }));
    const { default: DocsPage } = await import("@/app/(studio)/docs/page");
    (DocsPage as () => void)();
    expect(redirect).toHaveBeenCalledWith("/connect");
    vi.doUnmock("next/navigation");
  });
});
