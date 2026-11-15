// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import bs58 from "bs58";
import type { Wallet } from "@wallet-standard/base";
import { DraftsTab, PoolsTab } from "@/components/earn-assistant";
import type { LiquidityActions } from "@/components/earn-view";
import { EARN_DISCLOSURE, EARN_DISCLOSURE_DETAILS, EarnDisclosure, EarnWalletProvider, WalletPicker, type EarnWalletState, type PrepareInput, type TreasuryActions } from "@/components/earn-wallet";
import { earnContext, validateDraft, type Draft } from "@/lib/earn";
import { fromPools, fromPositions, type LiquidityData } from "@/lib/liquidity";
import { balancesFrom, CHOSEN_KEY, chosenWallet, explorerTxUrl, preparedFrom, rememberWallet, usdcText, walletsFrom, type EarnWallets, type Prepared } from "@/lib/wallets";

// Earn's wallet: the one-line disclaimer and its tooltip, the chat bar's wallet picker (no wallets,
// wallets with balances, balances unavailable, Mynt without the tools), the choice remembered per
// user, and the on-chain deposit and withdrawal: nothing is signed until the user's own clicks, the
// summary is Mynt's, the browser wallet must be the chosen linked wallet, and the transaction goes
// to it untouched.

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
afterEach(cleanup);

const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const SOL2 = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const MANAGE = "https://accounts.example.com/user";
const POOL = "11111111-1111-4111-8111-111111111111";
const TX = btoa(String.fromCharCode(...Array.from({ length: 200 }, (_, i) => i % 256)));
const SIG_BYTES = new Uint8Array(64).fill(7);
const SIG = bs58.encode(SIG_BYTES);

const list = (over: Partial<EarnWallets> = {}): EarnWallets => ({
  supported: true,
  balancesSupported: true,
  owner: "owner-a",
  wallets: [
    { address: SOL, chain: "solana", network: "Solana", balances: { solLamports: "1500000000", usdcBaseUnits: "2500000000" } },
    { address: EVM, chain: "ethereum", network: "EVM", balances: null },
  ],
  manageUrl: MANAGE,
  treasury: { deposit: true, withdraw: true, status: true },
  ...over,
});

const prepared = (over: Partial<Prepared["summary"]> = {}): Prepared => ({
  cluster: "devnet",
  transactionBase64: TX,
  expiresAt: "2099-01-01T00:00:00Z",
  summary: { pool: "On-chain float", amount: "500 USDC", lockInSeconds: 30 * 86_400, noticeSeconds: 7 * 86_400, wallet: SOL, ...over },
});

// A browser wallet, as the Wallet Standard registers one, connected to `account`.
function fakeWallet(account: string, chains = ["solana:devnet"]) {
  const connect = vi.fn(async () => ({ accounts: [{ address: account, publicKey: new Uint8Array(32), chains, features: ["solana:signAndSendTransaction"] }] }));
  const signAndSendTransaction = vi.fn(async (..._inputs: { transaction: Uint8Array; chain: string; account: { address: string } }[]) => [{ signature: SIG_BYTES }]);
  const wallet = {
    version: "1.0.0",
    name: "Test Wallet",
    icon: "data:image/svg+xml;base64,PHN2Zy8+",
    chains,
    accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect },
      "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: [0], signAndSendTransaction },
    },
  } as unknown as Wallet;
  return { wallet, connect, signAndSendTransaction };
}

type TestState = EarnWalletState & { prepares: PrepareInput[]; settled: number };
function state(over: Partial<EarnWalletState> = {}): TestState {
  const prepares: PrepareInput[] = [];
  const s: TestState = {
    prepares,
    settled: 0,
    list: list(),
    chosen: list().wallets[0],
    choose: () => undefined,
    treasury: {
      prepare: async (input) => (prepares.push(input), { prepared: prepared() }),
      status: vi.fn<TreasuryActions["status"]>().mockResolvedValueOnce({ status: "pending", error: null }).mockResolvedValue({ status: "confirmed", error: null }),
    },
    browserWallets: () => [] as Wallet[],
    onSettled: () => void s.settled++,
    pollMs: 1,
    ...over,
  };
  return s;
}

