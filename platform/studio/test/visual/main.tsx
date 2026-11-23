// The visual harness: one studio screen per page (?screen=<id>&theme=light|dark), in the studio's
// real shell (sidebar and header) with the tests' fixtures, and the API answered from fixtures
// in the browser (no server). Not part of the app; nothing here ships.
import "@/app/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

import { ThemeProvider } from "@/components/theme-switcher";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StudioShell } from "@/app/(studio)/studio-shell";
import WorkspaceLayout from "@/app/(studio)/[projectId]/layout";
import { Assistant } from "@/app/(studio)/[projectId]/assistant";
import { ProjectWelcome } from "@/components/assistant-ui/project-welcome";
import { ConnectGuide } from "@/components/connect-guide";
import NewAppPage from "@/app/(studio)/new/page";
import { DashboardView } from "@/components/dashboard-view";
import { InvestorView } from "@/components/investor-view";
import { HeaderTabs } from "@/components/header-tabs";
import { ModeSwitch } from "@/components/mode-switch";
import { EarnWorkspace } from "@/components/earn-assistant";
import type { LiquidityActions } from "@/components/earn-view";
import type { EarnWalletState } from "@/components/earn-wallet";
import { BuildsView } from "@/components/builds-view";
import { LicencesPageView } from "@/components/licences-page-view";
import { AuditsView, AuditTabs, NO_AUDIT_FILTERS, ObligationsView } from "@/components/audits-view";
import { NO_SETTINGS_TOOLS, WorkspaceView } from "@/components/workspace-view";
import { fromDashboardTool } from "@/lib/dashboard";
import { fromPnl } from "@/lib/pnl";
import { fromAudit, fromCoverage, fromLicences } from "@/lib/compliance";
import { fromAttention } from "@/lib/attention";
import { fromClassAudit, fromObligations } from "@/lib/audit-classes";
import { fromPools, fromPositions, fromWithdrawals, type LiquidityData } from "@/lib/liquidity";
import { appLicences, fromPnl as appPnl } from "@/lib/app-panel";
import type { Draft } from "@/lib/earn";

const q = new URLSearchParams(window.location.search);
const screenId = q.get("screen") ?? "dashboard";
const theme = q.get("theme") === "dark" ? "dark" : "light";
try {
  localStorage.setItem("theme", theme);
} catch {}

const NOW = Date.parse("2026-11-15T12:00:00Z");
const noop = () => undefined;

// ---- fixtures (from test/*.test.tsx) ----

const projects = [
  { id: "a1", name: "Round-up savings", description: "", status: "published", stage: "production", ownerId: "u1", previewUrl: null, conversations: [{ id: "b1", title: "Add a card screen", status: "succeeded", phaseMessage: null, previewUrl: null, createdAt: "2026-11-12T10:00:00Z", updatedAt: "2026-11-12T10:00:00Z" }] },
  { id: "a2", name: "Payroll advance", description: "", status: "draft", stage: "staging", ownerId: "u1", previewUrl: null, conversations: [{ id: "b3", title: "Add onboarding", status: "coding", phaseMessage: null, previewUrl: null, createdAt: "2026-11-05T10:00:00Z", updatedAt: "2026-11-05T10:00:00Z" }] },
  { id: "a3", name: "Allowance cards for teenagers with a very long name", description: "", status: "draft", stage: "idea", ownerId: null, previewUrl: null, conversations: [] },
];

