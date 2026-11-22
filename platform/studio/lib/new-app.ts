import { z } from "zod";
import { appKindId } from "./studio-tools";

// New app: what the user typed ("What do you want to build?") and the products they picked
// become a draft Mynt app (create_app) and its first build (start_build). Pure, so the route,
// the page and the tests share it.

export const NewAppRequest = z
  .object({
    prompt: z.string().trim().min(10, "Say a little more about what to build (at least 10 characters).").max(4000),
    product_ids: z.array(z.string().trim().min(1).max(200)).min(1, "Pick at least one product to build on.").max(20),
    // The app kind it starts from (a template on New app), passed to start_build where Mynt takes one.
    kind: appKindId.optional(),
  })
  .strict();
export type NewAppRequest = z.infer<typeof NewAppRequest>;

// The composer's reason it can't send yet: the same rules as NewAppRequest, said before sending.
// (Nothing typed yet isn't a reason: the composer's Send waits for text anyway.)
export const NO_PRODUCTS = "Pick at least one product to build on.";
export const TOO_SHORT = "Say a little more about what to build (at least 10 characters).";
export function sendBlockedReason(productIds: readonly string[], text = ""): string | null {
  if (!productIds.length) return NO_PRODUCTS;
  const typed = text.trim().length;
  return typed > 0 && typed < 10 ? TOO_SHORT : null;
}

// Mynt's app kinds (list_app_kinds): starting points for common finance apps, offered on New app's
// Templates tab and as slash commands. The specific app ideas on them come from Mynt's database
// (list_app_ideas): each is labelled by the problem it solves, with a one-line pitch saying what the app does
// about it. New app offers them as chips under the welcome and as the Templates tab's rows.
// An idea or a kind may narrow its lines to some product categories (deposits, retirement, ...), and an idea to
// words from its products' names ("Money Market Account"): what's picked when it's used.
export type AppIdea = { id: string; problem: string; pitch: string; goal: string; productLines: string[]; categories?: string[]; productNames?: string[] };
export type AppKind = { id: string; title: string; description: string; productLines: string[]; categories?: string[]; goalTemplate: string; ideas: AppIdea[] };
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((l): l is string => typeof l === "string") : []);
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

// Ideas, from Mynt's shape (product_lines) or the studio's (productLines). An idea without its own lines builds on
// its kind's; one naming a line the kind doesn't have is dropped.
function ideasFrom(list: unknown, kindLines: readonly string[]): AppIdea[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is Obj => isObj(e) && appKindId.safeParse(e.id).success && str(e.problem).length > 0 && str(e.goal).length > 0)
    .map((e) => {
      const own = strings(e.product_lines ?? e.productLines);
      const categories = strings(e.categories);
      const productNames = strings(e.product_names ?? e.productNames);
      return {
        id: str(e.id),
        problem: str(e.problem),
        pitch: str(e.pitch),
        goal: str(e.goal),
        productLines: own.length ? own : [...kindLines],
        ...(categories.length ? { categories } : {}),
        ...(productNames.length ? { productNames } : {}),
      };
    })
    .filter((e) => e.productLines.every((l) => kindLines.includes(l)));
}

// The route's answer from Mynt's two replies: list_app_kinds, and list_app_ideas (null when this Mynt hasn't the
// tool), each idea under the kind it names, in Mynt's order.
export function appKindsFrom(kindsReply: unknown, ideasReply: unknown = null): AppKind[] {
  const list = isObj(kindsReply) && Array.isArray(kindsReply.kinds) ? (kindsReply.kinds as unknown[]) : [];
  const ideas = isObj(ideasReply) && Array.isArray(ideasReply.ideas) ? (ideasReply.ideas as unknown[]).filter(isObj) : [];
  return list
    .filter((k): k is Obj => isObj(k) && appKindId.safeParse(k.id).success && typeof k.goal_template === "string")
    .map((k) => {
      const productLines = strings(k.product_lines);
      const categories = strings(k.categories);
      return {
        id: str(k.id),
        title: str(k.title) || str(k.id),
        description: str(k.description),
        productLines,
        ...(categories.length ? { categories } : {}),
        goalTemplate: str(k.goal_template),
        ideas: ideasFrom(ideas.filter((i) => i.kind === k.id), productLines),
      };
    });
}

// /api/app-kinds' answer (the studio's shape), as the page reads it: anything else is no templates.
export function kindsFromRoute(data: unknown): AppKind[] {
  const list = isObj(data) && Array.isArray(data.kinds) ? (data.kinds as unknown[]) : [];
  return list
    .filter((k): k is Obj => isObj(k) && appKindId.safeParse(k.id).success && typeof k.title === "string" && typeof k.goalTemplate === "string" && Array.isArray(k.productLines))
    .map((k) => {
      const productLines = strings(k.productLines);
      const categories = strings(k.categories);
      return { id: str(k.id), title: str(k.title), description: str(k.description), productLines, ...(categories.length ? { categories } : {}), goalTemplate: str(k.goalTemplate), ideas: ideasFrom(k.ideas, productLines) };
    });
}

// Every idea with the kind it builds on, grouped by kind in the kinds' order. A kind without ideas is one
// idea itself (its title as the label, its description and goal), so it can still be used.
export type KindIdea = { kind: AppKind; idea: AppIdea };
export function kindIdeas(kinds: readonly AppKind[]): KindIdea[] {
  return kinds.flatMap((kind) =>
    (kind.ideas.length ? kind.ideas : [kindAsIdea(kind)]).map((idea) => ({ kind, idea })),
  );
}

