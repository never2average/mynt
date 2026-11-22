// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";

// The builder chat follows a build that's still going: as its page opens (from the cursor its
// history was read up to), and again whenever a reply asks to be followed on (data-follow), with
// no message sent. GET /api/chat streams it (app/api/chat/route.ts).

vi.mock("next/navigation", () => ({
  usePathname: () => "/app-1/b1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
}));

const { Assistant, followUrl } = await import("@/app/(studio)/[projectId]/assistant");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
  Element.prototype.scrollTo ??= function () {};
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// An AI SDK UI message stream, as the route sends it.
function sse(chunks: Record<string, unknown>[]) {
  const body = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const say = (id: string, text: string) => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
];

const history: UIMessage[] = [{ id: "h0", role: "user", parts: [{ type: "text", text: "Build a savings goal screen" }] }];

describe("following a build in the builder chat", () => {
  it("builds the follow address from the build and the cursor", () => {
    expect(followUrl("app-1", "b1", 12)).toBe("/api/chat?projectId=app-1&buildId=b1&after=12");
    expect(followUrl("app-1", "b1", null)).toBe("/api/chat?projectId=app-1&buildId=b1");
  });

  it("follows a running build as its page opens, and follows on when the reply asks", async () => {
    const asked: string[] = [];
    const replies = [
      sse([{ type: "start" }, ...say("t1", "Adding the chart"), { type: "data-follow", data: { buildId: "b1", after: 20 }, transient: true }, { type: "finish" }]),
      sse([{ type: "start" }, ...say("t2", "_verifying: Running Mynt's checks_"), { type: "finish" }]),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        asked.push(`${init?.method ?? "GET"} ${url}`);
        return replies.shift() ?? new Response(null, { status: 204 });
      }),
    );
    render(<Assistant initialMessages={history} follow={{ after: 5 }} selectedProjectId="app-1" selectedConversationId="b1" />);
    expect(await screen.findByText("Adding the chart")).toBeTruthy();
    expect(await screen.findByText(/Running Mynt's checks/)).toBeTruthy();
    await waitFor(() => expect(asked).toEqual(["GET /api/chat?projectId=app-1&buildId=b1&after=5", "GET /api/chat?projectId=app-1&buildId=b1&after=20"]));
    // Once: no follow is asked for after a reply that didn't ask to be followed on.
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toHaveLength(2);
  });

  it("doesn't follow a build that's over", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    render(<Assistant initialMessages={history} follow={null} selectedProjectId="app-1" selectedConversationId="b1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetch).not.toHaveBeenCalled();
  });
});