const measured = {
  currency: "USD",
  period: { from: "2026-10-14", to: "2026-11-12", days: 30 },
  money_moved: { settled_usd: 125430.5, live: true },
  customers: { active_enrollments: 812 },
  handoffs: { total: 300, converted: 75, conversion_rate: 0.25 },
  build_spend: { month_usd: 42.1, monthly_cap_usd: 200 },
  earnings: { usd: null, tracked: false },
  daily: [{ date: "2026-11-02", money_moved_usd: 1200 }, { date: "2026-11-01", money_moved_usd: 800 }],
  apps: [{ app_id: "a1", name: "Round-up savings", status: "published", money_moved_usd: 125430.5, customers: 812, conversion_rate: 0.25, last_build: { id: "b9", status: "succeeded", at: "2026-11-10T12:00:00Z" } }],
};
const pnlReply = {
  currency: "USD",
  series: [
    { start: "2026-06-01", end: "2026-06-30", revenue_cents: 20000, costs_cents: 9000, net_cents: 11000 },
    { start: "2026-07-01", end: "2026-07-31", revenue_cents: 30000, costs_cents: 15000, net_cents: 15000 },
    { start: "2026-08-01", end: "2026-08-31", revenue_cents: 26000, costs_cents: 22000, net_cents: 4000 },
    { start: "2026-09-01", end: "2026-09-30", revenue_cents: null, costs_cents: 12000, net_cents: null },
    { start: "2026-10-01", end: "2026-10-31", revenue_cents: 50000, costs_cents: 80000, net_cents: -30000 },
    { start: "2026-11-01", end: "2026-11-30", revenue_cents: 150000, costs_cents: 40000, net_cents: 110000 },
  ],
  statement: {
    columns: [
      { key: "this_period", label: "This month", start: "2026-11-01", end: "2026-11-30" },
      { key: "last_period", label: "Last month", start: "2026-10-01", end: "2026-10-31" },
      { key: "year_to_date", label: "Year to date", start: "2026-01-01", end: "2026-11-30" },
    ],
    revenue: [{ key: "app:a1", label: "Round-up savings", app_id: "a1", values: { this_period: 150000, last_period: 50000, year_to_date: 200000 }, measured: true, source: "settled fees" }],
    costs: [
      { key: "build_agents", label: "Coding agents", values: { this_period: 30000, last_period: 70000, year_to_date: 100000 }, measured: true, source: "builds" },
      { key: "hosting", label: "Hosting", values: { this_period: null, last_period: null, year_to_date: null }, measured: false, source: null },
    ],
    totals: {
      revenue: { this_period: 150000, last_period: 50000, year_to_date: 200000 },
      costs: { this_period: 40000, last_period: 80000, year_to_date: 120000 },
      net: { this_period: 110000, last_period: -30000, year_to_date: 80000 },
    },
  },
  unmeasured: [{ key: "hosting", label: "Hosting", reason: "Hosting costs aren't metered per workspace yet." }],
};
const stagesData = { kind: "ready" as const, data: { checks: false, apps: projects.map((p) => ({ id: p.id, name: p.name, stage: p.stage as "production", readiness: null })) } };
const attention = fromAttention({ items: [{ id: "x1", kind: "licence", severity: "high", title: "Harbor Bank's lender licence in NY expires in 16 days", detail: "Payroll advance can't move money in New York after it lapses.", href: "/licences", at: "2026-11-14T10:00:00Z" }] });
const activity = fromAudit({
  events: [
    { at: "2026-11-15T09:00:00Z", actor: { id: "u1", name: "Ines Diaz" }, action: "app.created", target: { type: "app", id: "a1", name: "Round-up savings" } },
    { at: "2026-11-14T11:00:00Z", actor: { id: "u2", name: "Sam Lee" }, action: "member.invited", target: { type: "user", id: "u9" }, details: "as member" },
    { at: "2026-11-12T08:00:00Z", actor: { id: "u1", name: "Ines Diaz" }, action: "build.succeeded", target: { type: "app", id: "a2", name: "Payroll advance" } },
  ],
}).events;

