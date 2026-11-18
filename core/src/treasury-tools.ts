import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { productsAnsweredBy } from "./access.js";
import { getPool } from "./liquidity.js";
import type { LiquidityRoles } from "./liquidity-tools.js";
import type { LinkedAccountsService } from "./linked-accounts.js";
import type { Store, User } from "./store.js";
import { MAINNET_DISABLED, TREASURY_CLUSTERS, TreasuryRefusal, type Standing, type TreasuryService } from "./treasury.js";
import { DEPOSIT_APPROVAL_FORMATS } from "./solana/treasury-chain.js";

// The tools of on-chain treasury pools (treasury.ts). Devnet only. Mynt prepares unsigned transactions; the person's
// own wallet signs and sends them.

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string, extra: Record<string, unknown> = {}) => ({ ...json({ error, ...extra }), isError: true });
const BaseUnits = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe("USDC base units (USDC has 6 decimals: 1 USDC is 1000000)");
const Seconds = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Address = z.string().min(32).max(44);

// Who the caller is for a treasury action: their firm (active on Mynt) and their verified Solana wallets.
export async function treasuryStanding(store: Store, user: User, identity: LinkedAccountsService | null): Promise<Standing> {
  const me = (await store.getUser(user.id)) ?? user;
  let firm: string | null = null;
  let firmProblem: string | null = null;
  if (!me.entity_id) firmProblem = "You don't belong to a firm yet; an admin adds your firm (register_firm) and you to it (add_entity_member)";
  else if ((await store.getEntity(me.entity_id))?.status !== "active") firmProblem = "Your firm isn't active on Mynt";
  else firm = me.entity_id;
  // Anyone's verified Solana wallets as the identity provider has them now; null when that can't be read.
  const linkedOf = async (userId: string): Promise<string[] | null> => {
    if (!identity) return null;
    const r = await identity.forUser(userId);
    return r.wallets === null ? null : r.wallets.filter((w) => w.chain === "solana" && w.verified).map((w) => w.address);
  };
  let wallets: Standing["wallets"];
  if (!identity) wallets = { unavailable: "No identity provider is connected to this Mynt, so linked wallets can't be read" };
  else {
    const r = await identity.forUser(user.id);
    wallets = r.wallets === null ? { unavailable: "unavailable" in r ? r.unavailable : "Your linked wallets couldn't be read" } : r.wallets.filter((w) => w.chain === "solana" && w.verified).map((w) => w.address);
  }
  return { user: me, firm, firmProblem, wallets, linkedOf };
}

