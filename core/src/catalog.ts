import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Product lines group products by economic function, not asset class: what the product does for
// the person or firm using it. A product spanning functions is a composition of primitives (see
// regime.ts): a cross-border transfer is an exchange primitive plus a payments primitive.
export const PRODUCT_LINES = [
  "credit", // lending and debt instruments, issued or bought: loans, bonds, T-bills, commercial paper, leasing
  "securitization", // pooling assets into securities: PTC/ABS/MBS, direct assignment, co-lending pools, REIT/InvIT units, asset reconstruction
  "payments", // moving money: acceptance, payouts, mandates, wallets, remittances, CBDC
  "account_operations", // holding and running money: deposits, savings/current/term/recurring, sweep, money-market accounts, CDs, cash management
  "custody_settlement", // safekeeping and settlement: custody, depositories, clearing/CCPs, escrow, trustees, vaults
  "wealth", // investment exposure: funds, ETFs, equities, PMS/AIF, REIT/InvIT units bought, government savings schemes, retirement products
  "insurance",
  "guarantees_trade", // bank guarantees, LCs, surety, credit/deposit guarantee schemes, factoring, supply-chain and export finance
  "exchange", // currency conversion, securities trading and execution, commodities and bullion trading, digital assets
  "derivatives", // forwards, swaps, futures, options
  "information", // credit bureaus, account aggregators, ratings, KYC registries, market data
] as const;
export type ProductLine = (typeof PRODUCT_LINES)[number];

// What a regulated primitive is made of. Commodities are an underlying, not a line.
export const UNDERLYINGS = ["cash", "securities", "commodities", "real_assets", "receivables", "risk", "data", "digital_assets"] as const;
export type Underlying = (typeof UNDERLYINGS)[number];

// A statutory or tax structure around a primitive: retirement is wealth plus a wrapper, not a line.
export const WRAPPERS = ["statutory_pension", "tax_advantaged", "government_scheme"] as const;
export type Wrapper = (typeof WRAPPERS)[number];

// The four lines Mynt started with, which stored products may still carry, and what each became.
// treasury is split by category; anything not listed there holds or runs money.
const TREASURY_BY_CATEGORY: Record<string, ProductLine> = {
  deposits: "account_operations",
  bonds: "credit",
  money_market: "credit",
  derivatives: "derivatives",
  mutual_funds: "wealth",
};
const SECURITIZED_UNITS = ["reit", "invit"];

// The line a stored product belongs to now. Lines already in PRODUCT_LINES are kept, except REIT and
// InvIT units still filed under wealth, which are securitization.
export function currentLine(product: Pick<FinancialProduct, "id" | "category"> & { product_line: string }): ProductLine {
  const line = product.product_line;
  if (line === "wealth" && SECURITIZED_UNITS.includes(product.id)) return "securitization";
  if (line === "retirement") return "wealth";
  if (line === "treasury") return lineForTreasuryCategory(product.category);
  return line as ProductLine;
}

// What an old treasury category became.
export function lineForTreasuryCategory(category: string): ProductLine {
  return TREASURY_BY_CATEGORY[category] ?? "account_operations";
}

export const RISK_LEVELS =["low", "moderate", "high", "very_high", "not_applicable"] as const;
export const LIQUIDITY = ["high", "moderate", "low", "none", "not_applicable"] as const;
export const HORIZONS = ["short", "short_to_medium", "medium", "medium_to_long", "long"] as const;
export const RETURN_TYPES = [
  "fixed_interest",
  "variable_interest",
  "market_linked",
  "inflation_linked",
  "guaranteed_income",
  "guaranteed_plus_bonus",
  "protection",
  "cost_of_credit",
] as const;

export interface FinancialProduct {
  id: string;
  name: string;
  product_line: ProductLine;
  category: string;
  region: string;
  risk_level: string;
  liquidity: string;
  typical_horizon: string;
  return_type: string;
  regulator: string;
  description: string;
  key_features: string[];
}

export interface ProductFilter {
  product_line?: string;
  category?: string;
  region?: string;
  risk_level?: string;
  query?: string;
}

export function filterProducts(products: FinancialProduct[], f: ProductFilter): FinancialProduct[] {
  const eq = (a: string, b?: string) => !b || a.toLowerCase() === b.toLowerCase();
  const q = f.query?.toLowerCase();
  return products.filter(
    (p) =>
      eq(p.product_line, f.product_line) &&
      eq(p.category, f.category) &&
      // "global" products apply in every region
      (!f.region || eq(p.region, f.region) || p.region === "global") &&
      eq(p.risk_level, f.risk_level) &&
      (!q || [p.name, p.description, ...p.key_features].some((s) => s.toLowerCase().includes(q))),
  );
}

export function countBy(products: FinancialProduct[], key: keyof FinancialProduct): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of products) out[String(p[key])] = (out[String(p[key])] ?? 0) + 1;
  return out;
}
