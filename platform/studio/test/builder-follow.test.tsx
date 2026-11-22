// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage } from "ai";

// The builder chat beyond its messages: it follows a build that's still going (as its page opens,
// and whenever a reply asks to be followed on), offers Ship while a session is open, a cap for a
// message that starts a build, and holds a message sent while a build is verified until it ends.

vi.mock("next/navigation", () => ({
  usePathname: () => "/app-1/b1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
}));

// The chat renders through several hops (stream, store, runtime): give it time on a slow machine.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 20_000 });

const { Assistant, followUrl, heldKey, SHIP_EVENT } = await import("@/app/(studio)/[projectId]/assistant");

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
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// An AI SDK UI message stream, as the route sends it.
function sse(chunks: Record<string, unknown>[]) {
  const body = [{ type: "start" }, ...chunks, { type: "finish" }].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const say = (id: string, text: string) => [
  { type: "text-start", id },
  { type: "text-delta", id, delta: text },
  { type: "text-end", id },
];
const budget = (b: Record<string, unknown> | null, session = true) =>
  new Response(JSON.stringify({ budget: b && { defaultCapUsd: 10, monthLeftUsd: 40, workspaceLeftUsd: null, minCapUsd: 0.5, sessionCapAboveUsd: 2, ...b }, session }), { status: 200 });

// A fake studio: the chat's replies in order (by method), the budget, and Ship; every request recorded.
type Reply = Response | (() => Promise<Response>);
function studio(opts: { chat?: Reply[]; follow?: Reply[]; budget?: Response; finish?: Response } = {}) {
  const asked: { method: string; url: string; body: unknown }[] = [];
  const chat = [...(opts.chat ?? [])];
  const follow = [...(opts.follow ?? [])];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      asked.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.startsWith("/api/builds/budget")) return opts.budget ?? budget(null);
      if (url.includes("/finish")) return opts.finish ?? new Response(JSON.stringify({ ok: true }), { status: 200 });
      const next = method === "POST" ? chat.shift() : follow.shift();
      if (typeof next === "function") return next();
      return next ?? (method === "POST" ? sse([]) : new Response(null, { status: 204 }));
    }),
  );
  return { asked, chatCalls: () => asked.filter((a) => a.url.startsWith("/api/chat")) };
}

const history: UIMessage[] = [{ id: "h0", role: "user", parts: [{ type: "text", text: "Build a savings goal screen" }] }];
const input = () => screen.getByLabelText("Message input") as HTMLTextAreaElement;
async function send(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input(), { key: "Enter" });
  });
}

