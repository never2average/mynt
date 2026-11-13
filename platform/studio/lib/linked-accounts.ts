// The accounts linked to the user's Mynt sign-in (get_linked_accounts): their GitHub username and
// crypto wallets, and the identity provider's account page where they link more. The studio only
// links out to that page; it never embeds the provider's sign-in. Pure, for the route, the
// dashboard and the tests.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export type LinkedAccounts = {
  supported: boolean; // Mynt has get_linked_accounts
  github: string | null; // the username
  wallet: { address: string; chain: string | null; network: string } | null; // the first wallet; network is checked against the address
  manageUrl: string | null; // https only
};

export const NOT_LINKED: LinkedAccounts = { supported: false, github: null, wallet: null, manageUrl: null };

// Only an https page is linked to (never javascript:, data: or a relative path).
function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

export function fromLinkedAccounts(reply: unknown): LinkedAccounts {
  const r = isObj(reply) ? reply : {};
  const git = r.git;
  const github = typeof git === "string" ? str(git) : isObj(git) ? (str(git.username) ?? str(git.login) ?? null) : null;
  const first = Array.isArray(r.wallets) ? r.wallets.find((w) => isObj(w) && str(w.address)) : undefined;
  const wallet = isObj(first) ? { address: str(first.address)!, chain: str(first.chain) ?? null, network: networkOf(str(first.address)!, str(first.chain)) } : null;
  return { supported: true, github: github ?? null, wallet, manageUrl: httpsUrl(r.manage_url) };
}

// The wallet's network, shown only when the address fits it: an EVM address (0x and 40 hex
// digits) on an EVM chain, or a Solana address (base58, 32-44 characters, no 0, O, I or l) on
// Solana. Anything else is "Unknown network", never a guess.
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_CHAINS: Record<string, string> = {
  ethereum: "Ethereum",
  base: "Base",
  polygon: "Polygon",
  arbitrum: "Arbitrum",
  optimism: "Optimism",
  avalanche: "Avalanche",
  evm: "EVM",
};
export const UNKNOWN_NETWORK = "Unknown network";

export function networkOf(address: string, chain?: string | null): string {
  const c = chain?.trim().toLowerCase() || null;
  if (SOLANA_ADDRESS.test(address)) return !c || c === "solana" ? "Solana" : UNKNOWN_NETWORK;
  if (EVM_ADDRESS.test(address)) return c ? (EVM_CHAINS[c] ?? UNKNOWN_NETWORK) : "EVM";
  return UNKNOWN_NETWORK;
}

// 0x1234…abcd: enough to recognise, short enough for a tile.
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
