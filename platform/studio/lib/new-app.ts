import { z } from "zod";
import { appKindId, buildCap } from "./studio-tools";

// New app: what the user typed ("What do you want to build?") and the products they picked
// become a draft Mynt app (create_app) and its first build (start_build). Pure, so the route,
// the page and the tests share it.

export const NewAppRequest = z
  .object({
    prompt: z.string().trim().min(10, "Say a little more about what to build (at least 10 characters).").max(4000),
    product_ids: z.array(z.string().trim().min(1).max(200)).min(1, "Pick at least one product to build on.").max(20),
    // The app kind it starts from (a template on New app), passed to start_build where Mynt takes one.
    kind: appKindId.optional(),
    // The cap the developer picked (Cap $ beside Build it); Mynt's usual cap without one. Mynt checks it again.
    cap_usd: buildCap.optional(),
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
// Templates tab and as slash commands. Each kind carries specific app ideas (its examples), which New app
// offers as chips under the welcome and as the Templates tab's rows.
export type AppIdea = { id: string; title: string; pitch: string; goal: string; productLines: string[] };
export type AppKind = { id: string; title: string; description: string; productLines: string[]; goalTemplate: string; examples: AppIdea[] };
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((l): l is string => typeof l === "string") : []);
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;

// A kind's ideas, from Mynt's shape (product_lines) or the studio's (productLines). An idea without its own
// lines builds on the kind's; one naming a line the kind doesn't have is dropped.
function ideasFrom(list: unknown, kindLines: readonly string[]): AppIdea[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is Obj => isObj(e) && appKindId.safeParse(e.id).success && str(e.title).length > 0 && str(e.goal).length > 0)
    .map((e) => {
      const own = strings(e.product_lines ?? e.productLines);
      return { id: str(e.id), title: str(e.title), pitch: str(e.pitch), goal: str(e.goal), productLines: own.length ? own : [...kindLines] };
    })
    .filter((e) => e.productLines.every((l) => kindLines.includes(l)));
}

export function appKindsFrom(reply: unknown): AppKind[] {
  const list = isObj(reply) && Array.isArray(reply.kinds) ? (reply.kinds as unknown[]) : [];
  return list
    .filter((k): k is Obj => isObj(k) && appKindId.safeParse(k.id).success && typeof k.goal_template === "string")
    .map((k) => {
      const productLines = strings(k.product_lines);
      return { id: str(k.id), title: str(k.title) || str(k.id), description: str(k.description), productLines, goalTemplate: str(k.goal_template), examples: ideasFrom(k.examples, productLines) };
    });
}

// /api/app-kinds' answer (the studio's shape), as the page reads it: anything else is no templates.
export function kindsFromRoute(data: unknown): AppKind[] {
  const list = isObj(data) && Array.isArray(data.kinds) ? (data.kinds as unknown[]) : [];
  return list
    .filter((k): k is Obj => isObj(k) && appKindId.safeParse(k.id).success && typeof k.title === "string" && typeof k.goalTemplate === "string" && Array.isArray(k.productLines))
    .map((k) => {
      const productLines = strings(k.productLines);
      return { id: str(k.id), title: str(k.title), description: str(k.description), productLines, goalTemplate: str(k.goalTemplate), examples: ideasFrom(k.examples, productLines) };
    });
}

// Every idea with the kind it builds on, grouped by kind in the kinds' order. A kind without ideas is one
// idea itself (its title, description and goal), so it can still be used.
export type KindIdea = { kind: AppKind; idea: AppIdea };
export function kindIdeas(kinds: readonly AppKind[]): KindIdea[] {
  return kinds.flatMap((kind) =>
    (kind.examples.length ? kind.examples : [{ id: kind.id, title: kind.title, pitch: kind.description, goal: kind.goalTemplate, productLines: kind.productLines }]).map((idea) => ({ kind, idea })),
  );
}

// The welcome's chips: a few ideas picked by a seed (one per page load, so they don't change while the user
// looks), one from each kind first so every kind shows, then others. Between `min` and `max` when there are
// that many ideas.
export const CHIPS_MIN = 4;
export const CHIPS_MAX = 6;
export function chipIdeas(kinds: readonly AppKind[], seed: number, max = CHIPS_MAX): KindIdea[] {
  const rand = seeded(seed);
  const shuffle = <T>(xs: readonly T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const withIdeas = kinds.filter((k) => k.examples.length);
  if (!withIdeas.length) return [];
  const firsts = shuffle(withIdeas).map((kind) => ({ kind, idea: shuffle(kind.examples)[0] }));
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

// Using a kind picks one product from each of its lines (the first listed), keeping any already picked
// in those lines; picks in other lines stay too.
export function picksForKind(kind: Pick<AppKind, "productLines">, products: readonly { id: string; productLine: string }[], picked: readonly string[]): string[] {
  const out = [...picked];
  for (const line of kind.productLines) {
    const inLine = products.filter((p) => p.productLine === line);
    if (!inLine.length || inLine.some((p) => out.includes(p.id))) continue;
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
