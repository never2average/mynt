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

  it("the plug button opens the docs' Connect your agent page; /connect sends old links there", async () => {
    render(<TooltipProvider><ConnectAgentButton /></TooltipProvider>);
    const button = document.querySelector("[data-connect-agent-open]")!;
    expect(button.getAttribute("href")).toBe("/docs/connect");
    expect(button.getAttribute("aria-label")).toBe("Connect your agent");
    const { default: ConnectPage } = await import("@/app/(studio)/connect/page");
    let thrown: unknown;
    try {
      ConnectPage();
    } catch (e) {
      thrown = e;
    }
    // next/navigation's redirect throws, carrying where it goes.
    expect(String((thrown as { digest?: string })?.digest ?? thrown)).toContain("/docs/connect");
    // Before the sign-in check too: Next's config redirects run ahead of the proxy, so signed-out visitors land
    // on the public docs page instead of the login.
    const { STUDIO_REDIRECTS } = await import("@/lib/redirects");
    expect(STUDIO_REDIRECTS).toContainEqual({ source: "/connect", destination: "/docs/connect", permanent: false });
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

describe("the docs' Connect your agent page is the guide", () => {
  afterEach(cleanup);

  it("/docs is the docs site now, and its Connect your agent page is this same guide", async () => {
    const { docsRoute } = await import("@/lib/docs");
    const { docsPageParts } = await import("@/components/docs/docs-page");
    const route = docsRoute(["connect"])!;
    expect(route.kind).toBe("markdown");
    const { title, toc, body } = docsPageParts(route);
    expect(title).toBe("Connect your agent");
    expect(toc.map((s) => s.id)).toEqual(["connect", "address", "sign-in", "access", "try", "trouble"]);
    render(<>{body}</>);
    await act(async () => {});
    const order = [...document.querySelectorAll("[data-docs-section]")].map((e) => e.getAttribute("data-docs-section"));
    expect(order).toEqual(["connect", "address", "sign-in", "access", "try", "trouble"]);
  }, 30_000); // the docs modules' first import takes a while on a cold start
});