const base = {
  product_id: "card-credit",
  sandbox: true,
  status: "open",
  min_reserve_bps: 2000,
  min_reserve_floor_cents: 0,
  notice_period_days: 7,
  lock_in_days: 30,
  min_commitment_cents: 100,
  max_commitment_cents: 10_000_000,
  approved_at: "2026-11-01T00:00:00Z",
};
const TREASURY = { cluster: "devnet", program_id: "Prog111111111111111111111111111111111111111", pool_address: SOL2, verified_build: true, on_chain_terms: { lock_in_seconds: 2_592_000, notice_seconds: 604_800 } };
const onChainPools = fromPools([{ ...base, id: POOL, name: "On-chain float", treasury: TREASURY }]).map((p) => ({ ...p, productLine: "credit", queueLength: null, health: null }));
const onChainPositions = fromPositions([{ pool_id: POOL, name: "On-chain float", product_id: "card-credit", sandbox: true, balance_cents: 100_000, available_to_withdraw_cents: 50_000, source: "on-chain", cluster: "devnet", deposit: "dep-1" }]);
const data: LiquidityData = { supported: true, access: { builder: false, liquidityProvider: true }, provider: { pools: onChainPools, positions: onChainPositions, withdrawals: [], canCommit: true, canWithdraw: true } };
const railCalls: string[] = [];
const rails: LiquidityActions = {
  propose: async () => ({ ok: true, reply: null }),
  commit: async () => (railCalls.push("commit"), { ok: true, reply: null }),
  withdraw: async () => (railCalls.push("withdraw"), { ok: true, reply: null }),
};
const depositDraft: Draft = { kind: "commit", id: "d1", poolId: POOL, poolName: "On-chain float", amountCents: 50_000, state: null, sandbox: true, onChain: true, wallet: SOL };
const withdrawDraft: Draft = { kind: "withdraw", id: "w1", poolId: POOL, poolName: "On-chain float", amountCents: 20_000, sandbox: true, onChain: true, wallet: SOL };

const renderDrafts = (s: EarnWalletState, drafts: Draft[] = [depositDraft]) =>
  render(
    <EarnWalletProvider value={s}>
      <DraftsTab data={data} drafts={drafts} actions={rails} />
    </EarnWalletProvider>,
  );
const click = async (el: Element) => act(async () => void fireEvent.click(el));
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

describe("the disclaimer", () => {
  it("is one line, with the full text in the ⓘ tooltip", async () => {
    render(<EarnDisclosure />);
    expect(document.querySelector("[data-earn-disclosure]")!.textContent).toBe(EARN_DISCLOSURE);
    expect(EARN_DISCLOSURE).toBe("Not investment advice · Mynt never holds your funds");
    expect(document.body.textContent).not.toContain("rails");
    await act(async () => void fireEvent.focus(screen.getByRole("button", { name: "About Earn and your money" })));
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toContain(EARN_DISCLOSURE_DETAILS);
    for (const s of ["rails", "on-chain treasury", "Solana devnet", "Mynt admin clears", "sandbox", "only figures Mynt measures", "isn't investment advice"]) expect(EARN_DISCLOSURE_DETAILS).toContain(s);
  });
});

