import { z } from "zod";

// New app: what the user typed ("What do you want to build?") and the products they picked
// become a draft Mynt app (create_app) and its first build (start_build). Pure, so the route,
// the page and the tests share it.

export const NewAppRequest = z
  .object({
    prompt: z.string().trim().min(10, "Say a little more about what to build (at least 10 characters).").max(4000),
    product_ids: z.array(z.string().trim().min(1).max(200)).min(1, "Pick at least one product to build on.").max(20),
  })
  .strict();
export type NewAppRequest = z.infer<typeof NewAppRequest>;

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
