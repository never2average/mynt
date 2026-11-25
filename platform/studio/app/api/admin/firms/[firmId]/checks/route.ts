import { z } from "zod";
import { hasTools, isUuid, writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ firmId: string }> };

// Admin → Regulated firms → a firm → Run checks (run_firm_checks): Mynt asks the public registers about the firm now
// (GLEIF's record of its LEI, FinCEN's MSB registrant list), keeps each answer, and re-checks the products resting on
// it. The answer says each register's result in words, whether the firm now passes, and what drifted.
const Body = z.object({}).strict();
const NAMES: Record<string, string> = { gleif_lei: "GLEIF's LEI record", fincen_msb: "FinCEN's MSB registrant list" };
const WORDS: Record<string, string> = { match: "matches", mismatch: "doesn't match", not_found: "not found", unavailable: "couldn't be reached (not a failure; Mynt tries again daily)" };

export async function POST(req: Request, { params }: Params) {
  const { firmId } = await params;
  if (!isUuid(firmId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  return asAdmin("running a firm's checks", async (mynt, session) => {
    if (!(await hasTools(mynt, "run_firm_checks"))) return json({ error: "unsupported", message: "This comes with Mynt's next update." }, 501);
    const r = (await callAdminTool(mynt, session, "run_firm_checks", { entity_id: firmId })) as { results?: unknown; legitimacy?: { passes?: unknown; rule?: unknown } | null; drifted_products?: unknown } | null;
    const results = (Array.isArray(r?.results) ? r.results : []).filter((x): x is { source?: unknown; status?: unknown } => typeof x === "object" && x !== null);
    const said = results.map((x) => `${NAMES[String(x.source)] ?? String(x.source)}: ${WORDS[String(x.status)] ?? String(x.status)}`);
    // No LEI on record means GLEIF wasn't asked: said, so a missing answer isn't read as a pass.
    if (!results.some((x) => x.source === "gleif_lei")) said.unshift("GLEIF's LEI record: not asked (the firm has no valid LEI on record)");
    const passes = r?.legitimacy?.rule === "off" ? null : typeof r?.legitimacy?.passes === "boolean" ? r.legitimacy.passes : null;
    const drifted = Array.isArray(r?.drifted_products) ? r.drifted_products.length : 0;
    return json({
      ok: true,
      passes,
      message: `${said.join(". ")}. ${passes === true ? "The firm passes the real-company check." : passes === false ? "The firm doesn't pass the real-company check yet." : "This Mynt doesn't require the real-company check."}${drifted ? ` ${drifted} published ${drifted === 1 ? "product" : "products"} it sponsors drifted.` : ""}`,
    });
  });
}
