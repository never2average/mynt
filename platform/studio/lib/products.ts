import { z } from "zod";

// New app's products: the ones the user may build on (list_buildable_products) and their own
// (list_my_products), each with the countries it's offered in, shown as flags; and the Create product
// sheet's request (create_product), then Test (test_product) and Publish (publish_product). Pure, so
// the routes, the page and the tests share it.

// ---- flags ----

// Codes that look like countries but have no flag of their own: user-assigned (AA, QM-QZ, XA-XZ, ZZ)
// and Eurozone. UK is the United Kingdom's common name for GB.
const NO_FLAG = /^(AA|Q[M-Z]|X[A-Z]|ZZ|EZ)$/;
const ALIASES: Record<string, string> = { UK: "GB" };
const names = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

// The ISO 3166-1 alpha-2 country a jurisdiction names ("US", "us", or a state such as "us-ny"),
// when it's a country with a flag; null for anything else ("global", unknown or reserved codes).
export function countryOf(jurisdiction: string): string | null {
  const m = /^([A-Za-z]{2})(?:-[A-Za-z0-9]{1,3})?$/.exec(jurisdiction.trim());
  if (!m) return null;
  const upper = m[1].toUpperCase();
  const code = ALIASES[upper] ?? upper;
  if (NO_FLAG.test(code)) return null;
  // Only codes the platform knows as a region: an unassigned pair would draw two letters, not a flag.
  const name = names?.of(code);
  return name && name !== code ? code : null;
}

// A country's flag: its two letters as regional indicator symbols (A is U+1F1E6).
export const flagEmoji = (code: string) => String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

export type Flag = { code: string; emoji: string; name: string };
// Each country of a product's jurisdictions once, in order; unknown ones are left out.
export function flagsFor(jurisdictions: readonly string[]): Flag[] {
  const out: Flag[] = [];
  for (const j of jurisdictions) {
    const code = countryOf(j);
    if (code && !out.some((f) => f.code === code)) out.push({ code, emoji: flagEmoji(code), name: names?.of(code) ?? code });
  }
  return out;
}

// ---- the products the page lists ----

export type ProductStatus = "published" | "draft" | "unpublished";
export type StudioProduct = {
  id: string;
  name: string;
  productLine: string;
  // Its category within the line (deposits, retirement, ...), when Mynt gives one: New app's ideas pick by it.
  category?: string;
  by: string;
  accessMode: string;
  // Where it's offered, as Mynt gives it: its region (a country code, or "global"), and the states or
  // countries it lists when it has several.
  jurisdictions?: string[];
  // Published unless Mynt says otherwise; only the user's own products can be anything else.
  status?: ProductStatus;
  // The user's own product (Test and Publish are theirs).
  mine?: boolean;
  lastTestPassed?: boolean | null;
};

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : []);
const isObj = (p: unknown): p is Obj => typeof p === "object" && p !== null && typeof (p as Obj).id === "string";
function jurisdictionsOf(p: Obj): string[] {
  const listed = [...strings(p.jurisdictions), ...strings(p.offered_in), ...strings(p.regions)];
  const region = str(p.region).trim();
  return [...new Set(region ? [region, ...listed] : listed)];
}
const statusOf = (v: unknown): ProductStatus => (v === "draft" || v === "unpublished" ? v : "published");

// list_buildable_products' products, then the user's own that aren't published (drafts can't be built
// on yet; their published ones are already in the first list).
export function productsFrom(buildable: unknown, mine: unknown = []): StudioProduct[] {
  const out: StudioProduct[] = (Array.isArray(buildable) ? buildable : []).filter(isObj).map((p) => ({
    id: str(p.id),
    name: str(p.name) || str(p.id),
    productLine: str(p.product_line),
    ...(str(p.category) ? { category: str(p.category) } : {}),
    by: str(p.by),
    accessMode: str(p.access_mode),
    jurisdictions: jurisdictionsOf(p),
    status: "published",
  }));
  for (const p of (Array.isArray(mine) ? mine : []).filter(isObj)) {
    const status = statusOf(p.status);
    if (status === "published" || out.some((o) => o.id === p.id)) continue;
    out.push({
      id: str(p.id),
      name: str(p.name) || str(p.id),
      productLine: str(p.product_line),
      ...(str(p.category) ? { category: str(p.category) } : {}),
      by: "You",
      accessMode: "",
      jurisdictions: jurisdictionsOf(p),
      status,
      mine: true,
      lastTestPassed: typeof p.last_test_passed === "boolean" ? p.last_test_passed : null,
    });
  }
  return out;
}

export const isPickable = (p: Pick<StudioProduct, "status">) => (p.status ?? "published") === "published";
export const NOT_PUBLISHED = "Publish this product before building on it.";
export const STATUS_LABEL: Record<ProductStatus, string> = { published: "Published", draft: "Draft", unpublished: "Unpublished" };

// ---- Create product ----