const USDC = (d: number) => String(d * 1_000_000);
const investorPositions = fromPositions({
  positions: [
    { pool_id: "p-rails", name: "Harbor credit pool", product_id: "prod1", pool_status: "cleared", contributed_cents: 500000, pending_in_cents: 0, balance_cents: 400000, queued_withdrawal_cents: 50000, withdrawn_cents: 100000, available_to_withdraw_cents: 0 },
    {
      source: "on-chain", cluster: "devnet", pool_id: "p-chain", name: "Cards treasury", product_id: "prod2", sandbox: true,
      deposits: [
        { deposit: "Dep1", amount: USDC(1000), remaining: USDC(1000), queued: "0", settled_at: "2026-10-03T00:00:00Z", review_until: "2026-10-04T00:00:00Z", unlock_at: "2026-11-25T00:00:00Z", unlocked: false, rejected: false },
        { deposit: "Dep2", amount: USDC(200), remaining: USDC(200), queued: USDC(200), settled_at: "2026-09-10T00:00:00Z", review_until: "2026-09-11T00:00:00Z", unlocks_at: "2026-10-10T00:00:00Z", unlocked: true, rejected: false },
        { deposit: "Dep3", amount: USDC(50), remaining: USDC(50), queued: "0", settled_at: "2026-11-15T00:00:00Z", review_until: "2026-11-16T00:00:00Z", unlock_at: "2027-02-15T00:00:00Z", unlocked: false, rejected: false },
      ],
      requests: [{ address: "Req1", deposit: "Dep2", amount: USDC(200), remaining: USDC(200), paid: USDC(0), payable_at: "2026-12-01T00:00:00Z", status: "open" }],
    },
  ],
});
const investorLiquidity: LiquidityData = {
  supported: true,
  access: { builder: true, liquidityProvider: true },
  provider: {
    pools: [
      { id: "p-rails", health: { verified: true, snapshotStatus: "ok", sequence: 7, periodEnd: "2026-11-01", latestVerifiedEnd: "2026-11-01", coverageBps: 12000, headroomCents: 1, reason: null } },
      { id: "p-chain", health: null },
    ] as never,
    positions: investorPositions,
    withdrawals: fromWithdrawals({ withdrawals: [{ id: "w1", pool_id: "p-rails", pool_name: "Harbor credit pool", amount_cents: 50000, status: "queued", eligible_at: "2026-11-20T00:00:00Z", settled_cents: 0 }] }),
    canCommit: true,
    canWithdraw: true,
  },
};
const financialRows = fromClassAudit({ rows: [{ id: "f1", at: "2026-11-14T10:00:00Z", class: "financial", kind: "liquidity.commit", summary: "Committed $5,000.00", status: "settled" }] }).rows;

const POOL = "11111111-1111-4111-8111-111111111111";
const poolBase = {
  product_id: "card-credit", sponsor_entity_id: "22222222-2222-4222-8222-222222222222", sandbox: false, status: "open", min_reserve_bps: 2000, min_reserve_floor_cents: 0,
  notice_period_days: 90, min_commitment_cents: 100_000, max_commitment_cents: 10_000_000, deposit_rail_id: "33333333-3333-4333-8333-333333333333",
  withdrawal_rail_id: "44444444-4444-4444-8444-444444444444", approved_at: "2026-11-01T00:00:00Z", offering_cleared: true,
};
const earnPools = fromPools([
  { ...poolBase, id: POOL, name: "Card float" },
  { ...poolBase, id: "11111111-1111-4111-8111-111111111112", name: "Uncleared float", offering_cleared: false },
  { ...poolBase, id: "11111111-1111-4111-8111-111111111113", name: "Payroll advance reserve pool for New York", status: "proposed", approved_at: null },
]).map((p) => ({ ...p, productLine: "credit", queueLength: null, health: null }));
const earnPositions = fromPositions([{ pool_id: POOL, name: "Card float", product_id: "card-credit", state: "us-ny", balance_cents: 500_000, available_to_withdraw_cents: 200_000 }]);
const earnData: LiquidityData = {
  supported: true,
  access: { builder: true, liquidityProvider: true },
  provider: { pools: earnPools, positions: earnPositions, withdrawals: [], canCommit: true, canWithdraw: true },
  builder: { pools: earnPools, proposable: [{ productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: "s1", sponsorName: "Harbor Bank" }], withdrawalsShown: true },
};
const earnActions: LiquidityActions = { propose: async () => ({ ok: true, reply: null }), commit: async () => ({ ok: true, reply: null }), withdraw: async () => ({ ok: true, reply: null }) };
const draft: Draft = { kind: "commit", id: "d1", poolId: POOL, poolName: "Card float", amountCents: 5_000_000, state: "us-ny", sandbox: false } as Draft;
const withDraft: UIMessage[] = [
  { id: "u", role: "user", parts: [{ type: "text", text: "Put $50k in a 90-day US credit pool" }] },
  { id: "a", role: "assistant", parts: [{ type: "text", text: "Card float fits: 90 days' notice, a 20% reserve. I've drafted a $50,000.00 commitment; it's in My strategies for you to review." }, { type: "data-earn-draft", data: draft } as never] },
];
const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const walletList = {
  supported: true, balancesSupported: true, owner: "owner-a",
  wallets: [
    { address: SOL, chain: "solana" as const, network: "Solana", balances: { solLamports: "1500000000", usdcBaseUnits: "2500000000" } },
    { address: "0x52908400098527886E0F7030069857D2E4169EE7", chain: "ethereum" as const, network: "EVM", balances: null },
  ],
  manageUrl: "/account",
  treasury: { deposit: true, withdraw: true, status: true },
};
const wallet: EarnWalletState = {
  list: walletList as never,
  chosen: walletList.wallets[0] as never,
  choose: noop,
  treasury: { prepare: async () => ({ error: "harness" }), status: async () => ({ status: "pending", stage: "not_found", error: null }) } as never,
  browserWallets: () => [],
  onSettled: noop,
};

