// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const { PutOnlineView, HostingControl, OnlineMark, ChatPutOnlineButton, PUT_ONLINE_EVENT } = await import("@/components/hosting-control");
const { fromHostingStatus, latestShippedBuild, putOnlineLabel } = await import("@/lib/hosting");
const { outcomeNote } = await import("@/lib/chat");
import type { HostingMeta } from "@/components/hosting-control";

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const noop = () => undefined;
const build = { id: "b2", goal: "A savings goal tracker", repository: "octo/cards", commitSha: "abcdef1234567890", branch: "mynt/b2", finishedAt: "2026-11-20T10:00:00Z" };
const notOnline = { state: "not_online" as const, url: null, buildId: null, commitSha: null, error: null };
type Supported = Extract<HostingMeta, { supported: true }>;
const meta = (over: Partial<Supported> = {}): Supported => ({
  supported: true,
  app: { id: "a1", name: "Cards", workspaceId: "w1" },
  role: "owner",
  canTurnOn: true,
  hosting: { on: false, status: null, app: notOnline },
  build,
  repository: null,
  repositories: null,
  canChooseRepository: false,
  ...over,
});

describe("Put online's sheet", () => {
  it("shows the build, the repository and commit it deploys, and what happens: its own address, the key added at Mynt's edge", () => {
    const html = renderToStaticMarkup(<PutOnlineView meta={meta()} onPutOnline={noop} onChooseRepository={noop} />);
    expect(html).toContain("A savings goal tracker");
    expect(html).toContain("octo/cards");
    expect(html).toContain("abcdef1");
    expect(html).toMatch(/own public address/);
    expect(html).toMatch(/added at Mynt&#x27;s edge .*never stored on the app&#x27;s machine/);
    expect(html).toMatch(/hosting is turned on first/);
    expect(html).toContain("data-confirm-put-online");
    expect(html).toContain("Not online");
  });

  it("says plainly when the build pushed nowhere, and offers Choose repository with the user's approved repositories", () => {
    const m = meta({ build: { ...build, repository: null, commitSha: null }, canChooseRepository: true, repositories: [{ repository: "octo/cards", approval: "approved", note: null, connectedAt: null }], repository: { current: null, managed: false } });
    render(<PutOnlineView meta={m} onPutOnline={noop} onChooseRepository={noop} />);
    expect(screen.getByText(/wasn't saved to a repository/)).toBeTruthy();
    expect(screen.getByText(/once Mynt has verified that new build, Put online hosts it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Put online/ })).toBeNull();
    const chosen: string[] = [];
    cleanup();
    render(<PutOnlineView meta={m} onPutOnline={noop} onChooseRepository={(r) => chosen.push(r)} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose repository" }));
    expect(chosen).toEqual(["octo/cards"]);
  });

  it("tells a member that an owner or admin turns hosting on, and doesn't let them confirm", () => {
    render(<PutOnlineView meta={meta({ role: "member", canTurnOn: false })} onPutOnline={noop} onChooseRepository={noop} />);
    expect(screen.getByText(/An owner or admin turns it on/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Put online" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("in Production, tells a member up front that owners and admins put a build online, and doesn't let them confirm", () => {
    render(<PutOnlineView meta={meta({ role: "member", canTurnOn: false, stage: "production", canPutOnline: false, hosting: { on: true, status: "running", app: notOnline } })} onPutOnline={noop} onChooseRepository={noop} />);
    expect(screen.getByText(/only the workspace's owners and admins put a build online there\. Ask one of them\./)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Put online" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("in Production, tells an owner what Mynt checks of the build first, and shows Mynt's refusal in its own words", () => {
    const refusal = "Build abcdef12 can't go online: this app is in Production, where a build goes online only if it passes the production checks about the build. Independent audit passed: 1 critical or high finding(s) in the independent audit. The build that is online stays as it is";
    render(<PutOnlineView meta={meta({ stage: "production", canPutOnline: true, hosting: { on: true, status: "running", app: notOnline } })} error={refusal} onPutOnline={noop} onChooseRepository={noop} />);
    expect(screen.getByText(/Mynt puts the build online only if it passes the production checks about the build/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(refusal);
    expect((screen.getByRole("button", { name: "Put online" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("in Staging, a member still puts a build online, with no word about Production", () => {
    const html = renderToStaticMarkup(<PutOnlineView meta={meta({ role: "member", canTurnOn: false, stage: "staging", canPutOnline: true, hosting: { on: true, status: "running", app: notOnline } })} onPutOnline={noop} onChooseRepository={noop} />);
    expect(html).not.toContain("Production, ");
    expect(html).not.toContain("data-production-owners-note");
    expect(html).not.toContain("data-production-checks");
    expect(html).not.toMatch(/data-confirm-put-online[^>]*disabled/);
    expect(html).not.toMatch(/disabled[^>]*data-confirm-put-online/);
  });

  it("shows the live address once the app runs this build, and offers the newer build when it runs an older one", () => {
    const online = { state: "online" as const, url: "https://cards.example.test", buildId: "b2", commitSha: "abcdef1234567890", error: null };
    render(<PutOnlineView meta={meta({ hosting: { on: true, status: "running", app: online } })} onPutOnline={noop} onChooseRepository={noop} />);
    expect(screen.getByText("Online at cards.example.test")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Put/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Open cards.example.test/ }).getAttribute("href")).toBe("https://cards.example.test");
    expect(putOnlineLabel({ ...online, buildId: "b1" }, build)).toBe("Put the new build online");
  });

  it("shows why the last deploy stopped, in Mynt's words", () => {
    const stopped = { ...notOnline, buildId: "b2", error: "npm ERR! missing script: start" };
    render(<PutOnlineView meta={meta({ hosting: { on: true, status: "running", app: stopped } })} onPutOnline={noop} onChooseRepository={noop} />);
    expect(screen.getByText("npm ERR! missing script: start")).toBeTruthy();
  });

  it("the state mark: Online at its address (a link), Deploying, Not online", () => {
    expect(renderToStaticMarkup(<OnlineMark online={{ ...notOnline, state: "deploying" }} />)).toContain("Deploying");
    expect(renderToStaticMarkup(<OnlineMark online={notOnline} />)).toContain("Not online");
    expect(renderToStaticMarkup(<OnlineMark online={{ ...notOnline, state: "online", url: "https://cards.example.test" }} />)).toContain('href="https://cards.example.test"');
  });
});

describe("the hosting helpers", () => {
  it("read hosting_status for one app, and only https addresses", () => {
    const reply = { tenant: { status: "running" }, apps: [{ app_id: "a1", build_id: "b2", commit_sha: "c", status: "running", url: "javascript:alert(1)", services: [{ service: "web", url: "https://web.example.test" }] }] };
    expect(fromHostingStatus(reply, "a1").app).toEqual({ state: "online", url: "https://web.example.test", buildId: "b2", commitSha: "c", error: null });
    expect(fromHostingStatus(reply, "a2")).toEqual({ on: true, status: "running", app: notOnline });
    expect(fromHostingStatus({ tenant: null, apps: [] }, "a1").on).toBe(false);
  });

  it("pick the app's newest succeeded build", () => {
    const reply = { builds: [
      { id: "b1", app_id: "a1", status: "succeeded", updated_at: "2026-11-01T00:00:00Z" },
      { id: "b3", app_id: "a1", status: "failed", updated_at: "2026-11-03T00:00:00Z" },
      { id: "b2", app_id: "a1", status: "succeeded", updated_at: "2026-11-02T00:00:00Z", repository: "octo/cards", commit_sha: "abc" },
      { id: "x", app_id: "a2", status: "succeeded", updated_at: "2026-11-04T00:00:00Z" },
    ] };
    expect(latestShippedBuild(reply, "a1")).toMatchObject({ id: "b2", repository: "octo/cards", commitSha: "abc" });
    expect(latestShippedBuild({ builds: [] }, "a1")).toBeNull();
  });

  it("the build's finished message points to Put online", () => {
    expect(outcomeNote({ status: "succeeded" })).toMatch(/Press \*\*Put online\*\* to host it/);
  });
});

describe("the app top bar's Put online", () => {
  beforeEach(() => vi.unstubAllGlobals());

  function stub(states: Record<string, unknown>[]) {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    let polls = 0;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const deploying = { on: true, status: "running", app: { state: "deploying", url: null, buildId: "b2", commitSha: "abcdef1234567890", error: null } };
      const body =
        method === "POST"
          ? { ok: true, message: "Putting Cards online: Mynt's hosting fetches commit abcdef1 from octo/cards, builds it and starts it.", hosting: deploying }
          : url.includes("only=status")
            ? { supported: true, hosting: states[Math.min(polls++, states.length - 1)] }
            : meta();
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  it("shows Not online and a labelled Put online, opens the sheet, deploys, and follows it until it's online at its address", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = stub([{ on: true, status: "running", app: { state: "online", url: "https://cards.example.test", buildId: "b2", commitSha: "abcdef1234567890", error: null } }]);
    const { container } = render(<HostingControl appId="a1" appName="Cards" />);
    await act(async () => undefined);
    expect(container.querySelector('[data-online-state="not_online"]')?.textContent).toBe("Not online");
    fireEvent.click(screen.getByRole("button", { name: "Put online" }));
    await act(async () => undefined);
    expect(screen.getByText("Put Cards online")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Put online" }).at(-1)!);
    await act(async () => undefined);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ action: "put_online", build_id: "b2" });
    expect(screen.getByText(/^Putting Cards online/)).toBeTruthy();
    expect(container.querySelector('[data-online-state="deploying"]')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5100);
    });
    expect(screen.getByText("Cards is online at https://cards.example.test")).toBeTruthy();
    expect(container.querySelector('[data-online-state="online"]')?.textContent).toBe("Online at cards.example.test");
  });

  it("the chat's Put online opens the same sheet, and only where Mynt hosts apps", async () => {
    stub([{ on: false, status: null, app: notOnline }]);
    render(
      <>
        <HostingControl appId="a1" appName="Cards" />
        <ChatPutOnlineButton projectId="a1" />
      </>,
    );
    await act(async () => undefined);
    const buttons = screen.getAllByRole("button", { name: "Put online" });
    expect(buttons).toHaveLength(2);
    act(() => void window.dispatchEvent(new CustomEvent(PUT_ONLINE_EVENT, { detail: { projectId: "a1" } })));
    await act(async () => undefined);
    expect(screen.getByText("Put Cards online")).toBeTruthy();

    cleanup();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ supported: false }), { status: 200 }));
    render(<ChatPutOnlineButton projectId="a1" />);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Put online" })).toBeNull();
  });
});
