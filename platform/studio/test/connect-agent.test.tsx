// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentInstructions, ConnectAgentDialog, claudeCodeCommand, cursorInstallLink, mcpUrl, vscodeInstallLink } from "@/components/connect-agent";

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

  it("switches agents in the dialog", async () => {
    render(<ConnectAgentDialog open onOpenChange={() => {}} />);
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

  it("the dialog links to it", async () => {
    render(<ConnectAgentDialog open onOpenChange={() => {}} />);
    await act(async () => {});
    expect(document.querySelector("[data-docs-link]")!.getAttribute("href")).toBe("/docs");
  });
});