export function registerTreasuryTools(server: McpServer, store: Store, user: User, roles: LiquidityRoles, treasury: TreasuryService, identity: LinkedAccountsService | null) {
  // A refusal with its code; anything else is a plain failure (the message never carries an RPC address). Each tool
  // audits its own outcome, by name.
  type Outcome = { value: unknown } | { refusal: TreasuryRefusal } | { error: string };
  const attempt = async (f: () => Promise<unknown>): Promise<Outcome> => {
    try {
      return { value: await f() };
    } catch (e) {
      return e instanceof TreasuryRefusal ? { refusal: e } : { error: (e as Error).message.slice(0, 300) };
    }
  };
  const reply = (o: Outcome) => ("value" in o ? json(o.value) : "refusal" in o ? fail(o.refusal.message, { code: o.refusal.code, ...o.refusal.extra }) : fail(o.error));
  const codeOf = (o: Outcome) => ("refusal" in o ? o.refusal.code : null);

  if (roles.builder || roles.admin) {
    server.registerTool(
      "get_treasury_attester",
      {
        title: "Mynt's treasury attester",
        description:
          "Builder: the devnet key Mynt approves treasury deposits with. Put it in your pool's attesters (terms.attesters) when you initialise the treasury, or Mynt can't approve deposits to it. It holds no funds and signs only deposit approvals.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        try {
          return json({ cluster: "devnet", attester: await treasury.attesterAddress() });
        } catch (e) {
          return fail((e as Error).message);
        }
      },
    );

    server.registerTool(
      "register_treasury_pool",
      {
        title: "Register a pool's on-chain treasury",
        description:
          "Builder of the pool's product: name the devnet treasury (a program built from Mynt's treasury template, and its pool account) that holds this pool's capital. Mynt reads both from devnet and refuses a pool account that isn't a mynt_treasury pool at its own address, for devnet, holding devnet USDC, whose attesters are exactly [Mynt's attester (get_treasury_attester), none] (attester_missing, unexpected_attesters), and whose creator or authority is a verified Solana wallet linked to you (not_pool_owner; an admin may register any). The program's executable hash is recorded; a build Mynt hasn't rebuilt from the template at this address is shown as an unverified build (devnet takes it). deposit_approval is the approval layout the program checks: MYNTDEP3 (the template now: each approval is for one deposit of its exact amount) or MYNTDEP2 (earlier builds: reusable until it expires, so Mynt's limits are only advisory). Mynt knows it for the template's own builds and refuses a different one (wrong_deposit_approval); otherwise it defaults to what the pool was registered with, or MYNTDEP3. Devnet only: mainnet is refused (mainnet_disabled). Registering again replaces it.",
        inputSchema: {
          pool_id: z.string().uuid(),
          cluster: z.enum(TREASURY_CLUSTERS),
          program_id: Address,
          pool_address: Address,
          deposit_approval: z.enum(DEPOSIT_APPROVAL_FORMATS).optional().describe("The deposit approval layout the program checks; leave it out for a build of the current template"),
        },
      },
      async (input) => {
        if (input.cluster !== "devnet") return fail(MAINNET_DISABLED, { code: "mainnet_disabled" });
        const pool = await getPool(store, input.pool_id);
        if (!pool) return fail(`No pool '${input.pool_id}'`, { code: "no_pool" });
        if (!roles.admin) {
          const me = (await store.getUser(user.id)) ?? user;
          const owned = me.entity_id ? (await productsAnsweredBy(store, me)).some((p) => p.entity_id === me.entity_id && p.product.id === pool.product_id) : false;
          if (!owned) return fail("Only the builder of the pool's product can register its treasury", { code: "not_builder" });
        }
        const details = { program_id: input.program_id, pool_address: input.pool_address };
        const o = await attempt(async () => treasury.register(user, input, { admin: roles.admin, wallets: (await treasuryStanding(store, user, identity)).wallets }));
        if ("value" in o) await store.audit(user.id, "register_treasury_pool", input.pool_id, details);
        else if ("refusal" in o) await store.audit(user.id, "register_treasury_pool_refused", input.pool_id, { ...details, code: codeOf(o) });
        return reply(o);
      },
    );
  }

  if (roles.liquidityProvider) {
    server.registerTool(
      "prepare_treasury_deposit",
      {
        title: "Prepare a deposit into a pool's on-chain treasury",
        description:
          "Liquidity provider, devnet only: an unsigned transaction depositing devnet USDC from one of your linked wallets into the pool's treasury. Mynt checks the wallet is a verified wallet linked to your sign-in, your firm's standing, the pool's commitment limits and pauses, then its attester approves this one deposit (valid ten minutes). For a pool on MYNTDEP3 (deposit_approval) the approval names the exact amount and is spent by the deposit, and approvals not yet landed count toward your firm's limit until they expire. Your wallet pays the fee, signs and sends it: Mynt never signs for your funds or holds your keys. max_lock_in_seconds is the longest lock-in you accept: the deposit fails on chain if the pool's lock-in rises above it. Refusals carry a code: wallet_not_linked, not_liquidity_provider, offering_not_cleared, over_limit, under_minimum, pool_paused, not_on_chain, mainnet_disabled, terms_changed, insufficient_usdc, attester_removed, attesters_changed, program_upgraded (the program was redeployed since it was registered), wrong_cluster, rate_limited (20 prepares a minute), rpc_unavailable.",
        inputSchema: { pool_id: z.string().uuid(), wallet: Address, amount_usdc_base_units: BaseUnits, max_lock_in_seconds: Seconds },
      },
      async (input) => {
        const details = { wallet: input.wallet, amount_usdc_base_units: input.amount_usdc_base_units };
        const o = await attempt(async () => treasury.prepareDeposit(await treasuryStanding(store, user, identity), input));
        if ("value" in o) await store.audit(user.id, "prepare_treasury_deposit", input.pool_id, details);
        else if ("refusal" in o) await store.audit(user.id, "prepare_treasury_deposit_refused", input.pool_id, { ...details, code: codeOf(o) });
        return reply(o);
      },
    );

    server.registerTool(
      "prepare_treasury_withdrawal",
      {
        title: "Prepare a withdrawal request from a pool's on-chain treasury",
        description:
          "Liquidity provider, devnet only: an unsigned request_withdrawal transaction against one of your deposits (deposit: its record's address, from list_my_positions), for your wallet to sign and send. It joins the pool's first-in-first-out queue and is paid to the wallet's own USDC account after the notice period, never below the reserve floor. max_notice_seconds is the longest notice you accept. Refusals carry a code: wallet_not_linked, not_liquidity_provider, offering_not_cleared, deposit_not_found, deposit_rejected, in_review, deposit_locked, over_limit, below_min_request, terms_changed, not_on_chain, mainnet_disabled, rate_limited, rpc_unavailable.",
        inputSchema: { pool_id: z.string().uuid(), wallet: Address, deposit: Address, amount_usdc_base_units: BaseUnits, max_notice_seconds: Seconds },
      },
      async (input) => {
        const details = { wallet: input.wallet, deposit: input.deposit, amount_usdc_base_units: input.amount_usdc_base_units };
        const o = await attempt(async () => treasury.prepareWithdrawal(await treasuryStanding(store, user, identity), input));
        if ("value" in o) await store.audit(user.id, "prepare_treasury_withdrawal", input.pool_id, details);
        else if ("refusal" in o) await store.audit(user.id, "prepare_treasury_withdrawal_refused", input.pool_id, { ...details, code: codeOf(o) });
        return reply(o);
      },
    );

    server.registerTool(
      "get_wallet_balances",
      {
        title: "A linked wallet's balances",
        description: "Liquidity provider: the SOL (lamports) and devnet USDC (base units) one of your verified linked Solana wallets holds, read from devnet. Only your own linked wallets (wallet_not_linked otherwise); devnet only (mainnet_disabled).",
        inputSchema: { address: Address, cluster: z.enum(TREASURY_CLUSTERS) },
        annotations: { readOnlyHint: true },
      },
      async ({ address, cluster }) => {
        if (cluster !== "devnet") return fail(MAINNET_DISABLED, { code: "mainnet_disabled" });
        const s = await treasuryStanding(store, user, identity);
        if (!Array.isArray(s.wallets)) return fail(`Your linked wallets couldn't be checked: ${s.wallets.unavailable}`, { code: "wallet_not_linked" });
        if (!s.wallets.includes(address)) return fail("That isn't a verified Solana wallet linked to your sign-in", { code: "wallet_not_linked" });
        try {
          return json(await treasury.balances(address, cluster));
        } catch (e) {
          return e instanceof TreasuryRefusal ? fail(e.message, { code: e.code }) : fail((e as Error).message.slice(0, 300));
        }
      },
    );
  }

  if (roles.liquidityProvider || roles.builder || roles.licenceProvider || roles.admin)
    server.registerTool(
      "get_treasury_tx_status",
      {
        title: "Has a treasury transaction landed?",
        description:
          "Whether a transaction you sent on devnet landed: not_found, processed, confirmed, finalized or failed (with the cluster's error). Once confirmed, the registered treasury pools it touched are queued for indexing (queued_pools), so list_my_positions shows it within moments. At most 30 calls a minute (rate_limited).",
        inputSchema: { signature: z.string().min(64).max(100) },
        annotations: { readOnlyHint: true },
      },
      async ({ signature }) => {
        try {
          return json(await treasury.txStatus(user, signature));
        } catch (e) {
          return e instanceof TreasuryRefusal ? fail(e.message, { code: e.code }) : fail((e as Error).message.slice(0, 300));
        }
      },
    );
}
