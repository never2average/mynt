// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useChat } from "@ai-sdk/react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

// Slash commands in the chat composers (Earn, Ask AI, an app's builder chat): typing "/" lists the
// chat's commands, one row each, "/command description"; Enter, Tab or a click runs an action or
// fills a prompt; Esc closes; the "/" button opens the same menu; plain Enter still sends.

vi.mock("next/navigation", () => ({
  usePathname: () => "/app-1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, refresh: () => undefined }),
}));

const { EarnWorkspace } = await import("@/components/earn-assistant");
const { AskAiPanel } = await import("@/components/ask-ai");
const { Thread } = await import("@/components/assistant-ui/thread");
const { builderCommands } = await import("@/app/(studio)/[projectId]/assistant");
const { ProjectWorkspaceShell } = await import("@/app/(studio)/[projectId]/project-workspace-shell");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { matchCommands, slashQuery, visibleCommands } = await import("@/lib/slash-commands");
const { PANEL_TAB_EVENT } = await import("@/lib/app-panel");
const { fromPools, fromPositions } = await import("@/lib/liquidity");
type LiquidityData = import("@/lib/liquidity").LiquidityData;
type LiquidityActions = import("@/components/earn-view").LiquidityActions;

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
afterEach(cleanup);

const POOL = "11111111-1111-4111-8111-111111111111";
const pools = fromPools([
  {
    id: POOL,
    name: "Card float",
    product_id: "card-credit",
    sponsor_entity_id: "22222222-2222-4222-8222-222222222222",
    sandbox: false,
    status: "open",
    min_reserve_bps: 2000,
    min_reserve_floor_cents: 0,
    notice_period_days: 90,
    min_commitment_cents: 100_000,
    max_commitment_cents: 10_000_000,
    deposit_rail_id: "33333333-3333-4333-8333-333333333333",
    withdrawal_rail_id: "44444444-4444-4444-8444-444444444444",
    approved_at: "2026-11-01T00:00:00Z",
    offering_cleared: true,
  },
]).map((p) => ({ ...p, productLine: "credit", queueLength: null, health: null }));
const positions = fromPositions([{ pool_id: POOL, name: "Card float", product_id: "card-credit", state: "us-ny", balance_cents: 500_000, available_to_withdraw_cents: 200_000 }]);
const lpData: LiquidityData = { supported: true, access: { builder: false, liquidityProvider: true }, provider: { pools, positions, withdrawals: [], canCommit: true, canWithdraw: true } };
const builderData: LiquidityData = { supported: true, access: { builder: true, liquidityProvider: false }, builder: { pools: [], proposable: [], withdrawalsShown: true } };
const actions: LiquidityActions = {
  propose: async () => ({ ok: true, reply: null }),
  commit: async () => ({ ok: true, reply: null }),
  withdraw: async () => ({ ok: true, reply: null }),
};

function fakeTransport(sent: string[]): ChatTransport<UIMessage> {
  return {
    sendMessages: async ({ messages }) => {
      const last = messages[messages.length - 1];
      sent.push(last.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
      const chunks: UIMessageChunk[] = [{ type: "start" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Done." }, { type: "text-end", id: "t" }, { type: "finish" }];
      return new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(ch);
          c.close();
        },
      });
    },
    reconnectToStream: async () => null,
  };
}

function Earn({ data, sent = [], owner = null }: { data: LiquidityData; sent?: string[]; owner?: string | null }) {
  const [id] = useState(() => `t-${Math.random()}`);
  const [transport] = useState(() => fakeTransport(sent));
  const chat = useChat<UIMessage>({ id, transport });
  return <EarnWorkspace chat={chat} status="enabled" data={data} actions={actions} isMobile={false} historyOwner={owner} />;
}

const input = () => screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
const type = async (text: string) => act(async () => void fireEvent.change(input(), { target: { value: text } }));
const press = async (key: string) => act(async () => void fireEvent.keyDown(input(), { key }));
const menu = () => document.querySelector("[data-slash-menu]");
const rows = () => [...document.querySelectorAll("[data-slash-menu] [data-slash-command]")];
const names = () => rows().map((r) => r.getAttribute("data-slash-command"));
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const selectedTab = () => document.querySelector('[data-panel-tab][aria-selected="true"]')?.getAttribute("data-panel-tab");

describe("the slash-command list", () => {
  it("matches what's typed after the slash; hides commands the user's roles can't use", () => {
    const cmds = [
      { name: "pools", description: "Open the Pools tab" },
      { name: "propose", description: "Draft a pool proposal", roles: ["builder"] },
      { name: "strategies", description: "Open My strategies" },
    ];
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/po")).toBe("po");
    expect(slashQuery("/commit $5")).toBeNull();
    expect(slashQuery("hello /x")).toBeNull();
    expect(matchCommands(cmds, "p").map((c) => c.name)).toEqual(["pools", "propose"]);
    // Names starting with it first, then names or descriptions containing it.
    expect(matchCommands(cmds, "pool").map((c) => c.name)).toEqual(["pools", "propose"]);
    expect(matchCommands(cmds, "my").map((c) => c.name)).toEqual(["strategies"]);
    expect(visibleCommands(cmds, ["liquidity-provider"]).map((c) => c.name)).toEqual(["pools", "strategies"]);
    expect(visibleCommands(cmds, ["builder"]).map((c) => c.name)).toEqual(["pools", "propose", "strategies"]);
  });
});

