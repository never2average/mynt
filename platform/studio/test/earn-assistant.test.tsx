// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useChat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { DraftsTab, EarnWorkspace, PoolsTab, type EarnStatus } from "@/components/earn-assistant";
import type { LiquidityActions } from "@/components/earn-view";
import { panelFrom, PROMPT_EXAMPLES, type Draft } from "@/lib/earn";
import { fromPools, fromPositions, type LiquidityData } from "@/lib/liquidity";

// Earn in the shared chat workspace: the centred prompt, the right-hand tabs by role and ?tab=,
// the Drafts badge, and drafts that need the user's click.

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
const UNCLEARED = "11111111-1111-4111-8111-111111111112";
const base = {
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
};
const pools = fromPools([
  { ...base, id: POOL, name: "Card float" },
  { ...base, id: UNCLEARED, name: "Uncleared float", offering_cleared: false },
]).map((p) => ({ ...p, productLine: "credit", queueLength: null, health: null }));
const positions = fromPositions([{ pool_id: POOL, name: "Card float", product_id: "card-credit", state: "us-ny", balance_cents: 500_000, available_to_withdraw_cents: 200_000 }]);
const lpData: LiquidityData = { supported: true, access: { builder: false, liquidityProvider: true }, provider: { pools, positions, withdrawals: [], canCommit: true, canWithdraw: true } };
const builderData: LiquidityData = { supported: true, access: { builder: true, liquidityProvider: false }, builder: { pools: [], proposable: [], withdrawalsShown: true } };

const actions = () => {
  const calls: { kind: string; input: Record<string, unknown> }[] = [];
  const a: LiquidityActions = {
    propose: async () => ({ ok: true, reply: null }),
    commit: async (input) => (calls.push({ kind: "commit", input }), { ok: true, reply: { movement_id: "m1", movement_status: "requested" } }),
    withdraw: async (input) => (calls.push({ kind: "withdraw", input }), { ok: true, reply: { seq: 4, eligible_at: "2027-02-12T00:00:00Z" } }),
  };
  return { a, calls };
};
const draft = (over: Partial<Draft> = {}): Draft => ({ kind: "commit", id: "d1", poolId: POOL, poolName: "Card float", amountCents: 5_000_000, state: "us-ny", sandbox: false, ...over }) as Draft;