const buildRows = [
  { appId: "a1", appName: "Round-up savings", id: "b1", title: "Add a card screen", status: "succeeded", updatedAt: "2026-11-12T10:00:00Z" },
  { appId: "a1", appName: "Round-up savings", id: "b2", title: "Fix the ledger sync so that every settled transfer shows up in the statement the same day", status: "failed", updatedAt: "2026-11-10T10:00:00Z" },
  { appId: "a2", appName: "Payroll advance", id: "b3", title: "Add onboarding", status: "coding", updatedAt: "2026-11-05T10:00:00Z" },
  { appId: "a2", appName: "Payroll advance", id: "b4", title: "Queue a check", status: "queued", updatedAt: "2026-10-20T10:00:00Z" },
];

const coverage = fromCoverage({
  states: [
    { code: "ca", name: "California", status: "unlocked", partners: [{ entity_id: "e1", name: "Harbor Bank" }], licences: [{ type: "Money transmitter", number: "MT-1" }], products: [{ name: "Round-up savings" }], rails: ["ACH"] },
    { code: "NY", status: "available", partners: ["Harbor Bank"] },
    { code: "TX", status: "unlocked", partners: ["Prairie Trust"] },
  ],
});
const licences = fromLicences({
  licences: [
    { partner: "Harbor Bank", type: "Money transmitter", regulator: "CA DFPI", number: "MT-1", states: ["ca"], status: "active", expires_at: "2027-06-01" },
    { partner: "Harbor Bank", type: "Lender", regulator: "NY DFS", number: "L-2", states: ["NY", "NJ"], status: "active", expires_at: "2026-12-01" },
    { partner: { name: "Prairie Trust" }, type: "Money transmitter", regulator: "TX DOB", number: "MT-3", states: ["TX"], status: "active", expires_at: "2026-10-01" },
    { partner: "Prairie Trust", type: "Lender", regulator: "TX OCCC", number: "L-4", states: ["TX"], status: "suspended", expires_at: null },
  ],
});
const securityRows = fromClassAudit({
  rows: [
    { id: "r1", at: "2026-11-12T10:00:00Z", class: "security", kind: "build.audit_finding", actor: { id: "u1", name: "Ines" }, app_id: "a1", target: { type: "build", id: "b1" }, summary: "Secret written to logs", severity: "high", status: "open" },
    { id: "r2", at: "2026-11-11T10:00:00Z", class: "security", kind: "program.gate", actor: "Mynt", app_id: "a1", target: { type: "program" }, summary: "Upgrade timelock missing", severity: "medium", status: "blocked" },
  ],
}).rows;
const obligations = fromObligations({
  obligations: [
    { licence_id: "l1", partner: { entity_id: "e1", name: "Harbor Bank" }, licence_type: "Money transmitter", regulator: "CA DFPI", obligation_id: "CA-MT-Q", title: "Quarterly transaction report", products: ["Cards", { name: "Savings" }], status: "met", evidence: "Filed 2026-10-10" },
    { licence_id: "l1", partner: { entity_id: "e1", name: "Harbor Bank" }, licence_type: "Money transmitter", regulator: "CA DFPI", obligation_id: "CA-MT-AUD", title: "Annual audit", products: ["Cards"], status: "at_risk" },
    { licence_id: "l2", partner: { entity_id: "e2", name: "Prairie Trust" }, regulator: "TX DOB", obligation_id: "TX-1", title: "Surety bond renewal", products: [], status: "overdue" },
  ],
});