describe("the wallet picker", () => {
  const picker = (s: EarnWalletState) =>
    render(
      <EarnWalletProvider value={s}>
        <WalletPicker />
      </EarnWalletProvider>,
    );
  const open = async () => {
    await act(async () => void fireEvent.keyDown(document.querySelector('[data-wallet-picker="wallets"]')!, { key: "Enter" }));
    return document.querySelector("[data-wallet-picker-menu]") as HTMLElement;
  };

  it("with no wallets is Link wallet, to the account page", () => {
    picker(state({ list: list({ wallets: [] }), chosen: null }));
    const link = screen.getByRole("link", { name: "Link wallet" });
    expect(link.getAttribute("href")).toBe(MANAGE);
  });

  it("before Mynt links accounts says so, disabled", () => {
    picker(state({ list: list({ supported: false, wallets: [], manageUrl: null }), chosen: null }));
    expect((document.querySelector('[data-wallet-picker="unsupported"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the wallets with short address, network and devnet balances, the chosen one checked, and Link wallet", async () => {
    const chosen: string[] = [];
    picker(state({ choose: (a) => void chosen.push(a) }));
    expect(document.querySelector('[data-wallet-picker="wallets"]')!.textContent).toContain("7EcDhS…FLtV");
    expect(document.querySelector('[data-wallet-picker="wallets"]')!.textContent).toContain("Devnet");
    const menu = await open();
    const sol = menu.querySelector(`[data-wallet-option="${SOL}"]`)!;
    expect(sol.textContent).toContain("Solana");
    expect(sol.querySelector("[data-wallet-balances]")!.textContent).toBe("2,500 USDC · 1.5 SOL · devnet");
    expect(sol.getAttribute("aria-checked")).toBe("true");
    expect(menu.querySelector(`[data-wallet-option="${EVM}"]`)!.textContent).toContain("EVM");
    expect(menu.querySelector("[data-wallet-link]")!.getAttribute("href")).toBe(MANAGE);
    await click(menu.querySelector(`[data-wallet-option="${EVM}"]`)!);
    expect(chosen).toEqual([EVM]);
  });

  it("shows the wallets without balances when Mynt can't give them", async () => {
    const l = list({ balancesSupported: false, wallets: [{ address: SOL, chain: "solana", network: "Solana", balances: null }] });
    picker(state({ list: l, chosen: l.wallets[0] }));
    const menu = await open();
    expect(menu.querySelector("[data-wallet-balances]")!.textContent).toBe("Balances unavailable");
    expect(menu.textContent).toContain("Live balances come with Mynt's next update.");
  });
});

describe("wallets, balances and the remembered choice", () => {
  it("reads verified wallets only, and balances as whole base units", () => {
    expect(walletsFrom({ wallets: [{ address: SOL, chain: "solana", verified: true }, { address: SOL2, chain: "solana", verified: false }, { address: EVM, chain: "ethereum" }, { address: "nonsense" }] }).map((w) => [w.address, w.chain])).toEqual([
      [SOL, "solana"],
      [EVM, "ethereum"],
      ["nonsense", null],
    ]);
    expect(balancesFrom({ sol_lamports: 5, usdc_base_units: "123456789" })).toEqual({ solLamports: "5", usdcBaseUnits: "123456789" });
    expect(balancesFrom({ sol_lamports: -1, usdc_base_units: 1 })).toBeNull();
    expect(balancesFrom({ sol_lamports: 1 })).toBeNull();
    expect(usdcText("123456789")).toBe("123.456789 USDC");
  });

  it("remembers the chosen wallet per user, and survives storage that throws", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const l = list();
    expect(chosenWallet(l, s)?.address).toBe(SOL); // first Solana wallet by default
    rememberWallet("owner-a", EVM, s);
    expect(chosenWallet(l, s)?.address).toBe(EVM);
    expect(chosenWallet({ ...l, owner: "owner-b" }, s)?.address).toBe(SOL); // another user on this browser
    expect(JSON.parse(store.get(CHOSEN_KEY)!)).toEqual({ "owner-a": EVM });
    rememberWallet("owner-a", "not-mine-any-more", s);
    expect(chosenWallet(l, s)?.address).toBe(SOL); // a wallet no longer linked isn't used
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(() => rememberWallet("owner-a", SOL, broken)).not.toThrow();
    expect(chosenWallet(l, broken)?.address).toBe(SOL);
  });

  it("refuses a prepared transaction that isn't devnet, too large, or for another wallet", () => {
    const ok = { cluster: "devnet", transaction_base64: TX, expires_at: null, summary: { pool: "P", amount: 500_000_000, lock_in_seconds: 0, notice_seconds: 0, wallet: SOL } };
    expect(preparedFrom(ok, SOL)).toMatchObject({ transactionBase64: TX, summary: { amount: "500 USDC" } });
    expect(preparedFrom({ ...ok, cluster: "mainnet-beta" }, SOL)).toHaveProperty("error");
    expect(preparedFrom({ ...ok, transaction_base64: btoa("x".repeat(1300)) }, SOL)).toHaveProperty("error");
    expect(preparedFrom({ ...ok, transaction_base64: "not base64!" }, SOL)).toHaveProperty("error");
    expect(preparedFrom(ok, SOL2)).toHaveProperty("error");
  });

  it("links a signature to an explorer only when one is configured, on devnet, https only", () => {
    expect(explorerTxUrl(SIG, undefined)).toBeNull();
    expect(explorerTxUrl(SIG, "https://explorer.example/tx/{signature}")).toBe(`https://explorer.example/tx/${SIG}?cluster=devnet`);
    expect(explorerTxUrl(SIG, "http://explorer.example/tx/{signature}")).toBeNull();
    expect(explorerTxUrl("bad", "https://explorer.example/tx/{signature}")).toBeNull();
  });
});

describe("the assistant's drafts with a wallet", () => {
  const sol = { address: SOL, network: "Solana", solana: true, balances: { solLamports: "1", usdcBaseUnits: "1000000000" } };
  it("an on-chain pool needs a chosen Solana wallet and enough devnet USDC, and no state", () => {
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 50_000 }, onChainPools, [], "d", null)).toHaveProperty("error");
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 50_000 }, onChainPools, [], "d", { ...sol, solana: false })).toHaveProperty("error");
    const over = validateDraft("commit", { pool_id: POOL, amount_cents: 200_000 }, onChainPools, [], "d", sol);
    expect("error" in over && over.error).toContain("1,000 USDC");
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 50_000 }, onChainPools, [], "d", sol)).toEqual({ draft: { ...depositDraft, id: "d" } });
    expect(validateDraft("withdraw", { pool_id: POOL, amount_cents: 20_000 }, onChainPools, onChainPositions, "w", sol)).toEqual({ draft: { ...withdrawDraft, id: "w" } });
  });

  it("tells the assistant the chosen wallet and its balances, or that they're unavailable", () => {
    expect(earnContext({ builder: false, liquidityProvider: true }, sol)).toContain(`${SOL} (Solana, devnet). Its devnet balances: 1,000 USDC · 0 SOL`);
    expect(earnContext({ builder: false, liquidityProvider: true }, { ...sol, balances: null })).toContain("unavailable");
    expect(earnContext({ builder: false, liquidityProvider: true }, null)).toContain("haven't chosen a wallet");
  });
});

