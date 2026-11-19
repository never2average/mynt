// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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
    expect(document.querySelector("h1")!.textContent).toBe("Connect your agent");
    expect(document.querySelector("[data-connect-page] [data-connect-agent]")).not.toBeNull();
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

describe("docs page", () => {
  afterEach(cleanup);

  it("lists every section and every agent's steps, with this site's /mcp address", async () => {
    const { default: DocsPage } = await import("@/app/(studio)/docs/page");
    render(<DocsPage />);
    await act(async () => {});
    for (const s of ["address", "connect", "sign-in", "access", "try", "trouble"]) expect(document.querySelector(`[data-docs-section="${s}"]`)).not.toBeNull();
    for (const a of ["claude-code", "claude", "cursor", "vscode", "chatgpt"]) expect(document.querySelector(`[data-docs-agent="${a}"]`)).not.toBeNull();
    expect(document.querySelector("[data-copy-value]")!.textContent).toBe(`${window.location.origin}/mcp`);
  });

  it("the connect page links to it", async () => {
    render(<ConnectAgentPanel />);
    await act(async () => {});
    expect(document.querySelector("[data-docs-link]")!.getAttribute("href")).toBe("/docs");
  });
});
