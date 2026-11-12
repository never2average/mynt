import type { NextRequest } from "next/server";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

// The products the user may build on (list_buildable_products), for New app's picker; ?query=
// searches their names and descriptions.
export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query")?.trim().slice(0, 200) || undefined;
  return asDeveloper("loading products", async (mynt) => {
    const reply = await callStudioTool(mynt, "list_buildable_products", query ? { query } : {});
    const products = (Array.isArray(reply) ? reply : [])
      .filter((p): p is Obj => typeof p === "object" && p !== null && typeof (p as Obj).id === "string")
      .map((p) => ({ id: str(p.id), name: str(p.name) || str(p.id), productLine: str(p.product_line), by: str(p.by), accessMode: str(p.access_mode) }));
    return json({ products });
  });
}
