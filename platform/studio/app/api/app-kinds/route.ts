import { appKindsFrom } from "@/lib/new-app";
import { productIdeasFrom } from "@/lib/product-ideas";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The Build page's templates: Mynt's app kinds (list_app_kinds), each with the app ideas on it from Mynt's database
// (list_app_ideas), and the ideas for new financial products (list_product_ideas) that Financial product mode offers.
// A Mynt without kinds has none, and App mode starts from a blank prompt; one without ideas yet (not seeded, or
// older) gives the kinds alone, and App mode offers those. One without product ideas gives none.
export async function GET() {
  return asDeveloper("loading templates", async (mynt) => {
    const tools = new Set((await listMyntTools(mynt)).map((t) => t.name));
    const [kinds, ideas, productIdeas] = await Promise.all([
      tools.has("list_app_kinds") ? callStudioTool(mynt, "list_app_kinds", {}) : Promise.resolve(null),
      tools.has("list_app_kinds") && tools.has("list_app_ideas") ? callStudioTool(mynt, "list_app_ideas", {}) : Promise.resolve(null),
      tools.has("list_product_ideas") ? callStudioTool(mynt, "list_product_ideas", {}) : Promise.resolve(null),
    ]);
    return json({ kinds: kinds === null ? [] : appKindsFrom(kinds, ideas), productIdeas: productIdeasFrom(productIdeas) });
  });
}
