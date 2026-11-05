import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PRODUCT_LINES } from "./catalog.js";
import { productRegime } from "./regime.js";
import { recomputeDerived } from "./derived.js";
import { normalizeModel } from "./regulatory.js";
import type { ProductRecord, Store, TakeRate, User } from "./store.js";

// Mynt's take on a product is proportional to the compliance and back-office work it carries. Admins
// set a rate per product line: a base percentage plus a share per workload point, kept within a floor
// and a cap. A product's workload comes from its regime: every regulated primitive it is made of adds
// a point, plus a tenth of the average obligations, filings and controls carried by the licences that
// may provide it, plus a point if the component is servicing (ongoing back-office work).

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });
const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

export interface ComponentWorkload {
  region: string;
  primitive: string;
  action: string;
  licences: { regulator_id: string; license_id: string; obligations: number; filings: number; controls: number }[];
  base_points: number;
  grc_points: number;
  servicing_points: number;
  points: number;
}

export interface Workload {
  score: number;
  components: ComponentWorkload[];
  note?: string;
}

export async function workloadScore(store: Store, product: ProductRecord): Promise<Workload> {
  if (product.components.length === 0)
    return { score: 0, components: [], note: "The product has no composition yet (set_product_composition), so it carries no workload points" };
  const [regime, ref] = await Promise.all([productRegime(store, product), store.referenceData(true)]);
  const components: ComponentWorkload[] = [];
  for (const r of regime.regions) {
    const model = normalizeModel(ref.regions.find((x) => x.code === r.region)?.regulatory);
    for (const c of r.components) {
      const licences = c.licences.flatMap((l) => {
        const reg = model.regulators.find((x) => x.id === l.regulator_id)?.license_types.find((x) => x._id === l.license_id)?.grc.registers;
        return reg
          ? [{ regulator_id: l.regulator_id, license_id: l.license_id, obligations: reg.obligations.length, filings: reg.reporting_disclosure_filings.length, controls: reg.controls.length }]
          : [];
      });
      const load = licences.length ? licences.reduce((n, l) => n + l.obligations + l.filings + l.controls, 0) / licences.length : 0;
      const grc_points = round(load / 10);
      const servicing_points = c.action === "servicing" ? 1 : 0;
      components.push({ region: r.region, primitive: c.primitive, action: c.action, licences, base_points: 1, grc_points, servicing_points, points: round(1 + grc_points + servicing_points) });
    }
  }
  return { score: round(components.reduce((n, c) => n + c.points, 0)), components };
}

export function applyTakeRate(rate: TakeRate, score: number) {
  const raw = rate.base_pct + rate.workload_pct * score;
  const pct = Math.min(rate.max_pct, Math.max(rate.min_pct, raw));
  return { rate_pct: round(pct), unclamped_pct: round(raw), clamped: pct === raw ? null : pct === rate.max_pct ? ("max" as const) : ("min" as const) };
}

// What Mynt takes on a product: its line's rate applied to its workload score (get_product_take_rate, and
// what's stored on the product; see derived.ts).
export async function productTakeRate(store: Store, record: ProductRecord) {
  const line = record.product.product_line;
  const [rate, workload] = await Promise.all([store.takeRate(line), workloadScore(store, record)]);
  if (!rate) return { line, configured: false as const, message: `No take rate is configured for ${line} yet; an admin sets one with define_take_rate`, workload };
  const { updated_by: _, ...terms } = rate;
  return { line, configured: true as const, ...applyTakeRate(rate, workload.score), basis: rate.basis, rate: terms, workload };
}

const TakeRateSchema = {
  line: z.enum(PRODUCT_LINES),
  base_pct: z.number().min(0).max(100).describe("Percentage taken on every product in the line"),
  workload_pct: z.number().min(0).max(100).describe("Percentage added per workload point (see get_product_take_rate)"),
  min_pct: z.number().min(0).max(100).describe("Floor"),
  max_pct: z.number().min(0).max(100).describe("Cap"),
  basis: z.string().trim().min(2).max(200).describe("What the percentage applies to, e.g. 'revenue' or 'volume'"),
};

// Admin: set and read the rates.
export function registerTakeRateAdminTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "define_take_rate",
    {
      title: "Define a take rate",
      description:
        "Admin: set what Mynt takes on a product line, proportional to each product's compliance and back-office workload: rate = base_pct + workload_pct × workload score, kept between min_pct and max_pct, applied to basis (e.g. revenue or volume). Replaces the line's current rate.",
      inputSchema: TakeRateSchema,
    },
    async (r) => {
      if (r.min_pct > r.max_pct) return fail("min_pct can't be above max_pct");
      const saved = await store.upsertTakeRate(r, user.id);
      await store.audit(user.id, "define_take_rate", r.line, r);
      // Products on the line take the new rate (stored on each; see derived.ts).
      await recomputeDerived(store, { line: r.line });
      return json(saved);
    },
  );

  server.registerTool(
    "list_take_rates",
    {
      title: "Take rates",
      description: "Admin: the take rate configured for each product line, and the lines that have none yet.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rates = await store.takeRates();
      return json({ rates, unconfigured: PRODUCT_LINES.filter((l) => !rates.some((r) => r.line === l)) });
    },
  );
}

// The product's owner, members of its firm and admins can see what Mynt takes on it.
export function registerTakeRateTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "get_product_take_rate",
    {
      title: "A product's take rate",
      description:
        "Innovator: what Mynt takes on one of your firm's products: its line's rate scaled by the product's workload score (a point per regulated component, plus a tenth of the average obligations, filings and controls of the licences that may provide it, plus a point for servicing), with the full breakdown.",
      inputSchema: { product_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ product_id }) => {
      const record = await store.getProduct(product_id);
      const allowed =
        record && (record.owner_id === user.id || (user.entity_id != null && record.entity_id === user.entity_id) || user.roles.includes("admin"));
      if (!record || !allowed) return fail(`No product of yours with id '${product_id}'`);
      return json({ product_id, ...(await productTakeRate(store, record)) });
    },
  );
}
