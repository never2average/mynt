// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useChat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { EarnWorkspace, PoolsTab, StrategiesTab, type EarnStatus } from "@/components/earn-assistant";
import { EarnTable, type LiquidityActions } from "@/components/earn-view";
import { HISTORY_KEY, listThreads, MAX_THREADS, saveThread, threadTitle } from "@/lib/earn-history";
import { panelFrom, PROMPT_EXAMPLES, type Draft } from "@/lib/earn";
import { fromPools, fromPositions, type LiquidityData } from "@/lib/liquidity";

// Earn in the shared chat workspace: the centred prompt, the right-hand tabs by role and ?tab=,
// the My strategies badge, drafts that need the user's click, and past conversations.

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
function Earn({ data, initialTab, messages, sent = [], status = "enabled", acts = actions().a, owner = null }: { data: LiquidityData; initialTab?: string; messages?: UIMessage[]; sent?: string[]; status?: EarnStatus; acts?: LiquidityActions; owner?: string | null }) {
  const [id] = useState(() => `t-${Math.random()}`);
  const [transport] = useState(() => fakeTransport(sent));
  const chat = useChat<UIMessage>({ id, transport, messages });
  return <EarnWorkspace chat={chat} status={status} data={data} actions={acts} initialTab={initialTab} isMobile={false} historyOwner={owner} />;
}
const tabIds = () => [...document.querySelectorAll("[data-panel-tab]")].map((b) => b.getAttribute("data-panel-tab"));
const selected = () => document.querySelector('[data-panel-tab][aria-selected="true"]')?.getAttribute("data-panel-tab");
const withDraft = (d: Draft): UIMessage[] => [
  { id: "u", role: "user", parts: [{ type: "text", text: "draft it" }] },
  { id: "a", role: "assistant", parts: [{ type: "text", text: "It's in My strategies." }, { type: "data-earn-draft", data: d } as never] },
];

