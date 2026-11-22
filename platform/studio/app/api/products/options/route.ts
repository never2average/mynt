import { optionsFrom } from "@/lib/products";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Create product's choices: the regions products can be offered in (each with its regulators) and the
// product categories, as Mynt's admins defined them.
export async function GET() {
  return asDeveloper("loading product options", async (mynt) => {
    const regions = await callStudioTool(mynt, "list_regions");
    const categories = await callStudioTool(mynt, "list_product_categories");
    return json(optionsFrom(regions, categories));
  });
}