describe("slash commands in Earn's composer", () => {
  it("typing / opens the menu: one row per command, '/command description', only the liquidity provider's", async () => {
    render(<Earn data={lpData} owner="u1" />);
    expect(menu()).toBeNull();
    await type("/");
    expect(menu()).toBeTruthy();
    expect(names()).toEqual(["pools", "invested", "strategies", "history", "new", "commit", "withdraw"]);
    // Builders-only commands are hidden from liquidity providers.
    expect(names()).not.toContain("my-pools");
    expect(names()).not.toContain("propose");
    for (const row of rows()) {
      // One line: the command in mono, then its description, truncated; no icon, no second line.
      expect(row.children).toHaveLength(2);
      expect(row.querySelector("[data-slash-name]")!.className).toContain("font-mono");
      expect(row.querySelector("[data-slash-description]")!.className).toContain("truncate");
      expect(row.querySelector("svg")).toBeNull();
      expect(row.textContent).toMatch(/^\/[a-z-]+ \S/);
    }
    expect(rows()[0].textContent).toBe("/pools Open the Pools tab");
    expect(document.querySelector("[data-slash-menu] [cmdk-group-heading]")).toBeNull();
  });

  it("filters by what's typed after the slash", async () => {
    render(<Earn data={lpData} />);
    await type("/str");
    expect(names()).toEqual(["strategies"]);
    await type("/with");
    expect(names()).toEqual(["withdraw"]);
    // Nothing matches: no menu.
    await type("/zzz");
    expect(menu()).toBeNull();
    // A space ends the command: the menu closes.
    await type("/pools now");
    expect(menu()).toBeNull();
  });

  it("Enter runs an action command: /strategies opens My strategies and clears the input, sending nothing", async () => {
    const sent: string[] = [];
    render(<Earn data={lpData} sent={sent} />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
    await type("/strat");
    await press("Enter");
    await settle();
    expect(selectedTab()).toBe("my-strategies");
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
    expect(input().value).toBe("");
    expect(menu()).toBeNull();
    expect(sent).toEqual([]);
  });

  it("Up/Down move the selection and Tab chooses; /invested shows Pools on Invested", async () => {
    render(<Earn data={lpData} />);
    await type("/");
    const sel = () => document.querySelector('[data-slash-menu] [data-slash-command][aria-selected="true"]')?.getAttribute("data-slash-command");
    expect(sel()).toBe("pools");
    await press("ArrowDown");
    expect(sel()).toBe("invested");
    await press("ArrowUp");
    await press("ArrowUp");
    expect(sel()).toBe("withdraw");
    await press("ArrowDown");
    await press("ArrowDown");
    await press("Tab");
    expect(selectedTab()).toBe("pools");
    expect(document.querySelector('[data-view-switch] [aria-checked="true"]')!.textContent).toBe("Invested");
    expect(input().value).toBe("");
  });

  it("a template command fills the input for the user to finish, cursor at the end; a click chooses too", async () => {
    const sent: string[] = [];
    render(<Earn data={lpData} sent={sent} />);
    await type("/commit");
    await press("Enter");
    await settle();
    expect(input().value).toBe("Commit $ to ");
    expect(input().selectionStart).toBe("Commit $ to ".length);
    expect(menu()).toBeNull();
    expect(sent).toEqual([]);
    await type("/");
    await act(async () => void fireEvent.click(document.querySelector('[data-slash-command="withdraw"]')!));
    await settle();
    expect(input().value).toBe("Withdraw $ from ");
  });

  it("Esc closes the menu and keeps what was typed; typing again opens it", async () => {
    render(<Earn data={lpData} />);
    await type("/po");
    expect(menu()).toBeTruthy();
    await press("Escape");
    expect(menu()).toBeNull();
    expect(input().value).toBe("/po");
    await type("/stra");
    expect(names()).toEqual(["strategies"]);
  });

  it("a builder sees My pools and Propose, not the liquidity provider's commands; /propose fills a proposal prompt", async () => {
    render(<Earn data={builderData} />);
    await type("/");
    expect(names()).toEqual(["pools", "my-pools", "strategies", "new", "propose"]);
    await type("/my");
    await press("Enter");
    expect(selectedTab()).toBe("my-pools");
    await type("/prop");
    await press("Enter");
    await settle();
    expect(input().value).toBe("Draft a pool proposal for ");
  });

  it("/history opens Past conversations; /new starts a new conversation", async () => {
    window.localStorage.clear();
    const sent: string[] = [];
    render(<Earn data={lpData} sent={sent} owner="u1" />);
    await type("/hist");
    await press("Enter");
    expect(document.querySelector('[data-dialog="history"]')).toBeTruthy();
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    cleanup();
    render(<Earn data={lpData} sent={sent} owner="u1" />);
    await type("hello");
    await press("Enter");
    await settle();
    expect(document.body.textContent).toContain("Done.");
    await type("/new");
    await press("Enter");
    await settle();
    expect(document.body.textContent).not.toContain("Done.");
    expect(screen.getByRole("heading", { name: "What do you want to earn?" })).toBeTruthy();
  });

  it("the labelled / button (tooltip Commands) opens the same menu", async () => {
    render(<Earn data={lpData} />);
    const button = screen.getByRole("button", { name: "Commands" });
    expect(button.textContent).toBe("/");
    expect(button.closest("[data-composer-toolbar]")).toBeTruthy();
    await act(async () => void fireEvent.click(button));
    // The menu lists every command at once; the "/" reaches the input through the composer's store.
    expect(names()).toContain("strategies");
    await waitFor(() => expect(input().value).toBe("/"));
    // With a message already typed, the button lists every command without replacing it.
    await type("half a thought");
    expect(menu()).toBeNull();
    await act(async () => void fireEvent.click(button));
    expect(names()).toHaveLength(6);
    expect(input().value).toBe("half a thought");
  });

  it("plain Enter still sends when the menu is closed", async () => {
    const sent: string[] = [];
    render(<Earn data={lpData} sent={sent} />);
    await type("Lowest risk pools");
    expect(menu()).toBeNull();
    await press("Enter");
    await settle();
    expect(sent).toEqual(["Lowest risk pools"]);
  });
});

describe("slash commands in Ask AI", () => {
  function Ask({ messages }: { messages?: UIMessage[] }) {
    const [transport] = useState(() => fakeTransport([]));
    const [id] = useState(() => `ask-${Math.random()}`);
    const chat = useChat<UIMessage>({ id, transport, messages });
    return <AskAiPanel chat={chat} status="enabled" onBack={() => undefined} onClose={() => undefined} onNavigate={() => undefined} />;
  }

  it("/new clears the conversation; the question templates fill the input", async () => {
    render(<Ask messages={[{ id: "u", role: "user", parts: [{ type: "text", text: "Earlier question" }] }]} />);
    expect(document.body.textContent).toContain("Earlier question");
    await type("/");
    expect(names()).toEqual(["new", "apps", "builds", "licences", "coverage", "audits"]);
    await type("/new");
    await press("Enter");
    await settle();
    expect(document.body.textContent).not.toContain("Earlier question");
    await type("/lic");
    await press("Enter");
    await settle();
    expect(input().value).toBe("Which partner licences cover ");
  });
});

describe("slash commands in the builder chat", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).startsWith("/api/projects")
        ? new Response(JSON.stringify({ projects: [{ id: "app-1", name: "Round-up savings", stage: "idea", previewUrl: null, conversations: [] }] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function BuilderChat({ sent }: { sent: string[] }) {
    const [transport] = useState(() => fakeTransport(sent));
    const [id] = useState(() => `b-${Math.random()}`);
    const chat = useChat<UIMessage>({ id, transport });
    const runtime = useAISDKRuntime(chat);
    return (
      <AssistantRuntimeProvider runtime={runtime}>
        <Thread commands={builderCommands("app-1")} />
      </AssistantRuntimeProvider>
    );
  }

  it("lists the panel tabs by their ids and the agent prompts; no /new", async () => {
    render(<BuilderChat sent={[]} />);
    await type("/");
    expect(names()).toEqual(["preview", "pnl", "licences", "security", "sdk", "activity", "fix", "add"]);
    await type("/fi");
    await press("Enter");
    await settle();
    expect(input().value).toBe("Fix ");
  });

  it("/pnl asks the workspace shell for the P&L tab, which shows it", async () => {
    const asked: unknown[] = [];
    const listen = (e: Event) => asked.push((e as CustomEvent).detail);
    window.addEventListener(PANEL_TAB_EVENT, listen);
    const sent: string[] = [];
    const { container } = render(
      <TooltipProvider>
        <SidebarProvider>
          <ProjectWorkspaceShell projectId="app-1">
            <BuilderChat sent={sent} />
          </ProjectWorkspaceShell>
        </SidebarProvider>
      </TooltipProvider>,
    );
    await settle();
    expect(container.querySelector('[data-panel-tab="preview"]')?.getAttribute("aria-selected")).toBe("true");
    await type("/pnl");
    await press("Enter");
    await settle();
    window.removeEventListener(PANEL_TAB_EVENT, listen);
    expect(asked).toEqual([{ projectId: "app-1", tab: "pnl" }]);
    expect(container.querySelector('[data-panel-tab="pnl"]')?.getAttribute("aria-selected")).toBe("true");
    expect(input().value).toBe("");
    expect(sent).toEqual([]);
  });
});
