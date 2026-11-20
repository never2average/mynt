// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useChat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { DraftsTab, EarnWorkspace, PoolsTab, type EarnStatus } from "@/components/earn-assistant";
import { EarnTable, type LiquidityActions } from "@/components/earn-view";
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
    // A row per draft in one table; the draft is reviewed in a sheet from its row, not a card.
    expect(document.querySelector('[data-draft-row="d1"] [data-draft-status]')!.textContent).toBe("Ready to confirm");
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
    fireEvent.click(document.querySelector('[data-panel-tab="drafts"]')!);
    expect(document.querySelector('[data-draft-row="d1"] [data-draft-status]')!.textContent).toBe("Sent");
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

describe("the Pools and Drafts tabs", () => {
  it("show the pools the conversation matched, lock-in and notice apart, and what the user holds in each", async () => {
    const { poolIds } = panelFrom([{ role: "assistant", parts: [{ type: "data-earn-pools", data: { pool_ids: [UNCLEARED] } }] }]);
    render(<PoolsTab data={lpData} poolIds={poolIds} />);
    // One table (it was a grid of cards; the card-only Yield line went with them), the matched
    // pools shown by the Show filter rather than a section heading.
    expect(document.querySelector("[data-card], [data-slot='card']")).toBeNull();
    expect(document.querySelectorAll("table")).toHaveLength(1);
    expect(document.querySelector('[data-filter="Show"]')!.getAttribute("aria-label")).toBe("Show: Matched");
    expect(document.querySelectorAll("[data-pool-row]")).toHaveLength(1);
    const row = document.querySelector(`tr[data-pool-row="${UNCLEARED}"]`)!;
    for (const s of ["Uncleared float", "Sandbox only — not yet cleared for real commitments", "$1,000.00 – $100,000.00 per firm"]) expect(row.textContent).toContain(s);
    expect(row.querySelector("[data-product]")!.textContent).toBe("card-credit · credit");
    expect(row.querySelector("[data-lock-in]")!.textContent).toBe("Not set");
    expect(row.querySelector("[data-notice]")!.textContent).toBe("90 days");
    // What the user holds in the pool is a column (the positions preview and its View all are gone;
    // the whole list is the My positions tab).
    expect(row.querySelector("[data-your-position]")!.textContent).toBe("—");
    expect(document.querySelector("[data-earn-positions], [data-view-all]")).toBeNull();
    // Show · All pools lists every pool open to the user.
    fireEvent.keyDown(document.querySelector('[data-filter="Show"]')!, { key: "Enter" });
    await act(async () => undefined);
    await act(async () => void fireEvent.click(document.querySelector('[data-filter-option="all"]')!));
    expect(document.querySelectorAll("[data-pool-row]")).toHaveLength(2);
    expect(document.querySelector(`tr[data-pool-row="${POOL}"] [data-your-position]`)!.textContent).toBe("$5,000.00");
    cleanup();
    render(<PoolsTab data={lpData} poolIds={null} />);
    expect(document.querySelectorAll("[data-pool-row]")).toHaveLength(2);
    expect(document.querySelector('[data-filter="Show"]')).toBeNull();
  });

  it("a draft the page's terms refuse can't be confirmed (an uncleared pool, over the limit)", async () => {
    const { a, calls } = actions();
    render(<DraftsTab data={lpData} drafts={[draft({ id: "d2", poolId: UNCLEARED, poolName: "Uncleared float" }), draft({ id: "d3", amountCents: 9_600_000 })]} actions={a} />);
    // Each row says why, and the sheet's button is off.
    expect(document.querySelector('[data-draft-row="d2"] [data-draft-status]')!.textContent).toContain("A Mynt admin must clear this pool");
    expect(document.querySelector('[data-draft-row="d3"] [data-draft-status]')!.textContent).toContain("over this pool's limit");
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
    render(<DraftsTab data={{ ...lpData, provider: { ...lpData.provider!, pools: locked } }} drafts={[draft({ poolName: "$1,000.00" })]} actions={actions().a} />);
    fireEvent.click(document.querySelector("[data-review]")!);
    const card = document.querySelector('[data-draft="commit"]')!;
    expect(card.querySelector("[data-lock-in]")!.textContent).toBe("30 days");
    expect(card.querySelector("[data-notice]")!.textContent).toBe("90 days");
    expect(card.querySelector("[data-draft-pool]")!.textContent).toBe("$1,000.00");
    expect(card.querySelector("[data-draft-amount]")!.textContent).toBe("$50,000.00");
  });

  it("a draft withdrawal needs the click too, and says payment depends on verified health", async () => {
    const { a, calls } = actions();
    render(<DraftsTab data={lpData} drafts={[draft({ kind: "withdraw", id: "w", amountCents: 200_000 } as Partial<Draft>)]} actions={a} />);
    fireEvent.click(document.querySelector('[data-review="w"]')!);
    expect(document.body.textContent).toContain("only as far as the latest verified health snapshot keeps the pool above its minimum reserve");
    expect(calls).toHaveLength(0);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Request withdrawal" })));
    expect(calls).toEqual([{ kind: "withdraw", input: { pool_id: POOL, amount_cents: 200_000, idempotency_key: expect.any(String) } }]);
  });
});

describe("the table tabs' forms", () => {
  it("open in a sheet from their labelled CTA or row button, not inline in the tab", async () => {
    render(<EarnTable tab="opportunities" data={lpData} actions={actions().a} />);
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