const ws = { id: "w1", name: "Acme", role: "owner" as const, createdAt: "2026-09-01T00:00:00Z", memberCount: 3 };
const info = { supported: true, workspace: ws, canManage: true, isOwner: true, tools: { ...NO_SETTINGS_TOOLS, rename: true } };
const membersData = {
  supported: true, canManage: true,
  members: [
    { userId: "u1", name: "Ines Diaz", email: "ines@example.com", role: "owner" as const },
    { userId: "u2", name: "Sam Lee", email: "sam@example.com", role: "member" as const },
  ],
  invites: [{ id: "i1", email: "dev@example.com", role: "member" as const, createdAt: "2026-11-10T00:00:00Z", expiresAt: "2026-11-24T00:00:00Z" }],
  manageUrl: null,
};
const appsRows = [
  { id: "a1", name: "Round-up savings", stage: "production" as const, owner: "Ines Diaz", lastBuild: { id: "b1", status: "succeeded", at: "2026-11-10T00:00:00Z" } },
  { id: "a3", name: "Budgeting", stage: "idea" as const, owner: null, lastBuild: null },
];
const memberActions = { invite: async () => null, changeRole: async () => null, remove: async () => null, revoke: async () => null };

// The app builder's panel tabs, as /api/apps/<id>/panel answers.
const APP_PNL = {
  series: [
    { start: "2026-10-01T00:00:00.000Z", revenue_cents: 50_000, costs_cents: 20_000, net_cents: 30_000 },
    { start: "2026-11-01T00:00:00.000Z", revenue_cents: null, costs_cents: 10_000, net_cents: null },
  ],
  statement: {
    columns: [{ key: "this_period", label: "This month (Nov)" }, { key: "year_to_date", label: "2026 to date" }],
    revenue: [{ key: "settled", label: "Money settled", values: { this_period: null, year_to_date: 50_000 }, measured: false }],
    costs: [{ key: "builds", label: "Builds", values: { this_period: 10_000, year_to_date: 30_000 }, measured: true }],
    totals: { revenue: { this_period: null, year_to_date: 50_000 }, costs: { this_period: 10_000, year_to_date: 30_000 }, net: { this_period: null, year_to_date: 20_000 } },
  },
  unmeasured: [{ key: "fees", label: "Take-rate fees", reason: "Mynt doesn't record fees charged yet" }],
};
const APP_COVERAGE = {
  states: [
    { code: "us-ny", name: "New York", status: "unlocked", products: [{ id: "p1", name: "Card" }, { id: "p2", name: "Savings" }], licences: [{ type: "MTL", regulator: "NYDFS", number: "1", status: "active" }] },
    { code: "us-ca", name: "California", status: "unlocked", products: [{ id: "p1", name: "Card" }], licences: [{ type: "MTL", regulator: "DFPI", number: "2", status: "active" }] },
  ],
};
const ev = (i: number) => ({ at: `2026-11-${String(10 + (i % 10)).padStart(2, "0")}T10:00:00Z`, action: `api_key_created`, actor: "Ines", details: null });
const panel: Record<string, unknown> = {
  pnl: appPnl(APP_PNL),
  licences: appLicences(APP_COVERAGE, [{ id: "p1", name: "Card" }, { id: "p2", name: "Savings" }], { id: "licences", label: "Every product licensed", status: "fail", detail: "Savings isn't covered in California", fix: { label: "See licences", href: "/licences", external: false, tool: null } } as never),
  security: {
    available: true,
    events: Array.from({ length: 4 }, (_, i) => ev(i)),
    eventsReason: null,
    checks: [
      { id: "build_verified", label: "Latest build verified", status: "pass", detail: null, fix: null },
      { id: "audit_findings", label: "No open critical findings", status: "fail", detail: "1 high finding", fix: null },
    ],
    checksReason: null,
  },
  sdk: { available: true, products: [{ productId: "p1", name: "Card", version: "3", action: "issuance", access: "public", permitted: ["deep_link"], notPermitted: [], fields: ["name"], handOff: null, generatedClients: null, hasContract: false, error: null }] },
  activity: { available: true, builds: [{ id: "b0", status: "failed", goal: "Fix the ledger sync", at: "2026-11-12T00:00:00Z" }, { id: "b1", status: "succeeded", goal: "Add a card screen", at: "2026-11-11T00:00:00Z" }], events: [ev(1)], eventsReason: null },
};