// create_product's choices, as Mynt's catalog defines them (core/src/catalog.ts, core/src/store.ts).
export const PRODUCT_LINES = ["credit", "securitization", "payments", "account_operations", "custody_settlement", "wealth", "insurance", "guarantees_trade", "exchange", "derivatives", "information"] as const;
export const PRODUCT_ACTIONS = ["issuance", "sale", "repackaging"] as const;
export const RISK_LEVELS = ["low", "moderate", "high", "very_high", "not_applicable"] as const;
export const LIQUIDITY = ["high", "moderate", "low", "none", "not_applicable"] as const;
export const HORIZONS = ["short", "short_to_medium", "medium", "medium_to_long", "long"] as const;
export const RETURN_TYPES = ["fixed_interest", "variable_interest", "market_linked", "inflation_linked", "guaranteed_income", "guaranteed_plus_bonus", "protection", "cost_of_credit"] as const;

// The id's rule, as create_product checks it.
export const PRODUCT_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_HINT = "Use a lowercase slug like 'green-fd'";
export const slugFromName = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");

const text = (max: number) => z.string().trim().min(1).max(max);
export const ProductId = z.string().max(80).regex(PRODUCT_SLUG, SLUG_HINT);
// What Create product sends (POST /api/products), and the studio passes on to create_product.
export const NewProductRequest = z
  .object({
    id: ProductId,
    name: text(200),
    product_line: z.enum(PRODUCT_LINES),
    category: text(120),
    region: z.string().trim().regex(/^([A-Za-z]{2}|global)$/, "A country code such as US, or global"),
    action: z.enum(PRODUCT_ACTIONS),
    underlying_product_ids: z.array(z.string().trim().min(1).max(200)).max(20),
    risk_level: z.enum(RISK_LEVELS),
    liquidity: z.enum(LIQUIDITY),
    typical_horizon: z.enum(HORIZONS),
    return_type: z.enum(RETURN_TYPES),
    regulator: text(200),
    description: text(4000),
    key_features: z.array(text(500)).max(20),
  })
  .strict()
  .refine((r) => r.action === "issuance" || r.underlying_product_ids.length > 0, { message: "Pick the products this one sells or repackages.", path: ["underlying_product_ids"] });
export type NewProductRequest = z.infer<typeof NewProductRequest>;

// Test or Publish (POST /api/products/<id>).
export const ProductActionRequest = z.object({ action: z.enum(["test", "publish"]) }).strict();
export type ProductAction = z.infer<typeof ProductActionRequest>["action"];

// Mynt's regions and categories, for the sheet's choices (GET /api/products/options).
export type Region = { code: string; name: string; regulators: string[] };
export type Category = { id: string; name: string; productLines: string[] };
export function optionsFrom(regions: unknown, categories: unknown): { regions: Region[]; categories: Category[] } {
  return {
    regions: (Array.isArray(regions) ? regions : [])
      .filter((r): r is Obj => typeof r === "object" && r !== null && typeof (r as Obj).code === "string")
      .map((r) => ({ code: str(r.code), name: str(r.name) || str(r.code), regulators: strings(r.regulators) })),
    categories: (Array.isArray(categories) ? categories : [])
      .filter(isObj)
      .map((c) => ({ id: str(c.id), name: str(c.name) || str(c.id), productLines: strings(c.product_lines) })),
  };
}

// test_product's report, as a line to show: passed, or the failing checks in Mynt's words.
export function testSummary(report: unknown): { passed: boolean; message: string } {
  const r = (report ?? {}) as { passed?: unknown; checks?: unknown };
  const checks = Array.isArray(r.checks) ? (r.checks as Obj[]) : [];
  const failing = checks.filter((c) => c && c.status === "fail").map((c) => str(c.message)).filter(Boolean);
  const passed = r.passed === true && !failing.length;
  return { passed, message: passed ? "Tests passed. You can publish it." : failing.length ? `Tests failed: ${failing.join("; ")}` : "Tests failed." };
}

// The sheet's and the rows' calls to the studio: an error to show, or what Mynt answered.
type Result<T> = { ok: true; data: T } | { ok: false; message: string };
async function post<T>(fetcher: typeof fetch, url: string, body: unknown, fallback: string): Promise<Result<T>> {
  let res: Response;
  try {
    res = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, message: "Couldn't reach the studio. Check your connection." };
  }
  const data = (await res.json().catch(() => null)) as (T & { message?: unknown }) | null;
  if (!res.ok) return { ok: false, message: typeof data?.message === "string" && data.message ? data.message : fallback };
  return { ok: true, data: data as T };
}
export const createProduct = (request: NewProductRequest, fetcher: typeof fetch = fetch) =>
  post<{ product: StudioProduct }>(fetcher, "/api/products", request, "Couldn't create the product. Please try again.");
export const runProductAction = (id: string, action: ProductAction, fetcher: typeof fetch = fetch) =>
  post<{ passed?: boolean; message?: string; product?: StudioProduct }>(fetcher, `/api/products/${encodeURIComponent(id)}`, { action }, action === "test" ? "Couldn't test the product. Please try again." : "Couldn't publish the product. Please try again.");
