// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";

import { AgentInstructions, ConnectAgentPanel, claudeCodeCommand, cursorInstallLink, mcpUrl, vscodeInstallLink } from "@/components/connect-agent";

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

  it("there's no Connect your agent button in the header; /connect still serves the docs' page and /docs/connect sends people there", async () => {
    const mod = await import("@/components/connect-agent");
    expect("ConnectAgentButton" in mod).toBe(false);
    render(<TooltipProvider><mod.DocsButton /></TooltipProvider>);
    expect(document.querySelector("[data-connect-agent-open]")).toBeNull();
    // Ahead of the file routes and the sign-in check (next.config.ts): /connect shows the docs' page at its own
    // address, and the docs' address redirects to it.
    const { STUDIO_REDIRECTS, STUDIO_REWRITES } = await import("@/lib/redirects");
    expect(STUDIO_REWRITES).toContainEqual({ source: "/connect", destination: "/docs/connect" });
    expect(STUDIO_REDIRECTS).toContainEqual({ source: "/docs/connect", destination: "/connect", permanent: false });
    const { pageNeedsSignIn } = await import("@/lib/page-gate");
    expect(pageNeedsSignIn("/connect")).toBe(false);
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

  it("/docs is the docs site (on Fumadocs), and its Connect your agent page is this same guide", async () => {
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
