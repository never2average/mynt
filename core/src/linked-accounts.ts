import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Store, User } from "./store.js";

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
  // The person's linked accounts, by the provider's own id for them (users.clerk_user_id for Clerk).
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
  private readonly cache = new Map<string, { at: number; value: LinkedAccounts }>();

  constructor(
    private readonly provider: IdentityProvider,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async forSubject(subject: string | null): Promise<LinkedAccountsReply> {
    const manage_url = this.provider.manageUrl();
    if (!subject) return { git: null, wallets: null, manage_url, unavailable: "This account didn't sign in through the identity provider" };
    const hit = this.cache.get(subject);
    if (hit && this.now() - hit.at < this.ttlMs) return { ...hit.value, manage_url };
    try {
      const value = await this.provider.linkedAccounts(subject);
      this.cache.set(subject, { at: this.now(), value });
      if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
      return { ...value, manage_url };
    } catch (e) {
      // Only the kind of failure: a provider's message may carry request details.
      const status = (e as { status?: number }).status;
      return { git: null, wallets: null, manage_url, unavailable: `The identity provider couldn't be reached${status ? ` (HTTP ${status})` : ""}; try again shortly` };
    }
  }
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function registerLinkedAccountsTools(server: McpServer, store: Store, user: User, service: LinkedAccountsService) {
  server.registerTool(
    "get_linked_accounts",
    {
      title: "Your linked accounts",
      description:
        "Your GitHub account and crypto wallets (Solana, Ethereum) linked to your sign-in, and whether each is verified, as the identity provider knows them; manage_url is where you link or unlink them. null with a reason when the provider can't be reached.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const r = await store.db.query("SELECT clerk_user_id FROM financial_products.users WHERE id = $1", [user.id]);
      const subject = ((r.rows[0] as { clerk_user_id?: string | null } | undefined)?.clerk_user_id ?? null) as string | null;
      return json(await service.forSubject(subject));
    },
  );
}
