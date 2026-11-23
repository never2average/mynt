import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_KINDS_DIR } from "./app-kinds.js";
import { PROMISE_WORDS } from "./app-ideas.js";
import { HORIZONS, LIQUIDITY, RETURN_TYPES, RISK_LEVELS } from "./catalog.js";
import type { Db } from "./db.js";
import type { Store, User } from "./store.js";

// Financial product ideas: new products a licensed firm could define, offered on the Build page's Financial product
// mode as chips (each named by its short chip_label and starting the product chat with the idea) and as Templates rows (Use opens the Create product
// sheet filled in). Each is labelled by who needs it and what for, with a draft product name, a line of what it is,
// the product line and category it sits in, its region and its key features. They are rows in Postgres
// (financial_products.product_ideas, app-ideas-schema.ts), apart from app ideas: an app idea is a build on a kind
// (a goal, SDK calls, the products it picks), a product idea is the start of a product definition, and their checks
// differ (an app idea mustn't talk about investing or bonds; a product idea in the bonds category names them).
// Admins keep them with create_product_idea, update_product_idea and retire_product_idea; builders read the active
// ones with list_product_ideas. The shipped ones are in workspaces/coding-build/templates/product-ideas.seed.json,
// added only when an admin runs seed_product_ideas: never on startup, and never over a row already there.

export const PRODUCT_IDEAS_SEED_PATH = join(APP_KINDS_DIR, "..", "product-ideas.seed.json");

// Where a product idea may sit: the regions Mynt launches in, and in each the product lines and categories of the
// products running there today (Mynt is US only: deposits for CDs and money market accounts, retirement for IRAs
// and 401(k) plans, mutual funds for money market funds, bonds for TIPS).
export const PRODUCT_IDEA_SCOPES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  US: { account_operations: ["deposits"], wealth: ["retirement", "mutual_funds"], credit: ["bonds"] },
};

export const PRODUCT_IDEA_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const LABEL_MAX = 80;
// The chip's label on the Build page: short enough to sit on one line (the product name and label are its tooltip).
export const CHIP_LABEL_MAX = 34;
export const PRODUCT_NAME_MAX = 60;
export const SUMMARY_MAX = 200;
export const FEATURE_MAX = 160;
export const FEATURES_MIN = 2;
export const FEATURES_MAX = 6;

// What a product idea mustn't call the people it serves, and what it mustn't be (what no region's scope covers is
// refused by its line; these are the words that slip past a line).
export const MERCHANT_WORDS = /\b(merchants?|shopkeepers?|sellers?|storefronts?|shops?)\b/i;
const OFF_SCOPE_WORDS = /\b(loans?|lend\w*|borrow\w*|bnpl|mortgages?|insur\w*|crypto\w*|stablecoins?|tokens?|leverage\w*|margin)\b/i;
const HOSTNAME_LIKE = /\b[a-z0-9-]+\.[a-z]{2,}\b/i;