describe("the on-chain deposit", () => {
  it("shows the pool's treasury on devnet", () => {
    render(<PoolsTab data={data} poolIds={null} />);
    expect(document.querySelector(`[data-pool-card="${POOL}"] [data-treasury="devnet"]`)!.textContent).toBe("On-chain treasury");
    expect(document.querySelector(`[data-pool-card="${POOL}"] [data-devnet]`)).toBeTruthy();
  });

  it("signs only after the user's clicks: prepare, Mynt's summary, then the user's own wallet, with the transaction untouched", async () => {
    const { wallet, connect, signAndSendTransaction } = fakeWallet(SOL);
    const s = state({ browserWallets: () => [wallet] });
    renderDrafts(s);
    // The draft is drawn: nothing prepared, nothing signed, and no rail commitment offered.
    expect(s.prepares).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Commit capital" })).toBeNull();
    const prepare = screen.getByRole("button", { name: "Deposit from 7EcDhS…FLtV · devnet" });
    await click(prepare);
    expect(s.prepares).toEqual([{ kind: "deposit", pool_id: POOL, wallet: SOL, amount_cents: 50_000, idempotency_key: expect.stringMatching(/^[A-Za-z0-9_-]{8,200}$/) }]);
    // Mynt's summary, not the assistant's words; still nothing signed.
    expect(document.querySelector("[data-summary-amount]")!.textContent).toContain("500 USDC");
    expect(document.querySelector("[data-summary-wallet]")!.textContent).toBe(SOL);
    expect(document.querySelector("[data-prepared]")!.textContent).toContain("30 days");
    expect(signAndSendTransaction).not.toHaveBeenCalled();
    await click(screen.getByRole("button", { name: "Sign in Test Wallet" }));
    await settle();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
    const input = signAndSendTransaction.mock.calls[0][0];
    expect(input.chain).toBe("solana:devnet");
    expect(input.account.address).toBe(SOL);
    expect(btoa(String.fromCharCode(...input.transaction))).toBe(TX); // untouched
    expect(document.querySelector("[data-tx=confirmed]")!.textContent).toContain("Confirmed on devnet");
    expect(document.querySelector(`[data-signature="${SIG}"]`)).toBeTruthy();
    expect(s.settled).toBe(1);
    expect(railCalls).toHaveLength(0);
  });

  it("refuses when the browser wallet isn't the chosen linked wallet, before signing", async () => {
    const { wallet, signAndSendTransaction } = fakeWallet(SOL2);
    renderDrafts(state({ browserWallets: () => [wallet] }));
    await click(screen.getByRole("button", { name: "Deposit from 7EcDhS…FLtV · devnet" }));
    await click(screen.getByRole("button", { name: "Sign in Test Wallet" }));
    expect(signAndSendTransaction).not.toHaveBeenCalled();
    const err = document.querySelector("[data-on-chain-error]")!.textContent!;
    expect(err).toContain("not your chosen wallet 7EcDhS…FLtV");
    expect(err).toContain("Nothing was signed");
  });

  it("refuses a summary for another wallet, and says when no browser wallet can sign", async () => {
    const { wallet, signAndSendTransaction } = fakeWallet(SOL);
    const s = state({ browserWallets: () => [wallet] });
    s.treasury.prepare = async () => ({ prepared: prepared({ wallet: SOL2 }) });
    renderDrafts(s);
    await click(screen.getByRole("button", { name: "Deposit from 7EcDhS…FLtV · devnet" }));
    await click(screen.getByRole("button", { name: "Sign in Test Wallet" }));
    expect(signAndSendTransaction).not.toHaveBeenCalled();
    expect(document.querySelector("[data-on-chain-error]")!.textContent).toContain("different wallet");
    cleanup();
    renderDrafts(state({ browserWallets: () => [] }));
    await click(screen.getByRole("button", { name: "Deposit from 7EcDhS…FLtV · devnet" }));
    expect(document.querySelector("[data-no-browser-wallet]")).toBeTruthy();
  });

  it("shows a failed transaction with its signature", async () => {
    const { wallet } = fakeWallet(SOL);
    const s = state({ browserWallets: () => [wallet] });
    s.treasury.status = async () => ({ status: "failed", error: "Lock-in longer than you agreed to" });
    renderDrafts(s);
    await click(screen.getByRole("button", { name: "Deposit from 7EcDhS…FLtV · devnet" }));
    await click(screen.getByRole("button", { name: "Sign in Test Wallet" }));
    await settle();
    expect(document.querySelector("[data-tx=failed]")!.textContent).toContain("Lock-in longer than you agreed to");
    expect(s.settled).toBe(0);
  });

  it("withdraws the same way, back to the chosen wallet", async () => {
    const { wallet, signAndSendTransaction } = fakeWallet(SOL);
    const s = state({ browserWallets: () => [wallet] });
    renderDrafts(s, [withdrawDraft]);
    expect(screen.queryByRole("button", { name: "Request withdrawal" })).toBeNull();
    await click(screen.getByRole("button", { name: "Withdraw to 7EcDhS…FLtV · devnet" }));
    expect(s.prepares[0]).toMatchObject({ kind: "withdrawal", pool_id: POOL, wallet: SOL, amount_cents: 20_000 });
    await click(screen.getByRole("button", { name: "Sign in Test Wallet" }));
    await settle();
    expect(signAndSendTransaction).toHaveBeenCalledTimes(1);
  });

  it("degrades: without Mynt's treasury tools it says on-chain deposits are coming soon; without a Solana wallet it asks for one", async () => {
    const s = state({ list: list({ treasury: { deposit: false, withdraw: false, status: false } }) });
    renderDrafts(s);
    const button = screen.getByRole("button", { name: /Deposit from/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.body.textContent).toContain("On-chain deposits coming soon.");
    await click(button);
    expect(s.prepares).toHaveLength(0);
    cleanup();
    renderDrafts(state({ chosen: list().wallets[1] }), [{ ...depositDraft, wallet: null }]);
    expect(document.body.textContent).toContain("Choose one of your linked Solana wallets in the chat bar first.");
  });

  it("a pool whose treasury isn't on devnet is never offered", () => {
    const mainnet = fromPools([{ ...base, id: POOL, name: "Elsewhere", treasury: { ...TREASURY, cluster: "mainnet-beta" } }]).map((p) => ({ ...p, productLine: null, queueLength: null, health: null }));
    render(
      <EarnWalletProvider value={state()}>
        <DraftsTab data={{ ...data, provider: { ...data.provider!, pools: mainnet } }} drafts={[depositDraft]} actions={rails} />
      </EarnWalletProvider>,
    );
    expect((screen.getByRole("button", { name: /Deposit from/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("devnet only");
  });
});