// ---- the API, answered in the browser ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function api(url: string): Response {
  const path = url.split("?")[0];
  const tab = new URL(url, "http://h").searchParams.get("tab");
  if (path === "/api/liquidity/access") return json({ developer: true, access: { builder: true, liquidityProvider: true }, owner: "o" });
  if (path === "/api/workspaces") return json({ supported: true, workspaces: [{ id: "w1", name: "Acme", role: "owner" }, { id: "w2", name: "Beta Labs", role: "member" }] });
  if (/^\/api\/workspaces\/w\d$/.test(path)) return json(info);
  if (path === "/api/projects") return json({ projects });
  if (path === "/api/session") return json({ name: "Ines Diaz", email: "ines@example.com" });
  if (path === "/api/invitations") return json({ invitations: [] });
  if (path === "/api/ask" || path === "/api/earn") return json({ enabled: true });
  if (path === "/api/linked-accounts") return json({ linked: { github: null, wallets: walletList.wallets } });
  if (path === "/api/repositories") return json({ supported: true, repositories: [] });
  if (path === "/api/earn/wallets") return json(walletList);
  if (path === "/api/products")
    return json({
      products: [
        { id: "p1", name: "Card credit", productLine: "credit", by: "Harbor Bank", accessMode: "public" },
        { id: "p2", name: "High-yield savings", productLine: "deposits", by: "Harbor Bank", accessMode: "public" },
        { id: "p3", name: "Earned wage access", productLine: "payroll_advance", by: "Prairie Trust", accessMode: "invite" },
      ],
    });
  const m = /^\/api\/apps\/([^/]+)\/panel$/.exec(path);
  if (m && tab) return json({ data: panel[tab] });
  if (/^\/api\/apps\/[^/]+\/promotion/.test(path)) return json({ supported: false });
  return json({});
}
window.fetch = (async (input: RequestInfo | URL) => api(typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url)) as typeof fetch;

// ---- screens ----

function fakeTransport(): ChatTransport<UIMessage> {
  return {
    sendMessages: async () =>
      new ReadableStream<UIMessageChunk>({
        start(c) {
          for (const ch of [{ type: "start" }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "Here are the pools." }, { type: "text-end", id: "t" }, { type: "finish" }] as UIMessageChunk[]) c.enqueue(ch);
          c.close();
        },
      }),
    reconnectToStream: async () => null,
  };
}
function Earn({ tab, messages }: { tab?: string; messages?: UIMessage[] }) {
  const [transport] = useState(fakeTransport);
  const chat = useChat<UIMessage>({ id: "earn", transport, messages });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <EarnWorkspace chat={chat} status="enabled" data={earnData} actions={earnActions} initialTab={tab} wallet={wallet} historyOwner="o" />
    </div>
  );
}

const Page = ({ children }: { children: React.ReactNode }) => (
  <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">{children}</div>
  </div>
);

function Dashboard({ empty = false }: { empty?: boolean }) {
  const [mode, setMode] = useState<"builder" | "investor">("builder");
  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <HeaderTabs>
        <ModeSwitch modes={["builder", "investor"]} mode={mode} onMode={setMode} />
      </HeaderTabs>
      {mode === "investor" ? (
        <div className="flex flex-1 flex-col p-4 lg:p-6">
          <InvestorView liquidity={{ kind: "ready", data: investorLiquidity }} activity={{ kind: "ready", data: financialRows }} attention={{ kind: "ready", data: [] }} now={NOW} />
        </div>
      ) : empty ? (
        <DashboardView dashboard={fromDashboardTool({})} stages={{ kind: "ready", data: { checks: false, apps: [] } }} attention={{ kind: "ready", data: [] }} activity={{ kind: "ready", data: [] }} pnl={{ kind: "unsupported" }} />
      ) : (
        <DashboardView dashboard={fromDashboardTool(measured)} stages={stagesData} attention={{ kind: "ready", data: attention }} activity={{ kind: "ready", data: activity }} pnl={{ kind: "ready", data: fromPnl(pnlReply) }} />
      )}
    </div>
  );
}