describe("Earn in the chat workspace", () => {
  it("starts as the centred prompt with example chips, no panel, and the disclosure under the composer", () => {
    render(<Earn data={lpData} />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
    expect(screen.getByRole("heading", { name: "What do you want to earn?" })).toBeTruthy();
    for (const ex of PROMPT_EXAMPLES) expect(document.querySelector(`[data-chip="${ex}"]`)).toBeTruthy();
    // One line under the composer; the full text is in its tooltip (test/earn-wallet.test.tsx).
    const note = document.querySelector("[data-composer-note] [data-earn-disclosure]")!.textContent!;
    expect(note).toBe("Not investment advice · Mynt never holds your funds");
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
    // The panel header no longer shows role badges or counts (removed at the user's request).
    expect(document.querySelector("[data-earn-stats]")).toBeNull();
    expect(document.querySelector('[data-role="Liquidity provider"]')).toBeNull();
  });

  it("has the right-hand tabs for the user's roles", () => {
    render(<Earn data={lpData} initialTab="my-positions" />);
    expect(tabIds()).toEqual(["pools", "my-positions", "my-strategies"]);
    cleanup();
    render(<Earn data={builderData} initialTab="my-pools" />);
    expect(tabIds()).toEqual(["pools", "my-pools", "my-strategies"]);
    cleanup();
    render(<Earn data={{ ...lpData, access: { builder: true, liquidityProvider: true }, builder: builderData.builder }} initialTab="my-pools" />);
    expect(tabIds()).toEqual(["pools", "my-positions", "my-pools", "my-strategies"]);
    expect([...document.querySelectorAll("[data-panel-tab]")].map((b) => b.textContent)).toEqual(["Pools", "My positions", "My pools", "My strategies"]);
  });

  it("?tab= picks the right-hand tab: a table opens the panel at once; old and unknown tabs are Pools", () => {
    render(<Earn data={lpData} initialTab="my-positions" />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
    expect(selected()).toBe("my-positions");
    expect(document.querySelector('[data-panel-content="my-positions"]')?.hasAttribute("hidden")).toBe(false);
    cleanup();
    // The old Opportunities (and /liquidity's Open pools) is Pools, opened, showing all pools.
    for (const old of ["opportunities", "open-pools"]) {
      render(<Earn data={lpData} initialTab={old} messages={[{ id: "a", role: "assistant", parts: [{ type: "data-earn-pools", data: { pool_ids: [UNCLEARED] } } as never] }]} />);
      expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
      expect(selected()).toBe("pools");
      expect(document.querySelector('[data-panel-tab="opportunities"]')).toBeNull();
      expect(document.querySelector('[data-filter="Show"]')!.getAttribute("aria-label")).toBe("Show: All pools");
      expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(2);
      cleanup();
    }
    // Drafts is My strategies.
    render(<Earn data={lpData} initialTab="drafts" />);
    expect(selected()).toBe("my-strategies");
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
    cleanup();
    render(<Earn data={lpData} initialTab="assistant" />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
    cleanup();
    // A tab the user doesn't have: Pools, panel closed.
    render(<Earn data={builderData} initialTab="my-positions" />);
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
  });

  it("counts drafts on the My strategies tab, and a draft is sent only by the user's click, once, even after looking at another tab", async () => {
    const { a, calls } = actions();
    render(<Earn data={lpData} messages={withDraft(draft())} acts={a} initialTab="my-strategies" />);
    expect(document.querySelector('[data-panel-tab="my-strategies"] [data-badge]')?.textContent).toBe("1");
    expect(calls).toHaveLength(0);
    // A card per strategy (title, pool, amount, terms as text, status, Review); no table. The
    // draft is reviewed and confirmed in a sheet from its card's Review.
    expect(document.querySelectorAll("[data-earn-strategies-tab] table")).toHaveLength(0);
    const card = document.querySelector('[data-draft-card="d1"]')!;
    expect(card.hasAttribute("data-card")).toBe(true);
    expect(card.querySelector("[data-draft-title]")!.textContent).toBe("Commitment");
    expect(card.querySelector("[data-draft-pool]")!.textContent).toBe("Card float");
    expect(card.querySelector("[data-draft-amount]")!.textContent).toBe("$50,000.00");
    expect(card.querySelector("[data-draft-terms]")!.textContent).toBe("Lock-in Not set · Notice 90 days");
    expect(card.querySelector("[data-draft-status]")!.textContent).toBe("Ready to confirm");
    expect(card.querySelector("[data-draft-status]")!.getAttribute("data-tone")).toBe("blue");
    expect(card.querySelector("[data-review]")!.textContent).toBe("Review");
    expect(card.querySelector("[data-card]")).toBeNull();
    expect(document.querySelector('[data-draft="commit"]')).toBeNull();
    fireEvent.click(document.querySelector('[data-review="d1"]')!);
    expect(document.querySelector('[data-sheet="draft"] [data-draft="commit"]')!.textContent).toContain("Nothing has been sent");
    expect(document.querySelector('[data-draft="commit"] [data-slot="card"]')).toBeNull();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Commit capital" })));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "commit", input: { pool_id: POOL, amount_cents: 5_000_000, state: "us-ny" } });
    expect(String(calls[0].input.idempotency_key)).toMatch(/^[A-Za-z0-9_-]{8,200}$/);
    // Closing the sheet and looking at another tab keeps what was sent.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(document.querySelector('[data-panel-tab="pools"]')!);
    fireEvent.click(document.querySelector('[data-panel-tab="my-strategies"]')!);
    expect(document.querySelector('[data-draft-card="d1"] [data-draft-status]')!.textContent).toBe("Sent");
    fireEvent.click(document.querySelector('[data-review="d1"]')!);
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

describe("the Pools and My strategies tabs", () => {
  it("Pools (Opportunities merged in): the pools the conversation matched as cards, lock-in and notice apart, what the user holds in each, and Commit capital", async () => {
    const { poolIds } = panelFrom([{ role: "assistant", parts: [{ type: "data-earn-pools", data: { pool_ids: [UNCLEARED] } }] }]);
    render(<PoolsTab data={lpData} poolIds={poolIds} actions={actions().a} />);
    // Cards (flat, one per pool, none nested), the matched pools shown by the Show filter.
    expect(document.querySelectorAll("table")).toHaveLength(0);
    expect(document.querySelector("[data-slot='card']")).toBeNull();
    expect(document.querySelector('[data-filter="Show"]')!.getAttribute("aria-label")).toBe("Show: Matched");
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(1);
    const card = document.querySelector(`[data-pool-card="${UNCLEARED}"]`)!;
    expect(card.className.split(" ")).toEqual(expect.arrayContaining(["rounded-lg", "border", "p-3"]));
    expect(card.querySelector("[data-card]")).toBeNull();
    for (const s of ["Uncleared float", "Sandbox only — not yet cleared for real commitments", "$1,000.00 – $100,000.00 per firm"]) expect(card.textContent).toContain(s);
    expect(card.querySelector("[data-product]")!.textContent).toBe("card-credit · credit");
    expect(card.querySelector("[data-lock-in]")!.textContent).toBe("Not set");
    expect(card.querySelector("[data-notice]")!.textContent).toBe("90 days");
    expect(card.querySelector("[data-health]")!.textContent).toContain("Health Not available yet");
    expect(card.querySelector("[data-your-position]")!.textContent).toBe("—");
    // Opportunities' Commit capital: on the toolbar and on each card, off (with why) where it can't.
    expect(document.querySelector('[data-toolbar] [data-cta="commit"]')).toBeTruthy();
    expect((card.querySelector(`[data-commit="${UNCLEARED}"]`) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-earn-positions], [data-view-all]")).toBeNull();
    // Show · All pools lists every pool open to the user.
    fireEvent.keyDown(document.querySelector('[data-filter="Show"]')!, { key: "Enter" });
    await act(async () => undefined);
    await act(async () => void fireEvent.click(document.querySelector('[data-filter-option="all"]')!));
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(2);
    expect(document.querySelector(`[data-pool-card="${POOL}"] [data-your-position]`)!.textContent).toBe("$5,000.00");
    expect((document.querySelector(`[data-commit="${POOL}"]`) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("2 pools · Page 1 of 1");
    cleanup();
    render(<PoolsTab data={lpData} poolIds={null} actions={actions().a} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(2);
    expect(document.querySelector('[data-filter="Show"]')).toBeNull();
    cleanup();
    // A builder sees the pools, without Commit capital.
    render(<PoolsTab data={{ ...builderData, builder: { ...builderData.builder!, pools } }} poolIds={null} actions={actions().a} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(2);
    expect(document.querySelector('[data-cta="commit"], [data-commit]')).toBeNull();
  });

  it("a draft the page's terms refuse can't be confirmed (an uncleared pool, over the limit)", async () => {
    const { a, calls } = actions();
    render(<StrategiesTab data={lpData} drafts={[draft({ id: "d2", poolId: UNCLEARED, poolName: "Uncleared float" }), draft({ id: "d3", amountCents: 9_600_000 })]} actions={a} />);
    // Each row says why, and the sheet's button is off.
    expect(document.querySelector('[data-draft-card="d2"] [data-draft-status]')!.textContent).toContain("A Mynt admin must clear this pool");
    expect(document.querySelector('[data-draft-card="d3"] [data-draft-status]')!.textContent).toContain("over this pool's limit");
    for (const id of ["d2", "d3"]) {
      fireEvent.click(document.querySelector(`[data-review="${id}"]`)!);
      const button = screen.getByRole("button", { name: "Commit capital" }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await act(async () => void fireEvent.click(button));
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
    }
    expect(calls).toHaveLength(0);
  });

  it("a draft shows the lock-in when Mynt sets one, the pool name in its own field, never as the amount", () => {
    const locked = fromPools([{ ...base, id: POOL, name: "$1,000.00", lock_in_days: 30 }]).map((p) => ({ ...p, queueLength: null, health: null }));
    render(<StrategiesTab data={{ ...lpData, provider: { ...lpData.provider!, pools: locked } }} drafts={[draft({ poolName: "$1,000.00" })]} actions={actions().a} />);
    fireEvent.click(document.querySelector("[data-review]")!);
    const card = document.querySelector('[data-draft="commit"]')!;
    expect(card.querySelector("[data-lock-in]")!.textContent).toBe("30 days");
    expect(card.querySelector("[data-notice]")!.textContent).toBe("90 days");
    expect(card.querySelector("[data-draft-pool]")!.textContent).toBe("$1,000.00");
    expect(card.querySelector("[data-draft-amount]")!.textContent).toBe("$50,000.00");
  });

  it("a draft withdrawal needs the click too, and says payment depends on verified health", async () => {
    const { a, calls } = actions();
    render(<StrategiesTab data={lpData} drafts={[draft({ kind: "withdraw", id: "w", amountCents: 200_000 } as Partial<Draft>)]} actions={a} />);
    fireEvent.click(document.querySelector('[data-review="w"]')!);
    expect(document.body.textContent).toContain("only as far as the latest verified health snapshot keeps the pool above its minimum reserve");
    expect(calls).toHaveLength(0);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Request withdrawal" })));
    expect(calls).toEqual([{ kind: "withdraw", input: { pool_id: POOL, amount_cents: 200_000, idempotency_key: expect.any(String) } }]);
  });
});

describe("the table tabs' forms", () => {
  it("open in a sheet from their labelled CTA or row button, not inline in the tab", async () => {
    render(<PoolsTab data={lpData} poolIds={null} actions={actions().a} />);
    expect(document.querySelector('[data-form="commit"]')).toBeNull();
    await act(async () => void fireEvent.click(document.querySelector(`[data-commit="${POOL}"]`)!));
    const sheet = document.querySelector('[data-sheet="commit"]')!;
    expect(sheet.querySelector('[data-form="commit"]')).toBeTruthy();
    expect(sheet.textContent).toContain("Mynt never holds your funds");
    expect((sheet.querySelector('select[aria-label="Pool"]') as HTMLSelectElement).value).toBe(POOL);
    cleanup();
    render(<EarnTable tab="my-positions" data={lpData} actions={actions().a} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-cta="withdraw"]')!));
    expect(document.querySelector('[data-sheet="withdraw"] [data-form="withdraw"] [data-withdraw-terms]')).toBeTruthy();
    cleanup();
    const proposable = [{ productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: "s1", sponsorName: "Harbor Bank" }];
    render(<EarnTable tab="my-pools" data={{ ...builderData, builder: { ...builderData.builder!, proposable } }} actions={actions().a} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-cta="propose"]')!));
    expect(document.querySelector('[data-sheet="propose"] [data-form="propose"]')!.textContent).toContain("Harbor Bank must approve it");
  });
});

describe("no outlined badges around long content", () => {
  it("states, money, health, terms, limits and statuses are plain text or a dot and its words; a badge holds one short word at most", () => {
    const treasury = fromPools([{ ...base, id: "11111111-1111-4111-8111-111111111119", name: "On-chain float", treasury: { program_id: "Prog111111111111111111111111111111111111111", treasury: "Tre4s111111111111111111111111111111111111111", cluster: "devnet", verified_build: false, attesters_flag: "approvers changed" } }]).map((p) => ({ ...p, productLine: "credit", queueLength: null, health: null }));
    const d: LiquidityData = { ...lpData, access: { builder: true, liquidityProvider: true }, provider: { ...lpData.provider!, pools: [...pools, ...treasury] }, builder: { pools, proposable: [], withdrawalsShown: true } };
    for (const view of [
      <PoolsTab key="p" data={d} poolIds={null} actions={actions().a} />,
      <StrategiesTab key="s" data={d} drafts={[draft(), draft({ id: "d4", kind: "withdraw", amountCents: 100 } as Partial<Draft>)]} actions={actions().a} />,
      <EarnTable key="m" tab="my-positions" data={d} actions={actions().a} />,
      <EarnTable key="b" tab="my-pools" data={d} actions={actions().a} />,
    ]) {
      render(view);
      for (const b of document.querySelectorAll('[data-slot="badge"]')) expect(b.textContent!.trim(), b.outerHTML).toMatch(/^\S+$/);
      for (const el of document.querySelectorAll("[data-stage], [data-money], [data-treasury], [data-unverified-build], [data-attesters-flag], [data-draft-status], [data-terms], [data-health], [data-limits]")) expect(el.closest('[data-slot="badge"]'), el.outerHTML).toBeNull();
      cleanup();
    }
    render(<PoolsTab data={d} poolIds={null} actions={actions().a} />);
    expect(document.querySelector(`[data-pool-card="${POOL}"] [data-stage="cleared"]`)!.getAttribute("data-tone")).toBe("green");
    expect(document.querySelector("[data-attesters-flag]")!.getAttribute("data-tone")).toBe("amber");
  });
});

describe("past conversations", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  const msgs = (q: string): UIMessage[] => [
    { id: `u-${q}`, role: "user", parts: [{ type: "text", text: q }] },
    { id: `a-${q}`, role: "assistant", parts: [{ type: "text", text: `About ${q}.` }] },
  ];
  const thread = (id: string, q: string, at: string) => ({ id, title: threadTitle(msgs(q)), updatedAt: at, messages: msgs(q), outcomes: {} });
  const historyButton = () => screen.getByRole("button", { name: "Past conversations" });

  it("saves threads per user, newest first, at most MAX_THREADS, titled by the first question; blocked storage keeps none", () => {
    const s = store();
    saveThread("u1", thread("a", "First question", "2026-11-20T10:00:00Z"), s);
    saveThread("u1", thread("b", "Second question", "2026-11-21T10:00:00Z"), s);
    saveThread("u2", thread("c", "Someone else's", "2026-11-21T11:00:00Z"), s);
    expect(listThreads("u1", s).map((t) => [t.id, t.title])).toEqual([
      ["b", "Second question"],
      ["a", "First question"],
    ]);
    expect(listThreads("u2", s).map((t) => t.id)).toEqual(["c"]);
    expect(listThreads(null, s)).toEqual([]);
    // Saving a thread again replaces it and moves it to the top.
    saveThread("u1", { ...thread("a", "First question", "2026-11-21T12:00:00Z"), messages: [...msgs("First question"), ...msgs("More")] }, s);
    expect(listThreads("u1", s).map((t) => [t.id, t.messages.length])).toEqual([
      ["a", 4],
      ["b", 2],
    ]);
    for (let i = 0; i < MAX_THREADS + 5; i++) saveThread("u1", thread(`t${i}`, `Q${i}`, `2026-12-01T00:00:${String(i).padStart(2, "0")}Z`), s);
    expect(listThreads("u1", s)).toHaveLength(MAX_THREADS);
    expect(listThreads("u1", s)[0].id).toBe(`t${MAX_THREADS + 4}`);
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveThread("u1", thread("x", "Q", "2026-11-21T00:00:00Z"), blocked)).toEqual([]);
    expect(threadTitle([])).toBe("Untitled conversation");
  });

  it("a floating Past conversations button at the chat's top right lists this user's threads; the chat is saved once it settles; New conversation starts afresh; a thread picked is restored to continue", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ u1: [thread("old", "Older question", "2026-11-20T10:00:00Z")], u2: [thread("theirs", "Not yours", "2026-11-21T10:00:00Z")] }));
    const sent: string[] = [];
    render(<Earn data={lpData} sent={sent} owner="u1" />);
    const button = historyButton();
    // In the chat's top-right corner, with Show tabs beside it while the panel isn't open.
    const corner = button.closest("[data-chat-corner]")!;
    expect(corner.className.split(" ")).toEqual(expect.arrayContaining(["absolute", "top-3", "right-3"]));
    expect(button.closest("[data-chat-side]")).toBeTruthy();
    expect(corner.querySelector("[data-expand-panel]")!.getAttribute("aria-label")).toBe("Show tabs");
    // Ask a question: once the answer settles, the thread is saved under this user.
    await act(async () => void fireEvent.click(document.querySelector('[data-chip="$50k, 90-day lock-in, US credit"]')!));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    const saved = listThreads("u1");
    expect(saved.map((t) => t.title)).toEqual(["$50k, 90-day lock-in, US credit", "Older question"]);
    expect(saved[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(listThreads("u2").map((t) => t.id)).toEqual(["theirs"]);
    // The list: newest first, the open one marked, each with its date.
    await act(async () => void fireEvent.click(historyButton()));
    // A centred pop-up about two thirds of the screen, not a sheet sliding in from the side.
    const sheet = document.querySelector('[data-dialog="history"]')!;
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(sheet.className).toContain("sm:w-[65vw]");
    expect(sheet.className).toContain("h-[65vh]");
    expect(document.querySelector('[data-sheet="history"]')).toBeNull();
    expect([...sheet.querySelectorAll("[data-thread-title]")].map((t) => t.textContent)).toEqual(["$50k, 90-day lock-in, US credit", "Older question"]);
    expect(sheet.querySelector(`[data-thread="${saved[0].id}"]`)!.getAttribute("aria-current")).toBe("true");
    expect(sheet.querySelector("[data-thread-date]")!.textContent).not.toBe("");
    // New conversation: the centred prompt again, the panel closed, nothing lost.
    await act(async () => void fireEvent.click(sheet.querySelector("[data-new-conversation]")!));
    expect(screen.getByRole("heading", { name: "What do you want to earn?" })).toBeTruthy();
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("false");
    expect(listThreads("u1")).toHaveLength(2);
    // Picking the older thread restores its messages, to carry on from.
    await act(async () => void fireEvent.click(historyButton()));
    await act(async () => void fireEvent.click(document.querySelector('[data-dialog="history"] [data-thread="old"]')!));
    expect(document.body.textContent).toContain("About Older question.");
    expect(document.querySelector("[data-chat-workspace]")?.getAttribute("data-panel-open")).toBe("true");
    // Restoring alone doesn't move it up the list.
    expect(listThreads("u1").map((t) => t.id)[1]).toBe("old");
  });

  it("Past conversations is a chat search: a search box over the recent chats, narrowed as the user types, with the matching words", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify({ u1: [thread("old", "Older question", "2026-11-20T10:00:00Z"), thread("tb", "Treasury bills ladder", "2026-11-21T10:00:00Z")] }),
    );
    render(<Earn data={lpData} owner="u1" />);
    await act(async () => void fireEvent.click(historyButton()));
    const dialog = document.querySelector('[data-dialog="history"]')!;
    const box = dialog.querySelector("[data-chat-search]") as HTMLInputElement;
    expect(box.getAttribute("placeholder")).toBe("Search chats");
    expect(dialog.querySelector("[data-list-heading]")!.textContent).toBe("Recent");
    expect([...dialog.querySelectorAll("[data-thread-title]")].map((t) => t.textContent)).toEqual(["Treasury bills ladder", "Older question"]);
    // Typing narrows the list to matches (title or words, any case), each with the words around the match.
    await act(async () => void fireEvent.change(box, { target: { value: "about OLDER" } }));
    expect([...dialog.querySelectorAll("[data-thread-title]")].map((t) => t.textContent)).toEqual(["Older question"]);
    expect(dialog.querySelector("[data-list-heading]")!.textContent).toBe("1 chat");
    expect(dialog.querySelector("[data-thread-snippet]")!.textContent).toContain("About Older question.");
    await act(async () => void fireEvent.change(box, { target: { value: "nothing like this" } }));
    expect(dialog.querySelector("[data-no-matches]")).not.toBeNull();
    // Down then Enter opens the first match.
    await act(async () => void fireEvent.change(box, { target: { value: "treasury" } }));
    await act(async () => void fireEvent.keyDown(box, { key: "ArrowDown" }));
    await act(async () => void fireEvent.keyDown(box, { key: "Enter" }));
    expect(document.body.textContent).toContain("About Treasury bills ladder.");
  });

  it("a restored draft keeps its idempotency key, and one already sent stays sent", async () => {
    window.localStorage.clear();
    const withDrafts = [...withDraft(draft()), { id: "a2", role: "assistant", parts: [{ type: "data-earn-draft", data: draft({ id: "d9", amountCents: 200_000 }) } as never] }] as UIMessage[];
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify({ u1: [{ id: "th", title: "draft it", updatedAt: "2026-11-20T10:00:00Z", messages: withDrafts, outcomes: { d1: { key: "key-sent-1", sent: "Deposit requested (movement m1, requested)." }, d9: { key: "key-kept-9", sent: null } } }] }));
    const { a, calls } = actions();
    render(<Earn data={lpData} acts={a} owner="u1" />);
    await act(async () => void fireEvent.click(historyButton()));
    await act(async () => void fireEvent.click(document.querySelector('[data-thread="th"]')!));
    fireEvent.click(document.querySelector('[data-panel-tab="my-strategies"]')!);
    expect(document.querySelector('[data-draft-card="d1"] [data-draft-status]')!.textContent).toBe("Sent");
    fireEvent.click(document.querySelector('[data-review="d1"]')!);
    expect((screen.getByRole("button", { name: "Commit capital" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(document.querySelector('[data-review="d9"]')!);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Commit capital" })));
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toMatchObject({ amount_cents: 200_000, idempotency_key: "key-kept-9" });
  });

  it("a builder's pool proposal: a card, Review opens Propose pool prefilled, confirm proposes once, and a restored thread keeps it sent", async () => {
    window.localStorage.clear();
    const options = [
      { productId: "other", productName: "Other product", componentKey: "deposits", sponsorId: "66666666-6666-4666-8666-666666666666", sponsorName: "Other Bank" },
      { productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: "22222222-2222-4222-8222-222222222222", sponsorName: "Sponsor Bank" },
    ];
    const data: LiquidityData = { ...builderData, builder: { ...builderData.builder!, proposable: options } };
    const terms = { product_id: "card-credit", component_key: "lending", name: "Card float", sandbox: false, min_reserve_bps: 1250, min_reserve_floor_cents: 50_000, notice_period_days: 30, min_commitment_cents: 100_000, max_commitment_cents: 10_000_050 };
    const proposal = { kind: "proposal", id: "p1", poolName: "Card float", productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: options[1].sponsorId, sponsorName: "Sponsor Bank", sandbox: false, terms } as Draft;
    const proposed: unknown[] = [];
    let answer!: (r: { ok: true; reply: unknown }) => void;
    const acts: LiquidityActions = { ...actions().a, propose: (input) => (proposed.push(input), new Promise((r) => (answer = r))) };
    render(<Earn data={data} messages={withDraft(proposal)} acts={acts} initialTab="my-strategies" owner="u1" />);
    const card = document.querySelector('[data-draft-card="p1"]')!;
    expect(card.getAttribute("data-draft-kind")).toBe("proposal");
    expect(card.querySelector("[data-draft-title]")!.textContent).toBe("Pool proposal");
    expect(card.querySelector("[data-draft-product]")!.textContent).toBe("Card credit");
    expect(card.querySelector("[data-draft-pool]")!.textContent).toBe("Card float");
    expect(card.querySelector("[data-draft-amount]")).toBeNull();
    expect(card.querySelector("[data-draft-terms]")!.textContent).toBe("Reserve 12.5%, at least $500.00 · Notice 30 days · $1,000.00 – $100,000.50 per firm");
    expect(card.querySelector("[data-draft-status]")!.textContent).toBe("Ready to confirm");
    expect(proposed).toHaveLength(0);
    fireEvent.click(document.querySelector('[data-review="p1"]')!);
    expect(screen.getByRole("heading", { name: "Review pool proposal" })).toBeTruthy();
    const form = document.querySelector('[data-sheet="draft"] [data-draft="proposal"] [data-form="propose"]')!;
    expect((form.querySelector('[aria-label="Sponsored component"]') as HTMLSelectElement).value).toBe("1");
    const field = (label: string) => (form.querySelector(`[aria-label="${label}"]`) as HTMLInputElement).value;
    expect([field("Pool name"), field("Minimum reserve percent"), field("Reserve floor"), field("Notice period days"), field("Smallest position"), field("Largest position")]).toEqual(["Card float", "12.5", "500", "30", "1000", "100000.50"]);
    expect((form.querySelector('[aria-label="Sandbox pool"]') as HTMLInputElement).checked).toBe(false);
    // Two clicks before Mynt answers send it once, with the draft's terms.
    const submit = screen.getByRole("button", { name: "Propose pool" });
    await act(async () => void fireEvent.click(submit));
    await act(async () => void fireEvent.click(submit));
    expect(proposed).toEqual([terms]);
    await act(async () => answer({ ok: true, reply: null }));
    expect(document.querySelector("[data-form-done]")!.textContent).toContain('Pool "Card float" proposed.');
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(document.querySelector('[data-draft-card="p1"] [data-draft-status]')!.textContent).toBe("Proposed");
    fireEvent.click(document.querySelector('[data-review="p1"]')!);
    expect(screen.queryByRole("button", { name: "Propose pool" })).toBeNull();
    // The thread keeps it sent: restored, it can't be proposed again.
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    const kept = listThreads("u1")[0];
    expect(kept.outcomes.p1).toEqual({ key: null, sent: expect.stringContaining('Pool "Card float" proposed.') });
    cleanup();
    render(<Earn data={data} acts={acts} owner="u1" />);
    await act(async () => void fireEvent.click(historyButton()));
    await act(async () => void fireEvent.click(document.querySelector(`[data-thread="${kept.id}"]`)!));
    fireEvent.click(document.querySelector('[data-panel-tab="my-strategies"]')!);
    expect(document.querySelector('[data-draft-card="p1"] [data-draft-status]')!.textContent).toBe("Proposed");
    fireEvent.click(document.querySelector('[data-review="p1"]')!);
    expect(screen.queryByRole("button", { name: "Propose pool" })).toBeNull();
    expect(proposed).toHaveLength(1);
  });

  it("a proposal whose component lost its sponsorship can't be sent", () => {
    const proposal = { kind: "proposal", id: "p2", poolName: "Gone", productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: "22222222-2222-4222-8222-222222222222", sponsorName: null, sandbox: true, terms: { product_id: "card-credit", component_key: "lending", name: "Gone", sandbox: true, min_reserve_bps: 2000, min_reserve_floor_cents: 0, notice_period_days: 0, min_commitment_cents: 100, max_commitment_cents: 200 } } as Draft;
    render(<StrategiesTab data={builderData} drafts={[proposal]} actions={actions().a} />);
    expect(document.querySelector('[data-draft-card="p2"] [data-draft-status]')!.textContent).toBe("This component has no approved sponsorship any more, so it can't have a pool.");
    fireEvent.click(document.querySelector('[data-review="p2"]')!);
    expect(screen.queryByRole("button", { name: "Propose pool" })).toBeNull();
  });

  it("without a user to keep them for, there's no history button", () => {
    render(<Earn data={lpData} />);
    expect(screen.queryByRole("button", { name: "Past conversations" })).toBeNull();
  });
});
