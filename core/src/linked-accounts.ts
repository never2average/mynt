import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { User } from "./store.js";

// The accounts a person has linked to their sign-in: their git host account and their crypto wallets, as the identity
// provider knows them. Read-only: linking happens on the provider's own account page (manage_url). Never a token.
//
// The provider adapter (ClerkIdentityProvider in auth.ts) says how to read them; this module caches them per user for
// a minute and turns a provider outage into a null with a reason, never a failed call.

export interface LinkedGit {
  provider: "github";
  username: string | null;
  verified: boolean;
}
export interface LinkedWallet {
  chain: "solana" | "ethereum";
  address: string;
  verified: boolean;
}
export interface LinkedAccounts {
  git: LinkedGit | null;
  wallets: LinkedWallet[];
}

export interface IdentityProvider {
  // Mynt's user to the provider's own id for them; null when they didn't sign in through it.
  subjectOf(userId: string): Promise<string | null>;
  // The person's linked accounts, by the provider's id: verified ones only.
  linkedAccounts(subject: string): Promise<LinkedAccounts>;
  // Where the person links or unlinks accounts themselves; null if the provider has no such page.
  manageUrl(): string | null;
}

// A wallet address's chain, from its form: 0x and 40 hex digits is Ethereum (and EVM chains); base58 of 32 to 44
// characters is Solana. Anything else isn't shown.
export function chainOf(address: string): LinkedWallet["chain"] | null {
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return "ethereum";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return "solana";
  return null;
}

export type LinkedAccountsReply =
  | (LinkedAccounts & { manage_url: string | null })
  | { git: null; wallets: null; manage_url: string | null; unavailable: string };

export class LinkedAccountsService {
  // Answers for a minute; a failure for 15 seconds (so a provider outage isn't hammered by every page load).
  private readonly cache = new Map<string, { at: number; ttl: number; value: LinkedAccounts | { unavailable: string } }>();

  constructor(
    private readonly provider: IdentityProvider,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly failureTtlMs = 15_000,
  ) {}

  async forUser(userId: string): Promise<LinkedAccountsReply> {
    const manage_url = this.provider.manageUrl();
    const reply = (v: LinkedAccounts | { unavailable: string }): LinkedAccountsReply =>
      "unavailable" in v ? { git: null, wallets: null, manage_url, unavailable: v.unavailable } : { ...v, manage_url };
    let subject: string | null;
    try {
      subject = await this.provider.subjectOf(userId);
    } catch {
      return reply({ unavailable: "Your account couldn't be looked up just now; try again shortly" });
    }
    if (!subject) return reply({ unavailable: "This account didn't sign in through the identity provider" });
    const hit = this.cache.get(subject);
    if (hit && this.now() - hit.at < hit.ttl) return reply(hit.value);
    let value: LinkedAccounts | { unavailable: string };
    let ttl = this.ttlMs;
    try {
      value = await this.provider.linkedAccounts(subject);
    } catch (e) {
      // Only the kind of failure: a provider's message may carry request details.
      const status = (e as { status?: number }).status;
      value = {
        unavailable:
          status === 404
            ? "The identity provider has no account for you any more (it was deleted); sign in again"
            : `The identity provider couldn't be reached${status ? ` (HTTP ${status})` : ""}; try again shortly`,
      };
      ttl = this.failureTtlMs;
    }
    this.cache.set(subject, { at: this.now(), ttl, value });
    if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
    return reply(value);
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function registerLinkedAccountsTools(server: McpServer, user: User, service: LinkedAccountsService) {
  server.registerTool(
    "get_linked_accounts",
    {
      title: "Your linked accounts",
      description:
        "Your verified GitHub account and crypto wallets (Solana, Ethereum) linked to your sign-in, as the identity provider knows them; manage_url is where you link or unlink them. null with a reason when the provider can't be reached or no longer has your account.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await service.forUser(user.id)),
  );
}
