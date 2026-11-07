// Dollars only for customers. A developer's customers see and send US dollars only: amounts, fees, totals,
// statuses, arrival times and references. Wallets, tokens, chain addresses, chain names and stablecoin symbols
// never reach a device, an SDK result or customer-facing copy. The settlement asset underneath (USDC on Solana,
// moved by the licensed ramp partner) is partner- and firm-side: it lives in a service's full output, which goes
// sealed to the innovator, never to the device.
//
// This module is the one place that knows what a crypto concept looks like, so the service-type check, the
// developer contract and the device's outcome all apply the same rule.

// Words that name a crypto concept when they are a whole part of a field name (snake_case or camelCase).
const CRYPTO_WORDS = new Set([
  "asset",
  "assets",
  "chain",
  "chains",
  "network",
  "networks",
  "wallet",
  "wallets",
  "address",
  "addresses",
  "tx",
  "txid",
  "txn",
  "hash",
  "token",
  "tokens",
  "coin",
  "coins",
  "crypto",
  "stablecoin",
  "stablecoins",
  "blockchain",
  "onchain",
  "memo",
  "gas",
  "mint",
  "cctp",
]);
// Token symbols and chain names: a value equal to one of these (any case) is a crypto concept.
const CRYPTO_VALUES = new Set([
  "usdc",
  "usdt",
  "eurc",
  "pyusd",
  "dai",
  "btc",
  "eth",
  "sol",
  "bitcoin",
  "ethereum",
  "solana",
  "base",
  "polygon",
  "arbitrum",
  "optimism",
  "avalanche",
  "tron",
  "stellar",
]);
for (const w of ["usdc", "usdt", "eurc", "pyusd", "btc", "eth", "sol", "bitcoin", "ethereum", "solana"]) CRYPTO_WORDS.add(w);

const words = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Whether a field name carries a crypto concept ("asset", "chain_network", "walletAddress", "destination_tx_hash").
export const cryptoName = (name: string): boolean => words(name).some((w) => CRYPTO_WORDS.has(w)) || /destination_?tag/i.test(name);

// Whether free text (a service type's name, which reaches devices in error messages) names a crypto concept.
export const cryptoText = (text: string): boolean => words(text).some((w) => CRYPTO_WORDS.has(w) || (CRYPTO_VALUES.has(w) && w !== "base"));

// Whether a value a device would be shown is a crypto concept: a token symbol or chain name, an EVM address or
// transaction hash, or a Solana-style base58 address or signature.
export function cryptoValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (CRYPTO_VALUES.has(s.toLowerCase())) return true;
  if (/^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(s)) return true;
  return /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(s) && /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

// What's wrong, for the dollars-only rule, with one property a device may be shown or may send.
export function cryptoPropertyProblem(name: string, schema: unknown, o: { usdOnly?: boolean } = {}): string | null {
  if (cryptoName(name)) return `'${name}' names a crypto concept`;
  const p = (schema && typeof schema === "object" ? schema : {}) as Record<string, unknown>;
  const values = [...(Array.isArray(p.enum) ? p.enum : []), ...("const" in p ? [p.const] : []), ...("default" in p ? [p.default] : [])];
  const bad = values.find(cryptoValue);
  if (bad !== undefined) return `'${name}' can take the value ${JSON.stringify(bad)}, a crypto asset or network`;
  // On the Mynt Ramp, a currency a device is shown or sends is US dollars.
  if (o.usdOnly && /(^|_)currency$/i.test(name)) {
    const ok = values.length > 0 && values.every((x) => x === "USD");
    if (!ok) return `'${name}' must be US dollars only (enum ["USD"] or const "USD")`;
  }
  return null;
}

export const DOLLARS_ONLY_RULE =
  "Customers see US dollars only: a device is shown amounts, fees, totals, statuses, arrival times and references, never a wallet, token, chain address, chain name or stablecoin. Keep the settlement asset in the service's output (sealed to the innovator), out of client_result and params";
