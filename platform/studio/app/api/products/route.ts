import type { NextRequest } from "next/server";
import { NewProductRequest, productsFrom } from "@/lib/products";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, isAuthError } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { myProductsFrom } from "@/lib/threads";
import { ownerOf } from "@/lib/wallets-server";

export const dynamic = "force-dynamic";

// The products the user may build on (list_buildable_products), for New app's picker and Products tab;
// ?query= searches their names and descriptions. Their own products that aren't published yet
// (list_my_products) come after, as drafts: shown, but not pickable until published. A Mynt that
// doesn't list the user's own products still lists what they can build on.
// `mine` is every product of the user's own (drafts and published, with when each last changed) and
// `owner` the hashed key their product chats are kept under in the browser (lib/threads.ts), for the
// Build page's Recent and the sidebar's Financial products; ?mine=1 returns only those.
export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query")?.trim().slice(0, 200) || undefined;
  const onlyMine = req.nextUrl.searchParams.get("mine") === "1";
  return asDeveloper("loading products", async (mynt, session) => {
    const reply = onlyMine ? [] : await callStudioTool(mynt, "list_buildable_products", query ? { query } : {});
    let mine: unknown = [];
    if (!query) {
      try {
        mine = await callStudioTool(mynt, "list_my_products");
      } catch (err) {
        if (isAuthError(err)) throw err;
      }
    }
    const own = { mine: myProductsFrom(mine), owner: ownerOf(session) };
    return json(onlyMine ? own : { products: productsFrom(reply, mine), ...own });
  });
}

// Create product: a draft product (create_product) with the sheet's fields, checked here first and by
// Mynt again; Mynt's refusal (an id already taken, underlying products missing) comes back in its words.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = NewProductRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Check what you entered." }, 400);
  const request = parsed.data;
  return asDeveloper("creating a product", async (mynt) => {
    await callStudioTool(mynt, "create_product", request);
    const [product] = productsFrom([], [{ ...request, status: "draft" }]);
    return json({ product }, 201);
  });
}
