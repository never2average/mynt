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
// Templates tab, as chips under the welcome and as slash commands.
export type AppKind = { id: string; title: string; description: string; productLines: string[]; goalTemplate: string };
type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");
export function appKindsFrom(reply: unknown): AppKind[] {
  const list = reply && typeof reply === "object" && Array.isArray((reply as Obj).kinds) ? ((reply as Obj).kinds as unknown[]) : [];
  return list
    .filter((k): k is Obj => typeof k === "object" && k !== null && appKindId.safeParse((k as Obj).id).success && typeof (k as Obj).goal_template === "string")
    .map((k) => ({
      id: str(k.id),
      title: str(k.title) || str(k.id),
      description: str(k.description),
      productLines: Array.isArray(k.product_lines) ? k.product_lines.filter((l): l is string => typeof l === "string") : [],
      goalTemplate: str(k.goal_template),
    }));
}

// /api/app-kinds' answer (the studio's shape), as the page reads it: anything else is no templates.
export function kindsFromRoute(data: unknown): AppKind[] {
  const list = data && typeof data === "object" && Array.isArray((data as Obj).kinds) ? ((data as Obj).kinds as unknown[]) : [];
  return list.filter(
    (k): k is AppKind =>
      typeof k === "object" && k !== null && appKindId.safeParse((k as Obj).id).success && typeof (k as Obj).title === "string" && typeof (k as Obj).goalTemplate === "string" && Array.isArray((k as Obj).productLines),
  );
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