describe("following a build in the builder chat", () => {
  it("builds the follow address from the build, the cursor, and whether Ship was just pressed", () => {
    expect(followUrl("app-1", "b1", 12)).toBe("/api/chat?projectId=app-1&buildId=b1&after=12");
    expect(followUrl("app-1", "b1", null)).toBe("/api/chat?projectId=app-1&buildId=b1");
    expect(followUrl("app-1", "b1", 3, true)).toBe("/api/chat?projectId=app-1&buildId=b1&after=3&shipping=1");
  });

  it("follows a running build as its page opens, and follows on when the reply asks", async () => {
    const s = studio({
      follow: [sse([...say("t1", "Adding the chart"), { type: "data-follow", data: { buildId: "b1", after: 20 }, transient: true }]), sse(say("t2", "_verifying: Running Mynt's checks_"))],
    });
    render(<Assistant initialMessages={history} follow={{ after: 5 }} build={{ buildId: "b1", status: "coding", session: false, finishing: false }} selectedProjectId="app-1" selectedConversationId="b1" />);
    expect(await screen.findByText("Adding the chart", undefined, { timeout: 4000 })).toBeTruthy();
    expect(await screen.findByText(/Running Mynt's checks/, undefined, { timeout: 4000 })).toBeTruthy();
    await waitFor(() => expect(s.chatCalls().map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/chat?projectId=app-1&buildId=b1&after=5", "GET /api/chat?projectId=app-1&buildId=b1&after=20"]));
    await new Promise((r) => setTimeout(r, 50));
    expect(s.chatCalls()).toHaveLength(2);
  });

  it("doesn't follow a build that's over", async () => {
    const s = studio();
    render(<Assistant initialMessages={history} follow={null} build={{ buildId: "b1", status: "succeeded", session: true, finishing: false }} selectedProjectId="app-1" selectedConversationId="b1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.chatCalls()).toEqual([]);
  });
});

describe("Ship", () => {
  it("is offered while a session is open, ships through the studio, and the chat follows the build to its end", async () => {
    const s = studio({ follow: [sse(say("t1", "_Shipping: the agent wraps up_"))] });
    render(<Assistant initialMessages={history} build={{ buildId: "b1", status: "coding", session: true, finishing: false }} selectedProjectId="app-1" selectedConversationId="b1" />);
    const ship = await screen.findByRole("button", { name: /Ship/ }, { timeout: 4000 });
    await act(async () => {
      fireEvent.click(ship);
    });
    await waitFor(() => expect(s.asked.find((a) => a.url === "/api/builds/b1/finish")).toMatchObject({ method: "POST", body: { projectId: "app-1" } }));
    expect(await screen.findByText(/Shipping: the agent wraps up/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(s.chatCalls().at(-1)?.url).toBe("/api/chat?projectId=app-1&buildId=b1&shipping=1");
    // Shipping: no second Ship.
    await waitFor(() => expect(screen.queryByRole("button", { name: /Ship/ })).toBeNull());
  });

  it("/ship does the same; a refusal is shown", async () => {
    const s = studio({ finish: new Response(JSON.stringify({ error: "mynt_refused", message: "Build is verifying; only a running session can be finished" }), { status: 422 }) });
    render(<Assistant initialMessages={history} build={{ buildId: "b1", status: "coding", session: true, finishing: false }} selectedProjectId="app-1" selectedConversationId="b1" />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(SHIP_EVENT, { detail: { projectId: "app-1" } }));
    });
    await waitFor(() => expect(s.asked.some((a) => a.url === "/api/builds/b1/finish")).toBe(true));
    expect(await screen.findByText("Build is verifying; only a running session can be finished", undefined, { timeout: 4000 })).toBeTruthy();
  });

  it("isn't offered for a one-off build, or once nothing is running", async () => {
    studio();
    render(<Assistant initialMessages={history} build={{ buildId: "b1", status: "coding", session: false, finishing: false }} selectedProjectId="app-1" selectedConversationId="b1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: /Ship/ })).toBeNull();
  });
});

describe("the cap for a new build", () => {
  it("starts at what's left this month when that's less than the usual cap, and is sent with the message", async () => {
    const s = studio({ budget: budget({ monthLeftUsd: 6.5 }) });
    render(<Assistant initialMessages={history} build={{ buildId: "b1", status: "failed", session: true, finishing: false }} selectedProjectId="app-1" selectedConversationId="b1" />);
    const field = (await screen.findByLabelText("Spending cap for this build, in US dollars", undefined, { timeout: 4000 })) as HTMLInputElement;
    expect(field.value).toBe("6.50");
    fireEvent.change(field, { target: { value: "4" } });
    fireEvent.blur(field);
    await send("Add a statements page");
    await waitFor(() => expect(s.asked.find((a) => a.method === "POST" && a.url === "/api/chat")?.body).toMatchObject({ projectId: "app-1", capUsd: 4 }));
  });

  it("blocks sending, saying why, when too little is left this month", async () => {
    studio({ budget: budget({ monthLeftUsd: 1.2 }) });
    render(<Assistant initialMessages={history} selectedProjectId="app-1" selectedConversationId={null} />);
    expect(await screen.findByText(/Only US\$1\.20 of your build budget is left this month/, undefined, { timeout: 4000 })).toBeTruthy();
    expect(input().disabled).toBe(true);
    expect(screen.queryByLabelText("Spending cap for this build, in US dollars")).toBeNull();
  });

  it("isn't shown while a build is running (the message steers it)", async () => {
    const s = studio({ budget: budget({}) });
    render(<Assistant initialMessages={history} build={{ buildId: "b1", status: "coding", session: true, finishing: false }} selectedProjectId="app-1" selectedConversationId="b1" />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByLabelText("Spending cap for this build, in US dollars")).toBeNull();
    expect(s.asked.some((a) => a.url.startsWith("/api/builds/budget"))).toBe(false);
  });
});

describe("a message sent while a build is verified", () => {
  const holdReply = (after: number) =>
    sse([
      ...say("t1", "Queued — sent when verification finishes."),
      { type: "data-hold", data: { buildId: "b1", text: "Add a statements page", after }, transient: true },
      { type: "data-state", data: { buildId: "b1", status: "verifying", session: true, finishing: true, after }, transient: true },
      { type: "data-follow", data: { buildId: "b1", after }, transient: true },
    ]);

  it("is held (kept across a reload), shown as queued, and sent as the next request once verification ends", async () => {
    // Verification ends only when the test says so.
    let end!: () => void;
    const ended = new Promise<void>((r) => (end = r));
    const s = studio({
      chat: [holdReply(9), sse(say("t3", "Starting the statements page"))],
      follow: [
        async () => {
          await ended;
          return sse([...say("t2", "**Shipped.**"), { type: "data-state", data: { buildId: "b1", status: "succeeded", session: true, finishing: true, after: 9 }, transient: true }]);
        },
      ],
    });
    // The page opens on a build that's no longer followed (its follow already ran), mid-verification.
    render(<Assistant initialMessages={history} build={{ buildId: "b1", status: "verifying", session: true, finishing: true }} selectedProjectId="app-1" selectedConversationId="b1" />);
    await send("Add a statements page");
    const banner = () => document.querySelector("[data-held-message]")?.textContent ?? null;
    await waitFor(() => expect(banner()).toMatch(/^Queued — sent when verification finishes: “Add a statements page”Remove$/));
    expect(JSON.parse(window.localStorage.getItem(heldKey("app-1")) ?? "null")).toEqual({ buildId: "b1", text: "Add a statements page", after: 9 });
    // Still verifying: nothing more is sent.
    await new Promise((r) => setTimeout(r, 50));
    expect(s.chatCalls().filter((c) => c.method === "POST")).toHaveLength(1);
    // Verification ends: the held message is sent again, now as a new request.
    end();
    await waitFor(() => expect(s.chatCalls().filter((c) => c.method === "POST")).toHaveLength(2));
    expect(s.chatCalls().filter((c) => c.method === "POST")[1].body).toMatchObject({ messages: [expect.objectContaining({ parts: [expect.objectContaining({ text: "Add a statements page" })] })] });
    expect(await screen.findByText("Starting the statements page", undefined, { timeout: 4000 })).toBeTruthy();
    expect(window.localStorage.getItem(heldKey("app-1"))).toBeNull();
    expect(document.querySelector("[data-held-message]")).toBeNull();
  });

  it("after a reload, follows the build it waits for and sends it when Mynt says that build is over", async () => {
    window.localStorage.setItem(heldKey("app-1"), JSON.stringify({ buildId: "b1", text: "Add a statements page", after: 9 }));
    const s = studio({ follow: [new Response(null, { status: 204 })] });
    render(<Assistant initialMessages={history} selectedProjectId="app-1" selectedConversationId={null} />);
    await waitFor(() => expect(s.chatCalls().filter((c) => c.method === "POST")).toHaveLength(1));
    expect(s.chatCalls()[0].url).toBe("/api/chat?projectId=app-1&buildId=b1&after=9");
    expect(window.localStorage.getItem(heldKey("app-1"))).toBeNull();
  });

  it("can be removed", async () => {
    window.localStorage.setItem(heldKey("app-1"), JSON.stringify({ buildId: "b1", text: "Add a statements page", after: 9 }));
    // Still verifying: the follow streams without an end.
    const s = studio({ follow: [sse(say("t1", "_verifying: Running Mynt's checks_"))] });
    render(<Assistant initialMessages={history} build={{ buildId: "b1", status: "verifying", session: true, finishing: true }} selectedProjectId="app-1" selectedConversationId="b1" />);
    const remove = await screen.findByRole("button", { name: /Remove/ }, { timeout: 4000 });
    await act(async () => {
      fireEvent.click(remove);
    });
    expect(window.localStorage.getItem(heldKey("app-1"))).toBeNull();
    expect(document.querySelector("[data-held-message]")).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(s.chatCalls().filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