function Licences({ map = false }: { map?: boolean }) {
  const [view, setView] = useState<"table" | "map">(map ? "map" : "table");
  const [region, setRegion] = useState<"us" | "world">("us");
  return (
    <Page>
      <LicencesPageView view={view as never} onView={(v) => setView(v as never)} region={region} onRegion={setRegion} coverage={{ kind: "ready", data: coverage }} licences={{ kind: "ready", data: licences }} now={Date.parse("2026-11-13T00:00:00Z")} />
    </Page>
  );
}

function Audits({ tab }: { tab: "security" | "obligations" | "financial" | "workspace" }) {
  const [t, setT] = useState(tab);
  const rows = t === "security" ? securityRows : t === "financial" ? financialRows : [];
  return (
    <Page>
      <AuditTabs tab={t} onTab={setT} />
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel={t}>
        {t === "obligations" ? (
          <ObligationsView obligations={obligations} now={NOW} />
        ) : (
          <AuditsView auditClass={t} rows={rows} filters={NO_AUDIT_FILTERS} onFilters={noop} members={[{ id: "u1", name: "Ines Diaz" }]} apps={[{ id: "a1", name: "Round-up savings" }]} actions={["build.audit_finding"]} page={1} hasNext onPrev={noop} onNext={noop} />
        )}
      </div>
    </Page>
  );
}

function Settings({ tab }: { tab: "members" | "invitations" | "apps" | "repositories" }) {
  const [t, setT] = useState(tab);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="@container/main flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        <WorkspaceView tab={t} onTab={setT as never} info={info as never} members={membersData as never} apps={appsRows} memberActions={memberActions} repos={{ kind: "ready", repos: [], connect: true }} />
      </div>
    </div>
  );
}

function AppBuilder() {
  return (
    <WorkspaceLayout>
      <Assistant selectedProjectId="a1" selectedConversationId={null} welcome={<ProjectWelcome />} />
    </WorkspaceLayout>
  );
}

const SCREENS: Record<string, { path: string; render: () => React.ReactNode }> = {
  dashboard: { path: "/", render: () => <Dashboard /> },
  "dashboard-empty": { path: "/", render: () => <Dashboard empty /> },
  investor: { path: "/", render: () => <Dashboard /> },
  "earn-start": { path: "/earn", render: () => <Earn /> },
  "earn-pools": { path: "/earn", render: () => <Earn tab="pools" messages={withDraft} /> },
  "earn-my-pools": { path: "/earn", render: () => <Earn tab="my-pools" messages={withDraft} /> },
  "earn-strategies": { path: "/earn", render: () => <Earn tab="my-strategies" messages={withDraft} /> },
  builds: { path: "/builds", render: () => <Page><BuildsView rows={buildRows} /></Page> },
  "builds-empty": { path: "/builds", render: () => <Page><BuildsView rows={[]} /></Page> },
  licences: { path: "/licences", render: () => <Licences /> },
  "licences-map": { path: "/licences", render: () => <Licences map /> },
  "audits-security": { path: "/audits", render: () => <Audits tab="security" /> },
  "audits-obligations": { path: "/audits", render: () => <Audits tab="obligations" /> },
  "audits-financial": { path: "/audits", render: () => <Audits tab="financial" /> },
  "audits-workspace": { path: "/audits", render: () => <Audits tab="workspace" /> },
  "settings-members": { path: "/settings", render: () => <Settings tab="members" /> },
  "settings-invitations": { path: "/settings", render: () => <Settings tab="invitations" /> },
  "settings-apps": { path: "/settings", render: () => <Settings tab="apps" /> },
  "settings-repositories": { path: "/settings", render: () => <Settings tab="repositories" /> },
  connect: { path: "/connect", render: () => <ConnectGuide /> },
  new: { path: "/new", render: () => <NewAppPage /> },
  app: { path: "/a1", render: () => <AppBuilder /> },
};

const screen = SCREENS[screenId] ?? SCREENS.dashboard;
(globalThis as unknown as { __visualPath?: string }).__visualPath = screen.path;

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <TooltipProvider delayDuration={0}>
      <StudioShell>{screen.render()}</StudioShell>
    </TooltipProvider>
  </ThemeProvider>,
);