export interface ProductIdeaFields {
  id: string;
  // The chip's label on the Build page, 1 to 34 characters on one line ("Goal-locked savings pots").
  chip_label: string;
  // The label: who needs it and what for ("Gig workers with uneven pay can't lock cash away for months").
  label: string;
  // The draft product's name, which the firm edits.
  product_name: string;
  // One line: what the product is.
  summary: string;
  product_line: string;
  category: string;
  region: string;
  key_features: string[];
  // The Create product sheet's classifications, prefilled when the idea is used (the firm changes them).
  risk_level?: string | null;
  liquidity?: string | null;
  typical_horizon?: string | null;
  return_type?: string | null;
  sort?: number;
}
export interface ProductIdea extends Omit<Required<ProductIdeaFields>, "chip_label"> {
  // None on a row added before chip labels, until an admin fills it.
  chip_label: string | null;
  status: "active" | "retired";
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// Everything wrong with a product idea, in plain words (none: it's good). The same rules for an admin's edit and the seed.
export function productIdeaErrors(idea: ProductIdeaFields): string[] {
  const errors: string[] = [];
  const label = `product idea '${idea.id}'`;
  if (!PRODUCT_IDEA_ID.test(idea.id)) errors.push(`${label}: the id is 2 to 40 lowercase letters, digits and dashes, starting with a letter`);
  const line = (name: string, text: string, min: number, max: number) => {
    const t = text.trim();
    if (t.length < min || t.length > max) errors.push(`${label}: the ${name} is ${min} to ${max} characters, not ${t.length}`);
    if (/[\r\n]/.test(text)) errors.push(`${label}: the ${name} is one line`);
  };
  line("chip label", idea.chip_label ?? "", 1, CHIP_LABEL_MAX);
  line("label", idea.label, 10, LABEL_MAX);
  line("product name", idea.product_name, 3, PRODUCT_NAME_MAX);
  line("summary", idea.summary, 20, SUMMARY_MAX);
  if (idea.key_features.length < FEATURES_MIN || idea.key_features.length > FEATURES_MAX) errors.push(`${label}: ${FEATURES_MIN} to ${FEATURES_MAX} key features, not ${idea.key_features.length}`);
  idea.key_features.forEach((f, i) => line(`key feature ${i + 1}`, f, 5, FEATURE_MAX));
  if (new Set(idea.key_features.map((f) => f.trim().toLowerCase())).size !== idea.key_features.length) errors.push(`${label}: a key feature is listed twice`);

  const scope = PRODUCT_IDEA_SCOPES[idea.region];
  if (!scope) errors.push(`${label}: region '${idea.region}' isn't one Mynt launches products in (${Object.keys(PRODUCT_IDEA_SCOPES).join(", ")})`);
  else if (!scope[idea.product_line]) errors.push(`${label}: '${idea.product_line}' isn't a product line with products in ${idea.region} (${Object.keys(scope).join(", ")})`);
  else if (!scope[idea.product_line].includes(idea.category))
    errors.push(`${label}: '${idea.category}' isn't a ${idea.product_line} category with products in ${idea.region} (${scope[idea.product_line].join(", ")})`);

  for (const [name, list] of [["risk level", RISK_LEVELS], ["liquidity", LIQUIDITY], ["typical horizon", HORIZONS], ["return type", RETURN_TYPES]] as const) {
    const key = ({ "risk level": "risk_level", liquidity: "liquidity", "typical horizon": "typical_horizon", "return type": "return_type" } as const)[name];
    const v = idea[key];
    if (v != null && !(list as readonly string[]).includes(v)) errors.push(`${label}: the ${name} is one of ${list.join(", ")}, not '${v}'`);
  }

  const texts: [string, string][] = [["chip label", idea.chip_label ?? ""], ["label", idea.label], ["product name", idea.product_name], ["summary", idea.summary], ...idea.key_features.map((f, i) => [`key feature ${i + 1}`, f] as [string, string])];
  for (const [name, text] of texts) {
    const promise = text.match(PROMISE_WORDS)?.[0];
    if (promise) errors.push(`${label}: the ${name} says '${promise}', which promises, projects or advises (describe the product's terms as the firm would state them)`);
    const merchant = text.match(MERCHANT_WORDS)?.[0];
    if (merchant) errors.push(`${label}: the ${name} says '${merchant}', which frames the people it serves as sellers of goods`);
    const off = text.match(OFF_SCOPE_WORDS)?.[0];
    if (off) errors.push(`${label}: the ${name} says '${off}', which isn't in the product lines Mynt runs in ${idea.region}`);
    if (HOSTNAME_LIKE.test(text)) errors.push(`${label}: the ${name} has a web address or file name in it`);
  }
  return errors;
}

export class ProductIdeaError extends Error {}

const COLUMNS =
  "id, chip_label, label, product_name, summary, product_line, category, region, key_features, risk_level, liquidity, typical_horizon, return_type, status, sort, created_at, updated_at, created_by";
const iso = (v: unknown) => new Date(v as string).toISOString();
const toIdea = (r: Record<string, unknown>): ProductIdea => ({
  id: r.id as string,
  chip_label: (r.chip_label as string | null) ?? null,
  label: r.label as string,
  product_name: r.product_name as string,
  summary: r.summary as string,
  product_line: r.product_line as string,
  category: r.category as string,
  region: r.region as string,
  key_features: [...(r.key_features as string[])],
  risk_level: (r.risk_level as string | null) ?? null,
  liquidity: (r.liquidity as string | null) ?? null,
  typical_horizon: (r.typical_horizon as string | null) ?? null,
  return_type: (r.return_type as string | null) ?? null,
  status: r.status as ProductIdea["status"],
  sort: Number(r.sort),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
  created_by: (r.created_by as string | null) ?? null,
});
const tidy = (f: ProductIdeaFields): ProductIdeaFields => ({
  ...f,
  chip_label: (f.chip_label ?? "").trim(),
  label: f.label.trim(),
  product_name: f.product_name.trim(),
  summary: f.summary.trim(),
  key_features: f.key_features.map((k) => k.trim()),
  risk_level: f.risk_level ?? null,
  liquidity: f.liquidity ?? null,
  typical_horizon: f.typical_horizon ?? null,
  return_type: f.return_type ?? null,
  sort: f.sort ?? 0,
});
const check = (f: ProductIdeaFields) => {
  const errors = productIdeaErrors(f);
  if (errors.length) throw new ProductIdeaError(errors.join("; "));
};
const values = (f: ProductIdeaFields) => [f.chip_label, f.label, f.product_name, f.summary, f.product_line, f.category, f.region, f.key_features, f.risk_level ?? null, f.liquidity ?? null, f.typical_horizon ?? null, f.return_type ?? null, f.sort ?? 0];
const INSERT = `INSERT INTO financial_products.product_ideas (id, chip_label, label, product_name, summary, product_line, category, region, key_features, risk_level, liquidity, typical_horizon, return_type, sort, created_by)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) ON CONFLICT (id) DO NOTHING`;

// Ideas by product line, then sort, then id. Active ones unless retired ones are asked for.
export async function listProductIdeas(db: Pick<Db, "query">, opts: { productLine?: string; region?: string; includeRetired?: boolean } = {}): Promise<ProductIdea[]> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM financial_products.product_ideas
     WHERE ($1::text IS NULL OR product_line = $1) AND ($2::text IS NULL OR region = $2) AND ($3::boolean OR status = 'active')
     ORDER BY product_line, sort, id`,
    [opts.productLine ?? null, opts.region ?? null, opts.includeRetired ?? false],
  );
  return rows.map(toIdea);
}

export async function getProductIdea(db: Pick<Db, "query">, id: string): Promise<ProductIdea | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM financial_products.product_ideas WHERE id = $1`, [id]);
  return rows[0] ? toIdea(rows[0]) : null;
}