// A chat whose transport records what's sent to /api/earn and answers with one line.
function fakeTransport(sent: string[]): ChatTransport<UIMessage> {
  return {
    sendMessages: async ({ messages }) => {
      const last = messages[messages.length - 1];
      sent.push(last.parts.map((p) => (p.type === "text" ? p.text : "")).join(""));
      const chunks: UIMessageChunk[] = [{ type: "start" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Here are the pools." }, { type: "text-end", id: "t" }, { type: "finish" }];
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
function Earn({ data, initialTab, messages, sent = [], status = "enabled", acts = actions().a }: { data: LiquidityData; initialTab?: string; messages?: UIMessage[]; sent?: string[]; status?: EarnStatus; acts?: LiquidityActions }) {
  const [id] = useState(() => `t-${Math.random()}`);
  const [transport] = useState(() => fakeTransport(sent));
  const chat = useChat<UIMessage>({ id, transport, messages });
  return <EarnWorkspace chat={chat} status={status} data={data} actions={acts} initialTab={initialTab} isMobile={false} />;
}
const tabIds = () => [...document.querySelectorAll("[data-panel-tab]")].map((b) => b.getAttribute("data-panel-tab"));
const selected = () => document.querySelector('[data-panel-tab][aria-selected="true"]')?.getAttribute("data-panel-tab");
const withDraft = (d: Draft): UIMessage[] => [
  { id: "u", role: "user", parts: [{ type: "text", text: "draft it" }] },
  { id: "a", role: "assistant", parts: [{ type: "text", text: "It's in Drafts." }, { type: "data-earn-draft", data: d } as never] },
];

describe("Earn in the chat workspace", () => {
  it("starts as the centred prompt with example chips, no panel, and the disclosure under the composer", () => {
    render(<Earn data={lpData} />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
    expect(screen.getByRole("heading", { name: "What do you want to earn?" })).toBeTruthy();
    for (const ex of PROMPT_EXAMPLES) expect(document.querySelector(`[data-chip="${ex}"]`)).toBeTruthy();
    const note = document.querySelector("[data-composer-note] [data-earn-disclosure]")!.textContent!;
    expect(note).toContain("on-chain USDC treasury per app is coming");
    expect(note).toContain("isn't investment advice");
    // No page-level tab bar or metadata card any more.
    expect(document.querySelector("[data-metadata]")).toBeNull();
    expect(document.querySelector('[role="tablist"][aria-label="Earn"]')).toBeNull();
  });

  it("the first prompt goes to the assistant, then the panel opens on Pools", async () => {
    const sent: string[] = [];
    render(<Earn data={lpData} sent={sent} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-chip="$50k, 90-day lock-in, US credit"]')!));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(sent).toEqual(["$50k, 90-day lock-in, US credit"]);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
    expect(selected()).toBe("pools");
    expect(document.querySelector("[data-earn-stats]")!.textContent).toContain("Liquidity provider");
  });

  it("has the right-hand tabs for the user's roles", () => {
    render(<Earn data={lpData} initialTab="opportunities" />);
    expect(tabIds()).toEqual(["pools", "opportunities", "my-positions", "drafts"]);
    cleanup();
    render(<Earn data={builderData} initialTab="my-pools" />);
    expect(tabIds()).toEqual(["pools", "my-pools"]);
    cleanup();
    render(<Earn data={{ ...lpData, access: { builder: true, liquidityProvider: true }, builder: builderData.builder }} initialTab="my-pools" />);
    expect(tabIds()).toEqual(["pools", "opportunities", "my-positions", "my-pools", "drafts"]);
    expect([...document.querySelectorAll("[data-panel-tab]")].map((b) => b.textContent)).toEqual(["Pools", "Opportunities", "My positions", "My pools", "Drafts"]);
  });

  it("?tab= picks the right-hand tab: a table opens the panel at once; old and unknown tabs are Pools", () => {
    render(<Earn data={lpData} initialTab="opportunities" />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
    expect(selected()).toBe("opportunities");
    expect(document.querySelector('[data-panel-content="opportunities"]')?.hasAttribute("hidden")).toBe(false);
    cleanup();
    render(<Earn data={lpData} initialTab="open-pools" />);
    expect(selected()).toBe("opportunities");
    cleanup();
    render(<Earn data={lpData} initialTab="assistant" />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
    cleanup();
    // A tab the user doesn't have: Pools, panel closed.
    render(<Earn data={builderData} initialTab="drafts" />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
  });

  it("counts drafts on the Drafts tab, and a draft is sent only by the user's click, once, even after looking at another tab", async () => {
    const { a, calls } = actions();
    render(<Earn data={lpData} messages={withDraft(draft())} acts={a} initialTab="drafts" />);
    expect(document.querySelector('[data-panel-tab="drafts"] [data-badge]')?.textContent).toBe("1");
    expect(calls).toHaveLength(0);
    expect(document.querySelector('[data-draft="commit"]')!.textContent).toContain("Nothing has been sent");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Commit capital" })));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "commit", input: { pool_id: POOL, amount_cents: 5_000_000, state: "us-ny" } });
    expect(String(calls[0].input.idempotency_key)).toMatch(/^[A-Za-z0-9_-]{8,200}$/);
    fireEvent.click(document.querySelector('[data-panel-tab="pools"]')!);
    fireEvent.click(document.querySelector('[data-panel-tab="drafts"]')!);
    expect(document.querySelector("[data-draft-done]")?.textContent).toContain("Deposit requested (movement m1, requested).");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Commit capital" })));
    expect(calls).toHaveLength(1);
  });

  it("says AI isn't configured, with the same centred prompt, and the tables still open", () => {
    render(<Earn data={lpData} status="disabled" />);
    expect(screen.getByRole("heading", { name: "What do you want to earn?" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("AI is not configured");
  });
});

describe("the Pools and Drafts tabs", () => {
  it("show the pools the conversation matched, lock-in and notice apart, and positions", () => {
    const { poolIds } = panelFrom([{ role: "assistant", parts: [{ type: "data-earn-pools", data: { pool_ids: [UNCLEARED] } }] }]);
    render(<PoolsTab data={lpData} poolIds={poolIds} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(1);
    const card = document.querySelector(`[data-pool-card="${UNCLEARED}"]`)!;
    for (const s of ["Uncleared float", "credit", "Sandbox only — not yet cleared for real commitments", "$1,000.00 – $100,000.00 per firm", "Not available yet"]) expect(card.textContent).toContain(s);
    expect(card.querySelector("[data-lock-in]")!.textContent).toBe("Not set");
    expect(card.querySelector("[data-notice]")!.textContent).toBe("90 days");
    expect(document.querySelector("[data-earn-positions]")!.textContent).toContain("$5,000.00 settled · $2,000.00 available");
    cleanup();
    render(<PoolsTab data={lpData} poolIds={null} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(2);
  });

  it("a draft the page's terms refuse can't be confirmed (an uncleared pool, over the limit)", async () => {
    const { a, calls } = actions();
    render(<DraftsTab data={lpData} drafts={[draft({ id: "d2", poolId: UNCLEARED, poolName: "Uncleared float" }), draft({ id: "d3", amountCents: 9_600_000 })]} actions={a} />);
    const buttons = screen.getAllByRole("button", { name: "Commit capital" }) as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    await act(async () => buttons.forEach((b) => fireEvent.click(b)));
    expect(calls).toHaveLength(0);
    expect(document.body.textContent).toContain("A Mynt admin must clear this pool");
    expect(document.body.textContent).toContain("over this pool's limit");
  });

  it("a draft shows the lock-in when Mynt sets one, the pool name in its own field, never as the amount", () => {
    const locked = fromPools([{ ...base, id: POOL, name: "$1,000.00", lock_in_days: 30 }]).map((p) => ({ ...p, queueLength: null, health: null }));
    render(<DraftsTab data={{ ...lpData, provider: { ...lpData.provider!, pools: locked } }} drafts={[draft({ poolName: "$1,000.00" })]} actions={actions().a} />);
    const card = document.querySelector('[data-draft="commit"]')!;
    expect(card.querySelector("[data-lock-in]")!.textContent).toBe("30 days");
    expect(card.querySelector("[data-notice]")!.textContent).toBe("90 days");
    expect(card.querySelector("[data-draft-pool]")!.textContent).toBe("$1,000.00");
    expect(card.querySelector("[data-draft-amount]")!.textContent).toBe("$50,000.00");
  });

  it("a draft withdrawal needs the click too, and says payment depends on verified health", async () => {
    const { a, calls } = actions();
    render(<DraftsTab data={lpData} drafts={[draft({ kind: "withdraw", id: "w", amountCents: 200_000 } as Partial<Draft>)]} actions={a} />);
    expect(document.body.textContent).toContain("only as far as the latest verified health snapshot keeps the pool above its minimum reserve");
    expect(calls).toHaveLength(0);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Request withdrawal" })));
    expect(calls).toEqual([{ kind: "withdraw", input: { pool_id: POOL, amount_cents: 200_000, idempotency_key: expect.any(String) } }]);
  });
});
