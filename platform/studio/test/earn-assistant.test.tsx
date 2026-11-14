// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EarnAssistant, EarnLanding, EarnPanel } from "@/components/earn-assistant";
import type { LiquidityActions } from "@/components/earn-view";
import { panelFrom, PROMPT_EXAMPLES, type Draft } from "@/lib/earn";
import { fromPools, fromPositions, type LiquidityData } from "@/lib/liquidity";

// Earn's Assistant tab: the prompt box, the panel beside the chat, and drafts that need the user's click.

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
const data: LiquidityData = { supported: true, access: { builder: false, liquidityProvider: true }, provider: { pools, positions, withdrawals: [], canCommit: true, canWithdraw: true } };

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

afterEach(cleanup);

describe("the prompt box", () => {
  it("asks the assistant with what's typed, or an example chip", () => {
    const onAsk = vi.fn();
    render(<EarnLanding status="enabled" onAsk={onAsk} />);
    expect(screen.getByRole("heading", { name: "What do you want to earn?" })).toBeTruthy();
    for (const ex of ["$50k, 90-day lock-in, US credit", "Lowest risk, withdraw anytime"]) expect(PROMPT_EXAMPLES).toContain(ex);
    fireEvent.change(screen.getByLabelText("What do you want to earn?"), { target: { value: "  $50k, 90-day lock-in, US credit  " } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(onAsk).toHaveBeenCalledWith("$50k, 90-day lock-in, US credit");
    fireEvent.click(screen.getByRole("button", { name: "Lowest risk, withdraw anytime" }));
    expect(onAsk).toHaveBeenLastCalledWith("Lowest risk, withdraw anytime");
    // Honest copy: rails today, an on-chain treasury coming, no advice or promised returns.
    const disclosure = document.querySelector("[data-earn-disclosure]")!.textContent!;
    expect(disclosure).toContain("on-chain USDC treasury per app is coming");
    expect(disclosure).toContain("isn't investment advice");
  });

  it("can't ask when AI isn't configured", () => {
    const onAsk = vi.fn();
    render(<EarnLanding status="disabled" onAsk={onAsk} />);
    expect(screen.getByRole("status").textContent).toContain("AI is not configured");
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the first prompt goes to the assistant's chat (POST /api/earn by its transport)", () => {
    const sendMessage = vi.fn(async () => undefined);
    const chat = { messages: [], sendMessage, stop: async () => undefined, setMessages: () => undefined } as never;
    render(<EarnAssistant chat={chat} status="enabled" data={data} actions={actions().a} />);
    fireEvent.change(screen.getByLabelText("What do you want to earn?"), { target: { value: "Sandbox pools to try" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(sendMessage).toHaveBeenCalledWith({ text: "Sandbox pools to try" });
  });
});

describe("the panel beside the chat", () => {
  it("follows the conversation: the pools it matched, and its drafts", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "90-day" }] },
      { role: "assistant", parts: [{ type: "text", text: "…" }, { type: "data-earn-pools", data: { pool_ids: [UNCLEARED] } }, { type: "data-earn-draft", data: draft() }] },
    ];
    const { poolIds, drafts } = panelFrom(messages);
    expect(poolIds).toEqual([UNCLEARED]);
    expect(drafts).toHaveLength(1);
    render(<EarnPanel data={data} poolIds={poolIds} drafts={drafts} actions={actions().a} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(1);
    const card = document.querySelector(`[data-pool-card="${UNCLEARED}"]`)!.textContent!;
    for (const s of ["Uncleared float", "credit", "Sandbox only — not yet cleared for real commitments", "90 days", "$1,000.00 – $100,000.00 per firm", "Not available yet"]) expect(card).toContain(s);
    // Lock-in and notice period are separate lines; Mynt sets no lock-in on this pool.
    expect(document.querySelector(`[data-pool-card="${UNCLEARED}"] [data-lock-in]`)!.textContent).toBe("Not set");
    expect(document.querySelector(`[data-pool-card="${UNCLEARED}"] [data-notice]`)!.textContent).toBe("90 days");
    expect(document.querySelector("[data-earn-positions]")!.textContent).toContain("$5,000.00 settled · $2,000.00 available");
    // Nothing matched yet: every pool open to the user.
    cleanup();
    render(<EarnPanel data={data} poolIds={null} drafts={[]} actions={actions().a} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(2);
  });

  it("a draft commitment does nothing until the user clicks Commit capital, then calls the commit route once", async () => {
    const { a, calls } = actions();
    render(<EarnPanel data={data} poolIds={null} drafts={[draft()]} actions={a} />);
    expect(calls).toHaveLength(0);
    expect(document.querySelector('[data-draft="commit"]')!.textContent).toContain("Nothing has been sent");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Commit capital" })));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "commit", input: { pool_id: POOL, amount_cents: 5_000_000, state: "us-ny" } });
    expect(String(calls[0].input.idempotency_key)).toMatch(/^[A-Za-z0-9_-]{8,200}$/);
    expect(screen.getByRole("status").textContent).toContain("Deposit requested (movement m1, requested).");
    // Done: a second click sends nothing.
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Commit capital" })));
    expect(calls).toHaveLength(1);
  });

  it("a draft shows the pool's lock-in when Mynt sets one, the notice period apart, and the pool name in its own field, never as the amount", () => {
    const locked = fromPools([{ ...base, id: POOL, name: "$1,000.00", lock_in_days: 30 }]).map((p) => ({ ...p, queueLength: null, health: null }));
    render(<EarnPanel data={{ ...data, provider: { ...data.provider!, pools: locked } }} poolIds={null} drafts={[draft({ poolName: "$1,000.00" })]} actions={actions().a} />);
    const card = document.querySelector('[data-draft="commit"]')!;
    expect(card.querySelector("[data-lock-in]")!.textContent).toBe("30 days");
    expect(card.querySelector("[data-notice]")!.textContent).toBe("90 days");
    expect(card.querySelector("[data-draft-pool]")!.textContent).toBe("$1,000.00");
    expect(card.querySelector("[data-draft-amount]")!.textContent).toBe("$50,000.00");
  });

  it("a draft the page's terms refuse can't be confirmed (an uncleared pool, over the limit)", async () => {
    const { a, calls } = actions();
    render(<EarnPanel data={data} poolIds={null} drafts={[draft({ id: "d2", poolId: UNCLEARED, poolName: "Uncleared float" }), draft({ id: "d3", amountCents: 9_600_000 })]} actions={a} />);
    const buttons = screen.getAllByRole("button", { name: "Commit capital" }) as HTMLButtonElement[];
    expect(buttons.every((b) => b.disabled)).toBe(true);
    await act(async () => buttons.forEach((b) => fireEvent.click(b)));
    expect(calls).toHaveLength(0);
    expect(document.body.textContent).toContain("A Mynt admin must clear this pool");
    expect(document.body.textContent).toContain("over this pool's limit");
  });

  it("a draft withdrawal needs the click too, and says payment depends on verified health", async () => {
    const { a, calls } = actions();
    render(<EarnPanel data={data} poolIds={null} drafts={[draft({ kind: "withdraw", id: "w", amountCents: 200_000 } as Partial<Draft>)]} actions={a} />);
    expect(document.body.textContent).toContain("only as far as the latest verified health snapshot keeps the pool above its minimum reserve");
    expect(calls).toHaveLength(0);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Request withdrawal" })));
    expect(calls).toEqual([{ kind: "withdraw", input: { pool_id: POOL, amount_cents: 200_000, idempotency_key: expect.any(String) } }]);
  });
});
