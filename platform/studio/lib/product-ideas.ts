import { HORIZONS, LIQUIDITY, PRODUCT_LINES, RETURN_TYPES, RISK_LEVELS, slugFromName, type NewProductRequest } from "./products";
import { seeded } from "./new-app";

// The Build page's Financial product mode offers ideas for new financial products a licensed firm could define,
// from Mynt's database (list_product_ideas): each with the problem it answers (its label), a draft product name,
// a line of what it is, its product line, category and region, and its key features. They are chips under the
// product chat's welcome, named by the short chip label (at most 34 characters) with the product name and the
// problem as the tooltip (a chip starts the chat with the idea as the first message), and the Templates tab's rows
// in that mode (Use opens the Create product sheet filled with the idea). App ideas (lib/new-app.ts) stay in App
// mode. Pure, so the route, the page and the tests share it.

export type ProductIdea = {
  id: string;
  // The chip's short label (Mynt's chip_label); none on an idea added before chip labels.
  chipLabel?: string;
  label: string;
  productName: string;
  summary: string;
  productLine: string;
  category: string;
  region: string;
  keyFeatures: string[];
  riskLevel?: string;
  liquidity?: string;
  typicalHorizon?: string;
  returnType?: string;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : []);
const ID = /^[a-z][a-z0-9-]{1,39}$/;
const oneOf = <T extends readonly string[]>(list: T, v: unknown) => ((list as readonly string[]).includes(str(v)) ? str(v) : undefined);

// Ideas from Mynt's shape (snake_case) or the studio's own (camelCase); one without an id, label, name or a real
// product line is dropped, and a classification Mynt doesn't list is left out.
function ideaFrom(e: Obj): ProductIdea | null {
  const id = str(e.id);
  const label = str(e.label).trim();
  const productName = str(e.product_name ?? e.productName).trim();
  const productLine = str(e.product_line ?? e.productLine);
  if (!ID.test(id) || !label || !productName || !(PRODUCT_LINES as readonly string[]).includes(productLine)) return null;
  const riskLevel = oneOf(RISK_LEVELS, e.risk_level ?? e.riskLevel);
  const liquidity = oneOf(LIQUIDITY, e.liquidity);
  const typicalHorizon = oneOf(HORIZONS, e.typical_horizon ?? e.typicalHorizon);
  const returnType = oneOf(RETURN_TYPES, e.return_type ?? e.returnType);
  const chipLabel = str(e.chip_label ?? e.chipLabel).trim();
  return {
    id,
    ...(chipLabel ? { chipLabel } : {}),
    label,
    productName,
    summary: str(e.summary).trim(),
    productLine,
    category: str(e.category),
    region: str(e.region),
    keyFeatures: strings(e.key_features ?? e.keyFeatures),
    ...(riskLevel ? { riskLevel } : {}),
    ...(liquidity ? { liquidity } : {}),
    ...(typicalHorizon ? { typicalHorizon } : {}),
    ...(returnType ? { returnType } : {}),
  };
}

// list_product_ideas' reply (null when this Mynt hasn't the tool): its ideas, in Mynt's order.
export function productIdeasFrom(reply: unknown): ProductIdea[] {
  const list = isObj(reply) && Array.isArray(reply.ideas) ? reply.ideas : [];
  return list.filter(isObj).map(ideaFrom).filter((i): i is ProductIdea => i !== null);
}

// /api/app-kinds' productIdeas (the studio's shape), as the page reads it: anything else is none.
export function productIdeasFromRoute(data: unknown): ProductIdea[] {
  return productIdeasFrom(isObj(data) ? { ideas: data.productIdeas } : null);
}

// The chips: a few ideas picked by a seed (one per page load), one from each product line first so every line
// shows, then others.
export const PRODUCT_CHIPS_MAX = 6;
export function chipProductIdeas(ideas: readonly ProductIdea[], seed: number, max = PRODUCT_CHIPS_MAX): ProductIdea[] {
  const rand = seeded(seed);
  const shuffle = <T,>(xs: readonly T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const lines = shuffle([...new Set(ideas.map((i) => i.productLine))]);
  const firsts = lines.map((l) => shuffle(ideas.filter((i) => i.productLine === l))[0]);
  const taken = new Set(firsts.map((i) => i.id));
  return [...firsts, ...shuffle(ideas.filter((i) => !taken.has(i.id)))].slice(0, max);
}

// A chip's first message to the product assistant: the idea in plain words (its name, the problem it answers,
// what it is, where, its features), for it to ask what's missing.
export function productIdeaMessage(idea: ProductIdea): string {
  const where = [idea.region, idea.productLine.replace(/_/g, " "), idea.category.replace(/_/g, " ")].filter(Boolean).join(", ");
  const features = idea.keyFeatures.length ? `\nKey features:\n${idea.keyFeatures.map((f) => `- ${f}`).join("\n")}` : "";
  const problem = idea.label.replace(/[.\s]+$/, "");
  const summary = idea.summary ? ` ${idea.summary}` : "";
  return `Help me define ${idea.productName}.${summary}\nThe problem it answers: ${problem}.\nWhere: ${where}.${features}`;
}

// What Use fills the Create product sheet with: the idea's name, line, category, region, summary as the
// description, key features and classifications. The regulator is left for the firm to pick; issuance by default.
export type ProductPrefill = Partial<NewProductRequest>;
export function productIdeaPrefill(idea: ProductIdea): ProductPrefill {
  return {
    id: slugFromName(idea.productName),
    name: idea.productName,
    product_line: idea.productLine as NewProductRequest["product_line"],
    category: idea.category,
    region: idea.region,
    action: "issuance",
    underlying_product_ids: [],
    description: idea.summary,
    key_features: idea.keyFeatures,
    ...(idea.riskLevel ? { risk_level: idea.riskLevel as NewProductRequest["risk_level"] } : {}),
    ...(idea.liquidity ? { liquidity: idea.liquidity as NewProductRequest["liquidity"] } : {}),
    ...(idea.typicalHorizon ? { typical_horizon: idea.typicalHorizon as NewProductRequest["typical_horizon"] } : {}),
    ...(idea.returnType ? { return_type: idea.returnType as NewProductRequest["return_type"] } : {}),
  };
}