export async function createProductIdea(db: Pick<Db, "query">, fields: ProductIdeaFields, actorId: string | null): Promise<ProductIdea> {
  const f = tidy(fields);
  check(f);
  const { rows } = await db.query(`${INSERT} RETURNING ${COLUMNS}`, [f.id, ...values(f), actorId]);
  if (!rows[0]) throw new ProductIdeaError(`There's already a product idea '${f.id}'; change it with update_product_idea`);
  return toIdea(rows[0]);
}

export type ProductIdeaPatch = Partial<Omit<ProductIdeaFields, "id">> & { status?: ProductIdea["status"] };

// Changes some fields; the idea as it would then be is checked whole.
export async function updateProductIdea(db: Pick<Db, "query">, id: string, patch: ProductIdeaPatch): Promise<ProductIdea> {
  const current = await getProductIdea(db, id);
  if (!current) throw new ProductIdeaError(`No product idea '${id}'; list_product_ideas lists them`);
  const next = tidy({ ...current, chip_label: current.chip_label ?? "", ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), id });
  check(next);
  const { rows } = await db.query(
    `UPDATE financial_products.product_ideas SET chip_label = $2, label = $3, product_name = $4, summary = $5, product_line = $6, category = $7, region = $8, key_features = $9,
       risk_level = $10, liquidity = $11, typical_horizon = $12, return_type = $13, sort = $14, status = $15, updated_at = now()
     WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, ...values(next), patch.status ?? current.status],
  );
  return toIdea(rows[0]);
}

export async function retireProductIdea(db: Pick<Db, "query">, id: string): Promise<ProductIdea> {
  const { rows } = await db.query(`UPDATE financial_products.product_ideas SET status = 'retired', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`, [id]);
  if (!rows[0]) throw new ProductIdeaError(`No product idea '${id}'; list_product_ideas lists them`);
  return toIdea(rows[0]);
}

// The shipped product ideas, every one checked: a bad one is a bug in the repository, so it throws.
export function seedProductIdeas(path = PRODUCT_IDEAS_SEED_PATH): ProductIdeaFields[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as { ideas?: ProductIdeaFields[] };
  const ideas = (data.ideas ?? []).map(tidy);
  const errors = ideas.flatMap((i) => productIdeaErrors(i));
  const ids = ideas.map((i) => i.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) errors.push(`product idea '${id}' is in the seed twice`);
  if (errors.length) throw new Error(`Bad product idea seed: ${errors.join("; ")}`);
  return ideas;
}

// Adds the shipped product ideas that aren't there yet. One that is (edited, retired or untouched) is left as it is.
export async function addProductIdeas(db: Pick<Db, "query">, actorId: string | null, ideas: ProductIdeaFields[] = seedProductIdeas()): Promise<{ inserted: string[]; kept: string[] }> {
  const inserted: string[] = [];
  const kept: string[] = [];
  for (const f of ideas) {
    const { rows } = await db.query(`${INSERT} RETURNING id`, [f.id, ...values(f), actorId]);
    (rows.length ? inserted : kept).push(f.id);
  }
  return { inserted, kept };
}

// Fills in the chip label of product ideas already there that have none (rows added before chip labels), from
// `ideas` (the shipped set by default). Nothing else changes, and a label already there, an admin's or the seed's,
// is never overwritten. Ids in `ideas` with no row are reported as missing, not added.
export async function fillProductIdeaChipLabels(
  db: Pick<Db, "query">,
  ideas: ProductIdeaFields[] = seedProductIdeas(),
): Promise<{ filled: string[]; kept: string[]; missing: string[] }> {
  const filled: string[] = [];
  const kept: string[] = [];
  const missing: string[] = [];
  for (const f of ideas) {
    const chip = (f.chip_label ?? "").trim();
    if (!chip || chip.length > CHIP_LABEL_MAX || /[\r\n]/.test(chip)) throw new ProductIdeaError(`product idea '${f.id}': the chip label is 1 to ${CHIP_LABEL_MAX} characters on one line`);
    const { rows } = await db.query(
      `UPDATE financial_products.product_ideas SET chip_label = $2, updated_at = now() WHERE id = $1 AND chip_label IS NULL RETURNING id`,
      [f.id, chip],
    );
    if (rows.length) filled.push(f.id);
    else ((await getProductIdea(db, f.id)) ? kept : missing).push(f.id);
  }
  return { filled, kept, missing };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const forBuilder = ({ id, chip_label, label, product_name, summary, product_line, category, region, key_features, risk_level, liquidity, typical_horizon, return_type }: ProductIdea) => ({
  id,
  chip_label,
  label,
  product_name,
  summary,
  product_line,
  category,
  region,
  key_features,
  risk_level,
  liquidity,
  typical_horizon,
  return_type,
});
const refusal = (e: unknown) => {
  if (e instanceof ProductIdeaError) return fail(e.message);
  throw e;
};

const lines = Object.keys(Object.assign({}, ...Object.values(PRODUCT_IDEA_SCOPES))) as [string, ...string[]];
const fields = {
  chip_label: z
    .string()
    .min(1)
    .max(CHIP_LABEL_MAX)
    .describe("The chip's label on the Build page: 1 to 34 characters on one line, plain words, usually a shortened product name (\"Goal-locked savings pots\"). The product name and label are the chip's tooltip"),
  label: z.string().min(10).max(LABEL_MAX).describe("The label: who needs the product and what for, in plain words (\"Gig workers with uneven pay can't lock cash away for months\")"),
  product_name: z.string().min(3).max(PRODUCT_NAME_MAX).describe("A draft name for the product, which the firm edits"),
  summary: z.string().min(20).max(SUMMARY_MAX).describe("One line: what the product is, factually"),
  product_line: z.enum(lines).describe("A product line with products in the region"),
  category: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/).describe("A category in that line with products in the region (deposits, retirement, mutual_funds, bonds)"),
  region: z.enum(Object.keys(PRODUCT_IDEA_SCOPES) as [string, ...string[]]).describe("The region Mynt launches products in"),
  key_features: z.array(z.string().min(5).max(FEATURE_MAX)).min(FEATURES_MIN).max(FEATURES_MAX).describe("The product's key features, each one line, stated as terms the firm sets"),
  risk_level: z.enum(RISK_LEVELS).optional().describe("Optional: prefilled in the Create product sheet"),
  liquidity: z.enum(LIQUIDITY).optional().describe("Optional: prefilled in the Create product sheet"),
  typical_horizon: z.enum(HORIZONS).optional().describe("Optional: prefilled in the Create product sheet"),
  return_type: z.enum(RETURN_TYPES).optional().describe("Optional: prefilled in the Create product sheet"),
  sort: z.number().int().min(0).max(100000).optional().describe("Order within the product line, lowest first (default 0)"),
};

export function registerProductIdeaTools(server: McpServer, store: Store, opts: { admin?: boolean } = {}) {
  server.registerTool(
    "list_product_ideas",
    {
      title: "Financial product ideas",
      description:
        "Builder: ideas for new financial products a licensed firm could define, offered on the Build page's Financial product mode. Each has a short chip_label (at most 34 characters, what the Build page's chip shows; null on an idea added before chip labels until an admin fills it), a label (who needs it and what for), a draft product name, a one-line summary, the product line, category and region it sits in, its key features and, optionally, the Create product sheet's risk level, liquidity, typical horizon and return type. They are starting points to edit, not products: create_product defines one. Only active ideas, unless an admin passes include_retired.",
      inputSchema: {
        product_line: fields.product_line.optional().describe("Only this product line's ideas"),
        include_retired: z.boolean().optional().describe("Admins only: retired ideas too, with each idea's status and history"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ product_line, include_retired }) => {
      const all = Boolean(opts.admin && include_retired);
      const ideas = await listProductIdeas(store.db, { productLine: product_line, includeRetired: all });
      return json({
        ideas: all ? ideas : ideas.map(forBuilder),
        ...(ideas.length ? {} : { note: product_line ? `No product ideas in ${product_line} yet` : "No product ideas yet: an admin adds them with seed_product_ideas or create_product_idea" }),
      });
    },
  );
}

export function registerProductIdeaAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "create_product_idea",
    {
      title: "Add a financial product idea",
      description:
        "Admin: add an idea for a new financial product, offered in the Build page's Financial product mode, with a chip_label of 1 to 34 characters for its chip. Refused if its region, product line or category has no products Mynt runs there (US: account_operations/deposits, wealth/retirement, wealth/mutual_funds, credit/bonds), if any text promises, projects or advises (earnings, yields, returns, a percentage, guarantees, 'risk-free', beating inflation, recommendations, advice), frames the people it serves as sellers of goods, or is about lending, insurance or crypto.",
      inputSchema: { id: z.string().regex(PRODUCT_IDEA_ID).describe("A short slug, unique across product ideas"), ...fields },
    },
    async (args) => {
      try {
        const idea = await createProductIdea(store.db, args, user.id);
        await store.audit(user.id, "create_product_idea", idea.id, { product_line: idea.product_line, category: idea.category, label: idea.label });
        return json({ idea });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "update_product_idea",
    {
      title: "Change a financial product idea",
      description:
        "Admin: change some of a product idea's fields (the ones you leave out stay). The idea as it would then be is checked whole, as create_product_idea checks it, so an idea added before chip labels needs a chip_label to change anything else. status 'active' brings back a retired idea.",
      inputSchema: {
        id: z.string().regex(PRODUCT_IDEA_ID),
        chip_label: fields.chip_label.optional(),
        label: fields.label.optional(),
        product_name: fields.product_name.optional(),
        summary: fields.summary.optional(),
        product_line: fields.product_line.optional(),
        category: fields.category.optional(),
        region: fields.region.optional(),
        key_features: fields.key_features.optional(),
        risk_level: fields.risk_level,
        liquidity: fields.liquidity,
        typical_horizon: fields.typical_horizon,
        return_type: fields.return_type,
        sort: fields.sort,
        status: z.enum(["active", "retired"]).optional(),
      },
    },
    async ({ id, ...patch }) => {
      try {
        const before = await getProductIdea(store.db, id);
        const idea = await updateProductIdea(store.db, id, patch);
        await store.audit(user.id, "update_product_idea", id, {
          changed: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined),
          before: before && forBuilder(before),
        });
        return json({ idea });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "retire_product_idea",
    {
      title: "Retire a financial product idea",
      description: "Admin: stop offering a product idea. The row stays (update_product_idea with status 'active' brings it back).",
      inputSchema: { id: z.string().regex(PRODUCT_IDEA_ID) },
    },
    async ({ id }) => {
      try {
        const idea = await retireProductIdea(store.db, id);
        await store.audit(user.id, "retire_product_idea", id, {});
        return json({ idea });
      } catch (e) {
        return refusal(e);
      }
    },
  );

  server.registerTool(
    "seed_product_ideas",
    {
      title: "Add Mynt's shipped financial product ideas",
      description:
        "Admin: add the financial product ideas that ship with Mynt (workspaces/coding-build/templates/product-ideas.seed.json) that aren't in the database yet. Safe to run again: an idea already there, edited or retired, is never overwritten. With labels_only: true, nothing is added: each shipped idea already in the database that has no chip_label gets the seed's (filled), one that has a chip_label keeps it (kept), and ids not in the database are listed (missing). Mynt never does this on its own.",
      inputSchema: {
        labels_only: z.boolean().optional().describe("Only fill in the seed's chip_label on its ideas already there that have none; adds and changes nothing else"),
      },
    },
    async ({ labels_only }) => {
      if (labels_only) {
        const filled = await fillProductIdeaChipLabels(store.db);
        await store.audit(user.id, "seed_product_ideas", "product_ideas", { labels_only: true, ...filled });
        return json(filled);
      }
      const result = await addProductIdeas(store.db, user.id);
      await store.audit(user.id, "seed_product_ideas", "product_ideas", { inserted: result.inserted, kept: result.kept.length });
      return json(result);
    },
  );
}