// A kind used as an idea: its title as the label, its description, goal, lines and categories.
export const kindAsIdea = (kind: AppKind): AppIdea => ({
  id: kind.id,
  problem: kind.title,
  pitch: kind.description,
  goal: kind.goalTemplate,
  productLines: kind.productLines,
  ...(kind.categories?.length ? { categories: kind.categories } : {}),
});

// The welcome's chips: a few ideas picked by a seed (one per page load, so they don't change while the user
// looks), one from each kind first so every kind shows, then others. Between `min` and `max` when there are
// that many ideas. Once the products are known, an idea with nothing published to pick isn't a chip (it stays
// on the Templates tab).
export const CHIPS_MIN = 4;
export const CHIPS_MAX = 6;
export function chipIdeas(kinds: readonly AppKind[], seed: number, max = CHIPS_MAX, products: readonly PickableProduct[] | null = null): KindIdea[] {
  const rand = seeded(seed);
  const shuffle = <T>(xs: readonly T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const buildable = (idea: AppIdea) => products === null || ideaProducts(idea, products).length > 0;
  const withIdeas = kinds.map((k) => ({ ...k, ideas: k.ideas.filter(buildable) })).filter((k) => k.ideas.length);
  if (!withIdeas.length) return [];
  const firsts = shuffle(withIdeas).map((kind) => ({ kind, idea: shuffle(kind.ideas)[0] }));
  const taken = new Set(firsts.map((f) => f.idea.id));
  const rest = shuffle(kindIdeas(withIdeas).filter((x) => !taken.has(x.idea.id)));
  return [...firsts, ...rest].slice(0, max);
}

// A small seeded generator (mulberry32): the same seed, the same chips.
function seeded(seed: number): () => number {
  let a = Math.floor(seed * 2 ** 32) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// What an idea or a kind is for, and the products it can pick from (the pickable ones: published).
export type PickTarget = { productLines: readonly string[]; categories?: readonly string[]; productNames?: readonly string[] };
export type PickableProduct = { id: string; productLine: string; name?: string; category?: string; status?: string };
const published = (p: PickableProduct) => (p.status ?? "published") === "published";

// The published products an idea names: in its lines, in its categories when it lists some (a product Mynt gives
// no category for counts as in them), and, when it names products, those whose names contain one of the names
// (or, if none do, every one in its categories). Empty: nothing to build it on yet.
export function ideaProducts(target: PickTarget, products: readonly PickableProduct[]): PickableProduct[] {
  const cats = target.categories ?? [];
  const inScope = products.filter((p) => published(p) && target.productLines.includes(p.productLine) && (!cats.length || !p.category || cats.includes(p.category)));
  const names = (target.productNames ?? []).map((n) => n.toLowerCase());
  if (!names.length) return inScope;
  const named = inScope.filter((p) => names.some((n) => (p.name ?? "").toLowerCase().includes(n)));
  return named.length ? named : inScope;
}

// The products using an idea or a kind adds to `picked`. One that names categories or products adds every
// published product it names; one that names only lines adds the first product of each line, unless one in that
// line is picked already. What's picked already stays.
export function picksForKind(target: PickTarget, products: readonly PickableProduct[], picked: readonly string[]): string[] {
  const out = [...picked];
  const named = ideaProducts(target, products);
  if (target.categories?.length || target.productNames?.length) {
    for (const p of named) if (!out.includes(p.id)) out.push(p.id);
    return out;
  }
  for (const line of target.productLines) {
    const inLine = named.filter((p) => p.productLine === line);
    if (!inLine.length || products.some((p) => p.productLine === line && out.includes(p.id))) continue;
    out.push(inLine[0].id);
  }
  return out;
}

// create_app's name, description and audience, from the prompt: the name is its first sentence
// (shortened), the description the whole prompt. The audience is left for the agent to refine.
export function appFieldsFromPrompt(prompt: string): { name: string; description: string; audience: string } {
  const text = prompt.trim().replace(/\s+/g, " ");
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const name = first.length > 60 ? `${first.slice(0, 57).replace(/\s+\S*$/, "")}…` : first.replace(/[.!?]+$/, "");
  return { name: name || "New app", description: text, audience: "As described in the app's description" };
}

export type NewAppResult = { appId: string; buildId: string | null; message?: string };

// The page's submit: creates the app through /api/apps and opens its workspace (on its first
// build when it started). Returns an error to show, or null once it has navigated.
export async function submitNewApp(
  request: NewAppRequest,
  deps: { fetch: typeof fetch; navigate: (path: string) => void },
): Promise<string | null> {
  let res: Response;
  try {
    res = await deps.fetch("/api/apps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  } catch {
    return "Couldn't reach the studio. Check your connection.";
  }
  const data = (await res.json().catch(() => null)) as (Partial<NewAppResult> & { message?: string }) | null;
  if (!res.ok || !data?.appId) return data?.message ?? "Couldn't create the app. Please try again.";
  deps.navigate(data.buildId ? `/${encodeURIComponent(data.appId)}/${encodeURIComponent(data.buildId)}` : `/${encodeURIComponent(data.appId)}`);
  return null;
}
